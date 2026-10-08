import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { readRange } from "./chunk";
import { MEDIA_TOKEN_PATTERN } from "./contract";
import type { Fence } from "./fence";
import { KIND_HEAD_BYTES, sniffMedia } from "./kind";

export const MAX_LEASES = 64;
const TRANSFERS_PER_LEASE = 3;
export const MAX_TRANSFERS = MAX_LEASES * TRANSFERS_PER_LEASE;
const KEEP_ALIVE_HEADROOM = MAX_LEASES;
const MAX_REMEMBERED_RELEASES = MAX_LEASES * 16;
const STREAM_BUFFER_BYTES = 64 * 1024;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
const SANDBOXED_VIEW_ORIGIN = "null";

type Lease = { path: string; size: number; mtimeMs: number; mime: string; meta: unknown; responses: Set<ServerResponse> };

export interface MediaServer {
	readonly origin: string;
	acquire(path: string, size: number, mtimeMs: number, meta: unknown, token: string): Promise<{ url: string; token: string; mime: string }>;
	release(token: string): void;
	close(): Promise<void>;
}

function matchesRevision(info: { size: number; mtimeMs: number }, size: number, mtimeMs: number): boolean {
	return info.size === size && info.mtimeMs === mtimeMs;
}

async function admitRecording(fence: Fence, path: string, size: number, mtimeMs: number, meta: unknown): Promise<Lease> {
	const verdict = await fence.check(path, meta);
	if (!verdict.ok) throw new Error(verdict.reason);
	const head = await readRange(verdict.real, 0, KIND_HEAD_BYTES);
	if (!matchesRevision(head, size, mtimeMs)) throw new Error("The file changed. Open it again.");
	const media = sniffMedia(head.bytes, verdict.real);
	if (media === undefined) throw new Error("This file is not a supported recording.");
	return { path: verdict.real, size, mtimeMs, mime: media.mime, meta, responses: new Set() };
}

type ByteWindow = { start: number; end: number };
type RangeSpec = { first: string; last: string };
type RangeVerdict = { kind: "whole" } | { kind: "window"; window: ByteWindow } | { kind: "unsatisfiable" };
type ServedVerdict = Exclude<RangeVerdict, { kind: "unsatisfiable" }>;

const RANGE_SPEC = /^(\d*)-(\d*)$/;

function parseRangeSpec(header: string): RangeSpec | "ignore" | "invalid" {
	const equals = header.indexOf("=");
	if (equals < 0) return "invalid";
	if (header.slice(0, equals).trim().toLowerCase() !== "bytes") return "ignore";
	const spec = header.slice(equals + 1).trim();
	if (spec.includes(",")) return "ignore";
	const match = RANGE_SPEC.exec(spec);
	return match === null ? "invalid" : { first: match[1] ?? "", last: match[2] ?? "" };
}

