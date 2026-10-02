// What Save does across the profile's two files, in order. Each write is checked
// against the revision the profile read it at, so a write that lands must bring
// the profile up to date at once: a later step that fails must not leave it
// holding a revision the server already refuses (so the next Save is refused for
// a change this very page made).
import { describe, expect, test } from "bun:test";
import { blankDraft } from "../src/agent-md";
import type { InstructionsSaved, SaveOutcome, SaveTarget } from "../src/contracts";
import { saveProfile } from "../page/profile-save";

const draft = { ...blankDraft("user::herald"), name: "herald", description: "d", charter: "c" };
const target: SaveTarget = { create: false, tier: "user", revision: "agent-r1" };
const WROTE_AGENT: SaveOutcome = { path: "/agents/herald/agent.md", relativePath: "agent/agents/herald/agent.md", created: false, tier: "user" };
const WROTE_TEXT: InstructionsSaved = { path: "/home/AGENTS.md", kind: "home" };

/** A forge that logs each call and fails the ones named in `fail`. */
function forgeThat(log: string[], fail: { agent?: string; instructions?: string } = {}) {
	return {
		save: async () => {
			log.push("save");
			if (fail.agent !== undefined) throw new Error(fail.agent);
			return WROTE_AGENT;
		},
		saveInstructions: async (name: string, text: string, revision: string) => {
			log.push(`saveInstructions ${name} ${text} ${revision}`);
			if (fail.instructions !== undefined) throw new Error(fail.instructions);
			return WROTE_TEXT;
		},
	};
}

function hooksThat(log: string[]) {
	return {
		agentWritten: () => void log.push("agentWritten"),
		instructionsWritten: async () => {
			await Promise.resolve();
			log.push("instructionsWritten");
		},
	};
}

describe("saving the agent and its standing instructions", () => {
	test("the agent is written first, and the profile is reopened on it before the instructions are tried", async () => {
		const log: string[] = [];
		await saveProfile(forgeThat(log), { agent: { draft, target }, instructions: { name: "herald", text: "Be brief.", revision: "text-r1" } }, hooksThat(log));
		expect(log).toEqual(["save", "agentWritten", "saveInstructions herald Be brief. text-r1", "instructionsWritten"]);
	});

	test("instructions refused after the agent landed: the profile was already reopened, and the error is about the instructions alone", async () => {
		const log: string[] = [];
		const forge = forgeThat(log, { instructions: "the file changed since you opened it" });
		const failure = await saveProfile(forge, { agent: { draft, target }, instructions: { name: "herald", text: "x", revision: "stale" } }, hooksThat(log)).catch((cause: Error) => cause);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe("The agent was saved, but its standing instructions were not: the file changed since you opened it");
		// Reopened (so the next Save carries the new agent revision) and never told the instructions landed.
		expect(log).toEqual(["save", "agentWritten", "saveInstructions herald x stale"]);
	});

	test("instructions alone that are refused say what the server said, and reopen nothing", async () => {
		const log: string[] = [];
		const forge = forgeThat(log, { instructions: "the file changed since you opened it" });
		await expect(saveProfile(forge, { instructions: { name: "herald", text: "x", revision: "stale" } }, hooksThat(log))).rejects.toThrow("the file changed since you opened it");
		expect(log).toEqual(["saveInstructions herald x stale"]);
	});

	test("instructions written: the caller refreshes the home and drops its copy BEFORE the save resolves", async () => {
		const log: string[] = [];
		let release: () => void = () => undefined;
		const refreshed = new Promise<void>(resolve => {
			release = resolve;
		});
		const saving = saveProfile(forgeThat(log), { instructions: { name: "herald", text: "x", revision: "r" } }, {
			agentWritten: () => void log.push("agentWritten"),
			instructionsWritten: async () => {
				log.push("refreshing");
				await refreshed;
				log.push("refreshed");
			},
		}).then(() => log.push("resolved"));
		await Promise.resolve();
		await Promise.resolve();
		expect(log).toEqual(["saveInstructions herald x r", "refreshing"]);
		release();
		await saving;
		expect(log).toEqual(["saveInstructions herald x r", "refreshing", "refreshed", "resolved"]);
	});

	test("an agent that is refused writes nothing else and reopens nothing", async () => {
		const log: string[] = [];
		const forge = forgeThat(log, { agent: "the file changed since you opened it" });
		await expect(saveProfile(forge, { agent: { draft, target }, instructions: { name: "herald", text: "x", revision: "r" } }, hooksThat(log))).rejects.toThrow("the file changed since you opened it");
		expect(log).toEqual(["save"]);
	});
});
