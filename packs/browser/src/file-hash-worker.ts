import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import type { FileHashReply, FileHashRequest } from "./files.js";
import { linkOffMachine, stampOf } from "./local-path.js";

const HASH_CHUNK_BYTES = 1 << 20;

async function hashFile({ real }: FileHashRequest): Promise<FileHashReply> {
	const refused = linkOffMachine(real);
	if (refused !== undefined) return { refused };
	const handle = await open(real, "r");
	try {
		const hash = createHash("sha256");
		const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
		for (;;) {
			const { bytesRead } = await handle.read(chunk, 0, HASH_CHUNK_BYTES, null);
			if (bytesRead === 0) break;
			hash.update(chunk.subarray(0, bytesRead));
		}
		return { sha256: hash.digest("hex"), stamp: stampOf(await handle.stat()) };
	} finally {
		await handle.close();
	}
}

hashFile(workerData as FileHashRequest).then(
	(reply) => parentPort?.postMessage(reply),
	(error: unknown) => parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies FileHashReply),
);
