// The rest of the agent, each part as the thing it is: what its memory reads
// (connected tiles), where its home is (a folder), what it thinks with (model
// cards and a stepped meter), how far it may go (choice cards and lane chips,
// all locked to a human), whom it extends (agent cards), and the file itself.
import { Badge, Icon, ProviderBrandIcon, Switch, Textarea, cn } from "@fraym/ui";
import type { ComponentProps, ReactNode } from "react";
import {
	type Approval,
	type ApprovalSetting,
	type Habitat,
	heldByExtra,
	type MemoryBackend,
	manifestDocument,
	THINKING_STEPS,
	type Thinking,
} from "../src/agent-md";
import type { AgentHome } from "../src/contracts";
import { grantPathsIn, parseExtra } from "../src/extra";
import { ChoiceCard, ChoiceGroup, FaceTile, GrantLock, PANEL, PickList, Section } from "./chrome";
import { flowList, setExtraPath } from "./extra-edit";
import type { SectionProps } from "./profile";
import { displayName, extraList, humanize, type RosterAgent, TIER_LABEL } from "./roster";
import { FileCard, ProposedBadge } from "./sections-identity";
import type { BridgedPresences, FaceBinding, ModelFact } from "./types";

type IconName = ComponentProps<typeof Icon>["name"];

// ── Memory ────────────────────────────────────────────────────────────────────

const BACKENDS: readonly { readonly id: MemoryBackend; readonly icon: IconName; readonly title: string; readonly detail: string }[] = [
	{ id: "inherit", icon: "aether", title: "Dimension's default", detail: "Whatever memory you run Dimension with." },
	{ id: "engram", icon: "memory", title: "Engram", detail: "Local, recalls by meaning across its rooms." },
	{ id: "local", icon: "db", title: "Local notes", detail: "Plain notes on this machine." },
	{ id: "hindsight", icon: "history", title: "Hindsight", detail: "Learns from what happened in its sessions." },
	{ id: "mnemopi", icon: "layers", title: "Mnemopi", detail: "A memory bank of its own, kept apart." },
	{ id: "off", icon: "minus", title: "No memory", detail: "Starts every session knowing nothing." },
];

function MemoryTile({ icon, title, detail, lit }: { readonly icon: IconName; readonly title: string; readonly detail: string; readonly lit: boolean }) {
	return (
		<div
			className={cn(
				"relative z-[1] flex min-w-0 flex-col gap-2 rounded-lg border p-3 fr-t-colors",
				lit ? "border-fr-accent-line bg-fr-surface" : "border-dashed border-fr-border bg-fr-bg opacity-70",
			)}
		>
			<span className={cn("flex size-8 items-center justify-center rounded-md", lit ? "bg-fr-accent-dim text-fr-accent" : "bg-fr-surface-3 text-fr-text-3")}>
				<Icon name={icon} size={16} strokeWidth={1.8} />
			</span>
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className={cn("text-fr-sm font-semibold", lit ? "text-fr-text" : "text-fr-text-2")}>{title}</span>
				<span className="fr-overflow font-secondary text-fr-xs text-fr-text-2" title={detail}>
					{detail}
				</span>
			</span>
			<span className={cn("font-secondary text-fr-2xs", lit ? "text-fr-accent" : "text-fr-text-3")}>{lit ? "Reads" : "Does not read"}</span>
		</div>
	);
}

