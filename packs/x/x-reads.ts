// The FREE read lane — X's own web GraphQL, authenticated with the browser
// cookies the user already has from being logged into x.com.
//
// WHY THIS EXISTS. X went pay-per-use in Feb 2026 and priced reads at
// $0.005 per post returned for search/timelines — so a single 100-result
// research sweep costs $0.50 on the official API. The same read is free
// through the endpoint x.com's own web client uses. `packages/last30days`
// has resolved X reads this way for a while (`scripts/lib/env.py` picks
// xai > bird > xurl); this module brings the same lane to the connector.
//
// WHY READS ONLY. bird's author is explicit, and we follow it verbatim:
// "Strong recommendation: Do not use bird to tweet. You will hit blocks very
// quickly. Use it to read tweets. … or pay for the Twitter API to create
// tweets." Every WRITE in this connector therefore stays on official OAuth,
// always — there is no code path from here to a mutation, by construction:
// this module only ever applies the `withSearch` mixin, so the client object
// it builds has no `createTweet`/`favoriteTweet`/`createBookmark` method to
// call even by mistake. Posting through cookies risks the user's real account,
// which is not ours to spend.
//
// FAILURE POSTURE. Every entry point returns `null` rather than throwing when
// the free lane is unavailable (no cookies, X changed a query id, network
// error). The caller then falls through to the official API, so the connector
// degrades to "costs money" rather than to "broken".
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveCredentials } from "./vendor/bird/lib/cookies.js";
import { TwitterClientBase } from "./vendor/bird/lib/twitter-client-base.js";
import type { BirdSearchClient, BirdTweet } from "./vendor/bird/lib/twitter-client-search.js";
import { withSearch } from "./vendor/bird/lib/twitter-client-search.js";

/** Which lane served (or would serve) a read. */
export type XReadBackend = "bird" | "official";

/** A post normalized across both lanes, so renderers never branch on backend. */
export interface XReadPost {
	readonly id: string;
	readonly text: string;
	readonly authorUsername?: string;
	readonly authorId?: string;
	/** ISO 8601. bird speaks Twitter's legacy date format; converted here. */
	readonly createdAt?: string;
	readonly likeCount?: number;
	readonly replyCount?: number;
	readonly retweetCount?: number;
	readonly conversationId?: string;
}

/** One page of posts plus the lane that produced it. */
export interface XSearchPage {
	readonly backend: XReadBackend;
	readonly posts: readonly XReadPost[];
	readonly nextCursor?: string;
}

/** What the free lane looks like right now — surfaced by `x_usage`. */
export interface XReadLaneStatus {
	/** The lane a read would take at this moment. */
	readonly backend: XReadBackend;
	/** Where the cookies came from ("env", "safari", "chrome", "firefox"), or null. */
	readonly cookieSource: string | null;
	/** One line a human can act on. */
	readonly detail: string;
}

const BACKEND_ENV = "INSO_X_READ_BACKEND";
// The vendored runtime query-id cache defaults to ~/.config/bird/. Point it at
// OUR config dir so the connector never writes into a real bird install's state.
const QUERY_ID_CACHE = join(homedir(), ".config", "dimension-x", "query-ids-cache.json");
// Browser cookie extraction shells out to keychain-backed stores; cap it so a
// tool call can never hang on a locked keychain prompt.
const COOKIE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
// Re-probe cookies at most this often. Extraction is slow and the answer only
// changes when the user logs in/out of x.com.
const LANE_TTL_MS = 5 * 60_000;

const SearchClient = withSearch(TwitterClientBase);

interface LaneCache {
	readonly at: number;
	/** The `INSO_X_READ_BACKEND` value this entry was resolved under. A cached
	 *  answer is only valid for the mode that produced it — without this,
	 *  flipping the env var in a live engine process is silently ignored for
	 *  the whole TTL (found by x-reads.probe.ts). */
	readonly mode: "auto" | "bird" | "official";
	/** Presence-fingerprint of the cookie env vars this entry resolved under.
	 *  The TTL exists to avoid slow BROWSER probing; env cookies are free to
	 *  read, so setting them must take effect at once rather than after 5 min. */
	readonly envKey: string;
	readonly status: XReadLaneStatus;
	readonly client: BirdSearchClient | null;
}
let laneCache: LaneCache | null = null;

interface LaneProbe {
	readonly mode: LaneCache["mode"];
	readonly envKey: string;
	readonly lane: Promise<LaneCache>;
}
let laneProbeInFlight: LaneProbe | null = null;

/** `auto` (default) prefers the free lane and falls back; `official` disables
 *  it entirely; `bird` is a diagnostic pin that does NOT fall back silently. */
function configuredBackend(): "auto" | "bird" | "official" {
	const raw = process.env[BACKEND_ENV]?.trim().toLowerCase();
	return raw === "bird" || raw === "official" ? raw : "auto";
}

/** Twitter's legacy date ("Wed Aug 03 11:22:33 +0000 2026") → ISO, so both
 *  lanes render identically. Returns undefined rather than an Invalid Date. */
