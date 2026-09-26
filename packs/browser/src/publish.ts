/**
 * Publishing — the agent fills, the HUMAN confirms, the page is the receipt.
 *
 * A recipe (data from the caller; the pack knows no platform) names the
 * compose page, a signed-in marker, the fields, the submit control and how the
 * posted URL shows up. `prepare` navigates, checks sign-in, types each field
 * and reads it back, then PARKS the publish: nothing is submitted until the
 * human presses Post in the Browser View (`confirm`), which re-verifies the
 * page, clicks submit exactly once and reads the receipt URL from the page.
 *
 * Hard lines, enforced here and in the driver:
 *  - never type into a password input (checked before typing, on the element);
 *  - never touch the credential store; a signed-out profile is reported, and
 *    the human signs in by hand;
 *  - submit exactly once, never retried: an error after dispatch is `unknown`;
 *  - the receipt URL comes only from the page, on the recipe's origin, its
 *    pathname matching the recipe's path template, and never something
 *    already there before submit;
 *  - confirm submits only on the very tab and URL the human was shown;
 *  - page content never chooses a selector or a URL.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { PublishCheck, PublishField, PublishMode, PublishRecipe, PublishRecord, PublishStatus } from "./contracts.js";
import { PUBLISH_MODES } from "./contracts.js";
import type { EngineDriver } from "./engines/types.js";
import { ActionNotDispatched, fail } from "./store.js";

const MAX_FIELDS = 8;
const MAX_VALUE_CHARS = 10_000;
const MAX_LABEL_CHARS = 40;
const MAX_SELECTOR_CHARS = 512;
const MAX_PATH_CHARS = 256;
const MAX_URL_CHARS = 2_048;
/** Receipt links read per snapshot; filtered by origin and path here, never in the page. */
const MAX_RECEIPT_LINKS = 5_000;
const SIGNED_IN_WAIT_MS = 15_000;
const RECEIPT_WAIT_MS = 20_000;
/** How long a parked publish waits for the human. */
export const PUBLISH_PENDING_MS = 10 * 60_000;
const POLL_MS = 250;
/** `http:` is allowed only here, for local fixtures and apps. */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost"];
const TERMINAL: readonly PublishStatus[] = ["posted", "unknown", "failed", "cancelled", "expired"];
/** Every outcome that would otherwise say "nothing was posted", once the human used the page while waiting. */
const TOUCHED_ERROR = "The page was used in the Browser View while waiting, so it may have posted there. Check the account.";
/** The same, on an engine whose page the human can use outside the runtime (chrome-relay). */
const SHARED_ERROR = "This page is in your own Chrome, where it can be used outside the Browser View, so it may have posted there. Check the account.";

/** A validated recipe, with its receipt path template compiled once. */
export interface Recipe extends PublishRecipe {
	/** Matches a receipt URL's pathname against `receipt.path`, in linear time. */
	matchesPath: (pathname: string) => boolean;
}

/** A parked publish: the record the human sees, and the recipe confirm needs (never shown). */
export interface Publication {
	record: PublishRecord;
	recipe: Recipe;
	/** Set once confirm starts: expiry never overtakes a submit already under way. */
	confirming: boolean;
	/**
	 * The human clicked or typed on the pinned tab in the Browser View while
	 * waiting (or the engine lets them use the page outside the runtime): they
	 * may have hit the site's own submit, so confirm never clicks submit and
	 * every outcome that would say "nothing was posted" is `unknown` instead.
	 */
	touchedWhilePending: boolean;
	/**
	 * The engine lets the human use this page outside the runtime (chrome-relay:
	 * their own Chrome), so they may have posted there unseen. The bar's Post
	 * still clicks submit, but every outcome that would say "nothing was
	 * posted" (cancel, close, expiry, changed since shown) is `unknown`.
	 */
	sharedPage: boolean;
	/** Resolves when the record reaches a terminal status. */
	settled: PromiseWithResolvers<void>;
}

// ---------------------------------------------------------------------------
// Validation — before anything touches the page
// ---------------------------------------------------------------------------

export function validateMode(mode: unknown): PublishMode {
	const found = PUBLISH_MODES.find((candidate) => candidate === mode);
	if (!found) fail("bad_mode", `mode must be one of: ${PUBLISH_MODES.join(", ")}`);
	return found;
}

