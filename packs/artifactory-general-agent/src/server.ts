// The General Agents pack's MCP server (doc 45 §7): two model tools the
// Machinist speaks through, and the App-only tools the host-rendered General
// Agents page (`page/`, a `workspace-surface` component) calls through its
// seat's `artifactory:call` grant. There is no View: the page is drawn by the
// host, so no tool here carries a `ui://` resource.
//
// WHERE AGENTS ARE READ AND WRITTEN. The engine spawns this server ONCE per
// engine process, from the PLUGIN's root (`plugin-servers.ts`: `cwd: entry.cwd
// ?? root`), and lends it to every session; its environment carries the
// engine's home (`INSO_HOME`, `INSO_VAULT_DIR`, `INSO_ENV`) and its project
// config dir (`PI_CONFIG_DIR`) — `app-host.ts` `engineHomeEnv`. The HOME is
// enough for the tiers that matter: pack agents (`plugins/`) and the user's own
// General Agents (`agent/general-agents/`), where new agents are written and which have a home.
// A project's agents need a workspace, and a call's
// `_meta["ai.insodimension/session"]` names the session but not its workspace
// (`workspaceId` is reserved, never emitted). Two parties know it: the agent,
// which binds it for its session with `forge_open { workspace }`, and the page,
// which reads the active workspace off its fill props and passes it as the
// App-only tools' `workspace` argument (a host call from a sessionless seat
// carries no session at all). Without either the Forge is still whole: it lists
// pack and user agents and creates into the user tier. `DIMENSION_FORGE_WORKSPACE`,
// when set, is the fallback workspace (a harness spawning this over stdio, a test).
//
// SECURITY (doc 58 §3). `capabilities.tools`, `gate.approval`, `workspace.*`
// and the other grant-class keys (`capabilities.control`, `capabilities.plugins`,
// `capabilities.mcp`, `subagents.allowed`, `harness`, `allowedHarnesses`) change
// only by a human's gesture on the page; so do the two profile fields that carry
// one: `habitat` (`workspace.policy`, where the agent works) and `lineage`
// (`extends`, which composes each base's whole grant into the agent).
// `forge_propose` — the model's only way to shape a draft — has none of those
// fields in its schema (`mcp`, which servers the agent may call, is one: the
// user picks it on the page), refuses an Everything-else proposal that names
// one — read as text AND as the YAML it parses to, so no spelling of a key
// slips through — and copies only the proposable fields out of what it is given.
// The proposal is only STORED here: the page shows it as 'Proposed by the
// Machinist' and the human accepts or discards it. `save_agent` and the
// instructions writer are App-only, so the model cannot write a file at all.
//
// WHOSE PROPOSAL IT IS. This one server is lent to every session, so a stored
// proposal carries the workspace its session was bound to (`forge_open`, else the
// fallback), and `pending_proposals` hands a page only its own workspace's, plus
// those made with none. A proposal about project agent `reviewer` in one project
// never lands on another project's `reviewer`.
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import {
	APPROVAL_SETTINGS,
	HABITATS,
	MEMORY_BACKENDS,
	MEMORY_SCOPES,
	NAME_RE,
	PERSONALITIES,
	PROMPT_MODES,
	THINKING_STEPS,
} from "./agent-md.js";
import type { DraftCheck, ForgeOpened, ForgeProposed, PendingProposals, ProposalDismissed, SaveTarget, StoredProposal } from "./contracts.js";
import { grantPathsIn, grantPathsInDocument } from "./extra.js";
import { describeHome, INSTRUCTIONS_MAX_BYTES, saveInstructions } from "./home.js";
import { listParts } from "./parts.js";
import { listAgents, pathsOf, type Roots, renderDraft, SaveRefused, saveAgent, WRITE_DIR } from "./store.js";

/** The request `_meta` key the engine stamps the calling session under (`app-server.ts` `SESSION_META_KEY`). */
const SESSION_META_KEY = "ai.insodimension/session";

/** Callable by the host only (the page, through `artifactory:call`). */
const APP_ONLY = { ui: { visibility: ["app"] as const } };
/** Callable by the model only: nothing on the page calls these. */
const MODEL_ONLY = { ui: { visibility: ["model"] as const } };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
/** The proposals a server keeps at most; the oldest undecided one goes first. */
const MAX_PROPOSALS = 32;

