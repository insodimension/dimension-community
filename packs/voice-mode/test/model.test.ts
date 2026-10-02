/** WHAT BREAKS FOR THE USER IF THIS GOES RED: the Voice pane crashes (and takes the whole Settings screen's pane with
 *  it) on a fact shape the engine sends that this bundle was not built against, or it tells the user the wrong thing
 *  about what will actually speak: "speaks with ElevenLabs" when the key is missing, or "cannot speak" when the
 *  on-device voice would. The facts are an untrusted boundary: they come from an engine newer or older than the pane. */
import { describe, expect, test } from "bun:test";
import { headline, modelRows, profileViews, readAgents, readModelsFact, readProfilesFact } from "../src/model";

const ELEVEN = { provider: "elevenlabs", model: "eleven_v4_turbo", voice: "EXAVITQu4vr4xnSDxMaL" };
const KOKORO = { provider: "local", model: "kokoro", voice: "af_heart" };

function fact(over: { elevenlabs?: unknown; local?: unknown; profiles?: unknown; default?: unknown } = {}) {
	return {
		profiles: over.profiles ?? [
			{ name: "aether", layer: "pack", description: "Warm", speak: [ELEVEN, KOKORO] },
			{ name: "local", layer: "builtin", speak: [KOKORO] },
		],
		providers: [
			{ id: "elevenlabs", label: "ElevenLabs", speak: over.elevenlabs ?? { ready: true } },
			{ id: "local", label: "On this machine", speak: over.local ?? { ready: true }, listen: { ready: true } },
		],
		default: over.default ?? { name: "aether", source: "default", why: "your voice.default" },
	};
}

const viewOf = (raw: unknown) => {
	const view = readProfilesFact(raw);
	if (!view) throw new Error("fact did not parse");
	return view;
};

describe("reading the speech/profiles fact", () => {
	test("an absent or non-object fact is 'no speech runtime', not an error", () => {
		expect(readProfilesFact(undefined)).toBeNull();
		expect(readProfilesFact("nope")).toBeNull();
		expect(readProfilesFact([])).toBeNull();
		expect(headline(null).tone).toBe("off");
	});

	test("a malformed row is dropped alone: the rest of the pane still renders", () => {
		const view = viewOf(
			fact({
				profiles: [
					{ name: "good", layer: "user", speak: [ELEVEN, { provider: "local" }, "junk", { model: "x" }] },
					{ name: "no-layer", speak: [ELEVEN] },
					{ name: "weird-layer", layer: "galaxy", speak: [ELEVEN] },
					null,
					42,
				],
			}),
		);
		expect(view.profiles.map(profile => profile.name)).toEqual(["good"]);
		expect(view.profiles[0]?.speak).toEqual([ELEVEN]);
	});

	test("a layer name that is a prototype property is not a layer", () => {
		const view = viewOf(fact({ profiles: [{ name: "p", layer: "toString", speak: [ELEVEN] }] }));
		expect(view.profiles).toEqual([]);
	});
});

