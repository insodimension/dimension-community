import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";
import { createLinkCardTool, createPublishTool } from "./publish";
import { authed, publicGet, resolveDid } from "./session";

interface Author {
	did: string;
	handle: string;
	displayName?: string;
}

interface PostView {
	uri: string;
	author: Author;
	record: { text?: string; createdAt?: string };
	replyCount?: number;
	repostCount?: number;
	likeCount?: number;
	quoteCount?: number;
	bookmarkCount?: number;
	labels?: { val: string }[];
}

interface ThreadNode {
	$type?: string;
	post?: PostView;
	parent?: ThreadNode;
	replies?: ThreadNode[];
}

interface ProfileView extends Author {
	description?: string;
	followersCount?: number;
	followsCount?: number;
	postsCount?: number;
	createdAt?: string;
	labels?: { val: string }[];
	associated?: { lists?: number; feedgens?: number; starterPacks?: number };
	pinnedPost?: { uri: string };
}

interface FeedView {
	uri: string;
	creator: Author;
	displayName: string;
	description?: string;
	likeCount?: number;
}

interface StarterPackView {
	uri: string;
	creator: Author;
	record: { name?: string; description?: string };
	joinedWeekCount?: number;
	joinedAllTimeCount?: number;
}

interface Trend {
	displayName: string;
	link: string;
	startedAt: string;
	postCount: number;
	status?: string;
	category?: string;
}

interface Notification {
	uri: string;
	author: Author;
	reason: string;
	reasonSubject?: string;
	record: { text?: string };
	isRead: boolean;
	indexedAt: string;
}

const POST_PATH = /^https?:\/\/(?:www\.)?bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/i;
const AT_POST = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/;

