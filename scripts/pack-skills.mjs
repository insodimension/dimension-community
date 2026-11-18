import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const SKILL_FIELDS = ["name", "description", "license", "allowed-tools", "metadata", "compatibility"];

const MANIFEST_KEYS = ["dimension", "omp", "pi"];

const SKILL_NAME_CHARS = /^[\p{L}\p{N}-]+$/u;

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

function nameProblem(raw, dirName) {
	if (typeof raw !== "string" || raw.trim().length === 0) return `has no "name"`;
	const name = raw.trim().normalize("NFKC");
	if (Array.from(name).length > 64) return `has a "name" longer than 64 characters`;
	if (name !== name.toLowerCase()) return `has a "name" that is not lowercase`;
	if (name.startsWith("-") || name.endsWith("-")) return `has a "name" that starts or ends with a hyphen`;
	if (name.includes("--")) return `has a "name" with two hyphens in a row`;
	if (!SKILL_NAME_CHARS.test(name)) return `has a "name" with characters other than letters, digits and hyphens (${JSON.stringify(name)})`;
	if (name !== dirName.normalize("NFKC")) return `has the "name" ${JSON.stringify(name)}, which must equal its directory name ${JSON.stringify(dirName)}`;
	return null;
}

function skillFrontmatterProblem(frontmatter, dirName) {
	for (const key in frontmatter) {
		if (!SKILL_FIELDS.includes(key)) {
			return `has the front matter key "${key}", which the Agent Skills format does not allow (allowed: ${SKILL_FIELDS.join(", ")}; put anything else under "metadata" as text)`;
		}
	}
	const name = nameProblem(frontmatter.name, dirName);
	if (name) return name;
	const description = frontmatter.description;
	if (typeof description !== "string" || description.trim().length === 0) return `has no "description"`;
	if (description.length > 1024) return `has a "description" of ${description.length} characters, more than the 1024 allowed`;
	if (frontmatter.license !== undefined && typeof frontmatter.license !== "string") return `has a "license" that is not text`;
	const compatibility = frontmatter.compatibility;
	if (compatibility !== undefined) {
		if (typeof compatibility !== "string") return `has a "compatibility" that is not text`;
		if (compatibility.length > 500) return `has a "compatibility" of ${compatibility.length} characters, more than the 500 allowed`;
	}
	const metadata = frontmatter.metadata;
	if (metadata !== undefined) {
		if (!isRecord(metadata)) return `has a "metadata" that is not a map of keys to text`;
		for (const key in metadata) {
			if (typeof metadata[key] !== "string") return `has "metadata.${key}" that is not text (quote it)`;
		}
	}
	const allowedTools = frontmatter["allowed-tools"];
	if (allowedTools !== undefined && typeof allowedTools !== "string") {
		return `has an "allowed-tools" that is not text (write it as one space-separated line, not a list)`;
	}
	return null;
}

function readSkillFrontmatter(content) {
	const text = content.replace(/\r\n?/g, "\n");
	if (!text.startsWith("---")) return { frontmatter: {} };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { frontmatter: {} };
	let loaded;
	try {
		loaded = globalThis.Bun.YAML.parse(text.slice(4, end));
	} catch (error) {
		return { error: `has front matter that is not valid YAML (${error instanceof Error ? error.message : String(error)}); quote a value that holds ": "` };
	}
	return { frontmatter: isRecord(loaded) ? loaded : {} };
}

function packSkillProblems(root, pack) {
	const skillsDir = join(root, "packs", pack, "skills");
	if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) return [];
	const skills = readdirSync(skillsDir)
		.filter(dir => statSync(join(skillsDir, dir)).isDirectory() && existsSync(join(skillsDir, dir, "SKILL.md")))
		.sort();
	if (skills.length === 0) return [];
	const problems = [];
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(join(root, "packs", pack, "package.json"), "utf8"));
	} catch {
		pkg = undefined;
	}
	if (pkg !== undefined && !MANIFEST_KEYS.some(key => isRecord(pkg?.[key]))) {
		problems.push(
			`packs/${pack}: package.json has no "dimension" block, so the harness skips the whole pack and its skills (${skills.join(", ")}) never reach a session; add "dimension": { "name": "${pack}" }`,
		);
	}
	for (const skill of skills) {
		const read = readSkillFrontmatter(readFileSync(join(skillsDir, skill, "SKILL.md"), "utf8"));
		const problem = "error" in read ? read.error : skillFrontmatterProblem(read.frontmatter, skill);
		if (problem) problems.push(`packs/${pack}: skill "${skill}" (skills/${skill}/SKILL.md) ${problem}, so the harness drops it`);
	}
	return problems;
}

export function shelfSkillProblems(root, packs) {
	if (!globalThis.Bun?.YAML) {
		return ["pack skills can only be checked under bun, which parses SKILL.md front matter the way the harness does (run bun scripts/validate-marketplace.mjs)"];
	}
	return packs.flatMap(pack => packSkillProblems(root, pack));
}
