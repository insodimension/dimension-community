import { afterEach, expect, test } from "bun:test";
import hackerNewsExtension from "../index";

type Tool = {
	name: string;
	approval?: unknown;
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};

const tools = new Map<string, Tool>();
hackerNewsExtension({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never);

const realFetch = globalThis.fetch;
const requested: URL[] = [];
afterEach(() => {
	globalThis.fetch = realFetch;
	requested.length = 0;
});

function serve(routes: Record<string, unknown>): void {
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		requested.push(url);
		const key = `${url.host}${url.pathname}`;
		if (!(key in routes)) throw new Error(`unexpected request ${url}`);
		const body = routes[key];
		return Response.json(typeof body === "function" ? (body as (u: URL) => unknown)(url) : body);
	}) as typeof fetch;
}

async function run(name: string, params: Record<string, unknown>): Promise<string> {
	const tool = tools.get(name);
	if (!tool) throw new Error(`no tool ${name}`);
	return (await tool.execute("t", params)).content[0]?.text ?? "";
}

const now = Math.floor(Date.now() / 1000);

function algoliaPages(all: { created_at_i: number }[]): (url: URL) => unknown {
	const newestFirst = [...all].sort((a, b) => b.created_at_i - a.created_at_i);
	return url => {
		const floor = Number(/created_at_i>(-?\d+)/.exec(url.searchParams.get("numericFilters") ?? "")?.[1] ?? Number.NEGATIVE_INFINITY);
		const matching = newestFirst.filter(hit => hit.created_at_i > floor);
		const size = Number(url.searchParams.get("hitsPerPage"));
		const page = Number(url.searchParams.get("page") ?? "0");
		return {
			hits: matching.slice(page * size, (page + 1) * size),
			nbHits: matching.length,
			page,
			nbPages: Math.ceil(matching.length / size),
		};
	};
}

test("every tool is a keyless read", () => {
	expect([...tools.keys()].sort()).toEqual([
		"hn_domain",
		"hn_front",
		"hn_item",
		"hn_search",
		"hn_thread_since",
		"hn_user",
	]);
	for (const tool of tools.values()) expect(tool.approval).toBe("read");
});

test("a search quotes each word so Algolia does not fuzz it, and says when the window is past Algolia's cap", async () => {
	serve({
		"hn.algolia.com/api/v1/search": {
			hits: [
				{
					objectID: "1",
					title: "Unreal camera rig",
					url: "https://www.example.com/a",
					author: "ana",
					points: 42,
					num_comments: 7,
					created_at_i: 1_700_000_000,
				},
			],
			nbHits: 5400,
			page: 0,
			nbPages: 50,
		},
	});

	const text = await run("hn_search", { query: "unreal camera -unity", since: "2026-01-01", minPoints: 10 });

	const sent = requested[0];
	expect(sent?.searchParams.get("query")).toBe('"unreal" "camera" -unity');
	expect(sent?.searchParams.get("tags")).toBe("story");
	expect(sent?.searchParams.get("numericFilters")).toBe(
		`created_at_i>=${Date.parse("2026-01-01T00:00:00Z") / 1000},points>=10`,
	);
	expect(text).toContain("1  42p  7c  2023-11-14  ana  Unreal camera rig (example.com)");
	expect(text).toContain("split the window with since/until");
});

test("an item's top-level comments follow HN's rank, deleted comments drop out and dead items are flagged", async () => {
	serve({
		"hacker-news.firebaseio.com/v0/item/100.json": {
			id: 100,
			type: "story",
			by: "maker",
			time: 1_700_000_000,
			title: "Show HN: Thing",
			score: 12,
			descendants: 3,
			kids: [102, 101],
			dead: true,
		},
		"hn.algolia.com/api/v1/items/100": {
			id: 100,
			author: "maker",
			text: null,
			created_at_i: 1_700_000_000,
			children: [
				{ id: 101, author: "early", text: "<p>first &amp; oldest</p>", created_at_i: 1_700_000_100, children: [] },
				{
					id: 102,
					author: "ranked",
					text: "best &#x27;comment&#x27;",
					created_at_i: 1_700_000_200,
					children: [{ id: 104, author: "reply", text: "agreed", created_at_i: 1_700_000_300, children: [] }],
				},
				{ id: 103, author: null, text: null, created_at_i: 1_700_000_400, children: [] },
			],
		},
	});

	const text = await run("hn_item", { item: "https://news.ycombinator.com/item?id=100" });

	expect(text).toContain("story 100 by maker  12 points  3 comments");
	expect(text).toContain("[dead]");
	const comments = text.split("Comments:\n")[1]?.split("\n") ?? [];
	expect(comments.map(line => line.trim().split(" ")[0])).toEqual(["102", "104", "101"]);
	expect(comments[0]).toContain("best 'comment'");
	expect(comments[1]?.startsWith("  104")).toBe(true);
	expect(text).not.toContain("103");
});

