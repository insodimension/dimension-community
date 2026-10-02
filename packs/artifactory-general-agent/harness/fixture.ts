// The design harness's host: a fenced Store with the facts the real host
// publishes (agents/list, sessions/list, agents/usage, capabilities/catalog,
// models) and a `call` door that answers the pack's App-only tools from
// memory. Nothing here ships; `bun run dev` serves it for design review.
//
// `?state=` picks what the page meets: home (default) · empty · loading ·
// error (the files cannot be read) · proposal (the Machinist proposed two
// drafts). `&call=off` is a host that grants no `artifactory:call`.
import { type AgentDraft, blankDraft, draftProblems } from "../src/agent-md";
import type { AgentHome, AgentListing, AgentSource, InstructionFile, ListedAgent, StoredProposal } from "../src/contracts";
import type { AgentFact, CatalogFact, ModelFact, PageStore, SessionRow, UsageFact } from "../page/types";
import { type Observable, observable } from "./observable";

const HOME = "~/.inso";
const PROJECT = "~/code/storefront";

interface Seed {
	readonly source: AgentSource;
	readonly pack?: string;
	readonly draft: Partial<AgentDraft> & Pick<AgentDraft, "name" | "description" | "charter">;
	readonly fact: { readonly enabled: boolean; readonly listed: boolean; readonly title?: string; readonly avatar?: AgentFact["avatar"] };
	readonly instructions?: string;
}

const SEEDS: readonly Seed[] = [
	{
		source: "user",
		draft: {
			name: "release-herald",
			description: "Writes the changelog and the release notes in my voice, from what actually merged",
			vibr: "orb",
			voice: "calm",
			habitat: "home",
			memory: "engram",
			thinking: "medium",
			models: ["anthropic/claude-sonnet-4.5", "openai/gpt-5.1"],
			tools: ["read", "grep", "glob", "bash", "palace"],
			skills: ["checkpoint", "code-health"],
			mcp: ["palace"],
			approval: "write",
			lineage: ["coding"],
			charter:
				"You write the changelog and the release notes.\n\n- Read the merged pull requests, never the branch names.\n- One line per change, in the past tense.\n- Never invent a change; when unsure, ask.",
		},
		fact: { enabled: true, listed: true, avatar: { id: "orb" } },
		instructions: "Keep entries under 100 characters. Group by area: Desktop, Engine, Packs.",
	},
	{
		source: "user",
		draft: {
			name: "cmo",
			description: "Runs the marketing desk: positioning, launches and the weekly growth review",
			vibr: "",
			voice: "bright",
			personality: "pragmatic",
			memory: "engram",
			approval: "always-ask",
			skills: ["cmo-onboarding", "positioning", "launch-plan", "growth-review"],
			charter: "You run the marketing desk. Every claim you make about the product is one you have checked.",
			extra: [
				"title: Chief Marketing Officer",
				"avatar:",
				"  id: mochi",
				"  skin: pearl",
				"  accent: coral",
				"capabilities:",
				"  control: [observe, create, agents]",
				"  plugins: [browser, reach]",
				"routing:",
				"  card: Marketing, positioning and launch questions",
			].join("\n"),
		},
		fact: { enabled: true, listed: true, title: "Chief Marketing Officer", avatar: { id: "mochi", skin: "pearl", accent: "coral" } },
	},
	{
		source: "user",
		draft: {
			name: "x-agent",
			description: "Posts and replies on X for the launch, in the brand's voice",
			vibr: "plugin:traction-vibrs/x-vibr",
			tools: ["read", "browser"],
			skills: ["x-posting"],
			charter: "You post on X. Short, specific, never hype.",
		},
		fact: { enabled: true, listed: true, title: "X", avatar: { id: "plugin:traction-vibrs/x-vibr" } },
	},
	{
		source: "user",
		draft: {
			name: "scribe",
			description: "The workspace writer: terse, precise, dated entries",
			vibr: "static",
			personality: "pragmatic",
			tools: ["read", "write", "palace"],
			charter: "You write terse, precise, dated entries. No filler.",
		},
		fact: { enabled: false, listed: true, avatar: { id: "static" } },
	},
	{
		source: "workspace",
		draft: {
			name: "reviewer",
			description: "Reviews this storefront's pull requests for correctness, security and style",
			vibr: "quasar",
			thinking: "xhigh",
			tools: ["read", "grep", "glob", "lsp"],
			skills: ["code-health"],
			lineage: ["coding"],
			approval: "always-ask",
			charter: "You review changes for correctness, security and the storefront's standards. Every finding carries evidence.",
		},
		fact: { enabled: true, listed: true, avatar: { id: "quasar" } },
	},
	{
		source: "pack",
		pack: "dimension-agents",
		draft: {
			name: "machinist",
			description: "The workbench's own engineer, who configures loops, model profiles, plugins, skills and MCP servers",
			vibr: "cube",
			habitat: "home",
			memory: "engram",
			tools: ["read", "bash", "loop", "models"],
			skills: ["autonomy", "model-intel"],
			approval: "write",
			charter: "You configure the machine: loops, model roles and profiles, plugins, marketplaces and MCP servers.\n\nYou never do the user's project work.",
		},
		fact: { enabled: true, listed: true, title: "Machinist", avatar: { id: "cube" } },
		instructions: "Prefer the smallest configuration change that works. Explain every grant you ask for.",
	},
	{
		source: "pack",
		pack: "dimension-agents",
		draft: {
			name: "coding",
			description: "The Code space's default agent, which works the repository you opened",
			vibr: "lattice",
			thinking: "high",
			skills: ["code-health", "checkpoint"],
			approval: "always-ask",
			promptMode: "append",
			charter: "You work the repository this session was opened in. Read before you edit, prove before you claim.",
		},
		fact: { enabled: true, listed: true, title: "Coding", avatar: { id: "lattice" } },
	},
	{
		source: "pack",
		pack: "dimension-agents",
		draft: {
			name: "aether",
			description: "Your personal companion across every project, with memory that spans all of them",
			vibr: "aurora",
			personality: "friendly",
			memory: "engram",
			memoryScope: "global",
			charter: "You are the person's companion across every project. Remember what matters; bring it back when it helps.",
			extra: "workspace:\n  policy: pinned\n  id: inso-personal",
		},
		fact: { enabled: true, listed: false, title: "Aether", avatar: { id: "aurora" } },
	},
];

