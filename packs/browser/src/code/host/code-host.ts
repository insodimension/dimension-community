// Written for the Browser pack (doc 77 §7.4.4, §7.6 L2): the code host. One worker thread per session holds the cell and every tab realm of the session; this class owns the sessions, hears the
// runtime when a browser ends or a View joins one, and is what `browser_run` calls (`CodeHostPort`). The sessions (session.ts) do the work; the runtime (runtime-port.ts) owns the browsers.

import { join } from "node:path";
import type { BrowserRuntime } from "../../runtime.js";
import { defaultRootDir } from "../../store.js";
import type { BridgeRequest, BrowserKind, CodeBrowserPort, CodeHostPort, RunStarted } from "../contracts.js";
import { CODE_IDLE_MS, RuntimeCodeBrowsers } from "./runtime-port.js";
import { CodeSession, DEFAULT_TIMING, type CodeTiming, sessionFolder, unknownRunMessage } from "./session.js";
import { defaultWorkerEntry, type SpawnWorker, threadWorkerSpawner } from "./transport.js";

/** OMP's default relay endpoint (browser/relay/kind.ts:10). */
const DEFAULT_RELAY_URL = "http://127.0.0.1:9224";
/** A cell's worker thread may hold this much heap before it ends itself; the server and every other session's browsers go on. */
const DEFAULT_HEAP_MB = 1_024;

/** What a cell may see of the server's environment (doc 77 §7.4.5): where programs and temp files live, locale, and puppeteer's own settings; never a key. */
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
  /** Root of the per-session folders a cell keeps an over-cap output in. Absent: none is kept. */
  artifactsRoot?: string;
  timing?: Partial<CodeTiming>;
  /** The worker thread's heap ceiling, MB. Default 1,024. */
  heapMb?: number;
}

export class CodeHost implements CodeHostPort {
  readonly #options: CodeHostOptions;
  readonly #spawn: SpawnWorker;
  readonly #timing: CodeTiming;
  readonly #sessions = new Map<string, CodeSession>();
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

  run(session: string, o: Parameters<CodeHostPort["run"]>[1]): Promise<RunStarted> {
    return this.#session(session).run(o);
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

function numberEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a number of milliseconds, 0 or more (got "${raw}")`);
  return value;
}

/**
 * The code host `createBrowserServer` starts with: the runtime's own browsers, the environment's settings (doc 77 matrix H7, H8, H9, H13).
 * `DIMENSION_BROWSER_CODE_IDLE_MS` (default 1,800,000, 0 = never), `DIMENSION_BROWSER_FREEZE_IDLE_MS` (20,000, 0 = never), `DIMENSION_BROWSER_SCREENSHOT_DIR`,
 * `DIMENSION_BROWSER_CODE_HEAP_MB`, `DIMENSION_BROWSER_CODE_ISOLATION` (`thread`).
 */
export function createRuntimeCodeHost(runtime: BrowserRuntime, env: Record<string, string | undefined> = process.env): CodeHost {
  const isolation = env.DIMENSION_BROWSER_CODE_ISOLATION?.trim() || "thread";
  if (isolation !== "thread") {
    throw new RangeError(`DIMENSION_BROWSER_CODE_ISOLATION must be "thread" (got "${isolation}"): the child-process rung under Node's permission model is not built yet, and running a weaker rung than asked for would be silent`);
  }
  const screenshotDir = env.DIMENSION_BROWSER_SCREENSHOT_DIR?.trim();
  return new CodeHost({
    browsers: new RuntimeCodeBrowsers(runtime.codeSeam(), { idleMs: numberEnv(env, "DIMENSION_BROWSER_CODE_IDLE_MS", CODE_IDLE_MS) }),
    env,
    headless: env.DIMENSION_BROWSER_HEADLESS !== "false",
    artifactsRoot: join(env.DIMENSION_BROWSER_ROOT || defaultRootDir(), "artifacts"),
    ...(screenshotDir ? { screenshotDir: screenshotDir.replace(/^~(?=$|[\\/])/, env.HOME ?? env.USERPROFILE ?? "~") } : {}),
    timing: { freezeIdleMs: numberEnv(env, "DIMENSION_BROWSER_FREEZE_IDLE_MS", DEFAULT_TIMING.freezeIdleMs) },
    heapMb: numberEnv(env, "DIMENSION_BROWSER_CODE_HEAP_MB", DEFAULT_HEAP_MB),
  });
}
