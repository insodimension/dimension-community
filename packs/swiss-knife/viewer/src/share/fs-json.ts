import type { z } from "zod";
import { DurableFileUnreadableError, parseJsonBytes, readDurableFile, writeFileAtomic, writeSecretFileAtomic } from "../../../../../lib/durable-file.mjs";

export class StoredFileError extends Error {
	override readonly name = "StoredFileError";
}

function storedJsonParser<S extends z.ZodType>(path: string, schema: S): (bytes: Buffer) => z.infer<S> {
	return bytes => {
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
	};
}

export interface StoredFileOptions {
	readonly holdsSecret?: boolean;
}

export async function readJsonFile<S extends z.ZodType>(path: string, schema: S, { holdsSecret = false }: StoredFileOptions = {}): Promise<z.infer<S> | undefined> {
	try {
		return await readDurableFile(path, storedJsonParser(path, schema), { keepDamagedCopy: !holdsSecret });
	} catch (error) {
		if (error instanceof DurableFileUnreadableError) throw new StoredFileError(error.message);
		throw error;
	}
}

export function writePrivateJsonFile<S extends z.ZodType>(path: string, schema: S, value: z.infer<S>, { holdsSecret = false }: StoredFileOptions = {}): Promise<void> {
	const text = `${JSON.stringify(value, null, "\t")}\n`;
	if (holdsSecret) return writeSecretFileAtomic(path, text, { mode: 0o600 });
	return writeFileAtomic(path, text, { mode: 0o600, backup: { parse: storedJsonParser(path, schema) } });
}
