// What the Voice pane says, as pure functions over the two public root facts it reads
// (`speech/profiles`, `agents/list`). No React, no host: the pane is a view of what this returns.
//
// The facts come from an engine this bundle was not built with, so every reader here is DEFENSIVE:
// a row that is not the shape the pane expects is dropped, never thrown on, and an absent fact is the
// honest "no speech engine" state. A throwing pane would only be caught by the Settings crash boundary
// and cost the user the whole pane.

export type VoiceLayer = "workspace" | "user" | "pack" | "builtin";

export interface Readiness {
	readonly ready: boolean;
	readonly reason?: string;
	readonly detail?: string;
}

export interface SpeakStep {
	readonly provider: string;
	readonly model: string;
	readonly voice?: string;
}

export interface ProfileRow {
	readonly name: string;
	readonly layer: VoiceLayer;
	readonly description?: string;
	readonly speak: readonly SpeakStep[];
}

export interface ProviderRow {
	readonly id: string;
	readonly label: string;
	readonly speak?: Readiness;
	readonly listen?: Readiness;
}

export interface DefaultProfile {
	readonly name: string;
	readonly why: string;
}

/** Where the `classifier` role resolves, as `speech/profiles.classifier` says it (ids, not display names). */
export interface ClassifierRoute {
	readonly provider: string;
	readonly model: string;
	/** The classifier's endpoint is not loopback: what it reads is sent off this device. */
	readonly leavesDevice: boolean;
	/** The endpoint's hostname, named only when `leavesDevice`. */
	readonly host?: string;
}

export interface ProfilesView {
	readonly profiles: readonly ProfileRow[];
	readonly providers: readonly ProviderRow[];
	readonly default: DefaultProfile | null;
	/** Absent = the engine does not say (an older engine): the pane makes no claim. `null` = no classifier role resolves. */
	readonly classifier?: ClassifierRoute | null;
}

/** The on-device provider's id: the built-in `local` profile names it, and a profile with no reachable
 *  entry falls back to it (doc 90 §5, "`local` is always last"). */
export const LOCAL_PROVIDER = "local";

const LAYERS: Readonly<Record<string, true>> = { workspace: true, user: true, pack: true, builtin: true };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

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
	if (!name || typeof value.layer !== "string" || !Object.hasOwn(LAYERS, value.layer)) return undefined;
	const description = text(value.description);
	const speak = Array.isArray(value.speak) ? value.speak.flatMap(step => readStep(step) ?? []) : [];
	return { name, layer: value.layer as VoiceLayer, speak, ...(description ? { description } : {}) };
}

function readProvider(value: unknown): ProviderRow | undefined {
	if (!isRecord(value)) return undefined;
	const id = text(value.id);
	if (!id) return undefined;
	const speak = readReadiness(value.speak);
	const listen = readReadiness(value.listen);
	return { id, label: text(value.label) ?? id, ...(speak ? { speak } : {}), ...(listen ? { listen } : {}) };
}

/** `undefined`: the engine does not say, or said something this pane cannot read (no claim either way, never a throw).
 *  `null`: it said no classifier role resolves. */
function readClassifier(value: unknown): ClassifierRoute | null | undefined {
	if (value === null) return null;
	if (!isRecord(value)) return undefined;
	const provider = text(value.provider);
	const model = text(value.model);
	if (!provider || !model || typeof value.leavesDevice !== "boolean") return undefined;
	const host = value.leavesDevice ? text(value.host) : undefined;
	return { provider, model, leavesDevice: value.leavesDevice, ...(host ? { host } : {}) };
}

/** The `speech/profiles` fact as the pane uses it; null when the engine published none (no speech runtime). */
export function readProfilesFact(raw: unknown): ProfilesView | null {
	if (!isRecord(raw)) return null;
	const profiles = Array.isArray(raw.profiles) ? raw.profiles.flatMap(row => readProfile(row) ?? []) : [];
	const providers = Array.isArray(raw.providers) ? raw.providers.flatMap(row => readProvider(row) ?? []) : [];
	const fallback = isRecord(raw.default) ? text(raw.default.name) : undefined;
	const classifier = readClassifier(raw.classifier);
	return {
		profiles,
		providers,
		default: fallback ? { name: fallback, why: (isRecord(raw.default) && text(raw.default.why)) || "" } : null,
		...(classifier !== undefined ? { classifier } : {}),
	};
}

export type Tone = "ok" | "warn" | "off";

export interface StateLine {
	readonly tone: Tone;
	readonly text: string;
}

const REASONS: Readonly<Record<string, string>> = {
	"needs-key": "Needs an API key",
	"needs-download": "Needs a download",
	unavailable: "Unavailable",
};

