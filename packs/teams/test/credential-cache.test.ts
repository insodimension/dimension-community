// The access-token cache's credential key. `tokenCache` is module state, evaluated
// ONCE PER PROCESS, so it outlives a session: a user who
// reconnects mid-process (a different tenant, a rotated secret) must not keep
// calling Graph with the old tenant's token until it expires. A wrong-but-still-
// valid token never trips the 401 path that clears the cache, so the cache key is
// the only thing that can catch it — hence the re-mint tests below.
//
// `getAccessToken`/`graphFetch` are module-private, so every case drives the real
// tool surface: the default-exported factory registers `teams_list_teams`, whose
// handler runs the token exchange and the Graph call. `CONFIG_TARGET` is derived
// from `homedir()` at module load, so the temp HOME is installed BEFORE the
// dynamic import and restored immediately after — the module keeps the temp path
// for the rest of the file without leaving a mutated env behind for the suite.

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOGIN_HOST = "https://login.microsoftonline.com/";
const GRAPH_API = "https://graph.microsoft.com/v1.0";

const home = await mkdtemp(join(tmpdir(), "dimension-teams-cred-"));
const CONFIG_TARGET = join(home, ".config", "dimension-teams", "token.json");
await mkdir(join(home, ".config", "dimension-teams"), { recursive: true });

const priorHome = process.env.HOME;
const priorUserProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
// Dynamic on purpose: a static import is hoisted above the HOME override, and
// the module resolves CONFIG_TARGET from `homedir()` at evaluation time.
const { default: teamsExtension } = await import("../index");
if (priorHome === undefined) delete process.env.HOME;
else process.env.HOME = priorHome;
if (priorUserProfile === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = priorUserProfile;

interface TokenRequest {
	url: string;
	clientId: string | null;
	clientSecret: string | null;
}

interface GraphRequest {
	url: string;
	authorization: string | null;
}

interface MinimalTool {
	name: string;
	execute: (toolCallId: string, params: Record<string, never>) => Promise<unknown>;
}

let tokenRequests: TokenRequest[] = [];
let graphRequests: GraphRequest[] = [];
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
	graphRequests = [];
	minted = 0;
	expiresInSeconds = 3600;
	realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.startsWith(LOGIN_HOST)) {
			const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
			tokenRequests.push({ url, clientId: form.get("client_id"), clientSecret: form.get("client_secret") });
			minted += 1;
			return json({ access_token: `token-${minted}`, expires_in: expiresInSeconds });
		}
		if (url.startsWith(GRAPH_API)) {
			graphRequests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
			return json({ value: [{ id: "team-1", displayName: "Team One" }] });
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

/** A distinct credential per test: the cache is module-level and survives across
 *  tests, so each test's first call must re-mint no matter what ran before it.
 *  That is what keeps these tests order-independent. */
function credential(marker: string, secret: string) {
	return { tenantId: `tenant-${marker}`, clientId: `client-${marker}`, clientSecret: secret };
}

async function storeCredential(cred: Record<string, string>): Promise<void> {
	await writeFile(CONFIG_TARGET, JSON.stringify(cred), "utf-8");
}

function listTeamsTool(): MinimalTool {
	const registered: MinimalTool[] = [];
	teamsExtension({ registerTool: (tool: MinimalTool) => registered.push(tool) } as never);
	const tool = registered.find(t => t.name === "teams_list_teams");
	if (!tool) throw new Error("teams_list_teams was not registered");
	return tool;
}

test("a rotated client secret re-mints the access token even though the cached one is nowhere near expiry", async () => {
	const tool = listTeamsTool();
	await storeCredential(credential("rotated", "secret-old"));
	await tool.execute("call-1", {});
	expect(tokenRequests).toHaveLength(1);
	expect(graphRequests[0]?.authorization).toBe("Bearer token-1");

	// The user reconnects mid-process with a rotated secret. The cached token has
	// ~59 minutes left, so expiry alone would happily keep serving it.
	await storeCredential(credential("rotated", "secret-new"));
	await tool.execute("call-2", {});

	expect(tokenRequests).toHaveLength(2);
	// The mint used the NEW stored secret, and the Graph call carried the NEW token.
	expect(tokenRequests[1]?.clientSecret).toBe("secret-new");
	expect(graphRequests[1]?.authorization).toBe("Bearer token-2");
});

test("a different tenant re-mints the access token rather than calling Graph as the old tenant", async () => {
	const tool = listTeamsTool();
	await storeCredential(credential("tenant-first", "secret"));
	await tool.execute("call-1", {});
	expect(graphRequests[0]?.authorization).toBe("Bearer token-1");

	await storeCredential(credential("tenant-second", "secret"));
	await tool.execute("call-2", {});

	expect(tokenRequests).toHaveLength(2);
	// The tenant is part of the token endpoint's own path, so the re-mint has to
	// go to the new tenant's authority.
	expect(tokenRequests[1]?.url).toBe(`${LOGIN_HOST}tenant-tenant-second/oauth2/v2.0/token`);
	expect(graphRequests[1]?.authorization).toBe("Bearer token-2");
});

test("an unchanged credential with an unexpired token performs exactly one token request", async () => {
	const tool = listTeamsTool();
	await storeCredential(credential("reuse", "secret"));
	await tool.execute("call-1", {});
	await tool.execute("call-2", {});

	expect(tokenRequests).toHaveLength(1);
	expect(graphRequests.map(r => r.authorization)).toEqual(["Bearer token-1", "Bearer token-1"]);
});

test("a token inside the skew window re-mints even when the credential is unchanged", async () => {
	// 30s of life left against a 60s skew: stale by the skew rule, and the
	// credential never changes, so only expiry can explain the second mint.
	expiresInSeconds = 30;
	const tool = listTeamsTool();
	await storeCredential(credential("skew", "secret"));
	await tool.execute("call-1", {});
	await tool.execute("call-2", {});

	expect(tokenRequests).toHaveLength(2);
	expect(graphRequests.map(r => r.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
});
