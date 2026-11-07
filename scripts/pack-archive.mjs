import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "fflate";
import { RELEASE_MAX_BYTES } from "./space-showcase.mjs";

export const SHELF_REPO = "insodimension/dimension-community";
export const SHELF_REPOSITORY = `https://github.com/${SHELF_REPO}`;

export const packReleaseTag = (name, version) => `${name}-v${version}`;
export const packArchiveName = (name, version) => `${name}-${version}.tgz`;
export const packReleaseUrl = (name, version) =>
	`${SHELF_REPOSITORY}/releases/download/${packReleaseTag(name, version)}/${packArchiveName(name, version)}`;

export function packDirectories(root) {
	const packsDir = join(root, "packs");
	if (!existsSync(packsDir)) return [];
	return readdirSync(packsDir)
		.filter(dir => statSync(join(packsDir, dir)).isDirectory() && existsSync(join(packsDir, dir, "package.json")))
		.sort();
}

const TAR_BLOCK = 512;
const TAR_NAME_MAX = 100;
const TAR_PREFIX_MAX = 155;
const FILE_MODES = { "100644": 0o644, "100755": 0o755 };
const GZIP_OPTIONS = { level: 9, mem: 12, mtime: 0 };

function git(root, args, options = {}) {
	const result = spawnSync("git", args, {
		cwd: root,
		input: options.input,
		env: options.env ? { ...process.env, ...options.env } : process.env,
		maxBuffer: 2 * RELEASE_MAX_BYTES,
		windowsHide: true,
	});
	if (result.error) throw new Error(`the release build reads packs through git, and git could not run (${result.error.message})`);
	if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
	return result.stdout;
}

const zeroSeparated = buffer => buffer.toString("utf8").split("\0").filter(Boolean);

function packOf(path) {
	const match = /^packs\/([^/]+)\/(.+)$/.exec(path);
	if (!match) throw new Error(`git listed ${path} outside packs/`);
	return { pack: match[1], rel: match[2] };
}

function shelfFiles(root, names) {
	const pathspecs = names.map(name => `packs/${name}/`);
	const files = [];
	for (const record of zeroSeparated(git(root, ["ls-files", "--stage", "-z", "--", ...pathspecs]))) {
		const tab = record.indexOf("\t");
		const [mode, , stage] = record.slice(0, tab).split(" ");
		const path = record.slice(tab + 1);
		if (stage !== "0") throw new Error(`${path} has an unresolved merge conflict`);
		if (!FILE_MODES[mode]) {
			throw new Error(`${path} is ${mode === "120000" ? "a symlink" : mode === "160000" ? "a submodule" : `git mode ${mode}`}; a release build holds plain files only`);
		}
		if (!lstatSync(join(root, path), { throwIfNoEntry: false })) continue;
		files.push({ path, mode: FILE_MODES[mode] });
	}
	for (const path of zeroSeparated(git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspecs]))) {
		if (path.endsWith("/")) throw new Error(`${path} is a nested git repository; a release build holds plain files only`);
		const stat = lstatSync(join(root, path));
		if (stat.isSymbolicLink()) throw new Error(`${path} is a symlink; a release build holds plain files only`);
		const executable = process.platform !== "win32" && (stat.mode & 0o100) !== 0;
		files.push({ path, mode: executable ? 0o755 : 0o644 });
	}
	for (const { path } of files) {
		if (path.includes("\n")) throw new Error(`${JSON.stringify(path)} has a line break in its name`);
	}
	return files;
}

function readNormalizedBlobs(root, paths) {
	if (paths.length === 0) return [];
	const objects = mkdtempSync(join(tmpdir(), "pack-archive-objects-"));
	try {
		const repoObjects = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]).toString().trim();
		const env = { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: repoObjects };
		const ids = git(root, ["hash-object", "-w", "--stdin-paths"], { input: `${paths.join("\n")}\n`, env })
			.toString("latin1")
			.trim()
			.split("\n");
		if (ids.length !== paths.length) throw new Error(`git hashed ${ids.length} of ${paths.length} files`);
		const batch = git(root, ["cat-file", "--batch"], { input: `${ids.join("\n")}\n`, env });
		const blobs = [];
		let cursor = 0;
		for (const id of ids) {
			const lineEnd = batch.indexOf(0x0a, cursor);
			const [gotId, type, size] = batch.toString("latin1", cursor, lineEnd).split(" ");
			if (gotId !== id || type !== "blob") throw new Error(`git returned ${gotId} ${type} for blob ${id}`);
			const start = lineEnd + 1;
			const end = start + Number(size);
			blobs.push(batch.subarray(start, end));
			cursor = end + 1;
		}
		return blobs;
	} finally {
		rmSync(objects, { recursive: true, force: true });
	}
}