function toIso(legacy: string | undefined): string | undefined {
	if (!legacy) return undefined;
	const parsed = Date.parse(legacy);
	return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function normalize(tweet: BirdTweet): XReadPost | null {
	if (!tweet.id) return null;
	const createdAt = toIso(tweet.createdAt);
	return {
		id: tweet.id,
		text: tweet.text ?? "",
		...(tweet.author?.username ? { authorUsername: tweet.author.username } : {}),
		...(tweet.authorId ? { authorId: tweet.authorId } : {}),
		...(createdAt ? { createdAt } : {}),
		...(typeof tweet.likeCount === "number" ? { likeCount: tweet.likeCount } : {}),
		...(typeof tweet.replyCount === "number" ? { replyCount: tweet.replyCount } : {}),
		...(typeof tweet.retweetCount === "number" ? { retweetCount: tweet.retweetCount } : {}),
		...(tweet.conversationId ? { conversationId: tweet.conversationId } : {}),
	};
}

/** Resolve (and cache) the free lane: are usable x.com cookies reachable? */
async function resolveLane(): Promise<LaneCache> {
	const now = Date.now();
	const mode = configuredBackend();
	// Presence, never the values — a cache key must not hold a credential.
	const envKey = `${process.env.X_AUTH_TOKEN ? 1 : 0}${process.env.X_CT0 ? 1 : 0}${process.env.AUTH_TOKEN ? 1 : 0}${process.env.CT0 ? 1 : 0}`;
	if (laneCache && laneCache.mode === mode && laneCache.envKey === envKey && now - laneCache.at < LANE_TTL_MS) {
		return laneCache;
	}
	if (laneProbeInFlight?.mode === mode && laneProbeInFlight.envKey === envKey) return laneProbeInFlight.lane;

	const probe: LaneProbe = { mode, envKey, lane: probeLane(mode, envKey, now) };
	laneProbeInFlight = probe;
	try {
		laneCache = await probe.lane;
		return laneCache;
	} finally {
		if (laneProbeInFlight === probe) laneProbeInFlight = null;
	}
}

async function probeLane(mode: LaneCache["mode"], envKey: string, now: number): Promise<LaneCache> {
	if (mode === "official") {
		return {
			at: now,
			mode,
			envKey,
			client: null,
			status: {
				backend: "official",
				cookieSource: null,
				detail: `Free lane disabled by ${BACKEND_ENV}=official — reads bill on the official API.`,
			},
		};
	}

	process.env.BIRD_QUERY_IDS_CACHE ??= QUERY_ID_CACHE;
	let authToken: string | null = null;
	let ct0: string | null = null;
	let source: string | null = null;
	let warnings: readonly string[] = [];
	try {
		// X_AUTH_TOKEN/X_CT0 are the namespaced names; the vendored resolver also
		// reads bare AUTH_TOKEN/CT0 (what last30days documents) and then probes
		// Safari/Chrome/Firefox.
		const resolved = await resolveCredentials({
			...(process.env.X_AUTH_TOKEN ? { authToken: process.env.X_AUTH_TOKEN } : {}),
			...(process.env.X_CT0 ? { ct0: process.env.X_CT0 } : {}),
			cookieTimeoutMs: COOKIE_TIMEOUT_MS,
		});
		authToken = resolved.cookies.authToken;
		ct0 = resolved.cookies.ct0;
		source = resolved.cookies.source;
		warnings = resolved.warnings;
	} catch {
		// Cookie extraction is best-effort: a locked keychain, a missing
		// sweet-cookie dep, or an unsupported browser all mean "no free lane".
	}

	if (!authToken || !ct0) {
		// The resolver's own warnings name the actual blocker (missing dep, no
		// cookie, locked store) far better than a generic message can.
		const why = warnings.length > 0 ? ` (${warnings.join("; ")})` : "";
		const detail =
			mode === "bird"
				? `${BACKEND_ENV}=bird but no x.com cookies were found${why}. Log into x.com in Safari/Chrome/Firefox, or set X_AUTH_TOKEN and X_CT0.`
				: `No x.com cookies found — reads bill on the official API${why}. Log into x.com in Safari/Chrome/Firefox (or set X_AUTH_TOKEN/X_CT0) to read for free.`;
		return {
			at: now,
			mode,
			envKey,
			client: null,
			status: { backend: "official", cookieSource: null, detail },
		};
	}

	return {
		at: now,
		mode,
		envKey,
		client: new SearchClient({ cookies: { authToken, ct0 }, timeoutMs: REQUEST_TIMEOUT_MS }),
		status: {
			backend: "bird",
			cookieSource: source,
			detail: `Free lane active — x.com web GraphQL, cookies from ${source ?? "env"}. Reads cost $0; writes still use the official API.`,
		},
	};
}

/** The lane a read would take right now. Never throws. */
export async function readLaneStatus(): Promise<XReadLaneStatus> {
	return (await resolveLane()).status;
}

/**
 * Run a search on the FREE lane.
 *
 * Returns `null` when the free lane is unavailable or the call fails, which is
 * the caller's signal to fall back to the paid official API. It never throws
 * and never mutates anything — `SearchClient` has no write methods at all.
 *
 * `query` is X's ordinary search syntax, so the same string works on both
 * lanes: `from:user`, `to:user`, `conversation_id:…`, `-is:retweet`, `lang:en`.
 */
export async function birdSearch(query: string, limit: number, cursor?: string): Promise<XSearchPage | null> {
	const lane = await resolveLane();
	if (!lane.client) return null;
	try {
		const result = await lane.client.search(query, limit, cursor ? { cursor } : {});
		if (!result.success) return null;
		const posts = result.tweets.flatMap(tweet => {
			const post = normalize(tweet);
			return post ? [post] : [];
		});
		return {
			backend: "bird",
			posts,
			...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
		};
	} catch {
		// A rotated query id, a rate limit, an expired cookie — all mean the same
		// thing to the caller: use the official API for this call.
		return null;
	}
}
