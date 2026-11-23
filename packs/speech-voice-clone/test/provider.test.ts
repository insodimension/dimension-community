import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SpeakSession, SpeechProvider, SpeechProviderContext } from "@dimension/sdk/provider";
import { createVoiceCloneProvider } from "../src/index.js";
import { type Layout, layoutAt } from "../src/layout.js";
import type { CloneModel, LockPlatform } from "../src/registry.js";
import type { WorkerPool } from "../src/runtime.js";
import { guideFor } from "../src/tags.js";
import { addVoice, BREEZE, closeSessions, dummyUv, FakeLiveWorker, FISH, markInstalled, QWEN, Recorder, REGISTRY, speaksSeconds, TempDirs, VOXCPM, writeText } from "./support.js";
import { failureOf } from "./outcome.js";

const temp = new TempDirs();
afterEach(async () => {
	closeSessions();
	await temp.dispose();
});

interface Acquisition {
	readonly layout: Layout;
	readonly model: CloneModel;
	readonly env: Readonly<Record<string, string | undefined>>;
}

interface RigOptions {
	readonly platform?: NodeJS.Platform;
	readonly uv?: "env" | "home-local" | "none";
	readonly voices?: readonly string[];
	readonly installed?: readonly CloneModel[];
	readonly dataRoot?: "env" | "engine";
}

interface Rig {
	readonly provider: SpeechProvider;
	readonly ctx: SpeechProviderContext;
	readonly layout: Layout;
	readonly engineHome: string;
	readonly lock: LockPlatform;
	readonly worker: FakeLiveWorker;
	readonly acquisitions: Acquisition[];
}

async function makeRig(options: RigOptions = {}): Promise<Rig> {
	const platform = options.platform ?? "win32";
	const lock: LockPlatform = platform === "linux" ? "linux" : "windows";
	const userHome = await temp.make("vc-user-");
	const engineHome = await temp.make("vc-engine-");
	const bin = await temp.make("vc-bin-");
	const dataRoot = options.dataRoot ?? "env";
	const root = dataRoot === "engine" ? join(engineHome, "speech", "voice-clone") : await temp.make("vc-data-");
	const layout = layoutAt(root);
	const env: Record<string, string> = {};
	if (dataRoot === "env") env.DIMENSION_VOICE_CLONE_HOME = root;

	const uv = options.uv ?? "env";
	if (uv === "env") env.UV = await dummyUv(bin);
	else if (uv === "home-local") await dummyUv(join(userHome, ".local", "bin"));

	for (const name of options.voices ?? ["me"]) await addVoice(layout, name, `Words spoken by ${name}.`);
	for (const model of options.installed ?? []) await markInstalled(layout, model, lock);

	const worker = new FakeLiveWorker(speaksSeconds(0.2, QWEN.sampleRate));
	const acquisitions: Acquisition[] = [];
	const pool = {
		acquire: (acquiredLayout: Layout, model: CloneModel, acquiredEnv: Readonly<Record<string, string | undefined>>) => {
			acquisitions.push({ layout: acquiredLayout, model, env: acquiredEnv });
			return Promise.resolve({ worker: worker.asLiveWorker(), release: () => {} });
		},
	} as unknown as WorkerPool;

	const provider = createVoiceCloneProvider({ pool, userHome, platform });
	const ctx: SpeechProviderContext = {
		home: engineHome,
		cwd: userHome,
		env,
		settings: { get: () => undefined },
		credentials: { withAccess: () => Promise.reject(new Error("this provider reads no login")) },
	};
	return { provider, ctx, layout, engineHome, lock, worker, acquisitions };
}

async function open(rig: Rig, entry: { model?: string; voice?: string; options?: Record<string, unknown> } = {}, audioTags = true, signal = new AbortController().signal): Promise<SpeakSession> {
	if (!rig.provider.openSpeak) throw new Error("provider has no openSpeak");
	return rig.provider.openSpeak(rig.ctx, { model: entry.model ?? QWEN.id, voice: entry.voice ?? "me", ...(entry.options ? { options: entry.options } : {}) }, { signal, audioTags });
}

