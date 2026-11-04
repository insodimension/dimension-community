import { createHash } from "node:crypto";
import { realpathSync, statSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { ActionNotDispatched, fail } from "./store.js";

export const MAX_FILE_PATH_CHARS = 4_096;
const EXTENSION_TOKEN = /^\.[a-z0-9]{1,16}$/;
const NETWORK_OR_DEVICE_PATH = /^[\\/]{2}|^[\\/][?.]{1,2}[\\/]/;
const HASH_CHUNK_BYTES = 1 << 20;

export interface FileStamp {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
}

export interface LocalFile {
	readonly path: string;
	readonly real: string;
	readonly size: number;
	readonly sha256: string;
	readonly stamp: FileStamp;
}

export interface FileIdentity {
	readonly path: string;
	readonly size: number;
	readonly sha256: string;
}

export function parseAccept(accept: unknown, where: string): string[] {
	if (typeof accept !== "string" || accept.trim().length === 0) fail("bad_recipe", `${where}.accept must be a comma-separated list of extensions such as ".mp4,.mov"`);
	const extensions = accept.split(",").map((token) => token.trim().toLowerCase());
	const invalid = extensions.find((token) => !EXTENSION_TOKEN.test(token));
	if (invalid !== undefined) fail("bad_recipe", `${where}.accept takes file extensions only (".mp4"), not ${JSON.stringify(invalid)}`);
	return extensions;
}

export function requireAbsolutePath(path: unknown, name: string, code: string): string {
	if (typeof path !== "string" || path.length === 0 || path.length > MAX_FILE_PATH_CHARS || !isAbsolute(path)) {
		fail(code, `${name} must be an absolute path of at most ${MAX_FILE_PATH_CHARS} characters`);
	}
	if (NETWORK_OR_DEVICE_PATH.test(path)) fail(code, `${name}: ${path} is a network or device path; only a file on this machine's own drives is uploaded`);
	return path;
}

function stampOf(stats: Stats): FileStamp {
	return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export function requireLocalFile(path: string, name: string, code: string, protectedRoot: string): { real: string; stamp: FileStamp } {
	requireAbsolutePath(path, name, code);
	let real: string;
	let stats: Stats;
	try {
		real = realpathSync.native(path);
		if (NETWORK_OR_DEVICE_PATH.test(real)) fail(code, `${name}: ${path} lives on a network share; only a file on this machine's own drives is uploaded`);
		stats = statSync(real);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(code, `${name}: ${path} does not exist`);
		throw error;
	}
	if (!stats.isFile()) fail(code, `${name}: ${path} is not a file`);
	const fromRoot = relative(realpathSync.native(protectedRoot), real);
	if (fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))) {
		fail(code, `${name}: ${path} is the browser's own data (profiles, saved passwords), which is never uploaded`);
	}
	return { real, stamp: stampOf(stats) };
}

export async function identifyLocalFile(path: string, name: string, code: string, protectedRoot: string): Promise<LocalFile> {
	const { real, stamp } = requireLocalFile(path, name, code, protectedRoot);
	const handle = await open(real, "r");
	try {
		const hash = createHash("sha256");
		const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
		for (;;) {
			const { bytesRead } = await handle.read(chunk, 0, HASH_CHUNK_BYTES, null);
			if (bytesRead === 0) break;
			hash.update(chunk.subarray(0, bytesRead));
		}
		const after = stampOf(await handle.stat());
		if (!sameStamp(stamp, after)) fail(code, `${name}: ${path} changed while it was being read; let whatever writes it finish, then publish again`);
		return { path, real, size: after.size, sha256: hash.digest("hex"), stamp: after };
	} finally {
		await handle.close();
	}
}

export function requireUnchanged(file: LocalFile, name: string): void {
	let now: FileStamp;
	try {
		now = stampOf(statSync(file.real));
	} catch (error) {
		throw new ActionNotDispatched("file_changed", `${name}: ${file.path} could not be read again before it was attached (${(error as Error).message}); nothing was attached`);
	}
	if (!sameStamp(file.stamp, now)) {
		throw new ActionNotDispatched("file_changed", `${name}: ${file.path} changed after it was approved; nothing was attached. Approve the new file on the board, then publish again`);
	}
}

export function identityOf(file: LocalFile): FileIdentity {
	return { path: file.path, size: file.size, sha256: file.sha256 };
}
