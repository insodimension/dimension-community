// General Agents on disk: where they are read from, how a file becomes a Forge
// draft, and the one way a draft becomes a file.
//
// Classification is `@dimension/sdk/general-agent`'s `parseGeneralAgent` — the
// same function the engine's catalog uses (`general-agent-contributions.ts`),
// so a file this server lists or writes cannot be read differently there.
// Precedence mirrors that catalog too: installed packs, then the workspace
// (`.inso/`, then legacy `.omp/`), then the user's own agents — first wins by
// name.
import { createHash, randomBytes } from "node:crypto";
import { type Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import {
	agentHomeWorkspaceId,
	GENERAL_AGENT_FILE,
	GENERAL_AGENTS_DIR,
	type GeneralAgentDecl,
	parseGeneralAgent,
} from "@dimension/sdk/general-agent";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
	type AgentDraft,
	DRAWN_CHILDREN,
	draftProblems,
	FLAT_ALIASES,
	type Habitat,
	HABITATS,
	MEMORY_BACKENDS,
	type MemoryBackend,
	type MemoryScope,
	type Thinking,
	THINKING_STEPS,
	toAgentMd,
	VOICE_NAME_RE,
} from "./agent-md.js";
import type { AgentListing, ListedAgent, SaveOutcome, SaveTarget, WritableTier } from "./contracts.js";
import { type Block, parseExtra, reindent } from "./extra.js";
import { isRecord } from "./guards.js";

/**
 * The project config dir the Forge reads — the ENGINE's own rule
 * (`getConfigDirName` in omp utils: `PI_CONFIG_DIR`, else `.inso` in the product),
 * because the General Agents catalog reads `<workspace>/<that dir>/agents`. A
 * hardcoded `.inso` listed files a dev engine (`.inso-dev`) never reads. Then the
 * legacy dir it only reads.
 */
export const WRITE_DIR = process.env.PI_CONFIG_DIR?.trim() || ".inso";
export const LEGACY_DIR = ".omp";

/** Where the engine keeps things, all under its one home (`INSO_HOME`). */
export function pathsOf(home: string | null) {
	if (home === null) return null;
	return {
		plugins: join(home, "plugins"),
		/** The agent dir: skills, settings — and `agents/`, the user tier. */
		agent: join(home, "agent"),
		userAgents: join(home, "agent", "agents"),
		/** `<home>/workspaces`: every agent home (`home-<name>`) — the engine pins `PI_AGENT_HOMES_DIR` here. */
		homes: join(home, "workspaces"),
	};
}

/** What the server knows about where agents live. */
export interface Roots {
	/** The workspace root project agents are read from; null = none bound. */
	readonly workspace: string | null;
	/** `INSO_HOME`; null = the engine did not say. */
	readonly home: string | null;
	/** Why `workspace` is null, when it is. */
	readonly workspaceMissing?: string;
}

/**
 * Every installed plugin root under the engine's plugin store: the OMP store's
 * `node_modules/<name>` (npm, bundled and `plugins:link` junctions) plus each
 * marketplace install's `installPath` from `installed_plugins.json`. Installed
 * is not enabled — the pack agents it yields are listed for lineage and
 * reading, never for editing.
 */
export async function installedPluginRoots(pluginsDir: string): Promise<Map<string, string>> {
	const roots = new Map<string, string>();
	const modules = join(pluginsDir, "node_modules");
	for (const entry of await listDirs(modules)) {
		if (entry.startsWith("@")) {
			for (const scoped of await listDirs(join(modules, entry))) roots.set(`${entry}/${scoped}`, join(modules, entry, scoped));
		} else if (!entry.startsWith(".")) roots.set(entry, join(modules, entry));
	}
	try {
		const installed = JSON.parse(await readFile(join(pluginsDir, "installed_plugins.json"), "utf8")) as {
			plugins?: Record<string, readonly { installPath?: unknown }[]>;
		};
		for (const [id, entries] of Object.entries(installed.plugins ?? {})) {
			const installPath = entries.find(entry => typeof entry.installPath === "string")?.installPath;
			if (typeof installPath === "string" && !roots.has(id)) roots.set(id, installPath);
		}
	} catch {
		// No marketplace installs yet: the registry file is created on the first.
	}
	return roots;
}

