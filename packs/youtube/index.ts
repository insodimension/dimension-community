// YouTube connector — search, inspect videos/channels, manage playlists, and
// read/post comments over the YouTube Data API v3, authenticated via the
// plugin's `oauth` connect flow (see fraym.plugin.json). The connect flow writes
// {access,refresh,expires,clientId,clientSecret?} to CONFIG_TARGET; this
// extension's ONLY job is to keep that access token fresh and expose it as agent
// tools. No Google SDK — plain fetch against the documented REST endpoints,
// matching the sibling google-calendar / google-drive connectors.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";

// MUST match `connect.configTarget` in fraym.plugin.json — the connect flow
// (packages/engine/src/plugin-oauth.ts) writes the credential there; this is
// the ONLY other place that path is spelled out (JSON manifest can't share a
// TS constant with this file).
const CONFIG_TARGET = join(homedir(), ".config", "dimension-youtube", "token.json");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
// Refresh this many ms before actual expiry so a slow request never races a
// token that goes stale mid-flight.
const REFRESH_SKEW_MS = 60_000;
// Video/comment bodies can be arbitrarily long; cap what we surface to the agent.
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_COMMENT_CHARS = 2_000;

const storedCredential = type({
	"provider?": "string",
	access: "string",
	refresh: "string",
	expires: "number",
	clientId: "string",
	"clientSecret?": "string",
});
type StoredCredential = typeof storedCredential.infer;

async function readCredential(): Promise<StoredCredential> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_TARGET, "utf-8");
	} catch {
		throw new Error("YouTube isn't connected yet. Open the plugin's Connect dialog (Plugins → YouTube) and sign in.");
	}
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors) {
		throw new Error(`YouTube's stored credential at ${CONFIG_TARGET} is malformed. Reconnect the plugin.`);
	}
	return parsed;
}

/** Refresh the access token via the standard `refresh_token` grant if it's
 *  expired (or about to be), persisting the renewed credential. Google may not
 *  re-issue a refresh token on every call — the old one is kept when absent. */
async function refreshAccessToken(cred: StoredCredential): Promise<StoredCredential> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: cred.refresh,
		client_id: cred.clientId,
	});
	if (cred.clientSecret) body.set("client_secret", cred.clientSecret);
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: body.toString(),
	});
	const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!res.ok || !payload || typeof payload.access_token !== "string") {
		const detail =
			payload && typeof payload.error_description === "string" ? payload.error_description : res.statusText;
		throw new Error(`YouTube token refresh failed: ${detail}. Reconnect the plugin.`);
	}
	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
	const refreshed: StoredCredential = {
		...cred,
		access: payload.access_token,
		refresh: typeof payload.refresh_token === "string" ? payload.refresh_token : cred.refresh,
		expires: Date.now() + expiresIn * 1000,
	};
	await writeFile(CONFIG_TARGET, JSON.stringify(refreshed, null, 2));
	return refreshed;
}

/** A valid bearer token, refreshing first if the stored one is expired/near-expiry. */
async function freshAccessToken(): Promise<string> {
	const cred = await readCredential();
	if (Date.now() < cred.expires - REFRESH_SKEW_MS) return cred.access;
	return (await refreshAccessToken(cred)).access;
}

