/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the user's collections vanish on
 *  reload, a corrupt blob in storage kills the whole rail, deleting a collection
 *  leaves sessions pointing at nothing, or a second window silently erases what
 *  the first one filed. The store is the ONLY persistence code in the pack, so
 *  nothing downstream can catch any of these. */
import { describe, expect, test } from "bun:test";
import { COLLECTIONS_STORAGE_KEY, createCollectionsStore, type StorageLike } from "../src/collections-store";

class MemoryStorage implements StorageLike {
	readonly data = new Map<string, string>();
	getItem(key: string): string | null {
		return this.data.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		this.data.set(key, value);
	}
}

describe("persistence", () => {
	test("collections, names and assignments survive a fresh store over the same storage", () => {
		const storage = new MemoryStorage();
		const first = createCollectionsStore(storage);
		const trips = first.create("Trips");
		const taxes = first.create("Taxes");
		first.rename(taxes.id, "Taxes 2026");
		first.assign("s-1", trips.id);
		first.assign("s-2", taxes.id);

		const second = createCollectionsStore(storage);
		expect(second.list().map(collection => collection.name)).toEqual(["Trips", "Taxes 2026"]);
		expect(second.collectionOf("s-1")).toBe(trips.id);
		expect(second.collectionOf("s-2")).toBe(taxes.id);
		expect(second.collectionOf("s-unfiled")).toBeNull();
	});

	test("writes under the documented versioned key", () => {
		const storage = new MemoryStorage();
		createCollectionsStore(storage).create("Trips");
		expect(storage.data.has(COLLECTIONS_STORAGE_KEY)).toBe(true);
		expect(COLLECTIONS_STORAGE_KEY).toBe("chat.collections.v1");
	});

	test("a change made through one store is not overwritten by a stale second store", () => {
		// Two windows share one origin: each holds its own in-memory copy. A mutation
		// that wrote its copy back would erase the other window's collection.
		const storage = new MemoryStorage();
		const windowA = createCollectionsStore(storage);
		const windowB = createCollectionsStore(storage);
		windowA.create("From A");
		windowB.create("From B");

		expect(createCollectionsStore(storage).list().map(collection => collection.name)).toEqual(["From A", "From B"]);
	});
});

describe("hostile storage", () => {
	const blobs: [string, string][] = [
		["not JSON", "{not json"],
		["wrong version", JSON.stringify({ v: 2, collections: [{ id: "c", name: "X", createdAt: 1 }], assignments: {} })],
		["not an object", JSON.stringify(["a"])],
		["null", "null"],
		["collections of the wrong type", JSON.stringify({ v: 1, collections: "nope", assignments: 7 })],
	];
	for (const [label, blob] of blobs) {
		test(`${label} yields an empty store and does not throw`, () => {
			const storage = new MemoryStorage();
			storage.data.set(COLLECTIONS_STORAGE_KEY, blob);
			const store = createCollectionsStore(storage);
			expect(store.list()).toEqual([]);
			expect(store.collectionOf("anything")).toBeNull();
			// And it recovers: the next write replaces the junk.
			const created = store.create("Fresh");
			expect(createCollectionsStore(storage).list()).toEqual([created]);
		});
	}

	test("malformed entries are dropped one by one, valid ones are kept", () => {
		const storage = new MemoryStorage();
		storage.data.set(
			COLLECTIONS_STORAGE_KEY,
			JSON.stringify({
				v: 1,
				collections: [
					{ id: "ok", name: "Kept", createdAt: 5 },
					{ id: "ok", name: "Duplicate id", createdAt: 6 },
					{ id: "no-name", name: "   ", createdAt: 7 },
					{ id: "bad-time", name: "Bad time", createdAt: "yesterday" },
					"garbage",
				],
				// "ghost" was deleted (or never existed): an assignment into it must not survive.
				assignments: { "s-1": "ok", "s-2": "ghost", "s-3": 9 },
			}),
		);
		const store = createCollectionsStore(storage);
		expect(store.list().map(collection => collection.id)).toEqual(["ok"]);
		expect(store.collectionOf("s-1")).toBe("ok");
		expect(store.collectionOf("s-2")).toBeNull();
		expect(store.collectionOf("s-3")).toBeNull();
	});

	test("storage that refuses writes keeps the change for this session instead of throwing", () => {
		const storage: StorageLike = {
			getItem: () => null,
			setItem: () => {
				throw new Error("QuotaExceededError");
			},
		};
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			const store = createCollectionsStore(storage);
			const created = store.create("Trips");
			store.assign("s-1", created.id);
			expect(store.list().map(collection => collection.name)).toEqual(["Trips"]);
			expect(store.collectionOf("s-1")).toBe(created.id);
		} finally {
			console.warn = originalWarn;
		}
	});

	test("with no storage at all the store still works, in memory", () => {
		const store = createCollectionsStore(undefined);
		const created = store.create("Trips");
		store.assign("s-1", created.id);
		expect(store.collectionOf("s-1")).toBe(created.id);
	});
});

