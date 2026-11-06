// X (Twitter) connector — read mentions, timelines, threads, search and
// profiles, and post/reply/thread/DM as the connected account, over the
// official X API v2 (https://docs.x.com/x-api), authenticated via the plugin's
// `oauth` connect flow (see dimension.plugin.json).
//
// AUTH SHAPE — OAuth 2.0 authorization-code + PKCE, PUBLIC client.
// Posting on X requires USER context; app-only bearer tokens are rejected on
// every write endpoint. The engine's generic OAuth executor
// (packages/engine/src/plugin-oauth.ts) drives the consent round-trip and
// writes {access,refresh,expires,clientId,scopes} to CONFIG_TARGET; this
// extension keeps the access token fresh (X access tokens live ~2h) and
// exposes the API as agent tools.
//
// The connect card mandates a "Native App" (public client) because X requires
// CONFIDENTIAL clients to authenticate the token endpoint with HTTP Basic —
// which the generic executor does not send. Refresh below still sends Basic
// when a secret happens to be stored, so a manually-provisioned confidential
// credential keeps working even though connect can't mint one.
//
// COST MODEL is part of the contract, not trivia (pay-per-use since Feb 2026):
// owned reads (own posts, mentions, bookmarks) bill $0.001 per resource; other
// reads (search, home timeline, others' posts) bill $0.005 per post; a post
// costs $0.015, or $0.20 when it contains a URL. Tool descriptions and the
// skill say so, and `x_post` reports the tier it just spent.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";
import {
	collectEnvelope,
	DEPTH_POSTS,
	type ResearchDepth,
	type SearchWindow,
	writeEnvelope,
	type XReadPost,
	type XSearchPage,
	type XSearchSort,
} from "./x-envelope.js";

// MUST match `connect.configTarget` in dimension.plugin.json — the connect flow
// writes the credential there; this is the ONLY other place that path is
// spelled out (a JSON manifest can't share a TS constant with this file).
const CONFIG_TARGET = join(homedir(), ".config", "dimension-x", "token.json");
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const X_API = "https://api.x.com/2";
// Refresh this many ms before actual expiry so a slow request never races a
// token that goes stale mid-flight. X access tokens are short (~2h).
const REFRESH_SKEW_MS = 120_000;
// X's own composer limit for a standard account. Premium accounts may exceed
// it, so this is a WARNING threshold, never a client-side rejection.
const STANDARD_POST_LIMIT = 280;

/** Tweet fields every read requests, so metrics/threading are always present. */
const TWEET_FIELDS = "created_at,public_metrics,conversation_id,in_reply_to_user_id,referenced_tweets,lang,note_tweet";
const USER_FIELDS = "username,name,verified,description,public_metrics,created_at";

const storedCredential = type({
	"provider?": "string",
	access: "string",
	refresh: "string",
	expires: "number",
	clientId: "string",
	"clientSecret?": "string",
	"scopes?": "string[]",
});
type StoredCredential = typeof storedCredential.infer;

/** Validate the stored credential's JSON text. Throws a reconnect message when
 *  it is not a credential. */
function parseCredential(raw: string): StoredCredential {
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors) {
		throw new Error(`X's stored credential at ${CONFIG_TARGET} is malformed. Reconnect the plugin.`);
	}
	return parsed;
}

async function readCredential(): Promise<StoredCredential> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_TARGET, "utf-8");
	} catch {
		throw new Error("X isn't connected yet. Open the plugin's Connect dialog (Plugins → X) and sign in.");
	}
	return parseCredential(raw);
}

/** The credential on disk right now, or null when it is missing or malformed.
 *  Synchronous for the approval card, which renders before any await. */
function readCredentialSync(): StoredCredential | null {
	try {
		return parseCredential(readFileSync(CONFIG_TARGET, "utf-8"));
	} catch {
		return null;
	}
}

/** Which authorised ACCOUNT a credential is. The clientId names only the OAuth
 *  app, and one app can authorise several accounts, so the tokens are the key. */
function credentialIdentity(cred: StoredCredential): string {
	return createHash("sha256").update(`${cred.access}\0${cred.refresh}`).digest("hex");
}

/** Refresh the access token via the `refresh_token` grant when it's expired (or
 *  about to be), persisting the renewed credential. X ROTATES refresh tokens —
 *  every refresh returns a new one and invalidates the old, so persisting the
 *  new value is mandatory, not an optimization. */
async function refreshAccessToken(cred: StoredCredential): Promise<StoredCredential> {
	if (!cred.refresh) {
		throw new Error(
			"X's stored credential has no refresh token — it was issued without the `offline.access` scope. Reconnect the plugin.",
		);
	}
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: cred.refresh,
		client_id: cred.clientId,
	});
	const headers: Record<string, string> = {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
	};
	// Confidential clients MUST authenticate the token endpoint with Basic; the
	// connect card mandates a public client, but honor a secret if one exists.
	if (cred.clientSecret) {
		headers.Authorization = `Basic ${Buffer.from(`${cred.clientId}:${cred.clientSecret}`).toString("base64")}`;
	}
	const res = await fetch(TOKEN_URL, { method: "POST", headers, body: body.toString() });
	const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!res.ok || !payload || typeof payload.access_token !== "string") {
		const detail =
			payload && typeof payload.error_description === "string"
				? payload.error_description
				: ((payload?.error as string | undefined) ?? res.statusText);
		throw new Error(`X token refresh failed: ${detail}. Reconnect the plugin (Plugins → X).`);
	}
	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 7200;
	const refreshed: StoredCredential = {
		...cred,
		access: payload.access_token,
		refresh: typeof payload.refresh_token === "string" ? payload.refresh_token : cred.refresh,
		expires: Date.now() + expiresIn * 1000,
	};
	await writeFile(CONFIG_TARGET, JSON.stringify(refreshed, null, 2));
	// A refresh rotates both tokens but keeps the account: carry the cached
	// handle over rather than paying for another /users/me.
	if (cachedMe?.identity === credentialIdentity(cred)) {
		cachedMe = { identity: credentialIdentity(refreshed), user: cachedMe.user };
	}
	return refreshed;
}

/** A valid bearer token, refreshing first if the stored one is expired/near-expiry. */
async function freshAccessToken(): Promise<string> {
	const cred = await readCredential();
	if (Date.now() < cred.expires - REFRESH_SKEW_MS) return cred.access;
	return (await refreshAccessToken(cred)).access;
}

