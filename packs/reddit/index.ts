// Reddit connector — browse the home feed & subreddits, read post/comment
// trees, search, submit posts, comment, vote, read the inbox, and reply, over
// the Reddit OAuth API (https://oauth.reddit.com; https://www.reddit.com/dev/api).
//
// AUTH SHAPE — why `form` + password grant, not the generic `oauth` executor.
// Reddit's token endpoint (https://www.reddit.com/api/v1/access_token) requires
// HTTP Basic auth (client_id:client_secret in the Authorization header) AND a
// unique User-Agent on EVERY request (the token exchange included) or it 429s.
// The engine's generic OAuth executor (packages/engine/src/plugin-oauth.ts)
// instead puts client_id/secret in the POST *body* and sends no User-Agent, and
// its loopback consent flow runs engine-side, not here — so it cannot drive
// Reddit. Following the connect-flow recipe's fallback (and the teams
// client-credentials pattern), the connect `form` collects
// {clientId, clientSecret, username, password} for a Reddit "script" app; this
// extension exchanges them for a bearer token via the OAuth2 *password* grant on
// demand, caches it in memory, and exposes the API as agent tools. Only the
// credentials are stored (CONFIG_TARGET), never logged. There is no engine-side
// `verify` — the exchange happens here, so the FIRST tool call is the real test.
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";

// MUST match `connect.configTarget` in fraym.plugin.json — the connect flow
// (packages/engine/src/plugin-connect.ts) renders the token template there; this
// is the ONLY other place that path is spelled out (a JSON manifest can't share
// a TS constant with this file).
const CONFIG_TARGET = join(homedir(), ".config", "dimension-reddit", "token.json");
const OAUTH_API = "https://oauth.reddit.com";
const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
// Reddit REQUIRES a unique, descriptive User-Agent on every request (a generic
// or shared one is aggressively rate-limited). Built per-account from the
// stored username, in the format Reddit recommends: platform:appid:version.
const PLUGIN_VERSION = "v0.1.0";
// Scopes the tool surface needs (Reddit ties the bearer token to these):
// identity (my_profile), read (feeds/posts/search), submit (posts), vote,
// privatemessages (inbox/reply), history + mysubreddits (feed context).
const OAUTH_SCOPES = "identity read submit vote privatemessages history mysubreddits";
// Re-mint the token this many ms before expiry so a slow request never races a
// token that goes stale mid-flight.
const TOKEN_SKEW_MS = 60_000;
const MAX_BODY_TEXT = 500;
const MAX_COMMENT_TEXT = 400;
// Hard cap on flattened comments so a giant thread stays scannable.
const MAX_COMMENTS = 200;

/** Clamp a caller-supplied limit into [1, max], defaulting when absent. */
function clampLimit(v: number | undefined, def: number, max: number): number {
	return Math.min(Math.max(v ?? def, 1), max);
}

/** Collapse whitespace runs to single spaces and trim — for one-line rendering. */
function oneLine(s: string | undefined): string {
	const t = s ?? "";
	return t.replace(/\s+/g, " ").trim();
}

const storedCredential = type({
	clientId: "string",
	clientSecret: "string",
	username: "string",
	password: "string",
});
type StoredCredential = typeof storedCredential.infer;

async function readCredential(): Promise<StoredCredential> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_TARGET, "utf-8");
	} catch {
		throw new Error(
			"Reddit isn't connected yet. Open the plugin's Connect dialog (Plugins → Reddit → Set up), create a \"script\" app at reddit.com/prefs/apps, and paste the client id/secret plus your Reddit username and password.",
		);
	}
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors) {
		throw new Error(`Reddit's stored credential at ${CONFIG_TARGET} is malformed. Reconnect the plugin.`);
	}
	return parsed;
}

