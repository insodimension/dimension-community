// Shared fixtures for the swiss-knife tests: temp dirs, synthetic images, and the
// fake `pi` the extension factory is loaded with. Not a test file.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import * as zod from "@oh-my-pi/omptype/zod";
import type { BlobRef, PresentedItem } from "@dimension/sdk/presentation";
import type { Library } from "../src/library/types";

/** A fresh temp directory, already `realpath`ed (Windows hands out 8.3 short names). */
export async function makeTempDir(): Promise<string> {
	return realpath(await mkdtemp(join(tmpdir(), "swiss-knife-")));
}

export async function removeTree(path: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rm(path, { recursive: true, force: true });
			return;
		} catch (error) {
			const busy = error instanceof Error && "code" in error && (error.code === "EBUSY" || error.code === "EPERM");
			if (!busy || attempt >= 30) throw error;
			await new Promise<void>(resolve => setTimeout(resolve, 100));
		}
	}
}

/** A 1x1 PNG: the smallest valid image, and the seed the synthetic ones are scaled from. */
export const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

/** A flat-colour PNG of the given size: huge in pixels, tiny in bytes. */
export async function flatPng(width: number, height: number): Promise<Uint8Array> {
	return new Bun.Image(TINY_PNG).resize(width, height).png().bytes();
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
	const out = Buffer.alloc(12 + data.length);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "ascii");
	out.set(data, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

/**
 * A PNG of seeded random pixels: incompressible, so it stands in for a photograph
 * (its PNG and even its JPEG are big). Deterministic per `seed`. Stored (level 0)
 * deflate blocks: noise does not compress, and this is the fastest valid encoding.
 */
export function noisePng(width: number, height: number, seed: number, alpha = false): Buffer {
	const channels = alpha ? 4 : 3;
	const stride = 1 + width * channels;
	const raw = Buffer.alloc(stride * height);
	let state = (Math.imul(seed + 1, 2654435761) >>> 0) || 1;
	for (let y = 0; y < height; y++) {
		// Filter byte 0 (None) at the start of each row, then the pixels.
		for (let i = 1; i < stride; i++) {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			state >>>= 0;
			raw[y * stride + i] = (state >>> 8) & 0xff;
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bit depth
	header[9] = alpha ? 6 : 2; // RGBA / RGB
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw, { level: 0 })),
		pngChunk("IEND", new Uint8Array(0)),
	]);
}

/**
 * A valid all-black 1-bit PNG of any pixel size: a canvas of millions of pixels in a
 * few KB on disk, for the decode-cost bounds (no pixel data is ever materialised here).
 */
export function blankPng(width: number, height: number): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 1; // bit depth
	header[9] = 0; // greyscale
	const raw = Buffer.alloc((1 + Math.ceil(width / 8)) * height);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw, { level: 1 })),
		pngChunk("IEND", new Uint8Array(0)),
	]);
}

/** A valid 2x2 24-bit BMP: a format Bun decodes but `classifyFile` has no magic for. */
export function tinyBmp(): Buffer {
	const rowSize = 8; // 2 pixels * 3 bytes, padded to 4
	const bmp = Buffer.alloc(54 + rowSize * 2);
	bmp.write("BM", 0, "ascii");
	bmp.writeUInt32LE(bmp.length, 2);
	bmp.writeUInt32LE(54, 10); // pixel data offset
	bmp.writeUInt32LE(40, 14); // BITMAPINFOHEADER size
	bmp.writeInt32LE(2, 18);
	bmp.writeInt32LE(2, 22);
	bmp.writeUInt16LE(1, 26); // planes
	bmp.writeUInt16LE(24, 28); // bits per pixel
	bmp.writeUInt32LE(rowSize * 2, 34);
	return bmp;
}

/**
 * A 300x100 JPEG whose EXIF Orientation is 6 (rotate 90 degrees clockwise to display):
 * as displayed it is 100 wide and 300 tall.
 */
export async function orientedJpeg(): Promise<Buffer> {
	const plain = Buffer.from(await new Bun.Image(TINY_PNG).resize(300, 100).jpeg({ quality: 80 }).bytes());
	const exif = Buffer.from([
		...Buffer.from("Exif\0\0", "latin1"),
		0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF header, first IFD at 8
		0x00, 0x01, // one entry
		0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, // Orientation, SHORT, 1 value: 6
		0x00, 0x00, 0x00, 0x00, // no next IFD
	]);
	const segment = Buffer.alloc(4);
	segment.writeUInt16BE(0xffe1, 0);
	segment.writeUInt16BE(exif.length + 2, 2);
	// SOI, then the APP1 segment, then the rest of the file.
	return Buffer.concat([plain.subarray(0, 2), segment, exif, plain.subarray(2)]);
}

/** Decoded size of a base64 image, as Bun reads it. */
export async function decodeThumb(data: string): Promise<{ width: number; height: number; bytes: number }> {
	const bytes = Buffer.from(data, "base64");
	const { width, height } = await new Bun.Image(bytes).metadata();
	return { width, height, bytes: bytes.length };
}

// ---- the extension factory, loaded the way the host loads it -------------------------

export interface FakePi {
	readonly zod: typeof zod;
	registerTool(definition: unknown): void;
}

export interface WireIssue {
	readonly success: boolean;
}

