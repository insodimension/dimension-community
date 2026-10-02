// Written for the Browser pack (doc 77 §7.4.4, §7.6 L2): the code host. One worker thread per session holds the cell and every tab realm of the session; this class owns the sessions, hears the
// runtime when a browser ends or a View joins one, and is what `browser_run` calls (`CodeHostPort`). The sessions (session.ts) do the work; the runtime (runtime-port.ts) owns the browsers.

import { join } from "node:path";
import type { BrowserRuntime } from "../../runtime.js";
import { defaultRootDir } from "../../store.js";
import type { BridgeRequest, BrowserKind, CodeBrowserPort, CodeHostPort, RunStarted } from "../contracts.js";
import { CODE_IDLE_MS, RuntimeCodeBrowsers } from "./runtime-port.js";
import { CodeSession, DEFAULT_TIMING, type CodeTiming, sessionFolder, unknownRunMessage } from "./session.js";
import { TerminatingWorkers } from "./terminating.js";
import { defaultWorkerEntry, type SpawnWorker, threadWorkerSpawner } from "./transport.js";

/** OMP's default relay endpoint (browser/relay/kind.ts:10). */
const DEFAULT_RELAY_URL = "http://127.0.0.1:9224";
/** A cell's worker thread may hold this much heap before it ends itself; the server and every other session's browsers go on. */
const DEFAULT_HEAP_MB = 1_024;
/** A cell's worker may hold this much in all (JS heap, Buffers, ArrayBuffers) before it is ended and its cell fails; `resourceLimits` bounds only the heap part. */
const DEFAULT_MEMORY_MB = 1_536;

/**
 * What a cell is handed of the server's environment: where programs and temp files live, locale, and puppeteer's own settings. This is hygiene against accidents (a cell that prints `process.env`, a child process
 * that inherits it), NOT a boundary: the worker is a thread of the server's own process, so on Linux `/proc/self/environ` still holds the environment the server started with, and the cell has HOME/USERPROFILE and full
 * Node. It matches OMP's sandbox A. Keeping a secret from a cell takes a separate process (the isolation rung, not built yet).
 */
const CELL_ENV = /^(?:PATH|Path|PATHEXT|SystemRoot|SYSTEMROOT|windir|WINDIR|ComSpec|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LANG|LANGUAGE|LC_[A-Z_]+|TZ|PUPPETEER_[A-Z_]+)$/;

export function scrubbedEnv(source: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && CELL_ENV.test(key)) kept[key] = value;
  return kept;
}

/**
 * What a cell's `browser.open` means, in OMP's order (browser.ts:103-142): `app.cdp_url` is a connected browser, `app.path` a spawned one, `app.relay` the relay, else a headless browser of the pack.
 * Only the last can be acquired in this build (the runtime refuses the others by name); L4's resolver replaces this one.
 */
export function resolveKind(request: BridgeRequest, o: { headless: boolean; relayUrl?: string }): BrowserKind {
  const app = request.app;
  if (app?.cdp_url !== undefined) return { kind: "connected", cdpUrl: app.cdp_url };
  if (app?.path !== undefined) return { kind: "spawned", path: app.path, ...(app.args === undefined ? {} : { args: app.args }) };
  if (app?.relay === true) return { kind: "relay", cdpUrl: o.relayUrl ?? DEFAULT_RELAY_URL };
  return { kind: "headless", headless: o.headless };
}

export interface CodeHostOptions {
  browsers: CodeBrowserPort;
  /** Starts a worker. Default: a `worker_threads` thread running the bundled worker (or its source when run from source). */
  spawn?: SpawnWorker;
  /** The environment the cell's is scrubbed from. Default: this process's. */
  env?: Record<string, string | undefined>;
  /** `browser.open` without `app`: a hidden browser, or the visible one `DIMENSION_BROWSER_HEADLESS=false` asks for. */
  headless?: boolean;
  resolveKind?: (request: BridgeRequest) => BrowserKind;
  screenshotDir?: string;
  /** What a relative `tab.uploadFile` path resolves against; absent: relative paths are refused with the rule named. */
  cwd?: string;
  /** Refuse password inputs from code (matrix D18). Default true. */
  refusePasswordFields?: boolean;
  /** JPEG instead of WebP for the screenshot the model sees. Default false. */
  excludeWebP?: boolean;
  /** The server registers `browser_task` (it does, unconditionally, in this build): the realm's password refusal then names it. Default true. */
  taskCredential?: boolean;
  /** Root of the per-session folders a cell keeps an over-cap output in. Absent: none is kept. */
  artifactsRoot?: string;
  timing?: Partial<CodeTiming>;
  /** The worker thread's heap ceiling, MB. Default 1,024. */
  heapMb?: number;
  /** What a worker may hold in all, MB (heap plus Buffers and ArrayBuffers); past it the worker is ended and the cell fails. Default 1,536; 0 = no limit. */
  memoryMb?: number;
}

