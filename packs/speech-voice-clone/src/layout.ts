import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { delimiter, join, parse, resolve } from "node:path";
import type { SpeechVoiceInfo } from "@dimension/sdk/provider";

export interface Layout {
	readonly root: string;
	readonly voices: string;
	readonly hf: string;
	readonly env: (model: string) => string;
	readonly python: (model: string) => string;
}

export function layoutAt(root: string): Layout {
	const env = (model: string) => join(root, "envs", model);
	return {
		root,
		voices: join(root, "voices"),
		hf: join(root, "hf"),
		env,
		python: model =>
			process.platform === "win32" ? join(env(model), "Scripts", "python.exe") : join(env(model), "bin", "python"),
	};
}

export function resolveLayout(env: Readonly<Record<string, string | undefined>>, engineHome: string): Layout {
	const fromEnv = env.DIMENSION_VOICE_CLONE_HOME?.trim();
	return layoutAt(fromEnv ? resolve(fromEnv) : join(engineHome, "speech", "voice-clone"));
}

export interface ClonedVoice extends SpeechVoiceInfo {
	readonly audio: string;
	readonly transcript: string;
}

export async function listVoices(layout: Layout): Promise<ClonedVoice[]> {
	let names: string[];
	try {
		names = await readdir(layout.voices);
	} catch {
		return [];
	}
	const voices: ClonedVoice[] = [];
	for (const name of names.sort()) {
		const { name: id, ext } = parse(name);
		if (ext.toLowerCase() !== ".wav") continue;
		const transcript = await readFile(join(layout.voices, `${id}.txt`), "utf8").then(
			text => text.trim(),
			() => "",
		);
		if (!transcript) continue;
		voices.push({ id, label: id, audio: join(layout.voices, name), transcript });
	}
	return voices;
}

export function findUv(env: Readonly<Record<string, string | undefined>>, userHome: string): string | undefined {
	const explicit = env.UV?.trim();
	if (explicit && existsSync(explicit)) return explicit;
	const binary = process.platform === "win32" ? "uv.exe" : "uv";
	const directories = [
		...(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean),
		join(userHome, ".local", "bin"),
		join(userHome, ".cargo", "bin"),
	];
	return directories.map(directory => join(directory, binary)).find(candidate => existsSync(candidate));
}
