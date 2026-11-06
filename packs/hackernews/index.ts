import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";

const ALGOLIA = "https://hn.algolia.com/api/v1";
const FIREBASE = "https://hacker-news.firebaseio.com/v0";
const SITE = "https://news.ycombinator.com";
const ALGOLIA_HIT_CAP = 1000;
const DAY_S = 86_400;
const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

interface AlgoliaHit {
	objectID: string;
	title?: string | null;
	url?: string | null;
	author?: string | null;
	points?: number | null;
	num_comments?: number | null;
	created_at?: string;
	created_at_i?: number;
	story_id?: number | null;
	parent_id?: number | null;
	story_title?: string | null;
	comment_text?: string | null;
	story_text?: string | null;
}

interface AlgoliaPage {
	hits: AlgoliaHit[];
	nbHits: number;
	page: number;
	nbPages: number;
}

interface AlgoliaNode {
	id: number;
	author: string | null;
	text: string | null;
	created_at_i: number;
	children: AlgoliaNode[];
}

interface FirebaseItem {
	id: number;
	type?: string;
	by?: string;
	time?: number;
	title?: string;
	url?: string;
	text?: string;
	score?: number;
	descendants?: number;
	kids?: number[];
	parent?: number;
	dead?: boolean;
	deleted?: boolean;
}

interface FirebaseUser {
	id: string;
	created: number;
	karma: number;
	about?: string;
	submitted?: number[];
}

export const FRONT_LISTS = ["top", "new", "best", "show", "ask", "job"] as const;
type FrontList = (typeof FRONT_LISTS)[number];

