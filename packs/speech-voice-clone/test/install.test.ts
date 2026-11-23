import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { installStamp, isInstalled } from "../src/install.js";
import { layoutAt } from "../src/layout.js";
import type { CloneModel, LockPlatform } from "../src/registry.js";
import { BREEZE, CHATTERBOX, FISH, INSTALL_MARKER_FILE, markInstalled, QWEN, REGISTRY, TempDirs, VOXCPM, writeText } from "./support.js";

const temp = new TempDirs();
afterEach(() => temp.dispose());

const LOCKS: readonly LockPlatform[] = ["windows", "linux"];

async function freshLayout() {
	return layoutAt(await temp.make());
}

describe("installStamp", () => {
	test("is the same for the same model and platform, and every model has its own", () => {
		expect(installStamp({ ...QWEN }, "windows")).toBe(installStamp(QWEN, "windows"));
		const stamps = REGISTRY.models.map(model => installStamp(model, "windows"));
		expect(new Set(stamps).size).toBe(stamps.length);
	});

	test.each(REGISTRY.models.map(model => [model.id, model] as const))("%s: an environment built from one platform's lock is not the other platform's", (_id, model) => {
		expect(installStamp(model, "windows")).not.toBe(installStamp(model, "linux"));
	});

	test.each([
		{ name: "the Python version", change: { python: "3.13" } },
		{ name: "the torch build", change: { torch: "cu126" } },
		{ name: "the weights revision", change: { weights: { ...QWEN.weights, revision: "0".repeat(40) } } },
		{ name: "the weights repo", change: { weights: { ...QWEN.weights, repo: "someone/else" } } },
		{ name: "the set of weights files", change: { weights: { ...QWEN.weights, files: ["model.safetensors"] } } },
	] satisfies { name: string; change: Partial<CloneModel> }[])("changes when $name changes", ({ change }) => {
		for (const lock of LOCKS) expect(installStamp({ ...QWEN, ...change }, lock)).not.toBe(installStamp(QWEN, lock));
	});

	test("the weights file list is part of the pin: a narrower list is a different download", () => {
		const files = CHATTERBOX.weights.files ?? [];
		expect(files.length).toBeGreaterThan(1);
		const narrowed: CloneModel = { ...CHATTERBOX, weights: { ...CHATTERBOX.weights, files: files.slice(1) } };
		const everything: CloneModel = { ...CHATTERBOX, weights: { repo: CHATTERBOX.weights.repo, revision: CHATTERBOX.weights.revision } };
		expect(installStamp(narrowed, "windows")).not.toBe(installStamp(CHATTERBOX, "windows"));
		expect(installStamp(everything, "windows")).not.toBe(installStamp(CHATTERBOX, "windows"));
	});

	test("changes when the pinned source commit changes, or appears", () => {
		const base = BREEZE.source;
		expect(base).toBeDefined();
		expect(installStamp({ ...BREEZE, source: { repo: base?.repo ?? "", sha: "f".repeat(40) } }, "windows")).not.toBe(installStamp(BREEZE, "windows"));
		expect(installStamp({ ...BREEZE, source: { repo: "other/repo", sha: base?.sha ?? "" } }, "windows")).not.toBe(installStamp(BREEZE, "windows"));
		expect(installStamp({ ...QWEN, source: { repo: "a/b", sha: "c".repeat(40) } }, "windows")).not.toBe(installStamp(QWEN, "windows"));
	});

	test("an absent source and an undefined source are the same pin", () => {
		const { source: _dropped, ...withoutSource } = BREEZE;
		expect(installStamp({ ...withoutSource, source: undefined }, "windows")).toBe(installStamp(withoutSource, "windows"));
	});

	test("reads the model's own lock file: the same pins under another id stamp differently", () => {
		expect(installStamp({ ...QWEN, id: VOXCPM.id }, "windows")).not.toBe(installStamp(QWEN, "windows"));
	});

	test("copy and runtime facts that do not change what is installed do not invalidate an install", () => {
		const reworded: CloneModel = {
			...QWEN,
			label: "A new label",
			description: "A new description.",
			sampleRate: 16000,
			tags: "brackets",
			licence: { id: "Other", commercialUse: "no", url: "https://example.com" },
		};
		for (const lock of LOCKS) expect(installStamp(reworded, lock)).toBe(installStamp(QWEN, lock));
	});

	test("a model with no lock file for the platform cannot be stamped", () => {
		expect(() => installStamp({ ...QWEN, id: "no-such-model" }, "windows")).toThrow();
	});
});

