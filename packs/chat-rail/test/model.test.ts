/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the personal rail lists somebody
 *  else's conversation (a coding session, a room), hides one of yours, sorts the
 *  oldest first, files a session under a collection that no longer exists so it
 *  vanishes from the list, or drops the session you are looking at behind a
 *  "Show more". Every rule here is computed by the pack ALONE from raw rows, so
 *  nothing upstream can catch it. */
import { describe, expect, test } from "bun:test";
import type { Collection } from "../src/collections-store";
import {
	clipRows,
	collectionKey,
	type Desk,
	type DeskRow,
	foldRail,
	narrowToDesk,
	type RailItem,
	railItemsOf,
	resolveDesk,
	UNFILED_ID,
} from "../src/model";

const DESK: Desk = { spaceId: "chat", workspaceId: "inso-personal", agents: ["aether"] };

function raw(id: string, over: Partial<DeskRow> = {}): DeskRow & { readonly id: string } {
	return { id, ref: { workspaceId: "inso-personal" }, profile: "aether", ...over };
}

const ids = (rows: readonly { readonly id: string }[]) => rows.map(row => row.id);

describe("narrowToDesk", () => {
	test("a row stamped for this space belongs, on the stamp alone", () => {
		const rows = [raw("mine-elsewhere", { space: "chat", ref: { workspaceId: "some-repo" }, profile: "coder" })];
		expect(ids(narrowToDesk(rows, DESK))).toEqual(["mine-elsewhere"]);
	});

	test("an Aether conversation begun from the Code bubble (stamped code) is the same family", () => {
		expect(ids(narrowToDesk([raw("from-bubble", { space: "code" })], DESK))).toEqual(["from-bubble"]);
	});

	test("a row stamped for another space is not rescued outside the desk workspace or agent", () => {
		const rows = [
			raw("code-repo", { space: "code", ref: { workspaceId: "some-repo" } }),
			raw("code-other-agent", { space: "code", profile: "coder" }),
		];
		expect(narrowToDesk(rows, DESK)).toEqual([]);
	});

	test("an unstamped row must live in the desk workspace", () => {
		const rows = [raw("home"), raw("repo", { ref: { workspaceId: "some-repo" } })];
		expect(ids(narrowToDesk(rows, DESK))).toEqual(["home"]);
	});

	test("an unstamped row is admitted by the space's agents when it lists any", () => {
		const rows = [
			raw("aether"),
			raw("other-agent", { profile: "coder" }),
			// An unattributed session is somebody's plain coding session.
			raw("no-profile", { profile: undefined }),
		];
		expect(ids(narrowToDesk(rows, DESK))).toEqual(["aether"]);
	});

	test("a space that lists no agents states no opinion, so the workspace alone decides", () => {
		const rows = [raw("a"), raw("b", { profile: undefined })];
		expect(ids(narrowToDesk(rows, { ...DESK, agents: [] }))).toEqual(["a", "b"]);
	});

	test("an unstamped room is never listed", () => {
		expect(narrowToDesk([raw("room", { kind: "room" })], DESK)).toEqual([]);
	});

	test("a space that declares no desk claims only what is stamped for it", () => {
		const rows = [raw("stamped", { space: "chat" }), raw("unstamped")];
		expect(ids(narrowToDesk(rows, { ...DESK, workspaceId: undefined }))).toEqual(["stamped"]);
	});

	test("returns the input itself when nothing is filtered out", () => {
		const rows = [raw("a"), raw("b")];
		expect(narrowToDesk(rows, DESK)).toBe(rows);
	});
});

describe("resolveDesk", () => {
	test("reads the desk off the active space's declared workspace scope", () => {
		const spaces = [
			{ id: "code", workspace: {} },
			{ id: "chat", workspace: { scope: { workspace: "inso-personal" } } },
		];
		expect(resolveDesk(spaces, "chat", ["aether"])).toEqual(DESK);
	});

	test("a space that scopes by agent, or is unknown, has no desk workspace", () => {
		const spaces = [{ id: "design", workspace: { scope: { agent: "designer" } } }];
		expect(resolveDesk(spaces, "design", []).workspaceId).toBeUndefined();
		expect(resolveDesk(spaces, "missing", []).workspaceId).toBeUndefined();
	});
});

describe("railItemsOf", () => {
	const item = (id: string, over: Partial<RailItem> = {}): RailItem => ({ id, title: id, ...over });

	test("keeps browsable rows and drops archived, ask-only, room and search-only ones", () => {
		const groups = [
			{
				items: [
					item("live"),
					item("archived", { archived: true }),
					item("seat", { askOnly: true }),
					item("room", { kind: "room" }),
				],
			},
			{ items: [item("elsewhere")], searchOnly: true },
		];
		expect(ids(railItemsOf(groups))).toEqual(["live"]);
	});
});