const CATALOG: CatalogFact = {
	plugins: [
		{ id: "browser", name: "browser", title: "Browser", description: "A real browser beside your chat that your agent drives while you watch.", icon: "globe", kind: "artifactory", enabled: true },
		{ id: "reach", name: "reach", title: "Reach", description: "Post and read across social platforms from one place.", icon: "send", kind: "connector", enabled: true },
		{ id: "palace", name: "palace", title: "Memory Palace", description: "Durable notes, a task board and an encrypted locker.", icon: "book", kind: "agentPlugin", enabled: true },
		{ id: "traction-ui", name: "traction-ui", title: "Traction UI", description: "Traction's rail, team chat and start surface.", icon: "chat", kind: "component", enabled: false },
		{ id: "dimension-agents", name: "dimension-agents", title: "Dimension Agents", description: "The agents Dimension ships: Coding, Machinist, Aether.", icon: "bot", kind: "generalAgent", enabled: true },
	],
	skills: [
		{ name: "checkpoint", description: "Session closeout and handoff: what changed, what is next." },
		{ name: "code-health", description: "Evidence, simplify, review, prove. The repo's quality loop." },
		{ name: "autonomy", description: "Create and operate autonomies.", pluginId: "dimension-agents" },
		{ name: "model-intel", description: "Live model rankings and profiles.", pluginId: "dimension-agents" },
		{ name: "positioning", description: "Positioning statements that survive a skeptical read." },
		{ name: "launch-plan", description: "A launch plan from the first tease to the retro." },
		{ name: "growth-review", description: "The weekly growth review: numbers first, stories second." },
		{ name: "cmo-onboarding", description: "Onboards a CMO to the product and its market.", pluginId: "reach" },
		{ name: "x-posting", description: "Writes and schedules posts for X.", pluginId: "reach" },
		{ name: "officecli", description: "Word, Excel and PowerPoint from the command line." },
	],
	mcp: [
		{ name: "palace", description: "The Memory Palace App", pluginId: "palace", status: "connected" },
		{ name: "browser", description: "A shared browser App", pluginId: "browser", status: "connected" },
		{ name: "github", description: "Issues, pull requests and reviews", status: "connected" },
		{ name: "linear", description: "Issues and cycles", status: "needs sign-in" },
	],
	tools: [
		...["read", "edit", "write", "bash", "grep", "glob", "lsp", "task", "todo", "web_search", "loop", "models"].map(name => ({ name, source: "builtin" as const, description: `The built-in ${name} tool.` })),
		{ name: "palace", source: "plugin", pluginId: "palace", description: "Read and write Memory Palace notes." },
		{ name: "browser", source: "plugin", pluginId: "browser", description: "Drive the shared browser." },
	],
};

