import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Json = Record<string, unknown>;

const scriptsDir = resolve(import.meta.dir, "..");
const DIMENSION_NAMESPACE = "ai.insodimension.dimension";
const shelves: string[] = [];

afterAll(() => {
	for (const shelf of shelves) rmSync(shelf, { recursive: true, force: true });
});

function shelfWith(requires: Json): string {
	const root = mkdtempSync(join(tmpdir(), "pack-requires-"));
	shelves.push(root);
	mkdirSync(join(root, "scripts"));
	for (const file of ["build-index.ts", "pack-manifest.mjs", "space-showcase.mjs", "validate-marketplace.mjs"]) {
		cpSync(join(scriptsDir, file), join(root, "scripts", file));
	}
	mkdirSync(join(root, ".dimension-plugin"));
	writeFileSync(
		join(root, ".dimension-plugin", "marketplace.json"),
		JSON.stringify({ name: "test-shelf", owner: { name: "Tests" }, plugins: [] }),
	);
	const dir = join(root, "packs", "needs-browser");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "needs-browser", version: "1.0.0", description: "A pack that drives Browser" }));
	writeFileSync(
		join(dir, "plugin.json"),
		JSON.stringify({ name: "needs-browser", version: "1.0.0", extensions: { [DIMENSION_NAMESPACE]: { contractVersion: 1, requires } } }),
	);
	return root;
}

function run(root: string, script: string) {
	const result = spawnSync(process.execPath, [join(root, "scripts", script)], { cwd: root, encoding: "utf8" });
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function entry(root: string): Json {
	const catalog = JSON.parse(readFileSync(join(root, ".dimension-plugin", "marketplace.json"), "utf8")) as { plugins: Json[] };
	return catalog.plugins[0] as Json;
}

describe("requires.plugins: the ranges a pack needs of other packs", () => {
	test("ride the catalog entry beside requires.dimension, and validate", () => {
		const root = shelfWith({ dimension: ">=0.11.26", plugins: { browser: "^0.9.13" } });
		expect(run(root, "build-index.ts").status).toBe(0);
		expect(entry(root).requires).toStrictEqual({ dimension: ">=0.11.26", plugins: { browser: "^0.9.13" } });
		expect(run(root, "validate-marketplace.mjs").status).toBe(0);
	});

	test("an unparseable range or a non-id key fails the shelf, naming the entry", () => {
		const root = shelfWith({ plugins: { browser: "latest", "Not An Id": "^1.0.0" } });
		expect(run(root, "build-index.ts").status).toBe(0);
		const validated = run(root, "validate-marketplace.mjs");
		expect(validated.status).not.toBe(0);
		expect(validated.output).toContain('requires.plugins.browser "latest" is not a semver range');
		expect(validated.output).toContain('requires.plugins key "Not An Id" is not a plugin id');
	});
});
