/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the Browser View's picture stream and input door become a
 *  hole or a stall. Someone who is not the View (a web page on another name that resolves to 127.0.0.1, a page
 *  that guessed a port, another browser's token) reads a person's logged-in browser or types into it; or a View
 *  that went away leaves Chrome screencasting for nobody and a listener open for good; or one slow View makes
 *  the pack hold every picture it was ever sent; or a closed browser keeps a live door.
 *
 *  Real HTTP on a real loopback socket against a fake browser source: the contract is what a client can observe
 *  (status codes, bytes, who is called, what is released), not how the listener is built.
 */
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, test } from "bun:test";
import type { BrowserState } from "../src/contracts";
import type { LiveFrame } from "../src/engines/types";
import { HEARTBEAT_MS, LiveChannel, type LiveChannelOptions, type LiveSource } from "../src/stream";
import { BrowserRuntimeError } from "../src/store";
import { KIND_PICTURE, KIND_PING, KIND_STATE, type Message, PING_QUERY, Reader } from "../src/wire";

const VIEWPORT = { width: 800, height: 600 };

function stateOf(browserId: string, over: Partial<BrowserState> = {}): BrowserState {
	return { browserId, url: "http://page.test/", title: "t", viewport: VIEWPORT, tabs: [], activeTabId: "", loading: false, canGoBack: false, canGoForward: false, task: null, publish: null, dialogs: [], revision: 1, profile: null, look: null, engine: "chromium", app: null, takenOver: false, agentActionAt: null, ...over };
}

/** A browser as the listener sees one: frames pushed on demand, state it can change, input it records. */
class FakeSource implements LiveSource {
	readonly watchers = new Map<string, Set<(frame: LiveFrame) => void>>();
	readonly closed = new Set<string>();
	readonly states = new Map<string, BrowserState>();
	readonly inputs: Array<{ browserId: string; events: unknown }> = [];
	inputError: BrowserRuntimeError | null = null;
	readonly viewers = new Map<string, number>();
	readonly previewHolds = new Map<string, number>();
	watchCalls = 0;
	stateReads = 0;
	/** While set, a state read never answers, as a renderer stuck in a navigation would leave it. */
	hangReads = false;

	open(browserId: string): void {
		this.watchers.set(browserId, new Set());
		this.states.set(browserId, stateOf(browserId));
	}
	/** How many Views the runtime has been told are on this browser. */
	viewersOf(browserId: string): number {
		return this.viewers.get(browserId) ?? 0;
	}
	watching(browserId: string): number {
		return this.watchers.get(browserId)?.size ?? 0;
	}
	private require(browserId: string): Set<(frame: LiveFrame) => void> {
		const set = this.watchers.get(browserId);
		if (!set || this.closed.has(browserId)) throw new BrowserRuntimeError("unknown_browser", "unknown or already closed browserId");
		return set;
	}
	watchFrames(browserId: string, onFrame: (frame: LiveFrame) => void): () => void {
		const set = this.require(browserId);
		this.watchCalls += 1;
		set.add(onFrame);
		return () => void set.delete(onFrame);
	}
	viewing(browserId: string): () => void {
		this.require(browserId);
		this.viewers.set(browserId, this.viewersOf(browserId) + 1);
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			this.viewers.set(browserId, this.viewersOf(browserId) - 1);
		};
	}
	previewHolding(browserId: string): () => void {
		this.require(browserId);
		this.previewHolds.set(browserId, (this.previewHolds.get(browserId) ?? 0) + 1);
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			const remaining = (this.previewHolds.get(browserId) ?? 0) - 1;
			if (remaining === 0) this.previewHolds.delete(browserId);
			else this.previewHolds.set(browserId, remaining);
		};
	}
	async liveState(browserId: string): Promise<BrowserState> {
		this.require(browserId);
		this.stateReads += 1;
		if (this.hangReads) await Promise.withResolvers<never>().promise;
		return structuredClone(this.states.get(browserId) as BrowserState);
	}
	async input(browserId: string, events: unknown): Promise<void> {
		this.require(browserId);
		if (this.inputError) throw this.inputError;
		this.inputs.push({ browserId, events });
	}
	push(browserId: string, id: string, size = 64): void {
		const jpeg = new Uint8Array(size).fill(id.length);
		jpeg.set([0xff, 0xd8]);
		for (const listener of [...this.require(browserId)]) listener({ id, jpeg, viewport: VIEWPORT, capturedAt: Date.now() });
	}
}

