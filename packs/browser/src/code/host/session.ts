// Written for the Browser pack (doc 77 §7.4.3, §7.4.4; matrix C6-C8, C11, C20, D2, D4, D27, D33, E1-E8). It follows OMP's supervisor (tools/browser/tab-supervisor.ts @ dc5f95d9e1, MIT, (c) Mario Zechner,
// Can Bölük, Stencil Labs: the 750 ms grace, one run per tab at a time, the recycle of a hung worker, the texts of `open` and `close` from tools/browser.ts) where it can, and differs where the pack is not OMP:
// ONE worker thread serves a session's cell and every tab of it, so `run` and `call` never leave the worker; the runtime (not the worker) makes and owns every browser and tab, so the worker adopts what
// the engine opened; and the host answers a call after at most `waitMs`, because the MCP host times a call out at 30 s.

import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { BrowserRuntimeError } from "../../store.js";
import type { BridgeRequest, BridgeResponse, BrowserKind, CodeBrowserPort, CodeTabInfo, HostToWorker, RunError, RunResult, RunStarted, TabHandle, TabRef, WorkerToHost } from "../contracts.js";
import { ToolAbortError, ToolError } from "../errors.js";
import { CODE_VIEWPORT, codedMessage, describeBrowser, describeKind, sameBrowserKind } from "./runtime-port.js";
import type { SpawnWorker, WorkerHandle } from "./transport.js";

const DEFAULT_TAB_NAME = "main";
/** What a cell holds in memory of its own output for a call that answers `running`; the worker bounds and coalesces what it posts, so this is only a ceiling. */
const MAX_OUTPUT_CHARS = 256 * 1024;
/** Finished runs kept readable, newest. */
const MAX_FINISHED = 16;
const RESET_NOTE = "the code worker was restarted since the last cell: its variables were reset";

export interface CodeTiming {
  /** A code tab idle this long (no cell, no View) is frozen; 0 never freezes (OMP `browser.freezeOnTurnEnd`, whose signal MCP does not send). */
  freezeIdleMs: number;
  /** The worker of a session with no browser left ends after this long without a cell (doc 77 §7.4.3 rule 6). */
  workerIdleMs: number;
  /** The worker gets this long to answer `init` with `ready` (OMP's setup and ready budgets, tab-supervisor.ts:198-215, cap 10 s). */
  startupTimeoutMs: number;
  /** OMP's GRACE_MS (tab-supervisor.ts:198): how long a cancelled cell has to answer before its worker is terminated, and what a synchronous loop gets past its budget. */
  graceMs: number;
  /** A finished run stays readable by `resume` this long. */
  finishedTtlMs: number;
}

export const DEFAULT_TIMING: CodeTiming = { freezeIdleMs: 20_000, workerIdleMs: 600_000, startupTimeoutMs: 10_000, graceMs: 750, finishedTtlMs: 600_000 };

export interface SessionDeps {
  session: string;
  browsers: CodeBrowserPort;
  spawn: SpawnWorker;
  /** The scrubbed environment the worker's cell may see. */
  env: Record<string, string>;
  /** What the cell asked for → the browser it means (OMP's `resolveBrowserKind`, tools/browser.ts:103-142; L4 replaces the default). */
  resolveKind(request: BridgeRequest): BrowserKind;
  screenshotDir?: string;
  /** Where a cell's over-cap output may be kept; this session's own folder. */
  outputDir?: string;
  timing: CodeTiming;
  /** The session holds nothing any more (no worker, no browser, nothing readable): the host forgets it. */
  onEmpty(): void;
}

type Outcome = { result: RunResult } | { error: RunError };

class Run {
  readonly id = `run-${randomBytes(5).toString("hex")}`;
  output = "";
  /** Aborted when the run is cancelled, the person takes the browser over, or its worker is terminated: what every host-side step of the run (an open) waits under. */
  readonly controller = new AbortController();
  readonly done = Promise.withResolvers<Outcome>();
  settled: Outcome | undefined;
  finishedAt = 0;
  hangTimer: NodeJS.Timeout | undefined;
  readonly holds = new Map<string, () => void>();
  /** Why it was stopped from outside (a take-over): replaces the worker's own cancellation error. */
  override: RunError | undefined;
  hung = false;
  worker: LiveWorker | undefined;
  constructor(readonly timeoutMs: number, readonly onProgress: ((chunk: string) => void) | undefined) {
    this.done.promise.catch(() => undefined);
  }
}

