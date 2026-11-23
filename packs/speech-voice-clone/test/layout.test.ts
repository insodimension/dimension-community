import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { findUv, layoutAt, listVoices, resolveLayout } from "../src/layout.js";
import { addVoice, dummyUv, TempDirs, writeText } from "./support.js";

const temp = new TempDirs();
afterEach(() => temp.dispose());

const UV_BINARY = process.platform === "win32" ? "uv.exe" : "uv";
const ENGINE_HOME = resolve("engine-home");
const DEFAULT_ROOT = join(ENGINE_HOME, "speech", "voice-clone");

describe("resolveLayout", () => {
	test("the environment variable names the data folder", () => {
		const root = resolve("a-data-folder");
		expect(resolveLayout({ DIMENSION_VOICE_CLONE_HOME: root }, ENGINE_HOME).root).toBe(root);
	});

	test("without it, data lives under <engine home>/speech/voice-clone", () => {
		expect(resolveLayout({}, ENGINE_HOME).root).toBe(DEFAULT_ROOT);
	});

	test.each([
		{ name: "an empty value", value: "" },
		{ name: "a blank value", value: "   \t" },
		{ name: "no value", value: undefined },
	])("$name falls back to the engine home", ({ value }) => {
		expect(resolveLayout({ DIMENSION_VOICE_CLONE_HOME: value }, ENGINE_HOME).root).toBe(DEFAULT_ROOT);
	});

	test("whitespace around the value is ignored", () => {
		const root = resolve("padded-data-folder");
		expect(resolveLayout({ DIMENSION_VOICE_CLONE_HOME: `  ${root}\n` }, ENGINE_HOME).root).toBe(root);
	});

	test("a relative path is resolved to an absolute one, so a worker started elsewhere finds the same folder", () => {
		const layout = resolveLayout({ DIMENSION_VOICE_CLONE_HOME: join("relative", "voices-home") }, ENGINE_HOME);
		expect(isAbsolute(layout.root)).toBe(true);
		expect(layout.root).toBe(resolve("relative", "voices-home"));
		expect(isAbsolute(layout.voices)).toBe(true);
	});
});

describe("listVoices", () => {
	test("a missing voices folder means no voices", async () => {
		expect(await listVoices(layoutAt(join(await temp.make(), "never-created")))).toEqual([]);
	});

	test("an empty voices folder means no voices", async () => {
		const layout = layoutAt(await temp.make());
		await mkdir(layout.voices, { recursive: true });
		expect(await listVoices(layout)).toEqual([]);
	});

	test("a voice is a .wav with its words in a sibling .txt; id and label are the file name", async () => {
		const layout = layoutAt(await temp.make());
		await addVoice(layout, "me", "  The exact words.\n");
		expect(await listVoices(layout)).toEqual([
			{ id: "me", label: "me", audio: join(layout.voices, "me.wav"), transcript: "The exact words." },
		]);
	});

	test("voices come back sorted by id", async () => {
		const layout = layoutAt(await temp.make());
		for (const name of ["zed", "alpha", "mid"]) await addVoice(layout, name);
		expect((await listVoices(layout)).map(voice => voice.id)).toEqual(["alpha", "mid", "zed"]);
	});

	test("a .wav without a transcript is not a voice", async () => {
		const layout = layoutAt(await temp.make());
		await addVoice(layout, "good");
		await writeText(join(layout.voices, "orphan.wav"), "RIFF");
		expect((await listVoices(layout)).map(voice => voice.id)).toEqual(["good"]);
	});

	test.each(["", "   ", "\n\n", "\t \n"])("a .wav whose transcript is blank (%p) is not a voice", async blank => {
		const layout = layoutAt(await temp.make());
		await addVoice(layout, "blank", blank);
		expect(await listVoices(layout)).toEqual([]);
	});

	test("a transcript without its recording is not a voice, and other audio formats are ignored", async () => {
		const layout = layoutAt(await temp.make());
		await writeText(join(layout.voices, "words-only.txt"), "Some words");
		await writeText(join(layout.voices, "song.mp3"), "ID3");
		await writeText(join(layout.voices, "song.txt"), "Some words");
		await writeText(join(layout.voices, "clip.flac"), "fLaC");
		await writeText(join(layout.voices, "clip.txt"), "Some words");
		await writeText(join(layout.voices, "notes.md"), "# notes");
		expect(await listVoices(layout)).toEqual([]);
	});

	test("the extension match ignores case", async () => {
		const layout = layoutAt(await temp.make());
		await writeText(join(layout.voices, "LOUD.WAV"), "RIFF");
		await writeText(join(layout.voices, "LOUD.txt"), "Words");
		expect(await listVoices(layout)).toEqual([{ id: "LOUD", label: "LOUD", audio: join(layout.voices, "LOUD.WAV"), transcript: "Words" }]);
	});

	test("dots in a name stay part of the id", async () => {
		const layout = layoutAt(await temp.make());
		await addVoice(layout, "my.voice.v2");
		expect((await listVoices(layout)).map(voice => voice.id)).toEqual(["my.voice.v2"]);
	});

	test("a transcript keeps its inner text, line breaks included, and loses only the outer whitespace", async () => {
		const layout = layoutAt(await temp.make());
		await addVoice(layout, "me", "\n  First line.\nSecond line.\n\n");
		expect((await listVoices(layout))[0]?.transcript).toBe("First line.\nSecond line.");
	});

	test("the recording itself is never opened: only its name and its transcript decide", async () => {
		const layout = layoutAt(await temp.make());
		await mkdir(layout.voices, { recursive: true });
		await writeFile(join(layout.voices, "empty.wav"), new Uint8Array(0));
		await writeFile(join(layout.voices, "empty.txt"), "Words");
		expect((await listVoices(layout)).map(voice => voice.id)).toEqual(["empty"]);
	});
});

