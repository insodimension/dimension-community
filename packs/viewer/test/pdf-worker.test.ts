import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { toClassicWorkerSource } from "../app/view/pdf-worker";

// A module worker cannot start from a blob inside the View's frame, so the
// installed pdf.js worker is run as a classic script. This is the tripwire for a
// pdf.js upgrade that adds syntax a classic script cannot contain.
const installed = readFileSync(Bun.resolveSync("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.dir), "utf8");

describe("toClassicWorkerSource", () => {
	test("the installed pdf.js worker becomes a script that parses as a classic script", () => {
		const classic = toClassicWorkerSource(installed);
		expect(classic).not.toMatch(/import\.meta/);
		expect(classic).not.toMatch(/^\s*export\b/m);
		expect(() => new Function(classic)).not.toThrow(); // parse only: the function is never called
	});

	test("refuses module syntax it does not know how to strip", () => {
		expect(() => toClassicWorkerSource("import x from './y.js';\nexport { other };")).toThrow("module syntax");
	});
});
