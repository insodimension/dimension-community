// Partly copied from OMP (https://github.com/can1357/oh-my-pi, MIT): the page picker at the end of this file is packages/coding-agent/src/tools/browser/attach.ts:8-9 and :226-298 (pickElectronTarget and its helpers) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../third-party/omp/LICENSE.
// Changed for the Browser pack: the picker changes only its error class (the pack's ToolError); the connection above it generalises the pack's own `attachRelay`.

/**
 * The `attach` engine's connection: how the pack reaches a Chrome that someone else started and still owns. It generalises what the
 * `chrome-relay` engine did alone (one `puppeteer.connect` on an HTTP discovery URL): the same connection now serves three kinds of browser
 * a cell may ask for (doc 77 §7.4.6) — `relay` (the user's own Chrome through the pack's extension relay), `connected` (any Chrome with a
 * debugging port, given by URL) and `spawned` (an application the pack started, or found already running, with a debugging port).
 *
 * What these have in common is the rule: the pack never closes the browser. Closing disconnects; the one exception is a `spawned`
 * application the pack started, which `kill` ends (the cell's `kill: true`); one that was already running is left running. The kinds module
 * (`code/kinds/establish.ts`) decides WHICH endpoint and waits for it; this module only connects to what it was given.
 */
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ToolError } from "../code/errors.js";
import { fail } from "../store.js";

/** Per-CDP-message timeout of every puppeteer launch or connect (OMP `BROWSER_PROTOCOL_TIMEOUT_MS`): above a cell's own budget, so only a genuinely stuck socket trips it. */
export const BROWSER_PROTOCOL_TIMEOUT_MS = 60_000;

/** Where the pack's relay (and OMP's) serves unless told otherwise. */
export const DEFAULT_RELAY_URL = "http://127.0.0.1:9224";

export type AttachKindTag = "connected" | "relay" | "spawned";

/** A browser to attach to instead of launching one. `cdpUrl` already answered `/json/version` with 200 when this was made. */
export interface AttachTarget {
	kind: AttachKindTag;
	/** The HTTP DevTools discovery endpoint (`http://host:port`, no trailing slash). */
	cdpUrl: string;
	/** What `Opened tab "main" on <label>` says: `relay http://127.0.0.1:9224`, `connected http://127.0.0.1:9222`, `spawned C:\\x\\app.exe (pid 123)`. */
	label: string;
	/** `spawned` only: the application's process. */
	pid?: number;
	/**
	 * `spawned` only, and only for an application THIS open started (one that was already running has none: it is not the pack's to end): ends the application's whole process tree. Closing the browser never calls it;
	 * `close({ kill: true })` does, and so does a failed or abandoned open that started the application (nothing else holds it then).
	 */
	terminate?: () => Promise<void>;
}

/** The target of the `chrome-relay` engine, which expects someone else to serve the relay at `url`. */
export function relayTarget(url: string = DEFAULT_RELAY_URL): AttachTarget {
	return { kind: "relay", cdpUrl: url, label: `relay ${url}` };
}

function reason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Connect to `target`. Rejects with the pack's own refusal rather than puppeteer's raw one, each saying what to do next. The caller owns the
 * returned connection and must `disconnect()` it (never `close()`: that would end the browser).
 */
export async function connectAttached(target: AttachTarget): Promise<Browser> {
	try {
		return await puppeteer.connect({ browserURL: target.cdpUrl, defaultViewport: null, protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS });
	} catch (error) {
		if (target.kind === "relay") {
			return fail(
				"relay_unavailable",
				`could not attach to chrome-relay at ${target.cdpUrl}: ${reason(error)}. ` +
					`Start the chrome-relay (the relay app/extension that exposes this endpoint), or point relayUrl at the endpoint it is actually listening on.`,
			);
		}
		return fail("attach_failed", `Connected to ${target.cdpUrl} but puppeteer.connect failed: ${reason(error)}`);
	}
}

// ---------------------------------------------------------------------------
// Which page of an attached browser a cell drives
// ---------------------------------------------------------------------------

// Everything from here to the end of the file is OMP's page picker (see the notice at the top of the file).
const ATTACH_TARGET_SKIP_PATTERN = /request[\s_-]?handler|devtools|background[\s_-]?(?:page|host)|service[\s_-]?worker/i;

/** A browser the user is driving keeps its focus: with no `app.target`, the page a cell adopts is the visible one and is not raised for screenshots. */
export function shouldPreserveConnectedBrowserFocus(target?: string): boolean {
	return !target;
}

/**
 * Pick the best page of an attached browser. Discoverable page targets come first, so Chromium and Edge attach flows that hide pages from
 * `browser.pages()` still give a usable tab. `preferVisible` is for a browser a human is using: among equally usable tabs, take the one that is
 * actually in front rather than whichever CDP enumerates first.
 */
export async function pickAttachedPage(browser: Browser, options: { matcher?: string; preferVisible?: boolean } = {}): Promise<Page> {
	const discovered = await Promise.all(
		browser.targets().map(async (target) => {
			if (String(target.type()) !== "page") return null;
			return await target.page().catch(() => null);
		}),
	);
	const usable = discovered.filter((page): page is Page => page !== null);
	if (usable.length > 0) return await pickPageFromList(usable, options);
	const fallback = await browser.pages();
	if (!fallback.length) throw new ToolError("No page targets available on the attached browser");
	return await pickPageFromList(fallback, options);
}

async function enrichPages(pages: Page[]): Promise<Array<{ page: Page; url: string; title: string }>> {
	return await Promise.all(pages.map(async (page) => ({ page, url: page.url(), title: ((await page.title().catch(() => "")) ?? "").trim() })));
}

async function pickPageFromList(pages: Page[], options: { matcher?: string; preferVisible?: boolean }): Promise<Page> {
	const enriched = await enrichPages(pages);
	if (options.matcher) {
		const needle = options.matcher.toLowerCase();
		const hit = enriched.find((p) => p.url.toLowerCase().includes(needle) || p.title.toLowerCase().includes(needle));
		if (hit) return hit.page;
		const summary = enriched.map((p) => `- ${p.title || "(untitled)"}  ${p.url}`).join("\n");
		throw new ToolError(`No page target matched ${JSON.stringify(options.matcher)}. Available pages:\n${summary}`);
	}
	const usable = enriched.filter((p) => !ATTACH_TARGET_SKIP_PATTERN.test(p.url) && !ATTACH_TARGET_SKIP_PATTERN.test(p.title));
	if (options.preferVisible && usable.length > 1) {
		// Best-effort foreground probe; a tab that cannot answer counts as hidden.
		const visibility = await Promise.all(
			usable.map(async (p) => {
				try {
					return (await p.page.evaluate(() => document.visibilityState === "visible")) === true;
				} catch {
					return false;
				}
			}),
		);
		const foreground = visibility.indexOf(true);
		if (foreground >= 0) return usable[foreground]!.page;
	}
	return (usable[0]?.page ?? enriched[0]!.page) as Page;
}
