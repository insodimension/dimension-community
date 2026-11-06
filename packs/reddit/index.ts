import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";

const CONFIG_TARGET = join(homedir(), ".config", "dimension-reddit", "token.json");
const OAUTH_API = "https://oauth.reddit.com";
const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const PLUGIN_VERSION = "v0.2.0";
const APP_ONLY_SCOPE = "read";
const TOKEN_SKEW_MS = 60_000;
const DEFAULT_TOKEN_SECONDS = 3600;
const MAX_BODY_TEXT = 500;
const MAX_COMMENT_TEXT = 400;
const MAX_COMMENTS = 200;
const HOUR_MS = 3_600_000;

function clampLimit(v: number | undefined, def: number, max: number): number {
	return Math.min(Math.max(v ?? def, 1), max);
}

function oneLine(s: string | undefined): string {
	return (s ?? "").replace(/\s+/g, " ").trim();
}

const storedCredential = type({
	clientId: "string",
	clientSecret: "string",
	username: "string",
});
type StoredCredential = typeof storedCredential.infer;

async function readCredential(): Promise<StoredCredential> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_TARGET, "utf-8");
	} catch {
		throw new Error(
			"Reddit isn't connected. Open Plugins → Reddit → Set up and paste the client id and secret of a Reddit app you already own. Reddit closed new app creation on 2025-11-11, so without one, read Reddit through the Browser pack's signed-in profile instead.",
		);
	}
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors) {
		throw new Error(`Reddit's stored credential at ${CONFIG_TARGET} is malformed. Reconnect the plugin.`);
	}
	return parsed;
}

interface CachedToken {
	readonly access: string;
	readonly expires: number;
	readonly userAgent: string;
	readonly credentialKey: string;
}

let tokenCache: CachedToken | null = null;

async function getAuth(): Promise<{ token: string; userAgent: string }> {
	const cred = await readCredential();
	const key = JSON.stringify(cred, Object.keys(cred).sort());
	if (tokenCache && tokenCache.credentialKey === key && Date.now() < tokenCache.expires - TOKEN_SKEW_MS) {
		return { token: tokenCache.access, userAgent: tokenCache.userAgent };
	}
	const userAgent = `dimension:reddit-plugin:${PLUGIN_VERSION} (by /u/${cred.username})`;
	const basic = Buffer.from(`${cred.clientId}:${cred.clientSecret}`).toString("base64");
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			Authorization: `Basic ${basic}`,
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
			"User-Agent": userAgent,
		},
		body: new URLSearchParams({ grant_type: "client_credentials", scope: APP_ONLY_SCOPE }).toString(),
	});
	const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!res.ok || !payload || typeof payload.access_token !== "string") {
		const err = payload && typeof payload.error === "string" ? payload.error : res.statusText;
		if (res.status === 401 || err === "unauthorized_client" || err === "invalid_client") {
			throw new Error(
				"Reddit rejected the client id/secret (401). Check them on reddit.com/prefs/apps (the id is the short string under the app name), then reconnect (Plugins → Reddit → Reconnect). An app Reddit has retired stays refused: read Reddit through the Browser pack instead.",
			);
		}
		throw new Error(`Reddit token request failed: ${err}. Reconnect the plugin (Plugins → Reddit → Reconnect).`);
	}
	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : DEFAULT_TOKEN_SECONDS;
	tokenCache = { access: payload.access_token, expires: Date.now() + expiresIn * 1000, userAgent, credentialKey: key };
	return { token: tokenCache.access, userAgent };
}

async function redditJson<T>(path: string, op: string): Promise<T> {
	const { token, userAgent } = await getAuth();
	const res = await fetch(`${OAUTH_API}${path}`, {
		headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent, Accept: "application/json" },
	});
	if (res.status === 401) {
		tokenCache = null;
		throw new Error(
			"Reddit rejected the access token (401). The app's credentials changed or Reddit retired the app — reconnect (Plugins → Reddit → Reconnect), or read Reddit through the Browser pack.",
		);
	}
	if (res.status === 429) {
		throw new Error(
			"Reddit rate limit hit (429). Reddit allows 100 requests a minute per app, averaged over 10 minutes — stop and wait, never loop.",
		);
	}
	const payload = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
	if (!res.ok || !payload) {
		const detail = payload && typeof payload.message === "string" ? payload.message : res.statusText;
		throw new Error(`Reddit ${op} failed: ${detail}`);
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
	readonly count?: number;
	readonly replies?: Listing<RedditCommentData> | "" | null;
}

