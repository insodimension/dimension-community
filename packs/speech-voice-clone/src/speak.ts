import type { SpeakEvent, SpeakSession } from "@dimension/sdk/provider";
import type { ClonedVoice } from "./layout.js";
import type { CloneModel } from "./registry.js";
import type { LiveWorker, WorkerLease } from "./runtime.js";
import { captionText, estimateWords, voiceText } from "./tags.js";

const BYTES_PER_SAMPLE = 2;

export class EventChannel<T> implements AsyncIterable<T> {
	readonly #queue: T[] = [];
	#waiter: PromiseWithResolvers<IteratorResult<T>> | undefined;
	#closed = false;

	emit(value: T): void {
		if (this.#closed) return;
		const waiter = this.#waiter;
		if (waiter) {
			this.#waiter = undefined;
			waiter.resolve({ value, done: false });
		} else {
			this.#queue.push(value);
		}
	}

	close(): void {
		this.#closed = true;
		this.#waiter?.resolve({ value: undefined, done: true });
		this.#waiter = undefined;
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				const value = this.#queue.shift();
				if (value !== undefined) return Promise.resolve({ value, done: false });
				if (this.#closed) return Promise.resolve({ value: undefined, done: true });
				this.#waiter = Promise.withResolvers<IteratorResult<T>>();
				return this.#waiter.promise;
			},
		};
	}
}

export interface CloneSpeakOptions {
	readonly model: CloneModel;
	readonly voice: ClonedVoice;
	readonly options: Readonly<Record<string, unknown>>;
	readonly audioTags: boolean;
	readonly lease: (signal: AbortSignal) => Promise<WorkerLease>;
	readonly signal: AbortSignal;
}

export class CloneSpeakSession implements SpeakSession {
	readonly sampleRate: number;
	readonly events = new EventChannel<SpeakEvent>();
	readonly #settings: CloneSpeakOptions;
	readonly #onAbort = () => this.close();
	#queue: Promise<void> = Promise.resolve();
	#epoch = 0;
	#replyFailed = false;
	#elapsed = 0;
	#heldTags = "";
	#current: { readonly worker: LiveWorker; readonly id: number } | undefined;
	#lease: Promise<WorkerLease> | undefined;
	#leaseAbort = new AbortController();
	#closed = false;

	constructor(settings: CloneSpeakOptions) {
		this.#settings = settings;
		this.sampleRate = settings.model.sampleRate;
		settings.signal.addEventListener("abort", this.#onAbort, { once: true });
		settings.lease(settings.signal).then(
			warm => warm.release(),
			() => {},
		);
	}

	push(text: string): void {
		if (this.#closed) return;
		const { model, audioTags } = this.#settings;
		const spoken = voiceText(`${this.#heldTags} ${text}`, model.tags, audioTags);
		if (!captionText(spoken)) {
			this.#heldTags = audioTags && model.tags !== "none" ? spoken : "";
			return;
		}
		this.#heldTags = "";
		const epoch = this.#epoch;
		this.#queue = this.#queue.then(() => this.#speak(spoken, text, epoch));
	}

	flush(): void {
		if (this.#closed) return;
		const epoch = this.#epoch;
		this.#heldTags = "";
		this.#queue = this.#queue.then(() => {
			if (epoch !== this.#epoch || this.#closed) return;
			if (!this.#replyFailed) this.events.emit({ t: "end" });
			this.#replyFailed = false;
			this.#elapsed = 0;
			this.#releaseLease();
		});
	}

	cancel(): void {
		if (this.#closed) return;
		this.#dropAll();
		this.events.emit({ t: "end" });
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#settings.signal.removeEventListener("abort", this.#onAbort);
		this.#dropAll();
		this.events.close();
	}

	#dropAll(): void {
		this.#epoch++;
		this.#replyFailed = false;
		this.#elapsed = 0;
		this.#heldTags = "";
		const current = this.#current;
		this.#current = undefined;
		current?.worker.cancel(current.id);
		this.#releaseLease();
	}

	#releaseLease(): void {
		const lease = this.#lease;
		this.#lease = undefined;
		this.#leaseAbort.abort();
		this.#leaseAbort = new AbortController();
		lease?.then(
			held => held.release(),
			() => {},
		);
	}

	async #speak(spoken: string, caption: string, epoch: number): Promise<void> {
		if (epoch !== this.#epoch || this.#closed || this.#replyFailed) return;
		const { voice, options } = this.#settings;
		let samples = 0;
		try {
			this.#lease ??= this.#settings.lease(this.#leaseAbort.signal);
			const { worker } = await this.#lease;
			if (epoch !== this.#epoch || this.#closed) return;
			const utterance = worker.speak(spoken, voice, options, pcm => {
				if (epoch !== this.#epoch || this.#closed || pcm.length === 0) return;
				samples += pcm.length / BYTES_PER_SAMPLE;
				this.events.emit({ t: "audio", pcm });
			});
			this.#current = { worker, id: utterance.id };
			await utterance.done;
			if (epoch !== this.#epoch || this.#closed) return;
			this.#current = undefined;
			const seconds = samples / this.sampleRate;
			const words = estimateWords(caption, this.#elapsed, seconds);
			if (words.length > 0) this.events.emit({ t: "words", words });
			this.#elapsed += seconds;
		} catch (error) {
			if (epoch !== this.#epoch || this.#closed) return;
			this.#current = undefined;
			this.#replyFailed = true;
			this.#releaseLease();
			this.events.emit({ t: "error", message: error instanceof Error ? error.message : String(error) });
		}
	}
}