const MODELS: readonly ModelFact[] = [
	{ providerId: "anthropic", providerName: "Anthropic", modelId: "claude-sonnet-4.5", label: "Claude Sonnet 4.5", available: true, reasoning: true, contextWindow: 1_000_000 },
	{ providerId: "anthropic", providerName: "Anthropic", modelId: "claude-opus-4.1", label: "Claude Opus 4.1", available: true, reasoning: true, contextWindow: 200_000 },
	{ providerId: "openai", providerName: "OpenAI", modelId: "gpt-5.1", label: "GPT-5.1", available: true, reasoning: true, contextWindow: 400_000 },
	{ providerId: "google", providerName: "Google", modelId: "gemini-2.5-pro", label: "Gemini 2.5 Pro", available: false, reasoning: true, contextWindow: 1_000_000 },
	{ providerId: "xai", providerName: "xAI", modelId: "grok-4", label: "Grok 4", available: true, reasoning: true, contextWindow: 256_000 },
];

function pathOf(seed: Seed): string {
	const name = seed.draft.name;
	if (seed.source === "pack") return `${HOME}/plugins/${seed.pack}/general-agents/${name}/agent.md`;
	if (seed.source === "user") return `${HOME}/agent/agents/${name}/agent.md`;
	return `${PROJECT}/.inso/agents/${name}/agent.md`;
}

function listedOf(seed: Seed): ListedAgent {
	const draft: AgentDraft = { ...blankDraft(`${seed.source}:${seed.pack ?? ""}:${seed.draft.name}`), vibr: "", ...seed.draft };
	return {
		name: draft.name,
		description: draft.description,
		source: seed.source,
		...(seed.pack !== undefined ? { pack: seed.pack } : {}),
		path: pathOf(seed),
		editable: seed.source !== "pack",
		...(seed.source === "pack" ? { readOnlyReason: `It ships in the ${seed.pack} pack.` } : { revision: "harness" }),
		draft,
	};
}

function factOf(seed: Seed): AgentFact {
	const draft = listedOf(seed).draft;
	const count = (list: readonly string[]) => (list.length === 0 ? ("all" as const) : list.length);
	return {
		name: seed.draft.name,
		description: seed.draft.description,
		...(seed.fact.title ? { title: seed.fact.title } : {}),
		provenance: seed.source === "pack" ? "dimension" : seed.source === "user" ? "local" : "workspace",
		...(seed.pack ? { pluginId: seed.pack } : {}),
		enabled: seed.fact.enabled,
		listed: seed.fact.listed,
		...(seed.fact.avatar ? { avatar: seed.fact.avatar } : {}),
		capabilities: { tools: count(draft.tools), skills: count(draft.skills), mcp: count(draft.mcp), plugins: "all" },
		...(seed.source !== "workspace" ? { homeWorkspaceId: `home-${seed.draft.name}` } : {}),
	};
}

