import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";
import { createReachReportTool, createVideoAnalyticsTool, ensureReachJobs } from "./analytics";
import { CONFIG_DIR, freshAccessToken, videoIdOf, youtubeJson } from "./api";
import { createUpdateVideoTool } from "./update";

const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_COMMENT_CHARS = 2_000;
const COMMENT_LEDGER = join(CONFIG_DIR, "comment-ledger.json");
const COMMENTS_PER_DAY = 5;
const DUPLICATE_SIMILARITY = 0.8;
const LEDGER_KEEP = 500;
const MAX_VIDEO_IDS = 50;
function clamp(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n[...truncated]` : text;
}

function clampLimit(v: number | undefined, def: number, max: number): number {
	return Math.min(Math.max(v ?? def, 1), max);
}

const PROMPT_EVERY_MODE = { tier: "write", policy: "prompt" } as const;
const APPROVAL_BODY_CAP = 4000;

function approvalArg(args: unknown, key: string): string | undefined {
	const value: unknown = typeof args === "object" && args !== null ? Reflect.get(args, key) : undefined;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

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
	readonly status?: {
		readonly privacyStatus?: string;
		readonly madeForKids?: boolean;
		readonly containsSyntheticMedia?: boolean;
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

const getVideosSchema = type({
	videoIds: type("string[]").describe(
		"1 to 50 video ids or watch/youtu.be/shorts URLs. One id prints the full detail; several print one line each.",
	),
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
	"channelId?": type("string").describe("Channel id (UC…) to read."),
	"handle?": type("string").describe("Channel handle to read, with or without the @ (e.g. @mkbhd)."),
});

function createSearchTool(): ToolDefinition<typeof searchSchema> {
	return {
		name: "youtube_search",
		label: "YouTube: Search",
		description:
			"Search YouTube for videos, channels, or playlists by keyword. Set kind to filter the result type (default video), order to sort by date or views, and publishedAfter to keep only recent results. Returns each result's id, title, kind, channel (with its channel id), and published date — pass video ids to youtube_get_videos for detail, a channel id to youtube_channel_stats. Quota: since 2026-06-01 search has its own bucket of 100 calls a day, so search sparingly; to study one channel, read its uploads playlist with youtube_list_playlist_items instead.",
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

function renderVideo(video: VideoItem, full: boolean): string {
	const s = video.snippet;
	const st = video.statistics;
	const status = video.status;
	const flags = [
		status?.privacyStatus,
		status?.madeForKids ? "made for kids" : null,
		status?.containsSyntheticMedia ? "altered or synthetic" : null,
	].filter(Boolean);
	const counts = `Views: ${st?.viewCount ?? "?"}  Likes: ${st?.likeCount ?? "?"}  Comments: ${st?.commentCount ?? "?"}`;
	if (!full) {
		return `${video.id ?? "?"}  ${s?.title ?? "(no title)"}  ${s?.publishedAt?.slice(0, 10) ?? "?"}  ${formatDuration(video.contentDetails?.duration)}  ${counts}${flags.length ? `  [${flags.join(", ")}]` : ""}`;
	}
	const lines: string[] = [`${s?.title ?? "(no title)"}  [${video.id ?? "?"}]`];
	if (s?.channelTitle) lines.push(`Channel: ${s.channelTitle}${s.channelId ? `  [${s.channelId}]` : ""}`);
	if (s?.publishedAt) lines.push(`Published: ${s.publishedAt.slice(0, 10)}`);
	lines.push(`Duration: ${formatDuration(video.contentDetails?.duration)}`);
	if (flags.length) lines.push(`Status: ${flags.join(", ")}`);
	lines.push(counts);
	lines.push(`Link: https://youtu.be/${video.id ?? "?"}`);
	if (s?.tags?.length) lines.push(`Tags: ${s.tags.slice(0, 15).join(", ")}`);
	if (s?.description) lines.push(`\nDescription:\n${clamp(s.description, MAX_DESCRIPTION_CHARS)}`);
	return lines.join("\n");
}

