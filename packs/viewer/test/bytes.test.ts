import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ByteCache, type ChunkSource, loadBytes } from "../app/view/bytes";
import type { FileChunk } from "../src/contract";

/** A chunk source backed by a buffer, like the server, with hooks to misbehave. */
function serve(file: Buffer, tweak: (chunk: FileChunk, call: number) => FileChunk = chunk => chunk): { source: ChunkSource; calls: () => number } {
	let calls = 0;
	return {
		calls: () => calls,
		source: async (offset, length) => {
			const bytes = file.subarray(offset, offset + length);
			return tweak({ base64: bytes.toString("base64"), offset, length: bytes.length, size: file.length, eof: offset + bytes.length >= file.length }, calls++);
		},
	};
}

describe("loadBytes", () => {
	const file = randomBytes(10_000);

	test("stitches chunks into identical bytes and reports progress up to the total", async () => {
		const { source, calls } = serve(file);
		const progress: number[] = [];
		const loaded = await loadBytes(source, { size: file.length, chunkBytes: 3_000, onProgress: done => progress.push(done) });
		expect(Buffer.from(loaded.bytes).equals(file)).toBe(true);
		expect(loaded.truncated).toBe(false);
		expect(calls()).toBe(4);
		expect(progress).toEqual([0, 3_000, 6_000, 9_000, 10_000]);
	});

	test("an empty file needs no call", async () => {
		const { source, calls } = serve(Buffer.alloc(0));
		expect((await loadBytes(source, { size: 0, chunkBytes: 1_000 })).bytes.length).toBe(0);
		expect(calls()).toBe(0);
	});

	test("a limit reads only the head and says so", async () => {
		const { source } = serve(file);
		const loaded = await loadBytes(source, { size: file.length, limit: 2_500, chunkBytes: 1_000 });
		expect(Buffer.from(loaded.bytes).equals(file.subarray(0, 2_500))).toBe(true);
		expect(loaded.truncated).toBe(true);
	});

	test("refuses to stitch a file that changed size between chunks", async () => {
		const { source } = serve(file, (chunk, call) => (call === 1 ? { ...chunk, size: chunk.size + 1 } : chunk));
		await expect(loadBytes(source, { size: file.length, chunkBytes: 3_000 })).rejects.toThrow("changed");
	});

	test("refuses an empty chunk before the end instead of looping forever", async () => {
		const { source } = serve(file, (chunk, call) => (call === 1 ? { ...chunk, base64: "", length: 0 } : chunk));
		await expect(loadBytes(source, { size: file.length, chunkBytes: 3_000 })).rejects.toThrow("ended");
	});

	test("refuses a chunk that claims one length and carries another", async () => {
		const { source } = serve(file, (chunk, call) => (call === 0 ? { ...chunk, length: chunk.length - 1 } : chunk));
		await expect(loadBytes(source, { size: file.length, chunkBytes: 3_000 })).rejects.toThrow("malformed");
	});

	test("stops between chunks when aborted", async () => {
		const { source, calls } = serve(file);
		const controller = new AbortController();
		const loading = loadBytes(source, { size: file.length, chunkBytes: 1_000, signal: controller.signal, onProgress: done => done >= 2_000 && controller.abort() });
		await expect(loading).rejects.toThrow();
		expect(calls()).toBeLessThan(10);
	});
});

describe("ByteCache", () => {
	const bytes = (length: number) => new Uint8Array(length);

	test("evicts the least recently used entry when the byte budget is exceeded", () => {
		const cache = new ByteCache(100, 10);
		cache.set("a", bytes(40));
		cache.set("b", bytes(40));
		cache.get("a"); // a is now newer than b
		cache.set("c", bytes(40));
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toBeDefined();
		expect(cache.get("c")).toBeDefined();
	});

	test("evicts by count too", () => {
		const cache = new ByteCache(1_000, 2);
		cache.set("a", bytes(1));
		cache.set("b", bytes(1));
		cache.set("c", bytes(1));
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("c")).toBeDefined();
	});

	test("an entry larger than the whole budget is not cached and evicts nothing", () => {
		const cache = new ByteCache(100, 10);
		cache.set("small", bytes(10));
		cache.set("giant", bytes(101));
		expect(cache.get("giant")).toBeUndefined();
		expect(cache.get("small")).toBeDefined();
	});

	test("replacing a key does not double-count its bytes", () => {
		const cache = new ByteCache(100, 10);
		cache.set("a", bytes(60));
		cache.set("a", bytes(60));
		cache.set("b", bytes(40));
		expect(cache.get("a")).toBeDefined();
		expect(cache.get("b")).toBeDefined();
	});
});