export interface RedditUserAbout {
	readonly name?: string;
	readonly link_karma?: number;
	readonly comment_karma?: number;
	readonly total_karma?: number;
	readonly created_utc?: number;
	readonly has_verified_email?: boolean;
	readonly is_suspended?: boolean;
	readonly is_mod?: boolean;
}

function postAge(createdUtc: number | undefined, now: number): string {
	if (createdUtc === undefined) return "age ?";
	const hours = Math.max(0, (now - createdUtc * 1000) / HOUR_MS);
	return hours < 48 ? `${Math.floor(hours)}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function formatPostLine(p: RedditPostData): string {
	const flags = [p.over_18 ? "NSFW" : null, p.stickied ? "pinned" : null, p.link_flair_text || null]
		.filter(Boolean)
		.join(",");
	const sub = p.subreddit ? `r/${p.subreddit}  ` : "";
	return `${p.name}  ${sub}${p.score ?? 0} pts  ${p.num_comments ?? 0} cmts  ${postAge(p.created_utc, Date.now())}  u/${p.author ?? "—"}${flags ? `  [${flags}]` : ""}  ${oneLine(p.title)}`;
}

interface SubredditRule {
	readonly short_name?: string;
	readonly description?: string;
	readonly kind?: string;
}

interface SubredditAbout {
	readonly display_name_prefixed?: string;
	readonly public_description?: string;
	readonly submission_type?: string;
	readonly subreddit_type?: string;
	readonly over18?: boolean;
}

export function renderSubredditRules(
	subreddit: string,
	about: SubredditAbout | undefined,
	rules: readonly SubredditRule[],
): string {
	const header = [
		about?.display_name_prefixed ?? `r/${subreddit}`,
		about?.subreddit_type && about.subreddit_type !== "public" ? about.subreddit_type : null,
		about?.submission_type ? `accepts ${about.submission_type} posts` : null,
		about?.over18 ? "NSFW" : null,
	]
		.filter(Boolean)
		.join("  ");
	const description = oneLine(about?.public_description);
	const ruleLines = rules.map(
		(rule, index) =>
			`${index + 1}. ${oneLine(rule.short_name)}${rule.kind && rule.kind !== "all" ? ` (${rule.kind}s)` : ""}${rule.description ? `: ${oneLine(rule.description).slice(0, MAX_COMMENT_TEXT)}` : ""}`,
	);
	return [
		header,
		...(description ? [description] : []),
		"",
		"Rules:",
		...(ruleLines.length ? ruleLines : ["(none listed; read the sidebar, wiki and pinned posts in the Browser)"]),
	].join("\n");
}

export function renderUserAbout(user: RedditUserAbout, now: number): string {
	if (user.is_suspended) return `u/${user.name ?? "—"}  SUSPENDED`;
	const created = user.created_utc ? new Date(user.created_utc * 1000).toISOString().slice(0, 10) : "—";
	const days = user.created_utc ? Math.floor((now - user.created_utc * 1000) / (24 * HOUR_MS)) : undefined;
	return [
		`u/${user.name ?? "—"}`,
		`account since: ${created}${days !== undefined ? ` (${days} days)` : ""}`,
		`post karma: ${user.link_karma ?? 0}`,
		`comment karma: ${user.comment_karma ?? 0}`,
		`total karma: ${user.total_karma ?? (user.link_karma ?? 0) + (user.comment_karma ?? 0)}`,
		`verified email: ${user.has_verified_email === undefined ? "unknown" : user.has_verified_email ? "yes" : "no"}`,
		...(user.is_mod ? ["moderator: yes"] : []),
	].join("\n");
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
		const flag = c.stickied ? " [pinned]" : "";
		out.push(
			`${"  ".repeat(depth)}${c.name}  u/${c.author ?? "—"} (${c.score ?? 0})${flag}: ${oneLine(c.body).slice(0, MAX_COMMENT_TEXT)}`,
		);
		flattenComments(c.replies, depth + 1, out);
	}
}

function subredditName(input: string): string {
	return input.trim().replace(/^\/?r\//i, "");
}

const subredditPostsSchema = type({
	subreddit: type("string").describe("Subreddit name WITHOUT the r/ prefix, e.g. programming."),
	"sort?": type("'hot' | 'new' | 'top' | 'rising' | 'controversial'").describe("Sort — default hot."),
	"time?": type("'hour' | 'day' | 'week' | 'month' | 'year' | 'all'").describe(
		"Time window for top/controversial — default day.",
	),
	"limit?": type("number").describe("Max posts, default 25, capped at 100."),
	"after?": type("string").describe("Pagination cursor from a previous call's 'after' line — omit for the first page."),
});

const subredditRulesSchema = type({
	subreddit: type("string").describe("Subreddit name WITHOUT the r/ prefix, e.g. unrealengine."),
});

const readPostSchema = type({
	post: type("string").describe("The post id or t3_ fullname from a listing or search line (e.g. t3_abc123 or abc123)."),
	"subreddit?": type("string").describe("The post's subreddit (without r/) — optional but avoids a redirect."),
	"sort?": type("'best' | 'top' | 'new' | 'controversial' | 'qa'").describe("Comment sort — default best."),
	"limit?": type("number").describe("Max comments to flatten, default 100, capped at 200."),
});

const searchSchema = type({
	query: type("string").describe(
		"Search query. Reddit's operators work: author:, flair:, self:, selftext:, site:, subreddit:, title:, url:, quoted phrases, and upper-case AND/OR/NOT with parentheses.",
	),
	"subreddit?": type("string").describe("Restrict to this subreddit (without r/); omit for a site-wide search."),
	"sort?": type("'relevance' | 'hot' | 'top' | 'new' | 'comments'").describe("Sort — default relevance."),
	"time?": type("'hour' | 'day' | 'week' | 'month' | 'year' | 'all'").describe("Time window — default all."),
	"limit?": type("number").describe("Max results, default 25, capped at 100."),
	"after?": type("string").describe("Pagination cursor from a previous call's 'after' line — omit for the first page."),
});

const myProfileSchema = type({});

function createSubredditPostsTool(): ToolDefinition<typeof subredditPostsSchema> {
	return {
		name: "reddit_subreddit_posts",
		label: "Reddit: Subreddit Posts",
		description:
			"List posts in a subreddit. sort = hot|new|top|rising|controversial (default hot); for top/controversial pass time (hour|day|week|month|year|all). Returns fullname/score/comments/age/author/title per line; paginate with 'after'. Score is fuzzed by Reddit.",
		parameters: subredditPostsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof subredditPostsSchema.infer) {
			const name = subredditName(params.subreddit);
			const sort = params.sort ?? "hot";
			const query = new URLSearchParams({ limit: String(clampLimit(params.limit, 25, 100)), raw_json: "1" });
			if (params.after) query.set("after", params.after);
			if (sort === "top" || sort === "controversial") query.set("t", params.time ?? "day");
			const listing = await redditJson<Listing<RedditPostData>>(
				`/r/${encodeURIComponent(name)}/${sort}?${query.toString()}`,
				"subreddit_posts",
			);
			const text = renderPostListing(
				listing,
				`No posts found in r/${name}. Check the subreddit name (without r/) and that it isn't private or banned.`,
			);
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createSubredditRulesTool(): ToolDefinition<typeof subredditRulesSchema> {
	return {
		name: "reddit_subreddit_rules",
		label: "Reddit: Subreddit Rules",
		description:
			"Read a subreddit's rules before drafting anything for it: what kinds of posts it accepts, its description, and every rule with its text (self-promotion, link, AI-content and flair rules live here). Reddit stopped showing member counts in 2025-09, so none are printed; the sidebar, wiki and pinned posts are read in the Browser. Read-only.",
		parameters: subredditRulesSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof subredditRulesSchema.infer) {
			const name = subredditName(params.subreddit);
			const base = `/r/${encodeURIComponent(name)}`;
			const [about, rules] = await Promise.all([
				redditJson<RedditThing<SubredditAbout>>(`${base}/about?raw_json=1`, "subreddit_about"),
				redditJson<{ rules?: readonly SubredditRule[] }>(`${base}/about/rules?raw_json=1`, "subreddit_rules"),
			]);
			return {
				content: [{ type: "text" as const, text: renderSubredditRules(name, about.data, rules.rules ?? []) }],
			};
		},
	};
}

