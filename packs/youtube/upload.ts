import { open, readFile, stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";
import { channelFor, channelLabel, googleError, tokenOf, YOUTUBE_API, youtubeJson } from "./api";
import { checkTitle, readThumbnail, THUMBNAIL_UPLOAD } from "./update";

const VIDEO_UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";
const CAPTION_UPLOAD = "https://www.googleapis.com/upload/youtube/v3/captions";
const CHUNK_BYTES = 32 * 256 * 1024;
const MAX_FAILURES = 8;
const DESCRIPTION_MAX_BYTES = 5000;
const TAGS_MAX_CHARS = 500;
const CAPTIONS_MAX_BYTES = 100 * 1024 * 1024;
const NOTHING_UPLOADED = "Nothing was uploaded.";

const VIDEO_MIME: Readonly<Record<string, string>> = {
	".mp4": "video/mp4",
	".m4v": "video/x-m4v",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".avi": "video/x-msvideo",
	".wmv": "video/x-ms-wmv",
	".flv": "video/x-flv",
	".mpg": "video/mpeg",
	".mpeg": "video/mpeg",
	".3gp": "video/3gpp",
};
const CAPTION_EXTENSIONS: Readonly<Record<string, true>> = { ".srt": true, ".vtt": true, ".sbv": true, ".sub": true, ".ttml": true, ".dfxp": true, ".scc": true };

const CATEGORY_IDS: Readonly<Record<string, string>> = {
	"film & animation": "1",
	"autos & vehicles": "2",
	music: "10",
	"pets & animals": "15",
	sports: "17",
	"travel & events": "19",
	gaming: "20",
	"people & blogs": "22",
	comedy: "23",
	entertainment: "24",
	"news & politics": "25",
	"howto & style": "26",
	education: "27",
	"science & technology": "28",
	"nonprofits & activism": "29",
};

const uploadSchema = type({
	filePath: type("string").describe("Absolute path of the video file (MP4, MOV, WebM, MKV, AVI and the other formats YouTube takes)."),
	title: type("string").describe("The title, character for character (at most 100 characters, no < or >)."),
	madeForKids: type("boolean").describe("YouTube's audience question: is the video made for kids? Answer it from the campaign or the package; ask the person if neither says."),
	"description?": type("string").describe("The whole description, exactly as it should appear (at most 5,000 bytes, no < or >)."),
	"tags?": type("string[]").describe("Tags; all of them together at most 500 characters."),
	"category?": type("string").describe("A category id (\"28\") or Studio's name for it (\"Science & Technology\"). Defaults to People & Blogs (22), as Studio does."),
	"visibility?": type("'public' | 'unlisted' | 'private'").describe("Who can watch it. Defaults to public. Leave it out when you pass publishAt."),
	"publishAt?": type("string").describe("A future ISO 8601 time to go public: the video uploads private and YouTube publishes it then."),
	"alteredContent?": type("boolean").describe("YouTube's altered or synthetic content disclosure (Studio's AI use answer): true when realistic content was made or changed with AI."),
	"language?": type("string").describe("The video's language as a BCP-47 tag (\"en\"), used for its title, description and audio."),
	"license?": type("'youtube' | 'creativeCommon'").describe("Standard YouTube licence (the default) or Creative Commons Attribution."),
	"embeddable?": type("boolean").describe("Whether other sites may embed it. Defaults to true."),
	"notifySubscribers?": type("boolean").describe("Whether subscribers are told about it. Defaults to true."),
	"thumbnailPath?": type("string").describe("Absolute path of a custom thumbnail (PNG or JPEG, at most 2 MB), set right after the upload."),
	"playlistId?": type("string").describe("The id of one of the channel's playlists to add it to (resolve a title with youtube_list_playlists)."),
	"captionsPath?": type("string").describe("Absolute path of a timed caption file (SRT, VTT, SBV and similar) to add after the upload."),
	"captionsLanguage?": type("string").describe("The captions' language as a BCP-47 tag. Defaults to language."),
	"channel?": type("string").describe("The connected channel to upload to (id, title or @handle). Needed only when several are connected."),
});
type UploadParams = typeof uploadSchema.infer;

interface UploadedVideo {
	readonly id?: string;
	readonly snippet?: { readonly title?: string };
	readonly status?: {
		readonly uploadStatus?: string;
		readonly rejectionReason?: string;
		readonly failureReason?: string;
		readonly privacyStatus?: string;
		readonly publishAt?: string;
		readonly selfDeclaredMadeForKids?: boolean;
		readonly madeForKids?: boolean;
	};
}

interface ReadbackRow {
	readonly field: string;
	readonly expected: string;
	readonly actual: string;
	readonly ok: boolean;
}

export interface UploadDetails {
	readonly videoId: string;
	readonly url: string;
	readonly channelId: string;
	readonly visibility: string;
	readonly publishAt?: string;
	readonly readback: readonly ReadbackRow[];
	readonly followUps: readonly string[];
}

type ChunkOutcome = { readonly done: true; readonly video: UploadedVideo } | { readonly done: false; readonly next: number } | { readonly retry: string };

function categoryIdOf(category: string | undefined): string {
	if (category === undefined) return "22";
	const trimmed = category.trim();
	if (/^\d+$/.test(trimmed)) return trimmed;
	const id = CATEGORY_IDS[trimmed.toLowerCase().replace(/\s+and\s+/, " & ")];
	if (!id) throw new Error(`"${category}" is not a YouTube category. Use one of: ${Object.keys(CATEGORY_IDS).join(", ")}, or its numeric id. ${NOTHING_UPLOADED}`);
	return id;
}

function tagsLength(tags: readonly string[]): number {
	return tags.reduce((sum, tag) => sum + [...tag].length + (/\s/.test(tag) ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}

function checkMetadata(params: UploadParams): void {
	checkTitle(params.title, NOTHING_UPLOADED);
	categoryIdOf(params.category);
	const description = params.description ?? "";
	if (Buffer.byteLength(description, "utf8") > DESCRIPTION_MAX_BYTES) {
		throw new Error(`The description is ${Buffer.byteLength(description, "utf8")} bytes; YouTube allows ${DESCRIPTION_MAX_BYTES}. ${NOTHING_UPLOADED}`);
	}
	if (/[<>]/.test(description)) throw new Error(`YouTube refuses < and > in a description. ${NOTHING_UPLOADED}`);
	if (params.tags && tagsLength(params.tags) > TAGS_MAX_CHARS) {
		throw new Error(`The tags come to ${tagsLength(params.tags)} characters as YouTube counts them; it allows ${TAGS_MAX_CHARS}. ${NOTHING_UPLOADED}`);
	}
	if (params.publishAt !== undefined) {
		if (params.visibility !== undefined && params.visibility !== "private") {
			throw new Error(`A scheduled video uploads private and goes public at publishAt, so visibility "${params.visibility}" cannot go with it. ${NOTHING_UPLOADED}`);
		}
		const when = Date.parse(params.publishAt);
		if (Number.isNaN(when)) throw new Error(`publishAt "${params.publishAt}" is not an ISO 8601 time. ${NOTHING_UPLOADED}`);
		if (when <= Date.now()) throw new Error(`publishAt ${params.publishAt} is not in the future. ${NOTHING_UPLOADED}`);
	}
	if (params.captionsPath !== undefined && !(params.captionsLanguage ?? params.language)) {
		throw new Error(`Captions need a language: pass captionsLanguage or language. ${NOTHING_UPLOADED}`);
	}
}

async function videoFile(path: string): Promise<{ size: number; mime: string }> {
	if (!isAbsolute(path)) throw new Error(`${path} is not an absolute path. ${NOTHING_UPLOADED}`);
	const mime = VIDEO_MIME[extname(path).toLowerCase()];
	if (!mime) throw new Error(`${path} is not a video file YouTube takes (${Object.keys(VIDEO_MIME).join(", ")}). ${NOTHING_UPLOADED}`);
	const info = await stat(path).catch(() => undefined);
	if (!info?.isFile()) throw new Error(`${path} could not be read. ${NOTHING_UPLOADED}`);
	if (info.size === 0) throw new Error(`${path} is empty. ${NOTHING_UPLOADED}`);
	return { size: info.size, mime };
}

async function captionFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
	if (!isAbsolute(path)) throw new Error(`${path} is not an absolute path. ${NOTHING_UPLOADED}`);
	if (!CAPTION_EXTENSIONS[extname(path).toLowerCase()]) {
		throw new Error(`${path} is not a caption file YouTube takes (${Object.keys(CAPTION_EXTENSIONS).join(", ")}). ${NOTHING_UPLOADED}`);
	}
	const bytes = new Uint8Array(
		await readFile(path).catch(() => {
			throw new Error(`${path} could not be read. ${NOTHING_UPLOADED}`);
		}),
	);
	if (bytes.byteLength === 0 || bytes.byteLength > CAPTIONS_MAX_BYTES) throw new Error(`${path} is ${bytes.byteLength} bytes; a caption file is 1 byte to 100 MB. ${NOTHING_UPLOADED}`);
	return bytes;
}

function videoResource(params: UploadParams): object {
	const scheduled = params.publishAt !== undefined;
	return {
		snippet: {
			title: params.title,
			description: params.description ?? "",
			categoryId: categoryIdOf(params.category),
			...(params.tags && params.tags.length > 0 ? { tags: params.tags } : {}),
			...(params.language ? { defaultLanguage: params.language, defaultAudioLanguage: params.language } : {}),
		},
		status: {
			privacyStatus: scheduled ? "private" : (params.visibility ?? "public"),
			...(scheduled ? { publishAt: new Date(params.publishAt ?? "").toISOString() } : {}),
			selfDeclaredMadeForKids: params.madeForKids,
			...(params.alteredContent === undefined ? {} : { containsSyntheticMedia: params.alteredContent }),
			...(params.license ? { license: params.license } : {}),
			...(params.embeddable === undefined ? {} : { embeddable: params.embeddable }),
		},
	};
}

function isTransient(status: number): boolean {
	return status >= 500 || status === 408 || status === 429;
}

async function refusal(response: Response): Promise<string> {
	return googleError(await response.json().catch(() => null), `${response.status} ${response.statusText}`);
}

async function startSession(accessToken: string, params: UploadParams, size: number, mime: string): Promise<string> {
	const notify = params.notifySubscribers === false ? "false" : "true";
	const response = await fetch(`${VIDEO_UPLOAD}?uploadType=resumable&part=snippet,status&notifySubscribers=${notify}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json; charset=UTF-8",
			"X-Upload-Content-Length": String(size),
			"X-Upload-Content-Type": mime,
		},
		body: JSON.stringify(videoResource(params)),
	});
	if (!response.ok) throw new Error(`YouTube refused to start the upload: ${await refusal(response)}. ${NOTHING_UPLOADED}`);
	const session = response.headers.get("location");
	if (!session) throw new Error(`YouTube started the upload but named no upload address. ${NOTHING_UPLOADED}`);
	return session;
}

function nextOffset(range: string | null): number {
	const end = range ? /bytes=\d+-(\d+)/.exec(range)?.[1] : undefined;
	return end === undefined ? 0 : Number(end) + 1;
}

async function outcomeOf(response: Response): Promise<ChunkOutcome> {
	if (response.status === 200 || response.status === 201) {
		return { done: true, video: ((await response.json().catch(() => null)) ?? {}) as UploadedVideo };
	}
	if (response.status === 308) return { done: false, next: nextOffset(response.headers.get("range")) };
	if (isTransient(response.status)) return { retry: await refusal(response) };
	if (response.status === 404 || response.status === 410) {
		throw new Error("The upload session expired before the file finished, so YouTube has no video from it. Call again to upload from the start.");
	}
	throw new Error(`YouTube refused the upload part way: ${await refusal(response)}. The file did not finish, so YouTube has no video from it.`);
}

function backoffMs(failures: number): number {
	return Math.min(32_000, 1000 * 2 ** (failures - 1)) + Math.floor(Math.random() * 1000);
}

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

async function sendFile(
	session: string,
	bearer: () => Promise<string>,
	path: string,
	size: number,
	signal: AbortSignal | undefined,
	progress: (sent: number) => void,
	retryDelayMs: (failures: number) => number,
): Promise<UploadedVideo> {
	const handle = await open(path, "r");
	const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, size));
	let offset = 0;
	let failures = 0;
	let probe = false;
	try {
		for (;;) {
			signal?.throwIfAborted();
			let outcome: ChunkOutcome;
			try {
				if (probe) {
					outcome = await outcomeOf(
						await fetch(session, { method: "PUT", headers: { Authorization: `Bearer ${await bearer()}`, "Content-Range": `bytes */${size}` }, signal }),
					);
				} else {
					const length = Math.min(CHUNK_BYTES, size - offset);
					const { bytesRead } = await handle.read(buffer, 0, length, offset);
					if (bytesRead !== length) throw new Error(`${path} changed while it was uploading. Call again once the file is final.`);
					outcome = await outcomeOf(
						await fetch(session, {
							method: "PUT",
							headers: { Authorization: `Bearer ${await bearer()}`, "Content-Range": `bytes ${offset}-${offset + length - 1}/${size}` },
							body: buffer.subarray(0, length),
							signal,
						}),
					);
				}
			} catch (error) {
				if (signal?.aborted || !(error instanceof TypeError)) throw error;
				outcome = { retry: error.message };
			}
			if (!("retry" in outcome) && !outcome.done && (outcome.next >= size || (!probe && outcome.next <= offset))) {
				outcome = { retry: outcome.next >= size ? "YouTube has the whole file but has not finished the video" : "YouTube kept none of the last part" };
			}
			if ("retry" in outcome) {
				failures += 1;
				if (failures > MAX_FAILURES) {
					throw new Error(
						`YouTube stopped answering after ${megabytes(offset)} of ${megabytes(size)} (${outcome.retry}). If the last part reached it the video may exist: list the channel's uploads (youtube_list_playlist_items on its UU… playlist) before calling again.`,
					);
				}
				probe = true;
				const pause = Promise.withResolvers<void>();
				setTimeout(pause.resolve, retryDelayMs(failures));
				await pause.promise;
				continue;
			}
			if (outcome.done) return outcome.video;
			if (outcome.next > offset) failures = 0;
			probe = false;
			offset = outcome.next;
			progress(offset);
		}
	} finally {
		await handle.close();
	}
}

