// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/tool-errors.ts @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../third-party/omp/LICENSE.
// Changed for the Browser pack: the `omp.agentFacingError` marker is dropped (it exists for OMP's postmortem fatal handler, which the pack does not have); `markRejectionHandled` and `isRejectionHandled` are
// the pack's own, the one fact the tab realm's and the cell's `unhandledRejection` guards (both live in the worker process) share.

/**
 * The error types the browser code realm throws into a cell, as OMP names them (matrix rows C9, D8, D9, D16, D22).
 * A `ToolError` is a message written for the model; a `ToolAbortError` is a cancellation.
 */

/** Base error for tool execution failures. Its message is the model-facing text. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
  }

  /** The text shown to the model. */
  render(): string {
    return this.message;
  }
}

/** Thrown when an operation is aborted through an AbortSignal. */
export class ToolAbortError extends Error {
  static readonly MESSAGE = "Operation aborted";

  constructor(message: string = ToolAbortError.MESSAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolAbortError";
  }
}

/** Throw a `ToolAbortError` if the signal is aborted, keeping a `ToolAbortError` reason as it is. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : undefined;
    throw reason instanceof ToolAbortError ? reason : new ToolAbortError(undefined, { cause: signal.reason });
  }
}

/** Render an error for the model. */
export function renderError(e: unknown): string {
  if (e instanceof ToolError) return e.render();
  if (e instanceof Error) return e.message;
  return String(e);
}

const settledRejections = new WeakSet<object>();

/**
 * The tab realm's guard settled `reason` (a run owns it, or it is fallout of a deliberate cleanup). Node calls every `unhandledRejection` listener, so the others in this process (the cell's) must be able to
 * tell, or one of them rethrows what another already handled and the worker, with every tab's variables, ends. A primitive reason cannot be marked, and is never settled this way.
 */
export function markRejectionHandled(reason: unknown): void {
  if (reason !== null && (typeof reason === "object" || typeof reason === "function")) settledRejections.add(reason);
}

/** Whether {@link markRejectionHandled} was called for `reason`. Safe to ask on a later turn: the mark is made in the same event dispatch the other listeners run in. */
export function isRejectionHandled(reason: unknown): boolean {
  return reason !== null && (typeof reason === "object" || typeof reason === "function") && settledRejections.has(reason);
}