function homeOf(seed: Seed | undefined, name: string): AgentHome {
	const source = seed?.source ?? "user";
	const homeId = `home-${name}`;
	const canStandAtHome = source !== "workspace";
	const folder = canStandAtHome ? `${HOME}/workspaces/${homeId}` : null;
	const text = seed?.instructions ?? "";
	const dir = seed === undefined ? `${HOME}/agent/agents/${name}` : pathOf(seed).replace(/\/agent\.md$/, "");
	const files: InstructionFile[] = [
		...(source === "pack" ? [{ kind: "workspace-copy" as const, path: `${PROJECT}/.inso/agents/${name}/AGENTS.md`, exists: false, bytes: 0, wins: false }] : []),
		...(canStandAtHome ? [{ kind: "home" as const, path: `${folder}/AGENTS.md`, exists: text !== "", bytes: text.length, wins: text !== "" }] : []),
		{ kind: source === "pack" ? "pack" : "agent-dir", path: `${dir}/AGENTS.md`, exists: text === "", bytes: 0, wins: text === "" },
	];
	return {
		name,
		exists: seed !== undefined,
		source,
		homeId,
		canStandAtHome,
		hasHome: canStandAtHome,
		homeNote: canStandAtHome ? `Its home is ${homeId}; the engine sets it up on its first session.` : "A project's own agent belongs to that project and has no home of its own.",
		folder,
		folderExists: canStandAtHome && seed?.source !== "workspace",
		memoryRoom: canStandAtHome ? homeId : "storefront",
		instructions: {
			files,
			text,
			editable: source !== "pack" && seed !== undefined,
			note: source === "pack" ? "A pack agent's instructions ship with its pack. A project copy, or its home AGENTS.md, takes their place." : "One file loads per session: the first of these that holds text.",
			target: source === "pack" || seed === undefined ? null : { path: files[0]?.path ?? "", kind: canStandAtHome ? "home" : "agent-dir", revision: "harness" },
		},
	};
}

const HOUR = 60 * 60 * 1000;

function sessions(now: number): SessionRow[] {
	const row = (id: string, profile: string | undefined, hoursAgo: number, extra: Partial<SessionRow> = {}): SessionRow => ({
		ref: { sessionId: id },
		...(profile !== undefined ? { profile } : {}),
		updatedAt: new Date(now - hoursAgo * HOUR).toISOString(),
		...extra,
	});
	return [
		row("s1", "release-herald", 3),
		row("s2", "release-herald", 30),
		row("s3", "release-herald", 50, { continuedInto: { toSessionId: "s4" } }),
		row("s4", "release-herald", 49, { continuedFrom: "s3" }),
		row("s5", "cmo", 0.2, { liveStatus: "running" }),
		row("s6", "cmo", 20),
		row("s7", "cmo", 1, { blockedOnInput: true }),
		row("r1", undefined, 5, { kind: "room", roomAuthority: "cmo" }),
		row("r2", undefined, 9, { kind: "room", roomAuthority: "cmo" }),
		row("s8", undefined, 2),
		row("s9", undefined, 26),
		row("s10", undefined, 200),
		row("s11", "reviewer", 72),
		row("s12", "machinist", 0.1, { liveStatus: "running" }),
		row("a1", "machinist", 10, { source: "autonomy" }),
		row("s13", "x-agent", 5),
	];
}

