import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV = ["HOME", "USERPROFILE", "INSO_X_READ_BACKEND", "BIRD_DISABLE_BROWSER_COOKIES"] as const;
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
	process.env.INSO_X_READ_BACKEND = "official";
	process.env.BIRD_DISABLE_BROWSER_COOKIES = "1";
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
	const mod = await import("../index.ts?official-lane");
	mod.default({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never);
	for (const name of ENV) if (name === "HOME" || name === "USERPROFILE") process.env[name] = prior[name];
});

afterAll(async () => {
	globalThis.fetch = realFetch;
	for (const name of ENV) {
		if (prior[name] === undefined) delete process.env[name];
		else process.env[name] = prior[name];
	}
	await rm(home, { recursive: true, force: true });
});

test("the billed lane asks X for at least its minimum of ten posts and returns only the count asked for", async () => {
	const result = await tools.get("x_search")?.execute("t", { query: "unreal camera", limit: 5 });

	const search = requested.find(url => url.pathname.endsWith("/tweets/search/recent"));
	expect(Number(search?.searchParams.get("max_results"))).toBeGreaterThanOrEqual(10);
	const rows = (result?.content[0]?.text ?? "").split("\n").filter(line => /^\d{19}\s/.test(line));
	expect(rows).toHaveLength(5);
});
