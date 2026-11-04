/**
 * Publishing — the agent fills, one confirm posts, the page is the receipt.
 *
 * A recipe (data from the caller; the pack knows no platform) names the
 * compose page, a signed-in marker, the fields, the submit control and how the
 * posted URL shows up. `prepare` navigates, checks sign-in, types each field
 * and reads it back, then PARKS the publish: nothing is submitted until a
 * confirm (the model's `browser_publish_confirm`, or the Post button in the
 * Browser View), which re-verifies the page, clicks submit exactly once and
 * reads the receipt URL from the page.
 *
 * Hard lines, enforced here and in the driver:
 *  - a password input is never a publish field (checked before typing, on the
 *    element): its value is never read, so a readback could not verify it.
 *    Logging in is browser_act's or browser_task's job, not publish's;
 *  - never touch the credential store; a signed-out profile is reported;
 *  - submit exactly once, never retried: an error after dispatch is `unknown`;
 *  - the receipt URL comes only from the page, on the recipe's origin, its
 *    pathname matching the recipe's path template, and never something
 *    already there before submit;
 *  - confirm submits only on the very tab and URL shown in the View;
 *  - page content never chooses a selector or a URL.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { accountFromText } from "./connection.js";
import type { EffectGuard, PublishCheck, PublishField, PublishFile, PublishMode, PublishRecipe, PublishRecord, PublishStatus, PublishStep } from "./contracts.js";
import { PUBLISH_MODES } from "./contracts.js";
import type { EngineDriver } from "./engines/types.js";
import { type LocalFile, requireAbsolutePath, requireUnchanged } from "./files.js";
import type { Spend } from "./publish-approval.js";
import { ActionNotDispatched, fail } from "./store.js";

const MAX_FIELDS = 8;
const MAX_FILES = 4;
const MAX_STEPS = 32;
const DEFAULT_STEP_WAIT_MS = 15_000;
const MAX_STEP_WAIT_MS = 60_000;
const MAX_VALUE_CHARS = 10_000;
const MAX_LABEL_CHARS = 40;
const MAX_SELECTOR_CHARS = 512;
const MAX_PATH_CHARS = 256;
const MAX_URL_CHARS = 2_048;
/** Receipt links read per snapshot; filtered by origin and path here, never in the page. */
const MAX_RECEIPT_LINKS = 5_000;
const SIGNED_IN_WAIT_MS = 15_000;
/** Characters of the account element's text read; a handle is far shorter. */
const MAX_ACCOUNT_TEXT_CHARS = 512;
const RECEIPT_WAIT_MS = 20_000;
/** How long a parked publish waits for a confirm. */
export const PUBLISH_PENDING_MS = 10 * 60_000;
const POLL_MS = 250;
/** `http:` is allowed only here, for local fixtures and apps. */
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost"];
const TERMINAL: readonly PublishStatus[] = ["posted", "unknown", "failed", "cancelled", "expired"];
/** Every outcome that would otherwise say "nothing was posted", once the human used the page while waiting. */
const TOUCHED_ERROR = "The page was used in the Browser View while waiting, so it may have posted there. Check the account.";
/** The same, on an engine whose page the human can use outside the runtime (chrome-relay). */
const SHARED_ERROR = "This page is in your own Chrome, where it can be used outside the Browser View, so it may have posted there. Check the account.";
const ATTACHED_NOTE = "; the files it attached had already started uploading, so the site may keep a private draft of this post: check the account and delete it there";
const WAIT_SLICE_MS = 1_000;
const WHITESPACE_RUN = /\s+/g;

export type PlanStep =
	| { kind: "field"; field: PublishField }
	| { kind: "file"; file: PublishFile }
	| { kind: "click"; selector: string }
	| { kind: "wait"; selector: string; timeoutMs: number }
	| { kind: "check"; selector: string };

/** A validated recipe, with its receipt path template compiled once. */
export interface Recipe extends PublishRecipe {
	/** Matches a receipt URL's pathname against `receipt.path`, in linear time. */
	matchesPath: (pathname: string) => boolean;
	plan: PlanStep[];
}

