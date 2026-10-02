// One agent's profile: who it is at the top (its face, name, tier, where it
// stands, its switches and the one action it offers), its week as a vitals
// strip, then every part of it as a section of real things (faces, files,
// marks, models, choices), never rows of label and value. A pack's agent reads
// the same, with its controls at rest and a way to extend it; yours and your
// project's are edited in place and saved from one sticky bar.
import { Badge, Button, Icon, Switch, cn } from "@fraym/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { AgentDraft } from "../src/agent-md";
import type { ListedAgent } from "../src/contracts";
import { FaceTile, GrantLock, type Vital, VitalsStrip, ViewColumn } from "./chrome";
import { faceWash } from "./faces";
import { usePolled } from "./facts";
import { errorText, type Forge } from "./forge";
import { LivePill, usageOf } from "./home";
import { type AgentActivity, agoLabel, liveStateOf, money, NO_ACTIVITY, tokenLabel } from "./kpis";
import { saveProfile } from "./profile-save";
import { fieldErrors, isDirty, isNew, type ProfileState, saveBlockers, saveTargetOf } from "./profile-state";
import { displayName, humanize, type RosterAgent, TIER_LABEL, titleOf } from "./roster";
import { CapabilitiesSection } from "./sections-capabilities";
import { CharterSection, IdentitySection, InstructionsSection } from "./sections-identity";
import { AdvancedSection, BrainSection, HomeSection, LineageSection, MemorySection, SafetySection } from "./sections-settings";
import { VoiceSection } from "./sections-voice";
import type { BridgedPresences, CatalogFact, FaceBinding, ModelFact, UsageFact } from "./types";
import type { VoiceKit } from "./voice";

/** Everything a section is handed: the draft, how to change it, and whether it may. */
export interface SectionProps {
	readonly draft: AgentDraft;
	readonly set: (patch: Partial<AgentDraft>) => void;
	readonly editable: boolean;
}

const NAV: readonly { readonly id: string; readonly label: string }[] = [
	{ id: "identity", label: "Identity" },
	{ id: "voice", label: "Voice" },
	{ id: "charter", label: "Charter" },
	{ id: "capabilities", label: "Capabilities" },
	{ id: "memory", label: "Memory" },
	{ id: "home", label: "Home" },
	{ id: "brain", label: "Brain" },
	{ id: "safety", label: "Safety" },
	{ id: "lineage", label: "Lineage" },
	{ id: "advanced", label: "Advanced" },
];

/** A face the human just picked shows as picked; otherwise the host's answer. */
export function previewFace(state: ProfileState, faceOf: (name: string) => FaceBinding): FaceBinding {
	const opened = state.agent?.draft.vibr;
	if (state.agent !== undefined && state.draft.vibr === opened) return faceOf(state.agent.name);
	return { avatar: (state.draft.vibr === "" ? "nebula" : state.draft.vibr) as FaceBinding["avatar"] };
}

function ProposalBanner({ fields, onDecide }: { readonly fields: readonly string[]; readonly onDecide: (keep: boolean) => void }) {
	return (
		<div role="status" data-slot="agent-proposal" className="flex flex-wrap items-center gap-3 rounded-lg border border-fr-accent-line bg-fr-accent-dim px-4 py-3">
			<span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-fr-accent text-fr-accent-ink">
				<Icon name="bot" size={16} strokeWidth={1.9} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="text-fr-sm font-semibold text-fr-text">Proposed by the Machinist</span>
				<span className="text-fr-xs text-fr-text-2">{fields.length > 0 ? `It set ${fields.join(", ")}. The marked parts below are its; accept to keep them, then save.` : "It named this agent. Accept to keep the draft, then save."}</span>
			</div>
			<div className="flex gap-2">
				<Button size="sm" variant="ghost" onClick={() => onDecide(false)}>
					Discard
				</Button>
				<Button size="sm" onClick={() => onDecide(true)}>
					<Icon name="check" strokeWidth={2} />
					Accept
				</Button>
			</div>
		</div>
	);
}

