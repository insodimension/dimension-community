// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/utils/src/turndown.ts @ be1cfdab27 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../../third-party/omp/LICENSE.
// Changed for the Browser pack: the entry file lives in turndown/ beside its modules (import paths only).

/** Behavior-compatible reimplementation of turndown's used surface. */

export * from "./gfm";
export { default, default as TurndownService } from "./service";
export * from "./types";
