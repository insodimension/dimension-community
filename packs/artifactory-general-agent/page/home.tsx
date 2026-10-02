// The home: a hero band with the roster's pulse, then every agent as a card in
// the Autonomy page's anatomy (its face on its accent, who it is, its switch,
// what it may use, where it stands, and what its week added up to), grouped by
// where it comes from. A card opens that agent's profile.
import {
	ActivityDot,
	Badge,
	Button,
	CapabilityChip,
	Icon,
	MarketplaceFilterPills,
	McpMark,
	NebulaBackdrop,
	PluginMark,
	SkillMark,
	Skeleton,
	Switch,
	cn,
} from "@fraym/ui";
import { memo, type ReactNode, useCallback, useMemo, useState } from "react";
import type { AgentDraft } from "../src/agent-md";
import type { StoredProposal } from "../src/contracts";
import { CardStat, FaceTile, LABEL, Section, ViewColumn } from "./chrome";
import { type AgentActivity, agoLabel, type LiveState, liveStateOf, money, NO_ACTIVITY, tokenLabel } from "./kpis";
import {
	allowlistOf,
	displayName,
	type Facet,
	FACET_LABEL,
	facetCounts,
	humanize,
	inFacet,
	isEditable,
	type RosterAgent,
	TIER_LABEL,
} from "./roster";
import type { BridgedPresences, CapabilityCount, CatalogFact, FaceBinding, UsageFact } from "./types";
import { type AgentVoice, isExplicitVoice, SOURCE_LABELS } from "./voice";

const GRID = "grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3";

/** A label on the hero: text at 80%, which the lit nebula keeps above AA. */
const HERO_LABEL = "font-secondary text-fr-2xs font-semibold tracking-fr-label text-fr-text/80";

const LANES: readonly { readonly facet: Facet; readonly heading: string; readonly note?: string }[] = [
	{ facet: "yours", heading: "Yours" },
	{ facet: "project", heading: "This project" },
	{ facet: "packs", heading: "From packs", note: "Read-only here. Extend one to make an agent of your own that starts from it." },
];

export interface UsageRow {
	readonly tokens: number;
	readonly cost: number;
	readonly turns: number;
}

export function usageOf(usage: UsageFact | undefined, name: string): UsageRow | undefined {
	return usage?.agents.find(row => row.name === name);
}

/** The live badge: an accent pill while it works, the fixed violet while it waits on you. */
export function LivePill({ state, count }: { readonly state: LiveState; readonly count: number }) {
	if (state === "idle") return null;
	const needs = state === "needs-you";
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-1.5 font-secondary text-fr-xs",
				needs ? "bg-fr-iris/15 text-fr-iris" : "bg-fr-accent-dim text-fr-accent",
			)}
		>
			<ActivityDot state={state} />
			{needs ? "Needs you" : "Working"}
			{count > 1 ? <span className="tabular-nums opacity-80">{count}</span> : null}
		</span>
	);
}

/** What the agent may use, as the Capabilities page draws it: the first few
 *  skills, plugins and servers it is limited to as marks and a count of the
 *  rest, else what it is not limited in. */
export function CapabilityStrip({ agent, catalog, max = 3 }: { readonly agent: RosterAgent; readonly catalog: CatalogFact | undefined; readonly max?: number }) {
	const draft = agent.listed?.draft;
	const hostTools = agent.fact?.capabilities?.tools;
	// The allowlists are read out of the draft's text (`allowlistOf` parses it per
	// kind): once per draft, not once per render of the card around them.
	const named = useMemo(() => namedCapabilities(draft), [draft]);
	const tools = useMemo(() => toolsSummary(draft, hostTools), [draft, hostTools]);
	const chips = named.slice(0, max).map(item => <CapabilityChip key={`${item.kind}:${item.name}`} mark={markOf(item.kind, item.name, catalog, 14)} label={humanize(item.name)} />);
	const rest = Math.max(0, named.length - max);
	return (
		<div data-slot="agent-capabilities" className="flex min-h-7 min-w-0 flex-wrap items-center gap-1.5">
			{chips}
			{rest > 0 ? <span className="rounded-sm bg-fr-surface-3 px-2 py-1 font-secondary text-fr-xs text-fr-text-2 tabular-nums">+{rest}</span> : null}
			{tools !== null ? (
				<span className={cn("inline-flex items-center gap-1.5 font-secondary text-fr-xs text-fr-text-2", chips.length === 0 && "rounded-sm bg-fr-surface-3 px-2 py-1")}>
					<Icon name={tools.every ? "layers" : "sliders"} size={12} strokeWidth={2} aria-hidden="true" />
					{tools.words}
				</span>
			) : null}
		</div>
	);
}

