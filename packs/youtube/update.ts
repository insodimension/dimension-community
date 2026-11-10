import { readFile } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";
import { googleError, ownerOfVideo, tokenOf, videoIdOf, YOUTUBE_API, youtubeFetch } from "./api";

const THUMBNAIL_UPLOAD = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const TITLE_MAX_CHARS = 100;
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
const THUMBNAIL_MIME: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

const updateSchema = type({
	videoUrl: type("string").describe("The posted video's URL."),
	"title?": type("string").describe("The new title, character for character. Pass title OR thumbnailPath."),
	"thumbnailPath?": type("string").describe("Absolute path of the new thumbnail (PNG or JPEG, at most 2 MB)."),
});
type UpdateParams = typeof updateSchema.infer;

interface VideoSnippet {
	readonly title?: string;
	readonly description?: string;
	readonly tags?: readonly string[];
	readonly categoryId?: string;
	readonly defaultLanguage?: string;
	readonly defaultAudioLanguage?: string;
}

export function snippetWithTitle(snippet: VideoSnippet, title: string): VideoSnippet {
	return {
		title,
		categoryId: snippet.categoryId,
		description: snippet.description ?? "",
		...(snippet.tags ? { tags: snippet.tags } : {}),
		...(snippet.defaultLanguage ? { defaultLanguage: snippet.defaultLanguage } : {}),
		...(snippet.defaultAudioLanguage ? { defaultAudioLanguage: snippet.defaultAudioLanguage } : {}),
	};
}

export function checkTitle(title: string, outcome: string): void {
	if (title.trim().length === 0) throw new Error(`The title is empty. ${outcome}`);
	if ([...title].length > TITLE_MAX_CHARS) throw new Error(`The title is ${[...title].length} characters; YouTube allows ${TITLE_MAX_CHARS}. ${outcome}`);
	if (/[<>]/.test(title)) throw new Error(`YouTube refuses < and > in a title. ${outcome}`);
}

export async function readThumbnail(path: string, outcome: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
	if (!isAbsolute(path)) throw new Error(`${path} is not an absolute path. Pass the thumbnail path exactly as the draft holds it. ${outcome}`);
	const mime = THUMBNAIL_MIME[extname(path).toLowerCase()];
	if (!mime) throw new Error(`${path} is not a PNG or JPEG; YouTube thumbnails are one of the two. ${outcome}`);
	const bytes = new Uint8Array(
		await readFile(path).catch(() => {
			throw new Error(`${path} could not be read. ${outcome}`);
		}),
	);
	if (bytes.byteLength > THUMBNAIL_MAX_BYTES) throw new Error(`${path} is ${bytes.byteLength} bytes; YouTube thumbnails are at most 2 MB. ${outcome}`);
	return { bytes, mime };
}

export function setThumbnail(videoId: string, accessToken: string, thumbnail: { bytes: Uint8Array<ArrayBuffer>; mime: string }): Promise<Response> {
	return fetch(`${THUMBNAIL_UPLOAD}?videoId=${videoId}&uploadType=media`, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": thumbnail.mime },
		body: thumbnail.bytes,
	});
}

function isClearRefusal(status: number): boolean {
	return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function applyChange(response: Response, what: string): Promise<unknown> {
	const payload: unknown = await response.json().catch(() => null);
	if (response.ok) return payload;
	const reason = googleError(payload, response.statusText);
	if (isClearRefusal(response.status)) {
		throw new Error(`YouTube refused the ${what}: ${reason}. Nothing was changed; fix the cause and call again.`);
	}
	throw new Error(`YouTube gave no clear answer to the ${what} (${reason}), so it may be live: check the video with youtube_get_videos before anything else, and never apply this change again.`);
}

export function createUpdateVideoTool(): ToolDefinition<typeof updateSchema> {
	return {
		name: "youtube_update_video",
		label: "YouTube: Update video",
		description:
			"Change an already-posted video on the connected channel: a new title (videos.update, resending the video's whole snippet so its description, tags and category stay) or a new thumbnail (thumbnails.set). Pass videoUrl and exactly one of title or thumbnailPath. It runs under the session's permission mode and asks nobody on its own. Apply each change once; after an unclear failure read the video with youtube_get_videos before trying again. Test & Compare, pinned comments and end screens have no API: apply those in Studio.",
		parameters: updateSchema,
		approval: "write",
		async execute(_toolCallId: string, params: UpdateParams) {
			if ((params.title === undefined) === (params.thumbnailPath === undefined)) {
				throw new Error("Pass exactly one of title or thumbnailPath: one call is one change.");
			}
			const videoId = videoIdOf(params.videoUrl);
			if (!VIDEO_ID.test(videoId)) throw new Error(`${params.videoUrl} names no YouTube video. Nothing was changed.`);
			const receipt = `https://www.youtube.com/watch?v=${videoId}`;
			if (params.title !== undefined) {
				const title = params.title;
				checkTitle(title, "Nothing was changed.");
				const accessToken = await tokenOf(await ownerOfVideo(videoId));
				const listed = await youtubeFetch(`/videos?part=snippet&id=${videoId}`, accessToken);
				const current = (await listed.json().catch(() => null)) as { items?: { snippet?: VideoSnippet }[] } | null;
				const snippet = current?.items?.[0]?.snippet;
				if (!listed.ok || !snippet) {
					throw new Error(`YouTube did not return video ${videoId} to this channel (${googleError(current, listed.statusText)}). Nothing was changed.`);
				}
				if (!snippet.categoryId) throw new Error(`Video ${videoId} came back without its category, and videos.update needs it. Nothing was changed.`);
				await applyChange(
					await fetch(`${YOUTUBE_API}/videos?part=snippet`, {
						method: "PUT",
						headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
						body: JSON.stringify({ id: videoId, snippet: snippetWithTitle(snippet, title) }),
					}),
					"title change",
				);
				return {
					content: [{ type: "text" as const, text: `Title of ${receipt} changed from "${snippet.title ?? ""}" to "${title}".` }],
				};
			}
			const path = params.thumbnailPath ?? "";
			const thumbnail = await readThumbnail(path, "Nothing was changed.");
			const accessToken = await tokenOf(await ownerOfVideo(videoId));
			await applyChange(await setThumbnail(videoId, accessToken, thumbnail), "thumbnail change");
			return { content: [{ type: "text" as const, text: `Thumbnail of ${receipt} set to ${path}.` }] };
		},
	};
}
