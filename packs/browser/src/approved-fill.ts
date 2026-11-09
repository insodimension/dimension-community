import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { originOf } from "./address.js";
import type { BrowserAction } from "./contracts.js";
import type { EditableText, EngineDriver } from "./engines/types.js";
import { PROFILE_NAME, RELAY_PROFILE } from "./profile-name.js";
import { type FillApproval, fillDigest, type PublishApprovals } from "./publish-approval.js";
import { fail } from "./store.js";
import { SUBMIT_JUDGE_LIMITS, type SubmitJudgeApproval, type SubmitJudgeRequest, type SubmitJudgeVerdict } from "./submit-judge.js";

const TRACTION_PROFILE = /^traction-/;
export const PUBLISH_PROFILES_FILE = "publish-profiles.json";
export const FILL_CLAIM_MS = 10 * 60_000;
export const JUDGE_CONFIDENCE_BAR = 0.8;
const EXCERPT_CHARS = 60;
const SUBMITTING_KEYS: Readonly<Record<string, true>> = { Enter: true, Space: true };

export type SubmitJudge = (request: SubmitJudgeRequest) => Promise<SubmitJudgeVerdict>;

export interface FillClaim {
	readonly approval: FillApproval;
	readonly origin: string;
	readonly tabId: string | null;
	readonly until: number;
}

export interface GatedBrowser {
	readonly profile: string;
	readonly driver: EngineDriver;
	fillClaim?: FillClaim | undefined;
}

export interface SubmitExpectation {
	readonly profile: string;
	readonly origin: string;
	readonly values: readonly string[];
}

export function codeRefusal(reason: string): string {
	return `${reason}: what it posts is checked against what the person approved, so code never drives it. Use the step tools on it, or open another profile.`;
}

type NamedProfiles = ReadonlySet<string> | "unknown";

export interface GatedProfilesOptions {
	readonly onGated?: (profiles: ReadonlySet<string>) => void;
	readonly now?: () => number;
}

const NO_PROFILES: ReadonlySet<string> = new Set();
const ABSENT_GRACE_MS = 2_000;

export class GatedProfiles {
	readonly #dir: string;
	readonly #file: string;
	readonly #onGated: (profiles: ReadonlySet<string>) => void;
	readonly #now: () => number;
	#seen: string | undefined;
	#present = false;
	#absentSince: number | undefined;
	#recheck: NodeJS.Timeout | undefined;
	#good: ReadonlySet<string> | undefined;
	#named: NamedProfiles | undefined;
	#watcher: FSWatcher | undefined;
	#closed = false;

	constructor(rootDir: string, options: GatedProfilesOptions = {}) {
		this.#dir = rootDir;
		this.#file = join(rootDir, PUBLISH_PROFILES_FILE);
		this.#onGated = options.onGated ?? (() => undefined);
		this.#now = options.now ?? (() => performance.now());
	}

	has(profile: string | null): profile is string {
		return this.reason(profile) !== undefined;
	}

	reason(profile: string | null): string | undefined {
		if (profile === null) return undefined;
		if (TRACTION_PROFILE.test(profile)) return `${profile} is a profile a Traction account posts from`;
		const named = this.#current();
		if (named !== "unknown") return named.has(profile) ? `${profile} is a profile a Traction account posts from` : undefined;
		return profile === RELAY_PROFILE ? undefined : `the publishing registry ${this.#file} could not be read, so ${profile} is treated as a profile a Traction account posts from`;
	}

	watch(): void {
		if (this.#watcher !== undefined || this.#closed) return;
		try {
			const watcher = watch(this.#dir, { persistent: false }, (_event, name) => {
				if (name === null || name === PUBLISH_PROFILES_FILE) this.#current();
			});
			watcher.on("error", () => {
				watcher.close();
				this.#watcher = undefined;
				this.watch();
			});
			this.#watcher = watcher;
		} catch (error) {
			console.error("[browser] the publishing registry watch failed; a newly named profile is let go at its next gate check:", error instanceof Error ? error.message : String(error));
		}
		this.#current();
	}

