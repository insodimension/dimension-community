// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/tab-worker.ts (RequestInterceptionCleanupError, errorPayload) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack (matrix D3, D32): `errorPayload` becomes `toRunError`, producing the contract's RunError (OMP's `isToolError` flag is not part of it: the cell sees a ToolError's name and message).

import type { RunError } from "../contracts";
import { ToolAbortError, ToolError } from "../errors";

/** The page's request interception could not be cleared after a run: the tab's state is no longer trustworthy and the worker must be recycled. */
export class RequestInterceptionCleanupError extends ToolError {}

/** An error as the cell and the host see it: its name and message intact, `isAbort` for a cancellation, `recoverTab` when the worker must be rebuilt. */
export function toRunError(error: unknown): RunError {
  if (error instanceof ToolAbortError) {
    return { name: error.name, message: error.message, stack: error.stack, isAbort: true };
  }
  if (error instanceof RequestInterceptionCleanupError) {
    return { name: error.name, message: error.message, stack: error.stack, isAbort: false, recoverTab: true };
  }
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack, isAbort: false };
  return { name: "Error", message: String(error), isAbort: false };
}
