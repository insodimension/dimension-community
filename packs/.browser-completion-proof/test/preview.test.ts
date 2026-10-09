import http from "node:http";
import { afterEach, expect, test } from "bun:test";
import type { BrowserState } from "../src/contracts";
import type { LiveFrame } from "../src/engines/types";
import { LiveChannel, type LiveSource } from "../src/stream";
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
		return { browserId: "one", url: "http://page.test/", title: "page", viewport, tabs: [], activeTabId: "", loading: false, canGoBack: false, canGoForward: false, task: null, publish: null, dialogs: [], revision: 1, profile: null, look: null, engine: "chromium", app: null, takenOver: false, agentActionAt: null };
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
function card(origin: string, token: string): Promise<{ status: number; chunks: Buffer[]; close(): void; next(): Promise<void> }> {
	return new Promise((resolve, reject) => {
		const req = http.get(`${origin}/p/${token}`, { agent: false }, response => {
			const chunks: Buffer[] = [];
			let wake: (() => void) | undefined;
			response.on("data", chunk => { chunks.push(chunk); wake?.(); wake = undefined; });
			resolve({ status: response.statusCode ?? 0, chunks, close: () => req.destroy(), next: () => chunks.length ? Promise.resolve() : new Promise(done => { wake = done; }) });
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
	await first.next();
	expect(Buffer.concat(first.chunks).includes(Buffer.from([0xff, 0xd8, 11]))).toBe(true);
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
