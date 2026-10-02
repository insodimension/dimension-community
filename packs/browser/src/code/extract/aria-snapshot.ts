// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/aria/aria-snapshot.ts @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// The bundle next to this file is Playwright's injected ARIA-snapshot code (Apache-2.0, (c) Microsoft, v1.61.0), copied verbatim: see ../../../third-party/playwright/LICENSE.
// Changed for the Browser pack: the two selector guards (assertSelectorString, parseAriaRefSelector) live in ../worker/selectors.ts with the other selector rules; the two page-side
// evaluators are built on first use instead of at import, so a worker that never takes a snapshot never parses the 40 KB bundle.

import type { ElementHandle, JSHandle, Page } from "puppeteer-core";
import ariaBundle from "./aria-snapshot.bundle.txt";

export interface AriaSnapshotOptions {
  /** Maximum tree depth to render. */
  depth?: number;
  /** Append `[box=x,y,w,h]` bounding boxes to each node. */
  boxes?: boolean;
}

/**
 * Page-side evaluators built here in the worker, never inside the page, so page CSP never applies. They run Playwright's ARIA-snapshot
 * bundle (CJS) in a throwaway module scope.
 *
 * Puppeteer serializes these functions to a CDP `Runtime.evaluate` in the page's MAIN world (the only world where the bundle's `_ariaRef`
 * ref expandos live: isolated-world locators and query handlers cannot see them). Nothing is installed on `window`; the only footprint is
 * the `_ariaRef` markers the snapshot writes, which are the price of actionable `[ref=eN]` ids.
 */
function buildEvaluator(params: string, call: string): (...args: unknown[]) => unknown {
  return new Function(
    ...params.split(",").map(p => p.trim()),
    `var module = { exports: {} };\n${ariaBundle}\nreturn module.exports.${call};`,
  ) as unknown as (...args: unknown[]) => unknown;
}

// Handles (root) must stay top-level args: Puppeteer only unwraps JSHandles passed positionally to page.evaluate, never ones nested inside an object.
let evaluateAriaSnapshot: ((...args: unknown[]) => unknown) | undefined;
let evaluateResolveRef: ((...args: unknown[]) => unknown) | undefined;

/**
 * Capture a Playwright-format ARIA snapshot of `root` (or the whole document when null). Always runs in `ai` mode so every node carries a
 * `[ref=eN]` id; resolve those to elements with {@link resolveAriaRefHandle}. Ids are renumbered from e1 on each call and remain valid
 * until the next snapshot.
 */
export async function captureAriaSnapshot(
  page: Page,
  root: ElementHandle | null,
  options: AriaSnapshotOptions = {},
): Promise<string> {
  const request = { depth: options.depth, boxes: options.boxes };
  evaluateAriaSnapshot ??= buildEvaluator("root, request", "ariaSnapshot(root, request)");
  return (await page.evaluate(evaluateAriaSnapshot as never, root as never, request as never)) as string;
}

/**
 * Resolve a `[ref=eN]` id from the latest snapshot to a live `ElementHandle`, or null when the ref no longer matches any element. Runs in
 * the main world so it sees the `_ariaRef` expandos the snapshot wrote.
 */
export async function resolveAriaRefHandle(page: Page, ref: string): Promise<ElementHandle | null> {
  evaluateResolveRef ??= buildEvaluator("ref", "resolveAriaRef(ref)");
  const handle = (await page.evaluateHandle(evaluateResolveRef as never, ref as never)) as JSHandle;
  const element = handle.asElement();
  if (!element) {
    await handle.dispose().catch(() => undefined);
    return null;
  }
  return element as ElementHandle;
}

/**
 * Build a self-contained expression script that runs the bundle in the page and returns the ARIA snapshot YAML. Used by the cmux backend,
 * whose `browser.eval` RPC takes a script string and returns the completion value (it has no ElementHandle to pass in). The script resolves
 * `selector` via `document.querySelector` in-page (CSS selectors only) or falls back to the whole document. Like the puppeteer path it
 * installs nothing on `window`.
 */
export function buildAriaSnapshotScript(selector: string | undefined, options: AriaSnapshotOptions = {}): string {
  const request = { depth: options.depth, boxes: options.boxes };
  const sel = selector ? JSON.stringify(selector) : "null";
  return `(function(){var module={exports:{}};\n${ariaBundle}\nvar __sel=${sel};var __root=__sel?document.querySelector(__sel):null;if(__sel&&!__root)throw new Error("tab.ariaSnapshot: selector "+__sel+" matched no element");return module.exports.ariaSnapshot(__root,${JSON.stringify(request)});})()`;
}
