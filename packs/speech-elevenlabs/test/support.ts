// Shared fakes for the pack's tests: a scripted `fetch`, a fake WebSocket and its factory, temp
// homes, and builders for the frames ElevenLabs sends. No network, no real home, no real time.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CaptionWord, SpeakEvent, SpeakSession, SpeechProvider, SpeechProviderContext } from "@dimension/sdk/provider";
import type { SocketFactory, SocketLike } from "../src/dialogue.js";
import { createElevenLabsProvider } from "../src/index.js";

export const KEY = "sk-test-secret-key-123";
export const VOICE = "voice-test-01";
export const DIALOGUE_MODEL = "eleven_v4_turbo";
export const SEGMENT_MODEL = "eleven_flash_v2_5";
export const KEY_FILE_PATH = [".config", "dimension-speech", "elevenlabs.json"] as const;

// ---- waiting (bounded, never a real-time sleep) ------------------------------------------------

export function withTimeout<T>(promise: Promise<T>, what: string, ms = 2_000): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error(`timed out waiting for ${what}`)), ms);
	return Promise.race([promise, timeout.promise]).finally(() => clearTimeout(timer));
}

/** Let every already-queued microtask and I/O callback run. */
export function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** Everything the session emits up to and including its terminal `end` (the iterable completes there). */
export function collect(session: SpeakSession, what = "the session to end"): Promise<SpeakEvent[]> {
	return withTimeout(
		(async () => {
			const events: SpeakEvent[] = [];
			for await (const event of session.events) events.push(event);
			return events;
		})(),
		what,
	);
}

export function ofType<T extends SpeakEvent["t"]>(events: readonly SpeakEvent[], t: T): Extract<SpeakEvent, { t: T }>[] {
	return events.filter((event): event is Extract<SpeakEvent, { t: T }> => event.t === t);
}

export function audioBytes(events: readonly SpeakEvent[]): Uint8Array {
	return new Uint8Array(Buffer.concat(ofType(events, "audio").map(event => event.pcm)));
}

export function captionWords(events: readonly SpeakEvent[]): CaptionWord[] {
	return ofType(events, "words").flatMap(event => [...event.words]);
}

// ---- audio and frame builders ------------------------------------------------------------------

/** PCM16 mono 24 kHz of the given length in bytes, with a position-dependent pattern so reordering shows. */
export function pcmBytes(length: number): Uint8Array {
	return Uint8Array.from({ length }, (_, i) => i % 251);
}

export function pcmSeconds(seconds: number): Uint8Array {
	return pcmBytes(Math.round(seconds * 24_000) * 2);
}

/** A Text-to-Dialogue audio frame; with `text`, an alignment fragment (times restart at 0). */
export function dialogueAudio(pcm: Uint8Array, text?: string, stepMs = 40): object {
	const audio = Buffer.from(pcm).toString("base64");
	if (text === undefined) return { audio };
	const chars = [...text];
	return {
		audio,
		alignment: {
			chars,
			char_start_times_ms: chars.map((_, i) => i * stepMs),
			char_durations_ms: chars.map(() => stepMs),
		},
	};
}

export const UNIT_DONE = { is_final_audio_for_turn: true } as const;
export const FINAL = { is_final: true } as const;

/** One NDJSON line of the with-timestamps stream (newline included). */
export function segmentLine(pcm: Uint8Array | undefined, text: string | undefined, stepS = 0.04): string {
	const chars = [...(text ?? "")];
	return `${JSON.stringify({
		...(pcm ? { audio_base64: Buffer.from(pcm).toString("base64") } : {}),
		...(text !== undefined
			? {
					alignment: {
						characters: chars,
						character_start_times_seconds: chars.map((_, i) => i * stepS),
						character_end_times_seconds: chars.map((_, i) => (i + 1) * stepS),
					},
				}
			: {}),
	})}\n`;
}

// ---- fake network ------------------------------------------------------------------------------

export class FakeSocket implements SocketLike {
	readyState = 0;
	closed = false;
	readonly sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((message: { readonly data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;

	constructor(
		readonly url: string,
		readonly headers: Readonly<Record<string, string>>,
	) {}

	send(data: string): void {
		this.sent.push(data);
	}

	/** Like a real socket, a locally initiated close still reports `close` a moment later. */
	close(): void {
		this.closed = true;
		this.readyState = 3;
		queueMicrotask(() => this.onclose?.());
	}

	/** The frames the client sent, parsed. */
	get frames(): Record<string, unknown>[] {
		return this.sent.map(text => JSON.parse(text) as Record<string, unknown>);
	}

	// Server side.
	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	receive(frame: object | string): void {
		this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
	}

	/** The connection dies (the server closes it, or it never came up). */
	drop(): void {
		this.readyState = 3;
		this.onclose?.();
	}
}

export class FakeNetwork {
	readonly sockets: FakeSocket[] = [];
	readonly connect: SocketFactory = (url, headers) => {
		const socket = new FakeSocket(url, headers);
		this.sockets.push(socket);
		return socket;
	};
}

export interface RecordedRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Headers;
	readonly body: string | undefined;
	readonly signal: AbortSignal | undefined;
}

export type Responder = (request: RecordedRequest, index: number) => Response | Promise<Response>;

const unexpectedRequest: Responder = request => {
	throw new Error(`unexpected request: ${request.method} ${request.url}`);
};

export class FakeHttp {
	readonly requests: RecordedRequest[] = [];
	readonly #waiters: { count: number; resolve(): void }[] = [];
	readonly #respond: Responder;

	constructor(respond: Responder) {
		this.#respond = respond;
	}

	readonly fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const request: RecordedRequest = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: typeof init?.body === "string" ? init.body : undefined,
			signal: init?.signal ?? undefined,
		};
		const index = this.requests.push(request) - 1;
		for (const waiter of this.#waiters.splice(0)) {
			if (this.requests.length >= waiter.count) waiter.resolve();
			else this.#waiters.push(waiter);
		}
		try {
			return Promise.resolve(this.#respond(request, index));
		} catch (error) {
			return Promise.reject(error);
		}
	}) as unknown as typeof fetch;

