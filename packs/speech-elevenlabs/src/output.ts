// The consumer side of a SpeakSession: an ordered event queue the engine drains with `for await`,
// audio re-cut into small events, and the one terminal `end` every path funnels through.
import type { CaptionWord, SpeakEvent } from "@dimension/sdk/provider";
import { SAMPLE_RATE } from "./protocol.js";

/** ≤ 100 ms of PCM16 mono per audio event: small enough to schedule gaplessly, large enough not to flood the wire. */
const MAX_AUDIO_EVENT_BYTES = (SAMPLE_RATE / 10) * 2;

/** An async iterable fed by `push`, completed by `close`. One consumer. */
export class EventQueue<T extends object> implements AsyncIterable<T> {
	readonly #items: T[] = [];
	#waiter: ((result: IteratorResult<T>) => void) | null = null;
	#closed = false;

	push(item: T): void {
		if (this.#closed) return;
		const waiter = this.#waiter;
		if (waiter) {
			this.#waiter = null;
			waiter({ value: item, done: false });
		} else this.#items.push(item);
	}

	/** Drop what is queued but not yet consumed. */
	clear(): void {
		this.#items.length = 0;
	}

	close(): void {
		this.#closed = true;
		const waiter = this.#waiter;
		this.#waiter = null;
		waiter?.({ value: undefined, done: true });
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				const item = this.#items.shift();
				if (item !== undefined) return Promise.resolve({ value: item, done: false });
				if (this.#closed) return Promise.resolve({ value: undefined, done: true });
				return new Promise<IteratorResult<T>>(resolve => {
					this.#waiter = resolve;
				});
			},
			return: () => {
				this.clear();
				this.close();
				return Promise.resolve({ value: undefined, done: true });
			},
		};
	}
}

/**
 * Where a session's audio, caption words and terminal events go. `end` is emitted exactly once
 * and completes the iterable; nothing is delivered after it.
 */
export class SpeakOutput {
	readonly #queue = new EventQueue<SpeakEvent>();
	/** A network chunk may end mid-sample; the odd byte waits for the next one. */
	#carry: number | null = null;
	#ended = false;

	get events(): AsyncIterable<SpeakEvent> {
		return this.#queue;
	}

	audio(chunk: Uint8Array): void {
		if (this.#ended) return;
		let bytes = chunk;
		if (this.#carry !== null) {
			bytes = new Uint8Array(chunk.byteLength + 1);
			bytes[0] = this.#carry;
			bytes.set(chunk, 1);
			this.#carry = null;
		}
		if (bytes.byteLength % 2 === 1) {
			this.#carry = bytes[bytes.byteLength - 1]!;
			bytes = bytes.subarray(0, bytes.byteLength - 1);
		}
		for (let start = 0; start < bytes.byteLength; start += MAX_AUDIO_EVENT_BYTES) {
			// A copy, so no event aliases a pooled network buffer.
			this.#queue.push({ t: "audio", pcm: new Uint8Array(bytes.subarray(start, start + MAX_AUDIO_EVENT_BYTES)) });
		}
	}

	words(words: readonly CaptionWord[]): void {
		if (!this.#ended && words.length > 0) this.#queue.push({ t: "words", words });
	}

	/** Every sample of the flushed text was delivered. */
	end(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#queue.push({ t: "end" });
		this.#queue.close();
	}

	/** `error`, then `end`: the consumer always sees the turn close. */
	fail(message: string): void {
		if (this.#ended) return;
		this.#queue.push({ t: "error", message });
		this.end();
	}

	/** Barge: what was queued for the consumer is dropped, then `end`. */
	cancel(): void {
		if (this.#ended) return;
		this.#queue.clear();
		this.end();
	}

	/**
	 * The session was torn down without a reply to finish: complete the iterable, say nothing.
	 * After a normal `end` this is a no-op, so the consumer still drains what was delivered.
	 */
	dispose(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#queue.clear();
		this.#queue.close();
	}
}
