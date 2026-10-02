/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the worker that runs the model's cells. If `run`/`call` crossed to the main thread every `tab.click`
 *  would cost two thread hops (OMP's cost, the one the port exists to avoid); if `open`/`close` did not, the engine would never learn of a tab and the
 *  View could not show it; if an `abort` did not end the cell and its pending host call, a cancelled request would leave a hung page and a stuck
 *  session; and if the tab realm was not told which tabs closed, a cell would drive a page that is gone.
 *
 *  The host (lane L2) and the tab realm (lane L3) are fakes that keep the contracts of doc 77 §7.7; the cell realm, the facade and the dispatcher are the real ones.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BridgeRequest, HostToWorker, RunResult, TabHandle, TabRealm, Transport, WorkerToHost } from "../src/code/contracts.js";
import { ToolAbortError } from "../src/code/errors.js";
import { clampBrowserTimeout, createDispatcher, WorkerCore } from "../src/code/worker/dispatch.js";

const handle = (name: string): TabHandle => ({ tabId: `t-${name}`, targetId: `target-${name}`, url: "about:blank", title: "", active: true, browserId: "b1", wsEndpoint: "ws://127.0.0.1:1/devtools/browser/x", kind: "headless", created: true });
const finished = (text: string, returnValue?: unknown): RunResult => ({ displays: [{ type: "text", text }], ...(returnValue === undefined ? {} : { returnValue }), screenshots: [] });

