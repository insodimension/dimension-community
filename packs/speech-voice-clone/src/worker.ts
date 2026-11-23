import { type ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { Layout } from "./layout.js";
import { PACK_FILES } from "./registry.js";

const FRAME_HEADER_BYTES = 5;
const FRAME_JSON = 1;
const FRAME_AUDIO = 2;
const STDERR_TAIL_LINES = 12;
const STDERR_LINE_CHARS = 300;
const UTF8 = new TextDecoder();

export type WorkerEvent =
	| { readonly t: "ready"; readonly sampleRate: number }
	| { readonly t: "done"; readonly id: number }
	| { readonly t: "error"; readonly id: number; readonly message: string }
	| { readonly t: "fatal"; readonly message: string }
	| { readonly t: "progress"; readonly stage: string; readonly fraction: number };

export type WorkerFrame =
	| { readonly kind: "event"; readonly event: WorkerEvent }
	| { readonly kind: "audio"; readonly id: number; readonly pcm: Uint8Array };

export class FrameDecoder {
	readonly #chunks: Uint8Array[] = [];
	#buffered = 0;

	push(chunk: Uint8Array): WorkerFrame[] {
		if (chunk.length > 0) {
			this.#chunks.push(chunk);
			this.#buffered += chunk.length;
		}
		const frames: WorkerFrame[] = [];
		while (this.#buffered >= FRAME_HEADER_BYTES) {
			const header = this.#read(FRAME_HEADER_BYTES, false);
			const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
			const length = view.getUint32(0, true);
			const kind = view.getUint8(4);
			if (this.#buffered < FRAME_HEADER_BYTES + length) break;
			const frame = this.#read(FRAME_HEADER_BYTES + length, true);
			const payload = frame.subarray(FRAME_HEADER_BYTES);
			if (kind === FRAME_JSON) {
				frames.push({ kind: "event", event: JSON.parse(UTF8.decode(payload)) as WorkerEvent });
			} else if (kind === FRAME_AUDIO) {
				const id = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true);
				frames.push({ kind: "audio", id, pcm: payload.subarray(4) });
			} else {
				throw new Error(`voice-clone worker sent an unknown frame kind ${kind}`);
			}
		}
		return frames;
	}

	#read(length: number, consume: boolean): Uint8Array {
		const first = this.#chunks[0];
		if (first && first.length >= length) {
			const bytes = first.slice(0, length);
			if (consume) this.#drop(length);
			return bytes;
		}
		const bytes = new Uint8Array(length);
		let filled = 0;
		for (const chunk of this.#chunks) {
			const take = Math.min(chunk.length, length - filled);
			bytes.set(chunk.subarray(0, take), filled);
			filled += take;
			if (filled === length) break;
		}
		if (consume) this.#drop(length);
		return bytes;
	}

	#drop(length: number): void {
		this.#buffered -= length;
		let remaining = length;
		while (remaining > 0) {
			const first = this.#chunks[0];
			if (!first) return;
			if (first.length <= remaining) {
				this.#chunks.shift();
				remaining -= first.length;
			} else {
				this.#chunks[0] = first.subarray(remaining);
				remaining = 0;
			}
		}
	}
}

export function definedEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
	return env;
}

export function workerEnv(
	layout: Layout,
	base: Readonly<Record<string, string | undefined>>,
	offline: boolean,
): Record<string, string> {
	const env = definedEnv(base);
	Object.assign(env, {
		HF_HOME: layout.hf,
		HF_HUB_DISABLE_TELEMETRY: "1",
		PYTHONUTF8: "1",
		PYTHONIOENCODING: "utf-8",
		PYTHONUNBUFFERED: "1",
		PYTHONDONTWRITEBYTECODE: "1",
	});
	if (offline) env.HF_HUB_OFFLINE = "1";
	return env;
}

export function collectTail(stream: Readable | null): () => string {
	const tail: string[] = [];
	let partial = "";
	const keep = (line: string) => {
		if (!line.trim()) return;
		tail.push(line.slice(0, STDERR_LINE_CHARS));
		if (tail.length > STDERR_TAIL_LINES) tail.shift();
	};
	stream?.setEncoding("utf8");
	stream?.on("data", (text: string) => {
		const lines = `${partial}${text}`.split(/\r?\n/);
		partial = lines.pop() ?? "";
		for (const line of lines) keep(line);
	});
	return () => {
		const unfinished = partial.trim() ? [...tail, partial.slice(0, STDERR_LINE_CHARS)] : tail;
		return unfinished.slice(-STDERR_TAIL_LINES).join("\n");
	};
}

export interface SpawnedWorker {
	readonly child: ChildProcess;
	readonly exited: Promise<{ readonly code: number | null; readonly tail: string }>;
}

export function spawnWorker(
	layout: Layout,
	model: string,
	env: Readonly<Record<string, string | undefined>>,
	mode: "serve" | "setup",
	onFrame: (frame: WorkerFrame) => void,
): SpawnedWorker {
	const args = [PACK_FILES.worker, "--models-file", PACK_FILES.models, "--model", model, "--data", layout.root];
	if (mode === "setup") args.push("--setup");
	const child = spawn(layout.python(model), args, {
		env: workerEnv(layout, env, mode === "serve"),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	child.stdin?.on("error", () => {});
	const decoder = new FrameDecoder();
	child.stdout?.on("data", (chunk: Buffer) => {
		for (const frame of decoder.push(chunk)) onFrame(frame);
	});
	const tail = collectTail(child.stderr);
	const { promise: exited, resolve } = Promise.withResolvers<{ code: number | null; tail: string }>();
	child.once("error", error => resolve({ code: null, tail: error.message }));
	child.once("close", code => resolve({ code, tail: tail() }));
	return { child, exited };
}
