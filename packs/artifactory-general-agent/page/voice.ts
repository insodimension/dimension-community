import { isRecord } from "../src/guards";

// What the Voice section says, as pure functions over the public root facts the voice lane publishes
// (`speech/profiles`, `speech/agents`) and the agent's own draft. No React, no host.
//
// The facts come from an engine this bundle was not built with, so every reader is DEFENSIVE: a row
// that is not the shape expected is dropped, never thrown on, and an absent fact is the honest "this
// build has no speech lane" state. The page never decides which profile an agent speaks with: the
// engine resolves it (`speech/agents`) and this file only LABELS what it returned. The labels below
// are the Voice settings pane's own, so the two screens say the same thing in the same words.

export const SPEECH_PROFILES_KEY = "speech/profiles";
export const SPEECH_AGENTS_KEY = "speech/agents";

export type VoiceLayer = "workspace" | "user" | "pack" | "builtin";
export type Tone = "ok" | "warn" | "off";

/** The on-device provider: a profile with no reachable entry falls back to it. */
export const LOCAL_PROVIDER = "local";

export const LAYER_LABELS: Readonly<Record<VoiceLayer, string>> = {
	workspace: "This project",
	user: "Yours",
	pack: "From a plugin",
	builtin: "Built in",
};

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

// ---------------------------------------------------------------------------------------------
// speech/profiles
// ---------------------------------------------------------------------------------------------

interface Readiness {
	readonly ready: boolean;
	readonly reason?: string;
	readonly detail?: string;
}

interface SpeakStep {
	readonly provider: string;
	readonly model: string;
	readonly voice?: string;
}

interface ProfileRow {
	readonly name: string;
	readonly layer: VoiceLayer;
	readonly description?: string;
	readonly speak: readonly SpeakStep[];
}

interface ProviderRow {
	readonly id: string;
	readonly label: string;
	readonly speak?: Readiness;
}

export interface ProfilesView {
	readonly profiles: readonly ProfileRow[];
	readonly providers: readonly ProviderRow[];
	readonly defaultName: string | null;
}

function readReadiness(value: unknown): Readiness | undefined {
	if (!isRecord(value) || typeof value.ready !== "boolean") return undefined;
	const reason = text(value.reason);
	const detail = text(value.detail);
	return { ready: value.ready, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) };
}

function readStep(value: unknown): SpeakStep | undefined {
	if (!isRecord(value)) return undefined;
	const provider = text(value.provider);
	const model = text(value.model);
	if (!provider || !model) return undefined;
	const voice = text(value.voice);
	return { provider, model, ...(voice ? { voice } : {}) };
}

function readProfile(value: unknown): ProfileRow | undefined {
	if (!isRecord(value)) return undefined;
	const name = text(value.name);
	const layer = value.layer;
	if (!name || (layer !== "workspace" && layer !== "user" && layer !== "pack" && layer !== "builtin")) return undefined;
	const description = text(value.description);
	const speak = Array.isArray(value.speak) ? value.speak.flatMap(step => readStep(step) ?? []) : [];
	return { name, layer, speak, ...(description ? { description } : {}) };
}

function readProvider(value: unknown): ProviderRow | undefined {
	if (!isRecord(value)) return undefined;
	const id = text(value.id);
	if (!id) return undefined;
	const speak = readReadiness(value.speak);
	return { id, label: text(value.label) ?? id, ...(speak ? { speak } : {}) };
}

/** The `speech/profiles` fact; null when the engine published none (no speech lane in this build). */
export function readProfilesFact(raw: unknown): ProfilesView | null {
	if (!isRecord(raw)) return null;
	return {
		profiles: Array.isArray(raw.profiles) ? raw.profiles.flatMap(row => readProfile(row) ?? []) : [],
		providers: Array.isArray(raw.providers) ? raw.providers.flatMap(row => readProvider(row) ?? []) : [],
		defaultName: isRecord(raw.default) ? (text(raw.default.name) ?? null) : null,
	};
}

/** What a provider that cannot speak is missing: a label (`Needs an API key`) and the same fact as a
 *  predicate (`needs an API key`), so a sentence can say WHO is missing it. */
