/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the Browser View's start page
 *  speaks engineer again (engines, Chromium, relay, the runtime's raw
 *  refusals) to a person who only wanted to open a page; Open ignores the
 *  address they typed; a person's own browser stops keeping their logins, or a
 *  Private one saves them, or "my own Chrome" opens the wrong kind of browser;
 *  a browser that ended normally is shown as an alarm, or one that could not be
 *  opened is shown as nothing; or a profile shows up in the picker before there
 *  is a second one to pick, or a profile another chat holds can be picked.
 *
 *  The View is mounted live on a linkedom document (`dom-harness.ts`) against a
 *  fake MCP App host whose `callServerTool` records every browser tool call and
 *  whose `updateModelContext` records everything the View puts in the agent's
 *  context. That is nothing at all until the human deliberately annotates: the
 *  host parks whatever the View sends and appends it to every later prompt.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BrowserState, ProfileListing } from "../src/contracts";
import { BrowserApp } from "../app/view/browser-app";
import { BrowserClient, mountFromToolResult, type ToolMount } from "../app/view/browser-client";
import { StartPage, type StartPageProps } from "../app/view/start-page";
import type { LiveFrame } from "../src/engines/types";
import { BrowserRuntimeError } from "../src/store";
import { LiveChannel, type LiveSource } from "../src/stream";
import { type Dom, mount, unmountAll } from "./dom-harness";

afterEach(unmountAll);

/** Words from the engine room. "Profile" is not one: it is Chrome's word, and the one the owner asked the View to use. */
const JARGON = /engine|relay|chromium/i;

const listing = (name: string, over: Partial<ProfileListing> = {}): ProfileListing => ({ name, label: name === "default" ? "Default" : name, colour: "blue", heldBy: null, sites: [], ...over });

const noop = () => {};
const startProps = (over: Partial<StartPageProps> = {}): StartPageProps => ({
	profiles: [],
	profilesError: null,
	profile: "default",
	isPrivate: false,
	ownChrome: false,
	opening: false,
	error: null,
	closed: false,
	onProfile: noop,
	onPrivate: noop,
	onOwnChrome: noop,
	onAddProfile: async () => {},
	onOpen: noop,
	...over,
});

const button = (dom: Dom, label: string): Element => {
	const found = dom.find("button").find(el => el.textContent?.trim().startsWith(label));
	if (!found) throw new Error(`no "${label}" button`);
	return found;
};
const optionBox = (dom: Dom, label: string): Element => {
	const row = dom.find("label").find(el => el.textContent?.includes(label));
	const box = row?.querySelector('input[type="checkbox"]');
	if (!box) throw new Error(`no "${label}" checkbox`);
	return box;
};
const openOptions = (dom: Dom) => dom.click(button(dom, "Options"));