// In-memory bearer-token cache. The password grant returns no refresh token, so
// on expiry we simply re-run the grant from the stored credentials; a 401 clears
// this slot. The User-Agent is derived from the same credential, so it rides
// along in the cache.
//
// KEYED BY CREDENTIAL, not by expiry alone. Module top-level state is process-wide,
// so the slot outlives a session: a user who reconnects mid-process (a new
// account, rotated secret) would otherwise keep acting as the OLD account until
// the token expired — and a wrong-but-valid token never trips the 401 path that
// clears this cache. The fingerprint is the whole stored credential, so any
// change re-mints.
let tokenCache: { access: string; expires: number; userAgent: string; credential: string } | null = null;

/** A valid bearer token + its User-Agent, minting a fresh one via the OAuth2
 *  password grant when the cached one is absent, expired, within the skew, or
 *  was minted from a credential the user has since replaced.
 *
 *  The credential is read on EVERY call, so disconnecting the plugin stops the
 *  tools working at once rather than at the cached token's expiry — that is the
 *  point, but it does mean a credential file that is unreadable right now throws
 *  "isn't connected yet" instead of riding an unexpired token. */
async function getAuth(): Promise<{ token: string; userAgent: string }> {
	const cred = await readCredential();
	// The cache key is the WHOLE parsed credential, taken off the object rather
	// than a hand-listed field set: a field added to `storedCredential` joins the
	// key automatically instead of silently failing to invalidate. Keys sorted so
	// the value depends on the credential's VALUES, not on its file order.
	const fingerprint = JSON.stringify(cred, Object.keys(cred).sort());
	if (tokenCache && tokenCache.credential === fingerprint && Date.now() < tokenCache.expires - TOKEN_SKEW_MS) {
		return { token: tokenCache.access, userAgent: tokenCache.userAgent };
	}
	const userAgent = `dimension:reddit-plugin:${PLUGIN_VERSION} (by /u/${cred.username})`;
	const basic = Buffer.from(`${cred.clientId}:${cred.clientSecret}`).toString("base64");
	const body = new URLSearchParams({
		grant_type: "password",
		username: cred.username,
		password: cred.password,
		scope: OAUTH_SCOPES,
	});
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			Authorization: `Basic ${basic}`,
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
			"User-Agent": userAgent,
		},
		body: body.toString(),
	});
	const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!res.ok || !payload || typeof payload.access_token !== "string") {
		const err = payload && typeof payload.error === "string" ? payload.error : res.statusText;
		// Reddit returns HTTP 200 {"error":"invalid_grant"} for a bad
		// username/password, and 401 for a bad client id/secret.
		if (err === "invalid_grant") {
			throw new Error(
				"Reddit rejected the username/password (invalid_grant). Check the account credentials — and if two-factor auth is on, append the current 6-digit code as password:123456 — then reconnect (Plugins → Reddit → Reconnect).",
			);
		}
		if (res.status === 401 || err === "unauthorized_client") {
			throw new Error(
				"Reddit rejected the client id/secret (401). Verify your script app's client ID and secret on reddit.com/prefs/apps (the id is the short string under the app name), then reconnect (Plugins → Reddit → Reconnect).",
			);
		}
		throw new Error(`Reddit token request failed: ${err}. Reconnect the plugin (Plugins → Reddit → Reconnect).`);
	}
	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
	tokenCache = {
		access: payload.access_token,
		expires: Date.now() + expiresIn * 1000,
		userAgent,
		credential: fingerprint,
	};
	return { token: tokenCache.access, userAgent };
}

