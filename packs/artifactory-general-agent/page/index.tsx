// The General Agents page (C-A): a `workspace-surface` component the host
// mounts on the Code space's `page` surface when the rail's General Agents
// entry is chosen, in a seat granted `artifactory:call` (its own server's
// App-only tools) and `agents:configure` (the two switches). It reads the host's
// facts from the fenced Store and draws every agent as a card, then one agent
// as a profile to read, edit, create from or extend.
import { agentPresenceFace } from "@fraym/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ListedAgent, StoredProposal } from "../src/contracts";
import { rememberFaces } from "./faces";
import { useActivity, useFact, useNow, usePolled } from "./facts";
import { errorText, forgeOf } from "./forge";
import { AgentsHome } from "./home";
import { AgentProfile } from "./profile";
import { acceptProposal, discardProposal, extendFrom, openBlank, openListed, type ProfileState, proposalsForProfile, proposalsToReview, receiveProposal } from "./profile-state";
import { joinRoster } from "./roster";
import { usePageStyles } from "./styles";
import {
	AGENTS_KEY,
	type AgentFact,
	CATALOG_KEY,
	type CatalogFact,
	type FaceBinding,
	type GeneralAgentsPageProps,
	MODELS_KEY,
	type ModelFact,
	PAGE_SLOT,
	USAGE_KEY,
	type UsageFact,
} from "./types";
import { readAgentVoices, readProfilesFact, SPEECH_AGENTS_KEY, SPEECH_PROFILES_KEY, type VoiceKit } from "./voice";

export type { GeneralAgentsPageProps } from "./types";

/** The Code space's default agent: a session opened as no agent is its. */
export const DEFAULT_AGENT = "coding";

/** How often the page asks its server for the Machinist's undecided proposals. */
const PROPOSALS_MS = 4000;

/** The listing before its first read: one array, so nothing keyed on it changes. */
const NO_AGENTS: readonly ListedAgent[] = [];

