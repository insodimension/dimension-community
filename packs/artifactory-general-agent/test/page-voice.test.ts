// The Voice section's rules, read without a DOM: how the two facts the voice lane publishes
// (`speech/profiles`, `speech/agents`) are read when the engine is not the one this bundle was built
// with, which layer the ladder marks as the one in use (the engine's word, never the page's), which
// layers this page may write, and what each profile card says will actually speak.
import { describe, expect, test } from "bun:test";
import {
	type AgentVoice,
	type AssignScope,
	defaultScope,
	isExplicitVoice,
	ladder,
	type LadderRow,
	monogram,
	outrankedBy,
	type ProfilesView,
	profileCards,
	readAgentVoices,
	readProfilesFact,
	scopeStates,
	type ScopeState,
	type VoiceLayers,
	type VoiceSource,
} from "../page/voice";

describe("reading the speech/profiles fact", () => {
	test("an absent or non-object fact is a build with no voice engine; an empty object is an engine with nothing to choose", () => {
		for (const absent of [undefined, null, "profiles", 3, []]) expect(readProfilesFact(absent)).toBeNull();
		expect(readProfilesFact({})).toEqual({ profiles: [], providers: [], defaultName: null });
	});

	test("a malformed profile or step is dropped and takes none of its neighbours", () => {
		const view = readProfilesFact({
			profiles: [
				{ name: "warm", layer: "user", description: "Soft", speak: [{ provider: "eleven", model: "v3", voice: "rachel" }] },
				null,
				7,
				{ name: "no-layer", speak: [] },
				{ name: "bad-layer", layer: "team", speak: [] },
				{ name: "", layer: "user", speak: [] },
				{
					name: "mixed",
					layer: "builtin",
					description: "",
					speak: [{ provider: "eleven", model: "v3" }, { provider: "no-model" }, { model: "no-provider" }, "nonsense", { provider: "local", model: "piper", voice: "" }],
				},
				{ name: "no-chain", layer: "pack", speak: "not-a-list" },
				{ name: "crisp", layer: "workspace", speak: [] },
			],
		});
		expect(view?.profiles).toEqual([
			{ name: "warm", layer: "user", description: "Soft", speak: [{ provider: "eleven", model: "v3", voice: "rachel" }] },
			{
				name: "mixed",
				layer: "builtin",
				speak: [
					{ provider: "eleven", model: "v3" },
					{ provider: "local", model: "piper" },
				],
			},
			{ name: "no-chain", layer: "pack", speak: [] },
			{ name: "crisp", layer: "workspace", speak: [] },
		]);
	});

	test("a malformed provider is dropped; one whose readiness is unreadable is kept as a provider that does not speak", () => {
		const view = readProfilesFact({
			providers: [
				{ id: "eleven", label: "ElevenLabs", speak: { ready: false, reason: "needs-key", detail: "Add a key." } },
				null,
				{ label: "no id" },
				{ id: "" },
				{ id: "bare" },
				{ id: "garbled", label: "Garbled", speak: { ready: "yes" } },
				{ id: "quiet", speak: { ready: true, reason: "", detail: "" } },
			],
		});
		expect(view?.providers).toEqual([
			{ id: "eleven", label: "ElevenLabs", speak: { ready: false, reason: "needs-key", detail: "Add a key." } },
			{ id: "bare", label: "bare" },
			{ id: "garbled", label: "Garbled" },
			{ id: "quiet", label: "quiet", speak: { ready: true } },
		]);
	});

	test("the default is the engine's `default.name` and nothing else", () => {
		expect(readProfilesFact({ default: { name: "warm" } })?.defaultName).toBe("warm");
		for (const unreadable of ["warm", {}, { name: "" }, { name: 4 }, null]) expect(readProfilesFact({ default: unreadable })?.defaultName).toBeNull();
	});
});