const REASONS: Readonly<Record<string, { readonly text: string; readonly phrase: string }>> = {
	"needs-key": { text: "Needs an API key", phrase: "needs an API key" },
	"needs-download": { text: "Needs a download", phrase: "needs a download" },
	unavailable: { text: "Unavailable", phrase: "is unavailable" },
};

export interface StateLine {
	readonly tone: Tone;
	readonly text: string;
	/** The same state as a predicate: "needs an API key", "is not installed". */
	readonly phrase: string;
}

/** One readiness as a sentence a person can act on. */
function stateLine(readiness: Readiness | undefined): StateLine {
	if (!readiness) return { tone: "off", text: "Does not speak", phrase: "does not speak" };
	if (readiness.ready) return { tone: "ok", text: "Ready", phrase: "is ready" };
	const reason = readiness.reason !== undefined && Object.hasOwn(REASONS, readiness.reason) ? REASONS[readiness.reason] : undefined;
	return { tone: "warn", text: reason?.text ?? "Not ready", phrase: reason?.phrase ?? "is not ready" };
}

export interface ChainStep {
	readonly providerLabel: string;
	readonly model: string;
	readonly voice?: string;
	readonly state: StateLine;
	readonly detail?: string;
	readonly ready: boolean;
}

/** One profile as the gallery draws it. */
export interface ProfileCard {
	readonly name: string;
	readonly layer: VoiceLayer;
	readonly layerLabel: string;
	readonly description?: string;
	readonly steps: readonly ChainStep[];
	/** The entry that will actually speak: the first ready one, or the on-device voice when none is. */
	readonly speaksWith: { readonly label: string; readonly fellBack: boolean } | null;
	/** What stops the first choice from speaking, in words; absent when it can. */
	readonly needs?: string;
}

function stepOf(step: SpeakStep, providers: ReadonlyMap<string, ProviderRow>): ChainStep {
	const provider = providers.get(step.provider);
	// A profile can name a provider that is not installed (a pack that is off): it cannot speak, and
	// the card says so rather than guessing at a label.
	const state: StateLine = provider ? stateLine(provider.speak) : { tone: "warn", text: "Not installed", phrase: "is not installed" };
	const detail = provider?.speak && !provider.speak.ready ? provider.speak.detail : undefined;
	return {
		providerLabel: provider?.label ?? step.provider,
		model: step.model,
		...(step.voice ? { voice: step.voice } : {}),
		state,
		...(detail ? { detail } : {}),
		ready: state.tone === "ok",
	};
}

export function profileCards(view: ProfilesView): ProfileCard[] {
	const providers = new Map(view.providers.map(provider => [provider.id, provider]));
	const local = providers.get(LOCAL_PROVIDER);
	const localReady = local?.speak?.ready === true;
	return view.profiles.map(profile => {
		const steps = profile.speak.map(step => stepOf(step, providers));
		const firstReady = steps.findIndex(step => step.ready);
		const head = steps[0];
		const spoken = steps[firstReady];
		const speaksWith = spoken
			? { label: spoken.providerLabel, fellBack: firstReady > 0 }
			: localReady
				? { label: local?.label ?? "On-device voice", fellBack: true }
				: null;
		const blocked = head !== undefined && firstReady !== 0 ? head : undefined;
		const needs = blocked ? `${blocked.providerLabel} ${blocked.state.phrase}.${blocked.detail ? ` ${blocked.detail}` : ""}` : undefined;
		return {
			name: profile.name,
			layer: profile.layer,
			layerLabel: LAYER_LABELS[profile.layer],
			...(profile.description ? { description: profile.description } : {}),
			steps,
			speaksWith,
			...(needs ? { needs } : {}),
		};
	});
}

