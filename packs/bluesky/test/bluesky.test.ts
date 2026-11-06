import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import blueskyExtension from "../index";
import { imageSize, stripImageMetadata } from "../publish";
import { forgetSession } from "../session";

type Tool = {
	name: string;
	approval?: unknown;
	formatApprovalDetails?: (args: unknown) => string[];
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};

const tools = new Map<string, Tool>();
blueskyExtension({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never);

const ENV = ["HOME", "USERPROFILE", "INSO_HOME"] as const;
const prior = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
const realFetch = globalThis.fetch;
const root = await mkdtemp(join(tmpdir(), "bluesky-pack-"));
const home = join(root, "home");
const insoHome = join(root, "inso");
const approvals = join(insoHome, "browser", "publish-approvals");
const configDir = join(home, ".config", "dimension-bluesky");

interface Call {
	url: URL;
	method: string;
	headers: Headers;
	body: unknown;
}
let calls: Call[] = [];

const PDS = "https://pds.example.net";
const DID = "did:plc:brand";

beforeEach(async () => {
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.INSO_HOME = insoHome;
	await rm(root, { recursive: true, force: true });
	await mkdir(configDir, { recursive: true });
	await mkdir(approvals, { recursive: true });
	forgetSession();
	calls = [];
});

const PUBLIC_HOSTS: Record<string, string> = { "brand.com": "93.184.216.34", "cdn.brand.com": "93.184.216.35" };
const lookup = spyOn(dns, "lookup").mockImplementation((async (host: string) => [
	{ address: PUBLIC_HOSTS[host] ?? (host === "intranet.corp" ? "10.0.0.7" : "127.0.0.1"), family: 4 },
]) as never);

afterEach(() => {
	globalThis.fetch = realFetch;
});

afterAll(async () => {
	lookup.mockRestore();
	for (const name of ENV) {
		if (prior[name] === undefined) delete process.env[name];
		else process.env[name] = prior[name];
	}
	await rm(root, { recursive: true, force: true });
});

async function connect(): Promise<void> {
	await writeFile(
		join(configDir, "credential.json"),
		JSON.stringify({ handle: "@Brand.com", appPassword: "abcd-efgh-ijkl-mnop" }),
	);
}

type Handler = (call: Call) => Response | Promise<Response>;

function serve(routes: Record<string, Handler>): void {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const raw = init?.body;
		const body = typeof raw === "string" ? JSON.parse(raw) : raw;
		const call = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body };
		calls.push(call);
		const handler = routes[`${url.host}${url.pathname}`];
		if (!handler) throw new Error(`unexpected request ${url}`);
		return handler(call);
	}) as typeof fetch;
}

const identity: Record<string, Handler> = {
	"public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle": call =>
		Response.json({
			did:
				call.url.searchParams.get("handle") === "brand.com"
					? DID
					: `did:plc:${call.url.searchParams.get("handle")?.split(".")[0]}`,
		}),
	"plc.directory/did:plc:brand": () =>
		Response.json({
			service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: `${PDS}/` }],
		}),
	"pds.example.net/xrpc/com.atproto.server.createSession": () =>
		Response.json({ did: DID, handle: "brand.com", accessJwt: "access-1", refreshJwt: "refresh-1" }),
	"pds.example.net/xrpc/com.atproto.server.refreshSession": () =>
		Response.json({ did: DID, handle: "brand.com", accessJwt: "access-2", refreshJwt: "refresh-2" }),
};

async function run(name: string, params: Record<string, unknown>): Promise<string> {
	const tool = tools.get(name);
	if (!tool) throw new Error(`no tool ${name}`);
	return (await tool.execute("t", params)).content[0]?.text ?? "";
}

const post = (uri: string, text: string, counts: Record<string, number> = {}) => ({
	uri,
	cid: "cid",
	author: { did: uri.split("/")[2], handle: "ana.bsky.social" },
	record: { text, createdAt: "2026-11-05T10:00:00.000Z" },
	likeCount: 4,
	repostCount: 1,
	replyCount: 2,
	quoteCount: 3,
	bookmarkCount: 5,
	...counts,
});