const entry = z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/, "one line");
const names = z.array(entry).max(64);
const agentName = z.string().regex(NAME_RE, "2–64 lowercase letters, digits or dashes");

const draftSchema = z.object({
	key: z.string().min(1).max(200),
	name: z.string().max(64),
	description: z.string().max(400),
	vibr: z.string().max(120),
	voice: z.string().max(120).default(""),
	personality: z.enum(PERSONALITIES),
	promptMode: z.enum(PROMPT_MODES),
	thinking: z.enum(THINKING_STEPS),
	models: names,
	tools: names,
	skills: names,
	mcp: names,
	memory: z.enum(MEMORY_BACKENDS),
	memoryScope: z.enum(MEMORY_SCOPES),
	approval: z.enum(APPROVAL_SETTINGS),
	habitat: z.enum(HABITATS),
	lineage: z.array(agentName).max(16),
	charter: z.string().max(40_000),
	extra: z.string().max(40_000),
});

/** The page's own workspace, for a call that names it (a sessionless host call). */
const workspaceArg = z.string().min(1).max(1024).optional().describe("absolute path of the workspace whose project agents to include");

/** `forge_propose`'s schema: the proposable fields and NOTHING else. */
const proposalShape = {
	name: agentName.describe("the agent's name: lowercase letters, digits, dashes"),
	description: z.string().max(400).optional().describe("one line: what it is for"),
	charter: z.string().max(40_000).optional().describe("the instructions it runs by (the agent.md body), markdown"),
	vibr: z.string().max(120).optional().describe("the avatar id it wears — a vibr such as orb, nebula or mochi"),
	voice: z.string().max(120).optional().describe("the voice profile it speaks with, by name (lowercase letters, digits, dashes); the user's own choice for it outranks this"),
	skills: names.optional().describe("skill allowlist; omit to keep every skill"),
	memory: z.enum(MEMORY_BACKENDS).optional(),
	thinking: z.enum(THINKING_STEPS).optional(),
	personality: z.enum(PERSONALITIES).optional(),
	extra: z
		.string()
		.max(20_000)
		.optional()
		.describe(
			"YAML for manifest keys the profile does not draw — title, defaultListed, engine.model/profile/roles, routing, loop, memory.namespace, capabilities.autoloadSkills/slashCommands, subagents.maxDepth, … One `key: value` per line, sections indented two spaces. It is laid over the draft's own, key by key (a key it names that the profile also draws, like engine.model, is then held as written). Keys that GRANT — capabilities.tools/mcp/plugins/control/ignore/optIn, subagents.allowed, gate.*, workspace.*, harness, allowedHarnesses — are refused: only the user sets those.",
		),
};

function json(structuredContent: object, text: string): CallToolResult {
	return { content: [{ type: "text", text }], structuredContent: structuredContent as Record<string, unknown> };
}