	close(): void {
		this.#closed = true;
		this.#watcher?.close();
		this.#watcher = undefined;
		clearTimeout(this.#recheck);
		this.#recheck = undefined;
	}

	#current(): NamedProfiles {
		let identity: string;
		try {
			const stats = statSync(this.#file, { bigint: true, throwIfNoEntry: false });
			identity = stats === undefined ? "absent" : `${stats.ino}:${stats.size}:${stats.mtimeNs}`;
		} catch {
			return this.#named ?? "unknown";
		}
		if (identity === this.#seen && this.#named !== undefined) return this.#named;
		if (identity === "absent") return this.#absent();
		this.#present = true;
		this.#absentSince = undefined;
		clearTimeout(this.#recheck);
		this.#recheck = undefined;
		const read = readNamedProfiles(this.#file);
		if (read === undefined) return this.#named ?? "unknown";
		if (read === "invalid") return this.#settle(identity, this.#good ?? "unknown");
		this.#good = read;
		return this.#settle(identity, read);
	}

	#absent(): NamedProfiles {
		if (!this.#present) return this.#settle("absent", NO_PROFILES);
		const now = this.#now();
		this.#absentSince ??= now;
		if (now - this.#absentSince >= ABSENT_GRACE_MS) return this.#settle("absent", "unknown");
		if (this.#recheck === undefined && !this.#closed) {
			this.#recheck = setTimeout(() => {
				this.#recheck = undefined;
				this.#current();
			}, ABSENT_GRACE_MS);
			this.#recheck.unref?.();
		}
		return this.#named ?? "unknown";
	}

	#settle(identity: string, named: NamedProfiles): NamedProfiles {
		this.#seen = identity;
		const previous = this.#named;
		this.#named = named;
		if (named === "unknown") {
			if (previous !== "unknown") console.error(`[browser] the publishing registry ${this.#file} could not be read: every saved profile but the relay is gated until it can be.`);
			return named;
		}
		if (previous === undefined || named === previous) return named;
		const added = previous === "unknown" ? named : new Set([...named].filter((profile) => !previous.has(profile)));
		if (added.size > 0) queueMicrotask(() => this.#onGated(added));
		return named;
	}
}

const PublishProfilesFile = z.object({ v: z.literal(1), profiles: z.array(z.string()) });

function readNamedProfiles(file: string): Set<string> | "invalid" | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return "invalid";
	}
	const parsed = PublishProfilesFile.safeParse(json);
	return parsed.success ? new Set(parsed.data.profiles.filter((name) => PROFILE_NAME.test(name))) : "invalid";
}

function excerpt(value: string): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return JSON.stringify(flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat);
}

function covers(approval: FillApproval, texts: readonly EditableText[]): boolean {
	return texts.every((text) => approval.digests.has(fillDigest(text.value)));
}

function judgeEvidence(live: readonly FillApproval[]): SubmitJudgeApproval[] {
	return live.slice(0, SUBMIT_JUDGE_LIMITS.approvals).map((approval) => ({
		draftId: approval.draftId,
		texts: approval.texts.slice(0, SUBMIT_JUDGE_LIMITS.approvalTexts).map((text) => text.slice(0, SUBMIT_JUDGE_LIMITS.textChars)),
	}));
}

function needsPerson(why: string): never {
	fail(
		"submit_needs_person",
		`submit_needs_person: ${why} Nothing was clicked. Post it with browser_submit, which asks the person first; if they decline, nothing is posted.`,
	);
}

interface PageNow {
	readonly origin: string | null;
	readonly tabId: string | null;
	readonly texts: EditableText[];
}

export interface FillSpend {
	release(): Promise<void>;
}

const NOTHING_SPENT: FillSpend = { release: async () => undefined };

export class FillGate {
	readonly #approvals: PublishApprovals;
	readonly #now: () => number;

	constructor(approvals: PublishApprovals, now: () => number = Date.now) {
		this.#approvals = approvals;
		this.#now = now;
	}

