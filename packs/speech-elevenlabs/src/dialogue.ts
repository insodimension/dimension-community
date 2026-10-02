// One reply spoken over the Text-to-Dialogue stream-input socket (Eleven v3/v4). The socket is
// opened when the session is, so the handshake overlaps the model's thinking time; every pushed
// segment is flushed at once; `close_socket` finishes the reply and the server answers `is_final`.
import type { SpeakEvent, SpeakSession } from "@dimension/sdk/provider";
import { DialogueTimeline } from "./alignment.js";
import { SpeakOutput } from "./output.js";
import {
	API_HOST,
	DIALOGUE_CLOSE,
	DIALOGUE_KEEP_ALIVE,
	type DialogueEvent,
	dialogueHello,
	dialogueInput,
	dialogueSocketUrl,
	describeHandshakeFailure,
	parseDialogueEvent,
	SAMPLE_RATE,
} from "./protocol.js";
import { SpeakableText } from "./speakable.js";

const KEEP_ALIVE_MS = 10_000;
/** A connection nobody has sent text to for this long is released; the next segment reopens it. */
const IDLE_MS = 60_000;
/** Silence from ElevenLabs while text is in flight or the reply is closed, before the reply is failed. */
const STALL_MS = 20_000;
const PROBE_TIMEOUT_MS = 5_000;
const SOCKET_OPEN = 1;

/** The slice of WebSocket this module uses, so a test can stand in for the network. */
export interface SocketLike {
	readonly readyState: number;
	send(data: string): void;
	close(): void;
	onopen: (() => void) | null;
	onmessage: ((message: { readonly data: unknown }) => void) | null;
	onclose: (() => void) | null;
}

export type SocketFactory = (url: string, headers: Readonly<Record<string, string>>) => SocketLike;

interface SocketListener {
	event(event: DialogueEvent): void;
	/** `opened` is false when the connection never completed its handshake. */
	closed(opened: boolean): void;
}

class DialogueSocket {
	readonly #ws: SocketLike;
	/** Frames sent before the handshake completes; they follow the hello frame in order. */
	readonly #outbox: string[] = [];
	readonly #keepAlive: Timer;
	#opened = false;
	#closed = false;