const channels: LiveChannel[] = [];
const opened: Array<{ close(): void }> = [];

const restores: Array<() => void> = [];

afterEach(async () => {
	for (const restore of restores.splice(0)) restore();
	for (const stream of opened.splice(0)) stream.close();
	for (const channel of channels.splice(0)) await channel.close();
});

/**
 * The pack measures how long it has written nothing to a View with `performance.now()`. A test that wants that cadence exactly freezes the clock and
 * moves it itself, so "not yet" and "now" are asserted without racing a real timer. The sockets and the pack's own tick stay real.
 */
function frozenClock(): { advance(ms: number): void } {
	const real = performance.now;
	// A whole millisecond: the clock then moves in whole milliseconds and "exactly the heartbeat" is exact, not 1999.9999999.
	let now = Math.floor(real.call(performance));
	performance.now = () => now;
	restores.push(() => {
		performance.now = real;
	});
	return {
		advance: (ms) => {
			now += ms;
		},
	};
}

function channelFor(source: LiveSource, options: LiveChannelOptions = {}): LiveChannel {
	const channel = new LiveChannel(source, { stateIntervalMs: 20, ...options });
	channels.push(channel);
	return channel;
}

interface OpenStream {
	status: number;
	headers: http.IncomingHttpHeaders;
	messages: Message[];
	/** Every byte received so far, whatever it held. */
	readonly bytes: number;
	ended: Promise<void>;
	waitFor(predicate: (messages: Message[]) => boolean, ms?: number): Promise<void>;
	resume(): void;
	close(): void;
}

/** GET a stream like the View's fetch: whatever bytes arrive go through the shared Reader. `host` and `origin` override those headers. */
function openStream(origin: string, token: string, extra: { frames?: boolean; ping?: boolean; host?: string; origin?: string; pause?: boolean } = {}): Promise<OpenStream> {
	const query = new URLSearchParams();
	if (extra.frames === false) query.set("frames", "0");
	if (extra.ping) query.set(PING_QUERY, "1");
	const url = new URL(`${origin}/s/${token}${query.size > 0 ? `?${query}` : ""}`);
	return new Promise((resolve, reject) => {
		const request = http.get(url, { headers: { ...(extra.host ? { host: extra.host } : {}), ...(extra.origin ? { origin: extra.origin } : {}) }, agent: false }, (response) => {
			const reader = new Reader();
			const messages: Message[] = [];
			const waiters: Array<() => void> = [];
			let received = 0;
			const ended = new Promise<void>((done) => {
				response.on("close", done);
				response.on("error", done);
			});
			if (response.statusCode !== 200) {
				response.resume();
				resolve({ status: response.statusCode ?? 0, headers: response.headers, messages, bytes: 0, ended, waitFor: async () => undefined, resume: () => undefined, close: () => request.destroy() });
				return;
			}
			if (extra.pause) response.pause();
			response.on("data", (chunk: Buffer) => {
				received += chunk.length;
				for (const message of reader.push(chunk)) messages.push(message);
				for (const wake of waiters.splice(0)) wake();
			});
			const stream: OpenStream = {
				get bytes() {
					return received;
				},
				status: 200,
				headers: response.headers,
				messages,
				ended,
				waitFor: (predicate, ms = 3_000) =>
					new Promise((done, fail) => {
						const timer = setTimeout(() => fail(new Error(`timed out waiting; got ${messages.map((m) => (m.kind === KIND_PICTURE ? `picture:${m.head.id}` : m.kind === KIND_PING ? "ping" : "state")).join(",")}`)), ms);
						const check = (): void => {
							if (predicate(messages)) {
								clearTimeout(timer);
								done();
							} else waiters.push(check);
						};
						check();
					}),
				resume: () => response.resume(),
				close: () => request.destroy(),
			};
			resolve(stream);
		});
		request.on("error", (error) => reject(error));
		opened.push({ close: () => request.destroy() });
	});
}

