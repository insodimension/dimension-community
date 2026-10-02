// The General Agents page's rules, read without a DOM: which cards a facet
// shows, what stops a draft from saving, what a Machinist proposal may and may
// not change when it is accepted or discarded, what extending a pack's agent
// starts from, and how a gesture writes a key the profile does not draw.
import { describe, expect, test } from "bun:test";
import { type AgentDraft, type AgentProposal, blankDraft } from "../src/agent-md";
import type { AgentSource, ListedAgent, StoredProposal } from "../src/contracts";
import { changedExtraPaths } from "../src/extra";
import { setExtraPath } from "../page/extra-edit";
import { rememberFaces } from "../page/faces";
import {
	acceptProposal,
	discardProposal,
	extendFrom,
	fieldErrors,
	openBlank,
	openListed,
	type ProfileState,
	proposalsForProfile,
	proposalsToReview,
	receiveProposal,
	saveBlockers,
} from "../page/profile-state";
import { allowlistOf, type Facet, inFacet, isEditable, joinRoster } from "../page/roster";
import type { AgentFact, FaceBinding } from "../page/types";

function listed(name: string, source: AgentSource, patch: Partial<AgentDraft> = {}): ListedAgent {
	const draft: AgentDraft = { ...blankDraft(`${source}::${name}`), name, description: `${name} agent`, charter: `You are ${name}.`, ...patch };
	return {
		name,
		description: draft.description,
		source,
		path: `/general-agents/${name}/agent.md`,
		editable: source !== "pack",
		...(source === "pack" ? { pack: "dimension-agents", readOnlyReason: "It ships in a pack." } : { revision: "r1" }),
		draft,
	};
}

function fact(name: string, provenance: AgentFact["provenance"], enabled = true): AgentFact {
	return { name, description: `${name} agent`, provenance, enabled, listed: true };
}

const FILES = [listed("machinist", "pack"), listed("coding", "pack"), listed("herald", "user"), listed("scribe", "user"), listed("reviewer", "workspace")];

describe("the roster and its facets", () => {
	const names = (facet: Facet, facts: readonly AgentFact[] | undefined) =>
		joinRoster(facts, FILES)
			.filter(agent => inFacet(agent, facet))
			.map(agent => agent.name);

	test("each tier facet shows exactly that tier's agents, the file's tier winning over the host's word", () => {
		expect(names("yours", undefined)).toEqual(["herald", "scribe"]);
		expect(names("packs", undefined)).toEqual(["machinist", "coding"]);
		expect(names("project", undefined)).toEqual(["reviewer"]);
		// An agent the host knows and no file lists yet still has a tier: its provenance.
		expect(names("yours", [fact("fresh", "local"), fact("scribe", "dimension")])).toEqual(["fresh", "scribe", "herald"]);
	});

	test("before the files arrive, a pack's agent linked from disk (provenance local) is a pack agent, not yours", () => {
		const linked: AgentFact = { ...fact("designer", "local"), pluginId: "dimension-agents" };
		const roster = joinRoster([linked, fact("fresh", "local")], undefined);
		expect(roster.filter(agent => inFacet(agent, "yours")).map(agent => agent.name)).toEqual(["fresh"]);
		expect(roster.filter(agent => inFacet(agent, "packs")).map(agent => agent.name)).toEqual(["designer"]);
	});

	test("Off is the host's word: only agents the host reports disabled, never ones it says nothing about", () => {
		expect(names("off", [fact("scribe", "local", false), fact("herald", "local")])).toEqual(["scribe"]);
		expect(names("off", undefined)).toEqual([]);
	});
	test("a host-only migration leftover stays visible but cannot be edited; a visible file restores editability", () => {
		const leftover = { ...fact("stranded-agent", "local"), description: "A project historian" };
		const [hostOnly] = joinRoster([leftover], []);
		expect(isEditable(hostOnly!)).toBe(false);
		expect(hostOnly?.listed).toBeUndefined();
		expect(hostOnly).toMatchObject({ name: "stranded-agent", tier: "user", fact: { description: "A project historian" } });
		const [moved] = joinRoster([leftover], [listed("stranded-agent", "user")]);
		expect(isEditable(moved!)).toBe(true);
	});
});