function createGetVideosTool(): ToolDefinition<typeof getVideosSchema> {
	return {
		name: "youtube_get_videos",
		label: "YouTube: Get Videos",
		description:
			"Read 1 to 50 videos by id or URL in one call (1 quota unit): title, channel, published date, duration, privacy, made-for-kids and altered/synthetic flags, and public views, likes and comments, stamped with the time they were read. One id adds the description and tags. Public views count from the first frame since 2026-08-24; watch time, retention and CTR are read in YouTube Studio, not here.",
		parameters: getVideosSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof getVideosSchema.infer) {
			const ids = [...new Set(params.videoIds.map(videoIdOf).filter(Boolean))];
			if (ids.length === 0) throw new Error("Pass at least one video id.");
			if (ids.length > MAX_VIDEO_IDS) throw new Error(`Pass at most ${MAX_VIDEO_IDS} video ids per call.`);
			const payload = await youtubeJson<{ items?: VideoItem[] }>(
				`/videos?part=snippet,statistics,contentDetails,status&id=${ids.map(encodeURIComponent).join(",")}`,
				await freshAccessToken(),
				"videos.list",
			);
			const items = payload.items ?? [];
			const found = new Set(items.map(video => video.id));
			const missing = ids.filter(id => !found.has(id));
			const body = items.map(video => renderVideo(video, ids.length === 1)).join("\n");
			const lines = [
				items.length ? body : "No videos found.",
				...(missing.length ? [`Not found or not visible: ${missing.join(", ")}`] : []),
				`Public counts read ${new Date().toISOString()}.`,
			];
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
			"List the videos inside a playlist — position, video id, title, owning channel and publish date. A channel's uploads playlist is its channel id with the leading UC replaced by UU, which gives its posting cadence at 1 quota unit instead of a search. Pass the video ids on to youtube_get_videos for numbers.",
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

interface CommentLedgerEntry {
	readonly at: string;
	readonly target: string;
	readonly text: string;
}

function wordsOf(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s]/gu, " ")
			.split(/\s+/)
			.filter(Boolean),
	);
}

export function commentRefusal(
	ledger: readonly CommentLedgerEntry[],
	text: string,
	now: Date,
): string | undefined {
	const today = now.toISOString().slice(0, 10);
	const postedToday = ledger.filter(entry => entry.at.slice(0, 10) === today).length;
	if (postedToday >= COMMENTS_PER_DAY) {
		return `Refused: ${postedToday} comments were already posted today (UTC), the daily cap is ${COMMENTS_PER_DAY}. YouTube's spam policy covers repetitive comments; post the rest tomorrow or by hand.`;
	}
	const words = wordsOf(text);
	for (const entry of ledger) {
		const earlier = wordsOf(entry.text);
		const shared = [...words].filter(word => earlier.has(word)).length;
		const union = new Set([...words, ...earlier]).size;
		if (union > 0 && shared / union >= DUPLICATE_SIMILARITY) {
			return `Refused: this text repeats a comment posted ${entry.at.slice(0, 10)} on ${entry.target}. Never post the same comment twice; write one for this conversation.`;
		}
	}
	return undefined;
}

async function readCommentLedger(): Promise<CommentLedgerEntry[]> {
	try {
		const parsed: unknown = JSON.parse(await readFile(COMMENT_LEDGER, "utf-8"));
		return Array.isArray(parsed) ? (parsed as CommentLedgerEntry[]) : [];
	} catch {
		return [];
	}
}

async function recordComment(ledger: readonly CommentLedgerEntry[], entry: CommentLedgerEntry): Promise<void> {
	await mkdir(dirname(COMMENT_LEDGER), { recursive: true });
	await writeFile(COMMENT_LEDGER, JSON.stringify([...ledger, entry].slice(-LEDGER_KEEP)));
}

