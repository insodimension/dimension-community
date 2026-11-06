import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { XReadPost, XSearchPage, XSearchSort } from "./x-reads.js";

export type ResearchDepth = "quick" | "default" | "deep";

export const DEPTH_POSTS: Readonly<Record<ResearchDepth, number>> = { quick: 10, default: 30, deep: 60 };
const POPULAR_DAYS: Readonly<Record<ResearchDepth, number>> = { quick: 3, default: 7, deep: 7 };
const POPULAR_PAGE_POSTS = 10;
const HANDLE_FROM_POSTS = 8;
const HANDLE_MENTION_POSTS = 5;
const RELATED_POSTS = 3;
const MAX_DISCOVERED_AUTHORS = 3;
const MIN_POSTS_TO_DISCOVER = 2;
const MAX_CALLS = 20;
const DAY_MS = 86_400_000;

export interface SearchWindow {
	readonly since?: string;
	readonly until?: string;
}

export type SearchPageFn = (
	query: string,
	limit: number,
	sort: XSearchSort,
	window: SearchWindow,
) => Promise<XSearchPage>;

export interface EnvelopeRequest {
	readonly topic: string;
	readonly queries: readonly string[];
	readonly depth: ResearchDepth;
	readonly handles: readonly string[];
	readonly related: readonly string[];
	readonly days: number;
}

export type EnvelopeLane = "topic" | "from" | "mention" | "related";

export interface EnvelopeRow {
	readonly id: string;
	readonly author_handle: string;
	readonly created_at: string;
	readonly text: string;
	readonly likes: number;
	readonly reposts: number;
	readonly replies: number;
	readonly quotes: number;
}

export interface EnvelopeCall {
	readonly lane: EnvelopeLane;
	readonly handles: readonly string[];
	readonly posts: readonly EnvelopeRow[];
}

export interface XPostsEnvelope {
	readonly schema: "last30days-x-posts/1";
	readonly generated_at: string;
	readonly topic: string;
	readonly window: { readonly from: string; readonly to: string };
	readonly provider: "x-connector";
	readonly status: "ok" | "partial";
	readonly error?: "unavailable";
	readonly calls: readonly EnvelopeCall[];
}

export interface CollectedEnvelope {
	readonly envelope: XPostsEnvelope;
	readonly discovered: readonly string[];
	readonly paidPosts: number;
}

interface PageRequest {
	readonly query: string;
	readonly limit: number;
	readonly sort: XSearchSort;
	readonly window: SearchWindow;
}

interface CallPlan {
	readonly lane: EnvelopeLane;
	readonly handles: readonly string[];
	readonly pages: readonly PageRequest[];
}

function envelopeRow(post: XReadPost): EnvelopeRow | null {
	if (!/^\d+$/.test(post.id) || !post.authorUsername || !post.createdAt || !post.text.trim()) return null;
	return {
		id: post.id,
		author_handle: post.authorUsername,
		created_at: post.createdAt,
		text: post.text,
		likes: post.likeCount ?? 0,
		reposts: post.retweetCount ?? 0,
		replies: post.replyCount ?? 0,
		quotes: post.quoteCount ?? 0,
	};
}

function popularPages(query: string, depth: ResearchDepth, todayMs: number): PageRequest[] {
	return Array.from({ length: POPULAR_DAYS[depth] }, (_, back) => {
		const dayStart = todayMs - back * DAY_MS;
		return {
			query,
			limit: POPULAR_PAGE_POSTS,
			sort: "top" as const,
			window: {
				since: new Date(dayStart).toISOString().slice(0, 10),
				until: new Date(dayStart + DAY_MS).toISOString().slice(0, 10),
			},
		};
	});
}

function discoveredAuthors(posts: readonly XReadPost[], known: ReadonlySet<string>, room: number): string[] {
	const counts = new Map<string, number>();
	for (const post of posts) {
		const author = post.authorUsername;
		if (!author || known.has(author.toLowerCase())) continue;
		counts.set(author, (counts.get(author) ?? 0) + 1);
	}
	return [...counts]
		.filter(([, count]) => count >= MIN_POSTS_TO_DISCOVER)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, Math.min(MAX_DISCOVERED_AUTHORS, Math.max(0, Math.floor(room / 2))))
		.map(([author]) => author);
}