/** `voiceCells`: the voice lane's facts (`./voice-fixture`), merged beside the host's own. */
export function fixtureStore(params: URLSearchParams, voiceCells: ReadonlyMap<string, Observable<unknown>>): PageStore {
	const state = params.get("state") ?? "home";
	let seeds: Seed[] = state === "empty" ? [] : [...SEEDS];
	const now = Date.now();
	const facts = observable<readonly AgentFact[]>(state === "loading" ? undefined : seeds.map(factOf));
	const cells = new Map<string, Observable<unknown>>([
		["agents/list", facts as Observable<unknown>],
		["sessions/list", observable<unknown>(state === "empty" ? [] : sessions(now))],
		[
			"agents/usage",
			observable<unknown>({
				range: "7d",
				updatedAt: now - 4 * 60 * 1000,
				agents: [
					{ name: "release-herald", tokens: 412_300, cost: 3.84, turns: 41 },
					{ name: "cmo", tokens: 1_284_000, cost: 12.6, turns: 118 },
					{ name: "coding", tokens: 2_950_000, cost: 21.4, turns: 260 },
					{ name: "machinist", tokens: 88_000, cost: 0.71, turns: 9 },
					{ name: "reviewer", tokens: 64_000, cost: 0.52, turns: 6 },
					{ name: "x-agent", tokens: 9_400, cost: 0.08, turns: 3 },
				],
			} satisfies UsageFact),
		],
		["capabilities/catalog", observable<unknown>(CATALOG)],
		["models", observable<unknown>(MODELS)],
	]);
	let proposals: StoredProposal[] =
		state === "proposal"
			? [
					{ id: "p1", at: now - 60_000, workspace: null, proposal: { name: "release-herald", description: "Writes the changelog, the release notes and the launch post", skills: ["checkpoint", "code-health", "launch-plan"], thinking: "high" } },
					{ id: "p2", at: now - 30_000, workspace: null, proposal: { name: "data-scout", description: "Finds the numbers behind a claim and cites them", vibr: "nebula", charter: "You find the numbers behind a claim and cite every source." } },
				]
			: [];
	const publish = () => facts.set(seeds.map(factOf));
	const tool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
		await new Promise(resolve => setTimeout(resolve, 120));
		switch (name) {
			case "list_agents": {
				if (state === "error") throw new Error("The pack's server did not answer (it is still starting).");
				const listing: AgentListing = { workspace: PROJECT, configDir: ".inso", userAgentsDir: `${HOME}/agent/agents`, agents: seeds.map(listedOf), notices: [] };
				return listing;
			}
			case "validate_agent":
				return { problems: draftProblems(args.draft as AgentDraft).filter(problem => !problem.startsWith("Name it") && !problem.startsWith("Give it") && !problem.startsWith("Write its")) };
			case "save_agent": {
				const draft = args.draft as AgentDraft;
				const existing = seeds.findIndex(seed => seed.draft.name === draft.name);
				const seed: Seed = { source: existing >= 0 ? (seeds[existing]?.source ?? "user") : "user", draft, fact: { enabled: true, listed: true, avatar: { id: draft.vibr || "nebula" } } };
				if (existing >= 0) seeds[existing] = { ...seeds[existing], ...seed } as Seed;
				else seeds = [...seeds, seed];
				publish();
				return { path: pathOf(seed), relativePath: `agent/agents/${draft.name}/agent.md`, created: existing < 0, tier: "user" };
			}
			case "agent_home":
				return homeOf(
					seeds.find(seed => seed.draft.name === args.name),
					String(args.name),
				);
			case "save_instructions": {
				const at = seeds.findIndex(seed => seed.draft.name === args.name);
				if (at >= 0) seeds[at] = { ...(seeds[at] as Seed), instructions: String(args.text) };
				return { path: `${HOME}/workspaces/home-${args.name}/AGENTS.md`, kind: "home" };
			}
			case "pending_proposals":
				return { proposals };
			case "dismiss_proposal": {
				const before = proposals.length;
				proposals = proposals.filter(entry => entry.id !== args.id);
				return { dismissed: proposals.length < before };
			}
			default:
				throw new Error(`${name} is not one of this pack's tools`);
		}
	};
	return {
		watch: <T>(key: string) => (voiceCells.get(key) ?? cells.get(key) ?? observable<unknown>(undefined)) as unknown as ReturnType<PageStore["watch"]> & { getSnapshot(): T | undefined },
		...(params.get("call") === "off"
			? {}
			: {
					call: async (intent: string, payload: unknown) => {
						const body = payload as { tool?: string; args?: Record<string, unknown>; name?: string; enabled?: boolean; listed?: boolean };
						if (intent === "configureGeneralAgent") {
							const at = seeds.findIndex(seed => seed.draft.name === body.name);
							const seed = seeds[at];
							if (seed === undefined) throw new Error(`No agent named ${body.name}`);
							seeds[at] = { ...seed, fact: { ...seed.fact, ...(body.enabled !== undefined ? { enabled: body.enabled } : {}), ...(body.listed !== undefined ? { listed: body.listed } : {}) } };
							publish();
							return undefined;
						}
						if (intent !== "callOwnServerTool" || body.tool === undefined) throw new Error(`Unknown intent ${intent}`);
						return tool(body.tool, body.args ?? {});
					},
				}),
	};
}
