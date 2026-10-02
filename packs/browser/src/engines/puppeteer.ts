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
 * `page-scripts.ts`. The one exception is `evaluate`: the runtime lets a
 * model's own JavaScript reach it on a throwaway browser only.
 */
import { type ChildProcess, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer, { TimeoutError } from "puppeteer-core";
import type { Browser, BrowserContext, CDPSession, ElementHandle, Frame, HTTPRequest, HTTPResponse, JSHandle, KeyInput, Page, Protocol, Target } from "puppeteer-core";
import { type BrowserAction, type BrowserApp, type BrowserRegion, type DialogType, type ElementInspection, type HandledDialog, type LogEntry, MAX_ELEMENT_ID_CHARS, MAX_ELEMENT_LABEL_CHARS, MAX_ELEMENT_TAG_CHARS, MAX_ELEMENTS_PER_REGION, MAX_LOG_ENTRIES, type ModelShot, type PageElements, type PageScroll, type ShotRequest, type TabInfo, type Viewport } from "../contracts.js";
import { FaviconCache } from "../favicon.js";
import { MAX_FRAME_BYTES } from "../image.js";
import { ActionNotDispatched, BrowserRuntimeError, fail } from "../store.js";
import {
	ELEMENT_LABEL_SCRIPT,
	ELEMENT_TEXT_SCRIPT,
	ELEMENTS_IN_REGIONS_SCRIPT,
	SCROLL_SCRIPT,
	FAVICON_HREF_SCRIPT,
	FOCUSED_LEAF_SCRIPT,
	FRAME_INSET_SCRIPT,
	INSPECT_SCRIPT,
	IS_PASSWORD_SCRIPT,
	INSERT_PASSWORD_SCRIPT,
	LINK_HREFS_SCRIPT,
	PAGE_TEXT_SCRIPT,
	READ_FIELD_SCRIPT,
	READ_PAGE_SCRIPT,
	SAVED_PASSWORD_TARGET_SCRIPT,
	SELECT_ALL_SCRIPT,
	READ_TEXT_SCRIPT,
	TYPE_TARGET_SCRIPT,
	EVAL_RESULT_SCRIPT,
	UA_HINTS_SCRIPT,
} from "./page-scripts.js";
import { watchPageLog } from "./page-log.js";
import { type AdmittedInput, inputCall } from "../input.js";
import { type HeadfulIdentity, identityPerBinary, type ResolvedBrowser, resolveBrowser, turnOffPasswordSaving, UA_HINTS, viewLaunchOptions, withTimeout } from "./launch.js";
import type { TabRef } from "../code/contracts.js";
import type { DialogPolicy, EngineDriver, EngineOptions, EngineState, EvalOutcome, FieldRead, LiveFrame, NavigateTabOptions, OpenTabOptions, PageRead, PageReader, PasswordSource, PerformOutcome, ReadOutcome, ReadPolicy, WaitCondition } from "./types.js";

const NAVIGATE_TIMEOUT_MS = 30_000;
/** Child frames a snapshot lists controls for, depth first. */
const MAX_SNAPSHOT_FRAMES = 16;
/**
 * A selector aimed into a child frame: `@<ref> <css>`, where `ref` is the
 * frame's 1-based child-index path from the main frame plus `~` and a tag of
 * that frame's identity and origin (`@1~3fa92c0d`, `@1.2~…`), as the snapshot
 * names it. Any frame, cross-origin and out-of-process included. The tag is
 * what makes a ref safe to reuse: an index alone shifts when an earlier
 * sibling iframe goes away, and would then aim at a different site.
 */
const FRAME_SELECTOR = /^@(\d{1,3}(?:\.\d{1,3}){0,7})~([0-9a-f]{8})\s+([\s\S]+)$/;
/** Anything that looks like a frame ref, well-formed or not (a stale or hand-written one is refused, never run as CSS). */
const FRAME_REF_LIKE = /^@\d/;
const ACTION_TIMEOUT_MS = 15_000;
const LAUNCH_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 15_000;
/** After a kill, how long the browser process gets to be seen exiting before the kill itself is called unconfirmed. */
const KILL_CONFIRM_MS = 5_000;
const FAVICON_SCRIPT_TIMEOUT_MS = 2_000;
/** How long a freshly started screencast gets to deliver its first picture before one is captured: Chrome sends nothing for a page that is not changing. */
const FIRST_FRAME_WAIT_MS = 150;
const SCREENCAST_QUALITY = 70;
/** A batch of the human's input gets this long: a renderer stuck in a navigation never acknowledges, and the View must hear that. */
const INPUT_TIMEOUT_MS = 5_000;
/** A model's picture: the browser's own webp at this quality, its longest edge at most this many CSS px. */
const MODEL_SHOT_QUALITY = 70;
const MODEL_SHOT_EDGE = 1_024;
/** An eval step gets this long to run its script, plus a grace for a promise it awaits. */
const EVAL_TIMEOUT_MS = 10_000;
const EVAL_GROUP = "dimension-eval";
const DEFAULT_RELAY_URL = "http://127.0.0.1:9224";
/** Dialogs kept per tab for the model, and the longest message kept (a page's own text: bounded, untrusted). */
const MAX_DIALOGS = 5;
const MAX_DIALOG_CHARS = 300;
/** After input that can navigate: how long a navigation gets to start, and how long to wait for it to commit and finish loading. */
const NAVIGATION_GRACE_MS = 100;
const SETTLE_MS = 1_500;
const SETTLE_POLL_MS = 20;
/** The error a read gets when the document under it is replaced by a navigation. */
const NAVIGATED_UNDER_READ = /Execution context was destroyed|Cannot find context|Inspected target navigated|Target closed|Session closed/i;

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
		return new PuppeteerDriver({ browser, tabs: [tab], viewport: options.viewport, ownsBrowser: false, release, app: null });
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

/** The probe's page: loopback is a secure context (`userAgentData` needs one); the request is answered in-browser and never sent. */
const PROBE_URL = "http://127.0.0.1/";

/**
 * Headful identity per browser binary, read from that binary: a throwaway
 * headless launch (no profile of ours) reports its User-Agent and client
 * hints, and `headfulIdentity` takes the headless token out.
 */
const binaryIdentities = identityPerBinary({
	stamp: (executablePath) => statSync(executablePath).mtimeMs,
	closeTimeoutMs: CLOSE_TIMEOUT_MS,
	async launch(executablePath) {
		const probe = await puppeteer.launch({ executablePath, headless: true, timeout: LAUNCH_TIMEOUT_MS, args: CHROMIUM_ARGS });
		return {
			async read() {
				const page = (await probe.pages())[0] ?? (await probe.newPage());
				await page.setRequestInterception(true);
				page.on("request", (request) => void request.respond({ status: 200, contentType: "text/html", body: "" }).catch(() => undefined));
				await page.goto(PROBE_URL, { timeout: NAVIGATE_TIMEOUT_MS });
				return { userAgent: await probe.userAgent(), hints: await page.evaluate(UA_HINTS_SCRIPT, [...UA_HINTS]) };
			},
			close: () => probe.close(),
			kill: () => void probe.process()?.kill("SIGKILL"),
		};
	},
});

/**
 * Give every target of a headless View the binary's headful identity: pages,
 * popups, out-of-process frames, and dedicated, shared and service workers,
 * existing and future. The `--user-agent` switch blanks the high-entropy
 * client hints; `Emulation.setUserAgentOverride` with the binary's own
 * metadata restores them. Auto-attach holds each new target before it runs;
 * the override, the nested auto-attach and the release are sent in that order
 * on the target's own session, so nothing leaves before its override, and a
 * paused target is always released (a service worker answers only once it
 * runs, so nothing waits on a reply before the release).
 */
async function presentAsHeadful(browser: Browser, identity: HeadfulIdentity): Promise<void> {
	const root = await browser.target().createCDPSession();
	const connection = root.connection();
	if (!connection) fail("launch_failed", "the browser's DevTools connection is gone");
	const override = { userAgent: identity.userAgent, userAgentMetadata: identity.metadata };
	const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
	const adopting = new Set<Promise<unknown>>();
	const watch = (session: CDPSession): void => {
		session.on("Target.attachedToTarget", ({ sessionId, targetInfo, waitingForDebugger }: Protocol.Target.AttachedToTargetEvent) => {
			const child = connection.session(sessionId);
			if (!child) return;
			// A DevTools-attached service worker is never stopped when idle (the
			// reason puppeteer itself detaches from them), so it is let go once
			// released, as the user's Chrome would stop it.
			const serviceWorker = targetInfo.type === "service_worker";
			if (!serviceWorker) watch(child);
			const sent: Promise<unknown>[] = [child.send("Emulation.setUserAgentOverride", override)];
			if (!serviceWorker) sent.push(child.send("Target.setAutoAttach", autoAttach));
			if (waitingForDebugger) sent.push(child.send("Runtime.runIfWaitingForDebugger"));
			const adopted = Promise.allSettled(sent).then(async () => {
				if (serviceWorker) await session.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
			});
			adopting.add(adopted);
			void adopted.then(() => adopting.delete(adopted));
		});
	};
	watch(root);
	await root.send("Target.setAutoAttach", autoAttach);
	// The targets already open (the first tab) carry the identity before any use.
	await withTimeout(Promise.all(adopting), ACTION_TIMEOUT_MS, "identity for the open tabs");
}

/** Launch the user's browser (launch.ts decides which, and how) on the profile directory this driver owns. */
async function launchChromium(options: EngineOptions, release: () => void): Promise<EngineDriver> {
	const userDataDir = options.profileDirectory;
	const headless = options.headless ?? true;
	let browser: Browser;
	let resolved: ResolvedBrowser;
	let identity: HeadfulIdentity | undefined;
	try {
		resolved = await resolveBrowser(options.executablePath);
		identity = headless ? await binaryIdentities.of(resolved.executablePath) : undefined;
		mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
		turnOffPasswordSaving(userDataDir);
		browser = await puppeteer.launch(viewLaunchOptions({
			browser: resolved, userDataDir, headless, args: CHROMIUM_ARGS, timeout: LAUNCH_TIMEOUT_MS,
			...(identity ? { userAgent: identity.userAgent } : {}),
		}));
		console.error(`[browser] launched ${resolved.app} (${resolved.executablePath})${headless ? ", headless" : ""} on ${userDataDir}`);
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
		if (identity) {
			// An update the stamp missed shows as a version the identity does not
			// name: it is probed again, once, and the fresh identity is presented.
			// Only `--user-agent`, fixed at launch, keeps the old string until reopen.
			const running = (await browser.version()).split("/").pop() ?? "";
			await presentAsHeadful(browser, await binaryIdentities.confirm(resolved.executablePath, identity, running));
		}
		const pages = await browser.pages();
		if (pages.length === 0) pages.push(await browser.newPage());
		const tabs: Tab[] = [];
		for (const page of pages) tabs.push(await prepareTab(page, options.viewport));
		return new PuppeteerDriver({ browser, tabs, viewport: options.viewport, ownsBrowser: true, release, app: resolved.app, ...(options.onPageLoaded ? { onPageLoaded: options.onPageLoaded } : {}) });
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
	/** Counts every navigation this tab started or was asked to start; a change means one is under way. */
	navSeq: number;
	/** Every dialog this tab's page (or an iframe of it) opened, as answered. */
	dialogs: DialogLog;
	/** What went wrong on this page, newest last (bounded); `LogEntry.n` is the driver's, so it orders across tabs. */
	log: LogEntry[];
}

/** The last MAX_DIALOGS dialogs answered, oldest first; `seq` counts them since the tab began. */
interface DialogLog {
	entries: Array<HandledDialog & { seq: number }>;
	seq: number;
	/** How this tab answers its dialogs when its opener asked for one way (`setDialogPolicy`); unset: alert and beforeunload accepted, confirm and prompt dismissed. */
	policy?: DialogPolicy;
}

/** A session that already answers its page's dialogs. */
interface Guarded {
	cdp: CDPSession;
	dialogs: DialogLog;
}

async function prepareTab(page: Page, viewport: Viewport, scale = 1, early?: Guarded): Promise<Tab> {
	const { cdp, dialogs } = early ?? (await guardPage(await page.createCDPSession()));
	const tab: Tab = { id: "", documentId: "", page, target: page.target(), cdp, loading: false, navSeq: 0, dialogs, log: [] };
	// Subscribed before the first read: a commit racing setup is never missed.
	cdp.on("Page.frameNavigated", ({ frame }) => {
		if (frame.parentId === undefined) tab.documentId = frame.loaderId;
	});
	try {
		await page.setViewport({ ...viewport, deviceScaleFactor: scale });
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

/**
 * Start answering a page's dialogs on `cdp`, before anything else runs on the
 * target — for a popup, before puppeteer even initialises its page, which an
 * open dialog would block for good.
 */
async function guardPage(cdp: CDPSession): Promise<Guarded> {
	const dialogs: DialogLog = { entries: [], seq: 0 };
	answerDialogs(cdp, dialogs);
	try {
		await cdp.send("Page.enable");
	} catch (err) {
		await cdp.detach().catch(() => undefined);
		throw err;
	}
	return { cdp, dialogs };
}

/**
 * An open JavaScript dialog freezes its page: every command to it waits for
 * an answer, so one unanswered `alert()` hangs the browser for good. Each is
 * answered the moment it opens, whoever caused it (the model's action, a
 * task agent driving the tab, the page itself, an iframe of it, cross-origin
 * ones included: Chrome delivers their dialogs to the page's own session): alert and
 * beforeunload are accepted (leaving is the point of a beforeunload), confirm
 * and prompt are dismissed. The outcome is recorded from Chrome's own "closed"
 * event, so it is true even when another client answered first.
 */
function answerDialogs(cdp: CDPSession, log: DialogLog): void {
	let open: { type: DialogType; message: string } | undefined;
	cdp.on("Page.javascriptDialogOpening", (event) => {
		open = { type: event.type, message: event.message.slice(0, MAX_DIALOG_CHARS) };
		const accept = log.policy === undefined ? event.type === "alert" || event.type === "beforeunload" : log.policy === "accept";
		void cdp.send("Page.handleJavaScriptDialog", { accept }).catch(() => undefined);
	});
	cdp.on("Page.javascriptDialogClosed", (event) => {
		if (!open) return;
		log.entries.push({ seq: ++log.seq, type: open.type, message: open.message, handled: event.result ? "accepted" : "dismissed" });
		if (log.entries.length > MAX_DIALOGS) log.entries.shift();
		open = undefined;
	});
}

/** The live screencast of one tab: the page size it was started at and its newest picture. */
interface Screencast {
	tab: Tab;
	viewport: Viewport;
	frame: LiveFrame | null;
	onFrame: (event: Protocol.Page.ScreencastFrameEvent) => void;
}

interface DriverParts {
	browser: Browser;
	/** At least one; the first becomes the active tab. */
	tabs: Tab[];
	viewport: Viewport;
	ownsBrowser: boolean;
	release: () => void;
	app: BrowserApp | null;
	/** See `EngineOptions.onPageLoaded`. */
	onPageLoaded?: () => void;
}

/** An action that did nothing beyond itself. */
const NONE: PerformOutcome = Object.freeze({});

/** The id a code worker adopts the tab by: the page's own target id (the main frame's id is the same string, which is why `Tab.id` can stand in). */
function targetIdOf(tab: Tab): string {
	const raw = tab.target as unknown as { _targetId?: unknown };
	return typeof raw._targetId === "string" ? raw._targetId : tab.id;
}

/** How long a freeze or thaw gets: a page that will not change lifecycle state must not hold a cell up. */
const FREEZE_TIMEOUT_MS = 3_000;

class PuppeteerDriver implements EngineDriver {
	readonly app: BrowserApp | null;
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
	readonly #onPageLoaded: (() => void) | undefined;
	readonly #onTargetCreated: (target: Target) => void;
	readonly #onDisconnected: () => void;
	/** Everyone watching: the active tab is cast while this is not empty, and not otherwise. */
	readonly #watchers = new Set<(frame: LiveFrame) => void>();
	#cast: Screencast | undefined;
	/** Screencast start/stop run in order; a tab switch never interleaves with another. */
	#castChain: Promise<void> = Promise.resolve();
	#frameSeq = 0;
	#logSeq = 0;
	#closed = false;
	#closing: Promise<void> | undefined;
	/** The launch tab while it is still blank and has not been handed to a code worker (`openTab` with `reuseBlank`); then undefined. */
	#fresh: Tab | undefined;

	constructor(parts: DriverParts) {
		this.#browser = parts.browser;
		this.app = parts.app;
		this.#viewport = parts.viewport;
		this.#ownsBrowser = parts.ownsBrowser;
		this.#release = parts.release;
		this.#onPageLoaded = parts.onPageLoaded;
		const first = parts.tabs[0];
		if (!first) fail("no_tab", "the browser has no page tab");
		this.#active = first;
		if (parts.tabs.length === 1) this.#fresh = first;
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
			dialogs: active.dialogs.entries.map(({ type, message, handled }) => ({ type, message, handled })),
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

	async shotForModel(request: ShotRequest): Promise<Omit<ModelShot, "url">> {
		const tab = this.#activeTab();
		const metrics = await this.#read(() => tab.cdp.send("Page.getLayoutMetrics"));
		const view = metrics.cssVisualViewport;
		// Clip and capture coordinates are the page's (document) CSS pixels, scrolled or not.
		let region: BrowserRegion = { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight };
		if (request.fullPage) region = { x: 0, y: 0, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height };
		else if (request.selector !== undefined) region = await this.#elementRegion(tab, request.selector, view);
		const width = Math.max(1, Math.ceil(region.width));
		const height = Math.max(1, Math.ceil(region.height));
		const scale = Math.min(1, MODEL_SHOT_EDGE / Math.max(width, height)) * (request.scale ?? 1);
		// Only a region past the viewport needs the page laid out beyond it (which can move viewport-relative CSS).
		const inView = region.x >= view.pageX && region.y >= view.pageY && region.x + width <= view.pageX + view.clientWidth && region.y + height <= view.pageY + view.clientHeight;
		const shot = await this.#read(() =>
			tab.cdp.send("Page.captureScreenshot", {
				format: "webp",
				quality: MODEL_SHOT_QUALITY,
				captureBeyondViewport: !inView,
				// The output is the clip's size times its scale times the page's pixel ratio.
				clip: { x: region.x, y: region.y, width, height, scale: scale / this.#scale },
			}),
		);
		return { mimeType: "image/webp", data: shot.data, width, height, scale: Math.round(scale * 1_000) / 1_000 };
	}

	/** The element's box in page pixels (an iframe's element too), or a refusal that nothing was captured. */
	async #elementRegion(tab: Tab, selector: string, view: { pageX: number; pageY: number }): Promise<BrowserRegion> {
		const { frame, css } = aim(tab.page, selector);
		const handle = await frame.$(css);
		if (!handle) throw new ActionNotDispatched("no_element", `${JSON.stringify(selector)} matches nothing on the page`);
		try {
			const box = await handle.boundingBox();
			if (!box || box.width < 1 || box.height < 1) throw new ActionNotDispatched("no_box", `${JSON.stringify(selector)} has no visible box to capture`);
			return { x: box.x + view.pageX, y: box.y + view.pageY, width: box.width, height: box.height };
		} finally {
			await handle.dispose().catch(() => undefined);
		}
	}

	logs(): LogEntry[] {
		return this.#active.log.map((entry) => ({ ...entry }));
	}

	async evaluate(expression: string, limit: number): Promise<EvalOutcome> {
		const tab = this.#activeTab();
		// The main world (no contextId), so the app's own globals are visible; `replMode` lets a snippet `await` and re-declare.
		const run = await withTimeout(
			tab.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, replMode: true, returnByValue: false, timeout: EVAL_TIMEOUT_MS, objectGroup: EVAL_GROUP }),
			EVAL_TIMEOUT_MS + 5_000,
			"eval",
		);
		try {
			// `replMode` (top-level await) hands a plain promise back unawaited: settle it here. A rejection is an exception.
			let outcome: { result: Protocol.Runtime.RemoteObject; exceptionDetails?: Protocol.Runtime.ExceptionDetails } = run;
			if (!run.exceptionDetails && run.result.subtype === "promise" && run.result.objectId !== undefined) {
				outcome = await withTimeout(tab.cdp.send("Runtime.awaitPromise", { promiseObjectId: run.result.objectId, returnByValue: false }), EVAL_TIMEOUT_MS + 5_000, "eval");
			}
			const thrown = outcome.exceptionDetails;
			if (thrown) {
				const said = thrown.exception?.description ?? String(thrown.exception?.value ?? thrown.text);
				return { ok: false, ran: thrown.exception?.className !== "SyntaxError", error: said.split("\n", 1)[0] ?? "" };
			}
			const result = outcome.result;
			if (result.type === "undefined") return { ok: true, truncated: false };
			if (result.objectId === undefined) {
				const text = result.unserializableValue ?? JSON.stringify(result.value);
				return { ok: true, value: text.slice(0, limit), truncated: text.length > limit };
			}
			const described = await tab.cdp.send("Runtime.callFunctionOn", {
				objectId: result.objectId,
				functionDeclaration: String(EVAL_RESULT_SCRIPT),
				arguments: [{ value: limit }],
				returnByValue: true,
				silent: true,
			});
			const { text, truncated } = described.result.value as { text: string; truncated: boolean };
			return { ok: true, value: text, truncated };
		} finally {
			await tab.cdp.send("Runtime.releaseObjectGroup", { objectGroup: EVAL_GROUP }).catch(() => undefined);
		}
	}

	watchFrames(listener: (frame: LiveFrame) => void): () => void {
		this.#assertOpen();
		this.#watchers.add(listener);
		if (this.#watchers.size === 1) void this.#restartScreencast().catch(() => undefined);
		else {
			// A page that is not changing sends nothing more: the newest picture is what a late watcher is owed.
			const shown = this.#cast?.frame;
			if (shown) queueMicrotask(() => { if (this.#watchers.has(listener)) listener(shown); });
		}
		return () => {
			if (!this.#watchers.delete(listener) || this.#watchers.size > 0) return;
			void this.#stopScreencast().catch(() => undefined);
		};
	}

	async input(events: readonly AdmittedInput[]): Promise<void> {
		const tab = this.#activeTab();
		await withTimeout(
			(async () => {
				for (const event of events) {
					const { method, params } = inputCall(event);
					await tab.cdp.send(method, params as never);
				}
			})(),
			INPUT_TIMEOUT_MS,
			"input",
		);
	}

	/**
	 * The main frame's text and controls, then each child frame's (depth first,
	 * cross-origin and out-of-process frames included) under `## frame @<ref>`,
	 * its selectors prefixed `@<ref> ` for browser_act and its centers in
	 * main-viewport pixels. A frame that is not rendered (no box) is left out.
	 */
	async snapshot(limit: number): Promise<string> {
		const tab = this.#activeTab();
		const page = tab.page;
		const parts = [await this.#duringNavigation(tab, () => page.evaluate(PAGE_TEXT_SCRIPT, limit, null, 0, 0))];
		let left = limit - (parts[0]?.length ?? 0);
		for (const { frame, ref } of childFrames(page)) {
			if (left <= 0) break;
			const offset = await frameOffset(frame).catch(() => null);
			if (offset === null) continue;
			// A frame navigating or detaching mid-read is left out of this snapshot.
			const text = await frame.evaluate(PAGE_TEXT_SCRIPT, left, ref, offset.x, offset.y).catch(() => null);
			if (text === null) continue;
			parts.push(text);
			left -= text.length;
		}
		return parts.join("\n\n");
	}

	async elements(regions: readonly BrowserRegion[], limit: number): Promise<{ scroll: PageScroll; regions: PageElements[] }> {
		return await this.#activeTab().page.evaluate(ELEMENTS_IN_REGIONS_SCRIPT, [...regions], limit, {
			tag: MAX_ELEMENT_TAG_CHARS,
			id: MAX_ELEMENT_ID_CHARS,
			label: MAX_ELEMENT_LABEL_CHARS,
			count: MAX_ELEMENTS_PER_REGION,
		});
	}

	async scroll(): Promise<PageScroll> {
		return await this.#activeTab().page.evaluate(SCROLL_SCRIPT);
	}

	// -----------------------------------------------------------------------
	// Publish — reads with fixed scripts, and one guarded fill
	// -----------------------------------------------------------------------

	async fill(selector: string, text: string): Promise<void> {
		await withTimeout(this.#type(this.#activeTab().page, selector, text, true), ACTION_TIMEOUT_MS + 5_000, "fill");
	}

	// Publish reads: hasElement/readField/readText resolve the selector through
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

	async readText(selector: string, limit: number): Promise<string | null> {
		const handle = await this.#activeTab().page.$(selector);
		if (handle === null) return null;
		try {
			return await handle.evaluate(ELEMENT_TEXT_SCRIPT, limit);
		} finally {
			await handle.dispose().catch(() => undefined);
		}
	}

	async readLabel(selector: string, limit: number): Promise<string | null> {
		const handle = await this.#activeTab().page.$(selector);
		if (handle === null) return null;
		try {
			return await handle.evaluate(ELEMENT_LABEL_SCRIPT, limit);
		} finally {
			await handle.dispose().catch(() => undefined);
		}
	}

	async linkHrefs(selector: string, limit: number): Promise<string[]> {
		return await this.#activeTab().page.evaluate(LINK_HREFS_SCRIPT, selector, limit);
	}

	// waitFor and inspect read only: a selector or a substring is data, and the one script that runs is compiled in page-scripts.ts.
	async waitFor(condition: WaitCondition, timeoutMs: number, mask: (value: string) => string): Promise<boolean> {
		const tab = this.#activeTab();
		try {
			if ("selector" in condition) {
				const { frame, css } = aim(tab.page, condition.selector);
				const found = await frame.waitForSelector(css, { visible: true, timeout: Math.max(1, timeoutMs) });
				await found?.dispose().catch(() => undefined);
				return true;
			}
			// Text and URL are compared after masking: an unmasked match would tell the caller, a guess at a time, what a saved password is.
			const needle = "text" in condition ? condition.text : condition.url;
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				if (mask(await this.#waitSubject(tab, "text" in condition)).includes(needle)) return true;
				if (Date.now() >= deadline) return false;
				await sleep(SETTLE_POLL_MS * 5);
			}
		} catch (error) {
			if (error instanceof TimeoutError) return false;
			throw error;
		}
	}

	/** The page's text, or its current URL, for a wait to match. A document replaced mid-read is an empty read: the next poll sees the new one. */
	async #waitSubject(tab: Tab, text: boolean): Promise<string> {
		if (!text) {
			const history = await this.#read(() => tab.cdp.send("Page.getNavigationHistory"));
			return history.entries[history.currentIndex]?.url ?? "";
		}
		try {
			return await tab.page.evaluate(READ_TEXT_SCRIPT);
		} catch (error) {
			if (NAVIGATED_UNDER_READ.test(describe(error))) return "";
			throw error;
		}
	}

	async inspect(selector: string): Promise<ElementInspection | null> {
		const page = this.#activeTab().page;
		const { frame, css } = aim(page, selector);
		const handle = await frame.$(css);
		if (!handle) return null;
		try {
			const read = await handle.evaluate(INSPECT_SCRIPT);
			// An iframe's boxes are reported in main-viewport pixels, as a snapshot lists its controls.
			const offset = frame === page.mainFrame() ? null : await frameOffset(frame).catch(() => null);
			if (offset === null) return { found: true, ...read };
			const shift = (box: BrowserRegion): BrowserRegion => ({ ...box, x: Math.round((box.x + offset.x) * 100) / 100, y: Math.round((box.y + offset.y) * 100) / 100 });
			return { found: true, ...read, rect: shift(read.rect), parent: read.parent && shift(read.parent) };
		} finally {
			await handle.dispose().catch(() => undefined);
		}
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
	async perform(action: BrowserAction, password?: PasswordSource): Promise<PerformOutcome> {
		const tab = this.#activeTab();
		const seen = tab.dialogs.seq;
		const outcome = await withTimeout(this.#dispatch(action, password), NAVIGATE_TIMEOUT_MS + 5_000, `${action.kind}`);
		const dialogs = tab.dialogs.entries.filter((dialog) => dialog.seq > seen).map(({ type, message, handled }) => ({ type, message, handled }));
		return dialogs.length === 0 ? outcome : { ...outcome, dialogs };
	}

	async #dispatch(action: BrowserAction, password: PasswordSource | undefined): Promise<PerformOutcome> {
		const tab = this.#activeTab();
		const page = tab.page;
		const started = tab.navSeq;
		switch (action.kind) {
			case "navigate": {
				const url = requireField(action.url, "navigate.url");
				await navigating(tab, page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS }));
				return NONE;
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
				return NONE;
			}
			case "reload":
				await navigating(tab, page.reload({ waitUntil: "domcontentloaded", timeout: NAVIGATE_TIMEOUT_MS }));
				return NONE;
			case "stop":
				await tab.cdp.send("Page.stopLoading");
				tab.loading = false;
				return NONE;
			case "click": {
				const options = { button: action.button ?? "left", count: action.clickCount ?? 1 };
				if (action.selector === undefined) {
					const x = requireNumber(action.x, "click.x");
					const y = requireNumber(action.y, "click.y");
					this.#assertInViewport("click", x, y);
					await page.mouse.click(x, y, options);
				} else {
					const { handle } = await this.#resolve(page, action.selector);
					try {
						await handle.click(options);
					} finally {
						await handle.dispose().catch(() => undefined);
					}
				}
				await this.#settle(tab, started, true);
				return NONE;
			}
			case "hover": {
				const x = requireNumber(action.x, "hover.x");
				const y = requireNumber(action.y, "hover.y");
				this.#assertInViewport("hover", x, y);
				await page.mouse.move(x, y);
				return NONE;
			}
			case "insert":
				if (action.useSavedPassword || action.generatePassword) return await this.#typePassword(await this.#focusedField(page), action, password);
				// Whatever has focus receives the text as one native input operation.
				await page.keyboard.sendCharacter(requireField(action.text, "insert.text"));
				return NONE;
			case "type": {
				const selector = requireField(action.selector, "type.selector");
				if (action.useSavedPassword || action.generatePassword) return await this.#typePassword(await this.#resolve(page, selector), action, password);
				await this.#type(page, selector, requireField(action.text, "type.text", true), false);
				return NONE;
			}
			case "select": {
				const wanted = requireField(action.value, "select.value", true);
				const { handle } = await this.#resolve(page, requireField(action.selector, "select.selector"));
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
				return NONE;
			}
			case "press": {
				const key = requireField(action.key, "press.key");
				await page.keyboard.press(key as KeyInput);
				await this.#settle(tab, started, key === "Enter" || key === "Space" || key === " ");
				return NONE;
			}
			case "resize":
				await this.resize({ width: requireNumber(action.width, "resize.width"), height: requireNumber(action.height, "resize.height") }, this.#scale);
				return NONE;
			case "scroll":
				await page.mouse.wheel({ deltaX: action.deltaX ?? 0, deltaY: action.deltaY ?? 0 });
				return NONE;
			default:
				throw new ActionNotDispatched("bad_action", `unsupported action kind ${JSON.stringify((action as BrowserAction).kind)}`);
		}
	}

	/** A coordinate outside the viewport reaches no element: refused, with the way out. */
	#assertInViewport(kind: "click" | "hover", x: number, y: number): void {
		const { width, height } = this.#viewport;
		if (x >= 0 && y >= 0 && x < width && y < height) return;
		throw new ActionNotDispatched(
			"off_viewport",
			`${kind} at ${x},${y} is outside the ${width}x${height} viewport, so nothing was ${kind === "click" ? "clicked" : "hovered"}. Scroll it into view with browser_act scroll, then take a new browser_snapshot for its fresh coordinates.`,
		);
	}

	/**
	 * After input that can start a navigation: give one a moment to start (only
	 * for a click or Enter), then wait — bounded — for it to commit and finish
	 * loading, so the result names the page the input led to. Input that starts
	 * nothing costs only the grace.
	 */
	async #settle(tab: Tab, startedAt: number, mayStart: boolean): Promise<void> {
		if (mayStart) {
			const grace = Date.now() + NAVIGATION_GRACE_MS;
			while (tab.navSeq === startedAt && Date.now() < grace) await sleep(SETTLE_POLL_MS);
		}
		if (tab.navSeq !== startedAt) await this.#awaitLoad(tab);
	}

	async #awaitLoad(tab: Tab): Promise<void> {
		const deadline = Date.now() + SETTLE_MS;
		while (tab.loading && Date.now() < deadline) await sleep(SETTLE_POLL_MS);
	}

	/**
	 * A read that lost its document to a navigation is retried once, after the
	 * navigation has settled. Reading has no effect, so re-reading is safe.
	 */
	async #duringNavigation<T>(tab: Tab, read: () => Promise<T>): Promise<T> {
		try {
			return await read();
		} catch (error) {
			if (!NAVIGATED_UNDER_READ.test(describe(error))) throw error;
			await sleep(SETTLE_POLL_MS * 2);
			await this.#awaitLoad(tab);
			return await read();
		}
	}

	// -----------------------------------------------------------------------
	// Tabs
	// -----------------------------------------------------------------------

	async openTab(url?: string, options: OpenTabOptions = {}): Promise<TabRef> {
		this.#assertOpen();
		const fresh = options.reuseBlank === true ? this.#fresh : undefined;
		let tab: Tab;
		if (fresh !== undefined && !fresh.page.isClosed() && fresh.page.url() === "about:blank") {
			this.#fresh = undefined;
			tab = fresh;
			await this.#activate(tab);
		} else {
			const page = await this.#browser.newPage();
			const adopted = await this.#adopt(page.target(), true);
			if (!adopted) fail("tab_closed", "the new tab closed before it could be shown");
			tab = adopted;
		}
		if (options.dialogs !== undefined) tab.dialogs.policy = options.dialogs;
		if (url === undefined) return await this.#refOf(tab);
		await this.#goto(tab, url, options);
		// A tab opened at a URL starts there: the blank page it was born on is
		// not a place "back" should lead to.
		await tab.cdp.send("Page.resetNavigationHistory").catch(() => undefined);
		return await this.#refOf(tab);
	}

	async tabs(): Promise<TabRef[]> {
		this.#assertOpen();
		return await Promise.all(this.#tabs.map((tab) => this.#refOf(tab)));
	}

	async navigateTab(tabId: string, url: string, options: NavigateTabOptions): Promise<TabRef> {
		this.#assertOpen();
		const tab = this.#tabById(tabId);
		await this.#goto(tab, url, options);
		return await this.#refOf(tab);
	}

	setDialogPolicy(tabId: string, policy: DialogPolicy | undefined): void {
		this.#assertOpen();
		const dialogs = this.#tabById(tabId).dialogs;
		if (policy === undefined) delete dialogs.policy;
		else dialogs.policy = policy;
	}

	async setFrozen(tabId: string, frozen: boolean): Promise<void> {
		this.#assertOpen();
		const tab = this.#tabById(tabId);
		await withTimeout(tab.cdp.send("Page.setWebLifecycleState", { state: frozen ? "frozen" : "active" }), FREEZE_TIMEOUT_MS, frozen ? "freezing a tab" : "thawing a tab");
	}

	/**
	 * Load `url` in `tab` and wait for `options.waitUntil` (default domcontentloaded, the pack's own tab opens). A page that has not loaded when the
	 * budget ends or `options.signal` aborts is STOPPED rather than left loading, and the call rejects (the signal's reason when it was the signal).
	 */
	async #goto(tab: Tab, url: string, options: NavigateTabOptions): Promise<void> {
		const { waitUntil = "domcontentloaded", timeoutMs = NAVIGATE_TIMEOUT_MS, signal } = options;
		signal?.throwIfAborted();
		const navigation = navigating(tab, tab.page.goto(url, { waitUntil, timeout: timeoutMs }));
		if (signal === undefined) {
			await navigation;
			return;
		}
		const { promise: aborted, reject } = Promise.withResolvers<never>();
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			await Promise.race([navigation, aborted]);
		} catch (error) {
			navigation.catch(() => undefined);
			await tab.cdp.send("Page.stopLoading").catch(() => undefined);
			throw error;
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	/** Where the tab is, from the browser process alone (a renderer call stalls while a navigation commits). */
	async #refOf(tab: Tab): Promise<TabRef> {
		const history = await tab.cdp.send("Page.getNavigationHistory").catch(() => null);
		const entry = history?.entries[history.currentIndex];
		return { tabId: tab.id, targetId: targetIdOf(tab), url: entry?.url ?? tab.page.url(), title: entry?.title ?? "", active: tab === this.#active };
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
		this.#watchers.clear();
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

	/**
	 * Hard stop, for a `close` that hung. puppeteer's own close waits for the browser to exit with no bound, so a Chrome that will
	 * not exit never lets it finish: this kills the whole process tree instead, and releases the lease only once the browser
	 * process is seen to have exited. Safe beside a pending `close`: that one ends when the process does, and releasing is idempotent.
	 */
	async kill(): Promise<void> {
		if (!this.#ownsBrowser) return await this.close();
		this.#closed = true;
		this.#browser.off("targetcreated", this.#onTargetCreated);
		this.#browser.off("disconnected", this.#onDisconnected);
		this.#watchers.clear();
		const proc = this.#browser.process();
		if (proc === null) fail("kill_failed", "this browser has no process of ours to kill");
		if (!hasExited(this.#browser)) {
			const exited = waitForExit(proc, KILL_CONFIRM_MS);
			await killTree(proc);
			if (!(await exited)) fail("kill_failed", `the browser process ${proc.pid} was killed but was not seen to exit within ${KILL_CONFIRM_MS} ms`);
		}
		await this.#browser.disconnect().catch(() => undefined);
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
			// Guarded before `target.page()`: a popup that opens a dialog as it loads would block puppeteer's own setup of it forever.
			const early = await guardPage(await target.createCDPSession());
			const page = await target.page();
			if (!page || this.#closed || page.isClosed()) {
				await early.cdp.detach().catch(() => undefined);
				return undefined;
			}
			const tab = await prepareTab(page, this.#viewport, this.#scale, early);
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
			if (event.frameId !== tab.id) return;
			tab.loading = true;
			tab.navSeq += 1;
		};
		tab.cdp.on("Page.frameStartedLoading", start);
		tab.cdp.on("Page.frameRequestedNavigation", start);
		tab.cdp.on("Page.navigatedWithinDocument", (event) => {
			// A fragment or history.pushState navigation replaces no document and never "stops loading".
			if (event.frameId !== tab.id) return;
			tab.loading = false;
			this.#pageLoaded(tab);
		});
		tab.cdp.on("Page.downloadWillBegin", (event) => {
			// A link that downloads never replaces the document or stops loading it.
			if (event.frameId === tab.id) tab.loading = false;
		});
		tab.cdp.on("Page.frameStoppedLoading", (event) => {
			if (event.frameId !== tab.id) return;
			tab.loading = false;
			this.#loadFavicon(tab);
			this.#pageLoaded(tab);
		});
		tab.page.once("close", () => this.#forget(tab));
		watchPageLog(tab.page, (type, text) => {
			tab.log.push({ n: ++this.#logSeq, type, text });
			if (tab.log.length > MAX_LOG_ENTRIES) tab.log.shift();
		});
		this.#loadFavicon(tab);
	}

	/** The active tab's page finished loading or changed route: the runtime may look at it. A tab behind the active one is not what is shown. */
	#pageLoaded(tab: Tab): void {
		if (this.#closed || tab !== this.#active || this.#onPageLoaded === undefined) return;
		try {
			this.#onPageLoaded();
		} catch (error) {
			console.error("Page-loaded listener failed:", describe(error));
		}
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
		if (this.#watchers.size > 0) await this.#restartScreencast();
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
		if (this.#watchers.size > 0) {
			await this.#stopScreencast();
			await this.#restartScreencast();
		}
	}

	/** Cast the CURRENT active tab, stopping whatever was cast before, while anyone watches. Ordered. */
	#restartScreencast(): Promise<void> {
		const step = this.#castChain.then(async () => {
			const tab = this.#active;
			if (this.#cast?.tab === tab || this.#watchers.size === 0) return;
			await this.#stopScreencastNow();
			if (this.#closed || tab.page.isClosed()) return;
			const cast: Screencast = {
				tab,
				viewport: this.#viewport,
				frame: null,
				onFrame: (event) => {
					// Every picture is acknowledged, or Chrome stops sending them.
					void tab.cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
					if (this.#cast === cast) this.#emit(cast, Buffer.from(event.data, "base64"));
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
			void this.#stillIfNone(cast);
		});
		this.#castChain = step.catch(() => undefined);
		return step;
	}

	/** One picture to every watcher, and the newest one kept for a watcher who joins later. */
	#emit(cast: Screencast, jpeg: Uint8Array): void {
		const frame: LiveFrame = { id: `live-${cast.tab.id}-${++this.#frameSeq}`, jpeg, viewport: cast.viewport, capturedAt: Date.now() };
		cast.frame = frame;
		for (const listener of [...this.#watchers]) {
			try {
				listener(frame);
			} catch (error) {
				console.error("A live frame listener failed:", error);
			}
		}
	}

	/** A page that has not painted since the cast began sends nothing: capture one picture so the view is never blank. The cast's own picture wins when it comes first. */
	async #stillIfNone(cast: Screencast): Promise<void> {
		await sleep(FIRST_FRAME_WAIT_MS);
		if (cast.frame !== null || this.#cast !== cast) return;
		const shot = await this.#read(() => cast.tab.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: SCREENCAST_QUALITY })).catch(() => null);
		if (shot !== null && cast.frame === null && this.#cast === cast) this.#emit(cast, Buffer.from(shot.data, "base64"));
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
		const { handle } = await this.#resolve(page, selector);
		try {
			if (refusePassword && (await handle.evaluate(IS_PASSWORD_SCRIPT))) {
				throw new ActionNotDispatched("password_field", `${JSON.stringify(selector)} is a password field, which a publish never reads back; log in with browser_act or browser_task`);
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
				throw new ActionNotDispatched("password_field", `${JSON.stringify(selector)} has a password field focused, which a publish never reads back; nothing was typed`);
			}
			if (text.length > 0) await page.keyboard.sendCharacter(text);
			else await page.keyboard.press("Backspace");
		} finally {
			await handle.dispose().catch(() => undefined);
		}
	}

	/**
	 * `useSavedPassword` / `generatePassword`: REPLACE `field`'s content with
	 * the password `source` gives for the field's own frame origin. Every check
	 * runs in puppeteer's utility world, an isolated world page script cannot
	 * reach, so the page cannot fake its origin (`window.origin` is replaceable
	 * in its own world), a password type, or focus. The origin is the FRAME's,
	 * never the top page's, and a field that is not a password input is refused
	 * before `source` is asked, so nothing is minted for it. The final focus,
	 * the re-check of type, origin and focus, and the insert are ONE evaluate
	 * on the field (INSERT_PASSWORD_SCRIPT): the text is bound to that element's
	 * document, never page-wide input a page could redirect between a check and
	 * a keystroke. No password is an error, never a fallback. Every refusal is
	 * a certain non-event.
	 */
	async #typePassword(
		target: { handle: ElementHandle<Element>; frame: Frame },
		action: BrowserAction,
		source: PasswordSource | undefined,
	): Promise<PerformOutcome> {
		const { handle, frame } = target;
		const flag = action.generatePassword ? "generatePassword" : "useSavedPassword";
		let field: ElementHandle<Element> | null = null;
		try {
			if (!source) throw new ActionNotDispatched("bad_action", `${flag} needs the profile's password store`);
			field = await utilityWorld(frame).adoptHandle(handle);
			const before = await field.evaluate(SAVED_PASSWORD_TARGET_SCRIPT);
			if (!before.password) {
				throw new ActionNotDispatched("not_password_field", `${flag} types only into a password field (input type=password), and this field is not one; nothing was typed or saved`);
			}
			let value: string | undefined;
			try {
				value = source(before.origin);
			} catch (error) {
				throw error instanceof BrowserRuntimeError
					? new ActionNotDispatched(error.code, error.message)
					: new ActionNotDispatched("credentials_unreadable", describe(error));
			}
			if (!value) {
				throw new ActionNotDispatched("no_saved_password", `no saved password for ${before.origin}; for a sign-up pass generatePassword: true, or pass text`);
			}
			const inserted = await field.evaluate(INSERT_PASSWORD_SCRIPT, value, before.origin);
			if (inserted === "inserted") return { passwordOrigin: before.origin };
			if (inserted === "rejected") throw new ActionNotDispatched("not_password_field", "the password field refused the text; nothing was typed");
			throw new ActionNotDispatched("focus_moved", `the password field lost ${inserted === "not_password" ? "its password type" : inserted === "origin" ? "its origin" : "focus"} before typing; nothing was typed`);
		} finally {
			await field?.dispose().catch(() => undefined);
			await handle.dispose().catch(() => undefined);
		}
	}

	/**
	 * The element that has focus, in whichever frame holds it (cross-origin
	 * and out-of-process frames included), read in each frame's utility world.
	 * None, or an unreadable frame when none was found, is a certain non-event.
	 */
	async #focusedField(page: Page): Promise<{ handle: ElementHandle<Element>; frame: Frame }> {
		let unreadable: unknown = null;
		for (const frame of page.frames()) {
			if (frame.detached) continue;
			try {
				const found = await utilityWorld(frame).evaluateHandle(FOCUSED_LEAF_SCRIPT);
				const element = found.asElement();
				if (element) return { handle: element as ElementHandle<Element>, frame };
				await found.dispose();
			} catch (error) {
				unreadable ??= error;
			}
		}
		const why = unreadable === null ? "" : ` (${describe(unreadable)})`;
		throw new ActionNotDispatched("no_focus", `no field has focus; click the password field first, or type into it by selector${why}; nothing was typed`);
	}

	/**
	 * Resolve `selector` — plain, or `@<ref> <css>` for a child frame — to an
	 * element and the frame it is in. Element resolution is read-only, so a
	 * miss here is a certain non-event.
	 */
	async #resolve(page: Page, selector: string): Promise<{ handle: ElementHandle<Element>; frame: Frame }> {
		const { frame, css, tag } = aim(page, selector);
		const handle = await frame.waitForSelector(css, { timeout: ACTION_TIMEOUT_MS }).catch(() => null);
		if (!handle) throw new ActionNotDispatched("no_element", `selector ${JSON.stringify(selector)} did not resolve to an element`);
		// The wait can outlast a navigation of that frame to another site.
		if (tag !== null && (frame.detached || frameTag(frame) !== tag)) {
			await handle.dispose().catch(() => undefined);
			throw frameChanged(selector);
		}
		return { handle, frame };
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

/** Resolves true once `proc` has exited (at once when it already has), false if it has not within `ms`. */
function waitForExit(proc: ChildProcess, ms: number): Promise<boolean> {
	if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const onExit = (): void => {
		clearTimeout(timer);
		resolve(true);
	};
	const timer = setTimeout(() => {
		proc.off("exit", onExit);
		resolve(false);
	}, ms);
	proc.once("exit", onExit);
	return promise;
}

const execFileAsync = promisify(execFile);

/**
 * The `taskkill` arguments that end `proc` and everything it started, or undefined when there is nothing to end. A pid names a
 * process only while it is running: once `proc` has exited the number may already belong to an unrelated program, so an exited
 * process gets no command at all, and the image filter makes a number that was reused by a program of another name match nothing.
 * `/T` still takes the whole tree below a match, whatever the children are called (crashpad, GPU and renderer helpers).
 */
export function taskkillArgs(proc: Pick<ChildProcess, "pid" | "spawnfile" | "exitCode" | "signalCode">): string[] | undefined {
	if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return undefined;
	return ["/pid", String(proc.pid), "/T", "/F", "/FI", `IMAGENAME eq ${win32.basename(proc.spawnfile)}`];
}

/**
 * Kill `proc` and everything it started. Windows: `taskkill /T` (killing only the browser process leaves its helpers running).
 * Elsewhere: the process group, which puppeteer makes Chrome the leader of, then the process itself if the group could not be signalled.
 */
async function killTree(proc: ChildProcess): Promise<void> {
	const pid = proc.pid;
	if (pid === undefined) return;
	if (process.platform === "win32") {
		// Decided here, right before the command starts: the process may have exited since the caller looked.
		const args = taskkillArgs(proc);
		if (args !== undefined) await execFileAsync("taskkill", args, { windowsHide: true }).catch(() => proc.kill());
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		proc.kill("SIGKILL");
	}
}

/**
 * puppeteer's per-frame utility world: an isolated world, so page script can
 * reach neither its globals nor its prototypes. `isolatedRealm()` and
 * `adoptHandle()` are on every CDP frame of the pinned puppeteer-core but
 * marked internal, so they are typed here.
 */
interface UtilityWorld {
	adoptHandle<T extends ElementHandle<Element>>(handle: T): Promise<T>;
	evaluateHandle<R>(fn: () => R): Promise<JSHandle<R>>;
}
function utilityWorld(frame: Frame): UtilityWorld {
	// Reason: internal API of the pinned puppeteer-core (see UtilityWorld).
	return (frame as unknown as { isolatedRealm(): UtilityWorld }).isolatedRealm();
}

/**
 * The active page's child frames, depth first, each with its `@<ref>`: the
 * 1-based child-index path, `~`, and the frame's tag. Bounded.
 */
function childFrames(page: Page): Array<{ frame: Frame; ref: string }> {
	const out: Array<{ frame: Frame; ref: string }> = [];
	const walk = (parent: Frame, prefix: string): void => {
		parent.childFrames().forEach((frame, i) => {
			if (out.length >= MAX_SNAPSHOT_FRAMES || frame.detached) return;
			const path = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
			out.push({ frame, ref: `${path}~${frameTag(frame)}` });
			walk(frame, path);
		});
	};
	walk(page.mainFrame(), "");
	return out;
}

/**
 * A short tag of a frame's identity (the browser's frame id) and its current
 * origin, both as the browser reports them, never as the page claims: the
 * same iframe navigated to another site gets a different tag.
 */
function frameTag(frame: Frame): string {
	let origin = "null";
	try {
		origin = new URL(frame.url()).origin;
	} catch {
		// No URL yet: the origin stays "null".
	}
	// `_id` (the CDP frame id) is on every frame of the pinned puppeteer-core, but stripped from its public types.
	if (!("_id" in frame) || typeof frame._id !== "string") throw new Error("puppeteer-core frames carry no _id; frame refs cannot be tagged");
	return createHash("sha256").update(`${frame._id}\n${origin}`).digest("hex").slice(0, 8);
}

function frameChanged(selector: string): ActionNotDispatched {
	const ref = selector.split(/\s/, 1)[0];
	return new ActionNotDispatched("no_frame", `frame changed (${ref} no longer names the frame the snapshot described); take a new browser_snapshot`);
}

/**
 * The frame a `@<path>~<tag>` names, only while it is still the frame the
 * snapshot tagged; anything else is a certain non-event.
 */
function frameAt(page: Page, path: string, tag: string): Frame {
	let frame = page.mainFrame();
	for (const step of path.split(".")) {
		const next = frame.childFrames()[Number(step) - 1];
		if (!next || next.detached) throw frameChanged(`@${path}~${tag}`);
		frame = next;
	}
	if (frameTag(frame) !== tag) throw frameChanged(`@${path}~${tag}`);
	return frame;
}

/**
 * The frame a selector aims at and the CSS to run there: the main frame for a
 * plain selector, a child frame for `@<ref> <css>` (`tag` is that ref's
 * identity tag, to re-check after any wait). A stale or hand-written ref is
 * refused before anything runs.
 */
function aim(page: Page, selector: string): { frame: Frame; css: string; tag: string | null } {
	const aimed = FRAME_SELECTOR.exec(selector);
	if (!aimed && FRAME_REF_LIKE.test(selector)) throw frameChanged(selector);
	if (!aimed) return { frame: page.mainFrame(), css: selector, tag: null };
	return { frame: frameAt(page, aimed[1] as string, aimed[2] as string), css: aimed[3] as string, tag: aimed[2] as string };
}

/** Where a child frame's content box starts in the main viewport, or null when it has no box (not rendered). */
async function frameOffset(frame: Frame): Promise<{ x: number; y: number } | null> {
	const element = await frame.frameElement();
	if (!element) return null;
	try {
		const box = await element.boundingBox();
		if (!box || box.width <= 0 || box.height <= 0) return null;
		const inset = await element.evaluate(FRAME_INSET_SCRIPT);
		return { x: box.x + inset.x, y: box.y + inset.y };
	} finally {
		await element.dispose().catch(() => undefined);
	}
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
