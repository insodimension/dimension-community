import { lstatSync, readlinkSync, realpathSync, type Stats, statSync } from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { fail } from "./store.js";

export const MAX_FILE_PATH_CHARS = 4_096;
export const MAX_UPLOAD_PATHS = 16;
const MAX_LINK_HOPS = 32;
const NETWORK_OR_DEVICE_PATH = /^[\\/]{2}|^[\\/][?.]{1,2}[\\/]/;
const ROOTED_WITHOUT_DRIVE_OR_DRIVE_RELATIVE = /^[\\/]|^[A-Za-z]:(?![\\/])/;
const PATH_SEPARATORS = /[\\/]+/;

export function requireAbsolutePath(path: unknown, name: string): string {
	if (typeof path !== "string" || path.length === 0 || path.length > MAX_FILE_PATH_CHARS || !isAbsolute(path)) {
		fail("bad_action", `${name} must be an absolute path of at most ${MAX_FILE_PATH_CHARS} characters`);
	}
	if (NETWORK_OR_DEVICE_PATH.test(path)) fail("bad_action", `${name}: ${path} is a network or device path; only a file on this machine's own drives is uploaded`);
	return path;
}

export function requireLocalFile(path: string, name: string, protectedRoot: string): string {
	requireAbsolutePath(path, name);
	const refusal = linkOffMachine(path);
	if (refusal !== undefined) fail("bad_action", `${name}: ${path} ${refusal}; only a file on this machine's own drives is uploaded`);
	let real: string;
	let stats: Stats;
	try {
		real = realpathSync.native(path);
		stats = statSync(real);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") fail("bad_action", `${name}: ${path} does not exist`);
		fail("bad_action", `${name}: ${path} could not be read (${(error as Error).message})`);
	}
	if (NETWORK_OR_DEVICE_PATH.test(real)) fail("bad_action", `${name}: ${path} lives on a network share; only a file on this machine's own drives is uploaded`);
	if (!stats.isFile()) fail("bad_action", `${name}: ${path} is not a file`);
	const fromRoot = relative(realpathSync.native(protectedRoot), real);
	if (fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))) {
		fail("bad_action", `${name}: ${path} is the browser's own data (profiles, saved passwords), which is never uploaded`);
	}
	return real;
}

function segmentsBelowRoot(path: string): { root: string; segments: string[] } {
	const { root } = parse(path);
	return { root, segments: path.slice(root.length).split(PATH_SEPARATORS).filter((segment) => segment.length > 0) };
}

function linkTargetRefusal(target: string): string | undefined {
	if (NETWORK_OR_DEVICE_PATH.test(target)) return `links to ${target}, a network or device path`;
	if (process.platform === "win32" && ROOTED_WITHOUT_DRIVE_OR_DRIVE_RELATIVE.test(target)) return `links to ${target}, a path on no drive letter (an NT or rooted path)`;
	return undefined;
}

function linkOffMachine(path: string): string | undefined {
	let { root: walked, segments } = segmentsBelowRoot(resolve(path));
	let hops = 0;
	while (segments.length > 0) {
		const [segment, ...rest] = segments;
		const next = resolve(walked, segment);
		let stats: Stats;
		try {
			stats = lstatSync(next);
		} catch (error) {
			const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
			if (hops === 0) return missing ? undefined : `could not be checked: ${next} cannot be read (${(error as Error).message})`;
			if (missing) return `links to ${next}, which does not exist`;
			return `goes through ${next}, reached through a link, which cannot be read (${(error as Error).message}), so it is not followed`;
		}
		segments = rest;
		if (!stats.isSymbolicLink()) {
			walked = next;
			continue;
		}
		hops += 1;
		if (hops > MAX_LINK_HOPS) return `goes through more than ${MAX_LINK_HOPS} links`;
		let target: string;
		try {
			target = readlinkSync(next);
		} catch (error) {
			return `goes through ${next}, a link whose target cannot be read (${(error as Error).message}), so it is not followed`;
		}
		const refused = linkTargetRefusal(target);
		if (refused !== undefined) return refused;
		const landed = segmentsBelowRoot(resolve(walked, target));
		walked = landed.root;
		segments = [...landed.segments, ...segments];
	}
	return undefined;
}
