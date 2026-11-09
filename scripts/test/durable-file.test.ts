import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	backupPathOf,
	DurableFileUnreadableError,
	parseJsonBytes,
	readDurableFile,
	readDurableFileSync,
	removeDurableFile,
	removeSecretFile,
	writeFileAtomic,
	writeFileAtomicSync,
	writeSecretFileAtomic,
} from "../../lib/durable-file.mjs";

const roots: string[] = [];
let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "shelf-durable-file-"));
	roots.push(dir);
	file = join(dir, "state.json");
	spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
	mock.restore();
});

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const JSON_BACKUP = { parse: parseJsonBytes };
const leftovers = (): string[] => readdirSync(dir).filter(name => name.endsWith(".tmp"));
const corruptCopies = (): string[] => readdirSync(dir).filter(name => name.startsWith("state.json.corrupt-"));

describe("writeFileAtomicSync", () => {
	test("writes the file into a folder that did not exist and leaves no staging file", () => {
		const nested = join(dir, "a", "b", "state.json");
		writeFileAtomicSync(nested, '{"n":1}');
		expect(readFileSync(nested, "utf8")).toBe('{"n":1}');
		expect(readdirSync(join(dir, "a", "b"))).toEqual(["state.json"]);
	});

	test("with backup, the previous whole file becomes the .bak", () => {
		writeFileAtomicSync(file, '{"n":1}', { backup: JSON_BACKUP });
		expect(fs.existsSync(backupPathOf(file))).toBe(false);
		writeFileAtomicSync(file, '{"n":2}', { backup: JSON_BACKUP });
		expect(readFileSync(file, "utf8")).toBe('{"n":2}');
		expect(readFileSync(backupPathOf(file), "utf8")).toBe('{"n":1}');
	});

	test("a damaged primary never replaces a good backup", () => {
		writeFileSync(backupPathOf(file), '{"n":1}');
		for (const damaged of ["{ torn", "", "\0\0\0\0"]) {
			writeFileSync(file, damaged);
			writeFileAtomicSync(file, '{"n":3}', { backup: JSON_BACKUP });
			expect(readFileSync(backupPathOf(file), "utf8")).toBe('{"n":1}');
		}
	});

	test("a previous file the backup parser rejects never replaces a good backup, even when it is whole JSON", () => {
		const listsOnly = {
			parse: (bytes: Buffer) => {
				const parsed = parseJsonBytes(bytes);
				if (!Array.isArray(parsed)) throw new Error("not a list");
				return parsed;
			},
		};
		writeFileSync(backupPathOf(file), "[1]");
		writeFileSync(file, '{"n":2}');
		writeFileAtomicSync(file, "[3]", { backup: listsOnly });
		expect(readFileSync(backupPathOf(file), "utf8")).toBe("[1]");
		writeFileAtomicSync(file, "[4]", { backup: listsOnly });
		expect(readFileSync(backupPathOf(file), "utf8")).toBe("[3]");
	});

	test("a write that fails before the rename leaves the old file and no staging file", () => {
		writeFileAtomicSync(file, '{"n":1}');
		const fsync = spyOn(fs, "fsyncSync").mockImplementation(() => {
			throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
		});
		try {
			expect(() => writeFileAtomicSync(file, '{"n":2}')).toThrow("EIO");
		} finally {
			fsync.mockRestore();
		}
		expect(readFileSync(file, "utf8")).toBe('{"n":1}');
		expect(leftovers()).toEqual([]);
	});

	test("a rename refused for a moment by another process holding the file is retried", () => {
		writeFileAtomicSync(file, '{"n":1}');
		const realRename = fs.renameSync;
		let refusals = 2;
		const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (refusals-- > 0) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
			realRename(from, to);
		});
		try {
			writeFileAtomicSync(file, '{"n":2}');
		} finally {
			rename.mockRestore();
		}
		expect(readFileSync(file, "utf8")).toBe('{"n":2}');
		expect(leftovers()).toEqual([]);
	});

	test.skipIf(process.platform === "win32")("keeps the replaced file's permissions unless a mode is given", () => {
		writeFileAtomicSync(file, '"a"', { mode: 0o600 });
		writeFileAtomicSync(file, '"b"');
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		writeFileAtomicSync(file, '"c"', { mode: 0o640, backup: JSON_BACKUP });
		expect(fs.statSync(file).mode & 0o777).toBe(0o640);
		expect(fs.statSync(backupPathOf(file)).mode & 0o777).toBe(0o600 & 0o640);
	});
});

