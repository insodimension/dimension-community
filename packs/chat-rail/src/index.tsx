// CHAT RAIL — the sessions-only rail of the personal-assistant space.
//
// What it is: your conversations, newest first, and the collections you file
// them in. What it is not: a project browser. There is no repo grouping, no
// branch or PR chip, no recap line, no Needs-you strip — the assistant is not a
// codebase, and the rail says so by leaving every one of those out.
//
// It is built the way `triage-rail` is — @fraym/ui primitives and the rail
// slot's three channels, no shipped rail inside — with one difference that is
// the point of the pack: it does not read `facts.sessions`. That fold is already
// windowed by the user's activity filter and grouped by PROJECT for Code
// (doc 84 §3). This rail reads the raw `sessions/list` rows through the
// standard root fact, narrows them to its own desk (`./model.ts`), and lets the
// kit's granted `sessionGroupsFromCatalog` turn them into rows — the one place
// the row's dot, unread state, handoff folding and relative time are decided,
// so this rail can never disagree with the shipped one about a session.
//
// Parts from @fraym/ui, ALL granted (host-externals.ts):
//   ActivityDot · Icon · IconButton · Input · Tooltip* · useObservable
//   sessionGroupsFromCatalog · useRailSessionPresence · useStandardRootFacts
//
// Collections live behind `./collections-store.ts` and nowhere else.
import {
	ActivityDot,
	FraymRailActions,
	Icon,
	IconButton,
	Input,
	sessionGroupsFromCatalog,
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
	useObservable,
	useRailActionSet,
	useRailSessionPresence,
	useStandardRootFacts,
	VoicemailMark,
} from "@fraym/ui";
import {
	type ComponentProps,
	type FormEvent,
	isValidElement,
	type KeyboardEvent,
	memo,
	type MouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { type Collection, type CollectionsStore, collectionsStore } from "./collections-store";
import { anchorOf, MenuHeading, MenuItem, MenuRule, type MenuAnchor, MenuShell } from "./menu";
import {
	activeSessionOf,
	clipRows,
	collectionKey,
	type DeskRow,
	type DeskSpace,
	foldRail,
	narrowToDesk,
	type RailItem,
	type RailSection,
	railItemsOf,
	resolveDesk,
} from "./model";
import { ensureStyles } from "./styles";

// ── The channels, restated structurally ─────────────────────────────────────
//
// No tsconfig and no ambient types, for the reason `independent-rail` records:
// a hand-written `@fraym/ui` declaration would be a second source of truth. Each
// member below is one the rail actually reads.

interface SessionRefLike {
	readonly workspaceId: string;
	readonly sessionId: string;
}

/** The kit's `SessionItem`, narrowed to what a row draws. */
interface RailRow extends RailItem {
	readonly sessionRef?: SessionRefLike;
	readonly time: string;
	readonly status: string;
	readonly dotState?: string;
	readonly profile?: string;
	readonly unread?: true;
	/** The voice desk's summary for this session (doc 91 §8): present only while a message is unplayed. */
	readonly voicemail?: { readonly unplayed: number; readonly needsYou?: true };
	readonly continuedInto?: { readonly toSessionId: string };
}

/** What the host's presence resolver answers for a row: the vibr avatar, or
 *  `null` to fall back to the status dot. The hook is typed against the kit's
 *  `SessionItem`, of which `RailRow` is a structural subset. */
type Presence = (item: RailRow) => ReactNode;

type PresenceFacts = Parameters<typeof useRailSessionPresence>[0];

interface RailFacts {
	readonly mode: {
		readonly app: string;
		readonly rail: "expanded" | "compact" | "hidden";
		readonly activeSurface?: string;
	};
	/** The session the shell has open, independent of the host's fold (`sessions`
	 *  drops rows another space stamped, or a query's ranked search omitted). Read
	 *  first for which row is foreground; a host older than this fact omits it. */
	readonly activeSession?: SessionRefLike | null;
	/** Fallback source of the foreground row (`item.active`) for a host that
	 *  publishes no `activeSession`. */
	readonly sessions: readonly { readonly items: readonly RailRow[] }[];
	readonly spaces: readonly DeskSpace[];
	readonly search: { readonly value: string };
	readonly presence: PresenceFacts;
}

type Verb<A extends unknown[]> = (...args: A) => void;

interface RailActions {
	readonly toggleCompact: Verb<[]>;
	// A `ShellIntent` is the kit's own union; this rail sends `create` itself and
	// hands the rest to the kit's `FraymRailActions`, which types what it emits.
	readonly intent: Verb<[intent: never]>;
	readonly setSearch: Verb<[value: string]>;
	readonly setSearchOpen: Verb<[open: boolean]>;
	readonly sessionContextMenu: Verb<[item: RailRow, event: MouseEvent<HTMLButtonElement>]>;
	readonly newSession?: Verb<[]>;
	readonly newSessionAs?: Verb<[agentName: string]>;
	readonly selectSession?: Verb<[item: RailRow]>;
	readonly sessionIntent?: Verb<[ref: SessionRefLike, present: boolean]>;
	readonly renameItem?: Verb<[item: RailRow, value: string | null]>;
	readonly archiveSessions?: Verb<[items: readonly RailRow[]]>;
	readonly openRailSession?: ComponentProps<typeof FraymRailActions>["onOpenRailSession"];
}

interface RailSectionProps {
	readonly rail: { subscribe: (fn: () => void) => () => void; getSnapshot: () => RailFacts };
	readonly actions: RailActions;
	readonly capabilities: { readonly agents?: readonly { readonly name: string }[] };
	readonly switcher?: ReactNode;
}

/** The raw `sessions/list` row: what the desk filter reads, plus whatever the kit
 *  reads to build a row from it (opaque here — it goes straight back to the kit). */
type RawRow = DeskRow & Parameters<typeof sessionGroupsFromCatalog>[0][number];

// ── Small hooks ─────────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;

/** Relative times ("5m", "2h") are computed when the kit builds a row, so they
 *  go stale between facts. One tick a minute re-folds them — the cadence the
 *  shipped rails use. */
function useMinute(): number {
	const [minute, setMinute] = useState(() => Math.floor(Date.now() / MINUTE_MS));
	useEffect(() => {
		const timer = setInterval(() => setMinute(Math.floor(Date.now() / MINUTE_MS)), MINUTE_MS);
		return () => clearInterval(timer);
	}, []);
	return minute;
}

/** A number that moves whenever the collections store changes, so a memo keyed
 *  on it re-folds. The store's own `list()` cannot be the key: `assign` changes
 *  the grouping without changing the list. */
function useStoreVersion(store: CollectionsStore): number {
	const version = useRef(0);
	const subscribe = useCallback(
		(notify: () => void) =>
			store.subscribe(() => {
				version.current += 1;
				notify();
			}),
		[store],
	);
	return useSyncExternalStore(subscribe, () => version.current, () => 0);
}

// ── Inline editor ───────────────────────────────────────────────────────────

/** One text field for every "name this" moment (rename a session, rename a
 *  collection, create a collection): Enter commits, Escape cancels, and a blur
 *  commits what was typed — the shipped rail's rename convention. `doneRef`
 *  stops the blur an Escape-driven unmount fires from committing after all. */
function InlineInput({
	initial,
	label,
	placeholder,
	onCommit,
	onCancel,
	lead,
}: {
	readonly initial: string;
	readonly label: string;
	readonly placeholder?: string;
	readonly onCommit: (value: string) => void;
	readonly onCancel: () => void;
	readonly lead: ReactNode;
}) {
	const [value, setValue] = useState(initial);
	const doneRef = useRef(false);
	const finish = (commit: boolean): void => {
		if (doneRef.current) return;
		doneRef.current = true;
		if (commit && value.trim() !== "") onCommit(value);
		else onCancel();
	};
	return (
		<div className="er-edit">
			<span className="er-glyph">{lead}</span>
			<input
				// biome-ignore lint/a11y/noAutofocus: the field exists only because the user just asked to type in it
				autoFocus
				aria-label={label}
				placeholder={placeholder}
				value={value}
				maxLength={120}
				onChange={event => setValue(event.target.value)}
				onFocus={event => event.currentTarget.select()}
				onClick={event => event.stopPropagation()}
				onKeyDown={event => {
					event.stopPropagation();
					if (event.key === "Enter") {
						event.preventDefault();
						finish(true);
					} else if (event.key === "Escape") {
						event.preventDefault();
						finish(false);
					}
				}}
				onBlur={() => finish(true)}
			/>
		</div>
	);
}

// ── Rows ────────────────────────────────────────────────────────────────────

interface RowProps {
	readonly item: RailRow;
	readonly actions: RailActions;
	/** What the host's presence resolver answered for THIS row (or `null`: the status dot). Resolved by the parent, so the
	 *  row's memo can ask "does it draw something different?" instead of "is it the same resolver?". */
	readonly presence: ReactNode;
	readonly renaming: boolean;
	readonly menuOpen: boolean;
	readonly onOpenMenu: (item: RailRow, anchor: MenuAnchor) => void;
	readonly onRenamed: (item: RailRow, value: string | null) => void;
}

/** One level of `Object.is`, for a prop that is a flat bag the resolver rebuilds on every call (`signals`). */
function sameBag(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) || Array.isArray(b)) return false;
	const x = a as Record<string, unknown>;
	const y = b as Record<string, unknown>;
	const keys = Object.keys(x);
	return keys.length === Object.keys(y).length && keys.every(key => Object.is(x[key], y[key]));
}