function clip(text: string | undefined, max: number): string {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function webUrl(uri: string, handle?: string): string {
	const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
	if (!match) return uri;
	const [, repo, collection, rkey] = match;
	const who = handle ?? repo;
	if (collection === "app.bsky.feed.post") return `https://bsky.app/profile/${who}/post/${rkey}`;
	if (collection === "app.bsky.feed.generator") return `https://bsky.app/profile/${who}/feed/${rkey}`;
	if (collection === "app.bsky.graph.starterpack") return `https://bsky.app/starter-pack/${who}/${rkey}`;
	return uri;
}

async function postUri(raw: string, dids = new Map<string, Promise<string>>()): Promise<string> {
	const text = raw.trim();
	const parts = POST_PATH.exec(text) ?? AT_POST.exec(text);
	if (!parts)
		throw new Error(
			`"${raw}" is not a Bluesky post. Pass https://bsky.app/profile/<handle>/post/<id> or an at:// post URI.`,
		);
	const [, actor = "", rkey] = parts;
	if (actor.startsWith("did:")) return `at://${actor}/app.bsky.feed.post/${rkey}`;
	const handle = actor.toLowerCase();
	let did = dids.get(handle);
	if (did === undefined) {
		did = resolveDid(handle);
		dids.set(handle, did);
	}
	return `at://${await did}/app.bsky.feed.post/${rkey}`;
}

function postLine(post: PostView): string {
	const labels = (post.labels ?? []).map(label => label.val).filter(value => !value.startsWith("!no-"));
	return [
		`@${post.author.handle}`,
		(post.record.createdAt ?? "").slice(0, 16).replace("T", " "),
		`likes ${post.likeCount ?? 0}  reposts ${post.repostCount ?? 0}  replies ${post.replyCount ?? 0}  quotes ${post.quoteCount ?? 0}  bookmarks ${post.bookmarkCount ?? 0}`,
		clip(post.record.text, 280),
		webUrl(post.uri, post.author.handle),
		labels.length > 0 ? `[labels: ${labels.join(", ")}]` : "",
	]
		.filter(Boolean)
		.join("  ");
}

function textOf(lines: readonly string[]): { content: { type: "text"; text: string }[] } {
	return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

function isoBound(value: string | undefined, field: string): string | undefined {
	if (value === undefined) return undefined;
	const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
	if (Number.isNaN(ms)) throw new Error(`${field} "${value}" is not a date. Use YYYY-MM-DD or an ISO time.`);
	return new Date(ms).toISOString();
}

const limitField = type("number").describe("How many, 1-100 (default 25).");
const cursorField = type("string").describe("The cursor a previous call returned.");

const searchSchema = type({
	query: type("string").describe(
		'Search text. Operators: "exact phrase", -word, #tag, from:handle, mentions:handle, domain:example.com, lang:en, since:/until: dates. Handles lowercase.',
	),
	"sort?": type("'top' | 'latest'").describe("top (default) or latest."),
	"since?": type("string").describe("Only posts on or after this date (YYYY-MM-DD or ISO)."),
	"until?": type("string").describe("Only posts before this date (YYYY-MM-DD or ISO)."),
	"author?": type("string").describe("Only posts by this handle or DID."),
	"mentions?": type("string").describe("Only posts mentioning this handle or DID."),
	"lang?": type("string").describe("Language code, e.g. en."),
	"domain?": type("string").describe("Only posts linking to this domain."),
	"url?": type("string").describe("Only posts linking to this exact URL."),
	"tags?": type("string[]").describe("Only posts with all of these hashtags (without #)."),
	"limit?": limitField,
	"cursor?": cursorField,
});

const getPostsSchema = type({
	posts: type("string[]").describe("1-25 bsky.app post URLs or at:// post URIs."),
});

const threadSchema = type({
	post: type("string").describe("A bsky.app post URL or at:// post URI."),
	"depth?": type("number").describe("Reply depth, 0-10 (default 6)."),
	"parentHeight?": type("number").describe("Parents to show above the post, 0-20 (default 3)."),
});

const quotesSchema = type({
	post: type("string").describe("A bsky.app post URL or at:// post URI."),
	"limit?": limitField,
	"cursor?": cursorField,
});

const profileSchema = type({
	actor: type("string").describe("A handle (brand.com, you.bsky.social) or DID."),
});

const authorFeedSchema = type({
	actor: type("string").describe("A handle or DID."),
	"filter?": type(
		"'posts_with_replies' | 'posts_no_replies' | 'posts_with_media' | 'posts_and_author_threads'",
	).describe("Which posts (default posts_and_author_threads)."),
	"limit?": limitField,
	"cursor?": cursorField,
});

const findFeedsSchema = type({
	query: type("string").describe("Words a feed's name or description holds, e.g. gamedev."),
	"limit?": limitField,
	"cursor?": cursorField,
});

const findPacksSchema = type({
	query: type("string").describe("Words a starter pack's name holds."),
	"limit?": limitField,
	"cursor?": cursorField,
});

const trendsSchema = type({
	"limit?": type("number").describe("How many, 1-25 (default 10)."),
});

const notificationsSchema = type({
	"reasons?": type("('mention' | 'reply' | 'quote' | 'like' | 'repost' | 'follow' | 'starterpack-joined')[]").describe(
		"Only these kinds (default mention, reply, quote).",
	),
	"limit?": limitField,
	"cursor?": cursorField,
});

function limitOf(value: number | undefined): number {
	return Math.min(Math.max(value ?? 25, 1), 100);
}

function createSearchPostsTool(): ToolDefinition<typeof searchSchema> {
	return {
		name: "bluesky_search_posts",
		label: "Bluesky: Search Posts",
		description:
			"Search Bluesky posts as the connected account (Bluesky closed keyless post search). sort top or latest; since/until, author, mentions, lang, domain, url, tags filters; the query also takes from:, mentions:, domain:, lang:, \"phrase\", #tag, -word. Returns each post's metrics, text and link, Bluesky's hit estimate, and a cursor.",
		parameters: searchSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof searchSchema.infer) {
			const reply = await authed<{ posts: PostView[]; hitsTotal?: number; cursor?: string }>(
				"app.bsky.feed.searchPosts",
				{
					appview: true,
					query: {
						q: params.query,
						sort: params.sort ?? "top",
						since: isoBound(params.since, "since"),
						until: isoBound(params.until, "until"),
						author: params.author,
						mentions: params.mentions,
						lang: params.lang,
						domain: params.domain,
						url: params.url,
						tag: params.tags,
						limit: limitOf(params.limit),
						cursor: params.cursor,
					},
				},
			);
			const lines = reply.posts.length === 0 ? ["No posts found."] : reply.posts.map(postLine);
			if (reply.hitsTotal !== undefined)
				lines.push(
					"",
					`~${reply.hitsTotal.toLocaleString("en-US")} matches (Bluesky's estimate, capped at 10,000).`,
				);
			if (reply.cursor) lines.push(`Next cursor: ${reply.cursor}`);
			return textOf(lines);
		},
	};
}

function createGetPostsTool(): ToolDefinition<typeof getPostsSchema> {
	return {
		name: "bluesky_get_posts",
		label: "Bluesky: Posts",
		description:
			"Read up to 25 Bluesky posts by link with their numbers: likes, reposts, replies, quotes, bookmarks. Bluesky has no impressions or views; these counts are all there is. Keyless.",
		parameters: getPostsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof getPostsSchema.infer) {
			if (params.posts.length === 0 || params.posts.length > 25) throw new Error("Pass 1-25 posts.");
			const dids = new Map<string, Promise<string>>();
			const uris = await Promise.all(params.posts.map(raw => postUri(raw, dids)));
			const reply = await publicGet<{ posts: PostView[] }>("app.bsky.feed.getPosts", { uris });
			const found = new Set(reply.posts.map(post => post.uri));
			const missing = uris.filter(uri => !found.has(uri));
			const lines = reply.posts.map(postLine);
			if (missing.length > 0)
				lines.push("", `Not found (deleted, or hidden from logged-out readers): ${missing.join(", ")}`);
			return textOf(lines);
		},
	};
}