describe("reading the speech/agents fact", () => {
	test("an absent or non-object fact leaves no agent with a resolved voice", () => {
		for (const absent of [undefined, null, "agents", 3, []]) expect(readAgentVoices(absent).size).toBe(0);
	});

	test("a malformed row, or one with a source the page does not know, is dropped and takes none of its neighbours", () => {
		const voices = readAgentVoices({
			cmo: { name: "warm", source: "user-config", why: "You chose it" },
			notARow: "warm",
			nothing: null,
			noName: { source: "user-config" },
			emptyName: { name: "", source: "agent" },
			noSource: { name: "warm" },
			unknownSource: { name: "warm", source: "voice-lane" },
			herald: { name: "calm", source: "session" },
		});
		expect([...voices.keys()]).toEqual(["cmo", "herald"]);
		expect(voices.get("cmo")).toEqual({ name: "warm", source: "user-config", why: "You chose it" });
		expect(voices.get("herald")).toEqual({ name: "calm", source: "session", why: "" });
	});

	test("layers keep only the profiles a layer really holds; layers that are not an object are the engine not listing them", () => {
		const voices = readAgentVoices({
			held: { name: "a", source: "agent", layers: { workspace: "w", user: "", agent: 5 } },
			empty: { name: "a", source: "default", layers: {} },
			text: { name: "a", source: "default", layers: "agent" },
			list: { name: "a", source: "default", layers: ["agent"] },
			silent: { name: "a", source: "default" },
		});
		expect(voices.get("held")?.layers).toEqual({ workspace: "w" });
		// Listed and all empty is not the same as not listed: the ladder shows every row for the first.
		expect(voices.get("empty")?.layers).toEqual({});
		for (const unlisted of ["text", "list", "silent"]) expect(voices.get(unlisted)?.layers).toBeUndefined();
	});
});

const voice = (source: VoiceSource, name = "warm", layers?: VoiceLayers): AgentVoice => ({ name, source, why: "", ...(layers ? { layers } : {}) });
const scopesOf = (rows: readonly LadderRow[]) => rows.map(row => row.scope);
const rowOf = (rows: readonly LadderRow[], scope: LadderRow["scope"]) => {
	const found = rows.find(row => row.scope === scope);
	if (!found) throw new Error(`no ${scope} row`);
	return found;
};

