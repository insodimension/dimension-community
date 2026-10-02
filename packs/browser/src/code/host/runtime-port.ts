// Written for the Browser pack (doc 77 §7.4.3, §7.7): the code host's view of the ONE runtime. The runtime stays the only owner of browsers, engines, profile locks, the session binding, the
// lifecycle and the View's stream; this file is the `CodeBrowserPort` it offers the host, built over a handful of closures (`CodeSeam`) that `BrowserRuntime.codeSeam()` hands out. Nothing here
// launches a Chrome of its own, and nothing in the worker creates a page: the engine opens and instruments every tab, the worker adopts it by targetId. A browser a cell asks for by `app` (connected,
// spawned, the relay) is found or started by `kinds/establish.ts` and handed to the runtime as an attach target; a cmux browser is not a Chrome and is held by `CmuxBrowsers`, which this port routes to.

import type { BrowserEngine, BrowserOpenOptions, BrowserOpener, BrowserState, Viewport } from "../../contracts.js";
import type { AttachTarget } from "../../engines/attach.js";
import type { EngineDriver } from "../../engines/types.js";
import { BrowserRuntimeError } from "../../store.js";
import type { AcquiredBrowser, BrowserKind, CodeBrowserPort, TabRef, WaitUntil } from "../contracts.js";
import { ToolAbortError, ToolError } from "../errors.js";
import { CmuxBrowsers } from "../kinds/cmux/cmux-browsers.js";
import { establishKind } from "../kinds/establish.js";
import { describeKind, sameBrowserKind } from "../kinds/resolve.js";

/** OMP's DEFAULT_VIEWPORT (browser/launch.ts:23): a cell's browser is this big unless the cell asks for another. */
export const CODE_VIEWPORT = { width: 1365, height: 768, scale: 1.25 } as const;
/** OMP's `browser.idleCloseSec` (settings-schema.ts:4720-4736): 1,800 s. */
export const CODE_IDLE_MS = 1_800_000;
/** The longest delay a timer holds; a "never" idle clock is parked here, and `persist` is what stops it closing the browser. */
const MAX_TIMER_MS = 2_147_483_647;

export type EndWhy = "closed" | "retired" | "taken-over";
export type EndListener = (browserId: string, why: EndWhy, reason?: string) => void;

/**
 * What a cell's browser may live for: its own idle clock, and whether it stays through idle close and being closed to make room. `kind` is the browser the cell asked for (what a second `browser.open` of the
 * same endpoint finds again); `label` is the words `Opened tab "main" on <label>` ends in for a browser that is not a plain headless one; `kill` is set by `close({ kill: true })` on a spawned application,
 * so closing the browser also ends the application the pack started.
 */
export interface CodeLifetime { idleMs: number; persist: boolean; kind?: BrowserKind; label?: string; kill?: boolean }

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
  /** `attach`: a browser somebody else owns to attach to instead of launching one (a cell's connected, spawned or relay browser; the engine is `chrome-relay`). */
  open(options: BrowserOpenOptions, opener: BrowserOpener, code: CodeLifetime, attach?: AttachTarget): Promise<BrowserState>;
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
  /** Whether the browser the pack launches is hidden: how `existing` names one the person opened in the View. Default true. */
  hidden?: boolean;
  /** Finds or starts what a non-headless kind names and waits for its DevTools endpoint. Default {@link establishKind}; a test passes its own. */
  establish?: typeof establishKind;
  /** The cmux browsers a cell has open. Default: a new one over {@link establishKind} (it connects to nothing until a cell asks for cmux). */
  cmux?: CmuxBrowsers;
}

interface Launch { promise: Promise<AcquiredBrowser>; waiting: number; controller: AbortController; settled: boolean }

/** A kind the runtime holds as an attach target: a browser somebody else owns. */
type AttachedKind = Exclude<BrowserKind, { kind: "headless" } | { kind: "cmux" }>;

