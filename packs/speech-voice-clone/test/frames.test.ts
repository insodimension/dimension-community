import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { layoutAt } from "../src/layout.js";
import { collectTail, definedEnv, FrameDecoder, type WorkerEvent, type WorkerFrame, workerEnv } from "../src/worker.js";

const FRAME_JSON = 1;
const FRAME_AUDIO = 2;

function frameBytes(kind: number, payload: Uint8Array): Uint8Array {
	const bytes = new Uint8Array(5 + payload.length);
	const view = new DataView(bytes.buffer);
	view.setUint32(0, payload.length, true);
	view.setUint8(4, kind);
	bytes.set(payload, 5);
	return bytes;
}

function eventFrame(event: object): Uint8Array {
	return frameBytes(FRAME_JSON, new TextEncoder().encode(JSON.stringify(event)));
}

function audioFrame(id: number, pcm: Uint8Array): Uint8Array {
	const payload = new Uint8Array(4 + pcm.length);
	new DataView(payload.buffer).setUint32(0, id, true);
	payload.set(pcm, 4);
	return frameBytes(FRAME_AUDIO, payload);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	return new Uint8Array(Buffer.concat(parts));
}

function pattern(length: number, salt = 0): Uint8Array {
	return Uint8Array.from({ length }, (_, i) => (i * 7 + salt) % 256);
}

function decodeAll(chunks: readonly Uint8Array[]): WorkerFrame[] {
	const decoder = new FrameDecoder();
	return chunks.flatMap(chunk => decoder.push(chunk));
}

function chunked(bytes: Uint8Array, sizes: readonly number[]): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	let offset = 0;
	for (let i = 0; offset < bytes.length; i++) {
		const size = Math.max(1, sizes[i % sizes.length] ?? 1);
		chunks.push(bytes.slice(offset, offset + size));
		offset += size;
	}
	return chunks;
}

function seededSizes(seed: number, count: number, max: number): number[] {
	let state = seed;
	return Array.from({ length: count }, () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return 1 + (state % max);
	});
}

const READY: WorkerEvent = { t: "ready", sampleRate: 24000, loadSeconds: 1.5 };
const PROGRESS: WorkerEvent = { t: "progress", stage: "downloading Qwen/Qwen3-TTS", fraction: 0.25 };
const ERROR: WorkerEvent = { t: "error", id: 7, message: "RuntimeError: out of memory" };
const MIXED_STREAM = concat([
	eventFrame(READY),
	audioFrame(1, pattern(300, 1)),
	audioFrame(1, pattern(2, 2)),
	eventFrame({ t: "done", id: 1 }),
	eventFrame(ERROR),
	audioFrame(0xdeadbeef, pattern(64, 3)),
	eventFrame(PROGRESS),
]);
const MIXED_FRAMES: WorkerFrame[] = [
	{ kind: "event", event: READY },
	{ kind: "audio", id: 1, pcm: pattern(300, 1) },
	{ kind: "audio", id: 1, pcm: pattern(2, 2) },
	{ kind: "event", event: { t: "done", id: 1 } },
	{ kind: "event", event: ERROR },
	{ kind: "audio", id: 0xdeadbeef, pcm: pattern(64, 3) },
	{ kind: "event", event: PROGRESS },
];