/** X reports errors two incompatible ways depending on the endpoint: an RFC 7807
 *  problem document ({title, detail, status}) and/or a partial-success envelope
 *  ({data, errors:[{title, detail}]}). Both must be read — a 200 carrying
 *  `errors` with no `data` is a FAILURE (e.g. a suspended author, a deleted post). */
interface XProblem {
	readonly title?: string;
	readonly detail?: string;
	readonly status?: number;
	readonly reason?: string;
	readonly errors?: readonly { readonly title?: string; readonly detail?: string; readonly message?: string }[];
}

function problemText(payload: XProblem | null, res: Response): string {
	if (!payload) return res.statusText || `HTTP ${res.status}`;
	const first = payload.errors?.[0];
	const fromErrors = first?.detail ?? first?.message ?? first?.title;
	const fromProblem = payload.detail ?? payload.title ?? payload.reason;
	return fromErrors ?? fromProblem ?? (res.statusText || `HTTP ${res.status}`);
}

/** Call an X API v2 endpoint and return its parsed body, mapping X's two error
 *  shapes and its billing/permission failures to messages that name the fix. */
async function xJson<T>(path: string, op: string, init?: RequestInit): Promise<T> {
	const accessToken = await freshAccessToken();
	const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
	if (init?.body) headers["Content-Type"] = "application/json";
	const res = await fetch(`${X_API}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
	// 204 (delete-style) has no body.
	const payload =
		res.status === 204 ? ({} as T & XProblem) : ((await res.json().catch(() => null)) as (T & XProblem) | null);
	if (res.status === 401) {
		throw new Error(`X rejected the access token (401) on ${op}. Reconnect the plugin (Plugins → X).`);
	}
	if (res.status === 403) {
		throw new Error(
			`X refused ${op} (403: ${problemText(payload, res)}). Usual causes: the app has no purchased API credits, the App permissions are Read-only (they cap the OAuth scopes), or the connected token lacks the scope this call needs — reconnect after fixing.`,
		);
	}
	if (res.status === 429) {
		const reset = res.headers.get("x-rate-limit-reset");
		const when = reset ? ` Window resets at ${new Date(Number(reset) * 1000).toISOString()}.` : "";
		throw new Error(`X rate-limited ${op} (429).${when} Rate limits are separate from billing — wait, don't retry.`);
	}
	if (!res.ok || !payload) {
		throw new Error(`X ${op} failed: ${problemText(payload, res)}`);
	}
	// A 2xx carrying `errors` and no `data` is a failure X chose to report softly.
	const envelope = payload as { data?: unknown; errors?: XProblem["errors"] };
	if (envelope.data === undefined && envelope.errors?.length) {
		throw new Error(`X ${op} returned no data: ${problemText(payload, res)}`);
	}
	return payload;
}

/** Clamp a caller-supplied limit into [min, max], defaulting when absent. X's
 *  paginated endpoints reject max_results below 5. */
function clampLimit(v: number | undefined, def: number, max: number, min = 5): number {
	return Math.min(Math.max(v ?? def, min), max);
}

/** Collapse whitespace runs so a multi-line post renders as one scannable line. */
function oneLine(s: string | undefined): string {
	return (s ?? "").replace(/\s+/g, " ").trim();
}

/** Accept a raw id, a status URL, or an @-less permalink and yield the post id.
 *  Users paste URLs far more often than 19-digit ids. */
function postId(input: string): string {
	const trimmed = input.trim();
	const fromUrl = /(?:x\.com|twitter\.com)\/[^/]+\/status(?:es)?\/(\d+)/i.exec(trimmed);
	if (fromUrl?.[1]) return fromUrl[1];
	const bare = /^(\d{5,25})$/.exec(trimmed);
	if (bare?.[1]) return bare[1];
	throw new Error(
		`"${input}" is not an X post id or status URL. Pass the numeric id or a https://x.com/…/status/… link.`,
	);
}

/** Strip a leading @ and any profile-URL wrapper from a handle. */
function handle(input: string): string {
	const trimmed = input.trim();
	const fromUrl = /(?:x\.com|twitter\.com)\/(@?[A-Za-z0-9_]{1,15})\/?$/i.exec(trimmed);
	const raw = fromUrl?.[1] ?? trimmed;
	return raw.replace(/^@/, "");
}

/** X's own URL-detection for billing purposes is "does the text contain a link";
 *  t.co wrapping means ANY http(s) URL or bare domain counts. Deliberately
 *  conservative — over-warning costs nothing, under-warning costs 13x. */
function containsUrl(text: string): boolean {
	return /https?:\/\/\S+|\b[a-z0-9-]+\.(?:com|net|org|io|ai|dev|co|app|xyz|gg|me|sh)\b/i.test(text);
}

interface XTweet {
	readonly id?: string;
	readonly text?: string;
	readonly created_at?: string;
	readonly author_id?: string;
	readonly conversation_id?: string;
	readonly lang?: string;
	readonly public_metrics?: {
		readonly reply_count?: number;
		readonly retweet_count?: number;
		readonly like_count?: number;
		readonly quote_count?: number;
		readonly impression_count?: number;
	};
	readonly referenced_tweets?: readonly { readonly type?: string; readonly id?: string }[];
	readonly note_tweet?: { readonly text?: string };
}

interface XUser {
	readonly id?: string;
	readonly username?: string;
	readonly name?: string;
	readonly verified?: boolean;
	readonly description?: string;
	readonly created_at?: string;
	readonly public_metrics?: {
		readonly followers_count?: number;
		readonly following_count?: number;
		readonly tweet_count?: number;
		readonly listed_count?: number;
	};
}

interface XListResponse {
	readonly data?: readonly XTweet[];
	readonly includes?: { readonly users?: readonly XUser[] };
	readonly meta?: { readonly next_token?: string; readonly result_count?: number };
}

/** Render one post as a single scannable line: id, author, age, metrics, text. */
function formatTweetLine(tweet: XTweet, authors: Map<string, XUser>): string {
	const author = tweet.author_id ? authors.get(tweet.author_id) : undefined;
	const who = author?.username ? `@${author.username}` : (tweet.author_id ?? "?");
	const when = tweet.created_at ? tweet.created_at.slice(0, 16).replace("T", " ") : "";
	const m = tweet.public_metrics;
	const metrics = m ? `  ♥${m.like_count ?? 0} ↺${m.retweet_count ?? 0} 💬${m.reply_count ?? 0}` : "";
	return `${tweet.id ?? "?"}  ${who}  ${when}${metrics}\n    ${oneLine(tweet.text)}`;
}

