// Reading a file in ranges. A document can be hundreds of megabytes; the View
// streams it in chunks instead of one JSON blob, and this is the only place the
// server touches file bytes. It opens the file and reads exactly the range
// asked (`fs.open` + positioned reads) — never `readFile`, so a 400 MB PDF costs
// one chunk of memory per call, not the file.
import { open } from "node:fs/promises";
import { type FileChunk, MAX_CHUNK_BYTES } from "./contract";

export interface RangeRead {
	readonly bytes: Buffer;
	/** The file's size at the time of the read. */
	readonly size: number;
	readonly mtimeMs: number;
}

/**
 * Read up to `length` bytes at `offset`. A read that starts at or past the end
 * is not an error: it returns no bytes (the caller sees `eof`). Only a regular
 * file is read; a directory, pipe or device is refused before any byte moves,
 * because opening a FIFO for reading blocks until a writer appears.
 */
export async function readRange(path: string, offset: number, length: number): Promise<RangeRead> {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError(`offset must be a non-negative integer, got ${offset}`);
	if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CHUNK_BYTES) {
		throw new RangeError(`length must be an integer from 0 to ${MAX_CHUNK_BYTES}, got ${length}`);
	}
	const handle = await open(path, "r");
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error("not a regular file");
		const want = Math.min(length, Math.max(0, stats.size - offset));
		const bytes = Buffer.allocUnsafe(want);
		let filled = 0;
		while (filled < want) {
			const { bytesRead } = await handle.read(bytes, filled, want - filled, offset + filled);
			if (bytesRead === 0) break; // The file shrank under us: return what was there.
			filled += bytesRead;
		}
		return { bytes: filled === want ? bytes : bytes.subarray(0, filled), size: stats.size, mtimeMs: stats.mtimeMs };
	} finally {
		await handle.close();
	}
}

/** One base64 chunk for `read_file_chunk`. `length` in the answer is what was returned. */
export async function readChunk(path: string, offset: number, length: number): Promise<FileChunk> {
	const { bytes, size } = await readRange(path, offset, length);
	return {
		base64: bytes.toString("base64"),
		offset,
		length: bytes.length,
		size,
		eof: offset + bytes.length >= size,
	};
}
