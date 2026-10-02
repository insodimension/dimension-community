/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the browser server outlives its host, or leaves a stuck cell's child process behind. A host lets a pack go by closing its stdin and then, if the pack is still there, kills it:
 * the SDK's StdioClientTransport after 2,000 ms (SIGTERM, which is TerminateProcess on Windows: nothing in the server runs after it), OMP's transport at once. A cell inside a native call (an `execSync` of a dev
 * server) or a Chrome that will not close used to keep the server, and every Chrome of every session, alive for as long as that call ran (39.8 s measured, never for a command that never ends); a stop that needs
 * longer than the host's window loses its cell's child process (a dev server, `ping -t`) to an orphan. The real process is proven in code-bundle.test.ts; this holds the decision itself, against scripted ports.
 */
import { describe, expect, test } from "bun:test";
import { createShutdown, SHUTDOWN_TIMING, type ShutdownDeps } from "../src/shutdown";

const TIMING = { backstopMs: 60, killBrowsersMs: 25, reapMs: 25 };

interface Rig {
  deps: ShutdownDeps;
  calls: string[];
  /** Let the polite stop finish (or fail). */
  finish(error?: Error): void;
  /** Let the reap finish. */
  reaped(): void;
  threads: { alive: number };
}

function rig(options: { stops?: boolean; atRisk?: boolean; reapEnds?: boolean } = {}): Rig {
  const calls: string[] = [];
  const stop = Promise.withResolvers<void>();
  const reap = Promise.withResolvers<void>();
  const threads = { alive: 0 };
  const deps: ShutdownDeps = {
    stop: () => {
      calls.push("stop");
      return options.stops === false ? Promise.withResolvers<void>().promise : stop.promise;
    },
    killBrowsers: async limitMs => void calls.push(`killBrowsers ${limitMs}`),
    childrenAtRisk: () => options.atRisk ?? false,
    reapChildren: () => {
      calls.push("reap");
      return options.reapEnds === false ? Promise.withResolvers<void>().promise : reap.promise;
    },
    unexitedThreads: () => threads.alive,
    exit: code => void calls.push(`exit ${code}`),
    killSelf: () => void calls.push("killSelf"),
  };
  return { deps, calls, finish: error => (error === undefined ? stop.resolve() : stop.reject(error)), reaped: () => reap.resolve(), threads };
}

describe("how the server's process ends", () => {
  test("a stop that finishes with no thread left ends the process the ordinary way, with status 0, and starts no reap when nothing is at risk", async () => {
    const { deps, calls, finish } = rig();
    const shutdown = createShutdown(deps, TIMING);
    const done = shutdown();
    finish();
    await done;
    expect(calls).toEqual(["stop", "exit 0"]);
  });

  test("a stop that fails still ends the process, with status 1", async () => {
    const { deps, calls, finish } = rig();
    const done = createShutdown(deps, TIMING)();
    finish(new Error("a browser would not close"));
    await done;
    expect(calls).toEqual(["stop", "exit 1"]);
  });

  test("a worker thread still alive after the stop (stuck in a native call) is not waited for: the process ends itself", async () => {
    const { deps, calls, finish, threads } = rig();
    threads.alive = 1;
    const done = createShutdown(deps, TIMING)();
    finish();
    await done;
    expect(calls).toEqual(["stop", "reap", "killSelf"]);
  });

  test("a stop that does not finish in time has the browsers killed and the children reaped together, then ends the process, without waiting for the stop", async () => {
    const { deps, calls, reaped } = rig({ stops: false });
    const began = performance.now();
    const done = createShutdown(deps, TIMING)();
    reaped();
    await done;
    expect(calls).toEqual(["stop", "reap", "killBrowsers 25", "killSelf"]);
    // The backstop, not the stop, set the pace.
    expect(performance.now() - began).toBeLessThan(1_000);
  });

  test("a signal and a closed stdin that arrive together stop once", async () => {
    const { deps, calls, finish } = rig();
    const shutdown = createShutdown(deps, TIMING);
    const first = shutdown();
    const second = shutdown();
    finish();
    await Promise.all([first, second]);
    expect(calls).toEqual(["stop", "exit 0"]);
  });
});

describe("a cell is inside a call that cannot be interrupted at the stop", () => {
  test("the reap starts with the stop, not after it: the stop is what waits for the cell's thread, and the reap is what lets that thread go", async () => {
    const { deps, calls, finish, reaped } = rig({ atRisk: true });
    const done = createShutdown(deps, TIMING)();
    // Both are under way before anything has finished.
    expect(calls).toEqual(["reap", "stop"]);
    reaped();
    finish();
    await done;
    expect(calls).toEqual(["reap", "stop", "exit 0"]);
  });

  test("a stop that ends with a thread still alive waits for the reap that is already running, once, and then ends the process", async () => {
    const { deps, calls, finish, reaped, threads } = rig({ atRisk: true });
    threads.alive = 1;
    const done = createShutdown(deps, TIMING)();
    finish();
    reaped();
    await done;
    expect(calls).toEqual(["reap", "stop", "killSelf"]);
  });

  test("a reap that never ends does not hold the process: it is waited for only as long as the timing says", async () => {
    const { deps, calls, finish, threads } = rig({ atRisk: true, reapEnds: false });
    threads.alive = 1;
    const began = performance.now();
    const done = createShutdown(deps, TIMING)();
    finish();
    await done;
    expect(calls).toEqual(["reap", "stop", "killSelf"]);
    expect(performance.now() - began).toBeLessThan(500);
  });

  test("the late path waits for the browsers' kill and the reap at the same time: the longer of the two, not their sum", async () => {
    const { deps, calls } = rig({ stops: false, atRisk: true, reapEnds: false });
    const began = performance.now();
    await createShutdown(deps, { backstopMs: 40, killBrowsersMs: 80, reapMs: 80 })();
    const took = performance.now() - began;
    expect(calls).toEqual(["reap", "stop", "killBrowsers 80", "killSelf"]);
    // 40 ms backstop + the 80 ms both get, not 40 + 80 + 80.
    expect(took).toBeLessThan(40 + 80 + 60);
  });
});

describe("the timing fits the window a host gives", () => {
  test("the whole of it - the backstop, then the kill of the browsers or the reap, whichever is longer - ends before the 2,000 ms the SDK's client waits after closing stdin", () => {
    const { backstopMs, killBrowsersMs, reapMs } = SHUTDOWN_TIMING;
    expect(backstopMs).toBeLessThanOrEqual(1_500);
    expect(backstopMs + Math.max(killBrowsersMs, reapMs)).toBeLessThan(2_000);
  });
});
