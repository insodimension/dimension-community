/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the personal rail shows rows that
 *  are not this desk's (a coding session, an archived one), a control appears that
 *  the host never offered (a dead "New session" or "Archive"), or filing a session
 *  under a collection does not move its row until something else re-renders.
 *
 *  The fold rules live in `model.test.ts` and the persistence rules in
 *  `collections-store.test.ts`; this file defends the WIRING between them and the
 *  three rail channels, which no pure test can see. The kit is stood in for by a
 *  fake that only reshapes rows — what it is asked to reshape is the assertion. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, createElement, type ReactNode, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

// ── The granted parts, replaced by stand-ins ─────────────────────────────────

interface RawRow {
	readonly ref: { readonly workspaceId: string; readonly sessionId: string };
	readonly title: string;
	readonly updatedAt: string;
	readonly space?: string;
	readonly profile?: string;
	readonly archivedAt?: string;
}

/** The raw `sessions/list` rows the fake root fact serves. */
let rootRows: readonly RawRow[] = [];
/** Every list the (fake) kit was asked to fold — i.e. what survived the desk filter. */
let kitInputs: (readonly RawRow[])[] = [];

const passthrough = ({ children }: { readonly children?: ReactNode }) => createElement("span", null, children);
const button = ({ children, ...rest }: { readonly children?: ReactNode }) =>
	createElement("button", { type: "button", ...rest }, children);

mock.module("@fraym/ui", () => ({
	ActivityDot: ({ state }: { readonly state: string }) => createElement("i", { "data-dot": state }),
	Icon: () => null,
	IconButton: button,
	Input: (props: Record<string, unknown>) => createElement("input", props),
	Tooltip: passthrough,
	TooltipContent: () => null,
	TooltipProvider: passthrough,
	TooltipTrigger: passthrough,
	useObservable: (source: { subscribe: (fn: () => void) => () => void; getSnapshot: () => unknown }) =>
		useSyncExternalStore(source.subscribe, source.getSnapshot),
	useStandardRootFacts: () => ({ sessions: rootRows }),
	useRailSessionPresence: () => () => null,
	// The kit's own pair: `useRailActionSet` resolves the ACTIVE space's declared actions,
	// `FraymRailActions` draws them. Stubbed to expose exactly which actions the pack hands over.
	useRailActionSet: (spaces: readonly { readonly id: string; readonly rail?: { readonly actions: readonly unknown[] } }[], id: string) =>
		spaces.find(space => space.id === id)?.rail?.actions ?? [],
	FraymRailActions: ({ actions }: { readonly actions: readonly { readonly id: string; readonly label: string }[] }) =>
		createElement(
			"nav",
			{ "data-slot": "rail-actions" },
			actions.map(action => createElement("button", { key: action.id, type: "button", "data-action": action.id }, action.label)),
		),
	// Reshapes snapshots into the row fields the rail reads; decides nothing.
	sessionGroupsFromCatalog: (rows: readonly RawRow[], active: { sessionId: string } | null) => {
		kitInputs.push(rows);
		return [
			{
				items: rows.map(snapshot => ({
					id: `${snapshot.ref.workspaceId}/${snapshot.ref.sessionId}`,
					sessionRef: snapshot.ref,
					title: snapshot.title,
					updatedAt: snapshot.updatedAt,
					time: "1m",
					status: "idle",
					active: active?.sessionId === snapshot.ref.sessionId,
					archived: Boolean(snapshot.archivedAt),
				})),
			},
		];
	},
}));

// Dynamic on purpose: `mock.module` must be registered before the pack's own
// imports resolve `@fraym/ui`, and static imports are hoisted above it.
const { default: ChatRail } = await import("../src/index");
const { collectionsStore } = await import("../src/collections-store");

// ── DOM harness ──────────────────────────────────────────────────────────────

const globalNames = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Event",
	"ResizeObserver",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;
type DomGlobal = (typeof globalNames)[number];
let originalGlobals: Record<DomGlobal, PropertyDescriptor | undefined> | undefined;
let container: HTMLElement;
const roots: Root[] = [];