describe("the ladder: who may say, and which one is in use", () => {
	// Every layer holds a profile: the row marked is the one the ENGINE's source names, whatever the others hold.
	const everyLayer: VoiceLayers = { workspace: "project-voice", user: "user-voice", agent: "file-voice" };
	const winners: readonly [VoiceSource, LadderRow["scope"] | null][] = [
		["workspace-config", "workspace"],
		["user-config", "user"],
		["agent", "agent"],
		["default", "default"],
		["builtin", "default"],
		// A one-off pick for this session is no layer on the ladder: nothing is marked rather than the wrong row.
		["session", null],
	];

	for (const [source, winner] of winners) {
		test(`the engine saying "${source}" marks ${winner ?? "no row"} as in use, in the order workspace, user, agent, default`, () => {
			const rows = ladder(voice(source, "resolved", everyLayer), "file-voice", "the-default");
			expect(scopesOf(rows)).toEqual(["workspace", "user", "agent", "default"]);
			expect(rows.filter(row => row.wins).map(row => row.scope)).toEqual(winner === null ? [] : [winner]);
		});
	}

	test("each layer row holds what that layer holds", () => {
		const rows = ladder(voice("user-config", "user-voice", { workspace: "project-voice", user: "user-voice" }), "file-voice", "the-default");
		expect(rows.map(row => [row.scope, row.value])).toEqual([
			["workspace", "project-voice"],
			["user", "user-voice"],
			["agent", "file-voice"],
			["default", "the-default"],
		]);
	});

	test("the agent row is the draft: an unsaved edit or clearing shows at once, and neither moves the in-use mark", () => {
		const saved = voice("user-config", "user-voice", { user: "user-voice", agent: "saved-in-file" });
		const edited = ladder(saved, "typed-but-unsaved", null, "saved-in-file");
		expect(rowOf(edited, "agent")).toMatchObject({ value: "typed-but-unsaved", wins: false });
		expect(rowOf(edited, "user").wins).toBe(true);

		const cleared = ladder(saved, "", null, "saved-in-file");
		expect(rowOf(cleared, "agent").value).toBeNull();
		expect(rowOf(cleared, "user").wins).toBe(true);

		// The agent's own choice is what the engine says speaks: an unsaved edit still does not take the mark from it.
		const own = ladder(voice("agent", "saved-in-file", { agent: "saved-in-file" }), "typed-but-unsaved", null, "saved-in-file");
		expect(rowOf(own, "agent")).toMatchObject({ value: "typed-but-unsaved", wins: true });
		expect(own.filter(row => row.wins)).toHaveLength(1);
	});

	const unlisted: readonly [string, AgentVoice | undefined][] = [
		["the agent's own file", voice("agent", "file-voice")],
		["the default", voice("default", "the-default")],
		["the built-in voice", voice("builtin", "on-device")],
		["a session pick", voice("session", "one-off")],
		["no resolved voice yet (a new agent)", undefined],
	];
	for (const [what, resolved] of unlisted) {
		test(`the engine listing no layers while ${what} speaks: the project and yours still get a row, unreported, so where a pick lands is on screen`, () => {
			const rows = ladder(resolved, "file-voice", "the-default");
			expect(scopesOf(rows)).toEqual(["workspace", "user", "agent", "default"]);
			expect(rowOf(rows, "workspace")).toMatchObject({ value: null, reported: false, wins: false });
			expect(rowOf(rows, "user")).toMatchObject({ value: null, reported: false, wins: false });
			// The page itself knows the agent's own file and the default, so those are never "not reported".
			expect(rowOf(rows, "agent")).toMatchObject({ value: "file-voice", reported: true });
			expect(rowOf(rows, "default")).toMatchObject({ reported: true });
		});
	}

	test("the engine listing no layers: the layer it names as the winner is reported, by the name it resolved, and the other one is not", () => {
		const user = ladder(voice("user-config", "user-voice"), "", null);
		expect(scopesOf(user)).toEqual(["workspace", "user", "agent", "default"]);
		expect(rowOf(user, "user")).toMatchObject({ value: "user-voice", reported: true, wins: true });
		expect(rowOf(user, "workspace")).toMatchObject({ value: null, reported: false, wins: false });

		const project = ladder(voice("workspace-config", "project-voice"), "", null);
		expect(scopesOf(project)).toEqual(["workspace", "user", "agent", "default"]);
		expect(rowOf(project, "workspace")).toMatchObject({ value: "project-voice", reported: true, wins: true });
		expect(rowOf(project, "user")).toMatchObject({ value: null, reported: false, wins: false });
	});

	test("the engine listing the layers: every project and user row is reported, so a layer holding nothing is empty and not unknown", () => {
		const nothing = ladder(voice("default", "the-default", {}), "", null);
		expect(rowOf(nothing, "workspace")).toMatchObject({ value: null, reported: true, wins: false });
		expect(rowOf(nothing, "user")).toMatchObject({ value: null, reported: true, wins: false });

		const partial = ladder(voice("user-config", "user-voice", { user: "user-voice" }), "", null);
		expect(rowOf(partial, "workspace")).toMatchObject({ value: null, reported: true });
		expect(rowOf(partial, "user")).toMatchObject({ value: "user-voice", reported: true });
	});

	const allSources: readonly VoiceSource[] = ["workspace-config", "user-config", "agent", "session", "default", "builtin"];
	const pendingCases: readonly { readonly name: string; readonly draft: string; readonly saved: string; readonly pending: boolean }[] = [
		{ name: "an unsaved edit", draft: "typed", saved: "in-file", pending: true },
		{ name: "an unsaved first pick", draft: "typed", saved: "", pending: true },
		{ name: "an unsaved clear", draft: "", saved: "in-file", pending: true },
		{ name: "a draft equal to the file", draft: "in-file", saved: "in-file", pending: false },
		{ name: "an empty draft over an empty file", draft: "", saved: "", pending: false },
	];
	for (const { name, draft, saved, pending } of pendingCases) {
		test(`${name}: the agent's row is ${pending ? "" : "not "}pending, and no other row is, whoever the engine says speaks`, () => {
			for (const source of allSources) {
				for (const layers of [undefined, { workspace: "project-voice", user: "user-voice", agent: "in-file" }]) {
					const rows = ladder(voice(source, "resolved", layers), draft, "the-default", saved);
					expect(rowOf(rows, "agent").pending).toBe(pending);
					expect(rows.filter(row => row.scope !== "agent").map(row => row.pending)).toEqual([false, false, false]);
				}
			}
		});
	}

	test("a pending draft never moves the in-use mark: the engine's source marks the same row whether the draft is unsaved or clean", () => {
		for (const source of allSources) {
			const engine = voice(source, "resolved", everyLayer);
			const clean = ladder(engine, "in-file", "the-default", "in-file").map(row => row.wins);
			for (const draft of ["typed", ""]) {
				expect(ladder(engine, draft, "the-default", "in-file").map(row => row.wins)).toEqual(clean);
			}
		}
	});

	test("the default row is the default voice when that is what speaks, else the default the page was told of", () => {
		// Nothing configured: the engine's built-in on-device voice is the default row's value.
		expect(rowOf(ladder(voice("builtin", "on-device"), "", null), "default")).toMatchObject({ value: "on-device", wins: true });
		expect(rowOf(ladder(voice("default", "the-default"), "", "stale-default"), "default")).toMatchObject({ value: "the-default", wins: true });
		expect(rowOf(ladder(voice("user-config", "user-voice", { user: "user-voice" }), "", "the-default"), "default")).toMatchObject({ value: "the-default", wins: false });
		expect(rowOf(ladder(voice("user-config", "user-voice", { user: "user-voice" }), "", null), "default").value).toBeNull();
	});
});

