/**
 * Puppeteer engine driver — the `chromium` and `chrome-relay` engines.
 *
 * What lives here: launching / attaching and the ownership rules that go with
 * each, the tabs this browser owns, the document identity frames and
 * annotations are pinned to, the live screencast, and one native dispatch per
 * action. Frame storage, cropping and validation live in the runtime.
 *
 * Ownership rules, restated because they are the whole safety story:
 *  - `chromium` owns the Chrome it launched AND the persistent profile
 *    directory behind it — every page in it is one of our tabs. `onClosed`
 *    (the profile-lock release) is called only once that process is CONFIRMED
 *    gone — a timed-out or unconfirmed shutdown keeps the lock, because a lock
 *    claiming "free" while a Chrome may still be writing the user-data dir is
 *    how one profile ends up with two Chromes.
 *  - `chrome-relay` owns NOTHING of the human's browser except the tabs it
 *    opened and the pages those tabs open (task agents are refused on the
 *    relay). It never adopts a tab the human is looking at and never closes the
 *    browser — only its own tabs, then disconnects. For the relay the leased
 *    resource is the attachment itself, so a confirmed disconnect IS a
 *    confirmed release.
 *
 * browser_read's reader (`launchReader`) is separate from both: a headless
 * Chrome with no profile of ours (a throwaway user-data dir), one incognito
 * context per read, one tab, popups blocked, downloads denied, and every
 * request screened by the read policy before it is sent.
 *
 * Every page script executed here is a fixed compiled function from
 * `page-scripts.ts`. Caller-supplied JavaScript never reaches `evaluate`.
 */
import { mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer, { TimeoutError } from "puppeteer-core";
import type { Browser, BrowserContext, CDPSession, ElementHandle, HTTPRequest, HTTPResponse, KeyInput, Page, Protocol, Target } from "puppeteer-core";
import type { BrowserAction, BrowserRegion, TabInfo, Viewport } from "../contracts.js";
import { FaviconCache } from "../favicon.js";
import { MAX_FRAME_BYTES } from "../image.js";
import { ActionNotDispatched, fail } from "../store.js";
import {
	ELEMENTS_IN_REGION_SCRIPT,
	FAVICON_HREF_SCRIPT,
	IS_PASSWORD_SCRIPT,
	LINK_HREFS_SCRIPT,
	PAGE_TEXT_SCRIPT,
	READ_FIELD_SCRIPT,
	READ_PAGE_SCRIPT,
	SELECT_ALL_SCRIPT,
	TYPE_TARGET_SCRIPT,
} from "./page-scripts.js";
import type { EngineDriver, EngineOptions, EngineState, FieldRead, LiveFrame, PageRead, PageReader, ReadOutcome, ReadPolicy } from "./types.js";

const NAVIGATE_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
const LAUNCH_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 15_000;
const FAVICON_SCRIPT_TIMEOUT_MS = 2_000;
/** How long a freshly started screencast gets to deliver its first frame before one is captured. */
const FIRST_FRAME_WAIT_MS = 500;
const SCREENCAST_QUALITY = 80;
const DEFAULT_RELAY_URL = "http://127.0.0.1:9224";

/** One process-wide cache: an origin's icon is the same whichever browser shows it. */
const FAVICONS = new FaviconCache();

/**
 * Launch flags for the profile we own. Beyond the usual first-run noise these
 * switch OFF everything that would phone home from an agent's browser:
 * background networking (component updates, variations/field trials, the
 * safebrowsing list fetch), profile sync, crash upload, domain reliability
 * beacons, link pings and Chrome's bundled default apps / component extensions
 * with background pages. `--metrics-recording-only` keeps UMA local and
 * upload-free. User-installed extensions in this profile are NOT disabled;
 * only Chrome's own default payload is.
 */
const CHROMIUM_ARGS = [
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-features=Translate,OptimizationHints,MediaRouter,InterestFeedContentSuggestions",
	"--disable-background-networking",
	"--disable-component-update",
	"--disable-sync",
	"--disable-domain-reliability",
	"--disable-breakpad",
	"--disable-crash-reporter",
	"--disable-client-side-phishing-detection",
	"--disable-default-apps",
	"--disable-component-extensions-with-background-pages",
	"--metrics-recording-only",
	"--no-pings",
];

export type PuppeteerEngine = "chromium" | "chrome-relay";

/**
 * Build a driver for one of the two Chrome-backed engines.
 *
 * Rejects rather than returning a degraded driver: there is no fallback engine
 * and no half-open browser. On every rejection path the profile lease is either
 * released (nothing is running, or shutdown was confirmed) or deliberately
 * retained with an explanatory error — never released on a guess.
 */
export async function createPuppeteerDriver(engine: PuppeteerEngine, options: EngineOptions): Promise<EngineDriver> {
	let released = false;
	/** Idempotent: several confirmations of the same shutdown may race. */
	const release = (): void => {
		if (released) return;
		released = true;
		options.onClosed();
	};

	if (engine === "chrome-relay") return await attachRelay(options, release);
	return await launchChromium(options, release);
}

/**
 * Attach to the human's already-running Chrome and open OUR OWN blank tab.
 *
 * The tab the human is looking at is never adopted, inspected or navigated —
 * `newPage()` is where every tab this driver owns begins.
 */
async function attachRelay(options: EngineOptions, release: () => void): Promise<EngineDriver> {
	const browserURL = options.relayUrl ?? DEFAULT_RELAY_URL;
	let browser: Browser | undefined;
	let page: Page | undefined;
	try {
		try {
			browser = await puppeteer.connect({ browserURL, defaultViewport: null });
		} catch (err) {
			fail(
				"relay_unavailable",
				`could not attach to chrome-relay at ${browserURL}: ${describe(err)}. ` +
					`Start the chrome-relay (the relay app/extension that exposes this endpoint), or point relayUrl at the endpoint it is actually listening on.`,
			);
		}
		page = await browser.newPage();
		const tab = await prepareTab(page, options.viewport);
		return new PuppeteerDriver({ browser, tabs: [tab], viewport: options.viewport, ownsBrowser: false, release });
	} catch (err) {
		// Roll back exactly what we created. Disconnecting ends the lease, which
		// is the only resource the relay engine holds — so the release here is
		// confirmed, not assumed. The human's browser is never closed.
		if (page && !page.isClosed()) await page.close().catch(() => undefined);
		if (browser) await browser.disconnect().catch(() => undefined);
		release();
		throw err;
	}
}

/** Launch Chrome on the persistent profile directory this driver owns. */
async function launchChromium(options: EngineOptions, release: () => void): Promise<EngineDriver> {
	const userDataDir = options.profileDirectory;
	let browser: Browser;
	try {
		mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
		browser = await puppeteer.launch({
			headless: options.headless ?? true,
			userDataDir,
			timeout: LAUNCH_TIMEOUT_MS,
			defaultViewport: null,
			// An explicit binary wins; otherwise the locally installed stable
			// Chrome channel. Nothing is downloaded at runtime.
			...(options.executablePath ? { executablePath: options.executablePath } : { channel: "chrome" as const }),
			args: CHROMIUM_ARGS,
		});
	} catch (err) {
		// Nothing of ours is running: puppeteer kills a partially started Chrome
		// before rejecting, so the profile directory has no live writer.
		release();
		throw err;
	}

	// Process-exit handling goes in the moment the launch succeeds, BEFORE any
	// further setup can fail: a Chrome that dies inside the setup window is a
	// confirmed release, and without this listener that confirmation is lost and
	// the profile stays locked forever.
	browser.process()?.once("exit", release);

	try {
		const pages = await browser.pages();
		if (pages.length === 0) pages.push(await browser.newPage());
		const tabs: Tab[] = [];
		for (const page of pages) tabs.push(await prepareTab(page, options.viewport));
		return new PuppeteerDriver({ browser, tabs, viewport: options.viewport, ownsBrowser: true, release });
	} catch (err) {
		try {
			// `browser.close()` resolves once the process is gone; only then is the
			// profile actually free.
			await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, "failed-launch cleanup");
			release();
		} catch (cleanupError) {
			if (hasExited(browser)) release();
			else {
				fail(
					"launch_cleanup_failed",
					`browser initialization failed (${describe(err)}), and shutdown is unconfirmed (${describe(cleanupError)}). ` +
						`The profile lease for ${userDataDir} is deliberately retained while that process may still be alive.`,
				);
			}
		}
		throw err;
	}
}

