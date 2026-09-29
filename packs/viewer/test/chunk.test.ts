import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChunk, readRange } from "../src/chunk";
import { MAX_CHUNK_BYTES } from "../src/contract";

describe("readChunk", () => {
	let dir: string;
	const bytes = randomBytes(10_000);
	let file: string;
	let empty: string;
	let big: string;
	let bigBytes: Buffer;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "viewer-chunk-"));
		file = join(dir, "ten-thousand.bin");
		empty = join(dir, "empty.bin");
		big = join(dir, "big.bin");
		bigBytes = randomBytes(MAX_CHUNK_BYTES * 2 + 12_345); // longer than two whole chunks
		await writeFile(file, bytes);
		await writeFile(empty, "");
		await writeFile(big, bigBytes);
		await mkdir(join(dir, "folder"));
	});
	afterAll(() => rm(dir, { recursive: true, force: true }));

	const decode = (base64: string) => Buffer.from(base64, "base64");

	test("returns the exact range and is not at the end", async () => {
		const chunk = await readChunk(file, 100, 200);
		expect(chunk).toMatchObject({ offset: 100, length: 200, size: 10_000, eof: false });
		expect(decode(chunk.base64).equals(bytes.subarray(100, 300))).toBe(true);
	});

	test("a chunk that ends exactly at the end of the file is eof", async () => {
		const chunk = await readChunk(file, 9_000, 1_000);
		expect(chunk).toMatchObject({ length: 1_000, eof: true });
	});

	test("a chunk one byte short of the end is not eof", async () => {
		expect((await readChunk(file, 9_000, 999)).eof).toBe(false);
	});

	test("asking past the end returns the tail only, and eof", async () => {
		const chunk = await readChunk(file, 9_990, 500);
		expect(chunk).toMatchObject({ offset: 9_990, length: 10, eof: true });
		expect(decode(chunk.base64).equals(bytes.subarray(9_990))).toBe(true);
	});

	test("starting at or beyond the end is empty, not an error", async () => {
		expect(await readChunk(file, 10_000, 100)).toMatchObject({ base64: "", length: 0, size: 10_000, eof: true });
		expect(await readChunk(file, 50_000, 100)).toMatchObject({ base64: "", length: 0, eof: true });
	});

	test("a zero-byte file is empty and already at eof", async () => {
		expect(await readChunk(empty, 0, MAX_CHUNK_BYTES)).toEqual({ base64: "", offset: 0, length: 0, size: 0, eof: true });
	});

	test("a file longer than one chunk reassembles to identical bytes", async () => {
		const parts: Buffer[] = [];
		let offset = 0;
		let calls = 0;
		for (;;) {
			const chunk = await readChunk(big, offset, MAX_CHUNK_BYTES);
			parts.push(decode(chunk.base64));
			offset += chunk.length;
			calls++;
			if (chunk.eof) break;
		}
		expect(calls).toBe(3);
		expect(createHash("sha256").update(Buffer.concat(parts)).digest("hex")).toBe(createHash("sha256").update(bigBytes).digest("hex"));
	});

	test("refuses a length over the cap and a negative or fractional offset", async () => {
		await expect(readChunk(file, 0, MAX_CHUNK_BYTES + 1)).rejects.toThrow(RangeError);
		await expect(readChunk(file, -1, 10)).rejects.toThrow(RangeError);
		await expect(readChunk(file, 1.5, 10)).rejects.toThrow(RangeError);
	});

	test("refuses a directory instead of opening it", async () => {
		await expect(readRange(join(dir, "folder"), 0, 10)).rejects.toThrow();
	});
});
