import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Layout } from "./layout.js";
import { type CloneModel, type LockPlatform, PACK_FILES, type Registry } from "./registry.js";
import { collectTail, definedEnv, spawnWorker } from "./worker.js";

const MARKER = "dimension-voice-clone.json";
const ENVIRONMENT_SHARE = 0.3;
const VENV_SHARE = 0.05;

export function installStamp(model: CloneModel, platform: LockPlatform): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				python: model.python,
				torch: model.torch,
				weights: model.weights,
				source: model.source ?? null,
			}),
		)
		.update(readFileSync(PACK_FILES.lock(model.id, platform)))
		.digest("hex");
}

export async function isInstalled(layout: Layout, model: CloneModel, platform: LockPlatform): Promise<boolean> {
	try {
		const marker: unknown = JSON.parse(await readFile(join(layout.env(model.id), MARKER), "utf8"));
		return (
			typeof marker === "object" &&
			marker !== null &&
			"stamp" in marker &&
			marker.stamp === installStamp(model, platform)
		);
	} catch {
		return false;
	}
}

function runUv(uv: string, args: readonly string[], env: Record<string, string>, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const child = spawn(uv, args, { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
	const tail = collectTail(child.stderr);
	const onAbort = () => child.kill();
	signal.addEventListener("abort", onAbort, { once: true });
	child.once("error", error => {
		signal.removeEventListener("abort", onAbort);
		reject(error);
	});
	child.once("close", code => {
		signal.removeEventListener("abort", onAbort);
		if (signal.aborted) reject(signal.reason);
		else if (code === 0) resolve();
		else reject(new Error(`uv ${args[0]} ${args[1] ?? ""} failed (exit ${code}):\n${tail()}`));
	});
	return promise;
}

export interface InstallTools {
	readonly uv: string;
	readonly platform: LockPlatform;
	readonly env: Readonly<Record<string, string | undefined>>;
}

export async function install(
	layout: Layout,
	registry: Registry,
	model: CloneModel,
	tools: InstallTools,
	onProgress: (fraction: number) => void,
	signal: AbortSignal,
): Promise<void> {
	const env = definedEnv(tools.env);
	const envDir = layout.env(model.id);
	const torchIndex = registry.torchIndexes[model.torch];
	if (!torchIndex) throw new Error(`models.json names no torch index "${model.torch}" for ${model.id}`);

	onProgress(0);
	await runUv(tools.uv, ["venv", "--python", model.python, "--allow-existing", envDir], env, signal);
	onProgress(VENV_SHARE);
	await runUv(
		tools.uv,
		[
			"pip",
			"sync",
			"--python",
			layout.python(model.id),
			PACK_FILES.lock(model.id, tools.platform),
			"--extra-index-url",
			torchIndex,
			"--index-strategy",
			"unsafe-best-match",
		],
		env,
		signal,
	);
	onProgress(ENVIRONMENT_SHARE);

	let failure: string | undefined;
	const worker = spawnWorker(layout, model.id, tools.env, "setup", frame => {
		if (frame.kind !== "event") return;
		const event = frame.event;
		if (event.t === "progress") onProgress(ENVIRONMENT_SHARE + (1 - ENVIRONMENT_SHARE) * event.fraction);
		else if (event.t === "fatal") failure = event.message;
	});
	const onAbort = () => worker.child.kill();
	signal.addEventListener("abort", onAbort, { once: true });
	const { code, tail } = await worker.exited;
	signal.removeEventListener("abort", onAbort);
	signal.throwIfAborted();
	if (code !== 0) throw new Error(`downloading ${model.label} failed: ${failure ?? tail}`);

	await writeFile(join(envDir, MARKER), JSON.stringify({ stamp: installStamp(model, tools.platform) }));
	onProgress(1);
}

interface RunningInstall {
	readonly controller: AbortController;
	readonly listeners: Set<(fraction: number) => void>;
	readonly done: Promise<void>;
	readonly progress: { last: number };
}

export class SharedInstalls {
	readonly #running = new Map<string, RunningInstall>();

	join(
		key: string,
		start: (onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<void>,
		onProgress: (fraction: number) => void,
		signal: AbortSignal,
	): Promise<void> {
		signal.throwIfAborted();
		const prior = this.#running.get(key);
		const run = prior && !prior.controller.signal.aborted ? prior : this.#start(key, start, prior?.done);
		const listener = (fraction: number) => onProgress(fraction);
		run.listeners.add(listener);
		if (run.progress.last > 0) onProgress(run.progress.last);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const leave = () => {
			if (!run.listeners.delete(listener)) return;
			if (run.listeners.size === 0) run.controller.abort(signal.reason);
			reject(signal.reason);
		};
		signal.addEventListener("abort", leave, { once: true });
		run.done.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", leave);
			run.listeners.delete(listener);
		});
		return promise;
	}

	#start(
		key: string,
		start: (onProgress: (fraction: number) => void, signal: AbortSignal) => Promise<void>,
		previous: Promise<void> | undefined,
	): RunningInstall {
		const controller = new AbortController();
		const listeners = new Set<(fraction: number) => void>();
		const progress = { last: 0 };
		const report = (fraction: number) => {
			if (fraction <= progress.last) return;
			progress.last = fraction;
			for (const listener of listeners) listener(fraction);
		};
		const settledPrevious = previous?.catch(() => {}) ?? Promise.resolve();
		const done = settledPrevious
			.then(() => {
				controller.signal.throwIfAborted();
				return start(report, controller.signal);
			})
			.finally(() => {
				if (this.#running.get(key) === run) this.#running.delete(key);
			});
		done.catch(() => {});
		const run: RunningInstall = { controller, listeners, done, progress };
		this.#running.set(key, run);
		return run;
	}
}
