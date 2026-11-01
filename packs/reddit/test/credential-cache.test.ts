// The bearer-token cache's credential key. `tokenCache` is module state, evaluated
// ONCE PER PROCESS, so it outlives a session: a user who
// reconnects mid-process (new account, rotated secret) must not keep acting as
// the old account until the old token expires. A wrong-but-still-valid token
// never trips the 401 path that clears the cache, so the cache key is the only
// thing that can catch it — hence the re-mint test below.
//
// `getAuth`/`redditFetch` are module-private, so every case drives the real tool
// surface: the default-exported factory registers `reddit_my_profile`, whose
// handler runs the token exchange and the API call. `CONFIG_TARGET` is derived
// from `homedir()` at module load, so the temp HOME is installed BEFORE the
// dynamic import and restored immediately after — the module keeps the temp path
// for the rest of the file without leaving a mutated env behind for the suite.

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
// Dynamic on purpose: a static import is hoisted above the HOME override, and
// the module resolves CONFIG_TARGET from `homedir()` at evaluation time.
const { default: redditExtension } = await import("../index");
if (priorHome === undefined) delete process.env.HOME;
else process.env.HOME = priorHome;
if (priorUserProfile === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = priorUserProfile;

interface Recorded {
	url: string;
	authorization: string | null;
}

interface MinimalTool {
	name: string;
	execute: (toolCallId: string, params: Record<string, never>) => Promise<unknown>;
}

let tokenRequests: Recorded[] = [];
let apiRequests: Recorded[] = [];
let minted = 0;
// Seconds the stubbed token endpoint claims. 3600 is comfortably outside the
// 60s skew; a value below the skew is the expiry case.
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
		if (url === TOKEN_URL) {
			tokenRequests.push({ url, authorization });
			minted += 1;
			return json({ access_token: `token-${minted}`, expires_in: expiresInSeconds });
		}
		if (url.startsWith(OAUTH_API)) {
			apiRequests.push({ url, authorization });
			return json({ name: "acct", link_karma: 1, comment_karma: 2 });
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

/** Reddit's Basic header carries base64(clientId:clientSecret) — decode it to see
 *  which stored credential a given mint actually used. */
function basicOf(record: Recorded): string {
	const header = record.authorization ?? "";
	return Buffer.from(header.replace(/^Basic /, ""), "base64").toString("utf-8");
}

/** A distinct credential per test: the cache is module-level and survives across
 *  tests, so each test's first call must re-mint no matter what ran before it.
 *  That is what keeps these tests order-independent. */
function credential(marker: string, secret: string) {
	return { clientId: `client-${marker}`, clientSecret: secret, username: `u_${marker}`, password: "pw" };
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

	// The user reconnects mid-process with a rotated secret. The cached token has
	// ~59 minutes left, so expiry alone would happily keep serving it.
	await storeCredential(credential("rotated", "secret-new"));
	await tool.execute("call-2", {});

	expect(tokenRequests).toHaveLength(2);
	// The mint used the NEW stored secret, and the API call carried the NEW token.
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
	// The User-Agent is minted from the same credential and rides along in the
	// cache, so a stale cache would also keep announcing the old account.
	expect(apiRequests[1]?.url).toBe(`${OAUTH_API}/api/v1/me?raw_json=1`);
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
	// 30s of life left against a 60s skew: stale by the skew rule, and the
	// credential never changes, so only expiry can explain the second mint.
	expiresInSeconds = 30;
	const tool = profileTool();
	await storeCredential(credential("skew", "secret"));
	await tool.execute("call-1", {});
	await tool.execute("call-2", {});

	expect(tokenRequests).toHaveLength(2);
	expect(apiRequests.map(r => r.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
});
