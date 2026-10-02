/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a person cannot tell from the
 *  toolbar which profile their browser is on (or is shown its folder name, or
 *  "Private" for a saved profile); the profile menu offers a profile another
 *  chat holds as if it were free, or lists the browser they are in as another
 *  one to open; switching profile opens the wrong profile, closes the browser
 *  they left, or swallows the reason it could not open; Private browser opens a
 *  saved profile; Add profile sends a name the runtime will refuse (or one that
 *  is already taken) or leaves the person on the old profile after making the
 *  new one; a person cannot take the wheel from a working agent, or can while a
 *  task is running or a post awaits their confirmation; or the start page and
 *  the menu stop being the same list of profiles.
 *
 *  The View is mounted live on a linkedom document (`dom-harness.ts`) against a
 *  fake MCP App host whose `callServerTool` records every browser tool call:
 *  `browser_profiles` answers a listing the test can change, `browser_stream`
 *  never answers (the state a View mounts with is the state it shows, until a
 *  tool answer replaces it), and the rest is the test's to answer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ReactNode } from "react";
import type { BrowserState, OpenBrowserListing, ProfileListing, PublishRecord, TaskRun } from "../src/contracts";
import { BrowserApp } from "../app/view/browser-app";
import { defaultColour, PROFILE_COLOURS } from "../src/profile-meta";
import { DEFAULT_PROFILE } from "../src/profile-name";
import { type Dom, mount, unmountAll } from "./dom-harness";

afterEach(unmountAll);

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

interface Call {
	readonly name: string;
	readonly args: Record<string, unknown>;
}

interface Host {
	readonly app: App;
	readonly calls: Call[];
	/** What `browser_profiles` answers now; a test changes it between two opens of the menu. */
	profiles: ProfileListing[];
	/** The browsers this chat holds that are not profiles, as `browser_profiles` lists them for the View. */
	browsers: OpenBrowserListing[];
}

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });
const answer = (structuredContent: object): CallToolResult => ({ content: [], structuredContent: { ...structuredContent } });

