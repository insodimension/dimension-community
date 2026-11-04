import { existsSync, lstatSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { ActionNotDispatched, fail } from "./store.js";

export const MAX_FILE_PATH_CHARS = 4_096;
export const HASH_WORKER_BUNDLE = "file-hash-worker.mjs";
const EXTENSION_TOKEN = /^\.[a-z0-9]{1,16}$/;
const NETWORK_OR_DEVICE_PATH = /^[\\/]{2}|^[\\/][?.]{1,2}[\\/]/;
const MAX_LINK_HOPS = 32;
const PATH_SEPARATORS = /[\\/]+/;
const CHECKPOINT_INTERVAL_MS = 50;

export interface FileHashRequest {
	readonly real: string;
}

export type FileHashReply = { readonly sha256: string; readonly stamp: FileStamp } | { readonly error: string };

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

function segmentsBelowRoot(path: string): { root: string; segments: string[] } {
	const { root } = parse(path);
	return { root, segments: path.slice(root.length).split(PATH_SEPARATORS).filter((segment) => segment.length > 0) };
}

function refuseLinksOffMachine(path: string, name: string, code: string): void {
	let { root: walked, segments } = segmentsBelowRoot(resolve(path));
	let hops = 0;
	while (segments.length > 0) {
		const [segment, ...rest] = segments;
		const next = resolve(walked, segment);
		let stats: Stats;
		try {
			stats = lstatSync(next);
		} catch {
			return;
		}
		segments = rest;
		if (!stats.isSymbolicLink()) {
			walked = next;
			continue;
		}
		hops += 1;
		if (hops > MAX_LINK_HOPS) fail(code, `${name}: ${path} goes through more than ${MAX_LINK_HOPS} links`);
		let target: string;
		try {
			target = readlinkSync(next);
		} catch (error) {
			fail(code, `${name}: ${path} goes through ${next}, a link whose target cannot be read (${(error as Error).message}), so it is not followed`);
		}
		if (NETWORK_OR_DEVICE_PATH.test(target)) fail(code, `${name}: ${path} links to ${target}, a network or device path; only a file on this machine's own drives is uploaded`);
		const landed = segmentsBelowRoot(resolve(walked, target));
		walked = landed.root;
		segments = [...landed.segments, ...segments];
	}
}

export function requireLocalFile(path: string, name: string, code: string, protectedRoot: string): { real: string; stamp: FileStamp } {
	requireAbsolutePath(path, name, code);
	refuseLinksOffMachine(path, name, code);
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

export async function identifyLocalFile(path: string, name: string, code: string, protectedRoot: string, checkpoint: () => void = () => undefined): Promise<LocalFile> {
	const { real, stamp } = requireLocalFile(path, name, code, protectedRoot);
	checkpoint();
	const hashed = await hashOffThread(real, checkpoint);
	if (!sameStamp(stamp, hashed.stamp)) fail(code, `${name}: ${path} changed while it was being read; let whatever writes it finish, then publish again`);
	return { path, real, size: hashed.stamp.size, sha256: hashed.sha256, stamp: hashed.stamp };
}

function hashWorkerEntry(): URL {
	const bundled = new URL(`./${HASH_WORKER_BUNDLE}`, import.meta.url);
	return existsSync(fileURLToPath(bundled)) ? bundled : new URL("./file-hash-worker.ts", import.meta.url);
}

function hashOffThread(real: string, checkpoint: () => void): Promise<{ sha256: string; stamp: FileStamp }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ sha256: string; stamp: FileStamp }>();
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
		if ("error" in reply) reject(new Error(reply.error));
		else resolve(reply);
	});
	worker.once("error", (error) => {
		clearInterval(poll);
		reject(error);
	});
	worker.once("exit", (exitCode) => {
		clearInterval(poll);
		reject(new Error(`the file-hash worker exited with code ${exitCode} before it answered`));
	});
	return promise;
}

export function requireUnchanged(file: LocalFile, name: string): void {
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
