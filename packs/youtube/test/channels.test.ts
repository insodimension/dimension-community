import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelFor, connectedChannels, NOT_CONNECTED, ownerOfVideo } from "../api";
import youtubeExtension from "../index";
import { ALPHA, BETA, bearerOf, type ChannelSeed, channelIdOf, seedChannel } from "./channel-fixture";

const ENV = ["HOME", "USERPROFILE"] as const;
const prior = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
const home = await mkdtemp(join(tmpdir(), "youtube-channels-"));
const configDir = join(home, ".config", "dimension-youtube");
const channelsDir = join(configDir, "channels");
const tokenFile = join(configDir, "token.json");
const GAMMA: ChannelSeed = { channelId: channelIdOf("gamma"), title: "Gamma Channel", handle: "gammahandle", access: "tok-gamma", refresh: "ref-gamma" };
const VIDEO = "dQw4w9WgXcQ";

interface Tool {
	name: string;
	approval: unknown;
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
}

interface Call {
	method: string;
	url: URL;
	headers: Headers;
	body: string | undefined;
}

interface Account {
	id: string;
	title: string;
	customUrl?: string;
}

interface Owner {
	channelId: string;
	channelTitle: string;
}

interface World {
	mine?: Record<string, Account>;
	owners?: Record<string, Owner>;
}

const tools = new Map<string, Tool>();
youtubeExtension({ registerTool: (tool: Tool) => tools.set(tool.name, tool), on: () => undefined } as never);

function tool(name: string): Tool {
	const found = tools.get(name);
	if (!found) throw new Error(`youtube did not register ${name}`);
	return found;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];

function serve(handler: (call: Call) => Response): void {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const call: Call = {
			method: init?.method ?? "GET",
			url: new URL(input instanceof Request ? input.url : String(input)),
			headers: new Headers(init?.headers),
			body: typeof init?.body === "string" ? init.body : undefined,
		};
		calls.push(call);
		return handler(call);
	}) as typeof fetch;
}

function accessOf(call: Call): string {
	return (call.headers.get("authorization") ?? "").replace("Bearer ", "");
}

function isMine(call: Call): boolean {
	return call.url.pathname === "/youtube/v3/channels" && call.url.searchParams.get("mine") === "true";
}

function serveWorld(world: World = {}): void {
	serve(call => {
		const path = call.url.pathname;
		if (call.url.host === "oauth2.googleapis.com") return Response.json({ access_token: "refreshed-access", expires_in: 3600 });
		if (isMine(call)) {
			const account = world.mine?.[accessOf(call)];
			if (!account) return Response.json({ items: [] });
			return Response.json({ items: [{ id: account.id, snippet: { title: account.title, ...(account.customUrl ? { customUrl: account.customUrl } : {}) } }] });
		}
		if (path === "/youtube/v3/channels") {
			const ids = (call.url.searchParams.get("id") ?? "").split(",");
			return Response.json({ items: ids.map(id => ({ id, snippet: { title: `channel ${id}` }, statistics: { subscriberCount: "5" } })) });
		}
		if (path === "/youtube/v3/videos" && call.method === "GET") {
			const id = call.url.searchParams.get("id") ?? "";
			const owner = world.owners?.[id];
			return Response.json({ items: owner ? [{ id, snippet: owner }] : [] });
		}
		if (path === "/youtube/v3/playlists") {
			return Response.json({ items: [{ id: "PL1", snippet: { title: `playlist read with ${accessOf(call)}` }, contentDetails: { itemCount: 3 }, status: { privacyStatus: "public" } }] });
		}
		if (path === "/youtube/v3/playlistItems" && call.method === "POST") return Response.json({ id: "item-1", snippet: { title: "Added video" } });
		if (path === "/youtube/v3/commentThreads" && call.method === "POST") return Response.json({ id: "c1", snippet: { topLevelComment: { id: "c1" } } });
		throw new Error(`unexpected request ${call.method} ${call.url}`);
	});
}

async function connectAs(access: string, refresh: string, over: { expires?: number; clientSecret?: string } = {}): Promise<void> {
	await mkdir(configDir, { recursive: true });
	await writeFile(
		tokenFile,
		JSON.stringify({
			access,
			refresh,
			expires: over.expires ?? Date.now() + 3_600_000,
			clientId: "client-id",
			...(over.clientSecret ? { clientSecret: over.clientSecret } : {}),
		}),
	);
}

