import { originOf } from "./address.js";
import type { BrowserAction } from "./contracts.js";
import type { EditableText, EngineDriver } from "./engines/types.js";
import { type FillApproval, fillDigest, type PublishApprovals } from "./publish-approval.js";
import { fail } from "./store.js";
import { SUBMIT_JUDGE_LIMITS, type SubmitJudgeApproval, type SubmitJudgeRequest, type SubmitJudgeVerdict } from "./submit-judge.js";

export const GATED_PROFILE = /^traction-/;
export const FILL_CLAIM_MS = 10 * 60_000;
export const JUDGE_CONFIDENCE_BAR = 0.8;
const EXCERPT_CHARS = 60;
const SUBMITTING_KEYS: Readonly<Record<string, true>> = { Enter: true, Space: true };

export type SubmitJudge = (request: SubmitJudgeRequest) => Promise<SubmitJudgeVerdict>;

export interface FillClaim {
	readonly approval: FillApproval;
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

export function isGated(profile: string | null): profile is string {
	return profile !== null && GATED_PROFILE.test(profile);
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

export class FillGate {
	readonly #approvals: PublishApprovals;
	readonly #now: () => number;

	constructor(approvals: PublishApprovals, now: () => number = Date.now) {
		this.#approvals = approvals;
		this.#now = now;
	}

	async before(browser: GatedBrowser, action: BrowserAction, judge: SubmitJudge | undefined): Promise<void> {
		const submitting = action.kind === "click" || (action.kind === "press" && SUBMITTING_KEYS[action.key as string] === true);
		if (!submitting) return;
		await this.after(browser);
		const texts = await this.#contentTexts(browser);
		if (texts.length === 0) return;
		const claim = browser.fillClaim;
		if (claim !== undefined && covers(claim.approval, texts)) return;
		const origin = await this.#origin(browser);
		const survey = await this.#approvals.fills(browser.profile, origin);
		const approval = survey.live.find((candidate) => covers(candidate, texts));
		if (approval !== undefined && (await this.#approvals.spendFill(approval))) {
			browser.fillClaim = { approval, until: this.#now() + FILL_CLAIM_MS };
			return;
		}
		if (judge === undefined) needsPerson("the page holds text that is not exactly an approved draft, and no judge is reachable here.");
		if (texts.length > SUBMIT_JUDGE_LIMITS.texts || texts.some((text) => text.value.length > SUBMIT_JUDGE_LIMITS.textChars)) {
			needsPerson("the page holds more text than the judge can read whole.");
		}
		const verdict = await judge({ profile: browser.profile, origin, texts: texts.map((text) => text.value), approvals: judgeEvidence(survey.live) }).catch(
			(error: unknown): SubmitJudgeVerdict => ({ verdict: "unavailable", reason: error instanceof Error ? error.message : String(error) }),
		);
		if (verdict.verdict === "consistent" && verdict.confidence >= JUDGE_CONFIDENCE_BAR) return;
		const why =
			"confidence" in verdict
				? `the judge found the text on the page ${verdict.verdict === "consistent" ? "only weakly" : "not"} consistent with what the person approved or asked for (confidence ${verdict.confidence.toFixed(2)}).`
				: `the judge could not decide (${verdict.verdict}: ${verdict.reason}).`;
		needsPerson(`${why} The text: ${texts.map((text) => excerpt(text.value)).join(", ")}.`);
	}

	async after(browser: GatedBrowser): Promise<void> {
		const claim = browser.fillClaim;
		if (claim === undefined) return;
		if (claim.until <= this.#now()) {
			browser.fillClaim = undefined;
			return;
		}
		const texts = await this.#contentTexts(browser);
		if (!texts.some((text) => claim.approval.digests.has(fillDigest(text.value)))) browser.fillClaim = undefined;
	}

	async submit(browser: GatedBrowser, expected: SubmitExpectation): Promise<{ release(): Promise<void> }> {
		await this.after(browser);
		const origin = await this.#origin(browser);
		if (expected.profile !== browser.profile || expected.origin !== origin) {
			fail("publish_mismatch", `publish_mismatch: this browser is profile ${browser.profile} on ${origin}, but the submit names profile ${expected.profile} on ${expected.origin}. Nothing was clicked.`);
		}
		const texts = await this.#contentTexts(browser);
		const onPage = texts.map((text) => fillDigest(text.value)).sort();
		const named = expected.values.map(fillDigest).sort();
		if (onPage.length !== named.length || onPage.some((digest, index) => digest !== named[index])) {
			fail("publish_mismatch", `publish_mismatch: the values you named are not the text on the page (${texts.map((text) => excerpt(text.value)).join(", ") || "no text"}). Pass values copied exactly from the page's fields. Nothing was clicked.`);
		}
		const claim = browser.fillClaim;
		const nothingToSpend = { release: async () => undefined };
		if (texts.length === 0 || (claim !== undefined && covers(claim.approval, texts))) return nothingToSpend;
		const approval = (await this.#approvals.fills(browser.profile, origin)).live.find((candidate) => covers(candidate, texts));
		if (approval === undefined || !(await this.#approvals.spendFill(approval))) return nothingToSpend;
		browser.fillClaim = { approval, until: this.#now() + FILL_CLAIM_MS };
		return {
			release: async () => {
				browser.fillClaim = undefined;
				await this.#approvals.releaseFill(approval);
			},
		};
	}

	async #contentTexts(browser: GatedBrowser): Promise<EditableText[]> {
		return (await browser.driver.editables()).texts.filter((text) => !text.exempt);
	}

	async #origin(browser: GatedBrowser): Promise<string> {
		const url = (await browser.driver.state()).url;
		const origin = originOf(url);
		if (origin === null || origin === "null") needsPerson(`the page ${excerpt(url)} has no site an approval or the judge can name.`);
		return origin;
	}
}
