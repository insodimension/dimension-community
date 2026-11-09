import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { removeDurableFile } from "../../../../../lib/durable-file.mjs";
import { hasCode } from "../../../src/library/errors";
import { readJsonFile, StoredFileError, writePrivateJsonFile } from "./fs-json";

const STATE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

const shareStateSchema = z.object({
	version: z.number().int().positive(),
	prefix: z.string().min(1),
	size: z.number().int().nonnegative(),
	mtimeMs: z.number(),
	createdAt: z.number().int().nonnegative(),
	manifest: z.string().min(1),
});
export type P2pShareState = z.infer<typeof shareStateSchema>;

const tunnelSchema = z.object({
	relay: z.string().min(1),
	tunnelId: z.string().min(1),
	token: z.string().min(1),
	baseUrl: z.string().min(1),
});
export type TunnelCredentials = z.infer<typeof tunnelSchema>;

export class P2pStore {
	readonly #dir: string;
	readonly #tunnelPath: string;

	constructor(home: string) {
		this.#dir = join(home, "artifacts", "p2p");
		this.#tunnelPath = join(home, "artifacts", "tunnel.json");
	}

	#sharePath(id: string): string {
		if (!STATE_ID_PATTERN.test(id)) throw new StoredFileError("a share id contains characters that cannot name a file");
		return join(this.#dir, `${id}.json`);
	}

	async readShare(id: string): Promise<P2pShareState | undefined> {
		try {
			return await readJsonFile(this.#sharePath(id), shareStateSchema);
		} catch (error) {
			if (error instanceof StoredFileError) return undefined;
			throw error;
		}
	}

	writeShare(id: string, state: P2pShareState): Promise<void> {
		return writePrivateJsonFile(this.#sharePath(id), shareStateSchema, state);
	}

	removeShare(id: string): Promise<void> {
		return removeDurableFile(this.#sharePath(id));
	}

	async shareIds(): Promise<readonly string[]> {
		try {
			return (await readdir(this.#dir)).filter(name => name.endsWith(".json")).map(name => name.slice(0, -".json".length));
		} catch (error) {
			if (hasCode(error, "ENOENT")) return [];
			throw error;
		}
	}

	async readTunnel(): Promise<TunnelCredentials | undefined> {
		try {
			return await readJsonFile(this.#tunnelPath, tunnelSchema);
		} catch (error) {
			if (error instanceof StoredFileError) return undefined;
			throw error;
		}
	}

	writeTunnel(credentials: TunnelCredentials): Promise<void> {
		return writePrivateJsonFile(this.#tunnelPath, tunnelSchema, credentials);
	}

	clearTunnel(): Promise<void> {
		return removeDurableFile(this.#tunnelPath);
	}
}