describe("only a choice earns a mark", () => {
	test("a project's, your own and the agent's own file are choices; a session pick, the default and the built-in voice are not", () => {
		const sources: readonly VoiceSource[] = ["workspace-config", "user-config", "agent", "session", "default", "builtin"];
		expect(sources.filter(source => isExplicitVoice(voice(source)))).toEqual(["workspace-config", "user-config", "agent"]);
		expect(isExplicitVoice(undefined)).toBe(false);
	});
});

describe("what outranks a pick", () => {
	const rows = (workspace: string | null, user: string | null, agent: string | null, fallback: string | null = "the-default"): LadderRow[] => [
		{ scope: "workspace", label: "This project", value: workspace, reported: true, wins: false, pending: false },
		{ scope: "user", label: "You", value: user, reported: true, wins: false, pending: false },
		{ scope: "agent", label: "The agent", value: agent, reported: true, wins: false, pending: false },
		{ scope: "default", label: "Default", value: fallback, reported: true, wins: false, pending: false },
	];
	const outranking = (scope: AssignScope, held: LadderRow[]) => outrankedBy(scope, held)?.scope ?? null;

	test("the nearest more specific layer that holds a value outranks a pick; one that holds none, a less specific one, and the default never do", () => {
		expect(outranking("agent", rows("project-voice", "user-voice", "file-voice"))).toBe("workspace");
		expect(outranking("agent", rows(null, "user-voice", "file-voice"))).toBe("user");
		expect(outranking("user", rows("project-voice", null, null))).toBe("workspace");
		expect(outranking("user", rows(null, "user-voice", "file-voice"))).toBeNull();
		expect(outranking("agent", rows(null, null, "file-voice"))).toBeNull();
		expect(outranking("workspace", rows("project-voice", "user-voice", "file-voice"))).toBeNull();
	});

	test("it reads the rows it is given: a layer the engine never listed cannot outrank, and one it did list still does", () => {
		// The engine named no layer, so the project's and your rows are unreported and hold nothing to outrank with.
		const none = ladder(voice("agent", "file-voice"), "file-voice", "the-default");
		expect(outranking("agent", none)).toBeNull();
		expect(outranking("user", none)).toBeNull();

		// The engine named yours as the winner: that row is reported and outranks the agent's own file; the unreported project row above it is passed over.
		const yours = ladder(voice("user-config", "user-voice"), "file-voice", "the-default");
		expect(outranking("agent", yours)).toBe("user");
		expect(outranking("user", yours)).toBeNull();

		// And the project's, when that is the one named: it outranks yours too.
		const project = ladder(voice("workspace-config", "project-voice"), "file-voice", "the-default");
		expect(outranking("agent", project)).toBe("workspace");
		expect(outranking("user", project)).toBe("workspace");
	});
});