	constructor(ws: SocketLike, voice: string, listener: SocketListener) {
		this.#ws = ws;
		ws.onopen = () => {
			this.#opened = true;
			ws.send(JSON.stringify(dialogueHello(voice)));
			for (const frame of this.#outbox.splice(0)) ws.send(frame);
		};
		ws.onmessage = message => {
			if (this.#closed || typeof message.data !== "string") return;
			const event = parseDialogueEvent(message.data);
			if (event) listener.event(event);
		};
		ws.onclose = () => {
			clearInterval(this.#keepAlive);
			if (!this.#closed) listener.closed(this.#opened);
		};
		this.#keepAlive = setInterval(() => this.send(DIALOGUE_KEEP_ALIVE), KEEP_ALIVE_MS);
		this.#keepAlive.unref();
	}

	send(frame: object): void {
		if (this.#closed) return;
		const text = JSON.stringify(frame);
		if (!this.#opened) this.#outbox.push(text);
		else if (this.#ws.readyState === SOCKET_OPEN) this.#ws.send(text);
	}

	/** Silent and idempotent: abandoning the socket also abandons any generation in flight. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		clearInterval(this.#keepAlive);
		try {
			this.#ws.close();
		} catch {
			// Already closing.
		}
	}
}

export interface DialogueSessionOptions {
	readonly apiKey: string;
	readonly model: string;
	readonly voice: string;
	/** Whether `[warmly]`-style tags reach the voice; when false they are removed from the text. */
	readonly tags: boolean;
	readonly connect: SocketFactory;
	readonly fetch: typeof fetch;
	readonly signal: AbortSignal;
}

export class DialogueSpeakSession implements SpeakSession {
	readonly sampleRate = SAMPLE_RATE;
	readonly #options: DialogueSessionOptions;
	readonly #speakable: SpeakableText;
	readonly #out = new SpeakOutput();
	readonly #timeline = new DialogueTimeline();
	readonly #onAbort = () => this.cancel();
	#socket: DialogueSocket | null = null;
	/** Segments sent whose audio is not yet complete (`is_final_audio_for_turn` settles one each). */
	#outstanding = 0;
	/** Any audio at all has arrived: a drop before it is far more likely a refused voice than a network blip. */
	#heardAudio = false;
	#ended = false;
	#settled = false;
	#stall: Timer | undefined;
	#idle: Timer | undefined;

	/** Opens the connection now; a factory that throws fails the open, not a later push. */
	constructor(options: DialogueSessionOptions) {
		this.#options = options;
		this.#speakable = new SpeakableText(options.tags);
		this.#connect();
		options.signal.addEventListener("abort", this.#onAbort, { once: true });
		this.#watch();
	}

	get events(): AsyncIterable<SpeakEvent> {
		return this.#out.events;
	}

	push(segment: string): void {
		if (this.#settled || this.#ended) return;
		const text = this.#speakable.next(segment);
		if (text === null) return;
		try {
			(this.#socket ?? this.#connect()).send(dialogueInput(text, this.#options.voice));
		} catch (error) {
			this.#fail(error instanceof Error ? error.message : String(error));
			return;
		}
		this.#outstanding += 1;
		this.#watch();
	}

	flush(): void {
		if (this.#settled || this.#ended) return;
		this.#ended = true;
		// Nothing in flight: no text was pushed, or every segment's audio is already delivered.
		if (this.#outstanding === 0) {
			this.#finish();
			return;
		}
		this.#socket?.send(DIALOGUE_CLOSE);
		this.#watch();
	}

	/** Idempotent, and it always reaches the consumer: `end` is emitted unless the reply already ended. */
	cancel(): void {
		this.#settle();
		this.#out.cancel();
	}

	close(): void {
		this.#settle();
		this.#out.dispose();
	}

	#connect(): DialogueSocket {
		const { apiKey, connect, model, voice } = this.#options;
		// The key rides a header, never the URL.
		const ws = connect(dialogueSocketUrl(model), { "xi-api-key": apiKey });
		const socket = new DialogueSocket(ws, voice, {
			event: event => this.#onEvent(event),
			closed: opened => this.#onSocketClosed(opened),
		});
		this.#socket = socket;
		return socket;
	}

	#onEvent(event: DialogueEvent): void {
		if (this.#settled) return;
		switch (event.kind) {
			case "audio":
				this.#heardAudio ||= event.pcm.byteLength > 0;
				this.#timeline.audio(event.pcm.byteLength, SAMPLE_RATE);
				this.#out.audio(event.pcm);
				if (event.alignment) this.#out.words(this.#timeline.alignment(event.alignment));
				break;
			case "unit-done":
				this.#outstanding = Math.max(0, this.#outstanding - 1);
				this.#out.words(this.#timeline.flush());
				break;
			case "final":
				this.#finish();
				return;
			case "error":
				this.#fail(event.message);
				return;
		}
		this.#watch();
	}

	#onSocketClosed(opened: boolean): void {
		if (this.#settled) return;
		this.#socket = null;
		if (!opened) {
			void this.#failHandshake();
			return;
		}
		if (this.#outstanding > 0) {
			this.#fail(
				this.#heardAudio
					? "ElevenLabs closed the voice connection"
					: "ElevenLabs closed the voice connection before speaking (check the voice id)",
			);
			return;
		}
		// Idle (the server's 20 s timeout, a network blip): nothing is lost, the next segment
		// reopens. A closed reply whose audio was all delivered is simply complete.
		if (this.#ended) this.#finish();
		else this.#watch();
	}

	/** Why a handshake that never opened failed, asked of the API instead of guessed. */
	async #failHandshake(): Promise<void> {
		// Dead now (no timers, no socket, pushes ignored); only the report waits for the probe.
		this.#settle();
		this.#out.fail(await this.#probe());
	}

	async #probe(): Promise<string> {
		try {
			const res = await this.#options.fetch(`https://${API_HOST}/v1/user`, {
				headers: { "xi-api-key": this.#options.apiKey },
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});
			return describeHandshakeFailure(res.status, await res.text());
		} catch {
			return "Could not reach ElevenLabs";
		}
	}

	/** Watch for silence only while ElevenLabs owes something; release a connection that is merely idle. */
	#watch(): void {
		clearTimeout(this.#stall);
		clearTimeout(this.#idle);
		this.#stall = undefined;
		this.#idle = undefined;
		if (this.#settled) return;
		if (this.#outstanding > 0 || this.#ended) {
			this.#stall = setTimeout(() => this.#fail("ElevenLabs stopped responding"), STALL_MS);
			this.#stall.unref();
		} else if (this.#socket) {
			this.#idle = setTimeout(() => {
				this.#socket?.close();
				this.#socket = null;
			}, IDLE_MS);
			this.#idle.unref();
		}
	}

	#finish(): void {
		this.#out.words(this.#timeline.flush());
		this.#settle();
		this.#out.end();
	}

	#fail(message: string): void {
		this.#settle();
		this.#out.fail(message);
	}

	#settle(): void {
		this.#settled = true;
		clearTimeout(this.#stall);
		clearTimeout(this.#idle);
		this.#options.signal.removeEventListener("abort", this.#onAbort);
		this.#socket?.close();
		this.#socket = null;
	}
}
