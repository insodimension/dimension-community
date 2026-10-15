// The wire contract between the viewer's server and its View. Both sides import
// this file (the browser pack's `contracts.ts` is the precedent), so a tool
// rename or a new kind is one edit and a type error on the other side.
import { z } from "zod";

export const VIEWER_VIEW_URI = "ui://viewer/index.html";

/** `_meta` key on a tool RESULT naming the document a host tab stands for. The
 *  host folds it into the tab identity `(server, view.uri, docKey)`; a result
 *  without it keeps the one-tab-per-server identity every other App has. */
export const TAB_META_KEY = "ai.insodimension/tab";

/** `_meta` key on a `view_file` RESULT asking the View to open that document in
 *  its annotate mode (`view_file`'s `annotate: true`). It is the View's own
 *  business, not the host's: it rides the result beside {@link TAB_META_KEY} and
 *  carries no document identity. A kind with nothing to annotate ignores it. */
export const ANNOTATE_META_KEY = "ai.insodimension.viewer/annotate";

/** The most bytes one `read_file_chunk` call may return (before base64). */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

export const VIEWER_KINDS = ["image", "pdf", "html", "markdown", "docx", "pptx", "xlsx", "text", "audio", "video", "binary"] as const;
export type ViewerKind = (typeof VIEWER_KINDS)[number];

/** `structuredContent` of a `view_file` result. `path` is the REAL path (symlinks
 *  resolved), which is also the document's tab key. */
export const viewedFileSchema = z.object({
	path: z.string().min(1),
	filename: z.string().min(1),
	kind: z.enum(VIEWER_KINDS),
	size: z.number().int().nonnegative(),
	mtimeMs: z.number(),
});
export type ViewedFile = z.infer<typeof viewedFileSchema>;

/** `_meta[TAB_META_KEY]` on a `view_file` result. */
export const tabMetaSchema = z.object({ key: z.string().min(1) });

/** `structuredContent` of a `read_file_chunk` result. `length` is the number of
 *  bytes actually returned, not the number asked for. */
export const fileChunkSchema = z.object({
	base64: z.string(),
	offset: z.number().int().nonnegative(),
	length: z.number().int().nonnegative(),
	size: z.number().int().nonnegative(),
	eof: z.boolean(),
});
export type FileChunk = z.infer<typeof fileChunkSchema>;

export const MEDIA_TOKEN_PATTERN = /^[a-f0-9]{48}$/;
export const mediaTokenSchema = z.string().regex(MEDIA_TOKEN_PATTERN);

export const mediaSourceSchema = z.object({
	url: z.string().url(),
	token: mediaTokenSchema,
	mime: z.string().min(1),
});

/* Wire keys the engine's app host stamps; see `@dimension/sdk/artifactory` and the engine's `SESSION_META_KEY`. */
export const SESSION_META_KEY = "ai.insodimension/session";
export const HOST_CONTEXT_REFERENCE_META_KEY = "ai.insodimension/host-context";
export const HOST_CONTEXT_ENDED_METHOD = "notifications/ai.insodimension/host-context-ended";
export const RECORDING_SLOT_REFUSAL_FIRST_WORDS = "The viewer already serves";


export type MediaSession = string | undefined;

export function recordingSlotRefusalSentence(held: number, names: readonly string[]): string {
	const offered = names.slice(0, 3).map((name) => `"${name}"`).join(", ");
	return `${RECORDING_SLOT_REFUSAL_FIRST_WORDS} ${held} recordings of this engine open — ${names.length === 0 ? `one of them is unnamed` : offered}${names.length === 3 ? ", and others" : ""}. Close one of those tabs (or close its session) before opening another.`;
}