const pictures = (messages: Message[]): string[] => messages.flatMap((message) => (message.kind === KIND_PICTURE ? [message.head.id] : []));
const states = (messages: Message[]) => messages.filter((message) => message.kind === KIND_STATE);
const pings = (messages: Message[]) => messages.filter((message) => message.kind === KIND_PING);

/** A raw HTTP exchange where the test controls every header (the Host header cannot be set through fetch). */
function raw(origin: string, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const request = http.request(new URL(path, origin), { method, headers, agent: false }, (response) => {
			// A stream never ends: its status is the answer.
			if (response.statusCode === 200 && path.startsWith("/s/")) {
				request.destroy();
				resolve({ status: 200, text: "" });
				return;
			}
			let text = "";
			response.on("data", (chunk: Buffer) => (text += chunk.toString()));
			response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
		});
		request.on("error", reject);
		request.end(body);
	});
}

const post = (origin: string, token: string, body: unknown, headers: Record<string, string> = {}) =>
	raw(origin, "POST", `/i/${token}`, { "content-type": "text/plain;charset=UTF-8", ...headers }, typeof body === "string" ? body : JSON.stringify(body));

describe("who may open the door", () => {
	test("a token for a browser opens its stream; any other token, no token or another path is the same 404", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");

		expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(token.length).toBeGreaterThanOrEqual(32);
		const good = await openStream(origin, token);
		expect(good.status).toBe(200);

		const answers = await Promise.all([
			raw(origin, "GET", `/s/${token.slice(0, -1)}x`, {}),
			raw(origin, "GET", "/s/", {}),
			raw(origin, "GET", `/s`, {}),
			raw(origin, "GET", `/x/${token}`, {}),
			raw(origin, "GET", `/`, {}),
			raw(origin, "POST", `/s/${token}`, {}, "[]"),
			raw(origin, "GET", `/i/${token}`, {}),
			raw(origin, "DELETE", `/s/${token}`, {}),
		]);
		for (const answer of answers) expect(answer).toEqual({ status: 404, text: "Not found.\n" });
	});

	test("two Views of one browser hold two different tokens", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const first = await channel.mint("a");
		const second = await channel.mint("a");
		expect(second.token).not.toBe(first.token);
		expect(second.origin).toBe(first.origin);
	});

	test("minting for a browser that does not exist is refused and opens no listener", async () => {
		const channel = channelFor(new FakeSource());
		await expect(channel.mint("nope")).rejects.toThrow(/unknown or already closed browserId/);
	});

	test("a request whose Host is not the loopback address it connected to is refused (DNS rebinding), token or not", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");

		for (const host of ["evil.example.test", `evil.example.test:${new URL(origin).port}`, `localhost:${new URL(origin).port}`, "127.0.0.1"]) {
			expect((await raw(origin, "GET", `/s/${token}`, { host })).status).toBe(404);
			expect((await post(origin, token, [{ kind: "text", text: "x" }], { host })).status).toBe(404);
		}
		expect(source.inputs).toEqual([]);
		expect((await raw(origin, "GET", `/s/${token}`, {})).status).toBe(200);
	});

	test("a page on a real origin is refused; the sandboxed View's `null` origin and a non-browser caller are not", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");

		expect((await openStream(origin, token, { origin: "https://evil.example.test" })).status).toBe(404);
		expect((await openStream(origin, token, { origin: "http://127.0.0.1:5431" })).status).toBe(404);
		expect((await post(origin, token, [{ kind: "text", text: "x" }], { origin: "https://evil.example.test" })).status).toBe(404);
		expect((await openStream(origin, token, { origin: "null" })).status).toBe(200);
		expect((await post(origin, token, [{ kind: "text", text: "x" }], { origin: "null" })).status).toBe(200);
		expect((await post(origin, token, [{ kind: "text", text: "y" }])).status).toBe(200);
		expect(source.inputs.map((input) => input.events)).toEqual([[{ kind: "text", text: "x" }], [{ kind: "text", text: "y" }]]);
	});

	test("answers carry the CORS header the View's opaque origin needs, and a preflight is answered", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");

		const stream = await openStream(origin, token, { origin: "null" });
		expect(stream.headers["access-control-allow-origin"]).toBe("*");
		expect(stream.headers["cache-control"]).toBe("no-store");
		const preflight = await raw(origin, "OPTIONS", `/i/${token}`, { origin: "null", "access-control-request-method": "POST", "access-control-request-private-network": "true" });
		expect(preflight.status).toBe(204);
	});
});

