import type { PresentedKind } from "@dimension/sdk/presentation";
import type { ArtifactState, LibraryItem, LibraryPage, LibraryQuery, LibrarySort } from "../../../../src/library/types";

export type LibraryScope = "all" | "starred" | "shared" | "discarded";

export interface LibraryFilter {
	readonly q: string;
	readonly kinds: readonly PresentedKind[];
	readonly tags: readonly string[];
	readonly workspace: string | undefined;
	readonly scope: LibraryScope;
	readonly sort: LibrarySort;
}

export const PAGE_SIZE = 200;
export const SEARCH_DEBOUNCE_MS = 80;

export const DEFAULT_FILTER: LibraryFilter = { q: "", kinds: [], tags: [], workspace: undefined, scope: "all", sort: "relevance" };

export function queryArgs(filter: LibraryFilter, cursor?: string): LibraryQuery {
	const q = filter.q.trim();
	return {
		...(q === "" ? {} : { q }),
		...(filter.kinds.length === 0 ? {} : { kinds: filter.kinds }),
		...(filter.tags.length === 0 ? {} : { tags: filter.tags }),
		...(filter.workspace === undefined ? {} : { workspace: filter.workspace }),
		...(filter.scope === "discarded" ? { state: "discarded" as const } : {}),
		...(filter.scope === "starred" ? { starred: true } : {}),
		...(filter.scope === "shared" ? { shared: true } : {}),
		sort: filter.sort,
		...(cursor === undefined ? {} : { cursor }),
		limit: PAGE_SIZE,
	};
}

export function filterKey(filter: LibraryFilter, generation: number): string {
	return `${generation}:${JSON.stringify(queryArgs(filter))}`;
}

export async function reloadLoaded(read: (args: LibraryQuery) => Promise<LibraryPage>, filter: LibraryFilter, count: number): Promise<LibraryPage> {
	let page = await read(queryArgs(filter));
	const items = [...page.items];
	while (items.length < count && page.next !== undefined) {
		page = await read(queryArgs(filter, page.next));
		items.push(...page.items);
	}
	return { items, ...(page.next === undefined ? {} : { next: page.next }), total: page.total };
}

export interface CheckedRow {
	readonly state: ArtifactState;
	readonly size: number;
	readonly mtimeMs: number;
}

export interface ListState {
	readonly key: string | null;
	readonly items: readonly LibraryItem[];
	readonly next: string | undefined;
	readonly total: number;
	readonly phase: "idle" | "loading" | "ready" | "failed";
	readonly error: string | null;
	readonly loadingMore: boolean;
	readonly stale: boolean;
	readonly refreshing: boolean;
	readonly checked: Readonly<Record<string, CheckedRow>>;
}

export type ListAction =
	| { readonly type: "request"; readonly key: string }
	| { readonly type: "more"; readonly key: string }
	| { readonly type: "page"; readonly key: string; readonly page: LibraryPage; readonly append: boolean }
	| { readonly type: "failed"; readonly key: string; readonly error: string }
	| { readonly type: "stale" }
	| { readonly type: "refresh"; readonly key: string }
	| { readonly type: "refreshed"; readonly key: string; readonly page?: LibraryPage }
	| { readonly type: "item"; readonly item: LibraryItem }
	| { readonly type: "remove"; readonly id: string }
	| { readonly type: "thumb"; readonly id: string }
	| { readonly type: "checked"; readonly rows: readonly ({ readonly id: string } & CheckedRow)[] };

export const INITIAL_LIST: ListState = { key: null, items: [], next: undefined, total: 0, phase: "idle", error: null, loadingMore: false, stale: false, refreshing: false, checked: {} };

export function reduceList(state: ListState, action: ListAction): ListState {
	switch (action.type) {
		case "request":
			return { ...state, key: action.key, phase: "loading", error: null, loadingMore: false, stale: false, refreshing: false };
		case "more":
			if (action.key !== state.key || state.next === undefined || state.loadingMore || state.refreshing) return state;
			return { ...state, loadingMore: true };
		case "page": {
			if (action.key !== state.key) return state;
			if (action.append && !state.loadingMore) return state;
			const items = action.append ? state.items.concat(action.page.items) : action.page.items;
			return { ...state, items, next: action.page.next, total: action.page.total, phase: "ready", error: null, loadingMore: false };
		}
		case "failed":
			if (action.key !== state.key) return state;
			return { ...state, phase: "failed", error: action.error, loadingMore: false };
		case "stale":
			if (state.key === null || state.stale) return state;
			return { ...state, stale: true };
		case "refresh":
			if (action.key !== state.key || state.phase !== "ready" || state.loadingMore || state.refreshing) return state;
			return { ...state, stale: false, refreshing: true };
		case "refreshed":
			if (action.key !== state.key || !state.refreshing) return state;
			if (action.page === undefined) return { ...state, refreshing: false };
			return { ...state, items: action.page.items, next: action.page.next, total: action.page.total, refreshing: false };
		case "item": {
			const at = state.items.findIndex(item => item.id === action.item.id);
			if (at === -1) return state;
			const items = state.items.slice();
			items[at] = action.item;
			const checked: Record<string, CheckedRow> = { ...state.checked };
			delete checked[action.item.id];
			return { ...state, items, checked, stale: state.stale || state.refreshing };
		}
		case "remove": {
			const at = state.items.findIndex(item => item.id === action.id);
			if (at === -1) return state;
			return { ...state, items: state.items.filter(item => item.id !== action.id), total: Math.max(0, state.total - 1), stale: state.stale || state.refreshing };
		}
		case "thumb": {
			const at = state.items.findIndex(item => item.id === action.id);
			const current = state.items[at];
			if (current === undefined || current.hasThumb) return state;
			const items = state.items.slice();
			items[at] = { ...current, hasThumb: true };
			return { ...state, items };
		}
		case "checked": {
			const changed = action.rows.filter(row => {
				const held = state.checked[row.id];
				return held === undefined || held.state !== row.state || held.size !== row.size || held.mtimeMs !== row.mtimeMs;
			});
			if (changed.length === 0) return state;
			const checked = { ...state.checked };
			for (const row of changed) checked[row.id] = { state: row.state, size: row.size, mtimeMs: row.mtimeMs };
			return { ...state, checked };
		}
	}
}

export function shownItem(item: LibraryItem, checked: Readonly<Record<string, CheckedRow>>): LibraryItem {
	const row = checked[item.id];
	if (row === undefined || (row.state === item.state && row.size === item.size && row.mtimeMs === item.mtimeMs)) return item;
	return { ...item, state: row.state, size: row.size, mtimeMs: row.mtimeMs };
}

export function unreadCount(item: LibraryItem): number {
	let unread = 0;
	for (const share of item.shares) unread += share.unread;
	return unread;
}

export function liveShares(item: LibraryItem): number {
	let live = 0;
	for (const share of item.shares) if (share.revokedAt === undefined) live++;
	return live;
}

export function checkBatches(ids: readonly string[], seenAt: Readonly<Record<string, number>>, now: number, freshMs: number, batch: number): readonly (readonly string[])[] {
	const due = ids.filter(id => {
		const at = seenAt[id];
		return at === undefined || now - at >= freshMs;
	});
	const batches: string[][] = [];
	for (let start = 0; start < due.length; start += batch) batches.push(due.slice(start, start + batch));
	return batches;
}