/** One readiness as a sentence a person can act on. `undefined` = the provider does not do this at all. */
export function stateLine(readiness: Readiness | undefined, verb: "speak" | "listen"): StateLine {
	if (!readiness) return { tone: "off", text: verb === "speak" ? "Does not speak" : "Does not listen" };
	if (readiness.ready) return { tone: "ok", text: "Ready" };
	const reason = readiness.reason;
	return { tone: "warn", text: reason !== undefined && Object.hasOwn(REASONS, reason) ? (REASONS[reason] as string) : "Not ready" };
}

export interface ChainStep {
	readonly providerLabel: string;
	readonly model: string;
	readonly voice?: string;
	readonly state: StateLine;
	readonly detail?: string;
	readonly ready: boolean;
}

export interface ProfileView {
	readonly name: string;
	readonly layer: VoiceLayer;
	readonly layerLabel: string;
	readonly description?: string;
	readonly isDefault: boolean;
	readonly steps: readonly ChainStep[];
	/** The entry that will actually speak: the first ready one, or the on-device voice when none is. `fellBack`: it is not
	 *  the profile's first choice, and `because` names that first choice, which is not ready. */
	readonly speaksWith: { readonly label: string; readonly fellBack: boolean; readonly because?: string } | null;
}

export const LAYER_LABELS: Readonly<Record<VoiceLayer, string>> = {
	workspace: "This workspace",
	user: "Yours",
	pack: "From a plugin",
	builtin: "Built in",
};