async function youtubeFetch(path: string, accessToken: string, init?: RequestInit): Promise<Response> {
	const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
	if (init?.body) headers["Content-Type"] = "application/json";
	const res = await fetch(`${YOUTUBE_API}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
	if (res.status === 401) {
		throw new Error("YouTube rejected the access token (401). Reconnect the plugin.");
	}
	return res;
}

async function youtubeJson<T>(path: string, accessToken: string, op: string, init?: RequestInit): Promise<T> {
	const res = await youtubeFetch(path, accessToken, init);
	const payload = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
	if (!res.ok || !payload) {
		// Surface Google's own error.message verbatim — it names the exact cause
		// (disabled API, quota exhausted, bad id, missing scope, …).
		throw new Error(`YouTube ${op} failed: ${payload?.error?.message ?? res.statusText}`);
	}
	return payload;
}

/** Truncate a body to a cap so a giant description/comment doesn't flood context. */
function clamp(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n[...truncated]` : text;
}

/** Clamp a caller-supplied limit into [1, max], defaulting when absent. */
function clampLimit(v: number | undefined, def: number, max: number): number {
	return Math.min(Math.max(v ?? def, 1), max);
}

/** A comment is public under the user's channel name, so posting one demands a
 *  human click in EVERY approval mode — a bare "write" tier is auto-approved by
 *  write and yolo mode. */
const PROMPT_EVERY_MODE = { tier: "write", policy: "prompt" } as const;
// A comment may run to 10k characters; the approval card shows the first 4000
// and says how much more follows.
const APPROVAL_BODY_CAP = 4000;

/** One non-empty string argument off unvalidated tool args, for an approval
 *  card. Never throws: the card renders before the schema checks the call. */
function approvalArg(args: unknown, key: string): string | undefined {
	const value: unknown = typeof args === "object" && args !== null ? Reflect.get(args, key) : undefined;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Turn an ISO 8601 duration (PT1H2M3S) into a compact 1:02:03 clock. Falls back
 *  to the raw string if it doesn't parse (e.g. live streams report P0D). */
function formatDuration(iso: string | undefined): string {
	if (!iso) return "?";
	const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
	if (!m) return iso;
	const [, d, h, min, s] = m;
	const days = Number(d ?? 0);
	const hours = Number(h ?? 0) + days * 24;
	const mins = Number(min ?? 0);
	const secs = Number(s ?? 0);
	const pad = (n: number) => String(n).padStart(2, "0");
	return hours > 0 ? `${hours}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

interface SearchId {
	readonly kind?: string;
	readonly videoId?: string;
	readonly channelId?: string;
	readonly playlistId?: string;
}

interface SearchSnippet {
	readonly title?: string;
	readonly channelTitle?: string;
	readonly channelId?: string;
	readonly publishedAt?: string;
	readonly description?: string;
}

interface SearchItem {
	readonly id?: SearchId;
	readonly snippet?: SearchSnippet;
}

interface VideoItem {
	readonly id?: string;
	readonly snippet?: {
		readonly title?: string;
		readonly channelTitle?: string;
		readonly channelId?: string;
		readonly publishedAt?: string;
		readonly description?: string;
		readonly tags?: readonly string[];
	};
	readonly statistics?: {
		readonly viewCount?: string;
		readonly likeCount?: string;
		readonly commentCount?: string;
	};
	readonly contentDetails?: {
		readonly duration?: string;
	};
}

interface PlaylistItem {
	readonly id?: string;
	readonly snippet?: {
		readonly title?: string;
		readonly position?: number;
		readonly channelTitle?: string;
		readonly videoOwnerChannelTitle?: string;
		readonly resourceId?: { readonly videoId?: string };
	};
	readonly contentDetails?: {
		readonly videoId?: string;
		readonly itemCount?: number;
		readonly videoPublishedAt?: string;
	};
	readonly status?: { readonly privacyStatus?: string };
}

interface PlaylistSummary {
	readonly id?: string;
	readonly snippet?: { readonly title?: string };
	readonly contentDetails?: { readonly itemCount?: number };
	readonly status?: { readonly privacyStatus?: string };
}

interface CommentSnippet {
	readonly authorDisplayName?: string;
	readonly textDisplay?: string;
	readonly likeCount?: number;
	readonly publishedAt?: string;
}

interface CommentThread {
	readonly id?: string;
	readonly snippet?: {
		readonly totalReplyCount?: number;
		readonly topLevelComment?: { readonly id?: string; readonly snippet?: CommentSnippet };
	};
}

interface CaptionItem {
	readonly id?: string;
	readonly snippet?: {
		readonly language?: string;
		readonly name?: string;
		readonly trackKind?: string;
		readonly isAutoSynced?: boolean;
	};
}

interface ChannelItem {
	readonly id?: string;
	readonly snippet?: { readonly title?: string; readonly customUrl?: string };
	readonly statistics?: {
		readonly subscriberCount?: string;
		readonly hiddenSubscriberCount?: boolean;
		readonly viewCount?: string;
		readonly videoCount?: string;
	};
}

const searchSchema = type({
	query: type("string").describe("Search terms."),
	"kind?": type("'video' | 'channel' | 'playlist'").describe('Result type to search for. Defaults to "video".'),
	"limit?": type("number").describe("Max results, default 10, capped at 50."),
	"order?": type("'relevance' | 'date' | 'viewCount'").describe(
		"relevance (default), date (newest first) or viewCount (most watched first).",
	),
	"publishedAfter?": type(/^\d{4}-\d{2}-\d{2}$/).describe(
		"Only results published on or after this day, YYYY-MM-DD (UTC).",
	),
});

const getVideoSchema = type({
	videoId: type("string").describe("Video id (the v= parameter, or from youtube_search)."),
});

const listPlaylistsSchema = type({
	"limit?": type("number").describe("Max playlists, default 25, capped at 50."),
});

const listPlaylistItemsSchema = type({
	playlistId: type("string").describe("Playlist id (from youtube_list_playlists)."),
	"limit?": type("number").describe("Max items, default 25, capped at 50."),
});

const playlistAddSchema = type({
	playlistId: type("string").describe("Target playlist id (from youtube_list_playlists) — must be one you own."),
	videoId: type("string").describe("Video id to add."),
});

const listCommentsSchema = type({
	videoId: type("string").describe("Video id whose comment threads to read."),
	"limit?": type("number").describe("Max top-level comments, default 20, capped at 100."),
});

const postCommentSchema = type({
	text: type("string").describe("Comment body (plain text)."),
	"videoId?": type("string").describe("Post a new TOP-LEVEL comment on this video. Provide this OR parentCommentId."),
	"parentCommentId?": type("string").describe(
		"Post a REPLY to this existing comment id (from youtube_list_comments). Provide this OR videoId.",
	),
});

const getCaptionsSchema = type({
	videoId: type("string").describe("Video id whose caption tracks to list."),
});

const channelStatsSchema = type({
	"channelId?": type("string").describe("Channel id to read. Omit to read the connected account's own channel."),
});

function createSearchTool(): ToolDefinition<typeof searchSchema> {
	return {
		name: "youtube_search",
		label: "YouTube: Search",
		description:
			"Search YouTube for videos, channels, or playlists by keyword. Set kind to filter the result type (default video), order to sort by date or views, and publishedAfter to keep only recent results. Returns each result's id, title, kind, channel (with its channel id), and published date — pass a video id to youtube_get_video for full detail, a channel id to youtube_channel_stats. Note: search is the most quota-expensive call (100 units), so keep limit tight.",
		parameters: searchSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof searchSchema.infer) {
			const accessToken = await freshAccessToken();
			const limit = clampLimit(params.limit, 10, 50);
			const search = new URLSearchParams({
				part: "snippet",
				q: params.query,
				type: params.kind ?? "video",
				maxResults: String(limit),
				order: params.order ?? "relevance",
			});
			if (params.publishedAfter) search.set("publishedAfter", `${params.publishedAfter}T00:00:00Z`);
			const payload = await youtubeJson<{ items?: SearchItem[] }>(
				`/search?${search.toString()}`,
				accessToken,
				"search.list",
			);
			const items = payload.items ?? [];
			const text =
				items.length === 0
					? "No results."
					: items
							.map(it => {
								const id = it.id?.videoId ?? it.id?.channelId ?? it.id?.playlistId ?? "?";
								const kind = (it.id?.kind ?? "").replace("youtube#", "") || "?";
								const when = it.snippet?.publishedAt ? `  ${it.snippet.publishedAt.slice(0, 10)}` : "";
								const channel = it.snippet?.channelTitle
									? `  — ${it.snippet.channelTitle}${it.snippet.channelId ? ` [${it.snippet.channelId}]` : ""}`
									: "";
								return `[${kind}] ${id}  ${it.snippet?.title ?? "(untitled)"}${channel}${when}`;
							})
							.join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createGetVideoTool(): ToolDefinition<typeof getVideoSchema> {
	return {
		name: "youtube_get_video",
		label: "YouTube: Get Video",
		description:
			"Read one video's full detail by id — title, channel, published date, duration, description, and statistics (views, likes, comments). Use this (not the search summary) when the description or engagement numbers matter.",
		parameters: getVideoSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof getVideoSchema.infer) {
			const accessToken = await freshAccessToken();
			const payload = await youtubeJson<{ items?: VideoItem[] }>(
				`/videos?part=snippet,statistics,contentDetails&id=${encodeURIComponent(params.videoId)}`,
				accessToken,
				"videos.list",
			);
			const video = payload.items?.[0];
			if (!video) {
				return { content: [{ type: "text" as const, text: `No video found for id ${params.videoId}.` }] };
			}
			const s = video.snippet;
			const st = video.statistics;
			const lines: string[] = [`${s?.title ?? "(no title)"}  [${video.id ?? params.videoId}]`];
			if (s?.channelTitle) lines.push(`Channel: ${s.channelTitle}${s.channelId ? `  [${s.channelId}]` : ""}`);
			if (s?.publishedAt) lines.push(`Published: ${s.publishedAt.slice(0, 10)}`);
			lines.push(`Duration: ${formatDuration(video.contentDetails?.duration)}`);
			lines.push(
				`Views: ${st?.viewCount ?? "?"}  Likes: ${st?.likeCount ?? "?"}  Comments: ${st?.commentCount ?? "?"}`,
			);
			lines.push(`Link: https://youtu.be/${video.id ?? params.videoId}`);
			if (s?.tags?.length) lines.push(`Tags: ${s.tags.slice(0, 15).join(", ")}`);
			if (s?.description) lines.push(`\nDescription:\n${clamp(s.description, MAX_DESCRIPTION_CHARS)}`);
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function createListPlaylistsTool(): ToolDefinition<typeof listPlaylistsSchema> {
	return {
		name: "youtube_list_playlists",
		label: "YouTube: List Playlists",
		description:
			"List the connected account's own playlists — id, title, item count, and privacy status. Grab a playlist id here for youtube_list_playlist_items or youtube_playlist_add.",
		parameters: listPlaylistsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listPlaylistsSchema.infer) {
			const accessToken = await freshAccessToken();
			const limit = clampLimit(params.limit, 25, 50);
			const payload = await youtubeJson<{ items?: PlaylistSummary[] }>(
				`/playlists?part=snippet,contentDetails,status&mine=true&maxResults=${limit}`,
				accessToken,
				"playlists.list",
			);
			const items = payload.items ?? [];
			const text =
				items.length === 0
					? "No playlists found."
					: items
							.map(pl => {
								const count = pl.contentDetails?.itemCount ?? "?";
								const privacy = pl.status?.privacyStatus ? `  [${pl.status.privacyStatus}]` : "";
								return `${pl.id ?? "?"}  ${pl.snippet?.title ?? "(untitled)"}  (${count} videos)${privacy}`;
							})
							.join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createListPlaylistItemsTool(): ToolDefinition<typeof listPlaylistItemsSchema> {
	return {
		name: "youtube_list_playlist_items",
		label: "YouTube: List Playlist Items",
		description:
			"List the videos inside a playlist — position, video id, title, owning channel and publish date. A channel's uploads playlist is its channel id with the leading UC replaced by UU, which gives its posting cadence. Pass a video id on to youtube_get_video for detail.",
		parameters: listPlaylistItemsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listPlaylistItemsSchema.infer) {
			const accessToken = await freshAccessToken();
			const limit = clampLimit(params.limit, 25, 50);
			const payload = await youtubeJson<{ items?: PlaylistItem[] }>(
				`/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(params.playlistId)}&maxResults=${limit}`,
				accessToken,
				"playlistItems.list",
			);
			const items = payload.items ?? [];
			const text =
				items.length === 0
					? "This playlist has no items (or isn't accessible)."
					: items
							.map(it => {
								const pos = it.snippet?.position ?? "?";
								const vid = it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId ?? "?";
								const channel = it.snippet?.videoOwnerChannelTitle ?? it.snippet?.channelTitle ?? "";
								const published = it.contentDetails?.videoPublishedAt
									? `  ${it.contentDetails.videoPublishedAt.slice(0, 10)}`
									: "";
								return `${pos}. ${vid}  ${it.snippet?.title ?? "(untitled)"}${channel ? `  — ${channel}` : ""}${published}`;
							})
							.join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createPlaylistAddTool(): ToolDefinition<typeof playlistAddSchema> {
	return {
		name: "youtube_playlist_add",
		label: "YouTube: Add to Playlist",
		description:
			"Add a video to one of your playlists. Mutating — confirm the exact playlist (by title) and video with the user first. The playlist must be one the connected account owns.",
		parameters: playlistAddSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof playlistAddSchema.infer) {
			const accessToken = await freshAccessToken();
			const body = {
				snippet: {
					playlistId: params.playlistId,
					resourceId: { kind: "youtube#video", videoId: params.videoId },
				},
			};
			const created = await youtubeJson<PlaylistItem>(
				"/playlistItems?part=snippet",
				accessToken,
				"playlistItems.insert",
				{
					method: "POST",
					body: JSON.stringify(body),
				},
			);
			const title = created.snippet?.title ?? params.videoId;
			return {
				content: [
					{
						type: "text" as const,
						text: `Added "${title}" (${params.videoId}) to playlist ${params.playlistId}.  [item ${created.id ?? "?"}]`,
					},
				],
			};
		},
	};
}

function createListCommentsTool(): ToolDefinition<typeof listCommentsSchema> {
	return {
		name: "youtube_list_comments",
		label: "YouTube: List Comments",
		description:
			"Read the top-level comment threads on a video (plain text, most-relevant first) — comment id, author, like count, and reply count. Quote the comment id to reply with youtube_post_comment.",
		parameters: listCommentsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listCommentsSchema.infer) {
			const accessToken = await freshAccessToken();
			const limit = clampLimit(params.limit, 20, 100);
			const search = new URLSearchParams({
				part: "snippet",
				videoId: params.videoId,
				order: "relevance",
				textFormat: "plainText",
				maxResults: String(limit),
			});
			const payload = await youtubeJson<{ items?: CommentThread[] }>(
				`/commentThreads?${search.toString()}`,
				accessToken,
				"commentThreads.list",
			);
			const items = payload.items ?? [];
			const text =
				items.length === 0
					? "No comments (or comments are disabled on this video)."
					: items
							.map(th => {
								const top = th.snippet?.topLevelComment?.snippet;
								const id = th.snippet?.topLevelComment?.id ?? th.id ?? "?";
								const replies = th.snippet?.totalReplyCount ?? 0;
								const likes = top?.likeCount ?? 0;
								const body = clamp((top?.textDisplay ?? "").replace(/\s+/g, " ").trim(), MAX_COMMENT_CHARS);
								return `[${id}] ${top?.authorDisplayName ?? "?"}  (${likes} likes, ${replies} replies)\n  ${body}`;
							})
							.join("\n\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createPostCommentTool(): ToolDefinition<typeof postCommentSchema> {
	return {
		name: "youtube_post_comment",
		label: "YouTube: Post Comment",
		description:
			"Post a PUBLIC comment. Pass videoId to post a new top-level comment on a video, OR parentCommentId to reply to an existing comment (from youtube_list_comments) — exactly one. Mutating and PUBLICLY VISIBLE under the connected account's name — confirm the exact target and full text with the user first; it cannot be silently undone.",
		parameters: postCommentSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			const videoId = approvalArg(args, "videoId");
			const parent = approvalArg(args, "parentCommentId");
			const text = approvalArg(args, "text") ?? "(missing)";
			const lines: string[] = [];
			if (videoId) lines.push(`Video: https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
			if (parent) lines.push(`Reply to comment: ${parent}`);
			if (!videoId && !parent) lines.push("Target: (missing)");
			lines.push(
				`Comment:\n${text.length > APPROVAL_BODY_CAP ? `${text.slice(0, APPROVAL_BODY_CAP)}[…${text.length - APPROVAL_BODY_CAP} more chars]` : text}`,
			);
			return lines;
		},
		async execute(_toolCallId: string, params: typeof postCommentSchema.infer) {
			const accessToken = await freshAccessToken();
			const hasVideo = !!params.videoId;
			const hasParent = !!params.parentCommentId;
			if (hasVideo === hasParent) {
				throw new Error(
					"Provide exactly one of videoId (new top-level comment) or parentCommentId (reply to a comment).",
				);
			}
			if (hasParent) {
				// Reply to an existing comment thread: comments.insert.
				const created = await youtubeJson<{ id?: string; snippet?: CommentSnippet }>(
					"/comments?part=snippet",
					accessToken,
					"comments.insert",
					{
						method: "POST",
						body: JSON.stringify({
							snippet: { parentId: params.parentCommentId, textOriginal: params.text },
						}),
					},
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Posted reply to comment ${params.parentCommentId}.  [comment ${created.id ?? "?"}]`,
						},
					],
				};
			}
			// New top-level comment: commentThreads.insert.
			const created = await youtubeJson<CommentThread>(
				"/commentThreads?part=snippet",
				accessToken,
				"commentThreads.insert",
				{
					method: "POST",
					body: JSON.stringify({
						snippet: {
							videoId: params.videoId,
							topLevelComment: { snippet: { textOriginal: params.text } },
						},
					}),
				},
			);
			const id = created.snippet?.topLevelComment?.id ?? created.id ?? "?";
			return {
				content: [
					{ type: "text" as const, text: `Posted top-level comment on video ${params.videoId}.  [comment ${id}]` },
				],
			};
		},
	};
}

function createGetCaptionsTool(): ToolDefinition<typeof getCaptionsSchema> {
	return {
		name: "youtube_get_captions",
		label: "YouTube: Get Captions",
		description:
			"List the caption TRACKS available for a video (language, name, kind, auto-synced flag). IMPORTANT: the official YouTube Data API only lets you DOWNLOAD the actual caption text for videos the connected account OWNS — for arbitrary third-party videos a transcript is NOT available through this API. Report the track list; if the user wants the text of a video they don't own, tell them it's unavailable via the official API rather than fabricating one.",
		parameters: getCaptionsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof getCaptionsSchema.infer) {
			const accessToken = await freshAccessToken();
			const payload = await youtubeJson<{ items?: CaptionItem[] }>(
				`/captions?part=snippet&videoId=${encodeURIComponent(params.videoId)}`,
				accessToken,
				"captions.list",
			);
			const items = payload.items ?? [];
			if (items.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No caption tracks listed for ${params.videoId}. Note: the captions.list endpoint requires appropriate access; a public transcript for a video you don't own is not downloadable via the official API.`,
						},
					],
				};
			}
			const tracks = items
				.map(c => {
					const sn = c.snippet;
					const flags = `${sn?.trackKind ? `  ${sn.trackKind}` : ""}${sn?.isAutoSynced ? "  [auto-synced]" : ""}`;
					return `[${c.id ?? "?"}] ${sn?.language ?? "?"}  ${sn?.name || "(default)"}${flags}`;
				})
				.join("\n");
			const text = `${tracks}\n\nNote: caption TEXT download via the official API is restricted to videos you own — the list above is track metadata only.`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createChannelStatsTool(): ToolDefinition<typeof channelStatsSchema> {
	return {
		name: "youtube_channel_stats",
		label: "YouTube: Channel Stats",
		description:
			"Read a channel's public statistics — subscribers, total views, video count. Omit channelId for the connected account's own channel, or pass a channelId (from youtube_search or youtube_get_video) for any channel.",
		parameters: channelStatsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof channelStatsSchema.infer) {
			const accessToken = await freshAccessToken();
			const selector = params.channelId ? `id=${encodeURIComponent(params.channelId)}` : "mine=true";
			const payload = await youtubeJson<{ items?: ChannelItem[] }>(
				`/channels?part=snippet,statistics&${selector}`,
				accessToken,
				"channels.list",
			);
			const ch = payload.items?.[0];
			if (!ch) {
				return {
					content: [
						{
							type: "text" as const,
							text: params.channelId
								? `No channel found for id ${params.channelId}.`
								: "No channel on this account.",
						},
					],
				};
			}
			const st = ch.statistics;
			const subs = st?.hiddenSubscriberCount ? "hidden" : (st?.subscriberCount ?? "?");
			const lines = [
				`${ch.snippet?.title ?? "(untitled channel)"}  [${ch.id ?? "?"}]${ch.snippet?.customUrl ? `  ${ch.snippet.customUrl}` : ""}`,
				`Subscribers: ${subs}  Views: ${st?.viewCount ?? "?"}  Videos: ${st?.videoCount ?? "?"}`,
			];
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

/**
 * YouTube plugin. A standard OMP plugin — `skills/`/`rules/` load via OMP's
 * native plugin discovery. This module registers the nine read/write tools; the
 * connect flow (fraym.plugin.json's `connect.oauth`) is what obtains and
 * refreshes the credential these tools read.
 */
export default function youtubeExtension(pi: ExtensionAPI): void {
	pi.registerTool(createSearchTool());
	pi.registerTool(createGetVideoTool());
	pi.registerTool(createListPlaylistsTool());
	pi.registerTool(createListPlaylistItemsTool());
	pi.registerTool(createPlaylistAddTool());
	pi.registerTool(createListCommentsTool());
	pi.registerTool(createPostCommentTool());
	pi.registerTool(createGetCaptionsTool());
	pi.registerTool(createChannelStatsTool());
}
