import http from "node:http";
import { afterEach, expect, spyOn, test } from "bun:test";
import type { BrowserState } from "../src/contracts";
import type { LiveFrame } from "../src/engines/types";
import { CardClient, LiveChannel, type LiveSource } from "../src/stream";
import { BrowserRuntimeError } from "../src/store";

const viewport = { width: 800, height: 600 };
const channels: LiveChannel[] = [];
const sockets: http.ClientRequest[] = [];
afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy();
	for (const channel of channels.splice(0)) await channel.close();
});

class Source implements LiveSource {
	readonly watchers = new Map<number, Set<(frame: LiveFrame) => void>>();
	readonly released = new Map<number, () => void>();
	readonly connected = new Map<number, () => void>();
	readonly inputs: unknown[] = [];
	views = 0;
	holds = 0;
	closed = false;
	watchFrames(_id: string, callback: (frame: LiveFrame) => void, size?: "view" | { maxWidth: 480 | 1280 }): () => void {
		if (this.closed) throw new BrowserRuntimeError("unknown_browser", "closed");
		const width = typeof size === "object" ? size.maxWidth : 0;
		const listeners = this.watchers.get(width) ?? new Set<(frame: LiveFrame) => void>();
		this.watchers.set(width, listeners);
		listeners.add(callback);
		this.connected.get(width)?.();
		return () => listeners.delete(callback);
	}
	previewHolding(): () => void {
		this.holds++;
		return () => {
			this.holds--;
			this.released.get(this.holds)?.();
		};
	}
	viewing(): () => void {
		this.views++;
		return () => { this.views--; };
	}
	async liveState(): Promise<BrowserState> {
		if (this.closed) throw new BrowserRuntimeError("unknown_browser", "closed");
		return { browserId: "one", url: "http://page.test/", title: "page", viewport, tabs: [], activeTabId: "", loading: false, canGoBack: false, canGoForward: false, task: null, publish: null, dialogs: [], revision: 1, profile: null, look: null, engine: "chromium", app: null, takenOver: false, agentActionAt: null, signedInTo: [] };
	}
	async input(_id: string, events: unknown): Promise<void> { this.inputs.push(events); }
	push(width: number, byte: number): void {
		for (const callback of this.watchers.get(width) ?? []) callback({ id: String(byte), jpeg: new Uint8Array([0xff, 0xd8, byte]), viewport, capturedAt: 1 });
	}
}

function request(origin: string, route: string, method = "GET", body?: string): Promise<{ status: number; bytes: Buffer }> {
	return new Promise((resolve, reject) => {
		const req = http.request(`${origin}${route}`, { method, headers: body ? { "content-type": "application/json" } : {}, agent: false }, response => {
			const chunks: Buffer[] = [];
			response.on("data", chunk => chunks.push(chunk));
			response.on("end", () => resolve({ status: response.statusCode ?? 0, bytes: Buffer.concat(chunks) }));
		});
		sockets.push(req);
		req.on("error", reject);
		req.end(body);
	});
}
/** A card client: what it has been sent so far, and `containing(bytes)`, which settles once those bytes have arrived (the stream's first chunk is only its part header, not a picture). */
function card(origin: string, token: string): Promise<{ status: number; chunks: Buffer[]; close(): void; containing(bytes: Buffer): Promise<void> }> {
	return new Promise((resolve, reject) => {
		const req = http.get(`${origin}/p/${token}`, { agent: false }, response => {
			const chunks: Buffer[] = [];
			const has = (bytes: Buffer): boolean => Buffer.concat(chunks).includes(bytes);
			let waiting: { bytes: Buffer; done: () => void } | undefined;
			response.on("data", chunk => {
				chunks.push(chunk);
				if (waiting !== undefined && has(waiting.bytes)) { waiting.done(); waiting = undefined; }
			});
			const containing = (bytes: Buffer): Promise<void> => {
				if (has(bytes)) return Promise.resolve();
				const { promise, resolve: done } = Promise.withResolvers<void>();
				waiting = { bytes, done };
				return promise;
			};
			resolve({ status: response.statusCode ?? 0, chunks, close: () => req.destroy(), containing });
		});
		sockets.push(req);
		req.on("error", reject);
	});
}