describe("FrameDecoder", () => {
	test("one chunk holding several frames yields them in order with ids and PCM intact", () => {
		expect(decodeAll([MIXED_STREAM])).toEqual(MIXED_FRAMES);
	});

	test("the request id is an unsigned little-endian 32-bit integer", () => {
		const [frame] = decodeAll([audioFrame(0xffffffff, new Uint8Array([9, 8]))]);
		expect(frame).toEqual({ kind: "audio", id: 4294967295, pcm: new Uint8Array([9, 8]) });
		const [small] = decodeAll([frameBytes(FRAME_AUDIO, new Uint8Array([1, 2, 0, 0, 5, 6]))]);
		expect(small).toEqual({ kind: "audio", id: 513, pcm: new Uint8Array([5, 6]) });
	});

	test("an audio frame with an id and no samples decodes to empty PCM", () => {
		expect(decodeAll([audioFrame(3, new Uint8Array(0))])).toEqual([{ kind: "audio", id: 3, pcm: new Uint8Array(0) }]);
	});

	test("the stream split at every possible byte boundary decodes identically", () => {
		for (let split = 0; split <= MIXED_STREAM.length; split++) {
			const decoder = new FrameDecoder();
			const frames = [...decoder.push(MIXED_STREAM.slice(0, split)), ...decoder.push(MIXED_STREAM.slice(split))];
			expect(frames).toEqual(MIXED_FRAMES);
		}
	});

	test("one byte at a time decodes identically, and a frame appears only on its last byte", () => {
		const decoder = new FrameDecoder();
		const frames: WorkerFrame[] = [];
		const firstFrameLength = eventFrame(READY).length;
		for (let i = 0; i < MIXED_STREAM.length; i++) {
			const produced = decoder.push(MIXED_STREAM.slice(i, i + 1));
			if (i < firstFrameLength - 1) expect(produced).toHaveLength(0);
			if (i === firstFrameLength - 1) expect(produced).toEqual([MIXED_FRAMES[0]] as WorkerFrame[]);
			frames.push(...produced);
		}
		expect(frames).toEqual(MIXED_FRAMES);
	});

	test.each([1, 2, 3, 4, 5, 6, 7, 13, 64, 1000])("fixed chunk size %i decodes identically", size => {
		expect(decodeAll(chunked(MIXED_STREAM, [size]))).toEqual(MIXED_FRAMES);
	});

	test.each([1, 2, 3, 4, 5, 6, 7, 8])("pseudo-random chunk sizes (seed %i) decode identically", seed => {
		expect(decodeAll(chunked(MIXED_STREAM, seededSizes(seed, 97, 40)))).toEqual(MIXED_FRAMES);
	});

	test("a partial header is held, then the frame is emitted once the rest arrives", () => {
		const decoder = new FrameDecoder();
		const bytes = eventFrame(READY);
		expect(decoder.push(bytes.slice(0, 3))).toEqual([]);
		expect(decoder.push(bytes.slice(3, 5))).toEqual([]);
		expect(decoder.push(bytes.slice(5, bytes.length - 1))).toEqual([]);
		expect(decoder.push(bytes.slice(bytes.length - 1))).toEqual([{ kind: "event", event: READY }]);
	});

	test("a complete frame followed by the start of the next emits the first and keeps the rest", () => {
		const decoder = new FrameDecoder();
		const next = audioFrame(2, pattern(20, 4));
		const first = decoder.push(concat([eventFrame(READY), next.slice(0, 7)]));
		expect(first).toEqual([{ kind: "event", event: READY }]);
		expect(decoder.push(next.slice(7))).toEqual([{ kind: "audio", id: 2, pcm: pattern(20, 4) }]);
	});

	test("an empty chunk changes nothing", () => {
		const decoder = new FrameDecoder();
		const bytes = eventFrame(READY);
		expect(decoder.push(new Uint8Array(0))).toEqual([]);
		expect(decoder.push(bytes.slice(0, 6))).toEqual([]);
		expect(decoder.push(new Uint8Array(0))).toEqual([]);
		expect(decoder.push(bytes.slice(6))).toEqual([{ kind: "event", event: READY }]);
	});

	test("a multi-megabyte audio frame arriving in pipe-sized chunks comes out whole", () => {
		const pcm = pattern(2_500_000, 11);
		expect(decodeAll(chunked(audioFrame(5, pcm), [65_536]))).toEqual([{ kind: "audio", id: 5, pcm }]);
	});

	test("JSON carrying multi-byte characters survives a split inside a character", () => {
		const event: WorkerEvent = { t: "error", id: 1, message: "voix: \u00e9t\u00e9, \u4f60\u597d, \ud83d\ude42 done" };
		const bytes = eventFrame(event);
		for (let split = 5; split < bytes.length; split++) {
			const decoder = new FrameDecoder();
			expect([...decoder.push(bytes.slice(0, split)), ...decoder.push(bytes.slice(split))]).toEqual([{ kind: "event", event }]);
		}
	});

	test("decoded PCM never aliases the bytes it was read from: clobbering the input afterwards cannot change it", () => {
		const decoder = new FrameDecoder();
		const chunk = audioFrame(1, pattern(32, 5));
		const [frame] = decoder.push(chunk);
		chunk.fill(0);
		expect(frame).toEqual({ kind: "audio", id: 1, pcm: pattern(32, 5) });
	});

	test("every frame of a chunk holding several is a copy, and so is a frame assembled from several chunks", () => {
		const decoder = new FrameDecoder();
		const first = audioFrame(1, pattern(40, 1));
		const second = audioFrame(2, pattern(40, 2));
		const together = concat([first, second.slice(0, 20)]);
		const [head] = decoder.push(together);
		const spanning = decoder.push(second.slice(20, 30));
		const done = decoder.push(second.slice(30));
		together.fill(0);
		second.fill(0);
		expect(head).toEqual({ kind: "audio", id: 1, pcm: pattern(40, 1) });
		expect(spanning).toEqual([]);
		expect(done).toEqual([{ kind: "audio", id: 2, pcm: pattern(40, 2) }]);
	});

	test("an unknown frame kind is a loud error naming the kind, not silently skipped", () => {
		const decoder = new FrameDecoder();
		expect(() => decoder.push(frameBytes(9, new Uint8Array([1, 2, 3])))).toThrow(/unknown frame kind 9/);
	});
});

