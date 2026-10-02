// Written for the Browser pack (doc 77 §7.4.3, §7.7): the code host's view of the ONE runtime. The runtime stays the only owner of browsers, engines, profile locks, the session binding, the
// lifecycle and the View's stream; this file is the `CodeBrowserPort` it offers the host, built over a handful of closures (`CodeSeam`) that `BrowserRuntime.codeSeam()` hands out. Nothing here
// launches a Chrome of its own, and nothing in the worker creates a page: the engine opens and instruments every tab, the worker adopts it by targetId.

import type { BrowserEngine, BrowserOpenOptions, BrowserOpener, BrowserState, Viewport } from "../../contracts.js";
import type { EngineDriver } from "../../engines/types.js";
import { BrowserRuntimeError } from "../../store.js";
import type { BrowserKind, CodeBrowserPort, TabRef, WaitUntil } from "../contracts.js";

/** OMP's DEFAULT_VIEWPORT (browser/launch.ts:23): a cell's browser is this big unless the cell asks for another. */
export const CODE_VIEWPORT = { width: 1365, height: 768, scale: 1.25 } as const;
/** OMP's `browser.idleCloseSec` (settings-schema.ts:4720-4736): 1,800 s. */
export const CODE_IDLE_MS = 1_800_000;
/** The longest delay a timer holds; a "never" idle clock is parked here, and `persist` is what stops it closing the browser. */
const MAX_TIMER_MS = 2_147_483_647;

export type EndWhy = "closed" | "retired" | "taken-over";
export type EndListener = (browserId: string, why: EndWhy, reason?: string) => void;

/** What a cell's browser may live for: its own idle clock, and whether it stays through idle close and being closed to make room. */
export interface CodeLifetime { idleMs: number; persist: boolean }

/** What the host reads of a runtime entry, and the one field it writes. Structural: the runtime's own `Entry` satisfies it. */
export interface CodeSeamEntry {
  readonly browserId: string;
  readonly driver: EngineDriver;
  readonly profile: string | null;
  readonly engine: BrowserEngine;
  readonly opener: BrowserOpener;
  readonly closed: boolean;
  readonly viewers: number;
  readonly pending: number;
  readonly lastUsed: number;
  code?: CodeLifetime;
}

/** The closures `BrowserRuntime.codeSeam()` builds. Every one is the runtime's own method or a line of one: no second implementation of anything. */
export interface CodeSeam {
  open(options: BrowserOpenOptions, opener: BrowserOpener, code: CodeLifetime): Promise<BrowserState>;
  resize(browserId: string, viewport: Viewport, scale: number): Promise<BrowserState>;
  close(browserId: string): Promise<void>;
  /** The live entry; throws `unknown_browser` with the runtime's own reason when it closed the browser (idle, to make room). Stamps `lastUsed`. */
  require(browserId: string): CodeSeamEntry;
  /** The live entry without stamping it as used or throwing: what a clock reads. */
  peek(browserId: string): CodeSeamEntry | undefined;
  /** The session's open browsers, whoever opened them. */
  browsersOf(session: string): CodeSeamEntry[];
  viewOf(session: string): string | undefined;
  bindView(session: string, browserId: string): void;
  /** One call in flight: out of idle close and make-room. Throws `task_running`, `publish_pending` (and `human_driving` once the person has the wheel). */
  hold(entry: CodeSeamEntry): () => void;
  /** A call is queued or running on the browser, or a task agent is driving it: nothing may close or freeze it under that work. */
  working(entry: CodeSeamEntry): boolean;
  /** Page work in the runtime's per-browser order. */
  serialize<T>(entry: CodeSeamEntry, work: () => Promise<T>): Promise<T>;
  onEnd(listener: EndListener): () => void;
  onViewed(listener: (browserId: string) => void): () => void;
}