async function redditFetch(path: string, init?: RequestInit): Promise<Response> {
	const { token, userAgent } = await getAuth();
	const res = await fetch(`${OAUTH_API}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"User-Agent": userAgent,
			Accept: "application/json",
			...(init?.headers ?? {}),
		},
	});
	if (res.status === 401) {
		// Drop the cached token so the next call re-mints; a persistent 401 means
		// the credentials or scopes are wrong rather than a merely stale token.
		tokenCache = null;
		throw new Error(
			"Reddit rejected the access token (401). The credentials may have changed or lack the needed scope — reconnect (Plugins → Reddit → Reconnect).",
		);
	}
	if (res.status === 429) {
		throw new Error(
			"Reddit rate limit hit (429). Free OAuth apps allow ~60 requests/minute — wait a minute and retry.",
		);
	}
	return res;
}

/** GET a Reddit JSON endpoint. */
async function redditJson<T>(path: string, op: string): Promise<T> {
	const res = await redditFetch(path);
	const payload = (await res.json().catch(() => null)) as (T & { message?: string; error?: unknown }) | null;
	if (!res.ok || !payload) {
		const detail = payload && typeof payload.message === "string" ? payload.message : res.statusText;
		throw new Error(`Reddit ${op} failed: ${detail}`);
	}
	return payload;
}

// Reddit's write endpoints (/api/submit, /api/comment, /api/vote) return HTTP
// 200 with an envelope {json:{errors:[[code,msg,field]],data:{…}}}; a 2xx alone
// does NOT mean success — the errors array must be empty.
interface RedditApiEnvelope {
	readonly json?: {
		readonly errors?: ReadonlyArray<readonly [string, string, string | null]>;
		readonly data?: {
			readonly id?: string;
			readonly name?: string;
			readonly url?: string;
			readonly things?: ReadonlyArray<{
				readonly kind: string;
				readonly data: { readonly id?: string; readonly name?: string };
			}>;
		};
	};
}

/** POST a form-encoded Reddit write endpoint, honoring the errors-on-200 quirk. */
async function redditPostForm(path: string, form: Record<string, string>, op: string): Promise<RedditApiEnvelope> {
	const res = await redditFetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(form).toString(),
	});
	const payload = (await res.json().catch(() => null)) as RedditApiEnvelope | null;
	if (!res.ok || !payload) {
		throw new Error(`Reddit ${op} failed: ${res.statusText}`);
	}
	const errors = payload.json?.errors;
	if (errors && errors.length > 0) {
		const [code, msg] = errors[0];
		throw new Error(`Reddit ${op} failed: ${msg || code}`);
	}
	return payload;
}

interface RedditThing<T> {
	readonly kind: string;
	readonly data: T;
}

interface Listing<T> {
	readonly kind: string;
	readonly data: {
		readonly after?: string | null;
		readonly children: ReadonlyArray<RedditThing<T>>;
	};
}

interface RedditPostData {
	readonly id: string;
	readonly name: string;
	readonly title?: string;
	readonly author?: string;
	readonly subreddit?: string;
	readonly score?: number;
	readonly num_comments?: number;
	readonly selftext?: string;
	readonly url?: string;
	readonly permalink?: string;
	readonly is_self?: boolean;
	readonly over_18?: boolean;
	readonly stickied?: boolean;
	readonly created_utc?: number;
	readonly link_flair_text?: string | null;
}

interface RedditCommentData {
	readonly id: string;
	readonly name: string;
	readonly author?: string;
	readonly body?: string;
	readonly score?: number;
	readonly stickied?: boolean;
	readonly count?: number; // present on "more" things
	readonly replies?: Listing<RedditCommentData> | "" | null;
}

interface RedditMessageData {
	readonly name: string;
	readonly author?: string;
	readonly subject?: string;
	readonly body?: string;
	readonly new?: boolean;
	readonly was_comment?: boolean;
	readonly subreddit?: string | null;
}

interface RedditMe {
	readonly name?: string;
	readonly link_karma?: number;
	readonly comment_karma?: number;
	readonly total_karma?: number;
	readonly created_utc?: number;
	readonly has_mail?: boolean;
	readonly inbox_count?: number;
	readonly is_gold?: boolean;
	readonly is_mod?: boolean;
}

function formatPostLine(p: RedditPostData): string {
	const flags = [p.over_18 ? "NSFW" : null, p.stickied ? "pinned" : null, p.link_flair_text || null]
		.filter(Boolean)
		.join(",");
	const title = oneLine(p.title);
	const sub = p.subreddit ? `r/${p.subreddit}  ` : "";
	return `${p.name}  ${sub}${p.score ?? 0} pts  ${p.num_comments ?? 0} cmts  u/${p.author ?? "—"}${flags ? `  [${flags}]` : ""}  ${title}`;
}

function renderPostListing(listing: Listing<RedditPostData>, emptyMsg: string): string {
	const children = listing.data.children ?? [];
	if (children.length === 0) return emptyMsg;
	const lines = children.map(c => formatPostLine(c.data)).join("\n");
	const after = listing.data.after;
	return after ? `${lines}\n\nafter: ${after}` : lines;
}

function formatPostHeader(p: RedditPostData): string {
	const flags = [p.over_18 ? "NSFW" : null, p.link_flair_text || null].filter(Boolean).join(",");
	const body = p.is_self ? oneLine(p.selftext).slice(0, MAX_BODY_TEXT) : (p.url ?? "");
	const perma = p.permalink ? `https://www.reddit.com${p.permalink}` : "";
	return [
		`${p.name}  r/${p.subreddit ?? "—"}  ${p.score ?? 0} pts  ${p.num_comments ?? 0} cmts  u/${p.author ?? "—"}${flags ? `  [${flags}]` : ""}`,
		p.title ?? "",
		body,
		perma,
	]
		.filter(Boolean)
		.join("\n");
}

/** Depth-first flatten of a comment tree into indented lines; "more" nodes note
 *  how many replies were collapsed rather than fetching them. */
function flattenComments(
	replies: Listing<RedditCommentData> | "" | null | undefined,
	depth: number,
	out: string[],
): void {
	if (!replies || typeof replies === "string") return;
	for (const child of replies.data.children) {
		if (out.length >= MAX_COMMENTS) return;
		if (child.kind === "more") {
			const more = child.data.count ?? 0;
			out.push(`${"  ".repeat(depth)}… (${more} more repl${more === 1 ? "y" : "ies"} collapsed)`);
			continue;
		}
		const c = child.data;
		const text = oneLine(c.body).slice(0, MAX_COMMENT_TEXT);
		const flag = c.stickied ? " [pinned]" : "";
		out.push(`${"  ".repeat(depth)}${c.name}  u/${c.author ?? "—"} (${c.score ?? 0})${flag}: ${text}`);
		flattenComments(c.replies, depth + 1, out);
	}
}

function formatMessageLine(m: RedditMessageData): string {
	const unread = m.new ? "● " : "  ";
	const subject = oneLine(m.subject || (m.was_comment ? "comment reply" : "message"));
	const body = oneLine(m.body).slice(0, MAX_COMMENT_TEXT);
	const ctx = m.subreddit ? ` r/${m.subreddit}` : "";
	return `${unread}${m.name}  u/${m.author ?? "—"}${ctx}  ${subject}: ${body}`;
}

const myFeedSchema = type({
	"sort?": type("'best' | 'hot' | 'new' | 'top' | 'rising'").describe("Feed sort — default best."),
	"time?": type("'hour' | 'day' | 'week' | 'month' | 'year' | 'all'").describe(
		"Time window for sort=top — default day.",
	),
	"limit?": type("number").describe("Max posts, default 25, capped at 100."),
	"after?": type("string").describe(
		"Pagination cursor from a previous call's 'after' line — omit for the first page.",
	),
});

const subredditPostsSchema = type({
	subreddit: type("string").describe("Subreddit name WITHOUT the r/ prefix, e.g. programming."),
	"sort?": type("'hot' | 'new' | 'top' | 'rising' | 'controversial'").describe("Sort — default hot."),
	"time?": type("'hour' | 'day' | 'week' | 'month' | 'year' | 'all'").describe(
		"Time window for top/controversial — default day.",
	),
	"limit?": type("number").describe("Max posts, default 25, capped at 100."),
	"after?": type("string").describe(
		"Pagination cursor from a previous call's 'after' line — omit for the first page.",
	),
});

const readPostSchema = type({
	post: type("string").describe("The post id or t3_ fullname from a feed/search line (e.g. t3_abc123 or abc123)."),
	"subreddit?": type("string").describe("The post's subreddit (without r/) — optional but avoids a redirect."),
	"sort?": type("'best' | 'top' | 'new' | 'controversial' | 'qa'").describe("Comment sort — default best."),
	"limit?": type("number").describe("Max comments to flatten, default 100, capped at 200."),
});

const searchSchema = type({
	query: type("string").describe("Search query text."),
	"subreddit?": type("string").describe("Restrict to this subreddit (without r/); omit for a site-wide search."),
	"sort?": type("'relevance' | 'hot' | 'top' | 'new' | 'comments'").describe("Sort — default relevance."),
	"time?": type("'hour' | 'day' | 'week' | 'month' | 'year' | 'all'").describe("Time window — default all."),
	"limit?": type("number").describe("Max results, default 25, capped at 100."),
	"after?": type("string").describe(
		"Pagination cursor from a previous call's 'after' line — omit for the first page.",
	),
});

/** Posting, commenting, and messaging publish under the user's name to other
 *  people, so they demand a human click in EVERY approval mode — a bare "write"
 *  tier is auto-approved by write and yolo mode. */
const PROMPT_EVERY_MODE = { tier: "write", policy: "prompt" } as const;
// A self post or comment may run to 40k characters; the approval card shows
// the first 4000 and says how much more follows.
const APPROVAL_BODY_CAP = 4000;

/** One string argument off unvalidated tool args, for an approval card, or
 *  undefined when it is not a string. Never throws: the card renders before the
 *  schema checks the call. */
function approvalArg(args: unknown, key: string): string | undefined {
	const value: unknown = typeof args === "object" && args !== null ? Reflect.get(args, key) : undefined;
	if (typeof value !== "string") return undefined;
	return value.length > APPROVAL_BODY_CAP
		? `${value.slice(0, APPROVAL_BODY_CAP)}[…${value.length - APPROVAL_BODY_CAP} more chars]`
		: value;
}

const submitPostSchema = type({
	subreddit: type("string").describe("Target subreddit (without r/)."),
	title: type("string").describe("Post title."),
	"text?": type("string").describe("Body text for a self (text) post. Provide either text OR url, not both."),
	"url?": type("string").describe("URL for a link post. Provide either url OR text, not both."),
	"nsfw?": type("boolean").describe("Mark the post NSFW — default false."),
	"sendReplies?": type("boolean").describe("Send reply notifications to the inbox — default true."),
});

const commentSchema = type({
	parent: type("string").describe("The t3_ (post) or t1_ (comment) fullname to reply to (from a feed/read line)."),
	text: type("string").describe("The comment text — Reddit markdown supported."),
});

const voteSchema = type({
	target: type("string").describe("The t3_ (post) or t1_ (comment) fullname to vote on."),
	dir: type("'up' | 'down' | 'clear'").describe("Vote direction: up (+1), down (-1), or clear (remove your vote)."),
});

const inboxSchema = type({
	"box?": type("'inbox' | 'unread' | 'messages' | 'comments' | 'mentions'").describe(
		"Which inbox view — default inbox.",
	),
	"limit?": type("number").describe("Max items, default 25, capped at 100."),
});

const replyMessageSchema = type({
	message: type("string").describe("The t4_ (private message) or t1_ (comment reply) fullname from reddit_inbox."),
	text: type("string").describe("The reply text — Reddit markdown supported."),
});

const myProfileSchema = type({});

function createMyFeedTool(): ToolDefinition<typeof myFeedSchema> {
	return {
		name: "reddit_my_feed",
		label: "Reddit: My Feed",
		description:
			"Read the connected account's home feed (its subscribed subreddits). sort = best|hot|new|top|rising (default best); for sort=top pass time (hour|day|week|month|year|all). Returns fullname/subreddit/score/comments/author/title per line; paginate with the returned 'after' cursor.",
		parameters: myFeedSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof myFeedSchema.infer) {
			const sort = params.sort ?? "best";
			const limit = clampLimit(params.limit, 25, 100);
			const query = new URLSearchParams({ limit: String(limit), raw_json: "1" });
			if (params.after) query.set("after", params.after);
			if (sort === "top") query.set("t", params.time ?? "day");
			const listing = await redditJson<Listing<RedditPostData>>(`/${sort}?${query.toString()}`, "my_feed");
			const text = renderPostListing(
				listing,
				"No posts in your feed. Subscribe to some subreddits, or use reddit_subreddit_posts for a specific one.",
			);
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createSubredditPostsTool(): ToolDefinition<typeof subredditPostsSchema> {
	return {
		name: "reddit_subreddit_posts",
		label: "Reddit: Subreddit Posts",
		description:
			"List posts in a subreddit. sort = hot|new|top|rising|controversial (default hot); for top/controversial pass time (hour|day|week|month|year|all). Returns fullname/score/comments/author/title per line; paginate with 'after'.",
		parameters: subredditPostsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof subredditPostsSchema.infer) {
			const sort = params.sort ?? "hot";
			const limit = clampLimit(params.limit, 25, 100);
			const query = new URLSearchParams({ limit: String(limit), raw_json: "1" });
			if (params.after) query.set("after", params.after);
			if (sort === "top" || sort === "controversial") query.set("t", params.time ?? "day");
			const listing = await redditJson<Listing<RedditPostData>>(
				`/r/${encodeURIComponent(params.subreddit)}/${sort}?${query.toString()}`,
				"subreddit_posts",
			);
			const text = renderPostListing(
				listing,
				`No posts found in r/${params.subreddit}. Check the subreddit name (without r/) and that it isn't private/banned.`,
			);
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createReadPostTool(): ToolDefinition<typeof readPostSchema> {
	return {
		name: "reddit_read_post",
		label: "Reddit: Read Post",
		description:
			"Read a post and its comment tree, flattened with indentation and truncated for scanning. Pass the post id or t3_ fullname (and optionally its subreddit + comment sort). Returns the post header/body, then comments as `t1_id  u/author (score): text`.",
		parameters: readPostSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof readPostSchema.infer) {
			const id = params.post.replace(/^t3_/, "");
			const sort = params.sort ?? "best";
			const limit = clampLimit(params.limit, 100, 200);
			const query = new URLSearchParams({ sort, limit: String(limit), raw_json: "1" });
			const base = params.subreddit ? `/r/${encodeURIComponent(params.subreddit)}` : "";
			const result = await redditJson<[Listing<RedditPostData>, Listing<RedditCommentData>]>(
				`${base}/comments/${encodeURIComponent(id)}?${query.toString()}`,
				"read_post",
			);
			const postThing = result[0]?.data.children[0];
			if (!postThing) {
				return {
					content: [{ type: "text" as const, text: `Post ${params.post} not found. Check the id and subreddit.` }],
				};
			}
			const header = formatPostHeader(postThing.data);
			const out: string[] = [];
			flattenComments(result[1], 0, out);
			const comments = out.length > 0 ? out.slice(0, limit).join("\n") : "(no comments)";
			return { content: [{ type: "text" as const, text: `${header}\n\n--- comments ---\n${comments}` }] };
		},
	};
}

function createSearchTool(): ToolDefinition<typeof searchSchema> {
	return {
		name: "reddit_search",
		label: "Reddit: Search",
		description:
			"Search Reddit posts. Takes query; optional subreddit (without r/) to scope, sort (relevance|hot|top|new|comments), and time (hour|day|week|month|year|all). Returns fullname/subreddit/score/comments/title per line; paginate with 'after'.",
		parameters: searchSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof searchSchema.infer) {
			const sort = params.sort ?? "relevance";
			const time = params.time ?? "all";
			const limit = clampLimit(params.limit, 25, 100);
			const query = new URLSearchParams({ q: params.query, sort, t: time, limit: String(limit), raw_json: "1" });
			if (params.after) query.set("after", params.after);
			let path: string;
			if (params.subreddit) {
				query.set("restrict_sr", "true");
				path = `/r/${encodeURIComponent(params.subreddit)}/search?${query.toString()}`;
			} else {
				path = `/search?${query.toString()}`;
			}
			const listing = await redditJson<Listing<RedditPostData>>(path, "search");
			const text = renderPostListing(listing, `No results for "${params.query}".`);
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createSubmitPostTool(): ToolDefinition<typeof submitPostSchema> {
	return {
		name: "reddit_submit_post",
		label: "Reddit: Submit Post",
		description:
			"Submit a post to a subreddit — a self (text) post or a link. DESTRUCTIVE — this publishes publicly under the connected account; ALWAYS confirm the subreddit, title, and body/url with the user first. Provide either text OR url. Returns the new post's fullname and url.",
		parameters: submitPostSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			const lines = [
				`Subreddit: r/${approvalArg(args, "subreddit") ?? "(missing)"}`,
				`Title: ${approvalArg(args, "title") ?? "(missing)"}`,
			];
			const url = approvalArg(args, "url");
			const text = approvalArg(args, "text");
			if (url !== undefined) lines.push(`Link: ${url}`);
			if (text !== undefined) lines.push(`Text:\n${text}`);
			if (url === undefined && text === undefined) lines.push("Body: (missing)");
			if (typeof args === "object" && args !== null && Reflect.get(args, "nsfw") === true) lines.push("NSFW: yes");
			return lines;
		},
		async execute(_toolCallId: string, params: typeof submitPostSchema.infer) {
			if (!params.text && !params.url) {
				throw new Error("Provide either text (a self post) or url (a link post).");
			}
			if (params.text && params.url) {
				throw new Error("Provide either text OR url, not both.");
			}
			const form: Record<string, string> = {
				sr: params.subreddit,
				title: params.title,
				kind: params.url ? "link" : "self",
				api_type: "json",
				nsfw: params.nsfw ? "true" : "false",
				sendreplies: params.sendReplies === false ? "false" : "true",
				resubmit: "true",
			};
			if (params.url) form.url = params.url;
			else form.text = params.text ?? "";
			const payload = await redditPostForm("/api/submit", form, "submit_post");
			const data = payload.json?.data;
			const name = data?.name ?? data?.id ?? "?";
			const url = data?.url ?? "";
			return {
				content: [
					{ type: "text" as const, text: `Submitted to r/${params.subreddit} — ${name}${url ? `  ${url}` : ""}` },
				],
			};
		},
	};
}

function createCommentTool(): ToolDefinition<typeof commentSchema> {
	return {
		name: "reddit_comment",
		label: "Reddit: Comment",
		description:
			"Comment on a post or reply to another comment. Pass the parent t3_ (post) or t1_ (comment) fullname and text. DESTRUCTIVE — this publishes publicly under the connected account; ALWAYS confirm the parent and text with the user first. Returns the new comment fullname.",
		parameters: commentSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			return [
				`Reply to: ${approvalArg(args, "parent") ?? "(missing)"}`,
				`Comment:\n${approvalArg(args, "text") ?? "(missing)"}`,
			];
		},
		async execute(_toolCallId: string, params: typeof commentSchema.infer) {
			const payload = await redditPostForm(
				"/api/comment",
				{ thing_id: params.parent, text: params.text, api_type: "json" },
				"comment",
			);
			const thing = payload.json?.data?.things?.[0];
			const name = thing?.data.name ?? thing?.data.id ?? "?";
			return { content: [{ type: "text" as const, text: `Commented on ${params.parent} — ${name}` }] };
		},
	};
}

function createVoteTool(): ToolDefinition<typeof voteSchema> {
	return {
		name: "reddit_vote",
		label: "Reddit: Vote",
		description:
			"Vote on a post or comment. Pass the t3_/t1_ fullname and dir = up|down|clear. WRITE — cast ONLY votes the user explicitly asked for. Reddit's rules forbid vote manipulation, bots, and directed/automated voting; confirm the exact target and direction with the user first.",
		parameters: voteSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof voteSchema.infer) {
			const dirMap = { up: "1", clear: "0", down: "-1" } as const;
			await redditPostForm("/api/vote", { id: params.target, dir: dirMap[params.dir], api_type: "json" }, "vote");
			return { content: [{ type: "text" as const, text: `Voted ${params.dir} on ${params.target}` }] };
		},
	};
}

function createInboxTool(): ToolDefinition<typeof inboxSchema> {
	return {
		name: "reddit_inbox",
		label: "Reddit: Inbox",
		description:
			"Read the connected account's message inbox. box = inbox|unread|messages|comments|mentions (default inbox). Returns `id  u/from  subject: snippet` per line (unread flagged with ●) — the id (a t4_/t1_ fullname) is what reddit_reply_message replies to.",
		parameters: inboxSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof inboxSchema.infer) {
			const box = params.box ?? "inbox";
			const limit = clampLimit(params.limit, 25, 100);
			const query = new URLSearchParams({ limit: String(limit), raw_json: "1" });
			const listing = await redditJson<Listing<RedditMessageData>>(`/message/${box}?${query.toString()}`, "inbox");
			const children = listing.data.children ?? [];
			const text =
				children.length === 0 ? `No items in ${box}.` : children.map(c => formatMessageLine(c.data)).join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createReplyMessageTool(): ToolDefinition<typeof replyMessageSchema> {
	return {
		name: "reddit_reply_message",
		label: "Reddit: Reply to Message",
		description:
			"Reply to a private message or inbox item. Pass the t4_ (private message) or t1_ (comment reply) fullname from reddit_inbox and text. DESTRUCTIVE — sends a real message from the connected account; ALWAYS confirm the recipient/thread and text with the user first.",
		parameters: replyMessageSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			return [
				`Reply to: ${approvalArg(args, "message") ?? "(missing)"}`,
				`Reply:\n${approvalArg(args, "text") ?? "(missing)"}`,
			];
		},
		async execute(_toolCallId: string, params: typeof replyMessageSchema.infer) {
			await redditPostForm(
				"/api/comment",
				{ thing_id: params.message, text: params.text, api_type: "json" },
				"reply_message",
			);
			return { content: [{ type: "text" as const, text: `Replied to ${params.message}` }] };
		},
	};
}

function createMyProfileTool(): ToolDefinition<typeof myProfileSchema> {
	return {
		name: "reddit_my_profile",
		label: "Reddit: My Profile",
		description:
			"Show the connected account's profile — username, link/comment/total karma, account age, and unread-mail flag. Read-only; useful to confirm which account the connector is acting as.",
		parameters: myProfileSchema,
		approval: "read" as const,
		async execute() {
			const me = await redditJson<RedditMe>("/api/v1/me?raw_json=1", "my_profile");
			const created = me.created_utc ? new Date(me.created_utc * 1000).toISOString().slice(0, 10) : "—";
			const lines = [
				`u/${me.name ?? "—"}`,
				`link karma: ${me.link_karma ?? 0}`,
				`comment karma: ${me.comment_karma ?? 0}`,
				`total karma: ${me.total_karma ?? (me.link_karma ?? 0) + (me.comment_karma ?? 0)}`,
				`account since: ${created}`,
				`unread mail: ${me.has_mail ? "yes" : "no"}${me.inbox_count ? ` (${me.inbox_count})` : ""}`,
				me.is_gold ? "premium: yes" : null,
				me.is_mod ? "moderator: yes" : null,
			].filter(Boolean);
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

/**
 * Reddit plugin. A standard OMP plugin — `skills/`/`rules/` load via OMP's native
 * plugin discovery. This module registers the ten Reddit API tools; the connect
 * flow (fraym.plugin.json's `connect.form`) collects the script-app credentials
 * these tools exchange for a bearer token (see the AUTH SHAPE note at the top).
 */
export default function redditExtension(pi: ExtensionAPI): void {
	pi.registerTool(createMyFeedTool());
	pi.registerTool(createSubredditPostsTool());
	pi.registerTool(createReadPostTool());
	pi.registerTool(createSearchTool());
	pi.registerTool(createSubmitPostTool());
	pi.registerTool(createCommentTool());
	pi.registerTool(createVoteTool());
	pi.registerTool(createInboxTool());
	pi.registerTool(createReplyMessageTool());
	pi.registerTool(createMyProfileTool());
}
