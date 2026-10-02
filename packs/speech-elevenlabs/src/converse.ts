// A live call over ElevenLabs Agents (doc 92 §8): the ENGINE holds the agent socket, microphone PCM goes
// up through `pushAudio`, the voice comes down as `audio` events and `interrupt` flushes playback. This
// file owns one call: the handshake, the mapping of agent frames to the neutral ConverseEvent
// vocabulary, and the three behaviours the spike showed the wire needs:
//
//   - `progress` rides `contextual_update` with a stable id: the agent never speaks it;
//   - `final` rides `user_message`, which SPEAKS and, sent mid-speech, cuts the agent off. So it is
//     held until the agent is idle: `finalHoldMs` (8 s by default), stretched while the agent is audibly
//     still speaking to at most four holds (32 s), then sent anyway;
//   - an `interruption` arrives AFTER the agent's audio already burst over the wire (4-7x real time),
//     so nothing stops by itself: the client must flush on the `interrupt` event.
import type { ConverseEvent, ConverseMedia, ConversePhase, ConverseSession } from "@dimension/sdk/provider";
import {
	type AgentFrame,
	audioChunkFrame,
	initiationFrame,
	MAX_CALL_SECONDS,
	parseAgentFrame,
	pongFrame,
	progressFrame,
	toolResultFrame,
	userMessageFrame,
} from "./convai.js";
import { EventQueue } from "./output.js";

/** The slice of WebSocket a call uses, so a test can stand in for the network. */
export interface ConvaiSocket {
	readonly readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: (() => void) | null;
	onmessage: ((message: { readonly data: unknown }) => void) | null;
	onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
}

/** The signed URL carries the credential; there are no headers to set. */
export type ConvaiSocketFactory = (signedUrl: string) => ConvaiSocket;

const SOCKET_OPEN = 1;
const OPEN_TIMEOUT_MS = 10_000;
/** After a `user_message` the agent should start speaking within this; past it, it chose silence. */
const REPLY_AUDIO_WAIT_MS = 3_000;
export const DEFAULT_FINAL_HOLD_MS = 8_000;
/** A final is never held longer than this many holds, even while the agent is audibly still talking. */
const HOLD_CAP_FACTOR = 4;

const OVERRIDE_REFUSED = /Override for field '([^']+)'/;

export interface RelayOptions {
	readonly signedUrl: string;
	readonly connect: ConvaiSocketFactory;
	readonly instructions: string;
	readonly voice: string;
	readonly signal: AbortSignal;
	/** How long a `final` waits for the agent to stop speaking before it is sent anyway. */
	readonly finalHoldMs?: number;
	/** The agent refused an override it should allow: its stored configuration has drifted. */
	readonly onOverrideRefused?: () => void;
}

function describeClose(code: number, reason: string, onOverrideRefused: (() => void) | undefined): string {
	if (code === 1008) {
		const field = OVERRIDE_REFUSED.exec(reason)?.[1];
		if (field) {
			onOverrideRefused?.();
			return `ElevenLabs refused the "${field}" override: the live agent allows only its instructions, first message and voice`;
		}
		return `ElevenLabs ended the call by policy${reason ? `: ${reason}` : ""}`;
	}
	return `The ElevenLabs call dropped (code ${code}${reason ? `: ${reason}` : ""})`;
}

/** Open the socket, introduce the call, and resolve once ElevenLabs has accepted it (its metadata frame). */
export async function openRelay(options: RelayOptions): Promise<ConverseSession> {
	options.signal.throwIfAborted();
	const session = new RelaySession(options);
	await session.ready;
	return session;
}

class RelaySession implements ConverseSession {
	readonly ready: Promise<void>;
	readonly events: AsyncIterable<ConverseEvent>;

	readonly #ws: ConvaiSocket;
	readonly #queue = new EventQueue<ConverseEvent>();
	readonly #options: RelayOptions;
	readonly #finalHoldMs: number;
	readonly #settle = Promise.withResolvers<void>();
	readonly #timers = new Set<Timer>();
	readonly #abort: () => void;