/** The code host's port onto the runtime (`CodeBrowserPort`), over {@link CodeSeam}. */
export class RuntimeCodeBrowsers implements CodeBrowserPort {
  readonly #seam: CodeSeam;
  readonly #idleMs: number;
  readonly #never: boolean;
  readonly #hidden: boolean;
  readonly #establish: typeof establishKind;
  readonly #cmux: CmuxBrowsers;
  /** Per session and browser kind: the acquisition in flight, so two `browser.open`s that start together share one browser instead of racing to make two. */
  readonly #launching = new Map<string, Launch>();

  constructor(seam: CodeSeam, options: RuntimeCodeBrowsersOptions = {}) {
    this.#seam = seam;
    const idle = options.idleMs ?? CODE_IDLE_MS;
    this.#idleMs = idle > 0 ? Math.min(idle, MAX_TIMER_MS) : MAX_TIMER_MS;
    this.#never = idle <= 0;
    this.#hidden = options.hidden ?? true;
    this.#establish = options.establish ?? establishKind;
    this.#cmux = options.cmux ?? new CmuxBrowsers({ ...(options.establish === undefined ? {} : { establish: options.establish }), idleMs: idle });
  }

  #lifetime(persist: boolean | undefined, kind: BrowserKind, label?: string): CodeLifetime {
    return { idleMs: this.#idleMs, persist: persist === true || this.#never, kind, ...(label === undefined ? {} : { label }) };
  }