/** Index the `includes.users` sidecar so author_id → @username resolves. */
function authorIndex(payload: XListResponse): Map<string, XUser> {
	const map = new Map<string, XUser>();
	for (const user of payload.includes?.users ?? []) {
		if (user.id) map.set(user.id, user);
	}
	return map;
}

function renderTweetList(payload: XListResponse, emptyMsg: string): string {
	const tweets = payload.data ?? [];
	if (tweets.length === 0) return emptyMsg;
	const authors = authorIndex(payload);
	const lines = tweets.map(tweet => formatTweetLine(tweet, authors));
	if (payload.meta?.next_token) lines.push(`\n[more available — pass cursor: "${payload.meta.next_token}"]`);
	return lines.join("\n");
}

function formatPostLine(post: XReadPost): string {
	const who = post.authorUsername ? `@${post.authorUsername}` : (post.authorId ?? "?");
	const when = post.createdAt ? post.createdAt.slice(0, 16).replace("T", " ") : "";
	const metrics = `  ♥${post.likeCount ?? 0} ↺${post.retweetCount ?? 0} 💬${post.replyCount ?? 0}`;
	return `${post.id}  ${who}  ${when}${metrics}\n    ${oneLine(post.text)}`;
}

function billedLine(count: number, query: string): string {
	return `[official API · query sent: ${query} · ${count} post(s) at $${PAID_POST_USD}, $${(count * PAID_POST_USD).toFixed(3)}]`;
}

function renderPosts(page: XSearchPage, emptyMsg: string, query: string): string {
	if (page.posts.length === 0) return `${emptyMsg}\n${billedLine(0, query)}`;
	const lines = page.posts.map(formatPostLine);
	if (page.nextCursor) lines.push(`\n[more available — pass cursor: "${page.nextCursor}"]`);
	lines.push(billedLine(page.posts.length, query));
	return lines.join("\n");
}

function officialPosts(payload: XListResponse): XReadPost[] {
	const authors = authorIndex(payload);
	return (payload.data ?? []).flatMap(tweet => {
		if (!tweet.id) return [];
		const author = tweet.author_id ? authors.get(tweet.author_id) : undefined;
		const m = tweet.public_metrics;
		return [
			{
				id: tweet.id,
				text: tweet.note_tweet?.text ?? tweet.text ?? "",
				...(author?.username ? { authorUsername: author.username } : {}),
				...(tweet.author_id ? { authorId: tweet.author_id } : {}),
				...(tweet.created_at ? { createdAt: tweet.created_at } : {}),
				...(m?.like_count !== undefined ? { likeCount: m.like_count } : {}),
				...(m?.reply_count !== undefined ? { replyCount: m.reply_count } : {}),
				...(m?.retweet_count !== undefined ? { retweetCount: m.retweet_count } : {}),
				...(m?.quote_count !== undefined ? { quoteCount: m.quote_count } : {}),
				...(tweet.conversation_id ? { conversationId: tweet.conversation_id } : {}),
			},
		];
	});
}

const OFFICIAL_END_MARGIN_MS = 30_000;
const OFFICIAL_SEARCH_MIN_RESULTS = 10;
const PAID_POST_USD = 0.005;

const WEB_OPERATORS: readonly (readonly [RegExp, string])[] = [
	[/\bmin_faves:/gi, "min_likes:"],
	[/\bmin_retweets:/gi, "min_reposts:"],
	[/\bfilter:replies\b/gi, "is:reply"],
	[/\bfilter:links\b/gi, "has:links"],
	[/\bfilter:media\b/gi, "has:media"],
	[/\bfilter:images\b/gi, "has:images"],
	[/\bfilter:videos\b/gi, "has:videos"],
];

interface ApiSearch {
	readonly query: string;
	readonly window: SearchWindow;
}

function apiSearch(query: string, window: SearchWindow): ApiSearch {
	let since = window.since;
	let until = window.until;
	const stripped = query.replace(/(^|\s)(since|until):(\d{4}-\d{2}-\d{2})(?=\s|$)/gi, (_match, lead: string, key: string, day: string) => {
		if (key.toLowerCase() === "since") since ??= day;
		else until ??= day;
		return lead;
	});
	const translated = WEB_OPERATORS.reduce((text, [web, api]) => text.replace(web, api), stripped)
		.replace(/\s+/g, " ")
		.trim();
	return { query: translated, window: { ...(since ? { since } : {}), ...(until ? { until } : {}) } };
}

async function searchPage(
	query: string,
	limit: number,
	cursor: string | undefined,
	sort: XSearchSort,
	window: SearchWindow,
): Promise<XSearchPage & ApiSearch> {
	const api = apiSearch(query, window);
	const search = new URLSearchParams({ query: api.query, sort_order: sort === "top" ? "relevancy" : "recency" });
	if (api.window.since) search.set("start_time", `${api.window.since}T00:00:00Z`);
	if (api.window.until) {
		const end = Math.min(Date.parse(`${api.window.until}T00:00:00Z`), Date.now() - OFFICIAL_END_MARGIN_MS);
		search.set("end_time", new Date(end).toISOString());
	}
	const requested = Math.max(limit, OFFICIAL_SEARCH_MIN_RESULTS);
	const payload = await xJson<XListResponse>(
		`/tweets/search/recent?${search.toString()}&${tweetListParams(requested, cursor, "next_token")}`,
		"tweets/search/recent",
	);
	return {
		...api,
		posts: officialPosts(payload).slice(0, limit),
		...(payload.meta?.next_token ? { nextCursor: payload.meta.next_token } : {}),
	};
}

/** Shared query string for any endpoint returning a tweet list. */
function tweetListParams(
	limit: number,
	cursor: string | undefined,
	cursorKey: "pagination_token" | "next_token",
): string {
	const params = new URLSearchParams({
		max_results: String(limit),
		"tweet.fields": TWEET_FIELDS,
		expansions: "author_id",
		"user.fields": "username,name,verified",
	});
	if (cursor) params.set(cursorKey, cursor);
	return params.toString();
}

/** The connected account's numeric id, needed by every user-scoped endpoint.
 *  Cached for the process against the account's credential identity: it never
 *  changes for a given account, and every uncached lookup is a billed request. */