describe("what a View receives", () => {
	test("its browser's state at once, then each picture the browser makes, with the page size it was taken at", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");
		const stream = await openStream(origin, token);

		await stream.waitFor((messages) => states(messages).length >= 1);
		expect(states(stream.messages)[0]).toMatchObject({ state: { browserId: "a", url: "http://page.test/" } });
		source.push("a", "p1", 100);
		source.push("a", "p2", 120);
		await stream.waitFor((messages) => pictures(messages).includes("p2"));
		const picture = stream.messages.find((message) => message.kind === KIND_PICTURE);
		expect(picture).toMatchObject({ head: { id: expect.any(String), viewport: VIEWPORT } });
		expect([...(picture as { jpeg: Uint8Array }).jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
		expect(pictures(stream.messages).at(-1)).toBe("p2");
	});

	test("only its own browser's pictures: another browser's never reach it", async () => {
		const source = new FakeSource();
		source.open("a");
		source.open("b");
		const channel = channelFor(source);
		const aToken = await channel.mint("a");
		const a = await openStream(aToken.origin, aToken.token);
		const bToken = await channel.mint("b");
		const b = await openStream(bToken.origin, bToken.token);

		source.push("a", "only-a");
		source.push("b", "only-b");
		await a.waitFor((messages) => pictures(messages).length >= 1);
		await b.waitFor((messages) => pictures(messages).length >= 1);
		// Both were pushed in one turn: had either leaked into the other it would be there by now.
		expect(pictures(a.messages)).toEqual(["only-a"]);
		expect(pictures(b.messages)).toEqual(["only-b"]);
		expect(states(a.messages).every((message) => (message as { state: { browserId: string } }).state.browserId === "a")).toBe(true);
	});

	test("a View that joins later is given the newest picture at once, without waiting for the page to change", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const first = await channel.mint("a");
		const early = await openStream(first.origin, first.token);
		source.push("a", "old");
		source.push("a", "newest");
		await early.waitFor((messages) => pictures(messages).includes("newest"));

		const second = await channel.mint("a");
		const late = await openStream(second.origin, second.token);
		await late.waitFor((messages) => pictures(messages).length >= 1);
		expect(pictures(late.messages)).toEqual(["newest"]);
		// One picture watcher serves both: a second View does not start a second screencast.
		expect(source.watchCalls).toBe(1);
	});

	test("state follows the browser and is sent when it changed, not on every read", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");
		const stream = await openStream(origin, token, { frames: false });

		await stream.waitFor((messages) => states(messages).length >= 1);
		// Let the browser be read several more times with nothing new to say.
		const reads = source.stateReads;
		await waitUntil(() => source.stateReads >= reads + 5);
		expect(states(stream.messages)).toHaveLength(1);

		source.states.set("a", stateOf("a", { url: "http://page.test/next", loading: true }));
		await stream.waitFor((messages) => states(messages).length >= 2);
		expect(states(stream.messages)[1]).toMatchObject({ state: { url: "http://page.test/next", loading: true } });
	});

	test("a View that asks for state only (annotating) starts no screencast, and one that wants pictures does", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");

		const quiet = await openStream(origin, token, { frames: false });
		await quiet.waitFor((messages) => states(messages).length >= 1);
		expect(source.watching("a")).toBe(0);

		const live = await openStream(origin, token);
		await live.waitFor((messages) => states(messages).length >= 1);
		expect(source.watching("a")).toBe(1);
		source.push("a", "seen");
		await live.waitFor((messages) => pictures(messages).includes("seen"));
		// Delivered to the one that asked in the same turn: the quiet one would have it by now.
		expect(pictures(quiet.messages)).toEqual([]);
	});

	/** Let the pack's own tick run `count` more times (each one reads the browser's state, or finds a read still pending). */
	async function ticks(source: FakeSource, count = 3): Promise<void> {
		const reads = source.stateReads;
		await waitUntil(() => source.stateReads >= reads + count);
	}

	test("a quiet View that asked for pings is pinged once its heartbeat has passed with nothing written to it, nine bytes a time, and is never told the state again", async () => {
		const clock = frozenClock();
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");
		const stream = await openStream(origin, token, { frames: false, ping: true });

		// Joined: a ping first (it proves the pack pings), then the state.
		await stream.waitFor((messages) => pings(messages).length === 1 && states(messages).length === 1);
		for (let heard = 2; heard <= 4; heard += 1) {
			clock.advance(HEARTBEAT_MS - 1);
			await ticks(source);
			// Fails if the pack pings before the heartbeat is up.
			expect(pings(stream.messages)).toHaveLength(heard - 1);
			const before = stream.bytes;
			clock.advance(1);
			// Fails if a quiet stream sends nothing: the View could not tell it from one that stalled.
			await stream.waitFor((messages) => pings(messages).length === heard);
			// The header and nothing else: the state, with every tab's favicon, is not sent again.
			expect(stream.bytes - before).toBe(9);
		}
		expect(states(stream.messages)).toHaveLength(1);
	});

	test("a View that is handed pictures is not pinged, however long it watches, while a quiet View of the same browser still is", async () => {
		const clock = frozenClock();
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");
		const watching = await openStream(origin, token, { ping: true });
		const quiet = await openStream(origin, token, { frames: false, ping: true });
		await Promise.all([watching, quiet].map((stream) => stream.waitFor((messages) => pings(messages).length === 1 && states(messages).length === 1)));

		// Twelve seconds, six heartbeats: a picture every second for one View, nothing for the other.
		for (let at = 1; at <= 12; at += 1) {
			clock.advance(1_000);
			source.push("a", `p${at}`);
			await watching.waitFor((messages) => pictures(messages).includes(`p${at}`));
		}
		await ticks(source);
		// Fails if handing a View bytes does not count as hearing from the pack (`lastWrite` never moved): it would be pinged on every tick once a heartbeat had passed since it joined.
		expect(pings(watching.messages)).toHaveLength(1);
		// Fails if the quiet is measured per browser: the pictures sent to one View would keep the other from ever being pinged.
		expect(pings(quiet.messages).length).toBeGreaterThanOrEqual(2);
		// Fails if a quiet View is pinged faster than its heartbeat (greeting, then at most one per two seconds).
		expect(pings(quiet.messages).length).toBeLessThanOrEqual(1 + 12_000 / HEARTBEAT_MS);
		expect(pictures(quiet.messages)).toEqual([]);
	});

	test("sixteen quiet Views cost sixteen pings of nine bytes a heartbeat, however heavy the page's state", async () => {
		const clock = frozenClock();
		const source = new FakeSource();
		source.open("a");
		// Ten tabs with a favicon at its largest: the state a beat used to repeat to every View.
		const favicon = `data:image/png;base64,${"A".repeat(32 * 1024 - 22)}`;
		const tabs = Array.from({ length: 10 }, (_, at) => ({ id: `t${at}`, title: "tab", url: "http://page.test/", active: at === 0, loading: false, favicon }));
		source.states.set("a", stateOf("a", { tabs, activeTabId: "t0" }));
		const channel = channelFor(source);
		const views: OpenStream[] = [];
		for (let view = 0; view < 16; view += 1) {
			const { origin, token } = await channel.mint("a");
			views.push(await openStream(origin, token, { frames: false, ping: true }));
		}
		await Promise.all(views.map((stream) => stream.waitFor((messages) => pings(messages).length === 1 && states(messages).length === 1)));
		const total = () => views.reduce((sum, stream) => sum + stream.bytes, 0);
		const before = total();
		// What one beat of the whole state would have cost: a state per View, each over 300 KB.
		expect(before / views.length).toBeGreaterThan(300_000);

		clock.advance(HEARTBEAT_MS);
		await Promise.all(views.map((stream) => stream.waitFor((messages) => pings(messages).length === 2)));
		expect(total() - before).toBe(16 * 9);
	});

	test("a View that did not ask for pings is never sent one, not at join and not across many heartbeats, while a View of the same browser that did ask is", async () => {
		const clock = frozenClock();
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");
		// One View that asked beside two that did not (one state-only, one with pictures): an older View's Reader throws on a kind it does not know.
		const asking = await openStream(origin, token, { frames: false, ping: true });
		const older = [await openStream(origin, token, { frames: false }), await openStream(origin, token)];
		await Promise.all(older.map((stream) => stream.waitFor((messages) => states(messages).length === 1)));
		await asking.waitFor((messages) => pings(messages).length === 1 && states(messages).length === 1);
		await ticks(source);
		// Fails if a View is greeted with a ping whether or not it asked: the one that did ask just had its greeting, so the greeting is on the wire and these two got the state alone.
		for (const stream of older) expect(stream.messages.map((message) => message.kind)).toEqual([KIND_STATE]);
		const settled = older.map((stream) => stream.bytes);

		for (let heard = 2; heard <= 6; heard += 1) {
			clock.advance(HEARTBEAT_MS);
			// The beat does run: the View that asked is pinged each time, so a View that is not pinged was passed over, not forgotten.
			await asking.waitFor((messages) => pings(messages).length === heard);
			await ticks(source);
		}
		// Fails if the heartbeat pings every View, not just those that asked: nothing else is sent to a still page.
		for (const stream of older) expect(stream.messages.map((message) => message.kind)).toEqual([KIND_STATE]);
		expect(older.map((stream) => stream.bytes)).toEqual(settled);
	});

	test("a pack whose state read is stuck (a renderer wedged in a navigation) still pings: the beat does not wait for the read", async () => {
		const clock = frozenClock();
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");
		const stream = await openStream(origin, token, { frames: false, ping: true });
		await stream.waitFor((messages) => pings(messages).length === 1 && states(messages).length === 1);

		source.hangReads = true;
		await ticks(source, 1);
		clock.advance(HEARTBEAT_MS);
		// Fails if the beat rides on the state read: a View would take a pack that is only waiting on a page for a dead one.
		await stream.waitFor((messages) => pings(messages).length === 2);
	});
});

