// An agent's home and its standing instructions.
//
// A user or pack agent has a HOME — the workspace `home-<name>` under
// `$INSO_HOME/workspaces` (doc 83 §1.4) — where the engine provisions its
// folder on the first session and OMP reads the agent-level `AGENTS.md`. This
// module answers, for the Forge's Home tab: is there a home, where is it, and
// which `AGENTS.md` does the agent actually run by. The tier rules are OMP's
// own (`omp/packages/coding-agent/src/config/general-agents.ts`,
// `agentContextCandidatesFor` + `holdsAgentsMd`), repeated here because the
// Forge cannot import the coding agent — the tier cases in `server.test.ts`
// pin them. One agent-level file loads per session, first hit wins:
//
//   1. `workspace-copy` — `<project config dir>/agents/<name>/AGENTS.md`, for a
//      PACK agent only; any file at all (even empty) claims the tier;
//   2. `home` — `<homes>/home-<name>/AGENTS.md`, for a pack or user agent; it
//      claims the tier only when NON-EMPTY, so an empty file never hides the
//      sibling behind it;
//   3. the sibling `AGENTS.md` beside `agent.md` — the unset default.
//
// A project-tier agent has only the sibling: it belongs to one project, so it
// has no home and no workspace copy.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { agentHomeWorkspaceId, derivesAgentHome, GENERAL_AGENT_FILE } from "@dimension/sdk/general-agent";
import type { AgentHome, AgentInstructions, AgentSource, InstructionFile, InstructionsSaved } from "./contracts.js";
import { LEGACY_DIR, listAgents, pathsOf, type Roots, revisionOf, SaveRefused, WRITE_DIR } from "./store.js";

const AGENTS_MD = "AGENTS.md";
/** A generous ceiling on a standing-instructions file: a prompt, not a corpus. */
export const INSTRUCTIONS_MAX_BYTES = 200_000;

