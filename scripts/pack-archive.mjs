import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "fflate";
import { packArchiveName } from "./shelf-release.mjs";
import { RELEASE_MAX_BYTES } from "./space-showcase.mjs";

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
const BLOB_HEADER_MAX = 160;

function git(root, args, options = {}) {
	const result = spawnSync("git", args, {
		cwd: root,
		input: options.input,
		env: options.env ? { ...process.env, ...options.env } : process.env,
		stdio: ["pipe", options.stdout ?? "pipe", "pipe"],
		maxBuffer: 2 * RELEASE_MAX_BYTES,
		windowsHide: true,
	});
	if (result.error) throw new Error(`the release build reads packs through git, and git could not run (${result.error.message})`);
	if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
	return result.stdout;
}

const zeroSeparated = buffer => buffer.toString("utf8").split("\0").filter(Boolean);

function packOf(path) {
	if (path.includes("\n")) throw new Error(`${JSON.stringify(path)} has a line break in its name`);
	const match = /^packs\/([^/]+)\/(.+)$/.exec(path);
	if (!match) throw new Error(`git listed ${path} outside packs/`);
	return { pack: match[1], rel: match[2] };
}

function shelfFiles(root, names) {
	const pathspecs = names.map(name => `packs/${name}/`);
	const dirty = new Set(zeroSeparated(git(root, ["diff-files", "--name-only", "-z", "--", ...pathspecs])));
	const files = [];
	for (const record of zeroSeparated(git(root, ["ls-files", "--stage", "-z", "--", ...pathspecs]))) {
		const tab = record.indexOf("\t");
		const [mode, id, stage] = record.slice(0, tab).split(" ");
		const path = record.slice(tab + 1);
		if (stage !== "0") throw new Error(`${path} has an unresolved merge conflict`);
		if (!FILE_MODES[mode]) {
			throw new Error(`${path} is ${mode === "120000" ? "a symlink" : mode === "160000" ? "a submodule" : `git mode ${mode}`}; a release build holds plain files only`);
		}
		if (!lstatSync(join(root, path), { throwIfNoEntry: false })) continue;
		files.push({ ...packOf(path), path, mode: FILE_MODES[mode], id: dirty.has(path) ? undefined : id });
	}
	for (const path of zeroSeparated(git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspecs]))) {
		if (path.endsWith("/")) throw new Error(`${path} is a nested git repository; a release build holds plain files only`);
		const stat = lstatSync(join(root, path));
		if (stat.isSymbolicLink()) throw new Error(`${path} is a symlink; a release build holds plain files only`);
		const executable = process.platform !== "win32" && (stat.mode & 0o100) !== 0;
		files.push({ ...packOf(path), path, mode: executable ? 0o755 : 0o644, id: undefined });
	}
	return files;
}

function hashChangedFiles(root, files, env) {
	const changed = files.filter(file => file.id === undefined);
	if (changed.length === 0) return;
	const ids = git(root, ["hash-object", "-w", "--stdin-paths"], { input: `${changed.map(file => file.path).join("\n")}\n`, env })
		.toString("latin1")
		.trim()
		.split("\n");
	if (ids.length !== changed.length) throw new Error(`git hashed ${ids.length} of ${changed.length} files`);
	changed.forEach((file, index) => {
		file.id = ids[index];
	});
}

function writeBlobBatch(root, ids, env, path) {
	const fd = openSync(path, "w");
	try {
		git(root, ["cat-file", "--batch"], { input: `${ids.join("\n")}\n`, env, stdout: fd });
	} finally {
		closeSync(fd);
	}
}

function readFully(fd, buffer, offset, length, position) {
	for (let done = 0; done < length; ) {
		const read = readSync(fd, buffer, offset + done, length - done, position + done);
		if (read === 0) throw new Error("git's blob batch ended early");
		done += read;
	}
}

