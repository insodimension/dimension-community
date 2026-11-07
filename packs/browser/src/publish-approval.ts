/**
 * Publish approvals — a post goes out only if a human approved EXACTLY that post.
 *
 * `browser_publish` fills a compose page and `browser_publish_confirm` (the
 * model's call, or the View's Post button) submits it. The host's Allow card
 * puts a human in front of the model's confirm, but nothing tied that confirm
 * to what the human APPROVED elsewhere (Traction's campaign board): a model
 * could park and confirm text nobody had approved, and a human clicking Allow
 * or Post saw only the text, never a statement that it was the approved one.
 *
 * An approval is a record a human-only surface writes into `<root>/publish-
 * approvals/` when the human approves a post. This module is the READER and the
 * one-shot spender; this pack never writes an approval:
 *
 *   - `<draftId>.json` — { v: 1, draftId, nonce, binding, approvedAt, expiresAt }.
 *     `binding` is `bindingOf({ origin, profile, preset, values })`: the site, the browser
 *     profile (the account), the shipped preset the post goes through (null for a
 *     recipe the caller wrote, whose selectors nobody approved) and every field's
 *     value in order, hashed with a domain tag, so an approval for text X, on
 *     profile P, at site S, through preset R covers nothing else. One draft has at
 *     most one entry; approving it again (a Retry)
 *     replaces it with a fresh `nonce`.
 *   - `<draftId>.<nonce>.used` — created EXCLUSIVELY (`wx`) by the confirm that is
 *     about to click Post. That create is the lock: two confirms, two browsers or
 *     a model and the View cannot both spend one approval, and a spent approval
 *     is never spendable again, whatever the post's outcome. Removed only when
 *     nothing was submitted (the page changed, the click never dispatched).
 *
 * Checked twice, both fail closed with `publish_unapproved` and the page
 * untouched by the refusal: when a post is parked (before the compose page is
 * opened, so a model cannot even show the human unapproved text) and when it is
 * confirmed (any caller, the View's Post included: it spends the approval too,
 * so a post the human pressed cannot be posted a second time by the agent).
 *
 * Boundary, stated so nobody reads more into it than is there: the record is a
 * file under the user's home. It keeps a model that holds browser tools out of
 * the publish door; it cannot stop a process that can write files as this user
 * (an agent with a code runner or a file writer, which Traction's agents are).
 * It also covers only what is hashed: origin, profile, preset and values, NOT the page a
 * `needsTarget` preset posts on, so no surface may approve such a preset until
 * the binding covers the target (a v2 domain tag).
 */
import { createHash } from "node:crypto";
import { open, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fail } from "./store.js";

/** The domain tag in the hash: a binding for another purpose can never collide with this one. */
const BINDING_DOMAIN = "publish-approval/v1";
const FILL_DOMAIN = "approved-fill/v1";
/** The longest a writer may keep one approval live; a longer record is not an approval. */
export const MAX_APPROVAL_MS = 24 * 60 * 60_000;
const DRAFT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_FILL_TEXTS = 64;
const MAX_FILL_TEXT_CHARS = 100_000;

export function fillDigest(value: string): string {
	const settled = value.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").trim();
	return createHash("sha256").update(JSON.stringify([FILL_DOMAIN, settled])).digest("hex");
}

export interface FillApproval {
	readonly draftId: string;
	readonly nonce: string;
	readonly profile: string;
	readonly origins: readonly string[];
	readonly texts: readonly string[];
	readonly digests: ReadonlySet<string>;
	readonly expiresAt: number;
}

export interface FillSurvey {
	readonly live: FillApproval[];
	readonly used: FillApproval[];
	readonly expired: FillApproval[];
}

export function originCovered(origins: readonly string[], origin: string): boolean {
	return origins.some((allowed) => {
		if (allowed === "*" || allowed === origin) return true;
		const wildcard = /^(https:\/\/)\*\.(.+)$/.exec(allowed);
		return wildcard !== null && origin.startsWith(wildcard[1] as string) && origin.endsWith(`.${wildcard[2]}`) && !origin.slice((wildcard[1] as string).length).includes("/");
	});
}

