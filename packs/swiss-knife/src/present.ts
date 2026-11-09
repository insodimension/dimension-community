// `present`: show the human a file (doc 86 §3.1, §4).
//
// The tool's whole job is to turn paths into a `Presentation` the thread draws
// as a card, and to say so in as few words as the model needs: one line per
// file in `content`, everything else in `details` (UI-only, never model context).
// Nothing here opens, annotates or reads a file's meaning; it resolves, refuses,
// classifies, and (for a picture) thumbnails.
//
// Bounds, because the model names the paths and the work happens before anyone
// has asked for it: at most `MAX_PRESENTED_ITEMS` paths are looked at; a file is
// read for its first `HEAD_BYTES`, and an image is read whole only up to
// `MAX_THUMB_SOURCE_BYTES`, one at a time; the thumbnails of a result share one
// `MAX_RESULT_THUMB_BYTES` budget. A path the tool refuses never costs a read.
//
// Accepted residual risks (decided 2026-10-01 after review). Each needs an agent
// that can already write to the filesystem, which is the power of the shell it has
// anyway, and each ends at a card or a thumbnail for the human, not at model context:
//   * Hardlinks. A hardlink is the secret's bytes under a harmless name and
//     `realpath` returns that name, so the name-based deny cannot see it.
//   * The existence oracle. A link to a MISSING target answers "no such file"; a
//     link to an existing protected target answers "protected location".
//   * The stat-to-open race. A path swapped for a link between `stat` and `open` is
//     opened as the link says; the check on the open handle re-asserts the TYPE only.

import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, realpath, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import {
	classifyFile,
	formatByteSize,
	MAX_PRESENTED_ITEMS,
	PRESENTED_KIND_LABELS,
	type Presentation,
	type PresentedItem,
	type PresentedSnapshot,
} from "@dimension/sdk/presentation";
import { denyReason, textRefusal as windowsSpellingRefusal } from "../viewer/src/fence";
import { imageFacts, MAX_THUMB_BYTES, MAX_THUMB_SOURCE_BYTES, type Thumbnail } from "./thumbnail";

/** Bytes of a file's start read to classify it. */
const HEAD_BYTES = 512;
/** Encoded thumbnail bytes one result may carry in all. */
const MAX_RESULT_THUMB_BYTES = 600 * 1024;
export const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;
export const MAX_RESULT_SNAPSHOT_BYTES = 100 * 1024 * 1024;
const SNAPSHOT_EXTENSION = /^[a-z0-9][a-z0-9._-]{0,31}$/;
/** Code points of a requested path, or of a file name, quoted back in the result. */
const MAX_ECHO = 200;
const SVG = "image/svg+xml";

/** One entry of `details.images`: the pixel lane every image-producing tool uses. */
export interface ThumbImage {
	readonly data: string;
	readonly mimeType: string;
}

/**
 * Why a requested path is refused on its text alone, before any filesystem call, or
 * `undefined`: nothing to look at, a NUL byte, or a Windows spelling the operating
 * system would act on (a device path, an alternate data stream, a network path;
 * resolving one would make it authenticate to a host the model chose). Relative
 * paths are fine here: the caller resolves them against the session's working directory.
 */
export function textRefusal(requested: string, platform: NodeJS.Platform): string | undefined {
	if (requested.trim() === "") return "the path is empty";
	if (requested.includes("\0")) return "the path contains a NUL byte";
	return windowsSpellingRefusal(requested, platform, "presentable");
}

export interface PresentDetails {
	readonly presentation: Presentation;
	readonly images?: readonly ThumbImage[];
}

export interface PresentResult {
	/** One line per item, and nothing else. Never pixels, never base64. */
	readonly text: string;
	readonly details: PresentDetails;
}

/** The call that opens a file for reading: `fs.promises.open`. */
export type OpenFile = (path: string, flags: number) => Promise<FileHandle>;
export type KeepSnapshot = (bytes: Buffer, extension: string) => Promise<PresentedSnapshot>;

export interface PresentOptions {
	/** The session's working directory: where a relative path is resolved. */
	readonly cwd: string;
	readonly signal?: AbortSignal;
	/** The platform whose path spellings are refused from text alone. Default: this one. A test seam. */
	readonly platform?: NodeJS.Platform;
	/** `fs.promises.open`: the call a test puts a swapped-in FIFO behind. A test seam. */
	readonly open?: OpenFile;
	readonly snapshot?: KeepSnapshot;
}

/** What one call of `presentPaths` shares across its paths. */
interface Run {
	readonly cwd: string;
	readonly platform: NodeJS.Platform;
	readonly open: OpenFile;
	/** Real paths already presented: a file named twice is one card. */
	readonly seen: Set<string>;
	readonly snapshot: KeepSnapshot | undefined;
}

