// The wire between the pack's server and its page: the structuredContent each
// tool answers with. Types only — both halves import it, neither re-derives it.
import type { AgentDraft, AgentProposal } from "./agent-md";

export type PartKind = "tool" | "skill" | "mcp" | "memory" | "lineage";

export interface Part {
	readonly kind: PartKind;
	readonly id: string;
	readonly label: string;
	readonly hint: string;
}

/** The tier an agent lives in, in the engine's own words:
 *  `pack` — `<pack>/general-agents/<name>/agent.md` in an installed plugin;
 *  `user` — `$INSO_HOME/agent/agents/<name>/agent.md`, where `agent_create` and
 *  the Forge write: follows the user into every workspace and has a home;
 *  `workspace` — `<root>/<config dir>/agents/<name>/agent.md` (or the legacy
 *  `.omp/`): one project's own agent, with no home. */
export type AgentSource = "workspace" | "user" | "pack";

/** The two tiers the Forge may write. */
export type WritableTier = Exclude<AgentSource, "pack">;

export interface ListedAgent {
	readonly name: string;
	readonly description: string;
	readonly source: AgentSource;
	/** The installed plugin directory it ships in — pack agents only. */
	readonly pack?: string;
	/** Absolute path of the agent.md. */
	readonly path: string;
	/** Whether `save_agent` may rewrite it: false only for a pack agent and for a
	 *  legacy `.omp/` file — every key the orrery does not draw is kept, so
	 *  nothing else makes a file unwritable. */
	readonly editable: boolean;
	readonly readOnlyReason?: string;
	/** Digest of the file as listed. A rewrite names it, and is refused when the
	 *  file changed since — a hand edit is never overwritten unseen. Absent for a
	 *  pack agent. */
	readonly revision?: string;
	/** The `workspace.id` its manifest names, when it names one (a home, a pinned workspace). */
	readonly workspaceId?: string;
	/** The agent as the Forge draws it. `key` is `<source>:<pack>:<name>`. */
	readonly draft: AgentDraft;
}

export interface AgentListing {
	/** The workspace root project agents are read from; null = none bound. */
	readonly workspace: string | null;
	/** The project config dir agents live under (`.inso`, or the dev engine's `.inso-dev`). */
	readonly configDir: string;
	/** Where new agents are written (`$INSO_HOME/agent/agents`); null when the
	 *  engine did not tell this server where its home is. */
	readonly userAgentsDir: string | null;
	readonly agents: readonly ListedAgent[];
	/** Things the human should know: an invalid file, a shadowed name, why pack
	 *  agents are missing, why there is no workspace. */
	readonly notices: readonly string[];
}

export interface PartListing {
	readonly parts: readonly Part[];
	/** Every place a part list was read from, so the tray can say so. */
	readonly sources: readonly string[];
	/** Part kinds (or halves of them) that could not be sourced, each with why. */
	readonly omitted: readonly string[];
}

/** What `save_agent` is asked to do. */
export type SaveTarget =
	/** A new agent — always the user tier, where `agent_create` writes. Refused when the name is taken anywhere. */
	| { readonly create: true }
	/** Rewrite the agent in `tier`, which must still be the file listed as `revision`. */
	| { readonly create: false; readonly tier: WritableTier; readonly revision: string };

export interface SaveOutcome {
	/** Absolute path written. */
	readonly path: string;
	/** Relative to the tier's root, `/`-separated: the workspace for a project
	 *  agent, the product home for a user agent. */
	readonly relativePath: string;
	readonly created: boolean;
	readonly tier: WritableTier;
}

/** One place an agent-level `AGENTS.md` may live. */
export interface InstructionFile {
	/** The engine's own names (`agent-receipt.ts`): `workspace-copy` — a project's
	 *  copy for a pack agent; `home` — the writable file that follows the agent;
	 *  `pack` / `agent-dir` — the sibling of `agent.md`, the unset default. */
	readonly kind: "workspace-copy" | "home" | "pack" | "agent-dir";
	readonly path: string;
	readonly exists: boolean;
	readonly bytes: number;
	/** The file OMP loads as the agent's standing instructions. */
	readonly wins: boolean;
}

export interface AgentInstructions {
	/** Strongest first — the order OMP looks in. */
	readonly files: readonly InstructionFile[];
	/** What the winning file holds; "" when none exists. */
	readonly text: string;
	readonly editable: boolean;
	/** The tier rules in words, and why it is read-only when it is. */
	readonly note: string;
	/** Where a save writes: the home `AGENTS.md` once the home folder exists, else
	 *  the sibling of `agent.md` (which seeds the home on its first provisioning).
	 *  `revision` digests that path and what it holds now — `save_instructions`
	 *  is refused unless it still matches, so neither an edit made elsewhere since
	 *  this was read nor a home provisioned since (the target moved) is overwritten. */
	readonly target: { readonly path: string; readonly kind: "home" | "agent-dir"; readonly revision: string } | null;
}

/** An agent's home: the folder, the standing instructions and the memory room
 *  that follow it from workspace to workspace (doc 83 §1.4). */
export interface AgentHome {
	readonly name: string;
	/** A listed agent of this name exists; false for a name still being typed. */
	readonly exists: boolean;
	/** The tier it lives in — `user` for a name that does not exist yet (where new agents land). */
	readonly source: AgentSource;
	/** `home-<name>`, the SDK's `agentHomeWorkspaceId` — what Lives = home writes. */
	readonly homeId: string;
	/** Whether the tier allows a home at all: a project agent belongs to one project and has none. */
	readonly canStandAtHome: boolean;
	/** Whether the engine registers this agent's home today. */
	readonly hasHome: boolean;
	/** Why it has, or has not, a home. */
	readonly homeNote: string;
	/** `$INSO_HOME/workspaces/<homeId>`; null when there is no home or no INSO_HOME. */
	readonly folder: string | null;
	readonly folderExists: boolean;
	/** The memory room its recall follows it from: its own home's, or the workspace its manifest names. */
	readonly memoryRoom: string;
	readonly instructions: AgentInstructions;
}

export interface InstructionsSaved {
	readonly path: string;
	readonly kind: "home" | "agent-dir";
}

/** `validate_agent`'s answer: why the draft cannot be written, from the same
 *  checks `save_agent` makes (empty = it can). */
export interface DraftCheck {
	readonly problems: readonly string[];
}

/** `forge_open`'s answer: the agent it read, and the workspace it read in. */
export interface ForgeOpened {
	readonly agent: string | null;
	readonly workspace: string | null;
}

/** `forge_propose`'s answer: the proposal as the page will show it. */
export interface ForgeProposed {
	readonly id: string;
	readonly proposal: AgentProposal;
}

/** A proposal the server holds until the human accepts or discards it on the page. */
export interface StoredProposal {
	readonly id: string;
	readonly proposal: AgentProposal;
	/** Epoch ms it was proposed. */
	readonly at: number;
	/** The workspace the proposing session was bound to; `null`: it had none, and every page sees it. */
	readonly workspace: string | null;
}

/** `pending_proposals`' answer, oldest first. */
export interface PendingProposals {
	readonly proposals: readonly StoredProposal[];
}

/** `dismiss_proposal`'s answer: false when it was no longer pending. */
export interface ProposalDismissed {
	readonly dismissed: boolean;
}
