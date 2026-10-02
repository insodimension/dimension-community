// How the browser server's process ends (stdio.ts wires it). A host lets a pack go by closing its stdin or by a signal; either way the server must be gone, with its browsers, in seconds, whatever a cell is doing.
//
// Two things keep a polite stop from being enough. `process.exit()` waits for every worker thread of the process, and a thread inside a synchronous native call (an `execSync`, a blocking pipe read) cannot be
// interrupted: the server stayed alive for the whole call (20 s measured) after everything else was closed. And a Chrome that will not close can hold `dispose` for as long as its close timeout (20 s). So the stop
// runs under a deadline, and a process that has anything left that it cannot reclaim by waiting ends itself instead.

import { spawnSync } from "node:child_process";

export interface ShutdownDeps {
  /** The polite stop: the transport, the code host and every browser. */
  stop(): Promise<void>;
  /** Kills every throwaway browser's process tree now, and returns when they are gone or the limit has passed. */
  killBrowsers(limitMs: number): Promise<void>;
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
}

export const SHUTDOWN_TIMING: ShutdownTiming = { backstopMs: 4_000, killBrowsersMs: 2_500 };

/** A shutdown that runs once however often it is asked for (a signal and a closed stdin can arrive together). */
export function createShutdown(deps: ShutdownDeps, timing: ShutdownTiming = SHUTDOWN_TIMING): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () => (running ??= (async () => {
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
      await deps.killBrowsers(timing.killBrowsersMs).catch(() => undefined);
      deps.killSelf();
      return;
    }
    // Stopped. A worker thread that is still alive is stuck in a call nothing can interrupt, and `process.exit()` would wait for that call to return.
    if (deps.unexitedThreads() > 0) {
      console.error("The browser server stopped, but a code worker is stuck inside a native call: the process ends itself instead of waiting for the call.");
      deps.killSelf();
      return;
    }
    deps.exit(failed ? 1 : 0);
  })());
}

/** Windows has no process group to signal: ending the server leaves what it started running (a stuck cell's child process, a Chrome the polite close missed). */
const REAP_LIMIT_MS = 3_000;
function endChildTrees(): void {
  const script = `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}' | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { taskkill /F /T /PID $_.ProcessId | Out-Null }`;
  try {
    spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: REAP_LIMIT_MS, stdio: "ignore" });
  } catch {
    // Best effort: the server goes either way.
  }
}

/**
 * Ends this process now. `SIGKILL` to oneself is the one exit that does not wait for a worker thread (on Windows libuv answers it with TerminateProcess; verified with a thread inside `execSync("ping -n 25 ...")`: gone at once,
 * where `process.exit()` returned after 24.7 s). Windows first ends the trees below the server, which nothing else would: its children would otherwise outlive it.
 */
export function killThisProcess(): void {
  if (process.platform === "win32") endChildTrees();
  try {
    process.kill(process.pid, "SIGKILL");
  } catch {
    // Fall through to the ordinary exit.
  }
  process.exit(1);
}