async function listDirs(dir: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	// A `plugins:link` install is a junction/symlink: it counts as a directory.
	return entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name);
}

// ── a file → a draft ────────────────────────────────────────────────────────

/** Keys the parser accepts and never stores — a retired setting, dropped on rewrite. */
const RETIRED_PATHS: Readonly<Record<string, true>> = { "memory.vault": true };

/** The frontmatter of a file `parseGeneralAgent` already accepted — the SDK's
 *  own split (`---` … `\n---`). */
function frontmatterOf(content: string): string {
	if (!content.startsWith("---")) return "";
	const end = content.indexOf("\n---", 3);
	return end < 0 ? "" : content.slice(content.indexOf("\n") + 1, end);
}

/** A face the profile's picker can hold: a plain avatar id, first-party or a
 *  contributed `plugin:` face, with no skin and no accent. Which ids exist is the
 *  host's roster, not this server's: the manifest parser has already checked the
 *  id's shape. */
function isPlainAvatar(avatar: NonNullable<GeneralAgentDecl["avatar"]>): boolean {
	return avatar.skin === undefined && avatar.accent === undefined;
}

/**
 * The profile-drawn paths this file holds in a form the profile cannot draw: an
 * avatar with a skin, `thinkingLevel: auto`, an allowlist that is `"*"` or
 * `[]` (none), a reach that lists workspaces, a pinned workspace. Such a key is
 * not drawn and not dropped — its text moves to Everything else, and the
 * profile's control for it stands aside.
 */
function heldPaths(decl: GeneralAgentDecl, raw: Raw, blocks: readonly Block[]): Set<string> {
	const held = new Set<string>();
	const { manifest, avatar } = decl;
	if (avatar !== undefined && !isPlainAvatar(avatar)) held.add("avatar");
	// A `voice:` that is not a profile name keeps its text in Everything else: a voice-aware engine
	// refuses the manifest, and rewriting it as an absent key would silently change the file.
	if (raw.voice !== undefined && !(typeof raw.voice === "string" && VOICE_NAME_RE.test(raw.voice))) held.add("voice");

	const level = raw.thinkingLevel;
	if (level !== undefined && (level === "inherit" || !(THINKING_STEPS as readonly string[]).includes(String(level)))) held.add("engine.thinkingLevel");

	const backend = manifest.memory?.backend;
	if (backend !== undefined && (backend === "inherit" || !(MEMORY_BACKENDS as readonly string[]).includes(backend))) held.add("memory.backend");

	// `[]` would be written back as an absent key (the host's default model).
	const model = manifest.engine?.model;
	if (model !== undefined && (!Array.isArray(model) || model.length === 0)) held.add("engine.model");

	// `[]` means NONE, and the profile writes an empty list as an absent key (ALL).
	for (const key of ["tools", "skills", "mcp"] as const) {
		const value = manifest.capabilities?.[key];
		if (value === "*" || (Array.isArray(value) && value.length === 0)) held.add(`capabilities.${key}`);
	}

	const workspace = manifest.workspace;
	if (workspace !== undefined) {
		// An older Forge wrote `agent-<name>` for `home`; it is read as the own-home switch
		// and rewritten as the id the engine registers.
		const ownHome = workspace.policy === "home" && (workspace.id === agentHomeWorkspaceId(decl.name) || workspace.id === `agent-${decl.name}`);
		const policyDrawn = workspace.policy === undefined || (HABITATS as readonly string[]).includes(workspace.policy);
		if (!policyDrawn || (workspace.id !== undefined && !ownHome)) {
			held.add("workspace.policy");
			held.add("workspace.id");
		}
		const reach = workspace.reach;
		if (reach !== undefined && reach !== "none" && !(reach === "all" && backend !== "off")) held.add("workspace.reach");
	}

	for (const block of blocks) {
		const canonical = FLAT_ALIASES[block.key];
		if (canonical !== undefined) held.add(canonical);
	}
	return held;
}

/** The raw settings the SDK's manifest does not carry. `parseAgentManifest` leaves
 *  `engine.thinkingLevel` undefined (the coding agent syncs it in later), so the
 *  level is read from the YAML itself — reading it from the manifest lost it. */
interface Raw {
	readonly thinkingLevel: unknown;
	readonly voice: unknown;
}

