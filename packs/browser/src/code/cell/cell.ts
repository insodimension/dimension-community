// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/eval/js/worker-core.ts (the run path, the floating-rejection guard) and
// packages/coding-agent/src/eval/js/executor.ts (the timeout annotation) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: one cell per worker and one facade (OMP's prelude.js, verbatim) whose two hooks, `__omp_prelude__` and `__omp_display__`, route by async context to the run that
// called them; the bridge is a function the worker core gives each run; the eval tool's output sink is `CellOutput`; no cwd, tool bridge or handle machinery.

import { AsyncLocalStorage } from "node:async_hooks";
import type { BridgeResponse, CodeEvaluator, EvaluatorHooks, RunError, RunResult, ScreenshotResult } from "../contracts.js";
import { ToolAbortError, ToolError, throwIfAborted } from "../errors.js";
import facadeSource from "../facade/prelude.js.txt";
import { CellOutput, displayValue } from "./display.js";
import { createCodeEvaluator } from "./evaluator.js";

/** What a cell's `browser.*` call becomes: the dispatcher validates the parameters and answers with the text the facade prints. */
export type CellInvoke = (parameters: unknown, o: { runId: string; signal: AbortSignal }) => Promise<BridgeResponse>;

export interface CellRunOptions {
  runId: string;
  code: string;
  /** The cell's own budget. Past it the run fails with OMP's timeout text and every operation it started is aborted. */
  timeoutMs: number;
  /** The caller's cancellation (an MCP request that was cancelled, a take-over). */
  signal: AbortSignal;
  invoke: CellInvoke;
  /** Every chunk of text the cell prints, as it prints it. */
  onText?: (chunk: string) => void;
}

