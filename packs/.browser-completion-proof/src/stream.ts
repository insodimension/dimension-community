/**
 * The Browser View's direct channel (doc 77 §3): one loopback listener that streams a browser's live pictures and
 * state out, and takes the human's mouse and keys in, so neither rides the MCP tool-call lane.
 *
 *   GET  /s/<token>[?frames=0][&ping=1]   pictures (JPEG) and state, framed by wire.ts; `frames=0`: state only; `ping=1`: this View understands pings
 *   POST /i/<token>              one batch of input events (JSON), answered { ok } or { ok: false, code, error }
 *
 * The listener exists only while a View holds a token: it opens on the first `mint`, and closes with the last token. A token names ONE
 * browser (never a session, never another browser) and dies with its browser, after an idle limit, or with the pack. The token is the
 * credential; the Host and Origin checks keep a web page that resolves to 127.0.0.1, or any real origin, out even if it knew one.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserState } from "./contracts.js";
import type { LiveFrame } from "./engines/types.js";
import { BrowserRuntimeError } from "./store.js";
import { encode, KIND_PICTURE, KIND_STATE, PING, PING_QUERY } from "./wire.js";

/** What the channel needs of the runtime. The runtime's own `watchFrames`, `liveState` and `input` are exactly these. */
export interface LiveSource {
	/** Pictures of the browser's active tab until the returned function is called. Throws `unknown_browser`. */
	watchFrames(browserId: string, onFrame: (frame: LiveFrame) => void, size?: "view" | { maxWidth: 480 | 1280 }): () => void;
	/** The browser's state, not queued behind page work. Throws `unknown_browser` once it is closed. */
	liveState(browserId: string): Promise<BrowserState>;
	/** A View is joined to this browser's stream until the returned function is called: the runtime does not give a watched browser up. Throws `unknown_browser`. */
	viewing(browserId: string): () => void;
	/** Card reader hold: does not enter the human's View or touch wheel ownership. */
	previewHolding(browserId: string): () => void;
	/** One batch of the human's input. Rejects with a `BrowserRuntimeError` whose `code` says why. */
	input(browserId: string, events: unknown): Promise<void>;
}

export interface LiveChannelOptions {
	/** A token with no open stream and no input for this long is dropped. */
	tokenIdleMs?: number;
	/** How often a browser's state is read while a View watches. */
	stateIntervalMs?: number;
	/** The most live tokens one browser holds; minting past it drops the oldest. */
	maxTokensPerBrowser?: number;
}

const TOKEN_IDLE_MS = 60_000;
const STATE_INTERVAL_MS = 250;
/**
 * A View that asked for pings (`?ping=1`) and has been handed nothing for this long is sent a ping: nine bytes that say the pack is alive.
 * A page that is not changing sends nothing of its own, so without this a still page and a stream that has stalled (this process wedged with
 * the socket still open) look the same to the View. The View reads silence of several times this (app/view/use-browser-stream.ts
 * STREAM_SILENCE_MS) as a dead stream. It is measured per View, from the last byte written to THAT View, so a View that is handed pictures is
 * never pinged; and it ticks with the room's timer, not with the state read, so a read stuck on a wedged page does not silence the pings.
 */
export const HEARTBEAT_MS = 2_000;
const MAX_TOKENS_PER_BROWSER = 16;
const MAX_CARD_TOKENS = 4;
const CARD_FRAME_MS = 250;
const CARD_HEAD = Buffer.from("--inso-frame\r\ncontent-type: image/jpeg\r\n\r\n");
const CARD_END = Buffer.from("THE-END");
/** One input batch is at most 64 small events plus a 4 KiB paste; a body past this is not one. */
const MAX_BODY_BYTES = 256 * 1024;
/** A hostile body is read (so the answer reaches the sender) only up to here, then the connection is cut. */
const MAX_DRAIN_BYTES = 8 * 1024 * 1024;
/** The runtime's codes for a browser that no longer exists. */
const GONE_CODES: ReadonlySet<string> = new Set(["unknown_browser", "browser_closed"]);
const STATUS_BY_CODE: Record<string, number> = { task_running: 409, publish_pending: 409, bad_input: 400, bad_json: 400, unknown_browser: 410, browser_closed: 410 };
/** No body, no secret: only what lets an opaque-origin View read an answer. */
const CORS = { "access-control-allow-origin": "*" } as const;

