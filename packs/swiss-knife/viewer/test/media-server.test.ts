import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, open, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { request, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFence, type Fence } from "../src/fence";
import { MAX_LEASES, MAX_TRANSFERS, startMediaServer, type MediaServer } from "../src/media-server";

const HEADER = Buffer.from([0, 0, 0, 32, ...Buffer.from("ftypisom"), ...new Uint8Array(52)]);
const TAIL = Buffer.from("selected tail bytes");
const LARGE_SIZE = 64 * 1024 * 1024 + 4096;
let directory: string;
let path: string;
let server: MediaServer;
let fence: Fence;
let allowed: boolean;
const clients = new Set<Socket>();
const SLOT_RETRIES = 200;

beforeEach(async () => {
	directory = await realpath(await mkdtemp(join(tmpdir(), "viewer-media-")));
	path = join(directory, "take.mp4");
	const file = await open(path, "w");
	try {
		await file.write(HEADER, 0, HEADER.length, 0);
		await file.truncate(LARGE_SIZE);
		await file.write(TAIL, 0, TAIL.length, LARGE_SIZE - TAIL.length);
	} finally {
		await file.close();
	}
	allowed = true;
	const realFence = createFence({ home: directory, env: {}, roots: [directory] });
	fence = { roots: realFence.roots, check: (requested, meta) => allowed ? realFence.check(requested, meta) : Promise.resolve({ ok: false, reason: "Access withdrawn" }) };
	server = await startMediaServer(fence);
});

afterEach(async () => {
	for (const client of clients) client.destroy();
	clients.clear();
	await server?.close();
	await rm(directory, { recursive: true, force: true });
});

function freshToken(): string {
	return randomBytes(24).toString("hex");
}

async function lease() {
	const revision = await stat(path);
	return server.acquire(path, revision.size, revision.mtimeMs, undefined, freshToken());
}

async function response(url: string, headers: OutgoingHttpHeaders = {}, method = "GET") {
	return new Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer }>((resolve, reject) => {
		const req = request(url, { method, headers }, res => {
			const chunks: Buffer[] = [];
			res.on("data", chunk => chunks.push(Buffer.from(chunk)));
			res.on("end", () => {
				if (res.statusCode === undefined) reject(new Error("The response carried no status."));
				else resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) });
			});
			res.on("error", reject);
		});
		req.on("error", reject);
		req.end();
	});
}

interface OpenStream {
	readonly status: number;
	readonly closed: Promise<void>;
	bodyBytes(): number;
	resume(): void;
	destroy(): void;
}

function openStream(url: string): Promise<OpenStream> {
	const target = new URL(url);
	const { promise, resolve, reject } = Promise.withResolvers<OpenStream>();
	const { promise: closed, resolve: settle } = Promise.withResolvers<void>();
	const socket = connect(Number(target.port), target.hostname);
	clients.add(socket);
	let received = 0;
	let head = Buffer.alloc(0);
	let headEnd = 0;
	let live = false;
	socket.once("connect", () => socket.write(`GET ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nRange: bytes=0-\r\nConnection: close\r\n\r\n`));
	socket.on("data", (chunk: Buffer) => {
		received += chunk.length;
		if (live) return;
		head = Buffer.concat([head, chunk]);
		const end = head.indexOf("\r\n\r\n");
		if (end < 0 || received <= end + 4) return;
		live = true;
		headEnd = end + 4;
		socket.pause();
		resolve({
			status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head.toString("latin1"))?.[1]),
			closed,
			bodyBytes: () => received - headEnd,
			resume: () => socket.resume(),
			destroy: () => socket.destroy(),
		});
	});
	socket.on("error", error => {
		if (!live) reject(error);
		settle();
	});
	socket.on("close", () => {
		if (!live) reject(new Error("The connection closed before any media arrived."));
		settle();
	});
	return promise;
}

async function afterSlotFrees(url: string, headers: OutgoingHttpHeaders) {
	let result = await response(url, headers);
	for (let attempt = 1; attempt < SLOT_RETRIES && result.status === 503; attempt++) result = await response(url, headers);
	return result;
}

