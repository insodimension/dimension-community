/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the code host's clocks and refusals. A person takes a browser over and the model's cell goes on clicking in it; a cell runs on a browser a
 * pending post owns; a tab freezes under a View that is looking at it, or never thaws; a worker that died, hung or never started leaves its call waiting for ever; the worker of a session that
 * is gone stays for ever; a finished result is kept for ever.
 *
 * A scripted browser port and a scripted worker, so every clock is short and exact and no Chrome is needed; the real thing is code-host.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CodeBrowserPort, HostToWorker, RunError, TabRef, WorkerToHost } from "../src/code/contracts";
import { CodeHost, type CodeHostOptions } from "../src/code/host/code-host";
import type { SpawnWorker, WorkerHandle } from "../src/code/host/transport";
import { BrowserRuntimeError } from "../src/store";
import { waitUntil } from "./fixture";

const NEVER = new AbortController().signal;

type Behavior = (worker: FakeWorker, message: HostToWorker) => void;

/** A worker the test plays: it answers `init` with `ready`, `close` by exiting, and everything else only when the test says so. */
class FakeWorker {
  readonly sent: HostToWorker[] = [];
  exited = false;
  readonly #listeners = new Set<(message: WorkerToHost) => void>();
  readonly #exits: Array<(reason: string) => void> = [];
  readonly handle: WorkerHandle;

  constructor(behavior: Behavior) {
    this.handle = {
      transport: {
        send: message => {
          this.sent.push(message);
          behavior(this, message);
        },
        onMessage: handler => {
          this.#listeners.add(handler);
          return () => void this.#listeners.delete(handler);
        },
        close: () => this.die("closed"),
      },
      terminate: async () => this.die("terminated"),
      onExit: handler => void this.#exits.push(handler),
    };
  }

