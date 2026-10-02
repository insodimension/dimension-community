/**
 * A fake cmux daemon, speaking cmux's real wire protocol: newline-delimited JSON requests and responses over a unix socket (a named pipe on Windows) or, for
 * the relay form, a loopback TCP port behind cmux's HMAC challenge. It stands in for the terminal app: nothing here is a browser, so what a page "is" is
 * what the test says (`FakePage`); `browser.eval` runs the script in a `vm` against a tiny fake `window` and `document`, which is enough for the helpers that
 * ask a page for its title, its size or a value.
 */
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

export interface FakePage {
	url: string;
	title: string;
	html: string;
	/** The page's snapshot refs: `@e1` and so on. */
	refs: Record<string, { role: string; name: string }>;
}

export interface FakeRequest {
	method: string;
	params: Record<string, unknown>;
}

/** What a handler answers: a result object, a daemon error, a raw line, or nothing at all (the daemon hangs). */
export type Answer = { result: unknown } | { error: { code: string; message: string } } | { raw: string } | "silence";

export interface FakeCmuxOptions {
	/** `auth <password>` is required as the first line. */
	password?: string;
	/** The relay form: a loopback port behind the HMAC challenge. */
	relay?: { id: string; token: string };
	/** Answer a request; return undefined for the default (empty result). */
	handler?: (request: FakeRequest) => Answer | undefined;
}

export interface FakeCmux {
	/** What to give `CmuxSocketClient` (a path, or `127.0.0.1:<port>` for the relay form). */
	socketPath: string;
	requests: FakeRequest[];
	/** How many connections the daemon accepted. */
	connections(): number;
	stop(): Promise<void>;
}

let dirs: string[] = [];

export async function startFakeCmux(options: FakeCmuxOptions = {}): Promise<FakeCmux> {
	const requests: FakeRequest[] = [];
	const sockets = new Set<Socket>();
	let accepted = 0;
	const server: Server = createServer((socket) => {
		accepted += 1;
		sockets.add(socket);
		socket.setEncoding("utf8");
		socket.on("error", () => undefined);
		socket.on("close", () => sockets.delete(socket));
		serve(socket, options, requests);
	});
	let socketPath: string;
	const listening = Promise.withResolvers<void>();
	if (options.relay) {
		server.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		const address = server.address();
		socketPath = `127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	} else {
		const dir = await mkdtemp(join(tmpdir(), "dimension-cmux-"));
		dirs.push(dir);
		socketPath = process.platform === "win32" ? `\\\\.\\pipe\\dimension-cmux-${randomBytes(6).toString("hex")}` : join(dir, "cmux.sock");
		server.listen(socketPath, () => listening.resolve());
		await listening.promise;
	}
	return {
		socketPath,
		requests,
		connections: () => accepted,
		async stop() {
			for (const socket of sockets) socket.destroy();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		},
	};
}

/** Remove the socket folders of every fake started (afterAll). */
export async function removeFakeCmuxDirs(): Promise<void> {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	dirs = [];
}

function serve(socket: Socket, options: FakeCmuxOptions, requests: FakeRequest[]): void {
	let buffer = "";
	let stage: "relay-auth" | "password" | "ready" = options.relay ? "relay-auth" : options.password !== undefined ? "password" : "ready";
	const nonce = randomBytes(8).toString("hex");
	if (options.relay) {
		socket.write(`${JSON.stringify({ protocol: "cmux-relay-auth", version: 1, relay_id: options.relay.id, nonce })}\n`);
	}
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (stage === "relay-auth") {
				const relay = options.relay!;
				const { mac } = JSON.parse(line) as { relay_id: string; mac: string };
				const expected = createHmac("sha256", Buffer.from(relay.token, "hex")).update(`relay_id=${relay.id}\nnonce=${nonce}\nversion=1`).digest("hex");
				if (mac !== expected) {
					socket.write(`${JSON.stringify({ ok: false })}\n`);
					socket.end();
					return;
				}
				socket.write(`${JSON.stringify({ ok: true })}\n`);
				stage = options.password !== undefined ? "password" : "ready";
			} else if (stage === "password") {
				if (line === `auth ${options.password}`) {
					socket.write("OK\n");
					stage = "ready";
				} else {
					socket.write("ERROR: Invalid password\n");
				}
			} else {
				answer(socket, line, options, requests);
			}
		}
	});
}

function answer(socket: Socket, line: string, options: FakeCmuxOptions, requests: FakeRequest[]): void {
	const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
	const asked: FakeRequest = { method: request.method, params: request.params };
	requests.push(asked);
	const reply = options.handler?.(asked) ?? { result: {} };
	if (reply === "silence") return;
	if ("raw" in reply) socket.write(`${reply.raw}\n`);
	else if ("error" in reply) socket.write(`${JSON.stringify({ id: request.id, ok: false, error: reply.error })}\n`);
	else socket.write(`${JSON.stringify({ id: request.id, ok: true, result: reply.result })}\n`);
}

/** The window every `browser.eval` script runs against: sizes a surface would report, and the page's title and text. */
function sandboxFor(page: FakePage): Record<string, unknown> {
	const documentElement = { scrollWidth: 1200, scrollHeight: 2400 };
	return {
		window: { innerWidth: 1000, innerHeight: 700, devicePixelRatio: 2, scrollX: 0, scrollY: 30 },
		document: { title: page.title, documentElement, body: { innerText: page.html } },
		location: { href: page.url },
	};
}

/**
 * The handler of a daemon with one page: it opens splits, navigates, reports a snapshot of `page.refs`, evaluates scripts against the fake window, and takes a
 * screenshot of `png`. Every other action (click, fill, ...) answers an empty result, as the daemon does. `splits` counts the surfaces it opened.
 */
export function pageHandler(page: FakePage, png?: Buffer): { handler: NonNullable<FakeCmuxOptions["handler"]>; closed: string[] } {
	const closed: string[] = [];
	let surfaces = 0;
	const handler = (request: FakeRequest): Answer | undefined => {
		switch (request.method) {
			case "browser.open_split": {
				surfaces += 1;
				if (typeof request.params.url === "string" && request.params.url !== "about:blank") page.url = request.params.url;
				return { result: { surface_id: `surface-uuid-${surfaces}`, url: page.url } };
			}
			case "surface.close":
				closed.push(String(request.params.surface_id));
				return { result: {} };
			case "browser.navigate":
				page.url = String(request.params.url);
				return { result: { url: page.url } };
			case "browser.url.get":
				return { result: { url: page.url } };
			case "browser.snapshot":
				return { result: { snapshot: "- generic", refs: page.refs, page: { url: page.url, title: page.title, html: page.html } } };
			case "browser.screenshot":
				return { result: { png_base64: (png ?? Buffer.alloc(0)).toString("base64") } };
			case "browser.eval": {
				try {
					return { result: { value: runInNewContext(String(request.params.script), sandboxFor(page)) as unknown } };
				} catch {
					return { error: { code: "js_error", message: "A JavaScript exception occurred" } };
				}
			}
			default:
				return undefined;
		}
	};
	return { handler, closed };
}
