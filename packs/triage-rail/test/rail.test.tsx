/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the strip shouts about nothing
 *  (or stays silent about a session parked on you), or Sweep archives rows the
 *  user never confirmed — it must hand the host EXACTLY the confirmed
 *  candidates, and on a host without the bulk verb it must not exist at all
 *  (a dead control is worse than no control).
 *
 *  Model rules live in `model.test.ts`; this file defends the WIRING between
 *  the fold and the three channels, which no pure test can see. */
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, createElement, type ReactNode, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

// ── The granted parts, replaced by stand-ins ─────────────────────────────────

const passthrough = ({ children }: { readonly children?: ReactNode }) => createElement("span", null, children);
/** Every row renders one dot, so this counts ROW RENDERS — the only way a test
 *  can see `memo(Row)` being defeated. */
let dotRenders = 0;
/** How often the stand-in for the kit's granted mark was mounted per session (drawn or not). */
const markCalls: Record<string, number> = {};
mock.module("@fraym/ui", () => ({
	ActivityDot: ({ state }: { readonly state: string }) => {
		dotRenders += 1;
		return createElement("i", { "data-dot": state });
	},
	Button: ({ children, onClick, ...rest }: { readonly children?: ReactNode; readonly onClick?: () => void }) =>
		createElement("button", { type: "button", onClick, ...rest }, children),
	Icon: () => null,
	IconButton: ({ children, onClick, ...rest }: { readonly children?: ReactNode; readonly onClick?: () => void }) =>
		createElement("button", { type: "button", onClick, ...rest }, children),
	Input: (props: Record<string, unknown>) => createElement("input", props),
	Tooltip: passthrough,
	TooltipContent: () => null,
	TooltipProvider: passthrough,
	TooltipTrigger: passthrough,
	useObservable: (source: { subscribe: (fn: () => void) => () => void; getSnapshot: () => unknown }) =>
		useSyncExternalStore(source.subscribe, source.getSnapshot),
	// The kit's granted mark: the pack hands it the row's summary and identity and nothing else, and the mark itself decides
	// whether to draw (nothing without an unplayed message). `markCalls` counts mounts of the component, drawn or not.
	VoicemailMark: (props: {
		readonly sessionId: string;
		readonly title: string;
		readonly agent?: string;
		readonly voicemail?: { readonly unplayed: number; readonly needsYou?: true };
		readonly className?: string;
	}) => {
		markCalls[props.sessionId] = (markCalls[props.sessionId] ?? 0) + 1;
		if (!props.voicemail || props.voicemail.unplayed <= 0) return null;
		return createElement("i", {
			"data-voicemail-mark": props.sessionId,
			"data-title": props.title,
			"data-agent": props.agent,
			"data-needs-you": props.voicemail?.needsYou ? "" : undefined,
			className: props.className,
		});
	},
}));

const TriageRail = (await import("../src/index")).default;

// ── DOM harness ──────────────────────────────────────────────────────────────

const globalNames = ["window", "document", "navigator", "HTMLElement", "Element", "Event", "IS_REACT_ACT_ENVIRONMENT"] as const;
type DomGlobal = (typeof globalNames)[number];
let originalGlobals: Record<DomGlobal, PropertyDescriptor | undefined> | undefined;
let container: HTMLElement;
const roots: Root[] = [];

beforeEach(() => {
	dotRenders = 0;
	for (const key of Object.keys(markCalls)) delete markCalls[key];
	// The component folds with the real clock, so the clock is a fixture too:
	// mid-afternoon keeps "an hour ago" inside today, at any hour CI runs.
	setSystemTime(new Date(2026, 8, 18, 15, 0, 0));
	const { window } = parseHTML('<html><head></head><body><div id="root"></div></body></html>');
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
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	container = window.document.getElementById("root") as unknown as HTMLElement;
});

afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	for (const name of globalNames) {
		const descriptor = originalGlobals?.[name];
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalGlobals = undefined;
	setSystemTime();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = (ago: number) => new Date(Date.now() - ago).toISOString();

interface Row {
	readonly id: string;
	readonly title: string;
	readonly status: string;
	readonly time: string;
	readonly updatedAt: string;
	readonly sessionRef?: { readonly workspaceId: string; readonly sessionId: string };
	readonly profile?: string;
	readonly voicemail?: { readonly unplayed: number; readonly newestAt: number; readonly needsYou?: true };
}

function row(id: string, status: string, ago: number, addressable = true): Row {
	return {
		id,
		title: `title ${id}`,
		status,
		time: "·",
		updatedAt: iso(ago),
		sessionRef: addressable ? { workspaceId: "w", sessionId: id } : undefined,
	};
}

function facts(rows: readonly Row[]) {
	return {
		identity: { version: "0.0.0", productLabel: "Test", userName: "tester", planLabel: "dev" },
		mode: { app: "code", rail: "expanded", activeSurface: "session" },
		sessions: [{ repo: "app", branch: "main", dot: "", items: rows }],
		projectLabel: "Projects",
		search: { open: false, value: "" },
	};
}

function actionsWith(extra: Record<string, unknown> = {}) {
	const calls: Record<string, unknown[][]> = {};
	const spy = (name: string) => (...args: unknown[]) => {
		(calls[name] ??= []).push(args);
	};
	return {
		calls,
		actions: {
			toggleCompact: spy("toggleCompact"),
			intent: spy("intent"),
			setSearch: spy("setSearch"),
			setSearchOpen: spy("setSearchOpen"),
			openUserMenu: spy("openUserMenu"),
			sessionContextMenu: spy("sessionContextMenu"),
			selectSession: spy("selectSession"),
			...extra,
		},
	};
}

async function mount(rows: readonly Row[], actions: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	const snapshot = { ...facts(rows), ...extra };
	const rail = { subscribe: () => () => {}, getSnapshot: () => snapshot };
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(createElement(TriageRail, { rail, actions, capabilities: {} })));
}

/** The rail's own minute tick, captured instead of waited on: the interval is
 *  the component's, and a test that slept 60 s would be a test nobody runs. */
async function withCapturedTick(body: (tick: () => Promise<void>) => Promise<void>) {
	const realSet = globalThis.setInterval;
	const realClear = globalThis.clearInterval;
	const pending: Array<() => void> = [];
	globalThis.setInterval = ((fn: () => void) => pending.push(fn)) as unknown as typeof globalThis.setInterval;
	globalThis.clearInterval = (() => {}) as typeof globalThis.clearInterval;
	try {
		await body(async () => {
			await act(async () => {
				for (const fn of pending) fn();
			});
		});
	} finally {
		globalThis.setInterval = realSet;
		globalThis.clearInterval = realClear;
	}
}

const click = async (el: Element | null | undefined) => {
	if (!el) throw new Error("nothing to click");
	await act(async () => {
		el.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("click", { bubbles: true }));
	});
};

const titles = (scope: string) =>
	[...container.querySelectorAll(`${scope} .tr-row-title`)].map(el => el.textContent);

// ── Contracts ────────────────────────────────────────────────────────────────