let cachedMe: { identity: string; user: XUser } | null = null;

async function me(): Promise<XUser> {
	// Refresh first: an expired token is rotated (and rewritten) inside xJson,
	// and the cache must be keyed to the credential the lookup actually used.
	await freshAccessToken();
	const cred = await readCredential();
	const identity = credentialIdentity(cred);
	if (cachedMe && cachedMe.identity === identity) return cachedMe.user;
	const payload = await xJson<{ data?: XUser }>(`/users/me?user.fields=${USER_FIELDS}`, "users/me");
	const user = payload.data;
	if (!user?.id) throw new Error("X did not return the connected account's id. Reconnect the plugin.");
	cachedMe = { identity, user };
	return user;
}

/** Publishing, deleting, and DMing are public or unretractable, so they demand
 *  a human click in EVERY approval mode — a bare "write" tier is auto-approved
 *  by write and yolo mode. */
const PROMPT_EVERY_MODE = { tier: "write", policy: "prompt" } as const;

/** One string argument off unvalidated tool args, for an approval card. Never
 *  throws: the card renders before the schema checks the call. */
function approvalArg(args: unknown, key: string): string | undefined {
	const value: unknown = typeof args === "object" && args !== null ? Reflect.get(args, key) : undefined;
	return typeof value === "string" ? value : undefined;
}

/** Who the write goes out as. Synchronous by contract and never touches the
 *  network: names the handle only when `me()` cached it for the account whose
 *  credential is on disk now, so a reconnect as another account never shows
 *  the old handle. */
function approvalAccount(): string {
	const cred = readCredentialSync();
	const username =
		cachedMe && cred && cachedMe.identity === credentialIdentity(cred) ? cachedMe.user.username : undefined;
	return username ? `As: @${username}` : "As: the connected X account";
}

/** The reply target x_post uses: an empty or whitespace-only replyTo is absent,
 *  so the post goes out top-level. Shared by the tool and its approval card. */
function replyTarget(raw: string | undefined): string | undefined {
	return raw?.trim() ? raw : undefined;
}

/** A post reference as the approval card shows it: the id plus its link, or the
 *  raw input flagged when it will not parse (the call then fails, posting nothing). */
function approvalPostRef(raw: string | undefined): string {
	if (raw === undefined) return "(missing)";
	try {
		const id = postId(raw);
		return `${id} (https://x.com/i/status/${id})`;
	} catch {
		return `${raw} (not a post id or status URL)`;
	}
}

/** The posts x_thread publishes, in order — shared by the tool and its approval
 *  card so the human approves exactly what goes out. */
function threadPosts(posts: readonly string[]): string[] {
	return posts.map(entry => entry.trim()).filter(Boolean);
}

const emptySchema = type({});

const mentionsSchema = type({
	"limit?": type("number").describe("Max mentions, default 20, capped at 100 (min 5)."),
	"cursor?": type("string").describe("pagination_token from a previous call's [more available] line."),
});

const myPostsSchema = type({
	"limit?": type("number").describe("Max posts, default 20, capped at 100 (min 5)."),
	"cursor?": type("string").describe("pagination_token from a previous call."),
});

const homeTimelineSchema = type({
	"limit?": type("number").describe("Max posts, default 20, capped at 100 (min 5). Billed at $0.005 per post."),
	"cursor?": type("string").describe("pagination_token from a previous call."),
});

const searchSchema = type({
	query: type("string").describe(
		'X search query in the official API syntax: "from:user", "to:user", "#tag", "url:domain.com", "-is:retweet", "is:reply", "has:links", "lang:en", "min_likes:10", "min_reposts:5", quoted phrases. Web spellings (min_faves:, min_retweets:, filter:replies/links/media, since:/until:) are translated. Only the last 7 days are searchable.',
	),
	"limit?": type("number").describe(
		"Max posts, default 20, capped at 100 (min 5). Billed at $0.005 per post returned.",
	),
	"cursor?": type("string").describe("next_token from a previous call."),
	"sort?": type("'recent' | 'top'").describe(
		"recent (default): newest first. top: X's most-engaged ranking, the popular pass that surfaces the week's strongest posts instead of only the last few hours.",
	),
	"since?": type(/^\d{4}-\d{2}-\d{2}$/).describe("Earliest day to include, YYYY-MM-DD (UTC). Within the last 7 days."),
	"until?": type(/^\d{4}-\d{2}-\d{2}$/).describe("Day to stop before, YYYY-MM-DD (UTC), exclusive."),
});

const postsEnvelopeSchema = type({
	topic: type("string").describe(
		"The research topic, character for character the topic string the last30days engine is run with: the engine refuses an envelope whose topic differs.",
	),
	"queries?": type("string[]").describe(
		"One or two X search queries for the topic (the plan's X queries). Defaults to the topic itself. Multi-word topics unquoted; quote only proper names.",
	),
	"depth?": type("'quick' | 'default' | 'deep'").describe(
		"Matches the engine's --quick / default / --deep: 10 / 30 / 60 newest posts per query, plus the popular pass.",
	),
	"handle?": type("string").describe(
		"The run's --x-handle account: it gets a from: call (8 posts) and a mention call (5 posts).",
	),
	"related?": type("string[]").describe("The run's --x-related accounts: each gets a from: call (3 posts)."),
	"days?": type("number").describe("The engine's --days window, default 30. X search itself reaches only the last 7."),
	"allowPaid?": type("boolean").describe(
		"The person agreed to the billed official-API reads ($0.005 per post) after seeing the estimate. Default false: the tool only answers with the estimate and X is reported as not covered.",
	),
});

const getPostSchema = type({
	post: type("string").describe("Post id or https://x.com/…/status/… URL."),
});

const readThreadSchema = type({
	post: type("string").describe("Any post id or URL in the thread — the whole conversation is fetched."),
	"limit?": type("number").describe("Max posts in the thread, default 50, capped at 100."),
});

const userLookupSchema = type({
	username: type("string").describe("Handle to look up, with or without the leading @."),
});

const bookmarksSchema = type({
	"limit?": type("number").describe("Max bookmarks, default 20, capped at 100 (min 5)."),
	"cursor?": type("string").describe("pagination_token from a previous call."),
});

const postSchema = type({
	text: type("string").describe("The post's full text. 280 characters for a standard account."),
	"replyTo?": type("string").describe(
		"Post id or URL to reply to. Only reply programmatically when the author @mentioned or quoted the user — see the skill's Safety section.",
	),
});