describe("readDurableFileSync", () => {
	test("a missing file with no backup is absent", () => {
		expect(readDurableFileSync(file, parseJsonBytes)).toBeUndefined();
	});

	test("a whole primary is read from the primary", () => {
		writeFileAtomicSync(file, '{"n":1}');
		expect(readDurableFileSync(file, parseJsonBytes)).toEqual({ n: 1 });
	});

	test("a torn primary is kept as a .corrupt copy, left in place, and the backup answers", () => {
		writeFileSync(backupPathOf(file), '{"n":1}');
		writeFileSync(file, '{"n":2');
		expect(readDurableFileSync(file, parseJsonBytes)).toEqual({ n: 1 });
		expect(readFileSync(file, "utf8")).toBe('{"n":2');
		const [copy] = corruptCopies();
		expect(copy).toBeDefined();
		expect(readFileSync(join(dir, copy as string), "utf8")).toBe('{"n":2');
	});

	test("an empty or NUL-filled primary is never trusted, even when the parser would accept it", () => {
		writeFileSync(backupPathOf(file), "kept");
		for (const damaged of ["", "\0\0\0"]) {
			writeFileSync(file, damaged);
			expect(readDurableFileSync(file, bytes => bytes.toString("utf8"))).toBe("kept");
		}
	});

	test("a primary missing while its backup exists is read from the backup", () => {
		writeFileSync(backupPathOf(file), '{"n":1}');
		expect(readDurableFileSync(file, parseJsonBytes)).toEqual({ n: 1 });
	});

	test("unreadable with no readable backup throws, and nothing is rewritten", () => {
		writeFileSync(file, "{ torn");
		writeFileSync(backupPathOf(file), "{ also torn");
		let thrown: unknown;
		try {
			readDurableFileSync(file, parseJsonBytes);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(DurableFileUnreadableError);
		expect((thrown as DurableFileUnreadableError).filePath).toBe(file);
		expect((thrown as DurableFileUnreadableError).quarantinedAt).toBe(join(dir, corruptCopies()[0] as string));
		expect(readFileSync(file, "utf8")).toBe("{ torn");
		expect(readFileSync(backupPathOf(file), "utf8")).toBe("{ also torn");
	});

	test("a second read of the same damaged file keeps one copy, not one per read", () => {
		writeFileSync(file, "{ torn");
		writeFileSync(backupPathOf(file), '{"n":1}');
		readDurableFileSync(file, parseJsonBytes);
		readDurableFileSync(file, parseJsonBytes);
		expect(corruptCopies()).toHaveLength(1);
	});

	test("keepDamagedCopy: false reads from the backup without copying the damaged bytes anywhere", () => {
		writeFileSync(file, "{ torn");
		writeFileSync(backupPathOf(file), '{"n":1}');
		expect(readDurableFileSync(file, parseJsonBytes, { keepDamagedCopy: false })).toEqual({ n: 1 });
		expect(corruptCopies()).toEqual([]);
		expect(leftovers()).toEqual([]);
		expect(readFileSync(file, "utf8")).toBe("{ torn");
	});

	test("keepDamagedCopy: false refuses with no readable backup and names no copy", () => {
		writeFileSync(file, "{ torn");
		expect(() => readDurableFileSync(file, parseJsonBytes, { keepDamagedCopy: false })).toThrow(
			expect.objectContaining({ quarantinedAt: undefined }),
		);
		expect(corruptCopies()).toEqual([]);
	});
});

describe("the async twins", () => {
	test("writeFileAtomic keeps the backup and readDurableFile recovers from it", async () => {
		await writeFileAtomic(file, '{"n":1}', { backup: JSON_BACKUP });
		await writeFileAtomic(file, '{"n":2}', { backup: JSON_BACKUP });
		expect(readFileSync(backupPathOf(file), "utf8")).toBe('{"n":1}');
		writeFileSync(file, "");
		expect(await readDurableFile(file, parseJsonBytes)).toEqual({ n: 1 });
		expect(corruptCopies()).toHaveLength(1);
		expect(leftovers()).toEqual([]);
	});

	test("readDurableFile throws the same refusal with no readable backup", async () => {
		writeFileSync(file, "{ torn");
		await expect(readDurableFile(file, parseJsonBytes)).rejects.toBeInstanceOf(DurableFileUnreadableError);
		expect(readFileSync(file, "utf8")).toBe("{ torn");
	});

	test("readDurableFile with keepDamagedCopy: false copies nothing", async () => {
		writeFileSync(file, "{ torn");
		writeFileSync(backupPathOf(file), '{"n":1}');
		expect(await readDurableFile(file, parseJsonBytes, { keepDamagedCopy: false })).toEqual({ n: 1 });
		expect(corruptCopies()).toEqual([]);
	});

	test("removeDurableFile deletes the file and its backup, so a later read is absent rather than brought back", async () => {
		await writeFileAtomic(file, '{"n":1}', { backup: JSON_BACKUP });
		await writeFileAtomic(file, '{"n":2}', { backup: JSON_BACKUP });
		await removeDurableFile(file);
		expect(await readDurableFile(file, parseJsonBytes)).toBeUndefined();
	});
});

describe("secret files keep no second copy", () => {
	const plantOldCopies = (): void => {
		writeFileSync(backupPathOf(file), '{"token":"old"}');
		writeFileSync(`${file}.corrupt-k3x9`, '{"token":"old"}');
		writeFileSync(join(dir, "other.json.corrupt-k3x9"), "kept");
	};

	test("writeSecretFileAtomic publishes the file and deletes its backup and damaged copies, never a neighbour's", async () => {
		plantOldCopies();
		await writeSecretFileAtomic(file, '{"token":"new"}');
		expect(readFileSync(file, "utf8")).toBe('{"token":"new"}');
		expect(readdirSync(dir).sort()).toEqual(["other.json.corrupt-k3x9", "state.json"]);
	});

	test("removeSecretFile deletes the file, its backup and its damaged copies, so a later read is absent", async () => {
		await writeSecretFileAtomic(file, '{"token":"new"}');
		plantOldCopies();
		await removeSecretFile(file);
		expect(await readDurableFile(file, parseJsonBytes)).toBeUndefined();
		expect(readdirSync(dir)).toEqual(["other.json.corrupt-k3x9"]);
	});

	test("removeSecretFile on a folder that does not exist is a no-op", async () => {
		await removeSecretFile(join(dir, "missing", "state.json"));
		expect(readdirSync(dir)).toEqual([]);
	});
});