/** Two letters for a provider's mark: its initials, or its first two characters. */
export function monogram(label: string): string {
	const words = label.trim().split(/[\s._-]+/).filter(Boolean);
	const letters = words.length > 1 ? words.map(word => word[0] ?? "").join("") : (words[0] ?? "").slice(0, 2);
	return letters.slice(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------------------------------
// speech/agents
// ---------------------------------------------------------------------------------------------

/** Where the winning profile came from (the lane's `VoiceProfileRef.source`). */
export type VoiceSource = "session" | "workspace-config" | "user-config" | "agent" | "default" | "builtin";

const SOURCES: ReadonlySet<string> = new Set<VoiceSource>(["session", "workspace-config", "user-config", "agent", "default", "builtin"]);

export const SOURCE_LABELS: Readonly<Record<VoiceSource, string>> = {
	session: "Chosen for this session",
	"workspace-config": "Set for this project",
	"user-config": "Set by you",
	agent: "The agent's own choice",
	default: "The default voice",
	builtin: "The built-in on-device voice",
};

/** What each layer holds, by profile name; absent = that layer sets nothing. */
export interface VoiceLayers {
	readonly workspace?: string;
	readonly user?: string;
	readonly agent?: string;
}

/** One agent's resolved voice, computed engine-side by the assignment order. */
export interface AgentVoice {
	readonly name: string;
	readonly source: VoiceSource;
	readonly why: string;
	/** Absent on an engine that does not list the layers. */
	readonly layers?: VoiceLayers;
}

function readLayers(value: unknown): VoiceLayers | undefined {
	if (!isRecord(value)) return undefined;
	const workspace = text(value.workspace);
	const user = text(value.user);
	const agent = text(value.agent);
	return { ...(workspace ? { workspace } : {}), ...(user ? { user } : {}), ...(agent ? { agent } : {}) };
}

/** The `speech/agents` fact: agent name to its resolved voice. Empty when the fact is absent. */
export function readAgentVoices(raw: unknown): ReadonlyMap<string, AgentVoice> {
	const out = new Map<string, AgentVoice>();
	if (!isRecord(raw)) return out;
	for (const [agent, value] of Object.entries(raw)) {
		if (!isRecord(value)) continue;
		const name = text(value.name);
		const source = text(value.source);
		if (!name || !source || !SOURCES.has(source)) continue;
		const layers = readLayers(value.layers);
		out.set(agent, { name, source: source as VoiceSource, why: text(value.why) ?? "", ...(layers ? { layers } : {}) });
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// The ladder: who is allowed to say, most specific first
// ---------------------------------------------------------------------------------------------

/** The layers a person can set from the page, most specific first (the engine's order). */
export type AssignScope = "workspace" | "user" | "agent";

export const SCOPE_ORDER: readonly AssignScope[] = ["workspace", "user", "agent"];

const SCOPE_LABELS: Readonly<Record<AssignScope | "default", string>> = {
	workspace: "This project",
	user: "You",
	agent: "The agent",
	default: "Default",
};

const SCOPE_OF_SOURCE: Readonly<Partial<Record<VoiceSource, AssignScope | "default">>> = {
	"workspace-config": "workspace",
	"user-config": "user",
	agent: "agent",
	default: "default",
	builtin: "default",
};

export interface LadderRow {
	readonly scope: AssignScope | "default";
	readonly label: string;
	/** The profile this layer holds; null = it sets nothing (or, when `reported` is false, is not known). */
	readonly value: string | null;
	/** The engine said what this layer holds. False when it does not list its layers and this row is not the
	 *  winner: the page then says "Not reported" rather than claim the layer is empty on a guess. */
	readonly reported: boolean;
	/** This row is the one in use. */
	readonly wins: boolean;
	/** The agent's own row only: the page holds a choice the file does not yet (an unsaved edit). It is not
	 *  in use until a save, so it never wears "In use". */
	readonly pending: boolean;
}

/**
 * The four layers, most specific first, with the one the engine says wins marked. Every layer the page can
 * write is always a row, so what a pick writes to is always on screen. `agentFile` is the agent's own
 * choice as the page holds it (the draft, so an unsaved edit shows at once) and `savedAgentFile` what the
 * file holds now: a difference marks the row `pending` and never moves `wins`, which stays the engine's
 * word until a save republishes.
 */
export function ladder(voice: AgentVoice | undefined, agentFile: string, defaultName: string | null, savedAgentFile: string = agentFile): LadderRow[] {
	const winning = voice ? SCOPE_OF_SOURCE[voice.source] : undefined;
	const layers = voice?.layers;
	const rows: LadderRow[] = [];
	for (const scope of SCOPE_ORDER) {
		const wins = winning === scope;
		if (scope === "agent") {
			rows.push({ scope, label: SCOPE_LABELS[scope], value: agentFile === "" ? null : agentFile, reported: true, wins, pending: agentFile !== savedAgentFile });
			continue;
		}
		const value = layers?.[scope] ?? (wins && voice ? voice.name : null);
		rows.push({ scope, label: SCOPE_LABELS[scope], value, reported: layers !== undefined || wins, wins, pending: false });
	}
	const fallback = winning === "default" ? (voice?.name ?? defaultName) : defaultName;
	rows.push({ scope: "default", label: SCOPE_LABELS.default, value: fallback, reported: true, wins: winning === "default", pending: false });
	return rows;
}

/** Whether somebody CHOSE this voice (a project, you, or the agent's own file) rather than it being the
 *  default. Only a choice is worth a mark on a card: a default voice would be the same chip on every one. */
export function isExplicitVoice(voice: AgentVoice | undefined): voice is AgentVoice {
	return voice !== undefined && (voice.source === "workspace-config" || voice.source === "user-config" || voice.source === "agent");
}

/** The row, above `scope`, whose choice still outranks one made there; null when none does. */
export function outrankedBy(scope: AssignScope, rows: readonly LadderRow[]): LadderRow | null {
	const at = SCOPE_ORDER.indexOf(scope);
	return rows.find(row => row.scope !== "default" && row.value !== null && SCOPE_ORDER.indexOf(row.scope) < at) ?? null;
}

export interface ScopeState {
	readonly scope: AssignScope;
	readonly enabled: boolean;
	/** Why it cannot be set, in words; absent when it can. */
	readonly reason?: string;
}

/** Which layers this page can write right now. A user or project choice is stored by agent name, so
 *  it needs the agent to exist (`exists`); the agent's own choice rides in its file, so it needs the
 *  file to be writable (`editable`). */
export function scopeStates(options: {
	readonly editable: boolean;
	readonly canAssign: boolean;
	readonly hasWorkspace: boolean;
	readonly exists: boolean;
	/** The file carries a `voice:` line the profile cannot draw (it sits in Everything else and wins over
	 *  the drawn one), so a pick at the agent's own layer would be written and then silently ignored. */
	readonly heldInFile?: boolean;
}): ScopeState[] {
	const config = (scope: "workspace" | "user", needsProject: boolean): ScopeState => {
		if (!options.exists) return { scope, enabled: false, reason: "Save the agent first." };
		if (!options.canAssign) return { scope, enabled: false, reason: "This build cannot save a voice choice yet." };
		if (needsProject && !options.hasWorkspace) return { scope, enabled: false, reason: "Open a project to set one for it." };
		return { scope, enabled: true };
	};
	const agent = (): ScopeState => {
		if (!options.editable) return { scope: "agent", enabled: false, reason: "Ships in a pack, so read-only. Extend it to change this." };
		if (options.heldInFile) return { scope: "agent", enabled: false, reason: "Its file sets this in Other settings, under Advanced. Change it there." };
		return { scope: "agent", enabled: true };
	};
	return [config("workspace", true), config("user", false), agent()];
}

/** The layer a pick lands on by default: yours, else the agent's own file. */
export function defaultScope(states: readonly ScopeState[]): AssignScope {
	return (["user", "agent", "workspace"] as const).find(scope => states.find(state => state.scope === scope)?.enabled) ?? "user";
}

// ---------------------------------------------------------------------------------------------
// The doors the voice lane lends the page
// ---------------------------------------------------------------------------------------------

/** One sample at a time, across the whole app (the voice desk's one-speaker rule): the state names
 *  the profile that is speaking so one card can show it while the others stay idle. */
export interface VoiceSampler {
	readonly state: {
		readonly phase: "idle" | "preparing" | "playing" | "error";
		readonly profile: string | null;
		readonly message?: string;
	};
	play(profile: string): void;
	stop(): void;
}

/** Writes `voice.agents.<agent>` at user or workspace scope; `null` clears it. The engine republishes
 *  `speech/agents` when it lands, which is what moves the page. Rejects with a sentence. */
export interface VoiceAssigner {
	assign(agent: string, profile: string | null, scope: "user" | "workspace"): Promise<void>;
}

/** What the page needs of the voice lane. A door the build does not have is absent, and the control
 *  that would use it says so instead of pretending. */
export interface VoiceKit {
	readonly profiles: ProfilesView | null;
	readonly agents: ReadonlyMap<string, AgentVoice>;
	readonly sampler?: VoiceSampler;
	readonly assigner?: VoiceAssigner;
}