function rawSettings(frontmatter: string): Raw {
	const parsed: unknown = parseYaml(frontmatter);
	if (!isRecord(parsed)) return { thinkingLevel: undefined, voice: undefined };
	const engine = parsed.engine;
	return { thinkingLevel: isRecord(engine) ? engine.thinkingLevel : undefined, voice: parsed.voice };
}

/** A section's keys as lines at 2 spaces — a flow-style section (`gate: { approval: yolo }`) is re-rendered as a block. */
function sectionChildren(block: Block): { key: string; lines: string[] }[] {
	if (block.children !== null) return block.children.map(child => ({ key: child.key, lines: reindent(child.lines, block.childIndent, 2) }));
	if (block.inline === "") return [];
	const value: unknown = parseYaml(block.inline);
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	return Object.entries(value).map(([key, setting]) => ({
		key,
		lines: stringifyYaml({ [key]: setting })
			.trimEnd()
			.split("\n")
			.map(text => `  ${text}`),
	}));
}

/**
 * The Forge draft for a parsed agent. NOTHING in the file is unshown: every key
 * the profile does not draw, and every drawn key it cannot draw faithfully,
 * lands in `draft.extra` as the text the author wrote, so `toAgentMd(draft)`
 * re-parses to the same manifest (identity.prompt made explicit — additive; an
 * absent avatar stays absent).
 */
export function draftFromFile(decl: GeneralAgentDecl, content: string, key: string): AgentDraft {
	const manifest = decl.manifest;
	const frontmatter = frontmatterOf(content);
	const blocks = parseExtra(frontmatter).blocks;
	const raw = rawSettings(frontmatter);
	const held = heldPaths(decl, raw, blocks);

	const pieces: string[] = [];
	for (const block of blocks) {
		const drawn = DRAWN_CHILDREN[block.key];
		if (block.key === "avatar") {
			if (held.has("avatar")) pieces.push(...block.lines);
		} else if (block.key === "voice") {
			if (held.has("voice")) pieces.push(...block.lines);
		} else if (drawn !== undefined) {
			const kept = sectionChildren(block).filter(child => {
				const path = `${block.key}.${child.key}`;
				return RETIRED_PATHS[path] === undefined && (!drawn.includes(child.key) || held.has(path));
			});
			if (kept.length > 0) pieces.push(`${block.key}:`, ...kept.flatMap(child => child.lines));
		} else if (!["name", "description", "specVersion", "extends"].includes(block.key)) pieces.push(...block.lines);
	}

	const drawnOr = <T>(path: string, value: T | undefined, fallback: T): T => (held.has(path) || value === undefined ? fallback : value);
	const backend = manifest.memory?.backend;
	const memory = drawnOr<MemoryBackend>("memory.backend", backend as MemoryBackend | undefined, "inherit");
	const reach = manifest.workspace?.reach;
	const memoryScope: MemoryScope = !held.has("workspace.reach") && reach === "all" && memory !== "off" ? "global" : "project";
	const policy = manifest.workspace?.policy;
	const habitat = drawnOr<Habitat>("workspace.policy", policy as Habitat | undefined, "bound");

	return {
		key,
		name: decl.name,
		description: decl.description,
		vibr: decl.avatar !== undefined && isPlainAvatar(decl.avatar) ? decl.avatar.id : "",
		voice: typeof raw.voice === "string" && !held.has("voice") ? raw.voice : "",
		personality: manifest.identity?.personality ?? "default",
		promptMode: manifest.identity?.prompt ?? "replace",
		thinking: drawnOr<Thinking>("engine.thinkingLevel", raw.thinkingLevel as Thinking | undefined, "inherit"),
		models: held.has("engine.model") ? [] : allowlist(manifest.engine?.model),
		tools: held.has("capabilities.tools") ? [] : allowlist(manifest.capabilities?.tools),
		skills: held.has("capabilities.skills") ? [] : allowlist(manifest.capabilities?.skills),
		mcp: held.has("capabilities.mcp") ? [] : allowlist(manifest.capabilities?.mcp),
		memory,
		memoryScope,
		// An absent approval INHERITS the host's; it stays absent until a human picks one.
		approval: manifest.gate?.approval ?? "inherit",
		habitat,
		lineage: [...(manifest.extends ?? [])],
		charter: decl.body,
		extra: pieces.join("\n"),
	};
}