type Parts = readonly [Uint8Array, Uint8Array];

interface Grant {
	browserId: string;
	kind: "view" | "card";
	width?: 480 | 1280;
	/** A card token permits only one socket; a new GET ends the old one. */
	card?: CardClient;
	/** Epoch ms of the last stream open, stream close or input. */
	lastUsed: number;
	/** Streams open on this token. */
	open: number;
}

/** One connected View: it is given the newest of each kind, never a backlog. */
class Client {
	#busy = false;
	#state: Parts | undefined;
	#picture: Parts | undefined;
	/** A ping is waiting to go out: set at join (it is the first thing a pinging View hears) and by the heartbeat. */
	#ping: boolean;
	/** When this View was last handed bytes, or joined (`performance.now()`): what a heartbeat measures its quiet from. */
	lastWrite = performance.now();

	constructor(
		readonly response: http.ServerResponse,
		readonly wantsPictures: boolean,
		/** The View said it understands pings (`?ping=1`); only such a View is ever sent one. */
		readonly wantsPing: boolean,
	) {
		this.#ping = wantsPing;
	}

	offerState(message: Parts): void {
		this.#state = message;
		this.#flush();
	}

	offerPicture(message: Parts): void {
		this.#picture = message;
		this.#flush();
	}

	/** The heartbeat. A View whose socket is still taking the last write is not idle, so it is not pinged; a ping never waits behind another. */
	offerPing(): void {
		if (this.#busy) return;
		this.#ping = true;
		this.#flush();
	}

	end(): void {
		this.response.end();
	}

	/**
	 * Write what is waiting, unless the socket is still taking the last write (its callback has not run). While it is, a newer message
	 * REPLACES the waiting one, so a View that cannot keep up costs the pack one message beyond what the socket already holds, not a queue.
	 */
	#flush(): void {
		const { response } = this;
		if (this.#busy || response.destroyed || response.writableEnded) return;
		const waiting = [this.#ping ? PING : undefined, this.#state, this.#picture];
		const chunks = waiting.flatMap((message) => (message === undefined ? [] : message.filter((part) => part.length > 0)));
		this.#ping = false;
		this.#state = undefined;
		this.#picture = undefined;
		if (chunks.length === 0) return;
		this.lastWrite = performance.now();
		this.#busy = true;
		const written = (): void => {
			this.#busy = false;
			this.#flush();
		};
		response.cork();
		chunks.forEach((chunk, at) => response.write(chunk, at === chunks.length - 1 ? written : undefined));
		response.uncork();
	}
}

/** Everything the Views of one browser share: one state reader, one picture watcher, the newest of each for a View that joins later. */
class Room {
	readonly clients = new Set<Client>();
	/** What ends each joined View's hold on the browser (`LiveSource.viewing`). */
	readonly #leases = new Map<Client, () => void>();
	#stopWatching: (() => void) | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	#sampling = false;
	/** The state the Views were last told: as JSON to see a change, as the message to tell it again. */
	#last: { json: string; message: Parts } | undefined;
	#lastPicture: Parts | undefined;

	constructor(
		readonly browserId: string,
		private readonly source: LiveSource,
		private readonly intervalMs: number,
		/** The last View left. */
		private readonly onEmpty: (room: Room) => void,
		/** The browser is closed. */
		private readonly onClosed: (room: Room) => void,
	) {}

	join(client: Client): void {
		this.clients.add(client);
		// Joined means watching: from here until it leaves, the runtime will not give this browser up.
		try {
			this.#leases.set(client, this.source.viewing(this.browserId));
		} catch (error) {
			if (!isGone(error)) throw error;
			this.onClosed(this);
			return;
		}
		this.#timer ??= setInterval(() => {
			this.#beat();
			void this.#sample();
		}, this.intervalMs);
		if (client.wantsPictures) this.#watch();
		if (this.#last !== undefined) client.offerState(this.#last.message);
		else void this.#sample();
		if (client.wantsPictures && this.#lastPicture !== undefined) client.offerPicture(this.#lastPicture);
	}

	leave(client: Client): void {
		this.clients.delete(client);
		this.#leases.get(client)?.();
		this.#leases.delete(client);
		if (![...this.clients].some((other) => other.wantsPictures)) this.#unwatch();
		if (this.clients.size > 0) return;
		this.#stop();
		this.onEmpty(this);
	}

	/** The browser is gone, or the pack is stopping: every View is told by its stream ending. */
	end(): void {
		const clients = [...this.clients];
		this.clients.clear();
		for (const release of this.#leases.values()) release();
		this.#leases.clear();
		this.#stop();
		for (const client of clients) client.end();
	}

	#stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#unwatch();
	}

	#watch(): void {
		if (this.#stopWatching !== undefined) return;
		try {
			this.#stopWatching = this.source.watchFrames(this.browserId, (frame) => this.#picture(frame));
		} catch (error) {
			if (isGone(error)) this.onClosed(this);
		}
	}

	#unwatch(): void {
		this.#stopWatching?.();
		this.#stopWatching = undefined;
		this.#lastPicture = undefined;
	}

	#picture(frame: LiveFrame): void {
		const message = encode(KIND_PICTURE, { id: frame.id, viewport: frame.viewport, at: frame.capturedAt }, frame.jpeg);
		this.#lastPicture = message;
		for (const client of this.clients) if (client.wantsPictures) client.offerPicture(message);
	}