export interface ToolContent {
	readonly type: string;
	readonly text?: string;
}

export interface ToolResult {
	readonly content: readonly ToolContent[];
	readonly details: {
		readonly presentation: { readonly items: readonly PresentedItem[] };
		readonly images?: readonly { readonly data: string; readonly mimeType: string }[];
	};
}

export interface PutBlobOptions {
	readonly extension?: string;
}

export interface PutBlobResult {
	readonly hash: string;
	readonly path: string;
	readonly displayPath: string;
	readonly ref: BlobRef;
}

export interface StoredBlob extends PutBlobResult {
	readonly bytes: Buffer;
	readonly extension: string | undefined;
}

export interface FakeBlobStore {
	readonly stored: readonly StoredBlob[];
	putBlob(data: Buffer, options?: PutBlobOptions): Promise<PutBlobResult>;
}

export function fakeBlobStore(directory = join(tmpdir(), "engine", "agent", "blobs")): FakeBlobStore {
	const stored: StoredBlob[] = [];
	return {
		stored,
		async putBlob(data, options) {
			const bytes = Buffer.from(data);
			const hash = createHash("sha256").update(bytes).digest("hex");
			const extension = options?.extension;
			const path = join(directory, hash);
			const result: PutBlobResult = {
				hash,
				path,
				displayPath: extension === undefined ? path : `${path}.${extension}`,
				ref: `blob:sha256:${hash}`,
			};
			stored.push({ ...result, bytes, extension });
			return result;
		},
	};
}

export interface ToolContext {
	readonly cwd: string;
	readonly sessionManager: { getSessionId(): string; putBlob: FakeBlobStore["putBlob"] };
}

export interface ExtensionDeps {
	readonly library: () => Promise<Library>;
}

export function toolContext(cwd: string, blobs: FakeBlobStore = fakeBlobStore()): ToolContext {
	return { cwd, sessionManager: { getSessionId: () => "session-under-test", putBlob: (data, options) => blobs.putBlob(data, options) } };
}

export interface RegisteredTool {
	readonly name: string;
	readonly description: string;
	readonly approval?: string | ((args: unknown) => string);
	readonly parameters: { safeParse(value: unknown): WireIssue };
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ToolContext,
	): Promise<ToolResult>;
}

function isRegisteredTool(value: unknown): value is RegisteredTool {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		typeof value.name === "string" &&
		"execute" in value &&
		typeof value.execute === "function" &&
		"parameters" in value &&
		typeof value.parameters === "function"
	);
}

/**
 * Import the extension at `entry` (an absolute path) and run its default export
 * against a fake `pi`, returning what it registered. `entry` is a `.ts` source or
 * the shipped `.mjs` bundle: the same factory contract either way.
 */
export async function loadTools(entry: string, deps?: ExtensionDeps): Promise<{ tools: RegisteredTool[]; raw: unknown[] }> {
	const mod: unknown = await import(pathToFileURL(entry).href);
	if (typeof mod !== "object" || mod === null || !("default" in mod) || typeof mod.default !== "function") {
		throw new Error(`${entry} has no default-exported extension factory`);
	}
	const factory: (pi: FakePi, deps?: ExtensionDeps) => void = mod.default as (pi: FakePi, deps?: ExtensionDeps) => void;
	const raw: unknown[] = [];
	factory({ zod, registerTool: definition => raw.push(definition) }, deps);
	return { tools: raw.filter(isRegisteredTool), raw };
}

const GIT_FLAGS = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always"];
const execFileAsync = promisify(execFile);

function isolatedGitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!/^GIT_/i.test(key)) env[key] = value;
	}
	return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", [...GIT_FLAGS, ...args], { cwd, env: isolatedGitEnv() });
	return stdout.trim();
}

export async function initRepo(dir: string, files: Readonly<Record<string, string | Uint8Array>>): Promise<string> {
	await mkdir(dir, { recursive: true });
	await git(dir, "init", "-q", "-b", "main");
	for (const [name, content] of Object.entries(files)) {
		const file = join(dir, name);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, content);
	}
	await git(dir, "add", "-A");
	await git(dir, "commit", "-q", "--allow-empty", "-m", "seed");
	return dir;
}

export async function addWorktree(repo: string, dir: string): Promise<string> {
	await mkdir(dirname(dir), { recursive: true });
	await git(repo, "worktree", "add", "-q", "--detach", dir);
	return dir;
}

export async function worktreeGitDir(worktree: string): Promise<string> {
	return resolve(await git(worktree, "rev-parse", "--absolute-git-dir"));
}

export async function registerProjects(file: string, paths: readonly string[]): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify({ projects: paths.map(path => ({ path })) }));
}

export interface WorktreeOwnerRecord {
	readonly root: string;
	readonly origin: string;
	readonly mapsSubpaths: boolean;
}

function ledgerKey(root: string): string {
	const flat = resolve(root).replaceAll("\\", "/").replace(/\/+$/, "");
	return process.platform === "win32" || process.platform === "darwin" ? flat.toLowerCase() : flat;
}

export async function recordWorktreeOwner(home: string, owner: WorktreeOwnerRecord): Promise<void> {
	await mkdir(home, { recursive: true });
	await writeFile(join(home, "worktree-owners.json"), JSON.stringify({ version: 1, owners: { [ledgerKey(owner.root)]: owner } }));
}
