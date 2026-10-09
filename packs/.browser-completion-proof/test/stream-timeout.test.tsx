/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the Browser View's live picture goes back to a blank canvas that says nothing and never retries — a loopback
 *  connect the host accepts and never answers (a local-network policy that prompts no one, a pack that stopped answering) hangs the View for good; or the deadline
 *  that fixes it is wrong the other way (fires early, is double-counted as two failures, skips the backoff, is left running after the stream opens and kills a
 *  healthy still page minutes later, or lets a late answer paint a picture the View already gave up on); or a click the pack never answers hangs input for good
 *  instead of saying so and reconnecting, or the clock's wording replaces the pack's own reason ("a task owns the page"); or a closed View leaves a timer
 *  ticking, a socket open or a retry running.
 *
 *  The hook runs on a linkedom React tree (`dom-harness.ts`) against a REAL loopback server (Bun.serve on 127.0.0.1) that can accept a request and never answer
 *  it. Only the hook's timers are virtual: it reads `window.setTimeout` at call time, and linkedom's `window` is a Proxy over `globalThis`, so installing the clock
 *  replaces the global timers for the length of a test (`afterEach` puts them back) while the sockets, the fetch and this file's own waiting (`realSetTimeout`)
 *  stay real: a test spends five seconds of deadline in a moment. "The socket really closed" is what the server sees, not what the hook says.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { act, useState } from "react";
import type { BrowserState } from "../src/contracts";
import { BrowserApp } from "../app/view/browser-app";
import type { BrowserClient, ToolMount } from "../app/view/browser-client";
import { CONNECT_TIMEOUT_MS, INPUT_TIMEOUT_MS, STREAM_SILENCE_MS, type BrowserStream, useBrowserStream } from "../app/view/use-browser-stream";
import { encode, KIND_PICTURE, KIND_STATE, PING } from "../src/wire";
import { HEARTBEAT_MS, LiveChannel, type LiveSource } from "../src/stream";
import { mount, unmountAll } from "./dom-harness";

const LIVE: BrowserState = {
	browserId: "b1",
	profile: null,
	engine: "chromium",
	app: "chrome",
	url: "https://example.com/",
	title: "Example",
	revision: 1,
	viewport: { width: 1280, height: 800 },
	task: null,
	tabs: [],
	activeTabId: "",
	loading: false,
	canGoBack: false,
	canGoForward: false,
	publish: null,
	dialogs: [],
};
/** What the pack's stream says once it answers: the browser's state, with the one tab the tests look for. */
const RECOVERED: BrowserState = { ...LIVE, tabs: [{ id: "t1", title: "Recovered page", url: "https://example.com/", active: true, loading: false, favicon: null }], activeTabId: "t1" };

const TIMED_OUT = "The live picture could not be reached (no answer within 5 s). A host that blocks http://127.0.0.1 does this.";
const BACKOFF_LADDER = [500, 1000, 2000, 4000, 8000, 8000];
const CLICK = [{ kind: "text", text: "hello" }] as const;

type Hold = (response: Response) => void;

/** The part of a running Bun server the tests use. */
interface Listening {
	readonly port: number | undefined;
	stop(closeActiveConnections?: boolean): Promise<void>;
}

/** The pack's loopback listener, as far as the View can tell: it can accept a request and never answer it, and it knows when a client's socket went away. */
class Loopback {
	/** `GET /s/<token>`: accepted and never answered, or answered with the browser's state (and a picture) on a stream that stays open. */
	mode: "hang" | "answer" = "hang";
	pictures = true;
	/** Whether this pack pings the Views that ask it to: a pack older than the ping is `false`. */
	pings = true;
	/** `POST /i/<token>`: never answered, taken, or refused with a reason. */
	input: "hang" | "ok" | "refuse" = "hang";
	streamRequests = 0;
	streamsGone = 0;
	inputRequests = 0;
	inputsGone = 0;
	readonly origin: string;
	readonly #heldStreams: Hold[] = [];
	readonly #heldInputs: Hold[] = [];
	readonly #open: ReadableStreamDefaultController<Uint8Array>[] = [];
	readonly #server: Listening;