interface LiveWorker {
  handle: WorkerHandle;
  ready: Promise<void>;
  /** Resolves with why the thread exited. */
  stopped: Promise<string>;
  dead: boolean;
}

interface BrowserRecord { browserId: string; wsEndpoint: string; kind: BrowserKind; createdByCode: boolean }
interface NamedTab { name: string; browserId: string; kind: BrowserKind; handle: TabHandle }
type HostReply = BridgeResponse & { attach?: TabHandle };

const tabKey = (browserId: string, tabId: string): string => `${browserId}\u0000${tabId}`;

export function unknownRunMessage(runId: string, ttlMs: number): string {
  return `unknown run ${JSON.stringify(runId)}: no cell with that id is running here or finished in the last ${Math.round(ttlMs / 60_000)} minutes; start a new one with browser_run({ code })`;
}

function busyMessage(runId: string): string {
  return `busy: a cell is still running in this session (${runId}); wait for it with browser_run({ "resume": "${runId}" }) and start no new cell meanwhile.`;
}

/** The error a cell gets for a worker that could not answer a budget it had run out of: it was stuck, so it was ended. */
function stuckError(timeoutMs: number): RunError {
  const seconds = Math.round(timeoutMs / 1000);
  return {
    name: "CellTimeoutError",
    message: `Command timed out after ${seconds} seconds. The cell was stuck (a synchronous loop never gives the worker a turn), so the JS worker was terminated and the cell's variables were reset; variables from earlier cells are gone.`,
    isAbort: false,
    budget: true,
    recoverTab: true,
  };
}

function abortError(): RunError {
  return { name: "ToolAbortError", message: ToolAbortError.MESSAGE, isAbort: true };
}

/** An error the host raised, as the cell gets it. */
function runErrorOf(error: unknown, signal: AbortSignal): RunError {
  if (error instanceof ToolAbortError || (signal.aborted && !(error instanceof ToolError))) return abortError();
  if (error instanceof BrowserRuntimeError) return { name: "ToolError", message: codedMessage(error), isAbort: false };
  if (error instanceof ToolError) return { name: "ToolError", message: error.message, isAbort: false };
  const failure = error instanceof Error ? error : new Error(String(error));
  return { name: failure.name, message: failure.message, isAbort: false, ...(failure.stack === undefined ? {} : { stack: failure.stack }) };
}

