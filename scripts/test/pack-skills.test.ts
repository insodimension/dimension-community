import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initGitShelf, SHELF_SCRIPTS } from "./git-shelf";

const scriptsDir = resolve(import.meta.dir, "..");
const shelves: string[] = [];

afterAll(() => {
	for (const shelf of shelves) rmSync(shelf, { recursive: true, force: true });
});

const GOOD_SKILL = [
	"---",
	"name: helper",
	"description: Helps with one thing. Use when the user asks for that thing.",
	"license: MIT",
	"compatibility: Requires the gh CLI.",
	"allowed-tools: Bash(npx helper *) Read",
	"metadata:",
	'  version: "1.2.3"',
	"---",
	"",
	"# Helper",
	"",
].join("\n");

function shelfWith(skill: string, pkgBlock: Record<string, unknown> | null = { name: "helper-pack" }): string {
	const root = mkdtempSync(join(tmpdir(), "pack-skills-"));
	shelves.push(root);
	initGitShelf(root);
	mkdirSync(join(root, "scripts"));
	for (const file of SHELF_SCRIPTS) cpSync(join(scriptsDir, file), join(root, "scripts", file));
	mkdirSync(join(root, ".dimension-plugin"));
	writeFileSync(
		join(root, ".dimension-plugin", "marketplace.json"),
		JSON.stringify({ name: "test-shelf", owner: { name: "Tests" }, plugins: [] }),
	);
	const dir = join(root, "packs", "helper-pack");
	mkdirSync(join(dir, "skills", "helper"), { recursive: true });
	const pkg: Record<string, unknown> = { name: "helper-pack", version: "1.0.0", description: "A pack that ships one skill" };
	if (pkgBlock) pkg.dimension = pkgBlock;
	writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
	writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "helper-pack", version: "1.0.0", description: "A pack that ships one skill" }));
	writeFileSync(join(dir, "skills", "helper", "SKILL.md"), skill);
	return root;
}

function validate(root: string) {
	const built = spawnSync(process.execPath, [join(root, "scripts", "build-index.ts")], { cwd: root, encoding: "utf8" });
	expect(built.status).toBe(0);
	const result = spawnSync(process.execPath, [join(root, "scripts", "validate-marketplace.mjs")], { cwd: root, encoding: "utf8" });
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function withFrontmatter(lines: string[]): string {
	return ["---", ...lines, "---", "", "# Helper", ""].join("\n");
}

describe("pack skills: every SKILL.md meets the closed Agent Skills front matter the harness enforces", () => {
	test("a skill using only the allowed keys, with allowed-tools as one line and its version under metadata, passes", () => {
		const result = validate(shelfWith(GOOD_SKILL));
		expect(result.output).toContain("marketplace.json OK");
		expect(result.status).toBe(0);
	});

	test("an extra top-level key fails, naming the pack, the skill and the key", () => {
		const result = validate(
			shelfWith(withFrontmatter(["name: helper", "description: Helps with one thing.", "prerequisites: none"])),
		);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain('packs/helper-pack: skill "helper" (skills/helper/SKILL.md) has the front matter key "prerequisites"');
	});

	test("a top-level version fails; the same version under metadata is the accepted home", () => {
		const result = validate(shelfWith(withFrontmatter(["name: helper", "description: Helps with one thing.", "version: 3.9.1"])));
		expect(result.status).not.toBe(0);
		expect(result.output).toContain('skill "helper" (skills/helper/SKILL.md) has the front matter key "version"');
	});

	test("allowed-tools written as a YAML list fails", () => {
		const result = validate(
			shelfWith(withFrontmatter(["name: helper", "description: Helps with one thing.", "allowed-tools:", "  - Bash(npx helper *)"])),
		);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain('skill "helper" (skills/helper/SKILL.md) has an "allowed-tools" that is not text');
	});

	test("a metadata value that is not text fails", () => {
		const result = validate(
			shelfWith(withFrontmatter(["name: helper", "description: Helps with one thing.", "metadata:", "  version: 1.2"])),
		);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain('has "metadata.version" that is not text');
	});

	test("an unquoted value holding a colon and a space is not valid YAML to the harness and fails", () => {
		const result = validate(
			shelfWith(withFrontmatter(["name: helper", "description: A phone is the person's own device: it is never picked by default."])),
		);
		expect(result.status).not.toBe(0);
		expect(result.output).toContain('skill "helper" (skills/helper/SKILL.md) has front matter that is not valid YAML');
	});

	test("a name that differs from the skill's directory fails", () => {
		const result = validate(shelfWith(withFrontmatter(["name: other", "description: Helps with one thing."])));
		expect(result.status).not.toBe(0);
		expect(result.output).toContain('has the "name" "other", which must equal its directory name "helper"');
	});

	test("a description over 1024 characters fails", () => {
		const result = validate(shelfWith(withFrontmatter(["name: helper", `description: ${"a".repeat(1025)}`])));
		expect(result.status).not.toBe(0);
		expect(result.output).toContain('has a "description" of 1025 characters');
	});

	test("a pack with skills but no dimension block in package.json fails, since the harness never enumerates it", () => {
		const result = validate(shelfWith(GOOD_SKILL, null));
		expect(result.status).not.toBe(0);
		expect(result.output).toContain('packs/helper-pack: package.json has no "dimension" block');
	});
});
