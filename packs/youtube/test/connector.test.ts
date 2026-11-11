import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { googleError, isQuotaRefusal, videoIdOf } from "../api";
import youtubeExtension, { commentRefusal } from "../index";
import { channelIdOf, seedChannel } from "./channel-fixture";

const home = await mkdtemp(join(tmpdir(), "dimension-youtube-"));
const configDir = join(home, ".config", "dimension-youtube");
await seedChannel(configDir, { channelId: channelIdOf("main"), title: "Main", access: "a", refresh: "r" });
const priorHome = process.env.HOME;
const priorUserProfile = process.env.USERPROFILE;

beforeAll(() => {
	process.env.HOME = home;
	process.env.USERPROFILE = home;
});

interface Tool {
	name: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
}

const tools = new Map<string, Tool>();
youtubeExtension({ registerTool: (tool: Tool) => tools.set(tool.name, tool), on: () => undefined } as never);

function tool(name: string): Tool {
	const found = tools.get(name);
	if (!found) throw new Error(`youtube did not register ${name}`);
	return found;
}

const realFetch = globalThis.fetch;
let requested: URL[] = [];
let posted = 0;

function stub(captions: object[] = []): void {
	requested = [];
	posted = 0;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		requested.push(url);
		if (init?.method === "POST") {
			posted += 1;
			return Response.json({ id: `c-${posted}`, snippet: { topLevelComment: { id: `c-${posted}` } } });
		}
		if (url.pathname.endsWith("/captions")) return Response.json({ items: captions });
		if (url.pathname.endsWith("/videos")) {
			return Response.json({
				items: (url.searchParams.get("id") ?? "")
					.split(",")
					.filter(id => id !== "gone0000000")
					.map(id => ({
						id,
						snippet: { title: `video ${id}`, publishedAt: "2026-11-01T00:00:00Z" },
						statistics: { viewCount: "10", likeCount: "2", commentCount: "1" },
						contentDetails: { duration: "PT1M5S" },
						status: { privacyStatus: "unlisted", containsSyntheticMedia: true },
					})),
			});
		}
		if (url.pathname.endsWith("/channels")) {
			return Response.json({ items: [{ id: "UCabc", snippet: { title: "Dimension" }, statistics: { subscriberCount: "5" } }] });
		}
		throw new Error(`unexpected ${url.pathname}`);
	}) as typeof fetch;
}

function refuse(status: number, body: unknown, statusText = ""): void {
	requested = [];
	globalThis.fetch = (async (input: string | URL | Request) => {
		requested.push(new URL(String(input)));
		return Response.json(body, { status, statusText });
	}) as typeof fetch;
}

