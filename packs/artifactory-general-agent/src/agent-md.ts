// The Forge's document: one General Agent draft, and the agent.md it writes.
//
// SHARED by the page (which shows these lines live on the agent's profile) and the
// server (which writes exactly these bytes in `save_agent`), so what the human
// watched being written is what lands on disk — one serializer, never two.
// It imports no package: the page bundle must not pull the SDK's YAML parser in.
//
// Field names and value sets mirror the canonical schema in
// omp/packages/coding-agent/src/config/agent-manifest.ts. That parser REJECTS
// unknown keys inside a known section, so the profile only ever emits keys the
// schema accepts, plus the two Dimension keys `@dimension/sdk/general-agent`
// reads beside it (`name`/`description`, and dimension#1042's `avatar`). Every
// other key the file carries travels as TEXT in `AgentDraft.extra` ("Everything
// else", `./extra`) and is written back untouched. It never emits `autonomy:` —
// a manifest with a trigger is a Loop, not an agent.
import { type Block, childLines, extraPaths, parseExtra, grantPathsIn, overlayExtra } from "./extra";

export type Personality = "default" | "friendly" | "pragmatic" | "none";
export type PromptMode = "replace" | "append";
export type Approval = "always-ask" | "write" | "yolo";
/** `inherit` = the file says nothing, so the host's own approval mode applies. */
export type ApprovalSetting = Approval | "inherit";
export type Thinking = "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type Habitat = "bound" | "home" | "ephemeral";
export type MemoryBackend = "inherit" | "engram" | "local" | "hindsight" | "mnemopi" | "off";
export type MemoryScope = "project" | "global";

export const PERSONALITIES: readonly Personality[] = ["default", "friendly", "pragmatic", "none"];
export const PROMPT_MODES: readonly PromptMode[] = ["replace", "append"];
export const THINKING_STEPS: readonly Thinking[] = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh"];
export const APPROVAL_SETTINGS: readonly ApprovalSetting[] = ["always-ask", "write", "yolo", "inherit"];
export const HABITATS: readonly Habitat[] = ["bound", "home", "ephemeral"];
export const MEMORY_BACKENDS: readonly MemoryBackend[] = ["inherit", "engram", "local", "hindsight", "mnemopi", "off"];
export const MEMORY_SCOPES: readonly MemoryScope[] = ["project", "global"];

export interface AgentDraft {
	/** Stable local identity; survives renames. */
	readonly key: string;
	name: string;
	description: string;
	/** The avatar id it wears (`avatar:`): a first-party vibr (`orb`, `nebula`,
	 *  `mochi`, …) or a contributed `plugin:<pack>/<id>` face. Which ids exist is
	 *  the HOST's roster (its vibrs plus the bridged presences it lends), so a face
	 *  added there is wearable here with no pack edit; the manifest parser checks
	 *  the id's shape. `""` = the file declares none, and hosts paint their
	 *  neutral agent face. A face with a skin or accent travels in `extra` as the
	 *  author wrote it. */
	vibr: string;
	/** The voice profile it speaks with (`voice:`): only a NAME, whose existence is
	 *  the engine's call at resolve time (an agent never fails to load for a missing
	 *  pack). Its own choice, the least specific one: a user or project setting
	 *  outranks it. `""` = the file declares none. */
	voice: string;
	personality: Personality;
	promptMode: PromptMode;
	thinking: Thinking;
	/** `engine.model`: the model patterns it runs on, first available wins.
	 *  Empty = the host's default model (key omitted). */
	models: string[];
	/** `capabilities.tools` allowlist. Empty = every tool (key omitted). */
	tools: string[];
	/** `capabilities.skills` allowlist. Empty = every skill (key omitted). */
	skills: string[];
	/** `capabilities.mcp` allowlist. Empty = every server (key omitted). */
	mcp: string[];
	memory: MemoryBackend;
	/** `project` = the agent recalls its own project; `global` = every project
	 *  (`workspace.reach: all`). Never `memory.*` — the recall scope is the
	 *  agent's reach grant. */
	memoryScope: MemoryScope;
	approval: ApprovalSetting;
	habitat: Habitat;
	/** `extends` — the agents whose brain this one composes from. */
	lineage: string[];
	/** The markdown body: the charter this agent runs by. */
	charter: string;
	/** Everything else: the YAML text of every manifest key the profile does not
	 *  draw — `title`, `engine.model`, `capabilities.control`, `routing`, `loop`,
	 *  … — and of any drawn key whose value it cannot draw (an avatar with a
	 *  skin, `thinkingLevel: auto`, a reach that lists workspaces). Written back
	 *  as the author wrote it. */
	extra: string;
}

