/**
 * Mirrors `ARTIFACTORY_SUBMIT_JUDGE_*` and the submit-judge types from `@dimension/sdk/artifactory`
 * (not yet published); keep the two identical.
 */
export const ARTIFACTORY_SUBMIT_JUDGE_EXTENSION_ID = "ai.insodimension/submit-judge";
export const ARTIFACTORY_SUBMIT_JUDGE_METHOD = "ai.insodimension/submit-judge/ask";

export const SUBMIT_JUDGE_LIMITS = {
	texts: 8,
	approvals: 6,
	approvalTexts: 8,
	textChars: 4_000,
	profileChars: 64,
	originChars: 2_048,
} as const;

export interface SubmitJudgeApproval {
	readonly draftId: string;
	readonly texts: readonly string[];
}

export interface SubmitJudgeRequest {
	readonly profile: string;
	readonly origin: string;
	readonly texts: readonly string[];
	readonly approvals: readonly SubmitJudgeApproval[];
}

export type SubmitJudgeVerdict =
	| { readonly verdict: "consistent" | "inconsistent"; readonly confidence: number }
	| { readonly verdict: "unavailable" | "no-evidence"; readonly reason: string };
