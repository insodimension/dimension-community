/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a cell that has already ended (its budget ran out, its worker died, it returned) leaves a work hold on a browser behind when a `browser.open` or `browser.tabs`
 * it started finishes late. Nothing releases that hold again, so the runtime counts the browser as working for good: it never idle-closes, is never closed to make room, never freezes, and the session's
 * worker never starts its idle clock, until the server stops.
 *
 * A scripted browser port whose `acquire` and `tabs` answer when the test says so, and a scripted worker, like code-lifecycle.test.ts; the real thing is code-host.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BrowserKind, CodeBrowserPort, HostToWorker, RunError, TabRef, WorkerToHost } from "../src/code/contracts";
import { CodeHost } from "../src/code/host/code-host";
import type { SpawnWorker, WorkerHandle } from "../src/code/host/transport";
import { waitUntil } from "./fixture";

const NEVER = new AbortController().signal;
const HEADLESS: BrowserKind = { kind: "headless", headless: true };

/** A worker the test plays: it answers `init` with `ready` and `close` by exiting; everything else only when the test says so. */
class FakeWorker {
  readonly sent: HostToWorker[] = [];
  exited = false;
  readonly #listeners = new Set<(message: WorkerToHost) => void>();
  readonly #exits: Array<(reason: string) => void> = [];
  readonly handle: WorkerHandle;
  constructor() {
    this.handle = {
      transport: {
        send: message => {
          this.sent.push(message);
          if (message.t === "init") queueMicrotask(() => this.emit({ t: "ready" }));
          if (message.t === "close") this.die("closed");
        },
        onMessage: handler => {
          this.#listeners.add(handler);
          return () => void this.#listeners.delete(handler);
        },
        close: () => this.die("closed"),
      },
      terminate: async () => {
        this.die("terminated");
        return "exited";
      },
      onExit: handler => void this.#exits.push(handler),
      warm: async () => undefined,
      memory: async () => (this.exited ? undefined : { mb: 1, own: true }),
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

  reply(id: number): Extract<HostToWorker, { t: "bridge-reply" }> | undefined {
    return this.sent.find((message): message is Extract<HostToWorker, { t: "bridge-reply" }> => message.t === "bridge-reply" && message.id === id);
  }
}

/**
 * A browser port that holds `acquire` (and the first browser's `tabs`) until the test lets it go, and counts the work holds the host takes per browser. `honorsSignal`: `acquire` gives up when its signal aborts, like
 * the runtime's own port; without it `acquire` answers whatever the signal says, which is a launch that finishes in the same instant as the abort.
 */
class GatedBrowsers implements CodeBrowserPort {
  readonly held = new Map<string, number>();
  readonly released: string[] = [];
  readonly acquireGate = Promise.withResolvers<void>();
  readonly tabsGate = Promise.withResolvers<void>();
  acquireSignal: AbortSignal | undefined;
  gateAcquire = false;
  honorsSignal = false;
  gateTabs = false;
  tabsOf: string[] = [];
  /** A browser the person opened in the View, which no cell has named. */
  viewBrowser: string | undefined;
  #serial = 0;

  holds(browserId: string): number {
    return this.held.get(browserId) ?? 0;
  }

  async acquire(_session: string, _req: unknown, signal: AbortSignal): Promise<{ browserId: string; created: boolean; wsEndpoint: string }> {
    this.acquireSignal = signal;
    if (this.gateAcquire) {
      const aborted = Promise.withResolvers<never>();
      if (this.honorsSignal) signal.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
      await Promise.race([this.acquireGate.promise, aborted.promise]);
    }
    return { browserId: "b1", created: true, wsEndpoint: "ws://fake/b1" };
  }

  isProfileBrowser(): boolean {
    return false;
  }

  async openTab(_browserId: string, o: { url?: string }): Promise<TabRef> {
    this.#serial += 1;
    return { tabId: `t${this.#serial}`, targetId: `t${this.#serial}`, url: o.url ?? "about:blank", title: "", active: true };
  }

  async navigateTab(): Promise<TabRef> {
    throw new Error("not scripted");
  }

  async findTab(): Promise<TabRef | undefined> {
    return undefined;
  }

  async tabs(browserId: string): Promise<TabRef[]> {
    this.tabsOf.push(browserId);
    if (this.gateTabs && browserId === "b1") await this.tabsGate.promise;
    return [];
  }

  async closeTab(): Promise<void> {}

  async setFrozen(): Promise<void> {}

  setDialogPolicy(): void {}

  async resize(): Promise<void> {}

  setPersist(): void {}

  activity(): undefined {
    return undefined;
  }

  existing(): { browserId: string; wsEndpoint: string; kind: BrowserKind } | undefined {
    return this.viewBrowser === undefined ? undefined : { browserId: this.viewBrowser, wsEndpoint: `ws://fake/${this.viewBrowser}`, kind: HEADLESS };
  }

  ownedByAnotherChat(): boolean {
    return false;
  }

  holdWork(browserId: string): () => void {
    this.held.set(browserId, this.holds(browserId) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.held.set(browserId, this.holds(browserId) - 1);
    };
  }

  async release(browserId: string): Promise<void> {
    this.released.push(browserId);
  }

  onEnd(): () => void {
    return () => undefined;
  }

  onViewed(): () => void {
    return () => undefined;
  }
}

const hosts: CodeHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

function rig(): { host: CodeHost; browsers: GatedBrowsers; worker: () => FakeWorker } {
  const browsers = new GatedBrowsers();
  const workers: FakeWorker[] = [];
  const spawn: SpawnWorker = () => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker.handle;
  };
  const host = new CodeHost({ browsers, spawn, env: {}, timing: { freezeIdleMs: 0, workerIdleMs: 60_000, startupTimeoutMs: 1_000, graceMs: 50, finishedTtlMs: 60_000 } });
  hosts.push(host);
  return {
    host,
    browsers,
    worker: () => {
      const worker = workers[0];
      if (worker === undefined) throw new Error("no worker was started");
      return worker;
    },
  };
}

/** Starts a cell the test answers by hand; the call returns at once with the run's id. */
async function start(host: CodeHost): Promise<string> {
  const started = await host.run("s1", { code: "x", timeoutMs: 30_000, waitMs: 20, signal: NEVER });
  if (started.state !== "running") throw new Error("the scripted cell answered by itself");
  return started.runId;
}

const budgetError = (recoverTab: boolean): RunError => ({ name: "CellTimeoutError", message: "The cell ran out of time.", isAbort: false, budget: true, resetNoted: true, ...(recoverTab ? { recoverTab } : {}) });

describe("a cell that ended while its browser.open was still in flight", () => {
  const endings: Array<{ how: string; end: (worker: FakeWorker, runId: string) => void }> = [
    { how: "its budget ran out and the worker was replaced", end: (worker, runId) => worker.emit({ t: "result", runId, ok: false, error: budgetError(true) }) },
    { how: "its worker died", end: worker => worker.die("crashed") },
  ];

  for (const { how, end } of endings) {
    test(`a browser that finishes launching after ${how} is let go, and no work hold is left on it`, async () => {
      const { host, browsers, worker } = rig();
      browsers.gateAcquire = true;
      const runId = await start(host);
      worker().emit({ t: "bridge", id: 1, runId, request: { action: "open", name: "main", url: "http://fake/page" } });
      await waitUntil("the open to reach the browser port", () => browsers.acquireSignal, signal => signal !== undefined);

      end(worker(), runId);
      const done = await host.resume("s1", runId, 1_000, NEVER);
      expect(done.state).toBe("done");

      browsers.acquireGate.resolve();
      // Either the late launch is let go, or the host took a hold on it: both are what the host does once the launch is back.
      await waitUntil("the host to deal with the late launch", () => ({ held: browsers.holds("b1"), released: browsers.released.length }), seen => seen.held > 0 || seen.released > 0);

      expect(browsers.holds("b1")).toBe(0);
      expect(browsers.released).toEqual(["b1"]);
    });
  }

  test("the open's deadline fires when the cell ends, so a launch that gives up on its signal stops launching", async () => {
    const { host, browsers, worker } = rig();
    browsers.gateAcquire = true;
    browsers.honorsSignal = true;
    const runId = await start(host);
    worker().emit({ t: "bridge", id: 1, runId, request: { action: "open", name: "main", url: "http://fake/page" } });
    await waitUntil("the open to reach the browser port", () => browsers.acquireSignal, signal => signal !== undefined);
    expect(browsers.acquireSignal?.aborted).toBe(false);

    worker().emit({ t: "result", runId, ok: false, error: budgetError(false) });
    await host.resume("s1", runId, 1_000, NEVER);

    expect(browsers.acquireSignal?.aborted).toBe(true);
    const reply = await waitUntil("the host's answer to the open", () => worker().reply(1), found => found !== undefined);
    expect(reply?.ok).toBe(false);
    expect(browsers.holds("b1")).toBe(0);
  });
});

describe("a cell that ended while browser.tabs was still walking the session's browsers", () => {
  test("no work hold is taken on a browser the walk reaches after the cell ended", async () => {
    const { host, browsers, worker } = rig();
    const runId = await start(host);
    worker().emit({ t: "bridge", id: 1, runId, request: { action: "open", name: "main", url: "http://fake/page" } });
    await waitUntil("the host's answer to the open", () => worker().reply(1), found => found !== undefined);
    expect(browsers.holds("b1")).toBe(1);

    // The person opened a second browser in the View; the walk holds b1 (held already), asks it for its tabs, and only then reaches b2.
    browsers.viewBrowser = "b2";
    browsers.gateTabs = true;
    worker().emit({ t: "bridge", id: 2, runId, request: { action: "tabs" } });
    await waitUntil("the walk to ask b1 for its tabs", () => browsers.tabsOf, asked => asked.includes("b1"));

    worker().emit({ t: "result", runId, ok: true, payload: { displays: [], screenshots: [] } });
    await host.resume("s1", runId, 1_000, NEVER);
    expect(browsers.holds("b1")).toBe(0);

    browsers.tabsGate.resolve();
    await waitUntil("the host's answer to the tabs call", () => worker().reply(2), found => found !== undefined);

    expect(browsers.holds("b2")).toBe(0);
    expect(browsers.holds("b1")).toBe(0);
  });
});