/** What an approval covers: where, as whom, through which shipped preset, and exactly what. */
export interface PublishBinding {
	readonly origin: string;
	readonly profile: string;
	/** The shipped preset's name; absent for a recipe the caller wrote (its selectors and submit button are the caller's, so no surface approves one). */
	readonly preset?: string;
	readonly values: readonly string[];
}

/** The hex SHA-256 an approval stores for a post. Another writer must compute the identical string (golden vectors in both packs' tests). */
export function bindingOf(binding: PublishBinding): string {
	return createHash("sha256").update(JSON.stringify([BINDING_DOMAIN, binding.origin, binding.profile, binding.preset ?? null, [...binding.values]])).digest("hex");
}

interface Approval {
	readonly draftId: string;
	readonly nonce: string;
	readonly binding: string;
	readonly approvedAt: number;
	readonly expiresAt: number;
}

/** A spent approval: `release()` gives it back, and only when nothing was submitted. */
export interface Spend {
	readonly draftId: string;
	release(): Promise<void>;
}

/** Where the refusal happens: it words what the refusal left untouched. */
export type ApprovalStage = "park" | "confirm";

const UNTOUCHED: Readonly<Record<ApprovalStage, string>> = {
	park: "Nothing was typed or clicked.",
	confirm: "Nothing was clicked and the publish is still pending: cancel it with browser_publish_cancel.",
};

export class PublishApprovals {
	readonly #dir: string;
	readonly #now: () => number;

	constructor(dir: string, now: () => number = Date.now) {
		this.#dir = dir;
		this.#now = now;
	}

	/** Refuse unless a live, unspent approval covers this post. Spends nothing. */
	async require(binding: PublishBinding, stage: ApprovalStage): Promise<void> {
		const found = await this.#survey(bindingOf(binding));
		if (found.live.length === 0) refuse(binding, found, stage);
	}