test("a card token only streams pictures, cannot enter the View or send input, and releases its width watcher on disconnect", async () => {
	const source = new Source();
	const channel = new LiveChannel(source);
	channels.push(channel);
	const view = await channel.mint("one");
	const card480 = await channel.mintCard("one", 480);
	const card1280 = await channel.mintCard("one", 1280);
	if ("code" in card480 || "code" in card1280) throw new Error("card unexpectedly busy");
	const connected480 = Promise.withResolvers<void>();
	const connected1280 = Promise.withResolvers<void>();
	source.connected.set(480, connected480.resolve);
	source.connected.set(1280, connected1280.resolve);
	const firstPending = card(card480.origin, card480.token);
	const secondPending = card(card1280.origin, card1280.token);
	await Promise.all([connected480.promise, connected1280.promise]);
	source.push(480, 11);
	source.push(1280, 22);
	const [first, second] = await Promise.all([firstPending, secondPending]);
	expect([first.status, second.status]).toEqual([200, 200]);
	expect(source.views).toBe(0);
	expect(source.holds).toBe(2);
	expect([source.watchers.get(480)?.size, source.watchers.get(1280)?.size]).toEqual([1, 1]);
	const [viewDoor, inputDoor, wrongPicture] = await Promise.all([
		request(view.origin, `/s/${card480.token}`),
		request(view.origin, `/i/${card480.token}`, "POST", "[]"),
		request(view.origin, `/p/${view.token}`),
	]);
	expect([viewDoor.status, inputDoor.status, wrongPicture.status]).toEqual([404, 404, 404]);
	expect(source.inputs).toEqual([]);
	const frame = Buffer.from([0xff, 0xd8, 11]);
	await first.containing(frame);
	expect(Buffer.concat(first.chunks).includes(frame)).toBe(true);
	expect(Buffer.concat(second.chunks).includes(Buffer.from([0xff, 0xd8, 11]))).toBe(false);
	const releasedOne = Promise.withResolvers<void>();
	source.released.set(1, releasedOne.resolve);
	first.close();
	await releasedOne.promise;
	expect(source.watchers.get(480)?.size).toBe(0);
	expect(source.watchers.get(1280)?.size).toBe(1);
	const releasedAll = Promise.withResolvers<void>();
	source.released.set(0, releasedAll.resolve);
	second.close();
	await releasedAll.promise;
}, 10_000);

/** The part of a response a card writes to, every write kept where the test can read it. It always has room (`write` answers true), so no picture waits on a drain: only the 250 ms gap can hold one back. */
class RecordedResponse {
	readonly writes: Buffer[] = [];
	destroyed = false;
	write(chunk: Buffer): boolean {
		this.writes.push(chunk);
		return true;
	}
	once(): this {
		return this;
	}
	end(): void {
		this.destroyed = true;
	}
	destroy(): void {
		this.destroyed = true;
	}
}

test("a card opened in a young process gets its first picture at once, and the 250 ms gap still holds the next one", () => {
	// `performance.now()` counts from the process start, not from the card. At 10 ms of uptime a card used to read its first picture as 10 ms into the gap and wait the other 240 ms for it.
	const clock = spyOn(performance, "now").mockReturnValue(10);
	const response = new RecordedResponse();
	const client = new CardClient(response as unknown as http.ServerResponse, () => {});
	try {
		// The bytes of the pictures themselves: a card's part header is written when it opens and is not a picture.
		const first = Buffer.from([0xff, 0xd8, 11]);
		const second = Buffer.from([0xff, 0xd8, 22]);
		client.offer(first);
		expect(Buffer.concat(response.writes).includes(first)).toBe(true);
		// No time has passed: the next picture is kept for when the gap is over, not sent.
		client.offer(second);
		expect(Buffer.concat(response.writes).includes(second)).toBe(false);
	} finally {
		client.end(false);
		clock.mockRestore();
	}
});
