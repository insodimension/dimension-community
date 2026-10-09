// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser.ts:66-101 and tools/browser/tab-protocol.ts:83-143 @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../third-party/omp/LICENSE.
// Changed for the Browser pack: the shapes are OMP's, re-cut as the contract between the lanes of doc 77 §7.7 (the bridge, the host/worker messages, the three ports).

/**
 * The contract between the lanes that build the `browser_run` tool (doc 77 §7.7). L1 froze it in wave 0; a lane may ADD to it,
 * and changing a shape is a message to every lane. Shapes are OMP's wherever OMP has one.
 *
 * Rules the contract fixes:
 *  1. `open` and `close` are the only calls that cross to the main thread; `run` and `call` never leave the worker.
 *  2. The worker adopts what the engine made and never creates a page.
 *  3. The worker connects to `wsEndpoint` with `puppeteer.connect({browserWSEndpoint, defaultViewport: null, protocolTimeout: 60_000})`;
 *     a connected, relay or spawned browser gives the same `wsEndpoint` shape.
 *     VERSION-ONE LIMIT, equal to OMP's: every browser the engine makes keeps a TCP DevTools port, and a cell runs with full Node (file system, network, child processes: doc 77 §7.4.5), so a cell can read another
 *     profile's `DevToolsActivePort` and `puppeteer.connect` to another session's Chrome. "Another session's browser: no handle" is true of the API a cell is given, not of code that goes around it.
 *     Hardening rung (doc 77 §7.8 decision 1, option B; not built): run the code host as a child process under Node's permission model (`--permission`). That is a seat belt, not secrecy: it narrows accidents and casual
 *     file reads (the scratch-directory-only reads and writes, no child process, no worker), but it does NOT close the reach to another session's Chrome. Open file descriptors and symlinks pass it, Node 22/24 has no network
 *     restriction (so `puppeteer.connect` to a TCP DevTools port still works), and a granted `child_process` escapes it. What closes the reach is the transport: a pipe to Chrome (`--remote-debugging-pipe`, no port at all) or
 *     DevTools ports that cannot be discovered from the profile directory. A pipe changes this rule (the worker would be handed a pipe, not a `wsEndpoint`); non-discoverable ports change only the host.
 *  4. Every text OMP prints is OMP's string (matrix rows C9, C10, C11, D8, D9, D16, D22).
 *  5. Errors thrown into the cell keep `name` and `message`; `isAbort` marks cancellation; `recoverTab` asks the host to rebuild the worker (a timeout and a cancel both set it).
 *  6. A saved profile never reaches `acquire` from code without the gate: `acquire` throws `code_needs_consent`. The refusal is {@link savedProfileRefusal}'s text. The gate is advisory against code that goes around
 *     the API (rule 3): it stops the model's `browser.open({ profile })`, not a cell that reads the profile's files.
 */

// ---- the bridge: what the verbatim facade sends. OMP browser.ts:66-88, field for field, plus `profile`.
/**
 * `open`, `close`, `tabs` and `active` cross to the host; `run` and `call` stay in the worker.
 * `tabs` (the pack's `browser.tabs()`): the host answers `details.value` = {@link CodeTabInfo}[] for every tab of the session's code browser, named or not, and an empty `text`.
 * `active` (`browser.active()`): the host answers with the tab the human is looking at, adopted like an `open`: `details.name` is the name the tab is adopted under (its own if it has one, else one the host makes up)
 * and `attach` is its handle; the dispatcher adopts it under that name, and an empty `details.name` is an error.
 */
