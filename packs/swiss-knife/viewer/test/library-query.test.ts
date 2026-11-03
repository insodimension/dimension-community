import { describe, expect, test } from "bun:test";
import { hasTag, parseTags, toggleTag, toggleValue } from "@fraym/ui/features/media-library";
import {
	checkBatches,
	DEFAULT_FILTER,
	filterKey,
	INITIAL_LIST,
	type ListAction,
	type ListState,
	PAGE_SIZE,
	queryArgs,
	reduceList,
	reloadLoaded,
	shownItem,
} from "../app/view/library/query";
import type { LibraryItem, LibraryPage, LibraryQuery } from "../../src/library/types";

const item = (id: string, extra: Partial<LibraryItem> = {}): LibraryItem => ({
	id,
	path: `/work/${id}.png`,
	name: `${id}.png`,
	tags: [],
	kind: "image",
	mime: "image/png",
	size: 10,
	mtimeMs: 1,
	source: "present",
	starred: false,
	state: "live",
	createdAt: 1,
	presentedAt: 1,
	hasThumb: false,
	shares: [],
	...extra,
});

const page = (ids: readonly string[], next?: string, total = ids.length): LibraryPage => ({ items: ids.map(id => item(id)), ...(next === undefined ? {} : { next }), total });
const play = (...actions: ListAction[]): ListState => actions.reduce(reduceList, INITIAL_LIST);
const ids = (state: ListState) => state.items.map(each => each.id);

describe("library query arguments", () => {
	test("the default filter asks for the best match, which is the most recent when nothing is searched, one page", () => {
		expect(queryArgs(DEFAULT_FILTER)).toEqual({ sort: "relevance", limit: PAGE_SIZE });
	});

	test("each filter maps to its own argument, the search trimmed, a cursor carried", () => {
		const args = queryArgs({ q: "  deck ", kinds: ["pdf", "pptx"], tags: ["Demo", "launch"], workspace: "/work", scope: "discarded", sort: "name" }, "c1");
		expect(args).toEqual({ q: "deck", kinds: ["pdf", "pptx"], tags: ["Demo", "launch"], workspace: "/work", state: "discarded", sort: "name", cursor: "c1", limit: PAGE_SIZE });
		expect(queryArgs({ ...DEFAULT_FILTER, scope: "starred" }).starred).toBe(true);
		expect(queryArgs({ ...DEFAULT_FILTER, scope: "shared" }).shared).toBe(true);
	});

	test("a search that is only spaces is no search, so it shares the unfiltered key", () => {
		expect(filterKey({ ...DEFAULT_FILTER, q: "   " }, 0)).toBe(filterKey(DEFAULT_FILTER, 0));
		expect(filterKey(DEFAULT_FILTER, 1)).not.toBe(filterKey(DEFAULT_FILTER, 0));
	});

	test("toggling a kind adds it once and takes it out again", () => {
		expect(toggleValue(toggleValue<string>([], "pdf"), "video")).toEqual(["pdf", "video"]);
		expect(toggleValue(["pdf", "video"], "pdf")).toEqual(["video"]);
	});

	test("a tag is selected whatever its case, and toggling it in another case takes it out instead of adding a twin", () => {
		expect(hasTag(["Film", "launch"], "FILM")).toBe(true);
		expect(hasTag(["film"], "films")).toBe(false);
		expect(toggleTag(["launch"], "Film")).toEqual(["launch", "Film"]);
		expect(toggleTag(["Film", "launch"], "FILM")).toEqual(["launch"]);
		expect(toggleTag(toggleTag([], "film"), "Film")).toEqual([]);
		expect(toggleTag(["film"], "films")).toEqual(["film", "films"]);
	});
});

