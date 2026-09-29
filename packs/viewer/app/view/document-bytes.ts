// The one door to a document's bytes, for the pane that draws it and for anything
// layered on top of it (a markup tool that burns marks into the picture needs the
// original bytes, not what the screen shows). Streams `read_file_chunk`, and
// shares one bounded cache, so asking twice costs nothing while the file has not
// changed: the key carries `size:mtime`, so a changed file never hits.
import { createToolCaller } from "@dimension/mcp-app-kit/tools";
import type { App } from "@modelcontextprotocol/ext-apps";
import { fileChunkSchema, MAX_CHUNK_BYTES } from "../../src/contract";
import { ByteCache, loadBytes } from "./bytes";
import { formatBytes } from "./format";
import type { DocTab } from "./tabs";

/** Streamed per call: big enough to be few round trips, small enough to show progress. */
const CHUNK_BYTES = Math.min(2 * 1024 * 1024, MAX_CHUNK_BYTES);
/** Text is a `<pre>`: past this it is a wall of characters nobody reads in a pane. */
export const TEXT_LIMIT = 1024 * 1024;
/** The View holds a document twice while parsing; refuse what would not fit comfortably. */
export const DOCUMENT_LIMIT = 128 * 1024 * 1024;

const cache = new ByteCache(256 * 1024 * 1024, 6);

export interface LoadedDocument {
	readonly bytes: Uint8Array;
	/** True when only the head of a large text file was read. */
	readonly truncated: boolean;
}

export interface DocumentLoadOptions {
	readonly signal?: AbortSignal;
	readonly onProgress?: (loaded: number, total: number) => void;
}

/** How many leading bytes of `tab` are read: all of it, except text, which is capped. */
export const readLimit = (tab: Pick<DocTab, "kind">): number | undefined => (tab.kind === "text" ? TEXT_LIMIT : undefined);

export async function loadDocumentBytes(app: App, tab: DocTab, options: DocumentLoadOptions = {}): Promise<LoadedDocument> {
	// A file card needs no bytes.
	if (tab.kind === "binary") return { bytes: new Uint8Array(0), truncated: false };
	const limit = readLimit(tab);
	if (limit === undefined && tab.size > DOCUMENT_LIMIT) {
		throw new Error(`This file is ${formatBytes(tab.size)}; the viewer opens files up to ${formatBytes(DOCUMENT_LIMIT)}.`);
	}
	const cacheKey = `${tab.key}\0${tab.size}:${tab.mtimeMs}:${limit ?? "all"}`;
	const cached = cache.get(cacheKey);
	if (cached !== undefined) return { bytes: cached, truncated: limit !== undefined && tab.size > limit };
	const tools = createToolCaller(app);
	const loaded = await loadBytes(
		async (offset, length) => {
			const result = await tools.raw("read_file_chunk", { path: tab.path, offset, length });
			if (result.isError) {
				const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n").trim();
				throw new Error(text || "The file could not be read.");
			}
			return fileChunkSchema.parse(result.structuredContent);
		},
		{ size: tab.size, limit, chunkBytes: CHUNK_BYTES, signal: options.signal, onProgress: options.onProgress },
	);
	cache.set(cacheKey, loaded.bytes);
	return loaded;
}
