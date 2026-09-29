// COLLECTIONS — the owner's "projects": a user grouping of sessions that has
// nothing to do with a code workspace (doc 84 §4).
//
// THIS FILE IS THE ONLY PERSISTENCE CODE IN THE PACK, and that is the design.
// Measured (doc 84 §4): no mutable grouping field exists on a session, a rail
// seat has no Store acts, and no pack-state door exists yet (gap G3). So the
// interim home is `localStorage` — per-webview, unsynced across machines, lost
// on reinstall — behind the exact `CollectionsStore` surface below. When the
// pack-state door lands, swapping the backend is a rewrite of THIS file and
// nothing else: the fold, the menu and the rail only ever see the interface.
//
// Three properties the rail relies on, each one a real failure otherwise:
//   - it never throws on what it reads. Storage is user-editable and shared
//     with older builds; a corrupt blob yields an empty store, not a dead rail.
//   - a mutation is read-modify-write against STORAGE, not against memory. Two
//     windows of the desktop app share one origin; writing memory back would
//     let a window with a stale copy erase the other's collections.
//   - `remove` unassigns. A session never points at a collection that is gone.

/** The `localStorage` key. Versioned in the name so a future shape change can
 *  read the old blob from the old key and write the new one beside it. */
export const COLLECTIONS_STORAGE_KEY = "chat.collections.v1";

export interface Collection {
	readonly id: string;
	readonly name: string;
	readonly createdAt: number;
}

export interface CollectionsStore {
	/** Collections in creation order. The array is a shared snapshot: its
	 *  identity is stable until the collection list itself changes, so a caller
	 *  must treat it as read-only. */
	list(): Collection[];
	create(name: string): Collection;
	rename(id: string, name: string): void;
	/** Deletes the collection AND unassigns every session filed in it. */
	remove(id: string): void;
	/** `null` files the session back under Unfiled. An unknown collection id is
	 *  refused (no-op): an assignment can never dangle. */
	assign(sessionId: string, collectionId: string | null): void;
	collectionOf(sessionId: string): string | null;
	subscribe(fn: () => void): () => void;
}

/** The slice of the Web Storage API the store touches, so a test (or a future
 *  host) can hand it any backing. */
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

interface State {
	readonly collections: Collection[];
	readonly assignments: ReadonlyMap<string, string>;
}

const EMPTY: State = { collections: [], assignments: new Map() };

/** A collection name is a short label, not a document. */
const MAX_NAME = 60;

function cleanName(name: string): string {
	return name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse whatever storage holds into a valid state. Anything that is not
 *  exactly the shape this file writes contributes nothing — never an
 *  exception, and never a half-trusted entry. */
function parse(raw: string | null): State {
	if (!raw) return EMPTY;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return EMPTY;
	}
	if (!isRecord(value) || value.v !== 1) return EMPTY;
	const collections: Collection[] = [];
	const ids = new Set<string>();
	if (Array.isArray(value.collections)) {
		for (const entry of value.collections) {
			if (!isRecord(entry)) continue;
			const { id, name, createdAt } = entry;
			if (typeof id !== "string" || id === "" || ids.has(id)) continue;
			if (typeof name !== "string" || cleanName(name) === "") continue;
			if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) continue;
			ids.add(id);
			collections.push({ id, name: cleanName(name), createdAt });
		}
	}
	const assignments = new Map<string, string>();
	if (isRecord(value.assignments)) {
		for (const [sessionId, collectionId] of Object.entries(value.assignments)) {
			// An assignment into a collection that does not exist is an orphan
			// (a hand edit, a half-written blob): dropped, so it can neither
			// resurrect nor leak into a collection created later with that id.
			if (typeof collectionId === "string" && ids.has(collectionId)) assignments.set(sessionId, collectionId);
		}
	}
	return { collections, assignments };
}

function serialize(state: State): string {
	return JSON.stringify({
		v: 1,
		collections: state.collections,
		assignments: Object.fromEntries(state.assignments),
	});
}