function multipartCaption(videoId: string, language: string, bytes: Uint8Array<ArrayBuffer>): { body: Blob; contentType: string } {
	const boundary = `dimension-${crypto.randomUUID()}`;
	const metadata = JSON.stringify({ snippet: { videoId, language, name: "", isDraft: false } });
	return {
		contentType: `multipart/related; boundary=${boundary}`,
		body: new Blob([
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
			bytes,
			`\r\n--${boundary}--\r\n`,
		]),
	};
}

function readbackOf(params: UploadParams, video: UploadedVideo | undefined): ReadbackRow[] {
	const expectedPrivacy = params.publishAt !== undefined ? "private" : (params.visibility ?? "public");
	const rows: ReadbackRow[] = [
		{ field: "title", expected: params.title, actual: video?.snippet?.title ?? "(not returned)", ok: video?.snippet?.title === params.title },
		{ field: "visibility", expected: expectedPrivacy, actual: video?.status?.privacyStatus ?? "(not returned)", ok: video?.status?.privacyStatus === expectedPrivacy },
		{
			field: "madeForKids",
			expected: String(params.madeForKids),
			actual: String(video?.status?.selfDeclaredMadeForKids ?? video?.status?.madeForKids ?? "(not returned)"),
			ok: (video?.status?.selfDeclaredMadeForKids ?? video?.status?.madeForKids) === params.madeForKids,
		},
	];
	if (params.publishAt !== undefined) {
		const expected = new Date(params.publishAt).toISOString();
		const actual = video?.status?.publishAt;
		rows.push({ field: "publishAt", expected, actual: actual ?? "(not returned)", ok: actual !== undefined && Date.parse(actual) === Date.parse(expected) });
	}
	return rows;
}