/** The fields the WORKSHOP (the model, through `forge_propose`) may fill. The
 *  grant-class fields — `tools` (`capabilities.tools`), `mcp`
 *  (`capabilities.mcp`, which servers the agent may call), `approval`
 *  (`gate.approval`), `memoryScope` (`workspace.reach`, a cross-project grant),
 *  `habitat` (`workspace.policy`, where it works) and `lineage` (`extends`,
 *  which composes each base's WHOLE grant into this agent) — are deliberately
 *  absent: doc 58 §3, only a human gesture in the View changes them. `extra`
 *  IS proposable, minus every grant-class key it could carry (`grantPathsIn`):
 *  the proposal is refused, and never applied, if it names one. */
export const PROPOSABLE_FIELDS = [
	"name",
	"description",
	"charter",
	"vibr",
	"voice",
	"skills",
	"memory",
	"thinking",
	"personality",
	"extra",
] as const satisfies readonly (keyof AgentDraft)[];
export type ProposableField = (typeof PROPOSABLE_FIELDS)[number];
/** A workshop proposal: a name plus any subset of the proposable fields. */
export type AgentProposal = { name: string } & Partial<Pick<AgentDraft, ProposableField>>;

/** A voice profile name: kebab-case, the stem of its `<name>.yml` and the value of `voice:`. Mirrors the
 *  SDK's `VOICE_PROFILE_NAME`; a manifest that fails it does not load, so a draft is refused before a write. */
export const VOICE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * A name as it is typed: lowercase, anything that is not a letter or digit
 * becomes one dash. A trailing dash survives on purpose — the next keystroke
 * is usually the rest of `release-herald`.
 */
export function normalizeTypedName(raw: string): string {
	return raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+/, "")
		.slice(0, 64);
}

/**
 * A new agent. `promptMode` is `replace`, the manifest's own default: the
 * charter is the agent's whole persona. `append` would put it after the full
 * default CODING prompt — right for an agent that extends `coding`, wrong for a
 * CMO or a scribe (dimension#1355), so it is a choice the human makes.
 */
export function blankDraft(key: string): AgentDraft {
	return {
		key,
		name: "",
		description: "",
		vibr: "orb",
		voice: "",
		personality: "default",
		promptMode: "replace",
		thinking: "inherit",
		models: [],
		tools: [],
		skills: [],
		mcp: [],
		memory: "inherit",
		memoryScope: "project",
		approval: "always-ask",
		habitat: "bound",
		lineage: [],
		charter: "",
		extra: "",
	};
}

