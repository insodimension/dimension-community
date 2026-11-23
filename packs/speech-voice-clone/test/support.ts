import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeakEvent, SpeakSession } from "@dimension/sdk/provider";
import { installStamp } from "../src/install.js";
import type { ClonedVoice, Layout } from "../src/layout.js";
import { type CloneModel, findModel, type LockPlatform, loadRegistry } from "../src/registry.js";
import type { LiveWorker, Utterance, WorkerLease } from "../src/runtime.js";
import { CloneSpeakSession } from "../src/speak.js";

export const INSTALL_MARKER_FILE = "dimension-voice-clone.json";
export const REGISTRY = loadRegistry();
export const QWEN = findModel(REGISTRY, "qwen3-tts");
export const BREEZE = findModel(REGISTRY, "breeze-tts-2");
export const VOXCPM = findModel(REGISTRY, "voxcpm2");
export const FISH = findModel(REGISTRY, "fish-s2-pro");
export const CHATTERBOX = findModel(REGISTRY, "chatterbox");

export const TEST_PLATFORM: NodeJS.Platform = "linux";
export const TEST_LOCK: LockPlatform = "linux";

export const VOICE: ClonedVoice = { id: "me", label: "me", audio: "/voices/me.wav", transcript: "Hello there." };

const SETTLE_TICKS = 12;
const WAIT_LIMIT_MS = 30_000;

export function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

export async function quiet(): Promise<void> {
	for (let i = 0; i < SETTLE_TICKS; i++) await tick();
}

export async function waitFor(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + WAIT_LIMIT_MS;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
		await tick();
	}
}

export class TempDirs {
	readonly #dirs: string[] = [];

	async make(prefix = "voice-clone-test-"): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), prefix));
		this.#dirs.push(dir);
		return dir;
	}

	async dispose(): Promise<void> {
		await Promise.all(this.#dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
	}
}

export async function writeText(path: string, content: string): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, content);
}

export async function addVoice(layout: Pick<Layout, "voices">, name: string, transcript = "Hello there."): Promise<void> {
	await mkdir(layout.voices, { recursive: true });
	await writeFile(join(layout.voices, `${name}.wav`), "RIFF");
	await writeFile(join(layout.voices, `${name}.txt`), transcript);
}

export async function markInstalled(layout: Layout, model: CloneModel, lock: LockPlatform = TEST_LOCK, stamp: string = installStamp(model, lock)): Promise<void> {
	await writeText(join(layout.env(model.id), INSTALL_MARKER_FILE), JSON.stringify({ stamp }));
}

export async function dummyUv(dir: string): Promise<string> {
	const path = join(dir, process.platform === "win32" ? "uv.exe" : "uv");
	await writeText(path, "not a real uv");
	return path;
}

export function pcmOf(samples: number, salt = 0): Uint8Array {
	return Uint8Array.from({ length: samples * 2 }, (_, i) => (i + salt) % 251);
}

export function pcmSeconds(seconds: number, sampleRate: number, salt = 0): Uint8Array {
	return pcmOf(Math.round(seconds * sampleRate), salt);
}

export type EventOf<T extends SpeakEvent["t"]> = Extract<SpeakEvent, { t: T }>;

export function ofType<T extends SpeakEvent["t"]>(events: readonly SpeakEvent[], t: T): EventOf<T>[] {
	return events.filter((event): event is EventOf<T> => event.t === t);
}

export function audioBytes(events: readonly SpeakEvent[]): Uint8Array {
	return new Uint8Array(Buffer.concat(ofType(events, "audio").map(event => event.pcm)));
}

export class Recorder {
	readonly events: SpeakEvent[] = [];
	readonly finished: Promise<void>;

	constructor(session: SpeakSession) {
		this.finished = (async () => {
			for await (const event of session.events) this.events.push(event);
		})();
	}

	get kinds(): string[] {
		return this.events.map(event => event.t);
	}

	count(t: SpeakEvent["t"]): number {
		return this.events.filter(event => event.t === t).length;
	}

