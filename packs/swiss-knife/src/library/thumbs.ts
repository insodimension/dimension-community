import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../../../../lib/durable-file.mjs";
import { MAX_THUMB_BYTES } from "../thumbnail";
import { hasCode, LibraryError } from "./errors";
import type { ThumbMime } from "./types";

const EXTENSIONS: Record<ThumbMime, string> = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg" };
export const THUMB_CONTENT_TYPES: Record<string, ThumbMime> = { webp: "image/webp", png: "image/png", jpg: "image/jpeg" };
export const THUMB_FILE_NAME = /^[A-Za-z0-9]{8,40}\.(webp|png|jpg)$/;

function matchesMime(bytes: Uint8Array, mime: ThumbMime): boolean {
	if (mime === "image/png") return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
	if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	return Buffer.from(bytes.subarray(0, 4)).toString("latin1") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP";
}

export async function writeThumb(directory: string, id: string, bytes: Uint8Array, mime: ThumbMime): Promise<string> {
	if (bytes.length === 0 || bytes.length > MAX_THUMB_BYTES) {
		throw new LibraryError(`a thumbnail is 1 byte to ${MAX_THUMB_BYTES} bytes; this one is ${bytes.length}`);
	}
	if (!matchesMime(bytes, mime)) throw new LibraryError(`the thumbnail bytes are not ${mime}`);
	const name = `${id}.${EXTENSIONS[mime]}`;
	await writeFileAtomic(join(directory, name), bytes);
	await removeThumbs(directory, id, name);
	return name;
}

export async function removeThumbs(directory: string, id: string, keep?: string): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(directory);
	} catch (error) {
		if (hasCode(error, "ENOENT")) return;
		throw error;
	}
	const own = entries.filter(entry => entry !== keep && entry.startsWith(`${id}.`));
	await Promise.all(own.map(entry => rm(join(directory, entry), { force: true })));
}