/** Two resolver answers draw the same thing: both absent, the same element, or elements of one type whose props are equal
 *  (a flat prop bag compared by value). The resolver's own identity moves with the ACTIVE session's live state on every
 *  streamed flush; comparing what a row would draw lets the other rows - all but one - keep their render. */
function samePresence(a: ReactNode, b: ReactNode): boolean {
	if (a === b) return true;
	if (!isValidElement(a) || !isValidElement(b) || a.type !== b.type || a.key !== b.key) return false;
	const x = a.props as Record<string, unknown>;
	const y = b.props as Record<string, unknown>;
	const keys = Object.keys(x);
	return keys.length === Object.keys(y).length && keys.every(key => sameBag(x[key], y[key]));
}

/** What the voicemail mark DRAWS from a row: nothing, a message, or a message that needs you. A catalog republish
 *  rebuilds `voicemail` on every fold, so the row's memo compares this, not the object. */
function mailKey(item: RailRow): 0 | 1 | 2 {
	const mail = item.voicemail;
	return mail && mail.unplayed > 0 ? (mail.needsYou ? 2 : 1) : 0;
}

/** Equal when nothing the row DRAWS or ACTS ON changed. A re-fold hands every
 *  row a fresh object (the kit builds them per call), so identity would defeat
 *  the memo on every minute tick and every catalog change; the fields below are
 *  the ones a handler reads back out of `item` when it fires (`sessionRef` and
 *  `lineage` are what `selectSession`/`renameItem`/`archiveSessions` address). */