test("reads need no account; only search, notifications and publish use the connected one", async () => {
	serve({
		...identity,
		"public.api.bsky.app/xrpc/app.bsky.feed.getPosts": call => {
			expect(call.url.searchParams.getAll("uris")).toEqual([
				"at://did:plc:ana/app.bsky.feed.post/3abc",
				"at://did:plc:x/app.bsky.feed.post/gone",
			]);
			return Response.json({ posts: [post("at://did:plc:ana/app.bsky.feed.post/3abc", "hello\nworld")] });
		},
	});

	const text = await run("bluesky_get_posts", {
		posts: ["https://bsky.app/profile/ana.bsky.social/post/3abc", "at://did:plc:x/app.bsky.feed.post/gone"],
	});

	expect(text).toContain(
		"@ana.bsky.social  2026-11-05 10:00  likes 4  reposts 1  replies 2  quotes 3  bookmarks 5  hello world  https://bsky.app/profile/ana.bsky.social/post/3abc",
	);
	expect(text).toContain(
		"Not found (deleted, or hidden from logged-out readers): at://did:plc:x/app.bsky.feed.post/gone",
	);
	expect(calls.some(call => call.headers.has("authorization"))).toBe(false);
	await expect(run("bluesky_search_posts", { query: "unreal" })).rejects.toThrow("Bluesky isn't connected");
});

test("search signs in once through the account's own PDS, asks the AppView through it, and refreshes an expired token instead of signing in again", async () => {
	await connect();
	let searches = 0;
	serve({
		...identity,
		"pds.example.net/xrpc/app.bsky.feed.searchPosts": () => {
			searches++;
			if (searches === 2)
				return Response.json({ error: "ExpiredToken", message: "Token has expired" }, { status: 400 });
			return Response.json({
				posts: [post("at://did:plc:ana/app.bsky.feed.post/1", "camera rigs")],
				hitsTotal: 1234,
				cursor: "c2",
			});
		},
	});

	const first = await run("bluesky_search_posts", {
		query: "camera",
		sort: "latest",
		since: "2026-11-01",
		tags: ["gamedev"],
	});
	await run("bluesky_search_posts", { query: "camera" });

	expect(first).toContain("~1,234 matches");
	expect(first).toContain("Next cursor: c2");
	const sent = calls.filter(call => call.url.pathname.endsWith("searchPosts"));
	expect(sent[0]?.headers.get("atproto-proxy")).toBe("did:web:api.bsky.app#bsky_appview");
	expect(sent[0]?.headers.get("authorization")).toBe("Bearer access-1");
	expect(sent[0]?.url.searchParams.get("since")).toBe("2026-11-01T00:00:00.000Z");
	expect(sent[0]?.url.searchParams.getAll("tag")).toEqual(["gamedev"]);
	expect(sent.at(-1)?.headers.get("authorization")).toBe("Bearer access-2");
	expect(calls.filter(call => call.url.pathname.endsWith("createSession"))).toHaveLength(1);
	expect(calls.filter(call => call.url.pathname.endsWith("refreshSession"))).toHaveLength(1);

	forgetSession();
	calls = [];
	await run("bluesky_search_posts", { query: "camera" });
	expect(calls.map(call => call.url.pathname)).toEqual(["/xrpc/app.bsky.feed.searchPosts"]);
	expect(calls[0]?.headers.get("authorization")).toBe("Bearer access-2");
});

test("notifications default to mentions, replies and quotes", async () => {
	await connect();
	serve({
		...identity,
		"pds.example.net/xrpc/app.bsky.notification.listNotifications": () =>
			Response.json({
				notifications: [
					{
						uri: "at://did:plc:ana/app.bsky.feed.post/9",
						author: { did: "did:plc:ana", handle: "ana.bsky.social" },
						reason: "reply",
						record: { text: "does it run on linux?" },
						isRead: false,
						indexedAt: "2026-11-06T08:00:00.000Z",
					},
				],
			}),
	});

	const text = await run("bluesky_my_notifications", {});

	expect(
		calls.find(call => call.url.pathname.endsWith("listNotifications"))?.url.searchParams.getAll("reasons"),
	).toEqual(["mention", "reply", "quote"]);
	expect(text).toBe(
		"reply  NEW  2026-11-06 08:00  @ana.bsky.social  does it run on linux?  https://bsky.app/profile/ana.bsky.social/post/9",
	);
});