export type CodeAction = "open" | "close" | "run" | "call" | "tabs" | "active";
/** One entry of `browser.tabs()`. `name` is absent for a tab no cell named (one the human opened). */
export interface CodeTabInfo { name?: string; id: string; url: string; title: string; active: boolean }
export type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
export interface BridgeRequest {
  action: CodeAction;
  /** Tab name, default "main". */
  name?: string;
  url?: string;
  app?: { path?: string; cdp_url?: string; relay?: boolean; args?: string[]; target?: string };
  viewport?: { width: number; height: number; scale?: number };
  wait_until?: WaitUntil;
  dialogs?: "accept" | "dismiss";
  /** run: exactly one of code / fn. */
  code?: string;
  fn?: string;
  args?: unknown[];
  /** call: at most one element-handle hop (tab-call.ts:70-109). */
  chain?: Array<{ method: string; args: unknown[] }>;
  /** Seconds, 1..300, default 30. */
  timeout?: number;
  all?: boolean;
  kill?: boolean;
  persist?: boolean;
  /** NEW. A saved profile; refused unless the gate allows (§7.4.5). */
  profile?: string;
}
export type BrowserKindTag = "headless" | "spawned" | "connected" | "relay" | "cmux";
export type BrowserKind =
  | { kind: "headless"; headless: boolean }
  | { kind: "spawned"; path: string; args?: string[] }
  | { kind: "connected"; cdpUrl: string }
  | { kind: "relay"; cdpUrl: string }
  | { kind: "cmux"; socketPath: string; password?: string; surface?: string; relayId?: string; relayToken?: string };
/** Base64 image content. */
export interface ImageBlock { type: "image"; data: string; mimeType: string }
export interface ScreenshotResult { dest: string; mimeType: string; bytes: number; width: number; height: number }
/** browser.ts:92-101 */
export interface BridgeDetails {
  action: CodeAction;
  name: string;
  url?: string;
  browser?: BrowserKindTag;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  screenshots?: ScreenshotResult[];
  value?: unknown;
}
export interface BridgeResponse { text: string; details: BridgeDetails; images?: ImageBlock[] }

// ---- one tab, as the worker adopts it
export interface TabRef { tabId: string; targetId: string; url: string; title: string; active: boolean }
export interface TabHandle extends TabRef {
  browserId: string;
  wsEndpoint: string;
  kind: BrowserKindTag;
  created: boolean;
  /** Raise the tab before a screenshot. Unset: yes, except for a tab adopted (not created) on a connected or relay browser, which is the user's visible tab (OMP's rule). */
  activateForScreenshot?: boolean;
  /** `kind: "cmux"` only: how the worker reaches the surface (`tabId` and `targetId` are the surface's UUID, `wsEndpoint` is empty: a cmux surface is no CDP target). */
  cmux?: CmuxConnection;
}
/** What reaches a cmux daemon: the host resolved it from the cmux environment (`CMUX_SOCKET_PATH`, `CMUX_SOCKET_PASSWORD`, `CMUX_RELAY_ID`, `CMUX_RELAY_TOKEN`); the worker's own environment never carries it. */
export interface CmuxConnection { socketPath: string; password?: string; relayId?: string; relayToken?: string }
/** What `acquire` answers: the browser, whether this call made it, its CDP endpoint, and the words `Opened tab "main" on <label>` ends in when the browser is not a plain headless one (a spawned application names its pid). */
export interface AcquiredBrowser { browserId: string; created: boolean; wsEndpoint: string; label?: string }

// ---- host <-> worker (OMP tab-protocol.ts:83-137, minus tool-call/tool-reply, plus bridge for open/close)
/**
 * What `init` tells the worker about the tab realm it builds. All but `session` and `env` are optional, and absent means the realm's own default:
 * - `screenshotDir`: where model screenshots are also saved (OMP's screenshot directory); absent: the realm reads `DIMENSION_BROWSER_SCREENSHOT_DIR` from `env`.
 * - `cwd`: resolves a relative `tab.uploadFile` path. MCP calls carry no working directory, so absent means a relative path is refused with the rule named.
 * - `refusePasswordFields`: `tab.type` / `tab.fill` / `tab.press` (and a handle's) refuse a password input from code, and keys that would reach one (matrix D18). ABSENT MEANS ON; the host sends `false` only where the owner has lifted the rule.
 * - `excludeWebP`: encode the screenshot the model sees as JPEG instead of WebP (a model provider that cannot read WebP).
 * - `memoryLimitMb`: the worker thread's memory limit (`DIMENSION_BROWSER_CODE_MEMORY_MB`). Present and above 0, the worker wraps its own allocators (`Buffer.alloc`, `ArrayBuffer`, the typed arrays) so that one that would take it
 *   past the limit throws in the cell before it is made (worker/memory-guard.ts). Absent or 0: no guard. The host's watchdog, which looks at an interval, is separate and always on where there is a limit.
 */