/** A host that answers `browser_profiles` with `host.profiles`, never answers `browser_stream`, records every call, and lets `respond` decide the rest. */
function fakeHost(profiles: ProfileListing[], respond: (call: Call) => CallToolResult = call => failure(`unexpected ${call.name}`)): Host {
	const calls: Call[] = [];
	const host: Host = {
		calls,
		profiles,
		browsers: [],
		// The View touches exactly these three App members; the rest of the host surface is not in play.
		app: {
			callServerTool: async (request: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult> => {
				const call = { name: request.name, args: request.arguments ?? {} };
				calls.push(call);
				if (call.name === "browser_stream") return await new Promise<CallToolResult>(() => {});
				return call.name === "browser_profiles" ? answer({ profiles: host.profiles, browsers: host.browsers }) : respond(call);
			},
			getHostCapabilities: () => ({ updateModelContext: { text: {}, image: {} } }),
			updateModelContext: async () => ({}),
		} as unknown as App,
	};
	return host;
}

const callsTo = (host: Host, name: string) => host.calls.filter(call => call.name === name).map(call => call.args);

// ---------------------------------------------------------------------------
// What the runtime would say
// ---------------------------------------------------------------------------

const SEEN = "2026-10-01T09:00:00.000Z";
const site = (host: string, signedIn: boolean | null = true) => ({ site: host, signedIn, seenAt: SEEN });
/** A profile as the runtime lists it. One this chat holds carries the id of its browser, as the runtime hands it to the View. */
const listing = (name: string, label: string, over: Partial<ProfileListing> = {}): ProfileListing => {
	const made: ProfileListing = { name, label, colour: "blue", heldBy: null, sites: [], ...over };
	return made.heldBy === "this chat" && made.browserId === undefined ? { ...made, browserId: `b-${name}` } : made;
};
const HELD_HERE = { heldBy: "this chat" } as const;
const hold = (by: "person" | "agent", task = false, takenOver = false, post = false) => ({ ...HELD_HERE, hold: { by, task, takenOver, post } });

const WORK = listing("work", "Work account", { colour: "teal", avatar: "💼", ...hold("person"), sites: [site("google.com"), site("x.com"), site("github.com")] });
/** As the runtime lists them, by folder name. The folder names run backwards against the labels, so a list shown in this order (or sorted by folder name) cannot pass for one sorted by label. The implicit Default is not in it. */
const BANK = listing("z-bank", "Bank", { colour: "green", sites: [site("chase.com"), site("mint.com", false), site("paypal.com", null)] });
const SHELF: ProfileListing[] = [
	listing("t-travel", "Travel", { heldBy: "human" }),
	listing("u-studio", "Studio", { heldBy: "another chat" }),
	listing("v-stream", "Streaming", { ...hold("person", false, true) }),
	listing("w-research", "Research", { colour: "pink", ...hold("agent", true) }),
	WORK,
	listing("x-gaming", "Gaming", { colour: "purple", ...hold("agent") }),
	listing("y-family", "Family", { colour: "orange", avatar: "🏠", ...hold("person") }),
	BANK,
];
/** The menu's rows while Work account is the profile on screen: what each says, and whether it can be pressed. */
const ROWS_BESIDE_WORK: Array<[text: string, disabled: boolean]> = [
	["DDefaultNo sign-ins yet", false],
	["BBankSigned in to chase.com", false],
	["🏠FamilyOpen here", false],
	["GGamingYour agent has it open", false],
	["RResearchAn agent task is running", false],
	["SStreamingYou have control", false],
	["SStudioIn use by another chat", true],
	["TTravelOpen in another chat", true],
];

const TAKEN_SENTENCE = "That browser is already open. Use it, or open a Private one.";
/** The runtime's refusal of a profile someone else holds, verbatim (`profile_held`). */
const HELD_TEXT = `profile "z-bank" is already open, held by another chat. Ask the human to close it, or use another profile.`;

/** A browser as the runtime describes it. */
function browserOf(browserId: string, profile: ProfileListing | null, over: Partial<BrowserState> = {}): BrowserState {
	return {
		browserId,
		profile: profile?.name ?? null,
		look: profile === null ? null : { label: profile.label, colour: profile.colour, ...(profile.avatar === undefined ? {} : { avatar: profile.avatar }) },
		engine: "chromium",
		app: "chrome",
		url: "https://example.com/",
		title: "Example",
		revision: 1,
		viewport: { width: 1280, height: 800 },
		task: null,
		tabs: [{ id: "t1", title: "Example", url: "https://example.com/", active: true, loading: false, favicon: null }],
		activeTabId: "t1",
		loading: false,
		canGoBack: false,
		canGoForward: false,
		publish: null,
		dialogs: [],
		takenOver: false,
		agentActionAt: null,
		...over,
	};
}
const WORK_BROWSER = browserOf("b1", WORK);

const RUNNING: TaskRun = {
	id: "task-1",
	agent: "jev",
	task: "Find the cheapest flight",
	status: "running",
	summary: "",
	steps: [{ n: 1, action: "Click Search", url: "https://example.com/", elapsedMs: 900 }],
	stepCount: 1,
	startedAt: new Date().toISOString(),
	elapsedMs: 900,
	usage: { modelCalls: 1, inputTokens: 120, outputTokens: 30, costUsd: null },
};
const AWAITING: PublishRecord = {
	publishId: "pub-1",
	status: "awaiting-confirmation",
	origin: "https://x.com",
	composeUrl: "https://x.com/compose/post",
	tabId: "t1",
	profile: "work",
	fields: [{ selector: "textarea", value: "Hello world", label: "Post" }],
	createdAt: "2026-10-01T09:00:00.000Z",
	expiresAt: "2026-10-01T09:10:00.000Z",
};

// ---------------------------------------------------------------------------
// What a person sees and presses
// ---------------------------------------------------------------------------

const button = (dom: Dom, label: string): Element => {
	const found = dom.find("button").find(el => el.textContent?.trim().startsWith(label));
	if (!found) throw new Error(`no "${label}" button`);
	return found;
};
/** The profile chip: the one menu button that says something (the other, More, is only an icon). */
const chipOf = (dom: Dom): Element => {
	const found = dom.find('button[aria-haspopup="menu"]').find(el => (el.textContent ?? "").trim().length > 0);
	if (!found) throw new Error("no profile chip");
	return found;
};
const rowsOf = (dom: Dom) => dom.find('[role="menuitemradio"]');
/** A row the person cannot open is still on the keyboard's path (so its reason is read out), marked `aria-disabled`, never `disabled`. */
const cannotOpen = (row: Element): boolean => row.getAttribute("aria-disabled") === "true";
const rowFor = (dom: Dom, label: string): Element => {
	const found = rowsOf(dom).find(el => el.textContent?.includes(label));
	if (!found) throw new Error(`no "${label}" row`);
	return found;
};
const alerts = (dom: Dom) => dom.find('[role="alert"]').map(el => el.textContent);
const menuIsOpen = (dom: Dom) => dom.find('[role="menu"], [role="dialog"]').length > 0;

const openMenu = async (dom: Dom) => {
	await dom.click(chipOf(dom));
	await dom.settle();
};

/** Take over / Hand back buttons on the page (the floating pill) or in the open menu. */
const controls = (dom: Dom, where: "page" | "menu"): string[] =>
	dom
		.find("button")
		.filter(el => (el.closest('[role="menu"]') !== null) === (where === "menu"))
		.map(el => el.textContent?.trim() ?? "")
		.filter(label => label === "Take over" || label === "Hand back");

/** linkedom has no `document.hasFocus`, which the post-confirmation bar asks when it appears: this document says its window has no focus. */
function Unfocused({ children }: { readonly children: ReactNode }) {
	Object.assign(document, { hasFocus: () => false });
	return children;
}

async function mountView(host: Host, state: BrowserState | null): Promise<Dom> {
	const dom = await mount(
		<Unfocused>
			<BrowserApp app={host.app} toolState={state === null ? null : { state, seq: 1 }} />
		</Unfocused>,
	);
	await dom.settle();
	return dom;
}

// ---------------------------------------------------------------------------
// The chip
// ---------------------------------------------------------------------------

describe("the profile chip", () => {
	const rows: ReadonlyArray<{ readonly name: string; readonly state: BrowserState; readonly chip: string }> = [
		{ name: "a saved profile shows the label and avatar its state carries, not its folder name", state: WORK_BROWSER, chip: "💼Work account" },
		{ name: "a saved profile with no avatar shows the first letter of its label", state: browserOf("b1", listing("acme-1", "Acme Ltd", { colour: "blue" })), chip: "AAcme Ltd" },
		{ name: "a throwaway browser is Private", state: browserOf("b1", null), chip: "Private" },
		{ name: "the person's own Chrome is Your Chrome", state: { ...browserOf("b1", null), profile: "relay", engine: "chrome-relay", app: null }, chip: "Your Chrome" },
	];
	for (const { name, state, chip } of rows) {
		test(`${name}, and drawing it asks the runtime for nothing`, async () => {
			const host = fakeHost(SHELF);
			const dom = await mountView(host, state);

			expect(chipOf(dom).textContent).toContain(chip);
			expect(callsTo(host, "browser_profiles")).toEqual([]);
		});
	}
});

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

describe("the profile menu", () => {
	test("lists the other profiles — Default first, then by label — with where each is signed in and who has it, and the ones held elsewhere cannot be pressed", async () => {
		const host = fakeHost(SHELF);
		const dom = await mountView(host, WORK_BROWSER);
		await openMenu(dom);

		// The current profile is the header: its label and where it is signed in (two sites named, the rest counted; a signed-out or unchecked site is not a sign-in).
		expect(dom.find('[aria-current="true"]').map(el => el.textContent)).toEqual(["💼Work accountSigned in to google.com, x.com +1"]);
		// Each row: the avatar, the label (never the folder name), what is known of it, and whether it can be pressed.
		expect(rowsOf(dom).map(el => [el.textContent, cannotOpen(el)])).toEqual(ROWS_BESIDE_WORK);
	});

	test("reads the profiles each time it opens, so who has a profile is never older than the last look", async () => {
		const host = fakeHost(SHELF);
		const dom = await mountView(host, WORK_BROWSER);
		expect(callsTo(host, "browser_profiles")).toHaveLength(0);

		await openMenu(dom);
		expect(callsTo(host, "browser_profiles")).toHaveLength(1);
		expect(cannotOpen(rowFor(dom, "Studio"))).toBe(true);

		// The other chat lets go of Studio while the menu is shut.
		await dom.click(chipOf(dom));
		host.profiles = SHELF.map(profile => (profile.name === "u-studio" ? { ...profile, heldBy: null } : profile));
		await openMenu(dom);

		expect(callsTo(host, "browser_profiles")).toHaveLength(2);
		expect(rowFor(dom, "Studio").textContent).toBe("SStudioNo sign-ins yet");
		expect(cannotOpen(rowFor(dom, "Studio"))).toBe(false);
	});

	test("Escape closes the Add profile form first, and the menu on the second press", async () => {
		const host = fakeHost(SHELF);
		const dom = await mountView(host, WORK_BROWSER);
		await openMenu(dom);
		await dom.click(button(dom, "Add profile"));

		// The keys are heard on the window, so any element that stays on the page can be where the key is pressed.
		await dom.key(chipOf(dom), "Escape");
		expect(dom.find('form[aria-label="New profile"]')).toHaveLength(0);
		expect(dom.find('[role="menu"]')).toHaveLength(1);

		await dom.key(chipOf(dom), "Escape");
		expect(menuIsOpen(dom)).toBe(false);
	});

	// linkedom's `focus()` only fires an event and it has no `activeElement`: the tests read what the menu moved focus to, in order, from the calls.
	const focusWhileOpening = async (dom: Dom): Promise<string[]> => {
		const focused: Element[] = [];
		Object.assign(HTMLElement.prototype, { focus(this: Element) { focused.push(this); } });
		Object.defineProperty(document, "activeElement", { configurable: true, get: () => focused.at(-1) ?? null });
		await openMenu(dom);
		return focused.map(el => el.textContent?.trim() ?? "");
	};

	test("focus lands on the first profile that can be opened, so Enter pressed straight after opening opens a profile; the first time the list is still loading and focus never rests on Take over meanwhile", async () => {
		const dom = await mountView(fakeHost(SHELF), browserOf("b1", WORK, { agentActionAt: Date.now() - 2_000 }));

		const first = await focusWhileOpening(dom);
		expect(first).not.toContain("Take over");
		expect(first.at(-1)).toBe("DDefaultNo sign-ins yet");

		// Opened again, the list is already there: focus goes straight to it.
		await dom.click(chipOf(dom));
		expect(await focusWhileOpening(dom)).toEqual(["DDefaultNo sign-ins yet"]);
	});

	for (const { name, shelf } of [
		{ name: "there is no other profile", shelf: [] },
		{ name: "every other profile is held elsewhere", shelf: [listing("t-travel", "Travel", { heldBy: "human" }), listing("u-studio", "Studio", { heldBy: "another chat" })] },
	]) {
		test(`focus lands on Add profile, never on Take over, with an agent acting and the control row on top, when ${name}`, async () => {
			const dom = await mountView(fakeHost(shelf), browserOf("b1", listing(DEFAULT_PROFILE, "Default"), { agentActionAt: Date.now() - 2_000 }));

			const focused = await focusWhileOpening(dom);

			// The agent is acting, so the menu does offer Take over, first in the list ...
			expect(controls(dom, "menu")).toEqual(["Take over"]);
			// ... and what Enter would press is Add profile.
			expect(focused).toEqual(["Add profile"]);
		});
	}
});

// ---------------------------------------------------------------------------
// Switching
// ---------------------------------------------------------------------------

describe("switching profile from the menu", () => {
	/** Work with its browser gone: what the runtime lists once it has closed what the person left. */
	const WORK_CLOSED = listing("work", "Work account", { colour: "teal", avatar: "💼", sites: WORK.sites });
	/** A runtime that opens Bank as `b2`, and whose `browser_leave` of Work closes it (so Work is free in the next listing). */
	const switching = (leave: () => CallToolResult = () => answer({ closed: true })): Host => {
		const host: Host = fakeHost(SHELF, call => {
			if (call.name === "browser_open") return answer(browserOf("b2", BANK));
			if (call.name === "browser_leave") {
				const result = leave();
				if (!result.isError) host.profiles = SHELF.map(profile => (profile.name === "work" ? WORK_CLOSED : profile));
				return result;
			}
			return failure(`unexpected ${call.name}`);
		});
		return host;
	};

	test("a free profile opens in this View with exactly that profile; once it is open the browser left is handed to browser_leave, and what the runtime closed is offered as a free profile again", async () => {
		const host = switching();
		const dom = await mountView(host, WORK_BROWSER);
		await openMenu(dom);

		await dom.click(rowFor(dom, "Bank"));
		await dom.settle();

		expect(callsTo(host, "browser_open")).toStrictEqual([{ engine: "chromium", profile: "z-bank" }]);
		expect(callsTo(host, "browser_leave")).toStrictEqual([{ browserId: "b1" }]);
		// Open first, so a refused open never leaves the person with no browser.
		expect(host.calls.map(call => call.name).filter(name => name === "browser_open" || name === "browser_leave")).toEqual(["browser_open", "browser_leave"]);
		expect(chipOf(dom).textContent?.trim()).toBe("BBank");
		expect(menuIsOpen(dom)).toBe(false);
		expect(callsTo(host, "browser_close")).toEqual([]);

		// Work was closed by the leave: the menu lists it as a free profile, and Bank (where they are) is the header.
		await openMenu(dom);
		expect(rowFor(dom, "Work account").textContent).toBe("💼Work accountSigned in to google.com, x.com +1");
		expect(rowsOf(dom).some(el => el.textContent?.includes("Bank"))).toBe(false);
		expect(dom.find('[aria-current="true"]')[0]?.textContent).toBe("BBankSigned in to chase.com");
	});

	test("a browser that could not be left is said once and the new one stays on screen", async () => {
		const host = switching(() => failure("could not close Work"));
		const dom = await mountView(host, WORK_BROWSER);
		await openMenu(dom);

		await dom.click(rowFor(dom, "Bank"));
		await dom.settle();

		expect(alerts(dom)).toEqual(["could not close Work"]);
		expect(chipOf(dom).textContent?.trim()).toBe("BBank");
	});

	test("a profile held elsewhere is listed but pressing it opens nothing", async () => {
		const host = fakeHost(SHELF, call => (call.name === "browser_open" ? answer(browserOf("b2", BANK)) : failure(`unexpected ${call.name}`)));
		const dom = await mountView(host, WORK_BROWSER);
		await openMenu(dom);

		await dom.click(rowFor(dom, "Studio"));
		await dom.click(rowFor(dom, "Travel"));
		await dom.settle();

		expect(callsTo(host, "browser_open")).toEqual([]);
		expect(chipOf(dom).textContent?.trim()).toBe("💼Work account");
	});

	test("a profile taken in the meantime keeps the current browser and says why, once, in plain words — or the runtime's own words when it is something else", async () => {
		let reason = HELD_TEXT;
		const host = fakeHost(SHELF, call => (call.name === "browser_open" ? failure(reason) : failure(`unexpected ${call.name}`)));
		const dom = await mountView(host, WORK_BROWSER);

		await openMenu(dom);
		await dom.click(rowFor(dom, "Bank"));
		await dom.settle();
		expect(alerts(dom)).toEqual([TAKEN_SENTENCE]);
		expect(chipOf(dom).textContent?.trim()).toBe("💼Work account");

		reason = "could not launch Chrome";
		await openMenu(dom);
		await dom.click(rowFor(dom, "Bank"));
		await dom.settle();
		expect(alerts(dom)).toEqual(["could not launch Chrome"]);
		expect(callsTo(host, "browser_open")).toStrictEqual([
			{ engine: "chromium", profile: "z-bank" },
			{ engine: "chromium", profile: "z-bank" },
		]);
		// The browser on screen was never left: the person is still in it.
		expect(callsTo(host, "browser_leave")).toEqual([]);
	});

	test("Private browser opens with no profile at all; it shows as Private, offers no second Private, and every saved profile is still there to open", async () => {
		const host: Host = fakeHost(SHELF, call => {
			if (call.name === "browser_open") return answer(browserOf("b2", null));
			if (call.name === "browser_leave") {
				host.profiles = SHELF.map(profile => (profile.name === "work" ? WORK_CLOSED : profile));
				return answer({ closed: true });
			}
			return failure(`unexpected ${call.name}`);
		});
		const dom = await mountView(host, WORK_BROWSER);
		await openMenu(dom);
		expect(dom.find('[role="menuitem"]').map(el => el.textContent?.trim())).toContain("Private browser");

		await dom.click(button(dom, "Private browser"));
		await dom.settle();

		// Strict: a `profile` key present with any value, even undefined, is not "no profile".
		expect(callsTo(host, "browser_open")).toStrictEqual([{ engine: "chromium" }]);
		expect(callsTo(host, "browser_leave")).toStrictEqual([{ browserId: "b1" }]);
		expect(chipOf(dom).textContent?.trim()).toBe("Private");
		expect(callsTo(host, "browser_close")).toEqual([]);

		await openMenu(dom);
		expect(dom.find('[role="menuitem"]').map(el => el.textContent?.trim())).not.toContain("Private browser");
		expect(dom.find('[aria-current="true"]')[0]?.textContent).toContain("Private");
		// The throwaway is not a profile: the rows are Default and the saved ones, the profile they just left among them (closed, so free).
		expect(rowsOf(dom).map(el => [el.textContent, cannotOpen(el)])).toEqual([...ROWS_BESIDE_WORK, ["💼Work accountSigned in to google.com, x.com +1", false]]);
	});
});

// ---------------------------------------------------------------------------
// Browsers left open
// ---------------------------------------------------------------------------

describe("browsers left open in the background", () => {
	/** The close buttons at the end of the menu's rows (the labels name the browser each closes; the tab strip's own close is not in the menu). */
	const closeButtons = (dom: Dom) => dom.find('[role="menu"] button[aria-label^="Close "]');
	const closeFor = (dom: Dom, label: string): Element => {
		const found = closeButtons(dom).find(el => el.getAttribute("aria-label") === `Close ${label}`);
		if (!found) throw new Error(`no "Close ${label}" button`);
		return found;
	};
	const PRIVATE_TASK = { browserId: "p1", kind: "private", hold: { by: "agent", task: true, takenOver: false, post: false } } as const;
	const CHROME_POST = { browserId: "c1", kind: "chrome", hold: { by: "person", task: false, takenOver: false, post: true } } as const;

	test("every row whose browser this chat holds has a close button, and a profile held elsewhere has none; a close asks for that browser, keeps the menu open, and the list is read again", async () => {
		const host: Host = fakeHost(SHELF, call => {
			if (call.name !== "browser_close") return failure(`unexpected ${call.name}`);
			host.profiles = host.profiles.map(profile => (profile.name === "x-gaming" ? listing("x-gaming", "Gaming", { colour: "purple" }) : profile));
			return answer({ closed: true });
		});
		const dom = await mountView(host, WORK_BROWSER);
		await openMenu(dom);
		expect(closeButtons(dom).map(el => el.getAttribute("aria-label"))).toEqual(["Close Family", "Close Gaming", "Close Research", "Close Streaming"]);
		const reads = callsTo(host, "browser_profiles").length;

		await dom.click(closeFor(dom, "Gaming"));
		await dom.settle();

		expect(callsTo(host, "browser_close")).toStrictEqual([{ browserId: "b-x-gaming" }]);
		expect(menuIsOpen(dom)).toBe(true);
		expect(callsTo(host, "browser_profiles")).toHaveLength(reads + 1);
		expect(rowFor(dom, "Gaming").textContent).toBe("GGamingNo sign-ins yet");
		expect(closeButtons(dom).map(el => el.getAttribute("aria-label"))).toEqual(["Close Family", "Close Research", "Close Streaming"]);
		// What was on screen was never closed.
		expect(callsTo(host, "browser_close").some(args => args.browserId === "b1")).toBe(false);
	});

	test("a browser that would not close says so, and its row stays", async () => {
		const host = fakeHost(SHELF, call => (call.name === "browser_close" ? failure("could not close Gaming") : failure(`unexpected ${call.name}`)));
		const dom = await mountView(host, WORK_BROWSER);
		await openMenu(dom);

		await dom.click(closeFor(dom, "Gaming"));
		await dom.settle();

		expect(alerts(dom)).toEqual(["could not close Gaming"]);
		expect(rowFor(dom, "Gaming").textContent).toBe("GGamingYour agent has it open");
	});

	test("a Private browser and Your Chrome left open are rows of their own — what each is doing, with a close — and the browser on screen is not among them; a post waiting is said in words", async () => {
		const host = fakeHost([...SHELF, listing("pub", "Pub", { ...hold("person", false, false, true) })]);
		host.browsers = [{ browserId: "b1", kind: "private", hold: { by: "person", task: false, takenOver: false, post: false } }, PRIVATE_TASK, CHROME_POST];
		const dom = await mountView(host, browserOf("b1", null));
		await openMenu(dom);

		// b1 is the Private browser on screen: it is the header, not a row.
		expect(rowsOf(dom).filter(el => /Private browser|Your Chrome/.test(el.textContent ?? "")).map(el => el.textContent)).toEqual(["Private browserAn agent task is running", "Your ChromeA post is waiting for you"]);
		expect(rowFor(dom, "Pub").textContent).toBe("PPubA post is waiting for you");
		expect(closeFor(dom, "Private browser")).toBeDefined();
		expect(closeFor(dom, "Your Chrome")).toBeDefined();

		await dom.click(closeFor(dom, "Your Chrome"));
		await dom.settle();
		expect(callsTo(host, "browser_close")).toStrictEqual([{ browserId: "c1" }]);
	});

	test("pressing a Private browser left open shows it and leaves the one on screen, without opening anything new", async () => {
		const host: Host = fakeHost(SHELF, call => {
			if (call.name === "browser_state") return answer(browserOf("p1", null));
			if (call.name === "browser_leave") return answer({ closed: false });
			return failure(`unexpected ${call.name}`);
		});
		host.browsers = [PRIVATE_TASK];
		const dom = await mountView(host, WORK_BROWSER);
		await openMenu(dom);

		await dom.click(rowFor(dom, "Private browser"));
		await dom.settle();

		expect(callsTo(host, "browser_state")).toStrictEqual([{ browserId: "p1" }]);
		expect(callsTo(host, "browser_open")).toEqual([]);
		expect(callsTo(host, "browser_leave")).toStrictEqual([{ browserId: "b1" }]);
		expect(chipOf(dom).textContent?.trim()).toBe("Private");
	});

	test("the first focus goes to the first profile that can be opened, else to a browser left open, else to Add profile — never to a close button", async () => {
		const dom = await mountView(fakeHost([listing("t-travel", "Travel", { heldBy: "human" })]), browserOf("b1", listing(DEFAULT_PROFILE, "Default")));
		const kept = fakeHost([listing("t-travel", "Travel", { heldBy: "human" })]);
		kept.browsers = [PRIVATE_TASK];
		const withKept = await mountView(kept, browserOf("b1", listing(DEFAULT_PROFILE, "Default")));
		for (const [view, expected] of [[dom, "Add profile"], [withKept, "Private browserAn agent task is running"]] as const) {
			await openMenu(view);
			const initial = view.find("[data-menu-initial]");
			expect(initial.map(el => el.textContent?.trim())).toEqual([expected]);
		}
	});
});

// ---------------------------------------------------------------------------
// Add profile
// ---------------------------------------------------------------------------

describe("Add profile in the menu", () => {
	const ACME = listing("acme-1", "Acme Corp", { colour: "blue" });
	/** The first colour of the palette that no listed profile — the implicit Default included — wears. */
	const FIRST_FREE = PROFILE_COLOURS.find(colour => ![defaultColour("default"), "teal", "blue"].includes(colour));
	/** A colour swatch or an avatar choice, named by its label. */
	const radio = (dom: Dom, name: string): Element => {
		const found = dom.find('[role="radio"]').find(el => el.getAttribute("aria-label") === name);
		if (!found) throw new Error(`no ${name} choice`);
		return found;
	};
	const nameField = (dom: Dom): Element => dom.find('input[aria-label="Profile name"]')[0] as Element;

	/** A runtime that makes the profile under a folder name of its own choosing, and opens the one it made. */
	function makesProfiles(): (call: Call) => CallToolResult {
		let made: ProfileListing | undefined;
		return call => {
			if (call.name === "browser_profile_add") {
				const { name, colour, avatar } = call.args as { name: string; colour: ProfileListing["colour"]; avatar?: string };
				made = listing("made-by-server", name, { colour, ...(avatar === undefined ? {} : { avatar }) });
				return answer({ profile: made });
			}
			if (call.name === "browser_leave") return answer({ closed: true });
			return call.name === "browser_open" && made !== undefined ? answer(browserOf("b2", made)) : failure(`unexpected ${call.name}`);
		};
	}

	async function openForm(host: Host): Promise<Dom> {
		const dom = await mountView(host, WORK_BROWSER);
		await openMenu(dom);
		await dom.click(button(dom, "Add profile"));
		return dom;
	}

	test("a name that cannot be used leaves the form open, says why, and sends nothing — a different reason for each kind of mistake", async () => {
		const host = fakeHost([WORK, ACME]);
		const dom = await openForm(host);
		const form = dom.find('form[aria-label="New profile"]')[0] as Element;
		const said = () => [...form.querySelectorAll('[role="alert"]')].map(el => el.textContent);

		// A blank box is not a mistake until they try to add.
		expect(said()).toEqual([]);

		const mistakes: Record<string, string[]> = {
			blank: ["", "   "],
			"path-like": ["a/b", "a\\b", "C:", ".hidden"],
			reserved: ["relay", "Con"],
			"too long": ["x".repeat(49)],
			"no letter or number": ["---"],
			// The label of a profile that exists in another case and spacing, its folder name, and the implicit Default.
			taken: ["  ACME   corp ", "ACME-1", "default", "Default"],
		};
		const kindOf = new Map<string, Set<string>>();
		for (const [kind, names] of Object.entries(mistakes)) {
			for (const typed of names) {
				await dom.type(nameField(dom), typed);
				await dom.submit(form);
				const sentences = said();
				expect(sentences, `"${typed}" (${kind})`).toHaveLength(1);
				expect(sentences[0]?.length ?? 0, `"${typed}" (${kind})`).toBeGreaterThan(0);
				const sentence = sentences[0] as string;
				kindOf.set(sentence, (kindOf.get(sentence) ?? new Set()).add(kind));
			}
		}

		expect(kindOf.get("Give the profile a name.")).toEqual(new Set(["blank"]));
		// One sentence per kind of mistake, and no sentence shared by two kinds.
		expect([...kindOf.values()].map(kinds => kinds.size)).toEqual([...kindOf.values()].map(() => 1));
		expect(kindOf.size).toBe(Object.keys(mistakes).length);
		expect(callsTo(host, "browser_profile_add")).toEqual([]);
		expect(callsTo(host, "browser_open")).toEqual([]);
		expect(dom.find('form[aria-label="New profile"]')).toHaveLength(1);

		// Once a name is wrong the field says so as they type, not only on the next press of Add.
		await dom.type(nameField(dom), "Fine name");
		expect(said()).toEqual([]);
		await dom.type(nameField(dom), "Not/fine");
		expect(said()).toHaveLength(1);
	});

	test("a good name adds the profile once, then opens the profile the runtime made, in that order — and the browser on screen is the new one", async () => {
		const host = fakeHost([WORK, ACME], makesProfiles());
		const dom = await openForm(host);

		// The colour is already one nobody has; picking an avatar and then going back to Initial sends no avatar at all.
		expect(radio(dom, FIRST_FREE as string).getAttribute("aria-checked")).toBe("true");
		await dom.click(radio(dom, "💼"));
		await dom.click(radio(dom, "Initial"));
		await dom.type(nameField(dom), "  Side   hustle ");
		await dom.submit(dom.find('form[aria-label="New profile"]')[0] as Element);
		await dom.settle();

		expect(callsTo(host, "browser_profile_add")).toStrictEqual([{ name: "Side hustle", colour: FIRST_FREE }]);
		// The runtime named the folder; the View opens that, not what was typed.
		expect(callsTo(host, "browser_open")).toStrictEqual([{ engine: "chromium", profile: "made-by-server" }]);
		// The profile on screen when it was added is the one left, once the new one is open.
		expect(host.calls.filter(call => ["browser_profile_add", "browser_open", "browser_leave"].includes(call.name)).map(call => [call.name, call.args.browserId])).toEqual([["browser_profile_add", undefined], ["browser_open", undefined], ["browser_leave", "b1"]]);
		expect(chipOf(dom).textContent?.trim()).toBe("SSide hustle");
		expect(menuIsOpen(dom)).toBe(false);
		expect(alerts(dom)).toEqual([]);
	});

	test("the colour and avatar that were picked are the ones sent", async () => {
		const host = fakeHost([WORK, ACME], makesProfiles());
		const dom = await openForm(host);

		await dom.click(radio(dom, "pink"));
		await dom.click(radio(dom, "🎮"));
		expect(radio(dom, "pink").getAttribute("aria-checked")).toBe("true");
		expect(radio(dom, FIRST_FREE as string).getAttribute("aria-checked")).toBe("false");
		await dom.type(nameField(dom), "Gaming rig");
		await dom.submit(dom.find('form[aria-label="New profile"]')[0] as Element);
		await dom.settle();

		expect(callsTo(host, "browser_profile_add")).toStrictEqual([{ name: "Gaming rig", colour: "pink", avatar: "🎮" }]);
		expect(chipOf(dom).textContent?.trim()).toBe("🎮Gaming rig");
	});

	test("a name the runtime refuses is shown in the form, nothing is opened, and the form takes another name", async () => {
		const refusal = "A profile with that name already exists on this computer.";
		let refuse = true;
		const make = makesProfiles();
		const host = fakeHost([WORK, ACME], call => (call.name === "browser_profile_add" && refuse ? failure(refusal) : make(call)));
		const dom = await openForm(host);
		const form = dom.find('form[aria-label="New profile"]')[0] as Element;

		await dom.type(nameField(dom), "Side hustle");
		await dom.submit(form);
		await dom.settle();

		expect(alerts(dom)).toEqual([refusal]);
		expect(form.querySelector('[role="alert"]')?.textContent).toBe(refusal);
		expect(callsTo(host, "browser_open")).toEqual([]);
		expect(chipOf(dom).textContent?.trim()).toBe("💼Work account");

		refuse = false;
		await dom.type(nameField(dom), "Side hustle 2");
		expect(alerts(dom)).toEqual([]);
		expect(form.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(false);
		await dom.submit(form);
		await dom.settle();

		expect(callsTo(host, "browser_profile_add")).toHaveLength(2);
		expect(callsTo(host, "browser_open")).toHaveLength(1);
		expect(chipOf(dom).textContent?.trim()).toBe("SSide hustle 2");
	});
});

// ---------------------------------------------------------------------------
// Taking over
// ---------------------------------------------------------------------------

describe("taking over from the agent", () => {
	const agentAt = (agoMs: number) => browserOf("b1", WORK, { agentActionAt: Date.now() - agoMs });
	/** A runtime that flips `takenOver` as `browser_control` is asked to, on the state it was given. */
	const controlled = (from: BrowserState) => (call: Call): CallToolResult => (call.name === "browser_control" ? answer({ ...from, takenOver: call.args.mode === "take" }) : failure(`unexpected ${call.name}`));

	for (const { name, state, offered } of [
		{ name: "an agent acted a moment ago", state: agentAt(2_000), offered: true },
		{ name: "an agent acted long ago", state: agentAt(60_000), offered: false },
		{ name: "no agent has acted", state: WORK_BROWSER, offered: false },
	]) {
		test(`the page offers Take over when ${name}: ${offered}`, async () => {
			const dom = await mountView(fakeHost(SHELF), state);

			expect(controls(dom, "page")).toEqual(offered ? ["Take over"] : []);
			expect(dom.text().includes("Your agent is working here")).toBe(offered);
		});
	}

	test("Take over asks for the wheel on this browser, the answer says they have it, and Hand back gives it back", async () => {
		const state = agentAt(2_000);
		const host = fakeHost(SHELF, controlled(state));
		const dom = await mountView(host, state);

		await dom.click(button(dom, "Take over"));
		await dom.settle();
		expect(callsTo(host, "browser_control")).toStrictEqual([{ browserId: "b1", mode: "take" }]);
		expect(controls(dom, "page")).toEqual(["Hand back"]);
		expect(dom.text()).toContain("You have control");
		expect(dom.text()).not.toContain("Your agent is working here");

		await dom.click(button(dom, "Hand back"));
		await dom.settle();
		expect(callsTo(host, "browser_control")).toStrictEqual([
			{ browserId: "b1", mode: "take" },
			{ browserId: "b1", mode: "return" },
		]);
		expect(controls(dom, "page")).toEqual(["Take over"]);
		expect(dom.text()).toContain("Your agent is working here");
	});

	test("a refused Take over says why and changes nothing", async () => {
		const host = fakeHost(SHELF, call => (call.name === "browser_control" ? failure("That browser is closed.") : failure(`unexpected ${call.name}`)));
		const dom = await mountView(host, agentAt(2_000));

		await dom.click(button(dom, "Take over"));
		await dom.settle();

		expect(alerts(dom)).toEqual(["That browser is closed."]);
		expect(controls(dom, "page")).toEqual(["Take over"]);
		expect(dom.text()).not.toContain("You have control");
	});

	test("the menu offers Take over and Hand back while an agent is acting or the person has the wheel, and they make the same calls as the pill", async () => {
		const state = agentAt(2_000);
		const host = fakeHost(SHELF, controlled(state));
		const dom = await mountView(host, state);

		await openMenu(dom);
		// One place at a time: with the menu open the pill is not on the page.
		expect([controls(dom, "page"), controls(dom, "menu")]).toEqual([[], ["Take over"]]);
		await dom.click(button(dom, "Take over"));
		await dom.settle();
		expect(callsTo(host, "browser_control")).toStrictEqual([{ browserId: "b1", mode: "take" }]);
		expect(menuIsOpen(dom)).toBe(false);
		expect(controls(dom, "page")).toEqual(["Hand back"]);

		await openMenu(dom);
		expect([controls(dom, "page"), controls(dom, "menu")]).toEqual([[], ["Hand back"]]);
		await dom.click(button(dom, "Hand back"));
		await dom.settle();
		expect(callsTo(host, "browser_control")).toStrictEqual([
			{ browserId: "b1", mode: "take" },
			{ browserId: "b1", mode: "return" },
		]);
		expect(controls(dom, "page")).toEqual(["Take over"]);
	});

	test("a browser no agent is acting in has no Take over anywhere: not on the page and not in the menu", async () => {
		for (const state of [WORK_BROWSER, agentAt(60_000), browserOf("b1", null), { ...browserOf("b1", null), profile: "relay", engine: "chrome-relay" as const, app: null }]) {
			const dom = await mountView(fakeHost(SHELF), state);
			await openMenu(dom);
			expect([controls(dom, "page"), controls(dom, "menu")]).toEqual([[], []]);
		}
	});

	for (const { name, over } of [
		{ name: "an agent task is running", over: { task: RUNNING } },
		{ name: "a post is waiting for their confirmation", over: { publish: AWAITING } },
	]) {
		test(`neither the page nor the menu offers Take over while ${name}, though the same browser idle offers both`, async () => {
			const recently = { agentActionAt: Date.now() - 2_000 };

			const idle = await mountView(fakeHost(SHELF), browserOf("b1", WORK, recently));
			await openMenu(idle);
			expect([controls(idle, "page"), controls(idle, "menu")]).toEqual([[], ["Take over"]]);

			const busy = await mountView(fakeHost(SHELF), browserOf("b1", WORK, { ...recently, ...over }));
			await openMenu(busy);
			expect([controls(busy, "page"), controls(busy, "menu")]).toEqual([[], []]);
		});
	}

	test("the pill goes away by itself once the agent has been still for 12 seconds", async () => {
		const dom = await mountView(fakeHost(SHELF), agentAt(12_000 - 1_500));
		expect(controls(dom, "page")).toEqual(["Take over"]);

		for (let attempt = 0; attempt < 100 && controls(dom, "page").length > 0; attempt += 1) await dom.settle();

		expect(controls(dom, "page")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The start page
// ---------------------------------------------------------------------------

describe("the start page", () => {
	test("lists the same profiles the menu does, by label, and adds a profile through the same form that then opens with it", async () => {
		const host = fakeHost(SHELF, call => {
			if (call.name === "browser_profile_add") return answer({ profile: listing("made-by-server", "Side hustle", { colour: call.args.colour as ProfileListing["colour"] }) });
			if (call.name === "browser_open") return answer(browserOf("b2", listing("made-by-server", "Side hustle")));
			return failure(`unexpected ${call.name}`);
		});
		const dom = await mountView(host, null);
		await dom.click(button(dom, "Options"));

		expect(dom.find('[role="radio"]').map(el => el.lastChild?.textContent)).toEqual(["Default", "Bank", "Family", "Gaming", "Research", "Streaming", "Studio", "Travel", "Work account"]);

		await dom.click(button(dom, "Add profile"));
		expect(dom.find('input[aria-label="Profile name"]')).toHaveLength(1);
		await dom.type(dom.find('input[aria-label="Profile name"]')[0] as Element, "Side hustle");
		await dom.submit(dom.find('form[aria-label="New profile"]')[0] as Element);
		await dom.settle();

		// Made and picked, not yet opened.
		expect(callsTo(host, "browser_profile_add")).toHaveLength(1);
		expect(callsTo(host, "browser_open")).toEqual([]);

		await dom.click(button(dom, "Open"));
		await dom.settle();

		expect(callsTo(host, "browser_open")).toStrictEqual([{ engine: "chromium", profile: "made-by-server" }]);
		expect(chipOf(dom).textContent?.trim()).toBe("SSide hustle");
	});

	test("Escape in Add profile backs out of it, as it did before the form was shared; with a name typed, nothing is made", async () => {
		const host = fakeHost(SHELF);
		const dom = await mountView(host, null);
		await dom.click(button(dom, "Options"));
		await dom.click(button(dom, "Add profile"));
		await dom.type(dom.find('input[aria-label="Profile name"]')[0] as Element, "Side hustle");

		// From the colour swatch the person tabbed to (the harness cannot press a key in a text field it then unmounts).
		await dom.key(dom.find('form[aria-label="New profile"] [role="radio"]')[0] as Element, "Escape");

		expect(dom.find('form[aria-label="New profile"]')).toHaveLength(0);
		expect(callsTo(host, "browser_profile_add")).toEqual([]);
	});
});