describe("draft validation", () => {
	test("a new agent needs a valid, free name, a description and a charter", () => {
		const blank = openBlank();
		expect(Object.keys(fieldErrors(blank, FILES)).sort()).toEqual(["charter", "description", "name"]);
		expect(fieldErrors({ ...blank, draft: { ...blank.draft, name: "-lead", description: "d", charter: "c" } }, FILES).name).toBeDefined();
		expect(fieldErrors({ ...blank, draft: { ...blank.draft, name: "herald", description: "d", charter: "c" } }, FILES).name).toContain("already exists");
		const good = { ...blank, draft: { ...blank.draft, name: "release-herald", description: "Writes notes", charter: "You write." } };
		expect(fieldErrors(good, FILES)).toEqual({});
		expect(saveBlockers(good, FILES, [])).toEqual([]);
	});

	test("a read-only agent, an undecided proposal and the server's verdict each block", () => {
		expect(saveBlockers(openListed(listed("coding", "pack")), FILES, [])).toEqual(["It ships in a pack."]);
		const good = { ...openBlank(), draft: { ...openBlank().draft, name: "new-one", description: "d", charter: "c" } };
		expect(saveBlockers(good, FILES, ["does not load"])).toEqual(["does not load"]);
		const proposed = receiveProposal(openListed(listed("herald", "user")), "p1", { name: "herald", description: "New line" }, FILES);
		expect(saveBlockers(proposed, FILES, [])).toHaveLength(1);
	});
});

describe("a Machinist proposal, accepted or discarded, never moves a grant", () => {
	const guarded = (draft: AgentDraft) => ({ tools: draft.tools, mcp: draft.mcp, approval: draft.approval, memoryScope: draft.memoryScope, habitat: draft.habitat, lineage: draft.lineage, extra: draft.extra });
	const base = listed("herald", "user", {
		tools: ["read"],
		mcp: ["palace"],
		approval: "always-ask",
		memoryScope: "project",
		habitat: "bound",
		extra: "capabilities:\n  control: [observe]",
	});
	// Everything a hostile model might smuggle past its schema, typed away.
	const hostile = {
		name: "herald",
		description: "Proposed line",
		charter: "Proposed charter",
		tools: ["bash", "write"],
		mcp: ["browser"],
		approval: "yolo",
		memoryScope: "global",
		habitat: "home",
		lineage: ["coding"],
		extra: "capabilities:\n  control: [observe, agents]",
	} as unknown as AgentProposal;

	test("it lands on the agent it names, changes what it may, and marks only those fields", () => {
		const received = receiveProposal(null, "p1", hostile, FILES.map(agent => (agent.name === "herald" ? base : agent)));
		expect(received.agent?.name).toBe("herald");
		expect(received.draft.description).toBe("Proposed line");
		// `habitat` is workspace.policy and `lineage` is `extends` (a base's whole grant): the human's, never a proposal's.
		expect(received.draft.habitat).toBe("bound");
		expect(received.draft.lineage).toEqual([]);
		expect(received.proposal?.fields).toEqual(["description", "charter"]);
		expect(received.proposal?.ids).toEqual(["p1"]);
	});

	test("accepting keeps the proposal's words and none of the grants it carried", () => {
		const accepted = acceptProposal(receiveProposal(openListed(base), "p1", hostile, [base]));
		expect(accepted.proposal).toBeUndefined();
		expect(accepted.draft.description).toBe("Proposed line");
		expect(guarded(accepted.draft)).toEqual(guarded(base.draft));
	});

	test("discarding restores the human's own draft, grants included", () => {
		const edited: ProfileState = { ...openListed(base), draft: { ...base.draft, tools: ["read", "grep"] } };
		const discarded = discardProposal(receiveProposal(edited, "p1", hostile, [base]));
		expect(discarded?.proposal).toBeUndefined();
		expect(discarded?.draft).toEqual(edited.draft);
	});

	test("a second proposal before a decision is decided with the first: both ids, back to the draft before either", () => {
		const first = receiveProposal(openListed(base), "p1", { name: "herald", description: "One" }, [base]);
		const second = receiveProposal(first, "p2", { name: "herald", charter: "Two" }, [base]);
		expect(second.proposal?.fields).toEqual(["description", "charter"]);
		expect(second.proposal?.ids).toEqual(["p1", "p2"]);
		expect(discardProposal(second)?.draft).toEqual(base.draft);
	});

	test("one that starts a new agent discards to no profile at all", () => {
		const fresh = receiveProposal(null, "p1", { name: "brand-new", description: "x" }, [base]);
		expect(fresh.agent).toBeUndefined();
		expect(discardProposal(fresh)).toBeNull();
	});

	test("lineage through Other settings is no way round: `extends` there stops the save until the human removes it", () => {
		const smuggled = receiveProposal(openListed(base), "p1", { name: "herald", extra: "extends: [coding]" }, [base]);
		expect(saveBlockers(acceptProposal(smuggled), FILES, []).join(" ")).toContain("extends");
	});

	test("a proposed voice lands on the open draft and is marked; a proposal that leaves it out keeps the human's own, and discarding restores it", () => {
		const mine = listed("herald", "user", { voice: "mine" });
		const proposed = receiveProposal(openListed(mine), "p1", { name: "herald", voice: "calm-low" }, [mine]);
		expect(proposed.draft.voice).toBe("calm-low");
		expect(proposed.proposal?.fields).toEqual(["voice"]);
		expect(discardProposal(proposed)?.draft.voice).toBe("mine");
		const silent = receiveProposal(openListed(mine), "p2", { name: "herald", description: "New line" }, [mine]);
		expect(silent.draft.voice).toBe("mine");
		expect(silent.proposal?.fields).toEqual(["description"]);
	});

	test("a proposed voice that is not a profile name is no way round the save check: the save is blocked until the human changes it", () => {
		const accepted = (voice: string) => acceptProposal(receiveProposal(openListed(base), "p1", { name: "herald", voice }, [base]));
		expect(saveBlockers(accepted("Not A Name"), FILES, []).length).toBeGreaterThan(0);
		expect(saveBlockers(accepted("calm-low"), FILES, [])).toEqual([]);
	});

	// An overlay that would move the grants the file holds is refused (`applyProposal`): the field must not read as proposed.
	test("an overlay the draft's grants refuse is not marked as proposed, while the rest of the proposal lands and a harmless overlay is marked", () => {
		const lead = listed("lead", "user", { extra: "subagents: { allowed: [scout], maxDepth: 2 }" });
		const refused = receiveProposal(openListed(lead), "p1", { name: "lead", description: "New line", extra: "subagents:\n  maxDepth: 3" }, [lead]);
		expect(refused.draft.extra).toBe(lead.draft.extra);
		expect(refused.draft.description).toBe("New line");
		expect(refused.proposal?.fields).toEqual(["description"]);

		const overlaid = receiveProposal(openListed(lead), "p2", { name: "lead", extra: "title: Scout lead" }, [lead]);
		expect(overlaid.draft.extra).toBe("subagents: { allowed: [scout], maxDepth: 2 }\ntitle: Scout lead");
		expect(overlaid.proposal?.fields).toEqual(["extra"]);
	});
});