class FakeRealm implements TabRealm {
  readonly held = new Map<string, TabHandle>();
  readonly released: string[] = [];
  readonly ended: string[] = [];
  readonly ran: Array<Parameters<TabRealm["run"]>[0]> = [];
  readonly called: Array<Parameters<TabRealm["call"]>[0]> = [];
  disposed = false;
  onCall: (r: Parameters<TabRealm["call"]>[0]) => Promise<RunResult> = async r => finished("", `${r.chain.map(step => step.method).join(">")}!`);
  async adopt(name: string, h: TabHandle): Promise<void> {
    this.held.set(name, h);
  }
  async release(name: string): Promise<void> {
    this.held.delete(name);
    this.released.push(name);
  }
  async run(r: Parameters<TabRealm["run"]>[0]): Promise<RunResult> {
    this.ran.push(r);
    return finished("page ran", 7);
  }
  async call(r: Parameters<TabRealm["call"]>[0]): Promise<RunResult> {
    this.called.push(r);
    return this.onCall(r);
  }
  names(): string[] {
    return [...this.held.keys()];
  }
  async end(browserId: string): Promise<void> {
    this.ended.push(browserId);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

/** The two ends of the thread boundary, in memory: what the host sends the worker, and what the worker sends the host. */
interface Boundary {
  worker: Transport<HostToWorker, WorkerToHost>;
  fromWorker: WorkerToHost[];
  readonly closed: boolean;
  send(message: HostToWorker): void;
  next<T extends WorkerToHost>(matches: (m: WorkerToHost) => m is T): Promise<T>;
}

function boundary(): Boundary {
  const toWorker: Array<(m: HostToWorker) => void> = [];
  const fromWorker: WorkerToHost[] = [];
  const waiting: Array<{ matches: (m: WorkerToHost) => boolean; resolve: (m: WorkerToHost) => void }> = [];
  let closed = false;
  const worker: Transport<HostToWorker, WorkerToHost> = {
    send: message => {
      fromWorker.push(message);
      for (const wait of [...waiting]) {
        if (!wait.matches(message)) continue;
        waiting.splice(waiting.indexOf(wait), 1);
        wait.resolve(message);
      }
    },
    onMessage: handler => {
      toWorker.push(handler);
      return () => void toWorker.splice(toWorker.indexOf(handler), 1);
    },
    close: () => {
      closed = true;
    },
  };
  return {
    worker,
    fromWorker,
    get closed() {
      return closed;
    },
    send(message) {
      for (const handler of [...toWorker]) handler(message);
    },
    next<T extends WorkerToHost>(matches: (m: WorkerToHost) => m is T): Promise<T> {
      const seen = fromWorker.find(matches);
      if (seen) return Promise.resolve(seen);
      const { promise, resolve } = Promise.withResolvers<WorkerToHost>();
      waiting.push({ matches, resolve });
      return promise as Promise<T>;
    },
  };
}

type Ended = Extract<WorkerToHost, { t: "result" }>;
const isResult = (m: WorkerToHost): m is Ended => m.t === "result";
const isBridge = (m: WorkerToHost): m is Extract<WorkerToHost, { t: "bridge" }> => m.t === "bridge";
const bridges = (b: Boundary): Array<Extract<WorkerToHost, { t: "bridge" }>> => b.fromWorker.filter(isBridge);
const textOf = (message: Ended): string => (message.ok ? message.payload.displays.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n") : `ERROR ${message.error.message}`);

const links: Boundary[] = [];
afterEach(() => {
  // A worker that was never closed would keep its cell realm's listeners for the next test.
  for (const link of links.splice(0)) link.send({ t: "close" });
});

/** A started worker: `init` sent, `ready` seen. `host` answers each `bridge` message. */
async function startWorker(host: (request: BridgeRequest) => { ok: true; text: string; attach?: TabHandle } | { ok: false; name: string; message: string } | "never") {
  const link = boundary();
  links.push(link);
  const realm = new FakeRealm();
  const core = new WorkerCore({ transport: link.worker, createRealm: () => realm });
  link.send({ t: "init", session: "s1", env: {} });
  await link.next((m): m is Extract<WorkerToHost, { t: "ready" }> => m.t === "ready");
  // The host side answers a bridge request as soon as the worker sends it.
  const answered = new Set<number>();
  const pump = async (): Promise<void> => {
    for (const request of bridges(link)) {
      if (answered.has(request.id)) continue;
      answered.add(request.id);
      const answer = host(request.request);
      if (answer === "never") continue;
      if (answer.ok) link.send({ t: "bridge-reply", id: request.id, ok: true, value: { text: answer.text, details: { action: request.request.action, name: request.request.name ?? "main" }, ...(answer.attach ? { attach: answer.attach } : {}) } });
      else link.send({ t: "bridge-reply", id: request.id, ok: false, error: { name: answer.name, message: answer.message, isAbort: false } });
    }
  };
  const originalSend = link.worker.send;
  link.worker.send = message => {
    originalSend(message);
    if (message.t === "bridge") queueMicrotask(() => void pump());
  };
  let n = 0;
  const run = async (code: string, timeoutMs = 5_000): Promise<Ended> => {
    n += 1;
    const runId = `run-${n}`;
    const result = link.next((m): m is Ended => isResult(m) && m.runId === runId);
    link.send({ t: "run", runId, code, timeoutMs });
    return result;
  };
  return { link, realm, core, run };
}

describe("open and close go to the host; run and call never leave the worker", () => {
  test("open crosses to the host, the tab it made is adopted before the cell goes on, and run and call cross nothing", async () => {
    const { link, realm, run } = await startWorker(request => ({ ok: true, text: `Opened tab "${request.name}" on headless browser (hidden)`, ...(request.action === "open" ? { attach: handle(request.name ?? "main") } : {}) }));
    const result = await run(`const tab = await browser.open({ name: "docs", url: "https://example.com" });
      await tab.click(1); const el = tab.id(3); await el.fill("x"); const value = await tab.run(() => 1, { timeout: 9 }); String(value)`);
    expect(result.ok).toBe(true);
    expect(textOf(result)).toBe('Opened tab "docs" on headless browser (hidden)\npage ran\n7');
    // One bridge message in all: the open. The click, the element fill and the run were answered in the worker.
    expect(bridges(link).map(message => message.request.action)).toEqual(["open"]);
    expect(bridges(link)[0]!.request).toMatchObject({ action: "open", name: "docs", url: "https://example.com", timeout: 30 });
    expect(realm.held.get("docs")).toEqual(handle("docs"));
    expect(realm.called.map(call => [call.name, call.chain.map(step => step.method)])).toEqual([["docs", ["click"]], ["docs", ["id", "fill"]]]);
    expect(realm.ran).toHaveLength(1);
    expect(realm.ran[0]).toMatchObject({ name: "docs", timeoutMs: 9_000 });
    expect(realm.ran[0]!.fn).toContain("=> 1");
  });

  test("close drops the pages the realm holds: the one tab named, or every tab with all", async () => {
    const { realm, run } = await startWorker(request => ({ ok: true, text: request.action === "close" ? "Released" : "Opened", ...(request.action === "open" ? { attach: handle(request.name ?? "main") } : {}) }));
    await run('await browser.open({ name: "a" }); await browser.open({ name: "b" }); await browser.open({ name: "c" });');
    expect(realm.names()).toEqual(["a", "b", "c"]);
    await run('await browser.tab("b").close()');
    expect(realm.released).toEqual(["b"]);
    await run("await browser.close({ all: true })");
    expect(realm.released).toEqual(["b", "a", "c"]);
    expect(realm.names()).toEqual([]);
  });

  test("a host refusal reaches the cell as an error of the same name and message, and the cell can handle it", async () => {
    const { run } = await startWorker(() => ({ ok: false, name: "ToolError", message: 'Tab "a" is bound to a different browser (headless). Close it first.' }));
    const result = await run('let seen; try { await browser.open({ name: "a" }); } catch (error) { seen = `${error.name}: ${error.message}`; } seen');
    expect(textOf(result)).toBe('ToolError: Tab "a" is bound to a different browser (headless). Close it first.');
  });

  test("the cell's names persist from one run to the next in the same worker", async () => {
    const { run } = await startWorker(() => ({ ok: true, text: "" }));
    await run("const kept = 41");
    expect(textOf(await run("kept + 1"))).toBe("42");
  });
});

describe("what the cell may pass to browser", () => {
  test("the facade's arguments are checked with OMP's wording, before anything is dispatched", async () => {
    const { link, realm, run } = await startWorker(() => ({ ok: true, text: "" }));
    const result = await run(`let seen; try { await browser.open({ wait_until: "later" }); } catch (error) { seen = error.message; } seen`);
    expect(textOf(result)).toMatch(/^browser received invalid arguments: wait_until/);
    expect(bridges(link)).toEqual([]);
    expect(realm.called).toEqual([]);
  });

  test("a run names exactly one of code and fn, and the cell's budget is clamped to OMP's 1 to 300 seconds", async () => {
    const realm = new FakeRealm();
    const hostCalls: BridgeRequest[] = [];
    const invoke = createDispatcher({ realm, host: async r => (hostCalls.push(r), { text: "", details: { action: r.action, name: "main" } }) });
    const live = { runId: "r", signal: new AbortController().signal };
    await expect(invoke({ action: "run", code: "1", fn: "() => 1" }, live)).rejects.toThrow("Action 'run' requires exactly one of 'code' or 'fn'.");
    await expect(invoke({ action: "run" }, live)).rejects.toThrow("Action 'run' requires exactly one of 'code' or 'fn'.");
    expect(realm.ran).toEqual([]);

    await invoke({ action: "run", code: "1" }, live);
    await invoke({ action: "run", code: "1", timeout: 999 }, live);
    await invoke({ action: "run", code: "1", timeout: 0 }, live);
    expect(realm.ran.map(r => r.timeoutMs)).toEqual([30_000, 300_000, 1_000]);
    expect([clampBrowserTimeout(undefined), clampBrowserTimeout(45), clampBrowserTimeout(-3)]).toEqual([30, 45, 1]);
  });

  test("a function runs with its serialised arguments, a code string as code", async () => {
    const realm = new FakeRealm();
    const invoke = createDispatcher({ realm, host: async () => { throw new Error("must not reach the host"); } });
    const live = { runId: "r", signal: new AbortController().signal };
    await invoke({ action: "run", name: "docs", fn: "({ tab }, x) => x", args: [{ __omp_re: { source: "a", flags: "g" } }] }, live);
    await invoke({ action: "run", name: "docs", code: "  return 1  " }, live);
    expect(realm.ran).toMatchObject([{ name: "docs", fn: "({ tab }, x) => x", args: [{ __omp_re: { source: "a", flags: "g" } }] }, { name: "docs", code: "return 1" }]);
  });

  test("a call whose signal is already aborted dispatches nothing", async () => {
    const realm = new FakeRealm();
    let hostCalls = 0;
    const invoke = createDispatcher({ realm, host: async r => (hostCalls += 1, { text: "", details: { action: r.action, name: "main" } }) });
    const controller = new AbortController();
    controller.abort();
    for (const action of ["open", "close", "run", "call"] as const) {
      await expect(invoke({ action, code: "1", chain: [] }, { runId: "r", signal: controller.signal })).rejects.toThrow(ToolAbortError.MESSAGE);
    }
    expect(hostCalls).toBe(0);
    expect(realm.ran).toEqual([]);
    expect(realm.called).toEqual([]);
  });
});

describe("cancellation, budget and shutdown", () => {
  test("an abort ends the cell and the host call it waits on, and the next cell runs in the same worker", async () => {
    const { link, run } = await startWorker(request => (request.name === "stuck" ? "never" : { ok: true, text: "fine" }));
    const stuck = run('await browser.open({ name: "stuck" })');
    const sent = await link.next(isBridge);
    link.send({ t: "abort", runId: "run-1" });
    const result = await stuck;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ name: "ToolAbortError", isAbort: true });
    // The host answers late: nothing is waiting for it any more, and nothing breaks.
    link.send({ t: "bridge-reply", id: sent.id, ok: true, value: { text: "late", details: { action: "open", name: "stuck" } } });
    expect(textOf(await run('const tab = await browser.open({ name: "ok" });'))).toBe("fine");
  });

  test("a cell that outlives its budget fails with OMP's timeout text, keeping what it printed, and the worker stays usable", async () => {
    const { run } = await startWorker(() => "never");
    const timed = await run('console.log("started"); await browser.open({ name: "x" })', 40);
    expect(timed.ok).toBe(false);
    if (!timed.ok) {
      expect(timed.error).toMatchObject({ name: "TimeoutError", message: "Command timed out after 1 seconds.", isAbort: false });
      expect(timed.error.partial?.displays).toEqual([{ type: "text", text: "started" }]);
    }
    expect(textOf(await run("1 + 1"))).toBe("2");
  });

  test("a browser the host ended is dropped from the tab realm", async () => {
    const { link, realm } = await startWorker(() => ({ ok: true, text: "" }));
    link.send({ t: "end", browserId: "b9", why: "taken-over" });
    await Promise.resolve();
    expect(realm.ended).toEqual(["b9"]);
  });

  test("close ends every run, disposes the realm, says closed and closes the transport", async () => {
    const { link, realm, run } = await startWorker(() => "never");
    const stuck = run('await browser.open({ name: "x" })');
    await link.next(isBridge);
    link.send({ t: "close" });
    const result = await stuck;
    expect(result.ok).toBe(false);
    await link.next((m): m is Extract<WorkerToHost, { t: "closed" }> => m.t === "closed");
    expect(realm.disposed).toBe(true);
    expect(link.closed).toBe(true);
  });

  test("a run before init is refused, not run", async () => {
    const link = boundary();
    links.push(link);
    new WorkerCore({ transport: link.worker, createRealm: () => new FakeRealm() });
    link.send({ t: "run", runId: "early", code: "1", timeoutMs: 1000 });
    const result = await link.next((m): m is Ended => isResult(m) && m.runId === "early");
    expect(result.ok).toBe(false);
  });
});