function newId(): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	if (uuid) return `col_${uuid}`;
	return `col_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Build a store over `storage`. With no storage (a locked-down webview, a
 *  server render) it degrades to memory-only: the rail still works, nothing
 *  survives the session. */
export function createCollectionsStore(storage: StorageLike | undefined): CollectionsStore {
	let state: State = EMPTY;
	let warned = false;
	/** The raw string storage held when `state` last agreed with it — read, or
	 *  written successfully. `undefined` = never looked. */
	let synced: string | null | undefined;

	/** The state a mutation must build on. Storage is the truth (another window may
	 *  have written since), so it is consulted every time — but only RE-PARSED when
	 *  its raw text differs from what this store last saw. That keeps two things:
	 *  `list()` keeps its identity across mutations that do not touch it, and a
	 *  change storage refused to take (quota, a revoked store) is not read back
	 *  as "nothing happened" by the very next click. */
	const sync = (): State => {
		if (!storage) return state;
		let raw: string | null;
		try {
			raw = storage.getItem(COLLECTIONS_STORAGE_KEY);
		} catch {
			// A storage that throws on read (a sandboxed origin) has nothing new to say.
			return state;
		}
		if (raw !== synced) {
			state = parse(raw);
			synced = raw;
		}
		return state;
	};
	sync();

	const listeners = new Set<() => void>();
	const emit = (): void => {
		for (const listener of [...listeners]) listener();
	};

	const commit = (next: State): void => {
		state = next;
		if (storage) {
			const raw = serialize(next);
			try {
				storage.setItem(COLLECTIONS_STORAGE_KEY, raw);
				synced = raw;
			} catch (error) {
				// Quota or a revoked store: the change still holds for this session,
				// but it will not survive a reload — say so once, not per click.
				if (!warned) {
					warned = true;
					console.warn("[chat-rail] collections could not be saved; they will not persist", error);
				}
			}
		}
		emit();
	};

	/** Adopt a change another window made, and tell subscribers. */
	const refresh = (): void => {
		const before = state;
		if (sync() !== before) emit();
	};

	const onStorage = (event: StorageEvent): void => {
		// `key === null` is `localStorage.clear()` from another window.
		if (event.key === COLLECTIONS_STORAGE_KEY || event.key === null) refresh();
	};
	const target: Pick<EventTarget, "addEventListener" | "removeEventListener"> | undefined =
		storage && typeof globalThis.addEventListener === "function" ? globalThis : undefined;

	return {
		list: () => state.collections,
		create(name) {
			const base = sync();
			const collection: Collection = {
				id: newId(),
				name: cleanName(name) || "Untitled",
				createdAt: Date.now(),
			};
			commit({ collections: [...base.collections, collection], assignments: base.assignments });
			return collection;
		},
		rename(id, name) {
			const base = sync();
			const next = cleanName(name);
			const index = base.collections.findIndex(collection => collection.id === id);
			if (next === "" || index < 0 || base.collections[index]!.name === next) return;
			const collections = base.collections.slice();
			collections[index] = { ...collections[index]!, name: next };
			commit({ collections, assignments: base.assignments });
		},
		remove(id) {
			const base = sync();
			if (!base.collections.some(collection => collection.id === id)) return;
			const assignments = new Map<string, string>();
			for (const [sessionId, collectionId] of base.assignments) {
				if (collectionId !== id) assignments.set(sessionId, collectionId);
			}
			commit({ collections: base.collections.filter(collection => collection.id !== id), assignments });
		},
		assign(sessionId, collectionId) {
			if (sessionId === "") return;
			const base = sync();
			if (collectionId !== null && !base.collections.some(collection => collection.id === collectionId)) return;
			if ((base.assignments.get(sessionId) ?? null) === collectionId) return;
			const assignments = new Map(base.assignments);
			if (collectionId === null) assignments.delete(sessionId);
			else assignments.set(sessionId, collectionId);
			commit({ collections: base.collections, assignments });
		},
		collectionOf: sessionId => state.assignments.get(sessionId) ?? null,
		subscribe(fn) {
			// The cross-window listener lives exactly as long as someone listens.
			if (listeners.size === 0) target?.addEventListener("storage", onStorage as EventListener);
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
				if (listeners.size === 0) target?.removeEventListener("storage", onStorage as EventListener);
			};
		},
	};
}

function ambientStorage(): StorageLike | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		// Touching `localStorage` throws a SecurityError in an opaque origin.
		return undefined;
	}
}

/** The one store the rail uses. */
export const collectionsStore: CollectionsStore = createCollectionsStore(ambientStorage());