const threadSchema = type({
	posts: type("string[]").describe(
		"The thread's posts in order. Each is published as a reply to the previous one. Two or more.",
	),
});

const deleteSchema = type({
	post: type("string").describe("Post id or URL to delete. Must belong to the connected account."),
});

const bookmarkSchema = type({
	post: type("string").describe("Post id or URL to bookmark."),
	"remove?": type("boolean").describe("Set true to remove the bookmark instead of adding it."),
});

const dmSchema = type({
	username: type("string").describe("Recipient's handle, with or without the leading @."),
	text: type("string").describe("The message body."),
});

function createMeTool(): ToolDefinition<typeof emptySchema> {
	return {
		name: "x_me",
		label: "X: Account",
		description:
			"Show the connected X account — username, display name, numeric id, and follower/following/post counts. Use this to confirm which account the agent is acting as before any write.",
		parameters: emptySchema,
		approval: "read" as const,
		async execute() {
			const user = await me();
			const m = user.public_metrics;
			const lines = [
				`@${user.username ?? "?"}  ${user.name ?? ""}  [id ${user.id}]`,
				`Followers: ${m?.followers_count ?? "?"}  Following: ${m?.following_count ?? "?"}  Posts: ${m?.tweet_count ?? "?"}`,
			];
			if (user.created_at) lines.push(`Joined: ${user.created_at.slice(0, 10)}`);
			if (user.description) lines.push(`Bio: ${oneLine(user.description)}`);
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function createMentionsTool(): ToolDefinition<typeof mentionsSchema> {
	return {
		name: "x_mentions",
		label: "X: Mentions",
		description:
			"Posts mentioning the connected account, newest first — the monitoring feed for 'what needs my reply'. Returns id, author, timestamp, metrics, and text per post; pass an id to x_read_thread for context before drafting a reply. Official mentions endpoint, an owned read at $0.001 per post.",
		parameters: mentionsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof mentionsSchema.infer) {
			const user = await me();
			const limit = clampLimit(params.limit, 20, 100);
			const payload = await xJson<XListResponse>(
				`/users/${user.id}/mentions?${tweetListParams(limit, params.cursor, "pagination_token")}`,
				"users/mentions",
			);
			return {
				content: [{ type: "text" as const, text: renderTweetList(payload, "No mentions in the returned window.") }],
			};
		},
	};
}

function createMyPostsTool(): ToolDefinition<typeof myPostsSchema> {
	return {
		name: "x_my_posts",
		label: "X: My Posts",
		description:
			"The connected account's own recent posts with engagement metrics (likes, reposts, replies). Use it to check how something performed or to find a post id to delete or continue. An owned read at $0.001 per post.",
		parameters: myPostsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof myPostsSchema.infer) {
			const user = await me();
			const limit = clampLimit(params.limit, 20, 100);
			const payload = await xJson<XListResponse>(
				`/users/${user.id}/tweets?${tweetListParams(limit, params.cursor, "pagination_token")}`,
				"users/tweets",
			);
			return { content: [{ type: "text" as const, text: renderTweetList(payload, "No posts found.") }] };
		},
	};
}

function createHomeTimelineTool(): ToolDefinition<typeof homeTimelineSchema> {
	return {
		name: "x_home_timeline",
		label: "X: Home Timeline",
		description:
			"The connected account's home timeline in reverse-chronological order — what the people they follow just posted. NOT an owned read: billed at the higher $0.005 per post, so prefer a tight limit over browsing.",
		parameters: homeTimelineSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof homeTimelineSchema.infer) {
			const user = await me();
			const limit = clampLimit(params.limit, 20, 100);
			const payload = await xJson<XListResponse>(
				`/users/${user.id}/timelines/reverse_chronological?${tweetListParams(limit, params.cursor, "pagination_token")}`,
				"users/timelines/reverse_chronological",
			);
			return { content: [{ type: "text" as const, text: renderTweetList(payload, "Timeline is empty.") }] };
		},
	};
}

