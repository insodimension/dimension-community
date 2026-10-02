// What Save does, in order, apart from the screen that asks for it. A profile
// is two files: the agent's agent.md and its standing instructions (AGENTS.md).
// Each write is checked against the revision the profile read it at, and each
// one that lands changes that revision, so the profile must be brought up to
// date the moment a write succeeds, not at the end of the whole save: a later
// step that fails would otherwise leave it holding a revision the server
// already refuses.
import type { AgentDraft } from "../src/agent-md";
import type { SaveTarget } from "../src/contracts";
import { errorText, type Forge } from "./forge";

export interface SaveRequest {
	/** The agent file, when the draft changed. */
	readonly agent?: { readonly draft: AgentDraft; readonly target: SaveTarget };
	/** The standing instructions, when they changed. */
	readonly instructions?: { readonly name: string; readonly text: string; readonly revision: string };
}

export interface SaveHooks {
	/** The agent file is written: reopen the profile on it. */
	readonly agentWritten: () => void;
	/** The instructions are written: read the home again, then let go of the local copy. */
	readonly instructionsWritten: () => Promise<void>;
}

/** Write what changed, agent first. Rejects with the words to show; when the
 *  agent was already written, they say so and name only the instructions as
 *  failed (the profile has been reopened on the saved agent by then). */
export async function saveProfile(forge: Pick<Forge, "save" | "saveInstructions">, request: SaveRequest, hooks: SaveHooks): Promise<void> {
	if (request.agent !== undefined) {
		await forge.save(request.agent.draft, request.agent.target);
		hooks.agentWritten();
	}
	if (request.instructions === undefined) return;
	const { name, text, revision } = request.instructions;
	try {
		await forge.saveInstructions(name, text, revision);
	} catch (cause) {
		throw new Error(request.agent === undefined ? errorText(cause) : `The agent was saved, but its standing instructions were not: ${errorText(cause)}`);
	}
	await hooks.instructionsWritten();
}
