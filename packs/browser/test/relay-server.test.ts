/** Partly copied from OMP (https://github.com/can1357/oh-my-pi, MIT): the discovery-endpoint tests are packages/coding-agent/test/tools/browser-relay-server.test.ts @ dc5f95d9e1 (Dimension omp fork).
 *  Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../third-party/omp/LICENSE.
 *  Changed for the Browser pack: the server is `node:http` and `ws`, so it runs where it ships: each test starts the pack's own relay command on Node (`--relay`, bundled
 *  like the pack's server) and talks to it from here; the raw GET is `node:net`; the access-control, adoption and taken-port tests are the pack's.
 *
 *  WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the relay either stops looking like Chrome to puppeteer, or becomes a way into the person's logged-in
 *  browser for someone it should not. The relay IS a remote control for the person's own Chrome, so who may connect is the whole security story: only
 *  loopback, never a web page (a browser sends an Origin on a websocket upgrade; the extension's is chrome-extension://), and the extension only with
 *  its token when one is configured. Past access: a client sees 503 until the extension has dialled in and 200 with a usable websocket URL after; a
 *  second pack instance adopts a relay that is already serving instead of fighting for the port; and a port held by something that is not a relay is
 *  said so, never taken over.
 */
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { WebSocket } from "ws";
import { findFreeCdpPort } from "../src/code/kinds/cdp";
import { ensureRelay, isLoopbackRelayUrl, probeRelayServer, stopOwnedRelays } from "../src/code/kinds/relay/ensure";
import type { RelayServer, startRelayServer } from "../src/code/kinds/relay/server";
import { removeRelayBundle, startRelayHost, stopRelayHosts } from "./relay-fixture";

const EXTENSION_HELLO = { t: "hello", userAgent: "test", browserVersion: "Chrome/151.0.0.0", tabs: [], attachedTabIds: [] } as const;

/** One raw HTTP exchange on a loopback socket: the request bytes exactly as given, the whole response back. */
async function rawGet(port: number, requestBytes: string, host = "127.0.0.1"): Promise<string> {
	const done = Promise.withResolvers<string>();
	let response = "";
	const socket = connect({ host, port });
	socket.on("connect", () => socket.write(requestBytes));
	socket.on("data", (chunk) => {
		response += chunk.toString("latin1");
	});
	socket.on("error", (error) => done.reject(error));
	socket.on("close", () => done.resolve(response));
	return await done.promise;
}

/** The status line a websocket upgrade request gets, read off a hand-sent request: a refusal is read the same under every runtime (Bun's `ws` reports no status). The socket is dropped as soon as the line is in. */
async function upgradeStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
	const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${Buffer.from("0123456789abcdef").toString("base64")}`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)];
	const done = Promise.withResolvers<number>();
	const socket = connect({ host: "127.0.0.1", port });
	let seen = "";
	socket.on("connect", () => socket.write(`${lines.join("\r\n")}\r\n\r\n`));
	socket.on("data", (chunk) => {
		seen += chunk.toString("latin1");
		const status = /^HTTP\/1\.1 (\d{3})/.exec(seen)?.[1];
		if (status !== undefined) {
			socket.destroy();
			done.resolve(Number(status));
		}
	});
	socket.on("error", (error) => done.reject(error));
	socket.on("close", () => done.resolve(0));
	return await done.promise;
}

function decodeChunkedBody(body: string): string {
	let decoded = "";
	let offset = 0;
	while (true) {
		const lineEnd = body.indexOf("\r\n", offset);
		if (lineEnd === -1) throw new Error("Invalid chunked response: missing chunk size");
		const length = Number.parseInt(body.slice(offset, lineEnd).split(";", 1)[0]!, 16);
		if (!Number.isFinite(length) || length < 0) throw new Error("Invalid chunked response: invalid chunk size");
		offset = lineEnd + 2;
		if (length === 0) return decoded;
		decoded += body.slice(offset, offset + length);
		offset += length + 2;
	}
}

function parseVersion(response: string): Record<string, string> {
	const boundary = response.indexOf("\r\n\r\n");
	if (boundary === -1) throw new Error("Invalid HTTP response: missing header boundary");
	const headers = response.slice(0, boundary);
	const body = response.slice(boundary + 4);
	expect(headers).toContain("200");
	return JSON.parse(/\r\ntransfer-encoding:\s*chunked\b/i.test(headers) ? decodeChunkedBody(body) : body) as Record<string, string>;
}

/** An extension socket that has said hello, as the extension's own first message does. */
async function connectExtension(port: number, options: { origin?: string; token?: string } = {}): Promise<WebSocket> {
	const query = options.token === undefined ? "" : `?token=${encodeURIComponent(options.token)}`;
	const opened = Promise.withResolvers<WebSocket>();
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ext${query}`, { headers: options.origin === undefined ? {} : { Origin: options.origin } });
	ws.once("open", () => {
		ws.send(JSON.stringify(EXTENSION_HELLO));
		opened.resolve(ws);
	});
	ws.once("error", (error) => opened.reject(error));
	return await opened.promise;
}