function sameRow(a: RowProps, b: RowProps): boolean {
	const x = a.item;
	const y = b.item;
	return (
		(x === y ||
			(x.id === y.id &&
				x.title === y.title &&
				x.time === y.time &&
				x.status === y.status &&
				x.dotState === y.dotState &&
				x.active === y.active &&
				x.unread === y.unread &&
				mailKey(x) === mailKey(y) &&
				x.continuedInto?.toSessionId === y.continuedInto?.toSessionId &&
				x.sessionRef?.sessionId === y.sessionRef?.sessionId &&
				x.sessionRef?.workspaceId === y.sessionRef?.workspaceId &&
				x.lineage?.rootRef.sessionId === y.lineage?.rootRef.sessionId &&
				x.profile === y.profile)) &&
		a.actions === b.actions &&
		samePresence(a.presence, b.presence) &&
		a.renaming === b.renaming &&
		a.menuOpen === b.menuOpen &&
		a.onOpenMenu === b.onOpenMenu &&
		a.onRenamed === b.onRenamed
	);
}

/** The dot slot: the handoff mark for a frozen row, else the host's presence
 *  answer (`useRailSessionPresence`, the only route to the vibr avatar), else the
 *  status dot — `null` from the resolver is how a row falls back to the dot. */
function Lead({ item, presence }: Pick<RowProps, "item" | "presence">) {
	if (item.continuedInto) {
		return (
			<span className="er-glyph">
				<Icon name="branch" size={13} strokeWidth={1.8} aria-hidden="true" />
			</span>
		);
	}
	return (
		<span className="er-glyph">
			{presence ?? <ActivityDot state={(item.dotState ?? item.status) as ComponentProps<typeof ActivityDot>["state"]} />}
		</span>
	);
}