function threadLines(node: ThreadNode | undefined, depth: number, out: string[]): void {
	if (!node) return;
	if (!node.post) {
		out.push(`${"  ".repeat(depth)}(${node.$type?.endsWith("blockedPost") ? "blocked" : "not found"})`);
		return;
	}
	out.push(`${"  ".repeat(depth)}${postLine(node.post)}`);
	for (const reply of node.replies ?? []) threadLines(reply, depth + 1, out);
}

function createThreadTool(): ToolDefinition<typeof threadSchema> {
	return {
		name: "bluesky_thread",
		label: "Bluesky: Thread",
		description:
			"Read a Bluesky post in its conversation: the parents above it, the post, and its replies indented, each with metrics and link. Keyless.",
		parameters: threadSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof threadSchema.infer) {
			const uri = await postUri(params.post);
			const reply = await publicGet<{ thread: ThreadNode }>("app.bsky.feed.getPostThread", {
				uri,
				depth: Math.min(Math.max(params.depth ?? 6, 0), 10),
				parentHeight: Math.min(Math.max(params.parentHeight ?? 3, 0), 20),
			});
			const parents: string[] = [];
			for (let parent = reply.thread.parent; parent; parent = parent.parent) {
				parents.unshift(parent.post ? `^ ${postLine(parent.post)}` : "^ (not found or blocked)");
			}
			const body: string[] = [];
			threadLines(reply.thread, 0, body);
			return textOf([...parents, ...(parents.length > 0 ? [""] : []), ...body]);
		},
	};
}

function createQuotesTool(): ToolDefinition<typeof quotesSchema> {
	return {
		name: "bluesky_quotes",
		label: "Bluesky: Quotes",
		description:
			"List the posts that quote a Bluesky post, with their metrics, text and links, and a cursor. Keyless.",
		parameters: quotesSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof quotesSchema.infer) {
			const uri = await postUri(params.post);
			const reply = await publicGet<{ posts: PostView[]; cursor?: string }>("app.bsky.feed.getQuotes", {
				uri,
				limit: limitOf(params.limit),
				cursor: params.cursor,
			});
			const lines = reply.posts.length === 0 ? ["No quotes."] : reply.posts.map(postLine);
			if (reply.cursor) lines.push(`Next cursor: ${reply.cursor}`);
			return textOf(lines);
		},
	};
}

