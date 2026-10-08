import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { Agent, request } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFence } from "../src/fence";
import { MAX_TRANSFERS, startMediaServer, type MediaServer } from "../src/media-server";

const HEADER = Buffer.from([0, 0, 0, 32, ...Buffer.from("ftypisom"), ...new Uint8Array(52)]);
const SIZE = 64 * 1024 * 1024 + 4096;
const SETTLE_TURNS = 20_000;

let directory: string;
let path: string;
let server: MediaServer;
let opened = 0;
let closed = 0;
const clients = new Set<Socket>();

beforeEach(async () => {
	opened = 0;
	closed = 0;
	directory = await realpath(await mkdtemp(join(tmpdir(), "viewer-abort-")));
	path = join(directory, "take.mp4");
	const file = await open(path, "w");
	try {
		await file.write(HEADER, 0, HEADER.length, 0);
		await file.truncate(SIZE);
	} finally {
		await file.close();
	}
	const counting: typeof open = async (target, flags) => {
		const handle = await open(target, flags);
		opened++;
		return new Proxy(handle, {
			get(source, property) {
				if (property === "close") return () => ((closed += 1), source.close());
				const value = Reflect.get(source, property, source);
				return typeof value === "function" ? value.bind(source) : value;
			},
		});
	};
	server = await startMediaServer(createFence({ home: directory, env: {}, roots: [directory] }), counting);
});

afterEach(async () => {
	for (const client of clients) client.destroy();
	clients.clear();
	await server.close();
	await rm(directory, { recursive: true, force: true });
});

async function recording(): Promise<URL> {
	const revision = await stat(path);
	const granted = await server.acquire(path, revision.size, revision.mtimeMs, undefined, randomBytes(24).toString("hex"));
	return new URL(granted.url);
}

function statusOf(chunk: Buffer): number {
	return Number(/^HTTP\/1\.1 (\d{3})/.exec(chunk.toString("latin1"))?.[1]);
}

function readHead(target: URL, range: string, keepOpen: boolean): Promise<{ status: number; socket: Socket }> {
	return new Promise((resolve, reject) => {
		const socket = connect(Number(target.port), target.hostname);
		clients.add(socket);
		socket.once("connect", () => socket.write(`GET ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nRange: bytes=${range}\r\nConnection: close\r\n\r\n`));
		socket.once("data", (chunk: Buffer) => {
			socket.pause();
			if (!keepOpen) socket.destroy();
			resolve({ status: statusOf(chunk), socket });
		});
		socket.once("error", () => resolve({ status: 0, socket }));
		socket.once("close", () => reject(new Error("The connection closed before any answer arrived.")));
	});
}

async function until(condition: () => boolean): Promise<boolean> {
	for (let turn = 0; turn < SETTLE_TURNS && !condition(); turn++) await new Promise<void>(resolve => setImmediate(resolve));
	return condition();
}

describe("a client that walks away from a recording mid-transfer", () => {
	test("gives its transfer slot and its file handle back, so playback keeps working after more aborts than there are slots", async () => {
		const target = await recording();
		const statuses = new Map<number, number>();
		for (let abort = 0; abort < MAX_TRANSFERS + 24; abort++) {
			const { status } = await readHead(target, "0-", false);
			statuses.set(status, (statuses.get(status) ?? 0) + 1);
		}
		expect(Object.fromEntries(statuses)).toEqual({ 206: MAX_TRANSFERS + 24 });
		expect((await readHead(target, "0-11", false)).status).toBe(206);
		expect(await until(() => closed === opened)).toBe(true);
		expect(opened).toBeGreaterThan(MAX_TRANSFERS);
	});

	test("a full house is refused until the clients leave, then every slot is free again", async () => {
		const target = await recording();
		const held = await Promise.all(Array.from({ length: MAX_TRANSFERS }, () => readHead(target, "0-", true)));
		expect(held.every(transfer => transfer.status === 206)).toBe(true);
		expect((await readHead(target, "0-11", false)).status).toBe(503);
		for (const transfer of held) transfer.socket.destroy();
		expect(await until(() => closed === opened)).toBe(true);
		for (let again = 0; again < MAX_TRANSFERS; again++) expect((await readHead(target, "0-", false)).status).toBe(206);
	});

	test("a keep-alive connection that fetches many ranges does not pile listeners up on its socket", async () => {
		const target = await recording();
		const warnings: string[] = [];
		const onWarning = (warning: Error) => void warnings.push(warning.name);
		process.on("warning", onWarning);
		const agent = new Agent({ keepAlive: true, maxSockets: 1 });
		try {
			for (let range = 0; range < 40; range++) {
				const bytes = await new Promise<number>((resolve, reject) => {
					const req = request(target, { agent, headers: { Range: "bytes=0-11" } }, res => {
						let length = 0;
						res.on("data", (chunk: Buffer) => void (length += chunk.length));
						res.on("end", () => resolve(length));
					});
					req.once("error", reject);
					req.end();
				});
				expect(bytes).toBe(12);
			}
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(warnings.filter(name => name === "MaxListenersExceededWarning")).toEqual([]);
		} finally {
			process.off("warning", onWarning);
			agent.destroy();
		}
	});
});