function blobBatchReader(fd) {
	const header = Buffer.alloc(BLOB_HEADER_MAX);
	let cursor = 0;
	return id => {
		const read = readSync(fd, header, 0, BLOB_HEADER_MAX, cursor);
		const lineEnd = header.subarray(0, read).indexOf(0x0a);
		if (lineEnd === -1) throw new Error(`git returned no blob for ${id}`);
		const [gotId, type, size] = header.toString("latin1", 0, lineEnd).split(" ");
		if (gotId !== id || type !== "blob") throw new Error(`git returned ${gotId} ${type} for blob ${id}`);
		const at = cursor + lineEnd + 1;
		cursor = at + Number(size) + 1;
		return { at, size: Number(size) };
	};
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

function tarInto(scratch, entries, fd) {
	const planned = entries.map(entry => {
		const ustar = ustarPath(entry.path);
		return { ...entry, ustar, pax: ustar ? undefined : paxRecords(entry.path) };
	});
	let total = 2 * TAR_BLOCK;
	for (const entry of planned) {
		total += TAR_BLOCK + padded(entry.blob.size);
		if (entry.pax) total += TAR_BLOCK + padded(entry.pax.length);
	}
	const tar = scratch.length >= total ? scratch : Buffer.alloc(Math.max(total, 2 * scratch.length));
	tar.fill(0, 0, total);
	let offset = 0;
	for (const entry of planned) {
		if (entry.pax) {
			writeHeader(tar, offset, { name: Buffer.from("././@PaxHeader"), prefix: Buffer.alloc(0), mode: 0o644, size: entry.pax.length, type: "x" });
			entry.pax.copy(tar, offset + TAR_BLOCK);
			offset += TAR_BLOCK + padded(entry.pax.length);
		}
		const { name, prefix } = entry.ustar ?? { name: Buffer.from(entry.path, "utf8").subarray(0, TAR_NAME_MAX), prefix: Buffer.alloc(0) };
		writeHeader(tar, offset, { name, prefix, mode: entry.mode, size: entry.blob.size, type: "0" });
		readFully(fd, tar, offset + TAR_BLOCK, entry.blob.size, entry.blob.at);
		offset += TAR_BLOCK + padded(entry.blob.size);
	}
	return { tar, total };
}

function compressedArchive(name, tar) {
	const compressed = gzipSync(tar, GZIP_OPTIONS);
	const bytes = Buffer.from(compressed.buffer, compressed.byteOffset, compressed.byteLength);
	if (bytes.length > RELEASE_MAX_BYTES) {
		throw new Error(`packs/${name} builds to ${bytes.length} bytes, over the ${RELEASE_MAX_BYTES}-byte release cap`);
	}
	return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

const byRelativePath = (left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0);

export function buildPackArchives(root, names) {
	const byPack = new Map(names.map(name => [name, []]));
	const files = shelfFiles(root, names);
	for (const file of files) byPack.get(file.pack)?.push(file);
	for (const [name, packFiles] of byPack) {
		if (packFiles.length === 0) throw new Error(`packs/${name} holds no files git would commit`);
		packFiles.sort(byRelativePath);
	}
	const work = mkdtempSync(join(tmpdir(), "pack-archive-"));
	try {
		const objects = join(work, "objects");
		mkdirSync(objects);
		const repoObjects = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]).toString().trim();
		const env = { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: repoObjects };
		hashChangedFiles(root, files, env);
		const batchPath = join(work, "blobs");
		writeBlobBatch(root, [...byPack.values()].flat().map(file => file.id), env, batchPath);
		const fd = openSync(batchPath, "r");
		try {
			const nextBlob = blobBatchReader(fd);
			const archives = new Map();
			let scratch = Buffer.alloc(0);
			for (const [name, packFiles] of byPack) {
				const entries = packFiles.map(file => ({ path: `${name}/${file.rel}`, mode: file.mode, blob: nextBlob(file.id) }));
				const { tar, total } = tarInto(scratch, entries, fd);
				scratch = tar;
				archives.set(name, compressedArchive(name, tar.subarray(0, total)));
				Bun.gc(false);
			}
			return archives;
		} finally {
			closeSync(fd);
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
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