	/** Read the state; tell the Views only when it differs from the last they were told. */
	async #sample(): Promise<void> {
		if (this.#sampling) return;
		this.#sampling = true;
		try {
			const state = await this.source.liveState(this.browserId);
			const json = JSON.stringify(state);
			if (this.#last !== undefined && json === this.#last.json) return;
			const message = encode(KIND_STATE, state);
			this.#last = { json, message };
			for (const client of this.clients) client.offerState(message);
		} catch (error) {
			// A page mid-navigation can fail one read; only a closed browser ends the stream.
			if (isGone(error)) this.onClosed(this);
		} finally {
			this.#sampling = false;
		}
	}

	/** A View that asked for pings and has been handed nothing for the heartbeat gets one. Not tied to the state read: that can be stuck on a wedged page while this process is perfectly alive. */
	#beat(): void {
		const now = performance.now();
		for (const client of this.clients) if (client.wantsPing && now - client.lastWrite >= HEARTBEAT_MS) client.offerPing();
	}
}

/** A card never accumulates frames: one newest picture waits for drain and the 250 ms gate. */
class CardClient {
	#pending: Uint8Array | undefined;
	#blocked = false;
	#last = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#ended = false;
	constructor(readonly response: http.ServerResponse, readonly leave: () => void) {
		response.write(CARD_HEAD);
		response.once("drain", () => { this.#blocked = false; this.#flush(); });
		response.once("close", () => this.end(false));
	}
	offer(jpeg: Uint8Array): void {
		if (this.#ended || jpeg.byteLength > 2 * 1024 * 1024) return;
		this.#pending = jpeg;
		this.#flush();
	}
	#flush(): void {
		if (this.#blocked || this.#ended || !this.#pending) return;
		const wait = CARD_FRAME_MS - (performance.now() - this.#last);
		if (wait > 0) {
			this.#timer ??= setTimeout(() => { this.#timer = undefined; this.#flush(); }, wait);
			return;
		}
		const jpeg = this.#pending;
		this.#pending = undefined;
		this.#last = performance.now();
		this.#blocked = !this.response.write(Buffer.concat([Buffer.from(jpeg), Buffer.from("\r\n"), CARD_HEAD]));
		if (this.#blocked) this.response.once("drain", () => { this.#blocked = false; this.#flush(); });
		else this.#flush();
	}
	end(deliberate = true): void {
		if (this.#ended) return;
		this.#ended = true;
		clearTimeout(this.#timer);
		this.#pending = undefined;
		if (deliberate && !this.response.destroyed) this.response.end(CARD_END);
		else this.response.destroy();
		this.leave();
	}
}

function isGone(error: unknown): boolean {
	return error instanceof BrowserRuntimeError && GONE_CODES.has(error.code);
}

function notFound(response: http.ServerResponse, cors: boolean): void {
	response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...(cors ? CORS : {}) });
	response.end("Not found.\n");
}

function reply(response: http.ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...CORS });
	response.end(JSON.stringify(body));
}

export class LiveChannel {
	readonly #source: LiveSource;
	readonly #tokenIdleMs: number;
	readonly #stateIntervalMs: number;
	readonly #maxTokens: number;
	/** In minting order, so the oldest is first. */
	readonly #grants = new Map<string, Grant>();
	readonly #rooms = new Map<string, Room>();
	readonly #cardRooms = new Map<string, { clients: Set<CardClient>; stop: () => void; release: () => void; check: ReturnType<typeof setInterval> }>();
	#server: http.Server | undefined;
	#listening: Promise<number> | undefined;
	#port = 0;
	#sweeper: ReturnType<typeof setInterval> | undefined;

	constructor(source: LiveSource, options: LiveChannelOptions = {}) {
		this.#source = source;
		this.#tokenIdleMs = options.tokenIdleMs ?? TOKEN_IDLE_MS;
		this.#stateIntervalMs = options.stateIntervalMs ?? STATE_INTERVAL_MS;
		this.#maxTokens = options.maxTokensPerBrowser ?? MAX_TOKENS_PER_BROWSER;
	}

	/** A token for one View of `browserId`, and where to find the listener. Throws `unknown_browser` when there is no such browser. */
	async mint(browserId: string): Promise<{ origin: string; token: string }> {
		await this.#source.liveState(browserId);
		const port = await this.#listen();
		const mine = [...this.#grants].filter(([, grant]) => grant.browserId === browserId && grant.kind === "view");
		for (const [token] of mine.slice(0, Math.max(0, mine.length - this.#maxTokens + 1))) this.#revoke(token);
		const token = randomBytes(24).toString("base64url");
		this.#grants.set(token, { browserId, kind: "view", lastUsed: Date.now(), open: 0 });
		this.#sweeper ??= setInterval(() => this.#sweep(), Math.min(1_000, this.#tokenIdleMs));
		this.#sweeper.unref();
		return { origin: `http://127.0.0.1:${port}`, token };
	}
	/** Card grants cannot evict View grants, and never retain a browser until an image consumer connects. */
	async mintCard(browserId: string, width: 480 | 1280): Promise<{ origin: string; token: string } | { code: "busy" }> {
		await this.#source.liveState(browserId);
		const mine = [...this.#grants].filter(([, grant]) => grant.browserId === browserId && grant.kind === "card");
		if (mine.length >= MAX_CARD_TOKENS) {
			const idle = mine.find(([, grant]) => grant.open === 0);
			if (!idle) return { code: "busy" };
			this.#revoke(idle[0]);
		}
		const port = await this.#listen();
		const token = randomBytes(24).toString("base64url");
		this.#grants.set(token, { browserId, kind: "card", width, lastUsed: Date.now(), open: 0 });
		this.#sweeper ??= setInterval(() => this.#sweep(), Math.min(1_000, this.#tokenIdleMs));
		this.#sweeper.unref();
		return { origin: `http://127.0.0.1:${port}`, token };
	}

	/** Every stream ends, every token dies, the listener closes. */
	async close(): Promise<void> {
		for (const room of [...this.#rooms.values()]) room.end();
		for (const room of this.#cardRooms.values()) {
			clearInterval(room.check);
			for (const client of [...room.clients]) client.end();
			room.stop();
			room.release();
		}
		this.#cardRooms.clear();
		this.#grants.clear();
		await this.#shutDown();
	}

	#listen(): Promise<number> {
		this.#listening ??= (async () => {
			const server = http.createServer((request, response) => void this.#handle(request, response));
			// A View's connection is a stream; Node's request timeouts are for requests, and a quiet page is a legitimate silence.
			server.requestTimeout = 0;
			server.keepAliveTimeout = 5_000;
			server.on("connection", (socket) => socket.setNoDelay(true));
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
			await promise;
			this.#server = server;
			this.#port = (server.address() as AddressInfo).port;
			return this.#port;
		})();
		return this.#listening;
	}

	async #shutDown(): Promise<void> {
		clearInterval(this.#sweeper);
		this.#sweeper = undefined;
		const server = this.#server;
		this.#server = undefined;
		this.#listening = undefined;
		if (server === undefined) return;
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		server.closeAllConnections();
		await closed.promise;
	}

	/** Drop every token that has sat idle with no stream; close the listener when none is left. */
	#sweep(): void {
		const now = Date.now();
		for (const [token, grant] of this.#grants) if (grant.open === 0 && now - grant.lastUsed > this.#tokenIdleMs) this.#revoke(token);
		this.#closeIfUnused();
	}

	#revoke(token: string): void {
		const grant = this.#grants.get(token);
		if (!grant) return;
		this.#grants.delete(token);
		grant.card?.end();
	}

	#closeIfUnused(): void {
		if (this.#grants.size === 0) void this.#shutDown().catch(() => undefined);
	}

	/** The browser is closed: its tokens die and its streams end. */
	#revokeBrowser(browserId: string): void {
		for (const [token, grant] of this.#grants) if (grant.browserId === browserId) this.#revoke(token);
		const room = this.#rooms.get(browserId);
		this.#rooms.delete(browserId);
		room?.end();
		for (const [key, card] of this.#cardRooms) if (key.startsWith(`${browserId}|`)) {
			clearInterval(card.check);
			this.#cardRooms.delete(key);
			for (const client of [...card.clients]) client.end();
			card.stop();
			card.release();
		}
		this.#closeIfUnused();
	}

	#room(browserId: string): Room {
		let room = this.#rooms.get(browserId);
		if (room === undefined) {
			room = new Room(
				browserId,
				this.#source,
				this.#stateIntervalMs,
				(empty) => {
					if (this.#rooms.get(empty.browserId) === empty) this.#rooms.delete(empty.browserId);
				},
				(closed) => this.#revokeBrowser(closed.browserId),
			);
			this.#rooms.set(browserId, room);
		}
		return room;
	}

	async #handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
		// Not the loopback address this listener was reached at: a name an attacker's page rebound to 127.0.0.1. No answer, no CORS header.
		if (request.headers.host !== `127.0.0.1:${this.#port}`) return notFound(response, false);
		// A sandboxed View's origin is `null`; a non-browser caller sends none. A page on a real origin is neither.
		const origin = request.headers.origin;
		if (origin !== undefined && origin !== "null") return notFound(response, false);
		const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.#port}`);
		const [empty, route, token, ...more] = url.pathname.split("/");
		const grant = token === undefined ? undefined : this.#grants.get(token);
		if (empty !== "" || more.length > 0 || grant === undefined || (route !== "s" && route !== "i" && route !== "p")) return notFound(response, true);
		if (request.method === "OPTIONS") {
			response.writeHead(204, { ...CORS, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-allow-private-network": "true", "access-control-max-age": "600" });
			return void response.end();
		}
		if (route === "p" && grant.kind === "card" && request.method === "GET") return this.#cardStream(request, response, grant);
		if (grant.kind !== "view") return notFound(response, true);
		if (route === "s" && request.method === "GET") return this.#stream(request, response, grant, url.searchParams.get("frames") !== "0", url.searchParams.get(PING_QUERY) === "1");
		if (route === "i" && request.method === "POST") return await this.#input(request, response, grant);
		return notFound(response, true);
	}

	#cardStream(request: http.IncomingMessage, response: http.ServerResponse, grant: Grant): void {
		grant.card?.end();
		const key = `${grant.browserId}|${grant.width}`;
		let room = this.#cardRooms.get(key);
		if (!room) {
			const clients = new Set<CardClient>();
			let release: (() => void) | undefined;
			let stop: () => void;
			try {
				release = this.#source.previewHolding(grant.browserId);
				stop = this.#source.watchFrames(grant.browserId, frame => {
					for (const client of clients) client.offer(frame.jpeg);
				}, { maxWidth: grant.width! });
			} catch (error) {
				release?.();
				if (isGone(error)) this.#revokeBrowser(grant.browserId);
				return notFound(response, true);
			}
			const check = setInterval(() => {
				void this.#source.liveState(grant.browserId).catch(error => {
					if (isGone(error)) this.#revokeBrowser(grant.browserId);
				});
			}, this.#stateIntervalMs);
			room = { clients, stop, release, check };
			this.#cardRooms.set(key, room);
		}
		grant.open = 1;
		response.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=inso-frame", "cache-control": "no-store", "x-content-type-options": "nosniff", connection: "close" });
		const current = room;
		const client = new CardClient(response, () => {
			current.clients.delete(client);
			if (grant.card === client) grant.card = undefined;
			grant.open = 0;
			grant.lastUsed = Date.now();
			if (current.clients.size === 0 && this.#cardRooms.get(key) === current) {
				this.#cardRooms.delete(key);
				clearInterval(current.check);
				current.stop();
				current.release();
			}
		});
		grant.card = client;
		current.clients.add(client);
		request.once("close", () => client.end(false));
	}

	#stream(request: http.IncomingMessage, response: http.ServerResponse, grant: Grant, wantsPictures: boolean, wantsPing: boolean): void {
		grant.open += 1;
		response.writeHead(200, { ...CORS, "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" });
		const client = new Client(response, wantsPictures, wantsPing);
		const room = this.#room(grant.browserId);
		let left = false;
		const leave = (): void => {
			if (left) return;
			left = true;
			grant.open -= 1;
			grant.lastUsed = Date.now();
			room.leave(client);
		};
		// Node closes the response and the request when the View goes; Bun only the request.
		request.once("close", leave);
		response.once("close", leave);
		room.join(client);
	}

	async #input(request: http.IncomingMessage, response: http.ServerResponse, grant: Grant): Promise<void> {
		grant.lastUsed = Date.now();
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of request as AsyncIterable<Buffer>) {
			size += chunk.length;
			if (size > MAX_DRAIN_BYTES) return void request.destroy();
			if (size <= MAX_BODY_BYTES) chunks.push(chunk);
		}
		if (size > MAX_BODY_BYTES) return reply(response, 413, { ok: false, code: "too_large", error: `input is larger than ${MAX_BODY_BYTES} bytes` });
		let events: unknown;
		try {
			events = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			return reply(response, 400, { ok: false, code: "bad_json", error: "input must be JSON" });
		}
		try {
			await this.#source.input(grant.browserId, events);
			reply(response, 200, { ok: true });
		} catch (error) {
			const code = error instanceof BrowserRuntimeError ? error.code : "input_failed";
			if (isGone(error)) this.#revokeBrowser(grant.browserId);
			reply(response, STATUS_BY_CODE[code] ?? 500, { ok: false, code, error: error instanceof Error ? error.message : String(error) });
		}
	}
}
