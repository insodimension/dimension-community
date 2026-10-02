// TRIAGE RAIL — a whole session rail built from PARTS, with no rail in it.
//
// The showcase claim of the assembly stack (doc 68): a third party holding
// only the `rail` slot's three channels and the kit's primitives can build a
// rail that is not a re-skin of the shipped one but a different OPINION about
// what a rail is for. This one answers three questions and nothing else:
//
//   what needs me      → the violet "Needs you · N" strip, the host's own
//                        `facts.triage` fold first, the pack's finds appended
//   what is recent     → Now · Today · Yesterday · This week · Earlier
//   what can go        → one Sweep on Earlier: archive idle rows older than 7d
//                        (shown only when the host grants `archiveSessions`)
//
// No options and no filter menu — it renders exactly that recommendation.
//
// Parts from @fraym/ui, ALL primitives:
//   ActivityDot · Button · IconButton · Icon · Input · Tooltip* · useObservable
// Imports from the shipped rail (SessionRail, features/session-rail/*): NONE,
// and that is the point. The recency and sweep folds are the pack's own
// (`./model.ts`), computed from `facts.sessions` — the host's grouped,
// filtered, loop-lifted fold. The strip consumes `facts.triage` as published.
import {
	ActivityDot,
	Button,
	Icon,
	IconButton,
	Input,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
	useObservable,
	VoicemailMark,
} from "@fraym/ui";
import {
	type ComponentProps,
	type FormEvent,
	type KeyboardEvent,
	memo,
	type MouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	foldTriage,
	LOOPS_BRANCH,
	type Placed,
	RECENCY_LABEL,
	type RecencyBucket,
	type RecencySection,
	startOfDay,
	sweepCandidates,
	type TriageGroup,
	type TriageRow,
	waitLabel,
} from "./model";
import { ensureStyles } from "./styles";

/** The row shape this rail reads — `SessionItem`, restated structurally (see
 *  `independent-rail` for why there is no tsconfig and no ambient types: a
 *  hand-written `@fraym/ui` declaration would be a second source of truth).
 *  Fields beyond {@link TriageRow} are display fuel. */
interface RailRow extends TriageRow {
	readonly time: string;
	readonly active?: boolean;
	readonly icon?: string;
	readonly avatarImage?: string;
	readonly meta?: string;
	readonly source?: "user" | "autonomy";
	readonly sessionRef?: { readonly workspaceId: string; readonly sessionId: string };
	readonly profile?: string;
	/** The voice desk's summary for this session (doc 91 §8): present only while a message is unplayed. */
	readonly voicemail?: { readonly unplayed: number; readonly needsYou?: true };
}

type RailGroup = TriageGroup<RailRow>;

interface RailFacts {
	readonly identity: {
		readonly version: string;
		readonly productLabel: string;
		readonly userName: string;
		readonly userAvatarUrl?: string;
		readonly planLabel: string;
	};
	readonly mode: { readonly app: string; readonly rail: "expanded" | "compact" | "hidden"; readonly activeSurface: unknown };
	readonly sessions: readonly RailGroup[];
	/** The host's own needs-you fold. Optional: an older host publishes none. */
	readonly triage?: readonly RailRow[];
	readonly projectLabel: string;
	readonly search: { readonly open: boolean; readonly value: string };
}

type Verb<A extends unknown[]> = (...args: A) => void;

interface RailActions {
	readonly toggleCompact: Verb<[]>;
	readonly intent: Verb<[intent: { readonly t: "create" }]>;
	readonly setSearch: Verb<[value: string]>;
	readonly setSearchOpen: Verb<[open: boolean]>;
	readonly openUserMenu: Verb<[event: MouseEvent<HTMLButtonElement>]>;
	readonly sessionContextMenu: Verb<[item: RailRow, event: MouseEvent<HTMLButtonElement>]>;
	readonly newSession?: Verb<[]>;
	readonly selectSession?: Verb<[item: RailRow]>;
	/** Bulk archive — arrives with the shipped rail's triage change. Absent ⇒
	 *  the Sweep affordance is hidden (the scope's optionality rule); the rail
	 *  never archives anything itself. */
	readonly archiveSessions?: Verb<[items: readonly RailRow[]]>;
}

