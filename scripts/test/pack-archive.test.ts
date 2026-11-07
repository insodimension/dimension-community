import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { buildPackArchives } from "../pack-archive.mjs";
import { git, initGitShelf, SHELF_SCRIPTS } from "./git-shelf";

setDefaultTimeout(30_000);

const scriptsDir = resolve(import.meta.dir, "..");
const shelves: string[] = [];

afterAll(() => {
	for (const shelf of shelves) rmSync(shelf, { recursive: true, force: true });
});

const LONG_DIR_PATH = `assets/${"a".repeat(60)}/${"b".repeat(60)}.txt`;
const LONG_NAME_PATH = `assets/${"c".repeat(120)}.txt`;
const BINARY = Uint8Array.from([0x00, 0x0d, 0x0a, 0xff, 0x0d, 0x0a, 0x00]);

function writeFile(root: string, path: string, bytes: string | Uint8Array) {
	const file = join(root, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, bytes);
}

function makeShelf(): string {
	const root = mkdtempSync(join(tmpdir(), "pack-archive-"));
	shelves.push(root);
	initGitShelf(root);
	for (const file of SHELF_SCRIPTS) cpSync(join(scriptsDir, file), join(root, "scripts", file));
	writeFile(root, ".gitattributes", "* text=auto eol=lf\n");
	writeFile(root, ".gitignore", "node_modules/\n");
	writeFile(root, ".dimension-plugin/marketplace.json", JSON.stringify({ name: "test-shelf", owner: { name: "Tests" }, plugins: [] }));
	writeFile(root, "packs/demo/package.json", JSON.stringify({ name: "demo", version: "1.0.0", description: "A demo pack for the archive tests." }));
	writeFile(root, "packs/demo/bin/run.sh", "#!/bin/sh\necho demo\n");
	writeFile(root, `packs/demo/${LONG_DIR_PATH}`, "deep");
	writeFile(root, `packs/demo/${LONG_NAME_PATH}`, "long");
	writeFile(root, "packs/demo/assets/blob.bin", BINARY);
	git(root, "add", ".");
	git(root, "update-index", "--chmod=+x", "packs/demo/bin/run.sh");
	writeFile(root, "packs/demo/notes.md", "line one\r\nline two\r\n");
	writeFile(root, "packs/demo/node_modules/dep/index.js", "module.exports = 1;\n");
	return root;
}

type TarEntry = { path: string; mode: number; bytes: Uint8Array };