const Row = memo(function Row({ item, actions, presence, renaming, menuOpen, onOpenMenu, onRenamed }: RowProps) {
	const ref = item.sessionRef;
	const onClick = useCallback(() => actions.selectSession?.(item), [actions, item]);
	const onContextMenu = useCallback(
		(event: MouseEvent<HTMLButtonElement>) => {
			event.preventDefault();
			onOpenMenu(item, anchorOf(event));
		},
		[item, onOpenMenu],
	);
	const onOptions = useCallback(
		(event: MouseEvent<HTMLButtonElement>) => {
			const rect = event.currentTarget.getBoundingClientRect();
			onOpenMenu(item, { x: rect.right, y: rect.bottom + 4 });
		},
		[item, onOpenMenu],
	);
	// A pointer or focus ARRIVING on the row is the user's intent to open it — the
	// host may read ahead. Absent verb ⇒ nothing is reported.
	const intent = actions.sessionIntent;
	const arrive = useCallback(() => ref && intent?.(ref, true), [intent, ref]);
	const leave = useCallback(() => ref && intent?.(ref, false), [intent, ref]);

	if (renaming) {
		return (
			<div className="er-row" data-renaming="" data-active={item.active ? "" : undefined}>
				<InlineInput
					initial={item.title}
					label="Rename session"
					lead={<Lead item={item} presence={presence} />}
					onCommit={value => onRenamed(item, value)}
					onCancel={() => onRenamed(item, null)}
				/>
			</div>
		);
	}
	return (
		<div
			className="er-row"
			data-slot="chat-session"
			data-session-id={ref?.sessionId ?? item.id}
			data-active={item.active ? "" : undefined}
			data-unread={item.unread ? "" : undefined}
			data-frozen={item.continuedInto ? "" : undefined}
		>
			<button
				type="button"
				className="er-row-main"
				disabled={actions.selectSession === undefined}
				aria-current={item.active ? "true" : undefined}
				onClick={onClick}
				onContextMenu={onContextMenu}
				onPointerEnter={arrive}
				onPointerLeave={leave}
				onFocus={arrive}
				onBlur={leave}
			>
				<Lead item={item} presence={presence} />
				<span className="er-title">{item.title}</span>
				<span className="er-time">{item.time}</span>
			</button>
			{/* The mark is rendered for every addressable row and decides for itself whether to draw: it must stay mounted
			    while its popover is open after the last message is played (the summary is gone by then), or Stop vanishes
			    mid-playback. */}
			{ref ? (
				<VoicemailMark sessionId={ref.sessionId} voicemail={item.voicemail} title={item.title} agent={item.profile} className="er-mail" />
			) : null}
			<button
				type="button"
				className="er-options"
				aria-label={`Options for ${item.title}`}
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				onClick={onOptions}
			>
				<Icon name="dots" size={16} strokeWidth={3.2} aria-hidden="true" />
			</button>
		</div>
	);
}, sameRow);

// ── Menus ───────────────────────────────────────────────────────────────────

function SessionMenu({
	anchor,
	item,
	collections,
	current,
	actions,
	store,
	onClose,
	onRename,
}: {
	readonly anchor: MenuAnchor;
	readonly item: RailRow;
	readonly collections: readonly Collection[];
	/** The collection this row is filed in, or null. */
	readonly current: string | null;
	readonly actions: RailActions;
	readonly store: CollectionsStore;
	readonly onClose: () => void;
	readonly onRename: (item: RailRow) => void;
}) {
	const [naming, setNaming] = useState(false);
	const [name, setName] = useState("");
	const key = collectionKey(item);
	const file = (collectionId: string | null) => () => {
		store.assign(key, collectionId);
		onClose();
	};
	const createAndFile = (event: FormEvent) => {
		event.preventDefault();
		if (name.trim() === "") return;
		store.assign(key, store.create(name).id);
		onClose();
	};
	return (
		<MenuShell anchor={anchor} label={`Options for ${item.title}`} onClose={onClose}>
			{naming ? (
				<form className="erm-new" onSubmit={createAndFile}>
					<input
						// biome-ignore lint/a11y/noAutofocus: the user just chose "New collection…"
						autoFocus
						aria-label="Collection name"
						placeholder="Collection name"
						value={name}
						maxLength={120}
						onChange={event => setName(event.target.value)}
					/>
					<div className="erm-actions">
						<button type="submit" className="erm-btn" disabled={name.trim() === ""}>
							Create and add
						</button>
						<button type="button" className="erm-btn" onClick={() => setNaming(false)}>
							Back
						</button>
					</div>
				</form>
			) : (
				<>
					{actions.renameItem ? (
						<MenuItem
							icon="edit"
							onSelect={() => {
								onClose();
								onRename(item);
							}}
						>
							Rename
						</MenuItem>
					) : null}
					{actions.archiveSessions ? (
						<MenuItem
							icon="archive"
							onSelect={() => {
								onClose();
								actions.archiveSessions?.([item]);
							}}
						>
							Archive
						</MenuItem>
					) : null}
					{actions.renameItem || actions.archiveSessions ? <MenuRule /> : null}
					<MenuHeading>Move to collection</MenuHeading>
					{collections.map(collection => (
						<MenuItem key={collection.id} checked={collection.id === current} onSelect={file(collection.id)}>
							{collection.name}
						</MenuItem>
					))}
					{current !== null ? <MenuItem onSelect={file(null)}>Remove from collection</MenuItem> : null}
					<MenuItem icon="plus" onSelect={() => setNaming(true)}>
						New collection…
					</MenuItem>
					<MenuRule />
					{/* Everything the host's own row menu carries (pin, delete, reveal…) stays one
					    click away: the pack adds to that menu's job, it does not replace it. */}
					<MenuItem
						onSelect={(event: MouseEvent<HTMLButtonElement>) => {
							onClose();
							// A keyboard activation dispatches its click at (0, 0) and the host places its
							// menu from the event's pointer: hand it the point this menu was anchored at.
							const atOrigin = event.clientX === 0 && event.clientY === 0;
							actions.sessionContextMenu(
								item,
								atOrigin ? Object.create(event, { clientX: { value: anchor.x }, clientY: { value: anchor.y } }) : event,
							);
						}}
					>
						More actions
					</MenuItem>
				</>
			)}
		</MenuShell>
	);
}