async function failureText(work: Promise<unknown>): Promise<string> {
	return work.then(
		() => "the call did not fail",
		(error: Error) => error.message,
	);
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

afterAll(async () => {
	if (priorHome === undefined) delete process.env.HOME;
	else process.env.HOME = priorHome;
	if (priorUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = priorUserProfile;
	await rm(home, { recursive: true, force: true });
});

test("watch, short and youtu.be URLs all yield the video id", () => {
	expect(videoIdOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3")).toBe("dQw4w9WgXcQ");
	expect(videoIdOf("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
	expect(videoIdOf("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
	expect(videoIdOf(" dQw4w9WgXcQ ")).toBe("dQw4w9WgXcQ");
});

test("several videos are read in one call, one line each with privacy and the synthetic flag, and missing ids are named", async () => {
	stub();
	const result = await tool("youtube_get_videos").execute("t", {
		videoIds: ["aaaaaaaaaaa", "https://youtu.be/bbbbbbbbbbb", "gone0000000", "aaaaaaaaaaa"],
	});
	const text = result.content[0]?.text ?? "";
	expect(requested).toHaveLength(1);
	expect(requested[0]?.searchParams.get("id")).toBe("aaaaaaaaaaa,bbbbbbbbbbb,gone0000000");
	expect(requested[0]?.searchParams.get("part")).toContain("status");
	expect(text).toContain("aaaaaaaaaaa  video aaaaaaaaaaa  2026-11-01  1:05  Views: 10");
	expect(text).toContain("[unlisted, altered or synthetic]");
	expect(text).toContain("Not found or not visible: gone0000000");
	expect(text).toMatch(/Public counts read \d{4}-\d{2}-\d{2}T/);
});

test("more than fifty ids are refused before any request", async () => {
	stub();
	const ids = Array.from({ length: 51 }, (_, index) => `v${String(index).padStart(10, "0")}`);
	await expect(tool("youtube_get_videos").execute("t", { videoIds: ids })).rejects.toThrow("at most 50");
	expect(requested).toHaveLength(0);
});

test("a channel is read by handle, with its uploads playlist", async () => {
	stub();
	const result = await tool("youtube_channel_stats").execute("t", { handle: "dimension" });
	expect(requested[0]?.searchParams.get("forHandle")).toBe("@dimension");
	expect(result.content[0]?.text).toContain("Uploads playlist: UUabc");
});

test("the comment cap and the duplicate check refuse before posting, and a posted comment is remembered", async () => {
	stub();
	await tool("youtube_post_comment").execute("t", { videoId: "aaaaaaaaaaa", text: "The renderer caps at 30 seconds, see the docs." });
	expect(posted).toBe(1);
	const ledger = JSON.parse(await readFile(join(configDir, "comment-ledger.json"), "utf-8"));
	expect(ledger).toHaveLength(1);

	await expect(
		tool("youtube_post_comment").execute("t", { videoId: "bbbbbbbbbbb", text: "the renderer caps at 30 seconds — see the docs!" }),
	).rejects.toThrow("repeats a comment");
	expect(posted).toBe(1);
});

test("the daily cap counts only today's comments", () => {
	const now = new Date("2026-11-06T12:00:00Z");
	const today = Array.from({ length: 5 }, (_, index) => ({ at: "2026-11-06T01:00:00Z", target: "video v", text: `distinct answer number ${index} about topic ${index * 7}` }));
	expect(commentRefusal(today, "a fresh and different reply", now)).toContain("daily cap is 5");
	const yesterday = today.map(entry => ({ ...entry, at: "2026-11-05T01:00:00Z" }));
	expect(commentRefusal(yesterday, "a fresh and different reply", now)).toBeUndefined();
});

const QUOTA_PAGE = "https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas";

function refusal(message: string, ...reasons: string[]): object {
	return { error: { code: 403, message, errors: reasons.map(reason => ({ message, domain: "youtube.quota", reason })) } };
}

test.each([
	["quotaExceeded", "Forbidden"],
	["dailyLimitExceeded", "Daily Limit Exceeded"],
	["rateLimitExceeded", "Rate Limit Exceeded"],
])("a %s refusal keeps Google's message and adds both causes, the quota page and the ways out", (reason, message) => {
	const payload = refusal(message, reason);

	const text = googleError(payload, "fallback");

	expect(isQuotaRefusal(payload)).toBe(true);
	expect(text.startsWith(`${message} `)).toBe(true);
	expect(text).toContain("10,000 units");
	expect(text).toContain("midnight Pacific");
	expect(text).toContain('"Queries per day"');
	expect(text).toContain("is 0 and never refills");
	expect(text).toContain("connecting again cannot fix it");
	expect(text).toContain(QUOTA_PAGE);
	expect(text).toContain("new Google Cloud project");
	expect(text).toContain("API compliance audit form");
});

test.each([
	"The request cannot be completed because you have exceeded your quota.",
	"Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'youtube.googleapis.com'",
	"The project is over its Quota.",
])("the word quota in the message alone, with no error reason, is a quota refusal: %s", message => {
	const payload = { error: { message } };

	const text = googleError(payload, "fallback");

	expect(isQuotaRefusal(payload)).toBe(true);
	expect(text.startsWith(`${message} `)).toBe(true);
	expect(text).toContain(QUOTA_PAGE);
});

test.each([
	["insufficientPermissions", "Insufficient Permission"],
	["videoNotFound", "The video that you are trying to rate cannot be found."],
	["forbidden", "The caller does not have permission"],
])("a %s refusal is Google's message and nothing more", (reason, message) => {
	const payload = refusal(message, reason);

	expect(isQuotaRefusal(payload)).toBe(false);
	expect(googleError(payload, "fallback")).toBe(message);
});

test.each(["The quotaUser parameter is invalid", "Too many quotations in one request"])(
	"a message that only contains letters of the word quota is not a quota refusal: %s",
	message => {
		expect(isQuotaRefusal({ error: { message } })).toBe(false);
		expect(googleError({ error: { message } }, "fallback")).toBe(message);
	},
);

test.each([
	["null", null],
	["undefined", undefined],
	["a string that says quota", "quota exceeded"],
	["a number", 403],
	["an object with no error", {}],
	["an error that is a string", { error: "quotaExceeded" }],
	["an error with no message", { error: { errors: [{ reason: "quotaExceeded" }] } }],
	["an empty message beside a quota reason", { error: { message: "", errors: [{ reason: "quotaExceeded" }] } }],
	["a message that is not text", { error: { message: 403 } }],
])("%s has no message to give, so googleError returns the fallback", (_label, payload) => {
	expect(googleError(payload, "fallback text")).toBe("fallback text");
});

test.each([
	["null", null],
	["a string that says quota", "quota exceeded"],
	["an error that is a string", { error: "quotaExceeded" }],
	["errors that is not a list", { error: { message: "Denied", errors: { reason: "quotaExceeded" } } }],
	["entries that are not objects", { error: { message: "Denied", errors: [null, 5, "quotaExceeded"] } }],
	["entries with a reason that is not a quota reason", { error: { message: "Denied", errors: [{ reason: 7 }, {}, { reason: "quotaExceededSoon" }] } }],
])("isQuotaRefusal is false for %s", (_label, payload) => {
	expect(isQuotaRefusal(payload)).toBe(false);
});

test("the caption track list names each track, and its closing note says the tool returns no caption text and points to the watch pack", async () => {
	stub([
		{ id: "cap-en", snippet: { language: "en", name: "English", trackKind: "standard" } },
		{ id: "cap-de", snippet: { language: "de", name: "", trackKind: "ASR", isAutoSynced: true } },
	]);

	const text = (await tool("youtube_get_captions").execute("t", { videoId: "dQw4w9WgXcQ" })).content[0]?.text ?? "";

	expect(requested).toHaveLength(1);
	expect(requested[0]?.pathname).toBe("/youtube/v3/captions");
	expect(requested[0]?.searchParams.get("videoId")).toBe("dQw4w9WgXcQ");
	const [tracks, note] = text.split("\n\n");
	expect(tracks?.split("\n")).toEqual(["[cap-en] en  English  standard", "[cap-de] de  (default)  ASR  [auto-synced]"]);
	expect(note).toContain("does not return their text");
	expect(note).toContain("watch pack");
	expect(text).not.toMatch(/only for videos/i);
	expect(text).not.toMatch(/this account owns/i);
});

const READ_TOOLS: [tool: string, params: Record<string, unknown>, op: string][] = [
	["youtube_get_videos", { videoIds: ["aaaaaaaaaaa"] }, "videos.list"],
	["youtube_search", { query: "dimension" }, "search.list"],
	["youtube_get_captions", { videoId: "dQw4w9WgXcQ" }, "captions.list"],
];

test.each(READ_TOOLS)("%s: a quota refusal is YouTube's message followed by both causes and the quota page", async (name, params, op) => {
	const message = "The request cannot be completed because you have exceeded your quota.";
	refuse(403, refusal(message, "quotaExceeded"), "Forbidden");

	const failure = await failureText(tool(name).execute("t", params));

	expect(requested).toHaveLength(1);
	expect(failure.startsWith(`YouTube ${op} failed: ${message} `)).toBe(true);
	expect(failure).toContain("is 0 and never refills");
	expect(failure).toContain(QUOTA_PAGE);
});

test.each(READ_TOOLS)("%s: a refusal that is not about quota keeps Google's message exactly, with no hint", async (name, params, op) => {
	refuse(403, refusal("The caller does not have permission", "forbidden"), "Forbidden");

	const failure = await failureText(tool(name).execute("t", params));

	expect(failure).toBe(`YouTube ${op} failed: The caller does not have permission`);
});

test.each(READ_TOOLS)("%s: a refusal with an empty message falls back to the HTTP status text", async (name, params, op) => {
	refuse(403, { error: { message: "" } }, "Forbidden");

	const failure = await failureText(tool(name).execute("t", params));

	expect(failure).toBe(`YouTube ${op} failed: Forbidden`);
});