/** Whether two reads of the grant-class paths name the same ones. */
function sameGrants(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

/** Lay a workshop proposal over a draft: only the fields it names change, and
 *  `tools`/`approval`/`memoryScope`/`habitat`/`lineage` never do — whatever the
 *  object carries at runtime. `extra` is overlaid key by key, and not at all
 *  when it names a grant-class key. */
export function applyProposal(draft: AgentDraft, proposal: AgentProposal): AgentDraft {
	const next: AgentDraft = { ...draft };
	const patch = next as unknown as Record<ProposableField, unknown>;
	for (const field of PROPOSABLE_FIELDS) {
		const value = proposal[field];
		if (value === undefined || field === "extra") continue;
		patch[field] = Array.isArray(value) ? [...value] : value;
	}
	if (proposal.extra !== undefined && grantPathsIn(proposal.extra).length === 0) {
		// The overlay replaces a section the draft writes INLINE wholesale, so a proposal that names
		// no grant can still drop one it never named (`subagents: { allowed: [..] }` losing `allowed`
		// leaves the agent free to spawn anything). A merge that moves the grants the file holds is
		// refused exactly as one that names a grant is.
		const merged = overlayExtra(draft.extra, proposal.extra);
		if (sameGrants(grantPathsIn(merged), grantPathsIn(draft.extra))) next.extra = merged;
	}
	return next;
}

// ── the paths the profile draws ─────────────────────────────────────────────

/** The top-level keys the profile draws. */
const DRAWN_TOP: readonly string[] = ["name", "description", "avatar", "voice", "specVersion", "extends"];
/** The legacy flat spellings that fold into a key the profile draws. A file that uses one keeps
 *  it in Everything else, and the profile's own control for the key it folds into stands aside:
 *  the file's flat line is what the engine reads, and writing the nested key beside it is a
 *  manifest the engine refuses (`both 'tools' and 'capabilities.tools' set`). */
export const FLAT_ALIASES: Readonly<Record<string, string>> = {
	tools: "capabilities.tools",
	thinkingLevel: "engine.thinkingLevel",
	thinking: "engine.thinkingLevel",
	model: "engine.model",
};
/** The keys the profile draws inside each section it draws. */
export const DRAWN_CHILDREN: Readonly<Record<string, readonly string[]>> = {
	identity: ["personality", "prompt"],
	engine: ["thinkingLevel", "model"],
	capabilities: ["tools", "skills", "mcp"],
	gate: ["approval"],
	memory: ["backend"],
	workspace: ["policy", "id", "reach"],
};
/** The drawn paths Everything else may NOT carry: the profile's name,
 *  description, lineage and charter own them outright. Every other drawn path
 *  yields to a line the author wrote in Everything else (and its control says so). */
const FIXED_PATHS: Readonly<Record<string, true>> = {
	name: true,
	description: true,
	specVersion: true,
	extends: true,
	"identity.prompt": true,
};

/** Whether `path` is a key the profile draws — `true` for `avatar`, `gate.approval`, … */
export function isDrawnPath(path: string): boolean {
	const [head, child] = path.split(".");
	if (head === undefined) return false;
	if (child === undefined) return DRAWN_TOP.includes(head);
	return DRAWN_CHILDREN[head]?.includes(child) ?? false;
}

/** The profile-drawn paths Everything else holds in this draft: each one's
 *  control is set aside and says so, and the file keeps the author's line. */
export function heldByExtra(draft: Pick<AgentDraft, "extra">): Set<string> {
	const held = new Set<string>();
	for (const path of extraPaths(parseExtra(draft.extra).blocks)) {
		if (isDrawnPath(path) && FIXED_PATHS[path] === undefined) held.add(path);
		const folded = FLAT_ALIASES[path];
		if (folded !== undefined) held.add(folded);
	}
	return held;
}

/** Why the draft cannot be written yet; empty = it can. */
export function draftProblems(draft: AgentDraft): string[] {
	const problems: string[] = [];
	if (!NAME_RE.test(draft.name)) problems.push("Name it: 2–64 lowercase letters, digits or dashes.");
	if (draft.voice !== "" && !VOICE_NAME_RE.test(draft.voice)) problems.push("A voice is a profile name: lowercase letters, digits and single dashes.");
	if (draft.description.trim() === "") problems.push("Give it one line that says what it is for.");
	if (draft.charter.trim() === "") problems.push("Write its charter: the instructions it runs by.");
	problems.push(...manifestDocument(draft).problems);
	return problems;
}

// ── agent.md ────────────────────────────────────────────────────────────────

const PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9 _./@:+-]*$/;
const YAML_WORDS = /^(true|false|yes|no|on|off|null|~)$/i;

/** Whether YAML would read this plain text as a number (`2026`, `1e3`, `0x10`, `0o7`) and so not hand back
 *  the string that was written. A profile name, an agent name or a skill can be all digits. The SDK reads
 *  with `yaml` (1.2), so `1_000` stays a string and needs no quoting. */
function readsAsNumber(value: string): boolean {
	return value.trim() !== "" && !Number.isNaN(Number(value));
}