describe("what a voice will actually speak with", () => {
	test("the first READY choice speaks, not the first listed", () => {
		const [aether] = profileViews(viewOf(fact({ elevenlabs: { ready: false, reason: "needs-key" } })));
		expect(aether?.steps.map(step => step.state.text)).toEqual(["Needs an API key", "Ready"]);
		expect(aether?.speaksWith).toEqual({ label: "On this machine", fellBack: true, because: "ElevenLabs" });
	});

	test("with every listed choice down, the on-device voice is the last resort and it says so", () => {
		const [aether] = profileViews(
			viewOf(
				fact({
					profiles: [{ name: "aether", layer: "pack", speak: [ELEVEN] }],
					elevenlabs: { ready: false, reason: "needs-key" },
				}),
			),
		);
		expect(aether?.speaksWith).toEqual({ label: "On this machine", fellBack: true, because: "ElevenLabs" });
	});

	test("nothing ready anywhere: it cannot speak, and the headline names the default voice", () => {
		const view = viewOf(
			fact({ elevenlabs: { ready: false, reason: "needs-key" }, local: { ready: false, reason: "needs-download" } }),
		);
		expect(profileViews(view)[0]?.speaksWith).toBeNull();
		expect(headline(view)).toEqual({ tone: "warn", text: "The default voice, aether, has nothing ready to speak with." });
	});

	test("a profile naming a provider that is not installed shows 'Not installed', never a guessed label", () => {
		const [ghost] = profileViews(
			viewOf(fact({ profiles: [{ name: "ghost", layer: "user", speak: [{ provider: "xai", model: "grok-voice", voice: "v" }] }] })),
		);
		expect(ghost?.steps[0]).toMatchObject({ providerLabel: "xai", ready: false, state: { text: "Not installed" } });
	});

	test("the default is marked on exactly one profile", () => {
		const defaults = profileViews(viewOf(fact())).filter(profile => profile.isDefault);
		expect(defaults.map(profile => profile.name)).toEqual(["aether"]);
	});

	test("a healthy default reads as a plain sentence, and a fallback says which choice was not ready", () => {
		expect(headline(viewOf(fact()))).toEqual({ tone: "ok", text: "The default voice, aether, speaks with ElevenLabs." });
		expect(headline(viewOf(fact({ elevenlabs: { ready: false, reason: "needs-key" } }))).text).toBe(
			"The default voice, aether, speaks with On this machine: ElevenLabs is not ready.",
		);
	});
});

describe("agents", () => {
	test("disabled and duplicate agents are dropped, the rest sorted by the name a person sees", () => {
		const rows = readAgents([
			{ name: "coding", enabled: true, voice: "aether" },
			{ name: "aether", title: "Aether", enabled: true },
			{ name: "coding", title: "Dupe", enabled: true },
			{ name: "off", enabled: false },
			{ title: "no name" },
			"junk",
		]);
		expect(rows).toEqual([
			{ name: "aether", title: "Aether", voice: null },
			{ name: "coding", title: "coding", voice: "aether" },
		]);
	});

	test("anything that is not a list is no agents", () => {
		expect(readAgents(undefined)).toEqual([]);
		expect(readAgents({ coding: {} })).toEqual([]);
	});
});

describe("the two model roles", () => {
	const catalog = [
		{ providerId: "anthropic", modelId: "haiku", label: "Haiku", available: true },
		{ providerId: "openai", modelId: "mini", label: "Mini", available: true },
		{ providerId: "openai", modelId: "locked", label: "Locked", available: false },
		{ providerId: "typesafe", modelId: "jev", label: "Jev", available: true, kind: "classify" },
		{ providerId: "typesafe", modelId: "jev", label: "Jev", available: true, kind: "classify" },
	];

	test("classify-only models never count as chat models, and unavailable ones count for nothing", () => {
		expect(readModelsFact(catalog)).toEqual({ chat: 2, classifiers: ["Jev"] });
	});

	test("rows name only what is connected: they never claim a model the Store cannot tell them", () => {
		const [voice, classifier] = modelRows(readModelsFact(catalog));
		expect(voice).toMatchObject({ role: "voice", tone: "ok" });
		expect(voice?.says).toBe("2 chat models are connected to write spoken replies.");
		expect(classifier).toMatchObject({ role: "classifier", tone: "ok", says: "Jev can judge what is worth saying." });
	});

	test("no chat model and no classifier: voice mode still works, the rows say how", () => {
		const [voice, classifier] = modelRows(readModelsFact([]));
		expect(voice).toMatchObject({ tone: "warn" });
		expect(voice?.says).toContain("read out as written");
		expect(classifier).toMatchObject({ tone: "off", says: "None connected: a plain rule decides what is worth saying." });
	});

	test("an unpublished catalog is 'not known yet', not 'none connected'", () => {
		expect(readModelsFact(undefined)).toBeNull();
		expect(modelRows(null).map(row => row.tone)).toEqual(["off", "off"]);
	});
});

/** The classifier's words leave the machine, so what the pane says about WHERE is the part that must not be wrong:
 *  a false "nothing is sent", a dropped host, or a claim on an engine that said nothing would each mislead the user. */