describe("assignment", () => {
	test("removing a collection unassigns its sessions and leaves the others filed", () => {
		const storage = new MemoryStorage();
		const store = createCollectionsStore(storage);
		const trips = store.create("Trips");
		const taxes = store.create("Taxes");
		store.assign("s-1", trips.id);
		store.assign("s-2", trips.id);
		store.assign("s-3", taxes.id);

		store.remove(trips.id);

		expect(store.list().map(collection => collection.id)).toEqual([taxes.id]);
		expect(store.collectionOf("s-1")).toBeNull();
		expect(store.collectionOf("s-2")).toBeNull();
		expect(store.collectionOf("s-3")).toBe(taxes.id);
		// The reload agrees — the unassignment was persisted, not just cached.
		const reloaded = createCollectionsStore(storage);
		expect(reloaded.collectionOf("s-1")).toBeNull();
		expect(reloaded.collectionOf("s-3")).toBe(taxes.id);
	});

	test("assigning null files the session back under Unfiled", () => {
		const store = createCollectionsStore(new MemoryStorage());
		const trips = store.create("Trips");
		store.assign("s-1", trips.id);
		store.assign("s-1", null);
		expect(store.collectionOf("s-1")).toBeNull();
	});

	test("a session moves between collections rather than joining two", () => {
		const store = createCollectionsStore(new MemoryStorage());
		const trips = store.create("Trips");
		const taxes = store.create("Taxes");
		store.assign("s-1", trips.id);
		store.assign("s-1", taxes.id);
		expect(store.collectionOf("s-1")).toBe(taxes.id);
	});

	test("an unknown collection id is refused, so an assignment can never dangle", () => {
		const store = createCollectionsStore(new MemoryStorage());
		store.assign("s-1", "col_missing");
		expect(store.collectionOf("s-1")).toBeNull();
	});

	test("a blank rename keeps the old name", () => {
		const store = createCollectionsStore(new MemoryStorage());
		const trips = store.create("Trips");
		store.rename(trips.id, "   ");
		expect(store.list()[0]?.name).toBe("Trips");
	});
});

describe("subscription", () => {
	test("subscribers hear real changes, not no-ops, and stop after unsubscribing", () => {
		const store = createCollectionsStore(new MemoryStorage());
		let heard = 0;
		const stop = store.subscribe(() => {
			heard += 1;
		});
		const trips = store.create("Trips");
		store.assign("s-1", trips.id);
		expect(heard).toBe(2);

		// Same assignment again, a rename to the same name, an unknown remove: nothing changed.
		store.assign("s-1", trips.id);
		store.rename(trips.id, "Trips");
		store.remove("col_missing");
		expect(heard).toBe(2);

		stop();
		store.create("Taxes");
		expect(heard).toBe(2);
	});

	test("list() keeps its identity until the collection list changes", () => {
		const store = createCollectionsStore(new MemoryStorage());
		const trips = store.create("Trips");
		const before = store.list();
		store.assign("s-1", trips.id);
		expect(store.list()).toBe(before);
		store.create("Taxes");
		expect(store.list()).not.toBe(before);
	});
});

describe("another window", () => {
	/** A browser fires `storage` in the OTHER windows of an origin when one writes. */
	const otherWindowWrote = (key: string | null) =>
		globalThis.dispatchEvent(Object.assign(new Event("storage"), { key }));

	test("a live subscriber adopts what another window filed, once its storage event arrives", () => {
		const storage = new MemoryStorage();
		const here = createCollectionsStore(storage);
		let heard = 0;
		const stop = here.subscribe(() => {
			heard += 1;
		});

		const there = createCollectionsStore(storage);
		const trips = there.create("Trips");
		there.assign("s-1", trips.id);
		expect(here.list()).toEqual([]);

		otherWindowWrote(COLLECTIONS_STORAGE_KEY);
		expect(here.list().map(collection => collection.name)).toEqual(["Trips"]);
		expect(here.collectionOf("s-1")).toBe(trips.id);
		expect(heard).toBe(1);

		// An event for some other key, or one that changes nothing, is not a change.
		otherWindowWrote("some.other.key");
		otherWindowWrote(COLLECTIONS_STORAGE_KEY);
		expect(heard).toBe(1);

		stop();
		there.create("Taxes");
		otherWindowWrote(COLLECTIONS_STORAGE_KEY);
		expect(here.list().length).toBe(1);
	});
});