describe("which proposals wait, and which land on the open profile", () => {
	const stored = (id: string, name: string): StoredProposal => ({ id, at: 0, workspace: null, proposal: { name, description: `${name} line` } });
	const herald = stored("p1", "herald");
	const scout = stored("p2", "data-scout");
	const none: ReadonlySet<string> = new Set();

	test("a new, unnamed agent takes ONE proposal; the next, another agent's, is not swallowed", () => {
		const blank = openBlank();
		expect(proposalsForProfile(blank, [herald, scout]).map(entry => entry.id)).toEqual(["p1"]);

		const named = receiveProposal(blank, herald.id, herald.proposal, FILES);
		expect(named.draft.name).toBe("herald");
		// The first one named the draft; the second is no business of this profile, and still waits.
		expect(proposalsToReview([herald, scout], named, none).map(entry => entry.id)).toEqual(["p2"]);
		expect(proposalsForProfile(named, [scout])).toEqual([]);
	});

	test("an agent on screen takes the proposals that name it, and only those", () => {
		const open = openListed(FILES.find(agent => agent.name === "herald") as ListedAgent);
		expect(proposalsForProfile(open, [scout, herald]).map(entry => entry.id)).toEqual(["p1"]);
	});

	test("a proposal on a profile that closes without a decision is waiting again; a decided one never is", () => {
		const carrying = receiveProposal(openListed(FILES.find(agent => agent.name === "herald") as ListedAgent), herald.id, herald.proposal, FILES);
		expect(proposalsToReview([herald, scout], carrying, none).map(entry => entry.id)).toEqual(["p2"]);
		// "All agents" without Accept or Discard: no profile carries it any more.
		expect(proposalsToReview([herald, scout], null, none).map(entry => entry.id)).toEqual(["p1", "p2"]);
		expect(proposalsToReview([herald, scout], null, new Set(["p1"])).map(entry => entry.id)).toEqual(["p2"]);
	});
});

describe("faces are remembered per name", () => {
	test("a name resolves once per memo and hands every caller the same binding; a new memo resolves afresh", () => {
		let calls = 0;
		const resolve = (name: string): FaceBinding => {
			calls += 1;
			return { avatar: name } as unknown as FaceBinding;
		};
		const faceOf = rememberFaces(resolve);
		expect(faceOf("herald")).toBe(faceOf("herald"));
		expect(faceOf("scout")).not.toBe(faceOf("herald"));
		expect(calls).toBe(2);
		expect(rememberFaces(resolve)("herald")).not.toBe(faceOf("herald"));
	});
});

