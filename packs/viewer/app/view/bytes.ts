// Getting a document's bytes into the View. The only door to the disk is the
// server's `read_file_chunk`, one base64 chunk per call; this stitches the chunks
// into one buffer, reports progress, and refuses to stitch a file that changed
// while it was being read (the halves would not be one document).
import type { FileChunk } from "../../src/contract";

/** One chunk of the file: `offset`, at most `length` bytes. */
export type ChunkSource = (offset: number, length: number) => Promise<FileChunk>;

export interface LoadOptions {
	/** The file's size as the server last reported it. */
	readonly size: number;
	/** Read at most this many leading bytes (text is capped; everything else is read whole). */
	readonly limit?: number;
	/** How many bytes to ask for per call. */
	readonly chunkBytes: number;
	readonly signal?: AbortSignal;
	readonly onProgress?: (loaded: number, total: number) => void;
}

export interface LoadedBytes {
	readonly bytes: Uint8Array;
	/** True when the file is longer than `limit` and only its head was read. */
	readonly truncated: boolean;
}

function decodeInto(target: Uint8Array, at: number, base64: string): number {
	const binary = atob(base64);
	for (let index = 0; index < binary.length; index++) target[at + index] = binary.charCodeAt(index);
	return binary.length;
}

export async function loadBytes(source: ChunkSource, options: LoadOptions): Promise<LoadedBytes> {
	const total = Math.min(options.size, options.limit ?? options.size);
	const bytes = new Uint8Array(total);
	let loaded = 0;
	options.onProgress?.(0, total);
	while (loaded < total) {
		options.signal?.throwIfAborted();
		const chunk = await source(loaded, Math.min(options.chunkBytes, total - loaded));
		if (chunk.size !== options.size) throw new Error("The file changed while it was being read. Open it again.");
		if (chunk.offset !== loaded) throw new Error("The viewer server answered out of order.");
		if (chunk.length === 0) throw new Error("The file ended before it was fully read. Open it again.");
		// Never trust a length to fit: a server that over-delivers must not write past the buffer.
		const room = total - loaded;
		const written = decodeInto(bytes, loaded, chunk.base64);
		if (written !== chunk.length || written > room) throw new Error("The viewer server sent a malformed chunk.");
		loaded += written;
		options.onProgress?.(loaded, total);
	}
	return { bytes, truncated: total < options.size };
}

/**
 * The bytes of documents already read, so flipping the theme (which remounts the
 * View's tree) or re-showing a tab does not stream a 50 MB PDF again. Bounded by
 * total size and count; the least recently used entry goes first. The caller
 * puts the file's `size:mtime` in the key, so a changed file never hits.
 */
export class ByteCache {
	readonly #entries = new Map<string, Uint8Array>();
	#total = 0;

	constructor(
		private readonly maxBytes: number,
		private readonly maxEntries: number,
	) {}

	get(key: string): Uint8Array | undefined {
		const hit = this.#entries.get(key);
		if (hit === undefined) return undefined;
		this.#entries.delete(key); // Re-insert: Map order is the recency order.
		this.#entries.set(key, hit);
		return hit;
	}

	set(key: string, bytes: Uint8Array): void {
		const previous = this.#entries.get(key);
		if (previous !== undefined) {
			this.#total -= previous.byteLength;
			this.#entries.delete(key);
		}
		if (bytes.byteLength > this.maxBytes) return; // Never worth evicting everything for one giant.
		this.#entries.set(key, bytes);
		this.#total += bytes.byteLength;
		for (const [oldest, entry] of this.#entries) {
			if (this.#total <= this.maxBytes && this.#entries.size <= this.maxEntries) break;
			this.#entries.delete(oldest);
			this.#total -= entry.byteLength;
		}
	}
}