function prepare(rig: Rig, target: { kind: "speak" | "listen" | "animate"; model: string }, onProgress: (fraction: number) => void = () => {}, signal = new AbortController().signal): Promise<void> {
	if (!rig.provider.prepare) throw new Error("provider has no prepare");
	return rig.provider.prepare(rig.ctx, target, onProgress, signal);
}

function detailOf(readiness: { ready: boolean; detail?: string } | undefined): string {
	return readiness && !readiness.ready ? (readiness.detail ?? "") : "";
}

const UNSUPPORTED_PLATFORMS = ["darwin", "freebsd", "openbsd", "sunos", "aix"] as const;

describe("status", () => {
	test.each(UNSUPPORTED_PLATFORMS)("%s is unavailable, and says why: the models need an NVIDIA GPU on Windows or Linux", async platform => {
		const rig = await makeRig({ platform, installed: [QWEN] });
		const { speak } = await rig.provider.status(rig.ctx);
		expect(speak).toMatchObject({ ready: false, reason: "unavailable" });
		expect(detailOf(speak)).toMatch(/NVIDIA/);
		expect(detailOf(speak)).toMatch(/Windows or Linux/);
	});

	test("the platform is checked before uv and voices, so a Mac is never told to install uv", async () => {
		const rig = await makeRig({ platform: "darwin", uv: "none", voices: [] });
		const detail = detailOf((await rig.provider.status(rig.ctx)).speak);
		expect(detail).toContain("NVIDIA");
		expect(detail).not.toContain("uv");
	});

	test.each(["linux", "win32"] as const)("%s is not blocked by the platform check", async platform => {
		const rig = await makeRig({ platform, installed: [QWEN] });
		expect((await rig.provider.status(rig.ctx)).speak).toEqual({ ready: true });
	});

	test("without uv it is unavailable and tells the user to install uv or set UV", async () => {
		const rig = await makeRig({ uv: "none" });
		const { speak } = await rig.provider.status(rig.ctx);
		expect(speak).toMatchObject({ ready: false, reason: "unavailable" });
		expect(detailOf(speak)).toContain("Install uv");
		expect(detailOf(speak)).toContain("UV");
		expect(detailOf(speak)).toContain("https://docs.astral.sh/uv");
	});

	test("the uv check comes before the voices check", async () => {
		const rig = await makeRig({ uv: "none", voices: [] });
		expect(detailOf((await rig.provider.status(rig.ctx)).speak)).toContain("uv");
	});

	test.each(["env", "home-local"] as const)("uv found through %s counts", async uv => {
		const rig = await makeRig({ uv, installed: [QWEN] });
		expect((await rig.provider.status(rig.ctx)).speak).toEqual({ ready: true });
	});

	test("uv found on PATH counts", async () => {
		const rig = await makeRig({ uv: "none", installed: [QWEN] });
		const bin = await temp.make("vc-pathbin-");
		await dummyUv(bin);
		const ctx = { ...rig.ctx, env: { ...rig.ctx.env, PATH: bin } };
		expect((await rig.provider.status(ctx)).speak).toEqual({ ready: true });
	});

	test("without a voice it is unavailable and says exactly where to put one", async () => {
		const rig = await makeRig({ voices: [] });
		const { speak } = await rig.provider.status(rig.ctx);
		expect(speak).toMatchObject({ ready: false, reason: "unavailable" });
		const detail = detailOf(speak);
		expect(detail).toContain(rig.layout.voices);
		expect(detail).toContain(".wav");
		expect(detail).toContain(".txt");
	});

	test("a recording without its words is not a voice, so the provider is still unavailable", async () => {
		const rig = await makeRig({ voices: [] });
		await writeText(join(rig.layout.voices, "me.wav"), "RIFF");
		expect((await rig.provider.status(rig.ctx)).speak).toMatchObject({ ready: false, reason: "unavailable" });
		await writeText(join(rig.layout.voices, "me.txt"), "   ");
		expect((await rig.provider.status(rig.ctx)).speak).toMatchObject({ ready: false, reason: "unavailable" });
		await writeText(join(rig.layout.voices, "me.txt"), "Now with words.");
		expect((await rig.provider.status(rig.ctx)).speak).toMatchObject({ ready: false, reason: "needs-download" });
	});

	test("with a voice but no model installed every model needs a download, each naming its size", async () => {
		const rig = await makeRig();
		const { speak, byModel } = await rig.provider.status(rig.ctx);
		expect(speak).toMatchObject({ ready: false, reason: "needs-download" });
		for (const model of REGISTRY.models) {
			expect(byModel?.speak?.[model.id]).toEqual({ ready: false, reason: "needs-download", detail: `${model.label} is not downloaded yet (${model.sizeHint})` });
		}
	});

	test("readiness is per model: an installed model is ready while the others still need a download", async () => {
		const rig = await makeRig({ installed: [QWEN] });
		const { speak, byModel } = await rig.provider.status(rig.ctx);
		expect(speak).toEqual({ ready: true });
		expect(byModel?.speak?.[QWEN.id]).toEqual({ ready: true });
		expect(byModel?.speak?.[FISH.id]).toMatchObject({ ready: false, reason: "needs-download" });
	});

	test("an install from older pins does not count: the model needs downloading again", async () => {
		const rig = await makeRig();
		for (const model of REGISTRY.models) await markInstalled(rig.layout, model, rig.lock, "0".repeat(64));
		expect((await rig.provider.status(rig.ctx)).speak).toMatchObject({ ready: false, reason: "needs-download" });
	});

	test("an environment built from the other platform's lock does not count", async () => {
		const rig = await makeRig({ platform: "win32" });
		await markInstalled(rig.layout, QWEN, "linux");
		expect((await rig.provider.status(rig.ctx)).speak).toMatchObject({ ready: false, reason: "needs-download" });
	});

	test.each(REGISTRY.models.map(model => [model.id, model] as const))("any one installed model makes it ready: %s", async (_id, model) => {
		const rig = await makeRig({ installed: [model] });
		expect((await rig.provider.status(rig.ctx)).speak).toEqual({ ready: true });
	});

	test("it reports speaking only: no listen, animate or converse entry", async () => {
		const rig = await makeRig({ installed: [QWEN] });
		const status = await rig.provider.status(rig.ctx);
		expect(Object.keys(status).sort()).toEqual(["byModel", "speak"]);
		expect(Object.keys(status.byModel ?? {})).toEqual(["speak"]);
	});

	test("asking is read-only: it never creates the data folder", async () => {
		const rig = await makeRig({ voices: [] });
		const empty = await temp.make("vc-never-");
		const ctx: SpeechProviderContext = { ...rig.ctx, env: { ...rig.ctx.env, DIMENSION_VOICE_CLONE_HOME: join(empty, "data") } };
		await rig.provider.status(ctx);
		await rig.provider.catalog(ctx);
		expect(existsSync(join(empty, "data"))).toBe(false);
	});

	test("the data folder defaults to <engine home>/speech/voice-clone", async () => {
		const rig = await makeRig({ dataRoot: "engine", installed: [QWEN] });
		expect(rig.ctx.env.DIMENSION_VOICE_CLONE_HOME).toBeUndefined();
		expect(rig.layout.root).toBe(join(rig.engineHome, "speech", "voice-clone"));
		expect((await rig.provider.status(rig.ctx)).speak).toEqual({ ready: true });
	});

	test("it is recomputed on every call: a voice added or a model installed later is seen", async () => {
		const rig = await makeRig({ voices: [] });
		expect((await rig.provider.status(rig.ctx)).speak).toMatchObject({ reason: "unavailable" });
		await addVoice(rig.layout, "me");
		expect((await rig.provider.status(rig.ctx)).speak).toMatchObject({ reason: "needs-download" });
		await markInstalled(rig.layout, FISH, rig.lock);
		expect((await rig.provider.status(rig.ctx)).speak).toEqual({ ready: true });
	});
});

