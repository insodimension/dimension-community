// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/tab-worker.ts (selector constants, normalizeSelector) and tools/browser/aria/aria-snapshot.ts (assertSelectorString, parseAriaRefSelector) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: ToolError comes from ../errors; the two aria-ref selector guards live here beside the other selector rules instead of in the ARIA snapshot file.

import { ToolError } from "../errors";

const LEGACY_SELECTOR_PREFIXES = ["p-aria/", "p-text/", "p-xpath/", "p-pierce/"] as const;

const SELECTOR_HANDLER_PREFIXES = [
	"aria/",
	"text/",
	"xpath/",
	"pierce/",
	"aria-ref=",
	"aria-ref/",
	"ariaref/",
	"p-",
] as const;

/**
 * Playwright-only selector engines/pseudos puppeteer cannot parse. Without this guard a
 * `tab.click(":has-text(...)")` would wait the full action timeout and fail opaquely;
 * fail fast instead with a pointer to the puppeteer-native alternative. Skipped for
 * explicit query-handler prefixes (`text/`, `aria/`, …) whose payload is literal text.
 */
const PLAYWRIGHT_ONLY_SELECTOR_RE =
	/:has-text\(|:text\(|:text-is\(|:text-matches\(|:visible\b|:hidden\b|:nth-match\(|:near\(|:above\(|:below\(|:right-of\(|:left-of\(/;

const ARIA_REF_PREFIXES = ["aria-ref=", "aria-ref/", "ariaref/"];

/**
 * Guard the selector funnels: `tab.click`/`type`/`fill`/`waitFor*`/`scrollIntoView`
 * take string selectors only, but user `run` code routinely passes the ElementHandle
 * from `tab.id(n)`/`tab.ref(...)` (or an un-awaited Promise of one) straight in.
 * Without this the value reaches `.trim()`/`.startsWith()` and throws the opaque,
 * minified `A.trim is not a function` instead of a recovery-naming ToolError.
 */
export function assertSelectorString(selector: unknown): asserts selector is string {
	if (typeof selector === "string") return;
	let kind: string;
	if (selector !== null && typeof selector === "object") {
		kind =
			"then" in selector && typeof selector.then === "function" ? "a Promise (missing await?)" : "an ElementHandle";
	} else {
		kind = `a ${typeof selector}`;
	}
	throw new ToolError(
		`Browser selector must be a string; got ${kind}. ` +
			"tab.click/type/fill/waitFor take string selectors only — " +
			'call the handle method directly (e.g. (await tab.id(n)).click()) or pass a string like "aria-ref=eN".',
	);
}

/**
 * Recognize a snapshot-ref selector and return the bare ref id, else null.
 * Accepts `aria-ref=e5` (Playwright-MCP style), `aria-ref/e5`, `ariaref/e5`,
 * and bare `e5`/`@e5`: agents copy ids straight out of the snapshot YAML
 * (`[ref=e5]`), so `tab.click("e5")` must act on the ref instead of falling
 * through to a CSS tag selector that can never match. Bare ids are safe to
 * claim here — an eN tag name is not real HTML, and the tab-worker backend's
 * observe ids are numeric (`tab.id(7)`), so refs are its only eN namespace.
 * (The cmux backend parses selectors itself and routes bare `eN` to its own
 * observe ids; either way `eN` means "the id from the last page dump".)
 */
export function parseAriaRefSelector(selector: string): string | null {
	assertSelectorString(selector);
	const trimmed = selector.trim();
	for (const prefix of ARIA_REF_PREFIXES) {
		if (trimmed.startsWith(prefix)) {
			const id = trimmed.slice(prefix.length).trim();
			return /^e\d+$/.test(id) ? id : null;
		}
	}
	const bare = /^@?(e\d+)$/.exec(trimmed);
	return bare ? bare[1]! : null;
}

export function normalizeSelector(selector: string): string {
	assertSelectorString(selector);
	if (!selector) return selector;
	if (
		!SELECTOR_HANDLER_PREFIXES.some(prefix => selector.startsWith(prefix)) &&
		PLAYWRIGHT_ONLY_SELECTOR_RE.test(selector)
	) {
		throw new ToolError(
			`Playwright-only selector ${JSON.stringify(selector)} is not supported by the browser tool. ` +
				`Use a puppeteer text selector ("text/Allow all"), an aria selector ("aria/Name"), CSS, or "xpath/...".`,
		);
	}
	if (selector.startsWith("p-") && !LEGACY_SELECTOR_PREFIXES.some(prefix => selector.startsWith(prefix))) {
		throw new ToolError(
			`Unsupported selector prefix. Use CSS or puppeteer query handlers (aria/, text/, xpath/, pierce/). Got: ${selector}`,
		);
	}
	if (selector.startsWith("p-text/")) return `text/${selector.slice("p-text/".length)}`;
	if (selector.startsWith("p-xpath/")) return `xpath/${selector.slice("p-xpath/".length)}`;
	if (selector.startsWith("p-pierce/")) return `pierce/${selector.slice("p-pierce/".length)}`;
	if (selector.startsWith("p-aria/")) {
		const rest = selector.slice("p-aria/".length);
		const nameMatch = rest.match(/\[\s*name\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\]]+))\s*\]/);
		const name = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3];
		if (name) return `aria/${name.trim()}`;
		return `aria/${rest}`;
	}
	return selector;
}
