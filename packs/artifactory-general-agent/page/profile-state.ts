// An agent's profile as state: the draft on screen, what it was when opened,
// which tier it saves to, why it cannot be saved, and a Machinist proposal the
// human has not decided on yet. Pure: the page draws this, the tests read it.
//
// SECURITY (doc 58 §3). A proposal lands through `applyProposal`, which copies
// only the proposable fields and never a grant-class one, whatever the object
// carries. Accepting keeps the draft as it stands; discarding restores the
// draft from before the proposal, so neither path can move a grant.
import {
	type AgentDraft,
	type AgentProposal,
	applyProposal,
	blankDraft,
	draftProblems,
	NAME_RE,
	PROPOSABLE_FIELDS,
	type ProposableField,
} from "../src/agent-md";
import type { ListedAgent, SaveTarget, StoredProposal } from "../src/contracts";

/** A Machinist proposal the human has not decided on: the server's id for it,
 *  the fields it changed, and the draft to go back to on Discard (`null`: it
 *  started a new agent). */
export interface PendingProposal {
	readonly ids: readonly string[];
	readonly fields: readonly ProposableField[];
	readonly before: AgentDraft | null;
}

export interface ProfileState {
	readonly draft: AgentDraft;
	/** The listed agent this profile edits; absent for a new one. */
	readonly agent?: ListedAgent;
	/** Why it cannot be saved here (a pack agent, a legacy file). */
	readonly readOnly?: string;
	readonly proposal?: PendingProposal;
}

let drafts = 0;
/** A local identity for a draft not yet on disk; survives renames. */
export function newDraftKey(): string {
	drafts += 1;
	return `draft-${Date.now().toString(36)}-${drafts}`;
}

export function isNew(state: ProfileState): boolean {
	return state.agent === undefined;
}

/** A profile opened on a listed agent. */
export function openListed(agent: ListedAgent): ProfileState {
	return {
		draft: { ...agent.draft },
		agent,
		...(agent.editable ? {} : { readOnly: agent.readOnlyReason ?? "This agent is read-only here." }),
	};
}

/** A new agent: a blank charter, speaking only as itself. */
export function openBlank(): ProfileState {
	return { draft: blankDraft(newDraftKey()) };
}

/**
 * A read-only agent's way forward: a NEW agent that extends it, prefilled with
 * its settings so the human sees what they start from. Its name is theirs to
 * give. `extra` stays behind: the keys it holds reach the new agent through
 * `extends` anyway, and copying them would make every one an override.
 */
export function extendFrom(base: AgentDraft): ProfileState {
	const blank = blankDraft(newDraftKey());
	return {
		draft: {
			...base,
			key: blank.key,
			name: "",
			vibr: base.vibr === "" ? blank.vibr : base.vibr,
			models: [...base.models],
			tools: [...base.tools],
			skills: [...base.skills],
			mcp: [...base.mcp],
			lineage: [base.name],
			extra: "",
		},
	};
}

/**
 * A proposal arrives. It rides on the profile it names: the open one when it is
 * that agent (or a new agent still unnamed), else the listed, editable agent of
 * that name, else a new agent. Only the fields it actually changed are marked
 * (a grant it tried to carry changed nothing, so it is not claimed); fields
 * proposed earlier and not yet decided stay marked, and Discard still returns
 * to the draft before the FIRST of them.
 */
export function receiveProposal(current: ProfileState | null, id: string, proposal: AgentProposal, agents: readonly ListedAgent[]): ProfileState {
	let base: ProfileState;
	let before: AgentDraft | null;
	if (current !== null && (current.draft.name === proposal.name || (isNew(current) && current.draft.name === ""))) {
		base = current;
		before = current.proposal?.before ?? current.draft;
	} else {
		const listed = agents.find(agent => agent.name === proposal.name && agent.editable);
		base = listed !== undefined ? openListed(listed) : openBlank();
		before = listed !== undefined ? base.draft : null;
	}
	const draft = applyProposal(base.draft, proposal);
	const changed = PROPOSABLE_FIELDS.filter(field => field !== "name" && JSON.stringify(draft[field]) !== JSON.stringify(base.draft[field]));
	const kept = base === current ? current?.proposal : undefined;
	const marked = new Set<ProposableField>([...(kept?.fields ?? []), ...changed]);
	const ids = [...(kept?.ids ?? []), id];
	return { ...base, draft, proposal: { ids, fields: [...marked], before } };
}

