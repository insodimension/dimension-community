import type { z } from "zod";
import { type DurableRead, DurableFileUnreadableError, parseJsonBytes, readDurableFile, writeFileAtomic } from "../../../../../lib/durable-file.mjs";

export class StoredFileError extends Error {
	override readonly name = "StoredFileError";
}

export async function readJsonFile<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S> | undefined> {
	let stored: DurableRead<z.infer<S>>;
	try {
		stored = await readDurableFile(path, bytes => {
			let parsed: unknown;
			try {
				parsed = parseJsonBytes(bytes);
			} catch {
				throw new StoredFileError(`${path} is not valid JSON`);
			}
			const checked = schema.safeParse(parsed);
			if (!checked.success) {
				const issue = checked.error.issues[0];
				throw new StoredFileError(`${path} is not valid: ${issue?.path.join(".") || "(root)"} ${issue?.message ?? ""}`.trim());
			}
			return checked.data;
		});
	} catch (error) {
		if (error instanceof DurableFileUnreadableError) throw new StoredFileError(error.message);
		throw error;
	}
	return stored.state === "ok" ? stored.value : undefined;
}

export function writePrivateJsonFile(path: string, value: unknown): Promise<void> {
	return writeFileAtomic(path, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600, backup: true });
}