function seed(...seeds: ChannelSeed[]): Promise<void[]> {
	return Promise.all(seeds.map(each => seedChannel(configDir, each)));
}

function mineCalls(): Call[] {
	return calls.filter(isMine);
}

function accountOf(seedValue: ChannelSeed): Account {
	return { id: seedValue.channelId, title: seedValue.title, ...(seedValue.handle ? { customUrl: seedValue.handle } : {}) };
}

async function stored(channelId: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(channelsDir, `${channelId}.json`), "utf-8")) as Record<string, unknown>;
}

async function channelFiles(): Promise<string[]> {
	return (await readdir(channelsDir).catch(() => [])).sort();
}

function fileOf(seedValue: ChannelSeed): string {
	return `${seedValue.channelId}.json`;
}

async function failureOf(work: Promise<unknown>): Promise<Error> {
	return work.then(
		() => {
			throw new Error("expected the call to fail");
		},
		(error: Error) => error,
	);
}

beforeAll(() => {
	process.env.HOME = home;
	process.env.USERPROFILE = home;
});

beforeEach(async () => {
	await rm(configDir, { recursive: true, force: true });
	calls = [];
	serveWorld();
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

afterAll(async () => {
	for (const name of ENV) {
		if (prior[name] === undefined) delete process.env[name];
		else process.env[name] = prior[name];
	}
	await rm(home, { recursive: true, force: true });
});

describe("adopting the token the engine's Connect writes", () => {
	test("it becomes channels/<id>.json through one mine=true request, token.json stays, and a second call makes no request", async () => {
		await connectAs("acc-1", "ref-1", { clientSecret: "secret" });
		serveWorld({ mine: { "acc-1": accountOf(ALPHA) } });

		const first = await connectedChannels();

		expect(first.map(channel => channel.channelId)).toEqual([ALPHA.channelId]);
		expect(calls).toHaveLength(1);
		expect(mineCalls()[0]?.url.searchParams.get("part")).toBe("snippet");
		expect(mineCalls()[0]?.headers.get("authorization")).toBe("Bearer acc-1");
		const record = await stored(ALPHA.channelId);
		expect(record).toMatchObject({
			channelId: ALPHA.channelId,
			title: "Alpha",
			handle: "@alpha",
			access: "acc-1",
			refresh: "ref-1",
			clientId: "client-id",
			clientSecret: "secret",
		});
		expect(Date.parse(String(record.connectedAt))).toBeGreaterThan(Date.now() - 60_000);
		expect(JSON.parse(await readFile(tokenFile, "utf-8"))).toMatchObject({ access: "acc-1", refresh: "ref-1" });

		const second = await connectedChannels();

		expect(second).toEqual(first);
		expect(calls).toHaveLength(1);
	});

	test("callers that arrive together share one adoption", async () => {
		await connectAs("acc-1", "ref-1");
		serveWorld({ mine: { "acc-1": accountOf(ALPHA) } });

		const [one, two] = await Promise.all([connectedChannels(), connectedChannels()]);

		expect(mineCalls()).toHaveLength(1);
		expect(one).toHaveLength(1);
		expect(two).toEqual(one);
	});

	test("an expired token is refreshed first, the channel lookup uses the fresh access token, and that is what is stored", async () => {
		await connectAs("stale", "ref-1", { expires: Date.now() - 1_000, clientSecret: "secret" });
		serveWorld({ mine: { "refreshed-access": accountOf(ALPHA) } });

		await connectedChannels();

		const refresh = calls.find(call => call.url.host === "oauth2.googleapis.com");
		const form = new URLSearchParams(refresh?.body);
		expect(refresh?.method).toBe("POST");
		expect(form.get("grant_type")).toBe("refresh_token");
		expect(form.get("refresh_token")).toBe("ref-1");
		expect(form.get("client_id")).toBe("client-id");
		expect(form.get("client_secret")).toBe("secret");
		expect(mineCalls()[0]?.headers.get("authorization")).toBe("Bearer refreshed-access");
		expect(await stored(ALPHA.channelId)).toMatchObject({ access: "refreshed-access", refresh: "ref-1" });
	});

	test("a second Connect with a different refresh token for another channel adds a second channel and leaves the first alone", async () => {
		serveWorld({ mine: { "acc-1": accountOf(ALPHA), "acc-2": accountOf(BETA) } });
		await connectAs("acc-1", "ref-1");
		await connectedChannels();

		await connectAs("acc-2", "ref-2");
		const channels = await connectedChannels();

		expect(channels.map(channel => channel.channelId).sort()).toEqual([ALPHA.channelId, BETA.channelId].sort());
		expect(await channelFiles()).toEqual([fileOf(ALPHA), fileOf(BETA)].sort());
		expect(await stored(ALPHA.channelId)).toMatchObject({ access: "acc-1", refresh: "ref-1" });
		expect(await stored(BETA.channelId)).toMatchObject({ access: "acc-2", refresh: "ref-2", title: "Beta Studio", handle: "@betastudio" });
		expect(mineCalls()).toHaveLength(2);

		await connectedChannels();
		expect(mineCalls()).toHaveLength(2);
	});

	test("connecting a channel that is already connected replaces its file and does not touch the others", async () => {
		await seed(ALPHA, BETA);
		await connectAs("acc-new", "ref-new");
		serveWorld({ mine: { "acc-new": { id: ALPHA.channelId, title: "Alpha Renamed", customUrl: "@alpha" } } });

		const channels = await connectedChannels();

		expect(channels.map(channel => channel.channelId).sort()).toEqual([ALPHA.channelId, BETA.channelId].sort());
		expect(await channelFiles()).toEqual([fileOf(ALPHA), fileOf(BETA)].sort());
		expect(await stored(ALPHA.channelId)).toMatchObject({ access: "acc-new", refresh: "ref-new", title: "Alpha Renamed" });
		expect(await stored(BETA.channelId)).toMatchObject({ access: BETA.access, refresh: BETA.refresh });
		expect(channels.find(channel => channel.channelId === ALPHA.channelId)?.refresh).toBe("ref-new");
	});

	test("a token.json whose refresh token already belongs to a channel file is not looked up again", async () => {
		await seed(ALPHA);
		await connectAs("another-access", ALPHA.refresh);

		const channels = await connectedChannels();

		expect(channels.map(channel => channel.channelId)).toEqual([ALPHA.channelId]);
		expect(calls).toEqual([]);
	});

	test("an account YouTube names no channel for is refused with nothing stored, and the next call tries again", async () => {
		await connectAs("acc-1", "ref-1");
		serveWorld({ mine: {} });

		const failure = await failureOf(connectedChannels());

		expect(failure.message).toMatch(/no YouTube channel/);
		expect(await channelFiles()).toEqual([]);

		serveWorld({ mine: { "acc-1": accountOf(ALPHA) } });
		expect((await connectedChannels()).map(channel => channel.channelId)).toEqual([ALPHA.channelId]);
	});

	test("files in channels/ that are not a stored channel are ignored", async () => {
		await seed(ALPHA);
		await writeFile(join(channelsDir, "broken.json"), "{not json");
		await writeFile(join(channelsDir, "partial.json"), JSON.stringify({ channelId: channelIdOf("partial") }));
		await writeFile(join(channelsDir, "notes.txt"), "scratch");

		const channels = await connectedChannels();

		expect(channels.map(channel => channel.channelId)).toEqual([ALPHA.channelId]);
		expect(calls).toEqual([]);
	});

	test("with no channel files and no usable token.json nothing is connected and nothing is requested", async () => {
		expect(await connectedChannels()).toEqual([]);

		await mkdir(configDir, { recursive: true });
		await writeFile(tokenFile, "{broken");
		expect(await connectedChannels()).toEqual([]);

		await writeFile(tokenFile, JSON.stringify({ access: "only-access" }));
		expect(await connectedChannels()).toEqual([]);

		expect(calls).toEqual([]);
	});
});

describe("channelFor", () => {
	test("with nothing connected it is the not-connected error, whether or not a channel is asked for", async () => {
		await expect(channelFor(undefined)).rejects.toThrow(NOT_CONNECTED);
		await expect(channelFor("@alpha")).rejects.toThrow(NOT_CONNECTED);
		expect(calls).toEqual([]);
	});

	test("omitted, empty or blank with exactly one channel connected it is that channel", async () => {
		await seed(ALPHA);

		for (const wanted of [undefined, "", "   "]) {
			expect((await channelFor(wanted)).channelId).toBe(ALPHA.channelId);
		}
		expect(calls).toEqual([]);
	});

	test("omitted, empty or blank with several connected it refuses and lists every channel", async () => {
		await seed(ALPHA, BETA);

		for (const wanted of [undefined, "", "   "]) {
			const failure = await failureOf(channelFor(wanted));
			expect(failure.message).toContain("Several channels");
			for (const channel of [ALPHA, BETA]) {
				expect(failure.message).toContain(channel.title);
				expect(failure.message).toContain(channel.channelId);
			}
		}
	});

	const SPELLINGS: [ChannelSeed, string][] = [
		[ALPHA, ALPHA.channelId],
		[ALPHA, ALPHA.channelId.toUpperCase()],
		[ALPHA, "Alpha"],
		[ALPHA, "ALPHA"],
		[ALPHA, "@alpha"],
		[ALPHA, "@ALPHA"],
		[ALPHA, "alpha"],
		[BETA, BETA.channelId],
		[BETA, "Beta Studio"],
		[BETA, "beta studio"],
		[BETA, "@betastudio"],
		[BETA, "@BetaStudio"],
		[BETA, "betastudio"],
		[BETA, "  @betastudio  "],
		[GAMMA, GAMMA.channelId],
		[GAMMA, "gamma channel"],
		[GAMMA, "gammahandle"],
		[GAMMA, "@gammahandle"],
	];
	for (const [expected, wanted] of SPELLINGS) {
		test(`${JSON.stringify(wanted)} picks ${expected.title} among three connected channels`, async () => {
			await seed(ALPHA, BETA, GAMMA);

			expect((await channelFor(wanted)).channelId).toBe(expected.channelId);
		});
	}

	test("a name that matches none is refused with the name and the connected channels, and partial titles do not match", async () => {
		await seed(ALPHA, BETA);

		for (const wanted of ["@nobody", "Beta", "Alph", "UCalpha"]) {
			const failure = await failureOf(channelFor(wanted));
			expect(failure.message).toContain(`No connected channel is "${wanted}"`);
			expect(failure.message).toContain(ALPHA.channelId);
			expect(failure.message).toContain(BETA.channelId);
		}
	});
});

describe("ownerOfVideo", () => {
	test("with nothing connected it is the not-connected error", async () => {
		await expect(ownerOfVideo(VIDEO)).rejects.toThrow(NOT_CONNECTED);
		expect(calls).toEqual([]);
	});

	test("with one channel connected it is that channel and no request is made", async () => {
		await seed(BETA);

		expect((await ownerOfVideo(VIDEO)).channelId).toBe(BETA.channelId);
		expect(calls).toEqual([]);
	});

	for (const owner of [ALPHA, BETA]) {
		test(`with several connected one videos.list finds ${owner.title} as the owner`, async () => {
			await seed(ALPHA, BETA);
			serveWorld({ owners: { [VIDEO]: { channelId: owner.channelId, channelTitle: owner.title } } });

			const found = await ownerOfVideo(VIDEO);

			expect(found.channelId).toBe(owner.channelId);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.method).toBe("GET");
			expect(calls[0]?.url.pathname).toBe("/youtube/v3/videos");
			expect(calls[0]?.url.searchParams.get("part")).toBe("snippet");
			expect(calls[0]?.url.searchParams.get("id")).toBe(VIDEO);
		});
	}

	test("with several connected a video owned by an unconnected channel is refused naming that channel", async () => {
		await seed(ALPHA, BETA);
		const stranger = { channelId: channelIdOf("stranger"), channelTitle: "Somebody Else" };
		serveWorld({ owners: { [VIDEO]: stranger } });

		const failure = await failureOf(ownerOfVideo(VIDEO));

		expect(failure.message).toContain(VIDEO);
		expect(failure.message).toContain("Somebody Else");
		expect(failure.message).toContain(stranger.channelId);
		expect(failure.message).toMatch(/not connected/);
	});

	test("with several connected a video YouTube does not return is refused", async () => {
		await seed(ALPHA, BETA);
		serveWorld({ owners: {} });

		const failure = await failureOf(ownerOfVideo(VIDEO));

		expect(failure.message).toContain(`no video ${VIDEO}`);
	});
});

describe("tools that act as a channel", () => {
	function playlists(params: Record<string, unknown> = {}): Promise<{ content: { text: string }[] }> {
		return tool("youtube_list_playlists").execute("t", params);
	}

	test("youtube_list_playlists with two channels and no channel errors before any playlist request", async () => {
		await seed(ALPHA, BETA);

		const failure = await failureOf(playlists());

		expect(failure.message).toContain("Several channels");
		expect(failure.message).toContain(ALPHA.channelId);
		expect(failure.message).toContain(BETA.channelId);
		expect(calls).toEqual([]);
	});

	test("youtube_list_playlists with channel @handle reads that channel's playlists with that channel's bearer", async () => {
		await seed(ALPHA, BETA);

		const result = await playlists({ channel: "@betastudio" });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url.pathname).toBe("/youtube/v3/playlists");
		expect(calls[0]?.url.searchParams.get("mine")).toBe("true");
		expect(calls[0]?.headers.get("authorization")).toBe(bearerOf(BETA));
		expect(result.content[0]?.text).toContain("playlist read with tok-beta");
	});

	test("youtube_list_playlists with one channel needs no channel argument", async () => {
		await seed(ALPHA);

		await playlists();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers.get("authorization")).toBe(bearerOf(ALPHA));
	});

	test("youtube_list_playlists with an unknown channel is refused before any request", async () => {
		await seed(ALPHA, BETA);

		await expect(playlists({ channel: "@nobody" })).rejects.toThrow(/No connected channel is "@nobody"/);
		expect(calls).toEqual([]);
	});

	const READS: [string, Record<string, unknown>][] = [
		["youtube_search", { query: "unreal" }],
		["youtube_get_videos", { videoIds: [VIDEO] }],
		["youtube_list_playlists", {}],
		["youtube_list_playlist_items", { playlistId: "PL1" }],
		["youtube_list_comments", { videoId: VIDEO }],
		["youtube_get_captions", { videoId: VIDEO }],
		["youtube_video_analytics", { videoId: VIDEO }],
		["youtube_reach_report", {}],
	];
	for (const [name, params] of READS) {
		test(`${name} with nothing connected is the not-connected error and makes no request`, async () => {
			await expect(tool(name).execute("t", params)).rejects.toThrow(NOT_CONNECTED);
			expect(calls).toEqual([]);
		});
	}

	test("youtube_playlist_add needs channel when several are connected and posts with the named channel's bearer", async () => {
		await seed(ALPHA, BETA);
		const add = (extra: Record<string, unknown>) => tool("youtube_playlist_add").execute("t", { playlistId: "PL1", videoId: VIDEO, ...extra });

		await expect(add({})).rejects.toThrow(/Several channels/);
		expect(calls).toEqual([]);

		await add({ channel: "Alpha" });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url.pathname).toBe("/youtube/v3/playlistItems");
		expect(calls[0]?.headers.get("authorization")).toBe(bearerOf(ALPHA));
	});

	test("youtube_post_comment needs channel when several are connected and posts with the named channel's bearer", async () => {
		await seed(ALPHA, BETA);
		const post = (extra: Record<string, unknown>) => tool("youtube_post_comment").execute("t", { videoId: VIDEO, text: "The renderer caps at thirty seconds.", ...extra });

		await expect(post({})).rejects.toThrow(/Several channels/);
		expect(calls).toEqual([]);

		await post({ channel: BETA.channelId });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url.pathname).toBe("/youtube/v3/commentThreads");
		expect(calls[0]?.headers.get("authorization")).toBe(bearerOf(BETA));
	});
});

