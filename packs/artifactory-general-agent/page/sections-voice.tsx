// How the agent sounds: the voice it speaks with now (and why), the layers that can choose one (this
// project, you, the agent's own file; the most specific wins), and every voice profile visible from
// the project as a card you can HEAR before you choose. Which profile resolves is the engine's word
// (`speech/agents`); this section labels it and writes the layer you pick. How the agent TALKS is its
// `Spoken:` line in Standing instructions: a separate thing, and the section says so.
import { Badge, cn, Icon } from "@fraym/ui";
import { useState } from "react";
import { heldByExtra } from "../src/agent-md";
import { ChoiceGroup, LABEL, PANEL, Section } from "./chrome";
import { errorText } from "./forge";
import type { SectionProps } from "./profile";
import { ProposedBadge } from "./sections-identity";
import {
	type AgentVoice,
	type AssignScope,
	type ChainStep,
	defaultScope,
	ladder,
	type LadderRow,
	monogram,
	outrankedBy,
	type ProfileCard,
	profileCards,
	scopeStates,
	SOURCE_LABELS,
	type ScopeState,
	type VoiceKit,
	type VoiceSampler,
} from "./voice";

/** What a pick at each layer is called in a sentence. */
const PICKING: Readonly<Record<AssignScope, string>> = {
	workspace: "this project",
	user: "you",
	agent: "the agent's own file",
};

/** What happens when a pick lands, so nobody wonders whether to press Save. */
const LANDS: Readonly<Record<AssignScope, string>> = {
	workspace: "Applies as soon as you pick it, to this agent in this project only.",
	user: "Applies as soon as you pick it, to this agent in every project that does not choose its own.",
	agent: "Saved with the rest of the profile, in its agent.md.",
};

function InlineAlert({ text }: { readonly text: string }) {
	return (
		<span role="alert" className="flex items-center gap-1.5 text-fr-xs text-fr-del">
			<Icon name="warnTri" size={12} strokeWidth={2} />
			{text}
		</span>
	);
}

/** A provider's mark: its initials on a tile. The state rides beside it as a dot, never as colour alone. */
function ProviderMark({ label, ready, speaking }: { readonly label: string; readonly ready: boolean; readonly speaking: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative flex size-5 shrink-0 items-center justify-center rounded-md font-secondary text-[9px] font-semibold",
				speaking ? "bg-fr-accent text-fr-accent-ink" : ready ? "bg-fr-surface-3 text-fr-text-2" : "bg-fr-surface-3 text-fr-text-3",
			)}
		>
			{monogram(label)}
			{!ready ? <span className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-fr-warn ring-1 ring-fr-surface" /> : null}
		</span>
	);
}

/** The fallback chain in order: the step that will speak is lit, the ones tried first and unready are flagged. */
function Chain({ steps, speaking }: { readonly steps: readonly ChainStep[]; readonly speaking: number }) {
	return (
		<ol className="m-0 flex list-none flex-wrap items-center gap-x-1 gap-y-1 p-0">
			{steps.map((step, index) => (
				<li key={`${step.providerLabel}:${step.model}`} className="flex items-center gap-1">
					<ProviderMark label={step.providerLabel} ready={step.ready} speaking={index === speaking} />
					<span className={cn("fr-overflow max-w-32 font-secondary text-fr-xs", index === speaking ? "text-fr-text" : step.ready ? "text-fr-text-2" : "text-fr-text-3")}>{step.providerLabel}</span>
					<span className="sr-only">{step.state.text}</span>
					{index < steps.length - 1 ? <span aria-hidden="true" className="text-fr-text-3">›</span> : null}
				</li>
			))}
		</ol>
	);
}

/** One sample at a time: pressed while this profile speaks (or is being made ready), a second press stops it. */
function PlayButton({ card, sampler, className }: { readonly card: ProfileCard; readonly sampler: VoiceSampler; readonly className?: string }) {
	const mine = sampler.state.profile === card.name;
	const phase = mine ? sampler.state.phase : "idle";
	const going = phase === "playing" || phase === "preparing";
	const cannot = card.speaksWith === null;
	return (
		<button
			type="button"
			aria-label={going ? `Stop the ${card.name} sample` : `Play a sample of ${card.name}`}
			aria-pressed={going}
			disabled={cannot}
			title={cannot ? "Nothing can speak this profile yet." : undefined}
			onClick={() => (going ? sampler.stop() : sampler.play(card.name))}
			className={cn(
				"flex size-8 shrink-0 items-center justify-center rounded-full border fr-t-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line",
				going ? "border-fr-accent bg-fr-accent text-fr-accent-ink" : "border-fr-border bg-fr-bg text-fr-text-2 hover:bg-fr-surface-3 hover:text-fr-text",
				phase === "preparing" && "animate-pulse",
				cannot && "cursor-default opacity-50",
				className,
			)}
		>
			<Icon name={going ? "pause" : "play"} size={13} strokeWidth={2} />
		</button>
	);
}