describe("definedEnv", () => {
	test("keeps every defined entry and drops the undefined ones, without touching its input", () => {
		const base = { PATH: "/bin", HOME: "/home/me", GONE: undefined, EMPTY: "" };
		const env = definedEnv(base);
		expect(env).toEqual({ PATH: "/bin", HOME: "/home/me", EMPTY: "" });
		expect("GONE" in env).toBe(false);
		expect("GONE" in base).toBe(true);
	});
});

describe("workerEnv", () => {
	const layout = layoutAt("/data/voice-clone");

	test("always points the Hugging Face cache at the pack's data folder, whatever the caller set", () => {
		expect(workerEnv(layout, { HF_HOME: "/somewhere/else" }, false).HF_HOME).toBe(layout.hf);
	});

	test("keeps the rest of the caller's environment, so uv, PATH and proxies still work", () => {
		const env = workerEnv(layout, { PATH: "/bin", HTTPS_PROXY: "http://proxy:3128", GONE: undefined }, false);
		expect(env.PATH).toBe("/bin");
		expect(env.HTTPS_PROXY).toBe("http://proxy:3128");
		expect("GONE" in env).toBe(false);
	});

	test("serving runs offline so a load never reaches for the Hub; setup is the one mode that may download", () => {
		expect(workerEnv(layout, {}, true).HF_HUB_OFFLINE).toBe("1");
		expect(workerEnv(layout, {}, false).HF_HUB_OFFLINE).toBeUndefined();
	});
});

describe("collectTail", () => {
	async function written(...chunks: (string | Uint8Array)[]): Promise<string> {
		const stream = new PassThrough();
		const tail = collectTail(stream);
		for (const chunk of chunks) stream.write(chunk);
		stream.end();
		await once(stream, "end");
		return tail();
	}

	test("keeps lines in order, skips blank ones, and reads CRLF like LF", async () => {
		expect(await written("one\r\n\r\ntwo\n   \nthree")).toBe("one\ntwo\nthree");
	});

	test("keeps only the last 12 lines, so a long traceback shows its end", async () => {
		const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
		expect((await written(`${lines.join("\n")}\n`)).split("\n")).toEqual(lines.slice(-12));
	});

	test("cuts one very long line to 300 characters, so a progress bar cannot flood an error message", async () => {
		const tail = await written(`${"x".repeat(5_000)}\n`);
		expect(tail).toBe("x".repeat(300));
	});

	test("a character split across two reads is decoded whole, never as replacement characters", async () => {
		const text = "caf\u00e9 \ud83d\ude42";
		const bytes = new TextEncoder().encode(`${text}\n`);
		const insideCharacters = [4, 7, 8, 9];
		for (const split of insideCharacters) {
			const tail = await written(bytes.slice(0, split), bytes.slice(split));
			expect(tail).not.toContain("\ufffd");
			expect(tail.replaceAll("\n", "")).toBe(text);
		}
	});

	test("a line that arrives in two reads is still one line", async () => {
		expect(await written("Traceback (most recent call la", "st):\nValueError: boom\n")).toBe("Traceback (most recent call last):\nValueError: boom");
	});

	test("no stream means an empty tail", () => {
		expect(collectTail(null)()).toBe("");
	});
});