function scalar(value: string): string {
	if (PLAIN_SCALAR.test(value) && !YAML_WORDS.test(value) && !readsAsNumber(value) && !/:\s/.test(value) && !/\s$/.test(value)) return value;
	return JSON.stringify(value);
}

function list(values: readonly string[]): string {
	return `[${values.map(scalar).join(", ")}]`;
}

/** A named manifest line, so the View can flash exactly the lines a gesture changed. */
export interface ManifestLine {
	readonly text: string;
	/** Stable id of the field this line renders (`capabilities.tools`, `body`, …);
	 *  `extra.<key>` for a line of Everything else. */
	readonly field: string;
}

export interface ManifestDocument {
	readonly lines: ManifestLine[];
	/** Why the merged document is not one the Forge can write. */
	readonly problems: string[];
}

interface Unit {
	readonly key: string;
	/** A scalar key's own lines. */
	readonly lines?: readonly ManifestLine[];
	/** A section's children: each the lines of one key. */
	readonly children?: readonly { readonly key: string; readonly lines: readonly ManifestLine[] }[];
}

/**
 * The agent.md as lines: what the profile draws, merged with Everything else.
 *
 * `homeId` is the managed-workspace id of the agent's own home — the SDK's
 * `agentHomeWorkspaceId(name)`, which the SERVER supplies (the View cannot
 * bundle the SDK, and the spelling must exist once). Lives = home writes it as
 * `workspace.id`; without it a preview shows a placeholder and is never saved.
 */