	async before(browser: GatedBrowser, action: BrowserAction, judge: SubmitJudge | undefined): Promise<FillSpend> {
		const submitting = action.kind === "click" || (action.kind === "press" && SUBMITTING_KEYS[action.key as string] === true);
		if (!submitting) return NOTHING_SPENT;
		const page = await this.#read(browser);
		const claim = this.#settle(browser, page);
		if (page.texts.length === 0 || (claim !== undefined && covers(claim.approval, page.texts))) return NOTHING_SPENT;
		const origin = requireOrigin(page);
		const live = await this.#approvals.fills(browser.profile, origin);
		const spent = await this.#spendExact(browser, page, origin, live);
		if (spent !== undefined) return spent;
		if (judge === undefined) needsPerson("the page holds text that is not exactly an approved draft, and no judge is reachable here.");
		const texts = page.texts.map((text) => text.value);
		if (texts.length > SUBMIT_JUDGE_LIMITS.texts || texts.reduce((sum, text) => sum + text.length, 0) > SUBMIT_JUDGE_LIMITS.submittingChars) {
			needsPerson("the page holds more text than the judge can read whole.");
		}
		const verdict = await judge({ profile: browser.profile, origin, texts, approvals: judgeEvidence(live) }).catch(
			(error: unknown): SubmitJudgeVerdict => ({ verdict: "unavailable", reason: error instanceof Error ? error.message : String(error) }),
		);
		if (verdict.verdict === "consistent" && verdict.confidence >= JUDGE_CONFIDENCE_BAR) return NOTHING_SPENT;
		const why =
			"confidence" in verdict
				? `the judge found the text on the page ${verdict.verdict === "consistent" ? "only weakly" : "not"} consistent with what the person approved or asked for (confidence ${verdict.confidence.toFixed(2)}).`
				: `the judge could not decide (${verdict.verdict}: ${verdict.reason}).`;
		return needsPerson(`${why} The text: ${page.texts.map((text) => excerpt(text.value)).join(", ")}.`);
	}

	async after(browser: GatedBrowser): Promise<void> {
		if (browser.fillClaim === undefined) return;
		this.#settle(browser, await this.#read(browser));
	}

	async submit(browser: GatedBrowser, expected: SubmitExpectation): Promise<FillSpend> {
		const page = await this.#read(browser);
		const claim = this.#settle(browser, page);
		const origin = requireOrigin(page);
		if (expected.profile !== browser.profile || expected.origin !== origin) {
			fail("publish_mismatch", `publish_mismatch: this browser is profile ${browser.profile} on ${origin}, but the submit names profile ${expected.profile} on ${expected.origin}. Nothing was clicked.`);
		}
		const onPage = page.texts.map((text) => fillDigest(text.value)).sort();
		const named = expected.values.map(fillDigest).sort();
		if (onPage.length !== named.length || onPage.some((digest, index) => digest !== named[index])) {
			fail("publish_mismatch", `publish_mismatch: the values you named are not the text on the page (${page.texts.map((text) => excerpt(text.value)).join(", ") || "no text"}). Pass values copied exactly from the page's fields. Nothing was clicked.`);
		}
		if (page.texts.length === 0 || (claim !== undefined && covers(claim.approval, page.texts))) return NOTHING_SPENT;
		return (await this.#spendExact(browser, page, origin, await this.#approvals.fills(browser.profile, origin))) ?? NOTHING_SPENT;
	}

	async #spendExact(browser: GatedBrowser, page: PageNow, origin: string, live: readonly FillApproval[]): Promise<FillSpend | undefined> {
		const approval = live.find((candidate) => covers(candidate, page.texts));
		if (approval === undefined || !(await this.#approvals.spendFill(approval))) return undefined;
		const claim: FillClaim = { approval, origin, tabId: page.tabId, until: this.#now() + FILL_CLAIM_MS };
		browser.fillClaim = claim;
		return {
			release: async () => {
				if (browser.fillClaim === claim) browser.fillClaim = undefined;
				await this.#approvals.releaseFill(approval);
			},
		};
	}

	#settle(browser: GatedBrowser, page: PageNow): FillClaim | undefined {
		const claim = browser.fillClaim;
		if (claim === undefined) return undefined;
		const holds =
			claim.until > this.#now() &&
			claim.tabId === page.tabId &&
			claim.origin === page.origin &&
			page.texts.some((text) => claim.approval.digests.has(fillDigest(text.value)));
		if (holds) return claim;
		browser.fillClaim = undefined;
		return undefined;
	}

	async #read(browser: GatedBrowser): Promise<PageNow> {
		const state = await browser.driver.state();
		const origin = originOf(state.url);
		const texts = (await browser.driver.editables()).filter((text) => !text.exempt);
		return { origin: origin === null || origin === "null" ? null : origin, tabId: state.activeTabId ?? null, texts };
	}
}

function requireOrigin(page: PageNow): string {
	if (page.origin === null) return needsPerson("the page has no site an approval or the judge can name.");
	return page.origin;
}