describe("the start page", () => {
	test("offers one Open, with no engineer words folded or unfolded", async () => {
		const dom = await mount(<StartPage {...startProps({ profiles: [listing("default"), listing("work")] })} />);
		const folded = dom.text();
		await openOptions(dom);

		expect(dom.find("button").filter(el => el.textContent?.trim().startsWith("Open"))).toHaveLength(1);
		expect(folded).not.toMatch(JARGON);
		expect(dom.text()).not.toMatch(JARGON);
	});

	test("the options are folded until asked for, fold again, and each box reports its own change", async () => {
		const seen: string[] = [];
		const dom = await mount(<StartPage {...startProps({ onPrivate: on => seen.push(`private:${on}`), onOwnChrome: on => seen.push(`chrome:${on}`) })} />);
		expect(dom.find('input[type="checkbox"]')).toHaveLength(0);

		await openOptions(dom);
		expect(dom.find('input[type="checkbox"]')).toHaveLength(2);
		await dom.check(optionBox(dom, "Private"), true);
		await dom.check(optionBox(dom, "own Chrome"), true);
		await dom.click(button(dom, "Options"));

		expect(seen).toEqual(["private:true", "chrome:true"]);
		expect(dom.find('input[type="checkbox"]')).toHaveLength(0);
	});

	test("the profile picker appears only once a second profile exists, and picking one is reported", async () => {
		for (const profiles of [null, [], [listing("default")]] as const) {
			const dom = await mount(<StartPage {...startProps({ profiles })} />);
			await openOptions(dom);
			expect(dom.find('[role="radiogroup"]')).toHaveLength(0);
			// Making the first extra profile is always on offer.
			await dom.click(button(dom, "Add profile"));
			expect(dom.find('input[aria-label="Profile name"]')).toHaveLength(1);
		}

		const picked: string[] = [];
		const dom = await mount(<StartPage {...startProps({ profiles: [listing("default"), listing("work", { label: "Work account" })], onProfile: name => picked.push(name) })} />);
		await openOptions(dom);
		const radios = dom.find('[role="radio"]');
		expect(radios.map(el => el.lastChild?.textContent)).toEqual(["Default", "Work account"]);
		await dom.click(radios[1] as Element);
		expect(picked).toEqual(["work"]);
	});

	test("a profile another chat holds is shown and cannot be picked; one the agent has open here can", async () => {
		const picked: string[] = [];
		const profiles = [listing("default"), listing("held", { heldBy: "another chat" }), listing("elsewhere", { heldBy: "human" }), listing("mine", { heldBy: "this chat", hold: { by: "agent", task: false, takenOver: false } })];
		const dom = await mount(<StartPage {...startProps({ profiles, onProfile: name => picked.push(name) })} />);
		await openOptions(dom);
		const radios = dom.find('[role="radio"]');
		expect(radios.map(el => [el.lastChild?.textContent, el.hasAttribute("disabled")])).toEqual([["Default", false], ["elsewhere", true], ["held", true], ["mine", false]]);
		await dom.click(radios[1] as Element);
		await dom.click(radios[3] as Element);
		expect(picked).toEqual(["mine"]);
	});

	test("a new profile is named through the shared name rules: a path-like, reserved or taken name is refused with a reason and sends nothing; a good one is sent as typed", async () => {
		const added: { name: string; colour?: string; avatar?: string }[] = [];
		const dom = await mount(<StartPage {...startProps({ profiles: [listing("default"), listing("work", { label: "Work" })], onAddProfile: async request => void added.push(request) })} />);
		await openOptions(dom);
		await dom.click(button(dom, "Add profile"));
		const field = dom.find('input[aria-label="Profile name"]')[0] as Element;
		const form = field.closest("form") as Element;
		const said = () => form.querySelector('[role="alert"]')?.textContent;

		const reasons: (string | undefined)[] = [];
		for (const name of ["a/b", "relay", "  WORK  "]) {
			await dom.type(field, name);
			await dom.submit(form);
			reasons.push(said());
		}
		expect(added).toEqual([]);
		expect(reasons.every(reason => reason !== undefined && reason.length > 0)).toBe(true);
		expect(new Set(reasons).size).toBe(3);

		await dom.type(field, "  Work account ");
		await dom.submit(form);
		expect(added).toEqual([{ name: "Work account", colour: expect.any(String) }]);
	});

	test("Private locks the profile picker and own Chrome locks Private; the folded row says which is on", async () => {
		const privately = await mount(<StartPage {...startProps({ profiles: [listing("default"), listing("work")], profile: "work", isPrivate: true })} />);
		expect(privately.text()).toContain("Private");
		await openOptions(privately);
		expect(privately.find('[role="radio"]').map(el => el.hasAttribute("disabled"))).toEqual([true, true]);

		const own = await mount(<StartPage {...startProps({ ownChrome: true })} />);
		expect(own.text()).toContain("Your Chrome");
		await openOptions(own);
		expect(optionBox(own, "Private").hasAttribute("disabled")).toBe(true);
	});
});

const LIVE: BrowserState = {
	browserId: "b1",
	profile: null,
	look: null,
	engine: "chromium",
	app: "chrome",
	url: "https://example.com/",
	title: "Example",
	revision: 1,
	viewport: { width: 1280, height: 800 },
	task: null,
	tabs: [],
	activeTabId: "",
	loading: false,
	canGoBack: false,
	canGoForward: false,
	publish: null,
	dialogs: [],
	takenOver: false,
	agentActionAt: null,
};

interface Call {
	readonly name: string;
	readonly args: Record<string, unknown>;
}

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });

interface ContextUpdate {
	readonly content: readonly unknown[];
}