describe("isInstalled", () => {
	test.each(LOCKS)("true when the environment's marker carries the model's current stamp for %s", async lock => {
		const layout = await freshLayout();
		await markInstalled(layout, QWEN, lock);
		expect(await isInstalled(layout, QWEN, lock)).toBe(true);
	});

	test("false before anything is installed", async () => {
		expect(await isInstalled(await freshLayout(), QWEN, "windows")).toBe(false);
	});

	test("an install made from the other platform's lock does not count", async () => {
		const layout = await freshLayout();
		await markInstalled(layout, QWEN, "linux");
		expect(await isInstalled(layout, QWEN, "linux")).toBe(true);
		expect(await isInstalled(layout, QWEN, "windows")).toBe(false);
	});

	test("false when the stamp differs: a stale marker means the environment is rebuilt, not trusted", async () => {
		const layout = await freshLayout();
		await markInstalled(layout, QWEN, "windows", "0".repeat(64));
		expect(await isInstalled(layout, QWEN, "windows")).toBe(false);
	});

	test("false after the model's pins move on, even though the old install was complete", async () => {
		const layout = await freshLayout();
		await markInstalled(layout, QWEN, "windows");
		const bumped: CloneModel = { ...QWEN, weights: { ...QWEN.weights, revision: "a".repeat(40) } };
		expect(await isInstalled(layout, QWEN, "windows")).toBe(true);
		expect(await isInstalled(layout, bumped, "windows")).toBe(false);
	});

	test("one model's marker says nothing about another model", async () => {
		const layout = await freshLayout();
		await markInstalled(layout, QWEN, "windows");
		expect(await isInstalled(layout, VOXCPM, "windows")).toBe(false);
		await markInstalled(layout, FISH, "windows");
		expect(await isInstalled(layout, FISH, "windows")).toBe(true);
		expect(await isInstalled(layout, CHATTERBOX, "windows")).toBe(false);
	});

	test("a marker copied into another model's folder does not pass for that model", async () => {
		const layout = await freshLayout();
		await markInstalled(layout, QWEN);
		await writeText(join(layout.env(VOXCPM.id), INSTALL_MARKER_FILE), JSON.stringify({ stamp: installStamp(QWEN, "windows") }));
		expect(await isInstalled(layout, VOXCPM, "windows")).toBe(false);
	});

	test("a different data root is a different install", async () => {
		const first = await freshLayout();
		const second = await freshLayout();
		await markInstalled(first, QWEN);
		expect(await isInstalled(second, QWEN, "windows")).toBe(false);
	});

	test.each([
		{ name: "invalid JSON", content: "{ not json" },
		{ name: "an empty file", content: "" },
		{ name: "null", content: "null" },
		{ name: "an array", content: "[]" },
		{ name: "an object without a stamp", content: "{}" },
		{ name: "a numeric stamp", content: JSON.stringify({ stamp: 12345 }) },
		{ name: "a null stamp", content: JSON.stringify({ stamp: null }) },
		{ name: "an empty stamp", content: JSON.stringify({ stamp: "" }) },
		{ name: "the stamp under another key", content: JSON.stringify({ hash: "x" }) },
	])("a damaged marker reads as not installed, never as a crash: $name", async ({ content }) => {
		const layout = await freshLayout();
		await writeText(join(layout.env(QWEN.id), INSTALL_MARKER_FILE), content);
		expect(await isInstalled(layout, QWEN, "windows")).toBe(false);
	});

	test("an environment folder with no marker is not an install, however complete it looks", async () => {
		const layout = await freshLayout();
		await writeText(join(layout.env(QWEN.id), "pyvenv.cfg"), "home = /usr/bin");
		expect(await isInstalled(layout, QWEN, "windows")).toBe(false);
	});
});