	/** Resolves once at least `count` requests have been made. */
	whenCalled(count: number): Promise<void> {
		if (this.requests.length >= count) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#waiters.push({ count, resolve });
		return withTimeout(promise, `request #${count}`);
	}
}

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A 200 whose NDJSON body the test writes by hand; aborting the request errors the stream, as fetch does. */
export class NdjsonStream {
	readonly response: Response;
	#controller: ReadableStreamDefaultController<Uint8Array> | undefined;

	constructor(signal?: AbortSignal) {
		const body = new ReadableStream<Uint8Array>({
			start: controller => {
				this.#controller = controller;
			},
		});
		this.response = new Response(body, { status: 200 });
		signal?.addEventListener("abort", () => this.#controller?.error(new DOMException("aborted", "AbortError")), {
			once: true,
		});
	}

	write(chunk: string | Uint8Array): void {
		this.#controller?.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
	}

	close(): void {
		this.#controller?.close();
	}
}

/** A responder that hands every request its own hand-driven stream, collected in `streams`. */
export function streamingResponder(streams: NdjsonStream[]): Responder {
	return request => {
		const stream = new NdjsonStream(request.signal);
		streams.push(stream);
		return stream.response;
	};
}

// ---- rig ---------------------------------------------------------------------------------------

/** Owns the temp homes and the sessions a test opens; `dispose` in `afterEach`. */
export class Harness {
	readonly #homes: string[] = [];
	readonly #sessions: SpeakSession[] = [];

	async home(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "speech-elevenlabs-"));
		this.#homes.push(dir);
		return dir;
	}

	track<T extends SpeakSession>(session: T): T {
		this.#sessions.push(session);
		return session;
	}

	async dispose(): Promise<void> {
		for (const session of this.#sessions.splice(0)) session.close();
		await Promise.all(this.#homes.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
	}
}

export interface RigOptions {
	/** Session environment; default carries {@link KEY}. */
	readonly env?: Record<string, string | undefined>;
	/** Raw content of the connect form's key file, when the test wants one. */
	readonly keyFile?: string;
	readonly respond?: Responder;
}

export interface Rig {
	readonly provider: SpeechProvider;
	readonly ctx: SpeechProviderContext;
	readonly network: FakeNetwork;
	readonly http: FakeHttp;
	readonly home: string;
}

export async function makeRig(harness: Harness, options: RigOptions = {}): Promise<Rig> {
	const home = await harness.home();
	if (options.keyFile !== undefined) {
		const path = join(home, ...KEY_FILE_PATH);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, options.keyFile);
	}
	const http = new FakeHttp(options.respond ?? unexpectedRequest);
	const network = new FakeNetwork();
	const provider = createElevenLabsProvider({ fetch: http.fetch, connect: network.connect, userHome: home });
	const ctx: SpeechProviderContext = {
		home,
		cwd: home,
		env: options.env ?? { ELEVENLABS_API_KEY: KEY },
		settings: { get: () => undefined },
		credentials: { withAccess: () => Promise.reject(new Error("this provider reads no login")) },
	};
	return { provider, ctx, network, http, home };
}

export interface OpenOptions {
	readonly model?: string;
	readonly voice?: string;
	readonly audioTags?: boolean;
	readonly signal?: AbortSignal;
}

export function openSpeak(rig: Rig, options: OpenOptions = {}): Promise<SpeakSession> {
	const open = rig.provider.openSpeak;
	if (!open) throw new Error("provider has no openSpeak");
	return open.call(
		rig.provider,
		rig.ctx,
		{ model: options.model ?? DIALOGUE_MODEL, voice: options.voice ?? VOICE },
		{ signal: options.signal ?? new AbortController().signal, audioTags: options.audioTags ?? true },
	);
}

/** Open a session and register it for cleanup. */
export async function openTracked(harness: Harness, rig: Rig, options: OpenOptions = {}): Promise<SpeakSession> {
	return harness.track(await openSpeak(rig, options));
}