function createProfileTool(): ToolDefinition<typeof profileSchema> {
	return {
		name: "bluesky_profile",
		label: "Bluesky: Profile",
		description:
			"Read a Bluesky account: handle, name, DID, followers, follows, posts, join date, bio, moderation labels, how many lists, feeds and starter packs it made, and its pinned post. Keyless.",
		parameters: profileSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof profileSchema.infer) {
			const profile = await publicGet<ProfileView>("app.bsky.actor.getProfile", {
				actor: params.actor.trim().replace(/^@/, ""),
			});
			const labels = (profile.labels ?? []).map(label => label.val);
			const lines = [
				`@${profile.handle}  ${profile.displayName ?? ""}  [${profile.did}]`,
				`Followers ${profile.followersCount ?? 0}  Follows ${profile.followsCount ?? 0}  Posts ${profile.postsCount ?? 0}  Joined ${(profile.createdAt ?? "?").slice(0, 10)}`,
				`Made: ${profile.associated?.starterPacks ?? 0} starter packs, ${profile.associated?.feedgens ?? 0} feeds, ${profile.associated?.lists ?? 0} lists`,
			];
			if (labels.length > 0) lines.push(`Labels: ${labels.join(", ")}`);
			if (profile.description) lines.push(`Bio: ${clip(profile.description, 500)}`);
			if (profile.pinnedPost) lines.push(`Pinned: ${webUrl(profile.pinnedPost.uri, profile.handle)}`);
			lines.push(`https://bsky.app/profile/${profile.handle}`);
			return textOf(lines);
		},
	};
}

function createAuthorFeedTool(): ToolDefinition<typeof authorFeedSchema> {
	return {
		name: "bluesky_author_feed",
		label: "Bluesky: Author Feed",
		description:
			"Read one account's posts, newest first, with each post's metrics: the way to measure an account's recent posts or study a peer. Reposts are marked. Keyless.",
		parameters: authorFeedSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof authorFeedSchema.infer) {
			const reply = await publicGet<{ feed: { post: PostView; reason?: { $type?: string } }[]; cursor?: string }>(
				"app.bsky.feed.getAuthorFeed",
				{
					actor: params.actor.trim().replace(/^@/, ""),
					filter: params.filter ?? "posts_and_author_threads",
					limit: limitOf(params.limit),
					cursor: params.cursor,
				},
			);
			const lines =
				reply.feed.length === 0
					? ["No posts."]
					: reply.feed.map(
							item => `${item.reason?.$type?.endsWith("reasonRepost") ? "[repost] " : ""}${postLine(item.post)}`,
						);
			if (reply.cursor) lines.push(`Next cursor: ${reply.cursor}`);
			return textOf(lines);
		},
	};
}

function createFindFeedsTool(): ToolDefinition<typeof findFeedsSchema> {
	return {
		name: "bluesky_find_feeds",
		label: "Bluesky: Find Feeds",
		description:
			"Find custom feeds about a topic, most liked first: name, creator, likes, description and link. Feeds are where a niche reads on Bluesky. Keyless; Bluesky marks this endpoint unstable.",
		parameters: findFeedsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof findFeedsSchema.infer) {
			const reply = await publicGet<{ feeds: FeedView[]; cursor?: string }>(
				"app.bsky.unspecced.getPopularFeedGenerators",
				{
					query: params.query,
					limit: limitOf(params.limit),
					cursor: params.cursor,
				},
			);
			const lines =
				reply.feeds.length === 0
					? ["No feeds found."]
					: reply.feeds.map(
							feed =>
								`${feed.displayName}  by @${feed.creator.handle}  likes ${feed.likeCount ?? 0}  ${webUrl(feed.uri, feed.creator.handle)}${feed.description ? `  ${clip(feed.description, 200)}` : ""}`,
						);
			if (reply.cursor) lines.push(`Next cursor: ${reply.cursor}`);
			return textOf(lines);
		},
	};
}

