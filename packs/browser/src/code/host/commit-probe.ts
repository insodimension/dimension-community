// Written for the Browser pack (doc 77 §7.4.4). What a code worker holds is read from the worker's own isolate where Node can say it (`Worker.getHeapStatistics`, 22.16+ and 24). Where it cannot (22.12 to 22.15, Bun)
// the only figure left is the whole process's, and on Windows the resident set is the wrong one: `Buffer.alloc` is calloc, whose pages are COMMITTED at once and become RESIDENT only when something touches them. A cell that
// pushes `Buffer.alloc(1e8)` in a loop commits memory at several GB/s while `process.memoryUsage.rss()` stays where it was (47 MB before and after 4 x 100 MB, measured on Node 22.12), and commit is what the machine runs out of.
//
// So on Windows the figure is the process's private bytes (what the OS charges against commit), read through ONE long-lived PowerShell that answers a line with a line. It is started when the first worker is, asked every
// 100 ms while any code worker lives (with a cell or without: a timer a cell left behind still allocates; one question serves every worker, at most one is in flight), and ends itself after `idleMs` with nobody asking.
// Measured on Node 22.12, Windows 11, at 10 questions a second: about 9% of one core for the helper while a worker lives (9.8 ms of CPU per question), 0.86% at one question a second, nothing with no questions;
// the server itself +0.2-0.5% of a core. It dies with the server too: its stdin closes, and so does its read loop.
// Where there is no PowerShell the caller falls back to the resident set, which is blind to untouched Buffers on Windows: that is a stated limit, not a silent one (README, PR).

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

const MB = 1024 * 1024;
/** How long one question gets before the caller goes on without an answer. */
const ANSWER_MS = 500;
/** A helper nobody asked for this long ends itself. */
export const COMMIT_PROBE_IDLE_MS = 60_000;
/** After a helper failed to come up, questions leave it alone this long. */
const RETRY_MS = 30_000;

export interface CommitProbeOptions {
  /** The process whose private bytes are read. Default: this one. */
  pid?: number;
  /** After this long without a question the helper ends; the next question starts a new one. */
  idleMs?: number;
  /** The shell that runs the helper. Default `powershell`. */
  shell?: string;
}

export class CommitProbe {
  readonly #pid: number;
  readonly #idleMs: number;
  readonly #shell: string;
  #child: ChildProcess | undefined;
  #started: PromiseWithResolvers<boolean> | undefined;
  #up = false;
  #asking: PromiseWithResolvers<number | undefined> | undefined;
  #idle: NodeJS.Timeout | undefined;
  /** Not before this time is a helper that failed to come up started again by a question (`ready` always tries). */
  #retryAt = 0;

  constructor(options: CommitProbeOptions = {}) {
    this.#pid = options.pid ?? process.pid;
    this.#idleMs = options.idleMs ?? COMMIT_PROBE_IDLE_MS;
    this.#shell = options.shell ?? "powershell";
  }

  /** The helper's pid while it runs (for a test that must prove it gone). */
  get helperPid(): number | undefined {
    return this.#child?.pid;
  }

  #start(): PromiseWithResolvers<boolean> {
    if (this.#started !== undefined) return this.#started;
    const started = Promise.withResolvers<boolean>();
    this.#started = started;
    const script = `$p = [System.Diagnostics.Process]::GetProcessById(${this.#pid}); [Console]::Out.WriteLine('ready'); while ($null -ne [Console]::In.ReadLine()) { $p.Refresh(); [Console]::Out.WriteLine($p.PrivateMemorySize64) }`;
    let child: ChildProcess;
    try {
      child = spawn(this.#shell, ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch {
      started.resolve(false);
      this.#started = undefined;
      return started;
    }
    this.#child = child;
    const gone = (): void => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#started = undefined;
      if (!this.#up) this.#retryAt = Date.now() + RETRY_MS; // it never came up (no such shell, it died at once): do not start one again for every question
      this.#up = false;
      clearTimeout(this.#idle);
      started.resolve(false);
      this.#asking?.resolve(undefined);
      this.#asking = undefined;
    };
    // A spawn that fails (no such shell) is an 'error' event, and a pipe that breaks is one on a stream: unheard, Node would end the server for either.
    child.on("error", gone);
    child.on("exit", gone);
    child.stdin?.on("error", () => undefined);
    child.stdout?.on("error", () => undefined);
    createInterface({ input: child.stdout! }).on("line", line => {
      if (line === "ready") {
        this.#up = true;
        started.resolve(true);
        return;
      }
      const bytes = Number(line);
      if (Number.isFinite(bytes)) this.#asking?.resolve(bytes / MB);
      this.#asking = undefined;
    });
    // The helper never holds the server up: it ends when its stdin does. A child's pipes are sockets at runtime (they have `unref`), though their stream types do not say so.
    child.unref();
    for (const pipe of [child.stdin, child.stdout]) (pipe as unknown as { unref?: () => void } | null)?.unref?.();
    this.#touch();
    return started;
  }

  /** Re-arms the idle clock: any question keeps the helper. */
  #touch(): void {
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.close(), this.#idleMs);
    this.#idle.unref();
  }

  /** Starts the helper if it is not running; resolves true once it has said it is up, false if it cannot be (no shell, it died, `timeoutMs` passed). */
  async ready(timeoutMs: number): Promise<boolean> {
    const started = this.#start();
    this.#touch();
    const limit = Promise.withResolvers<false>();
    const timer = setTimeout(limit.resolve, timeoutMs, false);
    try {
      return await Promise.race([started.promise, limit.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The process's private bytes, MB. Undefined when the helper is not up (it is started for the next question), or does not answer in a moment. At most one question is in flight. */
  async read(): Promise<number | undefined> {
    const child = this.#child;
    if (child === undefined || !this.#up) {
      if (child === undefined && Date.now() >= this.#retryAt) void this.#start().promise;
      return undefined;
    }
    this.#touch();
    if (this.#asking === undefined) {
      this.#asking = Promise.withResolvers<number | undefined>();
      try {
        child.stdin?.write("\n");
      } catch {
        this.#asking.resolve(undefined);
        this.#asking = undefined;
        return undefined;
      }
    }
    const limit = Promise.withResolvers<undefined>();
    const timer = setTimeout(limit.resolve, ANSWER_MS);
    try {
      return await Promise.race([this.#asking.promise, limit.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ends the helper now. A later question starts a new one. */
  close(): void {
    clearTimeout(this.#idle);
    const child = this.#child;
    if (child === undefined) return;
    this.#child = undefined;
    this.#started = undefined;
    this.#up = false;
    this.#asking?.resolve(undefined);
    this.#asking = undefined;
    try {
      child.stdin?.end();
    } catch {
      // Already closed.
    }
    child.kill();
  }
}
