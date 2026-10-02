/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the browser server outlives its host. A host lets a pack go by closing its stdin; a cell inside a native call (an `execSync` of a dev server) or a Chrome that will not close
 * used to keep the server, and every Chrome of every session, alive for as long as that call ran (39.8 s measured, never for a command that never ends). The real process is proven in code-bundle.test.ts; this holds
 * the decision itself, against scripted ports.
 */
import { describe, expect, test } from "bun:test";
import { createShutdown, type ShutdownDeps } from "../src/shutdown";

const TIMING = { backstopMs: 60, killBrowsersMs: 25 };

interface Rig {
  deps: ShutdownDeps;
  calls: string[];
  /** Let the polite stop finish (or fail). */
  finish(error?: Error): void;
  threads: { alive: number };
}

function rig(options: { stops?: boolean } = {}): Rig {
  const calls: string[] = [];
  const stop = Promise.withResolvers<void>();
  const threads = { alive: 0 };
  const deps: ShutdownDeps = {
    stop: () => {
      calls.push("stop");
      return options.stops === false ? Promise.withResolvers<void>().promise : stop.promise;
    },
    killBrowsers: async limitMs => void calls.push(`killBrowsers ${limitMs}`),
    unexitedThreads: () => threads.alive,
    exit: code => void calls.push(`exit ${code}`),
    killSelf: () => void calls.push("killSelf"),
  };
  return { deps, calls, finish: error => (error === undefined ? stop.resolve() : stop.reject(error)), threads };
}

describe("how the server's process ends", () => {
  test("a stop that finishes with no thread left ends the process the ordinary way, with status 0", async () => {
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
    expect(calls).toEqual(["stop", "killSelf"]);
  });

  test("a stop that does not finish in time has the browsers killed first and then ends the process, without waiting for the stop", async () => {
    const { deps, calls } = rig({ stops: false });
    const began = performance.now();
    await createShutdown(deps, TIMING)();
    expect(calls).toEqual(["stop", "killBrowsers 25", "killSelf"]);
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
