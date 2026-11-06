import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
	collectEnvelope,
	type EnvelopeRequest,
	type SearchPageFn,
	type SearchWindow,
	writeEnvelope,
} from "../x-envelope";
import type { XReadPost, XSearchPage, XSearchSort } from "../x-reads";

const NOW = new Date("2026-11-06T15:30:00Z");

interface SearchCall {
	readonly query: string;
	readonly limit: number;
	readonly sort: XSearchSort;
	readonly window: SearchWindow;
}

function post(id: string, author: string, extra: Partial<XReadPost> = {}): XReadPost {
	return {
		id,
		text: `post ${id}`,
		authorUsername: author,
		createdAt: "2026-11-05T10:00:00.000Z",
		likeCount: 4,
		retweetCount: 2,
		replyCount: 1,
		quoteCount: 1,
		...extra,
	};
}

function recordingSearch(pages: (call: SearchCall) => XSearchPage | Error): {
	search: SearchPageFn;
	calls: SearchCall[];
} {
	const calls: SearchCall[] = [];
	return {
		calls,
		search: async (query, limit, sort, window) => {
			const call = { query, limit, sort, window };
			calls.push(call);
			const page = pages(call);
			if (page instanceof Error) throw page;
			return page;
		},
	};
}

const REQUEST: EnvelopeRequest = {
	topic: "unreal engine camera plugin",
	queries: ["unreal engine camera plugin"],
	depth: "default",
	handles: [],
	related: [],
	days: 30,
};

test("the topic call merges the newest posts with one top-ranked page per day of the searchable week", async () => {
	const { search, calls } = recordingSearch(call =>
		call.sort === "recent"
			? { backend: "bird", posts: [post("100", "alice"), post("101", "bob")] }
			: {
					backend: "bird",
					posts: [post("101", "bob"), post(`2${call.window.since?.slice(8)}`, `day${call.window.since}`)],
				},
	);

	const { envelope } = await collectEnvelope(REQUEST, search, NOW);

	expect(calls[0]).toEqual({
		query: "unreal engine camera plugin -is:retweet",
		limit: 30,
		sort: "recent",
		window: {},
	});
	const popular = calls.filter(call => call.sort === "top");
	expect(popular).toHaveLength(7);
	expect(popular[0]?.window).toEqual({ since: "2026-11-06", until: "2026-11-07" });
	expect(popular[6]?.window).toEqual({ since: "2026-10-31", until: "2026-11-01" });
	expect(envelope.calls).toHaveLength(1);
	expect(envelope.calls[0]?.lane).toBe("topic");
	expect(envelope.calls[0]?.posts.map(row => row.id)).toEqual([
		"100",
		"101",
		"206",
		"205",
		"204",
		"203",
		"202",
		"201",
		"231",
	]);
	expect(envelope).toMatchObject({
		schema: "last30days-x-posts/1",
		generated_at: NOW.toISOString(),
		topic: REQUEST.topic,
		window: { from: "2026-10-07", to: "2026-11-06" },
		provider: "x-connector",
		status: "ok",
	});
});

test("a row carries exactly the eight envelope fields and drops posts the engine cannot cite", async () => {
	const { search } = recordingSearch(call =>
		call.sort === "recent"
			? {
					backend: "bird",
					posts: [
						post("300", "dana"),
						post("301", "", { authorUsername: undefined }),
						post("x302", "erin"),
						post("303", "fay", { text: "  " }),
					],
				}
			: { backend: "bird", posts: [] },
	);

	const { envelope } = await collectEnvelope({ ...REQUEST, depth: "quick" }, search, NOW);

	expect(envelope.calls[0]?.posts).toEqual([
		{
			id: "300",
			author_handle: "dana",
			created_at: "2026-11-05T10:00:00.000Z",
			text: "post 300",
			likes: 4,
			reposts: 2,
			replies: 1,
			quotes: 1,
		},
	]);
});

test("named accounts get from and mention calls; frequent topic authors are discovered and scoped to the topic", async () => {
	const { search, calls } = recordingSearch(call =>
		call.query.endsWith("plugin -is:retweet") && call.sort === "recent"
			? {
					backend: "bird",
					posts: [
						post("400", "gus"),
						post("401", "gus"),
						post("402", "hana"),
						post("403", "Epic"),
						post("404", "epic"),
					],
				}
			: { backend: "bird", posts: [] },
	);

	const result = await collectEnvelope(
		{ ...REQUEST, depth: "quick", handles: ["epic"], related: ["unrealengine"] },
		search,
		NOW,
	);

	expect(result.discovered).toEqual(["gus"]);
	expect(result.envelope.calls.map(call => [call.lane, call.handles])).toEqual([
		["topic", []],
		["from", ["epic"]],
		["mention", ["epic"]],
		["related", ["unrealengine"]],
		["from", ["gus"]],
		["mention", ["gus"]],
	]);
	expect(calls.map(call => call.query)).toContain("from:gus unreal engine camera plugin -is:retweet");
	expect(calls.map(call => call.query)).toContain("@epic -is:retweet");
});

test("a failure after some posts marks the envelope partial; a failure before any post is thrown", async () => {
	const partial = recordingSearch(call =>
		call.sort === "recent" ? { backend: "bird", posts: [post("500", "ivy")] } : new Error("rate limited"),
	);
	const { envelope } = await collectEnvelope(REQUEST, partial.search, NOW);
	expect(envelope.status).toBe("partial");
	expect(envelope.error).toBe("unavailable");

	const dead = recordingSearch(() => new Error("cookies expired"));
	await expect(collectEnvelope(REQUEST, dead.search, NOW)).rejects.toThrow("cookies expired");
});

test("posts served by the billed lane are counted so the cost can be stated", async () => {
	const { search } = recordingSearch(call =>
		call.sort === "recent"
			? { backend: "official", posts: [post("600", "jo"), post("601", "kai")] }
			: { backend: "bird", posts: [post("602", "lee")] },
	);

	const { paidPosts } = await collectEnvelope({ ...REQUEST, depth: "quick" }, search, NOW);

	expect(paidPosts).toBe(2);
});

test("the envelope never exceeds the engine's twenty-call limit", async () => {
	const handles = Array.from({ length: 12 }, (_, index) => `acct${index}`);
	const { search } = recordingSearch(() => ({ backend: "bird", posts: [post("700", "mo"), post("701", "mo")] }));

	const { envelope, discovered } = await collectEnvelope({ ...REQUEST, handles }, search, NOW);

	expect(envelope.calls.length).toBeLessThanOrEqual(20);
	expect(discovered).toEqual([]);
});

test("the written file is the compact envelope", async () => {
	const { search } = recordingSearch(() => ({ backend: "bird", posts: [post("800", "nia")] }));
	const { envelope } = await collectEnvelope({ ...REQUEST, depth: "quick" }, search, NOW);

	const path = await writeEnvelope(envelope);
	try {
		const text = await readFile(path, "utf-8");
		expect(text.includes("\n")).toBe(false);
		expect(JSON.parse(text)).toEqual(envelope);
	} finally {
		await rm(dirname(path), { recursive: true, force: true });
	}
});