/** The skills, plugins and servers a draft is limited to, in the order the strip draws them. */
function namedCapabilities(draft: AgentDraft | undefined): { readonly kind: "skills" | "plugins" | "mcp"; readonly name: string }[] {
	const named: { readonly kind: "skills" | "plugins" | "mcp"; readonly name: string }[] = [];
	if (draft === undefined) return named;
	for (const kind of ["skills", "plugins", "mcp"] as const) {
		const list = allowlistOf(draft, kind);
		if (list.kind === "some") for (const name of list.names) named.push({ kind, name });
	}
	return named;
}

/** The agent's tool reach in words: its file's allowlist, else the host's count. */
function toolsSummary(draft: AgentDraft | undefined, hostTools: CapabilityCount | undefined): { readonly words: string; readonly every: boolean } | null {
	if (draft !== undefined) {
		const list = allowlistOf(draft, "tools");
		if (list.kind === "all") return { words: "Every tool", every: true };
		if (list.kind === "none") return { words: "No tools", every: false };
		return { words: `${list.names.length} ${list.names.length === 1 ? "tool" : "tools"}`, every: false };
	}
	if (hostTools === undefined) return null;
	if (hostTools === "all") return { words: "Every tool", every: true };
	return { words: `${hostTools} ${hostTools === 1 ? "tool" : "tools"}`, every: false };
}

/** The mark of one capability, drawn from the catalog record when there is one. */
export function markOf(kind: "skills" | "plugins" | "mcp", name: string, catalog: CatalogFact | undefined, size: number): ReactNode {
	if (kind === "plugins") {
		const plugin = catalog?.plugins.find(record => pluginMatches(record.name, name));
		return <PluginMark plugin={plugin ?? { name }} size={size} />;
	}
	if (kind === "skills") {
		const skill = catalog?.skills.find(record => record.name === name);
		const owner = skill?.pluginId === undefined ? undefined : catalog?.plugins.find(record => record.id === skill.pluginId);
		return <SkillMark name={name} {...(owner !== undefined ? { pluginIcon: owner } : {})} size={size} />;
	}
	return <McpMark name={name} size={size} />;
}

/** A plugin allowlist entry names a package, or its unscoped basename. */
export function pluginMatches(recordName: string, entry: string): boolean {
	if (recordName === entry) return true;
	const base = recordName.startsWith("@") ? recordName.slice(recordName.indexOf("/") + 1) : recordName;
	return base === entry;
}

function standing(activity: AgentActivity, state: LiveState, now: number): { readonly text: string; readonly tone: "accent" | "iris" | "mute" } {
	if (state === "needs-you") return { text: activity.needsYou === 1 ? "Waiting on your answer" : `${activity.needsYou} sessions waiting on you`, tone: "iris" };
	if (state === "working") return { text: activity.working === 1 ? "Working now" : `Working in ${activity.working} sessions`, tone: "accent" };
	return { text: activity.lastActive === null ? "Never used" : `Last active · ${agoLabel(activity.lastActive, now)}`, tone: "mute" };
}

/** Memoized: the page re-renders on every coalesced session update, and a card
 *  whose props are the same objects as last time draws the same thing. Its
 *  handlers take the name, so one stable function serves every card. */
