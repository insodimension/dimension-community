// The Chat rail's fold — pure functions, no React, no @fraym/ui.
//
// Three questions, each answered here so a test can hold it without a DOM:
//
//   which rows are mine        → {@link narrowToDesk}: the desk filter, the
//                                same rule the host's `scopeSessionCatalog`
//                                applies to a workspace-scoped space
//   in what order and where    → {@link foldRail}: newest first, grouped by the
//                                user's collections, the rest under Unfiled
//   how many to draw           → {@link clipRows}: a section folds after a
//                                page, but never hides the open session
//
// Typed STRUCTURALLY, for the reason every pack here is: the kit's `SessionItem`
// and the driver's `SessionSnapshot` grow on the host's schedule, so each field a
// rule reads is named below and every one degrades to "absent ⇒ not this".
import type { Collection } from "./collections-store";

// ── The desk ────────────────────────────────────────────────────────────────

/** The raw `sessions/list` row fields the desk filter reads. */
export interface DeskRow {
	readonly ref: { readonly workspaceId: string };
	/** The space that created the session — write-once, stamped by the engine. */
	readonly space?: string;
	readonly kind?: string;
	readonly profile?: string;
}

/** What "mine" means for this rail's space. */
export interface Desk {
	/** The space this rail is seated in (`facts.mode.app`). */
	readonly spaceId: string;
	/** The workspace the space declares as its desk (`workspace.scope.workspace`).
	 *  Absent when the space declares none — then only stamped rows are mine. */
	readonly workspaceId: string | undefined;
	/** The General Agents this space may open sessions as. Empty = no opinion,
	 *  the same degrade the host makes for a space that lists none. */
	readonly agents: readonly string[];
}

/** The slice of a registered space this rail reads (`RailFacts.spaces`). */
export interface DeskSpace {
	readonly id: string;
	readonly workspace: { readonly scope?: { readonly workspace?: string; readonly agent?: string } };
}

/** Read the desk off the registered spaces, so the rail names no workspace of
 *  its own: the space declares it (`workspace.scope`), the rail obeys. */
export function resolveDesk(spaces: readonly DeskSpace[], spaceId: string, agents: readonly string[]): Desk {
	const scope = spaces.find(space => space.id === spaceId)?.workspace.scope;
	return { spaceId, workspaceId: scope?.workspace, agents };
}

/**
 * Narrow the raw session list to this desk. The host's `scopeSessionCatalog`
 * (`packages/app/src/bench-catalog.ts`) matches a stamped row on the stamp alone,
 * which is right for a space that owns its sessions but wrong for a desk shared
 * with a bubble: an Aether conversation begun from the Code bubble is stamped
 * `code` and runs in the same home workspace, and doc 72 §2 says Aether
 * conversations from the main pane and from the bubble are ONE family. So:
 *
 *  - a row stamped for THIS space belongs, on the stamp alone (doc 72 §2);
 *  - any other row belongs when it lives in the desk workspace and was made by
 *    one of the space's agents (or the space names none), whatever space
 *    stamped it — never a room.
 *
 * Returns the input array itself when nothing is filtered out, so a memo keyed
 * on it does not see a new list per render.
 */
export function narrowToDesk<Row extends DeskRow>(rows: readonly Row[], desk: Desk): readonly Row[] {
	const belongs = (row: Row): boolean => {
		if (row.space === desk.spaceId) return true;
		if (row.kind === "room") return false;
		if (desk.workspaceId === undefined) return false;
		// A profile-less row is admitted only where the space states no agents:
		// an unattributed session is somebody's plain coding session, and the
		// personal surface must not adopt it.
		if (desk.agents.length > 0 && (row.profile === undefined || !desk.agents.includes(row.profile))) return false;
		return row.ref.workspaceId === desk.workspaceId;
	};
	return rows.every(belongs) ? rows : rows.filter(belongs);
}

// ── Rows ────────────────────────────────────────────────────────────────────

/** The row fields the fold reads — the kit's `SessionItem`, restated. */
export interface RailItem {
	readonly id: string;
	readonly title: string;
	readonly updatedAt?: string;
	readonly preview?: string;
	readonly sessionRef?: { readonly sessionId: string };
	/** Present when the row stands for a `/handoff` chain rather than one session. */
	readonly lineage?: { readonly rootRef: { readonly sessionId: string }; readonly text: string };
	readonly archived?: boolean;
	readonly askOnly?: true;
	readonly kind?: string;
	readonly active?: boolean;
}

interface ItemGroup<Item extends RailItem> {
	readonly items: readonly Item[];
	readonly searchOnly?: boolean;
}

/** The rows a person would call "my sessions" out of the kit's grouped fold.
 *  The kit keeps archived rows in the list (its own filter hides them), lists a
 *  room's seat only to carry an ask, and parks unregistered-folder rows in a
 *  search-only bucket — none of which belong on this rail. */