test("a user preflight counts only the Show HNs from the last year", async () => {
	serve({
		"hacker-news.firebaseio.com/v0/user/ana.json": {
			id: "ana",
			created: now - 400 * 86_400,
			karma: 1234,
			about: "builds <i>tools</i>",
		},
		"hn.algolia.com/api/v1/search": (url: URL) => ({
			hits: [],
			nbHits: url.searchParams.get("tags")?.startsWith("story") ? 9 : 120,
			page: 0,
			nbPages: 0,
		}),
		"hn.algolia.com/api/v1/search_by_date": {
			hits: [
				{
					objectID: "7",
					title: "Show HN: New",
					points: 80,
					num_comments: 20,
					author: "ana",
					created_at_i: now - 30 * 86_400,
				},
				{
					objectID: "6",
					title: "Show HN: Old",
					points: 3,
					num_comments: 0,
					author: "ana",
					created_at_i: now - 380 * 86_400,
				},
			],
			nbHits: 2,
			page: 0,
			nbPages: 1,
		},
	});

	const text = await run("hn_user", { username: "ana" });

	expect(text).toContain("ana  karma 1,234");
	expect(text).toContain("(400 days ago)");
	expect(text).toContain("Stories: 9  Comments: 120  Show HN: 2 (1 in the last 365 days)");
	expect(text).toContain("Show HN: New");
	expect(text).not.toContain("Show HN: Old");
	expect(text).toContain("About: builds tools");
});

test("the front page reports where an item ranks even below the rows shown", async () => {
	const ids = Array.from({ length: 200 }, (_, index) => 1000 + index);
	const routes: Record<string, unknown> = { "hacker-news.firebaseio.com/v0/showstories.json": ids };
	for (const id of ids.slice(0, 2))
		routes[`hacker-news.firebaseio.com/v0/item/${id}.json`] = {
			id,
			title: `Story ${id}`,
			score: 5,
			descendants: 1,
			by: "x",
			time: now - 3600,
			url: "https://a.dev/",
		};
	serve(routes);

	const text = await run("hn_front", { list: "show", limit: 2, find: 1150 });

	expect(text).toContain("Item 1150 is #151 of 200 on show.");
	expect(text).toContain("1. 1000  5p  1c  1h  x  Story 1000 (a.dev)");
	expect(text).toContain("2. 1001");
	expect(requested.filter(url => url.pathname.startsWith("/v0/item/"))).toHaveLength(2);
});

test("a domain check keeps the domain and its subdomains, never a look-alike, and a URL matches its one page", async () => {
	const hits = [
		{
			objectID: "1",
			title: "Docs",
			url: "https://docs.example.com/start",
			points: 50,
			num_comments: 4,
			author: "a",
			created_at_i: 1_700_000_000,
		},
		{
			objectID: "2",
			title: "Home",
			url: "https://www.example.com/",
			points: 9,
			num_comments: 0,
			author: "b",
			created_at_i: 1_690_000_000,
		},
		{
			objectID: "3",
			title: "Look-alike",
			url: "https://notexample.com/",
			points: 900,
			num_comments: 0,
			author: "c",
			created_at_i: 1_680_000_000,
		},
	];
	serve({ "hn.algolia.com/api/v1/search_by_date": { hits, nbHits: 3, page: 0, nbPages: 1 } });

	const domain = await run("hn_domain", { target: "example.com" });
	expect(domain).toContain("2 stories for example.com on this page; best 50 points.");
	expect(domain).not.toContain("Look-alike");
	expect(requested[0]?.searchParams.get("restrictSearchableAttributes")).toBe("url");

	const page = await run("hn_domain", { target: "https://docs.example.com/start/" });
	expect(page).toContain("1 stories for docs.example.com/start");
	expect(page).not.toContain("Home");
});