export function manifestDocument(draft: AgentDraft, homeId?: string | null): ManifestDocument {
	const parsed = parseExtra(draft.extra);
	const problems: string[] = [];
	for (const stray of parsed.stray) problems.push(`Other settings must be \`key: value\` lines, not “${stray.trim()}”.`);
	if (draft.extra.split("\n").some(line => /^(---|\.\.\.)/.test(line))) problems.push("Other settings cannot hold a document separator (---).");
	const byKey = new Map<string, Block>(parsed.blocks.map(block => [block.key, block]));
	const held = extraPaths(parsed.blocks);
	const fixed = [...held].filter(path => FIXED_PATHS[path] !== undefined);
	for (const path of fixed) problems.push(`\`${path}\` is set on the profile itself (identity, lineage or charter). Remove it from Other settings.`);
	const yields = (path: string) => held.has(path) && FIXED_PATHS[path] === undefined;

	const line = (field: string, text: string): ManifestLine => ({ field, text });
	const units: Unit[] = [
		{ key: "name", lines: [line("name", `name: ${scalar(draft.name || "unnamed")}`)] },
		{ key: "description", lines: [line("description", `description: ${scalar(draft.description || "…")}`)] },
		{ key: "avatar", lines: draft.vibr === "" ? [] : [line("avatar", `avatar: ${scalar(draft.vibr)}`)] },
		{ key: "voice", lines: draft.voice === "" ? [] : [line("voice", `voice: ${scalar(draft.voice)}`)] },
		{ key: "specVersion", lines: [line("specVersion", "specVersion: 1")] },
	];
	if (draft.lineage.length > 0) units.push({ key: "extends", lines: [line("extends", `extends: ${list(draft.lineage)}`)] });

	const child = (path: string, text: string) => ({ key: path.split(".")[1] ?? path, lines: [line(path, text)] });
	const section = (key: string, children: readonly { key: string; lines: readonly ManifestLine[] }[]) => units.push({ key, children });

	section("identity", [
		...(draft.personality !== "default" ? [child("identity.personality", `  personality: ${draft.personality}`)] : []),
		child("identity.prompt", `  prompt: ${draft.promptMode}`),
	]);
	section("engine", [
		...(draft.thinking !== "inherit" ? [child("engine.thinkingLevel", `  thinkingLevel: ${draft.thinking}`)] : []),
		...(draft.models.length > 0 ? [child("engine.model", `  model: ${list(draft.models)}`)] : []),
	]);
	section("capabilities", [
		...(draft.tools.length > 0 ? [child("capabilities.tools", `  tools: ${list(draft.tools)}`)] : []),
		...(draft.skills.length > 0 ? [child("capabilities.skills", `  skills: ${list(draft.skills)}`)] : []),
		...(draft.mcp.length > 0 ? [child("capabilities.mcp", `  mcp: ${list(draft.mcp)}`)] : []),
	]);
	section("gate", draft.approval !== "inherit" ? [child("gate.approval", `  approval: ${draft.approval}`)] : []);
	section("memory", draft.memory !== "inherit" ? [child("memory.backend", `  backend: ${draft.memory}`)] : []);

	// Recall across every project is not a memory key: the agent's recall scope
	// follows its `workspace.reach` grant, so "Every project" writes
	// `reach: all` (and, with it, the control verbs' reach — the grant is one).
	// A memory-less agent has nothing to recall, so it never carries the grant.
	const reachAll = draft.memory !== "off" && draft.memoryScope === "global";
	// A `workspace:` section REQUIRES a policy (agent-manifest.ts): whenever Everything
	// else writes any key of it, the profile writes its own policy beside them.
	const extraWorkspace = (byKey.get("workspace")?.children?.length ?? 0) > 0 || (byKey.get("workspace")?.inline ?? "") !== "";
	section(
		"workspace",
		draft.habitat !== "bound" || reachAll || extraWorkspace
			? [
					child("workspace.policy", `  policy: ${draft.habitat}`),
					// `home` REQUIRES an id (agent-manifest.ts AgentWorkspacePolicy): the agent's
					// own derived home, which the engine registers as `home-<name>`.
					...(draft.habitat === "home" ? [child("workspace.id", `  id: ${scalar(homeId ?? "(its home id)")}`)] : []),
					...(reachAll ? [child("workspace.reach", "  reach: all")] : []),
				]
			: [],
	);

	const used = new Set<string>();
	const lines: ManifestLine[] = [line("fence", "---")];
	const pushAll = (field: string, texts: readonly string[]) => {
		for (const text of texts) lines.push(line(field, text));
	};
	for (const unit of units) {
		const block = byKey.get(unit.key);
		if (unit.lines !== undefined) {
			// A scalar the profile writes when set (`avatar`). A key the author wrote
			// in Everything else takes its place; the name and description never yield.
			if (block !== undefined && yields(unit.key)) {
				used.add(unit.key);
				pushAll(`extra.${unit.key}`, block.lines);
			} else {
				if (block !== undefined) used.add(unit.key);
				lines.push(...unit.lines);
			}
			continue;
		}
		const kept = (unit.children ?? []).filter(entry => !yields(`${unit.key}.${entry.key}`));
		if (block === undefined) {
			if (kept.length > 0) {
				lines.push(line(unit.key, `${unit.key}:`));
				for (const entry of kept) lines.push(...entry.lines);
			}
			continue;
		}
		used.add(unit.key);
		if (kept.length === 0) pushAll(`extra.${unit.key}`, block.lines);
		else if (block.children === null) {
			problems.push(`\`${unit.key}\` is written inline in Other settings, so the profile's own ${unit.key} settings cannot join it. Write its keys indented, one per line.`);
			lines.push(line(unit.key, `${unit.key}:`));
			for (const entry of kept) lines.push(...entry.lines);
		} else {
			lines.push(line(unit.key, `${unit.key}:`));
			for (const entry of kept) lines.push(...entry.lines);
			pushAll(`extra.${unit.key}`, childLines(block, 2));
		}
	}
	for (const block of parsed.blocks) if (!used.has(block.key)) pushAll(`extra.${block.key}`, block.lines);

	lines.push(line("fence", "---"));
	const body = draft.charter.trim() === "" ? ["…"] : draft.charter.replace(/\s+$/, "").split("\n");
	for (const text of body) lines.push(line("body", text));
	return { lines, problems };
}

export function manifestLines(draft: AgentDraft, homeId?: string | null): ManifestLine[] {
	return manifestDocument(draft, homeId).lines;
}

export function toAgentMd(draft: AgentDraft, homeId: string): string {
	return `${manifestLines(draft, homeId)
		.map(entry => entry.text)
		.join("\n")}\n`;
}