describe("what stops it", () => {
	test("the last View leaving releases the picture watcher; a new one starts it again", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");
		const first = await openStream(origin, token);
		await first.waitFor((messages) => states(messages).length >= 1);
		expect(source.watching("a")).toBe(1);

		first.close();
		await first.ended;
		await waitUntil(() => source.watching("a") === 0);

		const again = await openStream(origin, token);
		await again.waitFor((messages) => states(messages).length >= 1);
		expect(source.watching("a")).toBe(1);
	});

	test("every View of a browser, pictures or state only, counts as watching it from when it joins until it leaves, and none is left when its browser or the channel ends", async () => {
		const source = new FakeSource();
		source.open("a");
		source.open("b");
		const channel = channelFor(source);
		const a = await channel.mint("a");
		const withPictures = await openStream(a.origin, a.token);
		const stateOnly = await openStream(a.origin, a.token, { frames: false });
		await withPictures.waitFor((messages) => states(messages).length >= 1);
		await stateOnly.waitFor((messages) => states(messages).length >= 1);
		expect(source.viewersOf("a")).toBe(2);
		// The state-only View takes no picture watcher, and is a viewer all the same.
		expect(source.watching("a")).toBe(1);

		withPictures.close();
		await withPictures.ended;
		await waitUntil(() => source.viewersOf("a") === 1);

		source.closed.add("a");
		await stateOnly.ended;
		await waitUntil(() => source.viewersOf("a") === 0);

		const b = await channel.mint("b");
		const onB = await openStream(b.origin, b.token);
		await onB.waitFor((messages) => states(messages).length >= 1);
		expect(source.viewersOf("b")).toBe(1);
		await channel.close();
		await onB.ended;
		expect(source.viewersOf("b")).toBe(0);
	});

	test("a closed browser ends every stream of it and its tokens stop working; other browsers go on", async () => {
		const source = new FakeSource();
		source.open("a");
		source.open("b");
		const channel = channelFor(source);
		const a = await channel.mint("a");
		const b = await channel.mint("b");
		const streamA = await openStream(a.origin, a.token);
		const streamB = await openStream(b.origin, b.token);
		await streamA.waitFor((messages) => states(messages).length >= 1);

		source.closed.add("a");
		await streamA.ended;
		expect((await raw(a.origin, "GET", `/s/${a.token}`, {})).status).toBe(404);
		expect((await post(a.origin, a.token, [{ kind: "text", text: "x" }])).status).toBe(404);
		source.push("b", "still-b");
		await streamB.waitFor((messages) => pictures(messages).includes("still-b"));
	});

	test("a token nobody uses for the idle limit dies, and when the last token is gone the listener closes", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source, { tokenIdleMs: 60 });
		const { origin, token } = await channel.mint("a");
		expect((await raw(origin, "GET", `/s/${token}`, {})).status).toBe(200);

		await waitUntil(async () => (await connects(origin)) === false, 2_000);
		const next = await channel.mint("a");
		expect(next.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect((await raw(next.origin, "GET", `/s/${next.token}`, {})).status).toBe(200);
	});

	test("a token in use is not dropped for idleness while its stream is open", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source, { tokenIdleMs: 60 });
		const { origin, token } = await channel.mint("a");
		const stream = await openStream(origin, token);
		// Integration test of real idle expiry against the platform clock: a fake clock would not prove the sweep runs.
		await new Promise((done) => setTimeout(done, 300));
		source.push("a", "late");
		await stream.waitFor((messages) => pictures(messages).includes("late"));
		expect((await post(origin, token, [{ kind: "text", text: "x" }])).status).toBe(200);
	});

	test("minting past the per-browser cap drops the oldest token", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source, { maxTokensPerBrowser: 2 });
		const first = await channel.mint("a");
		const second = await channel.mint("a");
		const third = await channel.mint("a");
		expect((await raw(first.origin, "GET", `/s/${first.token}`, {})).status).toBe(404);
		expect((await raw(second.origin, "GET", `/s/${second.token}`, {})).status).toBe(200);
		expect((await raw(third.origin, "GET", `/s/${third.token}`, {})).status).toBe(200);
	});

	test("closing the channel ends open streams and refuses new connections", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");
		const stream = await openStream(origin, token);
		await stream.waitFor((messages) => states(messages).length >= 1);

		await channel.close();
		await stream.ended;
		expect(await connects(origin)).toBe(false);
		expect(source.watching("a")).toBe(0);
	});
});