interface RailSectionProps {
	readonly rail: { subscribe: (fn: () => void) => () => void; getSnapshot: () => RailFacts };
	readonly actions: RailActions;
	readonly capabilities: unknown;
	readonly switcher?: ReactNode;
}

const SECTION_ICON: Record<RecencyBucket, ComponentProps<typeof Icon>["name"]> = {
	now: "bolt",
	today: "sun",
	yesterday: "moon",
	week: "clock",
	earlier: "history",
};

// ── Rows ────────────────────────────────────────────────────────────────────

/** Memoised on `item` IDENTITY, not on a wrapper: the host's row objects are
 *  stable between facts, so a re-render of the rail (a minute tick, a search
 *  keystroke) reconciles nothing. Taking `placed` whole would defeat that —
 *  every fold allocates fresh wrappers. */
const Row = memo(function Row({
	item,
	repo,
	trailing,
	actions,
}: {
	readonly item: RailRow;
	/** The project caption — the recency groups drop the project heading. */
	readonly repo: string;
	/** The right-hand caption: the host's relative time, or the wait age. */
	readonly trailing: string;
	readonly actions: RailActions;
}) {
	const onClick = useCallback(() => actions.selectSession?.(item), [actions, item]);
	const onContextMenu = useCallback(
		(event: MouseEvent<HTMLButtonElement>) => {
			event.preventDefault();
			actions.sessionContextMenu(item, event);
		},
		[actions, item],
	);
	const dotState = (item.dotState ?? item.status) as ComponentProps<typeof ActivityDot>["state"];
	const row = (
		<button
			type="button"
			className="tr-row"
			data-session-id={item.sessionRef?.sessionId ?? item.id}
			data-active={item.active ? "" : undefined}
			data-unread={item.unread ? "" : undefined}
			data-frozen={item.continuedInto ? "" : undefined}
			disabled={item.locating}
			onClick={onClick}
			onContextMenu={onContextMenu}
		>
			<span className="tr-row-lead">
				{item.continuedInto ? (
					<Icon name="branch" size={13} strokeWidth={1.8} aria-hidden="true" />
				) : item.avatarImage ? (
					<img className="tr-avatar" style={{ width: 16, height: 16 }} src={item.avatarImage} alt="" />
				) : (
					<ActivityDot state={dotState} />
				)}
			</span>
			<span className="tr-row-body">
				<span className="tr-row-title">{item.title}</span>
				{repo || item.meta ? (
					<span className="tr-row-meta">{[repo, item.meta].filter(Boolean).join(" · ")}</span>
				) : null}
			</span>
			<span className="tr-row-time">{trailing}</span>
		</button>
	);
	// A voice message the desk holds for this session (doc 91 §8). The mark is its own click target, so it is a SIBLING of
	// the row button (a button in a button is invalid HTML). Every addressable row sits in the same holder, whether or not it
	// holds a message: the kit's mark decides for itself whether to draw, and it must stay mounted under its open popover
	// after the last message is played; a holder that came and went with the summary would also remount the row button.
	const ref = item.sessionRef;
	if (!ref) return row;
	return (
		<div className="tr-row-holder">
			{row}
			<VoicemailMark sessionId={ref.sessionId} voicemail={item.voicemail} title={item.title} agent={item.profile} className="tr-mail" />
		</div>
	);
});

// ── Needs-you strip ─────────────────────────────────────────────────────────

/** The strip shows the oldest waits and names the rest: a strip of two hundred
 *  rows (every never-opened session on a fresh upgrade reads as unread) is a
 *  list, not a call to action. Six is what fits above the first group. */
const STRIP_FOLD = 6;