/** A parked publish: the record the View shows, and the recipe confirm needs (never shown). */
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
	/** The signed-in account the recipe's `account` selector read before filling, if any. */
	account?: string;
	shownReads?: string[];
	attached: boolean;
	cancelRequested?: string;
	held?: Spend;
	parked: PromiseWithResolvers<void>;
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
	const files = validateFiles(input.files);
	const steps = input.steps === undefined ? undefined : validateSteps(input.steps, fields, files);
	const receipt = input.receipt;
	if (!isObject(receipt)) fail("bad_recipe", "receipt must be an object");
	const path = receiptPath(receipt.path);
	return {
		origin,
		composeUrl: compose.href,
		signedIn: selector(input.signedIn, "signedIn"),
		...(input.account === undefined ? {} : { account: selector(input.account, "account") }),
		fields,
		...(files.length === 0 ? {} : { files }),
		...(steps === undefined ? {} : { steps: steps.declared }),
		submit: selector(input.submit, "submit"),
		receipt: {
			path,
			...(receipt.linkSelector === undefined ? {} : { linkSelector: selector(receipt.linkSelector, "receipt.linkSelector") }),
			...(receipt.origin === undefined ? {} : { origin: parseOrigin(receipt.origin, "receipt.origin") }),
		},
		matchesPath: compilePath(path),
		plan: steps?.plan ?? [...fields.map((field): PlanStep => ({ kind: "field", field })), ...files.map((file): PlanStep => ({ kind: "file", file }))],
	};
}

function validateFiles(input: unknown): PublishFile[] {
	if (input === undefined) return [];
	if (!Array.isArray(input) || input.length > MAX_FILES) fail("bad_recipe", `files must hold at most ${MAX_FILES} entries`);
	const labels = new Set<string>();
	return input.map((file: unknown, index): PublishFile => {
		if (!isObject(file)) fail("bad_recipe", `files[${index}] must be { label, selector, path }`);
		if (typeof file.label !== "string" || file.label.trim().length === 0 || file.label.length > MAX_LABEL_CHARS) {
			fail("bad_recipe", `files[${index}].label must be a non-empty string of at most ${MAX_LABEL_CHARS} characters`);
		}
		const label = file.label.trim();
		if (labels.has(label)) fail("bad_recipe", `files[${index}].label ${JSON.stringify(label)} is used twice`);
		labels.add(label);
		return { label, selector: selector(file.selector, `files[${index}].selector`), path: requireAbsolutePath(file.path, `files[${index}].path`, "bad_recipe") };
	});
}

function validateSteps(input: unknown, fields: readonly PublishField[], files: readonly PublishFile[]): { declared: PublishStep[]; plan: PlanStep[] } {
	if (!Array.isArray(input) || input.length === 0 || input.length > MAX_STEPS) fail("bad_recipe", `steps must hold 1-${MAX_STEPS} entries`);
	const targets = new Map<string, PlanStep>([
		...fields.map((field): [string, PlanStep] => [`field:${field.label}`, { kind: "field", field }]),
		...files.map((file): [string, PlanStep] => [`file:${file.label}`, { kind: "file", file }]),
	]);
	if (fields.some((field) => field.label === undefined) || targets.size !== fields.length + files.length) fail("bad_recipe", "with steps, every field needs a label of its own");
	const placed = new Set<string>();
	const declared: PublishStep[] = [];
	const plan = input.map((step: unknown, index): PlanStep => {
		const where = `steps[${index}]`;
		if (!isObject(step)) fail("bad_recipe", `${where} must be an object`);
		const keys = Object.keys(step);
		const only = (allowed: readonly string[]): void => {
			const extra = keys.find((key) => !allowed.includes(key));
			if (extra !== undefined) fail("bad_recipe", `${where}.${extra} is not a ${String(step.kind)} step key`);
		};
		switch (step.kind) {
			case "field":
			case "file": {
				only(["kind", "label"]);
				const label = typeof step.label === "string" ? step.label.trim() : "";
				const key = `${step.kind}:${label}`;
				const target = targets.get(key);
				if (target === undefined) fail("bad_recipe", `${where} names no ${step.kind} labelled ${JSON.stringify(label)}`);
				if (placed.has(key)) fail("bad_recipe", `${where} places ${step.kind} ${JSON.stringify(label)} a second time`);
				placed.add(key);
				declared.push({ kind: step.kind, label });
				return target;
			}
			case "click":
			case "check": {
				only(["kind", "selector"]);
				const target = selector(step.selector, `${where}.selector`);
				declared.push({ kind: step.kind, selector: target });
				return { kind: step.kind, selector: target };
			}
			case "wait": {
				only(["kind", "selector", "timeoutMs"]);
				const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_WAIT_MS;
				if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_STEP_WAIT_MS) {
					fail("bad_recipe", `${where}.timeoutMs must be an integer from 1 to ${MAX_STEP_WAIT_MS}`);
				}
				const target = selector(step.selector, `${where}.selector`);
				declared.push({ kind: "wait", selector: target, ...(step.timeoutMs === undefined ? {} : { timeoutMs }) });
				return { kind: "wait", selector: target, timeoutMs };
			}
			default:
				return fail("bad_recipe", `${where}.kind must be field, file, click, wait or check`);
		}
	});
	if (placed.size !== fields.length + files.length) fail("bad_recipe", "steps must place every field and every file exactly once");
	return { declared, plan };
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