export interface RealmInit {
  session: string;
  env: Record<string, string>;
  screenshotDir?: string;
  cwd?: string;
  refusePasswordFields?: boolean;
  excludeWebP?: boolean;
  memoryLimitMb?: number;
}
export type HostToWorker =
  /**
   * `env` is the whole environment the cell may see: the worker deletes every other key of its `process.env` before it builds the realms (only in a worker thread; never in the main thread).
   * `tabs`: a rebuilt worker re-adopts the session's tabs, each through `TabRealm.adopt`, BEFORE it answers `ready`.
   * `outputDir`: a folder the cell realm may keep the full text of an over-cap cell output in: `sessionFolder(artifactsRoot, session)` from `../spill.ts`, THE one folder per session (the tool's own files are there too; a host
   * defines no copy of that function). A host that ends a session calls `discardSessionSpills(artifactsRoot, session)`, and once at start `sweepSpills(artifactsRoot)`; a rebuilt worker keeps the folder, because a failed
   * cell's message names a file in it. Absent: no file is kept.
   */
  | ({ t: "init"; outputDir?: string; tabs?: Array<{ name: string; handle: TabHandle }> } & RealmInit)
  | { t: "run"; runId: string; code: string; timeoutMs: number }
  | { t: "bridge-reply"; id: number; ok: true; value: BridgeResponse & { attach?: TabHandle } }
  | { t: "bridge-reply"; id: number; ok: false; error: RunError }
  | { t: "abort"; runId: string }
  | { t: "end"; browserId: string; why: "closed" | "retired" | "taken-over"; reason?: string }
  | { t: "close" };
export type WorkerToHost =
  | { t: "ready" }
  /** open and close only */
  | { t: "bridge"; id: number; runId: string; request: BridgeRequest }
  /** Worker-local run/call names the tab it is about to touch; the host resolves it to an owned browser. */
  | { t: "activity"; runId: string; name: string }
  /** Progress, never the output itself (that is the `result`): at most one per 100 ms and 16 KiB per run, whatever the cell prints; a stretch left out is `[…NB elided…]`. Append them; the end is what matters. */
  | { t: "text"; runId: string; chunk: string }
  | { t: "result"; runId: string; ok: true; payload: RunResult }
  | { t: "result"; runId: string; ok: false; error: RunError }
  | { t: "log"; level: "debug" | "warn" | "error"; msg: string }
  | { t: "closed" };
export interface RunResult { displays: Array<{ type: "text"; text: string } | ImageBlock>; returnValue?: unknown; screenshots: ScreenshotResult[] }
/** `partial`: what the cell had shown before it failed (its text and images), so a screenshot taken before the step that threw is not lost. */
export interface RunError {
  name: string;
  message: string;
  stack?: string;
  isAbort: boolean;
  /**
   * The host MUST terminate this worker thread and start a new one (the pages stay; the new worker re-adopts them) before the next run: the cell that failed may still be running
   * (a synchronous loop cannot be stopped from inside the thread, a loop that catches the abort goes on, and raw Puppeteer calls in a timed-out `tab.run` never see the cell's signal), and its variables are to be reset.
   * The cell realm sets it whenever it gives up on a cell that is still running: its budget ran out, or the run was cancelled (OMP force-kills its JS worker on ANY abort, eval/js/context-manager.ts:430-448);
   * the tab realm may set it too. A run cancelled before its code began never has it. A host that replaces the worker because of this flag decides to from the worker's own error,
   * before it swaps in a message of its own (a take-over), or the cancelled code is left running.
   */
  recoverTab?: boolean;
  /** The cell's own budget ran out (`CellTimeoutError`). Its `message` is already OMP's whole annotation, reset sentence included. A `TimeoutError` the page raised never carries this. */
  budget?: boolean;
  /** `message` already tells the model the worker was reset and its variables are gone (a timeout's and a cancel's do): a host that rebuilds the worker must not add a sentence of its own. */
  resetNoted?: boolean;
  partial?: RunResult;
}
/** tab-protocol.ts:139-143 */
export interface Transport<In, Out> { send(m: Out): void; onMessage(h: (m: In) => void): () => void; close(): void }

