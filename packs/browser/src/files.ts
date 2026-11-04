import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fail } from "./store.js";

export const MAX_FILE_PATH_CHARS = 4_096;
export const MAX_UPLOAD_PATHS = 16;
const EXTENSION_TOKEN = /^\.[a-z0-9]{1,16}$/;

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
	return path;
}

export function requireLocalFile(path: string, name: string, code: string, protectedRoot: string): void {
	let real: string;
	try {
		if (!statSync(path).isFile()) fail(code, `${name}: ${path} is not a file`);
		real = realpathSync.native(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") fail(code, `${name}: ${path} does not exist`);
		throw error;
	}
	const fromRoot = relative(realpathSync.native(protectedRoot), real);
	if (fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))) {
		fail(code, `${name}: ${path} is the browser's own data (profiles, saved passwords), which is never uploaded`);
	}
}