export class CodeHost implements CodeHostPort {
  readonly #options: CodeHostOptions;
  readonly #spawn: SpawnWorker;
  readonly #timing: CodeTiming;
  readonly #sessions = new Map<string, CodeSession>();
  /** Shared by every session: workers that were ended but are stuck in a native call count against one cap. */
  readonly #terminating = new TerminatingWorkers();
  readonly #unsubscribe: Array<() => void>;
  #disposed = false;

  constructor(options: CodeHostOptions) {
    this.#options = options;
    this.#spawn = options.spawn ?? threadWorkerSpawner(defaultWorkerEntry(), { maxOldGenerationSizeMb: options.heapMb ?? DEFAULT_HEAP_MB });
    this.#timing = { ...DEFAULT_TIMING, ...options.timing };
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
      const { env: source = process.env, headless = true, artifactsRoot, screenshotDir } = this.#options;
      const resolve = this.#options.resolveKind ?? ((request: BridgeRequest) => resolveKind(request, { headless, ...(source.DIMENSION_BROWSER_RELAY_URL ? { relayUrl: source.DIMENSION_BROWSER_RELAY_URL } : {}) }));
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
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        refusePasswordFields: this.#options.refusePasswordFields ?? true,
        excludeWebP: this.#options.excludeWebP ?? false,
        taskCredential: this.#options.taskCredential ?? true,
        timing: this.#timing,
        onEmpty: () => {
          if (this.#sessions.get(id) === created) this.#sessions.delete(id);
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

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const stop of this.#unsubscribe) stop();
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map(session => session.close()));
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
 * `DIMENSION_BROWSER_CODE_HEAP_MB`, `DIMENSION_BROWSER_CODE_MEMORY_MB` (1,536, 0 = no limit), `DIMENSION_BROWSER_CODE_ISOLATION` (`thread`).
 */
export function createRuntimeCodeHost(runtime: BrowserRuntime, env: Record<string, string | undefined> = process.env): CodeHost {
  // Why the rung is a separate process, checked on Node 22.12 (--experimental-permission) and 24.12 (--permission): a worker thread INHERITS the permission model (reads and child processes were denied inside it, and
  // creating one needs --allow-worker). What cannot be done is to restrict the cell alone: the model is process-wide, and this server itself needs fs and child_process (Chrome, Python, the files it keeps).
  const isolation = env.DIMENSION_BROWSER_CODE_ISOLATION?.trim() || "thread";
  if (isolation !== "thread") {
    throw new RangeError(`DIMENSION_BROWSER_CODE_ISOLATION must be "thread" (got "${isolation}"): the child-process rung under Node's permission model is not built yet, and running a weaker rung than asked for would be silent`);
  }
  const screenshotDir = env.DIMENSION_BROWSER_SCREENSHOT_DIR?.trim();
  return new CodeHost({
    browsers: new RuntimeCodeBrowsers(runtime.codeSeam(), { idleMs: numberEnv(env, "DIMENSION_BROWSER_CODE_IDLE_MS", CODE_IDLE_MS, "milliseconds") }),
    env,
    headless: env.DIMENSION_BROWSER_HEADLESS !== "false",
    artifactsRoot: join(env.DIMENSION_BROWSER_ROOT || defaultRootDir(), "artifacts"),
    ...(screenshotDir ? { screenshotDir: screenshotDir.replace(/^~(?=$|[\\/])/, env.HOME ?? env.USERPROFILE ?? "~") } : {}),
    timing: { freezeIdleMs: numberEnv(env, "DIMENSION_BROWSER_FREEZE_IDLE_MS", DEFAULT_TIMING.freezeIdleMs, "milliseconds") },
    heapMb: numberEnv(env, "DIMENSION_BROWSER_CODE_HEAP_MB", DEFAULT_HEAP_MB, "megabytes"),
    memoryMb: numberEnv(env, "DIMENSION_BROWSER_CODE_MEMORY_MB", DEFAULT_MEMORY_MB, "megabytes"),
    ...(env.DIMENSION_BROWSER_CWD?.trim() ? { cwd: env.DIMENSION_BROWSER_CWD.trim() } : {}),
    refusePasswordFields: env.DIMENSION_BROWSER_ALLOW_PASSWORD_FIELDS?.trim().toLowerCase() !== "true",
    excludeWebP: env.DIMENSION_BROWSER_EXCLUDE_WEBP?.trim().toLowerCase() === "true",
  });
}