/** The line under a profile: what speaks, and when something is in the way, a note saying what, in words a person can act on. */
function speaksLine(card: ProfileCard): { readonly text: string; readonly note?: string; readonly warn: boolean } {
	const note = card.needs === undefined ? {} : { note: card.needs };
	if (card.speaksWith === null) return { text: "Cannot speak yet", ...note, warn: true };
	if (card.speaksWith.fellBack) return { text: `Falls back to ${card.speaksWith.label}`, ...note, warn: true };
	return { text: `Speaks with ${card.speaksWith.label}`, warn: false };
}

function SoundsLike({
	name,
	why,
	card,
	sampler,
}: {
	readonly name: string | null;
	readonly why: string;
	readonly card: ProfileCard | undefined;
	readonly sampler: VoiceSampler | undefined;
}) {
	const line = card ? speaksLine(card) : undefined;
	const usable = card !== undefined && card.speaksWith !== null;
	return (
		<div className="flex flex-wrap items-center gap-4">
			<span className={cn("flex size-12 shrink-0 items-center justify-center rounded-xl", usable ? "bg-fr-accent-dim text-fr-accent" : "bg-fr-surface-3 text-fr-text-2")}>
				<Icon name="waveform" size={22} strokeWidth={1.6} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className={LABEL}>Sounds like</span>
				<span className="fr-overflow text-fr-md font-semibold text-fr-text">{name ?? "No voice chosen"}</span>
				<span className="text-fr-xs leading-relaxed text-fr-text-2">
					{why}
					{line ? <span className={cn("ml-1.5", line.warn && "text-fr-warn")}>· {line.text}</span> : null}
				</span>
				{line?.note ? <span className="text-fr-xs leading-relaxed text-fr-text-2">{line.note}</span> : null}
			</div>
			{card && sampler ? <PlayButton card={card} sampler={sampler} /> : null}
		</div>
	);
}

function LadderRowView({
	row,
	state,
	selected,
	busy,
	onSelect,
	onClear,
}: {
	readonly row: LadderRow;
	readonly state: ScopeState | undefined;
	readonly selected: boolean;
	/** A write is in flight: nothing on the ladder changes until it lands. */
	readonly busy: boolean;
	readonly onSelect: () => void;
	readonly onClear: () => void;
}) {
	const body = (
		<>
			<span
				aria-hidden="true"
				className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-full border", selected ? "border-fr-accent bg-fr-accent" : "border-fr-border", state === undefined && "border-transparent")}
			>
				{selected ? <span className="size-1.5 rounded-full bg-fr-accent-ink" /> : null}
			</span>
			<span className="w-24 shrink-0 text-fr-sm text-fr-text">{row.label}</span>
			<span className={cn("fr-overflow min-w-0 font-secondary text-fr-sm", row.value === null ? "text-fr-text-3" : "text-fr-text")}>{row.value ?? (row.reported ? "Nothing set" : "Not reported")}</span>
			{row.pending ? (
				<Badge tone="mute" variant="soft" className="shrink-0 text-fr-xs">
					Unsaved
				</Badge>
			) : row.wins ? (
				<Badge tone="accent" variant="soft" className="shrink-0 text-fr-xs">
					In use
				</Badge>
			) : null}
		</>
	);
	const reason = state && !state.enabled ? state.reason : undefined;
	return (
		<div className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2", selected ? "border-fr-accent-line bg-fr-accent-dim" : "border-fr-border-soft bg-fr-bg", reason && !selected && "opacity-70")}>
			{state === undefined ? (
				<div className="flex min-w-0 flex-1 items-center gap-3">{body}</div>
			) : (
				<button
					type="button"
					role="radio"
					aria-checked={selected}
					disabled={!state.enabled || busy}
					onClick={onSelect}
					className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line disabled:cursor-default"
				>
					{body}
				</button>
			)}
			{state?.enabled && (row.value !== null || !row.reported) ? (
				<button type="button" disabled={busy} aria-label={`Clear what ${PICKING[state.scope]} chose`} onClick={onClear} className="shrink-0 rounded-md px-2 py-1 text-fr-xs text-fr-text-2 fr-t-colors hover:bg-fr-surface-3 hover:text-fr-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line disabled:cursor-default disabled:opacity-50">
					Clear
				</button>
			) : null}
			{reason ? <span className="w-full pl-[1.625rem] text-fr-xs text-fr-text-2">{reason}</span> : null}
		</div>
	);
}

