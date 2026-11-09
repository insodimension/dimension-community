import { createHash } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";
import { freshAccessToken, googleError, videoIdOf, youtubeFetch } from "./api";

const BINDING_DOMAIN = "publish-approval/v1";
export const UPDATE_ORIGIN = "https://www.youtube.com";
export const UPDATE_PRESET = "youtube_update_video";
const THUMBNAIL_UPLOAD = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";
const MAX_APPROVAL_MS = 24 * 60 * 60_000;
const DRAFT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const TITLE_MAX_CHARS = 100;
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
const THUMBNAIL_MIME: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
const PROMPT_EVERY_MODE = { tier: "write", policy: "prompt" } as const;

const approvalRecord = type({
	v: "1",
	draftId: "string",
	nonce: /^[0-9a-f]{32}$/,
	binding: /^[0-9a-f]{64}$/,
	approvedAt: "string",
	expiresAt: "string",
});

const updateSchema = type({
	draftId: type("string").describe("The board's youtube-update draft id, exactly as the board gave it on Approve."),
	videoUrl: type("string").describe("The draft's target: the posted video's URL."),
	"title?": type("string").describe("The approved new title, character for character. Pass title OR thumbnailPath."),
	"thumbnailPath?": type("string").describe("Absolute path of the approved thumbnail (PNG or JPEG, at most 2 MB), exactly as the draft holds it."),
});
type UpdateParams = typeof updateSchema.infer;

function approvalsDir(): string {
	const insoHome = process.env.INSO_HOME;
	return insoHome ? join(insoHome, "browser", "publish-approvals") : join(homedir(), ".inso", "browser", "publish-approvals");
}

export function updateBinding(videoId: string, values: readonly string[]): string {
	return createHash("sha256")
		.update(JSON.stringify([BINDING_DOMAIN, UPDATE_ORIGIN, videoId, UPDATE_PRESET, values]))
		.digest("hex");
}

async function claimApproval(draftId: string, binding: string, now: number): Promise<() => Promise<() => Promise<void>>> {
	const dir = approvalsDir();
	const unapproved = `publish_unapproved: no board approval covers this exact YouTube change (draft ${draftId}, binding sha256:${binding.slice(0, 12)}). Apply only what the person approved on the campaign board, to the video that draft targets, exactly as approved, with the thumbnail file unchanged since Approve. Nothing was changed.`;
	const raw = await readFile(join(dir, `${draftId}.json`), "utf8").catch(() => null);
	if (raw === null) throw new Error(unapproved);
	let parsed: typeof approvalRecord.infer | type.errors | null;
	try {
		parsed = approvalRecord(JSON.parse(raw));
	} catch {
		parsed = null;
	}
	if (parsed === null || parsed instanceof type.errors || parsed.draftId !== draftId) throw new Error(unapproved);
	const from = Date.parse(parsed.approvedAt);
	const until = Date.parse(parsed.expiresAt);
	if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from || until - from > MAX_APPROVAL_MS || parsed.binding !== binding) {
		throw new Error(unapproved);
	}
	const marker = join(dir, `${draftId}.${parsed.nonce}.used`);
	const used = `publish_unapproved: the approval for draft ${draftId} was already used, so the change may already be live. Do not apply it again: read the video with youtube_get_videos and record draft_posted with its URL, or unconfirmed.`;
	if (await readFile(marker).then(() => true, () => false)) throw new Error(used);
	if (until <= now) {
		throw new Error(
			`publish_unapproved: the approval for draft ${draftId} expired at ${new Date(until).toISOString()}. Record draft_failed with that reason; the person presses Retry on the board. Nothing was changed.`,
		);
	}
	return async () => {
		try {
			await (await open(marker, "wx")).close();
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error(used);
			throw error;
		}
		return async () => {
			await unlink(marker).catch(() => undefined);
		};
	};
}

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

function checkTitle(title: string): void {
	if (title.trim().length === 0) throw new Error("The title is empty. Nothing was changed.");
	if ([...title].length > TITLE_MAX_CHARS) throw new Error(`The title is ${[...title].length} characters; YouTube allows ${TITLE_MAX_CHARS}. Nothing was changed.`);
	if (/[<>]/.test(title)) throw new Error("YouTube refuses < and > in a title. Nothing was changed.");
}

