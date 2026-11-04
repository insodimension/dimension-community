import { lstatSync, readlinkSync, type Stats } from "node:fs";
import { parse, resolve } from "node:path";

export const NETWORK_OR_DEVICE_PATH = /^[\\/]{2}|^[\\/][?.]{1,2}[\\/]/;
const ROOTED_WITHOUT_DRIVE_OR_DRIVE_RELATIVE = /^[\\/]|^[A-Za-z]:(?![\\/])/;
const PATH_SEPARATORS = /[\\/]+/;
export const MAX_LINK_HOPS = 32;

export interface FileStamp {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
}

export function stampOf(stats: Stats): FileStamp {
	return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

export function sameStamp(a: FileStamp, b: FileStamp): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
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

export function linkOffMachine(path: string): string | undefined {
	let { root: walked, segments } = segmentsBelowRoot(resolve(path));
	let hops = 0;
	while (segments.length > 0) {
		const [segment, ...rest] = segments;
		const next = resolve(walked, segment);
		let stats: Stats;
		try {
			stats = lstatSync(next);
		} catch (error) {
			if (hops === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			return `goes through ${next}, which cannot be checked without following a link (${(error as Error).message})`;
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
		const refusal = linkTargetRefusal(target);
		if (refusal !== undefined) return refusal;
		const landed = segmentsBelowRoot(resolve(walked, target));
		walked = landed.root;
		segments = [...landed.segments, ...segments];
	}
	return undefined;
}