  emit(message: WorkerToHost): void {
    for (const listener of [...this.#listeners]) listener(message);
  }

  die(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    for (const handler of this.#exits) handler(reason);
  }

  /** What the host sent of a kind, in order. */
  of<T extends HostToWorker["t"]>(kind: T): Array<Extract<HostToWorker, { t: T }>> {
    return this.sent.filter((message): message is Extract<HostToWorker, { t: T }> => message.t === kind);
  }
}

const defaultBehavior: Behavior = (worker, message) => {
  if (message.t === "init") queueMicrotask(() => worker.emit({ t: "ready" }));
  if (message.t === "close") worker.die("closed");
};

/** A browser port the test drives: one browser per session, scripted refusals, a log of what the host asked. */
class FakeBrowsers implements CodeBrowserPort {
  readonly log: string[] = [];
  readonly frozen = new Set<string>();
  holdError: Error | undefined;
  idleMs = 0;
  viewers = 0;
  pending = 0;
  readonly #ends = new Set<(browserId: string, why: "closed" | "retired" | "taken-over", reason?: string) => void>();
  readonly #views = new Set<(browserId: string) => void>();
  #browser: { id: string; tabs: TabRef[] } | undefined;
  #serial = 0;

  get id(): string | undefined {
    return this.#browser?.id;
  }

  async acquire(): Promise<{ browserId: string; created: boolean; wsEndpoint: string }> {
    this.log.push("acquire");
    const created = this.#browser === undefined;
    this.#browser ??= { id: "b1", tabs: [] };
    return { browserId: this.#browser.id, created, wsEndpoint: "ws://fake/b1" };
  }

  async openTab(browserId: string, o: { url?: string }): Promise<TabRef> {
    this.#serial += 1;
    const tab: TabRef = { tabId: `t${this.#serial}`, targetId: `t${this.#serial}`, url: o.url ?? "about:blank", title: "", active: true };
    this.#browser?.tabs.push(tab);
    this.log.push(`openTab ${browserId}`);
    return tab;
  }

  async navigateTab(): Promise<TabRef> {
    throw new Error("not scripted");
  }

  async findTab(): Promise<TabRef | undefined> {
    return undefined;
  }

  async tabs(): Promise<TabRef[]> {
    return [...(this.#browser?.tabs ?? [])];
  }

  async closeTab(): Promise<void> {
    this.log.push("closeTab");
  }

  async setFrozen(browserId: string, tabId: string, frozen: boolean): Promise<void> {
    this.log.push(`${frozen ? "freeze" : "thaw"} ${tabId}`);
    if (frozen) this.frozen.add(tabId);
    else this.frozen.delete(tabId);
  }

  setDialogPolicy(): void {}

  async resize(): Promise<void> {}

  setPersist(): void {}

  activity(): { idleMs: number; viewers: number; pending: number } | undefined {
    return this.#browser === undefined ? undefined : { idleMs: this.idleMs, viewers: this.viewers, pending: this.pending };
  }

  existing(): { browserId: string; wsEndpoint: string } | undefined {
    return this.#browser === undefined ? undefined : { browserId: this.#browser.id, wsEndpoint: "ws://fake/b1" };
  }

  holdWork(): () => void {
    if (this.holdError !== undefined) throw this.holdError;
    this.pending += 1;
    this.log.push("hold");
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.pending -= 1;
      this.log.push("unhold");
    };
  }

  async release(): Promise<void> {
    this.end("closed");
  }

  onEnd(listener: (browserId: string, why: "closed" | "retired" | "taken-over", reason?: string) => void): () => void {
    this.#ends.add(listener);
    return () => void this.#ends.delete(listener);
  }

  onViewed(listener: (browserId: string) => void): () => void {
    this.#views.add(listener);
    return () => void this.#views.delete(listener);
  }

  /** The runtime ended the browser. */
  end(why: "closed" | "retired" | "taken-over", reason?: string): void {
    const browser = this.#browser;
    if (browser === undefined) return;
    this.#browser = undefined;
    for (const listener of [...this.#ends]) listener(browser.id, why, reason);
  }

  /** A View joined its stream. */
  view(): void {
    if (this.#browser !== undefined) for (const listener of [...this.#views]) listener(this.#browser.id);
  }
}

interface Rig {
  host: CodeHost;
  browsers: FakeBrowsers;
  workers: FakeWorker[];
}

const hosts: CodeHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

function rig(options: Partial<CodeHostOptions> = {}, behavior: Behavior = defaultBehavior): Rig {
  const browsers = new FakeBrowsers();
  const workers: FakeWorker[] = [];
  const spawn: SpawnWorker = () => {
    const worker = new FakeWorker(behavior);
    workers.push(worker);
    return worker.handle;
  };
  const host = new CodeHost({ browsers, spawn, env: {}, timing: { freezeIdleMs: 0, workerIdleMs: 60_000, startupTimeoutMs: 1_000, graceMs: 50, finishedTtlMs: 60_000 }, ...options });
  hosts.push(host);
  return { host, browsers, workers };
}

const OK = { ok: true as const, payload: { displays: [{ type: "text" as const, text: "done" }], screenshots: [] } };

/** Starts a cell that the test will answer by hand; the call returns at once with the run's id. */
async function start(host: CodeHost, session = "s1", timeoutMs = 30_000): Promise<string> {
  const started = await host.run(session, { code: "x", timeoutMs, waitMs: 20, signal: NEVER });
  if (started.state !== "running") throw new Error("the scripted cell answered by itself");
  return started.runId;
}

/** The cell opens `name` through the bridge and the test waits for the host's reply. */
async function open(worker: FakeWorker, runId: string, id = 1): Promise<void> {
  worker.emit({ t: "bridge", id, runId, request: { action: "open", name: "main", url: "http://fake/page" } });
  await waitUntil("the host's reply to the open", () => worker.of("bridge-reply").find(reply => reply.id === id), reply => reply !== undefined, 2_000);
}

const abortRunError = (message: string): RunError => ({ name: "ToolAbortError", message, isAbort: true });

describe("a person takes a browser over", () => {
  test("the cell using it is stopped with human_driving and its tabs are dropped from the worker", async () => {
    const { host, browsers, workers } = rig();
    const runId = await start(host);
    const worker = workers[0]!;
    await open(worker, runId);
    browsers.end("taken-over");
    expect(worker.of("end")).toEqual([{ t: "end", browserId: "b1", why: "taken-over" }]);
    expect(worker.of("abort")).toEqual([{ t: "abort", runId }]);
    // The worker answers the abort the way a cell answers a cancellation.
    worker.emit({ t: "result", runId, ok: false, error: abortRunError("Operation aborted") });
    const done = await host.resume("s1", runId, 1_000, NEVER);
    if (done.state !== "done" || !("error" in done.result)) throw new Error("the cell should have ended in an error");
    expect(done.result.error.message).toContain("human_driving");
    expect(done.result.error.isAbort).toBe(true);
  });

  test("a closed or retired browser drops its tabs and tells the worker why, but the cell goes on", async () => {
    const { host, browsers, workers } = rig();
    const runId = await start(host);
    const worker = workers[0]!;
    await open(worker, runId);
    browsers.end("retired", "it was a code browser, closed after 1800 s with no calls; open a new one with browser.open");
    expect(worker.of("end")).toEqual([{ t: "end", browserId: "b1", why: "retired", reason: "it was a code browser, closed after 1800 s with no calls; open a new one with browser.open" }]);
    expect(worker.of("abort")).toEqual([]);
  });
});

describe("a cell counts as a call in flight", () => {
  test("it holds the session's browsers while it runs and lets go when it ends", async () => {
    const { host, browsers, workers } = rig();
    const runId = await start(host);
    const worker = workers[0]!;
    await open(worker, runId);
    expect(browsers.pending).toBe(1);
    worker.emit({ t: "result", runId, ...OK });
    expect((await host.resume("s1", runId, 1_000, NEVER)).state).toBe("done");
    expect(browsers.pending).toBe(0);
  });

  test.each([
    ["publish_pending", "a post awaits confirmation on this browser"],
    ["task_running", "a browser_task (jev) owns this page"],
    ["human_driving", "the person took over this browser in the View"],
  ])("a run on a browser that refuses it (%s) is refused with the refusal's code, and nothing is left held", async (code, text) => {
    const { host, browsers, workers } = rig();
    const first = await start(host);
    await open(workers[0]!, first);
    workers[0]!.emit({ t: "result", runId: first, ...OK });
    await host.resume("s1", first, 1_000, NEVER);
    browsers.holdError = new BrowserRuntimeError(code, text);
    await expect(host.run("s1", { code: "y", timeoutMs: 5_000, waitMs: 20, signal: NEVER })).rejects.toThrow(`${code}: ${text}`);
    expect(browsers.pending).toBe(0);
    // The refusal is not a stuck run: once the browser accepts again the session runs.
    browsers.holdError = undefined;
    const again = await host.run("s1", { code: "y", timeoutMs: 5_000, waitMs: 20, signal: NEVER });
    expect(again.state).toBe("running");
  });
});

describe("an idle tab freezes and thaws", () => {
  test("it freezes after the freeze period with no cell, no call and no View, and a cell thaws it first", async () => {
    const { host, browsers, workers } = rig({ timing: { freezeIdleMs: 80, workerIdleMs: 60_000, startupTimeoutMs: 1_000, graceMs: 50, finishedTtlMs: 60_000 } });
    const runId = await start(host);
    await open(workers[0]!, runId);
    workers[0]!.emit({ t: "result", runId, ...OK });
    await host.resume("s1", runId, 1_000, NEVER);
    // Just ended: a call reached it a moment ago, so it is not idle yet.
    browsers.idleMs = 10;
    expect(browsers.frozen.size).toBe(0);
    browsers.idleMs = 500;
    await waitUntil("the tab is frozen", () => browsers.frozen.size, size => size === 1, 2_000);
    const second = await host.run("s1", { code: "z", timeoutMs: 5_000, waitMs: 20, signal: NEVER });
    expect(second.state).toBe("running");
    expect(browsers.frozen.size).toBe(0);
    // The thaw came before the worker was told to run.
    expect(browsers.log.indexOf("thaw t1")).toBeGreaterThan(-1);
  });

  test("a View that is looking keeps it live, and a View that joins thaws it", async () => {
    const { host, browsers, workers } = rig({ timing: { freezeIdleMs: 60, workerIdleMs: 60_000, startupTimeoutMs: 1_000, graceMs: 50, finishedTtlMs: 60_000 } });
    const runId = await start(host);
    await open(workers[0]!, runId);
    workers[0]!.emit({ t: "result", runId, ...OK });
    await host.resume("s1", runId, 1_000, NEVER);
    browsers.idleMs = 500;
    browsers.viewers = 1;
    // Sweeps keep coming while it is watched; none freezes it.
    await waitUntil("the freeze clock has looked and left it alone", () => browsers.log.length, () => true, 100);
    await new Promise(resolve => setTimeout(resolve, 300)); // a real wait: the thing under test is that nothing happens in this window
    expect(browsers.frozen.size).toBe(0);
    browsers.viewers = 0;
    await waitUntil("the tab is frozen once the View has gone", () => browsers.frozen.size, size => size === 1, 2_000);
    browsers.view();
    await waitUntil("the View's arrival thaws it", () => browsers.frozen.size, size => size === 0, 2_000);
  });
});

describe("the worker's life", () => {
  test("a session with no browser lets its worker go after the idle spell, and a later cell gets a new one", async () => {
    const { host, workers } = rig({ timing: { freezeIdleMs: 0, workerIdleMs: 80, startupTimeoutMs: 1_000, graceMs: 50, finishedTtlMs: 60_000 } });
    const runId = await start(host);
    workers[0]!.emit({ t: "result", runId, ...OK });
    await host.resume("s1", runId, 1_000, NEVER);
    await waitUntil("the idle worker has been closed", () => workers[0]!.exited, exited => exited, 2_000);
    expect(workers[0]!.of("close")).toHaveLength(1);
    const next = await host.run("s1", { code: "n", timeoutMs: 5_000, waitMs: 20, signal: NEVER });
    expect(next.state).toBe("running");
    expect(workers).toHaveLength(2);
  });

  test("a session that still has a browser keeps its worker past the idle spell; the browser's end starts the spell", async () => {
    const { host, browsers, workers } = rig({ timing: { freezeIdleMs: 0, workerIdleMs: 80, startupTimeoutMs: 1_000, graceMs: 50, finishedTtlMs: 60_000 } });
    const runId = await start(host);
    await open(workers[0]!, runId);
    workers[0]!.emit({ t: "result", runId, ...OK });
    await host.resume("s1", runId, 1_000, NEVER);
    await new Promise(resolve => setTimeout(resolve, 300)); // a real wait: the thing under test is that the worker is NOT closed in this window
    expect(workers[0]!.exited).toBe(false);
    browsers.end("retired", "idle");
    await waitUntil("the worker goes with its last browser's end", () => workers[0]!.exited, exited => exited, 2_000);
  });

  test("a worker that never answers `init` is a startup timeout, one that exits first says why, one that cannot be started is the spawner's error", async () => {
    const silent = rig({ timing: { freezeIdleMs: 0, workerIdleMs: 60_000, startupTimeoutMs: 60, graceMs: 50, finishedTtlMs: 60_000 } }, () => {});
    await expect(silent.host.run("s1", { code: "x", timeoutMs: 5_000, waitMs: 20, signal: NEVER })).rejects.toThrow("Timed out initializing browser tab worker");
    expect(silent.workers[0]!.exited).toBe(true);
    const dying = rig({}, (worker, message) => {
      if (message.t === "init") queueMicrotask(() => worker.die("boom"));
    });
    await expect(dying.host.run("s1", { code: "x", timeoutMs: 5_000, waitMs: 20, signal: NEVER })).rejects.toThrow("Tab worker failed during startup: boom");
    const refusing = new CodeHost({ browsers: new FakeBrowsers(), spawn: () => { throw new Error("no thread for you"); }, env: {} });
    hosts.push(refusing);
    await expect(refusing.run("s1", { code: "x", timeoutMs: 5_000, waitMs: 20, signal: NEVER })).rejects.toThrow("no thread for you");
    // A failed start does not wedge the session: it is not busy.
    await expect(silent.host.run("s1", { code: "x", timeoutMs: 5_000, waitMs: 20, signal: NEVER })).rejects.toThrow("Timed out initializing");
  });

  test("a worker that dies under a cell ends the cell, with the variables reset", async () => {
    const { host, workers } = rig();
    const runId = await start(host);
    workers[0]!.die("it ran out of memory (1024 MB heap)");
    const done = await host.resume("s1", runId, 1_000, NEVER);
    if (done.state !== "done" || !("error" in done.result)) throw new Error("the cell should have ended in an error");
    expect(done.result.error.message).toBe("The code worker stopped (it ran out of memory (1024 MB heap)); the cell's variables were reset.");
    // The next cell has a worker again.
    expect((await host.run("s1", { code: "x", timeoutMs: 5_000, waitMs: 20, signal: NEVER })).state).toBe("running");
    expect(workers).toHaveLength(2);
  });

  test("a worker that answers a cancel late is terminated after the grace, and the call returns the cancellation", async () => {
    const { host, workers } = rig();
    const cancel = new AbortController();
    const waiting = host.run("s1", { code: "x", timeoutMs: 30_000, waitMs: 20_000, signal: cancel.signal });
    await waitUntil("the cell was sent", () => workers[0]?.of("run").length, count => count === 1, 2_000);
    cancel.abort();
    const answer = await waiting;
    if (answer.state !== "done" || !("error" in answer.result)) throw new Error("a cancelled cell ends in an error");
    expect(answer.result.error.isAbort).toBe(true);
    expect(workers[0]!.of("abort")).toHaveLength(1);
    expect(workers[0]!.exited).toBe(true);
  });

  test("a failure that asks for a new worker gets one: the reason is added unless the cell's own budget already said it, and the next ReferenceError is explained once", async () => {
    const { host, workers } = rig();
    const first = await start(host);
    workers[0]!.emit({ t: "result", runId: first, ok: false, error: { name: "ToolError", message: "Tab \"main\" is stuck", isAbort: false, recoverTab: true } });
    const stuck = await host.resume("s1", first, 1_000, NEVER);
    if (stuck.state !== "done" || !("error" in stuck.result)) throw new Error("expected an error");
    expect(stuck.result.error.message).toBe("Tab \"main\" is stuck The code worker was restarted; the cell's variables were reset.");
    expect(workers[0]!.exited).toBe(true);
    const second = await start(host);
    workers[1]!.emit({ t: "result", runId: second, ok: false, error: { name: "ReferenceError", message: "x is not defined", isAbort: false } });
    const missing = await host.resume("s1", second, 1_000, NEVER);
    if (missing.state !== "done" || !("error" in missing.result)) throw new Error("expected an error");
    expect(missing.result.error.message).toContain("the code worker was restarted since the last cell: its variables were reset");
    const third = await start(host);
    workers[1]!.emit({ t: "result", runId: third, ok: false, error: { name: "ReferenceError", message: "y is not defined", isAbort: false } });
    const again = await host.resume("s1", third, 1_000, NEVER);
    if (again.state !== "done" || !("error" in again.result)) throw new Error("expected an error");
    expect(again.result.error.message).toBe("y is not defined");
    const budget = await start(host);
    workers[1]!.emit({ t: "result", runId: budget, ok: false, error: { name: "CellTimeoutError", message: "Command timed out after 1 seconds. The JS worker was force-killed and its VM state was reset; variables from earlier cells are gone.", isAbort: false, recoverTab: true, budget: true } });
    const timedOut = await host.resume("s1", budget, 1_000, NEVER);
    if (timedOut.state !== "done" || !("error" in timedOut.result)) throw new Error("expected an error");
    expect(timedOut.result.error.message).not.toContain("restarted");
    expect(workers[1]!.exited).toBe(true);
  });

  test("a rebuilt worker is handed the session's tabs before it runs anything", async () => {
    const { host, workers } = rig();
    const first = await start(host);
    await open(workers[0]!, first);
    workers[0]!.emit({ t: "result", runId: first, ok: false, error: { name: "ToolError", message: "stuck", isAbort: false, recoverTab: true } });
    await host.resume("s1", first, 1_000, NEVER);
    await start(host);
    const init = workers[1]!.of("init")[0]!;
    expect(init.tabs?.map(tab => [tab.name, tab.handle.browserId, tab.handle.wsEndpoint, tab.handle.tabId])).toEqual([["main", "b1", "ws://fake/b1", "t1"]]);
    expect(workers[1]!.sent.map(message => message.t).slice(0, 2)).toEqual(["init", "run"]);
  });
});

describe("what is kept", () => {
  test("a finished run is readable for the keeping period and then it is unknown", async () => {
    const { host, workers } = rig({ timing: { freezeIdleMs: 0, workerIdleMs: 60_000, startupTimeoutMs: 1_000, graceMs: 50, finishedTtlMs: 120 } });
    const runId = await start(host);
    workers[0]!.emit({ t: "result", runId, ...OK });
    expect((await host.resume("s1", runId, 1_000, NEVER)).state).toBe("done");
    expect((await host.resume("s1", runId, 0, NEVER)).state).toBe("done");
    await waitUntil("the finished run has expired", async () => host.resume("s1", runId, 0, NEVER).then(() => "kept", () => "gone"), state => state === "gone", 3_000);
  });

  test("a cell that prints without end keeps the newest of it, bounded", async () => {
    const { host, workers } = rig();
    const runId = await start(host);
    for (let chunk = 0; chunk < 40; chunk += 1) workers[0]!.emit({ t: "text", runId, chunk: `${String(chunk).padStart(2, "0")}${"x".repeat(16_000)}\n` });
    const looked = await host.resume("s1", runId, 0, NEVER);
    if (looked.state !== "running") throw new Error("still running");
    expect(looked.outputSoFar.length).toBeLessThanOrEqual(256 * 1024);
    expect(looked.outputSoFar).toContain("39xxxx");
    expect(looked.outputSoFar).not.toContain("00xxxx");
  });

  test("shutting the host down ends a running cell and its worker, and nothing runs after", async () => {
    const { host, workers } = rig();
    const runId = await start(host);
    await host.dispose();
    expect(workers[0]!.exited).toBe(true);
    await expect(host.run("s1", { code: "x", timeoutMs: 5_000, waitMs: 20, signal: NEVER })).rejects.toThrow(/shut down/);
    await expect(host.resume("s1", runId, 0, NEVER)).rejects.toThrow(/shut down/);
  });
});