function stepOf(step: SpeakStep, providers: ReadonlyMap<string, ProviderRow>): ChainStep {
	const provider = providers.get(step.provider);
	// A profile can name a provider that is not installed (a pack that is off): it cannot speak, and
	// the pane says so rather than guessing at a label.
	const state: StateLine = provider ? stateLine(provider.speak, "speak") : { tone: "warn", text: "Not installed" };
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

export function profileViews(view: ProfilesView): ProfileView[] {
	const providers = new Map(view.providers.map(provider => [provider.id, provider]));
	const local = providers.get(LOCAL_PROVIDER);
	const localReady = local?.speak?.ready === true;
	return view.profiles.map(profile => {
		const steps = profile.speak.map(step => stepOf(step, providers));
		const firstReady = steps.findIndex(step => step.ready);
		const head = steps[0];
		const because = head && firstReady !== 0 ? head.providerLabel : undefined;
		const spoken = steps[firstReady];
		const speaksWith = spoken
			? { label: spoken.providerLabel, fellBack: firstReady > 0, ...(because ? { because } : {}) }
			: localReady
				? { label: local?.label ?? "On-device voice", fellBack: true, ...(because ? { because } : {}) }
				: null;
		return {
			name: profile.name,
			layer: profile.layer,
			layerLabel: LAYER_LABELS[profile.layer],
			...(profile.description ? { description: profile.description } : {}),
			isDefault: view.default?.name === profile.name,
			steps,
			speaksWith,
		};
	});
}

export interface Headline {
	readonly tone: Tone;
	readonly text: string;
}

/** The one line at the top: can voice mode speak right now, and in whose voice by default. */
export function headline(view: ProfilesView | null): Headline {
	if (!view) return { tone: "off", text: "This engine has no speech runtime, so voice mode is not available here." };
	const profiles = profileViews(view);
	const chosen = profiles.find(profile => profile.isDefault);
	if (!chosen) return { tone: "warn", text: "No default voice is set." };
	if (!chosen.speaksWith) {
		return { tone: "warn", text: `The default voice, ${chosen.name}, has nothing ready to speak with.` };
	}
	return {
		tone: "ok",
		text: chosen.speaksWith.fellBack
			? `The default voice, ${chosen.name}, speaks with ${chosen.speaksWith.label}${chosen.speaksWith.because ? `: ${chosen.speaksWith.because} is not ready` : ""}.`
			: `The default voice, ${chosen.name}, speaks with ${chosen.speaksWith.label}.`,
	};
}

export interface AgentRow {
	readonly name: string;
	readonly title: string;
	/** The voice profile the agent's own manifest names; a user or workspace assignment can still outrank it. */
	readonly voice: string | null;
}

/** The enabled General Agents of `agents/list`, by display name. */
export function readAgents(raw: unknown): AgentRow[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const rows: AgentRow[] = [];
	for (const value of raw) {
		if (!isRecord(value)) continue;
		const name = text(value.name);
		if (!name || seen.has(name) || value.enabled === false) continue;
		seen.add(name);
		rows.push({ name, title: text(value.title) ?? name, voice: text(value.voice) ?? null });
	}
	return rows.sort((a, b) => a.title.localeCompare(b.title));
}

export interface ModelsView {
	/** Connected chat models: what the `voice` role (then `tiny`, then `smol`) can resolve to. */
	readonly chat: number;
	/** Connected classify-only models (TypeSafe's Jev, a local System One): what the `classifier` role can hold. */
	readonly classifiers: readonly string[];
}

/** The public `models` catalog reduced to the two counts the Voice pane's model rows need. Null when absent. */
export function readModelsFact(raw: unknown): ModelsView | null {
	if (!Array.isArray(raw)) return null;
	let chat = 0;
	const classifiers: string[] = [];
	for (const value of raw) {
		if (!isRecord(value) || value.available !== true) continue;
		if (value.kind === "classify") {
			const label = text(value.label) ?? text(value.modelId);
			if (label && !classifiers.includes(label)) classifiers.push(label);
		} else {
			chat += 1;
		}
	}
	return { chat, classifiers };
}

export interface ModelRow {
	/** The model role's id, as `models` and the config name it. */
	readonly role: "voice" | "classifier";
	readonly title: string;
	readonly tone: Tone;
	readonly says: string;
	readonly hint: string;
	/** The hint states where the classifier's input goes: render it as plain text, not as small print. */
	readonly disclosure?: true;
}

const CLASSIFIER_HINT = "The classifier is the judge model (Jev by default). It only decides whether a message is worth saying; voice mode works without it.";

/** The Classifier row once the engine says where the role resolves. What the classifier reads leaves this device when its
 *  endpoint is remote, so the row says what, to whom and when, in a sentence the user can act on. */
function classifierRow(route: ClassifierRoute | null): ModelRow {
	if (!route) {
		return { role: "classifier", title: "Classifier", tone: "off", says: "No classifier is connected: a plain rule decides, and nothing is sent.", hint: CLASSIFIER_HINT };
	}
	const name = `${route.provider}/${route.model}`;
	const hint = route.leavesDevice
		? `While voice mode is on, the classifier (${name}) reads your mood. On each message, your last six messages to the agent (scrubbed of code, paths and secrets) and the agent's last spoken line go to ${route.host ?? route.provider}. With voice mode off, nothing is sent.`
		: `While voice mode is on, the classifier (${name}) runs on this device; nothing leaves it.`;
	return { role: "classifier", title: "Classifier", tone: "ok", says: `${name} reads your mood and judges what is worth saying.`, hint, disclosure: true };
}

/** The two model roles voice mode uses, said in plain words. The voice role's resolution is not on the public Store, so
 *  its row states what is CONNECTED and how the role falls back, never a model it cannot know. The classifier's does
 *  arrive, on `speech/profiles.classifier` from newer engines: pass it as `route` to state where the role resolves
 *  (`null` = none does); `undefined` (an older engine) keeps the connected-models row and makes no claim. */
export function modelRows(models: ModelsView | null, route?: ClassifierRoute | null): ModelRow[] {
	const voiceHint = "Set the voice model in Models to pick the small model that writes what is spoken. Unset, it falls back to your tiny model, then your small one.";
	const voice: ModelRow = !models
		? { role: "voice", title: "Voice model", tone: "off", says: "Not known yet.", hint: voiceHint }
		: models.chat > 0
			? { role: "voice", title: "Voice model", tone: "ok", says: `${models.chat} chat ${models.chat === 1 ? "model is" : "models are"} connected to write spoken replies.`, hint: voiceHint }
			: { role: "voice", title: "Voice model", tone: "warn", says: "No chat model is connected, so replies are read out as written, only cleaned up.", hint: voiceHint };
	const classifier: ModelRow = route !== undefined
		? classifierRow(route)
		: !models
			? { role: "classifier", title: "Classifier", tone: "off", says: "Not known yet.", hint: CLASSIFIER_HINT }
			: models.classifiers.length > 0
				? { role: "classifier", title: "Classifier", tone: "ok", says: `${models.classifiers.join(", ")} can judge what is worth saying.`, hint: CLASSIFIER_HINT }
				: { role: "classifier", title: "Classifier", tone: "off", says: "None connected: a plain rule decides what is worth saying.", hint: CLASSIFIER_HINT };
	return [voice, classifier];
}

export interface TuningKey {
	readonly key: string;
	readonly fallback: string;
	readonly what: string;
}

/** The `voice` block keys of the product config (`~/.inso/config.json`, or the workspace's `.inso/config.json`). The
 *  engine reads them; nothing in the Store carries their values, so the pane lists them and does not pretend to show them. */
export const TUNING_KEYS: readonly TuningKey[] = [
	{ key: "vocalizer.mode", fallback: "brief", what: "What is spoken: brief, assistant (every block in full), all (thinking too) or yield (only the final message)." },
	{ key: "vocalizer.enhanced", fallback: "on when a voice model is connected", what: "Rewrite replies into spoken prose with the small model." },
	{ key: "attention.catchUpAfterMinutes", fallback: "60", what: "How long away from an agent before it welcomes you back." },
	{ key: "attention.chimes", fallback: "on", what: "A soft tone when a message is waiting." },
];