type Refused = { readonly refused: string };
interface Presented {
	readonly item: PresentedItem;
	readonly thumb?: Thumbnail;
	readonly snapshotFailure?: string;
}

interface Budget {
	readonly thumbBytes: number;
	readonly snapshotBytes: number;
}

type SnapshotOutcome = { readonly snapshot?: PresentedSnapshot; readonly snapshotFailure?: string };

function snapshotExtension(fileName: string): string | undefined {
	const extension = extname(fileName).slice(1).toLowerCase();
	return SNAPSHOT_EXTENSION.test(extension) ? extension : undefined;
}

async function keepSnapshot(keep: KeepSnapshot, bytes: Buffer, fileName: string): Promise<SnapshotOutcome> {
	const extension = snapshotExtension(fileName);
	if (extension === undefined) return {};
	try {
		const snapshot = await keep(bytes, extension);
		return denyReason(snapshot.path, { allowBlobCopy: true }) === undefined ? { snapshot } : {};
	} catch (error) {
		return { snapshotFailure: error instanceof Error && error.message !== "" ? error.message : String(error) };
	}
}

/** C0 and C1 controls, line and paragraph separators, and the bidirectional overrides and isolates. */
const UNSAFE_IN_A_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * `text` on one line: anything a terminal, a line splitter or a bidi renderer
 * would act on (a file name may carry any of it) becomes a space, and the result
 * is cut to `max` code points, never inside a surrogate pair.
 */
export function oneLine(text: string, max: number): string {
	const flat = text.replace(UNSAFE_IN_A_LINE, " ");
	if (flat.length <= max) return flat; // fewer UTF-16 units than `max` is fewer code points
	let units = 0;
	let points = 0;
	for (const point of flat) {
		if (points === max) return `${flat.slice(0, units)}...`;
		units += point.length;
		points++;
	}
	return flat;
}

/**
 * Read-only, and on POSIX never blocking: opening a FIFO for reading waits for a
 * writer unless `O_NONBLOCK` is set, and a path swapped for one after `stat` would
 * park a thread-pool thread. It does nothing to a regular file. Windows has no such
 * flag (nor a FIFO in the filesystem namespace).
 */
export function readOnlyFlags(flags: { readonly O_RDONLY: number; readonly O_NONBLOCK?: number } = constants): number {
	return flags.O_RDONLY | (flags.O_NONBLOCK ?? 0);
}

/**
 * Why an entry is not a file this tool may read, or `undefined`. Only a regular
 * file passes: opening a FIFO would block on it and a device never ends.
 */
export function nonFileReason(info: Pick<Stats, "isDirectory" | "isFile">): string | undefined {
	if (info.isDirectory()) return "it is a directory, not a file";
	return info.isFile() ? undefined : "it is not a regular file";
}

function unresolvedReason(error: unknown): string {
	const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
	if (code === "ENOENT" || code === "ENOTDIR") return "no such file";
	if (code === "EACCES" || code === "EPERM") return "permission denied";
	return `it cannot be resolved${code ? ` (${code})` : ""}`;
}

