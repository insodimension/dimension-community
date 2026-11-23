import { homedir } from "node:os";
import type { SpeechProvider, SpeechProviderContext, SpeechReadiness } from "@dimension/sdk/provider";
import { install, isInstalled, SharedInstalls } from "./install.js";
import { findUv, type Layout, listVoices, resolveLayout } from "./layout.js";
import {
	type CloneModel,
	findModel,
	type LockPlatform,
	loadRegistry,
	lockPlatform,
	type Registry,
} from "./registry.js";
import { WorkerPool } from "./runtime.js";
import { CloneSpeakSession } from "./speak.js";
import { guideFor } from "./tags.js";

export const PROVIDER_ID = "voice-clone";

const UV_INSTALL_URL = "https://docs.astral.sh/uv/getting-started/installation/";

export interface VoiceCloneDeps {
	readonly registry?: Registry;
	readonly pool?: WorkerPool;
	readonly userHome?: string;
	readonly platform?: NodeJS.Platform;
}

export class SpeechNeedsDownloadError extends Error {
	readonly reason = "needs-download";
	readonly half = "speak";
	readonly model: string;
	readonly sizeHint: string;
	readonly detail: string;

	constructor(model: CloneModel) {
		super(`Download the ${model.label} model (${model.sizeHint}) to speak.`);
		this.name = "SpeechNeedsDownloadError";
		this.model = model.id;
		this.sizeHint = model.sizeHint;
		this.detail = `${model.label} is not downloaded yet (${model.sizeHint})`;
	}
}

function describe(model: CloneModel): string {
	const licence =
		model.licence.commercialUse === "yes" ? model.licence.id : `${model.licence.id}: not for commercial use`;
	return `${model.description} Licence: ${licence}.`;
}

export function createVoiceCloneProvider(deps: VoiceCloneDeps = {}): SpeechProvider {
	const registry = deps.registry ?? loadRegistry();
	const pool = deps.pool ?? new WorkerPool();
	const installs = new SharedInstalls();
	const platform = lockPlatform(deps.platform ?? process.platform);
	const userHome = deps.userHome ?? homedir();

	const blocker = async (ctx: SpeechProviderContext, layout: Layout): Promise<string | undefined> => {
		if (!platform) return "Voice cloning needs an NVIDIA GPU with CUDA on Windows or Linux.";
		if (!findUv(ctx.env, userHome)) {
			return `Voice cloning builds each model's Python environment with uv. Install uv (${UV_INSTALL_URL}) or set UV to its path.`;
		}
		if ((await listVoices(layout)).length === 0) {
			return `Add a voice first: put a clean 10 to 30 second recording at ${layout.voices}/<name>.wav and its exact words in <name>.txt beside it.`;
		}
		return undefined;
	};

	const readinessByModel = async (
		ctx: SpeechProviderContext,
		layout: Layout,
	): Promise<Record<string, SpeechReadiness>> => {
		const blocked = await blocker(ctx, layout);
		const entries = await Promise.all(
			registry.models.map(async (model): Promise<[string, SpeechReadiness]> => {
				if (blocked || !platform) return [model.id, { ready: false, reason: "unavailable", detail: blocked }];
				if (await isInstalled(layout, model, platform)) return [model.id, { ready: true }];
				return [
					model.id,
					{ ready: false, reason: "needs-download", detail: new SpeechNeedsDownloadError(model).detail },
				];
			}),
		);
		return Object.fromEntries(entries);
	};

	const requireReady = async (ctx: SpeechProviderContext, layout: Layout): Promise<LockPlatform> => {
		const blocked = await blocker(ctx, layout);
		if (blocked || !platform) throw new Error(blocked ?? "unsupported platform");
		return platform;
	};

	return {
		id: PROVIDER_ID,

		async catalog(ctx) {
			const layout = resolveLayout(ctx.env, ctx.home);
			const [voices, byModel] = await Promise.all([listVoices(layout), readinessByModel(ctx, layout)]);
			return {
				speak: registry.models.map(model => {
					const guide = guideFor(model.tags);
					return {
						id: model.id,
						label: model.label,
						description: describe(model),
						voices: voices.map(({ id, label }) => ({ id, label })),
						audioTags: model.tags !== "none",
						sizeHint: model.sizeHint,
						...(byModel[model.id] ? { readiness: byModel[model.id] } : {}),
						...(guide ? { guide } : {}),
					};
				}),
				freeFormVoice: false,
				audioTags: false,
			};
		},

		async status(ctx) {
			const layout = resolveLayout(ctx.env, ctx.home);
			const byModel = await readinessByModel(ctx, layout);
			const states = Object.values(byModel);
			const headline: SpeechReadiness = states.some(state => state.ready)
				? { ready: true }
				: (states.find(state => !state.ready && state.reason === "unavailable") ?? {
						ready: false,
						reason: "needs-download",
						detail: "No voice-cloning model is downloaded yet",
					});
			return { speak: headline, byModel: { speak: byModel } };
		},

		async prepare(ctx, target, onProgress, signal) {
			signal.throwIfAborted();
			if (target.kind !== "speak") throw new Error(`voice-clone only speaks; it has no ${target.kind} models`);
			const model = findModel(registry, target.model);
			const layout = resolveLayout(ctx.env, ctx.home);
			const lock = await requireReady(ctx, layout);
			const uv = findUv(ctx.env, userHome);
			if (!uv) throw new Error(`uv is not installed: ${UV_INSTALL_URL}`);
			await installs.join(
				`${layout.root}\n${model.id}`,
				async (report, installSignal) => {
					if (await isInstalled(layout, model, lock)) return;
					await install(layout, registry, model, { uv, platform: lock, env: ctx.env }, report, installSignal);
				},
				onProgress,
				signal,
			);
		},

		releaseIdleModels: () => pool.releaseIdle(),

		async openSpeak(ctx, entry, opts) {
			opts.signal.throwIfAborted();
			const model = findModel(registry, entry.model);
			const layout = resolveLayout(ctx.env, ctx.home);
			const lock = await requireReady(ctx, layout);
			const voice = (await listVoices(layout)).find(candidate => candidate.id === entry.voice);
			if (!voice) {
				throw new Error(
					`voice-clone has no voice "${entry.voice}": add ${layout.voices}/${entry.voice}.wav and ${entry.voice}.txt`,
				);
			}
			if (!(await isInstalled(layout, model, lock))) throw new SpeechNeedsDownloadError(model);
			opts.signal.throwIfAborted();
			return new CloneSpeakSession({
				model,
				voice,
				options: entry.options ?? {},
				audioTags: opts.audioTags && model.tags !== "none",
				lease: signal => pool.acquire(layout, model, ctx.env, signal),
				signal: opts.signal,
			});
		},
	};
}

export function createSpeechProvider(): SpeechProvider {
	return createVoiceCloneProvider();
}