async function statFile(path: string): Promise<{ exists: boolean; bytes: number }> {
	try {
		const info = await stat(path);
		return { exists: info.isFile(), bytes: info.isFile() ? info.size : 0 };
	} catch {
		return { exists: false, bytes: 0 };
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** What a file holds now; "" when it is not there. */
async function contentOf(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

interface Candidate {
	readonly kind: InstructionFile["kind"];
	readonly path: string;
}

/** Where OMP looks for this agent's `AGENTS.md`, strongest first; the last entry is the sibling default. */
function candidatesFor(roots: Roots, source: AgentSource, name: string, agentFile: string): Candidate[] {
	const sibling: Candidate = { kind: source === "pack" ? "pack" : "agent-dir", path: join(dirname(agentFile), AGENTS_MD) };
	if (source === "workspace") return [sibling];
	const homes = pathsOf(roots.home)?.homes;
	const home: Candidate[] = homes === undefined ? [] : [{ kind: "home", path: join(homes, agentHomeWorkspaceId(name), AGENTS_MD) }];
	if (source === "user") return [...home, sibling];
	const projectDirs = roots.workspace === null ? [] : [...new Set([WRITE_DIR, LEGACY_DIR])].map(dir => join(roots.workspace as string, dir, "agents"));
	return [...projectDirs.map((dir): Candidate => ({ kind: "workspace-copy", path: join(dir, name, AGENTS_MD) })), ...home, sibling];
}

/**
 * Which file the agent runs by, exactly as OMP decides it: the first of the
 * strong tiers that holds an `AGENTS.md`, else the sibling (when it exists).
 */
async function resolveInstructions(roots: Roots, source: AgentSource, name: string, agentFile: string): Promise<{ files: InstructionFile[]; text: string }> {
	const candidates = candidatesFor(roots, source, name, agentFile);
	const stats = await Promise.all(candidates.map(candidate => statFile(candidate.path)));
	let winner = -1;
	for (const [index, candidate] of candidates.entries()) {
		const { exists, bytes } = stats[index] ?? { exists: false, bytes: 0 };
		const isSibling = index === candidates.length - 1;
		const holds = candidate.kind === "workspace-copy" ? exists : candidate.kind === "home" ? exists && bytes > 0 : isSibling && exists;
		if (holds) {
			winner = index;
			break;
		}
	}
	const files = candidates.map((candidate, index): InstructionFile => ({ ...candidate, ...(stats[index] ?? { exists: false, bytes: 0 }), wins: index === winner }));
	const text = winner < 0 ? "" : await readFile(candidates[winner]?.path ?? "", "utf8");
	return { files, text };
}

const TIER_RULES: Readonly<Record<AgentSource, string>> = {
	pack: "A pack agent runs by the first of these that applies: a project's own copy (any file there counts), then its home AGENTS.md when it is not empty, then the AGENTS.md its pack ships.",
	user: "Your agent runs by its home AGENTS.md when that is not empty (it follows the agent into every project), else by the AGENTS.md beside its agent.md.",
	workspace: "A project agent has no home: it runs by the AGENTS.md beside its agent.md, in this project.",
};

/** The agent home for a name — existing or still being typed (then: the user tier, where new agents land). */
export async function describeHome(roots: Roots, name: string): Promise<AgentHome> {
	const listed = (await listAgents(roots)).agents.find(agent => agent.name === name);
	const source: AgentSource = listed?.source ?? "user";
	const paths = pathsOf(roots.home);
	const homeId = agentHomeWorkspaceId(name);
	const canStandAtHome = source !== "workspace";
	// Mirrors the engine's registry (`managed-workspaces.ts`): a project agent has
	// no derived home, and one that names another `workspace.id` stands there instead.
	const foreign = !derivesAgentHome(name, listed?.workspaceId);
	const hasHome = canStandAtHome && !foreign;
	const folder = canStandAtHome && paths !== null ? join(paths.homes, homeId) : null;
	const agentFile = listed?.path ?? join(paths?.userAgents ?? "", name, GENERAL_AGENT_FILE);
	const { files, text } = await resolveInstructions(roots, source, name, agentFile);
	const folderExists = folder !== null && (await isDirectory(folder));

	let homeNote: string;
	if (!canStandAtHome) homeNote = "A project agent belongs to one project, so it has no home of its own.";
	else if (listed?.workspaceId === `agent-${name}`) {
		homeNote = `Its file names "${listed.workspaceId}" as its workspace, an id no registry knows (an older version of this page wrote it). Save it with Where it runs set to Its own home and it stands in ${homeId}.`;
	} else if (foreign) homeNote = `It names its own workspace, "${listed?.workspaceId}", so it runs there and has no home of its own.`;
	else if (paths === null) homeNote = `Its home is ${homeId}; where that lives is unknown, as the engine did not say where its home is.`;
	else homeNote = folderExists ? `Its home is ${homeId}; the folder exists.` : `Its home is ${homeId}; the engine creates the folder the first time the agent is opened, seeding it from the AGENTS.md beside agent.md.`;

	const editable = listed === undefined ? false : listed.editable;
	const targetFile: Pick<NonNullable<AgentInstructions["target"]>, "path" | "kind"> | null =
		listed === undefined || !listed.editable
			? null
			: source === "user" && folderExists
				? { path: join(folder ?? "", AGENTS_MD), kind: "home" }
				: { path: join(dirname(listed.path), AGENTS_MD), kind: "agent-dir" };
	// The revision a save must name: the target's path AND what it holds now, so a
	// write is refused both when the file changed and when the target moved (a
	// home provisioned since). The winning file was read above and is usually
	// that very file; the target is read again only when it is not.
	let target: AgentInstructions["target"] = null;
	if (targetFile !== null) {
		const current = targetFile.path === files.find(file => file.wins)?.path ? text : await contentOf(targetFile.path);
		target = { ...targetFile, revision: revisionOf(`${targetFile.path}\0${current}`) };
	}
	const note =
		listed === undefined
			? `${TIER_RULES.user} Save the agent first; its standing instructions can be written once it exists.`
			: listed.editable
				? `${TIER_RULES[source]} A save writes ${target?.kind === "home" ? "the home AGENTS.md" : "the AGENTS.md beside agent.md, which seeds the home on its first provisioning"}.`
				: `${TIER_RULES[source]} ${listed.readOnlyReason ?? "It is read-only here."}`;

	return {
		name,
		exists: listed !== undefined,
		source,
		homeId,
		canStandAtHome,
		hasHome,
		homeNote,
		folder: hasHome ? folder : null,
		folderExists: hasHome && folderExists,
		memoryRoom: foreign && listed?.workspaceId !== undefined ? listed.workspaceId : homeId,
		instructions: { files, text, editable, note, target },
	};
}

/**
 * Write the agent's standing instructions: the home `AGENTS.md` once the home
 * folder exists, else the sibling of `agent.md`. Atomic like `saveAgent`, and
 * guarded like it: `revision` is the one `describeHome` gave, and a save is
 * refused unless the target still has that path and that content. Only a
 * listed, editable agent has a target, and the path is derived from its name —
 * never taken from the caller.
 */
export async function saveInstructions(roots: Roots, name: string, text: string, revision: string): Promise<InstructionsSaved> {
	if (Buffer.byteLength(text) > INSTRUCTIONS_MAX_BYTES) throw new SaveRefused(`The instructions are over ${INSTRUCTIONS_MAX_BYTES / 1000} KB; a standing prompt should be far shorter.`);
	const { instructions } = await describeHome(roots, name);
	const { target } = instructions;
	if (target === null) throw new SaveRefused(instructions.editable ? `No agent named "${name}".` : instructions.note);
	if (target.revision !== revision) {
		throw new SaveRefused(`${name}'s standing instructions changed since they were opened here: the file was edited elsewhere, or its home was set up since, so a save would land somewhere else. Reopen them so nothing written since is lost.`);
	}
	const temp = join(dirname(target.path), `.${basename(target.path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		await mkdir(dirname(target.path), { recursive: true });
		await writeFile(temp, text === "" || text.endsWith("\n") ? text : `${text}\n`, { encoding: "utf8", flag: "wx" });
		await rename(temp, target.path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
	return { path: target.path, kind: target.kind };
}