export function createUploadVideoTool(retryDelayMs: (failures: number) => number = backoffMs): ToolDefinition<typeof uploadSchema, UploadDetails> {
	return {
		name: "youtube_upload_video",
		label: "YouTube: Upload video",
		description:
			"Upload a video file to a connected channel through the YouTube Data API (a resumable upload that survives a dropped connection), then read it back. It goes up public unless visibility or publishAt says otherwise, with the title, description, tags, category, audience, altered-content answer, language and licence given; optionally sets a custom thumbnail, adds it to a playlist and adds a caption file. It runs under the session's permission mode and asks nobody on its own. Every check runs before a byte is sent; once the video exists a failed thumbnail, playlist or caption step is reported and never uploads it again. Upload a film once: after an unclear failure list the channel's uploads before calling again. End screens, cards and Test & Compare have no API: set those in Studio. Uploads use their own quota of 100 a day per Google Cloud project.",
		parameters: uploadSchema,
		approval: "write",
		async execute(_toolCallId: string, params: UploadParams, signal, onUpdate) {
			checkMetadata(params);
			const file = await videoFile(params.filePath);
			const thumbnail = params.thumbnailPath === undefined ? undefined : await readThumbnail(params.thumbnailPath, NOTHING_UPLOADED);
			const captions = params.captionsPath === undefined ? undefined : await captionFile(params.captionsPath);
			const channel = await channelFor(params.channel);
			const session = await startSession(await tokenOf(channel), params, file.size, file.mime);
			const uploaded = await sendFile(
				session,
				() => tokenOf(channel),
				params.filePath,
				file.size,
				signal,
				sent => onUpdate?.({ content: [{ type: "text", text: `Uploaded ${megabytes(sent)} of ${megabytes(file.size)} (${Math.floor((sent / file.size) * 100)}%).` }] }),
				retryDelayMs,
			);
			const videoId = uploaded.id;
			if (!videoId) throw new Error("YouTube finished the upload but returned no video id. List the channel's uploads before calling again.");
			const url = `https://youtu.be/${videoId}`;
			const followUps: string[] = [];
			const token = await tokenOf(channel);
			if (uploaded.status?.uploadStatus === "rejected" || uploaded.status?.uploadStatus === "failed") {
				followUps.push(`YouTube ${uploaded.status.uploadStatus} the file: ${uploaded.status.rejectionReason ?? uploaded.status.failureReason ?? "no reason given"}.`);
			}
			if (thumbnail) {
				const response = await fetch(`${THUMBNAIL_UPLOAD}?videoId=${videoId}&uploadType=media`, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": thumbnail.mime },
					body: new Blob([thumbnail.bytes], { type: thumbnail.mime }),
				}).catch((error: unknown) => error);
				followUps.push(
					response instanceof Response && response.ok
						? `Thumbnail set from ${params.thumbnailPath}.`
						: `Thumbnail NOT set (${response instanceof Response ? await refusal(response) : String(response)}). The video is up: set it with youtube_update_video, never by uploading again. A channel that is not phone-verified cannot use custom thumbnails.`,
				);
			}
			if (params.playlistId) {
				const added = await youtubeJson(`/playlistItems?part=snippet`, token, "playlistItems.insert", {
					method: "POST",
					body: JSON.stringify({ snippet: { playlistId: params.playlistId, resourceId: { kind: "youtube#video", videoId } } }),
				}).then(
					() => `Added to playlist ${params.playlistId}.`,
					(error: unknown) => `NOT added to playlist ${params.playlistId} (${error instanceof Error ? error.message : String(error)}). Add it with youtube_playlist_add.`,
				);
				followUps.push(added);
			}
			if (captions && params.captionsPath) {
				const language = params.captionsLanguage ?? params.language ?? "";
				const part = multipartCaption(videoId, language, captions);
				const response = await fetch(`${CAPTION_UPLOAD}?part=snippet&uploadType=multipart`, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": part.contentType },
					body: part.body,
				}).catch((error: unknown) => error);
				followUps.push(
					response instanceof Response && response.ok
						? `Captions (${language}) added from ${params.captionsPath}.`
						: `Captions NOT added (${response instanceof Response ? await refusal(response) : String(response)}). The video is up: add ${params.captionsPath} in Studio (Subtitles, upload file, with timing).`,
				);
			}
			const listed = await youtubeJson<{ items?: UploadedVideo[] }>(`/videos?part=snippet,status&id=${videoId}`, token, "videos.list").catch(() => undefined);
			const readback = readbackOf(params, listed?.items?.[0] ?? uploaded);
			const visibility = listed?.items?.[0]?.status?.privacyStatus ?? uploaded.status?.privacyStatus ?? "unknown";
			const publishAt = listed?.items?.[0]?.status?.publishAt ?? uploaded.status?.publishAt;
			const when = publishAt ? `, scheduled to go public at ${publishAt}` : "";
			const lines = [
				`Uploaded "${params.title}" to ${channelLabel(channel)}: ${url} (${visibility}${when}).`,
				"Read back:",
				...readback.map(row => `- ${row.field}: ${row.ok ? "ok" : `MISMATCH, expected ${row.expected}`} (${row.actual})`),
				...followUps.map(line => `- ${line}`),
				"YouTube is still processing it; HD versions can take a while to appear.",
			];
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { videoId, url, channelId: channel.channelId, visibility, ...(publishAt ? { publishAt } : {}), readback, followUps },
			};
		},
	};
}
