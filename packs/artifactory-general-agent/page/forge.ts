// The page's one door to its own pack's server: `store.call("callOwnServerTool")`
// (C-B), which the seat's `artifactory:call` grant opens. It resolves with the
// tool's structured answer and rejects with the tool's own words, so a refused
// save reaches the profile as text it can show inline.
import type { AgentDraft } from "../src/agent-md";
import type { AgentHome, AgentListing, DraftCheck, InstructionsSaved, PendingProposals, ProposalDismissed, SaveOutcome, SaveTarget } from "../src/contracts";
import type { PageStore } from "./types";

export const NO_CALL_DOOR = "This host does not let the General Agents page call its server (the artifactory:call grant), so agents cannot be read or saved here.";

export interface Forge {
	listAgents(): Promise<AgentListing>;
	validate(draft: AgentDraft): Promise<DraftCheck>;
	save(draft: AgentDraft, target: SaveTarget): Promise<SaveOutcome>;
	home(name: string): Promise<AgentHome>;
	saveInstructions(name: string, text: string, revision: string): Promise<InstructionsSaved>;
	pendingProposals(): Promise<PendingProposals>;
	dismissProposal(id: string): Promise<ProposalDismissed>;
	/** Switch an agent on or off, show or hide it in the rail (`agents:configure`). */
	configure(name: string, patch: { readonly enabled?: boolean; readonly listed?: boolean }): Promise<void>;
}

export function forgeOf(store: PageStore, workspace: string | undefined): Forge {
	const tool = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
		if (store.call === undefined) throw new Error(NO_CALL_DOOR);
		const scoped = workspace === undefined ? args : { ...args, workspace };
		return (await store.call("callOwnServerTool", { tool: name, args: scoped })) as T;
	};
	return {
		listAgents: () => tool<AgentListing>("list_agents"),
		validate: draft => tool<DraftCheck>("validate_agent", { draft }),
		save: (draft, target) =>
			tool<SaveOutcome>("save_agent", target.create ? { draft, create: true } : { draft, create: false, tier: target.tier, revision: target.revision }),
		home: name => tool<AgentHome>("agent_home", { name }),
		saveInstructions: (name, text, revision) => tool<InstructionsSaved>("save_instructions", { name, text, revision }),
		// The inbox is per workspace: the server hands back this one's proposals, and those made with none.
		pendingProposals: () => tool<PendingProposals>("pending_proposals"),
		dismissProposal: async id => {
			if (store.call === undefined) throw new Error(NO_CALL_DOOR);
			return (await store.call("callOwnServerTool", { tool: "dismiss_proposal", args: { id } })) as ProposalDismissed;
		},
		configure: async (name, patch) => {
			if (store.call === undefined) throw new Error(NO_CALL_DOOR);
			await store.call("configureGeneralAgent", { name, ...patch });
		},
	};
}

export function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