	/**
	 * Spend the approval that covers this post, or refuse. The exclusive create of
	 * its marker is the lock, so of any number of concurrent spenders exactly one
	 * wins; the rest see `used`.
	 */
	async consume(binding: PublishBinding, stage: ApprovalStage): Promise<Spend> {
		const found = await this.#survey(bindingOf(binding));
		for (const approval of found.live) {
			const marker = join(this.#dir, `${approval.draftId}.${approval.nonce}.used`);
			try {
				await (await open(marker, "wx")).close();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					found.used.push(approval);
					continue;
				}
				throw error;
			}
			return {
				draftId: approval.draftId,
				release: async () => {
					await unlink(marker).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
					});
				},
			};
		}
		return refuse(binding, found, stage);
	}

	/** Every approval for this binding, sorted into the states a refusal tells apart. Unreadable or malformed entries are not approvals. */
	async #survey(binding: string): Promise<{ live: Approval[]; used: Approval[]; expired: Approval[] }> {
		const live: Approval[] = [];
		const used: Approval[] = [];
		const expired: Approval[] = [];
		const { names, spent } = await this.#listing();
		const now = this.#now();
		for (const name of names) {
			const approval = readApproval(await readRecord(join(this.#dir, name), name));
			if (approval === null || approval.binding !== binding) continue;
			if (spent.has(`${approval.draftId}.${approval.nonce}.used`)) used.push(approval);
			else if (approval.expiresAt <= now) expired.push(approval);
			else live.push(approval);
		}
		return { live, used, expired };
	}

	async fills(profile: string, origin: string): Promise<FillSurvey> {
		const survey: FillSurvey = { live: [], used: [], expired: [] };
		const { names, spent } = await this.#listing();
		const now = this.#now();
		for (const name of names) {
			const approval = readFillApproval(await readRecord(join(this.#dir, name), name));
			if (approval === null || approval.profile !== profile || !originCovered(approval.origins, origin)) continue;
			if (spent.has(`${approval.draftId}.${approval.nonce}.used`)) survey.used.push(approval);
			else if (approval.expiresAt <= now) survey.expired.push(approval);
			else survey.live.push(approval);
		}
		return survey;
	}

	async spendFill(approval: FillApproval): Promise<boolean> {
		try {
			await (await open(join(this.#dir, `${approval.draftId}.${approval.nonce}.used`), "wx")).close();
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
	}

	async releaseFill(approval: FillApproval): Promise<void> {
		await unlink(join(this.#dir, `${approval.draftId}.${approval.nonce}.used`)).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}

	async #listing(): Promise<{ names: string[]; spent: ReadonlySet<string> }> {
		let names: string[];
		try {
			names = await readdir(this.#dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { names: [], spent: new Set() };
			throw error;
		}
		return { names: names.filter((name) => name.endsWith(".json")), spent: new Set(names.filter((name) => name.endsWith(".used"))) };
	}
}

interface ApprovalRecord {
	readonly fields: Record<string, unknown>;
	readonly draftId: string;
	readonly nonce: string;
	readonly approvedAt: number;
	readonly expiresAt: number;
}

async function readRecord(path: string, name: string): Promise<ApprovalRecord | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const fields = parsed as Record<string, unknown>;
	const { draftId, nonce, approvedAt, expiresAt } = fields;
	if (typeof draftId !== "string" || !DRAFT_ID.test(draftId) || name !== `${draftId}.json`) return null;
	if (typeof nonce !== "string" || !NONCE.test(nonce)) return null;
	if (typeof approvedAt !== "string" || typeof expiresAt !== "string") return null;
	const from = Date.parse(approvedAt);
	const until = Date.parse(expiresAt);
	if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from || until - from > MAX_APPROVAL_MS) return null;
	return { fields, draftId, nonce, approvedAt: from, expiresAt: until };
}

function readApproval(record: ApprovalRecord | null): Approval | null {
	if (record === null || record.fields.v !== 1) return null;
	const { binding } = record.fields;
	if (typeof binding !== "string" || !DIGEST.test(binding)) return null;
	return { draftId: record.draftId, nonce: record.nonce, binding, approvedAt: record.approvedAt, expiresAt: record.expiresAt };
}

function readFillApproval(record: ApprovalRecord | null): FillApproval | null {
	if (record === null || record.fields.v !== 2) return null;
	const { profile, origins, texts } = record.fields;
	if (typeof profile !== "string" || profile === "") return null;
	const listed = Array.isArray(origins) && origins.length > 0 && origins.length <= MAX_FILL_TEXTS && origins.every((item) => typeof item === "string" && /^(?:\*|https?:\/\/(?:\*\.)?[^\s/*]+)$/.test(item));
	if (!listed) return null;
	if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_FILL_TEXTS || !texts.every((item) => typeof item === "string" && item.trim() !== "" && item.length <= MAX_FILL_TEXT_CHARS)) return null;
	return { draftId: record.draftId, nonce: record.nonce, profile, origins: origins as string[], texts: texts as string[], digests: new Set((texts as string[]).map(fillDigest)), expiresAt: record.expiresAt };
}

/** The refusal, worded for the model that has to act on it: what is wrong, and the one thing to do. */
function refuse(binding: PublishBinding, found: { used: readonly Approval[]; expired: readonly Approval[] }, stage: ApprovalStage): never {
	const post = `site ${binding.origin}, profile ${binding.profile}, ${binding.preset === undefined ? "a recipe, which no board approves," : `preset ${binding.preset},`} text sha256:${bindingOf(binding).slice(0, 12)}`;
	const spent = found.used[0];
	if (spent !== undefined) {
		fail(
			"publish_unapproved",
			`publish_unapproved: the approval for draft ${spent.draftId} (${post}) was already used, so this post may already be up. Do not post it again: follow it with browser_publish_wait, then record draft_posted with its url, or unconfirmed if you cannot tell. ${UNTOUCHED[stage]}`,
		);
	}
	const lapsed = found.expired[0];
	if (lapsed !== undefined) {
		fail(
			"publish_unapproved",
			`publish_unapproved: the approval for draft ${lapsed.draftId} (${post}) expired at ${new Date(lapsed.expiresAt).toISOString()}. Record draft_failed with that reason; the user presses Retry on the board, which approves it again. ${UNTOUCHED[stage]}`,
		);
	}
	fail(
		"publish_unapproved",
		`publish_unapproved: no board approval covers this exact post (${post}). Post only text the user approved on the campaign board, from the profile that draft names, through the platform's preset (never a recipe you wrote), exactly as approved, character for character. ${UNTOUCHED[stage]}`,
	);
}