function createSearchTool(): ToolDefinition<typeof searchSchema> {
	return {
		name: "x_search",
		label: "X: Search",
		description:
			'Search public posts from the LAST 7 DAYS on the official X API, billed $0.005 per post returned, so state the limit deliberately. Operators: "from:user", "to:user", "#tag", "url:domain.com", "-is:retweet", "is:reply", "has:links", "lang:en", "min_likes:10", "min_reposts:5", quoted phrases. Web-search spellings are translated before the call (min_faves→min_likes, min_retweets→min_reposts, filter:replies→is:reply, filter:links→has:links, filter:media→has:media; since:/until: become the day window), and the output names the query sent. sort "top" is the popular pass (X\'s most-engaged ranking); since/until narrow it to days. Posts older than 7 days: read x.com advanced search in the Browser on the brand\'s profile (see the x skill).',
		parameters: searchSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof searchSchema.infer) {
			const limit = clampLimit(params.limit, 20, 100);
			const window: SearchWindow = {
				...(params.since ? { since: params.since } : {}),
				...(params.until ? { until: params.until } : {}),
			};
			const page = await searchPage(params.query, limit, params.cursor, params.sort ?? "recent", window);
			const text = renderPosts(page, `No posts in the last 7 days match: ${params.query}`, page.query);
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function paidEstimate(depth: ResearchDepth): string {
	return (DEPTH_POSTS[depth] * 2 * PAID_POST_USD).toFixed(2);
}

function createPostsEnvelopeTool(): ToolDefinition<typeof postsEnvelopeSchema> {
	return {
		name: "x_posts_envelope",
		label: "X: Posts for last30days",
		description:
			"Fetch X posts for a last30days run and write them as a last30days-x-posts/1 envelope file: the newest posts for each query, a popular pass (X's top-ranked posts for each of the last 7 days), from/mention calls for the named account, and up to 3 discovered authors. Returns the file path and the exact engine flags (LAST30DAYS_X_HOST_LANE=1, --x-posts, --x-handle, --x-related). X search reaches only the last 7 days of the 30-day window. Every read is billed on the official API ($0.005 per post): without allowPaid it only answers with the estimate; ask the person, and only on their yes call it with allowPaid, which shows them the estimate again.",
		parameters: postsEnvelopeSchema,
		approval: (args: unknown) =>
			typeof args === "object" && args !== null && Reflect.get(args, "allowPaid") === true
				? PROMPT_EVERY_MODE
				: "read",
		formatApprovalDetails(args: unknown) {
			const depth = approvalArg(args, "depth");
			const estimate = paidEstimate(depth === "quick" || depth === "deep" ? depth : "default");
			return [
				`Topic: ${approvalArg(args, "topic") ?? "(missing)"}`,
				`Billed X reads on the official API at $0.005 per post: roughly $${estimate} or more for this run.`,
			];
		},
		async execute(_toolCallId: string, params: typeof postsEnvelopeSchema.infer) {
			const depth: ResearchDepth = params.depth ?? "default";
			if (!params.allowPaid) {
				return {
					content: [
						{
							type: "text" as const,
							text: `X is not covered for this run yet: X search is billed on the official API at $0.005 per post, roughly $${paidEstimate(depth)} or more for this depth. Ask the person whether to spend that; only on their yes call again with allowPaid. Otherwise run last30days without --x-posts and say X was not covered.`,
						},
					],
				};
			}
			const result = await collectEnvelope(
				{
					topic: params.topic,
					queries: params.queries?.length ? params.queries.slice(0, 2) : [params.topic],
					depth,
					handle: params.handle ? handle(params.handle) : null,
					related: (params.related ?? []).map(handle),
					days: params.days ?? 30,
				},
				(query, limit, sort, window) => searchPage(query, limit, undefined, sort, window),
				new Date(),
			);
			const rows = result.envelope.calls.reduce((sum, call) => sum + call.posts.length, 0);
			const cost = `$${(result.paidPosts * PAID_POST_USD).toFixed(2)} on the official API`;
			if (rows === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `X search returned no posts for "${params.topic}" in the last 7 days (cost ${cost}). No envelope was written: run last30days without --x-posts and report X as having no posts this week.`,
						},
					],
				};
			}
			const path = await writeEnvelope(result.envelope);
			const related = [...(params.related ?? []).map(handle), ...result.discovered];
			const lines = [
				`Wrote ${rows} post(s) in ${result.envelope.calls.length} call(s) to ${path}`,
				`Status: ${result.envelope.status}${result.envelope.error ? ` (${result.envelope.error})` : ""} · window ${result.envelope.window.from} to ${result.envelope.window.to}, X search covers only the last 7 days · cost ${cost}`,
				"",
				"Run the engine in the same shell with:",
				"  LAST30DAYS_X_HOST_LANE=1",
				`  --x-posts "${path}"`,
				...(params.handle ? [`  --x-handle ${handle(params.handle)}`] : []),
				...(related.length ? [`  --x-related ${related.join(",")}`] : []),
				"",
				"The file is single-use, expires 6 hours after it was written, and the topic must match the engine's topic exactly.",
			];
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function createGetPostTool(): ToolDefinition<typeof getPostSchema> {
	return {
		name: "x_get_post",
		label: "X: Get Post",
		description:
			"Read one post by id or URL — full text, author, timestamp, language, and engagement metrics (likes, reposts, replies, quotes, impressions). Use this when the exact wording or the numbers matter.",
		parameters: getPostSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof getPostSchema.infer) {
			const id = postId(params.post);
			const search = new URLSearchParams({
				"tweet.fields": TWEET_FIELDS,
				expansions: "author_id",
				"user.fields": "username,name,verified",
			});
			const payload = await xJson<{ data?: XTweet; includes?: { users?: readonly XUser[] } }>(
				`/tweets/${id}?${search.toString()}`,
				"tweets/get",
			);
			const tweet = payload.data;
			if (!tweet) return { content: [{ type: "text" as const, text: `No post found for id ${id}.` }] };
			const author = payload.includes?.users?.[0];
			const m = tweet.public_metrics;
			const lines = [
				`${tweet.id}  ${author?.username ? `@${author.username}` : (tweet.author_id ?? "?")}${author?.name ? ` (${author.name})` : ""}`,
				tweet.created_at ? `Posted: ${tweet.created_at}` : "",
				`Likes: ${m?.like_count ?? "?"}  Reposts: ${m?.retweet_count ?? "?"}  Replies: ${m?.reply_count ?? "?"}  Quotes: ${m?.quote_count ?? "?"}  Impressions: ${m?.impression_count ?? "?"}`,
				tweet.conversation_id && tweet.conversation_id !== tweet.id
					? `In conversation: ${tweet.conversation_id} (use x_read_thread for the full exchange)`
					: "",
				`Link: https://x.com/${author?.username ?? "i"}/status/${tweet.id}`,
				"",
				tweet.text ?? "",
			];
			return { content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }] };
		},
	};
}

function createReadThreadTool(): ToolDefinition<typeof readThreadSchema> {
	return {
		name: "x_read_thread",
		label: "X: Read Thread",
		description:
			"Read a whole conversation from any post in it — the root plus every reply, in chronological order. Use this to get context before drafting a reply to a mention. Official API, $0.005 per post returned plus the one-post lookup of its root; built on recent search, so it only reaches posts from the LAST 7 DAYS.",
		parameters: readThreadSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof readThreadSchema.infer) {
			const id = postId(params.post);
			const limit = clampLimit(params.limit, 50, 100);
			const seed = await xJson<{ data?: XTweet }>(`/tweets/${id}?tweet.fields=conversation_id`, "tweets/get");
			const conversationId = seed.data?.conversation_id ?? id;
			const empty = `No posts from the last 7 days in conversation ${conversationId}. X's recent-search window may have aged them out.`;
			const search = new URLSearchParams({ query: `conversation_id:${conversationId}` });
			const payload = await xJson<XListResponse>(
				`/tweets/search/recent?${search.toString()}&${tweetListParams(limit, undefined, "next_token")}`,
				"tweets/search/recent",
			);
			const authors = authorIndex(payload);
			const ordered = [...(payload.data ?? [])].sort((a, b) =>
				(a.created_at ?? "").localeCompare(b.created_at ?? ""),
			);
			const body = ordered.length === 0 ? empty : ordered.map(tweet => formatTweetLine(tweet, authors)).join("\n");
			return {
				content: [
					{ type: "text" as const, text: `Conversation ${conversationId} — ${ordered.length} post(s)\n${body}` },
				],
			};
		},
	};
}