/** The cell's budget ran out. Not a cancellation: the model is told, with the output it had by then. */
export class CellTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Command timed out after ${Math.max(1, Math.round(timeoutMs / 1000))} seconds.`);
    this.name = "TimeoutError";
  }
}

interface CellRun {
  runId: string;
  filename: string;
  signal: AbortSignal;
  invoke: CellInvoke;
  hooks: EvaluatorHooks;
  screenshots: ScreenshotResult[];
  floating: unknown[];
  ended: boolean;
}

const callerRun = new AsyncLocalStorage<CellRun>();
const GLOBAL_KEYS = ["__omp_prelude__", "__omp_display__", "browser"] as const;
let facadeUsers = 0;

function installFacade(): void {
  if (facadeUsers++ > 0) return;
  const target = globalThis as Record<string, unknown>;
  target.__omp_prelude__ = async (name: string, parameters: unknown): Promise<unknown> => {
    const run = callerRun.getStore();
    if (!run || run.ended) throw new ToolError("browser can only be used while a cell is running");
    if (name !== "browser") throw new ToolError(`Unknown prelude ${JSON.stringify(name)}`);
    throwIfAborted(run.signal);
    const response = await run.invoke(parameters, { runId: run.runId, signal: run.signal });
    // Images become the cell's own displays; the facade only reads `text` and `details` (OMP: surfaceBridgedToolImages).
    for (const image of response.images ?? []) run.hooks.onDisplay(image);
    if (response.details.screenshots) run.screenshots.push(...response.details.screenshots);
    return { text: response.text, details: response.details };
  };
  target.__omp_display__ = (value: unknown): void => {
    const run = callerRun.getStore();
    if (run && !run.ended) displayValue(value, run.hooks);
  };
  // The facade is a block statement that assigns `globalThis.browser`; an indirect eval runs it in global scope.
  const geval = globalThis.eval as (source: string) => unknown;
  geval(facadeSource);
}

function uninstallFacade(): void {
  if (--facadeUsers > 0) return;
  for (const key of GLOBAL_KEYS) delete (globalThis as Record<string, unknown>)[key];
}

/** A thrown value as the host gets it: `name` and `message` kept, `isAbort` for cancellation, `recoverTab` when the realm marked the failure as one that needs a fresh worker. */
export function failureOf(error: unknown): RunError {
  if (error instanceof Error) {
    const recoverTab = (error as Error & { recoverTab?: unknown }).recoverTab === true;
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
      ...(recoverTab ? { recoverTab } : {}),
    };
  }
  return { name: "Error", message: String(error), isAbort: false };
}

/** A failed run: the error, and everything the cell had shown before it (a screenshot taken before the step that threw is still the model's to see). */
export class CellFailure extends Error {
  constructor(
    readonly error: RunError,
    readonly partial: RunResult,
  ) {
    super(error.message);
    this.name = error.name;
  }
}

const RECENT_CELL_FILES_MAX = 256;

/**
 * The cell realm: runs the model's code with OMP's facade as `browser`, keeps its top-level names between runs, and turns what it prints and returns into a `RunResult`.
 * One per worker. The tab realm's `tab.run` code runs in evaluators of its own.
 */
export class CodeCell {
  readonly #evaluator: CodeEvaluator;
  readonly #live = new Map<string, CellRun>();
  readonly #recentFiles = new Set<string>();
  readonly #uninstallGuard: (() => void) | undefined;
  #disposed = false;

  /**
   * `guardRejections`: take part in the process's `unhandledRejection` events so a promise the cell floated fails the run that owns it (OMP: "Unhandled rejection (missing await?)")
   * instead of taking the worker down. One a cell cannot claim is rethrown, as OMP does, so a worker with a real fault still dies.
   */
  constructor(options: { evaluator?: CodeEvaluator; guardRejections?: boolean } = {}) {
    this.#evaluator = options.evaluator ?? createCodeEvaluator();
    installFacade();
    this.#uninstallGuard = options.guardRejections ? this.#installGuard() : undefined;
  }

  #installGuard(): () => void {
    const onRejection = (reason: unknown): void => {
      if (this.consumeRejection(reason)) return;
      setTimeout(() => { throw reason; }, 0);
    };
    process.on("unhandledRejection", onRejection);
    return () => process.off("unhandledRejection", onRejection);
  }

  /** Whether `reason` is the cell's: a run floated it (kept for that run) or a finished cell did (only logged by the caller). False: not cell activity. */
  consumeRejection(reason: unknown): boolean {
    const stack = reason instanceof Error && typeof reason.stack === "string" ? reason.stack : undefined;
    if (stack !== undefined) {
      // The stack can name several cells (a helper an earlier cell defined, called from the live one): the outermost frame owns the promise.
      let owner: CellRun | undefined;
      let ownerIndex = -1;
      for (const run of this.#live.values()) {
        const index = stack.lastIndexOf(run.filename);
        if (index > ownerIndex) {
          ownerIndex = index;
          owner = run;
        }
      }
      if (owner) {
        owner.floating.push(reason);
        return true;
      }
      for (const filename of this.#recentFiles) if (stack.includes(filename)) return true;
    }
    // A reason with no usable stack (`Promise.reject("msg")`) during the only live run is still that run's activity: nothing else runs user code in this realm.
    const only = this.#live.size === 1 ? this.#live.values().next().value : undefined;
    if (only && stack === undefined) {
      only.floating.push(reason);
      return true;
    }
    return false;
  }

  async run(o: CellRunOptions): Promise<RunResult> {
    if (this.#disposed) throw new ToolError("The code realm is closed");
    const output = new CellOutput();
    const filename = `browser-cell-${o.runId}.js`;
    // One signal for everything the run starts. Its reason is either the budget's CellTimeoutError (the model is told the budget ran out) or OMP's ToolAbortError (an MCP cancel arrives as a DOMException).
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(new CellTimeoutError(o.timeoutMs)), o.timeoutMs);
    const onCancel = (): void => budget.abort(o.signal.reason instanceof ToolAbortError ? o.signal.reason : new ToolAbortError(undefined, { cause: o.signal.reason }));
    if (o.signal.aborted) onCancel();
    else o.signal.addEventListener("abort", onCancel, { once: true });
    const signal = budget.signal;
    const run: CellRun = {
      runId: o.runId, filename, signal, invoke: o.invoke, screenshots: [], floating: [], ended: false,
      hooks: { onText: () => {}, onDisplay: () => {} },
    };
    const live = output.hooks(chunk => o.onText?.(chunk));
    // A run that was raced out (timeout, cancel) may still print later; that is nobody's output.
    run.hooks = { onText: chunk => { if (!run.ended) live.onText(chunk); }, onDisplay: display => { if (!run.ended) live.onDisplay(display); } };
    this.#live.set(o.runId, run);

    const abandoned = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    // Whichever loses the race must not become an unhandled rejection of its own.
    abandoned.catch(() => {});
    let failure: unknown;
    let failed = false;
    try {
      const evaluated = callerRun.run(run, () => this.#evaluator.evaluate(o.code, { filename, scope: {}, hooks: run.hooks }));
      evaluated.catch(() => {});
      const value = await Promise.race([evaluated, abandoned]);
      displayValue(value, run.hooks);
      // One turn of the event loop so rejections the cell already floated surface while this run still owns them.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      if (run.floating.length > 0) {
        const [first, ...rest] = run.floating;
        for (const reason of rest) {
          const detail = failureOf(reason);
          run.hooks.onText(`[unhandled rejection] ${detail.name}: ${detail.message}\n`);
        }
        const detail = failureOf(first);
        throw Object.assign(new Error(`Unhandled rejection (missing await?): ${detail.message}`), { name: detail.name });
      }
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      clearTimeout(timer);
      o.signal.removeEventListener("abort", onCancel);
      this.#live.delete(o.runId);
      this.#recentFiles.add(filename);
      if (this.#recentFiles.size > RECENT_CELL_FILES_MAX) this.#recentFiles.delete(this.#recentFiles.values().next().value as string);
    }
    // The output is read BEFORE the run is marked ended, so everything it printed is in it.
    const { text, images } = output.finish();
    run.ended = true;
    const result: RunResult = {
      displays: [...images, ...(text.length > 0 ? [{ type: "text" as const, text }] : [])],
      screenshots: run.screenshots,
    };
    if (failed) throw new CellFailure(failureOf(failure), result);
    return result;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#uninstallGuard?.();
    uninstallFacade();
  }
}