describe("catalog", () => {
	test("warns on the models that may not be used commercially, and only on those", async () => {
		const rig = await makeRig();
		const { speak } = await rig.provider.catalog(rig.ctx);
		for (const model of REGISTRY.models) {
			const entry = speak?.find(candidate => candidate.id === model.id);
			expect(entry).toBeDefined();
			expect(entry?.description?.includes("not for commercial use")).toBe(model.licence.commercialUse === "no");
			expect(entry?.description).toContain(model.licence.id);
		}
		expect(speak?.map(entry => entry.id)).toEqual(REGISTRY.models.map(model => model.id));
	});

	test("offers the user's voices on every model, as id and label only: no file paths, no transcript text", async () => {
		const rig = await makeRig({ voices: ["zed", "alpha"] });
		const { speak } = await rig.provider.catalog(rig.ctx);
		for (const entry of speak ?? []) {
			expect(entry.voices).toEqual([
				{ id: "alpha", label: "alpha" },
				{ id: "zed", label: "zed" },
			]);
		}
		const serialized = JSON.stringify(speak);
		expect(serialized).not.toContain("Words spoken by");
		expect(serialized).not.toContain(rig.layout.voices.replaceAll("\\", "\\\\"));
	});

	test("audio tags and the writing guide are offered exactly for the models that perform tags", async () => {
		const rig = await makeRig();
		const { speak } = await rig.provider.catalog(rig.ctx);
		for (const model of REGISTRY.models) {
			const entry = speak?.find(candidate => candidate.id === model.id);
			expect(entry?.audioTags).toBe(model.tags !== "none");
			expect(entry?.guide).toBe(guideFor(model.tags));
			expect("guide" in (entry ?? {})).toBe(model.tags !== "none");
		}
		expect(speak?.find(entry => entry.id === BREEZE.id)?.guide).toContain("[laughs]");
		expect(speak?.find(entry => entry.id === FISH.id)?.guide).toContain("[whisper]");
	});

	test("is available before anything works, so a profile editor can still list the models: no uv, no voices, unsupported platform", async () => {
		const rig = await makeRig({ platform: "darwin", uv: "none", voices: [] });
		const { speak } = await rig.provider.catalog(rig.ctx);
		expect(speak).toHaveLength(REGISTRY.models.length);
		expect(speak?.every(entry => entry.voices?.length === 0)).toBe(true);
	});

	test("sees a voice added after the first call", async () => {
		const rig = await makeRig({ voices: [] });
		expect((await rig.provider.catalog(rig.ctx)).speak?.[0]?.voices).toEqual([]);
		await addVoice(rig.layout, "later");
		expect((await rig.provider.catalog(rig.ctx)).speak?.[0]?.voices).toEqual([{ id: "later", label: "later" }]);
	});
});