describe("library list: the latest request wins", () => {
	test("a slower answer to an older search never replaces the newer one", () => {
		const state = play(
			{ type: "request", key: "a" },
			{ type: "request", key: "ab" },
			{ type: "page", key: "ab", page: page(["ab1"]), append: false },
			{ type: "page", key: "a", page: page(["a1", "a2"]), append: false },
		);
		expect(ids(state)).toEqual(["ab1"]);
		expect(state.phase).toBe("ready");
	});

	test("an older answer that lands first is dropped too, and the newer one still shows", () => {
		const state = play({ type: "request", key: "a" }, { type: "request", key: "ab" }, { type: "page", key: "a", page: page(["a1"]), append: false });
		expect(ids(state)).toEqual([]);
		expect(state.phase).toBe("loading");
		expect(ids(reduceList(state, { type: "page", key: "ab", page: page(["ab1"]), append: false }))).toEqual(["ab1"]);
	});

	test("the old rows stay on screen while a new search loads, so typing never flashes empty", () => {
		const state = play({ type: "request", key: "a" }, { type: "page", key: "a", page: page(["a1"]), append: false }, { type: "request", key: "ab" });
		expect(ids(state)).toEqual(["a1"]);
		expect(state.phase).toBe("loading");
	});

	test("a failure of an older request says nothing over the newer one", () => {
		const state = play({ type: "request", key: "a" }, { type: "request", key: "b" }, { type: "failed", key: "a", error: "boom" });
		expect(state.phase).toBe("loading");
		expect(state.error).toBeNull();
	});

	test("pages append in order, one at a time, and a stale page for a replaced search is dropped", () => {
		let state = play({ type: "request", key: "k" }, { type: "page", key: "k", page: page(["1", "2"], "c1", 5), append: false });
		state = reduceList(state, { type: "more", key: "k" });
		expect(reduceList(state, { type: "more", key: "k" })).toBe(state);
		state = reduceList(state, { type: "page", key: "k", page: page(["3", "4"], "c2", 5), append: true });
		expect(ids(state)).toEqual(["1", "2", "3", "4"]);
		expect(state.next).toBe("c2");
		expect(state.loadingMore).toBe(false);
		const replaced = reduceList(reduceList(state, { type: "more", key: "k" }), { type: "request", key: "other" });
		expect(ids(reduceList(replaced, { type: "page", key: "k", page: page(["5"]), append: true }))).toEqual(["1", "2", "3", "4"]);
	});

	test("no further page is asked for once the cursor runs out", () => {
		const state = play({ type: "request", key: "k" }, { type: "page", key: "k", page: page(["1"]), append: false });
		expect(reduceList(state, { type: "more", key: "k" })).toBe(state);
	});
});

describe("library list: rows change in place", () => {
	const loaded = play({ type: "request", key: "k" }, { type: "page", key: "k", page: page(["1", "2", "3"], undefined, 3), append: false });

	test("an updated item replaces its row without moving it", () => {
		const state = reduceList(loaded, { type: "item", item: item("2", { starred: true }) });
		expect(ids(state)).toEqual(["1", "2", "3"]);
		expect(state.items[1]?.starred).toBe(true);
	});

	test("a removed item leaves and the total follows", () => {
		const state = reduceList(loaded, { type: "remove", id: "2" });
		expect(ids(state)).toEqual(["1", "3"]);
		expect(state.total).toBe(2);
		expect(reduceList(state, { type: "remove", id: "2" })).toBe(state);
	});

	test("a drawn poster marks its row as having a thumbnail, once", () => {
		const state = reduceList(loaded, { type: "thumb", id: "3" });
		expect(state.items[2]?.hasThumb).toBe(true);
		expect(reduceList(state, { type: "thumb", id: "3" })).toBe(state);
	});

	test("a check that finds a file gone shows it missing; an unchanged check changes nothing", () => {
		const state = reduceList(loaded, { type: "checked", rows: [{ id: "1", state: "missing", size: 10, mtimeMs: 1 }] });
		const first = state.items[0] as LibraryItem;
		expect(shownItem(first, state.checked).state).toBe("missing");
		expect(shownItem(state.items[1] as LibraryItem, state.checked)).toBe(state.items[1] as LibraryItem);
		expect(reduceList(state, { type: "checked", rows: [{ id: "1", state: "missing", size: 10, mtimeMs: 1 }] })).toBe(state);
	});
});