	#media: Extract<ConverseMedia, { kind: "relay" }> | undefined;
	#ended = false;
	#openedAt = 0;
	#muted = false;
	#lastPhase: ConversePhase | undefined;

	/** The agent is speaking: from its first audio frame until `agent_response_complete` or an interruption. */
	#speaking = false;
	/** A `user_message` went out and the agent has not started answering it yet. */
	#replyPending = false;
	/** The user barged in and the agent has not answered yet: do not talk over them. */
	#userBusy = false;
	readonly #pendingFinals: string[] = [];
	#holdTimer: Timer | undefined;
	#replyTimer: Timer | undefined;
	#speakingTimer: Timer | undefined;
	#holdSince = 0;
	/** When the audio received so far finishes playing, if it plays gaplessly from its arrival (`performance.now()` ms). */
	#playbackEndsAt = 0;

	/** Delegations asked for and not yet answered. A `final` answers the whole run, so it closes every one. */
	readonly #delegations = new Set<string>();
	#userTurn = 0;
	#assistantTurn = 0;
	/** An assistant turn by the response id a later correction names. Bounded: a call has few responses. */
	readonly #responseTurns = new Map<string, number>();

	constructor(options: RelayOptions) {
		this.#options = options;
		this.#finalHoldMs = options.finalHoldMs ?? DEFAULT_FINAL_HOLD_MS;
		this.events = this.#queue;
		this.ready = this.#settle.promise;

		const ws = options.connect(options.signedUrl);
		this.#ws = ws;
		ws.onopen = () => ws.send(JSON.stringify(initiationFrame(options.instructions, options.voice)));
		ws.onmessage = message => this.#onMessage(message.data);
		ws.onclose = event => this.#onClose(event.code, event.reason);
		// Once the call is up the close event that follows an error ends it (with its code); before that, nothing else will.
		ws.onerror = () => {
			if (!this.#media) this.#failOpening(new Error("Could not reach the ElevenLabs live agent"));
		};

		this.#later(OPEN_TIMEOUT_MS, () => this.#failOpening(new Error("ElevenLabs did not answer the live call in time")));
		this.#abort = () => (this.#media ? this.close() : this.#failOpening(options.signal.reason));
		options.signal.addEventListener("abort", this.#abort, { once: true });
	}

	get media(): Extract<ConverseMedia, { kind: "relay" }> {
		if (!this.#media) throw new Error("the call is not open yet");
		return this.#media;
	}

	// ---- what the engine calls ------------------------------------------------------------------

	pushAudio(pcm: Uint8Array): void {
		if (this.#ended || this.#muted || pcm.byteLength === 0 || !this.#media) return;
		if (this.#ws.readyState === SOCKET_OPEN) this.#ws.send(audioChunkFrame(pcm));
	}

	mute(muted: boolean): void {
		this.#muted = muted;
		this.#updatePhase();
	}

	progress(_delegationId: string, text: string): void {
		if (this.#ended || !text) return;
		// The label is what the instructions call "context marked as progress": silent, never recited.
		this.#send(progressFrame(`Progress: ${text}`));
	}

	final(_delegationId: string, text: string): void {
		if (this.#ended) return;
		this.#delegations.clear();
		this.#updatePhase();
		this.#pendingFinals.push(text);
		if (!this.#busy()) this.#flushFinals();
		else if (this.#holdTimer === undefined) {
			this.#holdSince = performance.now();
			this.#holdTimer = this.#later(this.#finalHoldMs, () => this.#holdExpired());
		}
	}

	close(): void {
		this.#finish("client");
	}

	// ---- the agent's side ------------------------------------------------------------------------

	#onMessage(data: unknown): void {
		if (this.#ended) return;
		const raw = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : undefined;
		const frame = raw === undefined ? null : parseAgentFrame(raw);
		if (!frame) return;
		if (!this.#media) {
			// Until ElevenLabs accepts the call only its metadata, or a refusal, means anything.
			if (frame.kind === "metadata") this.#accept(frame);
			else if (frame.kind === "error") this.#failOpening(new Error(frame.message));
			return;
		}
		this.#onFrame(frame);
	}

	#accept(frame: Extract<AgentFrame, { kind: "metadata" }>): void {
		this.#media = { kind: "relay", inputRate: frame.inputRate, outputRate: frame.outputRate };
		this.#openedAt = performance.now();
		this.#clearTimers();
		this.#updatePhase();
		this.#settle.resolve();
	}

	#onFrame(frame: AgentFrame): void {
		switch (frame.kind) {
			case "audio":
				if (frame.pcm.byteLength === 0 || !this.#media) return;
				this.#speaking = true;
				this.#userBusy = false;
				this.#replyPending = false;
				this.#trackPlayback(frame.pcm.byteLength, this.#media.outputRate);
				this.#updatePhase();
				this.#emit({ t: "audio", pcm: frame.pcm, rate: this.#media.outputRate });
				return;
			case "user":
				this.#userBusy = false;
				this.#emit({ t: "transcript", role: "user", text: frame.text, turn: ++this.#userTurn, final: true });
				return;
			case "agent": {
				const turn = ++this.#assistantTurn;
				if (frame.responseId) {
					if (this.#responseTurns.size >= 64) this.#responseTurns.clear();
					this.#responseTurns.set(frame.responseId, turn);
				}
				this.#emit({ t: "transcript", role: "assistant", text: frame.text, turn, final: true });
				return;
			}
			case "correction": {
				// What the user actually heard of a response that was cut off ("" when none of it was).
				const turn = (frame.responseId && this.#responseTurns.get(frame.responseId)) || this.#assistantTurn;
				this.#emit({ t: "transcript", role: "assistant", text: frame.corrected, turn, final: true });
				return;
			}
			case "complete":
				this.#stopSpeaking();
				this.#userBusy = false;
				this.#flushWhenIdle();
				return;
			case "interruption":
				this.#stopSpeaking();
				this.#userBusy = true;
				this.#emit({ t: "interrupt" });
				return;
			case "tool":
				this.#onTool(frame);
				return;
			case "ping":
				this.#later(frame.delayMs, () => this.#send(pongFrame(frame.eventId)));
				return;
			case "error":
				this.#emit({ t: "error", message: frame.message });
				return;
			case "metadata":
				return;
		}
	}

	#onTool(frame: Extract<AgentFrame, { kind: "tool" }>): void {
		if (frame.name !== "delegate_to_agent" || frame.task === undefined) {
			const why = frame.task === undefined && frame.name === "delegate_to_agent" ? "task is required" : "unknown tool";
			this.#send(toolResultFrame(frame.callId, why, true));
			return;
		}
		this.#delegations.add(frame.callId);
		// The platform answers the model itself (`expects_response: false`); this only tells it we got the call.
		this.#send(toolResultFrame(frame.callId, "started", false));
		this.#updatePhase();
		this.#emit({ t: "delegate", id: frame.callId, task: frame.task });
	}

	#onClose(code: number, reason: string): void {
		if (this.#ended) return;
		if (!this.#media) {
			this.#failOpening(new Error(describeClose(code, reason, this.#options.onOverrideRefused)));
		} else if (code === 1000 || code === 1005) {
			const expired = performance.now() - this.#openedAt >= (MAX_CALL_SECONDS - 5) * 1000;
			this.#finish(expired ? "expired" : "provider");
		} else {
			this.#finish("error", describeClose(code, reason, this.#options.onOverrideRefused));
		}
	}

	// ---- holding the final until the agent is quiet -----------------------------------------------------

	#busy(): boolean {
		return this.#speaking || this.#replyPending || this.#userBusy;
	}

	#flushWhenIdle(): void {
		if (this.#pendingFinals.length > 0 && !this.#busy()) this.#flushFinals();
	}

	#flushFinals(): void {
		this.#cancel(this.#holdTimer);
		this.#holdTimer = undefined;
		if (this.#ended || this.#pendingFinals.length === 0) return;
		const text = this.#pendingFinals.splice(0).join("\n\n");
		this.#send(userMessageFrame(text));
		this.#replyPending = true;
		this.#cancel(this.#replyTimer);
		this.#replyTimer = this.#later(REPLY_AUDIO_WAIT_MS, () => {
			this.#replyPending = false;
			this.#flushWhenIdle();
		});
	}

	/**
	 * ElevenLabs sends a response's audio several times faster than it plays, so the audio received so far
	 * says when the agent will stop talking. `agent_response_complete` is the authority and arrives a couple
	 * of seconds after that; if it never does (a turn that ends another way) the agent counts as quiet once
	 * the audio has played out plus a grace of half the hold.
	 */
	#trackPlayback(bytes: number, rate: number): void {
		const now = performance.now();
		this.#playbackEndsAt = Math.max(this.#playbackEndsAt, now) + (bytes / 2 / rate) * 1000;
		this.#cancel(this.#speakingTimer);
		this.#speakingTimer = this.#later(this.#playbackEndsAt + this.#finalHoldMs / 2 - now, () => {
			this.#stopSpeaking();
			this.#flushWhenIdle();
		});
	}

	#stopSpeaking(): void {
		this.#speaking = false;
		this.#playbackEndsAt = 0;
		this.#cancel(this.#speakingTimer);
		this.#updatePhase();
	}

	/** The hold ran out. Send, unless the agent is still audibly mid-speech and the hard cap is not reached. */
	#holdExpired(): void {
		this.#holdTimer = undefined;
		const cap = this.#holdSince + this.#finalHoldMs * HOLD_CAP_FACTOR;
		const now = performance.now();
		if (this.#speaking && now < cap) {
			this.#holdTimer = this.#later(cap - now, () => this.#holdExpired());
			return;
		}
		this.#flushFinals();
	}

