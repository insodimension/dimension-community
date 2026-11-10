import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUploadVideoTool, type UploadDetails } from "../upload";
import { bearerOf, type ChannelSeed, channelIdOf, seedChannel } from "./channel-fixture";

const ENV = ["HOME", "USERPROFILE"] as const;
const prior = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
const root = await mkdtemp(join(tmpdir(), "youtube-upload-"));
const home = join(root, "home");
const media = join(root, "media");
const CONFIG_DIR = join(home, ".config", "dimension-youtube");
const UPLOADER: ChannelSeed = { channelId: channelIdOf("uploader"), title: "Uploader", access: "tok-up", refresh: "refresh-up" };

const CHUNK_BYTES = 8 * 1024 * 1024;
const GRANULE = 256 * 1024;
const VIDEO_ID = "dQw4w9WgXcQ";
const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-1";
const NOTHING_UPLOADED = /Nothing was uploaded/;
const FUTURE = "2099-06-01T12:00:00+02:00";
const FUTURE_UTC = "2099-06-01T10:00:00.000Z";

function pattern(size: number): Buffer {
	const bytes = Buffer.alloc(size);
	let state = 0x9e3779b9;
	for (let index = 0; index < size; index++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		bytes[index] = state & 0xff;
	}
	return bytes;
}

async function fixture(name: string, bytes: Uint8Array | string): Promise<string> {
	const path = join(media, name);
	await writeFile(path, bytes);
	return path;
}

await mkdir(media, { recursive: true });
const LARGE_BYTES = pattern(CHUNK_BYTES + 13);
const LARGE = { path: await fixture("large.mp4", LARGE_BYTES), size: LARGE_BYTES.byteLength, sha256: createHash("sha256").update(LARGE_BYTES).digest("hex") };
const SMALL = { path: await fixture("small.mp4", pattern(2048)) };
const EMPTY_VIDEO = await fixture("empty.mp4", "");
const NOTES = await fixture("notes.txt", "not a video");
const THUMB_BYTES = pattern(300);
const THUMB = await fixture("thumb.png", THUMB_BYTES);
const THUMB_GIF = await fixture("thumb.gif", THUMB_BYTES);
const THUMB_TOO_BIG = await fixture("huge.png", Buffer.alloc(2 * 1024 * 1024 + 1));
const CAPTIONS_TEXT = "1\n00:00:00,000 --> 00:00:02,000\nHello there\n";
const CAPTIONS = await fixture("captions.srt", CAPTIONS_TEXT);
const CAPTIONS_EMPTY = await fixture("empty.srt", "");
const CAPTIONS_WRONG = await fixture("captions.txt", CAPTIONS_TEXT);

beforeAll(() => {
	process.env.HOME = home;
	process.env.USERPROFILE = home;
});

interface UploadResult {
	content: { text: string }[];
	details: UploadDetails;
}

interface UploadTool {
	execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<UploadResult>;
}

interface Call {
	method: string;
	url: URL;
	headers: Headers;
	body: unknown;
}

type Handler = (call: Call, bytes: Uint8Array) => Response | Promise<Response>;

interface VideoRow {
	id: string;
	snippet: { title: string };
	status: Record<string, unknown>;
}

interface SessionRequest {
	ordinal: number;
	probe: boolean;
	from: number;
	to: number;
	total: number;
}

type Fault = { status: number; kept: "all" | number; body?: unknown } | { drop: true; kept: "all" | number };

interface Script {
	start?: () => Response;
	session?: (request: SessionRequest) => Fault | undefined;
	done?: (video: VideoRow) => Response;
	thumbnail?: () => Response;
	playlist?: () => Response;
	captions?: () => Response;
	listing?: (video: VideoRow) => Response;
	token?: () => Response;
}

interface Google {
	puts: SessionRequest[];
	received: () => { bytes: number; sha256: string };
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];

function serve(handler: Handler): void {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const raw = init?.body;
		const view = ArrayBuffer.isView(raw);
		const bytes = raw instanceof Blob ? new Uint8Array(await raw.arrayBuffer()) : view ? new Uint8Array(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)) : new Uint8Array(0);
		const call: Call = {
			method: init?.method ?? "GET",
			url: new URL(input instanceof Request ? input.url : String(input)),
			headers: new Headers(init?.headers),
			body: typeof raw === "string" ? raw : raw instanceof Blob ? bytes : undefined,
		};
		calls.push(call);
		return handler(call, bytes);
	}) as typeof fetch;
}

function refusal(status: number, message: string): Response {
	return Response.json({ error: { message } }, { status });
}