/** The pack's error code in front of its message, so the cell and the model read which refusal it was. */
export function codedMessage(error: unknown): string {
  if (error instanceof BrowserRuntimeError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/** Rejects with the signal's reason as soon as it aborts; settles with `work` otherwise. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = (): void => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  return promise;
}

export interface RuntimeCodeBrowsersOptions {
  /** Idle clock of a cell's browser, ms; 0 = never. */
  idleMs?: number;
}

interface Launch { promise: Promise<{ browserId: string; created: boolean; wsEndpoint: string }>; waiting: number }

/** The code host's port onto the runtime (`CodeBrowserPort`), over {@link CodeSeam}. */
export class RuntimeCodeBrowsers implements CodeBrowserPort {
  readonly #seam: CodeSeam;
  readonly #idleMs: number;
  /** Per session: the acquisition in flight, so two `browser.open`s that start together share one browser instead of racing to make two. */
  readonly #launching = new Map<string, Launch>();

  constructor(seam: CodeSeam, options: RuntimeCodeBrowsersOptions = {}) {
    this.#seam = seam;
    const idle = options.idleMs ?? CODE_IDLE_MS;
    this.#idleMs = idle > 0 ? Math.min(idle, MAX_TIMER_MS) : MAX_TIMER_MS;
    this.#never = idle <= 0;
  }

  readonly #never: boolean;

  #lifetime(persist: boolean | undefined): CodeLifetime {
    return { idleMs: this.#idleMs, persist: persist === true || this.#never };
  }

  /** The throwaway Chromium a session already holds: one browser per session (doc 77 §7.4.3 rule 1). A saved profile's is never the cell's. */
  #reusable(session: string): CodeSeamEntry | undefined {
    const shown = this.#seam.viewOf(session);
    const candidates = this.#seam.browsersOf(session).filter(entry => entry.profile === null && entry.engine === "chromium" && !entry.closed);
    return candidates.find(entry => entry.browserId === shown) ?? candidates[0];
  }

  async acquire(session: string, req: Parameters<CodeBrowserPort["acquire"]>[1], signal: AbortSignal): Promise<{ browserId: string; created: boolean; wsEndpoint: string }> {
    if (req.profile !== undefined) {
      throw new BrowserRuntimeError("code_needs_consent", `a saved profile (${JSON.stringify(req.profile)}) cannot be driven by code yet: it holds logins, and code runs with full Node. Open a throwaway browser instead; the person can sign in in the View.`);
    }
    if (req.kind.kind !== "headless") {
      throw new BrowserRuntimeError("code_kind_unsupported", `a ${req.kind.kind} browser is not available to browser_run in this build; only a headless browser is (open without app and profile).`);
    }
    let launch = this.#launching.get(session);
    const starter = launch === undefined;
    if (launch === undefined) {
      const started: Launch = { promise: this.#acquire(session, req), waiting: 0 };
      launch = started;
      this.#launching.set(session, started);
      started.promise.then(
        () => this.#launching.delete(session),
        () => this.#launching.delete(session),
      );
      // A browser made for an open that nobody waits for any more (its deadline passed or the cell was cancelled) must not outlive it: no Chrome left behind (matrix C8).
      started.promise.then(async made => {
        if (made.created && started.waiting === 0) await this.#seam.close(made.browserId).catch(() => undefined);
      }, () => undefined);
    }
    launch.waiting += 1;
    const joined = launch;
    try {
      const made = await abortable(launch.promise, signal);
      // A second open that started while the first was still launching shares what the first made.
      return starter ? made : { ...made, created: false };
    } finally {
      joined.waiting -= 1;
    }
  }

  async #acquire(session: string, req: Parameters<CodeBrowserPort["acquire"]>[1]): Promise<{ browserId: string; created: boolean; wsEndpoint: string }> {
    const existing = this.#reusable(session);
    if (existing !== undefined) {
      const entry = this.#seam.require(existing.browserId);
      if (req.persist !== undefined && entry.code !== undefined) entry.code.persist = req.persist || this.#never;
      return { browserId: entry.browserId, created: false, wsEndpoint: entry.driver.cdpEndpoint() };
    }
    const size = req.viewport ?? CODE_VIEWPORT;
    const state = await this.#seam.open({ engine: "chromium", viewport: { width: size.width, height: size.height } }, { caller: "model", session }, this.#lifetime(req.persist));
    const entry = this.#seam.require(state.browserId);
    if (size.scale !== undefined && size.scale !== 1) await this.#seam.resize(state.browserId, { width: size.width, height: size.height }, size.scale);
    // The browser a cell made is the one `browser_view()` shows when the human has not opened another in this session.
    if (this.#seam.viewOf(session) === undefined) this.#seam.bindView(session, state.browserId);
    return { browserId: state.browserId, created: true, wsEndpoint: entry.driver.cdpEndpoint() };
  }

  async openTab(browserId: string, o: Parameters<CodeBrowserPort["openTab"]>[1], signal: AbortSignal): Promise<TabRef> {
    const entry = this.#seam.require(browserId);
    return await abortable(this.#seam.serialize(entry, () => entry.driver.openTab(o.url, {
      waitUntil: o.waitUntil ?? "load",
      timeoutMs: o.timeoutMs,
      signal,
      reuseBlank: true,
      ...(o.dialogs === undefined ? {} : { dialogs: o.dialogs }),
    })), signal);
  }

  async navigateTab(browserId: string, tabId: string, o: { url: string; waitUntil?: WaitUntil; timeoutMs: number }, signal: AbortSignal): Promise<TabRef> {
    const entry = this.#seam.require(browserId);
    return await abortable(this.#seam.serialize(entry, () => entry.driver.navigateTab(tabId, o.url, { waitUntil: o.waitUntil ?? "load", timeoutMs: o.timeoutMs, signal })), signal);
  }

  async findTab(browserId: string, match: string): Promise<TabRef | undefined> {
    const needle = match.toLowerCase();
    return (await this.tabs(browserId)).find(tab => tab.url.toLowerCase().includes(needle) || tab.title.toLowerCase().includes(needle));
  }

  async tabs(browserId: string): Promise<TabRef[]> {
    return await this.#seam.require(browserId).driver.tabs();
  }

  async closeTab(browserId: string, tabId: string): Promise<void> {
    const entry = this.#seam.require(browserId);
    await this.#seam.serialize(entry, () => entry.driver.closeTab(tabId));
  }

  async setFrozen(browserId: string, tabId: string, frozen: boolean): Promise<void> {
    await this.#seam.require(browserId).driver.setFrozen(tabId, frozen);
  }

  setDialogPolicy(browserId: string, tabId: string, policy: "accept" | "dismiss" | undefined): void {
    this.#seam.require(browserId).driver.setDialogPolicy(tabId, policy);
  }

  async resize(browserId: string, viewport: { width: number; height: number; scale?: number }): Promise<void> {
    await this.#seam.resize(browserId, { width: viewport.width, height: viewport.height }, viewport.scale ?? 1);
  }

  setPersist(browserId: string, persist: boolean): void {
    const entry = this.#seam.require(browserId);
    if (entry.code !== undefined) entry.code.persist = persist || this.#never;
  }

  activity(browserId: string): { idleMs: number; viewers: number; pending: number; working: boolean } | undefined {
    const entry = this.#seam.peek(browserId);
    return entry === undefined ? undefined : { idleMs: performance.now() - entry.lastUsed, viewers: entry.viewers, pending: entry.pending, working: this.#seam.working(entry) };
  }

  existing(session: string): { browserId: string; wsEndpoint: string } | undefined {
    const entry = this.#reusable(session);
    return entry === undefined ? undefined : { browserId: entry.browserId, wsEndpoint: entry.driver.cdpEndpoint() };
  }

  holdWork(browserId: string): () => void {
    return this.#seam.hold(this.#seam.require(browserId));
  }

  async release(browserId: string, _o: { kill: boolean }): Promise<void> {
    try {
      await this.#seam.close(browserId);
    } catch (error) {
      // Already closed by the runtime (idle, to make room) is what was asked for.
      if (!(error instanceof BrowserRuntimeError && error.code === "unknown_browser")) throw error;
    }
  }

  onEnd(listener: EndListener): () => void {
    return this.#seam.onEnd(listener);
  }

  onViewed(listener: (browserId: string) => void): () => void {
    return this.#seam.onViewed(listener);
  }
}

/** Whether two requests ask for the same kind of browser (OMP's `sameBrowserKind`, browser.ts:454-462). */
export function sameBrowserKind(a: BrowserKind, b: BrowserKind): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "headless" && b.kind === "headless") return a.headless === b.headless;
  if (a.kind === "spawned" && b.kind === "spawned") return a.path === b.path;
  if (a.kind === "connected" && b.kind === "connected") return a.cdpUrl === b.cdpUrl;
  if (a.kind === "relay" && b.kind === "relay") return a.cdpUrl === b.cdpUrl;
  if (a.kind === "cmux" && b.kind === "cmux") return a.socketPath === b.socketPath;
  return false;
}

/** OMP's `describeKind` (browser.ts:439-452): how an error names the browser a tab is bound to. */
export function describeKind(kind: BrowserKind): string {
  switch (kind.kind) {
    case "headless": return `headless ${kind.headless ? "hidden" : "visible"}`;
    case "spawned": return `spawned:${kind.path}`;
    case "connected": return `connected:${kind.cdpUrl}`;
    case "relay": return `relay:${kind.cdpUrl}`;
    case "cmux": return `cmux:${kind.surface ?? "split"}`;
  }
}

/** OMP's `describeBrowser` (browser.ts:423-437) for the kinds this host opens: the words the "Opened tab" line ends in. */
export function describeBrowser(kind: BrowserKind): string {
  switch (kind.kind) {
    case "headless": return `headless browser (${kind.headless ? "hidden" : "visible"})`;
    case "spawned": return `spawned ${kind.path}`;
    case "connected": return `connected ${kind.cdpUrl}`;
    case "relay": return `relay ${kind.cdpUrl}`;
    case "cmux": return `cmux browser (${kind.surface ?? "split"})`;
  }
}