function SwitchField({ label, checked, disabled, onChange, locked }: { readonly label: string; readonly checked: boolean; readonly disabled: boolean; readonly onChange?: ((on: boolean) => void) | undefined; readonly locked?: boolean }) {
	return (
		<label className="flex items-center justify-between gap-3 rounded-md border border-fr-border-soft bg-fr-bg px-3 py-2">
			<span className="flex items-center gap-1.5 text-fr-sm text-fr-text">
				{label}
				{locked ? <GrantLock /> : null}
			</span>
			{onChange !== undefined ? (
				<Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
			) : (
				<span className={cn("font-secondary text-fr-xs", checked ? "text-fr-text" : "text-fr-text-3")}>{checked ? "On" : "Off"}</span>
			)}
		</label>
	);
}

export function AgentProfile({
	state,
	onChange,
	onClose,
	onExtend,
	onDecide,
	onSaved,
	forge,
	roster,
	listed,
	activity,
	usage,
	catalog,
	models,
	now,
	faceOf,
	bridged,
	onDock,
	configure,
	busy,
	notice,
	voice,
	hasWorkspace,
}: {
	readonly state: ProfileState;
	readonly onChange: (state: ProfileState) => void;
	readonly onClose: () => void;
	readonly onExtend: (base: AgentDraft) => void;
	readonly onDecide: (keep: boolean) => void;
	readonly onSaved: (name: string) => void;
	readonly forge: Forge;
	readonly roster: readonly RosterAgent[];
	readonly listed: readonly ListedAgent[];
	readonly activity: ReadonlyMap<string, AgentActivity>;
	readonly usage: UsageFact | undefined;
	readonly catalog: CatalogFact | undefined;
	readonly models: readonly ModelFact[] | undefined;
	readonly now: number;
	readonly faceOf: (name: string) => FaceBinding;
	readonly bridged: BridgedPresences | undefined;
	readonly onDock: (() => void) | undefined;
	readonly configure: ((name: string, patch: { readonly enabled?: boolean; readonly listed?: boolean }) => Promise<void>) | undefined;
	readonly busy: ReadonlySet<string>;
	readonly notice: string | undefined;
	/** What the voice lane lends the page; its absence is a state the section draws. */
	readonly voice: VoiceKit;
	/** A project is open: its workspace can hold a voice choice of its own. */
	readonly hasWorkspace: boolean;
}) {
	const { draft } = state;
	const creating = isNew(state);
	const editable = state.readOnly === undefined;
	const agentName = state.agent?.name;
	const rosterAgent = roster.find(agent => agent.name === agentName);
	const fact = rosterAgent?.fact;
	const set = useCallback((patch: Partial<AgentDraft>) => onChange({ ...state, draft: { ...state.draft, ...patch } }), [onChange, state]);
	const [live, setLive] = useState(false);

	// The agent's home and standing instructions (an existing agent's only: a new
	// one has no home until it is written).
	const readHome = useCallback(() => (agentName === undefined ? Promise.resolve(undefined) : forge.home(agentName)), [forge, agentName]);
	const home = usePolled(readHome, null, `${agentName}`);
	const onDisk = home.value?.instructions.text ?? "";
	const [instructions, setInstructions] = useState<string | null>(null);
	const instructionsText = instructions ?? onDisk;
	const instructionsDirty = instructions !== null && instructions !== onDisk;
	const agentDirty = isDirty(state);

	// The server's verdict on the draft, asked once the typing settles.
	const [serverProblems, setServerProblems] = useState<readonly string[]>([]);
	useEffect(() => {
		if (!editable) return;
		let current = true;
		const timer = setTimeout(() => {
			forge.validate(draft).then(
				check => current && setServerProblems(check.problems),
				() => current && setServerProblems([]),
			);
		}, 400);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [forge, draft, editable]);

	const others = useMemo(() => listed.filter(agent => agent.name !== agentName), [listed, agentName]);
	const errors = fieldErrors(state, others);
	const blockers = saveBlockers(state, others, serverProblems.filter(problem => !problem.startsWith("Name it") && !problem.startsWith("Give it one line") && !problem.startsWith("Write its charter")));
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | undefined>(undefined);

	const save = async () => {
		setSaving(true);
		setSaveError(undefined);
		try {
			const target = agentDirty ? saveTargetOf(state) : undefined;
			if (typeof target === "string") throw new Error(target);
			const written = home.value?.instructions.target;
			await saveProfile(
				forge,
				{
					...(target !== undefined ? { agent: { draft, target } } : {}),
					...(instructionsDirty && agentName !== undefined && written ? { instructions: { name: agentName, text: instructionsText, revision: written.revision } } : {}),
				},
				{
					// The agent file is written: reopen on it now, so a failure further on
					// cannot leave this profile holding a revision the server refuses.
					agentWritten: () => onSaved(draft.name),
					// The instructions are written: read the home again, then drop the local
					// copy. The profile is clean, the next save carries the new revision, and
					// Discard shows what is on disk.
					instructionsWritten: async () => {
						await home.refresh();
						setInstructions(null);
					},
				},
			);
		} catch (cause) {
			setSaveError(errorText(cause));
		} finally {
			setSaving(false);
		}
	};

	const title = creating ? (draft.name === "" ? "New agent" : humanize(draft.name)) : rosterAgent ? displayName(rosterAgent) : humanize(draft.name);
	const face = previewFace(state, faceOf);
	const act = agentName === undefined ? NO_ACTIVITY : (activity.get(agentName) ?? NO_ACTIVITY);
	const liveState = liveStateOf(act);
	const week = agentName === undefined ? undefined : usageOf(usage, agentName);
	const homeId = fact?.homeWorkspaceId ?? home.value?.homeId;
	const vitals: Vital[] = [
		{ key: "sessions", icon: "chat", label: "Sessions 7d", value: `${act.sessions7d}`, title: `${act.sessionsTotal} sessions in all`, quiet: act.sessions7d === 0 },
		{ key: "tokens", icon: "waveform", label: "Tokens 7d", value: week ? tokenLabel(week.tokens) : "–", quiet: !week || week.tokens === 0, ...(week ? { title: `${week.turns} turns` } : {}) },
		{ key: "cost", icon: "chart", label: "Cost 7d", value: week ? money(week.cost) : "–", quiet: !week || week.cost === 0 },
		{ key: "active", icon: "clock", label: "Last active", value: agoLabel(act.lastActive, now), quiet: act.lastActive === null },
		{ key: "rooms", icon: "orbit", label: "Rooms led", value: `${act.roomsLed}`, quiet: act.roomsLed === 0 },
		{ key: "home", icon: "folder", label: "Home", value: homeId ?? "None", quiet: homeId === undefined, ...(homeId ? { title: home.value?.folder ?? homeId } : {}) },
	];
	const primary: ReactNode = !editable ? (
		<Button onClick={() => onExtend(draft)}>
			<Icon name="copy" strokeWidth={2} />
			Extend as a new agent
		</Button>
	) : (
		<Button onClick={() => void save()} disabled={saving || blockers.length > 0 || !(agentDirty || instructionsDirty)}>
			<Icon name={creating ? "plus" : "check"} strokeWidth={2} />
			{creating ? "Create agent" : "Save"}
		</Button>
	);
	const dirty = editable && (agentDirty || instructionsDirty);
	const marked = new Set(state.proposal?.fields ?? []);

	const footer = dirty ? (
		<div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-5">
			<div data-slot="agent-save-bar" className="pointer-events-auto flex w-full max-w-285 flex-wrap items-center gap-3 rounded-xl border border-fr-border bg-fr-surface px-4 py-3 shadow-md">
				<span className={cn("flex size-2 shrink-0 rounded-full", blockers.length > 0 ? "bg-fr-warn" : "bg-fr-accent")} aria-hidden="true" />
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<span className="text-fr-sm font-medium text-fr-text">
						{creating ? "A new agent, not written yet" : agentDirty && instructionsDirty ? "Unsaved changes to the agent and its instructions" : instructionsDirty ? "Unsaved standing instructions" : "Unsaved changes"}
					</span>
					<span role={blockers.length > 0 || saveError ? "alert" : undefined} className={cn("fr-overflow text-fr-xs", saveError || blockers.length > 0 ? "text-fr-warn" : "text-fr-text-2")}>
						{saveError ?? (blockers.length > 0 ? blockers[0] + (blockers.length > 1 ? ` (and ${blockers.length - 1} more)` : "") : creating ? "Written into your own agents, where it gets a home." : `Writes ${state.agent?.source === "workspace" ? "this project's" : "your"} agent.md${instructionsDirty ? " and its AGENTS.md" : ""}.`)}
					</span>
				</div>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => {
						setInstructions(null);
						setSaveError(undefined);
						if (state.agent !== undefined) onChange({ ...state, draft: { ...state.agent.draft } });
						else onClose();
					}}
				>
					{creating ? "Cancel" : "Discard changes"}
				</Button>
				<Button size="sm" onClick={() => void save()} disabled={saving || blockers.length > 0}>
					<Icon name={creating ? "plus" : "check"} strokeWidth={2} />
					{saving ? "Saving…" : creating ? "Create agent" : agentDirty && instructionsDirty ? "Save agent and instructions" : instructionsDirty ? "Save instructions" : "Save agent"}
				</Button>
			</div>
		</div>
	) : null;

	return (
		<ViewColumn slot="general-agent-profile" footer={footer}>
			<div className="-mb-3 flex items-center justify-between gap-3">
				<Button variant="ghost" size="sm" onClick={onClose}>
					<Icon name="back" strokeWidth={2} />
					All agents
				</Button>
				{onDock ? (
					<Button variant="outline" size="sm" onClick={onDock}>
						<Icon name="bot" strokeWidth={2} />
						Ask the Machinist
					</Button>
				) : null}
			</div>

			{state.proposal !== undefined ? <ProposalBanner fields={state.proposal.fields} onDecide={onDecide} /> : null}

			<header
				data-slot="agent-header"
				onPointerEnter={() => setLive(true)}
				onPointerLeave={() => setLive(false)}
				className="relative isolate flex flex-col gap-5 overflow-hidden rounded-lg border border-fr-border-soft bg-fr-surface p-5 @3xl:flex-row @3xl:items-start"
			>
				<span aria-hidden="true" className="pointer-events-none absolute -top-24 -left-16 size-80 rounded-full" style={{ background: `radial-gradient(circle, ${faceWash(face, 16)}, transparent 70%)` }} />
				<FaceTile face={face} tile={112} presence={96} live={live} bridged={bridged} name={title} className="relative" />
				<div className="relative flex min-w-0 flex-1 flex-col gap-2">
					<div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
						<h1 className="m-0 min-w-0 text-fr-2xl leading-tight font-semibold tracking-[-0.01em] text-fr-text">{title}</h1>
						<Badge tone={state.agent?.source === "pack" ? "mute" : "accent"} variant="soft">
							{creating ? "New" : TIER_LABEL[state.agent?.source ?? "user"]}
						</Badge>
						<LivePill state={liveState} count={liveState === "needs-you" ? act.needsYou : act.working} />
					</div>
					{!creating ? <span className="font-secondary text-fr-xs text-fr-text-2">{draft.name}</span> : null}
					<p className="m-0 max-w-prose text-fr-sm leading-relaxed text-pretty text-fr-text-2">{draft.description || (creating ? "Say in one line what it is for, under Identity." : "No description yet.")}</p>
					{draft.lineage.length > 0 ? (
						<span className="flex flex-wrap items-center gap-1.5 font-secondary text-fr-xs text-fr-text-2">
							<Icon name="branch" size={12} strokeWidth={2} />
							Extends
							{draft.lineage.map(base => (
								<span key={base} className="rounded-sm bg-fr-surface-3 px-2 py-0.5 text-fr-text">
									{titleOf(base, roster)}
								</span>
							))}
						</span>
					) : null}
					{state.readOnly !== undefined ? (
						<span className="flex items-center gap-1.5 text-fr-xs text-fr-text-2">
							<Icon name="lock" size={12} strokeWidth={2} />
							{state.readOnly} Extend it to make an agent of your own that starts from it.
						</span>
					) : null}
				</div>
				<div className="relative flex w-full shrink-0 flex-col gap-2 @3xl:w-60">
					{fact !== undefined ? (
						<>
							<SwitchField
								label="Enabled"
								checked={fact.enabled}
								disabled={busy.has(fact.name)}
								onChange={configure !== undefined && editable ? on => void configure(fact.name, { enabled: on }) : undefined}
							/>
							<SwitchField
								label="Show in rail"
								checked={fact.listed}
								disabled={busy.has(fact.name)}
								onChange={configure !== undefined ? on => void configure(fact.name, { listed: on }) : undefined}
							/>
						</>
					) : null}
					<div className="flex [&>button]:w-full [&>button]:justify-center">{primary}</div>
				</div>
			</header>

			{!creating ? <VitalsStrip vitals={vitals} caption={usage ? `Sessions, tokens and cost cover the last 7 days; tokens and cost measured ${agoLabel(usage.updatedAt, now)}.` : "Sessions cover the last 7 days. Tokens and cost appear once this host measures them."} className="-mt-2" /> : null}

			{notice ? (
				<p role="alert" className="m-0 -mt-3 text-fr-xs text-fr-warn">
					{notice}
				</p>
			) : null}

			<nav aria-label="Profile sections" className="sticky top-0 z-[5] -mx-1 -my-2 flex flex-wrap gap-1 border-b border-fr-border-soft bg-fr-bg px-1 py-2">
				{NAV.map(entry => (
					<button
						key={entry.id}
						type="button"
						onClick={() => document.getElementById(`agent-${entry.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
						className="rounded-full px-2.5 py-1 font-secondary text-fr-xs text-fr-text-2 fr-t-colors hover:bg-fr-surface-2 hover:text-fr-text"
					>
						{entry.label}
					</button>
				))}
				{editable ? (
					<span className="ml-auto flex items-center gap-1.5 px-2 font-secondary text-fr-xs text-fr-text-2">
						<GrantLock /> Only you set these; the Machinist can propose the rest.
					</span>
				) : null}
			</nav>

			<IdentitySection draft={draft} set={set} editable={editable} creating={creating} errors={errors} face={face} faceOf={faceOf} bridged={bridged} marked={marked} />
			<VoiceSection draft={draft} set={set} editable={editable} agentName={agentName} savedVoice={state.agent?.draft.voice ?? ""} creating={creating} kit={voice} hasWorkspace={hasWorkspace} marked={marked} />
			<CharterSection draft={draft} set={set} editable={editable} errors={errors} agent={state.agent} marked={marked} />
			<InstructionsSection home={home.value} error={home.error} creating={creating} text={instructionsText} onText={setInstructions} editable={editable} />
			<CapabilitiesSection draft={draft} set={set} editable={editable} catalog={catalog} marked={marked} />
			<MemorySection draft={draft} set={set} editable={editable} homeId={homeId} marked={marked} />
			<HomeSection draft={draft} home={home.value} homeId={homeId} />
			<BrainSection draft={draft} set={set} editable={editable} models={models} marked={marked} />
			<SafetySection draft={draft} set={set} editable={editable} marked={marked} />
			<LineageSection draft={draft} set={set} editable={editable} roster={roster} self={agentName} faceOf={faceOf} bridged={bridged} />
			<AdvancedSection draft={draft} set={set} editable={editable} homeId={homeId} problems={serverProblems} />
			{dirty ? <div aria-hidden="true" className="h-16" /> : null}
		</ViewColumn>
	);
}