function google(script: Script = {}): Google {
	const hash = createHash("sha256");
	const puts: SessionRequest[] = [];
	let committed = 0;
	let total = 0;
	let video: VideoRow = { id: VIDEO_ID, snippet: { title: "" }, status: {} };
	let digest: string | undefined;

	function keep(request: SessionRequest, payload: Uint8Array, kept: "all" | number): Response | undefined {
		if (request.from !== committed) return refusal(400, `chunk starts at ${request.from} but ${committed} bytes are already held`);
		if (payload.byteLength !== request.to - request.from + 1) return refusal(400, "chunk length does not match its Content-Range");
		if (kept === "all" && request.to + 1 !== request.total && payload.byteLength % GRANULE !== 0) {
			return refusal(400, "a chunk that is not the last must be a multiple of 256 KiB");
		}
		const held = kept === "all" ? payload : payload.subarray(0, kept);
		hash.update(held);
		committed += held.byteLength;
		return undefined;
	}

	function progress(): Response {
		if (committed === 0) return new Response(null, { status: 308 });
		return new Response(null, { status: 308, headers: { Range: `bytes=0-${committed - 1}` } });
	}

	function finished(): Response {
		return script.done ? script.done(video) : Response.json(video);
	}

	function session(call: Call, payload: Uint8Array): Response {
		const header = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(call.headers.get("content-range") ?? "");
		if (!header) return refusal(400, "unreadable Content-Range");
		const probe = header[1] === undefined;
		const request: SessionRequest = { ordinal: puts.length, probe, from: Number(header[1] ?? -1), to: Number(header[2] ?? -1), total: Number(header[3]) };
		puts.push(request);
		const fault = script.session?.(request);
		if (fault) {
			if (!probe && fault.kept !== 0) keep(request, payload, fault.kept);
			if ("drop" in fault) throw new TypeError("fetch failed");
			if (fault.status === 308) return progress();
			return Response.json(fault.body ?? { error: { message: `injected ${fault.status}` } }, { status: fault.status });
		}
		if (probe) return committed === total ? finished() : progress();
		const rejected = keep(request, payload, "all");
		if (rejected) return rejected;
		return committed === total ? finished() : progress();
	}

	serve((call, payload) => {
		const { pathname, searchParams } = call.url;
		if (call.method === "POST" && pathname === "/upload/youtube/v3/videos") {
			if (script.start) return script.start();
			total = Number(call.headers.get("x-upload-content-length"));
			const resource = JSON.parse(String(call.body)) as { snippet: { title: string }; status: Record<string, unknown> };
			video = {
				id: VIDEO_ID,
				snippet: { title: resource.snippet.title },
				status: {
					uploadStatus: "uploaded",
					privacyStatus: resource.status.privacyStatus,
					selfDeclaredMadeForKids: resource.status.selfDeclaredMadeForKids,
					...(resource.status.publishAt ? { publishAt: resource.status.publishAt } : {}),
				},
			};
			return new Response(null, { status: 200, headers: { Location: SESSION } });
		}
		if (call.method === "PUT" && pathname === "/upload/youtube/v3/videos" && searchParams.get("upload_id") === "session-1") return session(call, payload);
		if (call.method === "POST" && pathname === "/upload/youtube/v3/thumbnails/set") return script.thumbnail?.() ?? Response.json({ items: [{}] });
		if (call.method === "POST" && pathname === "/youtube/v3/playlistItems") return script.playlist?.() ?? Response.json({ id: "item-1" });
		if (call.method === "POST" && pathname === "/upload/youtube/v3/captions") return script.captions?.() ?? Response.json({ id: "caption-1" });
		if (call.method === "GET" && pathname === "/youtube/v3/videos") return script.listing ? script.listing(video) : Response.json({ items: [video] });
		if (call.method === "POST" && call.url.href === "https://oauth2.googleapis.com/token" && script.token) return script.token();
		throw new Error(`unexpected request ${call.method} ${call.url}`);
	});

	return {
		puts,
		received: () => ({ bytes: committed, sha256: (digest ??= hash.digest("hex")) }),
	};
}

interface Run {
	delays?: number[];
	signal?: AbortSignal;
}

function upload(params: Record<string, unknown>, run: Run = {}): Promise<UploadResult> {
	const tool = createUploadVideoTool(failures => {
		run.delays?.push(failures);
		return 0;
	}) as unknown as UploadTool;
	return tool.execute("call-1", { filePath: SMALL.path, title: "Film", madeForKids: false, ...params }, run.signal);
}