export function validateRecipe(input: PublishRecipe): Recipe {
	if (!isObject(input)) fail("bad_recipe", "recipe must be an object");
	const origin = parseOrigin(input.origin);
	const compose = parseUrl(input.composeUrl, "composeUrl");
	if (compose.origin !== origin) fail("bad_recipe", `composeUrl must be on ${origin}, got ${compose.origin}`);
	if (!Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > MAX_FIELDS) {
		fail("bad_recipe", `fields must hold 1-${MAX_FIELDS} entries`);
	}
	const fields = input.fields.map((field, index): PublishField => {
		if (!isObject(field)) fail("bad_recipe", `fields[${index}] must be an object`);
		if (typeof field.value !== "string" || field.value.length > MAX_VALUE_CHARS) {
			fail("bad_recipe", `fields[${index}].value must be a string of at most ${MAX_VALUE_CHARS} characters`);
		}
		if (field.label !== undefined && (typeof field.label !== "string" || field.label.trim().length === 0 || field.label.length > MAX_LABEL_CHARS)) {
			fail("bad_recipe", `fields[${index}].label must be a non-empty string of at most ${MAX_LABEL_CHARS} characters`);
		}
		return {
			selector: selector(field.selector, `fields[${index}].selector`),
			value: field.value,
			...(field.label === undefined ? {} : { label: field.label.trim() }),
		};
	});
	const receipt = input.receipt;
	if (!isObject(receipt)) fail("bad_recipe", "receipt must be an object");
	const path = receiptPath(receipt.path);
	return {
		origin,
		composeUrl: compose.href,
		signedIn: selector(input.signedIn, "signedIn"),
		fields,
		submit: selector(input.submit, "submit"),
		receipt: {
			path,
			...(receipt.linkSelector === undefined ? {} : { linkSelector: selector(receipt.linkSelector, "receipt.linkSelector") }),
		},
		matchesPath: compilePath(path),
	};
}

const PLACEHOLDERS: Readonly<Record<string, string>> = { segment: "[^/]+", digits: "[0-9]+" };
/** A `{name}` placeholder, a stray brace, or a regex metacharacter to escape. */
const TEMPLATE_TOKEN = /\{([^{}]*)\}|[{}]|[.*+?^$()|[\]\\]/g;

function receiptPath(value: unknown): string {
	if (typeof value !== "string" || !value.startsWith("/") || value.length > MAX_PATH_CHARS) {
		fail("bad_recipe", `receipt.path must start with "/" and be at most ${MAX_PATH_CHARS} characters`);
	}
	return value;
}

/**
 * Compile a receipt path template to an anchored matcher over a pathname.
 * Literal text is regex-escaped; `{segment}` and `{digits}` become classes
 * that cannot cross "/", at most one per segment. Each placeholder is followed
 * by a fixed literal up to the next "/" (or the end), so it has at most one
 * end where the rest can match: matching is linear in the pathname.
 */
export function compilePath(path: string): (pathname: string) => boolean {
	const segments = path.split("/").map((segment, index) => {
		let placeholders = 0;
		const source = segment.replace(TEMPLATE_TOKEN, (token, placeholder: string | undefined) => {
			if (placeholder === undefined) {
				if (token === "{" || token === "}") fail("bad_recipe", `receipt.path has an unmatched brace in segment ${index}`);
				return `\\${token}`;
			}
			// Own keys only: `{constructor}` must not find Object.prototype.
			const pattern = Object.hasOwn(PLACEHOLDERS, placeholder) ? PLACEHOLDERS[placeholder] : undefined;
			if (pattern === undefined) fail("bad_recipe", `receipt.path placeholder {${placeholder}} is unknown; use {segment} or {digits}`);
			placeholders += 1;
			return pattern;
		});
		if (placeholders > 1) fail("bad_recipe", "receipt.path allows at most one placeholder per segment");
		return source;
	});
	const pattern = new RegExp(`^${segments.join("/")}$`);
	return (pathname) => pattern.test(pathname);
}

function parseOrigin(value: unknown): string {
	const url = parseUrl(value, "origin");
	if (url.pathname !== "/" || url.search !== "" || url.hash !== "") fail("bad_recipe", `origin must be a bare origin such as https://example.com`);
	return url.origin;
}

function parseUrl(value: unknown, name: string): URL {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_CHARS) {
		fail("bad_recipe", `${name} must be a URL of at most ${MAX_URL_CHARS} characters`);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		fail("bad_recipe", `${name} ${JSON.stringify(value)} is not an absolute URL`);
	}
	if (url.username || url.password) fail("bad_recipe", `${name} must not carry credentials`);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))) {
		fail("bad_recipe", `${name} must be https (http only for 127.0.0.1 and localhost)`);
	}
	return url;
}

function selector(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_SELECTOR_CHARS) {
		fail("bad_recipe", `${name} must be a non-empty CSS selector of at most ${MAX_SELECTOR_CHARS} characters`);
	}
	return value.trim();
}

// ---------------------------------------------------------------------------
// check / post — never submits
// ---------------------------------------------------------------------------

/**
 * Navigate to the compose page and wait for the signed-in marker ON the
 * recipe's origin. `check` stops there; `post` fills and verifies every field
 * and returns the parked publication. A signed-out profile types nothing.
 */