describe("foldRail", () => {
	const HOUR = 60 * 60 * 1000;
	const NOW = Date.UTC(2026, 8, 30, 12);
	const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();
	const session = (id: string, hoursAgo: number, over: Partial<RailItem> = {}): RailItem => ({
		id,
		title: `Session ${id}`,
		updatedAt: at(hoursAgo),
		sessionRef: { sessionId: id },
		...over,
	});
	const collection = (id: string, name = id): Collection => ({ id, name, createdAt: 1 });
	const nothingFiled = { collections: [] as Collection[], collectionOf: () => null, query: "" };

	test("orders newest first, and sorts a row with no usable time last", () => {
		const items = [
			session("old", 30),
			session("no-time", 0, { updatedAt: undefined }),
			session("new", 1),
			session("garbled", 0, { updatedAt: "not a date" }),
			session("mid", 5),
		];
		const fold = foldRail(items, nothingFiled);
		expect(ids(fold.sections[0]?.items ?? [])).toEqual(["new", "mid", "old", "garbled", "no-time"]);
	});

	test("is flat — one Unfiled section, no headers — until a collection exists", () => {
		const fold = foldRail([session("a", 1)], nothingFiled);
		expect(fold.grouped).toBe(false);
		expect(fold.sections.map(section => section.id)).toEqual([UNFILED_ID]);
	});

	test("groups by collection in creation order, then Unfiled, each newest first", () => {
		const filed: Record<string, string> = { a: "trips", c: "trips", d: "taxes" };
		const fold = foldRail([session("a", 4), session("b", 1), session("c", 2), session("d", 3)], {
			collections: [collection("trips"), collection("taxes")],
			collectionOf: key => filed[key] ?? null,
			query: "",
		});
		expect(fold.grouped).toBe(true);
		expect(fold.sections.map(section => [section.id, ids(section.items)])).toEqual([
			["trips", ["c", "a"]],
			["taxes", ["d"]],
			[UNFILED_ID, ["b"]],
		]);
	});

	test("a session whose collection was deleted falls back to Unfiled instead of disappearing", () => {
		const fold = foldRail([session("orphan", 1), session("kept", 2)], {
			collections: [collection("trips")],
			// The blob still names "deleted-collection" for `orphan`.
			collectionOf: key => (key === "orphan" ? "deleted-collection" : key === "kept" ? "trips" : null),
			query: "",
		});
		expect(fold.sections.map(section => [section.id, ids(section.items)])).toEqual([
			["trips", ["kept"]],
			[UNFILED_ID, ["orphan"]],
		]);
	});

	test("browsing shows an empty collection; searching drops it", () => {
		const input = { collections: [collection("empty"), collection("trips")], collectionOf: () => null, query: "" };
		const browsing = foldRail([session("a", 1)], input);
		expect(browsing.sections.map(section => section.id)).toEqual(["empty", "trips", UNFILED_ID]);

		const searching = foldRail([session("a", 1)], { ...input, query: "session a" });
		expect(searching.sections.map(section => section.id)).toEqual([UNFILED_ID]);
	});

	test("search matches title, preview and a folded handoff chain's older titles, ignoring case", () => {
		const items = [
			session("title", 1, { title: "Plan the Lisbon trip" }),
			session("preview", 2, { title: "Untitled", preview: "book flights to LISBON" }),
			session("chain", 3, {
				title: "Continue executing the plan",
				lineage: { rootRef: { sessionId: "root" }, text: "Lisbon itinerary Continue executing the plan" },
			}),
			session("miss", 4, { title: "Quarterly taxes" }),
		];
		const fold = foldRail(items, { ...nothingFiled, query: "  lisbon " });
		expect(ids(fold.sections.flatMap(section => section.items))).toEqual(["title", "preview", "chain"]);
		expect(fold.total).toBe(3);
	});

	test("a row filed by search does not depend on which section it is in", () => {
		const fold = foldRail([session("a", 1, { title: "Lisbon" }), session("b", 2, { title: "Lisbon too" })], {
			collections: [collection("trips")],
			collectionOf: key => (key === "a" ? "trips" : null),
			query: "lisbon",
		});
		expect(fold.total).toBe(2);
		expect(fold.sections.map(section => [section.id, ids(section.items)])).toEqual([
			["trips", ["a"]],
			[UNFILED_ID, ["b"]],
		]);
	});

	test("a handoff chain stays in its collection: the row is keyed by the chain's root", () => {
		const chain = session("tail-after-handoff", 1, {
			lineage: { rootRef: { sessionId: "chain-root" }, text: "" },
		});
		expect(collectionKey(chain)).toBe("chain-root");
		const fold = foldRail([chain], {
			collections: [collection("trips")],
			collectionOf: key => (key === "chain-root" ? "trips" : null),
			query: "",
		});
		expect(ids(fold.sections[0]?.items ?? [])).toEqual(["tail-after-handoff"]);
		expect(fold.sections[0]?.id).toBe("trips");
	});
});

describe("clipRows", () => {
	const row = (id: string, active = false): RailItem => ({ id, title: id, active });
	const many = (count: number, activeIndex = -1) =>
		Array.from({ length: count }, (_, index) => row(`r${index}`, index === activeIndex));

	test("shows everything at or under the limit", () => {
		const rows = many(3);
		expect(clipRows(rows, 3)).toBe(rows);
		expect(clipRows(rows, Number.POSITIVE_INFINITY)).toBe(rows);
	});

	test("folds the rest, but never folds away the open session", () => {
		expect(ids(clipRows(many(6), 2))).toEqual(["r0", "r1"]);
		expect(ids(clipRows(many(6, 4), 2))).toEqual(["r0", "r1", "r4"]);
	});
});
