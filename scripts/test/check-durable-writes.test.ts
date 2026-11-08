import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compareWithAllowlist, readAllowlist, scanRawWrites } from "../check-durable-writes";

const fixtureRoot = mkdtempSync(join(tmpdir(), "shelf-durable-writes-"));

afterAll(() => {
	rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeFixture(relative: string, source: string): void {
	const file = join(fixtureRoot, relative);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, source);
}

describe("durable write guard", () => {
	test("the scan counts each raw write shape in pack runtime source and skips comments, declarations, tests, builds and scripts", () => {
		writeFixture(
			"packs/demo/src/writes.ts",
			[
				'fs.writeFileSync(file, "a");',
				'await Bun.write(file, "a");',
				'await fs.promises.writeFile(file, "a");',
				'await handle.writeFile("a");',
				'await writeFile(file, "a");',
				"fs.renameSync(from, to);",
				"await fs.rename(from, to);",
				"await fsp.rename(from, to);",
				"await fs.promises.rename(from, to);",
				"await rename(from, to);",
				"// fs.writeFileSync(file, a);",
				" * Bun.write(file, a)",
				"function writeFile(file: string) {}",
				"rename(id: string, name: string): void;",
				"rename(id, name) {",
				"await writeFileAtomic(file, a);",
				"store.rename(id, name);",
				"await renameBank(a, b);",
			].join("\n"),
		);
		writeFixture("packs/demo/index.ts", "fs.renameSync(from, to);\n");
		writeFixture("packs/demo/src/writes.test.ts", 'fs.writeFileSync(file, "a");\n');
		writeFixture("packs/demo/test/helper.ts", 'fs.writeFileSync(file, "a");\n');
		writeFixture("packs/demo/scripts/build.mjs", 'await writeFile(out, "a");\n');
		writeFixture("packs/demo/app/server.mjs", 'fs.writeFileSync(file, "a");\n');
		writeFixture("packs/demo/dist/index.mjs", 'fs.writeFileSync(file, "a");\n');
		writeFixture("lib/durable-file.mjs", "fs.renameSync(from, to);\n");

		expect(Object.fromEntries(scanRawWrites(fixtureRoot))).toEqual({
			"packs/demo/index.ts": 1,
			"packs/demo/src/writes.ts": 10,
		});
	});

	test("a new raw write in an allowlisted file fails", () => {
		const report = compareWithAllowlist(new Map([["a.ts", 3]]), { "a.ts": { count: 2, why: "scratch" } });
		expect(report.drift).toEqual([{ file: "a.ts", found: 3, allowed: 2 }]);
	});

	test("a raw write in a file with no allowance fails", () => {
		const report = compareWithAllowlist(new Map([["b.ts", 1]]), {});
		expect(report.drift).toEqual([{ file: "b.ts", found: 1, allowed: 0 }]);
	});

	test("an allowance above the found count fails so the list ratchets down", () => {
		const report = compareWithAllowlist(new Map([["a.ts", 1]]), { "a.ts": { count: 2, why: "scratch" } });
		expect(report.drift).toEqual([{ file: "a.ts", found: 1, allowed: 2 }]);
	});

	test("an allowance for a file with no raw writes left is stale and fails", () => {
		const report = compareWithAllowlist(new Map(), { "gone.ts": { count: 1, why: "scratch" } });
		expect(report.drift).toEqual([{ file: "gone.ts", found: 0, allowed: 1 }]);
	});

	test("an allowance without a reason fails", () => {
		const report = compareWithAllowlist(new Map([["a.ts", 1]]), { "a.ts": { count: 1, why: "  " } });
		expect(report.drift).toEqual([]);
		expect(report.unexplained).toEqual(["a.ts"]);
	});

	test("the shelf as committed is within its allowance", () => {
		const report = compareWithAllowlist(scanRawWrites(), readAllowlist());
		expect(report.drift).toEqual([]);
		expect(report.unexplained).toEqual([]);
	});
});