	constructor() {
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			// A request that is accepted and never answered stays that way: Bun's own 10 s idle cut would otherwise end the hang the tests mean to keep.
			idleTimeout: 0,
			fetch: async request => {
				const { pathname } = new URL(request.url);
				if (pathname.startsWith("/s/")) {
					this.streamRequests += 1;
					request.signal.addEventListener("abort", () => void (this.streamsGone += 1));
					if (this.mode === "answer") return this.#answer();
					return this.#hold(this.#heldStreams);
				}
				if (pathname.startsWith("/i/")) {
					this.inputRequests += 1;
					request.signal.addEventListener("abort", () => void (this.inputsGone += 1));
					if (this.input === "hang") return this.#hold(this.#heldInputs);
					await request.text();
					return this.input === "ok" ? Response.json({ ok: true }) : Response.json({ ok: false, error: "a task owns the page" }, { status: 409 });
				}
				return new Response("not found", { status: 404 });
			},
		});
		this.origin = `http://127.0.0.1:${this.#server.port}`;
	}

	#hold(held: Hold[]): Promise<Response> {
		const { promise, resolve } = Promise.withResolvers<Response>();
		held.push(resolve);
		return promise;
	}

	/** The pack's greeting (a ping, if it pings), the browser's state, then (unless `pictures` is off) one picture, on a body that then stays open. */
	#answer(): Response {
		const parts = [...(this.pings ? PING : []), ...encode(KIND_STATE, RECOVERED)];
		if (this.pictures) parts.push(...encode(KIND_PICTURE, { id: "p1", viewport: { width: 800, height: 600 }, at: 0 }, new Uint8Array([1, 2, 3])));
		let self: ReadableStreamDefaultController<Uint8Array> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start: controller => {
				self = controller;
				this.#open.push(controller);
				for (const part of parts) if (part.length > 0) controller.enqueue(part);
			},
			cancel: () => {
				this.#open.splice(this.#open.indexOf(self as ReadableStreamDefaultController<Uint8Array>), 1);
			},
		});
		return new Response(body, { headers: { "content-type": "application/octet-stream" } });
	}

	/** Answer every stream request that is still waiting, however late: the client has usually given up on them by now. */
	answerHeldStreams(): void {
		for (const resolve of this.#heldStreams.splice(0)) resolve(this.#answer());
	}

	/** Answer every input POST that is still waiting with `ok`, however late: the client has usually given up on them by now. */
	answerHeldInputs(): void {
		for (const resolve of this.#heldInputs.splice(0)) resolve(Response.json({ ok: true }));
	}

	/** The pack ends every stream it is serving (its browser closed, or the token was dropped). */
	endStreams(): void {
		for (const controller of this.#open.splice(0)) controller.close();
	}

	/** The pack's heartbeat: a ping on every stream it is serving (none if it is a pack that does not ping). */
	beat(): void {
		if (this.pings) this.#emit(PING);
	}

	/** A frame of a kind this View does not know, as a newer pack might send, on every stream it is serving. */
	emitUnknown(): void {
		this.#emit(encode(99, { from: "a newer pack" }, new Uint8Array([7, 7])));
	}

	#emit(parts: readonly Uint8Array[]): void {
		for (const controller of this.#open) for (const part of parts) if (part.length > 0) controller.enqueue(part);
	}

	async close(): Promise<void> {
		for (const resolve of [...this.#heldStreams.splice(0), ...this.#heldInputs.splice(0)]) resolve(new Response("closing", { status: 503 }));
		await this.#server.stop(true);
	}
}

/** The hook's timers: nothing fires until the test says how much time has passed. */
class VirtualClock {
	#now = 0;
	#next = 1;
	readonly #armed = new Map<number, { at: number; ms: number; run: () => void }>();
	/** Every delay the code under test asked for, in order. */
	readonly requested: number[] = [];

	readonly setTimeout = (run: () => void, ms = 0): number => {
		this.requested.push(ms);
		const id = this.#next++;
		this.#armed.set(id, { at: this.#now + ms, ms, run });
		return id;
	};

	readonly clearTimeout = (id?: number): void => void this.#armed.delete(id as number);

	/** The delays of the timers still armed. */
	get pending(): number[] {
		return [...this.#armed.values()].map(timer => timer.ms);
	}

	/** Make this the clock the hook sees. `window` is a Proxy over `globalThis`, so this is the global clock until `afterEach` puts the real one back. */
	install(): void {
		Object.assign(globalThis, { setTimeout: this.setTimeout, clearTimeout: this.clearTimeout });
	}

	/** Fire, in time order, every timer that falls due within `ms`. */
	advance(ms: number): void {
		const until = this.#now + ms;
		for (;;) {
			const due = [...this.#armed.entries()].filter(([, timer]) => timer.at <= until).sort(([a, x], [b, y]) => x.at - y.at || a - b)[0];
			if (due === undefined) break;
			this.#armed.delete(due[0]);
			this.#now = Math.max(this.#now, due[1].at);
			due[1].run();
		}
		this.#now = until;
	}
}

/** What the hook renders into, read back after every commit. */
class Probe {
	setId: (id: string | null) => void = () => {};
	/** How many times the hook's host component has rendered. */
	renders = 0;
	#last: BrowserStream | undefined;
	set last(stream: BrowserStream) {
		this.renders += 1;
		this.#last = stream;
	}
	get now(): BrowserStream {
		if (this.#last === undefined) throw new Error("the hook has not rendered");
		return this.#last;
	}
}

function Harness({ client, probe }: { client: BrowserClient; probe: Probe }) {
	const [id, setId] = useState<string | null>(null);
	probe.setId = setId;
	probe.last = useBrowserStream(client, id, false);
	return null;
}

/** The one thing the hook asks of the client: where the loopback listener is. Counts the asks. */
class Grants {
	calls = 0;
	/** While set, the host's answer waits: a human has not yet answered the consent prompt. */
	gate: Promise<void> | undefined;
	/** When set, the host's answer is this failure. */
	fail: string | undefined;
	constructor(
		private readonly origin: string,
		private readonly token = "t".repeat(32),
	) {}
	stream = async (_browserId: string) => {
		this.calls += 1;
		await this.gate;
		if (this.fail !== undefined) throw new Error(this.fail);
		return { origin: this.origin, token: this.token };
	};
}

/** A browser that never changes, for a test that wants the pack's real listener in front of the View. */
class QuietBrowser implements LiveSource {
	watchFrames(): () => void {
		return () => {};
	}
	viewing(): () => void {
		return () => {};
	}
	async liveState(): Promise<BrowserState> {
		return LIVE;
	}
	async input(): Promise<void> {}
}

function fakeCanvas(): { element: HTMLCanvasElement; draws: unknown[] } {
	const draws: unknown[] = [];
	const element = { width: 0, height: 0, getContext: () => ({ drawImage: (bitmap: unknown) => draws.push(bitmap) }) } as unknown as HTMLCanvasElement;
	return { element, draws };
}

const loopbacks: Loopback[] = [];
const channels: LiveChannel[] = [];
const realBitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
/** The clock the sockets, the settling and this file's own waits run on, whatever a test installs. */
const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = globalThis;
const realPerformanceNow = performance.now;
let blocked = 0;

beforeEach(() => {
	// Bun has no image decoder; a picture is "decoded" to a bitmap the fake canvas records.
	Object.defineProperty(globalThis, "createImageBitmap", { value: async () => ({ width: 8, height: 6, close() {} }), configurable: true, writable: true });
});

afterEach(async () => {
	await unmountAll();
	Object.assign(globalThis, { setTimeout: realSetTimeout, clearTimeout: realClearTimeout });
	performance.now = realPerformanceNow;
	blocked = 0;
	if (realBitmap) Object.defineProperty(globalThis, "createImageBitmap", realBitmap);
	else Reflect.deleteProperty(globalThis, "createImageBitmap");
	for (const loopback of loopbacks.splice(0)) await loopback.close();
	for (const channel of channels.splice(0)) await channel.close();
});

/** The View's own thread was blocked for `ms` (a host UI freeze, a long GC): the clock it reads moves on, though no timer of its ran meanwhile. */
function blockThread(ms: number): void {
	blocked += ms;
	performance.now = () => realPerformanceNow.call(performance) + blocked;
}

function listener(): Loopback {
	const loopback = new Loopback();
	loopbacks.push(loopback);
	return loopback;
}

/** Let real time pass: sockets deliver, promises and effects settle. */
const settle = () => act(async () => new Promise<void>(done => realSetTimeout(done, 20)));

async function until(what: string, predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await settle();
	if (!predicate()) throw new Error(`timed out waiting for: ${what}`);
}

/** Real time passes (the sockets, not the clock), and the caller then checks that nothing happened. */
async function quiet(): Promise<void> {
	for (let tick = 0; tick < 5; tick += 1) await settle();
}

/** An origin on loopback that nothing listens on: a connect to it is refused at once. */
async function closedOrigin(): Promise<string> {
	const closed = new Loopback();
	await closed.close();
	return closed.origin;
}

/** The hook mounted with no browser yet, its timers virtual, a fake canvas given; `start()` binds it to browser "b1". `origin` and `token` are where the host says the listener is and what it lets the View open (default: the test's own loopback). */
async function scenario(options: { origin?: string; token?: string } = {}) {
	const loopback = listener();
	const grants = new Grants(options.origin ?? loopback.origin, options.token);
	const probe = new Probe();
	await mount(<Harness client={grants as unknown as BrowserClient} probe={probe} />);
	const clock = new VirtualClock();
	clock.install();
	const canvas = fakeCanvas();
	probe.now.canvas(canvas.element);
	return {
		loopback,
		grants,
		probe,
		clock,
		canvas,
		start: () => act(async () => probe.setId("b1")),
		advance: (ms: number) => act(async () => clock.advance(ms)),
		/** A still page for `ms` of virtual time: every HEARTBEAT_MS the pack pings, and the View has heard it before time moves on. */
		still: async (ms: number) => {
			for (let passed = 0; passed < ms; passed += HEARTBEAT_MS) {
				await act(async () => clock.advance(HEARTBEAT_MS));
				const heard = clock.requested.length;
				loopback.beat();
				await until("the View hears the heartbeat", () => clock.requested.length > heard);
			}
		},
		/** Send the human's input; `outcome` settles with what the hook said of it: `sent`, or the rejection's text. Boxed so awaiting `send` does not wait for the answer. */
		send: async (): Promise<{ outcome: Promise<string> }> => {
			let outcome!: Promise<string>;
			await act(async () => {
				outcome = probe.now.post(CLICK).then(
					() => "sent",
					(cause: Error) => cause.message,
				);
			});
			return { outcome };
		},
	};
}

describe("a loopback connect that is accepted and never answered", () => {
	test("a deadline that is a few seconds, never minutes, is what stands between a hang and a blank canvas", () => {
		// A blank canvas is waited on for at most this long: a regression to a minute is a View that looks dead.
		expect(CONNECT_TIMEOUT_MS).toBeGreaterThan(1000);
		expect(CONNECT_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
	});

	test("is cut at the deadline (not before) into the visible reconnecting state, and each timeout is ONE failure on the backoff ladder", async () => {
		const { loopback, grants, probe, clock, start, advance } = await scenario();
		await start();
		await until("the stream request reaches the pack", () => loopback.streamRequests === 1);
		// Fails if the connect is not given a deadline at all (the hang is forever) or the deadline is not armed around the connect.
		expect(clock.requested).toEqual([CONNECT_TIMEOUT_MS]);

		// Fails if the deadline fires early.
		await advance(CONNECT_TIMEOUT_MS - 1);
		await quiet();
		expect(probe.now.connection).toBe("connecting");
		expect(probe.now.error).toBeNull();
		expect(loopback.streamsGone).toBe(0);

		await advance(1);
		await until("the View says it is reconnecting", () => probe.now.connection === "reconnecting");
		expect(probe.now.error).toBe(TIMED_OUT);
		// Fails if the deadline only gives up waiting and leaves the socket open (a late answer would then still be taken).
		await until("the pack sees the client go away", () => loopback.streamsGone === 1);
		expect(clock.pending).toEqual([BACKOFF_LADDER[0] as number]);

		// Fails if a timeout is not a failure of the ladder (no backoff, a double retry, or a backoff that does not double up to its cap).
		for (let attempt = 2; attempt <= BACKOFF_LADDER.length; attempt += 1) {
			await advance(BACKOFF_LADDER[attempt - 2] as number);
			await until(`attempt ${attempt} reaches the pack`, () => loopback.streamRequests === attempt);
			expect(clock.pending).toEqual([CONNECT_TIMEOUT_MS]);
			await advance(CONNECT_TIMEOUT_MS);
			await until(`attempt ${attempt} times out`, () => clock.requested.length === attempt * 2);
		}
		expect(clock.requested).toEqual([5000, 500, 5000, 1000, 5000, 2000, 5000, 4000, 5000, 8000, 5000, 8000]);
		expect(grants.calls).toBe(BACKOFF_LADDER.length);
		expect(loopback.streamRequests).toBe(BACKOFF_LADDER.length);
		await until("every hung socket was closed", () => loopback.streamsGone === BACKOFF_LADDER.length);
		expect(probe.now.connection).toBe("reconnecting");
		expect(probe.now.error).toBe(TIMED_OUT);
	}, 20_000);

	test("goes live when the pack answers again, leaves no deadline running on the open stream, and starts the ladder over after it", async () => {
		const { loopback, grants, probe, clock, canvas, start, advance, still } = await scenario();
		await start();
		await until("attempt 1 reaches the pack", () => loopback.streamRequests === 1);
		await advance(CONNECT_TIMEOUT_MS);
		await until("attempt 1 times out", () => clock.requested.length === 2);
		await advance(500);
		await until("attempt 2 reaches the pack", () => loopback.streamRequests === 2);
		await advance(CONNECT_TIMEOUT_MS);
		await until("attempt 2 times out", () => clock.requested.length === 4);
		expect(clock.pending).toEqual([1000]);

		loopback.mode = "answer";
		await advance(1000);
		await until("the recovered stream paints", () => probe.now.connection === "live" && probe.now.picture !== null && canvas.draws.length > 0);
		expect(probe.now.error).toBeNull();
		expect(probe.now.state?.tabs[0]?.title).toBe("Recovered page");
		expect(grants.calls).toBe(3);
		// Fails if the connect deadline is not cleared once the headers arrive: it would abort a healthy stream five seconds in. The only timer left is the stream's silence watch.
		expect(clock.pending).toEqual([STREAM_SILENCE_MS]);

		await still(60_000);
		await quiet();
		expect(probe.now.connection).toBe("live");
		expect(loopback.streamRequests).toBe(3);
		expect(loopback.streamsGone).toBe(2);

		// The pack ends the stream, and its next connect hangs again: the wait is the FIRST rung, not the fourth the earlier failures had reached.
		loopback.mode = "hang";
		loopback.endStreams();
		await until("the ended stream is noticed: its silence watch is gone and the short retry is armed", () => clock.pending.length === 1 && clock.pending[0] !== STREAM_SILENCE_MS);
		await advance(clock.pending[0] as number);
		await until("attempt 4 reaches the pack", () => loopback.streamRequests === 4);
		await advance(CONNECT_TIMEOUT_MS);
		await until("attempt 4 times out", () => probe.now.connection === "reconnecting");
		// Fails if a successful connect does not reset the ladder.
		expect(clock.pending).toEqual([500]);
	}, 20_000);

	test("the View puts no deadline of its own on the wait for the host's answer (a consent prompt nobody has answered yet): only the connect after it is timed", async () => {
		const { loopback, grants, probe, clock, start, advance } = await scenario();
		const consent = Promise.withResolvers<void>();
		grants.gate = consent.promise;
		await start();
		await until("the host is asked", () => grants.calls === 1);
		// Fails if the deadline is armed before the host call: a person slow to answer a prompt would be told the pack could not be reached.
		expect(clock.pending).toEqual([]);
		await advance(60_000);
		await quiet();
		expect(probe.now.connection).toBe("connecting");
		expect(probe.now.error).toBeNull();
		expect(loopback.streamRequests).toBe(0);

		consent.resolve();
		await until("the connect begins once the human has answered", () => loopback.streamRequests === 1);
		expect(clock.pending).toEqual([CONNECT_TIMEOUT_MS]);
	});

	test("a host call that fails after the wait (the SDK's own 60 s request timeout on a prompt nobody answered) is a plain failure: reconnecting with its words, and the next backoff tick asks the host again", async () => {
		const { loopback, grants, probe, clock, start, advance } = await scenario();
		const prompt = Promise.withResolvers<void>();
		grants.gate = prompt.promise;
		await start();
		await until("the host is asked", () => grants.calls === 1);
		grants.fail = "MCP error -32001: Request timed out";
		prompt.resolve();
		await until("the View says it is reconnecting", () => probe.now.connection === "reconnecting");
		expect(probe.now.error).toBe("MCP error -32001: Request timed out");
		expect(loopback.streamRequests).toBe(0);
		expect(clock.pending).toEqual([BACKOFF_LADDER[0] as number]);

		grants.fail = undefined;
		grants.gate = undefined;
		await advance(BACKOFF_LADDER[0] as number);
		await until("the next tick asks the host again", () => grants.calls === 2);
		await until("the connect begins", () => loopback.streamRequests === 1);
	});

	test("an answer that arrives after the abort paints nothing and costs no extra retry", async () => {
		const { loopback, grants, probe, clock, canvas, start, advance } = await scenario();
		await start();
		await until("the stream request reaches the pack", () => loopback.streamRequests === 1);
		await advance(CONNECT_TIMEOUT_MS);
		await until("the View says it is reconnecting", () => probe.now.connection === "reconnecting");
		await until("the pack sees the client go away", () => loopback.streamsGone === 1);

		// A hook that only stopped waiting (a flag) rather than aborting would take this answer and paint it.
		loopback.answerHeldStreams();
		await quiet();
		expect(canvas.draws).toEqual([]);
		expect(probe.now.picture).toBeNull();
		expect(probe.now.state).toBeNull();
		expect(probe.now.connection).toBe("reconnecting");
		expect(loopback.streamRequests).toBe(1);
		expect(grants.calls).toBe(1);
		expect(clock.pending).toEqual([500]);
	});
});

describe("a loopback connect that is refused", () => {
	test("is told with the fetch's own failure, at once, never as a silence; its timer is gone and it retries on the same ladder", async () => {
		const { probe, grants, clock, start, advance } = await scenario({ origin: await closedOrigin() });
		await start();
		// Nothing advances the virtual clock: a refusal is reported the moment the socket says so, not at the deadline.
		await until("the View says it is reconnecting", () => probe.now.connection === "reconnecting");
		// Fails if every connect failure is worded as the deadline's silence (a host that blocks loopback, or a pack that is down, would read as "no answer").
		expect(probe.now.error).not.toContain("no answer within");
		expect(probe.now.error).toMatch(/^The live picture could not be reached \(\S[^)]*\)\. A host that blocks http:\/\/127\.0\.0\.1 does this\.$/);
		// The failure cleared the connect's deadline; only the backoff is armed.
		expect(clock.pending).toEqual([BACKOFF_LADDER[0] as number]);

		await advance(BACKOFF_LADDER[0] as number);
		await until("the second attempt asks the host again", () => grants.calls === 2);
		await until("the second refusal waits the next rung", () => clock.pending.length === 1 && clock.pending[0] === BACKOFF_LADDER[1]);
		expect(probe.now.error).not.toContain("no answer within");
	});
});

describe("the human's input", () => {
	test("a POST the pack never answers is cut at its deadline, says so and closes its socket, but leaves the healthy stream alone; an answer that arrives after the abort changes nothing", async () => {
		const { loopback, grants, probe, clock, start, advance, still, send } = await scenario();
		loopback.mode = "answer";
		await start();
		await until("the stream is live", () => probe.now.connection === "live" && probe.now.picture !== null);

		const { outcome } = await send();
		await until("the POST reaches the pack", () => loopback.inputRequests === 1);
		// Fails if the POST has no deadline: input would hang for good.
		expect(clock.pending).toEqual([STREAM_SILENCE_MS, INPUT_TIMEOUT_MS]);

		// The pack keeps pinging, so the POST's deadline is the only one in play.
		await still(INPUT_TIMEOUT_MS - HEARTBEAT_MS);
		await advance(HEARTBEAT_MS);
		expect(await outcome).toBe("Input could not be sent (no answer within 8 s).");
		// Fails if the abort only forgets the request: its socket would stay open.
		await until("the pack sees the POST's socket close", () => loopback.inputsGone === 1);

		// Fails if a slow page takes a healthy stream down with it (a fresh connect, a host call, a flash of 'Reconnecting'): the stream was never the problem.
		await quiet();
		expect(probe.now.connection).toBe("live");
		expect(loopback.streamRequests).toBe(1);
		expect(loopback.streamsGone).toBe(0);
		expect(grants.calls).toBe(1);
		expect(clock.pending).toEqual([STREAM_SILENCE_MS]);

		// The batch may still be applied: the pack answers 200 to a request the View has abandoned. Nothing in the View moves.
		const renders = probe.renders;
		loopback.answerHeldInputs();
		await quiet();
		expect(probe.renders).toBe(renders);
		expect(probe.now.connection).toBe("live");
		expect(probe.now.error).toBeNull();
		expect(loopback.streamRequests).toBe(1);
		expect(clock.pending).toEqual([STREAM_SILENCE_MS]);
	}, 20_000);

	test("a POST that fails outright (the socket refused or reset, not a silence) is reported with the fetch's own words and restarts the stream, which may be as dead as that socket", async () => {
		const { loopback, probe, start, send } = await scenario();
		loopback.mode = "answer";
		await start();
		await until("the stream is live", () => probe.now.connection === "live");

		const realFetch = globalThis.fetch;
		globalThis.fetch = ((target: Parameters<typeof fetch>[0], init?: RequestInit) => (init?.method === "POST" ? Promise.reject(new TypeError("connection reset")) : realFetch(target, init))) as typeof fetch;
		try {
			expect(await (await send()).outcome).toBe("Input could not be sent (connection reset).");
			// Fails if a failed POST no longer asks for a fresh stream.
			await until("the stream reconnects", () => loopback.streamRequests === 2);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("a POST the pack answers in time leaves no timer behind and does not touch the stream", async () => {
		const { loopback, probe, clock, start, send } = await scenario();
		loopback.mode = "answer";
		loopback.input = "ok";
		await start();
		await until("the stream is live and under its silence watch", () => probe.now.connection === "live" && clock.pending.length === 1);

		expect(await (await send()).outcome).toBe("sent");
		// The POST's own deadline is gone; only the stream's silence watch remains.
		expect(clock.pending).toEqual([STREAM_SILENCE_MS]);
		await quiet();
		expect(loopback.streamRequests).toBe(1);
	});

	test("a refusal the pack gives in time is raised with the pack's own words, not the clock's", async () => {
		const { loopback, probe, clock, start, send } = await scenario();
		loopback.mode = "answer";
		loopback.input = "refuse";
		await start();
		await until("the stream is live and under its silence watch", () => probe.now.connection === "live" && clock.pending.length === 1);

		expect(await (await send()).outcome).toBe("a task owns the page");
		expect(clock.pending).toEqual([STREAM_SILENCE_MS]);
	});
});

describe("an open stream that goes quiet", () => {
	test("the pack's heartbeat is well inside the silence that condemns a stream, and that silence is seconds, never minutes", () => {
		// Fails if the pack's repeat is slowed (or the View's patience cut) until a healthy still page reads as a stall.
		expect(HEARTBEAT_MS * 2).toBeLessThanOrEqual(STREAM_SILENCE_MS);
		// A frozen picture is told within this long.
		expect(STREAM_SILENCE_MS).toBeLessThanOrEqual(10_000);
	});

	test("a pack that stops writing mid-stream is cut at the silence deadline, counted from the last thing it sent, into reconnecting; the View is live again when the pack answers", async () => {
		const { loopback, grants, probe, clock, canvas, start, advance, still } = await scenario();
		loopback.mode = "answer";
		await start();
		await until("the stream is live", () => probe.now.connection === "live" && probe.now.picture !== null && canvas.draws.length > 0);
		// Fails if an open stream has no watch (a stalled one would read "live" for good) or keeps the connect's 5 s deadline.
		expect(clock.pending).toEqual([STREAM_SILENCE_MS]);

		// The pack repeats the state for ten seconds, then stops writing with the socket still open.
		await still(10_000);
		await advance(STREAM_SILENCE_MS - 1);
		await quiet();
		// Fails if the silence is counted from the connect, not from the last thing sent: a stream that beat for ten seconds would already be cut.
		expect(probe.now.connection).toBe("live");
		expect(loopback.streamsGone).toBe(0);

		await advance(1);
		await until("the View says it is reconnecting", () => probe.now.connection === "reconnecting");
		expect(probe.now.error).toBe("The live picture went quiet (nothing arrived for 6 s).");
		// Fails if the stalled socket is only forgotten, not closed.
		await until("the pack sees the stalled stream's socket close", () => loopback.streamsGone === 1);
		// One failure on the ladder's first rung, and nothing else armed.
		expect(clock.pending).toEqual([BACKOFF_LADDER[0] as number]);

		await advance(BACKOFF_LADDER[0] as number);
		await until("the View is live again on a new stream", () => loopback.streamRequests === 2 && probe.now.connection === "live" && probe.now.error === null);
		expect(grants.calls).toBe(2);
	}, 20_000);

	test("a still page whose pack keeps pinging never reconnects however long it sits, and the pings cost no render", async () => {
		const { loopback, grants, probe, clock, start, still } = await scenario();
		loopback.mode = "answer";
		await start();
		await until("the stream is live", () => probe.now.connection === "live" && probe.now.picture !== null);
		await quiet();
		const renders = probe.renders;

		// Four virtual minutes: forty times the silence deadline.
		await still(240_000);
		// Fails if hearing something does not push the deadline back (a healthy stream would be cut six seconds in).
		expect(probe.now.connection).toBe("live");
		expect(loopback.streamRequests).toBe(1);
		expect(grants.calls).toBe(1);
		expect(loopback.streamsGone).toBe(0);
		// Fails if every push leaves its old timer behind.
		expect(clock.pending).toEqual([STREAM_SILENCE_MS]);
		// The repeat is the state the View already shows: dropped before React sees it.
		expect(probe.renders).toBe(renders);
	}, 30_000);

	test("a pack that never pings (one older than this View) is trusted as it always was: no silence watch is armed, however long the stream sits quiet", async () => {
		const { loopback, grants, probe, clock, start, advance } = await scenario();
		loopback.mode = "answer";
		loopback.pings = false;
		await start();
		await until("the stream paints", () => probe.now.connection === "live" && probe.now.picture !== null);
		await quiet();
		// Fails if the View judges silence without a ping to measure it by: every still page on an older pack would reconnect every six seconds.
		expect(clock.pending).toEqual([]);
		await advance(10 * 60_000);
		await quiet();
		expect(probe.now.connection).toBe("live");
		expect(loopback.streamRequests).toBe(1);
		expect(grants.calls).toBe(1);
	});

	test("any frame is proof of life, one this View does not know included, and none of them costs a render", async () => {
		const { loopback, grants, probe, clock, start, advance } = await scenario();
		loopback.mode = "answer";
		await start();
		await until("the stream paints", () => probe.now.connection === "live" && probe.now.picture !== null);
		await quiet();
		const renders = probe.renders;

		// A newer pack's frame every five seconds for a virtual minute: never a ping, never a state, yet ten times the silence deadline passes.
		for (let at = 0; at < 12; at += 1) {
			await advance(STREAM_SILENCE_MS - 1_000);
			const heard = clock.requested.length;
			loopback.emitUnknown();
			await until("the View hears it", () => clock.requested.length > heard);
		}
		// Fails if only frames the View knows push the deadline back, or an unknown one is an error that ends the stream.
		expect(probe.now.connection).toBe("live");
		expect(probe.now.error).toBeNull();
		expect(loopback.streamRequests).toBe(1);
		expect(grants.calls).toBe(1);
		expect(probe.renders).toBe(renders);
	}, 20_000);

	test("a silence timer that fires late because this View's own thread was blocked gives the stream one more window to deliver what was waiting, and does not cut a healthy stream", async () => {
		const { loopback, grants, probe, clock, start, advance } = await scenario();
		loopback.mode = "answer";
		await start();
		await until("the stream paints", () => probe.now.connection === "live" && probe.now.picture !== null);
		expect(clock.pending).toEqual([STREAM_SILENCE_MS]);
		const heard = clock.requested.length;

		// The thread is blocked for twenty seconds; the pack's ping is waiting in the socket, unread, behind the overdue timer.
		loopback.beat();
		blockThread(20_000);
		await advance(STREAM_SILENCE_MS);
		// Fails if a late timer aborts at once: a host freeze would flash 'Reconnecting' and make a fresh host call over a stream that never stopped.
		expect(loopback.streamsGone).toBe(0);
		expect(clock.pending).toEqual([STREAM_SILENCE_MS]);
		await until("the waiting ping is read", () => clock.requested.length > heard + 1);
		await quiet();
		expect(probe.now.connection).toBe("live");
		expect(probe.now.error).toBeNull();
		expect(loopback.streamRequests).toBe(1);
		expect(grants.calls).toBe(1);
	}, 20_000);

	test("a late silence timer forgives a stalled View once: if nothing arrives in the extra window, the stream is cut like any other silence", async () => {
		const { loopback, probe, start, advance } = await scenario();
		loopback.mode = "answer";
		await start();
		await until("the stream paints", () => probe.now.connection === "live" && probe.now.picture !== null);

		blockThread(20_000);
		await advance(STREAM_SILENCE_MS);
		expect(loopback.streamsGone).toBe(0);
		await quiet();
		expect(probe.now.connection).toBe("live");

		// Nothing came, and the thread is blocked again: the pack really is silent. Fails if the forgiveness can be spent again and again (a silent pack on a View that keeps stalling would never be cut).
		blockThread(20_000);
		await advance(STREAM_SILENCE_MS);
		await until("the View says it is reconnecting", () => probe.now.connection === "reconnecting");
		expect(probe.now.error).toBe("The live picture went quiet (nothing arrived for 6 s).");
		await until("the pack sees the stalled stream's socket close", () => loopback.streamsGone === 1);
	}, 20_000);

	test("hearing the pack earns the forgiveness again: a host that freezes again and again in one session, with the pack's ping read after each, never costs a healthy stream its connection", async () => {
		const { loopback, grants, probe, clock, start, advance } = await scenario();
		loopback.mode = "answer";
		await start();
		await until("the stream paints", () => probe.now.connection === "live" && probe.now.picture !== null);

		for (const freeze of [1, 2, 3]) {
			// The thread is blocked for twenty seconds with the pack's ping waiting in the socket; the overdue timer is forgiven, and then the ping is read.
			const heard = clock.requested.length;
			loopback.beat();
			blockThread(20_000);
			await advance(STREAM_SILENCE_MS);
			await until(`the ping waiting through freeze ${freeze} is read`, () => clock.requested.length > heard + 1);
			// Fails if the forgiveness is spent for good by the first freeze (it must be re-earned by hearing, which is what the ping just did): the second would abort a stream that never stopped.
			await quiet();
			expect(loopback.streamsGone).toBe(0);
			expect(probe.now.connection).toBe("live");
			expect(probe.now.error).toBeNull();
			expect(clock.pending).toEqual([STREAM_SILENCE_MS]);
		}
		expect(loopback.streamRequests).toBe(1);
		expect(grants.calls).toBe(1);
	}, 20_000);

	test("a connect timer that fires late because this View's own thread was blocked is not a failed connect either: the pack's answer, read a moment later, goes live", async () => {
		const { loopback, probe, clock, start, advance } = await scenario();
		await start();
		await until("the stream request reaches the pack", () => loopback.streamRequests === 1);

		blockThread(20_000);
		await advance(CONNECT_TIMEOUT_MS);
		// Fails if a late connect timer is counted as a failure: the ladder, the banner and a second connect for an answer that was already on its way.
		expect(probe.now.connection).toBe("connecting");
		expect(clock.pending).toEqual([CONNECT_TIMEOUT_MS]);
		loopback.mode = "answer";
		loopback.answerHeldStreams();
		await until("the stream paints", () => probe.now.connection === "live" && probe.now.picture !== null);
		expect(loopback.streamRequests).toBe(1);
		expect(probe.now.error).toBeNull();
	}, 20_000);

	test("a View on the real listener is held to the silence watch from the pack's first ping: what it asks for and what the pack answers agree", async () => {
		const channel = new LiveChannel(new QuietBrowser(), { stateIntervalMs: 15 });
		channels.push(channel);
		const { origin, token } = await channel.mint("b1");
		const { probe, clock, start } = await scenario({ origin, token });
		await start();
		// Fails if the View does not ask the pack for pings (`?ping=1`), or the pack does not greet a View that did: no watch would ever be armed.
		await until("the stream is live and under its silence watch", () => probe.now.connection === "live" && clock.pending.includes(STREAM_SILENCE_MS));
		expect(probe.now.state?.browserId).toBe("b1");
	});
});

describe("a View that is torn down", () => {
	const phases = [
		{ name: "while its connect is still waiting for an answer", socket: "stream" },
		{ name: "while it waits out a backoff", socket: null },
		{ name: "while an input POST is still waiting for an answer", socket: "input" },
		{ name: "while its stream is open and live", socket: "open" },
	] as const;

	test.each(phases)("lets go of every timer, socket and retry $name", async ({ socket }) => {
		const { loopback, grants, probe, clock, start, advance, send } = await scenario();
		let outcome: Promise<string> | undefined;
		if (socket === "input" || socket === "open") {
			loopback.mode = "answer";
			await start();
			await until("the stream is live", () => probe.now.connection === "live");
			if (socket === "input") {
				({ outcome } = await send());
				await until("the POST reaches the pack", () => loopback.inputRequests === 1);
			}
		} else {
			await start();
			await until("the stream request reaches the pack", () => loopback.streamRequests === 1);
			if (socket === null) {
				await advance(CONNECT_TIMEOUT_MS);
				await until("the View is waiting out a backoff", () => probe.now.connection === "reconnecting" && clock.pending.length === 1);
			}
		}
		const requests = loopback.streamRequests;

		await unmountAll();
		// Fails if a deadline or backoff timer survives the View.
		expect(clock.pending).toEqual([]);
		// Fails if the in-flight request is only forgotten, not aborted: its socket would stay open.
		if (socket === "stream" || socket === "open") await until("the pack sees the stream's socket close", () => loopback.streamsGone === 1);
		if (socket === "input") {
			await until("the pack sees the POST's socket close", () => loopback.inputsGone === 1);
			expect(await outcome).not.toBe("sent");
		}

		clock.advance(60_000);
		await new Promise(done => realSetTimeout(done, 100));
		expect(loopback.streamRequests).toBe(requests);
		expect(grants.calls).toBe(requests);
	}, 20_000);

	test("a View that sent many batches holds none of them: unmounting aborts nothing that already finished", async () => {
		const { loopback, probe, start, send } = await scenario();
		loopback.mode = "answer";
		loopback.input = "ok";
		const posted: AbortSignal[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = ((target: Parameters<typeof fetch>[0], init?: RequestInit) => {
			if (init?.method === "POST" && init.signal) posted.push(init.signal);
			return realFetch(target, init);
		}) as typeof fetch;
		try {
			await start();
			await until("the stream is live", () => probe.now.connection === "live");
			for (let batch = 0; batch < 3; batch += 1) expect(await (await send()).outcome).toBe("sent");
			expect(posted).toHaveLength(3);

			await unmountAll();
			// Fails if a finished POST's controller is left in the View's in-flight set: it grows by one per batch for the life of the View, and unmount aborts them all.
			expect(posted.map(signal => signal.aborted)).toEqual([false, false, false]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

/** A host whose `browser_stream` names the loopback listener; `browser_profiles` is answered; anything else is a failure the test then reports. */
function hostOn(loopback: Loopback): { app: App; unexpected: string[] } {
	const unexpected: string[] = [];
	const app = {
		callServerTool: async (request: { name: string }): Promise<CallToolResult> => {
			if (request.name === "browser_stream") return { content: [], structuredContent: { origin: loopback.origin, token: "t".repeat(32) } };
			if (request.name === "browser_profiles") return { content: [], structuredContent: { profiles: [] } };
			unexpected.push(request.name);
			return { isError: true, content: [{ type: "text", text: "unexpected" }] };
		},
		getHostCapabilities: () => ({ updateModelContext: { text: {}, image: {} } }),
		updateModelContext: async () => ({}),
	} as unknown as App;
	return { app, unexpected };
}

describe("the Browser View as the human sees it", () => {
	test("a connect that hangs shows 'Reconnecting to the browser' with why, and the banner clears once the pack answers", async () => {
		const loopback = listener();
		loopback.pictures = false;
		const { app, unexpected } = hostOn(loopback);
		const deliver: { toolState?: (mount: ToolMount) => void } = {};
		function Late() {
			const [toolState, setToolState] = useState<ToolMount | null>(null);
			deliver.toolState = setToolState;
			return <BrowserApp app={app} toolState={toolState} />;
		}
		const dom = await mount(<Late />);
		const clock = new VirtualClock();
		clock.install();

		await act(async () => deliver.toolState?.({ state: LIVE, seq: 1 }));
		await until("the stream request reaches the pack", () => loopback.streamRequests === 1);
		expect(dom.text()).not.toContain("Reconnecting to the browser");

		await act(async () => clock.advance(CONNECT_TIMEOUT_MS));
		await until("the banner appears", () => dom.text().includes("Reconnecting to the browser"));
		expect(dom.text()).toContain("no answer within 5 s");
		expect(dom.text()).not.toContain("Recovered page");

		loopback.mode = "answer";
		await act(async () => clock.advance(500));
		await until("the recovered page shows", () => dom.text().includes("Recovered page"));
		expect(dom.text()).not.toContain("Reconnecting to the browser");
		expect(unexpected).toEqual([]);
	}, 20_000);

	test("a stream that goes quiet mid-session shows 'Reconnecting to the browser' with why, and the banner clears once the pack answers", async () => {
		const loopback = listener();
		loopback.mode = "answer";
		loopback.pictures = false;
		const { app, unexpected } = hostOn(loopback);
		const deliver: { toolState?: (mount: ToolMount) => void } = {};
		function Late() {
			const [toolState, setToolState] = useState<ToolMount | null>(null);
			deliver.toolState = setToolState;
			return <BrowserApp app={app} toolState={toolState} />;
		}
		const dom = await mount(<Late />);
		const clock = new VirtualClock();
		clock.install();

		await act(async () => deliver.toolState?.({ state: LIVE, seq: 1 }));
		await until("the live page shows", () => dom.text().includes("Recovered page"));
		expect(dom.text()).not.toContain("Reconnecting to the browser");

		await act(async () => clock.advance(STREAM_SILENCE_MS));
		await until("the banner appears", () => dom.text().includes("Reconnecting to the browser"));
		expect(dom.text()).toContain("went quiet");

		await act(async () => clock.advance(500));
		await until("the banner clears", () => !dom.text().includes("Reconnecting to the browser"));
		expect(dom.text()).toContain("Recovered page");
		expect(unexpected).toEqual([]);
	}, 20_000);
});