export function MemorySection({ draft, set, editable, homeId, marked }: SectionProps & { readonly homeId: string | undefined; readonly marked: ReadonlySet<string> }) {
	const off = draft.memory === "off";
	const held = heldByExtra(draft);
	const everyProject = draft.memoryScope === "global";
	return (
		<Section id="agent-memory" title="Memory" lede="What it remembers and where it recalls from. Its home's notes follow it into every project." aside={marked.has("memory") ? <ProposedBadge /> : undefined}>
			<div className={cn(PANEL, "flex flex-col gap-4 p-4")}>
				<div className="relative grid grid-cols-2 gap-3 @3xl:grid-cols-4">
					<span aria-hidden="true" className="absolute top-1/2 right-8 left-8 hidden h-px bg-fr-border @3xl:block" />
					<MemoryTile icon="folder" title="This project" detail="Notes of the project it works in" lit={!off} />
					<MemoryTile icon="pin" title="Its home" detail={homeId ?? "No home: a project agent"} lit={!off && homeId !== undefined} />
					<MemoryTile icon="book" title="Shared notes" detail="Your notes kept for every agent" lit={!off} />
					<MemoryTile icon="globe" title="Other projects" detail="Only when it recalls from every project" lit={!off && everyProject} />
				</div>
				<label className="flex items-center justify-between gap-3 rounded-md border border-fr-border-soft bg-fr-bg px-3 py-2.5">
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="flex items-center gap-1.5 text-fr-sm text-fr-text">
							Recall from every project
							<GrantLock />
						</span>
						<span className="text-fr-xs text-fr-text-2">
							{held.has("workspace.reach") ? "Its reach is set in Other settings." : "Also lets its control verbs reach every project: the grant is one."}
						</span>
					</span>
					<Switch
						aria-label="Recall from every project"
						checked={everyProject && !off}
						disabled={!editable || off || held.has("workspace.reach")}
						onCheckedChange={on => set({ memoryScope: on ? "global" : "project" })}
					/>
				</label>
			</div>
			<ChoiceGroup label="Memory engine" columns={3}>
				{BACKENDS.map(option => (
					<ChoiceCard key={option.id} icon={option.icon} title={option.title} detail={option.detail} checked={!held.has("memory.backend") && draft.memory === option.id} disabled={!editable || held.has("memory.backend")} onSelect={() => set({ memory: option.id })} />
				))}
			</ChoiceGroup>
		</Section>
	);
}

// ── Home ──────────────────────────────────────────────────────────────────────

export function HomeSection({ draft, home, homeId }: { readonly draft: SectionProps["draft"]; readonly home: AgentHome | undefined; readonly homeId: string | undefined }) {
	const worksHere = draft.habitat === "home";
	const winner = home?.instructions.files.find(file => file.wins);
	return (
		<Section id="agent-home" title="Home" lede="Its own folder under your Dimension home: where it works when it lives at home, and where its standing instructions and notes follow it from.">
			<div className={cn(PANEL, "flex flex-col gap-4 p-4 @3xl:flex-row @3xl:items-center")}>
				<span className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-fr-accent-dim text-fr-accent">
					<Icon name="folder" size={28} strokeWidth={1.6} />
				</span>
				<div className="flex min-w-0 flex-1 flex-col gap-1.5">
					<span className="flex flex-wrap items-center gap-2">
						<span className="text-fr-md font-semibold text-fr-text">{homeId ?? "No home"}</span>
						{homeId !== undefined ? (
							<Badge tone={worksHere ? "accent" : "mute"} variant="soft">
								{worksHere ? "Works here" : "Works where you open it"}
							</Badge>
						) : null}
						{home !== undefined && homeId !== undefined ? (
							<Badge tone={home.folderExists ? "add" : "mute"} variant="soft">
								{home.folderExists ? "Set up" : "Set up on its first session"}
							</Badge>
						) : null}
					</span>
					<span className="fr-overflow font-secondary text-fr-xs text-fr-text-2" title={home?.folder ?? undefined}>
						{home?.folder ?? (homeId === undefined ? "A project's own agent belongs to that project and has no home." : "Its folder under your Dimension home.")}
					</span>
					{home !== undefined ? <span className="text-fr-xs text-fr-text-2">{home.homeNote}</span> : null}
				</div>
				{winner !== undefined ? (
					<div className="shrink-0 rounded-md border border-fr-border-soft bg-fr-bg px-3 py-2 @3xl:max-w-80">
						<FileCard name="AGENTS.md" path={winner.path} note={`${winner.bytes} bytes`} />
					</div>
				) : null}
			</div>
		</Section>
	);
}

// ── Brain ─────────────────────────────────────────────────────────────────────

function modelFor(pattern: string, models: readonly ModelFact[] | undefined): ModelFact | undefined {
	return models?.find(model => `${model.providerId}/${model.modelId}` === pattern || model.modelId === pattern || model.label === pattern);
}

