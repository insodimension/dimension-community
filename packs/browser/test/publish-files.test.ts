import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PublishRecord } from "../src/contracts";
import type { EngineDriver } from "../src/engines/types";
import { identifyLocalFile, requireLocalFile, requireUnchanged } from "../src/files";
import { type PublishPreset, loadPresets, parsePreset, resolvePreset } from "../src/presets";
import { prepare, validateRecipe } from "../src/publish";
import { bindingOf } from "../src/publish-approval";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { approvePublish, BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, perform, teardown } from "./fixture";
import { PLATFORM_ROUTES, type PlatformFixture, rebasePreset, startPlatformFixture } from "./platform-fixture";

const CALLER = "ai.insodimension/caller";
const TITLE = "Dry Run, the film";
const DESCRIPTION = "A film about a dry run.\nSecond line ünïcødé 🚀";
const HASHED_BYTES = 256 * 1024 * 1024;

async function canMakeSymlinks(): Promise<boolean> {
	const dir = await mkdtemp(join(tmpdir(), "dimension-browser-symlink-probe-"));
	try {
		await symlink(join(dir, "target"), join(dir, "link"), "file");
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
		throw error;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const symlinksAllowed = await canMakeSymlinks();

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

	test("an optional file left out drops its slot, its file step and every step that only runs with it, and nothing else", () => {
		const { recipe } = resolvePreset(shipped, { name: "youtube-upload", values: [TITLE, DESCRIPTION], files: { Video: "C:/films/master.MP4" } });
		expect(recipe.files).toEqual([{ label: "Video", selector: 'ytcp-uploads-file-picker input[type="file"]', path: "C:/films/master.MP4" }]);
		const runsWithVideoOnly = (youtube.steps ?? []).filter((step) => (step.onlyWith === undefined || step.onlyWith === "Video") && (step.kind !== "file" || step.label === "Video"));
		expect(recipe.steps).toEqual(runsWithVideoOnly.map(({ onlyWith: _onlyWith, ...step }) => step));
		expect(runsWithVideoOnly.length).toBeLessThan(youtube.steps?.length ?? 0);
	});

	test("the approval binding covers each file's path, size and bytes: Traction's golden vector, and no files hashes exactly as before", () => {
		const post = { origin: "https://studio.youtube.com", profile: "traction-youtube-brand", preset: "youtube-upload", values: ["Dry Run", "A film — about 🚀"] };
		const video = { path: "C:/films/master.mp4", size: 1_073_741_824, sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" };
		const captions = { path: "C:/films/captions.srt", size: 38, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };
		const golden = "035e4d44c2c0346ccaf77710c064711336b14f64c37c3776a430277319eda72b";
		expect(bindingOf({ ...post, files: { Video: video, Captions: captions } })).toBe(golden);
		expect(bindingOf({ ...post, files: { Captions: captions, Video: video } })).toBe(golden);
		expect(createHash("sha256").update(JSON.stringify(["publish-approval/v1", post.origin, post.profile, post.preset, post.values, { Captions: [captions.path, 38, captions.sha256], Video: [video.path, 1_073_741_824, video.sha256] }])).digest("hex")).toBe(golden);
		expect(bindingOf({ ...post, files: { Video: { ...video, sha256: captions.sha256 }, Captions: captions } })).not.toBe(golden);
		expect(bindingOf({ ...post, files: { Video: { ...video, size: video.size + 1 }, Captions: captions } })).not.toBe(golden);
		expect(bindingOf({ ...post, files: {} })).toBe(bindingOf(post));
		expect(bindingOf(post)).toBe(createHash("sha256").update(JSON.stringify(["publish-approval/v1", post.origin, post.profile, post.preset, post.values])).digest("hex"));
	});

	test("a network or device path is refused by what it is, before any filesystem call could reach out over SMB", () => {
		const resolve = (path: string) => () => resolvePreset(shipped, { name: "youtube-upload", values: [TITLE, DESCRIPTION], files: { Video: path } });
		const network = ["//unc-refusal.invalid/share/master.mp4", ...(process.platform === "win32" ? ["\\\\unc-refusal.invalid\\share\\master.mp4", "\\\\?\\UNC\\unc-refusal.invalid\\share\\master.mp4", "\\\\.\\pipe\\master.mp4", "\\??\\UNC\\unc-refusal.invalid\\share\\master.mp4"] : [])];
		for (const path of network) {
			expect(resolve(path)).toThrow("is a network or device path");
			expect(() => requireLocalFile(path, 'file "Video"', "bad_file", "/")).toThrow("is a network or device path");
		}
	});

	test.skipIf(!symlinksAllowed)("a symlink whose target is a network share, an NT or rooted path, or a dangling hop is refused at the link, before the operating system follows it; a link to a local file still resolves", async () => {
		const dir = await createRoot();
		const share = process.platform === "win32" ? "\\\\unc-refusal.invalid\\share\\master.mp4" : "//unc-refusal.invalid/share/master.mp4";
		const real = join(dir, "master.mp4");
		await mkdir(join(dir, "browser-root"));
		await writeFile(real, "local bytes");
		const direct = join(dir, "direct.mp4");
		const chained = join(dir, "chained.mp4");
		const dangling = join(dir, "dangling.mp4");
		const local = join(dir, "local.mp4");
		await symlink(share, direct, "file");
		await symlink(share, join(dir, "hop.mp4"), "file");
		await symlink("hop.mp4", chained, "file");
		await symlink(join(dir, "gone", "master.mp4"), dangling, "file");
		await symlink(real, local, "file");
		const refusal = (path: string) => () => requireLocalFile(path, 'file "Video"', "bad_file", join(dir, "browser-root"));
		for (const path of [direct, chained]) expect(refusal(path)).toThrow(`links to ${share}, a network or device path`);
		expect(refusal(dangling)).toThrow("which cannot be checked without following a link");
		if (process.platform === "win32") {
			const rooted = join(dir, "rooted.mp4");
			await symlink("\\Device\\Mup\\unc-refusal.invalid\\share\\master.mp4", rooted, "file");
			expect(refusal(rooted)).toThrow(/a path on no drive letter \(an NT or rooted path\)|which cannot be checked without following a link/);
		}
		expect(requireLocalFile(local, 'file "Video"', "bad_file", join(dir, "browser-root")).real).toBe(await realpath(real));
	});

	test("a file identified at Approve is refused right before it is attached once its bytes or metadata change", async () => {
		const dir = await createRoot();
		const path = join(dir, "master.mp4");
		await writeFile(path, "approved bytes");
		await mkdir(join(dir, "browser-root"));
		const identified = await identifyLocalFile(path, 'file "Video"', "bad_file", join(dir, "browser-root"));
		expect(identified).toMatchObject({ path, size: 14, sha256: createHash("sha256").update("approved bytes").digest("hex") });
		expect(() => requireUnchanged(identified, 'file "Video"')).not.toThrow();
		await sleep(20);
		await writeFile(path, "swapped bytes!");
		expect(() => requireUnchanged(identified, 'file "Video"')).toThrow('file_changed: file "Video": ');
		expect(() => requireUnchanged(identified, 'file "Video"')).toThrow("changed after it was approved; nothing was attached");
	});

	test("a hidden field must still read the typed text, give or take whitespace, or the wizard fails with field-mismatch", async () => {
		const ORIGIN = "https://wizard.example";
		const parkWith = async (hiddenRead: (typed: string) => string) => {
			const values = new Map<string, string>();
			let advanced = false;
			const driver = {
				state: async () => ({ url: `${ORIGIN}/compose`, activeTabId: "tab-1" }),
				perform: async (action: { kind: string; selector?: string }) => {
					if (action.kind === "click" && action.selector === "#next") advanced = true;
				},
				hasElement: async () => true,
				waitFor: async () => true,
				readField: async (selector: string) => ({ state: "value", value: advanced ? hiddenRead(values.get(selector) ?? "") : (values.get(selector) ?? "") }),
				fill: async (selector: string, value: string) => {
					values.set(selector, value);
				},
				inspect: async () => ({ found: true, rect: { x: 0, y: 0, width: 0, height: 0 } }),
			} as unknown as EngineDriver;
			const recipe = validateRecipe({
				origin: ORIGIN,
				composeUrl: `${ORIGIN}/compose`,
				signedIn: "#me",
				fields: [{ label: "Description", selector: "#description", value: "First line\nSecond  line" }],
				steps: [{ kind: "field", label: "Description" }, { kind: "click", selector: "#next" }],
				submit: "#save",
				receipt: { path: "/{segment}" },
			});
			return await prepare(driver, "p", recipe, "post");
		};
		expect(await parkWith((typed) => typed.replace(/\s+/g, " "))).toMatchObject({ record: { status: "awaiting-confirmation" } });
		expect(await parkWith(() => "master.mp4")).toMatchObject({ status: "failed", error: 'field-mismatch: "#description" no longer holds the value typed after the steps; nothing was submitted' });
		expect(await parkWith((typed) => `${typed} (edited)`)).toMatchObject({ status: "failed" });
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

			expect(confirmed.structuredContent).toMatchObject({
				status: "failed",
				error: 'changed since shown: "tp-yt-paper-radio-button[name=\\"UNLISTED\\"][aria-checked=\\"true\\"]" is no longer on the page; nothing was submitted; the files it attached had already started uploading, so the site may keep a private draft of this post: check the account and delete it there',
			});
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
		"browser_act has no upload step: an agent driving Studio by hand cannot hand it a file, from any caller",
		async () => {
			const s = await session("yt-act");
			const m = await media();
			const act = (actions: unknown[], caller?: string) => s.call("browser_act", { browserId: s.browserId, actions }, caller);

			const opened = await act([
				{ kind: "navigate", url: s.fixture.url("/") },
				{ kind: "click", selector: "ytcp-button#create-icon" },
				{ kind: "click", selector: "aria/Upload videos" },
			]);
			expect(JSON.parse(opened.content[0]?.text ?? "{}").status, JSON.stringify(opened.content)).toBe("completed");
			const upload = { kind: "upload", selector: 'ytcp-uploads-file-picker input[type="file"]', paths: [m.video] };
			expect(errorText(await act([upload]))).toContain("kind");
			expect(errorText(await act([upload], "app"))).toContain("kind");
			await expect(perform(s.runtime, s.browserId, upload as never)).rejects.toThrow('unsupported action kind "upload"');
			expect(s.fixture.uploads()).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a file swapped after the person approved it is refused before Studio is opened: the approval binds its bytes, not its name",
		async () => {
			const s = await session("yt-swap");
			const m = await media();
			await approvePublish(s.rootDir, { origin: s.fixture.origin, profile: s.profile, preset: "youtube-upload", values: [TITLE, DESCRIPTION], files: { Video: m.video } });
			await writeFile(m.video, "a different film under the approved name");

			const swapped = await s.call("browser_publish", { browserId: s.browserId, preset: { name: "youtube-upload", values: [TITLE, DESCRIPTION], files: { Video: m.video } }, mode: "post" });

			expect(errorText(swapped)).toStartWith("publish_unapproved:");
			expect(s.fixture.hits(PLATFORM_ROUTES["youtube-upload"] ?? "/")).toBe(0);
			expect(s.fixture.uploads()).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"attaching the video spends the approval: a cancel says a draft may be left, and parking it again needs a fresh Approve instead of uploading twice",
		async () => {
			const s = await session("yt-retry");
			const m = await media();
			const files = { Video: m.video };
			await approvePublish(s.rootDir, { origin: s.fixture.origin, profile: s.profile, preset: "youtube-upload", values: [TITLE, DESCRIPTION], files });
			const publish = () => s.call("browser_publish", { browserId: s.browserId, preset: { name: "youtube-upload", values: [TITLE, DESCRIPTION], files }, mode: "post" });

			const parked = await publish();
			expect(parked.structuredContent?.status, JSON.stringify(parked.content)).toBe("awaiting-confirmation");
			const cancelled = await s.call("browser_publish_cancel", { browserId: s.browserId, publishId: parked.structuredContent?.publishId });
			expect(cancelled.structuredContent).toMatchObject({ status: "cancelled" });
			expect(String(cancelled.structuredContent?.error)).toContain("the site may keep a private draft of this post");

			expect(errorText(await publish())).toContain("was already used");
			expect((await s.runtime.state(s.browserId)).publish).toMatchObject({ publishId: parked.structuredContent?.publishId, status: "cancelled" });
			expect(s.fixture.uploads().map((upload) => upload.field)).toEqual(["video"]);

			await approvePublish(s.rootDir, { origin: s.fixture.origin, profile: s.profile, preset: "youtube-upload", values: [TITLE, DESCRIPTION], files });
			const again = await publish();
			expect(again.structuredContent?.status, JSON.stringify(again.content)).toBe("awaiting-confirmation");
			expect(s.fixture.submissions()).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a wizard longer than the call returns preparing with its publishId; browser_publish_wait follows it to the parked post, and a cancel while preparing is reported once the run stops",
		async () => {
			const s = await session("yt-async");
			const m = await media();
			const files = { Video: m.video };
			const request = { browserId: s.browserId, preset: { name: "youtube-upload", values: [TITLE, DESCRIPTION], files }, mode: "post", waitSeconds: 0 };
			await approvePublish(s.rootDir, { origin: s.fixture.origin, profile: s.profile, preset: "youtube-upload", values: [TITLE, DESCRIPTION], files });

			const started = await s.call("browser_publish", request);
			expect(started.structuredContent, JSON.stringify(started.content)).toMatchObject({ status: "preparing" });
			const publishId = started.structuredContent?.publishId;
			expect(errorText(await s.call("browser_act", { browserId: s.browserId, actions: [{ kind: "reload" }] }))).toContain("a post is being prepared on this browser");
			let followed = await s.call("browser_publish_wait", { browserId: s.browserId, publishId, waitSeconds: 25 });
			while (followed.structuredContent?.status === "preparing") followed = await s.call("browser_publish_wait", { browserId: s.browserId, publishId, waitSeconds: 25 });
			expect(followed.structuredContent).toMatchObject({ publishId, status: "awaiting-confirmation" });
			await s.call("browser_publish_cancel", { browserId: s.browserId, publishId });

			await approvePublish(s.rootDir, { origin: s.fixture.origin, profile: s.profile, preset: "youtube-upload", values: [TITLE, DESCRIPTION], files });
			const second = await s.call("browser_publish", request);
			expect(second.structuredContent).toMatchObject({ status: "preparing" });
			const stopped = await s.call("browser_publish_cancel", { browserId: s.browserId, publishId: second.structuredContent?.publishId });
			expect(stopped.structuredContent).toMatchObject({ status: "cancelled" });
			expect(String(stopped.structuredContent?.error)).toStartWith("Cancelled while it was being prepared; nothing was submitted");
			expect(s.fixture.submissions()).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a publish returns preparing while its file is still being hashed: a second publish is refused at once, and a cancel stops the hash before Studio opens or the approval is spent",
		async () => {
			const s = await session("yt-hashing");
			const video = join(await createRoot(), "master.mp4");
			await writeFile(video, "");
			await truncate(video, HASHED_BYTES);
			const files = { Video: video };
			const request = { browserId: s.browserId, preset: { name: "youtube-upload", values: [TITLE, DESCRIPTION], files }, mode: "post", waitSeconds: 0 };
			await approvePublish(s.rootDir, { origin: s.fixture.origin, profile: s.profile, preset: "youtube-upload", values: [TITLE, DESCRIPTION], files });

			const started = await s.call("browser_publish", request);
			expect(started.structuredContent, JSON.stringify(started.content)).toMatchObject({ status: "preparing" });
			expect(errorText(await s.call("browser_publish", request))).toContain("a post is being prepared on this browser");
			const stopped = await s.call("browser_publish_cancel", { browserId: s.browserId, publishId: started.structuredContent?.publishId });

			expect(stopped.structuredContent).toMatchObject({ status: "cancelled" });
			expect(String(stopped.structuredContent?.error)).toStartWith("Cancelled while it was being prepared; nothing was submitted");
			expect(s.fixture.hits(PLATFORM_ROUTES["youtube-upload"] ?? "/")).toBe(0);
			expect(s.fixture.uploads()).toEqual([]);
			expect((await readdir(join(s.rootDir, "publish-approvals"))).filter((name) => name.endsWith(".used"))).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a file written to while it is hashed after the call returned preparing fails the record with its code, bad_file, and spends nothing",
		async () => {
			const s = await session("yt-hash-changed");
			const video = join(await createRoot(), "master.mp4");
			await writeFile(video, "");
			await truncate(video, HASHED_BYTES);
			const files = { Video: video };
			await approvePublish(s.rootDir, { origin: s.fixture.origin, profile: s.profile, preset: "youtube-upload", values: [TITLE, DESCRIPTION], files });

			const started = await s.call("browser_publish", { browserId: s.browserId, preset: { name: "youtube-upload", values: [TITLE, DESCRIPTION], files }, mode: "post", waitSeconds: 0 });
			expect(started.structuredContent, JSON.stringify(started.content)).toMatchObject({ status: "preparing" });
			await truncate(video, HASHED_BYTES + 1);
			let record = started.structuredContent;
			while (record?.status === "preparing") record = (await s.call("browser_publish_wait", { browserId: s.browserId, publishId: started.structuredContent?.publishId, waitSeconds: 25 })).structuredContent;

			expect(record).toMatchObject({ status: "failed" });
			expect(String(record?.error)).toStartWith(`bad_file: file "Video": ${video} changed while it was being read`);
			expect(s.fixture.hits(PLATFORM_ROUTES["youtube-upload"] ?? "/")).toBe(0);
			expect((await readdir(join(s.rootDir, "publish-approvals"))).filter((name) => name.endsWith(".used"))).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
