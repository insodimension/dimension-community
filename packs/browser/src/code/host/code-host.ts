// Written for the Browser pack (doc 77 §7.4.4, §7.6 L2): the code host. One worker thread per session holds the cell and every tab realm of the session; this class owns the sessions, hears the
// runtime when a browser ends or a View joins one, and is what `browser_run` calls (`CodeHostPort`). The sessions (session.ts) do the work; the runtime (runtime-port.ts) owns the browsers.

import { join } from "node:path";
import type { BrowserRuntime } from "../../runtime.js";
import { defaultRootDir } from "../../store.js";
import type { BridgeRequest, BrowserKind, CodeBrowserPort, CodeHostPort, RunStarted } from "../contracts.js";
import { resolveKind } from "../kinds/resolve.js";
import { CODE_IDLE_MS, RuntimeCodeBrowsers } from "./runtime-port.js";
import { CodeSession, DEFAULT_TIMING, type CodeTiming, unknownRunMessage } from "./session.js";
import type { CommitProbe } from "./commit-probe.js";
import { HostMemory } from "./host-memory.js";
import { TerminatingWorkers } from "./terminating.js";
import { discardSessionSpills, sessionFolder, sweepSpills } from "../spill.js";
import { defaultCommitProbe, defaultWorkerEntry, type SpawnWorker, threadWorkerSpawner } from "./transport.js";

/** A cell's worker thread may hold this much heap before it ends itself; the server and every other session's browsers go on. */
const DEFAULT_HEAP_MB = 1_024;
/**
 * A cell's worker may hold this much in all (JS heap, Buffers, ArrayBuffers). Two things hold it, and neither is a guarantee: the allocation guard in the worker refuses a `Buffer`, `ArrayBuffer` or typed array that would
 * pass it, before it is made (worker/memory-guard.ts; it does not see native modules, `WebAssembly.Memory` or what Node's own internals allocate), and the watchdog reads the worker every 100 ms and ends it past the limit
 * (a look at an interval: a loop allocating faster than that runs past it by the rate times the interval). `resourceLimits` bounds only the heap part.
 */
const DEFAULT_MEMORY_MB = 1_536;
/**
 * All the code workers of the server may hold this much together, across sessions, before the largest is ended. The per-worker limit alone lets ten sessions that each hold 1.4 GB take 14 GB of commit in the one
 * process; this is the best effort against commit exhaustion, not a bound: it is enforced by the same 100 ms look, so what a loop allocates between two looks is not in it. Two full-size workers fit; a third at the same size does not.
 */
const DEFAULT_TOTAL_MEMORY_MB = 3_072;

/**
 * What a cell is handed of the server's environment: where programs and temp files live, locale, and puppeteer's own settings. This is hygiene against accidents (a cell that prints `process.env`, a child process
 * that inherits it), NOT a boundary: the worker is a thread of the server's own process, the cell has HOME/USERPROFILE (the credentials path stays readable by design) and full Node, and a cell that means to read
 * the server's files, network or other processes' command lines can. It matches OMP's sandbox A. The pack's own keys (TYPESAFE_API_KEY, TEXT_MODEL_API_KEY) and any other DIMENSION_* secret are not in the
 * process's environment block at all (secrets.ts takes them out at start), so `process.report.getReport().environmentVariables` shows none either; on Linux `/proc/self/environ` is the environment the process was
 * started with and unsetting does not change it [INFERENCE, not run here].
 *
 * A separate-process rung under Node's permission model would be hardening, not secrecy, and is not built: Node documents the model as a seat belt that code written to bypass it can (already-open file descriptors
 * and symlinks get through; Node 22 and 24 have no network restriction, so a cell could still reach a localhost CDP endpoint and send data out; a granted child_process escapes it altogether). What it would stop is
 * an accident or a casual read of a path, which is not what this host promises to keep from a cell.
 */
const CELL_ENV = /^(?:PATH|Path|PATHEXT|SystemRoot|SYSTEMROOT|windir|WINDIR|ComSpec|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LANG|LANGUAGE|LC_[A-Z_]+|TZ|PUPPETEER_[A-Z_]+)$/;

export function scrubbedEnv(source: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && CELL_ENV.test(key)) kept[key] = value;
  return kept;
}