	// ---- plumbing ------------------------------------------------------------------------------------

	#send(frame: Record<string, unknown>): void {
		if (this.#ws.readyState === SOCKET_OPEN) this.#ws.send(JSON.stringify(frame));
	}

	#emit(event: ConverseEvent): void {
		if (!this.#ended) this.#queue.push(event);
	}

	#updatePhase(): void {
		if (this.#ended || !this.#media) return;
		let phase: ConversePhase = "listening";
		if (this.#speaking) phase = "speaking";
		else if (this.#delegations.size > 0) phase = "working";
		else if (this.#muted) phase = "muted";
		if (phase === this.#lastPhase) return;
		this.#lastPhase = phase;
		this.#queue.push({ t: "phase", phase });
	}

	#later(ms: number, run: () => void): Timer {
		const timer = setTimeout(() => {
			this.#timers.delete(timer);
			run();
		}, ms);
		this.#timers.add(timer);
		return timer;
	}

	/** Stop a timer for good: `clearTimeout` alone leaves it in `#timers` until teardown, one entry per audio frame. */
	#cancel(timer: Timer | undefined): void {
		if (timer === undefined) return;
		clearTimeout(timer);
		this.#timers.delete(timer);
	}

	#clearTimers(): void {
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers.clear();
	}

	#teardown(): void {
		this.#ended = true;
		this.#clearTimers();
		this.#pendingFinals.length = 0;
		this.#options.signal.removeEventListener("abort", this.#abort);
		try {
			this.#ws.close(1000);
		} catch {
			// Already closing.
		}
	}

	/** The call never came up: the open promise rejects, and the iterable ends empty. */
	#failOpening(error: unknown): void {
		if (this.#ended) return;
		this.#teardown();
		this.#queue.close();
		this.#settle.reject(error);
	}

	/** The call is over. Exactly one `end`, after at most one `error`, then the iterable completes. */
	#finish(reason: Extract<ConverseEvent, { t: "end" }>["reason"], error?: string): void {
		if (this.#ended) return;
		this.#teardown();
		if (error) this.#queue.push({ t: "error", message: error });
		this.#queue.push({ t: "end", reason });
		this.#queue.close();
	}
}