describe("which layers this page may write", () => {
	const open = { editable: true, canAssign: true, hasWorkspace: true, exists: true, heldInFile: false };
	const statesOf = (patch: Partial<typeof open>): Record<AssignScope, ScopeState> => {
		const states = scopeStates({ ...open, ...patch });
		expect(states.map(state => state.scope)).toEqual(["workspace", "user", "agent"]);
		return Object.fromEntries(states.map(state => [state.scope, state])) as Record<AssignScope, ScopeState>;
	};

	test("with everything open, every layer is writable and none gives a reason", () => {
		for (const state of Object.values(statesOf({}))) expect(state).toEqual({ scope: state.scope, enabled: true });
	});

	test("a project or user choice is stored by the agent's name, so it needs the agent to exist; the agent's own file does not", () => {
		const states = statesOf({ exists: false });
		expect(states.workspace.enabled).toBe(false);
		expect(states.user.enabled).toBe(false);
		expect(states.workspace.reason).toBeDefined();
		expect(states.user.reason).toBeDefined();
		expect(states.agent.enabled).toBe(true);
	});

	test("a project or user choice needs a door to write it through; the agent's own file does not", () => {
		const states = statesOf({ canAssign: false });
		expect(states.workspace.enabled).toBe(false);
		expect(states.user.enabled).toBe(false);
		expect(states.agent.enabled).toBe(true);
	});

	test("only a project's choice needs a project to be open", () => {
		const states = statesOf({ hasWorkspace: false });
		expect(states.workspace.enabled).toBe(false);
		expect(states.workspace.reason).toBeDefined();
		expect(states.user.enabled).toBe(true);
		expect(states.agent.enabled).toBe(true);
	});

	test("a pack's agent is read-only: its own file is closed with a reason, and your and the project's choice about it are not", () => {
		const states = statesOf({ editable: false });
		expect(states.agent.enabled).toBe(false);
		expect(states.agent.reason).toBeDefined();
		expect(states.user.enabled).toBe(true);
		expect(states.workspace.enabled).toBe(true);
	});

	test("a voice the agent's file sets in Other settings closes only the agent's own layer, with a reason of its own; yours and the project's stay open", () => {
		const states = statesOf({ heldInFile: true });
		expect(states.agent.enabled).toBe(false);
		expect(states.agent.reason).toBeDefined();
		expect(states.user).toEqual({ scope: "user", enabled: true });
		expect(states.workspace).toEqual({ scope: "workspace", enabled: true });
		// The file is writable here, so this is not the pack's reason: the line is just not the profile's to change.
		expect(states.agent.reason).not.toBe(statesOf({ editable: false }).agent.reason);
	});

	test("on a pack's read-only agent the pack's reason is the one given, whether or not its file holds the voice", () => {
		expect(statesOf({ editable: false, heldInFile: true }).agent).toEqual(statesOf({ editable: false }).agent);
	});

	test("a pick lands on yours first, then the agent's own file, then the project's", () => {
		const landing = (patch: Partial<typeof open>) => defaultScope(scopeStates({ ...open, ...patch }));
		expect(landing({})).toBe("user");
		expect(landing({ editable: false })).toBe("user");
		// No door to write config through: only the agent's own file is left.
		expect(landing({ canAssign: false })).toBe("agent");
		expect(landing({ exists: false })).toBe("agent");
		// The project is last: with yours closed and the file closed, it is what is left.
		const onlyProject: ScopeState[] = [{ scope: "workspace", enabled: true }, { scope: "user", enabled: false }, { scope: "agent", enabled: false }];
		expect(defaultScope(onlyProject)).toBe("workspace");
	});
});