/** A host that answers `browser_profiles`, records every call and every context update, and lets `answer` decide the rest. */
function fakeApp(answer: (call: Call) => CallToolResult): { readonly app: App; readonly calls: Call[]; readonly contexts: ContextUpdate[] } {
	const calls: Call[] = [];
	const contexts: ContextUpdate[] = [];
	// The View touches exactly these three App members; the rest of the host surface is not in play.
	const app = {
		callServerTool: async (request: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult> => {
			const call = { name: request.name, args: request.arguments ?? {} };
			calls.push(call);
			return call.name === "browser_profiles" ? { content: [], structuredContent: { profiles: [] } } : answer(call);
		},
		getHostCapabilities: () => ({ updateModelContext: { text: {}, image: {} } }),
		updateModelContext: async (update: ContextUpdate) => {
			contexts.push(update);
			return {};
		},
	} as unknown as App;
	return { app, calls, contexts };
}

const opens = (calls: readonly Call[]) => calls.filter(call => call.name === "browser_open").map(call => call.args);

/** The runtime's two refusals of a saved set that is already held, verbatim: one holder in this server (`profile_held`, open or still launching), one across servers (`profile_locked`). */
const SET_TAKEN = {
	profile_held: `profile "default" is already open, held by another chat. Ask the human to close it, or use another profile.`,
	profile_locked: `profile "default" is already in use (pid 4242 since 2026-09-29T08:00:00.000Z). Close that browser first (browser_close), or use another profile.`,
} as const;
const TAKEN_SENTENCE = "That browser is already open. Use it, or open a Private one.";

const addressField = (dom: Dom): Element => dom.find('input[aria-label="Address"]')[0] as Element;
const alerts = (dom: Dom) => dom.find('[role="alert"]').map(el => el.textContent);

describe("opening from the start page", () => {
	test("Open goes to the address that was typed, on the person's saved logins, and a refusal is shown, not swallowed", async () => {
		const { app, calls } = fakeApp(() => failure("could not open"));
		const dom = await mount(<BrowserApp app={app} toolState={null} />);
		await dom.settle();

		await dom.type(addressField(dom), "example.com");
		await dom.click(button(dom, "Open"));
		await dom.settle();

		expect(opens(calls)).toStrictEqual([{ engine: "chromium", profile: "default", url: "https://example.com/" }]);
		expect(alerts(dom)).toEqual(["could not open"]);
	});

	test("something that is not an address opens nothing and says why", async () => {
		const { app, calls } = fakeApp(() => failure("unexpected"));
		const dom = await mount(<BrowserApp app={app} toolState={null} />);
		await dom.settle();

		await dom.type(addressField(dom), "two words");
		await dom.click(button(dom, "Open"));
		await dom.settle();

		expect(opens(calls)).toEqual([]);
		expect(alerts(dom)).toHaveLength(1);
		expect(addressField(dom).getAttribute("aria-invalid")).toBe("true");
	});

	test("an empty address opens a blank browser on their logins, Private sends no profile, and their own Chrome is the Chrome kind", async () => {
		const { app, calls } = fakeApp(() => failure("could not open"));
		const dom = await mount(<BrowserApp app={app} toolState={null} />);
		await dom.settle();

		await dom.click(button(dom, "Open"));
		await dom.settle();
		await openOptions(dom);
		await dom.check(optionBox(dom, "Private"), true);
		await dom.click(button(dom, "Open"));
		await dom.settle();
		await dom.check(optionBox(dom, "Private"), false);
		await dom.check(optionBox(dom, "own Chrome"), true);
		await dom.click(button(dom, "Open"));
		await dom.settle();

		expect(opens(calls)).toStrictEqual([{ engine: "chromium", profile: "default" }, { engine: "chromium" }, { engine: "chrome-relay", profile: "relay" }]);
	});

	for (const [code, text] of Object.entries(SET_TAKEN)) {
		test(`a saved set another browser holds (${code}) is one plain sentence with a way out, and Private then opens`, async () => {
			const { app, calls } = fakeApp(call => {
				if (call.name !== "browser_open") return failure("connection reset");
				return call.args.profile === undefined ? { content: [], structuredContent: { ...LIVE, browserId: "b2" } } : failure(text);
			});
			const dom = await mount(<BrowserApp app={app} toolState={null} />);
			await dom.settle();

			await dom.click(button(dom, "Open"));
			await dom.settle();
			expect(alerts(dom)).toEqual([TAKEN_SENTENCE]);

			await openOptions(dom);
			await dom.check(optionBox(dom, "Private"), true);
			await dom.click(button(dom, "Open"));
			await dom.settle();

			expect(opens(calls)).toStrictEqual([{ engine: "chromium", profile: "default" }, { engine: "chromium" }]);
			expect(dom.find(".bx-browser")).toHaveLength(1);
			expect(dom.text()).not.toContain(TAKEN_SENTENCE);
		});
	}
});

describe("a browser the host's own tool call failed to open", () => {
	const mounted = (result: CallToolResult): ToolMount => {
		const read = mountFromToolResult(result);
		if (read === null) throw new Error("the result said nothing about a browser");
		return { ...read, seq: 1 };
	};

	test("is told on the start page — in plain words for a held set, verbatim otherwise — not dropped", async () => {
		for (const [text, shown] of [[SET_TAKEN.profile_held, TAKEN_SENTENCE], ["could not launch Chrome", "could not launch Chrome"]] as const) {
			const { app } = fakeApp(() => failure("unexpected"));
			const dom = await mount(<BrowserApp app={app} toolState={mounted(failure(text))} />);
			await dom.settle();

			expect(alerts(dom)).toEqual([shown]);
			expect(button(dom, "Open")).toBeTruthy();
		}
	});

	test("a result that opened a browser is a browser, and one that says nothing about a browser is nothing", () => {
		expect(mountFromToolResult({ content: [], structuredContent: { ...LIVE } })).toEqual({ state: LIVE });
		expect(mountFromToolResult({ content: [], structuredContent: { state: LIVE } })).toEqual({ state: LIVE });
		expect(mountFromToolResult({ content: [] })).toBeNull();
	});
});

describe("a browser that ends", () => {
	test("is a normal ending: the start page returns with one calm line, and nothing announces an error", async () => {
		const { app, calls } = fakeApp(call => (call.name === "browser_stream" ? failure("unknown or already closed browserId b1") : failure("unexpected")));
		const dom = await mount(<BrowserApp app={app} toolState={{ state: LIVE, seq: 1 }} />);
		await dom.settle();

		expect(dom.text()).toContain("This browser was closed.");
		expect(dom.find('input[aria-label="Address"]')).toHaveLength(1);
		expect(dom.find('[role="alert"]')).toHaveLength(0);
		expect(dom.text()).not.toMatch(/shut down|elsewhere/i);
		// The page is one click away again: the same Open the first visit had.
		expect(button(dom, "Open")).toBeTruthy();
		expect(calls.some(call => call.name === "browser_stream")).toBe(true);
	});

	test("the calm line belongs to the ended browser only: once the next one is open it is gone", async () => {
		const next = { ...LIVE, browserId: "b2" };
		const { app } = fakeApp(call => {
			if (call.name === "browser_open") return { content: [], structuredContent: { ...next } };
			// The first browser is gone; the second one merely stumbles.
			return failure(call.args.browserId === "b1" ? "unknown or already closed browserId b1" : "connection reset");
		});
		const dom = await mount(<BrowserApp app={app} toolState={{ state: LIVE, seq: 1 }} />);
		await dom.settle();
		expect(dom.text()).toContain("This browser was closed.");

		await dom.click(button(dom, "Open"));
		await dom.settle();

		expect(dom.find(".bx-browser")).toHaveLength(1);
		expect(dom.text()).not.toContain("This browser was closed.");
	});
});

describe("what the View puts in the agent's context", () => {
	const crop = [{ type: "image", data: "AA==", mimeType: "image/png" }, { type: "text", text: "the circled button" }];

	test("nothing: not when a browser is mounted, and not when the human opens one from the start page", async () => {
		const mountedBy = fakeApp(() => failure("unexpected"));
		const mounted = await mount(<BrowserApp app={mountedBy.app} toolState={{ state: LIVE, seq: 1 }} />);
		await mounted.settle();
		expect(mounted.find(".bx-browser")).toHaveLength(1);
		expect(mountedBy.contexts).toEqual([]);

		const openedBy = fakeApp(call => (call.name === "browser_open" ? { content: [], structuredContent: { ...LIVE, browserId: "b2" } } : failure("unexpected")));
		const started = await mount(<BrowserApp app={openedBy.app} toolState={null} />);
		await started.settle();
		await started.click(button(started, "Open"));
		await started.settle();
		expect(started.find(".bx-browser")).toHaveLength(1);
		expect(openedBy.contexts).toEqual([]);
	});

	test("the human's annotation, exactly as sent, and its taking back — once — when the View moves to another browser", async () => {
		const { app, contexts } = fakeApp(() => failure("unexpected"));
		const client = new BrowserClient(app);
		await client.follow("b1");
		expect(contexts).toEqual([]);

		expect(await client.updateContext("b1", crop)).toBe(true);
		expect(contexts).toEqual([{ content: crop }]);
		// Still the same browser: nothing more to say.
		await client.follow("b1");
		expect(contexts).toHaveLength(1);

		// The picture is of b1's page; it no longer describes what is on screen.
		await client.follow("b2");
		expect(contexts).toEqual([{ content: crop }, { content: [] }]);
		await client.follow("b3");
		expect(contexts).toHaveLength(2);
	});

	test("an annotation the human removes is taken back, and moving on then has nothing left to take back", async () => {
		const { app, contexts } = fakeApp(() => failure("unexpected"));
		const client = new BrowserClient(app);
		await client.follow("b1");
		await client.updateContext("b1", crop);

		expect(await client.updateContext("b1", [])).toBe(true);
		await client.follow("b2");

		expect(contexts).toEqual([{ content: crop }, { content: [] }]);
	});

	test("an annotation for a browser the View has already left is never sent", async () => {
		const { app, contexts } = fakeApp(() => failure("unexpected"));
		const client = new BrowserClient(app);
		await client.follow("b1");

		const pending = client.updateContext("b1", crop);
		await client.follow("b2");

		expect(await pending).toBe(false);
		expect(contexts).toEqual([]);
	});
});

/** A browser behind the real listener: state the test can change, picture watchers it can count, input it records. */
class ListeningBrowser implements LiveSource {
	state: BrowserState = { ...LIVE, tabs: [{ id: "t1", title: "First title", url: "https://example.com/", active: true, loading: false, favicon: null }], activeTabId: "t1" };
	watchers = 0;
	readonly inputs: unknown[] = [];
	watchFrames(_browserId: string, _onFrame: (frame: LiveFrame) => void): () => void {
		this.watchers += 1;
		return () => void (this.watchers -= 1);
	}
	viewing(_browserId: string): () => void {
		return () => {};
	}
	async liveState(): Promise<BrowserState> {
		return structuredClone(this.state);
	}
	async input(_browserId: string, events: unknown): Promise<void> {
		if (!Array.isArray(events)) throw new BrowserRuntimeError("bad_input", "not a list");
		this.inputs.push(events);
	}
}

const channels: LiveChannel[] = [];
afterEach(async () => {
	for (const channel of channels.splice(0)) await channel.close();
});

/** A host whose `browser_stream` answers with a real listener's address; every other call is recorded and refused. */
function appOnListener(browser: ListeningBrowser): { app: App; calls: Call[]; channel: LiveChannel } {
	const channel = new LiveChannel(browser, { stateIntervalMs: 15 });
	channels.push(channel);
	const { app, calls } = fakeApp(() => failure("unexpected"));
	const answer = app.callServerTool.bind(app);
	app.callServerTool = async request => {
		if (request.name !== "browser_stream") return await answer(request);
		calls.push({ name: request.name, args: request.arguments ?? {} });
		return { content: [], structuredContent: { ...(await channel.mint("b1")) } };
	};
	return { app, calls, channel };
}

async function until(dom: Dom, predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 150 && !predicate(); attempt += 1) await dom.settle();
	expect(predicate()).toBe(true);
}