function CollectionMenu({
	anchor,
	collection,
	onClose,
	onRename,
	onDelete,
}: {
	readonly anchor: MenuAnchor;
	readonly collection: Collection;
	readonly onClose: () => void;
	readonly onRename: (collection: Collection) => void;
	readonly onDelete: (collection: Collection) => void;
}) {
	return (
		<MenuShell anchor={anchor} label={`Options for ${collection.name}`} onClose={onClose}>
			<MenuItem
				icon="edit"
				onSelect={() => {
					onClose();
					onRename(collection);
				}}
			>
				Rename
			</MenuItem>
			<MenuItem
				icon="trash"
				tone="danger"
				onSelect={() => {
					onClose();
					onDelete(collection);
				}}
			>
				Delete collection
			</MenuItem>
		</MenuShell>
	);
}

// ── Sections ────────────────────────────────────────────────────────────────

/** Rows a section shows before its "Show more" row. Searching lifts the fold: a
 *  search that stops at a limit is indistinguishable from one that found nothing
 *  more. */
const SECTION_FOLD = 30;

interface SectionCtx {
	readonly actions: RailActions;
	readonly sessionPresence: Presence;
	readonly renamingId: string | null;
	readonly menuItemId: string | null;
	readonly onOpenMenu: (item: RailRow, anchor: MenuAnchor) => void;
	readonly onRenamed: (item: RailRow, value: string | null) => void;
}

function SectionRows({
	rows,
	sectionId,
	searching,
	expanded,
	onToggleExpanded,
	ctx,
}: {
	readonly rows: readonly RailRow[];
	readonly sectionId: string;
	readonly searching: boolean;
	readonly expanded: boolean;
	readonly onToggleExpanded: (sectionId: string) => void;
	readonly ctx: SectionCtx;
}) {
	const shown = clipRows(rows, searching || expanded ? Number.POSITIVE_INFINITY : SECTION_FOLD);
	const hidden = rows.length - shown.length;
	return (
		<div className="er-rows">
			{shown.map(item => (
				<Row
					key={item.id}
					item={item}
					actions={ctx.actions}
					presence={item.continuedInto ? null : ctx.sessionPresence(item)}
					renaming={ctx.renamingId === item.id}
					menuOpen={ctx.menuItemId === item.id}
					onOpenMenu={ctx.onOpenMenu}
					onRenamed={ctx.onRenamed}
				/>
			))}
			{hidden > 0 || (expanded && rows.length > SECTION_FOLD && !searching) ? (
				<button type="button" className="er-more" onClick={() => onToggleExpanded(sectionId)}>
					<span className="er-glyph" aria-hidden="true" />
					{expanded ? "Show less" : `Show ${hidden} more`}
				</button>
			) : null}
		</div>
	);
}

function CollectionHead({
	collection,
	count,
	open,
	renaming,
	onToggle,
	onOpenMenu,
	onRenamed,
}: {
	readonly collection: Collection;
	readonly count: number;
	readonly open: boolean;
	readonly renaming: boolean;
	readonly onToggle: (id: string) => void;
	readonly onOpenMenu: (collection: Collection, anchor: MenuAnchor) => void;
	readonly onRenamed: (collection: Collection, name: string | null) => void;
}) {
	if (renaming) {
		return (
			<InlineInput
				initial={collection.name}
				label="Rename collection"
				lead={<Icon name="folder" size={14} strokeWidth={1.8} aria-hidden="true" />}
				onCommit={value => onRenamed(collection, value)}
				onCancel={() => onRenamed(collection, null)}
			/>
		);
	}
	return (
		<div className="er-section-head" data-manage="">
			<button
				type="button"
				className="er-section-toggle"
				aria-expanded={open}
				onClick={() => onToggle(collection.id)}
				onContextMenu={event => {
					event.preventDefault();
					onOpenMenu(collection, anchorOf(event));
				}}
			>
				<span className="er-glyph">
					<Icon name="caretR" size={12} strokeWidth={2.2} className="er-caret" aria-hidden="true" />
				</span>
				<span className="er-section-name">{collection.name}</span>
				<span className="er-count">{count}</span>
			</button>
			<button
				type="button"
				className="er-options"
				aria-label={`Options for ${collection.name}`}
				aria-haspopup="menu"
				onClick={event => {
					const rect = event.currentTarget.getBoundingClientRect();
					onOpenMenu(collection, { x: rect.right, y: rect.bottom + 4 });
				}}
			>
				<Icon name="dots" size={16} strokeWidth={3.2} aria-hidden="true" />
			</button>
		</div>
	);
}

// ── The rail ────────────────────────────────────────────────────────────────

