// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/relay/server.ts @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../../third-party/omp/LICENSE.
// Changed for the Browser pack: `Bun.serve` and `ServerWebSocket` are `node:http` and the `ws` package (the pack runs on Node), so starting is asynchronous (Node reports a taken port on the listen event); the default tab group is titled "dimension".

/**
 * HTTP + WebSocket server for the browser relay.
 *
 * Impersonates Chrome's CDP discovery endpoint so the pack's code realm (and
 * any puppeteer client) can connect with a plain `browserURL`:
 * - `GET /json/version` → 200 with `webSocketDebuggerUrl` once the extension
 *   is connected, 503 before that (clients like `waitForCdp` keep polling).
 * - `GET /json` / `/json/list` → attachable page targets (debugging aid).
 * - `WS /cdp` → downstream CDP clients (puppeteer).
 * - `WS /ext` → the Chrome extension (token-gated when configured).
 *
 * Binds loopback only: anything that can reach this port can drive the
 * user's logged-in browser.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { RelayBridge } from "./bridge.js";

/** Options for {@link startRelayServer}. */
export interface RelayServerOptions {
	port: number;
	/** Shared secret the extension must present as `?token=`; unset disables the check. */
	token?: string;
	/** Group tabs the agent actively drives under one per-window Chrome tab group (default on); `false` disables. */
	group?: boolean | { title: string; color: string };
	log?: (message: string, data?: Record<string, unknown>) => void;
	/** Do not let the listener keep the process alive (the pack's server serves a relay only for as long as it runs; the standalone command keeps itself alive). */
	unref?: boolean;
}

/** A running relay server. */
export interface RelayServer {
	bridge: RelayBridge;
	port: number;
	/** Closes every socket and the listener; resolves once the port is free. */
	stop(): Promise<void>;
}

const WS_KEEPALIVE_MS = 30_000;
/** Screenshots travel base64-encoded through both websocket legs. */
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
/** Default appearance of the Dimension tab group. */
const DEFAULT_GROUP = { title: "dimension", color: "cyan" } as const;

/** True when `raw` can serve as the authority of a `ws://` URL: no whitespace,
 *  slashes, userinfo, fragments, or control characters, and URL-parseable. */
function isWsAuthority(raw: string): boolean {
	if (/[\s/\\@#?]|[\x00-\x1f]/.test(raw)) return false;
	try {
		return new URL(`ws://${raw}`).host.length > 0;
	} catch {
		return false;
	}
}

/** Refuse an upgrade request with a plain HTTP status, then end the socket. */
function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
	socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: ${reason.length}\r\nContent-Type: text/plain\r\n\r\n${reason}`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const text = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
	res.end(text);
}

function sendText(res: ServerResponse, status: number, text: string): void {
	res.writeHead(status, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(text) });
	res.end(text);
}

function textOf(message: RawData): string {
	if (typeof message === "string") return message;
	if (Buffer.isBuffer(message)) return message.toString("utf8");
	if (Array.isArray(message)) return Buffer.concat(message).toString("utf8");
	return Buffer.from(message).toString("utf8");
}

/** Start the relay server on 127.0.0.1. Rejects with the listen error (`EADDRINUSE`) if the port is taken. */
export async function startRelayServer(opts: RelayServerOptions): Promise<RelayServer> {
	const log = opts.log ?? (() => {});
	const group = opts.group === false ? null : opts.group === true || opts.group === undefined ? DEFAULT_GROUP : opts.group;
	const bridge = new RelayBridge({ log, group });
	const sockets = new Set<WebSocket>();
	const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

	/** What the request is for, from its target and Host header (a client may reach the relay by any loopback name). */
	const locate = (req: IncomingMessage): { host: string; path: string; url: URL } => {
		const fallback = `127.0.0.1:${opts.port}`;
		const rawHost = req.headers.host?.trim();
		const host = rawHost && isWsAuthority(rawHost) ? rawHost : fallback;
		const url = new URL(req.url ?? "/", `http://${fallback}`);
		return { host, path: url.pathname.replace(/\/+$/, "") || "/", url };
	};

	const server: Server = createServer((req, res) => {
		const { host, path } = locate(req);
		if (path === "/cdp" || path === "/ext") return sendText(res, 426, "websocket upgrade required");
		if (req.method !== "GET") return sendText(res, 405, "Method not allowed");
		if (path === "/json/version") {
			if (!bridge.ready) return sendJson(res, 503, { error: "relay extension is not connected" });
			return sendJson(res, 200, bridge.versionInfo(`ws://${host}/cdp`));
		}
		if (path === "/json" || path === "/json/list") return sendJson(res, 200, bridge.listTargets());
		return sendText(res, 404, "Not found");
	});

	server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		const { path, url } = locate(req);
		if (path === "/cdp") {
			// Browsers set Origin on websocket upgrades; native CDP clients
			// don't. Reject any Origin so a web page can't drive the relay.
			if (req.headers.origin) return refuseUpgrade(socket, 403, "Forbidden");
			wss.handleUpgrade(req, socket, head, (ws) => accept(ws, "cdp"));
			return;
		}
		if (path === "/ext") {
			const origin = req.headers.origin;
			if (origin && !origin.startsWith("chrome-extension://")) return refuseUpgrade(socket, 403, "Forbidden");
			if (opts.token && url.searchParams.get("token") !== opts.token) return refuseUpgrade(socket, 401, "Unauthorized");
			wss.handleUpgrade(req, socket, head, (ws) => accept(ws, "ext"));
			return;
		}
		refuseUpgrade(socket, 404, "Not found");
	});

	function accept(ws: WebSocket, role: "cdp" | "ext"): void {
		sockets.add(ws);
		let connId: number | undefined;
		if (role === "ext") bridge.extConnected(ws);
		else connId = bridge.cdpConnected(ws);
		ws.on("message", (message: RawData) => {
			const text = textOf(message);
			if (role === "ext") bridge.extMessage(ws, text);
			else if (connId !== undefined) bridge.cdpMessage(connId, text);
		});
		ws.on("close", () => {
			sockets.delete(ws);
			if (role === "ext") bridge.extClosed(ws);
			else if (connId !== undefined) bridge.cdpClosed(connId);
		});
		// A socket error is followed by `close`; without a listener it would be thrown as an uncaught exception.
		ws.on("error", () => ws.terminate());
	}

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => reject(error);
		server.once("error", onError);
		server.listen({ host: "127.0.0.1", port: opts.port }, () => {
			server.off("error", onError);
			resolve();
		});
	});
	if (opts.unref) server.unref();
	// A listener error after startup must not crash the host process.
	server.on("error", (error) => log("relay server error", { error: error.message }));

	// Puppeteer connections go silent while the agent is idle; protocol-level
	// pings count as activity and keep them under any idle timeout.
	const keepalive = setInterval(() => {
		for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.ping();
	}, WS_KEEPALIVE_MS);
	keepalive.unref();

	log("relay listening", { port: opts.port });
	let stopping: Promise<void> | undefined;
	return {
		bridge,
		port: opts.port,
		stop(): Promise<void> {
			stopping ??= (async () => {
				clearInterval(keepalive);
				for (const ws of sockets) ws.terminate();
				wss.close();
				await new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				});
			})();
			return stopping;
		},
	};
}
