import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CHANNEL_ID_LENGTH = 22;
const SEEDED_LIFETIME_MS = 24 * 3_600_000;
const FINGERPRINT_LENGTH = 32;

export function channelIdOf(tag: string): string {
	return `UC${tag.padEnd(CHANNEL_ID_LENGTH, "x").slice(0, CHANNEL_ID_LENGTH)}`;
}

export function fingerprintOf(refresh: string): string {
	return createHash("sha256").update(refresh).digest("hex").slice(0, FINGERPRINT_LENGTH);
}

export interface ChannelSeed {
	readonly channelId: string;
	readonly title: string;
	readonly handle?: string;
	readonly access: string;
	readonly refresh: string;
	readonly expires?: number;
	readonly connectedWith?: string;
}

export const ALPHA: ChannelSeed = {
	channelId: channelIdOf("alpha"),
	title: "Alpha",
	handle: "@alpha",
	access: "tok-alpha",
	refresh: "ref-alpha",
};

export const BETA: ChannelSeed = {
	channelId: channelIdOf("beta"),
	title: "Beta Studio",
	handle: "@betastudio",
	access: "tok-beta",
	refresh: "ref-beta",
};

export function bearerOf(seed: ChannelSeed): string {
	return `Bearer ${seed.access}`;
}

export function channelRecord(seed: ChannelSeed): Record<string, unknown> {
	return {
		access: seed.access,
		refresh: seed.refresh,
		expires: seed.expires ?? Date.now() + SEEDED_LIFETIME_MS,
		clientId: "client",
		channelId: seed.channelId,
		title: seed.title,
		...(seed.handle ? { handle: seed.handle } : {}),
		connectedAt: "2026-11-01T00:00:00.000Z",
		connectedWith: seed.connectedWith ?? fingerprintOf(seed.refresh),
	};
}

export async function seedChannel(configDir: string, seed: ChannelSeed): Promise<void> {
	const directory = join(configDir, "channels");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, `${seed.channelId}.json`), JSON.stringify(channelRecord(seed)));
}