function VoiceCard({
	card,
	held,
	inUse,
	disabled,
	sampler,
	onPick,
}: {
	readonly card: ProfileCard;
	readonly held: boolean;
	readonly inUse: boolean;
	readonly disabled: boolean;
	readonly sampler: VoiceSampler | undefined;
	readonly onPick: () => void;
}) {
	const line = speaksLine(card);
	const speaking = card.steps.findIndex(step => step.ready);
	return (
		<div className="relative">
			<button
				type="button"
				role="radio"
				aria-checked={held}
				disabled={disabled}
				onClick={onPick}
				className={cn(
					"flex h-full w-full min-w-0 flex-col items-start gap-2 rounded-lg border p-3.5 text-left fr-t-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line",
					sampler && "pr-14",
					held ? "border-fr-accent-line bg-fr-accent-dim" : "border-fr-border-soft bg-fr-surface",
					disabled ? "cursor-default" : held ? "" : "hover:border-fr-border hover:bg-fr-surface-2",
					disabled && !held && "opacity-60",
				)}
			>
				<span className="flex min-w-0 items-center gap-2">
					<span className="fr-overflow text-fr-sm font-semibold text-fr-text">{card.name}</span>
					{inUse ? (
						<Badge tone="accent" variant="soft" className="shrink-0 text-fr-xs">
							In use
						</Badge>
					) : null}
				</span>
				{card.description ? <span className="text-fr-xs leading-relaxed text-pretty text-fr-text-2">{card.description}</span> : null}
				<Chain steps={card.steps} speaking={speaking} />
				<span className="flex flex-wrap items-center gap-x-2 text-fr-xs">
					<span className="text-fr-text-3">{card.layerLabel}</span>
					<span className={line.warn ? "text-fr-warn" : "text-fr-text-2"}>{line.text}</span>
				</span>
				{line.note ? <span className="pr-6 text-fr-xs leading-relaxed text-pretty text-fr-text-2">{line.note}</span> : null}
				{held ? (
					<span aria-hidden="true" className="absolute right-3 bottom-3 flex size-4 items-center justify-center rounded-full bg-fr-accent text-fr-accent-ink">
						<Icon name="check" size={10} strokeWidth={3} />
					</span>
				) : null}
			</button>
			{sampler ? <PlayButton card={card} sampler={sampler} className="absolute top-3 right-3" /> : null}
		</div>
	);
}