describe("the live connection", () => {
	test("state reaches the View on the stream: one browser_stream call opens it and no tool call is made to learn what changed", async () => {
		const browser = new ListeningBrowser();
		const { app, calls } = appOnListener(browser);
		const dom = await mount(<BrowserApp app={app} toolState={{ state: LIVE, seq: 1 }} />);
		await until(dom, () => dom.text().includes("First title"));

		browser.state = { ...browser.state, tabs: [{ id: "t1", title: "Retitled by the page", url: "https://example.com/", active: true, loading: false, favicon: null }] };
		await until(dom, () => dom.text().includes("Retitled by the page"));
		// Many more state reads happen on the listener than there are tool calls: there is exactly the one.
		expect(calls.map(call => call.name)).toEqual(["browser_stream"]);
		expect(calls[0]?.args).toEqual({ browserId: "b1" });
	});

	test("the picture watcher runs while the View shows the page, and stops while the human annotates it", async () => {
		const browser = new ListeningBrowser();
		const { app } = appOnListener(browser);
		const dom = await mount(<BrowserApp app={app} toolState={{ state: LIVE, seq: 1 }} />);
		await until(dom, () => browser.watchers === 1);

		const annotate = dom.find('button[aria-label^="Annotate"]')[0] as Element;
		await dom.click(annotate);
		await until(dom, () => browser.watchers === 0);
		// The state keeps coming while the picture is frozen: a tab retitled now still shows.
		browser.state = { ...browser.state, tabs: [{ id: "t1", title: "Changed while annotating", url: "https://example.com/", active: true, loading: false, favicon: null }] };
		await until(dom, () => dom.text().includes("Changed while annotating"));
	});

	test("a View that is torn down lets go of the listener: its picture watcher is released", async () => {
		const browser = new ListeningBrowser();
		const { app } = appOnListener(browser);
		const dom = await mount(<BrowserApp app={app} toolState={{ state: LIVE, seq: 1 }} />);
		await until(dom, () => browser.watchers === 1);

		await unmountAll();
		for (let attempt = 0; attempt < 150 && browser.watchers !== 0; attempt += 1) await new Promise(done => setTimeout(done, 20));
		expect(browser.watchers).toBe(0);
	});
});