function windowOf({ first, last }: RangeSpec, size: number): ByteWindow | null {
	if (size === 0) return null;
	if (first === "") {
		const suffix = Number(last);
		return last === "" || suffix === 0 ? null : { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(first);
	const end = last === "" ? size - 1 : Number(last);
	return start >= size || end < start ? null : { start, end: Math.min(end, size - 1) };
}

function selectRange(method: string | undefined, header: string | undefined, size: number): RangeVerdict {
	if (method !== "GET" || header === undefined) return { kind: "whole" };
	const spec = parseRangeSpec(header);
	if (spec === "ignore") return { kind: "whole" };
	const window = spec === "invalid" ? null : windowOf(spec, size);
	return window === null ? { kind: "unsatisfiable" } : { kind: "window", window };
}

function responseHead(lease: Lease, verdict: ServedVerdict, size: number): { status: 200 | 206; headers: OutgoingHttpHeaders; range: ByteWindow } {
	const range = verdict.kind === "window" ? verdict.window : { start: 0, end: size - 1 };
	const headers: OutgoingHttpHeaders = {
		"Content-Type": lease.mime,
		"Content-Length": range.end - range.start + 1,
		"Accept-Ranges": "bytes",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
	};
	if (verdict.kind === "window") headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
	return { status: verdict.kind === "window" ? 206 : 200, headers, range };
}

function comesFromView(req: IncomingMessage, listenerHost: string): boolean {
	const origin = req.headers.origin;
	return req.headers.host === listenerHost && (origin === undefined || origin === SANDBOXED_VIEW_ORIGIN);
}

async function streamRecording(req: IncomingMessage, res: ServerResponse, lease: Lease, openFile: typeof open): Promise<void> {
	const file = await openFile(lease.path, OPEN_FLAGS);
	try {
		const stats = await file.stat();
		if (res.destroyed) return;
		if (!stats.isFile() || !matchesRevision(stats, lease.size, lease.mtimeMs)) {
			res.writeHead(409).end();
			return;
		}
		const verdict = selectRange(req.method, req.headers.range, stats.size);
		if (verdict.kind === "unsatisfiable") {
			res.writeHead(416, { "Content-Range": `bytes */${stats.size}` }).end();
			return;
		}
		const head = responseHead(lease, verdict, stats.size);
		res.writeHead(head.status, head.headers);
		if (req.method === "HEAD" || stats.size === 0) res.end();
		else await pipeline(file.createReadStream({ start: head.range.start, end: head.range.end, highWaterMark: STREAM_BUFFER_BYTES, autoClose: false }), res);
	} finally {
		await file.close();
	}
}

export async function startMediaServer(fence: Fence, openFile: typeof open = open): Promise<MediaServer> {
	const leases = new Map<string, Lease>();
	const pendingAdmissions = new Map<string, { cancelled: boolean }>();
	const releasedTokens = new Set<string>();
	let active = 0;
	let host = "";
	let closing: Promise<void> | undefined;
	const server = createServer((req, res) => {
		if (!comesFromView(req, host)) {
			res.writeHead(404).end();
			return;
		}
		res.setHeader("Access-Control-Allow-Origin", "*");
		const token = /^\/media\/([a-f0-9]{48})$/.exec(req.url ?? "")?.[1];
		const lease = token === undefined ? undefined : leases.get(token);
		if (lease === undefined) {
			res.writeHead(404).end();
			return;
		}
		void serve(req, res, lease).catch(() => {
			if (!res.headersSent) res.writeHead(500).end();
			else res.destroy();
		});
	});
	server.requestTimeout = 30_000;
	server.headersTimeout = 10_000;
	server.maxConnections = MAX_TRANSFERS + KEEP_ALIVE_HEADROOM;

	async function serve(req: IncomingMessage, res: ServerResponse, lease: Lease): Promise<void> {
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, { Allow: "GET, HEAD" }).end();
			return;
		}
		if (active >= MAX_TRANSFERS) {
			res.writeHead(503).end();
			return;
		}
		active++;
		lease.responses.add(res);
		const socket = req.socket;
		let released = false;
		const release = () => {
			if (released) return;
			released = true;
			active--;
			lease.responses.delete(res);
			socket.off("close", release);
			if (!res.writableFinished) res.destroy();
		};
		// Bun reports a client abort on the socket only; destroying the response is what lets the pipeline reject and close the file.
		socket.once("close", release);
		try {
			const verdict = await fence.check(lease.path, lease.meta);
			if (!verdict.ok || verdict.real !== lease.path) {
				res.writeHead(404).end();
				return;
			}
			await streamRecording(req, res, lease, openFile);
		} finally {
			release();
		}
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Media listener did not bind a TCP port");
	host = `127.0.0.1:${address.port}`;
	const origin = `http://${host}`;
	return {
		origin,
		async acquire(path: string, size: number, mtimeMs: number, meta: unknown, token: string) {
			if (closing !== undefined) throw new Error("The recording server is closed.");
			if (!MEDIA_TOKEN_PATTERN.test(token) || leases.has(token) || pendingAdmissions.has(token)) throw new Error("Invalid recording capability.");
			if (releasedTokens.has(token)) throw new Error("Recording opening was cancelled.");
			if (leases.size + pendingAdmissions.size >= MAX_LEASES) throw new Error("Close an open recording before opening another.");
			const admission = { cancelled: false };
			pendingAdmissions.set(token, admission);
			try {
				const lease = await admitRecording(fence, path, size, mtimeMs, meta);
				if (admission.cancelled) throw new Error("Recording opening was cancelled.");
				leases.set(token, lease);
				return { url: `${origin}/media/${token}`, token, mime: lease.mime };
			} finally {
				pendingAdmissions.delete(token);
			}
		},
		release(token: string) {
			const admission = pendingAdmissions.get(token);
			if (admission !== undefined) admission.cancelled = true;
			for (const response of leases.get(token)?.responses ?? []) response.destroy();
			leases.delete(token);
			releasedTokens.add(token);
			if (releasedTokens.size > MAX_REMEMBERED_RELEASES) {
				const oldest = releasedTokens.values().next();
				if (!oldest.done) releasedTokens.delete(oldest.value);
			}
		},
		close() {
			closing ??= new Promise<void>((resolve, reject) => {
				for (const lease of leases.values()) for (const response of lease.responses) response.destroy();
				leases.clear();
				for (const admission of pendingAdmissions.values()) admission.cancelled = true;
				server.close(error => error ? reject(error) : resolve());
				server.closeAllConnections();
			});
			return closing;
		},
	};
}