describe("library list: refreshing in place", () => {
	const loaded = play({ type: "request", key: "k" }, { type: "page", key: "k", page: page(["1", "2"], "c1", 5), append: false });
	const refreshing = play({ type: "request", key: "k" }, { type: "page", key: "k", page: page(["1", "2"], "c1", 5), append: false }, { type: "stale" }, { type: "refresh", key: "k" });

	test("a refresh swaps the rows without the list ever going back to loading", () => {
		const seen: ListState[] = [loaded];
		for (const action of [{ type: "stale" }, { type: "refresh", key: "k" }, { type: "refreshed", key: "k", page: page(["0", "1", "2"], "c1", 6) }] satisfies ListAction[]) {
			seen.push(reduceList(seen[seen.length - 1] as ListState, action));
		}
		expect(seen.map(state => state.phase)).toEqual(["ready", "ready", "ready", "ready"]);
		expect(ids(seen[2] as ListState)).toEqual(["1", "2"]);
		const done = seen[3] as ListState;
		expect(ids(done)).toEqual(["0", "1", "2"]);
		expect(done).toMatchObject({ total: 6, next: "c1", refreshing: false, stale: false });
	});

	test("a next page is refused while a refresh reads, and asked for again once it lands", () => {
		expect(reduceList(refreshing, { type: "more", key: "k" })).toBe(refreshing);
		const landed = reduceList(refreshing, { type: "refreshed", key: "k", page: page(["1", "2"], "c1", 5) });
		expect(reduceList(landed, { type: "more", key: "k" }).loadingMore).toBe(true);
	});

	test("a new search wins over a refresh in flight: the old answer is dropped and nothing is left stale", () => {
		const typed = play(
			{ type: "request", key: "k" },
			{ type: "page", key: "k", page: page(["1", "2"], undefined, 2), append: false },
			{ type: "stale" },
			{ type: "refresh", key: "k" },
			{ type: "stale" },
			{ type: "request", key: "k2" },
		);
		expect(typed).toMatchObject({ key: "k2", phase: "loading", refreshing: false, stale: false });
		const late = reduceList(typed, { type: "refreshed", key: "k", page: page(["old"], undefined, 1) });
		expect(late).toBe(typed);
		expect(ids(reduceList(late, { type: "page", key: "k2", page: page(["new"], undefined, 1), append: false }))).toEqual(["new"]);
	});

	test("a refresh answer for an earlier search never lands on the refresh of the current one", () => {
		const state = play(
			{ type: "request", key: "k" },
			{ type: "page", key: "k", page: page(["a"], undefined, 1), append: false },
			{ type: "stale" },
			{ type: "refresh", key: "k" },
			{ type: "request", key: "k2" },
			{ type: "page", key: "k2", page: page(["b"], undefined, 1), append: false },
			{ type: "stale" },
			{ type: "refresh", key: "k2" },
		);
		const late = reduceList(state, { type: "refreshed", key: "k", page: page(["a", "a2"], undefined, 2) });
		expect(late).toBe(state);
		expect(ids(reduceList(late, { type: "refreshed", key: "k2", page: page(["b", "b2"], undefined, 2) }))).toEqual(["b", "b2"]);
	});

	test("an edit or removal that lands while a refresh reads leaves the list stale, so the older read is followed by a newer one", () => {
		const edited = reduceList(refreshing, { type: "item", item: item("2", { starred: true }) });
		expect(edited.stale).toBe(true);
		const landed = reduceList(edited, { type: "refreshed", key: "k", page: page(["1", "2"], "c1", 5) });
		expect(landed).toMatchObject({ refreshing: false, stale: true });
		expect(reduceList(refreshing, { type: "remove", id: "2" }).stale).toBe(true);
		expect(reduceList(loaded, { type: "item", item: item("2", { starred: true }) }).stale).toBe(false);
		expect(reduceList(loaded, { type: "remove", id: "2" }).stale).toBe(false);
	});
});

describe("reloading the rows that were loaded", () => {
	const rows = (from: number, count: number): string[] => Array.from({ length: count }, (_, index) => `r${from + index}`);
	const pages = [page(rows(0, PAGE_SIZE), "c1", 550), page(rows(PAGE_SIZE, PAGE_SIZE), "c2", 550), page(rows(2 * PAGE_SIZE, 150), undefined, 550)];
	const served = () => {
		const calls: LibraryQuery[] = [];
		const read = async (args: LibraryQuery): Promise<LibraryPage> => {
			calls.push(args);
			const found = pages[args.cursor === undefined ? 0 : Number(args.cursor.slice(1))];
			if (found === undefined) throw new Error(`no page for ${args.cursor}`);
			return found;
		};
		return { calls, read };
	};
	const filter = { ...DEFAULT_FILTER, q: "hero" };

	const cases = [
		{ name: "one page that was loaded is one page read", count: PAGE_SIZE, cursors: [undefined], rows: 200, next: "c1" },
		{ name: "less than a page loaded is still one page read, never truncated to fewer rows than the server answers", count: 3, cursors: [undefined], rows: 200, next: "c1" },
		{ name: "two pages loaded are two pages read, following the cursor", count: 2 * PAGE_SIZE, cursors: [undefined, "c1"], rows: 400, next: "c2" },
		{ name: "one row into the third page reads the third page", count: 2 * PAGE_SIZE + 1, cursors: [undefined, "c1", "c2"], rows: 550, next: undefined },
		{ name: "more rows than exist stops when the cursor runs out", count: 5000, cursors: [undefined, "c1", "c2"], rows: 550, next: undefined },
	] as const;

	for (const each of cases) {
		test(each.name, async () => {
			const { calls, read } = served();
			const result = await reloadLoaded(read, filter, each.count);
			expect(calls.map(call => call.cursor)).toEqual([...each.cursors]);
			expect(calls.every(call => call.q === "hero" && call.limit === PAGE_SIZE)).toBe(true);
			expect(result.items.map(row => row.id)).toEqual(rows(0, each.rows));
			expect(result.next).toBe(each.next);
			expect(result.total).toBe(550);
		});
	}
});

describe("library helpers", () => {
	test("tags are split on commas, trimmed, and kept once whatever their case", () => {
		expect(parseTags(" demo, Launch ,, demo,launch ")).toEqual(["demo", "Launch"]);
	});

	test("visible rows are checked in batches, and a row checked a moment ago is not checked again", () => {
		const many = Array.from({ length: 450 }, (_, index) => `id${index}`);
		expect(checkBatches(many, {}, 1000, 60_000, 200).map(batch => batch.length)).toEqual([200, 200, 50]);
		expect(checkBatches(["a", "b"], { a: 990 }, 1000, 60_000, 200)).toEqual([["b"]]);
		expect(checkBatches(["a"], { a: 0 }, 61_000, 60_000, 200)).toEqual([["a"]]);
	});
});
