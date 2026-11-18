import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import { SKILL_FIELDS } from "../../../scripts/pack-skills.mjs";
import { conformSkillFrontmatter } from "../scripts/frontmatter";

const BODY = "\n\n> **Path note (Dimension port):** see below.\n\nversion: 9.9.9 in the body stays\n- Bash(not a key)\n";

const UPSTREAM = [
	"---",
	"name: impeccable",
	"description: Use when the user wants to design or polish a frontend interface.",
	"version: 3.9.1",
	"license: Apache 2.0",
	"allowed-tools:",
	"  - Bash(npx impeccable *)",
	"  - Bash(node <SKILL_DIR>/scripts/*)",
	"---",
].join("\n");

const CONFORMING = [
	"---",
	"name: impeccable",
	"description: Use when the user wants to design or polish a frontend interface.",
	"license: Apache 2.0",
	"allowed-tools: Bash(npx impeccable *) Bash(node <SKILL_DIR>/scripts/*)",
	"metadata:",
	'  version: "3.9.1"',
	"---",
].join("\n");

function frontmatterOf(markdown: string): Record<string, unknown> {
	return YAML.parse(markdown.slice(4, markdown.indexOf("\n---", 3))) as Record<string, unknown>;
}

describe("conformSkillFrontmatter: an upstream SKILL.md comes out in the closed Agent Skills front matter", () => {
	test("version moves under metadata, allowed-tools becomes one line, the body is untouched", () => {
		const out = conformSkillFrontmatter(UPSTREAM + BODY);
		expect(out).toBe(CONFORMING + BODY);
		const frontmatter = frontmatterOf(out);
		for (const key of Object.keys(frontmatter)) expect(SKILL_FIELDS).toContain(key);
		expect(frontmatter["allowed-tools"]).toBe("Bash(npx impeccable *) Bash(node <SKILL_DIR>/scripts/*)");
		expect(frontmatter.metadata).toStrictEqual({ version: "3.9.1" });
	});

	test("conforming front matter is left as it is", () => {
		expect(conformSkillFrontmatter(CONFORMING + BODY)).toBe(CONFORMING + BODY);
	});

	test("the vendored SKILL.md is already what the sync writes", () => {
		const vendored = readFileSync(join(import.meta.dir, "..", "skills", "impeccable", "SKILL.md"), "utf8");
		expect(conformSkillFrontmatter(vendored)).toBe(vendored);
	});

	test("unknown keys of any shape join existing metadata as text, and a block description keeps its lines", () => {
		const input = [
			"---",
			"name: impeccable",
			"description: >",
			"  Folded text that spans",
			"  two lines.",
			"metadata:",
			"  author: someone",
			"  revision: 4",
			"prerequisites:",
			"  commands: [npx]",
			"user-invocable: true",
			"---",
		].join("\n");
		const frontmatter = frontmatterOf(conformSkillFrontmatter(input + BODY));
		expect(Object.keys(frontmatter)).toStrictEqual(["name", "description", "metadata"]);
		expect(frontmatter.description).toBe("Folded text that spans two lines.\n");
		expect(frontmatter.metadata).toStrictEqual({
			author: "someone",
			revision: "4",
			prerequisites: '{"commands":["npx"]}',
			"user-invocable": "true",
		});
		expect(conformSkillFrontmatter(input + BODY).endsWith(`\n---${BODY}`)).toBe(true);
	});

	test("a scalar moved into metadata keeps its source spelling", () => {
		const moved = frontmatterOf(
			conformSkillFrontmatter(["---", "name: impeccable", "description: d.", "version: 3.10", "---"].join("\n") + BODY),
		);
		expect(moved.metadata).toStrictEqual({ version: "3.10" });
		const merged = frontmatterOf(
			conformSkillFrontmatter(["---", "name: impeccable", "description: d.", "metadata:", "  version: 1.0", "---"].join("\n") + BODY),
		);
		expect(merged.metadata).toStrictEqual({ version: "1.0" });
	});

	test("a file without front matter is returned unchanged", () => {
		expect(conformSkillFrontmatter("# Just a body\n")).toBe("# Just a body\n");
	});
});
