// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/tab-worker.ts (WorkerCore: #init's attach path, #run, #consumeUnhandledRejection, #recordFloatingRejection,
// #floatingRejectionError, #foldFloatingRejections, #close) and tab-supervisor.ts (the `is not alive`, `was closed` and `is busy` texts, the 750 ms grace) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack (doc 77 7.4, matrix D1, D5, D28; a failed request-interception cleanup no longer replaces the run's own failure): OMP runs one process per tab behind a supervisor, so `tab.click` crosses two hops; here ONE worker holds every tab of a session and the
// engine has already created and instrumented each page, so this realm only ADOPTS a page by targetId and `run` and `call` are plain calls inside the worker (zero postMessage hops). The page is never
// created, closed or restyled here (stealth, viewport, dialog policy and the page log stay the engine's); the realm only disconnects its own connection. The user's code runs through the cell's
// evaluator, which owns wrapCode and the persistent names.

import { isMainThread } from "node:worker_threads";
import puppeteer, { type Browser, type Page, type Target } from "puppeteer-core";
import { renderFunctionRun } from "../cell/run-code";
import type { CodeEvaluator, RunResult, TabHandle, TabRealm } from "../contracts";
import { ToolAbortError, ToolError, throwIfAborted } from "../errors";
import { sleep } from "./abortable";
import { cloneSafe, RunOutput } from "./run-output";
import { createRunPageScope, type RunPageScope } from "./run-page-scope";
import {
  bindRunFacade,
  installBrowserWorkerRejectionGuard,
  isBrowserRunOwnedRejection,
  isExpectedCleanupError,
  markExpectedCleanupError,
  observeBrowserRunPromise,
  resolvePredicateTimeout,
  type WaitPredicateOptions,
  waitForRun,
  withBrowserPromiseCombinatorTracking,
} from "./run-scope";
import { resolveScreenshotDir, type ShotConfig } from "./screenshot";
import { createTabApi } from "./tab-api";
import { renderTabCall, type TabCallStep } from "./tab-call";
import { describeInflight, type RunState } from "./tab-ops";
import { TabSession } from "./tab-session";

/** The browser connection's protocol timeout (OMP `BROWSER_PROTOCOL_TIMEOUT_MS`): a CDP call that never answers fails after a minute. */
const BROWSER_PROTOCOL_TIMEOUT_MS = 60_000;
/** After a run is cancelled, how long it may take to unwind before a closing tab stops waiting for it (OMP's supervisor grace). */
const GRACE_MS = 750;
/** A page the engine just made may not have reached this connection yet. */
const TARGET_APPEAR_TIMEOUT_MS = 5_000;
/** The names a function run receives, and the ones `tab.run` code can use (OMP `BROWSER_RUN_SCOPE`). */
const RUN_SCOPE: readonly string[] = ["tab", "page", "browser", "wait", "assert"];

export interface TabRealmOptions {
  /** One evaluator per tab NAME (a factory), so a tab's top-level names persist per tab as they do in OMP. */
  evaluator: () => CodeEvaluator;
  /** The worker's environment (`init.env`); `DIMENSION_BROWSER_SCREENSHOT_DIR` is read from it when `screenshotDir` is not given. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The screenshot directory the host resolved (`init.screenshotDir`); wins over the environment. */
  screenshotDir?: string;
  /** Resolves a relative `uploadFile` path. MCP calls carry no working directory, so unset means a relative path is refused with the rule named. */
  cwd?: string;
  /** Refuse `type` and `fill` on a password input from code (matrix D18). Off is OMP's behaviour. */
  refusePasswordFields?: boolean;
  /** Encode the model's screenshot as JPEG instead of WebP. */
  excludeWebP?: boolean;
  /** Route unhandled rejections of the code a run started back into that run. Default: only inside a worker thread, where an unhandled rejection would end the worker. */
  guardRejections?: boolean;
  /** Where the realm's warnings go (the worker passes its host `log` message). */
  log?: (level: "debug" | "warn" | "error", msg: string) => void;
}