/** Rows the compact (56px) rail draws: one glyph each, so a long list is a
 *  column of dots, not a rail. */
const COMPACT_ROWS = 30;

type MenuTarget =
	| { readonly kind: "session"; readonly item: RailRow }
	| { readonly kind: "collection"; readonly collection: Collection };

interface MenuState {
	readonly anchor: MenuAnchor;
	readonly target: MenuTarget;
}

/** A copy of `set` with `id` flipped in or out. */
function toggled(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
	const next = new Set(set);
	if (!next.delete(id)) next.add(id);
	return next;
}

const NO_RAW: readonly RawRow[] = [];
const NO_COLLECTED = { collections: [] as Collection[], collectionOf: () => null, query: "" };

export const ChatRailSection = memo(function ChatRailSection({ rail, actions, capabilities, switcher }: RailSectionProps) {
	const facts = useObservable(rail) as RailFacts;
	const root = useStandardRootFacts() as { readonly sessions?: readonly RawRow[] };
	const store = collectionsStore;
	const compact = facts.mode.rail === "compact";
	const query = facts.search.value;
	const searching = query.trim() !== "";
	useEffect(ensureStyles, []);

	// ── Rows: desk → kit rows → this rail's fold ──
	//
	// The space declares its desk and its agents; the rail reads both and names
	// neither. `capabilities.agents` is the host's list of agents this space may
	// open sessions as (empty until it loads — and empty means "no opinion").
	const agentKey = (capabilities.agents ?? []).map(agent => agent.name).join("\u0000");
	const desk = useMemo(
		() => resolveDesk(facts.spaces, facts.mode.app, agentKey === "" ? [] : agentKey.split("\u0000")),
		[facts.spaces, facts.mode.app, agentKey],
	);
	const scoped = useMemo(() => narrowToDesk(root.sessions ?? NO_RAW, desk), [root.sessions, desk]);
	// The open session comes from the host's own fact, NOT from `facts.sessions`:
	// this rail lists rows that fold excludes (a conversation begun from the Code
	// bubble is stamped `code`; a search the host's ranked search omits), and an
	// open row the fold dropped would otherwise lose its highlight and its place
	// under "Show N more". The fold is the fallback for a host that predates it.
	const activeRef = facts.activeSession ?? activeSessionOf(facts.sessions);
	const activeId = activeRef ? `${activeRef.workspaceId}\u0000${activeRef.sessionId}` : "";
	const minute = useMinute();
	// biome-ignore lint/correctness/useExhaustiveDependencies: `activeId` is the active ref's VALUE; keying on the ref's identity would re-fold on every facts change; `minute` refreshes the relative-time labels
	const items = useMemo(() => railItemsOf<RailRow>(sessionGroupsFromCatalog(scoped, activeRef)), [scoped, activeId, minute]);

	const storeVersion = useStoreVersion(store);
	const collections = store.list();
	// biome-ignore lint/correctness/useExhaustiveDependencies: `storeVersion` is the store's change signal — `assign` moves rows without changing `collections`
	const fold = useMemo(
		() => foldRail(items, { collections, collectionOf: store.collectionOf, query }),
		[items, collections, storeVersion, query, store],
	);
	const flat = useMemo(() => (compact ? (foldRail(items, NO_COLLECTED).sections[0]?.items ?? []) : []), [compact, items]);

	const sessionPresence = useRailSessionPresence(facts.presence);

	// The space's OWN extra rail entries (anything but "New session", which this
	// rail draws as `+`): what a space declares in `rail.actions` reaches its rail
	// through the kit's granted `useRailActionSet`/`FraymRailActions`, the same
	// pair `independent-rail` uses, so no entry needs a special case here. Plugin
	// entries (`facts.contributedActions`) are deliberately NOT drawn: this is a
	// personal assistant, not the Code rail.
	const spaceActions = useRailActionSet(
		facts.spaces as Parameters<typeof useRailActionSet>[0],
		facts.mode.app as Parameters<typeof useRailActionSet>[1],
	);
	const extraActions = useMemo(() => spaceActions.filter(action => action.target !== "new-session"), [spaceActions]);

	// ── Interaction state ──
	const [menu, setMenu] = useState<MenuState | null>(null);
	const closeMenu = useCallback(() => setMenu(null), []);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [renamingCollection, setRenamingCollection] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
	// Sections remember being closed for the life of the mount; a fresh rail opens
	// everything, because a hidden group is a hidden session.
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
	const toggleCollapsed = useCallback((id: string) => setCollapsed(current => toggled(current, id)), []);
	const toggleExpanded = useCallback((id: string) => setExpanded(current => toggled(current, id)), []);

	const openSessionMenu = useCallback((item: RailRow, anchor: MenuAnchor) => setMenu({ anchor, target: { kind: "session", item } }), []);
	const openCollectionMenu = useCallback(
		(collection: Collection, anchor: MenuAnchor) => setMenu({ anchor, target: { kind: "collection", collection } }),
		[],
	);
	const startRename = useCallback((item: RailRow) => setRenamingId(item.id), []);
	const onSessionRenamed = useCallback(
		(item: RailRow, value: string | null) => {
			setRenamingId(null);
			const title = value?.trim();
			if (title && title !== item.title) actions.renameItem?.(item, title);
		},
		[actions],
	);
	const onCollectionRenamed = useCallback(
		(collection: Collection, name: string | null) => {
			setRenamingCollection(null);
			if (name !== null) store.rename(collection.id, name);
		},
		[store],
	);
	const onCollectionCreated = useCallback(
		(name: string | null) => {
			setCreating(false);
			if (name !== null) store.create(name);
		},
		[store],
	);
	const deleteCollection = useCallback(
		(collection: Collection) => {
			setConfirmDelete(null);
			store.remove(collection.id);
		},
		[store],
	);

	// ── Header verbs ──
	const onSearchChange = useCallback((event: FormEvent<HTMLInputElement>) => actions.setSearch(event.currentTarget.value), [actions]);
	const onSearchFocus = useCallback(() => actions.setSearchOpen(true), [actions]);
	const onSearchKey = useCallback(
		(event: KeyboardEvent<HTMLInputElement>) => {
			if (event.key !== "Escape") return;
			actions.setSearch("");
			actions.setSearchOpen(false);
			event.currentTarget.blur();
		},
		[actions],
	);
	// The space's default agent opens the session (`newSession`); a host that offers
	// only the named form is asked for the first agent this space lists.
	const agent = capabilities.agents?.[0]?.name;
	const canCreate = actions.newSession !== undefined || (actions.newSessionAs !== undefined && agent !== undefined);
	const onNewSession = useCallback(() => {
		// Same navigate-then-mint order as the shipped rail action.
		actions.intent({ t: "create" } as never);
		if (actions.newSession) actions.newSession();
		else if (agent !== undefined) actions.newSessionAs?.(agent);
	}, [actions, agent]);

	const ctx: SectionCtx = useMemo(
		() => ({
			actions,
			sessionPresence: sessionPresence as Presence,
			renamingId,
			menuItemId: menu?.target.kind === "session" ? menu.target.item.id : null,
			onOpenMenu: openSessionMenu,
			onRenamed: onSessionRenamed,
		}),
		[actions, sessionPresence, renamingId, menu, openSessionMenu, onSessionRenamed],
	);

	const menuNode =
		menu === null ? null : menu.target.kind === "session" ? (
			<SessionMenu
				anchor={menu.anchor}
				item={menu.target.item}
				collections={collections}
				current={store.collectionOf(collectionKey(menu.target.item))}
				actions={actions}
				store={store}
				onClose={closeMenu}
				onRename={startRename}
			/>
		) : (
			<CollectionMenu
				anchor={menu.anchor}
				collection={menu.target.collection}
				onClose={closeMenu}
				onRename={collection => setRenamingCollection(collection.id)}
				onDelete={collection => setConfirmDelete(collection.id)}
			/>
		);

	if (compact) {
		return (
			<TooltipProvider delayDuration={350}>
				<aside data-slot="chat-rail" data-compact="" className="er-rail">
					<div className="er-head">
						<IconButton aria-label="Expand rail" onClick={actions.toggleCompact}>
							<Icon name="panel" size={15} strokeWidth={1.8} aria-hidden="true" />
						</IconButton>
						{canCreate ? (
							<IconButton aria-label="New session" onClick={onNewSession}>
								<Icon name="plus" size={15} strokeWidth={2} aria-hidden="true" />
							</IconButton>
						) : null}
					</div>
					{switcher}
					<div className="er-list er-compact-list">
						{clipRows(flat, COMPACT_ROWS).map(item => (
							<Tooltip key={item.id}>
								<TooltipTrigger asChild>
									<button
										type="button"
										className="er-compact-row"
										data-active={item.active ? "" : undefined}
										aria-label={item.title}
										disabled={actions.selectSession === undefined}
										onClick={() => actions.selectSession?.(item)}
										onContextMenu={event => {
											event.preventDefault();
											actions.sessionContextMenu(item, event);
										}}
									>
										<Lead item={item} presence={item.continuedInto ? null : ctx.sessionPresence(item)} />
									</button>
								</TooltipTrigger>
								<TooltipContent side="right">{item.title}</TooltipContent>
							</Tooltip>
						))}
					</div>
				</aside>
			</TooltipProvider>
		);
	}

	const renderRows = (section: RailSection<RailRow>) => (
		<SectionRows
			rows={section.items}
			sectionId={section.id}
			searching={searching}
			expanded={expanded.has(section.id)}
			onToggleExpanded={toggleExpanded}
			ctx={ctx}
		/>
	);

	return (
		<TooltipProvider delayDuration={700}>
			<aside data-slot="chat-rail" className="er-rail">
				{switcher}
				<div className="er-head">
					<div className="er-search">
						<Icon name="search" size={13} strokeWidth={1.8} aria-hidden="true" />
						<Input
							size="sm"
							variant="ghost"
							type="search"
							placeholder="Search"
							aria-label="Search sessions"
							value={query}
							onChange={onSearchChange}
							onFocus={onSearchFocus}
							onKeyDown={onSearchKey}
						/>
					</div>
					{canCreate ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<IconButton aria-label="New session" onClick={onNewSession}>
									<Icon name="plus" size={15} strokeWidth={2} aria-hidden="true" />
								</IconButton>
							</TooltipTrigger>
							<TooltipContent side="bottom">New session</TooltipContent>
						</Tooltip>
					) : null}
				</div>
				{extraActions.length > 0 ? (
					<FraymRailActions
						actions={extraActions}
						onIntent={actions.intent as ComponentProps<typeof FraymRailActions>["onIntent"]}
						onOpenRailSession={actions.openRailSession}
						activeSurface={(facts.mode.activeSurface ?? "session") as ComponentProps<typeof FraymRailActions>["activeSurface"]}
					/>
				) : null}
				<div className="er-list" data-slot="chat-list">
					{searching ? null : creating ? (
						<InlineInput
							initial=""
							label="New collection"
							placeholder="Collection name"
							lead={<Icon name="folder" size={14} strokeWidth={1.8} aria-hidden="true" />}
							onCommit={name => onCollectionCreated(name)}
							onCancel={() => onCollectionCreated(null)}
						/>
					) : (
						<button type="button" className="er-plain" onClick={() => setCreating(true)}>
							<span className="er-glyph">
								<Icon name="plus" size={14} strokeWidth={1.8} aria-hidden="true" />
							</span>
							New collection
						</button>
					)}
					{fold.total === 0 && (searching || !fold.grouped) ? (
						<div className="er-empty">
							<strong>{searching ? "No sessions match" : "No sessions yet"}</strong>
							{searching ? "Try a shorter query." : "Start a conversation and it will land here."}
						</div>
					) : null}
					{fold.grouped
						? fold.sections.map(section => {
								const open = !collapsed.has(section.id);
								const collection = section.collection;
								return (
									<section
										key={section.id}
										className="er-section"
										data-slot="chat-collection"
										data-collection={collection ? section.id : undefined}
										data-open={open ? "" : undefined}
									>
										{collection ? (
											<CollectionHead
												collection={collection}
												count={section.items.length}
												open={open}
												renaming={renamingCollection === collection.id}
												onToggle={toggleCollapsed}
												onOpenMenu={openCollectionMenu}
												onRenamed={onCollectionRenamed}
											/>
										) : (
											<div className="er-section-head">
												<button
													type="button"
													className="er-section-toggle"
													aria-expanded={open}
													onClick={() => toggleCollapsed(section.id)}
												>
													<span className="er-glyph">
														<Icon name="caretR" size={12} strokeWidth={2.2} className="er-caret" aria-hidden="true" />
													</span>
													<span className="er-section-name">Unfiled</span>
													<span className="er-count">{section.items.length}</span>
												</button>
											</div>
										)}
										{collection && confirmDelete === collection.id ? (
											<div className="er-confirm" role="alertdialog" aria-label={`Delete ${collection.name}`}>
												<span>
													Delete <strong>{collection.name}</strong>? Its sessions stay, under Unfiled.
												</span>
												<span className="er-confirm-actions">
													<button type="button" className="er-btn" data-tone="danger" onClick={() => deleteCollection(collection)}>
														Delete
													</button>
													<button type="button" className="er-btn" onClick={() => setConfirmDelete(null)}>
														Cancel
													</button>
												</span>
											</div>
										) : null}
										{open ? (
											section.items.length === 0 ? (
												<div className="er-section-empty">Move a session here from its menu.</div>
											) : (
												renderRows(section)
											)
										) : null}
									</section>
								);
							})
						: fold.sections.map(section => <div key={section.id}>{renderRows(section)}</div>)}
				</div>
				{menuNode}
			</aside>
		</TooltipProvider>
	);
});

/** The declarative half — the host validates id/contract against its own
 *  manifest record; what matters here is the contract version it speaks. */
export const implementation = {
	specVersion: 2,
	id: "chat-rail",
	slot: "rail",
	component: ChatRailSection,
} as const;

/** The bundle contract (doc 68 §16.2): the host takes the default export. */
export default ChatRailSection;