function handleCalls(handles: readonly string[], core: string): CallPlan[] {
	const scope = core ? ` ${core}` : "";
	return handles.flatMap(handle => [
		{
			lane: "from" as const,
			handles: [handle],
			pages: [
				{
					query: `from:${handle}${scope} -is:retweet`,
					limit: HANDLE_FROM_POSTS,
					sort: "recent" as const,
					window: {},
				},
			],
		},
		{
			lane: "mention" as const,
			handles: [handle],
			pages: [
				{
					query: `@${handle}${scope} -is:retweet`,
					limit: HANDLE_MENTION_POSTS,
					sort: "recent" as const,
					window: {},
				},
			],
		},
	]);
}

export async function collectEnvelope(
	request: EnvelopeRequest,
	search: SearchPageFn,
	now: Date,
): Promise<CollectedEnvelope> {
	const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	let paidPosts = 0;
	let failure: unknown;
	let fetched = 0;

	const runCall = async (plan: CallPlan): Promise<{ call: EnvelopeCall; posts: XReadPost[] }> => {
		const unique = new Map<string, XReadPost>();
		for (const page of plan.pages) {
			try {
				const result = await search(page.query, page.limit, page.sort, page.window);
				if (result.backend === "official") paidPosts += result.posts.length;
				for (const post of result.posts) if (!unique.has(post.id)) unique.set(post.id, post);
			} catch (error) {
				failure = error;
			}
		}
		const posts = [...unique.values()];
		const rows = posts.flatMap(post => envelopeRow(post) ?? []);
		fetched += rows.length;
		return { call: { lane: plan.lane, handles: plan.handles, posts: rows }, posts };
	};

	const topicPlans: CallPlan[] = request.queries.map((query, index) => {
		const scoped = query.includes("-is:retweet") ? query : `${query} -is:retweet`;
		const recency: PageRequest = { query: scoped, limit: DEPTH_POSTS[request.depth], sort: "recent", window: {} };
		return {
			lane: "topic",
			handles: [],
			pages: index === 0 ? [recency, ...popularPages(scoped, request.depth, todayMs)] : [recency],
		};
	});
	const namedPlans: CallPlan[] = [
		...handleCalls(request.handles, ""),
		...request.related.map(handle => ({
			lane: "related" as const,
			handles: [handle],
			pages: [{ query: `from:${handle} -is:retweet`, limit: RELATED_POSTS, sort: "recent" as const, window: {} }],
		})),
	];

	const calls: EnvelopeCall[] = [];
	const topicPosts: XReadPost[] = [];
	for (const plan of [...topicPlans, ...namedPlans].slice(0, MAX_CALLS)) {
		const { call, posts } = await runCall(plan);
		calls.push(call);
		if (plan.lane === "topic") topicPosts.push(...posts);
	}

	const known = new Set([...request.handles, ...request.related].map(handle => handle.toLowerCase()));
	const discovered = discoveredAuthors(topicPosts, known, MAX_CALLS - calls.length);
	for (const plan of handleCalls(discovered, request.queries[0] ?? request.topic)) {
		calls.push((await runCall(plan)).call);
	}

	if (fetched === 0 && failure !== undefined) {
		throw failure instanceof Error ? failure : new Error(String(failure));
	}
	return {
		envelope: {
			schema: "last30days-x-posts/1",
			generated_at: now.toISOString(),
			topic: request.topic,
			window: {
				from: new Date(todayMs - request.days * DAY_MS).toISOString().slice(0, 10),
				to: new Date(todayMs).toISOString().slice(0, 10),
			},
			provider: "x-connector",
			...(failure === undefined
				? { status: "ok" as const }
				: { status: "partial" as const, error: "unavailable" as const }),
			calls,
		},
		discovered,
		paidPosts,
	};
}

export async function writeEnvelope(envelope: XPostsEnvelope): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "last30days-x-posts-"));
	const path = join(dir, "x-posts.json");
	await writeFile(path, JSON.stringify(envelope), "utf-8");
	return path;
}