function createPostCommentTool(): ToolDefinition<typeof postCommentSchema> {
	return {
		name: "youtube_post_comment",
		label: "YouTube: Post Comment",
		description: `Post a PUBLIC comment. Pass videoId to post a new top-level comment on a video, OR parentCommentId to reply to an existing comment (from youtube_list_comments) — exactly one. PUBLICLY VISIBLE under the channel's name and asks the person every time. Refused after ${COMMENTS_PER_DAY} comments in a UTC day, and refused when the text repeats (80% of its words) any comment posted before: YouTube's spam policy names repetitive comments.`,
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
			const hasVideo = !!params.videoId;
			const hasParent = !!params.parentCommentId;
			if (hasVideo === hasParent) {
				throw new Error(
					"Provide exactly one of videoId (new top-level comment) or parentCommentId (reply to a comment).",
				);
			}
			const ledger = await readCommentLedger();
			const refusal = commentRefusal(ledger, params.text, new Date());
			if (refusal) throw new Error(refusal);
			const accessToken = await freshAccessToken();
			if (hasParent) {
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
				await recordComment(ledger, {
					at: new Date().toISOString(),
					target: `comment ${params.parentCommentId}`,
					text: params.text,
				});
				return {
					content: [
						{
							type: "text" as const,
							text: `Posted reply to comment ${params.parentCommentId}.  [comment ${created.id ?? "?"}]`,
						},
					],
				};
			}
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
			await recordComment(ledger, { at: new Date().toISOString(), target: `video ${params.videoId}`, text: params.text });
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
			"List the caption TRACKS available for a video (language, name, kind, auto-synced flag). The Data API downloads caption text only for videos the connected account owns; for another channel's video, fetch its captions with the watch pack instead of reporting a transcript as unavailable. Never invent one.",
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
							text: `No caption tracks listed for ${params.videoId}. For a video this account does not own, fetch captions with the watch pack.`,
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
			const text = `${tracks}\n\nTrack metadata only: the Data API downloads caption text only for videos this account owns.`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createChannelStatsTool(): ToolDefinition<typeof channelStatsSchema> {
	return {
		name: "youtube_channel_stats",
		label: "YouTube: Channel Stats",
		description:
			"Read a channel's public statistics — subscribers, total views, video count, stamped with the time read. Pass handle (@name) or channelId for any channel; omit both for the connected account's own channel. Its uploads playlist (UC→UU) gives its recent videos at 1 unit.",
		parameters: channelStatsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof channelStatsSchema.infer) {
			if (params.channelId && params.handle) throw new Error("Pass channelId or handle, not both.");
			const handle = params.handle?.trim().replace(/^@?/, "@");
			const selector = params.channelId
				? `id=${encodeURIComponent(params.channelId)}`
				: handle
					? `forHandle=${encodeURIComponent(handle)}`
					: "mine=true";
			const accessToken = await freshAccessToken();
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
								: handle
									? `No channel found for handle ${handle}.`
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
				...(ch.id?.startsWith("UC") ? [`Uploads playlist: UU${ch.id.slice(2)}`] : []),
				`Read ${new Date().toISOString()}.`,
			];
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

export default function youtubeExtension(pi: ExtensionAPI): void {
	pi.registerTool(createSearchTool());
	pi.registerTool(createGetVideosTool());
	pi.registerTool(createListPlaylistsTool());
	pi.registerTool(createListPlaylistItemsTool());
	pi.registerTool(createPlaylistAddTool());
	pi.registerTool(createListCommentsTool());
	pi.registerTool(createPostCommentTool());
	pi.registerTool(createGetCaptionsTool());
	pi.registerTool(createChannelStatsTool());
	pi.registerTool(createReachReportTool());
	pi.registerTool(createVideoAnalyticsTool());
	pi.registerTool(createUpdateVideoTool());
	pi.on("session_start", () => {
		void ensureReachJobs().catch(() => undefined);
	});
}
