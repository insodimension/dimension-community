import type { ClonedVoice, Layout } from "./layout.js";
import type { CloneModel } from "./registry.js";
import { type SpawnedWorker, spawnWorker, type WorkerFrame } from "./worker.js";

const IDLE_UNLOAD_MS = 5 * 60_000;

interface Pending {
	readonly onAudio: (pcm: Uint8Array) => void;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
}

export interface Utterance {
	readonly id: number;
	readonly done: Promise<void>;
}

export class LiveWorker {
	readonly model: CloneModel;
	readonly root: string;
	readonly ready: Promise<void>;
	readonly #process: SpawnedWorker;
	readonly #pending = new Map<number, Pending>();
	#nextId = 1;
	#failure: Error | undefined;

	constructor(layout: Layout, model: CloneModel, env: Readonly<Record<string, string | undefined>>) {
		this.model = model;
		this.root = layout.root;
		const ready = Promise.withResolvers<void>();
		this.ready = ready.promise;
		this.#process = spawnWorker(layout, model.id, env, "serve", frame => this.#receive(frame, ready));
		void this.#process.exited.then(({ code, tail }) => {
			const failure = this.#failure ?? new Error(`${model.label} stopped (exit ${code}): ${tail}`);
			this.#failure = failure;
			ready.reject(failure);
			for (const pending of this.#pending.values()) pending.reject(failure);
			this.#pending.clear();
		});
		this.ready.catch(() => {});
	}

	get alive(): boolean {
		return this.#failure === undefined;
	}

	speak(
		text: string,
		voice: ClonedVoice,
		options: Readonly<Record<string, unknown>>,
		onAudio: (pcm: Uint8Array) => void,
	): Utterance {
		if (this.#failure) throw this.#failure;
		const id = this.#nextId++;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#pending.set(id, { onAudio, resolve, reject });
		this.#send({ op: "speak", id, text, voice: { audio: voice.audio, transcript: voice.transcript }, options });
		return { id, done: promise };
	}

	cancel(id: number): void {
		if (this.#pending.has(id)) this.#send({ op: "cancel", id });
	}

	async stop(): Promise<void> {
		this.#failure ??= new Error(`${this.model.label} was unloaded`);
		this.#process.child.kill();
		await this.#process.exited;
	}

	#send(command: Record<string, unknown>): void {
		const stdin = this.#process.child.stdin;
		if (stdin?.writable) stdin.write(`${JSON.stringify(command)}\n`);
	}

	#receive(frame: WorkerFrame, ready: PromiseWithResolvers<void>): void {
		if (frame.kind === "audio") {
			this.#pending.get(frame.id)?.onAudio(frame.pcm);
			return;
		}
		const event = frame.event;
		if (event.t === "ready") {
			if (event.sampleRate !== this.model.sampleRate) {
				this.#failure = new Error(
					`${this.model.label} speaks at ${event.sampleRate} Hz, models.json says ${this.model.sampleRate} Hz`,
				);
				this.#process.child.kill();
				return;
			}
			ready.resolve();
		} else if (event.t === "fatal") {
			this.#failure = new Error(`${this.model.label} failed to load: ${event.message}`);
		} else if (event.t === "done" || event.t === "error") {
			const pending = this.#pending.get(event.id);
			this.#pending.delete(event.id);
			if (event.t === "done") pending?.resolve();
			else pending?.reject(new Error(`${this.model.label}: ${event.message}`));
		}
	}
}

export interface WorkerLease {
	readonly worker: LiveWorker;
	release(): void;
}

export class WorkerPool {
	readonly #idleMs: number;
	#live: LiveWorker | undefined;
	#leases = 0;
	#unleased: PromiseWithResolvers<void> | undefined;
	#idleTimer: NodeJS.Timeout | undefined;
	#turn: Promise<unknown> = Promise.resolve();

	constructor(idleMs: number = IDLE_UNLOAD_MS) {
		this.#idleMs = idleMs;
	}

	acquire(
		layout: Layout,
		model: CloneModel,
		env: Readonly<Record<string, string | undefined>>,
		signal: AbortSignal,
	): Promise<WorkerLease> {
		const next = this.#turn.then(async () => {
			signal.throwIfAborted();
			const worker = await this.#switchTo(layout, model, env, signal);
			return this.#lease(worker);
		});
		this.#turn = next.catch(() => {});
		return next;
	}

	async releaseIdle(): Promise<number> {
		const live = this.#live;
		if (!live || this.#leases > 0) return 0;
		clearTimeout(this.#idleTimer);
		this.#live = undefined;
		await live.stop();
		return 1;
	}

	async close(): Promise<void> {
		clearTimeout(this.#idleTimer);
		const live = this.#live;
		this.#live = undefined;
		await live?.stop();
	}

	#lease(worker: LiveWorker): WorkerLease {
		clearTimeout(this.#idleTimer);
		this.#leases++;
		let released = false;
		return {
			worker,
			release: () => {
				if (released) return;
				released = true;
				this.#leases--;
				if (this.#leases > 0) return;
				this.#unleased?.resolve();
				this.#unleased = undefined;
				this.#scheduleUnload(worker);
			},
		};
	}

	async #switchTo(
		layout: Layout,
		model: CloneModel,
		env: Readonly<Record<string, string | undefined>>,
		signal: AbortSignal,
	): Promise<LiveWorker> {
		const live = this.#live;
		if (live?.alive && live.model.id === model.id && live.root === layout.root) {
			await live.ready;
			return live;
		}
		if (this.#leases > 0) {
			this.#unleased ??= Promise.withResolvers<void>();
			await this.#unleased.promise;
			signal.throwIfAborted();
		}
		clearTimeout(this.#idleTimer);
		this.#live = undefined;
		await live?.stop();
		const worker = new LiveWorker(layout, model, env);
		this.#live = worker;
		try {
			await worker.ready;
		} catch (error) {
			if (this.#live === worker) this.#live = undefined;
			throw error;
		}
		return worker;
	}

	#scheduleUnload(worker: LiveWorker): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => {
			if (this.#live !== worker || this.#leases > 0) return;
			this.#live = undefined;
			void worker.stop();
		}, this.#idleMs);
		this.#idleTimer.unref?.();
	}
}