export async function prepare(driver: EngineDriver, profile: string, recipe: Recipe, mode: PublishMode): Promise<PublishCheck | Publication> {
	try {
		await driver.perform({ kind: "navigate", url: recipe.composeUrl });
	} catch (error) {
		return { status: "failed", url: await currentUrl(driver), profile, error: `could not open the compose page: ${describe(error)}` };
	}
	const deadline = Date.now() + SIGNED_IN_WAIT_MS;
	let signedIn = false;
	while (!signedIn) {
		signedIn = originOf(await currentUrl(driver)) === recipe.origin && (await driver.hasElement(recipe.signedIn).catch(() => false));
		if (signedIn || Date.now() >= deadline) break;
		await sleep(POLL_MS);
	}
	const url = await currentUrl(driver);
	if (!signedIn) return { status: "not-signed-in", url, profile };
	if (mode === "check") return { status: "signed-in", url, profile };

	for (const field of recipe.fields) {
		const failed = (error: string): PublishCheck => ({ status: "failed", url, profile, error: `${error}; nothing was submitted` });
		const before = await driver.readField(field.selector).catch((error) => ({ state: "error" as const, error }));
		if (before.state === "error") return failed(`could not read ${JSON.stringify(field.selector)}: ${describe(before.error)}`);
		if (before.state === "absent") return failed(`${JSON.stringify(field.selector)} is not on the page`);
		if (before.state === "password") return failed(`${JSON.stringify(field.selector)} is a password field; publishing never types into one`);
		if (before.state === "not-editable") return failed(`${JSON.stringify(field.selector)} is not an input, textarea or editable element`);
		try {
			await driver.fill(field.selector, field.value);
		} catch (error) {
			return failed(`typing into ${JSON.stringify(field.selector)} failed: ${describe(error)}`);
		}
		const after = await driver.readField(field.selector).catch(() => null);
		if (after?.state !== "value" || after.value !== field.value) {
			return failed(`field-mismatch: ${JSON.stringify(field.selector)} does not read back the exact value typed`);
		}
	}
	// Where the human is about to be shown the values: this tab, this URL. Confirm submits only there.
	const shown = await driver.state().catch(() => null);
	if (!shown || originOf(shown.url) !== recipe.origin) {
		return { status: "failed", url: shown?.url ?? url, profile, error: `the tab left ${recipe.origin} while typing; nothing was submitted` };
	}
	const now = Date.now();
	return {
		record: {
			publishId: randomBytes(16).toString("hex"),
			status: "awaiting-confirmation",
			origin: recipe.origin,
			composeUrl: shown.url,
			tabId: shown.activeTabId,
			profile,
			fields: recipe.fields.map((field) => ({ ...field })),
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + PUBLISH_PENDING_MS).toISOString(),
		},
		recipe,
		confirming: false,
		touchedWhilePending: false,
		sharedPage: false,
		settled: Promise.withResolvers<void>(),
	};
}

// ---------------------------------------------------------------------------
// confirm — the human's Post
// ---------------------------------------------------------------------------

/** The pending publication `publishId`, or a refusal naming why it cannot be acted on. */
export function requirePending(publication: Publication | null, publishId: string): Publication {
	if (!publication || publication.record.publishId !== publishId) fail("unknown_publish", "no such publish on this browser");
	expireIfDue(publication);
	const { status } = publication.record;
	if (status !== "awaiting-confirmation" || publication.confirming) {
		fail("publish_not_pending", `this publish is ${publication.confirming ? "already being confirmed" : status}`);
	}
	return publication;
}

/**
 * Re-verify, click submit exactly once, read the receipt. Always settles the
 * publication; never throws for a page outcome.
 */
export async function confirm(driver: EngineDriver, publication: Publication): Promise<void> {
	publication.confirming = true;
	const { recipe } = publication;
	try {
		// The human used the page while waiting and may have pressed the site's own
		// submit; a site that keeps the text afterwards would look unchanged, so a
		// click here could post twice. Never click: report it honestly instead.
		if (publication.touchedWhilePending) return settle(publication, "unknown", { error: TOUCHED_ERROR });
		const changed = await changedSinceShown(driver, publication);
		if (changed) {
			if (publication.sharedPage) return settle(publication, "unknown", { error: SHARED_ERROR });
			return settle(publication, "failed", { error: `changed since shown: ${changed}; nothing was submitted` });
		}
		// What already looks like a receipt is not one: it predates this submit.
		const before = new Set(await receipts(driver, recipe).catch(() => []));
		try {
			await driver.perform({ kind: "click", selector: recipe.submit });
		} catch (error) {
			if (error instanceof ActionNotDispatched) {
				return settle(publication, "failed", { error: `submit was not clicked: ${describe(error)}; nothing was submitted` });
			}
			return settle(publication, "unknown", { error: `submit was clicked, then errored, so it may have posted; never retried (${describe(error)})` });
		}
		const deadline = Date.now() + RECEIPT_WAIT_MS;
		while (Date.now() < deadline) {
			const found = (await receipts(driver, recipe).catch(() => [])).find((url) => !before.has(url));
			if (found) return settle(publication, "posted", { url: found });
			await sleep(POLL_MS);
		}
		settle(publication, "unknown", { error: "submitted, but no receipt was seen, so it may have posted; never retried" });
	} catch (error) {
		// Reached only by a fault outside the submit's own try: the click may have landed.
		settle(publication, "unknown", { error: `publishing errored, so it may have posted; never retried (${describe(error)})` });
	}
}