const AgentCard = memo(function AgentCard({
	agent,
	activity,
	usage,
	now,
	face,
	bridged,
	catalog,
	voice,
	busy,
	onOpen,
	onToggle,
}: {
	readonly agent: RosterAgent;
	readonly activity: AgentActivity;
	readonly usage: UsageRow | undefined;
	readonly now: number;
	readonly face: FaceBinding;
	readonly bridged: BridgedPresences | undefined;
	readonly catalog: CatalogFact | undefined;
	readonly voice: AgentVoice | undefined;
	readonly busy: boolean;
	readonly onOpen: ((name: string) => void) | undefined;
	readonly onToggle: ((name: string, on: boolean) => void) | undefined;
}) {
	const [live, setLive] = useState(false);
	const state = liveStateOf(activity);
	const stand = standing(activity, state, now);
	const title = displayName(agent);
	const enabled = agent.fact?.enabled !== false;
	const description = agent.fact?.description ?? agent.listed?.description ?? "";
	return (
		<article
			data-slot="agent-card"
			data-state={state}
			onPointerEnter={() => setLive(true)}
			onPointerLeave={() => setLive(false)}
			onFocus={() => setLive(true)}
			onBlur={event => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setLive(false);
			}}
			className={cn(
				"group/card relative flex flex-col overflow-hidden rounded-lg border bg-fr-surface fr-t-colors",
				state === "needs-you" ? "border-fr-iris/40 hover:border-fr-iris/70" : "border-fr-border-soft hover:border-fr-border",
			)}
		>
			<div className="flex items-start gap-3.5 px-4 pt-4">
				<FaceTile face={face} tile={64} presence={52} live={live} bridged={bridged} name={title} className={cn(!enabled && "opacity-55 saturate-0")} />
				<div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
					<h3 className="m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
						{/* The name is the card's link; its box stretches over the card, under the controls. */}
						<button
							type="button"
							onClick={onOpen === undefined ? undefined : () => onOpen(agent.name)}
							disabled={onOpen === undefined}
							title={agent.name}
							className={cn(
								"min-w-0 fr-overflow text-left text-fr-md font-semibold fr-t-colors after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-fr-accent-line disabled:cursor-default",
								enabled ? "text-fr-text" : "text-fr-text-2",
							)}
						>
							{title}
						</button>
						<Badge tone="mute" variant="soft">
							{TIER_LABEL[agent.tier]}
						</Badge>
						<LivePill state={state} count={state === "needs-you" ? activity.needsYou : activity.working} />
					</h3>
					<p className="m-0 line-clamp-2 min-h-[2lh] text-fr-sm leading-relaxed text-pretty text-fr-text-2">{description || "No description yet."}</p>
				</div>
				{onToggle !== undefined ? (
					<span className="relative z-[1] pt-0.5">
						<Switch aria-label={`${title} enabled`} checked={enabled} disabled={busy} onCheckedChange={on => onToggle(agent.name, on)} />
					</span>
				) : (
					<span className={cn("relative pt-1 font-secondary text-fr-xs", enabled ? "text-fr-text-2" : "text-fr-text-3")}>{enabled ? "On" : "Off"}</span>
				)}
			</div>
			<div className="mx-4 mt-3.5 rounded-lg border border-fr-border-soft bg-fr-bg px-3 py-2.5 fr-t-colors group-hover/card:border-fr-border">
				<CapabilityStrip agent={agent} catalog={catalog} />
			</div>
			<div className="mt-auto flex items-center justify-between gap-3 px-4 pt-3">
				<span className={cn("flex min-w-0 items-center gap-2 font-secondary text-fr-xs", stand.tone === "accent" ? "text-fr-accent" : stand.tone === "iris" ? "text-fr-iris" : "text-fr-text-2")}>
					<ActivityDot state={state === "idle" ? (enabled ? "idle" : "off") : state} />
					<span className="fr-overflow">{stand.text}</span>
				</span>
				<span className="flex shrink-0 items-center gap-2.5">
					{isExplicitVoice(voice) ? (
						<span title={`Speaks with ${voice.name}. ${SOURCE_LABELS[voice.source]}.`} className="flex min-w-0 items-center gap-1 font-secondary text-fr-xs text-fr-text-2">
							<Icon name="waveform" size={12} strokeWidth={1.8} aria-hidden="true" />
							<span className="fr-overflow max-w-24">{voice.name}</span>
						</span>
					) : null}
					{agent.fact !== undefined && enabled && !agent.fact.listed ? <span className="font-secondary text-fr-xs text-fr-text-2">Hidden from rail</span> : null}
				</span>
			</div>
			<dl className="m-0 mt-3 grid grid-cols-4 divide-x divide-fr-border-soft border-t border-fr-border-soft">
				<CardStat value={`${activity.sessions7d}`} label="Sessions 7d" title={`${activity.sessions7d} sessions active in the last 7 days, ${activity.sessionsTotal} in all`} quiet={activity.sessions7d === 0} />
				<CardStat value={usage ? tokenLabel(usage.tokens) : "–"} label="Tokens 7d" title={usage ? `${usage.tokens.toLocaleString("en-US")} tokens in the last 7 days` : "Not measured yet"} quiet={!usage || usage.tokens === 0} />
				<CardStat value={usage ? money(usage.cost) : "–"} label="Cost 7d" title={usage ? `${money(usage.cost)} in the last 7 days` : "Not measured yet"} quiet={!usage || usage.cost === 0} />
				<CardStat value={`${activity.roomsLed}`} label="Rooms led" title={`Leads ${activity.roomsLed} ${activity.roomsLed === 1 ? "room" : "rooms"}`} quiet={activity.roomsLed === 0} />
			</dl>
		</article>
	);
});