describe("prepare", () => {
	test.each(["listen", "animate"] as const)("refuses a %s target: it only speaks", async kind => {
		const rig = await makeRig();
		const error = await failureOf(() => prepare(rig, { kind, model: QWEN.id }));
		expect(error.message).toContain("only speaks");
		expect(error.message).toContain(kind);
	});

	test("refuses an unknown model, naming the models it has", async () => {
		const rig = await makeRig();
		const error = await failureOf(() => prepare(rig, { kind: "speak", model: "nope" }));
		expect(error.message).toContain('"nope"');
		expect(error.message).toContain("qwen3-tts");
	});

	test("refuses with the blocker's own words when the machine cannot run it", async () => {
		const noUv = await makeRig({ uv: "none" });
		expect((await failureOf(() => prepare(noUv, { kind: "speak", model: QWEN.id }))).message).toContain("Install uv");
		const noVoice = await makeRig({ voices: [] });
		expect((await failureOf(() => prepare(noVoice, { kind: "speak", model: QWEN.id }))).message).toContain(noVoice.layout.voices);
		const mac = await makeRig({ platform: "darwin" });
		expect((await failureOf(() => prepare(mac, { kind: "speak", model: QWEN.id }))).message).toContain("NVIDIA");
	});

	test("a signal that is already aborted rejects with its reason", async () => {
		const rig = await makeRig({ installed: [QWEN] });
		const controller = new AbortController();
		const reason = new Error("already cancelled");
		controller.abort(reason);
		expect(await failureOf(() => prepare(rig, { kind: "speak", model: QWEN.id }, () => {}, controller.signal))).toBe(reason);
	});

	test("an installed model is already prepared: resolves without reporting progress, however often it is asked", async () => {
		const rig = await makeRig({ installed: [QWEN, VOXCPM] });
		const progress: number[] = [];
		await prepare(rig, { kind: "speak", model: QWEN.id }, fraction => progress.push(fraction));
		await Promise.all([prepare(rig, { kind: "speak", model: VOXCPM.id }), prepare(rig, { kind: "speak", model: VOXCPM.id })]);
		expect(progress).toEqual([]);
	});

	test("an install that cannot run reaches the caller as a rejection, never as success, and leaves nothing installed", async () => {
		const rig = await makeRig();
		const error = await failureOf(() => prepare(rig, { kind: "speak", model: VOXCPM.id }));
		expect(error.message.length).toBeGreaterThan(0);
		expect((await rig.provider.status(rig.ctx)).speak).toMatchObject({ ready: false, reason: "needs-download" });
	});

	test("simultaneous prepares of one model share one install, so they fail together with the same error; a later one starts afresh", async () => {
		const rig = await makeRig();
		const target = { kind: "speak", model: VOXCPM.id } as const;
		const [a, b] = await Promise.allSettled([prepare(rig, target), prepare(rig, target)]);
		expect(a.status).toBe("rejected");
		expect(b.status).toBe("rejected");
		expect(a.status === "rejected" && b.status === "rejected" && a.reason === b.reason).toBe(true);
		const later = await failureOf(() => prepare(rig, target));
		expect(a.status === "rejected" && later !== a.reason).toBe(true);
	});
});