// ---- L1 consumes, L2 implements. The tool never touches a worker or a runtime directly.
export interface CodeHostPort {
  /**
   * Starts the cell and waits up to `waitMs` for it to finish; past that the run continues in the worker and the answer is `state: "running"` with the output so far.
   * The tool passes at most 25 s (the host times an MCP call out at 30 s and does not reset it on progress, doc 77 §7.8), however long the cell's own `timeoutMs` is.
   * A cell still running for this session makes `run` reject with an Error whose message starts `busy` and names that run's id. `signal` cancels the cell while this call waits;
   * once the answer is `running` the run no longer belongs to the call, and only `resume`'s signal or the cell's own budget stops it.
   */
  run(session: string, o: { code: string; timeoutMs: number; waitMs: number; signal: AbortSignal; onProgress?: (chunk: string) => void; onBrowserActivity?: (browserId: string) => void }): Promise<RunStarted>;
  /** Waits up to `waitMs` for the run to finish; `waitMs` 0 only looks. A finished run stays readable for 10 minutes. An unknown or expired `runId` rejects with an Error whose message says so. */
  resume(session: string, runId: string, waitMs: number, signal: AbortSignal, onBrowserActivity?: (browserId: string) => void): Promise<RunStarted>;
  dispose(): Promise<void>;
}
export type RunStarted =
  | { state: "done"; result: RunResult | { error: RunError }; previewBrowserId?: string }
  | { state: "running"; runId: string; outputSoFar: string; previewBrowserId?: string };

// ---- L2 implements on BrowserRuntime (four hooks in runtime.ts); L2 and L4 consume.
export interface CodeBrowserPort {
  acquire(session: string, req: { kind: BrowserKind; profile?: string; viewport?: { width: number; height: number; scale?: number }; persist?: boolean }, signal: AbortSignal): Promise<AcquiredBrowser>;
  /**
   * Makes a tab of `browserId` the cell's. A browser the pack launched opens a new tab; one it only attached to (connected, spawned, relay) hands over the page the person has in front, or the one whose URL or title contains `target`
   * (`app.target`), as it is, and navigates it when `url` is given. A cmux browser opens a split at `url`, or attaches to the surface the request named.
   */
  openTab(browserId: string, o: { url?: string; waitUntil?: WaitUntil; dialogs?: "accept" | "dismiss"; timeoutMs: number; target?: string }, signal: AbortSignal): Promise<TabRef>;
  /** app.target */
  findTab(browserId: string, match: string): Promise<TabRef | undefined>;
  tabs(browserId: string): Promise<TabRef[]>;
  closeTab(browserId: string, tabId: string): Promise<void>;
  setFrozen(browserId: string, tabId: string, frozen: boolean): Promise<void>;
  /** Counts as a call in flight; throws human_driving, publish_pending, task_running. */
  holdWork(browserId: string): () => void;
  release(browserId: string, o: { kill: boolean }): Promise<void>;
  /** `reason` is the runtime's own account when it closed the browser (idle, to make room): what the cell is told in place of "not alive". */
  onEnd(l: (browserId: string, why: "closed" | "retired" | "taken-over", reason?: string) => void): () => void;
  // ---- ADDED by L2 (the host needs them on reuse, on a View mounting, and for the freeze clock).
  /** Navigates a tab the session already holds (`browser.open({ name, url })` on a name that exists). A page that has not loaded in `timeoutMs` (or when `signal` aborts) is stopped and the call rejects. */
  navigateTab(browserId: string, tabId: string, o: { url: string; waitUntil?: WaitUntil; timeoutMs: number }, signal: AbortSignal): Promise<TabRef>;
  /** How the tab answers its dialogs; `undefined` restores the engine's default. The engine is the only CDP client that answers (doc 77 §7.4.3 rule 7). */
  setDialogPolicy(browserId: string, tabId: string, policy: "accept" | "dismiss" | undefined): void;
  /** The page size and pixel ratio of every tab. A View mounted on the browser decides its own size, and this is the cell's ask. */
  resize(browserId: string, viewport: { width: number; height: number; scale?: number }): Promise<void>;
  /** `persist: true` exempts the browser from idle close and from being closed to make room. */
  setPersist(browserId: string, persist: boolean): void;
  /** What the freeze clock reads; undefined once the browser is gone. `idleMs`: since any call reached it, the View's included. `working`: a call is queued or running, or a task agent is driving the browser (a task's steps do not touch `idleMs`). */
  activity(browserId: string): { idleMs: number; viewers: number; pending: number; working: boolean } | undefined;
  /** The browser the session already holds (one a cell made, or the person opened in the View), without making one: what `browser.tabs()` and `browser.active()` read. */
  existing(session: string): { browserId: string; wsEndpoint: string; kind: BrowserKind } | undefined;
  /** A View joined the browser's live stream, or a task agent began driving it: a frozen tab draws nothing and answers no timer, so the host thaws before either looks. */
  onViewed(l: (browserId: string) => void): () => void;
  /** The host is shutting down: let go of what the port holds that the runtime does not (the splits of a cmux browser). The runtime closes its own browsers. */
  dispose?(): Promise<void>;
}