/** Fill `size` bytes from the start of an open file; fewer if it shrank underneath us. */
async function readWhole(handle: FileHandle, size: number): Promise<Buffer> {
	const buffer = Buffer.allocUnsafe(size);
	let filled = 0;
	while (filled < size) {
		const { bytesRead } = await handle.read(buffer, filled, size - filled, filled);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	return buffer.subarray(0, filled);
}

/**
 * One requested path, to a presented item or a stated refusal. `undefined` when
 * an earlier path already resolved to the same file.
 */
async function presentOne(requested: unknown, run: Run, budget: Budget): Promise<Presented | Refused | undefined> {
	if (typeof requested !== "string") return { refused: "it is not a path" };
	const textual = textRefusal(requested, run.platform);
	if (textual !== undefined) return { refused: textual };

	// Deny before the disk: a secret path costs no filesystem call, so the answer
	// says nothing about whether it exists.
	const lexical = resolve(run.cwd, requested);
	const early = denyReason(lexical);
	if (early !== undefined) return { refused: early };

	let real: string;
	try {
		// The promise form, on purpose: under Bun on Windows it canonicalises 8.3 short names (`ENV~1` -> `.env`)
		// and case, so the deny on the real path sees what the name really is. `realpathSync` does not.
		real = await realpath(lexical);
	} catch (error) {
		return { refused: unresolvedReason(error) };
	}
	// A link into a secret is refused for what it resolves to, in words that do not
	// say what that is: the requested name was harmless and the target is not ours to describe.
	if (denyReason(real) !== undefined)
		return { refused: "it resolves to a protected location (credentials, keys or engine state)" };
	if (run.seen.has(real)) return undefined;

	// `stat` before `open`: opening a FIFO or a device would block on it.
	let info: Stats;
	try {
		info = await stat(real);
	} catch (error) {
		return { refused: unresolvedReason(error) };
	}
	const notFile = nonFileReason(info);
	if (notFile !== undefined) return { refused: notFile };

	let handle: FileHandle;
	try {
		handle = await run.open(real, readOnlyFlags());
	} catch (error) {
		return { refused: unresolvedReason(error) };
	}
	try {
		// What was opened is what is described: a swap between `stat` and `open` is caught here.
		const opened = await handle.stat();
		const swapped = nonFileReason(opened);
		if (swapped !== undefined) return { refused: swapped };
		const head = Buffer.allocUnsafe(Math.min(HEAD_BYTES, opened.size));
		const { bytesRead } = await handle.read(head, 0, head.length, 0);
		const fileName = basename(real);
		const { kind, mime } = classifyFile(fileName, head.subarray(0, bytesRead));
		run.seen.add(real);

		const name = oneLine(fileName, MAX_ECHO);
		const base: PresentedItem = { path: real, name, kind, mime, size: opened.size, mtimeMs: opened.mtimeMs };
		const keep = run.snapshot !== undefined && opened.size <= Math.min(MAX_SNAPSHOT_BYTES, budget.snapshotBytes) ? run.snapshot : undefined;
		const thumbnails = kind === "image" && mime !== SVG && opened.size <= MAX_THUMB_SOURCE_BYTES;
		if (keep === undefined && !thumbnails) return { item: base };
		const bytes = await readWhole(handle, opened.size);
		const kept: SnapshotOutcome = keep === undefined ? {} : await keepSnapshot(keep, bytes, fileName);
		const item = kept.snapshot === undefined ? base : { ...base, snapshot: kept.snapshot };
		const facts = thumbnails ? await imageFacts(bytes, Math.min(MAX_THUMB_BYTES, budget.thumbBytes)) : undefined;
		if (facts === undefined) return { item, snapshotFailure: kept.snapshotFailure };
		return { item: { ...item, width: facts.width, height: facts.height }, thumb: facts.thumb, snapshotFailure: kept.snapshotFailure };
	} finally {
		await handle.close();
	}
}

/**
 * Present `input` (a path or several). Every path is judged on its own: a
 * refusal is a line in the answer and the other paths still present. Throws only
 * when NOTHING could be presented, so the model sees a failed call, not a success
 * with an empty card.
 */
export async function presentPaths(input: string | readonly string[], options: PresentOptions): Promise<PresentResult> {
	const all = typeof input === "string" ? [input] : input;
	const requested = all.slice(0, MAX_PRESENTED_ITEMS);
	const lines: string[] = [];
	const items: PresentedItem[] = [];
	const images: ThumbImage[] = [];
	const run: Run = {
		cwd: options.cwd,
		platform: options.platform ?? process.platform,
		open: options.open ?? open,
		seen: new Set(),
		snapshot: options.snapshot,
	};
	let thumbBytes = 0;
	let snapshotBytes = 0;

	for (const path of requested) {
		options.signal?.throwIfAborted();
		const outcome = await presentOne(path, run, {
			thumbBytes: MAX_RESULT_THUMB_BYTES - thumbBytes,
			snapshotBytes: MAX_RESULT_SNAPSHOT_BYTES - snapshotBytes,
		});
		if (outcome === undefined) continue;
		if ("refused" in outcome) {
			const shown = oneLine(String(path), MAX_ECHO).trim() || "(empty path)";
			lines.push(`Could not present ${shown}: ${outcome.refused}.`);
			continue;
		}
		const { item, thumb, snapshotFailure } = outcome;
		if (item.snapshot !== undefined) snapshotBytes += item.size;
		if (thumb !== undefined) {
			thumbBytes += thumb.bytes;
			images.push({ data: thumb.data, mimeType: thumb.mimeType });
		}
		items.push(thumb === undefined ? item : { ...item, thumb: images.length - 1 });
		const presented = `Presented ${item.name} (${PRESENTED_KIND_LABELS[item.kind]}, ${formatByteSize(item.size)})`;
		lines.push(
			snapshotFailure === undefined
				? `${presented}.`
				: `${presented}; no copy was kept (${oneLine(snapshotFailure, MAX_ECHO)}), so its card opens the file as it is when clicked.`,
		);
	}
	if (all.length > requested.length) {
		lines.push(`Only the first ${requested.length} of ${all.length} paths were presented.`);
	}
	if (items.length === 0) throw new Error(lines.join("\n") || "Nothing to present: pass the path of a file.");

	return {
		text: lines.join("\n"),
		details: { presentation: { items }, ...(images.length > 0 ? { images } : {}) },
	};
}