/**
 * While a cross-process navigation commits, the page's CDP session is briefly
 * detached ("Not attached to an active page", "Target closed" on the swapped
 * renderer). Reads have no effect, so they are retried across that window.
 */
const READ_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800];

// ---------------------------------------------------------------------------
// browser_read's reader
// ---------------------------------------------------------------------------

/** The reader's page size; nobody watches it, it only has to lay the page out like a desktop. */
const READER_VIEWPORT: Viewport = { width: 1_280, height: 800 };
/** Visible iframes the read script reports; enough for any page's challenge widget. */
const MAX_READ_FRAMES = 500;

/**
 * Launch browser_read's headless reader. It has NO profile: puppeteer gives it
 * a throwaway user-data dir, deleted on close, and every read runs in its own
 * incognito context besides. Chrome's popup blocker stays ON (puppeteer turns
 * it off by default), so a page's `window.open` or popunder never opens a tab
 * or sends a request.
 */
export async function launchReader(options: { executablePath?: string }): Promise<PageReader> {
	const browser = await puppeteer.launch({
		headless: true,
		timeout: LAUNCH_TIMEOUT_MS,
		defaultViewport: READER_VIEWPORT,
		...(options.executablePath ? { executablePath: options.executablePath } : { channel: "chrome" as const }),
		args: CHROMIUM_ARGS,
		ignoreDefaultArgs: ["--disable-popup-blocking"],
	});
	return new PuppeteerReader(browser);
}

class PuppeteerReader implements PageReader {
	readonly #browser: Browser;
	/** Set once closing starts, or when a read could not dispose of its context. */
	#spent = false;

	constructor(browser: Browser) {
		this.#browser = browser;
	}

	get usable(): boolean {
		return !this.#spent && this.#browser.connected;
	}

