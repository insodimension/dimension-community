// Written for the Browser pack (doc 77 §7.4.4). A worker thread that is told to end is not always gone: a cell inside a synchronous native call (`execSync`, a blocking pipe read) holds its thread until
// the call returns, and nothing in Node can interrupt that (measured: `worker.terminate()` answered after 18.4 s for an 18 s `execSync`). Every such thread is tens of MB and may carry a child process, so the host
// counts the workers it has ended but that are still alive, and starts no new ones past a small cap: a model that keeps retrying a hanging command must not add a thread and a process per attempt.

import type { WorkerHandle } from "./transport.js";

/** How many workers that were told to end may still be alive before no new cell starts. */
export const MAX_TERMINATING_WORKERS = 2;

/** The longest a cell's first line is quoted in a refusal. */
const LABEL_CHARS = 100;

/** What a cell was running, in one short line, for the message that names it. */
export function cellLabel(code: string): string {
  const flat = code.replace(/\s+/g, " ").trim();
  return flat.length > LABEL_CHARS ? `${flat.slice(0, LABEL_CHARS)}…` : flat;
}

export class TerminatingWorkers {
  readonly #alive = new Map<WorkerHandle, string>();
  #waiters: Array<() => void> = [];

  constructor(readonly max: number = MAX_TERMINATING_WORKERS) {}

  /** Workers told to end that have not exited yet. */
  get size(): number {
    return this.#alive.size;
  }

  /** What each of them was running. */
  get labels(): string[] {
    return [...this.#alive.values()];
  }

  /** Counts `handle` from now until it exits. */
  add(handle: WorkerHandle, label: string): void {
    if (this.#alive.has(handle)) return;
    this.#alive.set(handle, label);
    handle.onExit(() => {
      this.#alive.delete(handle);
      const waiting = this.#waiters;
      this.#waiters = [];
      for (const wake of waiting) wake();
    });
  }

  /** Whether a new worker may start. A worker that is ending normally leaves within milliseconds, so this waits up to `waitMs` for room before it says no. */
  async hasRoom(waitMs: number): Promise<boolean> {
    if (this.size < this.max) return true;
    const deadline = Date.now() + waitMs;
    while (this.size >= this.max) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      const gate = Promise.withResolvers<void>();
      const timer = setTimeout(gate.resolve, left);
      this.#waiters.push(gate.resolve);
      await gate.promise;
      clearTimeout(timer);
    }
    return true;
  }
}
