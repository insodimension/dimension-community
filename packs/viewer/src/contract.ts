// The wire contract between the viewer's server and its View. Both sides import
// this file (the browser pack's `contracts.ts` is the precedent), so a tool
// rename or a new kind is one edit and a type error on the other side.
import { z } from "zod";

export const VIEWER_VIEW_URI = "ui://viewer/index.html";

/** `_meta` key on a tool RESULT naming the document a host tab stands for. The
 *  host folds it into the tab identity `(server, view.uri, docKey)`; a result
 *  without it keeps the one-tab-per-server identity every other App has. */
export const TAB_META_KEY = "ai.insodimension/tab";

/** The most bytes one `read_file_chunk` call may return (before base64). */
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

export const VIEWER_KINDS = ["image", "pdf", "html", "markdown", "docx", "pptx", "xlsx", "text", "binary"] as const;
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