/** Resolves with the run's outcome, or why it did not settle in time. */
async function settledWithin(run: Run, ms: number, signal: AbortSignal | undefined): Promise<Outcome | "timeout" | "aborted"> {
  if (run.settled !== undefined) return run.settled;
  if (signal?.aborted) return "aborted";
  const gate = Promise.withResolvers<"timeout" | "aborted">();
  const timer = setTimeout(() => gate.resolve("timeout"), ms);
  const onAbort = (): void => gate.resolve("aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([run.done.promise, gate.promise]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export class CodeSession {
  readonly #d: SessionDeps;
  #worker: LiveWorker | undefined;
  readonly #tabs = new Map<string, NamedTab>();
  readonly #browsers = new Map<string, BrowserRecord>();
  #active: Run | undefined;
  readonly #finished = new Map<string, Run>();
  /** `browserId\0tabId` of every tab this host froze. */
  readonly #frozen = new Set<string>();
  /** Freeze and thaw run one after the other, so a cell never starts under a sweep. */
  #sweeping: Promise<void> = Promise.resolve();
  #freezeTimer: NodeJS.Timeout | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #pruneTimer: NodeJS.Timeout | undefined;
  #resetNote = false;
  #closed = false;

  constructor(deps: SessionDeps) {
    this.#d = deps;
  }

  ownsBrowser(browserId: string): boolean {
    return this.#browsers.has(browserId);
  }

  // -----------------------------------------------------------------------
  // Runs
  // -----------------------------------------------------------------------

  async run(o: { code: string; timeoutMs: number; waitMs: number; signal: AbortSignal; onProgress?: (chunk: string) => void }): Promise<RunStarted> {
    this.#assertOpen();
    if (o.signal.aborted) throw new ToolAbortError();
    if (this.#active !== undefined) throw new Error(busyMessage(this.#active.id));
    const run = new Run(o.timeoutMs, o.onProgress);
    // Reserved before the first await: a second call arriving while the worker starts is `busy`, not a second cell.
    this.#active = run;
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#freezeTimer);
    try {
      const live = await this.#ensureWorker();
      await this.#thaw();
      this.#holdBrowsers(run);
      if (o.signal.aborted) throw new ToolAbortError();
      run.worker = live;
      run.hangTimer = setTimeout(() => this.#hung(run), o.timeoutMs + this.#d.timing.graceMs);
      live.handle.transport.send({ t: "run", runId: run.id, code: o.code, timeoutMs: o.timeoutMs });
    } catch (error) {
      this.#releaseHolds(run);
      if (this.#active === run) this.#active = undefined;
      this.#afterRun();
      throw error;
    }
    return await this.#wait(run, o.waitMs, o.signal);
  }

  async resume(runId: string, waitMs: number, signal: AbortSignal): Promise<RunStarted> {
    this.#assertOpen();
    this.#prune();
    const run = this.#active?.id === runId ? this.#active : this.#finished.get(runId);
    if (run === undefined) {
      throw new Error(unknownRunMessage(runId, this.#d.timing.finishedTtlMs));
    }
    return await this.#wait(run, waitMs, signal);
  }

  async #wait(run: Run, waitMs: number, signal: AbortSignal): Promise<RunStarted> {
    const outcome = await settledWithin(run, waitMs, signal);
    if (outcome === "timeout") return { state: "running", runId: run.id, outputSoFar: run.output };
    if (outcome === "aborted") return await this.#cancel(run);
    return { state: "done", result: "error" in outcome ? { error: outcome.error } : outcome.result };
  }

  /** The call that was waiting for this run was cancelled: the cell is told (its pending operations reject), and a worker that does not answer within the grace is terminated. */
  async #cancel(run: Run): Promise<RunStarted> {
    if (run.settled === undefined) {
      run.controller.abort(new ToolAbortError());
      run.worker?.handle.transport.send({ t: "abort", runId: run.id });
      const outcome = await settledWithin(run, this.#d.timing.graceMs, undefined);
      if (outcome === "timeout") {
        if (run.worker !== undefined) this.#recycle(run.worker);
        this.#settle(run, { error: abortError() });
      }
    }
    const settled = run.settled ?? { error: abortError() };
    return { state: "done", result: "error" in settled ? { error: settled.error } : settled.result };
  }

  /** The cell has outlived its budget and the grace on top: a synchronous loop (it can never answer its own timer). The worker is terminated; the page and the browser are not. */
  #hung(run: Run): void {
    if (run.settled !== undefined) return;
    run.hung = true;
    run.controller.abort(new ToolAbortError());
    if (run.worker !== undefined) this.#recycle(run.worker);
    this.#settle(run, { error: stuckError(run.timeoutMs) });
  }

  #finish(live: LiveWorker, run: Run, outcome: Outcome): void {
    let settled = outcome;
    const noted = this.#resetNote;
    this.#resetNote = false;
    if ("error" in outcome) {
      let error = outcome.error;
      if (run.override !== undefined && error.isAbort) error = run.override;
      else if (noted && error.name === "ReferenceError") error = { ...error, message: `${error.message} (${RESET_NOTE})` };
      if (error.recoverTab === true) {
        // The cell's own budget already says what happened (OMP's whole sentence); any other reason to rebuild the worker is ours to state.
        if (error.budget !== true) error = { ...error, message: `${error.message} The code worker was restarted; the cell's variables were reset.` };
        this.#recycle(live);
      }
      settled = { error };
    }
    this.#settle(run, settled);
  }

  #settle(run: Run, outcome: Outcome): void {
    if (run.settled !== undefined) return;
    clearTimeout(run.hangTimer);
    run.settled = outcome;
    run.finishedAt = Date.now();
    this.#releaseHolds(run);
    if (this.#active === run) this.#active = undefined;
    this.#finished.set(run.id, run);
    this.#prune();
    run.done.resolve(outcome);
    this.#afterRun();
  }

  // -----------------------------------------------------------------------
  // The worker
  // -----------------------------------------------------------------------

  async #ensureWorker(): Promise<LiveWorker> {
    const current = this.#worker;
    if (current !== undefined && !current.dead) {
      await current.ready;
      return current;
    }
    const live = this.#spawn();
    this.#worker = live;
    await live.ready;
    return live;
  }

  #spawn(): LiveWorker {
    const { timing } = this.#d;
    const handle = this.#d.spawn({ env: this.#d.env });
    const ready = Promise.withResolvers<void>();
    ready.promise.catch(() => undefined);
    const stopped = Promise.withResolvers<string>();
    const live: LiveWorker = { handle, ready: ready.promise, stopped: stopped.promise, dead: false };
    const startup = setTimeout(() => {
      ready.reject(new Error("Timed out initializing browser tab worker"));
      this.#recycle(live, false);
    }, timing.startupTimeoutMs);
    void ready.promise.then(() => clearTimeout(startup), () => clearTimeout(startup));
    handle.onExit(reason => {
      live.dead = true;
      if (this.#worker === live) this.#worker = undefined;
      ready.reject(new Error(`Tab worker failed during startup: ${reason}`));
      stopped.resolve(reason);
      const run = this.#active;
      if (run !== undefined && run.worker === live && run.settled === undefined) {
        this.#settle(run, { error: run.override ?? { name: "CodeWorkerExited", message: `The code worker stopped (${reason}); the cell's variables were reset.`, isAbort: false } });
      }
      this.#afterRun();
    });
    handle.transport.onMessage(message => this.#onMessage(live, message, ready));
    const { screenshotDir, outputDir } = this.#d;
    handle.transport.send({
      t: "init",
      session: this.#d.session,
      env: this.#d.env,
      ...(screenshotDir === undefined ? {} : { screenshotDir }),
      ...(outputDir === undefined ? {} : { outputDir }),
      // A rebuilt worker re-adopts the session's tabs before it answers `ready`: the pages and browsers outlive it.
      tabs: [...this.#tabs.values()].map(tab => ({ name: tab.name, handle: tab.handle })),
    });
    return live;
  }

  /** Ends `live` now: the next cell gets a fresh worker that re-adopts the session's tabs, and its variables are gone. */
  #recycle(live: LiveWorker, note = true): void {
    if (this.#worker === live) this.#worker = undefined;
    live.dead = true;
    if (note) this.#resetNote = true;
    void live.handle.terminate().catch(() => undefined);
  }

  #onMessage(live: LiveWorker, message: WorkerToHost, ready: PromiseWithResolvers<void>): void {
    switch (message.t) {
      case "ready":
        ready.resolve();
        return;
      case "bridge":
        void this.#bridge(live, message);
        return;
      case "text": {
        const run = this.#active;
        if (run?.id !== message.runId) return;
        run.output = (run.output + message.chunk).slice(-MAX_OUTPUT_CHARS);
        run.onProgress?.(message.chunk);
        return;
      }
      case "result": {
        const run = this.#active;
        if (run?.id !== message.runId || run.worker !== live) return;
        this.#finish(live, run, message.ok ? { result: message.payload } : { error: message.error });
        return;
      }
      case "log":
        if (message.level !== "debug") console.error(`[browser-code] ${message.msg}`);
        return;
      case "closed":
        return;
    }
  }

  // -----------------------------------------------------------------------
  // The bridge: what a cell asks the main thread for
  // -----------------------------------------------------------------------

  async #bridge(live: LiveWorker, message: Extract<WorkerToHost, { t: "bridge" }>): Promise<void> {
    const reply = (m: HostToWorker): void => {
      if (!live.dead) live.handle.transport.send(m);
    };
    const run = this.#active;
    if (run === undefined || run.id !== message.runId || run.settled !== undefined) {
      reply({ t: "bridge-reply", id: message.id, ok: false, error: abortError() });
      return;
    }
    try {
      reply({ t: "bridge-reply", id: message.id, ok: true, value: await this.#request(message.request, run) });
    } catch (error) {
      reply({ t: "bridge-reply", id: message.id, ok: false, error: runErrorOf(error, run.controller.signal) });
    }
  }

  async #request(request: BridgeRequest, run: Run): Promise<HostReply> {
    switch (request.action) {
      case "open":
        return await this.#open(request, run);
      case "close":
        return await this.#close(request);
      case "tabs":
        return await this.#listTabs(run);
      case "active":
        return await this.#activeTab(run);
      case "run":
      case "call":
        throw new ToolError(`Action '${request.action}' runs in the code worker and never reaches the host`);
    }
  }

  async #open(request: BridgeRequest, run: Run): Promise<HostReply> {
    const name = request.name ?? DEFAULT_TAB_NAME;
    const timeoutMs = (request.timeout ?? 30) * 1000;
    const caller = run.controller.signal;
    // ONE deadline covers browser acquisition, the tab, and the navigation (matrix C7).
    const deadline = AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)]);
    try {
      return await this.#openTab(name, this.#d.resolveKind(request), request, timeoutMs, deadline, run);
    } catch (error) {
      if (caller.aborted) throw new ToolAbortError();
      if (deadline.aborted) throw new ToolError(`Browser open timed out after ${timeoutMs}ms`);
      throw error;
    }
  }

  async #openTab(name: string, kind: BrowserKind, request: BridgeRequest, timeoutMs: number, deadline: AbortSignal, run: Run): Promise<HostReply> {
    const { browsers } = this.#d;
    const existing = this.#tabs.get(name);
    if (existing !== undefined) {
      if (!sameBrowserKind(existing.kind, kind)) {
        throw new ToolError(`Tab ${JSON.stringify(name)} is bound to a different browser (${describeKind(existing.kind)}). Close it first.`);
      }
      const reused = await this.#reuse(existing, request, timeoutMs, deadline);
      if (reused !== undefined) return reused;
    }
    const acquired = await this.#acquire(kind, request, deadline, run);
    const { record } = acquired;
    if (!acquired.created && request.viewport !== undefined) await browsers.resize(record.browserId, request.viewport);
    let ref: TabRef;
    try {
      ref = await browsers.openTab(record.browserId, {
        ...(request.url === undefined ? {} : { url: request.url }),
        ...(request.wait_until === undefined ? {} : { waitUntil: request.wait_until }),
        ...(request.dialogs === undefined ? {} : { dialogs: request.dialogs }),
        timeoutMs,
      }, deadline);
    } catch (error) {
      // A browser this very open made, and nothing else uses, does not outlive its failure (matrix C8).
      if (acquired.created) await this.#dropBrowser(record, true);
      throw error;
    }
    const handle: TabHandle = { ...ref, browserId: record.browserId, wsEndpoint: record.wsEndpoint, kind: record.kind.kind, created: true };
    this.#tabs.set(name, { name, browserId: record.browserId, kind: record.kind, handle });
    return this.#opened("Opened", name, record.kind, ref, handle, request);
  }

  /** `browser.open` on a name the session already holds: refresh the tab's clocks and apply what the call asks (OMP tab-supervisor.ts:302-361). Undefined when the tab is gone, which opens it afresh. */
  async #reuse(existing: NamedTab, request: BridgeRequest, timeoutMs: number, deadline: AbortSignal): Promise<HostReply | undefined> {
    const { browsers } = this.#d;
    let alive: TabRef | undefined;
    try {
      alive = (await browsers.tabs(existing.browserId)).find(tab => tab.tabId === existing.handle.tabId);
    } catch {
      alive = undefined;
    }
    if (alive === undefined) {
      this.#forgetTab(existing.name);
      return undefined;
    }
    if (request.persist !== undefined) browsers.setPersist(existing.browserId, request.persist);
    if (request.dialogs !== undefined) browsers.setDialogPolicy(existing.browserId, existing.handle.tabId, request.dialogs);
    if (request.viewport !== undefined) await browsers.resize(existing.browserId, request.viewport);
    const ref = request.url === undefined
      ? alive
      : await browsers.navigateTab(existing.browserId, existing.handle.tabId, { url: request.url, ...(request.wait_until === undefined ? {} : { waitUntil: request.wait_until }), timeoutMs }, deadline);
    const handle: TabHandle = { ...existing.handle, ...ref, created: existing.handle.created };
    this.#tabs.set(existing.name, { ...existing, handle });
    return this.#opened("Reused", existing.name, existing.kind, ref, handle, request);
  }

  #opened(verb: "Opened" | "Reused", name: string, kind: BrowserKind, ref: TabRef, handle: TabHandle, request: BridgeRequest): HostReply {
    const size = request.viewport ?? CODE_VIEWPORT;
    return {
      text: [`${verb} tab ${JSON.stringify(name)} on ${describeBrowser(kind)}`, `URL: ${ref.url}`, ref.title ? `Title: ${ref.title}` : null].filter(line => line !== null).join("\n"),
      details: { action: "open", name, browser: kind.kind, url: ref.url, viewport: { width: size.width, height: size.height, ...(size.scale === undefined ? {} : { deviceScaleFactor: size.scale }) } },
      attach: handle,
    };
  }

  /** The browser a call works on: the session's own (one per session), or a new one. Held for the cell that asked, so no clock closes it under that cell. */
  async #acquire(kind: BrowserKind, request: BridgeRequest, deadline: AbortSignal, run: Run): Promise<{ record: BrowserRecord; created: boolean }> {
    const { browsers } = this.#d;
    const made = await browsers.acquire(this.#d.session, {
      kind,
      ...(request.profile === undefined ? {} : { profile: request.profile }),
      ...(request.viewport === undefined ? {} : { viewport: request.viewport }),
      ...(request.persist === undefined ? {} : { persist: request.persist }),
    }, deadline);
    let record = this.#browsers.get(made.browserId);
    if (record === undefined) {
      record = { browserId: made.browserId, wsEndpoint: made.wsEndpoint, kind, createdByCode: made.created };
      this.#browsers.set(record.browserId, record);
    } else {
      record.wsEndpoint = made.wsEndpoint;
    }
    if (!run.holds.has(record.browserId)) {
      try {
        run.holds.set(record.browserId, browsers.holdWork(record.browserId));
      } catch (error) {
        if (made.created) await this.#dropBrowser(record, true);
        throw error;
      }
    }
    return { record, created: made.created };
  }

  async #close(request: BridgeRequest): Promise<HostReply> {
    const name = request.name ?? DEFAULT_TAB_NAME;
    const kill = request.kill === true;
    if (request.all === true) {
      const names = [...this.#tabs.keys()];
      for (const held of names) await this.#releaseTab(held, kill);
      return { text: `Released ${names.length} managed tab${names.length === 1 ? "" : "s"}`, details: { action: "close", name } };
    }
    const had = this.#tabs.has(name);
    if (had) await this.#releaseTab(name, kill);
    return { text: had ? `Released managed tab ${JSON.stringify(name)}` : `No tab named ${JSON.stringify(name)}`, details: { action: "close", name } };
  }

  /** Releases a named tab: its page closes, and the browser with it when this was the cell's own and no other tab of the session uses it (matrix C11). */
  async #releaseTab(name: string, kill: boolean): Promise<void> {
    const tab = this.#tabs.get(name);
    if (tab === undefined) return;
    this.#forgetTab(name);
    await this.#d.browsers.closeTab(tab.browserId, tab.handle.tabId).catch(() => undefined);
    const record = this.#browsers.get(tab.browserId);
    if (record === undefined || !record.createdByCode || [...this.#tabs.values()].some(other => other.browserId === record.browserId)) return;
    await this.#dropBrowser(record, kill);
  }

  /** Lets go of a browser the cell made: the runtime closes it unless a View has joined it (the person's eyes outrank a cell's tidiness). */
  async #dropBrowser(record: BrowserRecord, kill: boolean): Promise<void> {
    const { browsers } = this.#d;
    if ((browsers.activity(record.browserId)?.viewers ?? 0) > 0) return;
    this.#forgetBrowser(record.browserId);
    await browsers.release(record.browserId, { kill }).catch((error: unknown) => console.error("A cell's browser did not close:", codedMessage(error)));
  }

  #forgetTab(name: string): void {
    this.#tabs.delete(name);
  }

  #forgetBrowser(browserId: string): void {
    this.#browsers.delete(browserId);
    for (const [name, tab] of this.#tabs) if (tab.browserId === browserId) this.#tabs.delete(name);
    for (const key of [...this.#frozen]) if (key.startsWith(`${browserId}\u0000`)) this.#frozen.delete(key);
    this.#active?.holds.get(browserId)?.();
    this.#active?.holds.delete(browserId);
  }

  /** Every browser the session holds, including one the person opened in the View that no cell has named yet. */
  #known(): BrowserRecord[] {
    const found = this.#d.browsers.existing(this.#d.session);
    if (found !== undefined && !this.#browsers.has(found.browserId)) {
      this.#browsers.set(found.browserId, { browserId: found.browserId, wsEndpoint: found.wsEndpoint, kind: this.#d.resolveKind({ action: "open" }), createdByCode: false });
    }
    return [...this.#browsers.values()];
  }

  async #listTabs(run: Run): Promise<HostReply> {
    const value: CodeTabInfo[] = [];
    for (const record of this.#known()) {
      this.#holdFor(run, record.browserId);
      for (const ref of await this.#d.browsers.tabs(record.browserId)) {
        const named = [...this.#tabs.values()].find(tab => tab.browserId === record.browserId && tab.handle.tabId === ref.tabId);
        value.push({ ...(named === undefined ? {} : { name: named.name }), id: ref.tabId, url: ref.url, title: ref.title, active: ref.active });
      }
    }
    return { text: "", details: { action: "tabs", name: DEFAULT_TAB_NAME, value } };
  }

  /** `browser.active()`: the tab the person is looking at, adopted like an `open` under its own name or one made up from its id. */
  async #activeTab(run: Run): Promise<HostReply> {
    for (const record of this.#known()) {
      this.#holdFor(run, record.browserId);
      const current = (await this.#d.browsers.tabs(record.browserId)).find(ref => ref.active);
      if (current === undefined) continue;
      const named = [...this.#tabs.values()].find(tab => tab.browserId === record.browserId && tab.handle.tabId === current.tabId);
      const name = named?.name ?? `tab-${current.tabId.slice(0, 6)}`;
      const handle: TabHandle = { ...current, browserId: record.browserId, wsEndpoint: record.wsEndpoint, kind: record.kind.kind, created: named?.handle.created ?? false };
      this.#tabs.set(name, { name, browserId: record.browserId, kind: record.kind, handle });
      return { text: "", details: { action: "active", name, url: current.url }, attach: handle };
    }
    throw new ToolError("No browser is open in this session. Open one with browser.open() first.");
  }

  // -----------------------------------------------------------------------
  // Holds, take-over, freeze
  // -----------------------------------------------------------------------

  #holdFor(run: Run, browserId: string): void {
    if (!run.holds.has(browserId)) run.holds.set(browserId, this.#d.browsers.holdWork(browserId));
  }

  /** The cell counts as a call in flight on every browser the session holds: no idle close, no make-room, and the refusals a page call gets (`task_running`, `publish_pending`, `human_driving`). */
  #holdBrowsers(run: Run): void {
    for (const record of [...this.#browsers.values()]) {
      try {
        this.#holdFor(run, record.browserId);
      } catch (error) {
        if (error instanceof BrowserRuntimeError && error.code === "unknown_browser") {
          this.#forgetBrowser(record.browserId);
          continue;
        }
        this.#releaseHolds(run);
        throw new ToolError(codedMessage(error));
      }
    }
  }

  #releaseHolds(run: Run): void {
    for (const release of run.holds.values()) release();
    run.holds.clear();
  }

  /** A browser of this session ended. Its tabs are dropped from the worker (a cell waiting on one is rejected there); a take-over also stops the cell that was using it. */
  browserEnded(browserId: string, why: "closed" | "retired" | "taken-over", reason: string | undefined): void {
    if (!this.#browsers.has(browserId)) return;
    const run = this.#active;
    const worker = this.#worker;
    const used = run?.holds.has(browserId) === true;
    this.#forgetBrowser(browserId);
    if (worker !== undefined && !worker.dead) worker.handle.transport.send({ t: "end", browserId, why, ...(reason === undefined ? {} : { reason }) });
    if (why === "taken-over" && run !== undefined && used && run.settled === undefined) {
      run.override = { name: "ToolError", message: "human_driving: the person took over this browser in the View, so the cell was stopped. Ask them to hand it back before you act again.", isAbort: true };
      run.controller.abort(new ToolAbortError());
      worker?.handle.transport.send({ t: "abort", runId: run.id });
    }
    this.#afterRun();
  }

  /** A View joined `browserId`'s stream: a frozen tab draws nothing, so it is thawed before the View looks. */
  viewed(browserId: string): void {
    if (this.#browsers.has(browserId)) void this.#thaw(browserId);
  }

  #thaw(only?: string): Promise<void> {
    const work = this.#sweeping.then(async () => {
      for (const key of [...this.#frozen]) {
        const [browserId, tabId] = key.split("\u0000") as [string, string];
        if (only !== undefined && browserId !== only) continue;
        this.#frozen.delete(key);
        await this.#d.browsers.setFrozen(browserId, tabId, false).catch(() => undefined);
      }
    });
    this.#sweeping = work.catch(() => undefined);
    return work;
  }

  /** Freezes the session's tabs once nothing has touched their browsers for the freeze period: no cell, no call, no View (OMP freezes at turn end; MCP sends none, doc 77 E3). */
  #freezeSweep(): void {
    const { freezeIdleMs } = this.#d.timing;
    const work = this.#sweeping.then(async () => {
      if (this.#active !== undefined || this.#closed) return;
      let nextIn = Number.POSITIVE_INFINITY;
      for (const record of [...this.#browsers.values()]) {
        const activity = this.#d.browsers.activity(record.browserId);
        if (activity === undefined) continue;
        if (activity.viewers > 0 || activity.pending > 0) {
          nextIn = Math.min(nextIn, freezeIdleMs);
          continue;
        }
        if (activity.idleMs < freezeIdleMs) {
          nextIn = Math.min(nextIn, freezeIdleMs - activity.idleMs);
          continue;
        }
        for (const tab of [...this.#tabs.values()]) {
          if (tab.browserId !== record.browserId || this.#frozen.has(tabKey(tab.browserId, tab.handle.tabId))) continue;
          await this.#d.browsers.setFrozen(tab.browserId, tab.handle.tabId, true).then(() => this.#frozen.add(tabKey(tab.browserId, tab.handle.tabId)), () => undefined);
        }
      }
      if (Number.isFinite(nextIn) && this.#active === undefined) this.#armFreeze(nextIn);
    });
    this.#sweeping = work.catch(() => undefined);
  }

  #armFreeze(afterMs: number): void {
    clearTimeout(this.#freezeTimer);
    this.#freezeTimer = setTimeout(() => this.#freezeSweep(), Math.max(50, afterMs));
    this.#freezeTimer.unref();
  }

  // -----------------------------------------------------------------------
  // Clocks
  // -----------------------------------------------------------------------

  /** After anything that ends work: the freeze clock, the worker's idle clock and the clock that forgets a finished run. */
  #afterRun(): void {
    if (this.#closed || this.#active !== undefined) return;
    const { freezeIdleMs, workerIdleMs, finishedTtlMs } = this.#d.timing;
    if (freezeIdleMs > 0 && this.#browsers.size > 0) this.#armFreeze(freezeIdleMs);
    clearTimeout(this.#idleTimer);
    // The worker dies with its last browser and after an idle spell without one (doc 77 §7.4.3 rule 6); with a browser, the browser's own idle clock ends it first.
    if (this.#browsers.size === 0 && this.#worker !== undefined) {
      this.#idleTimer = setTimeout(() => void this.#retireWorker(), workerIdleMs);
      this.#idleTimer.unref();
    }
    clearTimeout(this.#pruneTimer);
    if (this.#finished.size > 0) {
      this.#pruneTimer = setTimeout(() => {
        this.#prune();
        this.#afterRun();
      }, finishedTtlMs);
      this.#pruneTimer.unref();
    }
    this.#emptyIfDone();
  }

  #prune(): void {
    const now = Date.now();
    for (const [id, run] of this.#finished) if (now - run.finishedAt > this.#d.timing.finishedTtlMs) this.#finished.delete(id);
    for (const id of this.#finished.keys()) {
      if (this.#finished.size <= MAX_FINISHED) break;
      this.#finished.delete(id);
    }
  }

  async #retireWorker(): Promise<void> {
    if (this.#active !== undefined || this.#browsers.size > 0) return;
    await this.#closeWorker();
    this.#emptyIfDone();
  }

  #emptyIfDone(): void {
    if (this.#active !== undefined || this.#worker !== undefined || this.#browsers.size > 0 || this.#finished.size > 0) return;
    this.#closed = true;
    clearTimeout(this.#freezeTimer);
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#pruneTimer);
    this.#d.onEmpty();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("the browser code host is shut down");
  }

  /** The worker leaves politely when it can (its realm disconnects from every browser), and is terminated when it cannot. */
  async #closeWorker(): Promise<void> {
    const live = this.#worker;
    if (live === undefined) return;
    this.#worker = undefined;
    if (!live.dead) {
      live.handle.transport.send({ t: "close" });
      await Promise.race([live.stopped, new Promise<void>(resolve => setTimeout(resolve, 2_000).unref())]);
    }
    live.dead = true;
    await live.handle.terminate().catch(() => undefined);
  }

  /** Server shutdown: the running cell is cancelled, every hold is let go, the worker ends. The runtime closes the browsers. */
  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#freezeTimer);
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#pruneTimer);
    const run = this.#active;
    if (run !== undefined && run.settled === undefined) {
      run.controller.abort(new ToolAbortError());
      this.#settle(run, { error: abortError() });
    }
    await this.#sweeping;
    await this.#closeWorker();
  }
}

/** One folder per session for what a cell keeps on disk (an over-cap output): a hash of the stamp, so the id itself is never a path. */
export function sessionFolder(root: string, session: string): string {
  return join(root, createHash("sha256").update(session).digest("hex").slice(0, 16));
}