	until(predicate: (events: readonly SpeakEvent[]) => boolean, what: string): Promise<void> {
		return waitFor(() => predicate(this.events), what);
	}

	untilEnds(count: number): Promise<void> {
		return this.until(() => this.count("end") >= count, `${count} end event(s); saw [${this.kinds.join(", ")}]`);
	}
}

export interface FakeCall {
	readonly id: number;
	readonly text: string;
	readonly voice: ClonedVoice;
	readonly options: Readonly<Record<string, unknown>>;
	readonly emit: (pcm: Uint8Array) => void;
	readonly finish: () => void;
	readonly fail: (message: string) => void;
}

export class FakeLiveWorker {
	readonly calls: FakeCall[] = [];
	readonly cancels: number[] = [];
	maxInFlight = 0;
	speakThrows: Error | undefined;
	#inFlight = 0;
	readonly #script: ((call: FakeCall) => void) | undefined;

	constructor(script?: (call: FakeCall) => void) {
		this.#script = script;
	}

	speak(text: string, voice: ClonedVoice, options: Readonly<Record<string, unknown>>, onAudio: (pcm: Uint8Array) => void): Utterance {
		if (this.speakThrows) throw this.speakThrows;
		const id = this.calls.length + 1;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#inFlight++;
		this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);
		let settled = false;
		const settle = (action: () => void) => {
			if (settled) return;
			settled = true;
			this.#inFlight--;
			action();
		};
		const call: FakeCall = {
			id,
			text,
			voice,
			options,
			emit: pcm => onAudio(pcm),
			finish: () => settle(resolve),
			fail: message => settle(() => reject(new Error(message))),
		};
		this.calls.push(call);
		this.#script?.(call);
		return { id, done: promise };
	}

	cancel(id: number): void {
		this.cancels.push(id);
	}

	asLiveWorker(): LiveWorker {
		return this as unknown as LiveWorker;
	}
}

export function speaksSeconds(seconds: number, sampleRate: number): (call: FakeCall) => void {
	return call => {
		call.emit(pcmSeconds(seconds, sampleRate, call.id));
		call.finish();
	};
}

export class LeaseLedger {
	requested = 0;
	granted = 0;
	released = 0;
	readonly signals: AbortSignal[] = [];

	get held(): number {
		return this.granted - this.released;
	}

	request(signal: AbortSignal): void {
		this.requested++;
		this.signals.push(signal);
	}

	grant(worker: FakeLiveWorker): WorkerLease {
		this.granted++;
		let released = false;
		return {
			worker: worker.asLiveWorker(),
			release: () => {
				if (released) return;
				released = true;
				this.released++;
			},
		};
	}
}

export interface SessionOptions {
	readonly model?: CloneModel;
	readonly audioTags?: boolean;
	readonly options?: Readonly<Record<string, unknown>>;
	readonly worker?: FakeLiveWorker;
	readonly lease?: (signal: AbortSignal, ledger: LeaseLedger) => Promise<WorkerLease>;
}

export interface SessionRig {
	readonly session: CloneSpeakSession;
	readonly recorder: Recorder;
	readonly worker: FakeLiveWorker;
	readonly abort: AbortController;
	readonly leases: LeaseLedger;
}

const openSessions: CloneSpeakSession[] = [];

export function closeSessions(): void {
	for (const session of openSessions.splice(0)) session.close();
}

export function makeSession(settings: SessionOptions = {}): SessionRig {
	const model = settings.model ?? QWEN;
	const worker = settings.worker ?? new FakeLiveWorker(speaksSeconds(0.5, model.sampleRate));
	const abort = new AbortController();
	const leases = new LeaseLedger();
	const session = new CloneSpeakSession({
		model,
		voice: VOICE,
		options: settings.options ?? {},
		audioTags: settings.audioTags ?? true,
		lease: signal => {
			leases.request(signal);
			return settings.lease ? settings.lease(signal, leases) : Promise.resolve(leases.grant(worker));
		},
		signal: abort.signal,
	});
	openSessions.push(session);
	return { session, recorder: new Recorder(session), worker, abort, leases };
}