export function VoiceSection({
	draft,
	set,
	editable,
	agentName,
	savedVoice,
	creating,
	kit,
	hasWorkspace,
	marked,
}: SectionProps & {
	/** The saved agent's name; absent while it is being created. */
	readonly agentName: string | undefined;
	/** What the agent's file holds now, so an unsaved pick is told apart from the one in force. */
	readonly savedVoice: string;
	readonly creating: boolean;
	readonly kit: VoiceKit;
	readonly hasWorkspace: boolean;
	readonly marked: ReadonlySet<string>;
}) {
	const { profiles, agents, sampler, assigner } = kit;
	const lede = "How it sounds when it speaks. How it talks is its Spoken line, in Standing instructions.";
	const aside = marked.has("voice") ? <ProposedBadge /> : undefined;
	const [picked, setPicked] = useState<AssignScope | undefined>(undefined);
	const [inflight, setInflight] = useState(0);
	const [error, setError] = useState<string | undefined>(undefined);

	if (profiles === null) {
		return (
			<Section id="agent-voice" title="Voice" lede={lede} aside={aside}>
				<div className={cn(PANEL, "flex items-center gap-4 p-4")}>
					<span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-fr-surface-3 text-fr-text-2">
						<Icon name="waveform" size={20} strokeWidth={1.6} />
					</span>
					<div className="flex min-w-0 flex-col gap-0.5">
						<span className="text-fr-sm font-medium text-fr-text">This build has no voice engine</span>
						<span className="text-fr-xs leading-relaxed text-fr-text-2">There is nothing to choose yet. A voice named in the agent's file is kept as written.</span>
					</div>
				</div>
			</Section>
		);
	}

	const cards = profileCards(profiles);
	const resolved: AgentVoice | undefined = agentName === undefined ? undefined : agents.get(agentName);
	const rows = ladder(resolved, draft.voice, profiles.defaultName, savedVoice);
	const writing = inflight > 0;
	const states = scopeStates({ editable, canAssign: assigner !== undefined, hasWorkspace, exists: !creating, heldInFile: heldByExtra(draft).has("voice") });
	const active = picked !== undefined && states.find(state => state.scope === picked)?.enabled ? picked : defaultScope(states);
	const nowName = resolved?.name ?? (draft.voice !== "" ? draft.voice : profiles.defaultName);
	const nowWhy = resolved ? SOURCE_LABELS[resolved.source] : draft.voice !== "" ? SOURCE_LABELS.agent : profiles.defaultName ? SOURCE_LABELS.default : "";
	const heldHere = rows.find(row => row.scope === active)?.value ?? null;
	const above = outrankedBy(active, rows);

	const write = (target: AssignScope, profile: string | null) => {
		setError(undefined);
		if (target === "agent") {
			set({ voice: profile ?? "" });
			return;
		}
		if (assigner === undefined || agentName === undefined) return;
		setInflight(count => count + 1);
		assigner
			.assign(agentName, profile, target)
			.catch(cause => setError(errorText(cause)))
			.finally(() => setInflight(count => count - 1));
	};

	return (
		<Section id="agent-voice" title="Voice" lede={lede} aside={aside}>
			<div className={cn(PANEL, "flex flex-col gap-5 p-4")}>
				<SoundsLike name={nowName} why={nowWhy} card={cards.find(card => card.name === nowName)} sampler={sampler} />

				<div className="flex flex-col gap-2">
					<span className="text-fr-sm font-medium text-fr-text">Who decides</span>
					<span className="text-fr-xs leading-relaxed text-fr-text-2">The most specific choice wins. Pick the row you want to set, then a voice below.</span>
					<div role="radiogroup" aria-label="Set the voice for" className="flex flex-col gap-1.5">
						{rows.map(row => {
							const state = states.find(entry => entry.scope === row.scope);
							return (
								<LadderRowView
									key={row.scope}
									row={row}
									state={state}
									selected={state !== undefined && row.scope === active}
									busy={writing}
									onSelect={() => state && setPicked(state.scope)}
									onClear={() => state && write(state.scope, null)}
								/>
							);
						})}
					</div>
				</div>

				<div className="flex flex-col gap-2.5">
					<div className="flex flex-col gap-0.5">
						<span className="text-fr-sm font-medium text-fr-text">Pick a voice for {PICKING[active]}</span>
						<span className="text-fr-xs leading-relaxed text-fr-text-2">{LANDS[active]}</span>
						{above && above.value !== null ? (
							<span className="text-fr-xs leading-relaxed text-fr-text-2">
								{above.label} already chose <span className="font-secondary text-fr-text">{above.value}</span>, which outranks this.
							</span>
						) : null}
					</div>
					{cards.length === 0 ? (
						<p className="m-0 rounded-lg border border-dashed border-fr-border px-4 py-3 text-fr-sm text-fr-text-2">No voice profile is visible from this project.</p>
					) : (
						<ChoiceGroup label="Voice profiles" columns={4}>
							{cards.map(card => (
								<VoiceCard
									key={card.name}
									card={card}
									held={heldHere === card.name}
									inUse={nowName === card.name}
									disabled={writing || states.find(state => state.scope === active)?.enabled !== true}
									sampler={sampler}
									onPick={() => write(active, card.name)}
								/>
							))}
						</ChoiceGroup>
					)}
					{error !== undefined ? <InlineAlert text={error} /> : null}
					{sampler?.state.phase === "error" && sampler.state.message ? <InlineAlert text={sampler.state.message} /> : null}
				</div>

				<p className="m-0 border-t border-fr-border-soft pt-3 text-fr-xs leading-relaxed text-fr-text-2">
					To write a new profile or add a provider key, open Settings, then Voice. This page only chooses between the profiles that exist.
				</p>
			</div>
		</Section>
	);
}