describe("the needs-you strip", () => {
	test("lists every needs-you row oldest wait first, and is absent when nothing needs you", async () => {
		const { actions } = actionsWith();
		await mount(
			[row("quiet", "idle", HOUR), row("recent", "failed", HOUR), row("old", "needs-you", 3 * HOUR)],
			actions,
		);
		expect(titles('[data-slot="triage-needs-you"]')).toEqual(["title old", "title recent"]);
		// A strip is a view: the rows still sit in their buckets (a needs-you row is live ⇒ Now).
		expect(titles('[data-bucket="now"]')).toEqual(["title old"]);
		expect(titles('[data-bucket="today"]')).toEqual(["title quiet", "title recent"]);
	});

	test("an unread row is emphasised and counts as needing you", async () => {
		const { actions } = actionsWith();
		await mount([{ ...row("mail", "idle", HOUR), unread: true }, row("seen", "idle", HOUR)], actions);
		expect(titles('[data-slot="triage-needs-you"]')).toEqual(["title mail"]);
		const emphasised = [...container.querySelectorAll(".tr-row[data-unread] .tr-row-title")].map(el => el.textContent);
		expect(emphasised).toEqual(["title mail", "title mail"]);
	});

	test("is not rendered at all when nothing needs you", async () => {
		const { actions } = actionsWith();
		await mount([row("quiet", "idle", HOUR)], actions);
		expect(container.querySelector('[data-slot="triage-needs-you"]')).toBeNull();
	});
});

describe("Sweep", () => {
	const stale = [row("a", "idle", 9 * DAY), row("b", "attached", 30 * DAY), row("keep", "idle", 8 * DAY, false)];
	const sweepButton = () =>
		[...container.querySelectorAll('[data-bucket="earlier"] button')].find(b => b.textContent?.includes("Sweep"));
	const confirmButton = () =>
		[...container.querySelectorAll(".tr-sweep-card button")].find(b => /^Archive/.test(b.textContent ?? ""));

	test("with the bulk verb: nothing is archived until confirmed, then exactly the candidates go to the host", async () => {
		const { actions, calls } = actionsWith({ archiveSessions: (...args: unknown[]) => (calls.archiveSessions ??= []).push(args) });
		await mount(stale, actions);
		expect(sweepButton()?.textContent).toContain("Sweep · 2");
		await click(sweepButton());
		expect(calls.archiveSessions).toBeUndefined();
		await click(confirmButton());
		expect(calls.archiveSessions).toHaveLength(1);
		expect((calls.archiveSessions?.[0]?.[0] as readonly Row[]).map(r => r.id)).toEqual(["a", "b"]);
	});

	test("without the bulk verb the affordance is hidden, even with candidates", async () => {
		const { actions } = actionsWith();
		await mount(stale, actions);
		expect(sweepButton()).toBeUndefined();
		expect(container.querySelector(".tr-sweep-card")).toBeNull();
	});

	test("is hidden when no row is old enough", async () => {
		const { actions } = actionsWith({ archiveSessions: () => {} });
		await mount([row("fresh", "idle", 2 * DAY)], actions);
		expect(sweepButton()).toBeUndefined();
	});
});

describe("the minute tick", () => {
	test("re-renders no row when only the clock moved", async () => {
		const { actions } = actionsWith();
		await withCapturedTick(async tick => {
			await mount([row("a", "idle", HOUR), row("b", "idle", 2 * HOUR), row("c", "idle", 3 * DAY)], actions);
			const mounted = dotRenders;
			expect(mounted).toBe(3);
			setSystemTime(new Date(Date.now() + 60_000));
			await tick();
			// A re-fold would hand every row a fresh wrapper and reconcile the
			// whole rail once a minute on a home with hundreds of sessions.
			expect(dotRenders).toBe(mounted);
		});
	});

	test("still moves the strip's wait caption", async () => {
		const { actions } = actionsWith();
		await withCapturedTick(async tick => {
			await mount([row("wait", "needs-you", 30 * 60_000)], actions);
			expect(container.querySelector('[data-slot="triage-needs-you"] .tr-row-time')?.textContent).toBe("30m");
			setSystemTime(new Date(Date.now() + 10 * 60_000));
			await tick();
			expect(container.querySelector('[data-slot="triage-needs-you"] .tr-row-time')?.textContent).toBe("40m");
		});
	});
});

