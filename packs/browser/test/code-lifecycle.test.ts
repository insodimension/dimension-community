/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the code host's clocks and refusals. A person takes a browser over and the model's cell goes on clicking in it; a cell runs on a browser a
 * pending post owns; a tab freezes under a View that is looking at it, or never thaws; a worker that died, hung or never started leaves its call waiting for ever; the worker of a session that
 * is gone stays for ever; a finished result is kept for ever.
 *
 * A scripted browser port and a scripted worker, so every clock is short and exact and no Chrome is needed; the real thing is code-host.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BrowserKind, CodeBrowserPort, HostToWorker, RunError, TabRef, WorkerToHost } from "../src/code/contracts";
import { CodeHost, type CodeHostOptions } from "../src/code/host/code-host";
import type { SpawnWorker, WorkerHandle, WorkerMemory } from "../src/code/host/transport";
import { BrowserRuntimeError } from "../src/store";
import { waitUntil } from "./fixture";

const NEVER = new AbortController().signal;

type Behavior = (worker: FakeWorker, message: HostToWorker) => void;

/** A worker the test plays: it answers `init` with `ready`, `close` by exiting, and everything else only when the test says so. */
class FakeWorker {
  readonly sent: HostToWorker[] = [];
  exited = false;
  /** A worker inside a native call: `terminate` cannot end it, and it answers `stuck` after the limit until the test lets the call return. */
  stuck = false;
  /** What the worker says it holds (undefined: it does not answer). */
  memory: WorkerMemory | undefined = { mb: 1, own: true };
  readonly terminateLimits: number[] = [];
  readonly #listeners = new Set<(message: WorkerToHost) => void>();
  readonly #exits: Array<(reason: string) => void> = [];
  #reason = "";
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
      terminate: async limitMs => {
        this.terminateLimits.push(limitMs);
        if (!this.stuck) {
          this.die("terminated");
          return "exited";
        }
        const delay = Promise.withResolvers<void>();
        setTimeout(delay.resolve, limitMs); // the real wait `terminate` makes
        await delay.promise;
        return this.exited ? "exited" : "stuck";
      },
      onExit: handler => (this.exited ? queueMicrotask(() => handler(this.#reason)) : void this.#exits.push(handler)),
      memory: async () => (this.exited ? undefined : this.memory),
    };
  }

  emit(message: WorkerToHost): void {
    for (const listener of [...this.#listeners]) listener(message);
  }

  die(reason: string): void {
    if (this.exited) return;
    this.exited = true;
    this.#reason = reason;
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
  /** A task agent is driving the browser: its steps never reach `idleMs`. */
  working = false;
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

  activity(): { idleMs: number; viewers: number; pending: number; working: boolean } | undefined {
    return this.#browser === undefined ? undefined : { idleMs: this.idleMs, viewers: this.viewers, pending: this.pending, working: this.working };
  }

  existing(): { browserId: string; wsEndpoint: string; kind: BrowserKind } | undefined {
    return this.#browser === undefined ? undefined : { browserId: this.#browser.id, wsEndpoint: "ws://fake/b1", kind: { kind: "headless", headless: true } };
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
    // Thawed for the View, and not left live for ever: the freeze clock runs again, and it freezes once nobody is looking.
    await waitUntil("the tab freezes again after the View's thaw", () => browsers.frozen.size, size => size === 1, 2_000);
  });

  test("a browser a task agent is driving is not frozen, however long it has been since a call reached it; when the task ends it freezes", async () => {
    const { host, browsers, workers } = rig({ timing: { freezeIdleMs: 60, workerIdleMs: 60_000, startupTimeoutMs: 1_000, graceMs: 50, finishedTtlMs: 60_000 } });
    const runId = await start(host);
    await open(workers[0]!, runId);
    workers[0]!.emit({ t: "result", runId, ...OK });
    await host.resume("s1", runId, 1_000, NEVER);
    browsers.idleMs = 500; // the cell's last call was long ago; the task's steps do not move this
    browsers.working = true;
    await new Promise(resolve => setTimeout(resolve, 300)); // a real wait: the thing under test is that nothing happens in this window
    expect(browsers.frozen.size).toBe(0);
    browsers.working = false;
    await waitUntil("the tab is frozen once the task has ended", () => browsers.frozen.size, size => size === 1, 2_000);
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

  test("every worker is told the realm settings in its init: password fields refused unless lifted, and the working directory and WebP choice when the owner set them", async () => {
    const plain = rig();
    await start(plain.host);
    const defaults = plain.workers[0]!.of("init")[0]!;
    expect(defaults.refusePasswordFields).toBe(true);
    expect(defaults.excludeWebP).toBe(false);
    expect(defaults.taskCredential).toBe(false); // a host that was not told the server offers browser_task never sends the model to it
    expect(defaults.cwd).toBeUndefined();
    const set = rig({ refusePasswordFields: false, excludeWebP: true, cwd: "/work/site", taskCredential: true });
    await start(set.host);
    const chosen = set.workers[0]!.of("init")[0]!;
    expect([chosen.refusePasswordFields, chosen.excludeWebP, chosen.cwd, chosen.taskCredential]).toEqual([false, true, "/work/site", true]);
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

const STUCK_TIMING = { freezeIdleMs: 0, workerIdleMs: 60_000, startupTimeoutMs: 1_000, graceMs: 40, terminateMs: 20, closeMs: 60, finishedTtlMs: 60_000 };

/** A worker that is inside a native call from the moment it starts: it never answers `close`, and `terminate` cannot end it. */
const stuckBehavior: Behavior = (worker, message) => {
  if (message.t === "init") {
    worker.stuck = true;
    queueMicrotask(() => worker.emit({ t: "ready" }));
  }
};

describe("a worker that nothing can end", () => {
  test("it does not hold the host's shutdown: dispose returns after the polite wait and the terminate limit, the thread left to end by itself", async () => {
    const { host, workers } = rig({ timing: STUCK_TIMING }, stuckBehavior);
    await start(host);
    const began = performance.now();
    await host.dispose();
    const took = performance.now() - began;
    // closeMs 60 + terminateMs 20: the shutdown waited for neither the call nor the thread.
    expect(took).toBeLessThan(600);
    expect(workers[0]!.exited).toBe(false);
    expect(workers[0]!.terminateLimits).toEqual([20]);
  });

  test("twenty hung cells in a row never leave more than two stuck threads alive; the refusal names the cells; when one returns, cells run again", async () => {
    const { host, workers } = rig({ timing: STUCK_TIMING }, stuckBehavior);
    let mostAlive = 0;
    const refusals: string[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const started = await host.run("s1", { code: `execSync("blocking-${attempt}")`, timeoutMs: 30, waitMs: 2_000, signal: NEVER }).catch((error: Error) => error);
      if (started instanceof Error) refusals.push(started.message);
      else if (started.state !== "done" || !("error" in started.result) || started.result.error.budget !== true) throw new Error("a hung cell ends at its budget");
      mostAlive = Math.max(mostAlive, workers.filter(worker => !worker.exited).length);
    }
    expect(mostAlive).toBe(2);
    expect(workers).toHaveLength(2);
    expect(refusals).toHaveLength(18);
    expect(refusals[0]).toContain("stuck: 2 earlier code workers are still alive inside a call that cannot be interrupted");
    expect(refusals[0]).toContain('execSync(\\"blocking-0\\")');
    expect(refusals[0]).toContain('execSync(\\"blocking-1\\")');
    // One call returns: its thread exits, and the next cell has room for a worker again.
    workers[0]!.die("the call returned");
    const next = await host.run("s1", { code: "x", timeoutMs: 5_000, waitMs: 20, signal: NEVER });
    expect(next.state).toBe("running");
    expect(workers).toHaveLength(3);
  }, 20_000);

  test("workers that end normally are never counted against the cap, however many cells recycle them", async () => {
    const { host, workers } = rig({ timing: STUCK_TIMING });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const runId = await start(host);
      workers.at(-1)!.emit({ t: "result", runId, ok: false, error: { name: "ToolError", message: "stuck tab", isAbort: false, recoverTab: true } });
      await host.resume("s1", runId, 1_000, NEVER);
    }
    expect(workers).toHaveLength(6);
    expect(workers.every(worker => worker.exited)).toBe(true);
  });

  /** A worker of one of these sessions is inside a native call from the moment it starts; every other session's workers behave. */
  const stuckFor = (...sessions: string[]): Behavior => (worker, message) => {
    if (message.t === "init") {
      worker.stuck = sessions.includes(message.session);
      queueMicrotask(() => worker.emit({ t: "ready" }));
    }
    if (message.t === "close" && !worker.stuck) worker.die("closed");
  };

  /** Runs cells that hang in `session` until one is refused; the refusal, or undefined when none was within `attempts`. */
  async function hangUntilRefused(host: CodeHost, session: string, attempts: number): Promise<string | undefined> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const started = await host.run(session, { code: `execSync("${session}-dev-server-${attempt}")`, timeoutMs: 30, waitMs: 2_000, signal: NEVER }).catch((error: Error) => error);
      if (started instanceof Error) return started.message;
    }
    return undefined;
  }

  test("stuck workers are counted per session: a session whose cells never return is refused alone, another session still gets its worker", async () => {
    const { host, workers } = rig({ timing: STUCK_TIMING }, stuckFor("s1"));
    const refusal = await hangUntilRefused(host, "s1", 6);
    expect(refusal).toContain("stuck: 2 earlier code workers");
    // The same session is refused again; a new session and an old one are not.
    expect(await hangUntilRefused(host, "s1", 1)).toContain("stuck: 2 earlier code workers");
    for (const session of ["s2", "s3"]) {
      const started = await host.run(session, { code: "40 + 2", timeoutMs: 5_000, waitMs: 20, signal: NEVER });
      expect(started.state).toBe("running");
    }
    expect(workers.filter(worker => !worker.exited)).toHaveLength(4); // s1's two stuck threads, and one worker each for s2 and s3
  }, 20_000);

  test("a refusal quotes the refused session's own cells and never another session's code", async () => {
    const { host } = rig({ timing: STUCK_TIMING }, stuckFor("s1", "s2"));
    expect(await hangUntilRefused(host, "s1", 6)).toBeDefined();
    const refusal = await hangUntilRefused(host, "s2", 6);
    expect(refusal).toContain("s2-dev-server-0");
    expect(refusal).toContain("s2-dev-server-1");
    expect(refusal).not.toContain("s1-dev-server");
  }, 20_000);

  test("a host-wide cap above the per-session one is the memory backstop: past it every session is refused, and the message holds no session's code", async () => {
    const { host, workers } = rig({ timing: STUCK_TIMING }, stuckFor("s1", "s2", "s3", "s4", "s5"));
    for (const session of ["s1", "s2", "s3", "s4"]) expect(await hangUntilRefused(host, session, 6)).toBeDefined();
    expect(workers.filter(worker => !worker.exited)).toHaveLength(8);
    // A fifth session has no stuck worker of its own, and the host holds eight: it is refused all the same, naming the number and none of the cells.
    const refusal = await host.run("s5", { code: "x", timeoutMs: 30, waitMs: 2_000, signal: NEVER }).catch((error: Error) => error.message);
    expect(refusal).toContain("stuck: 8 code workers");
    expect(refusal).not.toContain("dev-server");
    // One of them returns and the fifth session is served.
    workers[0]!.die("the call returned");
    expect((await host.run("s5", { code: "x", timeoutMs: 5_000, waitMs: 20, signal: NEVER })).state).toBe("running");
  }, 30_000);
});

const MEMORY_TIMING = { freezeIdleMs: 0, workerIdleMs: 60_000, startupTimeoutMs: 1_000, graceMs: 40, terminateMs: 20, closeMs: 60, memoryPollMs: 15, memoryIdlePollMs: 15, finishedTtlMs: 60_000 };

async function ended(host: CodeHost, runId: string): Promise<RunError> {
  const done = await host.resume("s1", runId, 2_000, NEVER);
  if (done.state !== "done" || !("error" in done.result)) throw new Error("the cell should have ended in an error");
  return done.result.error;
}

describe("a worker's memory is bounded, not only its heap", () => {
  test("a cell whose worker grows past the limit fails with the reason, its worker is replaced, and the next cell runs", async () => {
    const { host, workers } = rig({ memoryMb: 100, timing: MEMORY_TIMING });
    const runId = await start(host);
    workers[0]!.memory = { mb: 640, own: true }; // Buffers: the heap limit would never have seen this
    const error = await ended(host, runId);
    expect(error.name).toBe("CellMemoryError");
    expect(error.message).toContain("grew the code worker to 640 MB");
    expect(error.message).toContain("the limit is 100 MB");
    expect(error.message).toContain("variables were reset");
    expect(workers[0]!.exited).toBe(true);
    expect((await host.run("s1", { code: "x", timeoutMs: 5_000, waitMs: 20, signal: NEVER })).state).toBe("running");
    expect(workers).toHaveLength(2);
    expect(workers[1]!.exited).toBe(false);
  });

  test("a worker past the limit with no cell running is ended too, and the next cell is told its variables were reset", async () => {
    const { host, workers } = rig({ memoryMb: 100, timing: MEMORY_TIMING });
    const runId = await start(host);
    workers[0]!.emit({ t: "result", runId, ...OK });
    await host.resume("s1", runId, 1_000, NEVER);
    workers[0]!.memory = { mb: 640, own: true }; // a timer the cell left behind keeps allocating
    await waitUntil("the idle worker is ended", () => workers[0]!.exited, exited => exited, 2_000);
    const next = await start(host);
    workers[1]!.emit({ t: "result", runId: next, ok: false, error: { name: "ReferenceError", message: "kept is not defined", isAbort: false } });
    expect((await ended(host, next)).message).toContain("variables were reset");
  });

  test("a worker that does not answer the memory question is left alone (its budget and the terminate limit are what end a stuck one)", async () => {
    const { host, workers } = rig({ memoryMb: 100, timing: MEMORY_TIMING });
    await start(host);
    workers[0]!.memory = undefined;
    await new Promise(resolve => setTimeout(resolve, 150)); // a real wait: nothing may happen in this window
    expect(workers[0]!.exited).toBe(false);
  });

  test("a cell that starts while the worker is only looked at rarely is looked at quickly from its first moment", async () => {
    // The worker was read once while idle, and the next look is 30 s away: the cell's start must not wait for it.
    const { host, workers } = rig({ memoryMb: 100, timing: { ...MEMORY_TIMING, memoryPollMs: 15, memoryIdlePollMs: 30_000 } });
    const idle = await start(host);
    workers[0]!.emit({ t: "result", runId: idle, ...OK });
    await host.resume("s1", idle, 1_000, NEVER);
    await new Promise(resolve => setTimeout(resolve, 80)); // a real wait: the idle look has happened and the next one is far off
    const runId = await start(host);
    workers[0]!.memory = { mb: 640, own: true };
    expect((await ended(host, runId)).name).toBe("CellMemoryError");
  });

  test("where only the whole process can be measured, the growth during the cell counts, not the level the process was already at", async () => {
    // The server already holds 900 MB (Chrome's pages, other sessions): far over the limit, and the cell has not added a byte.
    const { host, workers } = rig({ memoryMb: 100, timing: MEMORY_TIMING }, (worker, message) => {
      if (message.t !== "init") return;
      worker.memory = { mb: 900, own: false };
      queueMicrotask(() => worker.emit({ t: "ready" }));
    });
    const runId = await start(host);
    await new Promise(resolve => setTimeout(resolve, 150)); // a real wait: nothing may happen in this window
    expect(workers[0]!.exited).toBe(false);
    workers[0]!.memory = { mb: 1_100, own: false }; // the process grew by 200 MB while the cell ran
    const error = await ended(host, runId);
    expect(error.message).toContain("grew the server by 200 MB while it ran");
    expect(workers[0]!.exited).toBe(true);
  });

  test("limits of 0 (per worker and for the host) turn the watchdog off", async () => {
    const { host, workers } = rig({ memoryMb: 0, totalMemoryMb: 0, timing: MEMORY_TIMING });
    await start(host);
    workers[0]!.memory = { mb: 99_999, own: true };
    await new Promise(resolve => setTimeout(resolve, 150)); // a real wait: nothing may happen in this window
    expect(workers[0]!.exited).toBe(false);
  });
});

describe("the code workers' memory is bounded together, not only one by one", () => {
  /** The error session `session`'s run ended in. */
  async function endedIn(host: CodeHost, session: string, runId: string): Promise<RunError> {
    const done = await host.resume(session, runId, 2_000, NEVER);
    if (done.state !== "done" || !("error" in done.result)) throw new Error("the cell should have ended in an error");
    return done.result.error;
  }

  test("sessions that are each under the per-worker limit cannot together pass the host limit: the largest worker is ended with a plain message, the others go on", async () => {
    const { host, workers } = rig({ memoryMb: 200, totalMemoryMb: 300, timing: MEMORY_TIMING });
    const runs = [await start(host, "s1"), await start(host, "s2"), await start(host, "s3")];
    // 100 + 110 + 130 = 340 MB: every worker is under its own 200 MB, the server is not.
    workers[0]!.memory = { mb: 100, own: true };
    workers[1]!.memory = { mb: 130, own: true };
    workers[2]!.memory = { mb: 110, own: true };
    const error = await endedIn(host, "s2", runs[1]!);
    expect(error.name).toBe("CellMemoryError");
    expect(error.message).toContain("held 340 MB together");
    expect(error.message).toContain("the limit is 300 MB");
    expect(error.message).toContain("this cell's worker was the largest at 130 MB");
    expect(error.message).toContain("variables were reset");
    expect(workers.map(worker => worker.exited)).toEqual([false, true, false]); // 210 MB are left: nothing more is ended
    await new Promise(resolve => setTimeout(resolve, 100)); // a real wait: the others must stay
    expect(workers.map(worker => worker.exited)).toEqual([false, true, false]);
  });

  test("the largest is ended whether or not it is running a cell: an idle worker holding the most is the one that goes, and a running neighbour is untouched", async () => {
    const { host, workers } = rig({ memoryMb: 500, totalMemoryMb: 300, timing: MEMORY_TIMING });
    const idle = await start(host, "s1");
    workers[0]!.emit({ t: "result", runId: idle, ...OK });
    await host.resume("s1", idle, 1_000, NEVER);
    const running = await start(host, "s2");
    workers[0]!.memory = { mb: 250, own: true };
    workers[1]!.memory = { mb: 100, own: true };
    await waitUntil("the idle worker is ended", () => workers[0]!.exited, exited => exited, 2_000);
    expect(workers[1]!.exited).toBe(false);
    workers[1]!.emit({ t: "result", runId: running, ...OK });
    expect((await host.resume("s2", running, 1_000, NEVER)).state).toBe("done");
  });

  test("two cells that both see the same growth of a process-wide figure are not added up", async () => {
    const wholeProcess: Behavior = (worker, message) => {
      if (message.t !== "init") return;
      worker.memory = { mb: 900, own: false };
      queueMicrotask(() => worker.emit({ t: "ready" }));
    };
    const { host, workers } = rig({ memoryMb: 1_000, totalMemoryMb: 300, timing: MEMORY_TIMING }, wholeProcess);
    await start(host, "s1");
    await start(host, "s2");
    // One process grew by 200 MB while both cells ran: each cell sees 200 MB, the server holds 200 MB, not 400.
    workers[0]!.memory = { mb: 1_100, own: false };
    workers[1]!.memory = { mb: 1_100, own: false };
    await new Promise(resolve => setTimeout(resolve, 150)); // a real wait: nothing may happen in this window
    expect(workers.map(worker => worker.exited)).toEqual([false, false]);
    workers[0]!.memory = { mb: 1_250, own: false };
    workers[1]!.memory = { mb: 1_250, own: false };
    await waitUntil("the server's growth passed the host limit", () => workers.filter(worker => worker.exited).length, ended => ended >= 1, 2_000);
  });

  test("a host limit of 0 turns only the total off: a worker over its own limit is still ended", async () => {
    const { host, workers } = rig({ memoryMb: 100, totalMemoryMb: 0, timing: MEMORY_TIMING });
    const runId = await start(host, "s1");
    workers[0]!.memory = { mb: 640, own: true };
    expect((await endedIn(host, "s1", runId)).message).toContain("grew the code worker to 640 MB");
  });

  test("no per-worker limit does not turn the total off: the host still bounds what all of them hold", async () => {
    const { host, workers } = rig({ memoryMb: 0, totalMemoryMb: 300, timing: MEMORY_TIMING });
    const runId = await start(host, "s1");
    workers[0]!.memory = { mb: 640, own: true };
    expect((await endedIn(host, "s1", runId)).message).toContain("held 640 MB together");
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