function parseOrigin(value: unknown, name = "origin"): string {
	const url = parseUrl(value, name);
	if (url.pathname !== "/" || url.search !== "" || url.hash !== "") fail("bad_recipe", `${name} must be a bare origin such as https://example.com`);
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
export async function prepare(
	driver: EngineDriver,
	profile: string,
	recipe: Recipe,
	mode: PublishMode,
	guard?: EffectGuard,
	files: Readonly<Record<string, LocalFile>> = {},
	publication: Publication = startPublication(recipe, profile),
): Promise<PublishCheck | Publication> {
	if (guard !== undefined) await guard();
	guard?.assertCurrent();
	try {
		await driver.perform({ kind: "navigate", url: recipe.composeUrl }, undefined, guard);
	} catch (error) {
		return { status: "failed", url: await currentUrl(driver, guard), profile, error: `could not open the compose page: ${describe(error)}` };
	}
	const deadline = Date.now() + SIGNED_IN_WAIT_MS;
	let signedIn = false;
	while (!signedIn) {
		const origin = originOf(await currentUrl(driver, guard));
		if (guard !== undefined) await guard();
		guard?.assertCurrent();
		signedIn = origin === recipe.origin && (await driver.hasElement(recipe.signedIn).catch(() => false));
		if (signedIn || Date.now() >= deadline) break;
		await sleep(POLL_MS);
	}
	const url = await currentUrl(driver, guard);
	guard?.assertCurrent();
	if (!signedIn) return { status: "not-signed-in", url, profile };
	if (guard !== undefined) await guard();
	guard?.assertCurrent();
	const account = recipe.account === undefined ? undefined : accountFromText(await driver.readText(recipe.account, MAX_ACCOUNT_TEXT_CHARS).catch(() => null));
	guard?.assertCurrent();
	if (mode === "check") return { status: "signed-in", url, profile, ...(account === undefined ? {} : { account }) };

	const failed = (error: string): PublishCheck => ({ status: "failed", url, profile, error: `${error}; nothing was submitted${publication.attached ? ATTACHED_NOTE : ""}` });
	for (const [index, step] of recipe.plan.entries()) {
		if (guard !== undefined) await guard();
		guard?.assertCurrent();
		switch (step.kind) {
			case "field": {
				const problem = await fillField(driver, step.field, guard);
				if (problem !== null) return failed(problem);
				break;
			}
			case "file": {
				const name = `file ${JSON.stringify(step.file.label)}`;
				const local = Object.hasOwn(files, step.file.label) ? files[step.file.label] : undefined;
				const attachGuard: EffectGuard | undefined =
					local === undefined ? guard : Object.assign(() => guard?.(), { assertCurrent: () => { guard?.assertCurrent(); requireUnchanged(local, name); } });
				const before = publication.attached;
				publication.attached = true;
				try {
					await driver.attachFile(step.file.selector, local?.real ?? step.file.path, attachGuard);
				} catch (error) {
					if (error instanceof ActionNotDispatched) publication.attached = before;
					return failed(`attaching ${name} to ${JSON.stringify(step.file.selector)} failed: ${describe(error)}`);
				}
				break;
			}
			case "click":
				try {
					await driver.perform({ kind: "click", selector: step.selector }, undefined, guard);
				} catch (error) {
					return failed(`step ${index + 1}, clicking ${JSON.stringify(step.selector)}, failed: ${describe(error)}`);
				}
				break;
			case "wait":
			case "check": {
				const timeoutMs = step.kind === "wait" ? step.timeoutMs : DEFAULT_STEP_WAIT_MS;
				const until = Date.now() + timeoutMs;
				let appeared = false;
				while (!appeared) {
					appeared = await driver.waitFor({ selector: step.selector }, Math.max(1, Math.min(WAIT_SLICE_MS, until - Date.now())), (value) => value).catch(() => false);
					guard?.assertCurrent();
					if (Date.now() >= until) break;
				}
				if (!appeared) return failed(`step ${index + 1}: ${JSON.stringify(step.selector)} did not appear within ${timeoutMs} ms`);
				break;
			}
		}
	}
	const shownReads = recipe.steps === undefined ? undefined : await readAfterSteps(driver, recipe, guard);
	if (typeof shownReads === "string") return failed(shownReads);
	if (guard !== undefined) await guard();
	guard?.assertCurrent();
	const shown = await driver.state().catch(() => null);
	guard?.assertCurrent();
	if (!shown || originOf(shown.url) !== recipe.origin) {
		return { status: "failed", url: shown?.url ?? url, profile, error: `the tab left ${recipe.origin} while typing; nothing was submitted${publication.attached ? ATTACHED_NOTE : ""}` };
	}
	Object.assign(publication.record, {
		status: "awaiting-confirmation",
		composeUrl: shown.url,
		tabId: shown.activeTabId,
		expiresAt: new Date(Date.now() + PUBLISH_PENDING_MS).toISOString(),
	});
	if (account !== undefined) publication.account = account;
	if (shownReads !== undefined) publication.shownReads = shownReads;
	publication.parked.resolve();
	return publication;
}

export function startPublication(recipe: Recipe, profile: string): Publication {
	const now = new Date().toISOString();
	return {
		record: {
			publishId: randomBytes(16).toString("hex"),
			status: "preparing",
			origin: recipe.origin,
			composeUrl: recipe.composeUrl,
			tabId: "",
			profile,
			fields: recipe.fields.map((field) => ({ ...field })),
			...(recipe.files === undefined ? {} : { files: recipe.files.map(({ label, path }) => ({ label, path })) }),
			createdAt: now,
			expiresAt: now,
		},
		recipe,
		confirming: false,
		touchedWhilePending: false,
		sharedPage: false,
		attached: false,
		parked: Promise.withResolvers<void>(),
		settled: Promise.withResolvers<void>(),
	};
}

export function failPreparation(publication: Publication, outcome: PublishCheck | Error): void {
	if (publication.record.status !== "preparing") return;
	const note = publication.attached ? ATTACHED_NOTE : "";
	if (publication.cancelRequested !== undefined) {
		const unsure = unsureError(publication);
		settle(publication, unsure === null ? "cancelled" : "unknown", { error: unsure ?? `${publication.cancelRequested}${note}` });
		return;
	}
	const error = outcome instanceof Error
		? `${describe(outcome)}; nothing was submitted${note}`
		: (outcome.error ?? `not signed in to ${publication.record.origin} on profile ${publication.record.profile}; nothing was typed`);
	settle(publication, "failed", { error });
}

async function readAfterSteps(driver: EngineDriver, recipe: Recipe, guard?: EffectGuard): Promise<string[] | string> {
	const reads: string[] = [];
	for (const field of recipe.fields) {
		if (guard !== undefined) await guard();
		guard?.assertCurrent();
		const read = await driver.readField(field.selector).catch(() => null);
		guard?.assertCurrent();
		if (read?.state !== "value") return `${JSON.stringify(field.selector)} left the page during the steps`;
		if (read.value !== field.value) {
			const box = await driver.inspect(field.selector).catch(() => null);
			guard?.assertCurrent();
			const hidden = box !== null && box.rect.width === 0 && box.rect.height === 0;
			const sameWords = read.value.replace(WHITESPACE_RUN, " ").trim() === field.value.replace(WHITESPACE_RUN, " ").trim();
			if (!hidden || !sameWords) return `field-mismatch: ${JSON.stringify(field.selector)} no longer holds the value typed after the steps`;
		}
		reads.push(read.value);
	}
	return reads;
}

async function fillField(driver: EngineDriver, field: PublishField, guard?: EffectGuard): Promise<string | null> {
	const before = await driver.readField(field.selector).catch((error) => ({ state: "error" as const, error }));
	guard?.assertCurrent();
	if (before.state === "error") return `could not read ${JSON.stringify(field.selector)}: ${describe(before.error)}`;
	if (before.state === "absent") return `${JSON.stringify(field.selector)} is not on the page`;
	if (before.state === "password") return `${JSON.stringify(field.selector)} is a password field, which a publish never reads back; log in with browser_act or browser_task`;
	if (before.state === "not-editable") return `${JSON.stringify(field.selector)} is not an input, textarea or editable element`;
	if (guard !== undefined) await guard();
	guard?.assertCurrent();
	try {
		await driver.fill(field.selector, field.value, guard);
	} catch (error) {
		return `typing into ${JSON.stringify(field.selector)} failed: ${describe(error)}`;
	}
	if (guard !== undefined) await guard();
	guard?.assertCurrent();
	const after = await driver.readField(field.selector).catch(() => null);
	guard?.assertCurrent();
	if (after?.state !== "value" || after.value !== field.value) return `field-mismatch: ${JSON.stringify(field.selector)} does not read back the exact value typed`;
	return null;
}

// ---------------------------------------------------------------------------
// confirm — the one Post (the model's confirm or the View's button)
// ---------------------------------------------------------------------------

/** The pending publication `publishId`, or a refusal naming why it cannot be acted on. */
export function requirePending(publication: Publication | null, publishId: string): Publication {
	if (!publication || publication.record.publishId !== publishId) fail("unknown_publish", "no such publish on this browser");
	expireIfDue(publication);
	const { status } = publication.record;
	if (status !== "awaiting-confirmation" || publication.confirming) {
		fail("publish_not_pending", `this publish is ${publication.confirming ? "already being confirmed" : status === "preparing" ? "still being prepared: follow it with browser_publish_wait" : status}`);
	}
	return publication;
}

/**
 * Re-verify, click submit exactly once, read the receipt. Always settles the
 * publication; never throws for a page outcome.
 */
export async function confirm(driver: EngineDriver, publication: Publication, guard?: EffectGuard): Promise<void> {
	publication.confirming = true;
	const { recipe } = publication;
	let submitDispatched = false;
	try {
		// The human used the page while waiting and may have pressed the site's own
		// submit; a site that keeps the text afterwards would look unchanged, so a
		// click here could post twice. Never click: report it honestly instead.
		if (publication.touchedWhilePending) return settle(publication, "unknown", { error: TOUCHED_ERROR });
		const changed = await changedSinceShown(driver, publication, guard);
		guard?.assertCurrent();
		if (changed) {
			if (publication.sharedPage) return settle(publication, "unknown", { error: SHARED_ERROR });
			return settle(publication, "failed", { error: `changed since shown: ${changed}; nothing was submitted${publication.attached ? ATTACHED_NOTE : ""}` });
		}
		// What already looks like a receipt is not one: it predates this submit.
		const before = new Set(await receipts(driver, recipe, guard).catch(() => []));
		if (guard !== undefined) await guard();
		guard?.assertCurrent();
		try {
			submitDispatched = true;
			await driver.perform({ kind: "click", selector: recipe.submit }, undefined, guard);
		} catch (error) {
			if (error instanceof ActionNotDispatched) {
				submitDispatched = false;
				const unsure = unsureError(publication);
				if (unsure) return settle(publication, "unknown", { error: unsure });
				return settle(publication, "failed", { error: `submit was not clicked: ${describe(error)}; nothing was submitted` });
			}
			return settle(publication, "unknown", { error: `submit was clicked, then errored, so it may have posted; never retried (${describe(error)})` });
		}
		const deadline = Date.now() + RECEIPT_WAIT_MS;
		while (Date.now() < deadline) {
			if (guard !== undefined) await guard();
			guard?.assertCurrent();
			const found = (await receipts(driver, recipe, guard).catch(() => [])).find((url) => !before.has(url));
			guard?.assertCurrent();
			if (found) return settle(publication, "posted", { url: found });
			await sleep(POLL_MS);
		}
		settle(publication, "unknown", { error: "submitted, but no receipt was seen, so it may have posted; never retried" });
	} catch (error) {
		const unsure = unsureError(publication);
		if (!submitDispatched && !unsure) settle(publication, "failed", { error: `publishing was refused before submit: ${describe(error)}; nothing was submitted` });
		else settle(publication, "unknown", { error: unsure ?? `publishing errored, so it may have posted; never retried (${describe(error)})` });
	}
}

/** Why the page no longer matches what the human was shown, or null. */
async function changedSinceShown(driver: EngineDriver, publication: Publication, guard?: EffectGuard): Promise<string | null> {
	try {
		if (guard !== undefined) await guard();
		guard?.assertCurrent();
		const state = await driver.state();
		guard?.assertCurrent();
		if (state.activeTabId !== publication.record.tabId) return "another tab is active";
		if (state.url !== publication.record.composeUrl) return `the tab is no longer on ${publication.record.composeUrl}`;
		for (const [index, field] of publication.record.fields.entries()) {
			if (guard !== undefined) await guard();
			guard?.assertCurrent();
			const read = await driver.readField(field.selector);
			guard?.assertCurrent();
			if (read.state !== "value" || read.value !== (publication.shownReads?.[index] ?? field.value)) return `${JSON.stringify(field.selector)} no longer holds the value shown`;
		}
		return await missingCheck(driver, publication.recipe, guard);
	} catch (error) {
		return `the page could not be re-read (${describe(error)})`;
	}
}

async function missingCheck(driver: EngineDriver, recipe: Recipe, guard?: EffectGuard): Promise<string | null> {
	for (const step of recipe.plan) {
		if (step.kind !== "check") continue;
		if (guard !== undefined) await guard();
		guard?.assertCurrent();
		const holds = await driver.hasElement(step.selector);
		guard?.assertCurrent();
		if (!holds) return `${JSON.stringify(step.selector)} is no longer on the page`;
	}
	return null;
}

/**
 * Receipt candidates now on the page: on the origin, pathname matching the
 * recipe's template, in page order. Every link is read (bounded) and filtered
 * here, so a page cannot push the real receipt out of a small window.
 */
async function receipts(driver: EngineDriver, recipe: Recipe, guard?: EffectGuard): Promise<string[]> {
	if (guard !== undefined) await guard();
	guard?.assertCurrent();
	const candidates = recipe.receipt.linkSelector === undefined
		? [(await driver.state()).url]
		: await driver.linkHrefs(recipe.receipt.linkSelector, MAX_RECEIPT_LINKS);
	guard?.assertCurrent();
	return candidates.filter((url) => url.length <= MAX_URL_CHARS && isReceipt(url, recipe));
}

function isReceipt(url: string, recipe: Recipe): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	return parsed.origin === (recipe.receipt.origin ?? recipe.origin) && recipe.matchesPath(parsed.pathname);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** A Cancel (the model's or the View's), or the browser closing under a pending publish. */
export function cancel(publication: Publication, error?: string): void {
	if (publication.record.status === "preparing") {
		publication.cancelRequested ??= error ?? "Cancelled while it was being prepared; nothing was submitted";
		return;
	}
	const unsure = unsureError(publication);
	if (unsure) settle(publication, "unknown", { error: unsure });
	else if (publication.attached) settle(publication, "cancelled", { error: `${error ?? "Cancelled; nothing was submitted"}${ATTACHED_NOTE}` });
	else settle(publication, "cancelled", error === undefined ? {} : { error });
}

export function expireIfDue(publication: Publication): void {
	if (publication.record.status !== "awaiting-confirmation" || publication.confirming) return;
	if (Date.now() < Date.parse(publication.record.expiresAt)) return;
	const unsure = unsureError(publication);
	if (unsure) settle(publication, "unknown", { error: unsure });
	else settle(publication, "expired", { error: `not confirmed within 10 minutes${publication.attached ? ATTACHED_NOTE : ""}` });
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
	const preparing = publication.record.status === "preparing";
	const untilExpiry = Date.parse(publication.record.expiresAt) - Date.now();
	const { promise: elapsed, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, Math.max(0, preparing || publication.confirming ? ms : Math.min(ms, untilExpiry)));
	await Promise.race([publication.settled.promise, ...(preparing ? [publication.parked.promise] : []), elapsed]);
	clearTimeout(timer);
	expireIfDue(publication);
}

/** A copy of the record, with expiry applied. */
export function publishRecord(publication: Publication): PublishRecord {
	expireIfDue(publication);
	const { record } = publication;
	return {
		...record,
		fields: record.fields.map((field) => ({ ...field })),
		...(record.files === undefined ? {} : { files: record.files.map((file) => ({ ...file })) }),
		...(record.preset === undefined ? {} : { preset: { ...record.preset } }),
	};
}

export function isPending(publication: Publication | null): boolean {
	if (!publication) return false;
	expireIfDue(publication);
	return publication.record.status === "awaiting-confirmation" || publication.record.status === "preparing";
}

function settle(publication: Publication, status: Exclude<PublishStatus, "awaiting-confirmation" | "preparing">, detail: { url?: string; error?: string }): void {
	if (TERMINAL.includes(publication.record.status)) return;
	Object.assign(publication.record, { status }, detail);
	publication.confirming = false;
	publication.parked.resolve();
	publication.settled.resolve();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function currentUrl(driver: EngineDriver, guard?: EffectGuard): Promise<string> {
	if (guard !== undefined) await guard();
	guard?.assertCurrent();
	const state = await driver.state().catch(() => null);
	guard?.assertCurrent();
	return state?.url ?? "";
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