interface BrowserConnection {
  wsEndpoint: string;
  browser: Promise<Browser>;
}

function privateTargetId(target: Target): string | undefined {
  const raw = target as unknown as { _targetId?: unknown };
  return typeof raw._targetId === "string" ? raw._targetId : undefined;
}

/** The page's own target id: private field when Puppeteer has it, else CDP says. */
async function targetIdOf(target: Target): Promise<string> {
  const fast = privateTargetId(target);
  if (fast) return fast;
  const session = await target.createCDPSession();
  try {
    const info = (await session.send("Target.getTargetInfo")) as { targetInfo?: { targetId?: string } };
    if (info.targetInfo?.targetId) return info.targetInfo.targetId;
    throw new ToolError("Target id unavailable from CDP target info");
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** The tab realm the dispatcher drives: pages the engine opened, adopted by name, run through OMP's tab helpers. */
export function createTabRealm(options: TabRealmOptions): TabRealm {
  return new BrowserTabRealm(options);
}

class BrowserTabRealm implements TabRealm {
  readonly #options: TabRealmOptions;
  readonly #sessions = new Map<string, TabSession>();
  readonly #connections = new Map<string, BrowserConnection>();
  /** Why a tab's browser ended, by tab name, so a later call on that name can say so instead of just that it is not alive. */
  readonly #ended = new Map<string, string>();
  readonly #uninstallGuard: (() => void) | undefined;
  #runCounter = 0;
  #disposed = false;

  constructor(options: TabRealmOptions) {
    this.#options = options;
    if (options.guardRejections ?? !isMainThread) {
      this.#uninstallGuard = installBrowserWorkerRejectionGuard(reason => this.#consumeUnhandledRejection(reason));
    }
  }

  names(): string[] {
    return [...this.#sessions.keys()];
  }

  async adopt(name: string, handle: TabHandle): Promise<void> {
    if (this.#disposed) throw new ToolError("The tab realm is closed");
    const held = this.#sessions.get(name);
    if (held && held.handle.targetId === handle.targetId && held.handle.browserId === handle.browserId && !held.page.isClosed()) return;
    const browser = await this.#connect(handle);
    const page = await this.#pageFor(browser, handle.targetId);
    const session = new TabSession(name, handle, browser, page, handle.activateForScreenshot ?? (handle.created || (handle.kind !== "connected" && handle.kind !== "relay")));
    // A relay claims the pages its extension should group; every other backend would reject the private method, so only the relay is asked.
    if (handle.kind === "relay") await session.claimRelayTarget();
    // The previous page of this name goes only once the new one is in hand: a failed adopt leaves the name as it was.
    if (held) await this.#drop(held, new ToolError(`Tab "${name}" was closed`));
    this.#ended.delete(name);
    this.#sessions.set(name, session);
  }

  async release(name: string): Promise<void> {
    this.#ended.delete(name);
    const session = this.#sessions.get(name);
    if (!session) return;
    await this.#drop(session, new ToolError(`Tab "${name}" was closed`));
    await this.#disconnectIfUnused(session.handle.browserId);
  }

  async end(browserId: string, reason?: string): Promise<void> {
    const sessions = [...this.#sessions.values()].filter(session => session.handle.browserId === browserId);
    for (const session of sessions) {
      if (reason) this.#ended.set(session.name, reason);
      await this.#drop(session, new ToolError(`Tab "${session.name}" was closed${reason ? `: ${reason}` : ""}`));
    }
    await this.#disconnectIfUnused(browserId);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#uninstallGuard?.();
    for (const session of [...this.#sessions.values()]) await this.#drop(session, new ToolError(`Tab "${session.name}" was closed`));
    for (const browserId of [...this.#connections.keys()]) await this.#disconnectIfUnused(browserId);
  }

  async run(r: Parameters<TabRealm["run"]>[0]): Promise<RunResult> {
    const session = this.#alive(r.name);
    const hasCode = r.code !== undefined && r.code.trim().length > 0;
    const hasFn = r.fn !== undefined && r.fn.trim().length > 0;
    if (hasCode === hasFn) throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
    const code = hasFn ? renderFunctionRun(r.fn!.trim(), RUN_SCOPE, r.args ?? []) : r.code!.trim();
    return this.#execute(session, code, r.timeoutMs, r.signal);
  }

  async call(r: Parameters<TabRealm["call"]>[0]): Promise<RunResult> {
    const session = this.#alive(r.name);
    return this.#execute(session, renderTabCall(r.chain as readonly TabCallStep[]), r.timeoutMs, r.signal);
  }

  #alive(name: string): TabSession {
    const session = this.#sessions.get(name);
    if (!session || session.page.isClosed()) {
      const why = this.#ended.get(name);
      throw new ToolError(`Tab ${JSON.stringify(name)} is not alive. Open it first with action:"open".${why ? ` Its browser ended (${why}).` : ""}`);
    }
    return session;
  }

  /** One connection per browser, shared by every tab of it; a changed endpoint under the same id is a new browser. */
  async #connect(handle: TabHandle): Promise<Browser> {
    const held = this.#connections.get(handle.browserId);
    if (held && held.wsEndpoint === handle.wsEndpoint) {
      const browser = await held.browser;
      if (browser.connected) return browser;
    }
    if (held) await this.end(handle.browserId);
    const connection: BrowserConnection = {
      wsEndpoint: handle.wsEndpoint,
      browser: puppeteer.connect({ browserWSEndpoint: handle.wsEndpoint, defaultViewport: null, protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS }),
    };
    this.#connections.set(handle.browserId, connection);
    try {
      const browser = await connection.browser;
      browser.on("disconnected", () => {
        if (this.#connections.get(handle.browserId) === connection) void this.end(handle.browserId, "the browser disconnected").catch(() => undefined);
      });
      return browser;
    } catch (error) {
      if (this.#connections.get(handle.browserId) === connection) this.#connections.delete(handle.browserId);
      throw error;
    }
  }

  async #pageFor(browser: Browser, targetId: string): Promise<Page> {
    const matches = (target: Target): boolean => privateTargetId(target) === targetId;
    let target: Target | undefined = browser.targets().find(matches);
    if (!target) {
      for (const candidate of browser.targets()) {
        if ((await targetIdOf(candidate).catch(() => "")) === targetId) {
          target = candidate;
          break;
        }
      }
    }
    // The engine made the page through its own connection a moment ago; this one learns of it by event.
    target ??= await browser.waitForTarget(matches, { timeout: TARGET_APPEAR_TIMEOUT_MS }).catch(() => undefined);
    if (!target) throw new ToolError(`Target ${targetId} is no longer available on the attached browser`);
    const page = await target.page();
    if (!page) throw new ToolError(`Target ${targetId} is no longer available on the attached browser`);
    return page;
  }

  /** Stop the run in flight on a tab (it gets `reason`), wait a grace for it to unwind, then forget the page. The page itself is the engine's and stays open. */
  async #drop(session: TabSession, reason: Error): Promise<void> {
    if (this.#sessions.get(session.name) === session) this.#sessions.delete(session.name);
    const active = session.active;
    if (active) {
      active.ac.abort(reason);
      await Promise.race([session.done, sleep(GRACE_MS)]);
    }
    await session.dispose();
  }

  /** The realm's own connection to a browser is released (never the browser) when no tab of it remains. */
  async #disconnectIfUnused(browserId: string): Promise<void> {
    for (const session of this.#sessions.values()) if (session.handle.browserId === browserId) return;
    const connection = this.#connections.get(browserId);
    if (!connection) return;
    this.#connections.delete(browserId);
    const browser = await connection.browser.catch(() => undefined);
    await browser?.disconnect().catch(() => undefined);
  }

  #consumeUnhandledRejection(reason: unknown): boolean {
    for (const session of this.#sessions.values()) {
      const active = session.active;
      if (!active) continue;
      if (!isBrowserRunOwnedRejection(reason, active.rejectionOwner, active.filename)) continue;
      this.#recordFloatingRejection(active, session, reason);
      return true;
    }
    return false;
  }

  #recordFloatingRejection(active: RunState, session: TabSession, reason: unknown): void {
    if (isExpectedCleanupError(reason)) return;
    if (session.active !== active) {
      this.#options.log?.("warn", `Unhandled rejection after browser run ended (run ${active.id}): ${reason instanceof Error ? reason.message : String(reason)}`);
      return;
    }
    const isFirst = active.floatingRejections.length === 0;
    active.floatingRejections.push(reason);
    if (isFirst) active.floatingFailure.reject(this.#floatingRejectionError(reason));
  }

  #floatingRejectionError(reason: unknown): Error {
    const message = reason instanceof Error ? reason.message : String(reason);
    const error = new Error(`Unhandled rejection (missing await?): ${message}`, { cause: reason });
    if (reason instanceof Error) error.name = reason.name;
    return error;
  }

  #foldFloatingRejections(active: RunState, failure: { error: unknown } | undefined): { error: unknown } | undefined {
    const rejections = active.floatingRejections;
    if (rejections.length === 0) return failure;
    let reported = rejections;
    if (!failure) {
      failure = { error: this.#floatingRejectionError(rejections[0]) };
      reported = rejections.slice(1);
    } else if (failure.error instanceof Error && failure.error.cause === rejections[0]) {
      reported = rejections.slice(1);
    }
    for (const reason of reported) {
      this.#options.log?.("warn", `Additional unhandled browser-run rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    }
    return failure;
  }

  /** OMP's `#run`: one run on one tab, under the run's own deadline, with the helpers' per-operation guards and the floating-rejection routing. */
  async #execute(session: TabSession, code: string, timeoutMs: number, hostSignal: AbortSignal): Promise<RunResult> {
    if (session.active) throw new ToolError(`Tab ${JSON.stringify(session.name)} is busy`);
    const runId = String(++this.#runCounter);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const ac = new AbortController();
    const runAc = new AbortController();
    const signal = AbortSignal.any([timeoutSignal, hostSignal, ac.signal, runAc.signal]);
    const output = new RunOutput();
    const screenshots: RunState["screenshots"] = [];
    const floatingFailure = Promise.withResolvers<never>();
    const active: RunState = {
      id: runId,
      ac,
      signal,
      output,
      screenshots,
      filename: `browser-run-${runId}.js`,
      rejectionOwner: {},
      floatingRejections: [],
      floatingFailure,
      inflight: new Map(),
      opCounter: 0,
    };
    const finished = Promise.withResolvers<void>();
    session.active = active;
    session.done = finished.promise;
    let completed = false;
    let returnValue: unknown;
    let failure: { error: unknown } | undefined;
    let runPage: RunPageScope | undefined;
    try {
      throwIfAborted(signal);
      runPage = createRunPageScope(session.page);
      const shot: ShotConfig = {
        dir: this.#options.screenshotDir ?? resolveScreenshotDir(this.#options.env ?? {}),
        excludeWebP: this.#options.excludeWebP ?? false,
        activate: session.activateForScreenshot,
      };
      const tabApi = createTabApi(
        { session, run: active, signal, timeoutMs, shot, cwd: this.#options.cwd, refusePasswordFields: this.#options.refusePasswordFields ?? false },
        output,
        screenshots,
      );
      const onFloatingRejection = (reason: unknown): void => this.#recordFloatingRejection(active, session, reason);
      const wait = (msOrPredicate: number | (() => unknown), opts?: WaitPredicateOptions): Promise<unknown> => {
        // Both wait forms register in the in-flight map so a cell that dies while sleeping or polling names the culprit instead of a bare whole-cell timeout.
        const label = typeof msOrPredicate === "number" ? `wait(${msOrPredicate}ms)` : "wait(predicate)";
        const resolved =
          typeof msOrPredicate === "number" ? undefined : { timeout: resolvePredicateTimeout(timeoutMs, opts?.timeout), interval: opts?.interval };
        return observeBrowserRunPromise(
          session.ops.runOp(active, label, signal, Number.POSITIVE_INFINITY, sig => waitForRun(msOrPredicate, sig, resolved)),
          active.rejectionOwner,
          onFloatingRejection,
        );
      };
      const scope: Record<string, unknown> = {
        page: bindRunFacade(runPage.page, signal, active.rejectionOwner, onFloatingRejection),
        browser: bindRunFacade(session.browser, signal, active.rejectionOwner, onFloatingRejection),
        tab: bindRunFacade(tabApi, signal, active.rejectionOwner, onFloatingRejection),
        assert: (cond: unknown, text?: string): void => {
          if (!cond) throw new ToolError(text ?? "Assertion failed");
        },
        wait,
      };
      const { promise: cancelRejection, reject: rejectCancel } = Promise.withResolvers<never>();
      const onCancel = (): void => {
        if (timeoutSignal.aborted) {
          const stalled = describeInflight(active.inflight);
          const dialog = session.openDialog;
          const dialogNote = dialog
            ? `; a ${dialog.type}(${JSON.stringify(dialog.message.slice(0, 80))}) dialog opened during this run and may still block the page — reopen the tab with dialogs:"accept"|"dismiss" or handle page.on('dialog')`
            : "";
          rejectCancel(new ToolError(`Browser code execution timed out after ${timeoutMs}ms${stalled ? ` (stalled on ${stalled})` : ""}${dialogNote}`));
          return;
        }
        const reason: unknown = signal.reason;
        // A closed or ended tab says so; any other abort is a cancellation.
        if (reason instanceof ToolError) rejectCancel(reason);
        else rejectCancel(reason instanceof ToolAbortError ? reason : new ToolAbortError(undefined, { cause: reason }));
      };
      if (signal.aborted) onCancel();
      else signal.addEventListener("abort", onCancel, { once: true });
      try {
        const evaluator = (session.evaluator ??= this.#options.evaluator());
        const hooks = {
          onText: (chunk: string): void => {
            throwIfAborted(signal);
            output.pushText(chunk);
          },
          onDisplay: (display: Parameters<RunOutput["pushDisplay"]>[0]): void => {
            throwIfAborted(signal);
            output.pushDisplay(display);
          },
        };
        returnValue = await withBrowserPromiseCombinatorTracking(
          active.rejectionOwner,
          onFloatingRejection,
          async () => await Promise.race([evaluator.evaluate(code, { filename: active.filename, scope, hooks }), cancelRejection, floatingFailure.promise]),
        );
        completed = true;
      } finally {
        signal.removeEventListener("abort", onCancel);
      }
    } catch (error) {
      failure = { error };
    } finally {
      runAc.abort(markExpectedCleanupError(new ToolAbortError("Browser run ended")));
      await sleep(0);
      try {
        await runPage?.cleanup();
      } catch (error) {
        // OMP let the cleanup failure replace the run's own. A page stuck behind a dialog fails both, and the run's own failure is the one that names the dialog: keep it and only
        // ask for the rebuild the cleanup failure calls for.
        if (failure === undefined) failure = { error };
        else if (typeof failure.error === "object" && failure.error !== null) Reflect.set(failure.error, "recoverTab", true);
      }
      failure = this.#foldFloatingRejections(active, failure);
      if (session.active === active) session.active = null;
      finished.resolve();
    }
    if (failure) throw failure.error;
    if (!completed) throw new ToolError("Browser code execution did not complete");
    return { displays: output.finish(), returnValue: cloneSafe(returnValue), screenshots };
  }
}