function readTar(tgz: Uint8Array): TarEntry[] {
	const tar = gunzipSync(tgz);
	const text = (from: number, length: number) => tar.toString("utf8", from, from + length).replace(/\0.*$/s, "");
	const entries: TarEntry[] = [];
	let paxPath: string | undefined;
	for (let offset = 0; offset + 512 <= tar.length; ) {
		if (tar.subarray(offset, offset + 512).every(byte => byte === 0)) break;
		const size = Number.parseInt(text(offset + 124, 12), 8);
		const type = String.fromCharCode(tar[offset + 156]);
		const body = tar.subarray(offset + 512, offset + 512 + size);
		if (type === "x") paxPath = /\d+ path=(.*)\n/.exec(body.toString("utf8"))?.[1];
		else {
			const prefix = text(offset + 345, 155);
			const name = text(offset, 100);
			entries.push({ path: paxPath ?? (prefix ? `${prefix}/${name}` : name), mode: Number.parseInt(text(offset + 100, 8), 8), bytes: body });
			paxPath = undefined;
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return entries;
}

describe("a pack's release build", () => {
	test("holds exactly what git would commit, under one top directory, and rebuilds to the same bytes after every mtime changes", () => {
		const root = makeShelf();
		const first = buildPackArchives(root, ["demo"]).get("demo");
		const later = new Date("2031-01-02T03:04:05Z");
		for (const path of ["package.json", "bin/run.sh", "notes.md", LONG_DIR_PATH, LONG_NAME_PATH, "assets/blob.bin"]) {
			utimesSync(join(root, "packs/demo", path), later, later);
		}
		const second = buildPackArchives(root, ["demo"]).get("demo");

		expect(second?.sha256).toBe(first?.sha256 as string);
		expect(Buffer.compare(second?.bytes as Buffer, first?.bytes as Buffer)).toBe(0);
		expect([...(first?.bytes as Buffer).subarray(4, 10)]).toEqual([0, 0, 0, 0, 2, 3]);
		const entries = readTar(first?.bytes as Buffer);
		expect(entries.map(entry => [entry.path, entry.mode])).toEqual([
			[`demo/${LONG_DIR_PATH}`, 0o644],
			["demo/assets/blob.bin", 0o644],
			[`demo/${LONG_NAME_PATH}`, 0o644],
			["demo/bin/run.sh", 0o755],
			["demo/notes.md", 0o644],
			["demo/package.json", 0o644],
		]);
		const bytesOf = (path: string) => Buffer.from(entries.find(entry => entry.path === `demo/${path}`)?.bytes ?? []);
		expect(bytesOf("notes.md").toString()).toBe("line one\nline two\n");
		expect([...bytesOf("assets/blob.bin")]).toEqual([...BINARY]);
		expect(bytesOf("package.json").equals(readFileSync(join(root, "packs/demo/package.json")))).toBeTrue();
	});

	test("a pack file changed after the catalog was built fails the drift check until the catalog is rebuilt", () => {
		const root = makeShelf();
		const run = (...args: string[]) => spawnSync(process.execPath, [join(root, "scripts", "build-index.ts"), ...args], { cwd: root, encoding: "utf8" });
		expect(run().status).toBe(0);
		writeFile(root, "packs/demo/notes.md", "line one\nline two changed\n");

		const stale = run("--check");
		expect(stale.status).toBe(1);
		expect(`${stale.stdout}${stale.stderr}`).toContain('"sha256"');
		expect(run().status).toBe(0);
		expect(run("--check").status).toBe(0);
	});

	test("a pack deleted from the shelf loses its entry on regeneration, while an external release listing stays", () => {
		const root = makeShelf();
		const run = () => spawnSync(process.execPath, [join(root, "scripts", "build-index.ts")], { cwd: root, encoding: "utf8" });
		const catalogPath = join(root, ".dimension-plugin/marketplace.json");
		const names = () => {
			const listed: { plugins: { name: string }[] } = JSON.parse(readFileSync(catalogPath, "utf8"));
			return listed.plugins.map(plugin => plugin.name);
		};
		writeFile(root, "packs/doomed/package.json", JSON.stringify({ name: "doomed", version: "1.0.0", description: "A pack that is about to be deleted." }));
		expect(run().status).toBe(0);
		const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
		catalog.plugins.push({
			name: "lantern",
			version: "0.2.0",
			description: "A space built in its maker's own repository.",
			license: "MIT",
			source: { source: "release", url: "https://get.example.com/lantern-0.2.0.tgz", sha256: "a".repeat(64), size: 4096 },
		});
		writeFileSync(catalogPath, JSON.stringify(catalog));

		rmSync(join(root, "packs/doomed"), { recursive: true, force: true });
		expect(run().status).toBe(0);
		expect(names()).toEqual(["demo", "lantern"]);
	});
});

type CatalogEntry = { name: string; source: unknown; release?: { source: string; url: string; sha256: string; size: number } };

describe("the validator on a shelf of release builds", () => {
	function shelfWithEditedDemo(edit: (demo: CatalogEntry) => void) {
		const root = makeShelf();
		expect(spawnSync(process.execPath, [join(root, "scripts", "build-index.ts")], { cwd: root, encoding: "utf8" }).status).toBe(0);
		const catalog: { plugins: CatalogEntry[] } = JSON.parse(readFileSync(join(root, ".dimension-plugin/marketplace.json"), "utf8"));
		const demo = catalog.plugins.find(plugin => plugin.name === "demo");
		if (!demo) throw new Error("the built catalog lists no demo pack");
		edit(demo);
		for (const path of [".dimension-plugin/marketplace.json", ".omp-plugin/marketplace.json"]) writeFile(root, path, JSON.stringify(catalog));
		const result = spawnSync(process.execPath, [join(root, "scripts", "validate-marketplace.mjs")], { cwd: root, encoding: "utf8" });
		return { status: result.status, output: `${result.stdout}${result.stderr}` };
	}

	test("a shelf pack keeps its path source and carries its release build beside it", () => {
		let listed: CatalogEntry | undefined;
		const result = shelfWithEditedDemo(demo => {
			listed = structuredClone(demo);
		});

		expect(result.status).toBe(0);
		expect(listed?.source).toBe("./packs/demo");
		expect(listed?.release?.source).toBe("release");
		expect(listed?.release?.url).toBe("https://github.com/insodimension/dimension-community/releases/download/demo-v1.0.0/demo-1.0.0.tgz");
	});

	test("refuses a shelf pack whose release url was edited by hand", () => {
		const result = shelfWithEditedDemo(demo => {
			if (!demo.release) throw new Error("demo carries no release build");
			demo.release.url = "https://github.com/insodimension/dimension-community/releases/download/demo-v1.0.0/demo-1.0.1.tgz";
		});

		expect(result.status).toBe(1);
		expect(result.output).toContain(`plugin "demo": release.url must be this shelf's release build`);
	});
});
