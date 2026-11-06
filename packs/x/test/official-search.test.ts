import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV = ["HOME", "USERPROFILE"] as const;
const prior = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
const realFetch = globalThis.fetch;
const requested: URL[] = [];
let home = "";
type Tool = {
	name: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};
const tools = new Map<string, Tool>();

beforeAll(async () => {
	home = await mkdtemp(join(tmpdir(), "x-official-"));
	await mkdir(join(home, ".config", "dimension-x"), { recursive: true });
	await writeFile(
		join(home, ".config", "dimension-x", "token.json"),
		JSON.stringify({ access: "a", refresh: "r", expires: Date.now() + 3_600_000, clientId: "c" }),
	);
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		requested.push(url);
		const count = Number(url.searchParams.get("max_results"));
		const data = Array.from({ length: count }, (_, index) => ({
			id: String(1900000000000000000n + BigInt(index)),
			text: `post ${index}`,
			author_id: "1",
			created_at: "2026-11-05T10:00:00.000Z",
			public_metrics: { like_count: 1, retweet_count: 0, reply_count: 0, quote_count: 0 },
		}));
		return Response.json({ data, includes: { users: [{ id: "1", username: "dev" }] } });
	}) as typeof fetch;
	const mod = await import("../index.ts?official-search");
	mod.default({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never);
	for (const name of ENV) {
		if (prior[name] === undefined) delete process.env[name];
		else process.env[name] = prior[name];
	}
});

afterAll(async () => {
	globalThis.fetch = realFetch;
	await rm(home, { recursive: true, force: true });
});

test("a search asks X for at least its minimum of ten posts and returns only the count asked for", async () => {
	const result = await tools.get("x_search")?.execute("t", { query: "unreal camera", limit: 5 });

	const search = requested.find(url => url.pathname.endsWith("/tweets/search/recent"));
	expect(Number(search?.searchParams.get("max_results"))).toBeGreaterThanOrEqual(10);
	const rows = (result?.content[0]?.text ?? "").split("\n").filter(line => /^\d{19}\s/.test(line));
	expect(rows).toHaveLength(5);
	const billed = Number(search?.searchParams.get("max_results"));
	expect(result?.content[0]?.text).toContain(`$${(billed * 0.005).toFixed(3)}`);
});

test("web search spellings reach the API in its own operators, the day operators as the window, and the output names the query sent", async () => {
	requested.length = 0;
	const result = await tools.get("x_search")?.execute("t", {
		query: "unreal camera min_faves:10 min_retweets:2 -filter:replies filter:links since:2026-11-01 until:2026-11-03",
		limit: 5,
	});

	const search = requested.find(url => url.pathname.endsWith("/tweets/search/recent"));
	expect(search?.searchParams.get("query")).toBe("unreal camera min_likes:10 min_reposts:2 -is:reply has:links");
	expect(search?.searchParams.get("start_time")).toBe("2026-11-01T00:00:00Z");
	expect(search?.searchParams.get("end_time")).toBe("2026-11-03T00:00:00.000Z");
	expect(result?.content[0]?.text).toContain("query sent: unreal camera min_likes:10 min_reposts:2 -is:reply has:links");
});

test("the window passed as parameters wins over a day operator left in the query", async () => {
	requested.length = 0;
	await tools.get("x_search")?.execute("t", { query: "camera since:2026-11-01", since: "2026-11-04", limit: 5 });

	const search = requested.find(url => url.pathname.endsWith("/tweets/search/recent"));
	expect(search?.searchParams.get("query")).toBe("camera");
	expect(search?.searchParams.get("start_time")).toBe("2026-11-04T00:00:00Z");
});
