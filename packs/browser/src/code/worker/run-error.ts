// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/tab-worker.ts (RequestInterceptionCleanupError) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack (matrix D3, D32): OMP's `errorPayload` flagged `recoverTab` in the worker's reply; here the error carries the flag itself and the cell's failure mapper reads it,
// so the host rebuilds the worker (the page and the browser survive).

import { ToolError } from "../errors";

/** The page's request interception could not be cleared after a run: the tab's state is no longer trustworthy and the worker must be recycled. */
export class RequestInterceptionCleanupError extends ToolError {
  readonly recoverTab = true;
}