describe("youtube_channel_stats", () => {
	test("with no handle or id it reads every connected channel in one request", async () => {
		await seed(ALPHA, BETA);

		const result = await tool("youtube_channel_stats").execute("t", {});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url.pathname).toBe("/youtube/v3/channels");
		expect(calls[0]?.url.searchParams.get("id")).toBe(`${ALPHA.channelId},${BETA.channelId}`);
		expect(calls[0]?.url.searchParams.has("mine")).toBe(false);
		expect(result.content[0]?.text).toContain(`[${ALPHA.channelId}]`);
		expect(result.content[0]?.text).toContain(`[${BETA.channelId}]`);
	});

	test("with nothing connected and no handle or id it is the not-connected error and no request is made", async () => {
		await expect(tool("youtube_channel_stats").execute("t", {})).rejects.toThrow(NOT_CONNECTED);
		expect(calls).toEqual([]);
	});

	test("a handle reads that handle whatever is connected", async () => {
		await seed(ALPHA, BETA);

		await tool("youtube_channel_stats").execute("t", { handle: "someoneelse" });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url.searchParams.get("forHandle")).toBe("@someoneelse");
		expect(calls[0]?.url.searchParams.has("id")).toBe(false);
	});
});

describe("youtube_channels", () => {
	test("it lists every connected channel with its title, handle, id and connection date", async () => {
		await seed(ALPHA, BETA);

		const text = (await tool("youtube_channels").execute("t", {})).content[0]?.text ?? "";

		const lines = text.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("Alpha");
		expect(lines[0]).toContain("@alpha");
		expect(lines[0]).toContain(ALPHA.channelId);
		expect(lines[0]).toContain("2026-11-01");
		expect(lines[1]).toContain("Beta Studio");
		expect(lines[1]).toContain("@betastudio");
		expect(lines[1]).toContain(BETA.channelId);
		expect(calls).toEqual([]);
	});

	test("with nothing connected it says how to connect", async () => {
		const text = (await tool("youtube_channels").execute("t", {})).content[0]?.text;

		expect(text).toBe(NOT_CONNECTED);
	});
});

