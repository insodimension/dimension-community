import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSpeechProvider, PROVIDER_ID } from "../src/index.js";
import { DEFAULT_MODEL, findModel, type LockPlatform, PACK_FILES, type TagStyle } from "../src/registry.js";
import { REGISTRY } from "./support.js";

const PACK = join(import.meta.dir, "..");
const GIT_SHA = /^[0-9a-f]{40}$/;
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
const EXACT_PIN = /^[A-Za-z0-9_.-]+(\[[A-Za-z0-9_,-]+\])?==\S+/;
const TAG_STYLES: readonly TagStyle[] = ["none", "brackets", "breeze"];
const LOCKS: readonly LockPlatform[] = ["windows", "linux"];
const MODELS = REGISTRY.models.map(model => [model.id, model] as const);

function readLock(model: string, platform: LockPlatform): string[] {
	return readFileSync(PACK_FILES.lock(model, platform), "utf8")
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(line => line && !line.startsWith("#"));
}

describe("models.json", () => {
	test("model ids are unique, and the default model is one of them", () => {
		const ids = REGISTRY.models.map(model => model.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain(DEFAULT_MODEL);
	});

	test.each(MODELS)("%s is installable: every pin is a full commit, and its torch build names an index", (_id, model) => {
		expect(REGISTRY.torchIndexes[model.torch]).toMatch(/^https:\/\//);
		expect(model.weights.repo).toMatch(REPO_NAME);
		expect(model.weights.revision).toMatch(GIT_SHA);
		if (model.weights.files) {
			expect(model.weights.files.length).toBeGreaterThan(0);
			for (const file of model.weights.files) expect(file.trim()).not.toBe("");
		}
		if (model.source) {
			expect(model.source.repo).toMatch(REPO_NAME);
			expect(model.source.sha).toMatch(GIT_SHA);
		}
		expect(model.python).toMatch(/^3\.\d+$/);
	});

	test.each(MODELS)("%s declares a usable sample rate, tag style and licence", (_id, model) => {
		expect(Number.isInteger(model.sampleRate) && model.sampleRate >= 8000).toBe(true);
		expect(TAG_STYLES).toContain(model.tags);
		expect(["yes", "no"]).toContain(model.licence.commercialUse);
	});

	test("findModel names the available models when the id is wrong", () => {
		expect(() => findModel(REGISTRY, "nope")).toThrow(/no model "nope".*qwen3-tts/);
	});
});

describe("per-platform lock files", () => {
	test("every model has a lock for each platform the provider supports, and no lock is orphaned", () => {
		const found = [...new Bun.Glob("*.txt").scanSync(join(PACK, "python", "requirements"))].sort();
		const expected = REGISTRY.models.flatMap(model => LOCKS.map(platform => `${model.id}.${platform}.txt`)).sort();
		expect(found).toEqual(expected);
	});

	test.each(MODELS.flatMap(([id, model]) => LOCKS.map(platform => [`${id} (${platform})`, model.id, platform] as const)))("%s is an exact lock: every line is name==version, so uv pip sync reproduces it", (_label, model, platform) => {
		const lines = readLock(model, platform);
		expect(lines.length).toBeGreaterThan(20);
		expect(lines.filter(line => !EXACT_PIN.test(line))).toEqual([]);
	});

	test.each(MODELS.flatMap(([id, model]) => LOCKS.map(platform => [`${id} (${platform})`, model.id, platform] as const)))("%s locks the torch build the registry asks for", (_label, id, platform) => {
		const lines = readLock(id, platform);
		const build = `+${findModel(REGISTRY, id).torch}`;
		const torch = lines.find(line => line.startsWith("torch=="));
		expect(torch).toBeDefined();
		expect(torch?.endsWith(build)).toBe(true);
		const audio = lines.find(line => line.startsWith("torchaudio=="));
		if (audio) expect(audio.endsWith(build)).toBe(true);
	});

	test.each(MODELS)("%s: the Windows lock carries none of the Linux-only CUDA wheels, which have no Windows build", (_id, model) => {
		const windows = readLock(model.id, "windows");
		expect(windows.filter(line => /^(triton|nvidia-)/.test(line))).toEqual([]);
		expect(readLock(model.id, "linux").some(line => line.startsWith("nvidia-"))).toBe(true);
	});
});

describe("the Python worker and the registry agree", () => {
	const worker = readFileSync(PACK_FILES.worker, "utf8");

	test.each(MODELS)("%s has a runtime in worker.py, and needs a pinned source exactly when the registry pins one", (_id, model) => {
		const dispatch = new RegExp(`spec\\.id == "${model.id}"([^:]*):`).exec(worker);
		expect(dispatch).not.toBeNull();
		const needsSource = /source is not None/.test(dispatch?.[1] ?? "");
		expect(needsSource).toBe(model.source !== undefined);
	});
});

describe("plugin declaration", () => {
	const plugin = JSON.parse(readFileSync(join(PACK, "plugin.json"), "utf8")) as { extensions: Record<string, Record<string, unknown>> };
	const extension = plugin.extensions["ai.insodimension.dimension"] ?? {};
	const connect = extension.connect as { kind: string[]; requires: { commands: string[]; install: Record<string, string[]> } };

	test("declares the id the provider answers to, and exactly the capabilities it implements", () => {
		const provider = createSpeechProvider();
		expect(extension.providers).toEqual({ speech: [{ id: provider.id, speak: true, listen: false, onDevice: true }] });
		expect(provider.id).toBe(PROVIDER_ID);
		expect(typeof provider.openSpeak).toBe("function");
		expect(provider.openListen).toBeUndefined();
		expect(existsSync(join(PACK, String(extension.entry)))).toBe(true);
	});

	test("asks the user for uv, which the provider cannot run without, and says how to get it on every platform it supports", () => {
		expect(connect.kind).toEqual(["cli"]);
		expect(connect.requires.commands).toContain("uv");
		for (const platform of ["win32", "linux"]) expect(connect.requires.install.uv?.[platform]?.length).toBeGreaterThan(0);
	});
});

describe("shipped voice profile", () => {
	test("names this provider with a model it has and the voice id the setup steps tell the user to create", () => {
		const profile = Bun.YAML.parse(readFileSync(join(PACK, "voice-profiles", "my-voice.yml"), "utf8")) as { speak: { provider: string; model: string; voice: string }[] };
		const cloned = profile.speak.filter(entry => entry.provider === PROVIDER_ID);
		expect(cloned.length).toBeGreaterThan(0);
		for (const entry of cloned) {
			expect(REGISTRY.models.map(model => model.id)).toContain(entry.model);
			expect(entry.voice).toBe("me");
		}
	});
});