function writeOctal(header, offset, width, value) {
	header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "latin1");
}

function ustarPath(path) {
	const bytes = Buffer.from(path, "utf8");
	if (bytes.length <= TAR_NAME_MAX) return { name: bytes, prefix: Buffer.alloc(0) };
	for (let split = bytes.indexOf(0x2f); split !== -1; split = bytes.indexOf(0x2f, split + 1)) {
		if (split > TAR_PREFIX_MAX) break;
		if (bytes.length - split - 1 <= TAR_NAME_MAX) return { name: bytes.subarray(split + 1), prefix: bytes.subarray(0, split) };
	}
	return undefined;
}

function paxRecords(path) {
	const body = ` path=${path}\n`;
	const bodyBytes = Buffer.byteLength(body, "utf8");
	let length = bodyBytes;
	while (String(length).length + bodyBytes !== length) length = String(length).length + bodyBytes;
	return Buffer.from(`${length}${body}`, "utf8");
}

function writeHeader(tar, offset, { name, prefix, mode, size, type }) {
	const header = tar.subarray(offset, offset + TAR_BLOCK);
	name.copy(header, 0);
	writeOctal(header, 100, 8, mode);
	writeOctal(header, 108, 8, 0);
	writeOctal(header, 116, 8, 0);
	writeOctal(header, 124, 12, size);
	writeOctal(header, 136, 12, 0);
	header.write("        ", 148, 8, "latin1");
	header.write(type, 156, 1, "latin1");
	header.write("ustar\0", 257, 6, "latin1");
	header.write("00", 263, 2, "latin1");
	prefix.copy(header, 345);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
}

const padded = size => Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

function tarOf(entries) {
	const planned = entries.map(entry => {
		const ustar = ustarPath(entry.path);
		return { ...entry, ustar, pax: ustar ? undefined : paxRecords(entry.path) };
	});
	let total = 2 * TAR_BLOCK;
	for (const entry of planned) {
		total += TAR_BLOCK + padded(entry.bytes.length);
		if (entry.pax) total += TAR_BLOCK + padded(entry.pax.length);
	}
	const tar = Buffer.alloc(total);
	let offset = 0;
	for (const entry of planned) {
		if (entry.pax) {
			writeHeader(tar, offset, { name: Buffer.from("././@PaxHeader"), prefix: Buffer.alloc(0), mode: 0o644, size: entry.pax.length, type: "x" });
			entry.pax.copy(tar, offset + TAR_BLOCK);
			offset += TAR_BLOCK + padded(entry.pax.length);
		}
		const { name, prefix } = entry.ustar ?? { name: Buffer.from(entry.path, "utf8").subarray(0, TAR_NAME_MAX), prefix: Buffer.alloc(0) };
		writeHeader(tar, offset, { name, prefix, mode: entry.mode, size: entry.bytes.length, type: "0" });
		entry.bytes.copy(tar, offset + TAR_BLOCK);
		offset += TAR_BLOCK + padded(entry.bytes.length);
	}
	return tar;
}

export function buildPackArchives(root, names) {
	const files = shelfFiles(root, names);
	const blobs = readNormalizedBlobs(root, files.map(file => file.path));
	const byPack = new Map(names.map(name => [name, []]));
	files.forEach((file, index) => {
		const { pack, rel } = packOf(file.path);
		byPack.get(pack)?.push({ path: `${pack}/${rel}`, mode: file.mode, bytes: blobs[index] });
	});
	const archives = new Map();
	for (const [name, entries] of byPack) {
		if (entries.length === 0) throw new Error(`packs/${name} holds no files git would commit`);
		entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
		const compressed = gzipSync(tarOf(entries), GZIP_OPTIONS);
		const bytes = Buffer.from(compressed.buffer, compressed.byteOffset, compressed.byteLength);
		if (bytes.length > RELEASE_MAX_BYTES) {
			throw new Error(`packs/${name} builds to ${bytes.length} bytes, over the ${RELEASE_MAX_BYTES}-byte release cap`);
		}
		archives.set(name, { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
	}
	return archives;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [outDir, ...requested] = process.argv.slice(2);
	if (!outDir) {
		console.error("usage: bun scripts/pack-archive.mjs <out-dir> [pack ...]");
		process.exit(2);
	}
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const versionOf = name => JSON.parse(readFileSync(join(root, "packs", name, "package.json"), "utf8")).version;
	const names = requested.length > 0 ? requested : packDirectories(root);
	mkdirSync(outDir, { recursive: true });
	for (const [name, archive] of buildPackArchives(root, names)) {
		const file = packArchiveName(name, versionOf(name));
		writeFileSync(join(outDir, file), archive.bytes);
		console.log(`${archive.sha256}  ${String(archive.size).padStart(9)}  ${file}`);
	}
}