function approve(draftId: string, values: string[], over: { expiresInMs?: number } = {}): string {
	const nonce = randomBytes(16).toString("hex");
	const now = Date.now();
	const binding = createHash("sha256")
		.update(JSON.stringify(["publish-approval/v1", "https://bsky.app", "brand.com", "bluesky_publish", values]))
		.digest("hex");
	return JSON.stringify({
		v: 1,
		draftId,
		nonce,
		binding,
		approvedAt: new Date(now - 1000).toISOString(),
		expiresAt: new Date(now + (over.expiresInMs ?? 3_600_000)).toISOString(),
	});
}

function publishRoutes(created: unknown[], failStatus?: number): Record<string, Handler> {
	return {
		...identity,
		"pds.example.net/xrpc/com.atproto.repo.uploadBlob": call =>
			Response.json({
				blob: {
					$type: "blob",
					ref: { $link: "bafyimage" },
					mimeType: call.headers.get("content-type"),
					size: (call.body as Uint8Array).length,
				},
			}),
		"pds.example.net/xrpc/com.atproto.repo.createRecord": call => {
			if (failStatus !== undefined)
				return Response.json(
					{ error: "InvalidRequest", message: "Record/text must not be longer than 300 graphemes" },
					{ status: failStatus },
				);
			created.push(call.body);
			return Response.json({
				uri: `at://${DID}/app.bsky.feed.post/r${created.length}`,
				cid: `cid${created.length}`,
			});
		},
	};
}

test("publish sends only the exact approved thread, with links as rich text and each post replying to the one before, and spends the approval", async () => {
	await connect();
	const image = join(root, "shot.png");
	const png = Buffer.from("89504e470d0a1a0a0000000d49484452000004b0000002760806000000", "hex");
	await writeFile(image, png);
	const posts = ["Ship day 🚀 see https://brand.com/launch.", "Built with #gamedev friends @ana.bsky.social"];
	const media = [{ path: image, post: 1, alt: "The editor with the camera rig open" }];
	const cards = [{ post: 0, uri: "https://brand.com/launch", title: "Launch & more", description: "" }];
	await writeFile(
		join(approvals, "d1.json"),
		approve("d1", [...posts, JSON.stringify([1, image, createHash("sha256").update(png).digest("hex"), media[0]?.alt])]),
	);
	const created: { record: Record<string, unknown> }[] = [];
	serve(publishRoutes(created));

	await expect(
		run("bluesky_publish", { draftId: "d1", posts: [posts[0], "Built with #gamedev friends"], media, cards }),
	).rejects.toThrow("publish_unapproved: no board approval covers this exact Bluesky post");
	await writeFile(image, Buffer.concat([png, Buffer.from([0])]));
	await expect(run("bluesky_publish", { draftId: "d1", posts, media, cards })).rejects.toThrow("publish_unapproved");
	expect(created).toHaveLength(0);
	expect(calls.some(call => call.url.pathname.endsWith("uploadBlob"))).toBe(false);
	await writeFile(image, png);

	const text = await run("bluesky_publish", { draftId: "d1", posts, media, cards });

	expect(text).toBe(
		[
			"Posted 1/2: https://bsky.app/profile/brand.com/post/r1",
			"Posted 2/2: https://bsky.app/profile/brand.com/post/r2",
		].join("\n"),
	);
	const [first, second] = created.map(entry => entry.record);
	expect(first?.text).toBe(posts[0]);
	expect(first?.facets).toEqual([
		{
			index: { byteStart: 18, byteEnd: 42 },
			features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://brand.com/launch" }],
		},
	]);
	expect(first?.embed).toEqual({
		$type: "app.bsky.embed.external",
		external: { uri: "https://brand.com/launch", title: "Launch & more", description: "" },
	});
	expect(first?.reply).toBeUndefined();
	expect(second?.reply).toEqual({
		root: { uri: `at://${DID}/app.bsky.feed.post/r1`, cid: "cid1" },
		parent: { uri: `at://${DID}/app.bsky.feed.post/r1`, cid: "cid1" },
	});
	expect(second?.facets).toEqual([
		{ index: { byteStart: 11, byteEnd: 19 }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "gamedev" }] },
		{
			index: { byteStart: 28, byteEnd: 44 },
			features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:ana" }],
		},
	]);
	expect(second?.embed).toEqual({
		$type: "app.bsky.embed.images",
		images: [
			{
				alt: media[0]?.alt,
				image: { $type: "blob", ref: { $link: "bafyimage" }, mimeType: "image/png", size: 29 },
				aspectRatio: { width: 1200, height: 630 },
			},
		],
	});

	await expect(run("bluesky_publish", { draftId: "d1", posts, media, cards })).rejects.toThrow(
		"was already used, so this post may already be up",
	);
	expect(created).toHaveLength(2);
});