function createUserLookupTool(): ToolDefinition<typeof userLookupSchema> {
	return {
		name: "x_user_lookup",
		label: "X: Profile",
		description:
			"Look up a public X profile by handle — display name, bio, verified status, follower/following/post counts, account age, and the numeric id other tools need.",
		parameters: userLookupSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof userLookupSchema.infer) {
			const name = handle(params.username);
			const payload = await xJson<{ data?: XUser }>(
				`/users/by/username/${encodeURIComponent(name)}?user.fields=${USER_FIELDS}`,
				"users/by/username",
			);
			const user = payload.data;
			if (!user) return { content: [{ type: "text" as const, text: `No X account found for @${name}.` }] };
			const m = user.public_metrics;
			const lines = [
				`@${user.username ?? name}  ${user.name ?? ""}${user.verified ? "  ✓" : ""}  [id ${user.id}]`,
				`Followers: ${m?.followers_count ?? "?"}  Following: ${m?.following_count ?? "?"}  Posts: ${m?.tweet_count ?? "?"}`,
				user.created_at ? `Joined: ${user.created_at.slice(0, 10)}` : "",
				user.description ? `Bio: ${oneLine(user.description)}` : "",
			];
			return { content: [{ type: "text" as const, text: lines.filter(Boolean).join("\n") }] };
		},
	};
}

function createBookmarksTool(): ToolDefinition<typeof bookmarksSchema> {
	return {
		name: "x_bookmarks",
		label: "X: Bookmarks",
		description:
			"The connected account's bookmarked posts, newest first — the user's own saved-for-later reading list. Cheap: an owned read at $0.001 per post. Requires the bookmark.read scope.",
		parameters: bookmarksSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof bookmarksSchema.infer) {
			const user = await me();
			const limit = clampLimit(params.limit, 20, 100);
			const payload = await xJson<XListResponse>(
				`/users/${user.id}/bookmarks?${tweetListParams(limit, params.cursor, "pagination_token")}`,
				"users/bookmarks",
			);
			return { content: [{ type: "text" as const, text: renderTweetList(payload, "No bookmarks.") }] };
		},
	};
}

function createUsageTool(): ToolDefinition<typeof emptySchema> {
	return {
		name: "x_usage",
		label: "X: Usage",
		description:
			"This app's official post-read consumption against its monthly cap, and the day the cap resets. Every x_* read bills this meter. Check it before a search sweep, and to answer 'how much have reads cost?'.",
		parameters: emptySchema,
		approval: "read" as const,
		async execute() {
			const payload = await xJson<{
				data?: {
					project_cap?: string;
					project_usage?: string;
					cap_reset_day?: number;
					project_id?: string;
				};
			}>("/usage/tweets", "usage/tweets");
			const d = payload.data;
			if (!d) return { content: [{ type: "text" as const, text: "X returned no usage for this app." }] };
			const used = Number(d.project_usage ?? 0);
			const cap = Number(d.project_cap ?? 0);
			const pct = cap > 0 ? ` (${((used / cap) * 100).toFixed(1)}%)` : "";
			const lines = [`Official post reads this period: ${used.toLocaleString()} / ${cap.toLocaleString()}${pct}`];
			if (d.cap_reset_day) lines.push(`Cap resets on day ${d.cap_reset_day} of the month.`);
			if (d.project_id) lines.push(`Project: ${d.project_id}`);
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

/** POST /2/tweets, shared by x_post and each rung of x_thread. */
async function publishPost(text: string, replyToId?: string): Promise<XTweet> {
	const body: { text: string; reply?: { in_reply_to_tweet_id: string } } = { text };
	if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId };
	const payload = await xJson<{ data?: XTweet }>("/tweets", "tweets/create", {
		method: "POST",
		body: JSON.stringify(body),
	});
	const created = payload.data;
	if (!created?.id) throw new Error("X accepted the post but returned no id.");
	return created;
}

function createPostTool(): ToolDefinition<typeof postSchema> {
	return {
		name: "x_post",
		label: "X: Post",
		description:
			"Publish a post as the connected account, or a reply when replyTo is set. PUBLIC, IMMEDIATE, and attributed to the user — confirm the exact final text with them in the current turn before calling; there is no draft state and no silent undo. Costs $0.015, or $0.20 when the text contains a URL. REPLY RULE: X's automation policy only permits a programmatic reply when the original author @mentioned or quoted the user — otherwise draft it and let the user send it themselves.",
		parameters: postSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			const replyTo = replyTarget(approvalArg(args, "replyTo"));
			const lines = [approvalAccount()];
			if (replyTo !== undefined) lines.push(`Reply to: ${approvalPostRef(replyTo)}`);
			lines.push(`Text:\n${approvalArg(args, "text") ?? "(missing)"}`);
			return lines;
		},
		async execute(_toolCallId: string, params: typeof postSchema.infer) {
			const text = params.text;
			if (!text.trim()) throw new Error("Refusing to publish an empty post.");
			const replyTo = replyTarget(params.replyTo);
			const replyToId = replyTo ? postId(replyTo) : undefined;
			const created = await publishPost(text, replyToId);
			const user = await me();
			const what = replyToId ? `Replied to ${replyToId}` : "Posted";
			const link = `https://x.com/${user.username ?? "i"}/status/${created.id}`;
			// Report the billing tier at the callsite so cost is visible now, not
			// discovered on an invoice — a URL makes a post 13x more expensive.
			const cost = containsUrl(text)
				? "Cost: $0.20 (posts containing a URL bill at the higher rate)."
				: "Cost: $0.015.";
			const overLimit =
				text.length > STANDARD_POST_LIMIT
					? `\nNote: ${text.length} characters — over the ${STANDARD_POST_LIMIT}-character standard limit. X accepts this only on a Premium account.`
					: "";
			return {
				content: [{ type: "text" as const, text: `${what}.  [${created.id}]\n${link}\n${cost}${overLimit}` }],
			};
		},
	};
}

function createThreadTool(): ToolDefinition<typeof threadSchema> {
	return {
		name: "x_thread",
		label: "X: Post Thread",
		description:
			"Publish several posts as one self-replying thread, in order. PUBLIC and IMMEDIATE — confirm EVERY post's text with the user first. Not atomic: if a later post fails, the earlier ones stay up and the tool reports exactly how far it got so you can continue from there. Each post bills separately ($0.015, or $0.20 with a URL).",
		parameters: threadSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			const raw: unknown = typeof args === "object" && args !== null ? Reflect.get(args, "posts") : undefined;
			if (!Array.isArray(raw)) return [approvalAccount(), "Posts: (missing)"];
			const posts = threadPosts(raw.map(entry => (typeof entry === "string" ? entry : "")));
			return [approvalAccount(), ...posts.map((text, i) => `Post ${i + 1}/${posts.length}:\n${text}`)];
		},
		async execute(_toolCallId: string, params: typeof threadSchema.infer) {
			const posts = threadPosts(params.posts);
			if (posts.length < 2) throw new Error("A thread needs at least two posts — use x_post for a single one.");
			const ids: string[] = [];
			let previous: string | undefined;
			try {
				for (const text of posts) {
					const created = await publishPost(text, previous);
					previous = created.id;
					ids.push(created.id as string);
				}
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Thread partially published: ${ids.length}/${posts.length} posts went out (${ids.join(", ") || "none"}). Post ${ids.length + 1} failed: ${detail}. The published posts are LIVE — continue with x_post replyTo ${previous ?? "the last id"} or delete them with x_delete.`,
				);
			}
			const user = await me();
			const cost = posts.reduce((sum, text) => sum + (containsUrl(text) ? 0.2 : 0.015), 0);
			return {
				content: [
					{
						type: "text" as const,
						text: `Posted a ${posts.length}-post thread.\nhttps://x.com/${user.username ?? "i"}/status/${ids[0]}\nIds: ${ids.join(", ")}\nCost: $${cost.toFixed(3)}.`,
					},
				],
			};
		},
	};
}

