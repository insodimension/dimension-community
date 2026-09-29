// The View's own tab strip (v1: the host gives one tab per server, so the
// documents share it). A pure reducer plus a tiny external store, and the store
// lives at MODULE scope on purpose: the tool result that mounts the View arrives
// before React's first effect, and a store owned by a component would drop it.
import { useSyncExternalStore } from "react";
import type { ViewedFile } from "../../src/contract";

export interface DocTab extends ViewedFile {
	/** The document's identity: the real path the server resolved. */
	readonly key: string;
	/** Bumped when the same file is opened again and has CHANGED on disk. */
	readonly revision: number;
}

export interface ViewerState {
	readonly tabs: readonly DocTab[];
	readonly activeKey: string | null;
	/** The last refusal or failure, shown until dismissed or a file opens. */
	readonly notice: string | null;
}

export type ViewerAction =
	| { readonly type: "open"; readonly key: string; readonly file: ViewedFile }
	| { readonly type: "refused"; readonly message: string }
	| { readonly type: "activate"; readonly key: string }
	| { readonly type: "close"; readonly key: string }
	| { readonly type: "dismiss" };

export const INITIAL_STATE: ViewerState = { tabs: [], activeKey: null, notice: null };

export function reduce(state: ViewerState, action: ViewerAction): ViewerState {
	switch (action.type) {
		case "open": {
			const at = state.tabs.findIndex(tab => tab.key === action.key);
			if (at === -1) {
				const tab: DocTab = { ...action.file, key: action.key, revision: 0 };
				return { tabs: [...state.tabs, tab], activeKey: action.key, notice: null };
			}
			// The same file again: focus it, and reload it only if it moved under us.
			const existing = state.tabs[at] as DocTab;
			const changed = existing.size !== action.file.size || existing.mtimeMs !== action.file.mtimeMs;
			const tabs = changed
				? state.tabs.map((tab, index) => (index === at ? { ...action.file, key: action.key, revision: existing.revision + 1 } : tab))
				: state.tabs;
			return { tabs, activeKey: action.key, notice: null };
		}
		case "refused":
			return { ...state, notice: action.message };
		case "activate":
			return state.tabs.some(tab => tab.key === action.key) ? { ...state, activeKey: action.key } : state;
		case "close": {
			const at = state.tabs.findIndex(tab => tab.key === action.key);
			if (at === -1) return state;
			const tabs = state.tabs.filter(tab => tab.key !== action.key);
			if (state.activeKey !== action.key) return { ...state, tabs };
			// Closing the front tab shows its right neighbour, else its left one.
			const next = tabs[at] ?? tabs[at - 1];
			return { ...state, tabs, activeKey: next?.key ?? null };
		}
		case "dismiss":
			return state.notice === null ? state : { ...state, notice: null };
	}
}

export interface ViewerStore {
	getState(): ViewerState;
	dispatch(action: ViewerAction): void;
	subscribe(listener: () => void): () => void;
}

export function createViewerStore(): ViewerStore {
	let state = INITIAL_STATE;
	const listeners = new Set<() => void>();
	return {
		getState: () => state,
		dispatch(action) {
			const next = reduce(state, action);
			if (next === state) return;
			state = next;
			for (const listener of listeners) listener();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export function useViewerState(store: ViewerStore): ViewerState {
	return useSyncExternalStore(store.subscribe, store.getState);
}