beforeEach(() => {
	rootRows = [];
	kitInputs = [];
	const { window } = parseHTML('<html><head></head><body><div id="root"></div></body></html>');
	// linkedom has no layout: the menu measures itself, so give it a box and a focus().
	const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.getBoundingClientRect ??= () => ({ width: 200, height: 100, left: 0, top: 0, right: 200, bottom: 100 });
	proto.focus ??= () => {};
	Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
	originalGlobals ??= Object.fromEntries(
		globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
	) as Record<DomGlobal, PropertyDescriptor | undefined>;
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Event: window.Event,
		ResizeObserver: class {
			observe() {}
			disconnect() {}
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	container = window.document.getElementById("root") as unknown as HTMLElement;
});

afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	for (const collection of collectionsStore.list()) collectionsStore.remove(collection.id);
	for (const name of globalNames) {
		const descriptor = originalGlobals?.[name];
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalGlobals = undefined;
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const iso = (agoMinutes: number) => new Date(Date.now() - agoMinutes * MINUTE).toISOString();

function session(id: string, title: string, agoMinutes: number, over: Partial<RawRow> = {}): RawRow {
	return { ref: { workspaceId: "inso-personal", sessionId: id }, title, updatedAt: iso(agoMinutes), profile: "aether", ...over };
}

interface SpaceAction {
	readonly id: string;
	readonly label: string;
	readonly target: string;
}

function facts(query = "", spaceActions: readonly SpaceAction[] = []) {
	return {
		mode: { app: "chat", rail: "expanded" },
		sessions: [{ items: [] }],
		spaces: [{ id: "chat", rail: { actions: spaceActions }, workspace: { scope: { workspace: "inso-personal" } } }],
		search: { open: false, value: query },
		presence: {},
	};
}

function spy() {
	const calls: Record<string, unknown[][]> = {};
	const record =
		(name: string) =>
		(...args: unknown[]) => {
			(calls[name] ??= []).push(args);
		};
	return { calls, record };
}

const EVERY_VERB = ["newSession", "selectSession", "renameItem", "archiveSessions"] as const;

/** Actions offering exactly `offered` of the optional verbs. */
function actionsOffering(offered: readonly (typeof EVERY_VERB)[number][] = EVERY_VERB) {
	const { calls, record } = spy();
	const actions: Record<string, unknown> = {
		toggleCompact: record("toggleCompact"),
		intent: record("intent"),
		setSearch: record("setSearch"),
		setSearchOpen: record("setSearchOpen"),
		sessionContextMenu: record("sessionContextMenu"),
	};
	for (const verb of offered) actions[verb] = record(verb);
	return { calls, actions };
}

async function mount(actions: Record<string, unknown>, query = "", spaceActions: readonly SpaceAction[] = []) {
	const snapshot = facts(query, spaceActions);
	const rail = { subscribe: () => () => {}, getSnapshot: () => snapshot };
	const root = createRoot(container);
	roots.push(root);
	await act(async () =>
		root.render(createElement(ChatRail, { rail, actions, capabilities: { agents: [{ name: "aether" }] } })),
	);
}

const click = async (el: Element | null | undefined) => {
	if (!el) throw new Error("nothing to click");
	await act(async () => {
		el.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));
	});
};

const contextMenu = async (el: Element | null | undefined) => {
	if (!el) throw new Error("nothing to right-click");
	const event = new (globalThis as unknown as { Event: typeof Event }).Event("contextmenu", {
		bubbles: true,
		cancelable: true,
	});
	// A pointer at (40, 60), as a browser's contextmenu event carries.
	Object.assign(event, { clientX: 40, clientY: 60 });
	await act(async () => {
		el.dispatchEvent(event);
	});
};