describe("the empty card", () => {
	test("never renders under a populated strip", async () => {
		const { actions } = actionsWith();
		const parked = row("parked", "needs-you", 2 * DAY);
		await mount([], actions, { triage: [parked], search: { open: true, value: "zzz" } });
		expect(titles('[data-slot="triage-needs-you"]')).toEqual(["title parked"]);
		expect(container.querySelector(".tr-empty")).toBeNull();
	});

	test("still names an empty rail when nothing needs you either", async () => {
		const { actions } = actionsWith();
		await mount([], actions);
		expect(container.querySelector(".tr-empty strong")?.textContent).toBe("Nothing to triage");
	});
});

describe("the voice message mark", () => {
	const mark = (id: string) => container.querySelector(`[data-voicemail-mark="${id}"]`);
	const mailRow = (id: string, over: Partial<Row> = {}): Row => ({
		...row(id, "idle", HOUR),
		voicemail: { unplayed: 1, newestAt: 1 },
		profile: "mochi",
		...over,
	});

	test("a row holding a message draws the kit's mark beside its row button; every addressable row sits in the same holder", async () => {
		const { actions } = actionsWith();
		await mount([mailRow("a"), mailRow("c", { voicemail: { unplayed: 2, newestAt: 1, needsYou: true } }), row("b", "idle", HOUR)], actions);

		expect(mark("a")).not.toBeNull();
		expect(mark("b")).toBeNull();
		// A button in a button is invalid HTML: the mark and the row button are siblings in one holder.
		expect(mark("a")?.closest(".tr-row")).toBeNull();
		const holder = mark("a")?.closest(".tr-row-holder");
		expect(holder?.querySelector(":scope > .tr-row")?.getAttribute("data-session-id")).toBe("a");
		// The width the row gives up is keyed (in the stylesheet) on the mark actually being drawn as a direct child of the holder.
		expect(holder?.querySelector(":scope > .tr-mail")).not.toBeNull();
		// A bare row has the same holder (so the tree never changes shape when a message arrives) but is not marked as holding one.
		const bare = container.querySelector('[data-session-id="b"]')?.closest(".tr-row-holder");
		expect(bare).not.toBeNull();
		expect(bare?.querySelector(":scope > .tr-mail")).toBeNull();
		// The mark is handed every addressable row, drawn or not: it decides, and must stay up under its open popover.
		expect(markCalls.b).toBeGreaterThan(0);
		// It is handed the row's identity, and the plain/needs-you distinction survives the pack.
		expect(mark("a")?.getAttribute("data-title")).toBe("title a");
		expect(mark("a")?.getAttribute("data-agent")).toBe("mochi");
		expect(mark("a")?.hasAttribute("data-needs-you")).toBe(false);
		expect(mark("c")?.hasAttribute("data-needs-you")).toBe(true);
	});

	test("a message arriving does not remount the row button", async () => {
		const { actions } = actionsWith();
		let snapshot = facts([row("a", "idle", HOUR)]);
		const listeners = new Set<() => void>();
		const rail = {
			subscribe: (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn)),
			getSnapshot: () => snapshot,
		};
		const root = createRoot(container);
		roots.push(root);
		await act(async () => root.render(createElement(TriageRail, { rail, actions, capabilities: {} })));
		const before = container.querySelector('[data-session-id="a"]');
		expect(before).not.toBeNull();

		snapshot = facts([mailRow("a")]);
		await act(async () => {
			for (const fn of listeners) fn();
		});
		// The same DOM node: a holder that came and went with the summary would have replaced it (and its focus and hover).
		expect(container.querySelector('[data-session-id="a"]')).toBe(before);
		expect(mark("a")).not.toBeNull();
	});

	test("a drained stack, or a row the host cannot address, draws no mark", async () => {
		const { actions } = actionsWith();
		await mount(
			[mailRow("drained", { voicemail: { unplayed: 0, newestAt: 1 } }), mailRow("nowhere", { sessionRef: undefined })],
			actions,
		);
		expect(container.querySelector("[data-voicemail-mark]")).toBeNull();
	});
});
