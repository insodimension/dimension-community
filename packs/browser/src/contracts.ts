/** What the browser IS. `abp` and `browser4` are refused with the reason (see engines/refused.ts). */
export const BROWSER_ENGINES = ["chromium", "chrome-relay", "abp", "browser4"] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];
/** Who drives a whole task at its own speed: upstream agent loops, used as published. */
export const TASK_AGENTS = ["jev", "browser-use"] as const;
export type TaskAgent = (typeof TASK_AGENTS)[number];
/**
 * `signup`: the password the browser saved for this profile + origin, or a
 * strong one it mints and saves. `login`: the saved one only. See credentials.ts.
 */
export const CREDENTIAL_MODES = ["signup", "login"] as const;
export type CredentialMode = (typeof CREDENTIAL_MODES)[number];
/** A password by REFERENCE: the caller names the origin, never the value. */
export interface CredentialRequest { origin: string; mode: CredentialMode }
/** What a task reports about the credential it used — never the value. */
export interface CredentialUse { origin: string; created: boolean }
/** Maximum encoded PNG accepted by the host's image model-context contract. */
export const MAX_ANNOTATION_BYTES = 2_097_152;
export interface Viewport { width: number; height: number }
export type MouseButton = "left" | "right" | "middle";
export interface BrowserAction {
  kind: "navigate" | "click" | "type" | "select" | "press" | "scroll" | "back" | "forward" | "reload" | "stop" | "insert" | "hover";
  url?: string;
  selector?: string;
  /** `type`: replaces the field's value. `insert`: typed into whatever is focused. */
  text?: string;
  /** `select`: the option's value or visible text. */
  value?: string;
  key?: string;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  /** `click` only; default "left". */
  button?: MouseButton;
  /** `click` only; 2 = double-click, 3 = triple-click. Default 1. */
  clickCount?: 1 | 2 | 3;
}
export interface TabInfo {
  /** Stable opaque id for the tab's lifetime. */
  id: string;
  title: string;
  url: string;
  active: boolean;
  loading: boolean;
  /** data: URL (≤ 32 KB, fetched server-side, cached per origin) or null. */
  favicon: string | null;
}
export type TabOp = "new" | "activate" | "close";
export interface TabRequest { op: TabOp; tabId?: string; url?: string }
/** `jpeg`: the latest live screencast frame (not annotatable). `png`: a fresh capture, retained for annotation. */
export type FrameFormat = "jpeg" | "png";
/** `failed`: provably nothing happened. `unknown`: dispatched, then errored — may have taken effect. */
export type ActionStatus = "completed" | "failed" | "unknown";
export interface ActionResult { status: ActionStatus; error?: string; state: BrowserState }
export interface TaskStep { n: number; action: string; url: string; elapsedMs: number }
export interface TaskUsage { modelCalls: number; inputTokens: number; outputTokens: number; costUsd: number | null }
export type TaskStatus = "running" | "done" | "blocked" | "failed" | "cancelled";
export interface TaskRun {
  id: string;
  agent: TaskAgent;
  task: string;
  status: TaskStatus;
  /** The agent's final message, or the failure reason. */
  summary: string;
  /** The most recent steps (bounded); `stepCount` is the total. */
  steps: TaskStep[];
  stepCount: number;
  startedAt: string;
  elapsedMs: number;
  usage: TaskUsage;
  /** Which saved password the browser used for this task, and whether it minted it. */
  credential?: CredentialUse;
}
/**
 * `credential`: the browser fills that origin's password fields itself (jev
 * never reads or types password inputs). The value is held by the browser and
 * never passes through a tool argument, a result or a model call.
 */
export interface TaskRequest { agent: TaskAgent; task: string; maxSteps?: number; credential?: CredentialRequest }
/** One field of a publish recipe: where to type, and exactly what. */
export interface PublishField { selector: string; value: string }
/**
 * How to post on one site, supplied by the caller as data — the pack itself is
 * platform-agnostic. See publish.ts for the bounds every field is held to.
 */