const titles = (root: ParentNode = container) => [...root.querySelectorAll(".er-title")].map(el => el.textContent);
const menuItems = () =>
	[...(globalThis as unknown as { document: Document }).document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map(
		el => el.textContent?.trim(),
	);
const rowNamed = (title: string) =>
	[...container.querySelectorAll('[data-slot="chat-session"]')].find(el => el.querySelector(".er-title")?.textContent === title);

// ── Contracts ────────────────────────────────────────────────────────────────

describe("which sessions the rail draws", () => {
	test("only this desk's, newest first — nothing else ever reaches the kit", async () => {
		rootRows = [
			session("old", "Old one", 90),
			session("new", "New one", 2),
			session("code", "A coding session", 1, { space: "code", ref: { workspaceId: "some-repo", sessionId: "code" } }),
			session("bubble", "From the bubble", 4, { space: "code" }),
			session("repo", "Unstamped repo session", 3, { ref: { workspaceId: "some-repo", sessionId: "repo" } }),
			session("mine", "Stamped for Chat", 5, { space: "chat", ref: { workspaceId: "elsewhere", sessionId: "mine" } }),
		];
		await mount(actionsOffering().actions);

		expect(titles()).toEqual(["New one", "From the bubble", "Stamped for Chat", "Old one"]);
		expect(kitInputs.at(-1)?.map(row => row.ref.sessionId)).toEqual(["old", "new", "bubble", "mine"]);
	});

	test("an archived session is not listed", async () => {
		rootRows = [session("live", "Live", 2), session("gone", "Archived", 1, { archivedAt: iso(0) })];
		await mount(actionsOffering().actions);
		expect(titles()).toEqual(["Live"]);
	});

	test("the host's search box filters the rows", async () => {
		rootRows = [session("a", "Plan the Lisbon trip", 2), session("b", "Quarterly taxes", 1)];
		await mount(actionsOffering().actions, "lisbon");
		expect(titles()).toEqual(["Plan the Lisbon trip"]);
	});

	test("clicking a row opens that session through the host", async () => {
		rootRows = [session("a", "First", 2)];
		const { actions, calls } = actionsOffering();
		await mount(actions);
		await click(container.querySelector(".er-row-main"));
		expect(calls.selectSession).toHaveLength(1);
		expect((calls.selectSession?.[0]?.[0] as { sessionRef: { sessionId: string } }).sessionRef.sessionId).toBe("a");
	});
});

describe("a verb the host does not offer is a control that does not exist", () => {
	test("no New session button without newSession or newSessionAs", async () => {
		await mount(actionsOffering([]).actions);
		expect(container.querySelector('[aria-label="New session"]')).toBeNull();
	});

	test("New session mints through the host, navigate-then-mint", async () => {
		const { actions, calls } = actionsOffering();
		await mount(actions);
		await click(container.querySelector('[aria-label="New session"]'));
		expect(calls.intent).toEqual([[{ t: "create" }]]);
		expect(calls.newSession).toHaveLength(1);
	});

	test("a host offering only the named form is asked for the space's agent", async () => {
		const { calls, record } = spy();
		await mount({
			toggleCompact: record("toggleCompact"),
			intent: record("intent"),
			setSearch: record("setSearch"),
			setSearchOpen: record("setSearchOpen"),
			sessionContextMenu: record("sessionContextMenu"),
			newSessionAs: record("newSessionAs"),
		});
		await click(container.querySelector('[aria-label="New session"]'));
		expect(calls.newSessionAs).toEqual([["aether"]]);
	});

	test("the row menu offers Rename and Archive only when the host does", async () => {
		rootRows = [session("a", "First", 2)];
		await mount(actionsOffering(["selectSession"]).actions);
		await contextMenu(container.querySelector(".er-row-main"));
		expect(menuItems()).not.toContain("Rename");
		expect(menuItems()).not.toContain("Archive");
		// What the pack itself provides stays.
		expect(menuItems()).toContain("New collection…");
	});

	test("with Rename and Archive offered, Archive hands the host the row", async () => {
		rootRows = [session("a", "First", 2)];
		const { actions, calls } = actionsOffering();
		await mount(actions);
		await contextMenu(container.querySelector(".er-row-main"));
		expect(menuItems()).toEqual(expect.arrayContaining(["Rename", "Archive", "More actions"]));
		const archive = [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].find(
			el => el.textContent?.trim() === "Archive",
		);
		await click(archive);
		expect((calls.archiveSessions?.[0]?.[0] as unknown[]).length).toBe(1);
		expect(document.querySelector('[role="menu"]')).toBeNull();
	});
});

describe("collections", () => {
	test("filing a session moves its row at once; deleting the collection returns it to Unfiled", async () => {
		rootRows = [session("a", "Lisbon plans", 2), session("b", "Taxes", 1)];
		await mount(actionsOffering().actions);
		expect(container.querySelector('[data-slot="chat-collection"]')).toBeNull();

		const trips = await act(async () => collectionsStore.create("Trips"));
		await act(async () => {
			collectionsStore.assign("a", trips.id);
		});

		const groups = [...container.querySelectorAll('[data-slot="chat-collection"]')];
		expect(groups).toHaveLength(2);
		expect(groups[0]?.querySelector(".er-section-name")?.textContent).toBe("Trips");
		expect(titles(groups[0] as unknown as ParentNode)).toEqual(["Lisbon plans"]);
		expect(groups[1]?.querySelector(".er-section-name")?.textContent).toBe("Unfiled");
		expect(titles(groups[1] as unknown as ParentNode)).toEqual(["Taxes"]);

		await act(async () => {
			collectionsStore.remove(trips.id);
		});
		expect(container.querySelector('[data-slot="chat-collection"]')).toBeNull();
		expect(titles()).toEqual(["Taxes", "Lisbon plans"]);
	});

	test("the row menu files a session into a collection, and it lands there", async () => {
		rootRows = [session("a", "Lisbon plans", 2), session("b", "Taxes", 1)];
		const trips = collectionsStore.create("Trips");
		await mount(actionsOffering().actions);

		await contextMenu(rowNamed("Lisbon plans")?.querySelector(".er-row-main"));
		const choice = [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].find(
			el => el.textContent?.trim() === "Trips",
		);
		await click(choice);

		expect(collectionsStore.collectionOf("a")).toBe(trips.id);
		const group = container.querySelector(`[data-collection="${trips.id}"]`);
		expect(titles(group as unknown as ParentNode)).toEqual(["Lisbon plans"]);
		expect(document.querySelector('[role="menu"]')).toBeNull();
	});
});

describe("the space's own rail entries", () => {
	const NEW_SESSION: SpaceAction = { id: "new-session", label: "New session", target: "new-session" };
	const FACE: SpaceAction = { id: "face", label: "Face to face", target: "surface" };

	test("an entry the space declares is drawn; New session is not drawn twice", async () => {
		await mount(actionsOffering().actions, "", [NEW_SESSION, FACE]);
		const drawn = [...container.querySelectorAll('[data-slot="rail-actions"] [data-action]')].map(el => el.getAttribute("data-action"));
		expect(drawn).toEqual(["face"]);
	});

	test("a space that declares only New session draws no strip at all", async () => {
		await mount(actionsOffering().actions, "", [NEW_SESSION]);
		expect(container.querySelector('[data-slot="rail-actions"]')).toBeNull();
	});
});
