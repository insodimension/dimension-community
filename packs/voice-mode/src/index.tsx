// Voice mode's Settings pane (doc 91 §2, §9): the `settings` slot's one filling. A pane is a seat on the
// ROOT-fenced Store, so it reads only the public root facts (`speech/profiles`, `agents/list`, `models`) and
// holds no session; it imports nothing but `react`, so there is no ungranted `@fraym/ui` name to refuse it.
//
// It is READ-ONLY, and says so by being so. Choosing which agent sounds like what, trying a voice, and showing
// what the `voice` role resolves to each need a door the Store does not give a root seat yet (a config write, a say
// on a seatless pane, the role map as a fact): those are filed SDK gaps, not controls that pretend. The `classifier`
// role is the one resolution a newer engine does publish, as `speech/profiles.classifier`: its input leaves the
// device when the endpoint is remote, so the pane states where it goes, and says nothing new on an older engine that
// omits it. What the pane CAN do it does honestly: say whether voice mode can speak right now, which voices exist and
// what each would really speak with, and how to change any of it.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
	headline,
	modelRows,
	profileViews,
	readAgents,
	readModelsFact,
	readProfilesFact,
	stateLine,
	TUNING_KEYS,
	type ProfileView,
	type ProfilesView,
} from "./model";
import { ensureStyles } from "./styles";

/** The public root keys this pane reads, restated: a pack cannot import the driver's constants. */
const SPEECH_PROFILES_KEY = "speech/profiles";
const AGENTS_LIST_KEY = "agents/list";
const MODELS_KEY = "models";

interface Observable<T> {
	getSnapshot(): T;
	subscribe(listener: () => void): () => void;
}

/** The slice of the host Store a pane reads; the host's fenced view satisfies it. */
export interface PaneStore {
	watch<T = unknown>(key: string): Observable<T | undefined>;
}

export interface VoicePaneProps {
	readonly store?: PaneStore;
}

const NO_UNSUBSCRIBE = () => undefined;

/** A root fact as a React value; undefined while the key is unpublished or the fence refuses it. */
function useFact(store: PaneStore | undefined, key: string): unknown {
	const observable = useMemo(() => store?.watch<unknown>(key), [store, key]);
	const subscribe = useMemo(
		() => (listener: () => void) => (observable ? observable.subscribe(listener) : NO_UNSUBSCRIBE),
		[observable],
	);
	const read = () => observable?.getSnapshot();
	return useSyncExternalStore(subscribe, read, read);
}

function Dot({ tone }: { readonly tone: "ok" | "warn" | "off" }) {
	return <span className="vm-dot" data-tone={tone} aria-hidden="true" />;
}

function Profile({ profile }: { readonly profile: ProfileView }) {
	return (
		<li className="vm-row">
			<div className="vm-grow">
				<div>
					<span className="vm-name">{profile.name}</span>
					{profile.isDefault ? <span className="vm-tag">Default</span> : null}
				</div>
				<div className="vm-meta">
					{profile.layerLabel}
					{profile.description ? ` · ${profile.description}` : ""}
				</div>
				<ul className="vm-chain">
					{profile.steps.map((step, index) => (
						<li key={`${step.providerLabel}:${step.model}:${index}`}>
							<span>
								{step.providerLabel} · {step.model}
								{step.voice ? ` · ${step.voice}` : ""}
							</span>
							<span className="vm-state" data-tone={step.state.tone} title={step.detail}>
								{step.state.text}
							</span>
						</li>
					))}
				</ul>
			</div>
			<div className="vm-state vm-meta" data-tone={profile.speaksWith ? "ok" : "warn"}>
				{profile.speaksWith
					? profile.speaksWith.fellBack
						? `Falls back to ${profile.speaksWith.label}`
						: `Speaks with ${profile.speaksWith.label}`
					: "Cannot speak yet"}
			</div>
		</li>
	);
}

function Engines({ view }: { readonly view: ProfilesView }) {
	if (view.providers.length === 0) return <div className="vm-empty">No speech engine is installed.</div>;
	return (
		<ul className="vm-list">
			{view.providers.map(provider => {
				const speak = stateLine(provider.speak, "speak");
				const listen = stateLine(provider.listen, "listen");
				return (
					<li className="vm-row" key={provider.id}>
						<div className="vm-grow">
							<div className="vm-name">{provider.label}</div>
							<div className="vm-meta">
								{provider.listen
									? `Listening: ${listen.text}${provider.listen.detail && !provider.listen.ready ? ` (${provider.listen.detail})` : ""}`
									: "Speaks only"}
							</div>
						</div>
						<div className="vm-state" data-tone={speak.tone} title={provider.speak?.detail}>
							{provider.speak ? `Speaking: ${speak.text}` : speak.text}
						</div>
					</li>
				);
			})}
		</ul>
	);
}