function contentRanges(): (string | null)[] {
	return calls.filter(call => call.method === "PUT").map(call => call.headers.get("content-range"));
}

function startCall(): Call {
	const [start] = calls;
	if (!start || start.method !== "POST") throw new Error("the first request was not the session start");
	return start;
}

function resourceOf(call: Call): { snippet: Record<string, unknown>; status: Record<string, unknown> } {
	return JSON.parse(String(call.body)) as { snippet: Record<string, unknown>; status: Record<string, unknown> };
}

function callsTo(pathname: string): Call[] {
	return calls.filter(call => call.url.pathname === pathname);
}

beforeEach(async () => {
	await rm(CONFIG_DIR, { recursive: true, force: true });
	await seedChannel(CONFIG_DIR, UPLOADER);
	calls = [];
	serve(call => {
		throw new Error(`unexpected request ${call.method} ${call.url}`);
	});
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

afterAll(async () => {
	for (const name of ENV) {
		if (prior[name] === undefined) delete process.env[name];
		else process.env[name] = prior[name];
	}
	await rm(root, { recursive: true, force: true });
});

describe("youtube_upload_video", () => {
	describe("transfer", () => {
		test("a file larger than one chunk goes up as contiguous ranges that reassemble the file, and the result names the video", async () => {
			const fake = google();

			const result = await upload({ filePath: LARGE.path });

			expect(contentRanges()).toEqual([`bytes 0-${CHUNK_BYTES - 1}/${LARGE.size}`, `bytes ${CHUNK_BYTES}-${LARGE.size - 1}/${LARGE.size}`]);
			expect(fake.received()).toEqual({ bytes: LARGE.size, sha256: LARGE.sha256 });
			expect(result.details).toMatchObject({ videoId: VIDEO_ID, url: `https://youtu.be/${VIDEO_ID}`, channelId: UPLOADER.channelId, visibility: "public", followUps: [] });
			expect(result.details.readback).toEqual([
				{ field: "title", expected: "Film", actual: "Film", ok: true },
				{ field: "visibility", expected: "public", actual: "public", ok: true },
				{ field: "madeForKids", expected: "false", actual: "false", ok: true },
			]);
			expect(result.content[0]?.text).toContain(`https://youtu.be/${VIDEO_ID}`);
			expect(calls.every(call => call.headers.get("authorization") === bearerOf(UPLOADER))).toBe(true);
		});

		test.each([
			["film.mp4", "video/mp4"],
			["CLIP.MOV", "video/quicktime"],
			["reel.webm", "video/webm"],
			["cut.mkv", "video/x-matroska"],
		])("%s starts a resumable session that declares its exact byte length and %s", async (name, mime) => {
			const path = await fixture(name, pattern(777));
			google();

			await upload({ filePath: path });

			const start = startCall();
			expect(start.url.pathname).toBe("/upload/youtube/v3/videos");
			expect(start.url.searchParams.get("uploadType")).toBe("resumable");
			expect(start.url.searchParams.get("part")).toBe("snippet,status");
			expect(start.headers.get("x-upload-content-length")).toBe("777");
			expect(start.headers.get("x-upload-content-type")).toBe(mime);
		});

		test("a link that fails once per chunk never trips the failure cap, because progress resets the count", async () => {
			const path = join(media, "long.mp4");
			const size = 10 * CHUNK_BYTES + 1;
			await writeFile(path, "");
			await truncate(path, size);
			const faulted = new Set<number>();
			const delays: number[] = [];
			const fake = google({
				session: request => {
					if (request.probe || faulted.has(request.from)) return undefined;
					faulted.add(request.from);
					return { status: 503, kept: 0 };
				},
			});

			const result = await upload({ filePath: path }, { delays });

			expect(result.details.videoId).toBe(VIDEO_ID);
			expect(fake.received().bytes).toBe(size);
			expect(delays.length).toBe(11);
			expect(delays.every(failures => failures === 1)).toBe(true);
		});

		test("a cancelled call stops sending instead of retrying", async () => {
			const controller = new AbortController();
			const fake = google({
				session: () => {
					controller.abort(new Error("cancelled by the person"));
					return { status: 503, kept: 0 };
				},
			});

			await expect(upload({}, { signal: controller.signal })).rejects.toThrow("cancelled by the person");

			expect(fake.puts.length).toBe(1);
			expect(calls.some(call => call.method === "GET")).toBe(false);
		});

		test("a finished upload without a video id is an error, not a success", async () => {
			google({ done: () => Response.json({}) });

			await expect(upload({})).rejects.toThrow(/returned no video id/);
		});

		test.each([
			[{ uploadStatus: "rejected", rejectionReason: "duplicate" }, /YouTube rejected the file: duplicate/],
			[{ uploadStatus: "failed", failureReason: "codec" }, /YouTube failed the file: codec/],
		])("a video YouTube refuses to process (%o) is reported in followUps", async (status, message) => {
			google({ done: video => Response.json({ ...video, status: { ...video.status, ...status } }) });

			const result = await upload({});

			expect(result.details.followUps[0]).toMatch(message);
			expect(result.details.videoId).toBe(VIDEO_ID);
		});
	});

	describe("resume", () => {
		const whole = `bytes 0-${CHUNK_BYTES - 1}/${LARGE.size}`;
		const probe = `bytes */${LARGE.size}`;
		const tail = `bytes ${CHUNK_BYTES}-${LARGE.size - 1}/${LARGE.size}`;

		test.each<[string, Fault]>([
			["HTTP 500", { status: 500, kept: "all" }],
			["HTTP 503", { status: 503, kept: "all" }],
			["HTTP 408", { status: 408, kept: "all" }],
			["HTTP 429", { status: 429, kept: "all" }],
			["a dropped connection", { drop: true, kept: "all" }],
		])("%s after the server stored the first chunk probes, then sends only what follows it", async (_label, fault) => {
			const fake = google({ session: request => (request.ordinal === 0 ? fault : undefined) });

			const result = await upload({ filePath: LARGE.path });

			expect(contentRanges()).toEqual([whole, probe, tail]);
			expect(fake.received()).toEqual({ bytes: LARGE.size, sha256: LARGE.sha256 });
			expect(result.details.videoId).toBe(VIDEO_ID);
		});

		test.each<[string, Fault]>([
			["HTTP 503", { status: 503, kept: 0 }],
			["a dropped connection", { drop: true, kept: 0 }],
			["a 308 that carries no Range", { status: 308, kept: 0 }],
		])("%s before the server kept anything resumes at byte 0 when the probe has no Range", async (_label, fault) => {
			const fake = google({ session: request => (request.ordinal === 0 ? fault : undefined) });

			const result = await upload({ filePath: LARGE.path });

			expect(contentRanges()).toEqual([whole, probe, whole, tail]);
			expect(fake.received()).toEqual({ bytes: LARGE.size, sha256: LARGE.sha256 });
			expect(result.details.videoId).toBe(VIDEO_ID);
		});

		test("a server that kept only part of a chunk resumes exactly where its Range says, mid-chunk", async () => {
			const kept = 3 * GRANULE;
			const fake = google({ session: request => (request.ordinal === 0 ? { status: 503, kept } : undefined) });

			await upload({ filePath: LARGE.path });

			expect(contentRanges()).toEqual([whole, probe, `bytes ${kept}-${LARGE.size - 1}/${LARGE.size}`]);
			expect(fake.received()).toEqual({ bytes: LARGE.size, sha256: LARGE.sha256 });
		});

		test.each<[string, Fault]>([
			["HTTP 503", { status: 503, kept: "all" }],
			["a dropped connection", { drop: true, kept: "all" }],
		])("%s on the last chunk after it was stored finishes from the probe without sending the tail twice", async (_label, fault) => {
			const fake = google({ session: request => (request.from === CHUNK_BYTES ? fault : undefined) });

			const result = await upload({ filePath: LARGE.path });

			expect(contentRanges()).toEqual([whole, tail, probe]);
			expect(fake.received()).toEqual({ bytes: LARGE.size, sha256: LARGE.sha256 });
			expect(result.details.videoId).toBe(VIDEO_ID);
		});

		test("a probe that says every byte is held but offers no video is probed again, never answered with an empty range", async () => {
			const script: Record<number, Fault> = {
				1: { status: 503, kept: "all" },
				2: { status: 308, kept: 0 },
			};
			const delays: number[] = [];
			const fake = google({ session: request => script[request.ordinal] });

			const result = await upload({ filePath: LARGE.path }, { delays });

			expect(contentRanges()).toEqual([whole, tail, probe, probe]);
			expect(delays).toEqual([1, 2]);
			expect(fake.received()).toEqual({ bytes: LARGE.size, sha256: LARGE.sha256 });
			expect(result.details.videoId).toBe(VIDEO_ID);
		});

		test("probes that fail too keep being retried, each wait told how many failures in a row came before it", async () => {
			const script: Record<number, Fault> = {
				0: { status: 503, kept: "all" },
				1: { drop: true, kept: 0 },
				2: { status: 429, kept: 0 },
			};
			const delays: number[] = [];
			const fake = google({ session: request => script[request.ordinal] });

			await upload({ filePath: LARGE.path }, { delays });

			expect(contentRanges()).toEqual([whole, probe, probe, probe, tail]);
			expect(delays).toEqual([1, 2, 3]);
			expect(fake.received()).toEqual({ bytes: LARGE.size, sha256: LARGE.sha256 });
		});

		test("a server that never recovers ends the call with the video-may-exist warning, after waiting between every attempt", async () => {
			const delays: number[] = [];
			const fake = google({ session: () => ({ status: 503, kept: 0, body: { error: { message: "backendError" } } }) });

			const failure = await upload({}, { delays }).then(
				() => undefined,
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);

			expect(failure).toMatch(/may exist: list the channel's uploads/);
			expect(failure).toContain("backendError");
			expect(delays.length).toBeGreaterThan(1);
			expect(delays.every((failures, index) => failures === index + 1)).toBe(true);
			expect(fake.puts.length).toBe(delays.length + 1);
			expect(calls.some(call => call.method === "GET")).toBe(false);
		});

		test.each([404, 410])("HTTP %i on a chunk means the session expired: no retry and a message to start over", async status => {
			const fake = google({ session: () => ({ status, kept: 0 }) });

			await expect(upload({})).rejects.toThrow(/upload session expired.*upload from the start/);

			expect(fake.puts.length).toBe(1);
			expect(calls.some(call => call.method === "GET")).toBe(false);
		});

		test("a 404 on the probe after a dropped connection is the same expired-session error", async () => {
			const fake = google({ session: request => (request.ordinal === 0 ? { drop: true, kept: 0 } : { status: 404, kept: 0 }) });

			await expect(upload({})).rejects.toThrow(/upload session expired/);

			expect(fake.puts.map(request => request.probe)).toEqual([false, true]);
		});

		test("another 4xx on a chunk is a refusal carrying Google's reason, with no retry", async () => {
			const fake = google({ session: () => ({ status: 403, kept: 0, body: { error: { message: "The request cannot be completed because you have exceeded your quota." } } }) });

			await expect(upload({})).rejects.toThrow(/refused the upload part way: The request cannot be completed because you have exceeded your quota\./);

			expect(fake.puts.length).toBe(1);
		});

		test("a refused session start surfaces Google's reason, says nothing was uploaded, and sends no bytes", async () => {
			google({ start: () => refusal(403, "quotaExceeded") });

			await expect(upload({})).rejects.toThrow(/refused to start the upload: quotaExceeded.*Nothing was uploaded/);

			expect(calls.length).toBe(1);
		});

		test("a session start with no Location is an error that says nothing was uploaded", async () => {
			google({ start: () => new Response(null, { status: 200 }) });

			await expect(upload({})).rejects.toThrow(/named no upload address.*Nothing was uploaded/);

			expect(calls.length).toBe(1);
		});
	});

	describe("validation", () => {
		const aboutAMinute = quoted(82, 82);

		function quoted(left: number, right: number): string {
			return `${"a".repeat(left)} ${"b".repeat(right)}`;
		}

		test.each<[string, Record<string, unknown>, RegExp]>([
			["a relative video path", { filePath: "clips/film.mp4" }, /not an absolute path/],
			["an unknown video extension", { filePath: NOTES }, /not a video file YouTube takes/],
			["a video file that does not exist", { filePath: join(media, "missing.mp4") }, /could not be read/],
			["an empty video file", { filePath: EMPTY_VIDEO }, /is empty/],
			["a blank title", { title: "   " }, /title is empty/],
			["a 101 character title", { title: "a".repeat(101) }, /101 characters/],
			["a title with <", { title: "Film <3" }, /refuses < and >/],
			["a description of 5001 bytes that is only 2501 characters", { description: `${"é".repeat(2500)}a` }, /5001 bytes/],
			["a description with >", { description: "see > below" }, /refuses < and >/],
			["tags that only overflow once quoted multi-word tags are counted", { tags: [aboutAMinute, aboutAMinute, aboutAMinute] }, /503 characters/],
			["tags that only overflow once the commas are counted", { tags: ["a".repeat(250), "b".repeat(250)] }, /501 characters/],
			["an unknown category name", { category: "Underwater Basket Weaving" }, /is not a YouTube category/],
			["a publishAt in the past", { publishAt: "2020-01-01T00:00:00Z" }, /not in the future/],
			["a publishAt that is not a time", { publishAt: "next tuesday" }, /not an ISO 8601 time/],
			["publishAt with public visibility", { publishAt: FUTURE, visibility: "public" }, /cannot go with it/],
			["publishAt with unlisted visibility", { publishAt: FUTURE, visibility: "unlisted" }, /cannot go with it/],
			["captions with no language anywhere", { captionsPath: CAPTIONS }, /Captions need a language/],
			["a relative thumbnail path", { thumbnailPath: "thumb.png" }, /not an absolute path/],
			["a thumbnail that is not PNG or JPEG", { thumbnailPath: THUMB_GIF }, /not a PNG or JPEG/],
			["a thumbnail over 2 MB", { thumbnailPath: THUMB_TOO_BIG }, /at most 2 MB/],
			["a captions file with the wrong extension", { captionsPath: CAPTIONS_WRONG, captionsLanguage: "en" }, /not a caption file/],
			["an empty captions file", { captionsPath: CAPTIONS_EMPTY, captionsLanguage: "en" }, /1 byte to 100 MB/],
			["a captions file that does not exist", { captionsPath: join(media, "missing.srt"), captionsLanguage: "en" }, /could not be read/],
		])("%s is refused before any request, saying nothing was uploaded", async (_label, params, message) => {
			const failure = await upload(params).then(
				() => "",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);

			expect(failure).toMatch(message);
			expect(failure).toMatch(NOTHING_UPLOADED);
			expect(calls).toEqual([]);
		});

		test("a channel that is not connected is refused before any request", async () => {
			await expect(upload({ channel: "@ghost" })).rejects.toThrow(/No connected channel is "@ghost"/);

			expect(calls).toEqual([]);
		});

		test.each<[string, Record<string, unknown>, "title" | "description" | "tags"]>([
			["a title of exactly 100 characters, counting each emoji as one", { title: "😀".repeat(100) }, "title"],
			["a description of exactly 5000 bytes", { description: "é".repeat(2500) }, "description"],
			["quoted multi-word tags that come to exactly 500", { tags: [quoted(81, 82), quoted(81, 82), quoted(81, 82)] }, "tags"],
			["plain tags whose commas bring them to exactly 500", { tags: ["a".repeat(249), "b".repeat(250)] }, "tags"],
		])("%s is accepted and sent whole", async (_label, params, field) => {
			google();

			await upload(params);

			expect(resourceOf(startCall()).snippet[field]).toEqual(params[field]);
		});
	});

	describe("resource sent", () => {
		test("a bare upload goes out public, with only the fields the caller gave", async () => {
			google();

			await upload({ tags: [] });

			const resource = resourceOf(startCall());
			expect(resource.status).toEqual({ privacyStatus: "public", selfDeclaredMadeForKids: false });
			expect(Object.keys(resource.snippet).sort()).toEqual(["categoryId", "description", "title"]);
			expect(resource.snippet.title).toBe("Film");
		});

		test.each<[string | undefined]>([[undefined], ["private"]])("publishAt with visibility %s uploads private with the time as UTC ISO and reads it back", async visibility => {
			google();

			const result = await upload({ publishAt: FUTURE, ...(visibility ? { visibility } : {}) });

			expect(resourceOf(startCall()).status).toMatchObject({ privacyStatus: "private", publishAt: FUTURE_UTC });
			expect(result.details).toMatchObject({ visibility: "private", publishAt: FUTURE_UTC });
			expect(result.details.readback.find(row => row.field === "publishAt")).toMatchObject({ expected: FUTURE_UTC, ok: true });
		});

		test.each([
			["Science & Technology", "28"],
			["science and technology", "28"],
			["  GAMING ", "20"],
			["Nonprofits and Activism", "29"],
			["27", "27"],
		])("category %j is sent as id %s", async (category, id) => {
			google();

			await upload({ category });

			expect(resourceOf(startCall()).snippet.categoryId).toBe(id);
		});

		test.each<[Record<string, unknown>, Record<string, unknown>]>([
			[{ madeForKids: true, alteredContent: true }, { selfDeclaredMadeForKids: true, containsSyntheticMedia: true }],
			[{ madeForKids: false, alteredContent: false }, { selfDeclaredMadeForKids: false, containsSyntheticMedia: false }],
			[{ madeForKids: true }, { selfDeclaredMadeForKids: true }],
		])("the audience and altered-content answers in %o are sent as %o, and an unanswered question is not invented", async (answers, sent) => {
			google();

			await upload(answers);

			const status = resourceOf(startCall()).status;
			expect(status).toMatchObject(sent);
			expect(Object.keys(status).filter(key => key === "containsSyntheticMedia")).toEqual(Object.keys(sent).filter(key => key === "containsSyntheticMedia"));
		});

		test.each([
			[false, "false"],
			[true, "true"],
		])("notifySubscribers %p reaches the session start as notifySubscribers=%s", async (notifySubscribers, expected) => {
			google();

			await upload({ notifySubscribers });

			expect(startCall().url.searchParams.get("notifySubscribers")).toBe(expected);
		});

		test("description, tags, language, licence and embedding are carried as given", async () => {
			google();
			const description = "Line one\nLine two — with ünïcode and https://example.com";

			await upload({ description, tags: ["unreal engine", "gamedev"], category: "Education", language: "en", license: "creativeCommon", embeddable: false, visibility: "unlisted" });

			expect(resourceOf(startCall())).toEqual({
				snippet: { title: "Film", description, categoryId: "27", tags: ["unreal engine", "gamedev"], defaultLanguage: "en", defaultAudioLanguage: "en" },
				status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false, license: "creativeCommon", embeddable: false },
			});
		});
	});

	describe("after the video exists", () => {
		test("the thumbnail, playlist and captions go to the new video and the readback comes last", async () => {
			google();

			const result = await upload({ thumbnailPath: THUMB, playlistId: "PLabc", captionsPath: CAPTIONS, language: "en", captionsLanguage: "fr" });

			const [thumbnail] = callsTo("/upload/youtube/v3/thumbnails/set");
			expect(thumbnail?.url.searchParams.get("videoId")).toBe(VIDEO_ID);
			expect(thumbnail?.headers.get("content-type")).toBe("image/png");
			expect(thumbnail?.body).toEqual(new Uint8Array(THUMB_BYTES));
			const [playlist] = callsTo("/youtube/v3/playlistItems");
			expect(JSON.parse(String(playlist?.body))).toEqual({ snippet: { playlistId: "PLabc", resourceId: { kind: "youtube#video", videoId: VIDEO_ID } } });
			const [captions] = callsTo("/upload/youtube/v3/captions");
			const type = captions?.headers.get("content-type") ?? "";
			const boundary = /^multipart\/related; boundary=(.+)$/.exec(type)?.[1] ?? "";
			const parts = new TextDecoder().decode(captions?.body as Uint8Array).split(`--${boundary}`);
			expect(boundary).not.toBe("");
			expect(JSON.parse(parts[1]?.split("\r\n\r\n")[1] ?? "")).toMatchObject({ snippet: { videoId: VIDEO_ID, language: "fr" } });
			expect(parts[2]?.split("\r\n\r\n")[1]?.replace(/\r\n$/, "")).toBe(CAPTIONS_TEXT);
			expect(result.details.followUps).toEqual([expect.stringMatching(/^Thumbnail set/), expect.stringMatching(/^Added to playlist PLabc/), expect.stringMatching(/^Captions \(fr\) added/)]);
			expect(calls.at(-1)?.method).toBe("GET");
			expect(calls.at(-1)?.url.pathname).toBe("/youtube/v3/videos");
		});

		test("captions fall back to the video's language when no captionsLanguage is given", async () => {
			google();

			const result = await upload({ captionsPath: CAPTIONS, language: "de" });

			const [captions] = callsTo("/upload/youtube/v3/captions");
			expect(new TextDecoder().decode(captions?.body as Uint8Array)).toContain('"language":"de"');
			expect(result.details.followUps).toEqual([expect.stringMatching(/^Captions \(de\) added/)]);
		});

		test("a thumbnail, playlist and captions step that all fail do not throw, do not stop each other, and never upload the file again", async () => {
			google({
				thumbnail: () => {
					throw new TypeError("fetch failed");
				},
				playlist: () => refusal(404, "Playlist not found"),
				captions: () => refusal(500, "Backend Error"),
			});

			const result = await upload({ thumbnailPath: THUMB, playlistId: "PLmissing", captionsPath: CAPTIONS, language: "en" });

			expect(result.details.videoId).toBe(VIDEO_ID);
			expect(result.details.followUps).toEqual([
				expect.stringMatching(/^Thumbnail NOT set \(.*fetch failed/),
				expect.stringMatching(/^NOT added to playlist PLmissing.*Playlist not found/),
				expect.stringMatching(/^Captions NOT added \(Backend Error\)/),
			]);
			expect(result.details.readback.every(row => row.ok)).toBe(true);
			expect(callsTo("/upload/youtube/v3/videos").filter(call => call.method === "POST").length).toBe(1);
			expect(contentRanges().length).toBe(1);
			expect(result.content[0]?.text).toContain("Thumbnail NOT set");
		});

		test("a thumbnail Google refuses is reported with Google's reason", async () => {
			google({ thumbnail: () => refusal(403, "The authenticated user cannot upload custom video thumbnails") });

			const result = await upload({ thumbnailPath: THUMB });

			expect(result.details.followUps).toEqual([expect.stringMatching(/^Thumbnail NOT set \(The authenticated user cannot upload custom video thumbnails\)/)]);
		});

		test("a readback that finds another title, visibility and audience answer flags each mismatch and reports the real visibility", async () => {
			google({
				listing: video =>
					Response.json({ items: [{ ...video, snippet: { title: "Film (renamed)" }, status: { ...video.status, privacyStatus: "private", selfDeclaredMadeForKids: true } }] }),
			});

			const result = await upload({ madeForKids: false });

			expect(result.details.visibility).toBe("private");
			expect(result.details.readback).toEqual([
				{ field: "title", expected: "Film", actual: "Film (renamed)", ok: false },
				{ field: "visibility", expected: "public", actual: "private", ok: false },
				{ field: "madeForKids", expected: "false", actual: "true", ok: false },
			]);
			expect(result.content[0]?.text).toContain("visibility: MISMATCH, expected public (private)");
		});

		test.each([
			["the same instant written another way", "2099-06-01T10:00:00Z", true],
			["a different instant", "2099-06-01T11:00:00.000Z", false],
		])("a scheduled readback with %s is ok=%p", async (_label, actual, ok) => {
			google({ listing: video => Response.json({ items: [{ ...video, status: { ...video.status, publishAt: actual } }] }) });

			const result = await upload({ publishAt: FUTURE });

			expect(result.details.readback.find(row => row.field === "publishAt")).toMatchObject({ expected: FUTURE_UTC, actual, ok });
		});

		test("a failed readback still returns the video, judged by the upload's own answer", async () => {
			google({ listing: () => refusal(500, "Backend Error") });

			const result = await upload({ visibility: "unlisted" });

			expect(result.details).toMatchObject({ videoId: VIDEO_ID, visibility: "unlisted" });
			expect(result.details.readback.every(row => row.ok)).toBe(true);
		});

		test("a token that expires mid-transfer is renewed once: parts and probes sent after it carry the new token, earlier parts the old one, and so do the follow-ups", async () => {
			const expiring: ChannelSeed = { channelId: channelIdOf("expiring"), title: "Expiring", access: "tok-old", refresh: "ref-expiring", expires: Date.now() + 10 * 60_000 };
			await seedChannel(CONFIG_DIR, expiring);
			const realNow = Date.now.bind(Date);
			let skew = 0;
			const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew);
			try {
				google({
					session: request => {
						if (request.from === 0) skew = 2 * 3_600_000;
						return request.from === CHUNK_BYTES ? { status: 503, kept: "all" } : undefined;
					},
					token: () => Response.json({ access_token: "tok-new", expires_in: 3600 }),
				});

				await upload({ filePath: LARGE.path, channel: expiring.channelId, thumbnailPath: THUMB, playlistId: "PLabc" });
			} finally {
				clock.mockRestore();
			}

			const bearer = (call: Call) => call.headers.get("authorization");
			const followUps = [...callsTo("/upload/youtube/v3/thumbnails/set"), ...callsTo("/youtube/v3/playlistItems"), ...callsTo("/youtube/v3/videos").filter(call => call.method === "GET")];
			expect(bearer(startCall())).toBe("Bearer tok-old");
			expect(contentRanges()).toEqual([`bytes 0-${CHUNK_BYTES - 1}/${LARGE.size}`, `bytes ${CHUNK_BYTES}-${LARGE.size - 1}/${LARGE.size}`, `bytes */${LARGE.size}`]);
			expect(calls.filter(call => call.method === "PUT").map(bearer)).toEqual(["Bearer tok-old", "Bearer tok-new", "Bearer tok-new"]);
			expect(followUps.length).toBe(3);
			expect(followUps.map(bearer)).toEqual(followUps.map(() => "Bearer tok-new"));
			const renewals = calls.filter(call => call.url.href === "https://oauth2.googleapis.com/token");
			expect(renewals.length).toBe(1);
			expect(new URLSearchParams(String(renewals[0]?.body)).get("refresh_token")).toBe("ref-expiring");
		});
	});
});