async function readThumbnail(path: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string; sha256: string }> {
	if (!isAbsolute(path)) throw new Error(`${path} is not an absolute path. Pass the thumbnail path exactly as the draft holds it. Nothing was changed.`);
	const mime = THUMBNAIL_MIME[extname(path).toLowerCase()];
	if (!mime) throw new Error(`${path} is not a PNG or JPEG; YouTube thumbnails are one of the two. Nothing was changed.`);
	const bytes = new Uint8Array(
		await readFile(path).catch(() => {
			throw new Error(`${path} could not be read. Nothing was changed.`);
		}),
	);
	if (bytes.byteLength > THUMBNAIL_MAX_BYTES) throw new Error(`${path} is ${bytes.byteLength} bytes; YouTube thumbnails are at most 2 MB. Nothing was changed.`);
	return { bytes, mime, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function isClearRefusal(status: number): boolean {
	return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function applyChange(response: Response, release: () => Promise<void>, what: string): Promise<unknown> {
	const payload: unknown = await response.json().catch(() => null);
	if (response.ok) return payload;
	const reason = googleError(payload, response.statusText);
	if (isClearRefusal(response.status)) {
		await release();
		throw new Error(`YouTube refused the ${what}: ${reason}. Nothing was changed and the approval still stands; fix the cause and call again.`);
	}
	throw new Error(`YouTube gave no clear answer to the ${what} (${reason}), so it may be live: check the video with youtube_get_videos before anything else, and never apply this draft again.`);
}

export function createUpdateVideoTool(): ToolDefinition<typeof updateSchema> {
	return {
		name: "youtube_update_video",
		label: "YouTube: Update video",
		description:
			"Apply an APPROVED youtube-update draft to an already-posted video on the connected channel: a new title (videos.update, resending the video's whole snippet so its description, tags and category stay) or a new thumbnail (thumbnails.set). Pass draftId, videoUrl and exactly one of title or thumbnailPath, exactly as the board holds them. Refused (publish_unapproved, nothing changed) unless the board's Approve covers this exact change on this exact video; an approval is spent once. Test & Compare, pinned comments and end screens have no API: apply those in Studio.",
		parameters: updateSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			const parsed = updateSchema(args);
			if (parsed instanceof type.errors) return ["YouTube update: (arguments missing or malformed)"];
			return [
				`YouTube draft: ${parsed.draftId}`,
				`Video: ${parsed.videoUrl}`,
				...(parsed.title !== undefined ? [`New title: ${parsed.title}`] : []),
				...(parsed.thumbnailPath !== undefined ? [`New thumbnail: ${parsed.thumbnailPath}`] : []),
			];
		},
		async execute(_toolCallId: string, params: UpdateParams) {
			if (!DRAFT_ID.test(params.draftId)) throw new Error(`draftId "${params.draftId}" is not a board draft id.`);
			if ((params.title === undefined) === (params.thumbnailPath === undefined)) {
				throw new Error("Pass exactly one of title or thumbnailPath: one youtube-update draft is one change.");
			}
			const videoId = videoIdOf(params.videoUrl);
			if (!VIDEO_ID.test(videoId)) throw new Error(`${params.videoUrl} names no YouTube video. Nothing was changed.`);
			const receipt = `https://www.youtube.com/watch?v=${videoId}`;
			if (params.title !== undefined) {
				const title = params.title;
				checkTitle(title);
				const spend = await claimApproval(params.draftId, updateBinding(videoId, ["title", title]), Date.now());
				const accessToken = await freshAccessToken();
				const listed = await youtubeFetch(`/videos?part=snippet&id=${videoId}`, accessToken);
				const current = (await listed.json().catch(() => null)) as { items?: { snippet?: VideoSnippet }[] } | null;
				const snippet = current?.items?.[0]?.snippet;
				if (!listed.ok || !snippet) {
					throw new Error(`YouTube did not return video ${videoId} to this channel (${googleError(current, listed.statusText)}). Nothing was changed and the approval still stands.`);
				}
				if (!snippet.categoryId) throw new Error(`Video ${videoId} came back without its category, and videos.update needs it. Nothing was changed.`);
				const release = await spend();
				await applyChange(
					await youtubeFetch("/videos?part=snippet", accessToken, {
						method: "PUT",
						body: JSON.stringify({ id: videoId, snippet: snippetWithTitle(snippet, title) }),
					}),
					release,
					"title change",
				);
				return {
					content: [{ type: "text" as const, text: `Title of ${receipt} changed from "${snippet.title ?? ""}" to "${title}".` }],
				};
			}
			const path = params.thumbnailPath ?? "";
			const thumbnail = await readThumbnail(path);
			const spend = await claimApproval(
				params.draftId,
				updateBinding(videoId, ["thumbnail", JSON.stringify([path, thumbnail.sha256])]),
				Date.now(),
			);
			const accessToken = await freshAccessToken();
			const release = await spend();
			await applyChange(
				await fetch(`${THUMBNAIL_UPLOAD}?videoId=${videoId}&uploadType=media`, {
					method: "POST",
					headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": thumbnail.mime },
					body: new Blob([thumbnail.bytes], { type: thumbnail.mime }),
				}),
				release,
				"thumbnail change",
			);
			return { content: [{ type: "text" as const, text: `Thumbnail of ${receipt} set to ${path}.` }] };
		},
	};
}