/** Keep the proposal: the draft stays as it is, unmarked. */
export function acceptProposal(state: ProfileState): ProfileState {
	const { proposal: _decided, ...rest } = state;
	return rest;
}

/** Throw the proposal away: back to the draft before it, or, when it started
 *  a new agent, no profile at all (`null`). */
export function discardProposal(state: ProfileState): ProfileState | null {
	if (state.proposal === undefined) return state;
	const { proposal, ...rest } = state;
	return proposal.before === null ? null : { ...rest, draft: proposal.before };
}

/**
 * The proposals still waiting on the human: not carried by the open profile
 * (which answers for them) and not decided. Read off what the profile holds
 * each time rather than remembered, so a proposal on a profile that closed
 * without a decision is waiting again, as it still is on the server.
 */
export function proposalsToReview(all: readonly StoredProposal[], open: ProfileState | null, decided: ReadonlySet<string>): StoredProposal[] {
	const carried = open?.proposal?.ids ?? [];
	return all.filter(entry => !decided.has(entry.id) && !carried.includes(entry.id));
}

/**
 * Which of the waiting proposals land on `profile` as soon as they are read:
 * those that name its agent, or, for a new agent still unnamed, the first one
 * alone. That one names the draft; the next is another agent's and keeps
 * waiting on the home, instead of replacing the profile and vanishing.
 */
export function proposalsForProfile(profile: ProfileState, waiting: readonly StoredProposal[]): StoredProposal[] {
	if (isNew(profile) && profile.draft.name === "") return waiting.slice(0, 1);
	return waiting.filter(entry => entry.proposal.name === profile.draft.name);
}

// ── validation ───────────────────────────────────────────────────────────────

/** The inline errors, by field, so each control says what is wrong with it. */
export interface FieldErrors {
	readonly name?: string;
	readonly description?: string;
	readonly charter?: string;
}

export function fieldErrors(state: ProfileState, agents: readonly { readonly name: string }[]): FieldErrors {
	const { draft } = state;
	const errors: { name?: string; description?: string; charter?: string } = {};
	if (isNew(state)) {
		if (draft.name === "") errors.name = "Give it an id: lowercase letters, digits and dashes.";
		else if (!NAME_RE.test(draft.name)) errors.name = "2 to 64 lowercase letters, digits or dashes, starting with a letter or digit.";
		else if (agents.some(agent => agent.name === draft.name)) errors.name = `An agent with the id “${draft.name}” already exists.`;
	}
	if (draft.description.trim() === "") errors.description = "Say in one line what it is for.";
	if (draft.charter.trim() === "") errors.charter = "Write its charter: the instructions it runs by.";
	return errors;
}

/**
 * Everything standing between the profile and a save, in the order a person
 * fixes them: why it is read-only, an undecided proposal, the fields, then the
 * document's own problems (Other settings) and the server's verdict.
 */
export function saveBlockers(state: ProfileState, agents: readonly { readonly name: string }[], serverProblems: readonly string[]): string[] {
	if (state.readOnly !== undefined) return [state.readOnly];
	const errors = fieldErrors(state, agents);
	const fieldMessages = [errors.name, errors.description, errors.charter].filter((message): message is string => message !== undefined);
	// `draftProblems` repeats the field rules in its own words; the fields already said them.
	const documentProblems = draftProblems(state.draft).filter(
		problem => !problem.startsWith("Name it") && !problem.startsWith("Give it one line") && !problem.startsWith("Write its charter"),
	);
	return [...(state.proposal !== undefined ? ["Accept or discard the Machinist’s proposal first."] : []), ...fieldMessages, ...documentProblems, ...serverProblems];
}

/** Whether the draft differs from the file it was opened from; a new agent always does. */
export function isDirty(state: ProfileState): boolean {
	if (state.agent === undefined) return true;
	return JSON.stringify(state.draft) !== JSON.stringify(state.agent.draft);
}

/** What a save asks the server to do, or why it cannot. */
export function saveTargetOf(state: ProfileState): SaveTarget | string {
	if (state.agent === undefined) return { create: true };
	const { source, revision } = state.agent;
	if (source === "pack" || revision === undefined) return "This agent was opened without its tier and revision, so it cannot be rewritten; reopen it.";
	return { create: false, tier: source, revision };
}