export interface CodeHostOptions {
  browsers: CodeBrowserPort;
  /** Starts a worker. Default: a `worker_threads` thread running the bundled worker (or its source when run from source). */
  spawn?: SpawnWorker;
  /** The environment the cell's is scrubbed from. Default: this process's. */
  env?: Record<string, string | undefined>;
  /** `browser.open` without `app`: a hidden browser, or the visible one `DIMENSION_BROWSER_HEADLESS=false` asks for. */
  headless?: boolean;
  /** Replaces the choice of browser for a request (kinds/resolve.ts: OMP's order, the pack's environment variables). A test passes its own. */
  resolveKind?: (request: BridgeRequest) => BrowserKind;
  screenshotDir?: string;
  /** What a relative `tab.uploadFile` path resolves against, and what a relative `app.path` of a spawned application is relative to (kinds/resolve.ts). Absent: this process's working directory for `app.path`; relative upload paths are refused with the rule named. */
  cwd?: string;
  /** Refuse password inputs from code (matrix D18). Default true. */
  refusePasswordFields?: boolean;
  /** JPEG instead of WebP for the screenshot the model sees. Default false. */
  excludeWebP?: boolean;
  /** Root of the per-session folders a cell keeps an over-cap output in. Absent: none is kept. */
  artifactsRoot?: string;
  timing?: Partial<CodeTiming>;
  /** The worker thread's heap ceiling, MB. Default 1,024. */
  heapMb?: number;
  /** What a worker may hold in all, MB (heap plus Buffers and ArrayBuffers); past it the worker is ended and the cell fails. Default 1,536; 0 = no limit. */
  memoryMb?: number;
  /** What all the workers may hold together, across sessions, MB; past it the largest worker is ended and its cell fails. Default 3,072; 0 = no limit. */
  totalMemoryMb?: number;
}

export class CodeHost implements CodeHostPort {
  readonly #options: CodeHostOptions;
  readonly #spawn: SpawnWorker;
  readonly #timing: CodeTiming;
  readonly #sessions = new Map<string, CodeSession>();
  /** Shared by every session so the host-wide cap can hold; each session is also counted on its own (a session's stuck workers refuse that session only). */
  readonly #terminating = new TerminatingWorkers();
  /** Every session's worker reports here: the host's total (DIMENSION_BROWSER_CODE_TOTAL_MB). */
  readonly #memory: HostMemory;
  /** Reads the server's commit charge where a worker's own memory cannot be read and the resident set would be blind to it (Windows); this host starts it with the first worker and ends it with itself. */
  readonly #commit: CommitProbe | undefined;
  readonly #unsubscribe: Array<() => void>;
  #disposed = false;

