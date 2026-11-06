import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = await mkdtemp(join(tmpdir(), "dimension-youtube-"));
const configDir = join(home, ".config", "dimension-youtube");
await mkdir(configDir, { recursive: true });
await writeFile(
	join(configDir, "token.json"),
	JSON.stringify({ access: "a", refresh: "r", expires: Date.now() + 3_600_000, clientId: "c" }),
);
const priorHome = process.env.HOME;
const priorUserProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
// Dynamic with a query, so this file gets its own module instance even when another test file loaded the pack first: the pack resolves its token and ledger paths from homedir() at module load, after HOME is swapped.
const { default: youtubeExtension, commentRefusal, videoIdOf } = await import("../index.ts?youtube-connector");
if (priorHome === undefined) delete process.env.HOME;
else process.env.HOME = priorHome;
if (priorUserProfile === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = priorUserProfile;

interface Tool {
	name: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
}

const tools = new Map<string, Tool>();
youtubeExtension({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never);

function tool(name: string): Tool {
	const found = tools.get(name);
	if (!found) throw new Error(`youtube did not register ${name}`);
	return found;
}

const realFetch = globalThis.fetch;
let requested: URL[] = [];
let posted = 0;

function stub(): void {
	requested = [];
	posted = 0;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		requested.push(url);
		if (init?.method === "POST") {
			posted += 1;
			return Response.json({ id: `c-${posted}`, snippet: { topLevelComment: { id: `c-${posted}` } } });
		}
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

afterEach(() => {
	globalThis.fetch = realFetch;
});

afterAll(async () => {
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