// ---- inside the worker: L1's dispatcher consumes, L3 implements. `open`/`close` never reach it; `run`/`call` always do.
export interface TabRealm {
  /** puppeteer.connect once per browser (cached), page by targetId, bound to the tab NAME every later run/call/release names. */
  adopt(name: string, h: TabHandle): Promise<void>;
  /** Drop the page; never closes a foreign browser. */
  release(name: string): Promise<void>;
  /**
   * `run` and `call` stay in the worker thread, so what they return is not posted anywhere; it is copied into the cell's realm, and there it is bounded (worker/dispatch.ts `bridgeResponse`): the text parts to the 50 KiB
   * inline budget (the start, the end, a note), the images to the 32 MiB a cell keeps in all. A realm SHOULD bound what it collects the same way as it collects it (text through `OutputSink`, images under
   * `MAX_IMAGE_BASE64_CHARS`), or a `tab.run` that prints without end grows the worker until its budget or the host's memory watchdog ends it. `returnValue` is the page code's own value and is never bounded or copied.
   */
  run(r: { name: string; code?: string; fn?: string; args?: unknown[]; timeoutMs: number; signal: AbortSignal }): Promise<RunResult>;
  call(r: { name: string; chain: Array<{ method: string; args: unknown[] }>; timeoutMs: number; signal: AbortSignal }): Promise<RunResult>;
  names(): string[];
  /** The browser closed, retired or was taken over: drop its pages, reject its runs. */
  end(browserId: string, reason?: string): Promise<void>;
  dispose(): Promise<void>;
}

// engines/types.ts additions (L2, after StealthParity merges)
//   openTab(url?: string): Promise<TabRef>        was Promise<void>; the id is what the worker adopts
//   tabs(): TabRef[]
//   setDialogPolicy(tabId: string, policy: "accept" | "dismiss" | undefined): void
//   setFrozen(tabId: string, frozen: boolean): Promise<void>

// ---- ADDED in wave 0 after L3's request: how the tab realm runs the user's code without owning the cell machinery.
// L1 implements it (src/code/cell/evaluator.ts, `createCodeEvaluator()`); L3 takes it as an option of its TabRealm. It does wrapCode
// (top-level await, final expression, const/let persistence), indirect eval, and routes console/print/display to `hooks`. Every name in
// `scope` is visible to the code LEXICALLY (not as a global), so two overlapping runs never clobber each other and `browser` can be
// the Puppeteer Browser inside `tab.run` while the cell's `browser` is the facade.
export type EvaluatorDisplay = ImageBlock | { type: "json"; data: unknown };
export interface EvaluatorHooks { onText(chunk: string): void; onDisplay(o: EvaluatorDisplay): void }
export interface CodeEvaluator {
  evaluate(code: string, o: { filename: string; scope: Record<string, unknown>; hooks: EvaluatorHooks }): Promise<unknown>;
}
