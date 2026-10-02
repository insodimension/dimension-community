// One reply spoken through per-segment requests (every model the dialogue socket does not serve,
// e.g. Flash v2.5): audio and character alignment come back together on one NDJSON stream.
// Segments are spoken strictly in order, one request at a time.
import type { SpeakEvent, SpeakSession } from "@dimension/sdk/provider";
import { WordAssembler } from "./alignment.js";
import { SpeakOutput } from "./output.js";
import { describeHttpFailure, parseSegmentLine, SAMPLE_RATE, segmentBody, segmentUrl } from "./protocol.js";
import { SpeakableText } from "./speakable.js";

/** Silence from ElevenLabs during a request before the reply is failed. */
const STALL_MS = 20_000;

export interface SegmentSessionOptions {
	readonly apiKey: string;
	readonly model: string;
	readonly voice: string;
	/** Whether `[warmly]`-style tags reach the voice; when false they are removed from the text. */
	readonly tags: boolean;
	readonly fetch: typeof fetch;
	readonly signal: AbortSignal;
}

export class SegmentSpeakSession implements SpeakSession {
	readonly sampleRate = SAMPLE_RATE;
	readonly #options: SegmentSessionOptions;
	readonly #speakable: SpeakableText;
	readonly #out = new SpeakOutput();
	readonly #abort = new AbortController();
	readonly #onAbort = () => this.cancel();
	readonly #queue: string[] = [];
	#running = false;
	#ended = false;
	#settled = false;
	/** Audio seconds delivered before the current segment: its alignment is relative to itself. */
	#elapsed = 0;
	#stall: Timer | undefined;

	constructor(options: SegmentSessionOptions) {
		this.#options = options;
		this.#speakable = new SpeakableText(options.tags);
		options.signal.addEventListener("abort", this.#onAbort, { once: true });
	}

	get events(): AsyncIterable<SpeakEvent> {
		return this.#out.events;
	}

	push(segment: string): void {
		if (this.#settled || this.#ended) return;
		const text = this.#speakable.next(segment);
		if (text === null) return;
		this.#queue.push(text);
		void this.#pump();
	}

	flush(): void {
		if (this.#settled || this.#ended) return;
		this.#ended = true;
		void this.#pump();
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

	async #pump(): Promise<void> {
		if (this.#running || this.#settled) return;
		this.#running = true;
		try {
			for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) {
				await this.#speak(next);
			}
		} catch (error) {
			// A cancelled request throws too; the session is already settled then.
			if (!this.#settled) this.#fail(error instanceof Error ? error.message : String(error));
			return;
		} finally {
			this.#running = false;
			clearTimeout(this.#stall);
		}
		if (this.#ended && !this.#settled && this.#queue.length === 0) {
			this.#settle();
			this.#out.end();
		}
	}

	async #speak(text: string): Promise<void> {
		const { apiKey, model, voice } = this.#options;
		this.#watch();
		const res = await this.#options.fetch(segmentUrl(voice), {
			method: "POST",
			// The key rides a header, never the URL.
			headers: { "xi-api-key": apiKey, "content-type": "application/json" },
			body: JSON.stringify(segmentBody(text, model)),
			signal: this.#abort.signal,
		});
		if (!res.ok || !res.body) throw new Error(describeHttpFailure(res.status, await res.text().catch(() => "")));
		const words = new WordAssembler();
		let bytes = 0;
		const handle = (line: string): void => {
			const chunk = parseSegmentLine(line);
			if (!chunk || this.#settled) return;
			if (chunk.pcm) {
				bytes += chunk.pcm.byteLength;
				this.#out.audio(chunk.pcm);
			}
			if (chunk.alignment) {
				const base = this.#elapsed;
				this.#out.words(
					words.push(
						chunk.alignment.chars,
						chunk.alignment.starts.map(s => base + s),
						chunk.alignment.ends.map(e => base + e),
					),
				);
			}
		};
		const decoder = new TextDecoder();
		let pending = "";
		for await (const part of res.body) {
			this.#watch();
			pending += decoder.decode(part, { stream: true });
			for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
				const line = pending.slice(0, nl).trim();
				pending = pending.slice(nl + 1);
				if (line) handle(line);
			}
		}
		if (pending.trim()) handle(pending.trim());
		if (!this.#settled) this.#out.words(words.flush());
		this.#elapsed += bytes / 2 / SAMPLE_RATE;
	}

	/** (Re)arm the silence timer: a request that stops producing bytes fails the reply and aborts it. */
	#watch(): void {
		if (this.#settled) return;
		clearTimeout(this.#stall);
		this.#stall = setTimeout(() => this.#fail("ElevenLabs stopped responding"), STALL_MS);
		this.#stall.unref();
	}

	#fail(message: string): void {
		this.#settle();
		this.#out.fail(message);
	}

	#settle(): void {
		this.#settled = true;
		clearTimeout(this.#stall);
		this.#options.signal.removeEventListener("abort", this.#onAbort);
		this.#abort.abort();
	}
}