function createFindStarterPacksTool(): ToolDefinition<typeof findPacksSchema> {
	return {
		name: "bluesky_find_starter_packs",
		label: "Bluesky: Find Starter Packs",
		description:
			"Find starter packs by name: creator, people who joined through it this week and all time, description and link. Keyless.",
		parameters: findPacksSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof findPacksSchema.infer) {
			const reply = await publicGet<{ starterPacks: StarterPackView[]; cursor?: string }>(
				"app.bsky.graph.searchStarterPacks",
				{
					q: params.query,
					limit: limitOf(params.limit),
					cursor: params.cursor,
				},
			);
			const lines =
				reply.starterPacks.length === 0
					? ["No starter packs found."]
					: reply.starterPacks.map(
							pack =>
								`${pack.record.name ?? "(unnamed)"}  by @${pack.creator.handle}  joined ${pack.joinedWeekCount ?? 0} this week, ${pack.joinedAllTimeCount ?? 0} all time  ${webUrl(pack.uri, pack.creator.handle)}${pack.record.description ? `  ${clip(pack.record.description, 200)}` : ""}`,
						);
			if (reply.cursor) lines.push(`Next cursor: ${reply.cursor}`);
			return textOf(lines);
		},
	};
}

function createTrendsTool(): ToolDefinition<typeof trendsSchema> {
	return {
		name: "bluesky_trends",
		label: "Bluesky: Trends",
		description:
			"Read what is trending on Bluesky now: topic, post count, when it started, status and category, with a link to its feed. Keyless; Bluesky marks this endpoint unstable.",
		parameters: trendsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof trendsSchema.infer) {
			const reply = await publicGet<{ trends: Trend[] }>("app.bsky.unspecced.getTrends", {
				limit: Math.min(Math.max(params.limit ?? 10, 1), 25),
			});
			const lines =
				reply.trends.length === 0
					? ["No trends returned."]
					: reply.trends.map(
							(trend, index) =>
								`${index + 1}. ${trend.displayName}  ${trend.postCount.toLocaleString("en-US")} posts  since ${trend.startedAt.slice(0, 16).replace("T", " ")}${trend.status ? `  ${trend.status}` : ""}${trend.category ? `  ${trend.category}` : ""}  https://bsky.app${trend.link}`,
						);
			return textOf(lines);
		},
	};
}

function createNotificationsTool(): ToolDefinition<typeof notificationsSchema> {
	return {
		name: "bluesky_my_notifications",
		label: "Bluesky: My Notifications",
		description:
			"Read the connected account's notifications, newest first, split by kind: mentions, replies and quotes by default (also likes, reposts, follows, starter-pack joins). Each line has who, when, read or new, the text, and the link. Does not mark them read.",
		parameters: notificationsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof notificationsSchema.infer) {
			const reply = await authed<{ notifications: Notification[]; cursor?: string }>(
				"app.bsky.notification.listNotifications",
				{
					appview: true,
					query: {
						reasons: params.reasons ?? ["mention", "reply", "quote"],
						limit: limitOf(params.limit),
						cursor: params.cursor,
					},
				},
			);
			const lines =
				reply.notifications.length === 0
					? ["No notifications of these kinds."]
					: reply.notifications.map(item =>
							[
								item.reason,
								item.isRead ? "read" : "NEW",
								item.indexedAt.slice(0, 16).replace("T", " "),
								`@${item.author.handle}`,
								clip(item.record.text, 280),
								item.uri.includes("/app.bsky.feed.post/")
									? webUrl(item.uri, item.author.handle)
									: item.reasonSubject
										? `on ${webUrl(item.reasonSubject)}`
										: "",
							]
								.filter(Boolean)
								.join("  "),
						);
			if (reply.cursor) lines.push(`Next cursor: ${reply.cursor}`);
			return textOf(lines);
		},
	};
}

export default function blueskyExtension(pi: ExtensionAPI): void {
	pi.registerTool(createSearchPostsTool());
	pi.registerTool(createGetPostsTool());
	pi.registerTool(createThreadTool());
	pi.registerTool(createQuotesTool());
	pi.registerTool(createProfileTool());
	pi.registerTool(createAuthorFeedTool());
	pi.registerTool(createFindFeedsTool());
	pi.registerTool(createFindStarterPacksTool());
	pi.registerTool(createTrendsTool());
	pi.registerTool(createNotificationsTool());
	pi.registerTool(createLinkCardTool());
	pi.registerTool(createPublishTool());
}
