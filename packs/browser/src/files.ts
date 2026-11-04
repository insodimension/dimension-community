import { existsSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { type FileStamp, linkOffMachine, NETWORK_OR_DEVICE_PATH, sameStamp, stampOf } from "./local-path.js";
import { ActionNotDispatched, fail } from "./store.js";

export type { FileStamp } from "./local-path.js";

export const MAX_FILE_PATH_CHARS = 4_096;
export const HASH_WORKER_BUNDLE = "file-hash-worker.mjs";
const EXTENSION_TOKEN = /^\.[a-z0-9]{1,16}$/;
const CHECKPOINT_INTERVAL_MS = 50;

export interface FileHashRequest {
	readonly real: string;
}

export type FileHashReply = { readonly sha256: string; readonly stamp: FileStamp } | { readonly refused: string } | { readonly error: string };

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

function refuseUnreadable(error: unknown, path: string, name: string, code: string): never {
	if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(code, `${name}: ${path} does not exist`);
	fail(code, `${name}: ${path} could not be read (${(error as Error).message})`);
}

export function requireLocalFile(path: string, name: string, code: string, protectedRoot: string): { real: string; stamp: FileStamp } {
	requireAbsolutePath(path, name, code);
	const refusal = linkOffMachine(path);
	if (refusal !== undefined) fail(code, `${name}: ${path} ${refusal}; only a file on this machine's own drives is uploaded`);
	let real: string;
	let stats: Stats;
	let realRoot: string;
	try {
		real = realpathSync.native(path);
	} catch (error) {
		refuseUnreadable(error, path, name, code);
	}
	if (NETWORK_OR_DEVICE_PATH.test(real)) fail(code, `${name}: ${path} lives on a network share; only a file on this machine's own drives is uploaded`);
	try {
		stats = statSync(real);
	} catch (error) {
		refuseUnreadable(error, path, name, code);
	}
	if (!stats.isFile()) fail(code, `${name}: ${path} is not a file`);
	try {
		realRoot = realpathSync.native(protectedRoot);
	} catch (error) {
		fail(code, `${name}: ${path} could not be checked against the browser's own data (${(error as Error).message})`);
	}
	const fromRoot = relative(realRoot, real);
	if (fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))) {
		fail(code, `${name}: ${path} is the browser's own data (profiles, saved passwords), which is never uploaded`);
	}
	return { real, stamp: stampOf(stats) };
}

export async function identifyLocalFile(path: string, name: string, code: string, protectedRoot: string, checkpoint: () => void = () => undefined): Promise<LocalFile> {
	const { real, stamp } = requireLocalFile(path, name, code, protectedRoot);
	checkpoint();
	const hashed = await hashOffThread(real, checkpoint);
	if ("refused" in hashed) fail(code, `${name}: ${path} ${hashed.refused} by the time it was read; only a file on this machine's own drives is uploaded`);
	if ("error" in hashed) fail(code, `${name}: ${path} could not be read (${hashed.error})`);
	if (!sameStamp(stamp, hashed.stamp)) fail(code, `${name}: ${path} changed while it was being read; let whatever writes it finish, then publish again`);
	return { path, real, size: hashed.stamp.size, sha256: hashed.sha256, stamp: hashed.stamp };
}

function hashWorkerEntry(): URL {
	const bundled = new URL(`./${HASH_WORKER_BUNDLE}`, import.meta.url);
	return existsSync(fileURLToPath(bundled)) ? bundled : new URL("./file-hash-worker.ts", import.meta.url);
}

function hashOffThread(real: string, checkpoint: () => void): Promise<FileHashReply> {
	const { promise, resolve, reject } = Promise.withResolvers<FileHashReply>();
	const worker = new Worker(hashWorkerEntry(), { workerData: { real } satisfies FileHashRequest });
	const poll = setInterval(() => {
		try {
			checkpoint();
		} catch (error) {
			clearInterval(poll);
			reject(error);
			void worker.terminate();
		}
	}, CHECKPOINT_INTERVAL_MS);
	worker.once("message", (reply: FileHashReply) => {
		clearInterval(poll);
		resolve(reply);
	});
	worker.once("error", (error: Error) => {
		clearInterval(poll);
		resolve({ error: `the file-hash worker failed: ${error.message}` });
	});
	worker.once("exit", (exitCode) => {
		clearInterval(poll);
		resolve({ error: `the file-hash worker exited with code ${exitCode} before it answered` });
	});
	return promise;
}

export function requireUnchanged(file: LocalFile, name: string): void {
	const refusal = linkOffMachine(file.real);
	if (refusal !== undefined) throw new ActionNotDispatched("file_changed", `file_changed: ${name}: ${file.path} now ${refusal}; nothing was attached`);
	let now: FileStamp;
	try {
		now = stampOf(statSync(file.real));
	} catch (error) {
		throw new ActionNotDispatched("file_changed", `file_changed: ${name}: ${file.path} could not be read again before it was attached (${(error as Error).message}); nothing was attached`);
	}
	if (!sameStamp(file.stamp, now)) {
		throw new ActionNotDispatched("file_changed", `file_changed: ${name}: ${file.path} changed after it was approved; nothing was attached. Approve the new file on the board, then publish again`);
	}
}

export function identityOf(file: LocalFile): FileIdentity {
	return { path: file.path, size: file.size, sha256: file.sha256 };
}
