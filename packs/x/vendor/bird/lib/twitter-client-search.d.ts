// Hand-written declarations for the vendored bird subset (plain JS upstream).
import type { TwitterClientBase, TwitterClientOptions } from "./twitter-client-base.js";

export interface BirdAuthor {
	readonly username?: string;
	readonly name?: string;
}

/** One post as `mapTweetResult` emits it (twitter-client-utils.js). */
export interface BirdTweet {
	readonly id?: string;
	readonly text?: string;
	/** Twitter's legacy format, e.g. "Wed Aug 03 11:22:33 +0000 2026" — NOT ISO. */
	readonly createdAt?: string;
	readonly replyCount?: number;
	readonly retweetCount?: number;
	readonly likeCount?: number;
	readonly quoteCount?: number;
	readonly conversationId?: string;
	readonly inReplyToStatusId?: string;
	readonly author?: BirdAuthor;
	readonly authorId?: string;
}

export interface BirdSearchOptions {
	readonly cursor?: string | undefined;
	readonly maxPages?: number | undefined;
	readonly includeRaw?: boolean | undefined;
	readonly product?: "Latest" | "Top" | undefined;
}

export interface BirdSearchResult {
	readonly success: boolean;
	readonly tweets: readonly BirdTweet[];
	readonly nextCursor?: string;
	readonly error?: string;
}

export interface BirdSearchClient {
	search(query: string, count?: number, options?: BirdSearchOptions): Promise<BirdSearchResult>;
}

/** Mixin adding `search`/`searchPaged` (SearchTimeline) to the base client. */
export declare function withSearch(
	base: typeof TwitterClientBase,
): new (options: TwitterClientOptions) => BirdSearchClient;