describe("pictures are bounded", () => {
	test("a View that cannot keep up gets the newest picture, not a backlog", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");
		const slow = await openStream(origin, token, { pause: true });

		// 150 one-megabyte pictures offered to a reader that is not reading (150 MB), the event loop turning between them.
		const TOTAL = 150;
		await waitUntil(() => source.watching("a") === 1);
		for (let i = 1; i <= TOTAL; i += 1) {
			source.push("a", `p${i}`, 1_000_000);
			await new Promise((done) => setImmediate(done));
		}
		slow.resume();
		await slow.waitFor((messages) => pictures(messages).includes(`p${TOTAL}`), 10_000);
		const numbers = pictures(slow.messages).map((id) => Number(id.slice(1)));
		expect(numbers.length).toBeLessThan(TOTAL / 2);
		expect(numbers.at(-1)).toBe(TOTAL);
		// What arrives is in the order it was made.
		expect(numbers).toEqual([...numbers].sort((x, y) => x - y));
	});

	test("pictures made in one turn collapse: the first goes out at once, the newest follows, those between are dropped", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");
		const stream = await openStream(origin, token);
		await stream.waitFor((messages) => states(messages).length >= 1);

		for (let i = 1; i <= 50; i += 1) source.push("a", `b${i}`, 300_000);
		await stream.waitFor((messages) => pictures(messages).includes("b50"));
		const numbers = pictures(stream.messages).map((id) => Number(id.slice(1)));
		// Not all fifty: the first went out at once and the rest were replaced while it was being written.
		expect(numbers.length).toBeLessThan(10);
		expect(numbers[0]).toBe(1);
		expect(numbers.at(-1)).toBe(50);
	});
});

