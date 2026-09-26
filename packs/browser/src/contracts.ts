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
/**
 * `savedPassword`: the text went into a password field of `origin`, and the
 * browser typed this profile's saved password for that origin instead of the
 * text given. Never the value.
 */
export interface ActionResult { status: ActionStatus; error?: string; state: BrowserState; savedPassword?: { origin: string } }
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
/** One field of a publish recipe: where to type, exactly what, and an optional caption shown in the View. */
export interface PublishField {
  selector: string;
  value: string;
  /** Shown above the value in the confirm bar (≤ 40 characters); the View falls back to "Field N". */
  label?: string;
}
/**
 * Who made a tool call, as the host stamped it in request `_meta`: "model"
 * (an agent turn) or "app" (the Browser View, i.e. the human). A call with no
 * stamp did not come through the host and is treated as not-the-human.
 */
export type ToolCaller = "model" | "app";
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
  /** CSS selector clicked exactly once, only on confirm. */
  submit: string;
  receipt: {
    /**
     * Template matched against the receipt URL's PATHNAME (the origin is checked
     * separately; query and hash are ignored): literal text plus `{segment}`
     * (one path segment) and `{digits}` (one or more 0-9), at most one
     * placeholder per segment. Starts with "/", at most 256 characters.
     * Example: "/{segment}/status/{digits}".
     */
    path: string;
    /** Receipt is the href of the first matching element whose href matches; else the active tab's URL. */
    linkSelector?: string;
  };
}
/** Which shipped preset a publish was resolved from, as the record shows it. */
export interface PresetRef {
  name: string;
  /** False until a real post was observed through the preset: the View says "Recipe not yet proven on the live site. Check the filled-in post before you press Post.". */
  verified: boolean;
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
  /** Where the post goes: the compose page URL the fields were typed into and read back on (confirm requires the tab still there). */
  composeUrl: string;
  /** The tab the fields were read back on: confirm submits only there, and the View holds Tab/Enter only while it is active. */
  tabId: string;
  profile: string;
  fields: PublishField[];
  createdAt: string;
  expiresAt: string;
  /** The posted URL, read from the page after submit. */
  url?: string;
  error?: string;
  /** Set when the recipe came from a named preset (`browser_publish`'s `preset`). */
  preset?: PresetRef;
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
/**
 * browser_read: one logged-out read of a public page (see read.ts). There is
 * no profile: every read runs in a fresh incognito context.
 */
export interface ReadRequest {
  url: string;
  /** Default 20 000, max 100 000. */
  maxChars?: number;
}
/**
 * `ok`: the final URL, title and readable text (`truncated` when cut at maxChars).
 * `blocked`: the page will not serve a logged-out reader, or the target is a
 * mirror/proxy host or a private address; `reason` says which. A blocked read
 * is final, never worked around.
 */
export type ReadResult =
  | { status: "ok"; url: string; title: string; text: string; truncated?: true }
  | { status: "blocked"; url: string; reason: string };
/** Capability is the opaque browserId; it must never appear in global listings. */
export interface BrowserRuntimePort {
  open(options: BrowserOpenOptions): Promise<BrowserState>;
  state(browserId: string): Promise<BrowserState>;
  frame(browserId: string, format?: FrameFormat): Promise<BrowserFrame>;
  tab(browserId: string, request: TabRequest, caller?: ToolCaller): Promise<BrowserState>;
  resize(browserId: string, viewport: Viewport, scale?: number): Promise<BrowserState>;
  snapshot(browserId: string): Promise<{ state: BrowserState; text: string }>;
  /** Refused (`publish_pending`) while a publish awaits confirmation, unless `caller` is "app". */
  act(browserId: string, action: BrowserAction, caller?: ToolCaller): Promise<ActionResult>;
  runTask(browserId: string, request: TaskRequest, onStep?: (step: TaskStep, run: TaskRun) => void): Promise<TaskRun>;
  cancelTask(browserId: string): Promise<TaskRun>;
  annotate(browserId: string, frameId: string, region: BrowserRegion, note: string): Promise<BrowserAnnotation>;
  profiles(): Promise<string[]>;
  /** Settles a pending publish first. Refused (`publish_pending`) while one awaits confirmation, unless `caller` is "app". */
  close(browserId: string, caller?: ToolCaller): Promise<void>;
  waitTask(browserId: string, ms: number): Promise<TaskRun>;
  startTask(browserId: string, request: TaskRequest, caller?: ToolCaller): Promise<TaskRun>;
  /** `check`: signed in? `post`: fill, verify and park for a confirm. Never submits. `preset` labels the record with the preset the recipe was resolved from. */
  publish(browserId: string, recipe: PublishRecipe, mode: PublishMode, caller?: ToolCaller, preset?: PresetRef): Promise<PublishCheck | PublishRecord>;
  /** The Post (the model's confirm or the View's button): re-verify, click submit exactly once, read the receipt from the page. */
  confirmPublish(browserId: string, publishId: string): Promise<PublishRecord>;
  cancelPublish(browserId: string, publishId: string): Promise<PublishRecord>;
  /** The publish's record once it is terminal or `ms` has passed, whichever is first. */
  waitPublish(browserId: string, publishId: string, ms: number): Promise<PublishRecord>;
  /** Read a public page in this server's own headless reader: a fresh incognito context, never a profile or a Browser View browser. */
  read(request: ReadRequest): Promise<ReadResult>;
  dispose(): Promise<void>;
}