// ---------------------------------------------------------------------------------------------
// The profile gallery
// ---------------------------------------------------------------------------------------------

type Readiness = { ready: boolean; reason?: string; detail?: string };
const provider = (id: string, label: string, speak?: Readiness) => ({ id, label, ...(speak ? { speak } : {}) });
const chain = (name: string, ...providers: string[]) => ({ name, layer: "user" as const, speak: providers.map(id => ({ provider: id, model: `${id}-model` })) });
const viewOf = (profiles: ProfilesView["profiles"], providers: ProfilesView["providers"]): ProfilesView => ({ profiles, providers, defaultName: null });
const cardOf = (profiles: ProfilesView["profiles"], providers: ProfilesView["providers"], name = "p") => {
	const card = profileCards(viewOf(profiles, providers)).find(candidate => candidate.name === name);
	if (!card) throw new Error(`no card ${name}`);
	return card;
};

const READY: Readiness = { ready: true };
const NEEDS_KEY: Readiness = { ready: false, reason: "needs-key", detail: "Add an ElevenLabs key in Settings." };

describe("what a profile card says will speak", () => {
	test("when the first choice is ready it speaks, nothing is blocking it, and a ready provider's detail is not a complaint", () => {
		const card = cardOf([chain("p", "eleven", "local")], [provider("eleven", "ElevenLabs", { ready: true, detail: "Voice library loaded" }), provider("local", "On-device", READY)]);
		expect(card.speaksWith).toEqual({ label: "ElevenLabs", fellBack: false });
		expect(card.needs).toBeUndefined();
		expect(card.steps.map(step => [step.providerLabel, step.ready, step.detail])).toEqual([
			["ElevenLabs", true, undefined],
			["On-device", true, undefined],
		]);
	});

	test("when the first choice is not ready, the first ready entry speaks and the card says what is in the first one's way", () => {
		const card = cardOf([chain("p", "eleven", "local")], [provider("eleven", "ElevenLabs", NEEDS_KEY), provider("local", "On-device", READY)]);
		expect(card.speaksWith).toEqual({ label: "On-device", fellBack: true });
		expect(card.needs).toMatch(/^ElevenLabs needs an API key\./);
		expect(card.needs).toContain("Add an ElevenLabs key in Settings.");
		expect(card.steps[0]).toMatchObject({ providerLabel: "ElevenLabs", ready: false, state: { tone: "warn", text: "Needs an API key" }, detail: "Add an ElevenLabs key in Settings." });
	});

	test("down a longer chain, the third speaks, and only the FIRST choice is what the card blames", () => {
		const card = cardOf(
			[chain("p", "eleven", "openai", "azure")],
			[provider("eleven", "ElevenLabs", { ready: false, reason: "needs-download" }), provider("openai", "OpenAI", { ready: false, reason: "unavailable", detail: "Offline." }), provider("azure", "Azure", READY)],
		);
		expect(card.speaksWith).toEqual({ label: "Azure", fellBack: true });
		expect(card.needs).toMatch(/^ElevenLabs needs a download\./);
		expect(card.needs).not.toContain("OpenAI");
	});

	test("with no ready entry the on-device voice speaks in its place when it is ready, and nothing does when it is not", () => {
		const blocked = [provider("eleven", "ElevenLabs", NEEDS_KEY)];
		// `local` is not named by the profile: it is the engine's own last resort.
		const withLocal = cardOf([chain("p", "eleven")], [...blocked, provider("local", "On-device", READY)]);
		expect(withLocal.speaksWith).toEqual({ label: "On-device", fellBack: true });
		expect(withLocal.needs).toMatch(/^ElevenLabs needs an API key\./);

		for (const local of [provider("local", "On-device", NEEDS_KEY), provider("local", "On-device")]) {
			expect(cardOf([chain("p", "eleven")], [...blocked, local]).speaksWith).toBeNull();
		}
		expect(cardOf([chain("p", "eleven")], blocked).speaksWith).toBeNull();
	});

	test("the on-device provider named first and ready is the profile's own voice, not a fall back", () => {
		const card = cardOf([chain("p", "local")], [provider("local", "On-device", READY)]);
		expect(card.speaksWith).toEqual({ label: "On-device", fellBack: false });
	});

	test("a provider the profile names that is not installed cannot speak, however ready the others are, and is labelled by its id", () => {
		const card = cardOf([chain("p", "gone-pack", "eleven")], [provider("eleven", "ElevenLabs", READY)]);
		expect(card.steps[0]).toMatchObject({ providerLabel: "gone-pack", ready: false, state: { tone: "warn", text: "Not installed" } });
		expect(card.speaksWith).toEqual({ label: "ElevenLabs", fellBack: true });
		expect(card.needs).toMatch(/^gone-pack is not installed\./);

		const alone = cardOf([chain("p", "gone-pack")], []);
		expect(alone.speaksWith).toBeNull();
		expect(alone.needs).toMatch(/^gone-pack is not installed\./);
	});

	test("a provider that publishes no readiness does not speak, and says so rather than 'not ready'", () => {
		const card = cardOf([chain("p", "mute")], [provider("mute", "Mute")]);
		expect(card.steps[0]?.state).toMatchObject({ tone: "off", text: "Does not speak" });
		expect(card.needs).toMatch(/^Mute does not speak\./);
		expect(card.steps[0]?.ready).toBe(false);
		expect(card.speaksWith).toBeNull();
	});

	test("a reason the page has no sentence for, or none at all, says 'Not ready'", () => {
		for (const reason of ["rate-limited", ""]) {
			const card = cardOf([chain("p", "x")], [provider("x", "X", { ready: false, reason })]);
			expect(card.steps[0]?.state).toMatchObject({ tone: "warn", text: "Not ready", phrase: "is not ready" });
		}
		expect(cardOf([chain("p", "x")], [provider("x", "X", { ready: false })]).needs).toMatch(/^X is not ready\./);
	});

	test("a profile with no entries has no first choice to blame: the on-device voice speaks for it, or nothing does", () => {
		const empty = { name: "p", layer: "user" as const, speak: [] };
		const spoken = cardOf([empty], [provider("local", "On-device", READY)]);
		expect(spoken.steps).toEqual([]);
		expect(spoken.speaksWith).toEqual({ label: "On-device", fellBack: true });
		expect(spoken.needs).toBeUndefined();

		const silent = cardOf([empty], []);
		expect(silent.speaksWith).toBeNull();
		expect(silent.needs).toBeUndefined();
	});

	test("each profile gets its own card, in the order the engine listed them, judged by its own chain", () => {
		const providers = [provider("eleven", "ElevenLabs", NEEDS_KEY), provider("local", "On-device", READY)];
		const cards = profileCards(viewOf([chain("zed", "local"), chain("alpha", "eleven"), chain("mid", "eleven", "local")], providers));
		expect(cards.map(card => [card.name, card.speaksWith])).toEqual([
			["zed", { label: "On-device", fellBack: false }],
			["alpha", { label: "On-device", fellBack: true }],
			["mid", { label: "On-device", fellBack: true }],
		]);
		expect(cards.map(card => card.needs !== undefined)).toEqual([false, true, true]);
	});
});

describe("a provider's mark", () => {
	const cases: readonly [label: string, mark: string][] = [
		["ElevenLabs", "EL"],
		["Open AI", "OA"],
		["On-device voice", "OD"],
		["Google Cloud Text To Speech", "GC"],
		["x", "X"],
		["  ", ""],
		["", ""],
	];
	for (const [label, mark] of cases) test(`"${label}" is ${mark === "" ? "no mark" : mark}`, () => expect(monogram(label)).toBe(mark));
});