describe("youtube_forget_channel", () => {
	function forget(channel: string): Promise<{ content: { text: string }[] }> {
		return tool("youtube_forget_channel").execute("t", { channel });
	}

	test("it removes the named channel's file and only that one, by handle, title or id", async () => {
		await seed(ALPHA, BETA, GAMMA);

		const removed = await forget("@alpha");
		expect(removed.content[0]?.text).toContain("Removed");
		expect(removed.content[0]?.text).toContain(ALPHA.channelId);
		expect(await channelFiles()).toEqual([fileOf(BETA), fileOf(GAMMA)].sort());

		await forget("Beta Studio");
		expect(await channelFiles()).toEqual([fileOf(GAMMA)]);

		await forget(GAMMA.channelId);
		expect(await channelFiles()).toEqual([]);
		expect(await connectedChannels()).toEqual([]);
		expect(calls).toEqual([]);
	});

	test("a channel that is not connected is refused and every file stays", async () => {
		await seed(ALPHA, BETA);

		await expect(forget("@nobody")).rejects.toThrow(/No connected channel is "@nobody"/);

		expect(await channelFiles()).toEqual([fileOf(ALPHA), fileOf(BETA)].sort());
	});

	test("the other channels keep working after one is forgotten", async () => {
		await seed(ALPHA, BETA);
		await forget("@alpha");

		expect((await channelFor(undefined)).channelId).toBe(BETA.channelId);
		expect((await tool("youtube_list_playlists").execute("t", {})).content[0]?.text).toContain("tok-beta");
	});

	test("a forgotten channel is not brought back by the Connect token that signed it in", async () => {
		await connectAs("acc-1", "ref-1");
		serveWorld({ mine: { "acc-1": accountOf(ALPHA) } });
		await connectedChannels();
		expect(await channelFiles()).toEqual([fileOf(ALPHA)]);

		await forget("@alpha");
		calls = [];

		expect(await connectedChannels()).toEqual([]);
		expect(await channelFiles()).toEqual([]);
		expect(calls).toEqual([]);
	});

	test("forgetting removes token.json only when it holds the forgotten channel's sign-in", async () => {
		serveWorld({ mine: { "acc-1": accountOf(ALPHA), "acc-2": accountOf(BETA) } });
		await connectAs("acc-1", "ref-1");
		await connectedChannels();
		await connectAs("acc-2", "ref-2");
		await connectedChannels();
		calls = [];

		await forget("@alpha");

		expect(JSON.parse(await readFile(tokenFile, "utf-8"))).toMatchObject({ refresh: "ref-2" });
		expect((await connectedChannels()).map(channel => channel.channelId)).toEqual([BETA.channelId]);

		await forget("@betastudio");

		expect(await readFile(tokenFile).then(() => true, () => false)).toBe(false);
		expect(await connectedChannels()).toEqual([]);
		expect(calls).toEqual([]);
	});
});

describe("approval tiers", () => {
	test("forgetting and posting are write tier, reading channels is read tier, and only the board-approved update prompts in every mode", () => {
		expect(tool("youtube_forget_channel").approval).toBe("write");
		expect(tool("youtube_playlist_add").approval).toBe("write");
		expect(tool("youtube_post_comment").approval).toBe("write");
		expect(tool("youtube_channels").approval).toBe("read");
		expect(tool("youtube_list_playlists").approval).toBe("read");
		expect(tool("youtube_reach_report").approval).toBe("read");
		expect(tool("youtube_update_video").approval).toEqual({ tier: "write", policy: "prompt" });
	});
});