test("a launch watch returns comments after the cursor oldest first, the story's rank, and the next cursor", async () => {
	serve({
		"hacker-news.firebaseio.com/v0/item/500.json": {
			id: 500,
			title: "Show HN: Launch",
			score: 33,
			descendants: 12,
			time: now - 7200,
		},
		"hacker-news.firebaseio.com/v0/topstories.json": [9, 8, 500],
		"hacker-news.firebaseio.com/v0/showstories.json": [500],
		"hn.algolia.com/api/v1/search_by_date": {
			hits: [
				{
					objectID: "511",
					author: "late",
					comment_text: "how does it scale?",
					parent_id: 510,
					story_id: 500,
					created_at_i: now - 60,
				},
				{
					objectID: "510",
					author: "early",
					comment_text: "nice",
					parent_id: 500,
					story_id: 500,
					created_at_i: now - 600,
				},
			],
			nbHits: 2,
			page: 0,
			nbPages: 1,
		},
	});

	const text = await run("hn_thread_since", { story: 500, since: now - 3600 });

	const search = requested.find(url => url.pathname.endsWith("/search_by_date"));
	expect(search?.searchParams.get("tags")).toBe("comment,story_500");
	expect(search?.searchParams.get("numericFilters")).toBe(`created_at_i>${now - 3600 - 120}`);
	expect(text).toContain("33 points  12 comments  2h old  #3 on top, #1 on show");
	expect(text.indexOf("510  early")).toBeLessThan(text.indexOf("511  late"));
	expect(text).toContain("on the story: nice");
	expect(text).toContain("reply to 510: how does it scale?");
	expect(text).toContain(`Cursor: ${now - 60}:511`);
});

test("a launch watch with more new comments than the limit returns the oldest ones, so the next call skips none", async () => {
	serve({
		"hacker-news.firebaseio.com/v0/item/600.json": {
			id: 600,
			title: "Busy",
			score: 300,
			descendants: 90,
			time: now - 7200,
		},
		"hacker-news.firebaseio.com/v0/topstories.json": [600],
		"hacker-news.firebaseio.com/v0/showstories.json": [],
		"hn.algolia.com/api/v1/search_by_date": algoliaPages(
			[3, 2, 1].map(n => ({
				objectID: `60${n}`,
				author: `u${n}`,
				comment_text: `c${n}`,
				parent_id: 600,
				story_id: 600,
				created_at_i: now - 100 + n,
			})),
		),
	});

	const text = await run("hn_thread_since", { story: 600, since: now - 1000, limit: 2 });

	expect(text).toContain("601  u1");
	expect(text).toContain("602  u2");
	expect(text).not.toContain("603  u3");
	expect(text).toContain("(1 newer not shown)");
	expect(text).toContain(`Cursor: ${now - 98}:602,601 (call again with it for the next comments)`);
	expect(requested.every(url => !url.pathname.endsWith("/search_by_date") || Number(url.searchParams.get("hitsPerPage")) <= 2)).toBe(true);
});

test("the next poll catches a comment indexed after the cursor passed its time, and never repeats one already shown", async () => {
	const comment = (objectID: string, created_at_i: number) => ({
		objectID,
		author: `u${objectID}`,
		comment_text: `c${objectID}`,
		parent_id: 700,
		story_id: 700,
		created_at_i,
	});
	const cursorTime = now - 300;
	serve({
		"hacker-news.firebaseio.com/v0/item/700.json": { id: 700, title: "Watch", score: 5, descendants: 4, time: now - 7200 },
		"hacker-news.firebaseio.com/v0/topstories.json": [],
		"hacker-news.firebaseio.com/v0/showstories.json": [],
		"hn.algolia.com/api/v1/search_by_date": algoliaPages([
			comment("701", cursorTime - 10),
			comment("702", cursorTime),
			comment("703", cursorTime - 40),
			comment("704", cursorTime + 10),
		]),
	});

	const text = await run("hn_thread_since", { story: 700, since: `${cursorTime}:701,702` });

	expect(text).toContain("703  u703");
	expect(text).toContain("704  u704");
	expect(text).not.toContain("701  u701");
	expect(text).not.toContain("702  u702");
	const next = /Cursor: (\S+)/.exec(text)?.[1] ?? "";
	requested.length = 0;
	const again = await run("hn_thread_since", { story: 700, since: next });
	expect(again).not.toMatch(/70[1-4] {2}u/);
});