  /** Whether the entry is a browser the pack only attached to (connected, spawned, relay): its pages are the person's. */
  #attachedEntry(entry: CodeSeamEntry): boolean {
    return entry.code?.kind !== undefined && entry.code.kind.kind !== "headless";
  }

  /** The throwaway Chromium a session already holds: one browser per session (doc 77 §7.4.3 rule 1). A saved profile's is never the cell's. */
  #reusable(session: string): CodeSeamEntry | undefined {
    const shown = this.#seam.viewOf(session);
    const candidates = this.#seam.browsersOf(session).filter(entry => entry.profile === null && entry.engine === "chromium" && !entry.closed);
    return candidates.find(entry => entry.browserId === shown) ?? candidates[0];
  }

  /** The browser of `kind` the session already holds (a second `browser.open` of the same endpoint), whoever's tab names it. */
  #attachedOf(session: string, kind: AttachedKind): CodeSeamEntry | undefined {
    return this.#seam.browsersOf(session).find(entry => !entry.closed && entry.code?.kind !== undefined && sameBrowserKind(entry.code.kind, kind));
  }

  async acquire(session: string, req: Parameters<CodeBrowserPort["acquire"]>[1], signal: AbortSignal): Promise<AcquiredBrowser> {
    if (req.profile !== undefined) {
      throw new BrowserRuntimeError("code_needs_consent", `a saved profile (${JSON.stringify(req.profile)}) cannot be driven by code yet: it holds logins, and code runs with full Node. Open a throwaway browser instead; the person can sign in in the View.`);
    }
    const key = `${session}\u0000${describeKind(req.kind)}`;
    let launch = this.#launching.get(key);
    const starter = launch === undefined;
    if (launch === undefined) {
      const controller = new AbortController();
      const started: Launch = { promise: this.#acquire(session, req.kind, req, controller.signal), waiting: 0, controller, settled: false };
      launch = started;
      this.#launching.set(key, started);
      const settle = (): void => {
        started.settled = true;
        this.#launching.delete(key);
      };
      started.promise.then(settle, settle);
      // A browser made for an open that nobody waits for any more (its deadline passed or the cell was cancelled) must not outlive it: no Chrome, no application and no cmux connection left behind (matrix C8).
      started.promise.then(async made => {
        if (made.created && started.waiting === 0) await this.#letGo(made.browserId);
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
      // Whatever the open is still waiting for (an application's port, the relay's extension) is not waited for any longer once nobody asks.
      if (joined.waiting === 0 && !joined.settled) joined.controller.abort(new ToolAbortError());
    }
  }

  /**
   * A browser this port made that no open waits for any more: the runtime closes it, and an application the pack started for it goes too (nothing else holds that application: no entry, no idle clock, no retry, and it
   * was started detached). `terminate` exists only for one this open started, so an application that was already running is only let go of.
   */
  async #letGo(browserId: string): Promise<void> {
    if (this.#cmux.owns(browserId)) return await this.#cmux.release(browserId).catch(() => undefined);
    const entry = this.#seam.peek(browserId);
    if (entry?.code?.kind?.kind === "spawned") entry.code.kill = true;
    await this.#seam.close(browserId).catch(() => undefined);
  }

  async #acquire(session: string, kind: BrowserKind, req: Parameters<CodeBrowserPort["acquire"]>[1], signal: AbortSignal): Promise<AcquiredBrowser> {
    if (kind.kind === "cmux") return await this.#cmux.acquire(session, kind, signal);
    if (kind.kind !== "headless") return await this.#acquireAttached(session, kind, req, signal);
    const existing = this.#reusable(session);
    if (existing !== undefined) {
      const entry = this.#seam.require(existing.browserId);
      if (req.persist !== undefined && entry.code !== undefined) entry.code.persist = req.persist || this.#never;
      return { browserId: entry.browserId, created: false, wsEndpoint: entry.driver.cdpEndpoint() };
    }
    const size = req.viewport ?? CODE_VIEWPORT;
    const state = await this.#seam.open({ engine: "chromium", viewport: { width: size.width, height: size.height } }, { caller: "model", session }, this.#lifetime(req.persist, kind));
    const entry = this.#seam.require(state.browserId);
    if (size.scale !== undefined && size.scale !== 1) await this.#seam.resize(state.browserId, { width: size.width, height: size.height }, size.scale);
    // The browser a cell made is the one `browser_view()` shows when the human has not opened another in this session.
    if (this.#seam.viewOf(session) === undefined) this.#seam.bindView(session, state.browserId);
    return { browserId: state.browserId, created: true, wsEndpoint: entry.driver.cdpEndpoint() };
  }

  /**
   * A connected, spawned or relay browser: found or started (`establishKind` waits for its DevTools endpoint, bounded by the open's own deadline), then attached to as a runtime entry of the attach engine. It is never
   * resized (the person's window is theirs) and never shown in the View unasked. A second open of the same endpoint is the same browser; another endpoint is another entry, as OMP's tabs are bound per browser.
   */
  async #acquireAttached(session: string, kind: AttachedKind, req: Parameters<CodeBrowserPort["acquire"]>[1], signal: AbortSignal): Promise<AcquiredBrowser> {
    const held = this.#attachedOf(session, kind);
    if (held !== undefined) {
      const entry = this.#seam.require(held.browserId);
      if (req.persist !== undefined && entry.code !== undefined) entry.code.persist = req.persist || this.#never;
      return { browserId: entry.browserId, created: false, wsEndpoint: entry.driver.cdpEndpoint(), ...(entry.code?.label === undefined ? {} : { label: entry.code.label }) };
    }
    const established = await this.#establish(kind, { signal });
    if (!("attach" in established)) throw new ToolError(`a ${kind.kind} browser did not resolve to a browser to attach to`);
    const attach: AttachTarget = established.attach;
    // From here on this open owns whatever it started (`attach.terminate` exists only then): any way out but success ends it, or it would run on with no entry, no idle clock and nobody to retry.
    let opened: string | undefined;
    try {
      signal.throwIfAborted();
      const lifetime = this.#lifetime(req.persist, kind, attach.label);
      const state = await this.#seam.open({ engine: "chrome-relay" }, { caller: "model", session }, lifetime, attach);
      opened = state.browserId;
      const entry = this.#seam.require(state.browserId);
      const created = entry.code === lifetime;
      if (!created) {
        // The runtime holds one relay Chrome per chat: a second open found the first (the person's own View, or an earlier cell). It is the cell's too, when it is the endpoint the cell asked for.
        if (entry.code === undefined) entry.code = lifetime;
        else if (entry.code.kind === undefined || !sameBrowserKind(entry.code.kind, kind)) {
          throw new ToolError(`This session already holds a browser attached as ${entry.code.kind === undefined ? "the relay" : describeKind(entry.code.kind)}; close it before opening ${describeKind(kind)}.`);
        }
      }
      return { browserId: state.browserId, created, wsEndpoint: entry.driver.cdpEndpoint(), label: attach.label };
    } catch (error) {
      if (attach.terminate !== undefined) {
        if (opened !== undefined) await this.#letGo(opened);
        await attach.terminate().catch(() => undefined);
      }
      throw error;
    }
  }

  async openTab(browserId: string, o: Parameters<CodeBrowserPort["openTab"]>[1], signal: AbortSignal): Promise<TabRef> {
    if (this.#cmux.owns(browserId)) return await abortable(this.#cmux.openTab(browserId, o, signal), signal);
    const entry = this.#seam.require(browserId);
    // A browser the pack only attached to (the person's own Chrome, an application) hands over a page it already has; a Chromium of the pack's opens one.
    if (this.#attachedEntry(entry)) return await abortable(this.#seam.serialize(entry, () => this.#adopt(entry, o, signal)), signal);
    return await abortable(this.#seam.serialize(entry, () => entry.driver.openTab(o.url, {
      waitUntil: o.waitUntil ?? "load",
      timeoutMs: o.timeoutMs,
      signal,
      reuseBlank: true,
      ...(o.dialogs === undefined ? {} : { dialogs: o.dialogs }),
    })), signal);
  }

  /** The page the person has in front (or the one `app.target` names), as it is; navigated only when the cell gave a URL. Its dialog policy is set before it navigates, as OMP's worker does. */
  async #adopt(entry: CodeSeamEntry, o: Parameters<CodeBrowserPort["openTab"]>[1], signal: AbortSignal): Promise<TabRef> {
    // A browser a person is using (the connected Chrome, the relay) hands over the page in front; an application the pack started is nobody's window, and OMP takes its first usable page in CDP order.
    const userDriven = entry.code?.kind?.kind === "connected" || entry.code?.kind?.kind === "relay";
    let ref = await entry.driver.adoptTab({ ...(o.target === undefined ? {} : { match: o.target }), preferVisible: userDriven && o.target === undefined });
    if (o.dialogs !== undefined) entry.driver.setDialogPolicy(ref.tabId, o.dialogs);
    if (o.url !== undefined) ref = await entry.driver.navigateTab(ref.tabId, o.url, { waitUntil: o.waitUntil ?? "load", timeoutMs: o.timeoutMs, signal });
    return ref;
  }

  async navigateTab(browserId: string, tabId: string, o: { url: string; waitUntil?: WaitUntil; timeoutMs: number }, signal: AbortSignal): Promise<TabRef> {
    if (this.#cmux.owns(browserId)) return await abortable(this.#cmux.navigateTab(browserId, tabId, o, signal), signal);
    const entry = this.#seam.require(browserId);
    return await abortable(this.#seam.serialize(entry, () => entry.driver.navigateTab(tabId, o.url, { waitUntil: o.waitUntil ?? "load", timeoutMs: o.timeoutMs, signal })), signal);
  }

  async findTab(browserId: string, match: string): Promise<TabRef | undefined> {
    const needle = match.toLowerCase();
    return (await this.tabs(browserId)).find(tab => tab.url.toLowerCase().includes(needle) || tab.title.toLowerCase().includes(needle));
  }

  async tabs(browserId: string): Promise<TabRef[]> {
    if (this.#cmux.owns(browserId)) return this.#cmux.tabs(browserId);
    return await this.#seam.require(browserId).driver.tabs();
  }

  async closeTab(browserId: string, tabId: string): Promise<void> {
    if (this.#cmux.owns(browserId)) return await this.#cmux.closeTab(browserId, tabId);
    const entry = this.#seam.require(browserId);
    await this.#seam.serialize(entry, () => entry.driver.closeTab(tabId));
  }

  async setFrozen(browserId: string, tabId: string, frozen: boolean): Promise<void> {
    if (this.#cmux.owns(browserId)) return;
    const entry = this.#seam.require(browserId);
    // The pages of a browser the pack only attached to are the person's: they are never frozen.
    if (this.#attachedEntry(entry)) return;
    await entry.driver.setFrozen(tabId, frozen);
  }

  setDialogPolicy(browserId: string, tabId: string, policy: "accept" | "dismiss" | undefined): void {
    if (this.#cmux.owns(browserId)) return;
    this.#seam.require(browserId).driver.setDialogPolicy(tabId, policy);
  }

  async resize(browserId: string, viewport: { width: number; height: number; scale?: number }): Promise<void> {
    if (this.#cmux.owns(browserId)) return;
    // The pages of a browser the pack only attached to are the person's: a later open or reuse that carries a viewport never resizes them (the creation path does not either).
    if (this.#attachedEntry(this.#seam.require(browserId))) return;
    await this.#seam.resize(browserId, { width: viewport.width, height: viewport.height }, viewport.scale ?? 1);
  }

  setPersist(browserId: string, persist: boolean): void {
    if (this.#cmux.owns(browserId)) return;
    const entry = this.#seam.require(browserId);
    if (entry.code !== undefined) entry.code.persist = persist || this.#never;
  }

  activity(browserId: string): { idleMs: number; viewers: number; pending: number; working: boolean } | undefined {
    if (this.#cmux.owns(browserId)) return undefined;
    const entry = this.#seam.peek(browserId);
    return entry === undefined ? undefined : { idleMs: performance.now() - entry.lastUsed, viewers: entry.viewers, pending: entry.pending, working: this.#seam.working(entry) };
  }

  existing(session: string): { browserId: string; wsEndpoint: string; kind: BrowserKind } | undefined {
    const entry = this.#reusable(session);
    return entry === undefined ? undefined : { browserId: entry.browserId, wsEndpoint: entry.driver.cdpEndpoint(), kind: entry.code?.kind ?? { kind: "headless", headless: this.#hidden } };
  }

  holdWork(browserId: string): () => void {
    if (this.#cmux.owns(browserId)) return this.#cmux.holdWork(browserId);
    return this.#seam.hold(this.#seam.require(browserId));
  }

  async release(browserId: string, o: { kill: boolean }): Promise<void> {
    if (this.#cmux.owns(browserId)) return await this.#cmux.release(browserId);
    // `kill` ends an application the pack started, after it lets go; a browser the person started is never ended, and a Chromium of the pack's closes either way.
    const entry = this.#seam.peek(browserId);
    if (o.kill && entry?.code?.kind?.kind === "spawned") entry.code.kill = true;
    try {
      await this.#seam.close(browserId);
    } catch (error) {
      // Already closed by the runtime (idle, to make room) is what was asked for.
      if (!(error instanceof BrowserRuntimeError && error.code === "unknown_browser")) throw error;
    }
  }

  onEnd(listener: EndListener): () => void {
    const stops = [this.#seam.onEnd(listener), this.#cmux.onEnd(listener)];
    return () => {
      for (const stop of stops) stop();
    };
  }

  onViewed(listener: (browserId: string) => void): () => void {
    return this.#seam.onViewed(listener);
  }

  /** The server is stopping: the splits the pack opened in cmux are closed with it. The runtime closes its own browsers. */
  async dispose(): Promise<void> {
    await this.#cmux.dispose();
  }
}
