// Written for the Browser pack (doc 77 §7.4.4). A worker thread that is told to end is not always gone: a cell inside a synchronous native call (`execSync`, a blocking pipe read) holds its thread until
// the call returns, and nothing in Node can interrupt that (measured: `worker.terminate()` answered after 18.4 s for an 18 s `execSync`). Every such thread is tens of MB and may carry a child process, so the host
// counts the workers it has ended but that are still alive, and starts no new ones past a small cap: a model that keeps retrying a hanging command must not add a thread and a process per attempt.
//
// The count is per session. A session that runs `execSync("npm run dev")` (a call that never returns) fills its OWN allowance and is refused, quoting its own cells; it must not lock every other session out of
// `browser_run` for as long as the server lives, and it must not show them its code. A larger host-wide cap stays as the backstop for memory (each stuck thread is tens of MB, whoever owns it): past it every session
// is refused, and the refusal names a number and no session's cells.

import type { WorkerHandle } from "./transport.js";

/** How many workers of ONE session that were told to end may still be alive before that session's next cell is refused. */
export const MAX_TERMINATING_PER_SESSION = 2;
/** How many may be alive across all sessions before every session's next cell is refused: the memory backstop. */
export const MAX_TERMINATING_TOTAL = 8;

/** The longest a cell's first line is quoted in a refusal. */
const LABEL_CHARS = 100;

/** What a cell was running, in one short line, for the message that names it. */
export function cellLabel(code: string): string {
  const flat = code.replace(/\s+/g, " ").trim();
  return flat.length > LABEL_CHARS ? `${flat.slice(0, LABEL_CHARS)}…` : flat;
}

/** Why a new worker may not start: the session's own stuck workers are at their allowance, or the host's total is. */
export type Room = "room" | "session-full" | "host-full";

interface Counted {
  session: string;
  label: string;
}

export class TerminatingWorkers {
  readonly #alive = new Map<WorkerHandle, Counted>();
  #waiters: Array<() => void> = [];

  constructor(readonly perSession: number = MAX_TERMINATING_PER_SESSION, readonly total: number = MAX_TERMINATING_TOTAL) {}

  /** Workers told to end that have not exited yet, in all sessions. */
  get size(): number {
    return this.#alive.size;
  }

  /** What each of one session's stuck workers was running: only that session's cells. */
  labels(session: string): string[] {
    return [...this.#alive.values()].filter(entry => entry.session === session).map(entry => entry.label);
  }

  /** Counts `handle`, a worker of `session`, from now until it exits. */
  add(session: string, handle: WorkerHandle, label: string): void {
    if (this.#alive.has(handle)) return;
    this.#alive.set(handle, { session, label });
    handle.onExit(() => {
      this.#alive.delete(handle);
      const waiting = this.#waiters;
      this.#waiters = [];
      for (const wake of waiting) wake();
    });
  }

  #verdict(session: string): Room {
    if (this.size >= this.total) return "host-full";
    return this.labels(session).length >= this.perSession ? "session-full" : "room";
  }

  /** Whether a new worker of `session` may start. A worker that is ending normally leaves within milliseconds, so this waits up to `waitMs` for room before it says no. */
  async room(session: string, waitMs: number): Promise<Room> {
    const deadline = Date.now() + waitMs;
    for (let verdict = this.#verdict(session); ; verdict = this.#verdict(session)) {
      if (verdict === "room") return verdict;
      const left = deadline - Date.now();
      if (left <= 0) return verdict;
      const gate = Promise.withResolvers<void>();
      const timer = setTimeout(gate.resolve, left);
      this.#waiters.push(gate.resolve);
      await gate.promise;
      clearTimeout(timer);
    }
  }
}