/** Why the page no longer matches what the human was shown, or null. */
async function changedSinceShown(driver: EngineDriver, publication: Publication): Promise<string | null> {
	try {
		const state = await driver.state();
		if (state.activeTabId !== publication.record.tabId) return "another tab is active";
		if (state.url !== publication.record.composeUrl) return `the tab is no longer on ${publication.record.composeUrl}`;
		for (const field of publication.record.fields) {
			const read = await driver.readField(field.selector);
			if (read.state !== "value" || read.value !== field.value) return `${JSON.stringify(field.selector)} no longer holds the value shown`;
		}
		return null;
	} catch (error) {
		return `the page could not be re-read (${describe(error)})`;
	}
}

/**
 * Receipt candidates now on the page: on the origin, pathname matching the
 * recipe's template, in page order. Every link is read (bounded) and filtered
 * here, so a page cannot push the real receipt out of a small window.
 */
async function receipts(driver: EngineDriver, recipe: Recipe): Promise<string[]> {
	const candidates = recipe.receipt.linkSelector === undefined
		? [(await driver.state()).url]
		: await driver.linkHrefs(recipe.receipt.linkSelector, MAX_RECEIPT_LINKS);
	return candidates.filter((url) => url.length <= MAX_URL_CHARS && isReceipt(url, recipe));
}

function isReceipt(url: string, recipe: Recipe): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	return parsed.origin === recipe.origin && recipe.matchesPath(parsed.pathname);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** The human's Cancel, or the browser closing under a pending publish. */
export function cancel(publication: Publication, error?: string): void {
	const unsure = unsureError(publication);
	if (unsure) settle(publication, "unknown", { error: unsure });
	else settle(publication, "cancelled", error === undefined ? {} : { error });
}

/** An unconfirmed publish past its deadline is `expired` — terminal; confirm is refused after it. */
export function expireIfDue(publication: Publication): void {
	if (publication.record.status !== "awaiting-confirmation" || publication.confirming) return;
	if (Date.now() < Date.parse(publication.record.expiresAt)) return;
	const unsure = unsureError(publication);
	if (unsure) settle(publication, "unknown", { error: unsure });
	else settle(publication, "expired", { error: "not confirmed within 10 minutes" });
}

/** Why an outcome that would say "nothing was posted" cannot, or null when it can. */
function unsureError(publication: Publication): string | null {
	if (publication.touchedWhilePending) return TOUCHED_ERROR;
	return publication.sharedPage ? SHARED_ERROR : null;
}

/** Resolve once the publication is terminal or `ms` has passed (or it expires), whichever is first. */
export async function waitSettled(publication: Publication, ms: number): Promise<void> {
	expireIfDue(publication);
	if (TERMINAL.includes(publication.record.status)) return;
	const untilExpiry = Date.parse(publication.record.expiresAt) - Date.now();
	const { promise: elapsed, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, Math.max(0, publication.confirming ? ms : Math.min(ms, untilExpiry)));
	await Promise.race([publication.settled.promise, elapsed]);
	clearTimeout(timer);
	expireIfDue(publication);
}

/** A copy of the record, with expiry applied. */
export function publishRecord(publication: Publication): PublishRecord {
	expireIfDue(publication);
	const { record } = publication;
	return { ...record, fields: record.fields.map((field) => ({ ...field })) };
}

export function isPending(publication: Publication | null): boolean {
	if (!publication) return false;
	expireIfDue(publication);
	return publication.record.status === "awaiting-confirmation";
}

function settle(publication: Publication, status: Exclude<PublishStatus, "awaiting-confirmation">, detail: { url?: string; error?: string }): void {
	if (TERMINAL.includes(publication.record.status)) return;
	Object.assign(publication.record, { status }, detail);
	publication.confirming = false;
	publication.settled.resolve();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function currentUrl(driver: EngineDriver): Promise<string> {
	return (await driver.state().catch(() => null))?.url ?? "";
}

function originOf(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