describe("openSpeak", () => {
	test("an already-aborted signal opens nothing", async () => {
		const rig = await makeRig({ installed: [QWEN] });
		const controller = new AbortController();
		controller.abort();
		await failureOf(() => open(rig, {}, true, controller.signal));
		expect(rig.acquisitions).toHaveLength(0);
	});

	test("an unknown model is refused by name", async () => {
		const rig = await makeRig({ installed: [QWEN] });
		expect((await failureOf(() => open(rig, { model: "nope" }))).message).toContain('"nope"');
	});

	test("an unknown voice is refused, telling the user which two files to add", async () => {
		const rig = await makeRig({ installed: [QWEN] });
		const message = (await failureOf(() => open(rig, { voice: "ghost" }))).message;
		expect(message).toContain('"ghost"');
		expect(message).toContain("ghost.wav");
		expect(message).toContain("ghost.txt");
		expect(rig.acquisitions).toHaveLength(0);
	});

	test("a voice with no transcript is as good as missing", async () => {
		const rig = await makeRig({ installed: [QWEN] });
		await writeText(join(rig.layout.voices, "mute.wav"), "RIFF");
		expect((await failureOf(() => open(rig, { voice: "mute" }))).message).toContain('"mute"');
	});

	test("refuses with the blocker's words when the machine cannot run it", async () => {
		const mac = await makeRig({ platform: "darwin", installed: [QWEN] });
		expect((await failureOf(() => open(mac))).message).toContain("NVIDIA");
		const noUv = await makeRig({ uv: "none", installed: [QWEN] });
		expect((await failureOf(() => open(noUv))).message).toContain("Install uv");
		const noVoice = await makeRig({ voices: [], installed: [QWEN] });
		expect((await failureOf(() => open(noVoice))).message).toContain(noVoice.layout.voices);
	});

	test("speaks with the voice that was asked for among several, with the profile's options, at the model's sample rate", async () => {
		const rig = await makeRig({ voices: ["alpha", "zed", "mid"], installed: [QWEN, VOXCPM] });
		const session = await open(rig, { model: VOXCPM.id, voice: "zed", options: { seed: 9 } });
		expect(session.sampleRate).toBe(VOXCPM.sampleRate);
		const recorder = new Recorder(session);
		session.push("Hello there.");
		session.flush();
		await recorder.untilEnds(1);

		const call = rig.worker.calls[0];
		expect(call?.text).toBe("Hello there.");
		expect(call?.options).toEqual({ seed: 9 });
		expect(call?.voice).toMatchObject({ id: "zed", audio: join(rig.layout.voices, "zed.wav"), transcript: "Words spoken by zed." });
		expect(rig.acquisitions.length).toBeGreaterThan(0);
		expect(rig.acquisitions.every(acquired => acquired.model.id === VOXCPM.id && acquired.layout.root === rig.layout.root)).toBe(true);
	});

	test("with no options in the profile the worker is given an empty object", async () => {
		const rig = await makeRig({ installed: [QWEN] });
		const session = await open(rig);
		const recorder = new Recorder(session);
		session.push("Hello.");
		session.flush();
		await recorder.untilEnds(1);
		expect(rig.worker.calls[0]?.options).toEqual({});
	});

	test("the model starts loading as the session opens, so it is warm by the time the user is heard", async () => {
		const rig = await makeRig({ installed: [QWEN] });
		await open(rig);
		expect(rig.acquisitions).toHaveLength(1);
	});

	test("audio tags reach the model only when the reply allows them and the model performs them", async () => {
		const rig = await makeRig({ installed: [QWEN, FISH, BREEZE] });
		const cases = [
			{ model: FISH, audioTags: true, text: "[whisper] Hello there.", expected: "[whisper] Hello there." },
			{ model: FISH, audioTags: false, text: "[whisper] Hello there.", expected: "Hello there." },
			{ model: BREEZE, audioTags: true, text: "[laughs] Hello there.", expected: "(laugh) Hello there." },
			{ model: BREEZE, audioTags: false, text: "[laughs] Hello there.", expected: "Hello there." },
			{ model: QWEN, audioTags: true, text: "[whisper] Hello there.", expected: "Hello there." },
			{ model: QWEN, audioTags: false, text: "[whisper] Hello there.", expected: "Hello there." },
		];
		for (const { model, audioTags, text, expected } of cases) {
			const before = rig.worker.calls.length;
			const session = await open(rig, { model: model.id }, audioTags);
			const recorder = new Recorder(session);
			session.push(text);
			session.flush();
			await recorder.untilEnds(1);
			expect(rig.worker.calls[before]?.text).toBe(expected);
		}
	});

	test("aborting the signal ends the session", async () => {
		const rig = await makeRig({ installed: [QWEN] });
		const controller = new AbortController();
		const session = await open(rig, {}, true, controller.signal);
		const recorder = new Recorder(session);
		controller.abort();
		await recorder.finished;
		expect(recorder.events).toEqual([]);
	});

	test("two sessions on one provider each ask the pool for their own worker", async () => {
		const rig = await makeRig({ installed: [QWEN] });
		await open(rig);
		await open(rig);
		expect(rig.acquisitions).toHaveLength(2);
	});
});

describe("openSpeak for a model that is not installed yet", () => {
	test.each([[[QWEN]], [[]]] as const)("answers at once that the model needs a download (installed: %p), opens no session, takes no worker, starts no install", async installed => {
		const rig = await makeRig({ installed: [...installed] });
		const error = (await failureOf(() => open(rig, { model: VOXCPM.id }))) as Error & { reason?: string; detail?: string; model?: string };
		expect(error.name).toBe("SpeechNeedsDownloadError");
		expect(error.reason).toBe("needs-download");
		expect(error.model).toBe(VOXCPM.id);
		expect(error.detail).toBe(`${VOXCPM.label} is not downloaded yet (${VOXCPM.sizeHint})`);
		expect(rig.acquisitions).toHaveLength(0);
		expect(existsSync(rig.layout.env(VOXCPM.id))).toBe(false);
	});

	test("an install from older pins counts as not downloaded", async () => {
		const rig = await makeRig();
		await markInstalled(rig.layout, VOXCPM, rig.lock, "0".repeat(64));
		const error = await failureOf(() => open(rig, { model: VOXCPM.id }));
		expect(error.name).toBe("SpeechNeedsDownloadError");
		expect(rig.acquisitions).toHaveLength(0);
	});
});
