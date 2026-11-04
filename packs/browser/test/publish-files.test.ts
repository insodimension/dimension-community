import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PublishRecord } from "../src/contracts";
import { type PublishPreset, loadPresets, parsePreset, resolvePreset } from "../src/presets";
import { bindingOf } from "../src/publish-approval";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { approvePublish, BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, perform, teardown } from "./fixture";
import { PLATFORM_ROUTES, type PlatformFixture, rebasePreset, startPlatformFixture } from "./platform-fixture";

const CALLER = "ai.insodimension/caller";
const TITLE = "Dry Run, the film";
const DESCRIPTION = "A film about a dry run.\nSecond line ünïcødé 🚀";

interface ToolResult {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
}

interface Session {
	call: (name: string, args: Record<string, unknown>, caller?: string) => Promise<ToolResult>;
	runtime: BrowserRuntime;
	browserId: string;
	fixture: PlatformFixture;
	rootDir: string;
	profile: string;
}

interface Media {
	video: string;
	thumbnail: string;
	captions: string;
	digest: (path: string) => string;
}

const clients: Client[] = [];
const fixtures: PlatformFixture[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	for (const fixture of fixtures.splice(0)) await fixture.stop();
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

const shipped = await loadPresets();
const youtube = shipped.find((preset) => preset.name === "youtube-upload") as PublishPreset;

async function media(): Promise<Media> {
	const dir = await createRoot();
	const contents = new Map<string, Buffer>();
	const make = async (name: string, bytes: Buffer): Promise<string> => {
		const path = join(dir, name);
		await writeFile(path, bytes);
		contents.set(path, bytes);
		return path;
	};
	return {
		video: await make("master.mp4", Buffer.from(`fixture video ${"\u0000\u00ff".repeat(4096)}`, "latin1")),
		thumbnail: await make("thumb.png", Buffer.from("fixture png bytes")),
		captions: await make("captions.srt", Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nHello\n")),
		digest: (path) => createHash("sha256").update(contents.get(path) ?? Buffer.alloc(0)).digest("hex"),
	};
}

async function session(profile: string): Promise<Session> {
	const fixture = startPlatformFixture("youtube-upload");
	fixtures.push(fixture);
	const rootDir = await createRoot();
	const runtime = newRuntime(rootDir);
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir, presets: shipped.map((preset) => rebasePreset(preset, fixture.origin)) });
	const client = new Client({ name: "publish-files-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	const call: Session["call"] = async (name, args, caller) =>
		(await client.callTool({ name, arguments: args, _meta: { [CALLER]: caller ?? "model", "ai.insodimension/session": { sessionId: "publish-files-chat" } } })) as ToolResult;
	const opened = await call("browser_open", { profile });
	expect(opened.isError).toBeFalsy();
	const browserId = opened.structuredContent?.browserId as string;
	await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/__fixture/login") });
	return { call, runtime, browserId, fixture, rootDir, profile };
}

function errorText(result: ToolResult): string {
	expect(result.isError).toBe(true);
	return result.content.map((part) => part.text ?? "").join("");
}

describe("preset file slots and wizard steps", () => {
	test("the shipped youtube-upload preset parses: two fields, a required video, optional thumbnail and captions, Unlisted checked at park and confirm", () => {
		expect(youtube.fields.map((field) => field.label)).toEqual(["Title", "Description"]);
		expect(youtube.files.map((file) => [file.label, file.optional === true])).toEqual([
			["Video", false],
			["Thumbnail", true],
			["Captions", true],
		]);
		expect(youtube.receipt).toEqual({ origin: "https://youtu.be", path: "/{segment}", linkSelector: "ytcp-video-share-dialog a[href]" });
		expect(youtube.steps?.filter((step) => step.kind === "check").map((step) => (step.kind === "check" ? step.selector : ""))).toContain('tp-yt-paper-radio-button[name="UNLISTED"][aria-checked="true"]');
	});

	test("a malformed file slot or wizard is refused when the preset loads, by what is wrong", () => {
		const { name: _name, ...rest } = structuredClone(youtube) as PublishPreset & Record<string, unknown>;
		const base = { ...rest, name: "youtube-upload" };
		const refused = (change: Record<string, unknown>) => () => parsePreset({ ...base, ...change }, "youtube-upload");
		expect(refused({ files: [{ label: "Video", selector: "input", accept: "video/*" }] })).toThrow(/accept takes file extensions only/);
		expect(refused({ files: [{ label: "Video", selector: "input", optional: false }] })).toThrow(/optional must be true or absent/);
		expect(refused({ files: [{ label: "Video", selector: "input", size: 1 }] })).toThrow(/files\[0\] must be/);
		const steps = youtube.steps ?? [];
		expect(refused({ steps: steps.filter((step) => !(step.kind === "field" && step.label === "Description")) })).toThrow(/every field and every file exactly once/);
		expect(refused({ steps: [...steps, { kind: "field", label: "Title" }] })).toThrow(/places field "Title" a second time/);
		expect(refused({ steps: [...steps, { kind: "click", selector: "#x", onlyWith: "Video" }] })).toThrow(/onlyWith must name an optional file/);
		expect(refused({ steps: [{ kind: "field", label: "Title", onlyWith: "Captions" }, ...steps.slice(1)] })).toThrow(/onlyWith is for click, wait and check steps/);
		expect(refused({ steps: [...steps, { kind: "wait", selector: "#x", timeoutMs: 60_001 }] })).toThrow(/timeoutMs must be an integer from 1 to 60000/);
		expect(refused({ steps: [...steps, { kind: "eval", selector: "#x" }] })).toThrow(/kind must be field, file, click, wait or check/);
		expect(refused({ receipt: { path: "/{segment}", origin: "https://youtu.be/watch" } })).toThrow(/receipt.origin must be a bare origin/);
	});

	test("a request without a required file, with a relative path, a file the slot does not accept or a slot the preset lacks is refused by name", () => {
		const resolve = (files?: Record<string, string>) => () => resolvePreset(shipped, { name: "youtube-upload", values: [TITLE, DESCRIPTION], ...(files === undefined ? {} : { files }) });
		expect(resolve()).toThrow('youtube-upload needs file "Video" (.mp4,');
		expect(resolve({ Thumbnail: "C:/films/thumb.png" })).toThrow('youtube-upload needs file "Video"');
		expect(resolve({ Video: "films/master.mp4" })).toThrow('file "Video" must be an absolute path');
		expect(resolve({ Video: "C:/films/master.txt" })).toThrow('file "Video": C:/films/master.txt is not one of (.mp4,');
		expect(resolve({ Video: "C:/films/master.mp4", Poster: "C:/films/poster.png" })).toThrow('youtube-upload has no file slot "Poster"; its file slots: Video, Thumbnail, Captions');
	});

	test("an optional file left out drops its slot, its file step and every step that only runs with it", () => {
		const { recipe } = resolvePreset(shipped, { name: "youtube-upload", values: [TITLE, DESCRIPTION], files: { Video: "C:/films/master.MP4" } });
		expect(recipe.files).toEqual([{ label: "Video", selector: 'ytcp-uploads-file-picker input[type="file"]', path: "C:/films/master.MP4" }]);
		expect(recipe.steps?.some((step) => step.kind === "file" && step.label !== "Video")).toBe(false);
		expect(recipe.steps?.length).toBe((youtube.steps?.length ?? 0) - 6);
		expect(JSON.stringify(recipe.steps)).not.toContain("onlyWith");
	});

	test("the approval binding covers the files: Traction's golden vector, and no files hashes exactly as before", () => {
		const post = { origin: "https://studio.youtube.com", profile: "traction-youtube-brand", preset: "youtube-upload", values: ["Dry Run", "A film — about 🚀"] };
		expect(bindingOf({ ...post, files: { Video: "C:/films/master.mp4", Captions: "C:/films/captions.srt" } })).toBe("7eff2d9d051ae7f3a743b7a8f66d1d1bfeb5ed1ec7a83e3d507f22f1787894d0");
		expect(bindingOf({ ...post, files: { Captions: "C:/films/captions.srt", Video: "C:/films/master.mp4" } })).toBe("7eff2d9d051ae7f3a743b7a8f66d1d1bfeb5ed1ec7a83e3d507f22f1787894d0");
		expect(bindingOf({ ...post, files: {} })).toBe(bindingOf(post));
		expect(bindingOf(post)).toBe(createHash("sha256").update(JSON.stringify(["publish-approval/v1", post.origin, post.profile, post.preset, post.values])).digest("hex"));
	});
});

describeWithChrome("youtube-upload against its fixture copy", () => {
	test(
		"every file lands in its input through the browser, the wizard reaches Unlisted and parks, and the Post saves once with the youtu.be-shaped receipt",
		async () => {
			const s = await session("yt-full");
			const m = await media();
			const files = { Video: m.video, Thumbnail: m.thumbnail, Captions: m.captions };
			await approvePublish(s.rootDir, { origin: s.fixture.origin, profile: s.profile, preset: "youtube-upload", values: [TITLE, DESCRIPTION], files });

			const parked = await s.call("browser_publish", { browserId: s.browserId, preset: { name: "youtube-upload", values: [TITLE, DESCRIPTION], files }, mode: "post" });

			expect(parked.isError, JSON.stringify(parked.content)).toBeFalsy();
			const record = parked.structuredContent as unknown as PublishRecord;
			expect(record).toMatchObject({
				status: "awaiting-confirmation",
				preset: { name: "youtube-upload", verified: false },
				fields: [
					{ label: "Title", value: TITLE },
					{ label: "Description", value: DESCRIPTION },
				],
				files: [
					{ label: "Video", path: m.video },
					{ label: "Thumbnail", path: m.thumbnail },
					{ label: "Captions", path: m.captions },
				],
			});
			expect(s.fixture.uploads()).toEqual([
				{ field: "video", name: "master.mp4", size: (await Bun.file(m.video).arrayBuffer()).byteLength, sha256: m.digest(m.video) },
				{ field: "thumbnail", name: "thumb.png", size: 17, sha256: m.digest(m.thumbnail) },
				{ field: "captions", name: "captions.srt", size: 38, sha256: m.digest(m.captions) },
			]);
			expect(s.fixture.submissions()).toEqual([]);

			const shown = { origin: record.origin, profile: record.profile, values: [TITLE, DESCRIPTION] };
			const withoutFiles = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: record.publishId, expect: shown });
			expect(errorText(withoutFiles)).toContain("mismatched: files");
			expect(s.fixture.submissions()).toEqual([]);

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: record.publishId, expect: { ...shown, files } });

			expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: s.fixture.url("/fxvid000001") });
			expect(s.fixture.submissions().map((text) => JSON.parse(text))).toEqual([
				{ videoId: "fxvid000001", title: TITLE, description: DESCRIPTION, audience: "VIDEO_MADE_FOR_KIDS_NOT_MFK", visibility: "UNLISTED" },
			]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"with only the video, the captions steps never run and the human's Post saves it",
		async () => {
			const s = await session("yt-video-only");
			const m = await media();
			await approvePublish(s.rootDir, { origin: s.fixture.origin, profile: s.profile, preset: "youtube-upload", values: [TITLE, ""], files: { Video: m.video } });

			const parked = await s.call("browser_publish", { browserId: s.browserId, preset: { name: "youtube-upload", values: [TITLE, ""], files: { Video: m.video } }, mode: "post" });
			expect(parked.isError, JSON.stringify(parked.content)).toBeFalsy();
			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.structuredContent?.publishId }, "app");

			expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: s.fixture.url("/fxvid000001") });
			expect(s.fixture.uploads().map((upload) => upload.field)).toEqual(["video"]);
			expect(JSON.parse(s.fixture.submissions()[0] ?? "{}")).toMatchObject({ title: TITLE, visibility: "UNLISTED" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a page that drifted off Unlisted after parking is never saved: the check step is read again at confirm",
		async () => {
			const s = await session("yt-drift");
			const m = await media();
			await approvePublish(s.rootDir, { origin: s.fixture.origin, profile: s.profile, preset: "youtube-upload", values: [TITLE, DESCRIPTION], files: { Video: m.video } });
			const parked = await s.call("browser_publish", { browserId: s.browserId, preset: { name: "youtube-upload", values: [TITLE, DESCRIPTION], files: { Video: m.video } }, mode: "post" });
			expect(parked.isError, JSON.stringify(parked.content)).toBeFalsy();
			const driver = (s.runtime as unknown as { byId: Map<string, { driver: { evaluate(expression: string, limit: number): Promise<unknown> } }> }).byId.get(s.browserId)?.driver;
			await driver?.evaluate(`document.querySelector('[name="PUBLIC"]').click()`, 100);

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.structuredContent?.publishId }, "app");

			expect(confirmed.structuredContent).toMatchObject({ status: "failed", error: 'changed since shown: "tp-yt-paper-radio-button[name=\\"UNLISTED\\"][aria-checked=\\"true\\"]" is no longer on the page; nothing was submitted' });
			expect(s.fixture.submissions()).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a missing file, the browser's own data, an approval that does not name the files, or a wizard in a hand-written recipe is refused before Studio is opened",
		async () => {
			const s = await session("yt-refused");
			const m = await media();
			const publish = (files: Record<string, string>) => s.call("browser_publish", { browserId: s.browserId, preset: { name: "youtube-upload", values: [TITLE, DESCRIPTION], files }, mode: "post" });
			const missing = join(s.rootDir, "..", "no-such-master.mp4");
			const own = join(s.rootDir, "own-data.mp4");
			await writeFile(own, "not for upload");

			expect(errorText(await publish({ Video: missing }))).toContain(`file "Video": ${missing} does not exist`);
			expect(errorText(await publish({ Video: own }))).toContain("is the browser's own data");
			await approvePublish(s.rootDir, { origin: s.fixture.origin, profile: s.profile, preset: "youtube-upload", values: [TITLE, DESCRIPTION] });
			expect(errorText(await publish({ Video: m.video }))).toStartWith("publish_unapproved:");

			const byHand = {
				origin: s.fixture.origin,
				composeUrl: s.fixture.url("/"),
				signedIn: "ytcp-button#create-icon",
				fields: [{ label: "Title", selector: "#title-textarea #textbox", value: TITLE }],
				steps: [{ kind: "click", selector: "ytcp-uploads-dialog #done-button" }, { kind: "field", label: "Title" }],
				submit: "ytcp-uploads-dialog #done-button",
				receipt: { path: "/{segment}" },
			};
			expect(errorText(await s.call("browser_publish", { browserId: s.browserId, recipe: byHand, mode: "check" }))).toContain("steps");

			expect(s.fixture.hits(PLATFORM_ROUTES["youtube-upload"] ?? "/")).toBe(0);
			expect(s.fixture.uploads()).toEqual([]);
			expect((await s.runtime.state(s.browserId)).publish).toBeNull();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"browser_act's upload step sets a file input and answers a page's own file picker on a saved profile; bad paths and the View are refused",
		async () => {
			const s = await session("yt-act");
			const m = await media();
			const act = (actions: unknown[], caller?: string) => s.call("browser_act", { browserId: s.browserId, actions }, caller);

			const opened = await act([
				{ kind: "navigate", url: s.fixture.url("/") },
				{ kind: "click", selector: "ytcp-button#create-icon" },
				{ kind: "click", selector: "aria/Upload videos" },
				{ kind: "upload", selector: 'ytcp-uploads-file-picker input[type="file"]', paths: [m.video] },
				{ kind: "wait", selector: "#title-textarea #textbox" },
				{ kind: "click", selector: 'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]' },
				{ kind: "click", selector: "ytcp-uploads-dialog #next-button" },
				{ kind: "click", selector: "ytcp-uploads-video-elements .row ytcp-button" },
				{ kind: "click", selector: "#captions-choose ytcp-button" },
				{ kind: "upload", selector: "#captions-continue", paths: [m.captions] },
				{ kind: "wait", selector: "#captions-done" },
			]);
			expect(JSON.parse(opened.content[0]?.text ?? "{}").status, JSON.stringify(opened.content)).toBe("completed");
			expect(s.fixture.uploads().map((upload) => [upload.field, upload.sha256])).toEqual([
				["video", m.digest(m.video)],
				["captions", m.digest(m.captions)],
			]);

			const upload = (paths: string[], caller?: string) => act([{ kind: "upload", selector: "ytcp-thumbnail-uploader input#file-loader", paths }], caller);
			expect(errorText(await upload(["thumb.png"]))).toContain("upload.paths[0] must be an absolute path");
			expect(errorText(await upload([join(s.rootDir, "..", "nowhere.png")]))).toContain("does not exist");
			expect(errorText(await upload([m.thumbnail, m.thumbnail]))).toContain("takes one file, not 2");
			expect(errorText(await upload([m.thumbnail], "app"))).toContain("upload is the agent's");
			expect(s.fixture.uploads()).toHaveLength(2);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
