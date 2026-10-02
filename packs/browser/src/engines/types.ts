import type { AdmittedInput } from "../input.js";
import type { BrowserAction, BrowserApp, BrowserRegion, ElementInspection, HandledDialog, LogEntry, ModelShot, PageElements, PageScroll, ShotRequest, TabInfo, Viewport } from "../contracts.js";
import type { TabRef, WaitUntil } from "../code/contracts.js";

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
  /** The last five dialogs the browser answered on the active tab, oldest first. */
  dialogs: HandledDialog[];
}

/** One live picture of the active tab. */
export interface LiveFrame {
  /** Changes whenever the picture does. */
  id: string;
  jpeg: Uint8Array;
  /** The page size (CSS px) it was taken at: a point on the picture maps to the page by this, not by whatever the viewport is now. */
  viewport: Viewport;
  /** Epoch ms. */
  capturedAt: number;
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

/**
 * The password to type for a document origin (`useSavedPassword`: the saved
 * one; `generatePassword`: the saved one, else one minted and saved first), or
 * undefined when there is none. May throw (an unreadable store, an origin a
 * password may not be bound to).
 */
export type PasswordSource = (origin: string) => string | undefined;
/** What `perform` did beyond the action itself: the frame origin whose password it typed, if it did. */
export interface PerformOutcome { passwordOrigin?: string; dialogs?: HandledDialog[] }
/** What `waitFor` holds out for: an element that is visible, text on the page, or a substring of the URL. */
export type WaitCondition = { selector: string } | { text: string } | { url: string };
/** What `evaluate` answered: the value as JSON text (absent for `undefined`), or the error the expression threw. */
export type EvalOutcome = { ok: true; value?: string; truncated: boolean } | { ok: false; ran: boolean; error: string };

export interface EngineDriver {
  /** The browser application this driver launched; null when it attached to one it does not own. */
  readonly app: BrowserApp | null;
  state(): Promise<EngineState>;
  /** Viewport PNG of the active tab, not a full-page image; device scale factor is one. */
  screenshot(): Promise<Uint8Array>;
  /**
   * A picture for a model: the browser's own webp (jpeg where webp is refused), shrunk so its longest edge is at most
   * 1024 CSS px. Not the live view's frames and not the annotation PNG: nothing here is retained. `url` is the caller's to fill.
   */
  shotForModel(request: ShotRequest): Promise<Omit<ModelShot, "url">>;
  /** The active tab's console errors/warnings, uncaught exceptions and failed or 4xx/5xx responses, oldest first (bounded per tab); `n` counts up across tabs. */
  logs(): LogEntry[];
  /**
   * Evaluate `expression` in the active tab's main world (app globals are visible) and answer its value as JSON text,
   * cut at `limit` characters. THE one place a caller's own JavaScript reaches a page: the runtime lets only a throwaway browser here.
   * `ran: false`: it never ran (a syntax error).
   */
  evaluate(expression: string, limit: number): Promise<EvalOutcome>;
  /**
   * Live pictures of the active tab for as long as anyone watches: `listener` gets one whenever the page changes and
   * one at once for a page that is not changing, and the cast follows the active tab and a resize. The screencast
   * runs only while at least one listener is subscribed; the returned function unsubscribes.
   */
  watchFrames(listener: (frame: LiveFrame) => void): () => void;
  /** The human's input on the active tab, in order (already admitted). Throws `ActionNotDispatched` when provably nothing reached the page. */
  input(events: readonly AdmittedInput[]): Promise<void>;
  snapshot(limit: number): Promise<string>;
  /**
   * What is on the active tab under each of `regions` (viewport px), one read for all of them: the elements under each
   * region as separate records (bounded; at most about `limit` characters of them per region), in the order asked, and
   * where the page is scrolled right now.
   */
  elements(regions: readonly BrowserRegion[], limit: number): Promise<{ scroll: PageScroll; regions: PageElements[] }>;
  /** Where the active tab is scrolled right now and how large its document is. */
  scroll(): Promise<PageScroll>;
  /**
   * Perform one action on the active tab now, once, never retried. Throws
   * `ActionNotDispatched` when provably nothing reached the page; any other
   * error means the effect may have happened.
   *
   * `password`, for a `type`/`insert` with `useSavedPassword` or
   * `generatePassword`: asked for the target password field's own frame
   * origin, read from the browser (an isolated world, never page script); the
   * value replaces the field's content. A field that is not a password input,
   * or no password for that origin, is an error and nothing is typed. The
   * result names the origin, never the value.
   */
  perform(action: BrowserAction, password?: PasswordSource): Promise<PerformOutcome>;
  /**
   * Replace a field's content exactly as `perform({ kind: "type" })` does. A
   * password input is refused with `ActionNotDispatched` before any input event.
   */
  fill(selector: string, text: string): Promise<void>;
  /**
   * Resolve when `condition` holds on the active tab (true) or after
   * `timeoutMs` (false). Reads only; a selector takes the `@<ref> ` frame prefix.
   * `mask` scrubs the page's text and URL exactly as the runtime scrubs
   * everything it returns: a `text` or `url` condition is matched against the
   * MASKED value, so a wait can never confirm what the caller may not read.
   */
  waitFor(condition: WaitCondition, timeoutMs: number, mask: (value: string) => string): Promise<boolean>;
  /** The layout facts of the first match of `selector` (`@<ref> ` prefix reaches an iframe), measured by a fixed page script; null when nothing matches. Does not wait. */
  inspect(selector: string): Promise<ElementInspection | null>;
  /** Publish reads on the active tab; none writes to the page. Selectors resolve like actions' (CSS or `pierce/`). */
  hasElement(selector: string): Promise<boolean>;
  readField(selector: string): Promise<FieldRead>;
  /** The text of the first element matching `selector`, at most `limit` characters; null when absent or a form control (never read). */
  readText(selector: string, limit: number): Promise<string | null>;
  /**
   * The `aria-label` of the first element matching `selector`, at most `limit` characters; null when absent or a form control.
   * The one attribute this reads: a fixed script, with the selector as data. Google's account button has its email only there.
   */
  readLabel(selector: string, limit: number): Promise<string | null>;
  /** Absolute hrefs of up to `limit` elements matching `selector` (CSS or `pierce/` only: it is read in-page). */
  linkHrefs(selector: string, limit: number): Promise<string[]>;
  /**
   * Open a tab, make it the active one, and navigate it to `url` (already validated) when given. Answers the tab, so the code worker
   * (doc 77 §7.4.3) can adopt it by `targetId`: the engine creates and instruments every tab, the worker never does.
   */
  openTab(url?: string, options?: OpenTabOptions): Promise<TabRef>;
  /** Every page tab this driver owns, in opening order, as the code worker adopts them. Reads only what the browser process knows (no renderer call). */
  tabs(): Promise<TabRef[]>;
  /** Navigate `tabId` (not necessarily the active one) and wait as `options` say; a page that has not loaded in time is stopped and the call rejects. */
  navigateTab(tabId: string, url: string, options: NavigateTabOptions): Promise<TabRef>;
  /** How `tabId` answers its JavaScript dialogs from now on; undefined restores the default (alert and beforeunload accepted, confirm and prompt dismissed). The engine is the one CDP client that answers, so two never both do. */
  setDialogPolicy(tabId: string, policy: DialogPolicy | undefined): void;
  /** Freeze (`Page.setWebLifecycleState` frozen) or thaw `tabId`: an idle tab stops using CPU. Capped at 3 s; throws for an unknown tab. */
  setFrozen(tabId: string, frozen: boolean): Promise<void>;
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
  /**
   * Hard stop, for a `close` that hung or failed: kill the owned browser's whole process tree and resolve only once the browser
   * process is confirmed gone (`close_failed`-style rejection otherwise). The lease is released only on that confirmation, like
   * `close`. A driver that owns nothing (the relay) just closes. Safe to call while a `close` is still pending.
   */
  kill(): Promise<void>;
}

export interface EngineOptions {
  /** Private user-data directory the driver owns: a saved profile's (protected by the runtime lock) or a throwaway browser's own. */
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
  /**
   * Called when the ACTIVE tab's main frame finishes loading, or navigates within its document (a single-page app's
   * route change). No url: the runtime asks for the state it wants. Never throws into the driver. `chromium` only.
   */
  onPageLoaded?(): void;
}

/** What the engine answers a dialog with, for a tab whose opener asked: every dialog accepted, or every dialog dismissed. */
export type DialogPolicy = "accept" | "dismiss";

/** How a tab is navigated: the lifecycle event to wait for, the budget, and an abort (a stalled page is stopped, never left loading). */
export interface NavigateTabOptions {
  waitUntil?: WaitUntil;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface OpenTabOptions extends NavigateTabOptions {
  /** The browser's launch tab, still blank and never handed out, is used instead of opening a second page. */
  reuseBlank?: boolean;
  dialogs?: DialogPolicy;
}