function NeedsYouStrip({ rows, actions, now }: { readonly rows: readonly Placed<RailRow>[]; readonly actions: RailActions; readonly now: number }) {
	const [expanded, setExpanded] = useState(false);
	if (rows.length === 0) return null;
	const shown = expanded ? rows : rows.slice(0, STRIP_FOLD);
	const hidden = rows.length - shown.length;
	return (
		<section className="tr-strip" data-slot="triage-needs-you" aria-label={`Needs you, ${rows.length}`}>
			<div className="tr-strip-head">
				<span className="tr-strip-dot" aria-hidden="true" />
				<span className="tr-eyebrow">Needs you</span>
				<span className="tr-count" style={{ color: "var(--fr-iris)" }}>
					{rows.length}
				</span>
			</div>
			{shown.map(placed => (
				<Row key={placed.item.id} item={placed.item} repo={placed.repo} trailing={waitLabel(placed.item, now)} actions={actions} />
			))}
			{rows.length > STRIP_FOLD ? (
				<button type="button" className="tr-more" onClick={() => setExpanded(current => !current)}>
					{expanded ? "Show less" : `Show ${hidden} more`}
				</button>
			) : null}
		</section>
	);
}

// ── Sweep ───────────────────────────────────────────────────────────────────

/** Sweep is either the button (idle) or the inline confirm card. */
type SweepState = "idle" | "confirm";

const SWEEP_PREVIEW = 4;

function SweepCard({
	candidates,
	onConfirm,
	onCancel,
}: {
	readonly candidates: readonly Placed<RailRow>[];
	readonly onConfirm: () => void;
	readonly onCancel: () => void;
}) {
	const n = candidates.length;
	const shown = candidates.slice(0, SWEEP_PREVIEW);
	const more = n - shown.length;
	return (
		<div className="tr-sweep-card" role="group" aria-label="Confirm sweep">
			<span className="tr-sweep-title">
				Archive {n} idle session{n === 1 ? "" : "s"} untouched for 7+ days?
			</span>
			<ul className="tr-sweep-list">
				{shown.map(({ item, repo }) => (
					<li key={item.id}>
						{item.title} <span className="tr-row-meta">· {repo}</span>
					</li>
				))}
				{more > 0 ? <li className="tr-row-meta">and {more} more</li> : null}
			</ul>
			<span className="tr-sweep-note">Archived sessions stay searchable and can be unarchived from their menu.</span>
			<div className="tr-sweep-actions">
				<Button size="sm" onClick={onConfirm}>
					<Icon name="archive" size={13} strokeWidth={1.8} aria-hidden="true" />
					Archive {n}
				</Button>
				<Button size="sm" variant="ghost" onClick={onCancel}>
					Keep
				</Button>
			</div>
		</div>
	);
}

// ── Sections ────────────────────────────────────────────────────────────────

/** Rows a section shows before its "Show more" row. "Now" is never folded —
 *  live work is the reason the rail exists — and a fold that hides a row the
 *  user is looking for still names the count. */
const SECTION_FOLD = 8;

function Section({
	id,
	title,
	icon,
	rows,
	actions,
	open,
	onToggle,
	action,
	children,
}: {
	readonly id: string;
	readonly title: string;
	readonly icon: ComponentProps<typeof Icon>["name"];
	readonly rows: readonly Placed<RailRow>[];
	readonly actions: RailActions;
	readonly open: boolean;
	readonly onToggle: (id: string) => void;
	/** A header control rendered outside the toggle (Earlier's Sweep). */
	readonly action?: ReactNode;
	readonly children?: ReactNode;
}) {
	const toggle = useCallback(() => onToggle(id), [onToggle, id]);
	const [expanded, setExpanded] = useState(false);
	const foldable = id !== "now" && rows.length > SECTION_FOLD;
	const shown = foldable && !expanded ? rows.slice(0, SECTION_FOLD) : rows;
	const hidden = rows.length - shown.length;
	return (
		<section className="tr-section" data-slot="triage-section" data-bucket={id} data-open={open ? "" : undefined}>
			<div className="tr-section-head">
				<button type="button" className="tr-section-toggle" aria-expanded={open} onClick={toggle}>
					<Icon name={icon} size={12} strokeWidth={1.8} aria-hidden="true" />
					<span className="tr-eyebrow">{title}</span>
					<Icon name="caretR" size={11} strokeWidth={2.2} className="tr-caret" aria-hidden="true" />
					<span className="tr-count">{rows.length}</span>
				</button>
				{action}
			</div>
			{open ? (
				<>
					{children}
					{shown.map(placed => (
						<Row key={placed.item.id} item={placed.item} repo={placed.repo} trailing={placed.item.time} actions={actions} />
					))}
					{foldable ? (
						<button type="button" className="tr-more" onClick={() => setExpanded(current => !current)}>
							{expanded ? "Show less" : `Show ${hidden} more`}
						</button>
					) : null}
				</>
			) : null}
		</section>
	);
}