test("an expired approval posts nothing, and a post Bluesky refuses gives the approval back", async () => {
	await connect();
	await writeFile(join(approvals, "old.json"), approve("old", ["hi"], { expiresInMs: -500 }));
	await writeFile(join(approvals, "d2.json"), approve("d2", ["hello"]));
	const created: unknown[] = [];
	serve(publishRoutes(created, 400));

	await expect(run("bluesky_publish", { draftId: "old", posts: ["hi"] })).rejects.toThrow("expired at");
	await expect(run("bluesky_publish", { draftId: "d2", posts: ["hello"] })).rejects.toThrow(
		"nothing was posted and the approval still stands",
	);
	expect((await readdir(approvals)).filter(name => name.endsWith(".used"))).toEqual([]);

	serve(publishRoutes(created));
	expect(await run("bluesky_publish", { draftId: "d2", posts: ["hello"] })).toBe(
		"Posted 1/1: https://bsky.app/profile/brand.com/post/r1",
	);
});

test("a 5xx on post 1 keeps the approval spent, since the post may be up", async () => {
	await connect();
	await writeFile(join(approvals, "d3.json"), approve("d3", ["hello"]));
	const created: unknown[] = [];
	serve(publishRoutes(created, 502));

	await expect(run("bluesky_publish", { draftId: "d3", posts: ["hello"] })).rejects.toThrow("bluesky_author_feed");
	serve(publishRoutes(created));
	await expect(run("bluesky_publish", { draftId: "d3", posts: ["hello"] })).rejects.toThrow("already used");
	expect(created).toHaveLength(0);
});

test("publish stops for a human in every approval mode and shows every post, image and link card field", () => {
	const tool = tools.get("bluesky_publish");
	const args = {
		draftId: "d9",
		posts: ["see https://brand.com/x", "two"],
		media: [{ path: "/a.png", post: 1, alt: "a chart" }],
		cards: [{ post: 0, uri: "https://brand.com/x", title: "Brand X", description: "Ships today", image: "https://cdn.brand.com/x.png" }],
	};
	expect(resolveApproval(tool as Parameters<typeof resolveApproval>[0], args, "yolo").policy).toBe("prompt");
	const card = tool?.formatApprovalDetails?.(args).join("\n") ?? "";
	for (const shown of ["see https://brand.com/x", "two", "/a.png", "a chart", "Brand X", "Ships today", "https://cdn.brand.com/x.png"])
		expect(card).toContain(shown);
	for (const tool of tools.values()) if (tool.name !== "bluesky_publish") expect(tool.approval).toBe("read");
});

test("a link card reads only public pages, at every redirect, and publishes exactly the approved card", async () => {
	await connect();
	const thumb = Buffer.from("89504e470d0a1a0a", "hex");
	const created: { record: { embed?: unknown } }[] = [];
	serve({
		...publishRoutes(created),
		"brand.com/launch": () =>
			new Response(
				"<html><head><meta property='og:title' content='Launch &amp; more'><meta property='og:image' content='https://cdn.brand.com/card.png'></head></html>",
				{ headers: { "content-type": "text/html" } },
			),
		"cdn.brand.com/card.png": () => new Response(thumb, { headers: { "content-type": "image/png" } }),
		"brand.com/hop": () => new Response(null, { status: 302, headers: { location: "http://intranet.corp/admin" } }),
		"brand.com/big": () =>
			new Response("<html><head><meta property='og:image' content='https://cdn.brand.com/huge.png'></head></html>", {
				headers: { "content-type": "text/html" },
			}),
		"cdn.brand.com/huge.png": () => new Response(new Uint8Array(1_000_001), { headers: { "content-type": "image/png" } }),
	});

	const card = JSON.parse(await run("bluesky_link_card", { url: "https://brand.com/launch" }));
	expect(card).toEqual({
		uri: "https://brand.com/launch",
		title: "Launch & more",
		description: "",
		image: "https://cdn.brand.com/card.png",
	});
	expect(JSON.parse(await run("bluesky_link_card", { url: "https://brand.com/big" })).image).toBeUndefined();
	const refused = [
		"http://localhost:8080/",
		"http://127.0.0.1/",
		"http://169.254.169.254/latest/meta-data",
		"http://[::1]/",
		"http://[fd00::1]/",
		"http://[::ffff:127.0.0.1]/",
		"http://intranet.corp/",
		"https://brand.com/hop",
		"file:///etc/passwd",
	];
	for (const url of refused) {
		await expect(run("bluesky_link_card", { url })).rejects.toThrow("gave no link card");
	}
	expect(calls.some(call => call.url.host !== "brand.com" && call.url.host !== "cdn.brand.com" && !call.url.host.endsWith("bsky.app"))).toBe(false);

	await writeFile(join(approvals, "d4.json"), approve("d4", ["Out now https://brand.com/launch"]));
	const text = await run("bluesky_publish", {
		draftId: "d4",
		posts: ["Out now https://brand.com/launch"],
		cards: [{ post: 0, ...card }],
	});
	expect(text).toContain("Posted 1/1");
	expect(created[0]?.record.embed).toEqual({
		$type: "app.bsky.embed.external",
		external: {
			uri: "https://brand.com/launch",
			title: "Launch & more",
			description: "",
			thumb: { $type: "blob", ref: { $link: "bafyimage" }, mimeType: "image/png", size: thumb.length },
		},
	});
	await expect(
		run("bluesky_publish", {
			draftId: "d4",
			posts: ["Out now https://brand.com/launch"],
			cards: [{ post: 0, ...card, uri: "https://brand.com/other" }],
		}),
	).rejects.toThrow("not the post's first link");
});