function contextLabel(tokens: number | undefined): string | undefined {
	if (tokens === undefined) return undefined;
	return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M context` : `${Math.round(tokens / 1000)}k context`;
}

function ModelCard({ pattern, model, rank, editable, onUp, onDown, onRemove }: { readonly pattern: string; readonly model: ModelFact | undefined; readonly rank: number; readonly editable: boolean; readonly onUp?: () => void; readonly onDown?: () => void; readonly onRemove: () => void }) {
	const context = contextLabel(model?.contextWindow);
	return (
		<li className="flex min-w-0 items-center gap-3 rounded-lg border border-fr-border-soft bg-fr-surface p-3">
			<span className="w-5 shrink-0 text-center font-secondary text-fr-xs text-fr-text-3 tabular-nums">{rank}</span>
			{model ? <ProviderBrandIcon providerId={model.providerId} providerName={model.providerName} size="md" /> : <ProviderBrandIcon providerId="" providerName={pattern} monogram={pattern.charAt(0).toUpperCase()} size="md" />}
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="flex min-w-0 items-center gap-2">
					<span className="fr-overflow text-fr-sm font-medium text-fr-text">{model?.label ?? pattern}</span>
					{rank === 1 ? (
						<Badge tone="accent" variant="soft">
							First choice
						</Badge>
					) : null}
					{model?.reasoning ? (
						<Badge tone="mute" variant="soft">
							Reasons
						</Badge>
					) : null}
				</span>
				<span className="fr-overflow font-secondary text-fr-xs text-fr-text-2">
					{model ? [model.providerName, context, model.available ? undefined : "not connected"].filter(Boolean).join(" · ") : "Not in this host's catalog; used when it is"}
				</span>
			</div>
			{editable ? (
				<span className="flex shrink-0 items-center gap-0.5">
					<button type="button" aria-label="Move up" disabled={onUp === undefined} onClick={onUp} className="flex size-7 items-center justify-center rounded-md text-fr-text-2 hover:bg-fr-surface-2 hover:text-fr-text disabled:opacity-30">
						<Icon name="arrowU" size={13} strokeWidth={2} />
					</button>
					<button type="button" aria-label="Move down" disabled={onDown === undefined} onClick={onDown} className="flex size-7 items-center justify-center rounded-md text-fr-text-2 hover:bg-fr-surface-2 hover:text-fr-text disabled:opacity-30">
						<Icon name="arrowD" size={13} strokeWidth={2} />
					</button>
					<button type="button" aria-label={`Remove ${model?.label ?? pattern}`} onClick={onRemove} className="flex size-7 items-center justify-center rounded-md text-fr-text-2 hover:bg-fr-surface-2 hover:text-fr-del">
						<Icon name="x" size={13} strokeWidth={2} />
					</button>
				</span>
			) : null}
		</li>
	);
}

const METER: readonly Exclude<Thinking, "inherit">[] = THINKING_STEPS.filter((step): step is Exclude<Thinking, "inherit"> => step !== "inherit");

function ThinkingMeter({ value, editable, onChange }: { readonly value: Thinking; readonly editable: boolean; readonly onChange: (next: Thinking) => void }) {
	const level = METER.indexOf(value as Exclude<Thinking, "inherit">);
	return (
		<div className="flex flex-wrap items-end gap-4">
			<div role="radiogroup" aria-label="Thinking" className="flex items-end gap-1.5">
				{METER.map((step, index) => {
					const on = value !== "inherit" && index <= level;
					return (
						<button
							key={step}
							type="button"
							role="radio"
							aria-checked={value === step}
							aria-label={humanize(step)}
							disabled={!editable}
							onClick={() => onChange(step)}
							className="group/step flex flex-col items-center gap-1.5 disabled:cursor-default"
						>
							<span
								className={cn("w-9 rounded-sm fr-t-colors", on ? "bg-fr-accent" : "bg-fr-surface-3", editable && !on && "group-hover/step:bg-fr-border")}
								style={{ height: `${10 + index * 7}px` }}
							/>
							<span className={cn("font-secondary text-fr-2xs", value === step ? "text-fr-text" : "text-fr-text-2")}>{step === "xhigh" ? "Max" : humanize(step)}</span>
						</button>
					);
				})}
			</div>
			<button
				type="button"
				role="radio"
				aria-checked={value === "inherit"}
				disabled={!editable}
				onClick={() => onChange("inherit")}
				className={cn(
					"rounded-full border px-3 py-1 font-secondary text-fr-xs fr-t-colors disabled:cursor-default",
					value === "inherit" ? "border-fr-accent-line bg-fr-accent-dim text-fr-accent" : "border-fr-border-soft text-fr-text-2 hover:border-fr-border",
				)}
			>
				Dimension's default
			</button>
		</div>
	);
}

export function BrainSection({ draft, set, editable, models, marked }: SectionProps & { readonly models: readonly ModelFact[] | undefined; readonly marked: ReadonlySet<string> }) {
	const held = heldByExtra(draft);
	const canModels = editable && !held.has("engine.model");
	const move = (from: number, to: number) => {
		const next = [...draft.models];
		const [moved] = next.splice(from, 1);
		if (moved !== undefined) next.splice(to, 0, moved);
		set({ models: next });
	};
	const options = (models ?? [])
		.filter(model => model.kind !== "classify" && !draft.models.includes(`${model.providerId}/${model.modelId}`))
		.map(model => ({
			id: `${model.providerId}/${model.modelId}`,
			label: model.label,
			detail: [model.providerName, contextLabel(model.contextWindow), model.available ? undefined : "not connected"].filter(Boolean).join(" · "),
			lead: <ProviderBrandIcon providerId={model.providerId} providerName={model.providerName} size={20} />,
		}));
	return (
		<Section id="agent-brain" title="Brain" lede="The models it runs on, first available wins, and how hard it thinks." aside={marked.has("thinking") ? <ProposedBadge /> : undefined}>
			<div className="grid grid-cols-1 gap-4 @4xl:grid-cols-[3fr_2fr]">
				<div className={cn(PANEL, "flex flex-col gap-3 p-4")}>
					<span className="text-fr-sm font-medium text-fr-text">Model stack</span>
					{held.has("engine.model") ? <p className="m-0 text-fr-xs text-fr-text-2">Its models are set in Other settings, under Advanced.</p> : null}
					{draft.models.length === 0 ? (
						<div className="flex items-center gap-3 rounded-lg border border-dashed border-fr-border px-3 py-3">
							<span className="flex size-8 items-center justify-center rounded-md bg-fr-surface-3 text-fr-text-2">
								<Icon name="aether" size={16} strokeWidth={1.8} />
							</span>
							<span className="flex flex-col gap-0.5">
								<span className="text-fr-sm font-medium text-fr-text">Dimension's default model</span>
								<span className="text-fr-xs text-fr-text-2">Whatever model a session picks. Add one to pin it.</span>
							</span>
						</div>
					) : (
						<ol className="m-0 flex list-none flex-col gap-2 p-0">
							{draft.models.map((pattern, index) => (
								<ModelCard
									key={pattern}
									pattern={pattern}
									model={modelFor(pattern, models)}
									rank={index + 1}
									editable={canModels}
									{...(index > 0 ? { onUp: () => move(index, index - 1) } : {})}
									{...(index < draft.models.length - 1 ? { onDown: () => move(index, index + 1) } : {})}
									onRemove={() => set({ models: draft.models.filter(entry => entry !== pattern) })}
								/>
							))}
						</ol>
					)}
					{canModels ? <PickList placeholder="Add a model" options={options} onPick={id => set({ models: [...draft.models, id] })} /> : null}
				</div>
				<div className={cn(PANEL, "flex flex-col gap-3 p-4")}>
					<span className="text-fr-sm font-medium text-fr-text">Thinking</span>
					{held.has("engine.thinkingLevel") ? (
						<p className="m-0 text-fr-xs text-fr-text-2">Its thinking level is set in Other settings, under Advanced.</p>
					) : (
						<ThinkingMeter value={draft.thinking} editable={editable} onChange={thinking => set({ thinking })} />
					)}
					<span className="text-fr-xs text-fr-text-2">A session can still turn it up or down; this is where it starts.</span>
				</div>
			</div>
		</Section>
	);
}

// ── Safety ────────────────────────────────────────────────────────────────────

const APPROVALS: readonly { readonly id: Approval; readonly icon: IconName; readonly title: string; readonly detail: string }[] = [
	{ id: "always-ask", icon: "hand", title: "Ask before everything", detail: "Every tool call waits for you." },
	{ id: "write", icon: "edit", title: "Ask before writes", detail: "Reads freely; asks before it changes anything." },
	{ id: "yolo", icon: "bolt", title: "Never asks", detail: "Runs every tool on its own. Only for agents you trust." },
];

const HABITATS: readonly { readonly id: Habitat; readonly icon: IconName; readonly title: string; readonly detail: string }[] = [
	{ id: "bound", icon: "folder", title: "Where you open it", detail: "Works in the project you start its session in." },
	{ id: "home", icon: "pin", title: "In its own home", detail: "Always works in its home folder, whatever is open." },
	{ id: "ephemeral", icon: "branch", title: "A scratch copy", detail: "A throwaway worktree; nothing lands until you merge." },
];

/** The Dimension Control lanes (`capabilities.control`) and what each lets it do. */
const LANES: readonly { readonly id: string; readonly icon: IconName; readonly label: string; readonly detail: string }[] = [
	{ id: "observe", icon: "eye", label: "Observe", detail: "Read other sessions" },
	{ id: "create", icon: "plus", label: "Create", detail: "Start sessions" },
	{ id: "steer", icon: "send", label: "Steer", detail: "Message running sessions" },
	{ id: "command", icon: "terminal", label: "Command", detail: "Run slash commands" },
	{ id: "end", icon: "x", label: "End", detail: "Stop sessions" },
	{ id: "rooms", icon: "orbit", label: "Rooms", detail: "Open and run rooms" },
	{ id: "agents", icon: "bot", label: "Agents", detail: "Create agents" },
];
const DEFAULT_LANES = ["observe", "create", "steer", "command"];

export function SafetySection({ draft, set, editable }: SectionProps & { readonly marked: ReadonlySet<string> }) {
	const held = heldByExtra(draft);
	const approval: ApprovalSetting = draft.approval;
	const control = parseExtra(draft.extra).blocks.find(block => block.key === "capabilities")?.children?.find(child => child.key === "control");
	const controlHeld = control !== undefined && extraList(draft.extra, "capabilities.control") === null;
	const declared = extraList(draft.extra, "capabilities.control");
	const lanes = declared ?? DEFAULT_LANES;
	const toggleLane = (lane: string) => {
		const next = lanes.includes(lane) ? lanes.filter(entry => entry !== lane) : [...lanes, lane];
		const ordered = LANES.map(entry => entry.id).filter(id => next.includes(id));
		const same = ordered.length === DEFAULT_LANES.length && DEFAULT_LANES.every(id => ordered.includes(id));
		set({ extra: setExtraPath(draft.extra, "capabilities.control", same ? null : flowList(ordered)) });
	};
	return (
		<Section id="agent-safety" title="Safety" lede="How far it may go on its own. Only you set these: the Machinist can never propose them." aside={<GrantLock />}>
			<div className="flex flex-col gap-2.5">
				<span className="flex items-center justify-between gap-2 text-fr-sm font-medium text-fr-text">
					<span className="flex items-center gap-1.5">
						Approval
						<GrantLock />
					</span>
					<button
						type="button"
						disabled={!editable || held.has("gate.approval")}
						onClick={() => set({ approval: "inherit" })}
						className={cn("rounded-full border px-3 py-1 font-secondary text-fr-xs font-normal fr-t-colors disabled:cursor-default", approval === "inherit" ? "border-fr-accent-line bg-fr-accent-dim text-fr-accent" : "border-fr-border-soft text-fr-text-2 hover:border-fr-border")}
					>
						Follow Dimension's setting
					</button>
				</span>
				<ChoiceGroup label="Approval">
					{APPROVALS.map(option => (
						<ChoiceCard key={option.id} icon={option.icon} title={option.title} detail={option.detail} checked={approval === option.id} disabled={!editable || held.has("gate.approval")} onSelect={() => set({ approval: option.id })} />
					))}
				</ChoiceGroup>
			</div>
			<div className="flex flex-col gap-2.5">
				<span className="flex items-center gap-1.5 text-fr-sm font-medium text-fr-text">
					Where it runs
					<GrantLock />
				</span>
				{held.has("workspace.policy") ? <p className="m-0 text-fr-xs text-fr-text-2">Its workspace is set in Other settings, under Advanced.</p> : null}
				<ChoiceGroup label="Where it runs">
					{HABITATS.map(option => (
						<ChoiceCard key={option.id} icon={option.icon} title={option.title} detail={option.detail} checked={!held.has("workspace.policy") && draft.habitat === option.id} disabled={!editable || held.has("workspace.policy")} onSelect={() => set({ habitat: option.id })} />
					))}
				</ChoiceGroup>
			</div>
			<div className="flex flex-col gap-2.5">
				<span className="flex items-center gap-1.5 text-fr-sm font-medium text-fr-text">
					Session lanes
					<GrantLock />
					<span className="font-secondary text-fr-xs font-normal text-fr-text-2">{declared === null ? "Dimension's default lanes" : `${lanes.length} of ${LANES.length}`}</span>
				</span>
				{controlHeld ? <p className="m-0 text-fr-xs text-fr-text-2">Its lanes carry per-lane approvals, set in Other settings under Advanced.</p> : null}
				<div className="flex flex-wrap gap-2" role="group" aria-label="Session lanes">
					{LANES.map(lane => {
						const on = lanes.includes(lane.id);
						return (
							<button
								key={lane.id}
								type="button"
								aria-pressed={on}
								disabled={!editable || controlHeld}
								onClick={() => toggleLane(lane.id)}
								title={lane.detail}
								className={cn(
									"inline-flex items-center gap-2 rounded-full border py-1.5 pr-3 pl-2 text-fr-sm fr-t-colors disabled:cursor-default",
									on ? "border-fr-accent-line bg-fr-accent-dim text-fr-text" : "border-fr-border-soft bg-fr-surface text-fr-text-2",
									editable && !controlHeld && !on && "hover:border-fr-border hover:text-fr-text",
								)}
							>
								<span className={cn("flex size-5 items-center justify-center rounded-full", on ? "bg-fr-accent text-fr-accent-ink" : "bg-fr-surface-3 text-fr-text-3")}>
									<Icon name={lane.icon} size={11} strokeWidth={2.2} />
								</span>
								{lane.label}
								<span className="font-secondary text-fr-xs text-fr-text-2">{lane.detail}</span>
							</button>
						);
					})}
				</div>
			</div>
		</Section>
	);
}

// ── Lineage ───────────────────────────────────────────────────────────────────

export function LineageSection({
	draft,
	set,
	editable,
	roster,
	self,
	faceOf,
	bridged,
}: SectionProps & { readonly roster: readonly RosterAgent[]; readonly self: string | undefined; readonly faceOf: (name: string) => FaceBinding; readonly bridged: BridgedPresences | undefined }) {
	const options = roster
		.filter(agent => agent.name !== self && agent.name !== draft.name && !draft.lineage.includes(agent.name))
		.map(agent => ({ id: agent.name, label: displayName(agent), detail: `${agent.name} · ${TIER_LABEL[agent.tier]}`, lead: <FaceTile face={faceOf(agent.name)} tile={24} presence={20} live={false} bridged={bridged} name={displayName(agent)} ring={false} className="rounded-md" /> }));
	return (
		<Section id="agent-lineage" title="Lineage" lede="The agents it extends: it takes their settings, key by key, and its own win. Their charters are never inherited.">
			<div className={cn(PANEL, "flex flex-col gap-3 p-4")}>
				{draft.lineage.length === 0 ? (
					<p className="m-0 text-fr-sm text-fr-text-2">It extends no agent: everything it is, it says itself.</p>
				) : (
					<ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 @2xl:grid-cols-2 @5xl:grid-cols-3">
						{draft.lineage.map((base, index) => {
							const agent = roster.find(candidate => candidate.name === base);
							const title = agent ? displayName(agent) : humanize(base);
							return (
								<li key={base} className="flex min-w-0 items-center gap-3 rounded-lg border border-fr-border-soft bg-fr-bg p-3">
									<FaceTile face={faceOf(base)} tile={44} presence={36} live={false} bridged={bridged} name={title} />
									<div className="flex min-w-0 flex-1 flex-col gap-0.5">
										<span className="fr-overflow text-fr-sm font-medium text-fr-text">{title}</span>
										<span className="fr-overflow font-secondary text-fr-xs text-fr-text-2">{agent ? `${base} · ${TIER_LABEL[agent.tier]}` : `${base} · not installed`}</span>
									</div>
									{index === 0 && draft.lineage.length > 1 ? <span className="font-secondary text-fr-2xs text-fr-text-3">First</span> : null}
									{editable ? (
										<button type="button" aria-label={`Stop extending ${title}`} onClick={() => set({ lineage: draft.lineage.filter(entry => entry !== base) })} className="flex size-7 items-center justify-center rounded-md text-fr-text-2 hover:bg-fr-surface-2 hover:text-fr-del">
											<Icon name="x" size={13} strokeWidth={2} />
										</button>
									) : null}
								</li>
							);
						})}
					</ul>
				)}
				{editable ? <PickList placeholder="Extend another agent" options={options} onPick={name => set({ lineage: [...draft.lineage, name] })} /> : null}
			</div>
		</Section>
	);
}

// ── Advanced ──────────────────────────────────────────────────────────────────

export function AdvancedSection({ draft, set, editable, homeId, problems }: SectionProps & { readonly homeId: string | undefined; readonly problems: readonly string[] }) {
	const grants = grantPathsIn(draft.extra);
	const document = manifestDocument(draft, homeId ?? null);
	const issues = [...document.problems, ...problems.filter(problem => !document.problems.includes(problem))];
	return (
		<Section id="agent-advanced" title="Advanced" lede="Every manifest key the profile does not draw, as the file says it, and the agent.md this profile writes.">
			<div className="grid grid-cols-1 gap-4 @5xl:grid-cols-2">
				<div className={cn(PANEL, "flex flex-col overflow-hidden")}>
					<div className="flex items-center justify-between gap-2 border-b border-fr-border-soft px-4 py-2.5">
						<span className="text-fr-sm font-medium text-fr-text">Other settings</span>
						<span className="font-secondary text-fr-xs text-fr-text-2">YAML</span>
					</div>
					<Textarea
						variant="ghost"
						resize="vertical"
						value={draft.extra}
						readOnly={!editable}
						aria-label="Other settings"
						spellCheck={false}
						placeholder={"title: Release Herald\nrouting:\n  card: Writes the changelog"}
						onChange={event => set({ extra: event.target.value })}
						className="max-h-none min-h-56 flex-1 rounded-none border-0 px-4 py-3 font-code text-fr-sm leading-relaxed"
					/>
					{grants.length > 0 ? (
						<p className="m-0 flex items-center gap-2 border-t border-fr-border-soft px-4 py-2 text-fr-xs text-fr-text-2">
							<GrantLock />
							Sets {grants.join(", ")}, which only you may set.
						</p>
					) : null}
					{issues.length > 0 ? (
						<ul role="alert" className="m-0 flex list-none flex-col gap-1 border-t border-fr-border-soft px-4 py-2.5">
							{issues.map(issue => (
								<li key={issue} className="flex items-start gap-1.5 text-fr-xs text-fr-del">
									<Icon name="warnTri" size={12} strokeWidth={2} className="mt-0.5 shrink-0" />
									{issue}
								</li>
							))}
						</ul>
					) : null}
				</div>
				<div className={cn(PANEL, "flex flex-col overflow-hidden")}>
					<div className="flex items-center justify-between gap-2 border-b border-fr-border-soft px-4 py-2.5">
						<span className="text-fr-sm font-medium text-fr-text">agent.md</span>
						<span className="font-secondary text-fr-xs text-fr-text-2">What a save writes</span>
					</div>
					<pre className="m-0 max-h-120 min-h-56 flex-1 overflow-auto bg-fr-bg px-4 py-3 font-code text-fr-xs leading-relaxed text-fr-text-2">
						{document.lines.map((line, index) => (
							<Line key={`${index}:${line.field}`} n={index + 1} extra={line.field.startsWith("extra.")}>
								{line.text}
							</Line>
						))}
					</pre>
				</div>
			</div>
		</Section>
	);
}

function Line({ n, extra, children }: { readonly n: number; readonly extra: boolean; readonly children: ReactNode }) {
	return (
		<span className="flex gap-3">
			<span className="w-6 shrink-0 text-right text-fr-text-3 select-none tabular-nums">{n}</span>
			<span className={cn("min-w-0 whitespace-pre-wrap", extra ? "text-fr-text-2" : "text-fr-text")}>{children}</span>
		</span>
	);
}