// ── Compact rail ────────────────────────────────────────────────────────────

function CompactRows({ rows, actions }: { readonly rows: readonly Placed<RailRow>[]; readonly actions: RailActions }) {
	return (
		<>
			{rows.map(({ item, repo }) => (
				<Tooltip key={item.id}>
					<TooltipTrigger asChild>
						<button
							type="button"
							className="tr-compact-row"
							data-active={item.active ? "" : undefined}
							aria-label={item.title}
							onClick={() => actions.selectSession?.(item)}
							onContextMenu={event => {
								event.preventDefault();
								actions.sessionContextMenu(item, event);
							}}
						>
							<ActivityDot state={(item.dotState ?? item.status) as ComponentProps<typeof ActivityDot>["state"]} size={7} />
						</button>
					</TooltipTrigger>
					<TooltipContent side="right">
						{item.title} · {repo}
					</TooltipContent>
				</Tooltip>
			))}
		</>
	);
}

// ── The rail ────────────────────────────────────────────────────────────────

/** The strip's wait ages tick without a facts change, and midnight moves
 *  "Today" to "Yesterday". One minute is the host's own cadence. */
const TICK_MS = 60_000;

export const TriageRailSection = memo(function TriageRailSection({ rail, actions, switcher }: RailSectionProps) {
	const facts = useObservable(rail) as RailFacts;
	const compact = facts.mode.rail === "compact";
	useEffect(ensureStyles, []);

	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(timer);
	}, []);

	// The tick feeds the strip's wait captions and the Sweep's age window ONLY.
	// The fold is keyed on local midnight, because the midnight boundary is the
	// only clock `foldTriage` reads: re-folding every minute would hand every
	// row a fresh `Placed` wrapper and re-render the whole rail through
	// `memo(Row)` on a home with hundreds of sessions.
	const dayStart = startOfDay(now);
	const fold = useMemo(() => foldTriage(facts.sessions, dayStart, facts.triage), [facts.sessions, facts.triage, dayStart]);
	const earlier = fold.sections.find(section => section.bucket === "earlier");
	const candidates = useMemo(() => (earlier ? sweepCandidates(earlier.rows, now) : []), [earlier, now]);

	// Sections remember being closed for the life of the mount; a fresh rail
	// opens everything, because a hidden bucket is a hidden session.
	const [closed, setClosed] = useState<Record<string, true>>({});
	const toggleSection = useCallback((id: string) => {
		setClosed(current => {
			const next = { ...current };
			if (next[id]) delete next[id];
			else next[id] = true;
			return next;
		});
	}, []);

	// ── Sweep ──
	const [sweep, setSweep] = useState<SweepState>("idle");
	const onSweepClick = useCallback(() => setSweep(current => (current === "confirm" ? "idle" : "confirm")), []);
	const onSweepConfirm = useCallback(() => {
		actions.archiveSessions?.(candidates.map(({ item }) => item));
		setSweep("idle");
	}, [actions, candidates]);
	const onSweepCancel = useCallback(() => setSweep("idle"), []);
	// The card is a question about rows, so it dies with them: facts move while
	// it is open (a row archived elsewhere, a time crossing the age line) and
	// "Archive 0 idle sessions?" is not a question. Dropping the state too
	// keeps a later candidate from springing the card open unasked.
	useEffect(() => {
		if (candidates.length === 0) setSweep("idle");
	}, [candidates.length]);

	// ── Search ──
	const onSearchChange = useCallback(
		(event: FormEvent<HTMLInputElement>) => actions.setSearch(event.currentTarget.value),
		[actions],
	);
	const onSearchFocus = useCallback(() => actions.setSearchOpen(true), [actions]);
	const onSearchKey = useCallback(
		(event: KeyboardEvent<HTMLInputElement>) => {
			if (event.key === "Escape") {
				actions.setSearch("");
				actions.setSearchOpen(false);
				event.currentTarget.blur();
			}
		},
		[actions],
	);

	const onNewSession = useCallback(() => {
		// Same navigate-then-mint order as the shipped rail action.
		actions.intent({ t: "create" });
		actions.newSession?.();
	}, [actions]);

	const initials = facts.identity.userName.trim().slice(0, 1).toUpperCase() || "·";
	const searching = facts.search.value.trim().length > 0;

	const sweepButton =
		actions.archiveSessions !== undefined && candidates.length > 0 ? (
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						size="sm"
						variant="ghost"
						aria-pressed={sweep === "confirm"}
						onClick={onSweepClick}
						style={{ padding: "2px 7px", fontSize: "var(--fr-fs-2xs)", fontFamily: "var(--fr-font-secondary)" }}
					>
						<Icon name="archive" size={11} strokeWidth={1.8} aria-hidden="true" />
						Sweep · {candidates.length}
					</Button>
				</TooltipTrigger>
				<TooltipContent side="right">Archive idle sessions untouched for 7+ days</TooltipContent>
			</Tooltip>
		) : undefined;

	if (compact) {
		// The same folds as the expanded rail: a 56px column of five hundred
		// dots is not a rail. Now stays whole; every other section shows its head.
		const all = fold.sections.flatMap(section => (section.bucket === "now" ? section.rows : section.rows.slice(0, SECTION_FOLD)));
		return (
			<TooltipProvider delayDuration={350}>
				<aside data-slot="triage-rail" data-compact="" className="tr-rail">
					<div className="tr-head">
						<IconButton aria-label="Expand rail" onClick={actions.toggleCompact}>
							<Icon name="panel" size={15} strokeWidth={1.8} aria-hidden="true" />
						</IconButton>
						{actions.newSession ? (
							<IconButton aria-label="New session" onClick={onNewSession}>
								<Icon name="plus" size={15} strokeWidth={2} aria-hidden="true" />
							</IconButton>
						) : null}
					</div>
					{switcher}
					<div className="tr-list tr-compact-list">
						{fold.needsYou.length > 0 ? (
							<>
								<span className="tr-compact-badge" aria-label={`Needs you, ${fold.needsYou.length}`}>
									{fold.needsYou.length}
								</span>
								<CompactRows rows={fold.needsYou.slice(0, STRIP_FOLD)} actions={actions} />
								<span className="tr-compact-rule" aria-hidden="true" />
							</>
						) : null}
						<CompactRows rows={all} actions={actions} />
						{fold.loops.length > 0 ? (
							<>
								<span className="tr-compact-rule" aria-hidden="true" />
								<CompactRows rows={fold.loops} actions={actions} />
							</>
						) : null}
					</div>
					<div className="tr-foot" style={{ justifyContent: "center", padding: "8px 0 10px" }}>
						<IconButton aria-label="Account menu" onClick={actions.openUserMenu}>
							{facts.identity.userAvatarUrl ? (
								<img className="tr-avatar" src={facts.identity.userAvatarUrl} alt="" />
							) : (
								<span className="tr-avatar">{initials}</span>
							)}
						</IconButton>
					</div>
				</aside>
			</TooltipProvider>
		);
	}

	return (
		<TooltipProvider delayDuration={700}>
			<aside data-slot="triage-rail" className="tr-rail">
				<div className="tr-head">
					<div className="tr-brand">
						<span className="tr-brand-name">{facts.identity.productLabel}</span>
						<span className="tr-eyebrow">Triage rail</span>
					</div>
					{actions.newSession ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<IconButton aria-label="New session" onClick={onNewSession}>
									<Icon name="plus" size={15} strokeWidth={2} aria-hidden="true" />
								</IconButton>
							</TooltipTrigger>
							<TooltipContent side="bottom">New session</TooltipContent>
						</Tooltip>
					) : null}
					<Tooltip>
						<TooltipTrigger asChild>
							<IconButton aria-label="Collapse rail" onClick={actions.toggleCompact}>
								<Icon name="panel" size={15} strokeWidth={1.8} aria-hidden="true" />
							</IconButton>
						</TooltipTrigger>
						<TooltipContent side="bottom">Collapse rail</TooltipContent>
					</Tooltip>
				</div>
				{switcher}
				<div className="tr-search">
					<Icon name="search" size={13} strokeWidth={1.8} aria-hidden="true" />
					<Input
						size="sm"
						variant="ghost"
						type="search"
						placeholder="Search sessions…"
						aria-label="Search sessions"
						value={facts.search.value}
						onChange={onSearchChange}
						onFocus={onSearchFocus}
						onKeyDown={onSearchKey}
					/>
				</div>
				<div className="tr-list" data-slot="triage-list">
					<NeedsYouStrip rows={fold.needsYou} actions={actions} now={now} />
					{fold.total === 0 && fold.needsYou.length === 0 ? (
						<div className="tr-empty">
							<strong>{searching ? "No sessions match" : "Nothing to triage"}</strong>
							{searching ? "Try a shorter query." : "New work lands here the moment it starts."}
						</div>
					) : null}
					{fold.sections.map((section: RecencySection<RailRow>) => (
						<Section
							key={section.bucket}
							id={section.bucket}
							title={RECENCY_LABEL[section.bucket]}
							icon={SECTION_ICON[section.bucket]}
							rows={section.rows}
							actions={actions}
							open={!closed[section.bucket]}
							onToggle={toggleSection}
							action={section.bucket === "earlier" ? sweepButton : undefined}
						>
							{section.bucket === "earlier" && sweep === "confirm" && candidates.length > 0 ? (
								<SweepCard candidates={candidates} onConfirm={onSweepConfirm} onCancel={onSweepCancel} />
							) : null}
						</Section>
					))}
					{fold.loops.length > 0 ? (
						<Section
							id={LOOPS_BRANCH}
							title="Autonomy"
							icon="orbit"
							rows={fold.loops}
							actions={actions}
							open={!closed[LOOPS_BRANCH]}
							onToggle={toggleSection}
						/>
					) : null}
				</div>
				<div className="tr-foot">
					{facts.identity.userAvatarUrl ? (
						<img className="tr-avatar" src={facts.identity.userAvatarUrl} alt="" />
					) : (
						<span className="tr-avatar" aria-hidden="true">
							{initials}
						</span>
					)}
					<span className="tr-foot-user">
						<span className="tr-brand-name">{facts.identity.userName}</span>
						<span className="tr-eyebrow">
							{facts.identity.planLabel} · {facts.identity.version}
						</span>
					</span>
					<IconButton aria-label="Account menu" onClick={actions.openUserMenu}>
						<Icon name="user" size={14} strokeWidth={1.8} aria-hidden="true" />
					</IconButton>
				</div>
			</aside>
		</TooltipProvider>
	);
});

/** The declarative half — the host validates id/contract against its own
 *  manifest record; what matters here is the contract version it speaks. */
export const implementation = {
	specVersion: 2,
	id: "triage-rail",
	slot: "rail",
	component: TriageRailSection,
} as const;

/** The bundle contract (doc 68 §16.2): the host takes the default export. */
export default TriageRailSection;