test("parallel calls share one token refresh", async () => {
	await connect();
	let expired = true;
	serve({
		...identity,
		"pds.example.net/xrpc/com.atproto.server.refreshSession": async () => {
			await Bun.sleep(20);
			expired = false;
			return Response.json({ did: DID, handle: "brand.com", accessJwt: "access-2", refreshJwt: "refresh-2" });
		},
		"pds.example.net/xrpc/app.bsky.feed.searchPosts": call =>
			expired || call.headers.get("authorization") !== "Bearer access-2"
				? Response.json({ error: "ExpiredToken" }, { status: 400 })
				: Response.json({ posts: [] }),
	});

	await Promise.all([1, 2, 3].map(() => run("bluesky_search_posts", { query: "camera" })));

	expect(calls.filter(call => call.url.pathname.endsWith("refreshSession"))).toHaveLength(1);
	expect(calls.filter(call => call.url.pathname.endsWith("createSession"))).toHaveLength(1);
});

test("bluesky_get_posts resolves each handle once", async () => {
	serve({
		...identity,
		"public.api.bsky.app/xrpc/app.bsky.feed.getPosts": () => Response.json({ posts: [] }),
	});

	await run("bluesky_get_posts", {
		posts: [1, 2, 3].map(id => `https://bsky.app/profile/ana.bsky.social/post/${id}`),
	});

	expect(calls.filter(call => call.url.pathname.endsWith("resolveHandle"))).toHaveLength(1);
});

test("image metadata is stripped before upload and the size is read from the header", () => {
	const app1 = Buffer.from([0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66]);
	const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x01, 0x01, 0x11, 0x00]);
	const jpeg = Buffer.concat([
		Buffer.from([0xff, 0xd8]),
		app1,
		sof,
		Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0x02]),
	]);
	const stripped = stripImageMetadata(jpeg, "image/jpeg");
	expect(Buffer.from(stripped).includes(Buffer.from("Exif"))).toBe(false);
	expect(imageSize(stripped, "image/jpeg")).toEqual({ width: 640, height: 480 });
});

test("a JPEG keeps only its rotation, so a portrait photo stays upright", () => {
	const exif = Buffer.from([
		0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x02, 0x00, 0x0f, 0x01, 0x02,
		0x00, 0x04, 0x00, 0x00, 0x00, 0x41, 0x63, 0x6d, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	]);
	const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, exif.length + 2]), exif]);
	const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x01, 0x01, 0x11, 0x00]);
	const jpeg = Buffer.concat([
		Buffer.from([0xff, 0xd8]),
		app1,
		sof,
		Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0x02]),
	]);

	const stripped = stripImageMetadata(jpeg, "image/jpeg");

	expect(Buffer.from(stripped).includes(Buffer.from("Acm"))).toBe(false);
	expect(imageSize(stripped, "image/jpeg")).toEqual({ width: 480, height: 640 });
});
