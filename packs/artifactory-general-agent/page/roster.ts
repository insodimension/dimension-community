// The roster the page draws: every agent the HOST knows (`agents/list`, which
// is live and carries the face, the switches and the capability counts) joined
// by name to the file the pack's server read (`list_agents`, which carries the
// tier, whether it may be rewritten and the draft). Pure: no React, no kit, so
// the rules read the same wherever they are drawn and the tests need no DOM.
import type { AgentSource, ListedAgent } from "../src/contracts";
import { type Block, parseExtra } from "../src/extra";
import type { AgentFact } from "./types";

export interface RosterAgent {
	readonly name: string;
	readonly fact?: AgentFact;
	readonly listed?: ListedAgent;
	readonly tier: AgentSource;
}

/** The host's record, in the tiers the files are read from. A pack's agent
 *  always names its plugin; `provenance: "local"` alone does not mean the
 *  user's own, because a pack linked from disk is `local` too. */
export function tierOfFact(fact: Pick<AgentFact, "provenance" | "pluginId">): AgentSource {
	if (fact.pluginId !== undefined) return "pack";
	if (fact.provenance === "local") return "user";
	if (fact.provenance === "workspace") return "workspace";
	return "pack";
}

/** Host facts first (their order is the catalog's), then files the host does
 *  not list (a project agent of a workspace the host is not showing). */
export function joinRoster(facts: readonly AgentFact[] | undefined, listed: readonly ListedAgent[] | undefined): RosterAgent[] {
	const files = new Map((listed ?? []).map(agent => [agent.name, agent]));
	const out: RosterAgent[] = [];
	const seen = new Set<string>();
	for (const fact of facts ?? []) {
		if (seen.has(fact.name)) continue;
		seen.add(fact.name);
		const file = files.get(fact.name);
		out.push({ name: fact.name, fact, ...(file !== undefined ? { listed: file } : {}), tier: file?.source ?? tierOfFact(fact) });
	}
	for (const file of listed ?? []) {
		if (seen.has(file.name)) continue;
		seen.add(file.name);
		out.push({ name: file.name, listed: file, tier: file.source });
	}
	return out;
}

/** The home page's filters. */
export type Facet = "all" | "yours" | "packs" | "project" | "off";

export const FACETS: readonly Facet[] = ["all", "yours", "packs", "project", "off"];

export const FACET_LABEL: Readonly<Record<Facet, string>> = {
	all: "All",
	yours: "Yours",
	packs: "From packs",
	project: "This project",
	off: "Off",
};

const FACET_TIER: Readonly<Partial<Record<Facet, AgentSource>>> = { yours: "user", packs: "pack", project: "workspace" };

/** Whether `agent` belongs under `facet`. `off` is the host's word: an agent
 *  the host lends no record for is not known to be off. */
export function inFacet(agent: RosterAgent, facet: Facet): boolean {
	if (facet === "all") return true;
	if (facet === "off") return agent.fact?.enabled === false;
	return agent.tier === FACET_TIER[facet];
}

export function facetCounts(agents: readonly RosterAgent[]): Record<Facet, number> {
	const counts = { all: 0, yours: 0, packs: 0, project: 0, off: 0 } satisfies Record<Facet, number>;
	for (const facet of FACETS) counts[facet] = agents.filter(agent => inFacet(agent, facet)).length;
	return counts;
}

/** The tier, as a person says it: the card's badge, in the filter pills' words. */
export const TIER_LABEL: Readonly<Record<AgentSource, string>> = {
	pack: "From a pack",
	user: "Yours",
	workspace: "This project",
};

/** Whether the page may rewrite this agent's file (and flip its switch). */
export function isEditable(agent: RosterAgent): boolean {
	return agent.tier !== "pack" && agent.listed?.editable !== false;
}

// ── what the extra text says ─────────────────────────────────────────────────

/** A scalar written in YAML, unquoted: `"Chief of Staff"` → `Chief of Staff`. */
function plain(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/** The value lines of a block: its inline value, or the `- item` lines under it. */
function listOf(block: Block): string[] | null {
	const inline = block.inline.trim();
	if (inline.startsWith("[") && inline.endsWith("]")) {
		const inner = inline.slice(1, -1).trim();
		return inner === "" ? [] : inner.split(",").map(plain);
	}
	if (inline !== "") return [plain(inline)];
	const items = block.lines
		.slice(1)
		.map(line => line.trim())
		.filter(line => line.startsWith("- "))
		.map(line => plain(line.slice(2)));
	return items.length > 0 ? items : null;
}

function blockAt(extra: string, path: string): Block | undefined {
	const [head, child] = path.split(".");
	const top = parseExtra(extra).blocks.find(block => block.key === head);
	if (child === undefined || top === undefined) return top;
	return top.children?.find(block => block.key === child);
}

/** A key of the extra text read as a list (`[a, b]`, `- a` lines or one
 *  scalar); `null` when the text does not set it, or sets it as a shape this
 *  reader does not read (a mapping) — Advanced shows it as written. */
export function extraList(extra: string, path: string): string[] | null {
	const block = blockAt(extra, path);
	if (block === undefined || block.children !== null) return null;
	return listOf(block);
}

/** A key of the extra text read as one scalar; `null` when it is not set as one. */
export function extraScalar(extra: string, path: string): string | null {
	const block = blockAt(extra, path);
	if (block === undefined || block.children !== null || block.inline.trim() === "") return null;
	return plain(block.inline);
}

/** A slug as a person reads it: `release-herald` → `Release herald`. */
export function humanize(slug: string): string {
	const words = slug.replace(/-+/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** What the agent is called on screen: the host's `title`, the file's own
 *  `title:`, else its name read as words. */
export function displayName(agent: RosterAgent): string {
	return agent.fact?.title ?? (agent.listed ? extraScalar(agent.listed.draft.extra, "title") : null) ?? humanize(agent.name);
}

/** An agent named by its id (a lineage entry), as a person reads it. */
export function titleOf(name: string, roster: readonly RosterAgent[]): string {
	const agent = roster.find(candidate => candidate.name === name);
	return agent === undefined ? humanize(name) : displayName(agent);
}

// ── the capabilities an agent is allowed ─────────────────────────────────────

/** One allowlist, in the manifest's three states: absent/`*` = every one,
 *  `[]` = none, a list = those. */
export type Allowlist = { readonly kind: "all" } | { readonly kind: "none" } | { readonly kind: "some"; readonly names: readonly string[] };

export type CapabilityKind = "skills" | "plugins" | "mcp" | "tools";

/** An agent's allowlist of one kind, off its draft: the drawn list, else the
 *  held text in Other settings (`*` or `[]`, a plugins list), else every one. */
export function allowlistOf(draft: { readonly tools: readonly string[]; readonly skills: readonly string[]; readonly mcp: readonly string[]; readonly extra: string }, kind: CapabilityKind): Allowlist {
	if (kind !== "plugins" && draft[kind].length > 0) return { kind: "some", names: draft[kind] };
	// A legacy flat `tools:` line is the same allowlist (FLAT_ALIASES), held in Other settings.
	const held = extraList(draft.extra, `capabilities.${kind}`) ?? (kind === "tools" ? extraList(draft.extra, "tools") : null);
	if (held === null) return { kind: "all" };
	if (held.length === 0) return { kind: "none" };
	if (held.length === 1 && held[0] === "*") return { kind: "all" };
	return { kind: "some", names: held };
}