describe("findUv", () => {
	test("an existing UV path wins over everything on PATH", async () => {
		const pathDir = await temp.make("vc-path-");
		await dummyUv(pathDir);
		const explicitDir = await temp.make("vc-explicit-");
		const explicit = join(explicitDir, "my-uv");
		await writeText(explicit, "x");
		expect(findUv({ UV: explicit, PATH: pathDir }, await temp.make("vc-home-"))).toBe(explicit);
	});

	test("a UV that points at nothing is ignored, and the search continues", async () => {
		const pathDir = await temp.make("vc-path-");
		const onPath = await dummyUv(pathDir);
		expect(findUv({ UV: join(pathDir, "missing-uv"), PATH: pathDir }, await temp.make("vc-home-"))).toBe(onPath);
	});

	test.each(["", "   "])("a blank UV (%p) is ignored", async blank => {
		const pathDir = await temp.make("vc-path-");
		const onPath = await dummyUv(pathDir);
		expect(findUv({ UV: blank, PATH: pathDir }, await temp.make("vc-home-"))).toBe(onPath);
	});

	test("PATH is searched in order", async () => {
		const first = await temp.make("vc-first-");
		const second = await temp.make("vc-second-");
		const inFirst = await dummyUv(first);
		await dummyUv(second);
		expect(findUv({ PATH: [first, second].join(delimiter) }, await temp.make("vc-home-"))).toBe(inFirst);
		expect(findUv({ PATH: [await temp.make("vc-empty-"), second].join(delimiter) }, await temp.make("vc-home-"))).toBe(join(second, UV_BINARY));
	});

	test("a Path-spelled variable is used when PATH is absent", async () => {
		const dir = await temp.make("vc-path-");
		const onPath = await dummyUv(dir);
		expect(findUv({ Path: dir }, await temp.make("vc-home-"))).toBe(onPath);
	});

	test("empty PATH segments are skipped rather than resolved against the working directory", async () => {
		const dir = await temp.make("vc-path-");
		const onPath = await dummyUv(dir);
		expect(findUv({ PATH: `${delimiter}${delimiter}${dir}${delimiter}` }, await temp.make("vc-home-"))).toBe(onPath);
	});

	test("falls back to ~/.local/bin, then ~/.cargo/bin, after PATH", async () => {
		const home = await temp.make("vc-home-");
		const cargo = await dummyUv(join(home, ".cargo", "bin"));
		expect(findUv({}, home)).toBe(cargo);
		const local = await dummyUv(join(home, ".local", "bin"));
		expect(findUv({}, home)).toBe(local);
		const pathDir = await temp.make("vc-path-");
		const onPath = await dummyUv(pathDir);
		expect(findUv({ PATH: pathDir }, home)).toBe(onPath);
	});

	test("nothing anywhere means undefined", async () => {
		const home = await temp.make("vc-home-");
		expect(findUv({}, home)).toBeUndefined();
		expect(findUv({ PATH: await temp.make("vc-empty-"), UV: join(home, "nope") }, home)).toBeUndefined();
	});

	test("looks for the platform's binary name", async () => {
		const dir = await temp.make("vc-path-");
		await writeText(join(dir, process.platform === "win32" ? "uv" : "uv.exe"), "wrong name for this platform");
		expect(findUv({ PATH: dir }, await temp.make("vc-home-"))).toBeUndefined();
	});
});