async function getJson<T>(url: string, what: string): Promise<T> {
	let res: Response;
	try {
		res = await fetch(url, { headers: { Accept: "application/json" } });
	} catch (error) {
		throw new Error(
			`Hacker News ${what} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (res.status === 429) {
		throw new Error(
			`Hacker News ${what} is rate limited (429). Algolia allows about 10,000 requests an hour per IP; wait and retry.`,
		);
	}
	if (!res.ok) throw new Error(`Hacker News ${what} failed: HTTP ${res.status}`);
	return (await res.json()) as T;
}

export function plainText(html: string | null | undefined): string {
	return (html ?? "")
		.replace(/<a\s[^>]*href="([^"]*)"[^>]*>.*?<\/a>/gis, "$1")
		.replace(/<p>/gi, " ¶ ")
		.replace(/<[^>]+>/g, "")
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
		.replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
		.replace(/\s+/g, " ")
		.trim();
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function day(unixSeconds: number | undefined): string {
	return unixSeconds === undefined ? "?" : new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function age(unixSeconds: number | undefined, nowSeconds: number): string {
	if (unixSeconds === undefined) return "?";
	const hours = Math.max(0, Math.floor((nowSeconds - unixSeconds) / 3600));
	return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function hostOf(url: string | null | undefined): string {
	if (!url) return "";
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function unixOf(value: string, field: string): number {
	const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
	if (Number.isNaN(ms)) throw new Error(`${field} "${value}" is not a date. Use YYYY-MM-DD or an ISO time.`);
	return Math.floor(ms / 1000);
}

export function itemIdOf(raw: string | number): number {
	const text = String(raw).trim();
	const fromUrl = /[?&]id=(\d+)/.exec(text)?.[1];
	const id = Number(fromUrl ?? text);
	if (!Number.isInteger(id) || id <= 0) throw new Error(`"${raw}" is not a Hacker News item id or item URL.`);
	return id;
}

export function exactQuery(query: string): string {
	if (query.includes('"')) return query;
	return query
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map(term => (term.startsWith("-") ? term : `"${term}"`))
		.join(" ");
}

function storyLine(hit: AlgoliaHit): string {
	const host = hostOf(hit.url);
	return [
		hit.objectID,
		`${hit.points ?? 0}p`,
		`${hit.num_comments ?? 0}c`,
		day(hit.created_at_i),
		hit.author ?? "?",
		`${hit.title ?? "(untitled)"}${host ? ` (${host})` : ""}`,
	].join("  ");
}

function pageFooter(page: AlgoliaPage, shown: number): string[] {
	const lines = [
		`~${page.nbHits.toLocaleString("en-US")} hits (Algolia's estimate); page ${page.page} of ${Math.max(page.nbPages, 1)} (0-based), ${shown} shown.`,
	];
	if (page.nbHits > ALGOLIA_HIT_CAP) {
		lines.push(
			`Algolia serves at most ${ALGOLIA_HIT_CAP.toLocaleString("en-US")} hits per query; split the window with since/until to reach the rest.`,
		);
	}
	return lines;
}

const searchSchema = type({
	query: type("string").describe(
		"Words to find. Each bare word is quoted (exact, no typo or prefix matching) unless exact is false or the query already has quotes. -word excludes.",
	),
	"exact?": type("boolean").describe("Quote each bare word (default true). Set false for Algolia's fuzzy matching."),
	"kind?": type("'story' | 'comment' | 'show_hn' | 'ask_hn' | 'front_page' | 'poll' | 'job' | 'all'").describe(
		"What to search (default story).",
	),
	"author?": type("string").describe("Only items by this HN username (case-sensitive)."),
	"sort?": type("'relevance' | 'date'").describe("relevance (default) or newest first."),
	"since?": type("string").describe("Only items created on or after this date (YYYY-MM-DD or ISO)."),
	"until?": type("string").describe("Only items created before this date (YYYY-MM-DD or ISO)."),
	"minPoints?": type("number").describe("Only stories with at least this many points."),
	"minComments?": type("number").describe("Only stories with at least this many comments."),
	"limit?": type("number").describe("Hits per page, 1-100 (default 20)."),
	"page?": type("number").describe("0-based page from a previous call's footer."),
});

const itemSchema = type({
	item: type("string | number").describe("Item id or a news.ycombinator.com/item?id= URL."),
	"maxComments?": type("number").describe("Comments to show, 0-300 (default 60). Top-level order is HN's own rank."),
	"maxDepth?": type("number").describe("Reply depth to show, 1-10 (default 4)."),
});

const userSchema = type({
	username: type("string").describe("HN username (case-sensitive)."),
});

const frontSchema = type({
	"list?": type("'top' | 'new' | 'best' | 'show' | 'ask' | 'job'").describe(
		"Which list (default top; show is /show, the Show HN page).",
	),
	"limit?": type("number").describe("Rows to show, 1-100 (default 30)."),
	"find?": type("string | number").describe(
		"An item id or URL: report its rank on this list (searched across the whole list, up to 500).",
	),
});

const domainSchema = type({
	target: type("string").describe(
		"A domain (example.com) or a full URL. A URL with a path matches that exact page; a domain matches every page on it and its subdomains.",
	),
	"limit?": type("number").describe("Stories per page, 1-100 (default 50)."),
	"page?": type("number").describe("0-based page."),
});

const threadSinceSchema = type({
	story: type("string | number").describe("The story's item id or URL."),
	"since?": type("string | number").describe(
		"The cursor from the previous call (unix seconds) or a date/ISO time. Absent = the newest comments.",
	),
	"limit?": type("number").describe("Comments to return, 1-200 (default 50)."),
});

function algoliaUrl(endpoint: "search" | "search_by_date", params: Record<string, string>): string {
	return `${ALGOLIA}/${endpoint}?${new URLSearchParams(params).toString()}`;
}

function createSearchTool(): ToolDefinition<typeof searchSchema> {
	return {
		name: "hn_search",
		label: "HN: Search",
		description:
			"Search Hacker News stories or comments through Algolia (keyless). Words are quoted by default because Algolia otherwise fuzzes and prefix-matches. Filters: kind, author, since/until, minPoints, minComments; sort relevance or date. Returns id/points/comments/date/author/title (domain) per story, id/story/date/author/text per comment, and the hit estimate. A query tops out at 1,000 hits: narrow since/until for more.",
		parameters: searchSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof searchSchema.infer) {
			const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
			const kind = params.kind ?? "story";
			const tags = [kind === "all" ? "" : kind, params.author ? `author_${params.author}` : ""]
				.filter(Boolean)
				.join(",");
			const numeric = [
				params.since ? `created_at_i>=${unixOf(params.since, "since")}` : "",
				params.until ? `created_at_i<${unixOf(params.until, "until")}` : "",
				params.minPoints !== undefined ? `points>=${params.minPoints}` : "",
				params.minComments !== undefined ? `num_comments>=${params.minComments}` : "",
			].filter(Boolean);
			const query: Record<string, string> = {
				query: params.exact === false ? params.query : exactQuery(params.query),
				hitsPerPage: String(limit),
				page: String(Math.max(params.page ?? 0, 0)),
			};
			if (tags) query.tags = tags;
			if (numeric.length > 0) query.numericFilters = numeric.join(",");
			const page = await getJson<AlgoliaPage>(
				algoliaUrl(params.sort === "date" ? "search_by_date" : "search", query),
				"search",
			);
			const lines =
				page.hits.length === 0
					? [`No hits for ${query.query}.`]
					: page.hits.map(hit =>
							hit.comment_text
								? [
										hit.objectID,
										`on ${hit.story_id ?? "?"}`,
										day(hit.created_at_i),
										hit.author ?? "?",
										clip(plainText(hit.comment_text), 240),
									].join("  ")
								: storyLine(hit),
						);
			lines.push("", `Query sent: ${query.query}`, ...pageFooter(page, page.hits.length));
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function flatten(
	nodes: readonly AlgoliaNode[],
	depth: number,
	maxDepth: number,
	budget: { left: number; hidden: number },
	out: string[],
): void {
	for (const node of nodes) {
		if (node.author === null && node.text === null) continue;
		if (budget.left <= 0 || depth > maxDepth) {
			budget.hidden += 1 + countNodes(node.children);
			continue;
		}
		budget.left -= 1;
		out.push(
			`${"  ".repeat(depth - 1)}${node.id}  ${node.author ?? "[deleted]"}  ${day(node.created_at_i)}: ${clip(plainText(node.text), 300)}`,
		);
		flatten(node.children, depth + 1, maxDepth, budget, out);
	}
}

function countNodes(nodes: readonly AlgoliaNode[]): number {
	let total = 0;
	for (const node of nodes) total += 1 + countNodes(node.children);
	return total;
}

export function rankedChildren(children: readonly AlgoliaNode[], kids: readonly number[] | undefined): AlgoliaNode[] {
	const rank = new Map((kids ?? []).map((id, index) => [id, index]));
	return [...children].sort(
		(a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
	);
}

function createItemTool(): ToolDefinition<typeof itemSchema> {
	return {
		name: "hn_item",
		label: "HN: Item",
		description:
			"Read one Hacker News item: a story (points, comments, date, dead/deleted flags, url, text) and its comment tree, top-level comments in HN's own rank order, replies indented. Takes an id or item URL; for a comment it also names the parent and story.",
		parameters: itemSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof itemSchema.infer) {
			const id = itemIdOf(params.item);
			const [item, tree] = await Promise.all([
				getJson<FirebaseItem | null>(`${FIREBASE}/item/${id}.json`, "item"),
				getJson<AlgoliaNode>(`${ALGOLIA}/items/${id}`, "item tree").catch(() => null),
			]);
			if (!item) throw new Error(`Hacker News has no item ${id}.`);
			const flags = [item.dead ? "[dead]" : "", item.deleted ? "[deleted]" : ""].filter(Boolean).join(" ");
			const lines = [
				`${item.type ?? "item"} ${item.id} by ${item.by ?? "?"}  ${item.score ?? 0} points  ${item.descendants ?? 0} comments  ${new Date((item.time ?? 0) * 1000).toISOString()}${flags ? `  ${flags}` : ""}`,
			];
			if (item.title) lines.push(item.title);
			if (item.url) lines.push(item.url);
			if (item.text) lines.push(clip(plainText(item.text), 2000));
			if (item.parent !== undefined) lines.push(`Reply to ${item.parent}`);
			lines.push(`${SITE}/item?id=${item.id}`);
			const maxComments = Math.min(Math.max(params.maxComments ?? 60, 0), 300);
			if (tree && tree.children.length > 0 && maxComments > 0) {
				const budget = { left: maxComments, hidden: 0 };
				const comments: string[] = [];
				flatten(
					rankedChildren(tree.children, item.kids),
					1,
					Math.min(Math.max(params.maxDepth ?? 4, 1), 10),
					budget,
					comments,
				);
				lines.push("", "Comments:", ...comments);
				if (budget.hidden > 0) lines.push(`(${budget.hidden} more not shown; raise maxComments or maxDepth)`);
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function createUserTool(): ToolDefinition<typeof userSchema> {
	return {
		name: "hn_user",
		label: "HN: User",
		description:
			"Read a Hacker News account for a launch preflight: created date and age in days, karma, story/comment/Show HN counts, Show HNs in the last 365 days with their dates and points, and the about text.",
		parameters: userSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof userSchema.infer) {
			const name = params.username.trim().replace(/^@/, "");
			const author = `author_${name}`;
			const [user, stories, comments, shows] = await Promise.all([
				getJson<FirebaseUser | null>(`${FIREBASE}/user/${encodeURIComponent(name)}.json`, "user"),
				getJson<AlgoliaPage>(algoliaUrl("search", { tags: `story,${author}`, hitsPerPage: "0" }), "user stories"),
				getJson<AlgoliaPage>(
					algoliaUrl("search", { tags: `comment,${author}`, hitsPerPage: "0" }),
					"user comments",
				),
				getJson<AlgoliaPage>(
					algoliaUrl("search_by_date", { tags: `show_hn,${author}`, hitsPerPage: "20" }),
					"user Show HN",
				),
			]);
			if (!user) throw new Error(`Hacker News has no user "${name}" (usernames are case-sensitive).`);
			const now = Math.floor(Date.now() / 1000);
			const recentShows = shows.hits.filter(hit => (hit.created_at_i ?? 0) >= now - 365 * DAY_S);
			const lines = [
				`${user.id}  karma ${user.karma.toLocaleString("en-US")}  joined ${day(user.created)} (${Math.floor((now - user.created) / DAY_S)} days ago)`,
				`Stories: ${stories.nbHits}  Comments: ${comments.nbHits}  Show HN: ${shows.nbHits} (${recentShows.length} in the last 365 days)`,
			];
			if (recentShows.length > 0) lines.push("Show HN, last 365 days:", ...recentShows.map(storyLine));
			if (user.about) lines.push(`About: ${clip(plainText(user.about), 600)}`);
			lines.push(`${SITE}/user?id=${encodeURIComponent(user.id)}`);
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function createFrontTool(): ToolDefinition<typeof frontSchema> {
	return {
		name: "hn_front",
		label: "HN: Front",
		description:
			"Read a live Hacker News list with rank positions: top (the front page), new, best, show (/show), ask or job. Pass find with an item id to get where that item ranks on the list right now (up to 500 deep).",
		parameters: frontSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof frontSchema.infer) {
			const list: FrontList = params.list ?? "top";
			const ids = await getJson<number[]>(`${FIREBASE}/${list}stories.json`, `${list} list`);
			const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);
			const items = await Promise.all(
				ids.slice(0, limit).map(id => getJson<FirebaseItem | null>(`${FIREBASE}/item/${id}.json`, "item")),
			);
			const now = Math.floor(Date.now() / 1000);
			const lines: string[] = [];
			if (params.find !== undefined) {
				const target = itemIdOf(params.find);
				const at = ids.indexOf(target);
				lines.push(
					at >= 0
						? `Item ${target} is #${at + 1} of ${ids.length} on ${list}.`
						: `Item ${target} is not in the ${ids.length} items on ${list}.`,
					"",
				);
			}
			items.forEach((item, index) => {
				if (!item) return;
				const host = hostOf(item.url);
				lines.push(
					`${index + 1}. ${item.id}  ${item.score ?? 0}p  ${item.descendants ?? 0}c  ${age(item.time, now)}  ${item.by ?? "?"}  ${item.title ?? ""}${host ? ` (${host})` : ""}`,
				);
			});
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

export function domainTarget(raw: string): { domain: string; page?: string } {
	const text = raw.trim();
	const url = (() => {
		try {
			return new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
		} catch {
			throw new Error(`"${raw}" is not a domain or URL.`);
		}
	})();
	const domain = url.hostname.replace(/^www\./, "").toLowerCase();
	const path = `${url.pathname.replace(/\/+$/, "")}${url.search}`;
	return path ? { domain, page: `${domain}${path}` } : { domain };
}

function pageKey(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
	} catch {
		return "";
	}
}

function createDomainTool(): ToolDefinition<typeof domainSchema> {
	return {
		name: "hn_domain",
		label: "HN: Domain",
		description:
			"Every Hacker News story submitted for a domain or one URL, newest first, with points and comments: the 'has this been posted before' and 'how did our site do' check. Matches the domain and its subdomains; a URL with a path matches that page only.",
		parameters: domainSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof domainSchema.infer) {
			const target = domainTarget(params.target);
			const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
			const page = await getJson<AlgoliaPage>(
				algoliaUrl("search_by_date", {
					query: target.page ?? target.domain,
					restrictSearchableAttributes: "url",
					tags: "story",
					hitsPerPage: String(limit),
					page: String(Math.max(params.page ?? 0, 0)),
				}),
				"domain search",
			);
			const matches = page.hits.filter(hit => {
				const host = hostOf(hit.url).toLowerCase();
				if (host !== target.domain && !host.endsWith(`.${target.domain}`)) return false;
				return target.page === undefined || pageKey(hit.url ?? "") === target.page;
			});
			const best = matches.reduce((top, hit) => Math.max(top, hit.points ?? 0), 0);
			const lines =
				matches.length === 0
					? [`No Hacker News stories for ${target.page ?? target.domain} on this page.`]
					: [
							`${matches.length} stories for ${target.page ?? target.domain} on this page; best ${best} points.`,
							...matches.map(storyLine),
						];
			lines.push("", ...pageFooter(page, matches.length));
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function createThreadSinceTool(): ToolDefinition<typeof threadSinceSchema> {
	return {
		name: "hn_thread_since",
		label: "HN: Thread Since",
		description:
			"Launch watch for one story: its points, comment count and rank on top and show right now, and the comments posted after a cursor, oldest first, each with the comment it replies to. Pass the returned cursor next time to get only newer comments. Algolia indexes comments within about a minute.",
		parameters: threadSinceSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof threadSinceSchema.infer) {
			const id = itemIdOf(params.story);
			const since =
				params.since === undefined
					? undefined
					: typeof params.since === "number" || /^\d+$/.test(params.since)
						? Number(params.since)
						: unixOf(params.since, "since");
			const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
			const query: Record<string, string> = {
				tags: `comment,story_${id}`,
				hitsPerPage: String(since === undefined ? limit : ALGOLIA_HIT_CAP),
			};
			if (since !== undefined) query.numericFilters = `created_at_i>${since}`;
			const [story, top, show, page] = await Promise.all([
				getJson<FirebaseItem | null>(`${FIREBASE}/item/${id}.json`, "item"),
				getJson<number[]>(`${FIREBASE}/topstories.json`, "top list"),
				getJson<number[]>(`${FIREBASE}/showstories.json`, "show list"),
				getJson<AlgoliaPage>(algoliaUrl("search_by_date", query), "new comments"),
			]);
			if (!story) throw new Error(`Hacker News has no item ${id}.`);
			const now = Math.floor(Date.now() / 1000);
			const rank = (ids: number[], name: string) =>
				ids.includes(id) ? `#${ids.indexOf(id) + 1} on ${name}` : `not on ${name}`;
			const comments = [...page.hits].sort((a, b) => (a.created_at_i ?? 0) - (b.created_at_i ?? 0)).slice(0, limit);
			const cursor = comments.reduce((latest, hit) => Math.max(latest, hit.created_at_i ?? 0), since ?? 0);
			const waiting = page.nbHits - comments.length;
			const flags = [story.dead ? "[dead]" : "", story.deleted ? "[deleted]" : ""].filter(Boolean).join(" ");
			const lines = [
				`${story.id}  ${story.score ?? 0} points  ${story.descendants ?? 0} comments  ${age(story.time, now)} old  ${rank(top, "top")}, ${rank(show, "show")}${flags ? `  ${flags}` : ""}`,
				story.title ?? "",
				"",
				comments.length === 0
					? since === undefined
						? "No comments yet."
						: "No new comments since the cursor."
					: `${comments.length} ${since === undefined ? "newest" : "new"} comments, oldest first${waiting > 0 ? ` (${waiting} ${since === undefined ? "older" : "newer"} not shown)` : ""}:`,
				...comments.map(
					hit =>
						`${hit.objectID}  ${hit.author ?? "?"}  ${age(hit.created_at_i, now)} ago  ${hit.parent_id === id ? "on the story" : `reply to ${hit.parent_id ?? "?"}`}: ${clip(plainText(hit.comment_text), 300)}`,
				),
				"",
				`Cursor: ${cursor || now}${since !== undefined && waiting > 0 ? " (call again with it for the next comments)" : ""}`,
			];
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

export default function hackerNewsExtension(pi: ExtensionAPI): void {
	pi.registerTool(createSearchTool());
	pi.registerTool(createItemTool());
	pi.registerTool(createUserTool());
	pi.registerTool(createFrontTool());
	pi.registerTool(createDomainTool());
	pi.registerTool(createThreadSinceTool());
}