	async read(url: string, limit: number, timeoutMs: number, policy: ReadPolicy): Promise<ReadOutcome> {
		const context = await this.#browser.createBrowserContext();
		try {
			return await this.#readIn(context, url, limit, timeoutMs, policy);
		} finally {
			// A context that will not close may still hold a page and its cookies:
			// retire the whole browser rather than read beside it.
			await withTimeout(context.close(), CLOSE_TIMEOUT_MS, "reader context close").catch(() => {
				this.#spent = true;
			});
		}
	}

	async #readIn(context: BrowserContext, url: string, limit: number, timeoutMs: number, policy: ReadPolicy): Promise<ReadOutcome> {
		// Nothing a page serves is written to disk.
		const cdp = await this.#browser.target().createCDPSession();
		try {
			await cdp.send("Browser.setDownloadBehavior", { behavior: "deny", ...(context.id ? { browserContextId: context.id } : {}) });
		} finally {
			await cdp.detach().catch(() => undefined);
		}
		// One tab: any other page in the context (a popup the blocker let
		// through) is closed the moment it appears.
		let primary: Target | undefined;
		context.on("targetcreated", (target: Target) => {
			if (primary === undefined || target === primary || target.type() !== "page") return;
			void target.page().then((page) => page?.close()).catch(() => undefined);
		});
		const page = await context.newPage();
		primary = page.target();

		// Set from event handlers; the cast keeps TypeScript from narrowing it to `null` here.
		let refusal = null as { url: string; reason: string } | null;
		const isMainNavigation = (request: HTTPRequest): boolean => {
			const frame = request.frame();
			return request.isNavigationRequest() && frame !== null && frame.parentFrame() === null;
		};
		await page.setRequestInterception(true);
		page.on("request", (request) => {
			const target = request.url();
			const check = request.isNavigationRequest() ? policy.navigation(target) : policy.subresource(target);
			void check
				.then(async (reason) => {
					if (reason === null) return await request.continue();
					if (isMainNavigation(request)) refusal ??= { url: target, reason };
					await request.abort("blockedbyclient");
				})
				.catch(() => undefined);
		});
		// The address Chrome actually connected to: a DNS answer that changed
		// after the policy's lookup (rebinding) is refused here, before any text
		// is returned.
		page.on("response", (response) => {
			if (!isMainNavigation(response.request())) return;
			const ip = response.remoteAddress().ip;
			const reason = ip ? policy.connected(response.url(), ip) : null;
			if (reason !== null) refusal ??= { url: response.url(), reason };
		});