export function GeneralAgentsPage(props: GeneralAgentsPageProps) {
	usePageStyles();
	const { store, workspace, avatar, agentPresences, bridgedPresences, onIntent } = props;
	const workspacePath = workspace?.path;
	const forge = useMemo(() => forgeOf(store, workspacePath), [store, workspacePath]);
	const facts = useFact<readonly AgentFact[]>(store, AGENTS_KEY);
	const usage = useFact<UsageFact>(store, USAGE_KEY);
	const catalog = useFact<CatalogFact>(store, CATALOG_KEY);
	const models = useFact<readonly ModelFact[]>(store, MODELS_KEY);
	const speechProfiles = useFact<unknown>(store, SPEECH_PROFILES_KEY);
	const speechAgents = useFact<unknown>(store, SPEECH_AGENTS_KEY);
	// A voice choice reaches the page through the doors the lane lends (`props.voice`): a sample to
	// hear and a write for `voice.agents.<agent>`. A door this build lacks is simply absent.
	const sampler = props.voice?.sampler;
	const assigner = props.voice?.assigner;
	const voiceAgents = useMemo(() => readAgentVoices(speechAgents), [speechAgents]);
	const voiceKit = useMemo<VoiceKit>(
		() => ({ profiles: readProfilesFact(speechProfiles), agents: voiceAgents, ...(sampler ? { sampler } : {}), ...(assigner ? { assigner } : {}) }),
		[speechProfiles, voiceAgents, sampler, assigner],
	);
	const now = useNow(30_000);
	const activity = useActivity(store, now, DEFAULT_AGENT);

	const readListing = useCallback(() => forge.listAgents(), [forge]);
	const listing = usePolled(readListing, null, forge);
	// A save, a hand edit, a flip on the Capabilities page: the host republishes
	// `agents/list` off its file watchers, and the files are read again with it.
	const refreshListing = listing.refresh;
	useEffect(() => {
		if (facts !== undefined) void refreshListing();
	}, [facts, refreshListing]);
	// The inbox is this workspace's: the server hands back only its proposals.
	const readProposals = useCallback(() => forge.pendingProposals(), [forge]);
	const proposals = usePolled(readProposals, PROPOSALS_MS, forge);

	const listed = useMemo(() => listing.value?.agents ?? NO_AGENTS, [listing.value]);
	const roster = useMemo(() => joinRoster(facts, listing.value?.agents), [facts, listing.value]);
	const faceOf = useMemo(() => rememberFaces(name => agentPresenceFace(avatar, name, agentPresences) as FaceBinding), [avatar, agentPresences]);

	const [profile, setProfile] = useState<ProfileState | null>(null);
	const [notice, setNotice] = useState<string | undefined>(undefined);
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
	/** Proposals the human decided: dismissed on the server, never laid again. One
	 *  on the open profile is held back by that profile, and when the profile
	 *  closes undecided it is held back by nothing: it is on the home again. */
	const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
	/** The agent a save just wrote: its profile reopens on the fresh file. */
	const reopen = useRef<string | null>(null);

	const pending = useMemo(() => proposalsToReview(proposals.value?.proposals ?? [], profile, decided), [proposals.value, profile, decided]);

	useEffect(() => {
		const name = reopen.current;
		if (name === null) return;
		const file = listing.value?.agents.find(agent => agent.name === name);
		if (file === undefined) return;
		reopen.current = null;
		setProfile(openListed(file));
	}, [listing.value]);

	// A proposal for the agent on screen lands on it as soon as it is read.
	useEffect(() => {
		if (profile === null) return;
		const mine = proposalsForProfile(profile, pending);
		if (mine.length === 0) return;
		setProfile(mine.reduce((next, entry) => receiveProposal(next, entry.id, entry.proposal, listed), profile));
	}, [pending, profile, listed]);

	const review = (entry: StoredProposal) => setProfile(receiveProposal(null, entry.id, entry.proposal, listed));

	const decide = async (state: ProfileState, keep: boolean) => {
		const ids = state.proposal?.ids ?? [];
		setDecided(current => new Set([...current, ...ids]));
		setProfile(keep ? acceptProposal(state) : discardProposal(state));
		try {
			await Promise.all(ids.map(id => forge.dismissProposal(id)));
		} catch (cause) {
			setNotice(errorText(cause));
		} finally {
			void proposals.refresh();
		}
	};

	// Stable between renders (they reach every card), so a card is skipped when
	// nothing it draws changed.
	const configure = useCallback(
		async (name: string, patch: { readonly enabled?: boolean; readonly listed?: boolean }) => {
			setBusy(current => new Set([...current, name]));
			setNotice(undefined);
			try {
				await forge.configure(name, patch);
			} catch (cause) {
				setNotice(errorText(cause));
			} finally {
				setBusy(current => {
					const next = new Set(current);
					next.delete(name);
					return next;
				});
			}
		},
		[forge],
	);

	const openAgent = useCallback(
		(name: string) => {
			const file = listed.find(agent => agent.name === name);
			if (file !== undefined) setProfile(openListed(file));
		},
		[listed],
	);
	const openDock = onIntent ? () => onIntent({ t: "dock.open" }) : undefined;
	const canConfigure = store.call !== undefined;

	return (
		// `display: contents`: the scope page.css puts every utility under, with no box of its own.
		<div data-slot={PAGE_SLOT} style={{ display: "contents" }}>
			{profile !== null ? (
				<AgentProfile
					key={profile.draft.key}
					state={profile}
					onChange={setProfile}
					onClose={() => setProfile(null)}
					onExtend={base => setProfile(extendFrom(base))}
					onDecide={keep => void decide(profile, keep)}
					onSaved={name => {
						reopen.current = name;
						setNotice(undefined);
						void listing.refresh();
					}}
					forge={forge}
					roster={roster}
					listed={listed}
					activity={activity}
					usage={usage}
					catalog={catalog}
					models={models}
					now={now}
					faceOf={faceOf}
					bridged={bridgedPresences}
					onDock={openDock}
					configure={canConfigure ? configure : undefined}
					voice={voiceKit}
					hasWorkspace={workspace != null}
					busy={busy}
					notice={notice}
				/>
			) : (
				<AgentsHome
					roster={roster}
					loading={facts === undefined}
					listingError={listing.error}
					activity={activity}
					usage={usage}
					catalog={catalog}
					now={now}
					faceOf={faceOf}
					voices={voiceAgents}
					bridged={bridgedPresences}
					proposals={pending}
					onReview={review}
					onOpen={openAgent}
					onCreate={() => setProfile(openBlank())}
					onDock={openDock}
					configure={canConfigure ? configure : undefined}
					busy={busy}
					notice={notice}
				/>
			)}
		</div>
	);
}
