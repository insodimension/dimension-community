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
 *  4. Every text OMP prints is OMP's string (matrix rows C9, C10, C11, D8, D9, D16, D22).
 *  5. Errors thrown into the cell keep `name` and `message`; `isAbort` marks cancellation; `recoverTab` asks the host to rebuild the worker.
 *  6. A saved profile never reaches `acquire` from code without the gate: `acquire` throws `code_needs_consent`.
 */

// ---- the bridge: what the verbatim facade sends. OMP browser.ts:66-88, field for field, plus `profile`.
export type CodeAction = "open" | "close" | "run" | "call";
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
  | { kind: "cmux"; socketPath: string; password?: string; surface?: string };
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
}

// ---- host <-> worker (OMP tab-protocol.ts:83-137, minus tool-call/tool-reply, plus bridge for open/close)
export type HostToWorker =
  | { t: "init"; session: string; env: Record<string, string>; screenshotDir?: string }
  | { t: "run"; runId: string; code: string; timeoutMs: number }
  | { t: "bridge-reply"; id: number; ok: true; value: BridgeResponse & { attach?: TabHandle } }
  | { t: "bridge-reply"; id: number; ok: false; error: RunError }
  | { t: "abort"; runId: string }
  | { t: "end"; browserId: string; why: "closed" | "retired" | "taken-over" }
  | { t: "close" };
export type WorkerToHost =
  | { t: "ready" }
  /** open and close only */
  | { t: "bridge"; id: number; runId: string; request: BridgeRequest }
  | { t: "text"; runId: string; chunk: string }
  | { t: "result"; runId: string; ok: true; payload: RunResult }
  | { t: "result"; runId: string; ok: false; error: RunError }
  | { t: "log"; level: "debug" | "warn" | "error"; msg: string }
  | { t: "closed" };
export interface RunResult { displays: Array<{ type: "text"; text: string } | ImageBlock>; returnValue?: unknown; screenshots: ScreenshotResult[] }
/** `partial`: what the cell had shown before it failed (its text and images), so a screenshot taken before the step that threw is not lost. */
export interface RunError { name: string; message: string; stack?: string; isAbort: boolean; recoverTab?: boolean; partial?: RunResult }
/** tab-protocol.ts:139-143 */
export interface Transport<In, Out> { send(m: Out): void; onMessage(h: (m: In) => void): () => void; close(): void }

// ---- L1 consumes, L2 implements. The tool never touches a worker or a runtime directly.
export interface CodeHostPort {
  run(session: string, o: { code: string; timeoutMs: number; signal: AbortSignal; onProgress?: (chunk: string) => void }): Promise<RunStarted>;
  /** Waits up to `waitMs` for the run to finish; `waitMs` 0 only looks. A finished run stays readable for 10 minutes. An unknown or expired `runId` rejects with an Error whose message says so. */
  resume(session: string, runId: string, waitMs: number, signal: AbortSignal): Promise<RunStarted>;
  dispose(): Promise<void>;
}
export type RunStarted =
  | { state: "done"; result: RunResult | { error: RunError } }
  | { state: "running"; runId: string; outputSoFar: string };

// ---- L2 implements on BrowserRuntime (four hooks in runtime.ts); L2 and L4 consume.
export interface CodeBrowserPort {
  acquire(session: string, req: { kind: BrowserKind; profile?: string; viewport?: { width: number; height: number; scale?: number }; persist?: boolean }, signal: AbortSignal): Promise<{ browserId: string; created: boolean; wsEndpoint: string }>;
  openTab(browserId: string, o: { url?: string; waitUntil?: WaitUntil; dialogs?: "accept" | "dismiss"; timeoutMs: number }, signal: AbortSignal): Promise<TabRef>;
  /** app.target */
  findTab(browserId: string, match: string): Promise<TabRef | undefined>;
  tabs(browserId: string): Promise<TabRef[]>;
  closeTab(browserId: string, tabId: string): Promise<void>;
  setFrozen(browserId: string, tabId: string, frozen: boolean): Promise<void>;
  /** Counts as a call in flight; throws human_driving, publish_pending, task_running. */
  holdWork(browserId: string): () => void;
  release(browserId: string, o: { kill: boolean }): Promise<void>;
  onEnd(l: (browserId: string, why: "closed" | "retired" | "taken-over") => void): () => void;
}

// ---- inside the worker: L1's dispatcher consumes, L3 implements. `open`/`close` never reach it; `run`/`call` always do.
export interface TabRealm {
  /** puppeteer.connect once per browser (cached), page by targetId, bound to the tab NAME every later run/call/release names. */
  adopt(name: string, h: TabHandle): Promise<void>;
  /** Drop the page; never closes a foreign browser. */
  release(name: string): Promise<void>;
  run(r: { name: string; code?: string; fn?: string; args?: unknown[]; timeoutMs: number; signal: AbortSignal }): Promise<RunResult>;
  call(r: { name: string; chain: Array<{ method: string; args: unknown[] }>; timeoutMs: number; signal: AbortSignal }): Promise<RunResult>;
  names(): string[];
  /** The browser closed, retired or was taken over: drop its pages, reject its runs. */
  end(browserId: string): Promise<void>;
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