describe("input", () => {
	test("a batch is handed to the browser the token names, as sent, and answers ok", async () => {
		const source = new FakeSource();
		source.open("a");
		source.open("b");
		const channel = channelFor(source);
		const a = await channel.mint("a");
		const batch = [{ kind: "mouse", type: "down", x: 10, y: 20, button: "left", clickCount: 1 }, { kind: "mouse", type: "up", x: 10, y: 20 }];

		const answer = await post(a.origin, a.token, batch);
		expect(answer.status).toBe(200);
		expect(JSON.parse(answer.text)).toEqual({ ok: true });
		expect(source.inputs).toEqual([{ browserId: "a", events: batch }]);
	});

	test("what the browser refuses is told to the View with a status it can act on", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");
		const body = [{ kind: "text", text: "x" }];

		// `unknown_browser` last: it ends the token, as a closed browser does.
		for (const [code, status] of [["task_running", 409], ["bad_input", 400], ["something_else", 500], ["unknown_browser", 410]] as const) {
			source.inputError = new BrowserRuntimeError(code, `because ${code}`);
			const answer = await post(origin, token, body);
			expect(answer.status).toBe(status);
			expect(JSON.parse(answer.text)).toEqual({ ok: false, code, error: `because ${code}` });
		}
	});

	test("a body that is not JSON, or is far too large, never reaches the browser", async () => {
		const source = new FakeSource();
		source.open("a");
		const channel = channelFor(source);
		const { origin, token } = await channel.mint("a");

		expect((await post(origin, token, "not json")).status).toBe(400);
		expect((await post(origin, token, "x".repeat(2_000_000))).status).toBe(413);
		expect(source.inputs).toEqual([]);
	});
});

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
		await new Promise((done) => setTimeout(done, 10));
	}
}

/** Whether a TCP connection to `origin` is accepted. */
function connects(origin: string): Promise<boolean> {
	const { port } = new URL(origin);
	return new Promise((resolve) => {
		const socket = net.connect(Number(port), "127.0.0.1");
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}