		let response: HTTPResponse | null;
		try {
			response = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
		} catch (err) {
			if (refusal) return { kind: "refused", ...refusal };
			if (err instanceof TimeoutError) return { kind: "timeout" };
			throw err;
		}
		const seen = await withTimeout(settledRead(page, limit), ACTION_TIMEOUT_MS, "read");
		// A script navigation after `load` that the policy refused still refuses the read.
		if (refusal) return { kind: "refused", ...refusal };
		return { kind: "read", page: { httpStatus: response?.status() ?? null, url: page.url(), ...seen } };
	}

	async close(): Promise<void> {
		this.#spent = true;
		try {
			await withTimeout(this.#browser.close(), CLOSE_TIMEOUT_MS, "reader close");
		} catch (err) {
			if (!hasExited(this.#browser)) fail("close_failed", `the reader browser did not shut down (${describe(err)})`);
		}
	}
}

/**
 * The read script, retried across a navigation's detach window: a redirect
 * right after `load` (a script sending the reader to a sign-in page) swaps the
 * document under it. Reading has no effect, so re-reading is safe.
 */
async function settledRead(page: Page, limit: number): Promise<Omit<PageRead, "httpStatus" | "url">> {
	for (const delay of READ_RETRY_DELAYS_MS) {
		try {
			return await page.evaluate(READ_PAGE_SCRIPT, limit, MAX_READ_FRAMES);
		} catch {
			await sleep(delay);
		}
	}
	return await page.evaluate(READ_PAGE_SCRIPT, limit, MAX_READ_FRAMES);
}

/**
 * One page tab. `cdp` is a private session on the tab's target. The main
 * frame's id — the target id — is the tab id. `documentId` is the main frame's
 * `loaderId`, fresh for every committed document (including a reload and a
 * same-URL navigation): read once from `Page.getFrameTree`, then kept current
 * by `Page.frameNavigated`, so reading it never waits on a renderer that is
 * mid-navigation.
 */
interface Tab {
	id: string;
	documentId: string;
	page: Page;
	target: Target;
	cdp: CDPSession;
	loading: boolean;
}

async function prepareTab(page: Page, viewport: Viewport, scale = 1): Promise<Tab> {
	await page.setViewport({ ...viewport, deviceScaleFactor: scale });
	const cdp = await page.createCDPSession();
	const tab: Tab = { id: "", documentId: "", page, target: page.target(), cdp, loading: false };
	// Subscribed before the first read: a commit racing setup is never missed.
	cdp.on("Page.frameNavigated", ({ frame }) => {
		if (frame.parentId === undefined) tab.documentId = frame.loaderId;
	});
	try {
		await cdp.send("Page.enable");
		// A tab behind another (the human's tab in the relay, a background tab)
		// is not rendered, and puppeteer's element clicks wait on rendering.
		// Focus emulation keeps our tabs rendering without stealing the window.
		await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
		const { frameTree } = await cdp.send("Page.getFrameTree");
		// Responses and events share one ordered session: this is at least as
		// new as any event already handled, and later events override it.
		tab.id = frameTree.frame.id;
		tab.documentId = frameTree.frame.loaderId;
		if (!tab.documentId) fail("no_document", "the tab did not report a document identity; it may be closing");
		return tab;
	} catch (err) {
		await cdp.detach().catch(() => undefined);
		throw err;
	}
}

/** The live screencast of one tab and its newest frame. */
interface Screencast {
	tab: Tab;
	frame: LiveFrame | null;
	first: PromiseWithResolvers<void>;
	onFrame: (event: Protocol.Page.ScreencastFrameEvent) => void;
}

interface DriverParts {
	browser: Browser;
	/** At least one; the first becomes the active tab. */
	tabs: Tab[];
	viewport: Viewport;
	ownsBrowser: boolean;
	release: () => void;
}

class PuppeteerDriver implements EngineDriver {
	readonly #browser: Browser;
	/** Every tab this driver owns, in opening order. */
	readonly #tabs: Tab[] = [];
	/** The tab being shown and driven. */
	#active: Tab;
	/** In-flight and finished adoptions, so one target never becomes two tabs. */
	readonly #adopting = new Map<Target, Promise<Tab | undefined>>();
	#viewport: Viewport;
	/** Device pixel ratio the page renders at, so the live view is crisp on HiDPI. */
	#scale = 1;
	readonly #ownsBrowser: boolean;
	readonly #release: () => void;
	readonly #onTargetCreated: (target: Target) => void;
	readonly #onDisconnected: () => void;
	/** Set once the live view asked for frames; from then on the active tab is always cast. */
	#liveWanted = false;
	#cast: Screencast | undefined;
	/** Screencast start/stop run in order; a tab switch never interleaves with another. */
	#castChain: Promise<void> = Promise.resolve();
	#frameSeq = 0;
	#closed = false;
	#closing: Promise<void> | undefined;

	constructor(parts: DriverParts) {
		this.#browser = parts.browser;
		this.#viewport = parts.viewport;
		this.#ownsBrowser = parts.ownsBrowser;
		this.#release = parts.release;
		const first = parts.tabs[0];
		if (!first) fail("no_tab", "the browser has no page tab");
		this.#active = first;
		for (const tab of parts.tabs) {
			this.#tabs.push(tab);
			this.#adopting.set(tab.target, Promise.resolve(tab));
			this.#wire(tab);
		}
		this.#onTargetCreated = (target: Target): void => {
			if (target.type() !== "page" || this.#closed || !this.#owns(target)) return;
			// A site's popup / target=_blank and a task agent's tab become the
			// active tab, so the human watches where the work happens.
			void this.#adopt(target, true).catch(() => undefined);
		};
		this.#onDisconnected = (): void => {
			if (this.#ownsBrowser) {
				// A dropped transport is NOT proof the process died, so this goes
				// through the normal confirmed shutdown rather than releasing.
				if (!this.#closed) void this.close().catch((err) => console.error("Owned browser cleanup failed:", err));
				return;
			}
			// Relay: the attachment IS the leased resource, and it is now provably
			// gone. Nothing of the human's browser was ever ours to close.
			this.#closed = true;
			this.#release();
		};
		parts.browser.on("targetcreated", this.#onTargetCreated);
		parts.browser.on("disconnected", this.#onDisconnected);
		void first.page.bringToFront().catch(() => undefined);
	}

	// -----------------------------------------------------------------------
	// Reads
	// -----------------------------------------------------------------------

	async state(): Promise<EngineState> {
		const active = this.#activeTab();
		// Only browser-process reads here: a renderer-side call (Page.getFrameTree)
		// stalls until an in-flight navigation commits, which would freeze the
		// live view for the whole load. The document id is event-tracked instead.
		const history = await this.#read(() => active.cdp.send("Page.getNavigationHistory"));
		const current = history.entries[history.currentIndex];
		if (!current) fail("no_document", "The browser did not report a current navigation entry.");
		// Browser-maintained metadata, not document JavaScript: the latter loses
		// its execution context during an ordinary in-flight navigation.
		const tabs = await Promise.all(
			this.#tabs.map(async (tab): Promise<TabInfo> => {
				let url = current.url;
				let title = current.title;
				if (tab !== active) {
					const other = await tab.cdp.send("Page.getNavigationHistory").catch(() => null);
					const entry = other?.entries[other.currentIndex];
					url = entry?.url ?? tab.page.url();
					title = entry?.title ?? "";
				}
				return { id: tab.id, title, url, active: tab === active, loading: tab.loading, favicon: FAVICONS.get(url) };
			}),
		);
		return {
			url: current.url,
			title: current.title,
			// A tab switch is a document change for everything pinned to one.
			documentId: `${active.id}:${active.documentId}`,
			viewport: this.#viewport,
			tabs,
			activeTabId: active.id,
			loading: active.loading,
			canGoBack: history.currentIndex > 0,
			canGoForward: history.currentIndex < history.entries.length - 1,
		};
	}

	async screenshot(): Promise<Uint8Array> {
		const { width, height } = this.#viewport;
		// Annotation frames stay in CSS pixels whatever the render scale: crop
		// regions, clicks and element lookups all share that one space.
		const shot = await this.#activeTab().page.screenshot({
			type: "png",
			captureBeyondViewport: false,
			...(this.#scale === 1 ? {} : { clip: { x: 0, y: 0, width, height, scale: 1 / this.#scale } }),
		});
		if (shot.length > MAX_FRAME_BYTES) {
			fail("frame_too_large", `screenshot is ${shot.length} bytes, above the ${MAX_FRAME_BYTES} byte limit`);
		}
		return shot;
	}

	async liveFrame(): Promise<LiveFrame> {
		const active = this.#activeTab();
		this.#liveWanted = true;
		if (this.#cast?.tab !== active) await this.#restartScreencast();
		const cast = this.#cast;
		if (!cast || cast.tab !== active) fail("tab_switched", "The active tab changed while starting the live view; ask again.");
		if (!cast.frame) {
			const { promise: waited, resolve } = Promise.withResolvers<void>();
			const timer = setTimeout(resolve, FIRST_FRAME_WAIT_MS);
			await Promise.race([cast.first.promise, waited]);
			clearTimeout(timer);
		}
		if (!cast.frame) {
			// A page that has not painted since the cast began sends nothing yet:
			// capture once so the view is never blank. The cast replaces it on the
			// next paint.
			const shot = await this.#read(() =>
				active.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: SCREENCAST_QUALITY }),
			);
			cast.frame ??= { id: `live-${active.id}-${++this.#frameSeq}`, data: shot.data, capturedAt: new Date().toISOString() };
		}
		return cast.frame;
	}

	async snapshot(limit: number): Promise<string> {
		return await this.#activeTab().page.evaluate(PAGE_TEXT_SCRIPT, limit);
	}

	async elements(region: BrowserRegion, limit: number): Promise<string> {
		return await this.#activeTab().page.evaluate(ELEMENTS_IN_REGION_SCRIPT, region, limit);
	}

	// -----------------------------------------------------------------------
	// Publish — reads with fixed scripts, and one guarded fill
	// -----------------------------------------------------------------------

	async fill(selector: string, text: string): Promise<void> {
		await withTimeout(this.#type(this.#activeTab().page, selector, text, true), ACTION_TIMEOUT_MS + 5_000, "fill");
	}

	// Publish reads: hasElement/readField resolve the selector through
	// puppeteer's own query handlers (so `pierce/` reaches into shadow roots),
	// then run a fixed data-only script on the element handle. linkHrefs runs one
	// fixed script that takes the selector as a data argument (CSS or `pierce/`
	// only). No selector ever becomes page code.
	async hasElement(selector: string): Promise<boolean> {
		const handle = await this.#activeTab().page.$(selector);
		if (handle === null) return false;
		await handle.dispose().catch(() => undefined);
		return true;
	}

	async readField(selector: string): Promise<FieldRead> {
		const handle = await this.#activeTab().page.$(selector);
		if (handle === null) return { state: "absent" };
		try {
			return await handle.evaluate(READ_FIELD_SCRIPT);
		} finally {
			await handle.dispose().catch(() => undefined);
		}
	}

	async linkHrefs(selector: string, limit: number): Promise<string[]> {
		return await this.#activeTab().page.evaluate(LINK_HREFS_SCRIPT, selector, limit);
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	/**
	 * One native dispatch, never retried, and bounded: an action that has not
	 * settled in time is reported as an error (the runtime classifies it
	 * `unknown` — it may still land). Everything that can fail without touching
	 * the page (validation, element resolution, empty history) throws
	 * ActionNotDispatched before the first input event.
	 */
	async perform(action: BrowserAction): Promise<void> {
		await withTimeout(this.#dispatch(action), NAVIGATE_TIMEOUT_MS + 5_000, `${action.kind}`);
	}

	async #dispatch(action: BrowserAction): Promise<void> {
		const tab = this.#activeTab();
		const page = tab.page;
		switch (action.kind) {
			case "navigate": {
				const url = requireField(action.url, "navigate.url");
				await navigating(tab, page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS }));
				return;
			}
			case "back":
			case "forward": {
				const history = await this.#read(() => tab.cdp.send("Page.getNavigationHistory"));
				const target = history.currentIndex + (action.kind === "back" ? -1 : 1);
				if (target < 0 || target >= history.entries.length) {
					throw new ActionNotDispatched("no_history", `there is no page to go ${action.kind} to`);
				}
				const options = { waitUntil: "domcontentloaded" as const, timeout: NAVIGATE_TIMEOUT_MS };
				await navigating(tab, action.kind === "back" ? page.goBack(options) : page.goForward(options));
				return;
			}
			case "reload":
				await navigating(tab, page.reload({ waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS }));
				return;
			case "stop":
				await tab.cdp.send("Page.stopLoading");
				tab.loading = false;
				return;
			case "click": {
				const options = { button: action.button ?? "left", count: action.clickCount ?? 1 };
				if (action.selector === undefined) {
					await page.mouse.click(requireNumber(action.x, "click.x"), requireNumber(action.y, "click.y"), options);
					return;
				}
				const handle = await this.#resolve(page, action.selector);
				try {
					await handle.click(options);
				} finally {
					await handle.dispose().catch(() => undefined);
				}
				return;
			}
			case "hover":
				await page.mouse.move(requireNumber(action.x, "hover.x"), requireNumber(action.y, "hover.y"));
				return;
			case "insert":
				// Whatever has focus receives the text as one native input operation.
				await page.keyboard.sendCharacter(requireField(action.text, "insert.text"));
				return;
			case "type":
				await this.#type(page, requireField(action.selector, "type.selector"), requireField(action.text, "type.text", true), false);
				return;
			case "select": {
				const wanted = requireField(action.value, "select.value", true);
				const handle = await this.#resolve(page, requireField(action.selector, "select.selector"));
				try {
					const value = await handle.evaluate((el, wanted) => {
						if (!(el instanceof HTMLSelectElement)) return null;
						const option = Array.from(el.options).find((o) => o.value === wanted || o.text.trim() === wanted);
						return option ? option.value : null;
					}, wanted);
					if (value === null) {
						throw new ActionNotDispatched("no_option", `${JSON.stringify(action.selector)} is not a <select> with an option ${JSON.stringify(wanted)}`);
					}
					await handle.select(value);
				} finally {
					await handle.dispose().catch(() => undefined);
				}
				return;
			}
			case "press":
				await page.keyboard.press(requireField(action.key, "press.key") as KeyInput);
				return;
			case "scroll":
				await page.mouse.wheel({ deltaX: action.deltaX ?? 0, deltaY: action.deltaY ?? 0 });
				return;
			default:
				throw new ActionNotDispatched("bad_action", `unsupported action kind ${JSON.stringify((action as BrowserAction).kind)}`);
		}
	}

	// -----------------------------------------------------------------------
	// Tabs
	// -----------------------------------------------------------------------

	async openTab(url?: string): Promise<void> {
		this.#assertOpen();
		const page = await this.#browser.newPage();
		const tab = await this.#adopt(page.target(), true);
		if (!tab) fail("tab_closed", "the new tab closed before it could be shown");
		if (url === undefined) return;
		await navigating(tab, page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS }));
		// A tab opened at a URL starts there: the blank page it was born on is
		// not a place "back" should lead to.
		await tab.cdp.send("Page.resetNavigationHistory").catch(() => undefined);
	}

	async activateTab(tabId: string): Promise<void> {
		this.#assertOpen();
		await this.#activate(this.#tabById(tabId));
	}

	async closeTab(tabId: string): Promise<void> {
		this.#assertOpen();
		const tab = this.#tabById(tabId);
		// Never let the browser reach zero tabs: a headful Chrome quits with its
		// last window, and the human would lose the browser to a tab close.
		if (this.#tabs.length === 1) await this.openTab();
		await tab.page.close();
		this.#forget(tab);
	}

	cdpEndpoint(): string {
		return this.#browser.wsEndpoint();
	}

	// -----------------------------------------------------------------------
	// Shutdown
	// -----------------------------------------------------------------------

	/**
	 * Stop everything this driver owns, bounded, and release the profile lease
	 * only on a CONFIRMED stop. Owned browser: await `browser.close()` (resolves
	 * once the process is gone). Relay: close our own tabs, disconnect, release.
	 * A failed close is not memoized, so a caller may try again.
	 */
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closing = this.#shutdown().finally(() => {
			this.#closing = undefined;
		});
		return this.#closing;
	}

	async #shutdown(): Promise<void> {
		this.#closed = true;
		this.#browser.off("targetcreated", this.#onTargetCreated);
		this.#browser.off("disconnected", this.#onDisconnected);
		await this.#stopScreencast();
		const tabs = [...this.#tabs];
		await Promise.all(tabs.map((tab) => tab.cdp.detach().catch(() => undefined)));

		if (!this.#ownsBrowser) {
			await Promise.all(tabs.map((tab) => (tab.page.isClosed() ? undefined : tab.page.close().catch(() => undefined))));
			await this.#browser.disconnect().catch(() => undefined);
			this.#release();
			return;
		}
		try {
			await withTimeout(this.#browser.close(), CLOSE_TIMEOUT_MS, "browser.close");
		} catch (err) {
			// A confirmed-dead process is still a confirmed release.
			if (hasExited(this.#browser)) {
				this.#release();
				return;
			}
			fail(
				"close_failed",
				`the browser did not shut down (${describe(err)}); its profile lease is deliberately NOT released while that process may still be alive`,
			);
		}
		this.#release();
	}

	// -----------------------------------------------------------------------
	// Internals — tabs
	// -----------------------------------------------------------------------

	/**
	 * Whether a new page target is ours. Everything in a Chrome we launched is.
	 * In the human's Chrome only pages our tabs opened (popups, target=_blank —
	 * `opener` is set even for noopener links). Task agents never run there.
	 */
	#owns(target: Target): boolean {
		if (this.#ownsBrowser) return true;
		const opener = target.opener();
		return opener !== undefined && this.#tabs.some((tab) => tab.target === opener);
	}

	/** Make `target` one of our tabs, once, however many paths race to adopt it. */
	#adopt(target: Target, activate: boolean): Promise<Tab | undefined> {
		const known = this.#adopting.get(target);
		if (known) return known;
		const work = (async (): Promise<Tab | undefined> => {
			const page = await target.page();
			if (!page || this.#closed || page.isClosed()) return undefined;
			const tab = await prepareTab(page, this.#viewport, this.#scale);
			if (this.#closed || page.isClosed()) {
				await tab.cdp.detach().catch(() => undefined);
				return undefined;
			}
			this.#tabs.push(tab);
			this.#wire(tab);
			if (activate) await this.#activate(tab);
			return tab;
		})();
		this.#adopting.set(target, work);
		work.catch(() => this.#adopting.delete(target));
		return work;
	}

	/**
	 * Loading, favicon and close tracking for one tab. Chrome reports
	 * `frameStartedLoading` only once the new document commits, so a page
	 * waiting on a slow server would look idle: a navigation the page requests
	 * (link, form, script) marks the tab loading at once, as `perform` does for
	 * navigations it starts.
	 */
	#wire(tab: Tab): void {
		const start = (event: { frameId: string }): void => {
			if (event.frameId === tab.id) tab.loading = true;
		};
		tab.cdp.on("Page.frameStartedLoading", start);
		tab.cdp.on("Page.frameRequestedNavigation", start);
		tab.cdp.on("Page.downloadWillBegin", (event) => {
			// A link that downloads never replaces the document or stops loading it.
			if (event.frameId === tab.id) tab.loading = false;
		});
		tab.cdp.on("Page.frameStoppedLoading", (event) => {
			if (event.frameId !== tab.id) return;
			tab.loading = false;
			this.#loadFavicon(tab);
		});
		tab.page.once("close", () => this.#forget(tab));
		this.#loadFavicon(tab);
	}

	#loadFavicon(tab: Tab): void {
		if (this.#closed || tab.page.isClosed()) return;
		void FAVICONS.load(tab.page.url(), () =>
			withTimeout(tab.page.evaluate(FAVICON_HREF_SCRIPT), FAVICON_SCRIPT_TIMEOUT_MS, "favicon lookup"),
		).catch(() => undefined);
	}

	/**
	 * A closed tab leaves the model. If it was the active one, its right
	 * neighbour (else left) takes over, as in every browser. If it was the
	 * last one, a blank tab replaces it: the browser never ends from a tab close.
	 */
	#forget(tab: Tab): void {
		const index = this.#tabs.indexOf(tab);
		if (index < 0) return;
		this.#tabs.splice(index, 1);
		this.#adopting.delete(tab.target);
		void tab.cdp.detach().catch(() => undefined);
		if (this.#closed || this.#active !== tab) return;
		const next = this.#tabs[index] ?? this.#tabs[index - 1];
		if (next) void this.#activate(next).catch(() => undefined);
		else void this.openTab().catch((err) => console.error("Could not replace the last closed tab:", err));
	}

	async #activate(tab: Tab): Promise<void> {
		this.#active = tab;
		// A hidden tab renders no frames: screenshots crawl and input waits
		// forever for one. The shown tab is always the front one.
		await tab.page.bringToFront().catch(() => undefined);
		if (this.#liveWanted) await this.#restartScreencast();
	}

	#tabById(tabId: string): Tab {
		const tab = this.#tabs.find((candidate) => candidate.id === tabId);
		if (!tab) throw new ActionNotDispatched("unknown_tab", `no tab ${JSON.stringify(tabId)} in this browser`);
		return tab;
	}

	/** The active tab, or a clear refusal when the browser or that tab is gone. */
	#activeTab(): Tab {
		this.#assertOpen();
		if (this.#active.page.isClosed()) fail("tab_closed", "The active tab just closed; read the state again.");
		return this.#active;
	}

	#assertOpen(): void {
		if (this.#closed) fail("browser_closed", "The browser is closed.");
	}

	// -----------------------------------------------------------------------
	// Internals — live screencast
	// -----------------------------------------------------------------------

	/**
	 * Fit the page to the View: every tab gets the new viewport and pixel ratio
	 * (so a tab switch never shows a stale size) and the live cast restarts.
	 */
	async resize(viewport: Viewport, scale: number): Promise<void> {
		this.#assertOpen();
		if (viewport.width === this.#viewport.width && viewport.height === this.#viewport.height && scale === this.#scale) return;
		this.#viewport = viewport;
		this.#scale = scale;
		await Promise.all(this.#tabs.map((tab) => tab.page.setViewport({ ...viewport, deviceScaleFactor: scale }).catch(() => undefined)));
		if (this.#liveWanted) {
			await this.#stopScreencast();
			await this.#restartScreencast();
		}
	}

	/** Cast the CURRENT active tab, stopping whatever was cast before. Ordered. */
	#restartScreencast(): Promise<void> {
		const step = this.#castChain.then(async () => {
			const tab = this.#active;
			if (this.#cast?.tab === tab) return;
			await this.#stopScreencastNow();
			if (this.#closed || tab.page.isClosed()) return;
			const cast: Screencast = {
				tab,
				frame: null,
				first: Promise.withResolvers<void>(),
				onFrame: (event) => {
					// Every frame is acknowledged, or Chrome stops sending them.
					void tab.cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
					if (this.#cast !== cast) return;
					cast.frame = { id: `live-${tab.id}-${++this.#frameSeq}`, data: event.data, capturedAt: new Date().toISOString() };
					cast.first.resolve();
				},
			};
			this.#cast = cast;
			tab.cdp.on("Page.screencastFrame", cast.onFrame);
			await tab.cdp
				.send("Page.startScreencast", {
					format: "jpeg",
					quality: SCREENCAST_QUALITY,
					maxWidth: Math.round(this.#viewport.width * this.#scale),
					maxHeight: Math.round(this.#viewport.height * this.#scale),
					everyNthFrame: 1,
				})
				.catch(() => undefined);
		});
		this.#castChain = step.catch(() => undefined);
		return step;
	}

	#stopScreencast(): Promise<void> {
		const step = this.#castChain.then(() => this.#stopScreencastNow());
		this.#castChain = step.catch(() => undefined);
		return step;
	}

	async #stopScreencastNow(): Promise<void> {
		const cast = this.#cast;
		if (!cast) return;
		this.#cast = undefined;
		cast.tab.cdp.off("Page.screencastFrame", cast.onFrame);
		if (!cast.tab.page.isClosed()) await cast.tab.cdp.send("Page.stopScreencast").catch(() => undefined);
	}

	// -----------------------------------------------------------------------
	// Internals — reads
	// -----------------------------------------------------------------------

	/**
	 * One read-only CDP call, retried with backoff across a navigation's
	 * detach window. Reads have no effect, so re-reading is safe; the last
	 * error is rethrown once the window is exhausted.
	 */
	async #read<T>(send: () => Promise<T>): Promise<T> {
		for (const delay of READ_RETRY_DELAYS_MS) {
			this.#assertOpen();
			try {
				return await send();
			} catch {
				await sleep(delay);
			}
		}
		this.#assertOpen();
		return await send();
	}

	/**
	 * Replace a field's content: focus, select all, and ONE native input
	 * operation — no transient empty value, and the text never appears in argv
	 * or a log. `refusePassword` refuses a password input before any input event.
	 */
	async #type(page: Page, selector: string, text: string, refusePassword: boolean): Promise<void> {
		const handle = await this.#resolve(page, selector);
		try {
			if (refusePassword && (await handle.evaluate(IS_PASSWORD_SCRIPT))) {
				throw new ActionNotDispatched("password_field", `${JSON.stringify(selector)} is a password field; publishing never types into one`);
			}
			await handle.focus();
			if (!(await handle.evaluate(SELECT_ALL_SCRIPT))) {
				const modifier = process.platform === "darwin" ? "Meta" : "Control";
				await page.keyboard.down(modifier);
				try {
					await page.keyboard.press("KeyA");
				} finally {
					await page.keyboard.up(modifier);
				}
			}
			// The page may have moved focus since `focus()` (or swapped in a
			// password input): the text goes only where it was aimed.
			const focus = await handle.evaluate(TYPE_TARGET_SCRIPT);
			if (focus === "elsewhere") throw new ActionNotDispatched("focus_moved", `${JSON.stringify(selector)} lost focus before typing; nothing was typed`);
			if (refusePassword && focus === "password") {
				throw new ActionNotDispatched("password_field", `${JSON.stringify(selector)} has a password field focused; publishing never types into one`);
			}
			if (text.length > 0) await page.keyboard.sendCharacter(text);
			else await page.keyboard.press("Backspace");
		} finally {
			await handle.dispose().catch(() => undefined);
		}
	}

	/** Element resolution is read-only, so a miss here is a certain non-event. */
	async #resolve(page: Page, selector: string): Promise<ElementHandle<Element>> {
		const handle = await page.waitForSelector(selector, { timeout: ACTION_TIMEOUT_MS }).catch(() => null);
		if (!handle) throw new ActionNotDispatched("no_element", `selector ${JSON.stringify(selector)} did not resolve to an element`);
		return handle;
	}
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * A navigation this driver started: the tab reads as loading from the moment
 * it is sent (Chrome's own loading events only begin at commit). A failed
 * navigation leaves the old document idle; a successful one clears on
 * `frameStoppedLoading`.
 */
async function navigating<T>(tab: Tab, navigation: Promise<T>): Promise<T> {
	tab.loading = true;
	try {
		return await navigation;
	} catch (err) {
		tab.loading = false;
		throw err;
	}
}

function requireField(value: unknown, name: string, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		throw new ActionNotDispatched("bad_action", `${name} is required`);
	}
	return value;
}

function requireNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ActionNotDispatched("bad_action", `${name} is required`);
	}
	return value;
}

/** True only when the child process is provably gone. */
function hasExited(browser: Browser): boolean {
	const proc = browser.process();
	return proc !== null && (proc.exitCode !== null || proc.signalCode !== null);
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Bound a call that would otherwise hang the caller forever. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	const { promise: expired, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	try {
		return await Promise.race([promise, expired]);
	} finally {
		clearTimeout(timer);
	}
}