function createReadPostTool(): ToolDefinition<typeof readPostSchema> {
	return {
		name: "reddit_read_post",
		label: "Reddit: Read Post",
		description:
			"Read a post and its comment tree, flattened with indentation and truncated for scanning. Pass the post id or t3_ fullname (and optionally its subreddit and comment sort). Returns the post header and body, then comments as `t1_id  u/author (score): text`. Scores are fuzzed; views and upvote ratio are read on the author's own Insights in the Browser.",
		parameters: readPostSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof readPostSchema.infer) {
			const id = params.post.replace(/^t3_/, "");
			const limit = clampLimit(params.limit, 100, 200);
			const query = new URLSearchParams({ sort: params.sort ?? "best", limit: String(limit), raw_json: "1" });
			const base = params.subreddit ? `/r/${encodeURIComponent(subredditName(params.subreddit))}` : "";
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
			const out: string[] = [];
			flattenComments(result[1], 0, out);
			const comments = out.length > 0 ? out.slice(0, limit).join("\n") : "(no comments)";
			return {
				content: [
					{ type: "text" as const, text: `${formatPostHeader(postThing.data)}\n\n--- comments ---\n${comments}` },
				],
			};
		},
	};
}

function createSearchTool(): ToolDefinition<typeof searchSchema> {
	return {
		name: "reddit_search",
		label: "Reddit: Search",
		description:
			"Search Reddit posts. Takes query (Reddit's operators: author:, flair:, self:, selftext:, site:, subreddit:, title:, url:, quoted phrases, AND/OR/NOT); optional subreddit (without r/) to scope, sort (relevance|hot|top|new|comments), and time (hour|day|week|month|year|all). Returns fullname/subreddit/score/comments/title per line; paginate with 'after'.",
		parameters: searchSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof searchSchema.infer) {
			const query = new URLSearchParams({
				q: params.query,
				sort: params.sort ?? "relevance",
				t: params.time ?? "all",
				limit: String(clampLimit(params.limit, 25, 100)),
				raw_json: "1",
			});
			if (params.after) query.set("after", params.after);
			if (params.subreddit) query.set("restrict_sr", "true");
			const path = params.subreddit
				? `/r/${encodeURIComponent(subredditName(params.subreddit))}/search?${query.toString()}`
				: `/search?${query.toString()}`;
			const listing = await redditJson<Listing<RedditPostData>>(path, "search");
			return { content: [{ type: "text" as const, text: renderPostListing(listing, `No results for "${params.query}".`) }] };
		},
	};
}

function createMyProfileTool(): ToolDefinition<typeof myProfileSchema> {
	return {
		name: "reddit_my_profile",
		label: "Reddit: My Profile",
		description:
			"The connected username's public profile: account age, post and comment karma, verified email, and SUSPENDED when Reddit has suspended it. The account-readiness read before drafting for a subreddit. A profile that loads here can still be shadowbanned in a subreddit: check one comment's permalink logged out in the Browser.",
		parameters: myProfileSchema,
		approval: "read" as const,
		async execute() {
			const { username } = await readCredential();
			const about = await redditJson<RedditThing<RedditUserAbout>>(
				`/user/${encodeURIComponent(username)}/about?raw_json=1`,
				"user_about",
			);
			return { content: [{ type: "text" as const, text: renderUserAbout(about.data, Date.now()) }] };
		},
	};
}

export default function redditExtension(pi: ExtensionAPI): void {
	pi.registerTool(createSubredditPostsTool());
	pi.registerTool(createSubredditRulesTool());
	pi.registerTool(createReadPostTool());
	pi.registerTool(createSearchTool());
	pi.registerTool(createMyProfileTool());
}
