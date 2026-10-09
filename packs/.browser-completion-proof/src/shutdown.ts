// How the browser server's process ends (stdio.ts wires it). A host lets a pack go by closing its stdin or by a signal, and then it does not wait: the SDK's StdioClientTransport (the engine's app host) ends stdin, waits
// 2,000 ms, and sends SIGTERM, which Node turns into TerminateProcess on Windows (nothing in the server runs after it); OMP's transport sends SIGTERM straight after ending stdin. Either way the server must be gone, with
// its browsers and the processes its cells started, inside that window, whatever a cell is doing.
//
// Two things keep a polite stop from being enough. `process.exit()` waits for every worker thread of the process, and a thread inside a synchronous native call (an `execSync`, a blocking pipe read) cannot be
// interrupted: the server stayed alive for the whole call (20 s measured) after everything else was closed. And a Chrome that will not close can hold `dispose` for as long as its close timeout (20 s). So the stop
// runs under a deadline, and a process that has anything left that it cannot reclaim by waiting ends itself instead.
//
// The thread in a native call is waiting for a child process (a dev server). Ending that child is what lets the thread go, and on Windows nothing else ever ends it (no process group), so when a cell is in a call at the
// stop the children are reaped WITH the stop, not after it: started last, the reap would not finish inside the host's window.

export interface ShutdownDeps {
  /** The polite stop: the transport, the code host and every browser. */
  stop(): Promise<void>;
  /** Kills every throwaway browser's process tree now, and returns when they are gone or the limit has passed. */
  killBrowsers(limitMs: number): Promise<void>;
  /** Whether a cell is inside a call, a worker that was ended is still stuck in one, or any cell has run: processes a cell started may outlive the server (a detached one always does), and the stop may wait on its thread. */
  childrenAtRisk(): boolean;
  /** Ends the processes cells started below this server (Windows; see reap.ts). Never rejects. */
  reapChildren(): Promise<void>;
  /** Worker threads of this process that have not exited. */
  unexitedThreads(): number;
  /** Ends the process the ordinary way: it flushes, and waits for the worker threads. */
  exit(code: number): void;
  /** Ends the process at once, without waiting for any thread. */
  killSelf(): void;
}

export interface ShutdownTiming {
  /** How long the polite stop gets before the browsers are killed and the process ends anyway. */
  backstopMs: number;
  /** How long the kill of the browsers' process trees gets. */
  killBrowsersMs: number;
  /** How long a reap that was started is waited for once the stop is over or late. */
  reapMs: number;
}

/** The backstop plus the longer of the two limits after it stays under the 2,000 ms of the SDK's client; the kill and the reap run together. */
export const SHUTDOWN_TIMING: ShutdownTiming = { backstopMs: 1_300, killBrowsersMs: 400, reapMs: 400 };

/** Resolves when `work` does or after `ms`, whichever is first. */
async function within(ms: number, work: Promise<unknown>): Promise<void> {
  const limit = Promise.withResolvers<void>();
  const timer = setTimeout(limit.resolve, ms);
  try {
    await Promise.race([work, limit.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** A shutdown that runs once however often it is asked for (a signal and a closed stdin can arrive together). */
export function createShutdown(deps: ShutdownDeps, timing: ShutdownTiming = SHUTDOWN_TIMING): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () => (running ??= (async () => {
    // Sweep alongside the stop whenever a cell has run: even a returned cell may have left a detached child.
    let reaping: Promise<void> | undefined;
    const reap = (): Promise<void> => (reaping ??= deps.reapChildren().catch(() => undefined));
    if (deps.childrenAtRisk()) void reap();
    let failed = false;
    const stopped = deps.stop().then(() => "stopped" as const, (error: unknown) => {
      failed = true;
      console.error(error);
      return "stopped" as const;
    });
    const late = Promise.withResolvers<"late">();
    const timer = setTimeout(late.resolve, timing.backstopMs, "late");
    const outcome = await Promise.race([stopped, late.promise]);
    clearTimeout(timer);
    if (outcome === "late") {
      console.error(`The browser server did not stop within ${timing.backstopMs} ms: its browsers are killed and the process ends now.`);
      const reaped = within(timing.reapMs, reap());
      await Promise.all([deps.killBrowsers(timing.killBrowsersMs).catch(() => undefined), reaped]);
      deps.killSelf();
      return;
    }
    // Stopped. A worker thread that is still alive is stuck in a call nothing can interrupt, and `process.exit()` would wait for that call to return.
    if (deps.unexitedThreads() > 0) {
      console.error("The browser server stopped, but a code worker is stuck inside a native call: the process ends itself instead of waiting for the call.");
      await within(timing.reapMs, reap());
      deps.killSelf();
      return;
    }
    if (reaping !== undefined) await within(timing.reapMs, reaping);
    deps.exit(failed ? 1 : 0);
  })());
}

/** Ends this process now. `SIGKILL` to oneself is the one exit that does not wait for a worker thread (on Windows libuv answers it with TerminateProcess; verified with a thread inside `execSync("ping -n 25 ...")`: gone at once, where `process.exit()` returned after 24.7 s). */
export function killThisProcess(): void {
  try {
    process.kill(process.pid, "SIGKILL");
  } catch {
    // Fall through to the ordinary exit.
  }
  process.exit(1);
}