function fail(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** A directory as one string, however it was spelled: symlinks and, on Windows, drive and folder case resolved. */
function canonicalDir(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}

/** Whether two workspaces (`null`: none) are the same directory. */
function sameWorkspace(a: string | null, b: string | null): boolean {
	if (a === null || b === null) return a === b;
	return canonicalDir(a) === canonicalDir(b);
}

function sessionOf(extra: { _meta?: Record<string, unknown> }): string {
	const meta = extra._meta?.[SESSION_META_KEY];
	if (typeof meta !== "object" || meta === null || !("sessionId" in meta)) return "";
	return typeof meta.sessionId === "string" ? meta.sessionId : "";
}

export interface ForgeServerOptions {
	/** Defaults to `process.env`: `INSO_HOME` locates the plugin store, the user's
	 *  agents and skills, and every agent home; `DIMENSION_FORGE_WORKSPACE` is the
	 *  fallback workspace. */
	readonly env?: NodeJS.ProcessEnv;
}

export function createForgeServer(options: ForgeServerOptions = {}): McpServer {
	const env = options.env ?? process.env;
	const home = env.INSO_HOME !== undefined && env.INSO_HOME !== "" ? env.INSO_HOME : null;
	const paths = pathsOf(home);
	const fallback = env.DIMENSION_FORGE_WORKSPACE !== undefined && isDirectory(env.DIMENSION_FORGE_WORKSPACE) ? resolve(env.DIMENSION_FORGE_WORKSPACE) : null;
	/** Session id → the workspace its agent named in `forge_open`. */
	const workspaces = new Map<string, string>();
	/** The Machinist's undecided proposals, oldest first; the page decides each. */
	const proposals: StoredProposal[] = [];

	/** The workspace the session behind a call bound with `forge_open`, else the fallback. */
	const boundWorkspace = (extra: { _meta?: Record<string, unknown> }): string | null => workspaces.get(sessionOf(extra)) ?? fallback;

	/** The roots a call resolves against: the workspace it names (the page), else
	 *  the one its session bound (the agent), else the fallback. A string is why
	 *  the named workspace cannot be used. */
	const rootsOf = (extra: { _meta?: Record<string, unknown> }, workspace?: string): Roots | string => {
		if (workspace !== undefined) {
			if (!isAbsolute(workspace) || !isDirectory(workspace)) return `${workspace} is not an existing absolute directory.`;
			return { workspace: resolve(workspace), home };
		}
		return { workspace: boundWorkspace(extra), home };
	};

	const server = new McpServer({ name: "dimension-community-general-agent", version: "0.4.0" });

	// ── the model's two doors ───────────────────────────────────────────────
	server.registerTool(
		"forge_open",
		{
			title: "General Agents",
			description: `Read the General Agents the user sees on the General Agents page (the rail's General Agents entry): every General Agent the installed packs ship, the user's own, and the workspace's, or one agent by name. \`workspace\` is optional: the absolute path of the directory you are working in, which adds that project's General Agents (\`<workspace>/${WRITE_DIR}/general-agents/<name>/agent.md\`) for the rest of this session. It writes nothing; to shape an agent, call forge_propose and the user decides on the page.`,
			inputSchema: {
				agent: agentName.optional().describe("read this agent"),
				workspace: z.string().min(1).max(1024).optional().describe("absolute path of your working directory"),
			},
			annotations: READ_ONLY,
			_meta: MODEL_ONLY,
		},
		async ({ agent, workspace }, extra) => {
			if (workspace !== undefined) {
				if (!isAbsolute(workspace) || !isDirectory(workspace)) return fail(`${workspace} is not an existing absolute directory.`);
				workspaces.set(sessionOf(extra), resolve(workspace));
			}
			const roots = rootsOf(extra);
			if (typeof roots === "string") return fail(roots);
			const listing = await listAgents(roots);
			const found = agent === undefined ? undefined : listing.agents.find(candidate => candidate.name === agent);
			const opened: ForgeOpened = { agent: found?.name ?? null, workspace: roots.workspace };
			const where = roots.workspace === null ? "no workspace (pack and user agents)" : roots.workspace;
			const text =
				agent !== undefined && found === undefined
					? `No General Agent named "${agent}" in ${where}. There are ${listing.agents.length}: ${listing.agents.map(listed => listed.name).join(", ")}.`
					: found !== undefined
						? `${found.name} (${found.source}, ${found.editable ? "editable" : "read-only"}) in ${where}: ${found.description}`
						: `${listing.agents.length} General Agents in ${where}: ${listing.agents.map(listed => `${listed.name} (${listed.source})`).join(", ")}.`;
			return json(opened, text);
		},
	);

	server.registerTool(
		"forge_propose",
		{
			title: "General Agent proposal",
			description:
				"Propose a General Agent draft to the user on the General Agents page, talk-to-build. Name it and give any of: description, charter, vibr, voice, skills, memory, thinking, personality, extra (YAML for the manifest keys the profile does not draw). The page of the workspace you bound with forge_open shows it on that agent's profile as proposed by the Machinist; the user accepts it, changes it, and saves it. Nothing is written by this call. A newer proposal for the same agent in the same workspace replaces the earlier one. A proposal cannot set anything that grants (the agent's tools, approval gate, workspace or where it works, the agents it extends, control lanes, plugins, MCP servers, delegation or harness): only the user sets those, on the profile.",
			inputSchema: proposalShape,
			_meta: MODEL_ONLY,
		},
		async (proposal, extra) => {
			// The SCHEMA is the guard for fields: `proposalShape` declares no `tools`, no
			// `mcp`, no `approval`, no `autonomy`, and the SDK strips undeclared keys
			// before this runs. `extra` is free text, so it is read here, twice: as text
			// (the lines the page can also place) and as the YAML it parses to (the keys
			// the engine will read, whatever their spelling). A grant-class key in
			// either refuses the whole proposal, and so does YAML that is not a mapping.
			if (proposal.extra !== undefined) {
				const textual = grantPathsIn(proposal.extra);
				if (textual.length > 0) {
					return fail(`A proposal cannot set ${textual.join(", ")}: those grant the agent something, so only the user sets them, on the General Agents page. Propose the rest.`);
				}
				let parsed: unknown;
				try {
					parsed = parseYaml(proposal.extra);
				} catch (error) {
					return fail(`extra is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) return fail("extra must be a YAML mapping: one `key: value` per line.");
				const resolved = grantPathsInDocument(parsed);
				if (resolved.length > 0) {
					return fail(`A proposal cannot set ${resolved.join(", ")}: those grant the agent something, so only the user sets them, on the General Agents page. Propose the rest.`);
				}
			}
			// One undecided proposal per agent per workspace: a second one for the same
			// name replaces the first under a fresh id, so the page shows it again.
			const workspace = boundWorkspace(extra);
			const stored: StoredProposal = { id: randomUUID(), proposal, at: Date.now(), workspace };
			const earlier = proposals.findIndex(candidate => candidate.proposal.name === proposal.name && sameWorkspace(candidate.workspace, workspace));
			if (earlier >= 0) proposals.splice(earlier, 1);
			proposals.push(stored);
			if (proposals.length > MAX_PROPOSALS) proposals.splice(0, proposals.length - MAX_PROPOSALS);
			const proposed: ForgeProposed = { id: stored.id, proposal };
			const fields = Object.keys(proposal).filter(field => field !== "name");
			return json(
				proposed,
				`Proposed ${proposal.name} on the General Agents page${fields.length > 0 ? ` (${fields.join(", ")})` : ""}. The user accepts or discards it there; nothing is written until they save it. Anything that grants (tools, the approval gate, workspace, control lanes) is theirs to set.`,
			);
		},
	);

	// ── the page's doors (App-only) ─────────────────────────────────────────
	server.registerTool(
		"pending_proposals",
		{
			description: "The Machinist's proposals the user has not accepted or discarded yet for the page's workspace (those made in it, and those made with no workspace), oldest first.",
			inputSchema: { workspace: workspaceArg },
			annotations: READ_ONLY,
			_meta: APP_ONLY,
		},
		async ({ workspace }, extra) => {
			const roots = rootsOf(extra, workspace);
			if (typeof roots === "string") return fail(roots);
			const here = roots.workspace;
			const pending: PendingProposals = { proposals: proposals.filter(candidate => candidate.workspace === null || (here !== null && sameWorkspace(candidate.workspace, here))) };
			return json(pending, `${pending.proposals.length} pending`);
		},
	);

	server.registerTool(
		"dismiss_proposal",
		{
			description: "The user decided on a proposal (accepted it into a draft, or discarded it): it is no longer pending.",
			inputSchema: { id: z.string().min(1).max(64) },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			_meta: APP_ONLY,
		},
		async ({ id }) => {
			const at = proposals.findIndex(candidate => candidate.id === id);
			if (at >= 0) proposals.splice(at, 1);
			const dismissed: ProposalDismissed = { dismissed: at >= 0 };
			return json(dismissed, at >= 0 ? "Dismissed" : "Not pending");
		},
	);

	server.registerTool(
		"list_agents",
		{
			description: "Every General Agent the page can see (installed packs', the user's own, the workspace's), each with its tier and marked editable or read-only.",
			inputSchema: { workspace: workspaceArg },
			annotations: READ_ONLY,
			_meta: APP_ONLY,
		},
		async ({ workspace }, extra) => {
			const roots = rootsOf(extra, workspace);
			if (typeof roots === "string") return fail(roots);
			const listing = await listAgents(roots);
			return json(listing, `${listing.agents.length} agents`);
		},
	);

	server.registerTool(
		"list_parts",
		{
			description: "The skills, MCP servers, tool names and memory backends the profile can offer, with where each list was read and what could not be.",
			inputSchema: { workspace: workspaceArg },
			annotations: READ_ONLY,
			_meta: APP_ONLY,
		},
		async ({ workspace }, extra) => {
			const roots = rootsOf(extra, workspace);
			if (typeof roots === "string") return fail(roots);
			const { agents } = await listAgents(roots);
			const listing = await listParts({ workspace: roots.workspace, pluginsDir: paths?.plugins ?? null, agentDir: paths?.agent ?? null, agents });
			return json(listing, `${listing.parts.length} parts`);
		},
	);

	server.registerTool(
		"validate_agent",
		{
			description: "Whether the draft would save: its own problems, then whether the agent.md it writes loads as a General Agent. Writes nothing.",
			inputSchema: { draft: draftSchema },
			annotations: READ_ONLY,
			_meta: APP_ONLY,
		},
		async ({ draft }) => {
			const rendered = renderDraft(draft, join(draft.name, "agent.md"));
			const check: DraftCheck = { problems: "problems" in rendered ? rendered.problems : [] };
			return json(check, check.problems.length === 0 ? "It would save." : check.problems.join(" "));
		},
	);

	server.registerTool(
		"save_agent",
		{
			description: `Write the draft. \`create: true\` writes a NEW General Agent into the user's own \`$INSO_HOME/agent/general-agents/<name>/agent.md\` by default, or into \`<workspace>/${WRITE_DIR}/general-agents/<name>/agent.md\` when \`tier: workspace\` is given, and refuses a name taken anywhere. \`create: false\` rewrites the agent of that name in \`tier\` (\`user\` or \`workspace\`) and is refused unless \`revision\` is the one list_agents gave. The merged agent.md must load as a General Agent or nothing is written.`,
			inputSchema: { draft: draftSchema, create: z.boolean(), tier: z.enum(["workspace", "user"]).optional(), revision: z.string().max(64).optional(), workspace: workspaceArg },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			_meta: APP_ONLY,
		},
		async ({ draft, create, tier, revision, workspace }, extra) => {
			let target: SaveTarget;
			if (create) target = { create: true, ...(tier !== undefined ? { tier } : {}) };
			else if (tier !== undefined && revision !== undefined) target = { create: false, tier, revision };
			else return fail("Rewriting an agent names its tier and its revision; both come from list_agents.");
			const roots = rootsOf(extra, workspace);
			if (typeof roots === "string") return fail(roots);
			try {
				const outcome = await saveAgent({ roots, draft, target });
				return json(outcome, `Wrote ${outcome.relativePath}`);
			} catch (error) {
				if (error instanceof SaveRefused) return fail(error.message);
				throw error;
			}
		},
	);

	server.registerTool(
		"agent_home",
		{
			description: "An agent's home: its id (home-<name>), its folder under the engine's workspaces, whether the engine registers it, the memory room it follows, and its standing instructions (every AGENTS.md OMP looks at, which one wins, what it holds, and the `revision` of the file a save would write, which `save_instructions` needs). Works for a name that does not exist yet (the user tier, where new agents land).",
			inputSchema: { name: agentName, workspace: workspaceArg },
			annotations: READ_ONLY,
			_meta: APP_ONLY,
		},
		async ({ name, workspace }, extra) => {
			const roots = rootsOf(extra, workspace);
			if (typeof roots === "string") return fail(roots);
			const described = await describeHome(roots, name);
			return json(described, `${name}: ${described.homeNote}`);
		},
	);

	server.registerTool(
		"save_instructions",
		{
			description: "Write an agent's standing instructions: its home AGENTS.md once the home folder exists, otherwise the AGENTS.md beside its agent.md (which seeds the home on its first provisioning). Only for a user or workspace agent the page may edit; the path is derived, never given. `revision` is the target's revision from agent_home: the write is refused unless the file still holds what it held then and the home has not been set up since (a save would land elsewhere), so nothing written meanwhile is lost.",
			inputSchema: { name: agentName, text: z.string().max(INSTRUCTIONS_MAX_BYTES), revision: z.string().max(64), workspace: workspaceArg },
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			_meta: APP_ONLY,
		},
		async ({ name, text, revision, workspace }, extra) => {
			const roots = rootsOf(extra, workspace);
			if (typeof roots === "string") return fail(roots);
			try {
				const saved = await saveInstructions(roots, name, text, revision);
				return json(saved, `Wrote ${saved.path}`);
			} catch (error) {
				if (error instanceof SaveRefused) return fail(error.message);
				throw error;
			}
		},
	);

	return server;
}