describe("recording range leases", () => {
	test("releasing an opening recording prevents a delayed fence approval from publishing its capability", async () => {
		await server.close();
		let approve!: () => void;
		let entered!: () => void;
		const approval = new Promise<void>(resolve => { approve = resolve; });
		const checking = new Promise<void>(resolve => { entered = resolve; });
		server = await startMediaServer({
			roots: fence.roots,
			async check(requested, meta) {
				entered();
				await approval;
				return fence.check(requested, meta);
			},
		});
		const revision = await stat(path);
		const token = "a".repeat(48);
		const opening = server.acquire(path, revision.size, revision.mtimeMs, undefined, token);
		const outcome = opening.then(
			source => ({ status: "fulfilled" as const, source }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		await checking;
		server.release(token);
		approve();
		const settled = await outcome;
		expect(settled.status).toBe("rejected");
		if (settled.status !== "rejected") throw new Error("Cancelled recording became available.");
		expect(settled.error).toBeInstanceOf(Error);
		expect((settled.error as Error).message).toBe("Recording opening was cancelled.");
		const result = await response(`${server.origin}/media/${token}`, { Range: "bytes=0-7" });
		expect(result.status).toBe(404);
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test("pending admissions consume lease capacity and cancellation restores it after they settle", async () => {
		await server.close();
		let approve!: () => void;
		const approval = new Promise<void>(resolve => { approve = resolve; });
		server = await startMediaServer({
			roots: fence.roots,
			async check(requested, meta) {
				await approval;
				return fence.check(requested, meta);
			},
		});
		const revision = await stat(path);
		const tokens = Array.from({ length: 64 }, (_, index) => index.toString(16).padStart(48, "0"));
		const openings = tokens.map(token => server.acquire(path, revision.size, revision.mtimeMs, undefined, token));
		const settled = Promise.allSettled(openings);
		try {
			await expect(server.acquire(path, revision.size, revision.mtimeMs, undefined, "f".repeat(48))).rejects.toThrow(/The viewer already serves/);
		} finally {
			for (const token of tokens) server.release(token);
			approve();
			await settled;
		}
		const source = await server.acquire(path, revision.size, revision.mtimeMs, undefined, "f".repeat(48));
		const result = await response(source.url, { Range: "bytes=0-7" });
		expect(result.status).toBe(206);
		expect(result.bytes).toEqual(HEADER.subarray(0, 8));
	});

	test("a recording larger than 64 MiB serves only the selected header bytes", async () => {
		const source = await lease();
		const result = await response(source.url, { Range: `bytes=0-${HEADER.length - 1}` });
		expect(result.status).toBe(206);
		expect(result.headers["content-type"]).toBe("video/mp4");
		expect(result.headers["content-length"]).toBe(String(HEADER.length));
		expect(result.headers["content-range"]).toBe(`bytes 0-${HEADER.length - 1}/${LARGE_SIZE}`);
		expect(result.bytes).toEqual(HEADER);
	});

	test.each([
		["open-ended tail", `bytes=${LARGE_SIZE - TAIL.length}-`],
		["suffix", `bytes=-${TAIL.length}`],
		["end beyond EOF", `bytes=${LARGE_SIZE - TAIL.length}-${LARGE_SIZE + 100}`],
	])("%s returns the exact final bytes", async (_name, range) => {
		const result = await response((await lease()).url, { Range: range });
		expect(result.status).toBe(206);
		expect(result.headers["content-range"]).toBe(`bytes ${LARGE_SIZE - TAIL.length}-${LARGE_SIZE - 1}/${LARGE_SIZE}`);
		expect(result.bytes).toEqual(TAIL);
	});

	test.each(["bytes=9-2", `bytes=${LARGE_SIZE}-`, "bytes=-0", "bytes=-", "bytes=9007199254740992-", "bytes=", "bytes", "bytes=abc", "bytes=+5-9", "bytes=1e3-2e3", "bytes=0x10-0x20"])("rejects invalid range %s without media bytes", async range => {
		const result = await response((await lease()).url, { Range: range });
		expect(result.status).toBe(416);
		expect(result.headers["content-range"]).toBe(`bytes */${LARGE_SIZE}`);
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test.each([
		["a unit other than bytes", "items=0-1"],
		["several ranges", "bytes=0-1,3-4"],
	])("%s is ignored and the whole recording is returned", async (_name, range) => {
		await writeFile(path, HEADER);
		const result = await response((await lease()).url, { Range: range });
		expect(result.status).toBe(200);
		expect(result.headers["content-length"]).toBe(String(HEADER.length));
		expect(result.headers["content-range"]).toBeUndefined();
		expect(result.bytes).toEqual(HEADER);
	});

	test.each([
		["a unit in capitals", "BYTES=0-1", HEADER.subarray(0, 2)],
		["whitespace after the equals sign", "bytes= 0-1", HEADER.subarray(0, 2)],
		["a last position beyond any safe integer", "bytes=0-99999999999999999999", HEADER],
		["a suffix beyond any safe integer", "bytes=-99999999999999999999", HEADER],
	])("%s is a valid range", async (_name, range, expected) => {
		await writeFile(path, HEADER);
		const result = await response((await lease()).url, { Range: range });
		expect(result.status).toBe(206);
		expect(result.headers["content-length"]).toBe(String(expected.length));
		expect(result.headers["content-range"]).toBe(`bytes 0-${expected.length - 1}/${HEADER.length}`);
		expect(result.bytes).toEqual(expected);
	});

	test("a Range on HEAD is ignored: the answer describes the whole recording and sends no body", async () => {
		const result = await response((await lease()).url, { Range: "bytes=0-11", Origin: "null" }, "HEAD");
		expect(result.status).toBe(200);
		expect(result.headers["content-length"]).toBe(String(LARGE_SIZE));
		expect(result.headers["content-range"]).toBeUndefined();
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test("GET without a range returns the entire small recording", async () => {
		await writeFile(path, HEADER);
		const result = await response((await lease()).url);
		expect(result.status).toBe(200);
		expect(result.headers["content-length"]).toBe(String(HEADER.length));
		expect(result.bytes).toEqual(HEADER);
	});

	test("revoking a lease makes its previously usable URL refuse access", async () => {
		const source = await lease();
		expect((await response(source.url, { Range: "bytes=0-11" })).status).toBe(206);
		server.release(source.token);
		const result = await response(source.url, { Range: "bytes=0-11" });
		expect(result.status).toBe(404);
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test("withdrawing fence access invalidates an existing lease", async () => {
		const source = await lease();
		allowed = false;
		const result = await response(source.url, { Range: "bytes=0-11" });
		expect(result.status).toBe(404);
		expect(result.bytes).toEqual(Buffer.alloc(0));
		await expect(lease()).rejects.toThrow("Access withdrawn");
	});

	test("a changed file cannot be read through its old revision lease", async () => {
		const source = await lease();
		await writeFile(path, HEADER);
		const result = await response(source.url, { Range: "bytes=0-11" });
		expect(result.status).toBe(409);
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test("a same-size recording with a new mtime cannot use the old lease", async () => {
		const revision = await stat(path);
		const source = await lease();
		const changed = new Date(revision.mtimeMs + 10_000);
		await utimes(path, changed, changed);
		const result = await response(source.url, { Range: "bytes=0-11" });
		expect(result.status).toBe(409);
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test("an outdated listing cannot grant a lease", async () => {
		const revision = await stat(path);
		await expect(server.acquire(path, revision.size - 1, revision.mtimeMs, undefined, freshToken())).rejects.toThrow(/changed/i);
	});

	test("releasing a lease restores capacity after the lease limit is reached", async () => {
		const first = await lease();
		for (let index = 1; index < MAX_LEASES; index++) await lease();
		await expect(lease()).rejects.toThrow(/The viewer already serves/);
		server.release(first.token);
		const result = await response((await lease()).url, { Range: "bytes=0-11" });
		expect(result.status).toBe(206);
		expect(result.bytes).toEqual(HEADER.subarray(0, 12));
	});

	test.each([
		["foreign origin", { Origin: "https://attacker.example" }],
		["listener origin is not a sandbox origin", { Origin: "http://127.0.0.1" }],
		["foreign host", { Host: "attacker.example" }],
	])("refuses %s even with a valid token", async (_name, headers) => {
		const result = await response((await lease()).url, { ...headers, Range: "bytes=0-11" });
		expect(result.status).toBe(404);
		expect(result.headers["access-control-allow-origin"]).toBeUndefined();
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test("a token cannot be extended into an arbitrary-path request", async () => {
		const result = await response(`${(await lease()).url}?path=${encodeURIComponent(path)}`);
		expect(result.status).toBe(404);
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test("a valid lease does not permit methods other than GET and HEAD", async () => {
		const result = await response((await lease()).url, {}, "POST");
		expect(result.status).toBe(405);
		expect(result.headers.allow).toBe("GET, HEAD");
		expect(result.bytes).toEqual(Buffer.alloc(0));
	});

	test.each([
		["an unknown token", 404, () => response(`${server.origin}/media/${"0".repeat(48)}`)],
		["a method other than GET and HEAD", 405, async () => response((await lease()).url, {}, "POST")],
		["a recording changed since it was leased", 409, async () => {
			const source = await lease();
			await writeFile(path, HEADER);
			return response(source.url, { Range: "bytes=0-11" });
		}],
		["an unsatisfiable range", 416, async () => response((await lease()).url, { Range: "bytes=-0" })],
		["a range requested by the sandboxed View", 206, async () => response((await lease()).url, { Range: "bytes=0-11", Origin: "null" })],
	])("%s answers %i with a grant for cross-origin fetches", async (_name, status, act) => {
		const result = await act();
		expect(result.status).toBe(status);
		expect(result.headers["access-control-allow-origin"]).toBe("*");
	});

	test("releasing a lease cuts the transfer already streaming from it", async () => {
		const source = await lease();
		const stream = await openStream(source.url);
		expect(stream.status).toBe(206);
		expect(stream.bodyBytes()).toBeGreaterThan(0);
		expect(stream.bodyBytes()).toBeLessThan(LARGE_SIZE);
		server.release(source.token);
		stream.resume();
		await stream.closed;
		expect(stream.bodyBytes()).toBeLessThan(LARGE_SIZE);
		expect((await response(source.url, { Range: "bytes=0-11" })).status).toBe(404);
	});

	test("closing the server cuts the transfer already streaming", async () => {
		const stream = await openStream((await lease()).url);
		expect(stream.status).toBe(206);
		expect(stream.bodyBytes()).toBeGreaterThan(0);
		expect(stream.bodyBytes()).toBeLessThan(LARGE_SIZE);
		const closing = server.close();
		stream.resume();
		await stream.closed;
		await closing;
		expect(stream.bodyBytes()).toBeLessThan(LARGE_SIZE);
	});

	test("the transfer after the last allowed one is refused until a slot frees", async () => {
		const releasing = await lease();
		const staying = await lease();
		const streams = await Promise.all([openStream(releasing.url), ...Array.from({ length: MAX_TRANSFERS - 1 }, () => openStream(staying.url))]);
		expect(streams.filter(stream => stream.status === 206)).toHaveLength(MAX_TRANSFERS);
		const refused = await response(staying.url, { Range: "bytes=0-11" });
		expect(refused.status).toBe(503);
		expect(refused.headers["access-control-allow-origin"]).toBe("*");
		expect(refused.bytes).toEqual(Buffer.alloc(0));
		server.release(releasing.token);
		const served = await afterSlotFrees(staying.url, { Range: "bytes=0-11" });
		expect(served.status).toBe(206);
		expect(served.bytes).toEqual(HEADER.subarray(0, 12));
	});

	test("a token released before its opening arrives is refused and never serves", async () => {
		const token = freshToken();
		server.release(token);
		const revision = await stat(path);
		await expect(server.acquire(path, revision.size, revision.mtimeMs, undefined, token)).rejects.toThrow("Recording opening was cancelled.");
		const result = await response(`${server.origin}/media/${token}`, { Range: "bytes=0-11" });
		expect(result.status).toBe(404);
		expect(result.bytes).toEqual(Buffer.alloc(0));
		const fresh = await lease();
		expect((await response(fresh.url, { Range: "bytes=0-11" })).status).toBe(206);
	});

	test("the memory of released tokens forgets the oldest and keeps the newest", async () => {
		const tokenAt = (index: number) => index.toString(16).padStart(48, "0");
		const released = 2000;
		for (let index = 0; index < released; index++) server.release(tokenAt(index));
		const revision = await stat(path);
		await expect(server.acquire(path, revision.size, revision.mtimeMs, undefined, tokenAt(released - 1))).rejects.toThrow("Recording opening was cancelled.");
		const reopened = await server.acquire(path, revision.size, revision.mtimeMs, undefined, tokenAt(0));
		expect((await response(reopened.url, { Range: "bytes=0-11" })).status).toBe(206);
	});

	test("closing the server cancels an opening still waiting for approval", async () => {
		await server.close();
		const { promise: approval, resolve: approve } = Promise.withResolvers<void>();
		const { promise: checking, resolve: entered } = Promise.withResolvers<void>();
		server = await startMediaServer({
			roots: fence.roots,
			async check(requested, meta) {
				entered();
				await approval;
				return fence.check(requested, meta);
			},
		});
		const revision = await stat(path);
		const refusal = server.acquire(path, revision.size, revision.mtimeMs, undefined, freshToken()).then(
			() => "opened",
			(error: unknown) => error instanceof Error ? error.message : String(error),
		);
		await checking;
		const closing = server.close();
		approve();
		expect(await refusal).toBe("Recording opening was cancelled.");
		await closing;
	});

	test("a closed server refuses new openings", async () => {
		await server.close();
		await expect(lease()).rejects.toThrow("The recording server is closed.");
	});
});