  constructor(options: CodeHostOptions) {
    this.#options = options;
    this.#memory = new HostMemory(options.totalMemoryMb ?? DEFAULT_TOTAL_MEMORY_MB);
    const watchesMemory = (options.memoryMb ?? DEFAULT_MEMORY_MB) > 0 || (options.totalMemoryMb ?? DEFAULT_TOTAL_MEMORY_MB) > 0;
    this.#commit = options.spawn === undefined && watchesMemory ? defaultCommitProbe() : undefined;
    this.#spawn = options.spawn ?? threadWorkerSpawner(defaultWorkerEntry(), { maxOldGenerationSizeMb: options.heapMb ?? DEFAULT_HEAP_MB }, this.#commit);
    this.#timing = { ...DEFAULT_TIMING, ...options.timing };
    // A server that was killed left its sessions' folders behind, and a machine that never spills again would keep them for ever: the age and size bounds are applied once, here.
    if (options.artifactsRoot !== undefined) sweepSpills(options.artifactsRoot);
    this.#unsubscribe = [
      options.browsers.onEnd((browserId, why, reason) => {
        for (const session of this.#sessions.values()) if (session.ownsBrowser(browserId)) session.browserEnded(browserId, why, reason);
      }),
      options.browsers.onViewed(browserId => {
        for (const session of this.#sessions.values()) session.viewed(browserId);
      }),
    ];
  }

  #session(id: string): CodeSession {
    if (this.#disposed) throw new Error("the browser code host is shut down");
    let session = this.#sessions.get(id);
    if (session === undefined) {
      const { env: source = process.env, headless = true, cwd = process.cwd(), artifactsRoot, screenshotDir } = this.#options;
      const resolve = this.#options.resolveKind ?? ((request: BridgeRequest) => resolveKind(request, source, cwd, headless));
      const created: CodeSession = new CodeSession({
        session: id,
        browsers: this.#options.browsers,
        spawn: this.#spawn,
        env: scrubbedEnv(source),
        resolveKind: resolve,
        ...(screenshotDir === undefined ? {} : { screenshotDir }),
        ...(artifactsRoot === undefined ? {} : { outputDir: sessionFolder(artifactsRoot, id) }),
        terminating: this.#terminating,
        memoryMb: this.#options.memoryMb ?? DEFAULT_MEMORY_MB,
        hostMemory: this.#memory,
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        refusePasswordFields: this.#options.refusePasswordFields ?? true,
        excludeWebP: this.#options.excludeWebP ?? false,
        timing: this.#timing,
        onEmpty: () => {
          if (this.#sessions.get(id) !== created) return;
          this.#sessions.delete(id);
          // The session holds no worker, no browser and no run the model can still read: what its cells kept on disk goes with it (doc 77 §7.4.2). A rebuilt worker keeps the folder, because a failed cell's message names a file in it.
          if (artifactsRoot !== undefined) discardSessionSpills(artifactsRoot, id);
        },
      });
      session = created;
      this.#sessions.set(id, session);
    }
    return session;
  }

  async run(session: string, o: Parameters<CodeHostPort["run"]>[1]): Promise<RunStarted> {
    return await this.#session(session).run(o);
  }

  async resume(session: string, runId: string, waitMs: number, signal: AbortSignal): Promise<RunStarted> {
    if (this.#disposed) throw new Error("the browser code host is shut down");
    const held = this.#sessions.get(session);
    if (held === undefined) throw new Error(unknownRunMessage(runId, this.#timing.finishedTtlMs));
    return await held.resume(runId, waitMs, signal);
  }

  /**
   * Whether a stop now may leave processes behind or wait on a thread that will not answer: a cell is running (it may be inside a call to a child process), or a worker this host ended is still alive inside one.
   * The server's shutdown starts its sweep of the cells' child processes with the stop when this is true.
   */
  holdsProcesses(): boolean {
    if (this.#terminating.size > 0) return true;
    for (const session of this.#sessions.values()) if (session.running) return true;
    return false;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const stop of this.#unsubscribe) stop();
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map(([, session]) => session.close()));
    // The browsers go with the server, and so do the files the sessions kept for them.
    if (this.#options.artifactsRoot !== undefined) for (const [id] of sessions) discardSessionSpills(this.#options.artifactsRoot, id);
    await this.#options.browsers.dispose?.();
    this.#commit?.close();
  }
}

type Unit = "milliseconds" | "megabytes";

function numberEnv(env: Record<string, string | undefined>, name: string, fallback: number, unit: Unit): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a number of ${unit}, 0 or more (got "${raw}")`);
  return value;
}

/**
 * The code host `createBrowserServer` starts with: the runtime's own browsers, the environment's settings (doc 77 matrix H7, H8, H9, H13).
 * `DIMENSION_BROWSER_CODE_IDLE_MS` (default 1,800,000, 0 = never), `DIMENSION_BROWSER_FREEZE_IDLE_MS` (20,000, 0 = never), `DIMENSION_BROWSER_SCREENSHOT_DIR`,
 * `DIMENSION_BROWSER_CODE_HEAP_MB`, `DIMENSION_BROWSER_CODE_MEMORY_MB` (1,536, 0 = no limit), `DIMENSION_BROWSER_CODE_TOTAL_MB` (3,072, all workers together, 0 = no limit), `DIMENSION_BROWSER_CODE_ISOLATION` (`thread`).
 */
export function createRuntimeCodeHost(runtime: BrowserRuntime, { env = process.env }: { env?: Record<string, string | undefined> } = {}): CodeHost {
  // Only a thread is built. A separate process under Node's permission model would be hardening, not secrecy (see CELL_ENV): a worker thread INHERITS the model (checked on Node 22.12 with --experimental-permission and
  // 24.12 with --permission: reads and child processes were denied inside it, and creating one needs --allow-worker), the model is process-wide, and this server itself needs fs and child_process (Chrome, Python, its files).
  const isolation = env.DIMENSION_BROWSER_CODE_ISOLATION?.trim() || "thread";
  if (isolation !== "thread") {
    throw new RangeError(`DIMENSION_BROWSER_CODE_ISOLATION must be "thread" (got "${isolation}"): the child-process rung under Node's permission model is not built yet, and running a weaker rung than asked for would be silent`);
  }
  const screenshotDir = env.DIMENSION_BROWSER_SCREENSHOT_DIR?.trim();
  return new CodeHost({
    browsers: new RuntimeCodeBrowsers(runtime.codeSeam(), { idleMs: numberEnv(env, "DIMENSION_BROWSER_CODE_IDLE_MS", CODE_IDLE_MS, "milliseconds"), hidden: env.DIMENSION_BROWSER_HEADLESS !== "false" }),
    env,
    headless: env.DIMENSION_BROWSER_HEADLESS !== "false",
    artifactsRoot: join(env.DIMENSION_BROWSER_ROOT || defaultRootDir(), "artifacts"),
    ...(screenshotDir ? { screenshotDir: screenshotDir.replace(/^~(?=$|[\\/])/, env.HOME ?? env.USERPROFILE ?? "~") } : {}),
    timing: { freezeIdleMs: numberEnv(env, "DIMENSION_BROWSER_FREEZE_IDLE_MS", DEFAULT_TIMING.freezeIdleMs, "milliseconds") },
    heapMb: numberEnv(env, "DIMENSION_BROWSER_CODE_HEAP_MB", DEFAULT_HEAP_MB, "megabytes"),
    memoryMb: numberEnv(env, "DIMENSION_BROWSER_CODE_MEMORY_MB", DEFAULT_MEMORY_MB, "megabytes"),
    totalMemoryMb: numberEnv(env, "DIMENSION_BROWSER_CODE_TOTAL_MB", DEFAULT_TOTAL_MEMORY_MB, "megabytes"),
    ...(env.DIMENSION_BROWSER_CWD?.trim() ? { cwd: env.DIMENSION_BROWSER_CWD.trim() } : {}),
    refusePasswordFields: env.DIMENSION_BROWSER_ALLOW_PASSWORD_FIELDS?.trim().toLowerCase() !== "true",
    excludeWebP: env.DIMENSION_BROWSER_EXCLUDE_WEBP?.trim().toLowerCase() === "true",
  });
}