describe("extending a pack's agent", () => {
	test("opens a new, nameless agent that extends it and starts from its settings, with nothing held over", () => {
		const pack = listed("coding", "pack", { vibr: "lattice", voice: "warm-studio", thinking: "high", models: ["anthropic/claude-sonnet-4.5"], skills: ["code-health"], promptMode: "append", extra: "routing:\n  card: Code" });
		const extended = extendFrom(pack.draft);
		expect(extended.agent).toBeUndefined();
		expect(extended.draft.name).toBe("");
		expect(extended.draft.lineage).toEqual(["coding"]);
		expect(extended.draft).toMatchObject({ vibr: "lattice", voice: "warm-studio", thinking: "high", models: ["anthropic/claude-sonnet-4.5"], skills: ["code-health"], promptMode: "append", charter: pack.draft.charter });
		expect(extended.draft.extra).toBe("");
		expect(extended.draft.key).not.toBe(pack.draft.key);
		// A fresh copy: editing it never edits the pack's draft.
		extended.draft.skills.push("checkpoint");
		expect(pack.draft.skills).toEqual(["code-health"]);
	});
});

describe("a gesture writes a key the profile does not draw", () => {
	test("sets, replaces and removes one child, keeping every other line as written", () => {
		const extra = "title: Chief\ncapabilities:\n  autoloadSkills: [fallow]\nrouting:\n  card: Marketing";
		const set = setExtraPath(extra, "capabilities.plugins", "[browser, reach]");
		expect(set).toBe("title: Chief\ncapabilities:\n  autoloadSkills: [fallow]\n  plugins: [browser, reach]\nrouting:\n  card: Marketing");
		expect(setExtraPath(set, "capabilities.plugins", "[browser]")).toContain("  plugins: [browser]\n");
		expect(setExtraPath(set, "capabilities.plugins", null)).toBe(extra);
	});

	test("an emptied section goes, a missing one is added, and an inline section is never split", () => {
		expect(setExtraPath("capabilities:\n  control: [observe]\ntitle: X", "capabilities.control", null)).toBe("title: X");
		expect(setExtraPath("title: X", "capabilities.control", "[observe, agents]")).toBe("title: X\ncapabilities:\n  control: [observe, agents]");
		expect(setExtraPath("capabilities: { tools: [read] }", "capabilities.plugins", "[browser]")).toBe("capabilities: { tools: [read] }");
	});

	test("an allowlist reads its three states off the draft: every one, none, or those", () => {
		const draft = { ...blankDraft("k"), skills: ["checkpoint"], extra: "capabilities:\n  tools: []\n  plugins: [browser]" };
		expect(allowlistOf(draft, "skills")).toEqual({ kind: "some", names: ["checkpoint"] });
		expect(allowlistOf(draft, "tools")).toEqual({ kind: "none" });
		expect(allowlistOf(draft, "plugins")).toEqual({ kind: "some", names: ["browser"] });
		expect(allowlistOf(draft, "mcp")).toEqual({ kind: "all" });
	});

	test("a legacy flat `tools:` line is the allowlist: its list, or none for `[]`, never 'every tool'", () => {
		expect(allowlistOf({ ...blankDraft("k"), extra: "tools: [read]" }, "tools")).toEqual({ kind: "some", names: ["read"] });
		expect(allowlistOf({ ...blankDraft("k"), extra: "tools: []" }, "tools")).toEqual({ kind: "none" });
	});
});

describe("the parts of Other settings a proposal moved", () => {
	test("names a key it added, a key it changed inside a section, and nothing it left alone", () => {
		const before = "title: Chief\ncapabilities:\n  autoloadSkills: [fallow]\n  slashCommands: [review]";
		const after = "title: Chief\ncapabilities:\n  autoloadSkills: [fallow, checkpoint]\n  slashCommands: [review]\nrouting:\n  card: Marketing";
		expect(changedExtraPaths(before, after)).toEqual(["capabilities.autoloadSkills", "routing.card"]);
		expect(changedExtraPaths(before, before)).toEqual([]);
	});

	test("a section the overlay re-wrote at another indent is not a change, and a key it dropped is one", () => {
		const before = "capabilities:\n    autoloadSkills: [fallow]\nrouting:\n    card: A\n    lane: B";
		const after = "capabilities:\n  autoloadSkills: [fallow]\nrouting:\n  card: A";
		expect(changedExtraPaths(before, after)).toEqual(["routing.lane"]);
	});

	test("an agent the proposal started has every key it set marked", () => {
		expect(changedExtraPaths("", "title: Scout\nengine:\n  profile: fast")).toEqual(["title", "engine.profile"]);
	});
});