export function railItemsOf<Item extends RailItem>(groups: readonly ItemGroup<Item>[]): Item[] {
	const out: Item[] = [];
	for (const group of groups) {
		if (group.searchOnly) continue;
		for (const item of group.items) {
			if (item.archived || item.askOnly || item.kind === "room") continue;
			out.push(item);
		}
	}
	return out;
}

/** The open session, read off the host's grouped fold — the one place the rail
 *  channel says which row is foreground. */
export function activeSessionOf<Ref>(
	groups: readonly { readonly items: readonly { readonly active?: boolean; readonly sessionRef?: Ref }[] }[],
): Ref | null {
	for (const group of groups) {
		for (const item of group.items) {
			if (item.active && item.sessionRef) return item.sessionRef;
		}
	}
	return null;
}

/** What a collection is keyed by: the session's stable identity. A row that
 *  stands for a handoff chain answers with the chain's ROOT, so a `/handoff`
 *  (which changes the row's live session id) does not drop it out of its
 *  collection. */
export function collectionKey(item: RailItem): string {
	return item.lineage?.rootRef.sessionId ?? item.sessionRef?.sessionId ?? item.id;
}

// ── The fold ────────────────────────────────────────────────────────────────

/** One group on the rail. `collection` is null for the Unfiled group. */
export interface RailSection<Item extends RailItem = RailItem> {
	readonly id: string;
	readonly collection: Collection | null;
	readonly items: readonly Item[];
}

export interface RailFold<Item extends RailItem = RailItem> {
	/** Collections in creation order, then Unfiled. */
	readonly sections: readonly RailSection<Item>[];
	/** Whether to draw group headers: only once a collection exists. Before that
	 *  the rail is one flat list, not a lone "Unfiled" heading over everything. */
	readonly grouped: boolean;
	/** Rows that survived the search, across every section. */
	readonly total: number;
}

export const UNFILED_ID = "unfiled";

export interface FoldInput {
	readonly collections: readonly Collection[];
	readonly collectionOf: (sessionKey: string) => string | null;
	readonly query: string;
}

function itemTime(item: RailItem): number {
	const time = Date.parse(item.updatedAt ?? "");
	return Number.isFinite(time) ? time : 0;
}

/** A row matches a query on its title, preview, or — for a folded handoff chain —
 *  any member's title, so a session the kit folded away is still findable by the
 *  name it once had. */
function matches(item: RailItem, needle: string): boolean {
	if (needle === "") return true;
	const haystack = `${item.title} ${item.preview ?? ""} ${item.lineage?.text ?? ""}`;
	return haystack.toLowerCase().includes(needle);
}

/**
 * Newest first (`updatedAt`, descending — not live-first, not pinned-first: the
 * rail is one honest recency list), partitioned into the user's collections.
 *
 * A session whose collection no longer exists falls to Unfiled: the store
 * unassigns on delete, but a stale or hand-edited blob must degrade to "not
 * filed", never to "not shown".
 *
 * Empty collections are drawn while browsing (a place to file into, and a thing
 * to delete) and dropped while searching (a header over nothing is noise).
 */
export function foldRail<Item extends RailItem>(items: readonly Item[], input: FoldInput): RailFold<Item> {
	const needle = input.query.trim().toLowerCase();
	const ranked = items
		.filter(item => matches(item, needle))
		.map(item => ({ item, time: itemTime(item) }))
		// Equal times fall back to the id so two rows never swap between renders.
		.sort((a, b) => b.time - a.time || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0))
		.map(entry => entry.item);

	const known = new Set(input.collections.map(collection => collection.id));
	const byCollection = new Map<string, Item[]>();
	const unfiled: Item[] = [];
	for (const item of ranked) {
		const filed = input.collectionOf(collectionKey(item));
		if (filed !== null && known.has(filed)) {
			const bucket = byCollection.get(filed);
			if (bucket) bucket.push(item);
			else byCollection.set(filed, [item]);
		} else {
			unfiled.push(item);
		}
	}

	const sections: RailSection<Item>[] = [];
	for (const collection of input.collections) {
		const rows = byCollection.get(collection.id) ?? [];
		if (needle !== "" && rows.length === 0) continue;
		sections.push({ id: collection.id, collection, items: rows });
	}
	if (unfiled.length > 0) sections.push({ id: UNFILED_ID, collection: null, items: unfiled });
	return { sections, grouped: input.collections.length > 0, total: ranked.length };
}

/** A section shows its first `limit` rows and folds the rest behind "Show more"
 *  — but never folds away the open session, which would leave the user looking
 *  at a conversation the rail claims not to have. `limit` of `Infinity` shows all. */
export function clipRows<Item extends RailItem>(rows: readonly Item[], limit: number): readonly Item[] {
	if (rows.length <= limit) return rows;
	const head = rows.slice(0, limit);
	const active = rows.slice(limit).find(item => item.active);
	return active ? [...head, active] : head;
}
