import type { BrowserAction, BrowserRegion, TabInfo, Viewport } from "../contracts.js";

/** Everything below describes the ACTIVE tab unless it says otherwise. */
export interface EngineState {
  url: string;
  title: string;
  /** Stable for one document; MUST change on reload, same-URL navigation and tab switch. */
  documentId: string;
  viewport: Viewport;
  /** Every page tab this driver owns, in opening order. */
  tabs: TabInfo[];
  activeTabId: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** The latest live frame of the active tab. */
export interface LiveFrame {
  /** Changes whenever the frame does. */
  id: string;
  /** Base64 JPEG. */
  data: string;
  capturedAt: string;
}

/** A publish field as read from the page. A password input is recognised and never read. */
export type FieldRead = { state: "absent" | "password" | "not-editable" } | { state: "value"; value: string };

/** What one read navigation saw: the status and final URL from the browser, the rest from the fixed read script. */
export interface PageRead {
  /** The main document's HTTP status; null when it had no network response. */
  httpStatus: number | null;
  /** The final URL, after redirects. */
  url: string;
  title: string;
  /** `document.body.innerText`, whitespace-collapsed, cut at the limit. */
  text: string;
  truncated: boolean;
  /** Length of the whole body text, before the cut. */
  bodyChars: number;
  /**
   * A visible password input (open shadow roots included): the largest share
   * (0..1) of the first viewport covered by a form or dialog around it — the
   * field itself when there is none. Null when no password input is visible.
   */
  passwordShare: number | null;
  /** The page's VISIBLE iframes, open shadow roots included (bounded): src and the share (0..1) of the first viewport each covers. */
  frames: Array<{ src: string; share: number }>;
}

/**
 * What the reader may fetch during one read. Each answer is a refusal reason,
 * or null to let the request through.
 */
export interface ReadPolicy {
  /** A navigation (main frame or subframe, redirects included): mirror hosts and private addresses. */
  navigation(url: string): Promise<string | null>;
  /** Any other request: private addresses only. */
  subresource(url: string): Promise<string | null>;
  /** The address the browser actually connected to for `url` — catches a DNS answer that changed after the check. */
  connected(url: string, ip: string): string | null;
}

/** One read's outcome: the page, a main-frame request the policy refused, or no `load` in time. */
export type ReadOutcome =
  | { kind: "read"; page: PageRead }
  | { kind: "refused"; url: string; reason: string }
  | { kind: "timeout" };

/**
 * browser_read's headless reader. No profile, no persistent cookie jar: every
 * read runs in a fresh incognito context on one tab and is disposed with it.
 */
export interface PageReader {
  /** False once the browser disconnected or began closing; the runtime then replaces it. */
  readonly usable: boolean;
  /**
   * Navigate a fresh context's only tab to `url` (already validated), wait for
   * `load` up to `timeoutMs`, and read it with the fixed read script. Every
   * request goes through `policy`; the context is closed before this returns.
   */
  read(url: string, limit: number, timeoutMs: number, policy: ReadPolicy): Promise<ReadOutcome>;
  /** Resolve once the browser process is gone; a failed close may be retried. */
  close(): Promise<void>;
}

export interface EngineDriver {
  state(): Promise<EngineState>;
  /** Viewport PNG of the active tab, not a full-page image; device scale factor is one. */
  screenshot(): Promise<Uint8Array>;
  /**
   * The newest screencast frame of the active tab, from memory. The first call
   * starts the screencast and waits for its first frame.
   */
  liveFrame(): Promise<LiveFrame>;
  snapshot(limit: number): Promise<string>;
  elements(region: BrowserRegion, limit: number): Promise<string>;
  /**
   * Perform one action on the active tab now, once, never retried. Throws
   * `ActionNotDispatched` when provably nothing reached the page; any other
   * error means the effect may have happened.
   */
  perform(action: BrowserAction): Promise<void>;
  /**
   * Replace a field's content exactly as `perform({ kind: "type" })` does. A
   * password input is refused with `ActionNotDispatched` before any input event.
   */
  fill(selector: string, text: string): Promise<void>;
  /** Publish reads on the active tab; none writes to the page. Selectors resolve like actions' (CSS or `pierce/`). */
  hasElement(selector: string): Promise<boolean>;
  readField(selector: string): Promise<FieldRead>;
  /** Absolute hrefs of up to `limit` elements matching `selector` (CSS or `pierce/` only: it is read in-page). */
  linkHrefs(selector: string, limit: number): Promise<string[]>;
  /** Open a tab, make it the active one, and navigate it to `url` (already validated) when given. */
  openTab(url?: string): Promise<void>;
  /** Make `tabId` the driven and shown tab. Throws `ActionNotDispatched` for an unknown id. */
  activateTab(tabId: string): Promise<void>;
  /** Close `tabId`. Closing the last tab opens a blank one first: the browser never ends from a tab close. */
  closeTab(tabId: string): Promise<void>;
  /** Set every tab's viewport and pixel ratio (both validated) and restart the live cast at that size. */
  resize(viewport: Viewport, scale: number): Promise<void>;
  /** CDP websocket endpoint of this browser, for an upstream task agent to attach to. */
  cdpEndpoint(): string;
  /** Resolve only after owned resources shut down. Never close foreign browsers. */
  close(): Promise<void>;
}

export interface EngineOptions {
  /** Private persistent profile directory, already protected by the runtime lock. */
  profileDirectory: string;
  viewport: Viewport;
  /** Undefined permits the engine's supported default; explicit values must be honored. */
  headless?: boolean;
  executablePath?: string;
  relayUrl?: string;
  /**
   * Release callback, NOT merely a disconnected notification. Call exactly when
   * owned profile resources are confirmed stopped, including failed initialization
   * before anything launched. A failed/unconfirmed shutdown MUST retain the lock.
   * Do not call this for a parent/foreign browser that this driver does not own.
   */
  onClosed(): void;
}