function allowlist(value: string[] | "*" | undefined): string[] {
	return Array.isArray(value) ? [...value] : [];
}

/** A short digest of a file's text: the lost-update guard a rewrite names. */
export function revisionOf(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ── listing ─────────────────────────────────────────────────────────────────

interface Found {
	readonly name: string;
	readonly path: string;
	readonly content: string;
	readonly decl: GeneralAgentDecl;
}

/** Every General Agent directly under `dir` (`<dir>/<name>/agent.md`). Loops
 *  and manifest-less files are ordinary residents and skipped silently; an
 *  agent an author got wrong is reported. */
async function scanAgents(dir: string, notices: string[]): Promise<Found[]> {
	const found: Found[] = [];
	for (const name of await listDirs(dir)) {
		const path = join(dir, name, GENERAL_AGENT_FILE);
		let content: string;
		try {
			content = await readFile(path, "utf8");
		} catch {
			continue;
		}
		const parsed = parseGeneralAgent(content, path, name);
		if (parsed.ok) found.push({ name, path, content, decl: parsed.decl });
		else if (parsed.reason === "invalid") notices.push(`${path} is not a valid General Agent: ${parsed.errors.join("; ")}`);
	}
	return found;
}

export async function listAgents(roots: Roots): Promise<AgentListing> {
	const notices: string[] = [];
	const agents: ListedAgent[] = [];
	const claimed = new Map<string, string>();
	const claim = (found: Found): boolean => {
		const winner = claimed.get(found.name);
		if (winner !== undefined) {
			notices.push(`${found.path} is shadowed by ${winner} (same name "${found.name}").`);
			return false;
		}
		claimed.set(found.name, found.path);
		return true;
	};
	const paths = pathsOf(roots.home);

	// The engine's order: packs own their names, then the project, then the user.
	if (paths === null) notices.push("Pack and user agents are not listed: the engine did not tell this server where its home is (INSO_HOME is unset).");
	else {
		for (const [pack, root] of await installedPluginRoots(paths.plugins)) {
			for (const found of await scanAgents(join(root, GENERAL_AGENTS_DIR), notices)) {
				if (!claim(found)) continue;
				agents.push({
					name: found.name,
					description: found.decl.description,
					source: "pack",
					pack,
					path: found.path,
					editable: false,
					readOnlyReason: `It ships in the ${pack} pack. Extend it to make your own.`,
					...(found.decl.manifest.workspace?.id !== undefined ? { workspaceId: found.decl.manifest.workspace.id } : {}),
					draft: draftFromFile(found.decl, found.content, `pack:${pack}:${found.name}`),
				});
			}
		}
	}

	if (roots.workspace === null) {
		notices.push(roots.workspaceMissing ?? "No workspace is bound, so project agents are not listed. Pack agents and yours are.");
	} else {
		for (const dirName of [WRITE_DIR, LEGACY_DIR]) {
			for (const found of await scanAgents(join(roots.workspace, dirName, "agents"), notices)) {
				if (!claim(found)) continue;
				const legacy = dirName === LEGACY_DIR;
				agents.push({
					name: found.name,
					description: found.decl.description,
					source: "workspace",
					path: found.path,
					editable: !legacy,
					...(legacy ? { readOnlyReason: `It lives in the legacy ${LEGACY_DIR}/agents; new agents are written only to ${WRITE_DIR}/agents.` } : {}),
					revision: revisionOf(found.content),
					...(found.decl.manifest.workspace?.id !== undefined ? { workspaceId: found.decl.manifest.workspace.id } : {}),
					draft: draftFromFile(found.decl, found.content, `workspace::${found.name}`),
				});
			}
		}
	}

	if (paths !== null) {
		for (const found of await scanAgents(paths.userAgents, notices)) {
			if (!claim(found)) continue;
			agents.push({
				name: found.name,
				description: found.decl.description,
				source: "user",
				path: found.path,
				editable: true,
				revision: revisionOf(found.content),
				...(found.decl.manifest.workspace?.id !== undefined ? { workspaceId: found.decl.manifest.workspace.id } : {}),
				draft: draftFromFile(found.decl, found.content, `user::${found.name}`),
			});
		}
	}
	return { workspace: roots.workspace, configDir: WRITE_DIR, userAgentsDir: paths?.userAgents ?? null, agents, notices };
}

// ── a draft → a file ────────────────────────────────────────────────────────

/** A refusal `save_agent` reports verbatim; nothing was written. */
export class SaveRefused extends Error {
	override readonly name = "SaveRefused";
}

/**
 * The agent.md a draft would write, or every reason it cannot be written: the
 * draft's own problems, and — the last word — whether the merged file loads as
 * a General Agent (never a Loop, never invalid YAML, never a name that
 * disagrees with its directory). The server's answer to "would this save?",
 * shared by the live check and the write.
 */
export function renderDraft(draft: AgentDraft, path: string): { content: string } | { problems: string[] } {
	const problems = draftProblems(draft);
	if (problems.length > 0) return { problems };
	const content = toAgentMd(draft, agentHomeWorkspaceId(draft.name));
	const parsed = parseGeneralAgent(content, path, draft.name);
	if (!parsed.ok) return { problems: [`The agent.md would not load as a General Agent (${parsed.reason}): ${parsed.errors.join("; ")}`] };
	return { content };
}

export interface SaveOptions {
	readonly roots: Roots;
	readonly draft: AgentDraft;
	readonly target: SaveTarget;
}

const slash = (path: string) => path.replaceAll("\\", "/");

/**
 * Write one agent.md, atomically: the bytes are the View's own serializer's,
 * re-parsed with `parseGeneralAgent` BEFORE anything touches disk, then written
 * to a temp file beside the target and renamed over it.
 */
export async function saveAgent(options: SaveOptions): Promise<SaveOutcome> {
	const { roots, draft, target } = options;
	const paths = pathsOf(roots.home);
	const tier: WritableTier = target.create ? "user" : target.tier;
	const tierRoot = tier === "user" ? roots.home : roots.workspace;
	const agentsDir = tier === "user" ? paths?.userAgents : roots.workspace === null ? undefined : join(roots.workspace, WRITE_DIR, "agents");
	if (tierRoot === null || agentsDir === undefined) {
		throw new SaveRefused(
			tier === "user"
				? "The user tier cannot be reached: the engine did not tell this server where its home is (INSO_HOME is unset)."
				: "No workspace is bound, so its project agents cannot be rewritten.",
		);
	}
	const dir = join(agentsDir, draft.name);
	const path = join(dir, GENERAL_AGENT_FILE);
	const rendered = renderDraft(draft, path);
	if ("problems" in rendered) throw new SaveRefused(rendered.problems.join(" "));
	const { content } = rendered;

	if (target.create) {
		const taken = (await listAgents(roots)).agents.find(agent => agent.name === draft.name);
		if (taken !== undefined) {
			throw new SaveRefused(`An agent named "${draft.name}" already exists (${taken.source === "pack" ? `the ${taken.pack} pack ships it` : `${taken.source} agent at ${taken.path}`}). Pick another name.`);
		}
		await mkdir(agentsDir, { recursive: true });
		// Non-recursive: EEXIST is the collision check, atomic with the claim.
		try {
			await mkdir(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SaveRefused(`${slash(relative(tierRoot, dir))} already exists. Pick another name.`);
			throw error;
		}
	} else {
		let existing: string;
		try {
			existing = await readFile(path, "utf8");
		} catch {
			throw new SaveRefused(`There is no ${slash(relative(tierRoot, path))} to update. Create it as a new agent.`);
		}
		const current = parseGeneralAgent(existing, path, draft.name);
		if (!current.ok) {
			throw new SaveRefused(
				current.reason === "loop"
					? `${draft.name} is a Loop, not a General Agent, and a Loop is never rewritten here.`
					: `${draft.name}'s agent.md does not parse (${current.errors.join("; ")}); fix it by hand first.`,
			);
		}
		if (revisionOf(existing) !== target.revision) {
			throw new SaveRefused(`${draft.name}'s agent.md changed on disk since it was opened here; reopen it so nothing written since is lost.`);
		}
	}

	const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		// A claimed-but-unwritten directory would block the next attempt at this name.
		if (target.create) await rm(dir, { recursive: true, force: true });
		throw error;
	}
	return { path, relativePath: slash(relative(tierRoot, path)), created: target.create, tier };
}
