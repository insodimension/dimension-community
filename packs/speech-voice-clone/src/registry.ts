import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type TagStyle = "none" | "brackets" | "breeze";

export type LockPlatform = "windows" | "linux";

export interface WeightsPin {
	readonly repo: string;
	readonly revision: string;
	readonly files?: readonly string[];
}

export interface SourcePin {
	readonly repo: string;
	readonly sha: string;
}

export interface Licence {
	readonly id: string;
	readonly commercialUse: "yes" | "no";
	readonly url: string;
}

export interface CloneModel {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly sizeHint: string;
	readonly python: string;
	readonly torch: string;
	readonly sampleRate: number;
	readonly weights: WeightsPin;
	readonly source?: SourcePin;
	readonly tags: TagStyle;
	readonly licence: Licence;
}

export interface Registry {
	readonly torchIndexes: Readonly<Record<string, string>>;
	readonly models: readonly CloneModel[];
}

export const PACK_FILES = {
	models: fileURLToPath(new URL("../models.json", import.meta.url)),
	worker: fileURLToPath(new URL("../python/worker.py", import.meta.url)),
	lock: (model: string, platform: LockPlatform) =>
		fileURLToPath(new URL(`../python/requirements/${model}.${platform}.txt`, import.meta.url)),
} as const;

export function lockPlatform(platform: NodeJS.Platform = process.platform): LockPlatform | undefined {
	if (platform === "win32") return "windows";
	if (platform === "linux") return "linux";
	return undefined;
}

export function loadRegistry(file: string = PACK_FILES.models): Registry {
	return JSON.parse(readFileSync(file, "utf8")) as Registry;
}

export const DEFAULT_MODEL = "qwen3-tts";

export function findModel(registry: Registry, id: string): CloneModel {
	const model = registry.models.find(candidate => candidate.id === id);
	if (!model) {
		throw new Error(
			`voice-clone has no model "${id}" (available: ${registry.models.map(candidate => candidate.id).join(", ")})`,
		);
	}
	return model;
}
