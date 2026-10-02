// What the tray offers, read from where the engine and the files actually keep
// it. A kind that cannot be sourced is OMITTED and said so — the tray never
// shows a hand-kept list as if it were the machine's.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { MEMORY_BACKENDS } from "./agent-md.js";
import type { ListedAgent, Part, PartListing } from "./contracts.js";
import { installedPluginRoots } from "./store.js";

/** The pack-relative files `readPackMcpEntries` reads a pack's servers from. */
const PACK_MCP_FILES = ["mcp.json", "ai.insodimension.dimension/mcp.json", ".mcp.json"] as const;

interface Root {
	/** Where the parts came from, as the tray's hint says it. */
	readonly label: string;
	readonly dir: string;
}

async function skillsIn(dir: string): Promise<{ id: string; description: string }[]> {
	let names: string[];
	try {
		names = (await readdir(dir, { withFileTypes: true })).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name);
	} catch {
		return [];
	}
	const skills: { id: string; description: string }[] = [];
	for (const name of names) {
		let text: string;
		try {
			text = await readFile(join(dir, name, "SKILL.md"), "utf8");
		} catch {
			continue;
		}
		const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
		let front: Record<string, unknown> = {};
		try {
			const parsed: unknown = match ? parseYaml(match[1] ?? "") : null;
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) front = parsed as Record<string, unknown>;
		} catch {
			// A SKILL.md with broken frontmatter still names a skill by its directory.
		}
		skills.push({
			id: typeof front.name === "string" && front.name.trim() !== "" ? front.name : name,
			description: typeof front.description === "string" ? front.description : "",
		});
	}
	return skills;
}

async function mcpServersIn(file: string): Promise<string[]> {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as { mcpServers?: unknown };
		return typeof parsed.mcpServers === "object" && parsed.mcpServers !== null ? Object.keys(parsed.mcpServers) : [];
	} catch {
		return [];
	}
}

/** One line of a description, short enough for a suggestion's hint. */
function hintOf(text: string, from: string): string {
	const line = text.split("\n")[0]?.trim() ?? "";
	const short = line.length > 90 ? `${line.slice(0, 89)}…` : line;
	return short === "" ? from : `${short} (${from})`;
}

export interface PartsOptions {
	readonly workspace: string | null;
	readonly pluginsDir: string | null;
	/** `$INSO_HOME/agent` — the user's own skills and MCP config; null = unknown. */
	readonly agentDir: string | null;
	/** The agents already listed: the tool names they use are real names. */
	readonly agents: readonly ListedAgent[];
}

export async function listParts(options: PartsOptions): Promise<PartListing> {
	const parts: Part[] = [];
	const sources: string[] = [];
	const omitted: string[] = [];
	const seen = new Set<string>();
	const add = (part: Part) => {
		const key = `${part.kind}:${part.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		parts.push(part);
	};

	const skillRoots: Root[] = [];
	const mcpFiles: Root[] = [];
	if (options.workspace !== null) {
		for (const dir of [".inso", ".omp"]) skillRoots.push({ label: `workspace ${dir}/skills`, dir: join(options.workspace, dir, "skills") });
		for (const file of [".inso/mcp.json", ".omp/mcp.json", ".mcp.json"]) mcpFiles.push({ label: `workspace ${file}`, dir: join(options.workspace, file) });
	} else omitted.push("Workspace skills and MCP servers: no workspace is known.");
	if (options.agentDir !== null) {
		skillRoots.push({ label: "your skills", dir: join(options.agentDir, "skills") });
		mcpFiles.push({ label: "your mcp.json", dir: join(options.agentDir, "mcp.json") });
	}
	if (options.pluginsDir !== null) {
		for (const [pack, root] of await installedPluginRoots(options.pluginsDir)) {
			skillRoots.push({ label: `the ${pack} pack`, dir: join(root, "skills") });
			for (const file of PACK_MCP_FILES) mcpFiles.push({ label: `the ${pack} pack`, dir: join(root, file) });
		}
	}
	if (options.agentDir === null || options.pluginsDir === null) {
		omitted.push("Your own and installed packs' skills and MCP servers: the engine did not pass INSO_HOME.");
	}

	for (const root of skillRoots) {
		const skills = await skillsIn(root.dir);
		if (skills.length > 0) sources.push(`skills: ${root.dir}`);
		for (const skill of skills) add({ kind: "skill", id: skill.id, label: skill.id, hint: hintOf(skill.description, root.label) });
	}
	for (const file of mcpFiles) {
		const servers = await mcpServersIn(file.dir);
		if (servers.length > 0) sources.push(`mcp: ${file.dir}`);
		for (const server of servers) add({ kind: "mcp", id: server, label: server, hint: file.label });
	}

	// The host lends Apps no tool registry, so the full tool list cannot be read
	// here. What CAN be read: the tool names agents on this machine already use.
	const users = new Map<string, string[]>();
	for (const agent of options.agents) for (const tool of agent.draft.tools) users.set(tool, [...(users.get(tool) ?? []), agent.name]);
	for (const [tool, names] of users) add({ kind: "tool", id: tool, label: tool, hint: `Used by ${names.join(", ")}` });
	if (users.size > 0) sources.push("tools: the capabilities.tools of the agents listed");
	omitted.push("The full tool list: the host exposes no tool registry to Apps, so only tools an existing agent already names are offered.");

	for (const backend of MEMORY_BACKENDS) {
		if (backend !== "inherit") add({ kind: "memory", id: backend, label: backend === "off" ? "No memory" : backend, hint: `memory.backend: ${backend}` });
	}
	sources.push("memory: the backends the agent.md serializer writes");
	return { parts, sources, omitted };
}
