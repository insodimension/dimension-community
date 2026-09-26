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
 *  - the receipt URL comes only from the page, on the recipe's origin, matching
 *    its pattern, and never something already there before submit;
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
const MAX_SELECTOR_CHARS = 512;
const MAX_PATTERN_CHARS = 512;
const MAX_URL_CHARS = 2_048;
const MAX_RECEIPT_LINKS = 50;
const SIGNED_IN_WAIT_MS = 15_000;
const RECEIPT_WAIT_MS = 20_000;
/** How long a parked publish waits for the human. */
export const PUBLISH_PENDING_MS = 10 * 60_000;
const POLL_MS = 250;
/** `http:` is allowed only here, for local fixtures and apps. */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost"];
const TERMINAL: readonly PublishStatus[] = ["posted", "unknown", "failed", "cancelled", "expired"];

/** A validated recipe, with its receipt pattern compiled once. */
export interface Recipe extends PublishRecipe {
	pattern: RegExp;
}

/** A parked publish: the record the human sees, and the recipe confirm needs (never shown). */
export interface Publication {
	record: PublishRecord;
	recipe: Recipe;
	/** Set once confirm starts: expiry never overtakes a submit already under way. */
	confirming: boolean;
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
		return { selector: selector(field.selector, `fields[${index}].selector`), value: field.value };
	});
	const receipt = input.receipt;
	if (!isObject(receipt)) fail("bad_recipe", "receipt must be an object");
	if (typeof receipt.urlPattern !== "string" || receipt.urlPattern.length === 0 || receipt.urlPattern.length > MAX_PATTERN_CHARS) {
		fail("bad_recipe", `receipt.urlPattern must be a regex source of 1-${MAX_PATTERN_CHARS} characters`);
	}
	let pattern: RegExp;
	try {
		pattern = new RegExp(receipt.urlPattern);
	} catch (error) {
		fail("bad_recipe", `receipt.urlPattern does not compile: ${describe(error)}`);
	}
	return {
		origin,
		composeUrl: compose.href,
		signedIn: selector(input.signedIn, "signedIn"),
		fields,
		submit: selector(input.submit, "submit"),
		receipt: {
			urlPattern: receipt.urlPattern,
			...(receipt.linkSelector === undefined ? {} : { linkSelector: selector(receipt.linkSelector, "receipt.linkSelector") }),
		},
		pattern,
	};
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
	const now = Date.now();
	return {
		record: {
			publishId: randomBytes(16).toString("hex"),
			status: "awaiting-confirmation",
			origin: recipe.origin,
			profile,
			fields: recipe.fields.map((field) => ({ ...field })),
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + PUBLISH_PENDING_MS).toISOString(),
		},
		recipe,
		confirming: false,
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
		const changed = await changedSinceShown(driver, publication);
		if (changed) return settle(publication, "failed", { error: `changed since shown: ${changed}; nothing was submitted` });
		// What already looks like a receipt is not one: it predates this submit.
		const before = new Set(await receipts(driver, recipe).catch(() => []));
		try {
			await driver.perform({ kind: "click", selector: recipe.submit });
		} catch (error) {
			if (error instanceof ActionNotDispatched) {
				return settle(publication, "failed", { error: `submit was not clicked: ${describe(error)}; nothing was submitted` });
			}
			return settle(publication, "unknown", { error: `submit was clicked, then errored — it may have posted; never retried (${describe(error)})` });
		}
		const deadline = Date.now() + RECEIPT_WAIT_MS;
		while (Date.now() < deadline) {
			const found = (await receipts(driver, recipe).catch(() => [])).find((url) => !before.has(url));
			if (found) return settle(publication, "posted", { url: found });
			await sleep(POLL_MS);
		}
		settle(publication, "unknown", { error: "submitted, no receipt seen — it may have posted; never retried" });
	} catch (error) {
		// Reached only by a fault outside the submit's own try: the click may have landed.
		settle(publication, "unknown", { error: `publishing errored — it may have posted; never retried (${describe(error)})` });
	}
}

/** Why the page no longer matches what the human was shown, or null. */
async function changedSinceShown(driver: EngineDriver, publication: Publication): Promise<string | null> {
	try {
		const url = (await driver.state()).url;
		if (originOf(url) !== publication.recipe.origin) return `the tab left ${publication.recipe.origin}`;
		for (const field of publication.record.fields) {
			const read = await driver.readField(field.selector);
			if (read.state !== "value" || read.value !== field.value) return `${JSON.stringify(field.selector)} no longer holds the value shown`;
		}
		return null;
	} catch (error) {
		return `the page could not be re-read (${describe(error)})`;
	}
}

/** Receipt candidates now on the page: on the origin, matching the pattern, in page order. */
async function receipts(driver: EngineDriver, recipe: Recipe): Promise<string[]> {
	const candidates = recipe.receipt.linkSelector === undefined
		? [(await driver.state()).url]
		: await driver.linkHrefs(recipe.receipt.linkSelector, MAX_RECEIPT_LINKS);
	return candidates.filter((url) => url.length <= MAX_URL_CHARS && originOf(url) === recipe.origin && recipe.pattern.test(url));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function cancel(publication: Publication): void {
	settle(publication, "cancelled", {});
}

/** An unconfirmed publish past its deadline is `expired` — terminal; confirm is refused after it. */
export function expireIfDue(publication: Publication): void {
	if (publication.record.status !== "awaiting-confirmation" || publication.confirming) return;
	if (Date.now() >= Date.parse(publication.record.expiresAt)) settle(publication, "expired", { error: "not confirmed within 10 minutes" });
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