function HomeSkeleton() {
	return (
		<div role="status" aria-busy="true" className={GRID}>
			<span className="sr-only">Loading your agents…</span>
			{[0, 1, 2, 3, 4, 5].map(key => (
				<div key={key} className="flex flex-col gap-3.5 rounded-lg border border-fr-border-soft bg-fr-surface p-4">
					<div className="flex items-start gap-3.5">
						<Skeleton className="size-16 shrink-0" rounded="lg" />
						<div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
							<Skeleton className="h-4 w-32" rounded="sm" />
							<Skeleton className="h-3 w-full max-w-56" rounded="sm" />
							<Skeleton className="h-3 w-40" rounded="sm" />
						</div>
					</div>
					<Skeleton className="h-11 w-full" rounded="lg" />
					<Skeleton className="h-3 w-36" rounded="sm" />
					<Skeleton className="h-9 w-full" rounded="sm" />
				</div>
			))}
		</div>
	);
}

/** Things to say to the Machinist, which builds agents with you. */
const ASK_FOR = ["An agent that writes our changelog in my voice", "A researcher that reads papers and keeps notes", "A reviewer that only comments, never edits"] as const;

function EmptyHome({ onCreate, onDock }: { readonly onCreate: () => void; readonly onDock: (() => void) | undefined }) {
	return (
		<div className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3.5 gap-y-5 rounded-lg border border-fr-border-soft bg-fr-surface px-5 py-6">
			<span className="flex size-10 items-center justify-center rounded-lg bg-fr-surface-3 text-fr-text-2">
				<Icon name="bot" size={20} strokeWidth={1.7} />
			</span>
			<div className="flex min-w-0 flex-col gap-1">
				<h2 className="m-0 text-fr-lg font-semibold text-fr-text">No agents here yet</h2>
				<p className="m-0 max-w-prose text-fr-sm leading-relaxed text-pretty text-fr-text-2">
					A General Agent is someone you can open a session as: its own charter, face, tools and memory. Create one by hand, or tell the Machinist what you
					want and it drafts one for you to accept.
				</p>
			</div>
			<div className="col-start-2 flex flex-col gap-3">
				<div className="flex flex-wrap gap-2">
					<Button size="sm" onClick={onCreate}>
						<Icon name="plus" strokeWidth={2} />
						Create agent
					</Button>
					{onDock ? (
						<Button size="sm" variant="outline" onClick={onDock}>
							<Icon name="bot" strokeWidth={2} />
							Ask the Machinist
						</Button>
					) : null}
				</div>
				<span className="font-secondary text-fr-xs text-fr-text-2">Try asking the Machinist</span>
				<ul className="m-0 flex list-none flex-col gap-1.5 p-0">
					{ASK_FOR.map(line => (
						<li key={line} className="flex items-baseline gap-2 text-fr-sm text-fr-text">
							<Icon name="caretR" size={12} strokeWidth={2} className="shrink-0 translate-y-px text-fr-accent" />
							<span>“{line}”</span>
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

/** The Machinist's undecided proposals, each one a door to its profile. */
function ProposalsBanner({
	proposals,
	roster,
	faceOf,
	bridged,
	onReview,
}: {
	readonly proposals: readonly StoredProposal[];
	readonly roster: readonly RosterAgent[];
	readonly faceOf: (name: string) => FaceBinding;
	readonly bridged: BridgedPresences | undefined;
	readonly onReview: (entry: StoredProposal) => void;
}) {
	return (
		<Section title="Proposed by the Machinist" count={proposals.length} lede="Drafts it made while you talked. Open one to accept, change or discard it; nothing is written until you save.">
			<ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 @4xl:grid-cols-2">
				{proposals.map(entry => {
					const known = roster.find(agent => agent.name === entry.proposal.name);
					const fields = Object.keys(entry.proposal).filter(field => field !== "name");
					return (
						<li key={entry.id} className="flex items-center gap-3 rounded-lg border border-fr-accent-line bg-fr-accent-dim/40 px-3.5 py-3">
							<FaceTile face={entry.proposal.vibr ? { avatar: entry.proposal.vibr as FaceBinding["avatar"] } : faceOf(entry.proposal.name)} tile={40} presence={32} live={false} bridged={bridged} name={entry.proposal.name} ring={false} />
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="fr-overflow text-fr-sm font-semibold text-fr-text">{known ? `Changes to ${displayName(known)}` : `A new agent: ${humanize(entry.proposal.name)}`}</span>
								<span className="fr-overflow font-secondary text-fr-xs text-fr-text-2">{fields.length > 0 ? `Sets ${fields.join(", ")}` : "Names it"}</span>
							</div>
							<Button size="sm" variant="outline" onClick={() => onReview(entry)}>
								Review
							</Button>
						</li>
					);
				})}
			</ul>
		</Section>
	);
}

export function AgentsHome({
	roster,
	loading,
	listingError,
	activity,
	usage,
	catalog,
	voices,
	now,
	faceOf,
	bridged,
	proposals,
	onReview,
	onOpen,
	onCreate,
	onDock,
	configure,
	busy,
	notice,
}: {
	readonly roster: readonly RosterAgent[];
	readonly loading: boolean;
	readonly listingError: string | undefined;
	readonly activity: ReadonlyMap<string, AgentActivity>;
	readonly usage: UsageFact | undefined;
	readonly catalog?: CatalogFact | undefined;
	readonly voices: ReadonlyMap<string, AgentVoice>;
	readonly now: number;
	readonly faceOf: (name: string) => FaceBinding;
	readonly bridged: BridgedPresences | undefined;
	readonly proposals: readonly StoredProposal[];
	readonly onReview: (entry: StoredProposal) => void;
	readonly onOpen: (name: string) => void;
	readonly onCreate: () => void;
	readonly onDock: (() => void) | undefined;
	readonly configure: ((name: string, patch: { readonly enabled?: boolean }) => Promise<void>) | undefined;
	readonly busy: ReadonlySet<string>;
	readonly notice: string | undefined;
}) {
	const [facet, setFacet] = useState<Facet>("all");
	const toggle = useCallback((name: string, on: boolean) => void configure?.(name, { enabled: on }), [configure]);
	const counts = facetCounts(roster);
	const filters = (["all", "yours", "project", "packs", "off"] as const).map(id => ({
		id,
		label: FACET_LABEL[id],
		count: counts[id],
		disabled: id !== "all" && id !== facet && counts[id] === 0,
	}));
	const working = roster.filter(agent => liveStateOf(activity.get(agent.name) ?? NO_ACTIVITY) !== "idle").length;
	const weekCost = usage?.agents.reduce((sum, row) => sum + row.cost, 0);
	const renderCard = (agent: RosterAgent) => (
		<AgentCard
			key={agent.name}
			agent={agent}
			activity={activity.get(agent.name) ?? NO_ACTIVITY}
			usage={usageOf(usage, agent.name)}
			now={now}
			face={faceOf(agent.name)}
			bridged={bridged}
			catalog={catalog}
			voice={voices.get(agent.name)}
			busy={busy.has(agent.name)}
			onOpen={agent.listed !== undefined ? onOpen : undefined}
			onToggle={configure !== undefined && isEditable(agent) && agent.fact !== undefined ? toggle : undefined}
		/>
	);
	return (
		<ViewColumn slot="general-agents-home">
			<header className="relative isolate flex flex-wrap items-end justify-between gap-x-6 gap-y-5 overflow-hidden rounded-lg border border-fr-accent-line px-6 pt-8 pb-7 shadow-[inset_0_1px_0_color-mix(in_oklab,var(--fr-text)_10%,transparent)]">
				<NebulaBackdrop colors={["var(--fr-accent)", "var(--fr-iris)"]} intensity="lit" />
				<div className="relative flex min-w-0 max-w-prose flex-col gap-1.5">
					<h1 className="m-0 text-fr-2xl leading-tight font-semibold tracking-[-0.01em] text-balance text-fr-text">General Agents</h1>
					<p className="m-0 text-fr-sm leading-relaxed text-pretty text-fr-text/80">
						Everyone you can open a session as. Open one to see its face, charter, tools and memory, and change what is yours; extend a pack's agent to make it
						your own.
					</p>
					<div className="mt-3 flex flex-wrap gap-2">
						<Button onClick={onCreate}>
							<Icon name="plus" strokeWidth={2} />
							Create agent
						</Button>
						{onDock ? (
							<Button variant="outline" onClick={onDock}>
								<Icon name="bot" strokeWidth={2} />
								Ask the Machinist
							</Button>
						) : null}
					</div>
				</div>
				{roster.length > 0 ? (
					<dl className="relative m-0 flex items-end gap-6">
						{working > 0 ? (
							<div className="flex flex-col gap-1">
								<dt className={HERO_LABEL}>Working</dt>
								<dd className="m-0 flex items-center gap-2 font-secondary text-fr-lg leading-none font-semibold text-fr-text tabular-nums">
									<ActivityDot state="working" />
									{working}
								</dd>
							</div>
						) : null}
						<div className="flex flex-col gap-1">
							<dt className={HERO_LABEL}>{roster.length === 1 ? "Agent" : "Agents"}</dt>
							<dd className="m-0 font-secondary text-fr-lg leading-none font-semibold text-fr-text tabular-nums">{roster.length}</dd>
						</div>
						{weekCost !== undefined ? (
							<div className="flex flex-col gap-1">
								<dt className={HERO_LABEL}>Cost 7d</dt>
								<dd className="m-0 font-secondary text-fr-lg leading-none font-semibold text-fr-text tabular-nums">{money(weekCost)}</dd>
							</div>
						) : null}
					</dl>
				) : null}
			</header>
			{proposals.length > 0 ? <ProposalsBanner proposals={proposals} roster={roster} faceOf={faceOf} bridged={bridged} onReview={onReview} /> : null}
			{roster.length > 1 ? <MarketplaceFilterPills filters={filters} active={facet} onChange={setFacet} ariaLabel="Filter agents" /> : null}
			{notice ? (
				<p role="alert" className="m-0 -mt-4 text-fr-xs text-fr-warn">
					{notice}
				</p>
			) : null}
			{listingError ? (
				<div role="alert" className="-mt-2 flex items-start gap-2.5 rounded-lg border border-fr-border-soft bg-fr-surface px-4 py-3">
					<Icon name="warnTri" size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-fr-warn" />
					<div className="flex min-w-0 flex-col gap-0.5">
						<span className="text-fr-sm font-medium text-fr-text">Could not read the agents' files</span>
						<span className="text-fr-xs text-fr-text-2">{listingError} Cards show what the host knows; profiles open once the files can be read.</span>
					</div>
				</div>
			) : null}
			{loading ? <HomeSkeleton /> : null}
			{!loading && roster.length === 0 ? <EmptyHome onCreate={onCreate} onDock={onDock} /> : null}
			{!loading && facet !== "all" ? (
				<Section title={FACET_LABEL[facet]} count={roster.filter(agent => inFacet(agent, facet)).length}>
					<div className={GRID}>{roster.filter(agent => inFacet(agent, facet)).map(renderCard)}</div>
				</Section>
			) : null}
			{!loading && facet === "all"
				? LANES.map(lane => {
						const inLane = roster.filter(agent => inFacet(agent, lane.facet));
						if (inLane.length === 0) return null;
						return (
							<Section key={lane.facet} title={lane.heading} count={inLane.length} lede={lane.note}>
								<div className={GRID}>{inLane.map(renderCard)}</div>
							</Section>
						);
					})
				: null}
			<p className={cn("m-0 -mt-3", LABEL, "font-normal")}>{usage ? `Tokens and cost cover the last 7 days, measured ${agoLabel(usage.updatedAt, now)}.` : "Tokens and cost appear once this host measures them."}</p>
		</ViewColumn>
	);
}