/** The Voice pane. Default export: the host seats it as `{ store, workspace }`. */
export default function VoicePane({ store }: VoicePaneProps) {
	useEffect(ensureStyles, []);
	const rawProfiles = useFact(store, SPEECH_PROFILES_KEY);
	const rawAgents = useFact(store, AGENTS_LIST_KEY);
	const rawModels = useFact(store, MODELS_KEY);
	const profiles = useMemo(() => readProfilesFact(rawProfiles), [rawProfiles]);
	const agents = useMemo(() => readAgents(rawAgents), [rawAgents]);
	const models = useMemo(() => readModelsFact(rawModels), [rawModels]);
	const voices = useMemo(() => (profiles ? profileViews(profiles) : []), [profiles]);
	const top = headline(profiles);
	const defaultName = profiles?.default?.name;

	return (
		<div data-slot="voice-pane">
			<section>
				<div className="vm-headline" role="status">
					<Dot tone={top.tone} />
					<span>{top.text}</span>
				</div>
				<p className="vm-sub">
					Turn voice mode on from the speaker beside the microphone in the composer. It works in any space, with any agent.
				</p>
			</section>

			{profiles ? (
				<>
					<section>
						<h2>Speech engines</h2>
						<p className="vm-sub">What can speak and listen on this machine right now.</p>
						<Engines view={profiles} />
					</section>

					<section>
						<h2>Voices</h2>
						<p className="vm-sub">
							A voice says how an agent sounds: the first ready choice below speaks, and the on-device voice is always the last
							resort.
						</p>
						{voices.length === 0 ? (
							<div className="vm-empty">No voice profile is visible from this workspace.</div>
						) : (
							<ul className="vm-list">
								{voices.map(profile => (
									<Profile key={profile.name} profile={profile} />
								))}
							</ul>
						)}
					</section>

					<section>
						<h2>Agents</h2>
						<p className="vm-sub">
							The voice each agent ships with. A voice you assign in your own config outranks it, and a workspace's outranks yours.
						</p>
						{agents.length === 0 ? (
							<div className="vm-empty">No agents are listed yet.</div>
						) : (
							<ul className="vm-list">
								{agents.map(agent => (
									<li className="vm-row" key={agent.name}>
										<div className="vm-grow vm-name">{agent.title}</div>
										<div className="vm-meta">
											{agent.voice ? agent.voice : defaultName ? `${defaultName} (default)` : "No voice set"}
										</div>
									</li>
								))}
							</ul>
						)}
					</section>
				</>
			) : null}

			<section>
				<h2>Models</h2>
				<p className="vm-sub">Two small models make voice mode feel attentive. Neither is required.</p>
				<ul className="vm-list">
					{modelRows(models, profiles?.classifier).map(row => (
						<li className="vm-row" key={row.role}>
							<Dot tone={row.tone} />
							<div className="vm-grow">
								<div className="vm-name">{row.title}</div>
								<div>{row.says}</div>
								<div className={row.disclosure ? "vm-notice" : "vm-meta"}>{row.hint}</div>
							</div>
						</li>
					))}
				</ul>
			</section>

			<section>
				<h2>Change it</h2>
				<ul className="vm-help">
					<li>
						Give an agent a voice with <code>voice: &lt;name&gt;</code> in its <code>agent.md</code>, or with{" "}
						<code>voice.agents.&lt;agent&gt;</code> in <code>~/.inso/config.json</code> (yours) or the workspace's{" "}
						<code>.inso/config.json</code>.
					</li>
					<li>
						Add a voice by dropping a <code>&lt;name&gt;.yml</code> into <code>voice-profiles/</code> beside your agents, or
						into the workspace's <code>.inso/voice-profiles/</code>. It appears above as soon as it is saved.
					</li>
					<li>
						Tune how it behaves in the <code>voice</code> block of the same <code>config.json</code>:
						<ul className="vm-help">
							{TUNING_KEYS.map(tuning => (
								<li key={tuning.key}>
									<code>{tuning.key}</code> ({tuning.fallback}): {tuning.what}
								</li>
							))}
						</ul>
					</li>
				</ul>
			</section>
		</div>
	);
}