async function waitForDiscovery(port: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if ((await fetch(`http://127.0.0.1:${port}/json/version`)).status === 200) return;
	}
	throw new Error("Relay discovery endpoint did not become ready");
}

const extensions: WebSocket[] = [];
const strangers: Server[] = [];

afterEach(async () => {
	for (const extension of extensions.splice(0)) extension.terminate();
	await stopRelayHosts();
	await stopOwnedRelays();
	for (const stranger of strangers.splice(0)) {
		stranger.closeAllConnections();
		const closed = Promise.withResolvers<void>();
		stranger.close(() => closed.resolve());
		await closed.promise;
	}
});

afterAll(removeRelayBundle);

async function startReadyRelay(options: { token?: string } = {}): Promise<number> {
	const { port } = await startRelayHost(options);
	extensions.push(await connectExtension(port, options.token === undefined ? {} : { token: options.token }));
	await waitForDiscovery(port);
	return port;
}

describe("the relay's discovery endpoint", () => {
	test("is 503 until the extension has dialled in, then 200 with a websocket URL puppeteer can use", async () => {
		const { port } = await startRelayHost();
		const before = await fetch(`http://127.0.0.1:${port}/json/version`);
		expect(before.status).toBe(503);
		expect(await before.json()).toEqual({ error: "relay extension is not connected" });
		extensions.push(await connectExtension(port));
		await waitForDiscovery(port);
		const after = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string; Browser?: string };
		expect(after.webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
		expect(after.Browser).toBe("Chrome/151.0.0.0");
	});

	test("advertises the requested Host authority so a remote Puppeteer client dials the relay", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(port, "GET /json/version HTTP/1.1\r\nHost: 100.100.92.97:12803\r\nConnection: close\r\n\r\n");
		expect(parseVersion(response).webSocketDebuggerUrl).toBe("ws://100.100.92.97:12803/cdp");
	});

	test("uses the loopback discovery URL when an HTTP/1.0 request has no Host header", async () => {
		const port = await startReadyRelay();
		expect(parseVersion(await rawGet(port, "GET /json/version HTTP/1.0\r\n\r\n")).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
	});

	test("uses the loopback discovery URL when Host is empty", async () => {
		const port = await startReadyRelay();
		expect(parseVersion(await rawGet(port, "GET /json/version HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n")).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
	});

	test("uses the loopback discovery URL when Host would produce an unusable WebSocket authority", async () => {
		const port = await startReadyRelay();
		expect(parseVersion(await rawGet(port, "GET /json/version HTTP/1.1\r\nHost: bad/host@evil\r\nConnection: close\r\n\r\n")).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
	});

	test("lists the pages it can attach to, refuses a write, and does not know other paths", async () => {
		const port = await startReadyRelay();
		expect(Array.isArray(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())).toBe(true);
		expect((await fetch(`http://127.0.0.1:${port}/json/version`, { method: "POST" })).status).toBe(405);
		expect((await fetch(`http://127.0.0.1:${port}/nothing`)).status).toBe(404);
		expect((await fetch(`http://127.0.0.1:${port}/cdp`)).status).toBe(426);
	});
});

describe("who may connect to the relay", () => {
	test("a web page cannot drive it: a websocket upgrade to /cdp that carries an Origin is refused", async () => {
		const port = await startReadyRelay();
		expect(await upgradeStatus(port, "/cdp", { Origin: "http://evil.example" })).toBe(403);
		expect(await upgradeStatus(port, "/cdp")).toBe(101);
		// A native CDP client (puppeteer) sends no Origin and gets in.
		const native = new WebSocket(`ws://127.0.0.1:${port}/cdp`);
		const opened = Promise.withResolvers<void>();
		native.once("open", () => opened.resolve());
		native.once("error", (error) => opened.reject(error));
		await opened.promise;
		native.close();
	});

	test("the extension's socket takes only the browser's own origin: another page's origin is refused, chrome-extension:// is not", async () => {
		const { port } = await startRelayHost();
		expect(await upgradeStatus(port, "/ext", { Origin: "https://evil.example" })).toBe(403);
		extensions.push(await connectExtension(port, { origin: "chrome-extension://abcdefghijklmnop" }));
		await waitForDiscovery(port);
	});

	test("with a token configured the extension must present it", async () => {
		const { port } = await startRelayHost({ token: "s3cret" });
		expect(await upgradeStatus(port, "/ext")).toBe(401);
		expect(await upgradeStatus(port, "/ext?token=wrong")).toBe(401);
		extensions.push(await connectExtension(port, { token: "s3cret" }));
		await waitForDiscovery(port);
	});

	test("it listens on loopback only: a LAN address of this machine is refused", async () => {
		const port = await startReadyRelay();
		const lan = Object.values(networkInterfaces())
			.flat()
			.find((address) => address !== undefined && address.family === "IPv4" && !address.internal);
		if (lan === undefined) return; // no network interface to try: nothing to assert on this machine
		await expect(rawGet(port, "GET /json/version HTTP/1.0\r\n\r\n", lan.address)).rejects.toThrow();
	});
});

describe("starting a relay, and finding one already serving", () => {
	test("a second relay command on a port a relay already serves says so and leaves it serving", async () => {
		const port = await startReadyRelay();
		await expect(startRelayHost({ port })).rejects.toThrow(`The browser relay is already running on http://127.0.0.1:${port}; nothing to do.`);
		expect((await fetch(`http://127.0.0.1:${port}/json/version`)).status).toBe(200);
	});

	test("probing tells a relay (503 waiting, 200 serving) from a server that is not one", async () => {
		const { port } = await startRelayHost();
		expect(await probeRelayServer(`http://127.0.0.1:${port}`)).toBe(true);
		const stranger = createServer((_request, response) => {
			response.statusCode = 404;
			response.end("nope");
		});
		const listening = Promise.withResolvers<void>();
		stranger.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		strangers.push(stranger);
		expect(await probeRelayServer(`http://127.0.0.1:${(stranger.address() as AddressInfo).port}`)).toBe(false);
	});

	/** A relay start that serves nothing, for the tests that are about WHEN the pack starts one. */
	function fakeStart(calls: Array<{ port: number; unref?: boolean }>, failure?: Error): typeof startRelayServer {
		return async (options) => {
			calls.push({ port: options.port, ...(options.unref === undefined ? {} : { unref: options.unref }) });
			await Promise.resolve();
			if (failure) throw failure;
			// What the caller reads of a started relay is its `stop`; the rest of it is not touched.
			return { port: options.port, stop: async () => undefined } as unknown as RelayServer;
		};
	}

	test("nothing serving: the pack starts a relay in its own process, once, however many opens ask at the same time", async () => {
		const port = await findFreeCdpPort();
		const calls: Array<{ port: number; unref?: boolean }> = [];
		const start = fakeStart(calls);
		const url = `http://127.0.0.1:${port}`;
		expect(await Promise.all([ensureRelay({ cdpUrl: url, start }), ensureRelay({ cdpUrl: url, start }), ensureRelay({ cdpUrl: url, start })])).toEqual([true, true, true]);
		// One start, on the port asked for, and one that never keeps the pack's server alive.
		expect(calls).toEqual([{ port, unref: true }]);
	});

	test("a relay that is already serving is adopted: none is started", async () => {
		const { url } = await startRelayHost();
		const calls: Array<{ port: number; unref?: boolean }> = [];
		expect(await ensureRelay({ cdpUrl: url, start: fakeStart(calls) })).toBe(true);
		expect(calls).toEqual([]);
	});

	test("a relay that cannot be started leaves the open to say the endpoint is not reachable", async () => {
		const port = await findFreeCdpPort();
		const calls: Array<{ port: number; unref?: boolean }> = [];
		expect(await ensureRelay({ cdpUrl: `http://127.0.0.1:${port}`, start: fakeStart(calls, new Error("boom")) })).toBe(false);
		expect(calls).toHaveLength(1);
	});

	test("a port held by something that is not a relay is said so, never taken over", async () => {
		const stranger = createServer((_request, response) => {
			response.statusCode = 404;
			response.end("nope");
		});
		const listening = Promise.withResolvers<void>();
		stranger.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		strangers.push(stranger);
		const port = (stranger.address() as AddressInfo).port;
		const busy = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
		await expect(ensureRelay({ cdpUrl: `http://127.0.0.1:${port}`, start: fakeStart([], busy) })).rejects.toThrow(`Port ${port} is in use by something that is not a browser relay.`);
	});

	test("an endpoint this machine cannot own is never started: a remote relay must already be serving", async () => {
		let started = 0;
		const never = (): never => {
			started += 1;
			throw new Error("not for a remote endpoint");
		};
		expect(await ensureRelay({ cdpUrl: "http://relay.example.com:9224", start: never })).toBe(false);
		expect(started).toBe(0);
		for (const [url, loopback] of [
			["http://127.0.0.1:9224", true],
			["http://localhost:9224", true],
			["http://[::1]:9224", true],
			["http://192.168.1.5:9224", false],
			["http://relay.example.com", false],
			["not a url", false],
		] as const) {
			expect(isLoopbackRelayUrl(url)).toBe(loopback);
		}
	});
});