export interface PublishRecipe {
  /** `https://…`; `http://` only for 127.0.0.1 and localhost. */
  origin: string;
  /** On `origin`. */
  composeUrl: string;
  /** CSS selector present only when the profile is signed in. */
  signedIn: string;
  /** 1-8 fields, each value at most 10 000 characters. */
  fields: PublishField[];
  /** CSS selector clicked exactly once, only after the human confirms. */
  submit: string;
  receipt: {
    /** Regex source matched against the WHOLE receipt URL (anchor it yourself); the URL must be on `origin`. */
    urlPattern: string;
    /** Receipt is the href of the first matching element whose href matches; else the active tab's URL. */
    linkSelector?: string;
  };
}
export const PUBLISH_MODES = ["check", "post"] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];
export const PUBLISH_STATUSES = ["awaiting-confirmation", "posted", "unknown", "failed", "cancelled", "expired"] as const;
/**
 * `unknown`: submit was dispatched and then errored, or no receipt appeared —
 * it may have posted; never retried. `failed`: provably nothing was submitted.
 */
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];
/** The browser's current or most recent publish. `url` is read from the page only. */
export interface PublishRecord {
  publishId: string;
  status: PublishStatus;
  origin: string;
  profile: string;
  fields: PublishField[];
  createdAt: string;
  expiresAt: string;
  url?: string;
  error?: string;
}
/** A `browser_publish` that stopped before anything was parked for confirmation. */
export interface PublishCheck {
  status: "not-signed-in" | "signed-in" | "failed";
  url: string;
  profile: string;
  error?: string;
}
export interface BrowserState {
  browserId: string;
  profile: string;
  engine: BrowserEngine;
  url: string;
  title: string;
  revision: number;
  viewport: Viewport;
  /** The running or most recent task on this browser. */
  task: TaskRun | null;
  /** Every page tab this browser owns, in opening order. */
  tabs: TabInfo[];
  activeTabId: string;
  /** The active tab is loading. */
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The current or most recent publish; the View renders its confirm bar from this. */
  publish: PublishRecord | null;
}
export interface BrowserFrame {
  state: BrowserState;
  frameId: string;
  mimeType: "image/png" | "image/jpeg";
  data: string;
  capturedAt: string;
}
export interface BrowserRegion { x: number; y: number; width: number; height: number }
export interface BrowserAnnotation {
  url: string;
  note: string;
  region: BrowserRegion;
  capturedAt: string;
  mimeType: "image/png";
  data: string;
  elements: string;
}
export interface BrowserOpenOptions {
  profile: string;
  engine?: BrowserEngine;
  viewport?: Viewport;
}
/** Capability is the opaque browserId; it must never appear in global listings. */
export interface BrowserRuntimePort {
  open(options: BrowserOpenOptions): Promise<BrowserState>;
  state(browserId: string): Promise<BrowserState>;
  frame(browserId: string, format?: FrameFormat): Promise<BrowserFrame>;
  tab(browserId: string, request: TabRequest): Promise<BrowserState>;
  resize(browserId: string, viewport: Viewport, scale?: number): Promise<BrowserState>;
  snapshot(browserId: string): Promise<{ state: BrowserState; text: string }>;
  act(browserId: string, action: BrowserAction): Promise<ActionResult>;
  runTask(browserId: string, request: TaskRequest, onStep?: (step: TaskStep, run: TaskRun) => void): Promise<TaskRun>;
  cancelTask(browserId: string): Promise<TaskRun>;
  annotate(browserId: string, frameId: string, region: BrowserRegion, note: string): Promise<BrowserAnnotation>;
  profiles(): Promise<string[]>;
  close(browserId: string): Promise<void>;
  waitTask(browserId: string, ms: number): Promise<TaskRun>;
  startTask(browserId: string, request: TaskRequest): Promise<TaskRun>;
  /** `check`: signed in? `post`: fill, verify and park for the human's confirmation. Never submits. */
  publish(browserId: string, recipe: PublishRecipe, mode: PublishMode): Promise<PublishCheck | PublishRecord>;
  /** The human's Post: re-verify, click submit exactly once, read the receipt from the page. */
  confirmPublish(browserId: string, publishId: string): Promise<PublishRecord>;
  cancelPublish(browserId: string, publishId: string): Promise<PublishRecord>;
  /** The publish's record once it is terminal or `ms` has passed, whichever is first. */
  waitPublish(browserId: string, publishId: string, ms: number): Promise<PublishRecord>;
  dispose(): Promise<void>;
}