function createDeleteTool(): ToolDefinition<typeof deleteSchema> {
	return {
		name: "x_delete",
		label: "X: Delete Post",
		description:
			"Delete one of the connected account's own posts. IRREVERSIBLE — read the post back with x_get_post and confirm the exact id with the user before calling. Deleting a mid-thread post orphans the replies below it.",
		parameters: deleteSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			return [approvalAccount(), `Delete post: ${approvalPostRef(approvalArg(args, "post"))}`];
		},
		async execute(_toolCallId: string, params: typeof deleteSchema.infer) {
			const id = postId(params.post);
			const payload = await xJson<{ data?: { deleted?: boolean } }>(`/tweets/${id}`, "tweets/delete", {
				method: "DELETE",
			});
			const text = payload.data?.deleted ? `Deleted post ${id}.` : `X did not confirm deletion of ${id}.`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createBookmarkTool(): ToolDefinition<typeof bookmarkSchema> {
	return {
		name: "x_bookmark",
		label: "X: Bookmark",
		description:
			"Add or remove a bookmark on a post for the connected account. Private to the account — nothing is published. Requires the bookmark.write scope; adding one bills $0.005.",
		parameters: bookmarkSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof bookmarkSchema.infer) {
			const id = postId(params.post);
			const user = await me();
			if (params.remove) {
				const payload = await xJson<{ data?: { bookmarked?: boolean } }>(
					`/users/${user.id}/bookmarks/${id}`,
					"users/bookmarks/delete",
					{ method: "DELETE" },
				);
				const ok = payload.data?.bookmarked === false;
				return {
					content: [
						{
							type: "text" as const,
							text: ok ? `Removed bookmark on ${id}.` : `X did not confirm removal of ${id}.`,
						},
					],
				};
			}
			const payload = await xJson<{ data?: { bookmarked?: boolean } }>(
				`/users/${user.id}/bookmarks`,
				"users/bookmarks/add",
				{
					method: "POST",
					body: JSON.stringify({ tweet_id: id }),
				},
			);
			const ok = payload.data?.bookmarked === true;
			return {
				content: [
					{ type: "text" as const, text: ok ? `Bookmarked ${id}.` : `X did not confirm the bookmark on ${id}.` },
				],
			};
		},
	};
}

function createDmTool(): ToolDefinition<typeof dmSchema> {
	return {
		name: "x_dm",
		label: "X: Send DM",
		description:
			"Send a direct message to a user. PRIVATE but immediate and unretractable — confirm the recipient handle AND the full text with the user first. Requires the dm.write scope and the app's \"Direct message\" permission. NEVER use for unsolicited outreach: mass or automated DMs violate X's platform rules.",
		parameters: dmSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			const username = approvalArg(args, "username");
			return [
				approvalAccount(),
				`To: ${username === undefined ? "(missing)" : `@${handle(username)}`}`,
				`Text:\n${approvalArg(args, "text") ?? "(missing)"}`,
			];
		},
		async execute(_toolCallId: string, params: typeof dmSchema.infer) {
			if (!params.text.trim()) throw new Error("Refusing to send an empty DM.");
			const name = handle(params.username);
			const lookup = await xJson<{ data?: XUser }>(
				`/users/by/username/${encodeURIComponent(name)}`,
				"users/by/username",
			);
			const recipient = lookup.data?.id;
			if (!recipient) throw new Error(`No X account found for @${name} — nothing was sent.`);
			const payload = await xJson<{ data?: { dm_event_id?: string } }>(
				`/dm_conversations/with/${recipient}/messages`,
				"dm_conversations/messages",
				{ method: "POST", body: JSON.stringify({ text: params.text }) },
			);
			const eventId = payload.data?.dm_event_id ?? "?";
			return {
				content: [{ type: "text" as const, text: `Sent a DM to @${name}.  [event ${eventId}]\nCost: $0.015.` }],
			};
		},
	};
}

/**
 * X plugin. A standard OMP plugin — `skills/`/`rules/` load via OMP's native
 * plugin discovery. This module registers the eleven read and five write tools;
 * the connect flow (dimension.plugin.json's `connect.oauth`) is what obtains
 * and refreshes the user-context credential these tools read.
 */
export default function xExtension(pi: ExtensionAPI): void {
	pi.registerTool(createMeTool());
	pi.registerTool(createMentionsTool());
	pi.registerTool(createMyPostsTool());
	pi.registerTool(createHomeTimelineTool());
	pi.registerTool(createSearchTool());
	pi.registerTool(createPostsEnvelopeTool());
	pi.registerTool(createGetPostTool());
	pi.registerTool(createReadThreadTool());
	pi.registerTool(createUserLookupTool());
	pi.registerTool(createBookmarksTool());
	pi.registerTool(createUsageTool());
	pi.registerTool(createPostTool());
	pi.registerTool(createThreadTool());
	pi.registerTool(createDeleteTool());
	pi.registerTool(createBookmarkTool());
	pi.registerTool(createDmTool());
}