describe("the classifier row says where the classifier's input goes", () => {
	const catalog = [{ providerId: "typesafe", modelId: "jev-latest", label: "Jev", available: true, kind: "classify" }];
	const remote = { provider: "typesafe", model: "jev-latest", leavesDevice: true, host: "api.typesafe.ai" };
	const rowFor = (classifier: unknown, models: unknown = catalog) => {
		const view = viewOf({ ...fact(), ...(classifier === undefined ? {} : { classifier }) });
		return modelRows(readModelsFact(models), view.classifier)[1];
	};

	test("a remote classifier names the model and the host, what is sent, and that voice mode off sends nothing", () => {
		const row = rowFor(remote);
		expect(row?.says).toContain("typesafe/jev-latest");
		expect(row?.hint).toContain("api.typesafe.ai");
		expect(row?.hint).toContain("last six messages");
		expect(row?.hint).toContain("last spoken line");
		expect(row?.hint).toContain("scrubbed of code, paths and secrets");
		expect(row?.hint).toContain("While voice mode is on");
		expect(row?.hint).toContain("With voice mode off, nothing is sent.");
		expect(row?.disclosure).toBe(true);
	});

	test("a remote classifier whose host the engine did not name still says it is sent away, never 'on this device'", () => {
		const row = rowFor({ provider: "typesafe", model: "jev-latest", leavesDevice: true });
		expect(row?.hint).toContain("go to typesafe");
		expect(row?.hint).not.toContain("this device");
	});

	test("a classifier on this device says nothing leaves it, and a stray host does not turn it into a remote one", () => {
		const row = rowFor({ provider: "local", model: "kev", leavesDevice: false, host: "api.typesafe.ai" });
		expect(row?.says).toContain("local/kev");
		expect(row?.hint).toContain("runs on this device; nothing leaves it.");
		expect(row?.hint).not.toContain("api.typesafe.ai");
		expect(row?.hint).not.toContain("last six messages");
	});

	test("null is 'no classifier resolves': a plain rule decides and nothing is sent, even with a classify model connected", () => {
		const row = rowFor(null);
		expect(row).toMatchObject({ tone: "off", says: "No classifier is connected: a plain rule decides, and nothing is sent." });
		expect(row?.disclosure).toBeUndefined();
	});

	test("an engine that does not say (no key) keeps today's row: the connected classify models, no claim about where", () => {
		expect("classifier" in viewOf(fact())).toBe(false);
		const row = rowFor(undefined);
		expect(row).toEqual(modelRows(readModelsFact(catalog))[1]);
		expect(row?.says).toBe("Jev can judge what is worth saying.");
		expect(row?.hint).not.toContain("nothing is sent");
		expect(row?.disclosure).toBeUndefined();
	});

	test("the engine's word stands even when the models catalog is not published yet", () => {
		expect(rowFor(remote, null)?.hint).toContain("api.typesafe.ai");
		expect(rowFor(null, null)?.says).toContain("nothing is sent");
	});

	test("a malformed classifier is 'the engine did not say': no throw, and never the reassuring 'nothing is sent'", () => {
		const malformed: unknown[] = [
			false,
			0,
			"",
			"typesafe/jev-latest",
			7,
			[],
			{},
			{ provider: "typesafe", model: "jev-latest" },
			{ provider: "typesafe", model: "jev-latest", leavesDevice: "true" },
			{ provider: "typesafe", model: "jev-latest", leavesDevice: 1 },
			{ provider: "", model: "jev-latest", leavesDevice: true, host: "api.typesafe.ai" },
			{ provider: "typesafe", model: 3, leavesDevice: true },
		];
		for (const value of malformed) {
			const view = viewOf({ ...fact(), classifier: value });
			expect(view.classifier).toBeUndefined();
			expect(view.profiles.map(profile => profile.name)).toEqual(["aether", "local"]);
			expect(modelRows(readModelsFact(catalog), view.classifier)[1]).toEqual(modelRows(readModelsFact(catalog))[1]);
		}
	});
});
