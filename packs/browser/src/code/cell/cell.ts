// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/eval/js/worker-core.ts (the run path, the floating-rejection guard) and
// packages/coding-agent/src/eval/js/executor.ts (the timeout annotation) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: one cell per worker and one facade (OMP's prelude.js, verbatim) whose two hooks, `__omp_prelude__` and `__omp_display__`, route by async context to the run that
// called them; the bridge is a function the worker core gives each run; the eval tool's output sink is `CellOutput`; no cwd, tool bridge or handle machinery.

import { AsyncLocalStorage } from "node:async_hooks";
import type { BridgeResponse, CodeEvaluator, EvaluatorHooks, RunError, RunResult, ScreenshotResult } from "../contracts.js";
import { ToolAbortError, ToolError, throwIfAborted } from "../errors.js";
import facadeSource from "../facade/prelude.js.txt";
import extensionsSource from "../facade/pack-extensions.js.txt";
import { CellOutput, displayValue } from "./display.js";
import { ERROR_LINE_BYTES } from "./output-sink.js";
import { createCodeEvaluator } from "./evaluator.js";

/** What a cell's `browser.*` call becomes: the dispatcher validates the parameters and answers with the text the facade prints. */
export type CellInvoke = (parameters: unknown, o: { runId: string; signal: AbortSignal }) => Promise<BridgeResponse>;

export interface CellRunOptions {
  runId: string;
  code: string;
  /** The cell's own budget. Past it the run fails with OMP's timeout text and every operation it started is aborted. */
  timeoutMs: number;
  /**
   * The caller's cancellation (an MCP request that was cancelled, a take-over). A cancel that arrives while the cell is running fails the run as a `ToolAbortError` that asks for a new worker, like a timeout does:
   * OMP force-kills its JS worker on ANY abort (eval/js/context-manager.ts:430-448), because the cancelled code may be a loop that catches the abort or never yields. A signal that is already aborted runs nothing.
   */
  signal: AbortSignal;
  invoke: CellInvoke;
  /** Progress: the text the cell prints, at most one chunk of 16 KiB every 100 ms (the sink bounds and throttles it, so a cell that floods costs the host a fixed rate). */
  onText?: (chunk: string) => void;
  /** The session's folder for the file holding the whole of an output longer than the inline budget; absent: no file is kept. */
  spillDir?: string;
}

/** OMP's sentence for what ending the worker does (eval/js/executor.ts:70-78). Said wherever the cell realm asks for a new worker, so the model does not refer to variables that are gone. */
export const WORKER_RESET_NOTE = "The JS worker was force-killed and its VM state was reset; variables from earlier cells are gone.";

/**
 * The cell's budget ran out. Not a cancellation: the model is told, with the output it had by then. OMP's text, as OMP says it (eval/js/executor.ts:70-78): the worker is force-killed at the
 * budget because that is the only way to stop user code, and the state is gone. Here the host does the killing, on `recoverTab`; this realm only asks for it.
 */
export class CellTimeoutError extends Error {
  readonly recoverTab = true;
  readonly budget = true;

  constructor(timeoutMs: number) {
    super(`Command timed out after ${Math.max(1, Math.round(timeoutMs / 1000))} seconds. ${WORKER_RESET_NOTE}`);
    this.name = "CellTimeoutError";
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
  // The facade is a block statement that assigns `globalThis.browser`; an indirect eval runs it in global scope. The pack's two additions wrap what it made.
  const geval = globalThis.eval as (source: string) => unknown;
  geval(facadeSource);
  geval(extensionsSource);
}

function uninstallFacade(): void {
  if (--facadeUsers > 0) return;
  for (const key of GLOBAL_KEYS) delete (globalThis as Record<string, unknown>)[key];
}

/** A thrown value as the host gets it: `name` and `message` kept, `isAbort` for cancellation, `recoverTab` (and `resetNoted`) when the realm marked the failure as one that needs a fresh worker. */
export function failureOf(error: unknown): RunError {
  if (error instanceof Error) {
    const recoverTab = (error as Error & { recoverTab?: unknown }).recoverTab === true;
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      isAbort: error.name === "AbortError" || error.name === "ToolAbortError",
      ...(recoverTab ? { recoverTab } : {}),
      ...(error instanceof CellTimeoutError ? { budget: true, resetNoted: true } : {}),
    };
  }
  return { name: "Error", message: String(error), isAbort: false };
}

/** The failure of a run the realm gave up on while its code was still running (a cancel): the worker is to be rebuilt, and the message says so. A timeout's already does. */
function abandonedFailure(error: RunError): RunError {
  if (error.resetNoted === true) return error;
  return { ...error, message: `${error.message.replace(/\.?$/, ".")} ${WORKER_RESET_NOTE}`, recoverTab: true, resetNoted: true };
}

/** What the budget or a cancel puts into the race with the cell's code: the reason, wrapped, so a failure that came out of the race is told from one the cell's own code threw. */
class Abandoned {
  constructor(readonly reason: unknown) {}
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
    const output = new CellOutput({ ...(o.spillDir === undefined ? {} : { spillDir: o.spillDir }), ...(o.onText === undefined ? {} : { onText: o.onText }) });
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
    const live = output.hooks();
    // A run that was raced out (timeout, cancel) may still print later; that is nobody's output.
    run.hooks = { onText: chunk => { if (!run.ended) live.onText(chunk); }, onDisplay: display => { if (!run.ended) live.onDisplay(display); } };
    this.#live.set(o.runId, run);

    // The race the cell's own code loses when the budget runs out or the caller cancels. What wins it is wrapped, so a failure that came out of the race is told from one the cell's code threw.
    const abandoned = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Abandoned(signal.reason));
      else signal.addEventListener("abort", () => reject(new Abandoned(signal.reason)), { once: true });
    });
    // Whichever loses the race must not become an unhandled rejection of its own.
    abandoned.catch(() => {});
    let failure: unknown;
    let failed = false;
    // The run was given up on while its code was still running: that code goes on in this worker, so the worker has to be replaced.
    let gaveUp = false;
    try {
      // A run cancelled before it began has started nothing: no code runs, and there is nothing to replace.
      throwIfAborted(signal);
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
      if (error instanceof Abandoned) {
        gaveUp = true;
        failure = error.reason;
      } else {
        failure = error;
      }
    } finally {
      clearTimeout(timer);
      o.signal.removeEventListener("abort", onCancel);
      this.#live.delete(o.runId);
      this.#recentFiles.add(filename);
      if (this.#recentFiles.size > RECENT_CELL_FILES_MAX) this.#recentFiles.delete(this.#recentFiles.values().next().value as string);
    }
    // The output is read BEFORE the run is marked ended, so everything it printed is in it.
    // A failed cell leaves room in the budget for the error line the tool appends to its text.
    const { text, images } = output.finish(failed ? ERROR_LINE_BYTES : 0);
    run.ended = true;
    const result: RunResult = {
      displays: [...images, ...(text.length > 0 ? [{ type: "text" as const, text }] : [])],
      screenshots: run.screenshots,
    };
    if (failed) {
      const error = failureOf(failure);
      throw new CellFailure(gaveUp ? abandonedFailure(error) : error, result);
    }
    return result;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#uninstallGuard?.();
    uninstallFacade();
  }
}
