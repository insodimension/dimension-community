import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const OAUTH_API = "https://oauth.reddit.com";

const home = await mkdtemp(join(tmpdir(), "dimension-reddit-cred-"));
const CONFIG_TARGET = join(home, ".config", "dimension-reddit", "token.json");
await mkdir(join(home, ".config", "dimension-reddit"), { recursive: true });

const priorHome = process.env.HOME;
const priorUserProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
const { default: redditExtension } = await import("../index.ts?reddit-credential");
if (priorHome === undefined) delete process.env.HOME;
else process.env.HOME = priorHome;
if (priorUserProfile === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = priorUserProfile;

interface Recorded {
	url: string;
	authorization: string | null;
	body: string;
}

interface MinimalTool {
	name: string;
	execute: (toolCallId: string, params: Record<string, never>) => Promise<unknown>;
}

let tokenRequests: Recorded[] = [];
let apiRequests: Recorded[] = [];
let minted = 0;
let expiresInSeconds = 3600;
let realFetch: typeof globalThis.fetch;

function json(payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(() => {
	tokenRequests = [];
	apiRequests = [];
	minted = 0;
	expiresInSeconds = 3600;
	realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const authorization = new Headers(init?.headers).get("authorization");
		const body = typeof init?.body === "string" ? init.body : "";
		if (url === TOKEN_URL) {
			tokenRequests.push({ url, authorization, body });
			minted += 1;
			return json({ access_token: `token-${minted}`, expires_in: expiresInSeconds });
		}
		if (url.startsWith(OAUTH_API)) {
			apiRequests.push({ url, authorization, body });
			return json({ kind: "t2", data: { name: "acct", link_karma: 1, comment_karma: 2 } });
		}
		throw new Error(`test stub saw an unexpected request: ${url}`);
	}) as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

afterAll(async () => {
	await rm(home, { recursive: true, force: true });
});

function basicOf(record: Recorded): string {
	const header = record.authorization ?? "";
	return Buffer.from(header.replace(/^Basic /, ""), "base64").toString("utf-8");
}

function credential(marker: string, secret: string) {
	return { clientId: `client-${marker}`, clientSecret: secret, username: `u_${marker}` };
}

async function storeCredential(cred: Record<string, string>): Promise<void> {
	await writeFile(CONFIG_TARGET, JSON.stringify(cred), "utf-8");
}

function profileTool(): MinimalTool {
	const registered: MinimalTool[] = [];
	redditExtension({ registerTool: (tool: MinimalTool) => registered.push(tool) } as never);
	const tool = registered.find(t => t.name === "reddit_my_profile");
	if (!tool) throw new Error("reddit_my_profile was not registered");
	return tool;
}

test("a rotated secret re-mints the bearer token even though the cached one is nowhere near expiry", async () => {
	const tool = profileTool();
	await storeCredential(credential("rotated", "secret-old"));
	await tool.execute("call-1", {});
	expect(tokenRequests).toHaveLength(1);
	expect(apiRequests[0]?.authorization).toBe("Bearer token-1");

	await storeCredential(credential("rotated", "secret-new"));
	await tool.execute("call-2", {});

	expect(tokenRequests).toHaveLength(2);
	expect(basicOf(tokenRequests[1] as Recorded)).toBe("client-rotated:secret-new");
	expect(apiRequests[1]?.authorization).toBe("Bearer token-2");
});

test("a different account re-mints the bearer token rather than acting as the old one", async () => {
	const tool = profileTool();
	await storeCredential(credential("acct-first", "secret"));
	await tool.execute("call-1", {});
	expect(apiRequests[0]?.authorization).toBe("Bearer token-1");

	await storeCredential(credential("acct-second", "secret"));
	await tool.execute("call-2", {});

	expect(tokenRequests).toHaveLength(2);
	expect(basicOf(tokenRequests[1] as Recorded)).toBe("client-acct-second:secret");
	expect(apiRequests[1]?.authorization).toBe("Bearer token-2");
	expect(apiRequests[1]?.url).toBe(`${OAUTH_API}/user/u_acct-second/about?raw_json=1`);
});

test("an unchanged credential with an unexpired token performs exactly one token request", async () => {
	const tool = profileTool();
	await storeCredential(credential("reuse", "secret"));
	await tool.execute("call-1", {});
	await tool.execute("call-2", {});

	expect(tokenRequests).toHaveLength(1);
	expect(apiRequests.map(r => r.authorization)).toEqual(["Bearer token-1", "Bearer token-1"]);
});

test("a token inside the skew window re-mints even when the credential is unchanged", async () => {
	expiresInSeconds = 30;
	const tool = profileTool();
	await storeCredential(credential("skew", "secret"));
	await tool.execute("call-1", {});
	await tool.execute("call-2", {});

	expect(tokenRequests).toHaveLength(2);
	expect(apiRequests.map(r => r.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
});

test("the token is an app-only grant: no password is ever sent, even from a credential stored before the password was dropped", async () => {
	const tool = profileTool();
	await storeCredential({ ...credential("legacy", "secret"), password: "old-password" });
	await tool.execute("call-1", {});

	const sent = new URLSearchParams(tokenRequests[0]?.body ?? "");
	expect(sent.get("grant_type")).toBe("client_credentials");
	expect(sent.has("password")).toBe(false);
	expect(sent.has("username")).toBe(false);
	expect(tokenRequests[0]?.body).not.toContain("old-password");
	expect(JSON.parse(await readFile(CONFIG_TARGET, "utf-8"))).toEqual(credential("legacy", "secret"));
});
