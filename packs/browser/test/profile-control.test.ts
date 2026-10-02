/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: switching profiles in the
 *  Browser View signs the person into the wrong account (one profile sees
 *  another's cookies) or loses the browser they left (its tabs, its login), a
 *  profile held in the background can be opened by a second seat, a throwaway
 *  browser an agent opened "just to look" shows up as a profile; or the
 *  take-over control stops being a wheel — an agent keeps clicking in a page the
 *  person is typing in, a batch the agent already sent carries on after the
 *  person reached for the wheel, the person's own clicks are refused, an agent
 *  can take the wheel for itself, a post awaiting confirmation is navigated
 *  away from, a task and the person drive the same page — or a model is sent
 *  the person's avatar and look.
 *
 *  Everything goes through the real MCP server over an in-memory transport,
 *  stamped the way a host stamps the View ("app", its session) and a chat
 *  ("model", its session), against a real headless Chrome and the local fixture
 *  site. Pages are read back from the page, never from a mock.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { PublishRecipe } from "../src/contracts";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { BROWSER_TEST_TIMEOUT_MS, chromePath, createRoot, describeWithChrome, failureCode, type Fixture, newRuntime, startFixture, teardown, waitUntil } from "./fixture";
import { type PublishFixture, startPublishFixture } from "./publish-fixture";

const CALLER = "ai.insodimension/caller";
const SESSION = "ai.insodimension/session";
const clients: Client[] = [];
const publishFixtures: PublishFixture[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	for (const fixture of publishFixtures.splice(0)) await fixture.stop();
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// The rig: the real server, stamped callers, parsed answers
// ---------------------------------------------------------------------------

interface ToolResult {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
}
const textOf = (result: ToolResult): string => result.content.map((block) => block.text ?? "").join("");

interface Who {
	caller: "model" | "app";
	session?: string;
}
/** The View, in its own seat. */
const VIEW: Who = { caller: "app", session: "s-view" };
/** A second View, a different seat. */
const VIEW_TWO: Who = { caller: "app", session: "s-view-2" };
/** An agent in a chat. */
const CHAT: Who = { caller: "model", session: "s-chat" };
/** The View in that same chat's seat: the person taking over what the chat's agent opened. */
const VIEW_OF_CHAT: Who = { caller: "app", session: "s-chat" };
/** Another chat. */
const OTHER_CHAT: Who = { caller: "model", session: "s-other" };

const PageState = z.object({
	browserId: z.string(),
	profile: z.string().nullable(),
	url: z.string(),
	title: z.string(),
	takenOver: z.boolean(),
	agentActionAt: z.number().nullable(),
	activeTabId: z.string(),
	tabs: z.array(z.object({ id: z.string(), url: z.string() })),
});
type PageState = z.infer<typeof PageState>;
const Listed = z.object({ profiles: z.array(z.record(z.string(), z.unknown())) });
const Outcome = z.object({ status: z.string(), completed: z.number(), error: z.string().optional(), url: z.string(), steps: z.array(z.object({ kind: z.string(), status: z.string() })).optional() });
const Inspected = z.object({ found: z.literal(true), rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }) });

interface Rig {
	call(name: string, args: Record<string, unknown>, who?: Who): Promise<ToolResult>;
	runtime: BrowserRuntime;
	fixture: Fixture;
	rootDir: string;
}

async function rig(): Promise<Rig> {
	const rootDir = await createRoot();
	const runtime = newRuntime(rootDir);
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir, presets: [] });
	const client = new Client({ name: "profile-control-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	const call: Rig["call"] = async (name, args, who) =>
		(await client.callTool({
			name,
			arguments: args,
			...(who === undefined ? {} : { _meta: { [CALLER]: who.caller, ...(who.session === undefined ? {} : { [SESSION]: { sessionId: who.session } }) } }),
		})) as ToolResult;
	return { call, runtime, fixture: startFixture(), rootDir };
}

/** A tool call that must have worked; its structured content as a browser state. */
function stateOf(result: ToolResult): PageState {
	if (result.isError) throw new Error(`the call failed: ${textOf(result)}`);
	return PageState.parse(result.structuredContent);
}

const open = async (r: Rig, who: Who, args: Record<string, unknown>): Promise<PageState> => stateOf(await r.call("browser_open", args, who));
const stateAs = async (r: Rig, who: Who, browserId?: string): Promise<PageState> => stateOf(await r.call("browser_state", browserId === undefined ? {} : { browserId }, who));

async function navigate(r: Rig, who: Who, browserId: string, path: string): Promise<void> {
	const done = await r.call("browser_act", { browserId, actions: [{ kind: "navigate", url: r.fixture.url(path) }] }, who);
	if (done.isError) throw new Error(`navigating to ${path} failed: ${textOf(done)}`);
}

const pageText = async (r: Rig, browserId: string): Promise<string> => textOf(await r.call("browser_snapshot", { browserId }, VIEW));

/** `browser_profiles` as `who` is sent it: the View's structured list, or the model's compact text. */
async function listAs(r: Rig, who: Who): Promise<Array<Record<string, unknown>>> {
	const result = await r.call("browser_profiles", {}, who);
	return Listed.parse(who.caller === "app" ? result.structuredContent : JSON.parse(textOf(result))).profiles;
}
const entry = (list: Array<Record<string, unknown>>, name: string): Record<string, unknown> | undefined => list.find((profile) => profile.name === name);

/** The refusal an agent reads: an error whose text is returned. */
function refusal(result: ToolResult): string {
	if (!result.isError) throw new Error(`expected a refusal, got: ${textOf(result).slice(0, 200)}`);
	return textOf(result);
}

const TOOK_OVER = "took over";

// ---------------------------------------------------------------------------
// Switching
// ---------------------------------------------------------------------------

describeWithChrome("switching profiles in the View", () => {
	test(
		"each profile keeps its own logins, and switching back returns the very same browser with its tabs; the session's default browser follows the latest open",
		async () => {
			const r = await rig();
			const a = await open(r, VIEW, { profile: "a", engine: "chromium" });
			await navigate(r, VIEW, a.browserId, "/set-cookie");
			// A second tab, to prove the browser left in the background keeps its tabs.
			const tabbed = await r.call("browser_act", { browserId: a.browserId, actions: [{ kind: "tab", op: "new", url: r.fixture.url("/page2") }] }, VIEW);
			expect(tabbed.isError).toBeFalsy();
			expect((await stateAs(r, VIEW)).browserId).toBe(a.browserId);

			const b = await open(r, VIEW, { profile: "b", engine: "chromium" });
			expect(b.browserId).not.toBe(a.browserId);
			// What the View reads with no browserId is the browser it opened last.
			expect((await stateAs(r, VIEW)).browserId).toBe(b.browserId);
			await navigate(r, VIEW, b.browserId, "/show-cookie");
			expect(await pageText(r, b.browserId)).toContain("COOKIE:none");

			const back = await open(r, VIEW, { profile: "a", engine: "chromium" });
			expect(back.browserId).toBe(a.browserId);
			expect(back.tabs).toHaveLength(2);
			expect(back.url).toBe(r.fixture.url("/page2"));
			expect((await stateAs(r, VIEW)).browserId).toBe(a.browserId);
			await navigate(r, VIEW, a.browserId, "/show-cookie");
			expect(await pageText(r, a.browserId)).toContain(`COOKIE:${r.fixture.cookieValue}`);

			// B never sees A's login, before or after A's tab visited the page.
			await navigate(r, VIEW, b.browserId, "/show-cookie");
			const seenByB = await pageText(r, b.browserId);
			expect(seenByB).toContain("COOKIE:none");
			expect(seenByB).not.toContain(r.fixture.cookieValue);

			// Both are still open and held by the View's seat; its own steps are never the agent working.
			const listed = await listAs(r, VIEW);
			for (const name of ["a", "b"]) expect(entry(listed, name)).toMatchObject({ heldBy: "this chat", hold: { by: "person", task: false, takenOver: false } });
			expect((await stateAs(r, VIEW, a.browserId)).agentActionAt).toBeNull();
			expect((await stateAs(r, VIEW, b.browserId)).agentActionAt).toBeNull();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a profile held in the background is refused to every other seat — in words, never its id — and is free once its holder closes it",
		async () => {
			const r = await rig();
			const a = await open(r, VIEW, { profile: "a", engine: "chromium" });
			const b = await open(r, VIEW, { profile: "b", engine: "chromium" });
			// `a` is in the background now.
			const c = await open(r, CHAT, { profile: "c" });

			for (const who of [CHAT, VIEW_TWO]) {
				const asked = refusal(await r.call("browser_open", { profile: "a" }, who));
				expect(asked).toContain("the human in the View");
				expect(asked).not.toContain(a.browserId);
			}
			expect(await failureCode(() => r.runtime.open({ profile: "a" }, { caller: "model", session: "s-chat" }))).toBe("profile_held");
			expect(await failureCode(() => r.runtime.open({ profile: "b" }, { caller: "app", session: "s-view-2" }))).toBe("profile_held");
			// An unstamped call is nobody's seat.
			expect(await failureCode(() => r.runtime.open({ profile: "a" }))).toBe("profile_held");
			// The View is told the same of a chat's browser.
			const taken = refusal(await r.call("browser_open", { profile: "c" }, VIEW));
			expect(taken).toContain("another chat");
			expect(taken).not.toContain(c.browserId);

			// A refusal disturbed nothing, and each seat sees the hold from its own side.
			expect((await stateAs(r, VIEW, a.browserId)).browserId).toBe(a.browserId);
			const asChat = await listAs(r, CHAT);
			expect([entry(asChat, "a")?.heldBy, entry(asChat, "b")?.heldBy, entry(asChat, "c")?.heldBy]).toEqual(["human", "human", "this chat"]);
			const asViewTwo = await listAs(r, VIEW_TWO);
			expect(entry(asViewTwo, "a")).toMatchObject({ heldBy: "human", hold: { by: "person", task: false, takenOver: false } });
			expect(entry(asViewTwo, "c")).toMatchObject({ heldBy: "another chat", hold: { by: "agent", task: false, takenOver: false } });

			// The holder closes the background one: the chat can have it; the other stays held.
			expect((await r.call("browser_close", { browserId: a.browserId }, VIEW)).isError).toBeFalsy();
			expect(entry(await listAs(r, CHAT), "a")?.heldBy).toBeNull();
			const adopted = await open(r, CHAT, { profile: "a" });
			expect(adopted.browserId).not.toBe(a.browserId);
			expect(entry(await listAs(r, CHAT), "a")?.heldBy).toBe("this chat");
			expect(refusal(await r.call("browser_open", { profile: "b" }, CHAT))).toContain("the human in the View");
			expect((await stateAs(r, VIEW, b.browserId)).browserId).toBe(b.browserId);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a throwaway browser is never listed as a profile, holds nothing, has no look, and the View can still take it over",
		async () => {
			const r = await rig();
			const throwaway = await open(r, CHAT, {});
			expect(throwaway.profile).toBeNull();
			const kept = await open(r, CHAT, { profile: "kept" });

			const asView = await listAs(r, VIEW);
			expect(asView.map((profile) => profile.name)).toEqual(["kept"]);
			expect(asView[0]).toMatchObject({ heldBy: "another chat", hold: { by: "agent", task: false, takenOver: false } });
			const asChat = await listAs(r, CHAT);
			expect(asChat.map((profile) => profile.name)).toEqual(["kept"]);
			expect(JSON.stringify([asView, asChat])).not.toMatch(new RegExp(`${throwaway.browserId}|ephemeral`));
			expect(await readdir(join(r.rootDir, "profiles"))).toEqual(["kept"]);

			const asPerson = await r.call("browser_state", { browserId: throwaway.browserId }, VIEW);
			expect(asPerson.structuredContent).toMatchObject({ profile: null, look: null });
			const handedOver = stateOf(await r.call("browser_control", { browserId: throwaway.browserId, mode: "take" }, VIEW));
			expect(handedOver.takenOver).toBe(true);
			// Taking a private browser over does not make it a profile, nor change the one that is.
			expect((await listAs(r, VIEW)).map((profile) => profile.name)).toEqual(["kept"]);
			expect(entry(await listAs(r, VIEW), "kept")).toMatchObject({ hold: { takenOver: false } });
			expect((await stateAs(r, CHAT, kept.browserId)).takenOver).toBe(false);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// Taking over
// ---------------------------------------------------------------------------

describeWithChrome("taking a browser over in the View", () => {
	/** A recipe the fixture site accepts: enough for `browser_publish` to get as far as the take-over check. */
	const recipe = (fixture: PublishFixture): PublishRecipe => ({
		origin: fixture.origin,
		composeUrl: fixture.url("/compose?v=nav"),
		signedIn: "#me",
		fields: [{ selector: "#text", value: "hello" }],
		submit: "#post",
		receipt: { path: "/alice/status/{digits}" },
	});

	test(
		"the person takes the wheel: the agent's actions are refused and its reads are not, the person's own input still works, and handing back gives the agent its hands again",
		async () => {
			const r = await rig();
			const startedAt = Date.now();
			await r.runtime.addProfile({ name: "Work", colour: "teal", avatar: "💼" });
			const opened = await open(r, CHAT, { profile: "work" });
			const id = opened.browserId;
			expect(opened.takenOver).toBe(false);
			expect(opened.agentActionAt).toBeNull();

			await navigate(r, CHAT, id, "/nav");
			const working = await stateAs(r, CHAT, id);
			expect(working.agentActionAt).toBeGreaterThanOrEqual(startedAt);
			expect(working.agentActionAt).toBeLessThanOrEqual(Date.now());

			// The person's chip: a model is never sent the look, the View is.
			const asModelState = await r.call("browser_state", { browserId: id }, CHAT);
			expect(Object.keys(asModelState.structuredContent ?? {})).toContain("takenOver");
			expect(Object.keys(asModelState.structuredContent ?? {})).not.toContain("look");
			expect((await r.call("browser_state", { browserId: id }, VIEW_OF_CHAT)).structuredContent).toMatchObject({ look: { label: "Work", colour: "teal", avatar: "💼" } });

			const taken = stateOf(await r.call("browser_control", { browserId: id, mode: "take" }, VIEW_OF_CHAT));
			expect(taken.takenOver).toBe(true);
			// Taking over twice is the same as once.
			expect(stateOf(await r.call("browser_control", { browserId: id, mode: "take" }, VIEW_OF_CHAT)).takenOver).toBe(true);

			// Every way an agent drives the page is refused, with words it can act on, and nothing reaches the page.
			const moves: Array<[string, Record<string, unknown>]> = [
				["browser_act", { browserId: id, actions: [{ kind: "navigate", url: r.fixture.url("/show-cookie") }] }],
				["browser_act", { browserId: id, actions: [{ kind: "click", selector: "#idle" }] }],
				["browser_act", { browserId: id, actions: [{ kind: "tab", op: "new", url: r.fixture.url("/show-cookie") }] }],
				["browser_act", { browserId: id, actions: [{ kind: "wait", text: "never", timeoutMs: 100 }] }],
				["browser_close", { browserId: id }],
				["browser_task", { browserId: id, agent: "jev", task: "do something", waitSeconds: 0 }],
			];
			for (const who of [CHAT, OTHER_CHAT, undefined]) {
				for (const [name, args] of moves) {
					const text = refusal(await r.call(name, args, who));
					expect({ name, who: who?.session, text: text.includes(TOOK_OVER) }).toEqual({ name, who: who?.session, text: true });
				}
			}
			// The same refusal at each runtime entry point, as a code.
			const navigateStep = { kind: "navigate", url: r.fixture.url("/show-cookie") } as const;
			expect(await failureCode(() => r.runtime.act(id, navigateStep, "model"))).toBe("human_driving");
			expect(await failureCode(() => r.runtime.act(id, navigateStep))).toBe("human_driving");
			expect(await failureCode(() => r.runtime.actMany(id, [navigateStep], "model"))).toBe("human_driving");
			expect(await failureCode(() => r.runtime.tab(id, { op: "new" }, "model"))).toBe("human_driving");
			expect(await failureCode(() => r.runtime.wait(id, { text: "never", timeoutMs: 100 }, "model"))).toBe("human_driving");
			expect(await failureCode(() => r.runtime.close(id, "model"))).toBe("human_driving");
			expect(await failureCode(() => r.runtime.startTask(id, { agent: "jev", task: "do something" }, "model"))).toBe("human_driving");

			// Nothing got through, and a refused attempt is not the agent working.
			expect(r.fixture.hits("/show-cookie")).toBe(0);
			const reading = await stateAs(r, CHAT, id);
			expect(reading).toMatchObject({ takenOver: true, url: working.url, agentActionAt: working.agentActionAt, tabs: working.tabs });
			// Reads stay open to the agent.
			expect(textOf(await r.call("browser_snapshot", { browserId: id }, CHAT))).toContain("nav start");

			// The person's own steps go through: the View's act, and its direct input channel, which no wheel refuses.
			await navigate(r, VIEW_OF_CHAT, id, "/show-cookie");
			expect(await pageText(r, id)).toContain("COOKIE:none");
			await navigate(r, VIEW_OF_CHAT, id, "/nav");
			const idle = Inspected.parse(await r.runtime.inspect(id, "#idle"));
			const at = { x: idle.rect.x + idle.rect.width / 2, y: idle.rect.y + idle.rect.height / 2 };
			await r.runtime.input(id, [
				{ kind: "mouse", type: "down", x: at.x, y: at.y, buttons: 1 },
				{ kind: "mouse", type: "up", x: at.x, y: at.y },
			]);
			await waitUntil("the person's click to land on the page", async () => (await stateAs(r, VIEW_OF_CHAT, id)).title, (title) => title === "idle clicked");
			expect((await stateAs(r, VIEW_OF_CHAT, id)).agentActionAt).toBe(working.agentActionAt);

			// Each side's list tells it so: the model that the human has it, the View what is going on.
			const asModel = await r.call("browser_profiles", {}, CHAT);
			const sent = Listed.parse(JSON.parse(textOf(asModel))).profiles;
			expect(sent).toEqual([{ name: "work", label: "Work", colour: "teal", heldBy: "human", sites: [] }]);
			expect(Object.keys(sent[0] ?? {})).toEqual(["name", "label", "colour", "heldBy", "sites"]);
			expect(entry(await listAs(r, OTHER_CHAT), "work")?.heldBy).toBe("human");
			expect(entry(await listAs(r, VIEW_OF_CHAT), "work")).toMatchObject({ avatar: "💼", heldBy: "this chat", hold: { by: "agent", task: false, takenOver: true } });

			// Handing back gives the agent its hands, and the same browser.
			const returned = stateOf(await r.call("browser_control", { browserId: id, mode: "return" }, VIEW_OF_CHAT));
			expect(returned).toMatchObject({ takenOver: false, browserId: id });
			expect(stateOf(await r.call("browser_control", { browserId: id, mode: "return" }, VIEW_OF_CHAT)).takenOver).toBe(false);
			expect(entry(await listAs(r, CHAT), "work")?.heldBy).toBe("this chat");
			expect(entry(await listAs(r, VIEW_OF_CHAT), "work")).toMatchObject({ hold: { takenOver: false } });
			await navigate(r, CHAT, id, "/show-cookie");
			expect(r.fixture.hits("/show-cookie")).toBe(2);
			expect((await stateAs(r, CHAT, id)).agentActionAt).toBeGreaterThan(working.agentActionAt ?? Infinity);
			// Still held by the same seat throughout: nobody else got in while it was the person's.
			expect(await failureCode(() => r.runtime.open({ profile: "work" }, { caller: "model", session: "s-other" }))).toBe("profile_held");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"only the person in the View can take the wheel or give it back; an agent asking changes nothing",
		async () => {
			const r = await rig();
			const opened = await open(r, CHAT, { profile: "w" });
			const id = opened.browserId;

			for (const who of [CHAT, OTHER_CHAT, undefined]) {
				refusal(await r.call("browser_control", { browserId: id, mode: "take" }, who));
				expect(await failureCode(() => r.runtime.control(id, "take", who?.caller))).toBe("human_only");
			}
			expect((await stateAs(r, CHAT, id)).takenOver).toBe(false);
			await navigate(r, CHAT, id, "/page2");

			stateOf(await r.call("browser_control", { browserId: id, mode: "take" }, VIEW_OF_CHAT));
			for (const who of [CHAT, OTHER_CHAT, undefined]) refusal(await r.call("browser_control", { browserId: id, mode: "return" }, who));
			expect((await stateAs(r, CHAT, id)).takenOver).toBe(true);
			refusal(await r.call("browser_act", { browserId: id, actions: [{ kind: "navigate", url: r.fixture.url("/page2") }] }, CHAT));
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"opening with an address is the caller's own page action: the person's works on a browser they took over and is not the agent working; an agent's does not get round the wheel",
		async () => {
			const r = await rig();
			const mine = await open(r, VIEW, { profile: "mine", url: r.fixture.url("/page2") });
			expect(mine.url).toBe(r.fixture.url("/page2"));
			expect(mine.agentActionAt).toBeNull();

			const theirs = await open(r, CHAT, { profile: "w" });
			stateOf(await r.call("browser_control", { browserId: theirs.browserId, mode: "take" }, VIEW_OF_CHAT));

			// The person asks their own seat for the profile again, with an address: the same browser, navigated.
			const again = await open(r, VIEW_OF_CHAT, { profile: "w", url: r.fixture.url("/show-cookie") });
			expect(again).toMatchObject({ browserId: theirs.browserId, url: r.fixture.url("/show-cookie"), takenOver: true, agentActionAt: null });

			// The agent doing the same is an agent's page action.
			expect(refusal(await r.call("browser_open", { profile: "w", url: r.fixture.url("/late") }, CHAT))).toContain(TOOK_OVER);
			expect(r.fixture.hits("/late")).toBe(0);
			expect((await stateAs(r, VIEW_OF_CHAT, theirs.browserId)).url).toBe(r.fixture.url("/show-cookie"));
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a batch the agent already sent stops between steps when the person takes over: later steps are not sent",
		async () => {
			const r = await rig();
			const opened = await open(r, CHAT, {});
			const id = opened.browserId;

			// The first step is slow on the server (2 s); the take lands while it is in flight.
			const batch = r.call(
				"browser_act",
				{ browserId: id, actions: [{ kind: "navigate", url: r.fixture.url("/slow") }, { kind: "navigate", url: r.fixture.url("/page2") }, { kind: "navigate", url: r.fixture.url("/show-cookie") }] },
				CHAT,
			);
			await waitUntil("the slow page to be requested", () => r.fixture.hits("/slow"), (hits) => hits === 1);
			const taken = stateOf(await r.call("browser_control", { browserId: id, mode: "take" }, VIEW_OF_CHAT));
			expect(taken.takenOver).toBe(true);

			const result = await batch;
			const outcome = Outcome.parse(JSON.parse(refusal(result)));
			expect(outcome).toMatchObject({ status: "failed", completed: 1, url: r.fixture.url("/slow") });
			expect(outcome.error).toContain(TOOK_OVER);
			expect(outcome.steps).toEqual([{ kind: "navigate", status: "completed" }]);
			// The steps not yet sent were not sent.
			expect(r.fixture.hits("/page2")).toBe(0);
			expect(r.fixture.hits("/show-cookie")).toBe(0);
			expect((await stateAs(r, VIEW_OF_CHAT, id)).url).toBe(r.fixture.url("/slow"));
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a post awaiting confirmation blocks taking over and opening a page in the browser — the pinned page is left as it was, for the person too — and once it is cancelled the take works and the agent's next check is refused",
		async () => {
			const r = await rig();
			const site = startPublishFixture();
			publishFixtures.push(site);
			const opened = await open(r, CHAT, { profile: "pub" });
			const id = opened.browserId;
			expect((await r.call("browser_act", { browserId: id, actions: [{ kind: "navigate", url: site.url("/login") }] }, CHAT)).isError).toBeFalsy();

			const parked = await r.call("browser_publish", { browserId: id, recipe: recipe(site), mode: "post" }, CHAT);
			expect(parked.structuredContent?.status).toBe("awaiting-confirmation");
			const publishId = String(parked.structuredContent?.publishId);
			const pinned = await stateAs(r, VIEW_OF_CHAT, id);
			expect(pinned.url).toBe(site.url("/compose?v=nav"));

			const refused = refusal(await r.call("browser_control", { browserId: id, mode: "take" }, VIEW_OF_CHAT));
			expect(refused).toContain("awaits confirmation");
			expect(await failureCode(() => r.runtime.control(id, "take", "app"))).toBe("publish_pending");
			const after = await stateAs(r, VIEW_OF_CHAT, id);
			expect(after).toMatchObject({ takenOver: false, url: pinned.url, activeTabId: pinned.activeTabId });
			expect(after.tabs).toHaveLength(pinned.tabs.length);
			expect(site.hits("/compose")).toBe(1);

			// An open with an address would navigate the pinned page by the side door: refused to the person and to the agent alike,
			// before anything is requested; an open without one is only the same browser handed back.
			const wanted = site.url("/page2");
			for (const who of [VIEW_OF_CHAT, CHAT]) {
				const opening = refusal(await r.call("browser_open", { profile: "pub", url: wanted }, who));
				expect({ who: who.caller, text: opening.includes("awaits confirmation") }).toEqual({ who: who.caller, text: true });
			}
			expect(site.hits("/page2")).toBe(0);
			expect(await stateAs(r, VIEW_OF_CHAT, id)).toMatchObject({ url: pinned.url, activeTabId: pinned.activeTabId });
			const handedBack = await open(r, VIEW_OF_CHAT, { profile: "pub" });
			expect(handedBack).toMatchObject({ browserId: id, url: pinned.url });
			const waited = await r.call("browser_publish_wait", { browserId: id, publishId, waitSeconds: 0 }, VIEW_OF_CHAT);
			expect(waited.structuredContent?.status).toBe("awaiting-confirmation");

			const cancelled = await r.call("browser_publish_cancel", { browserId: id, publishId }, VIEW_OF_CHAT);
			expect(cancelled.structuredContent?.status).toBe("cancelled");
			expect(stateOf(await r.call("browser_control", { browserId: id, mode: "take" }, VIEW_OF_CHAT)).takenOver).toBe(true);

			// A check would navigate the person's page: refused, and the compose page is not asked for again.
			expect(refusal(await r.call("browser_publish", { browserId: id, recipe: recipe(site), mode: "check" }, CHAT))).toContain(TOOK_OVER);
			expect(site.hits("/compose")).toBe(1);
			expect(site.submissions()).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	/** A site whose compose page is held until `release()`, so a post is provably mid-fill while the person reaches for the wheel. */
	function startHeldCompose(signedIn: boolean) {
		const asked = Promise.withResolvers<void>();
		const held = Promise.withResolvers<void>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname !== "/compose") return new Response("not found", { status: 404 });
				asked.resolve();
				await held.promise;
				const page = `<!doctype html><title>compose</title>${signedIn ? `<p id="me">@alice</p>` : "<p>sign in</p>"}<textarea id="text"></textarea><button id="post" type="button">Post</button>`;
				return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
			},
		});
		const origin = `http://127.0.0.1:${server.port}`;
		const recipe: PublishRecipe = { origin, composeUrl: `${origin}/compose`, signedIn: "#me", fields: [{ selector: "#text", value: "hello" }], submit: "#post", receipt: { path: "/alice/status/{digits}" } };
		return { recipe, asked: asked.promise, release: () => held.resolve(), stop: async () => void (await server.stop(true)) };
	}

	test(
		"the wheel is not on offer while a post is being filled: the take is refused, and the post then parks with nobody driving",
		async () => {
			const r = await rig();
			const site = startHeldCompose(true);
			try {
				const id = (await open(r, CHAT, { profile: "pub" })).browserId;
				const filling = r.call("browser_publish", { browserId: id, recipe: site.recipe, mode: "post" }, CHAT);
				await site.asked;

				// The agent is typing into the page and nothing is parked yet: a take now would leave the post on a page the person drives.
				expect(refusal(await r.call("browser_control", { browserId: id, mode: "take" }, VIEW_OF_CHAT))).toContain("being prepared");
				expect(await failureCode(() => r.runtime.control(id, "take", "app"))).toBe("publish_pending");
				// The state the View reads is not queued behind the fill (a queued read would wait for the page this fill is held on).
				expect((await r.runtime.liveState(id)).takenOver).toBe(false);

				site.release();
				const parked = await filling;
				expect(parked.structuredContent?.status).toBe("awaiting-confirmation");
				expect((await stateAs(r, VIEW_OF_CHAT, id)).takenOver).toBe(false);
			} finally {
				site.release();
				await site.stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a fill that ends without parking a post gives the wheel back: the person can take over once it has failed",
		async () => {
			const r = await rig();
			const site = startHeldCompose(false);
			try {
				const id = (await open(r, CHAT, { profile: "pub" })).browserId;
				const filling = r.call("browser_publish", { browserId: id, recipe: site.recipe, mode: "post" }, CHAT);
				await site.asked;
				expect(await failureCode(() => r.runtime.control(id, "take", "app"))).toBe("publish_pending");

				site.release();
				const outcome = await filling;
				expect(outcome.structuredContent?.status).not.toBe("awaiting-confirmation");
				expect(stateOf(await r.call("browser_control", { browserId: id, mode: "take" }, VIEW_OF_CHAT)).takenOver).toBe(true);
			} finally {
				site.release();
				await site.stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an agent cannot confirm a post while the person has the wheel: it stays pending and nothing is clicked, and the person's own Post still goes through",
		async () => {
			const r = await rig();
			const site = startPublishFixture();
			publishFixtures.push(site);
			const id = (await open(r, CHAT, { profile: "pub" })).browserId;
			expect((await r.call("browser_act", { browserId: id, actions: [{ kind: "navigate", url: site.url("/login") }] }, CHAT)).isError).toBeFalsy();
			stateOf(await r.call("browser_control", { browserId: id, mode: "take" }, VIEW_OF_CHAT));

			// The person, who holds the wheel, prepares the post themselves (an agent's publish is refused while they hold it).
			const parked = await r.call("browser_publish", { browserId: id, recipe: recipe(site), mode: "post" }, VIEW_OF_CHAT);
			expect(parked.structuredContent?.status).toBe("awaiting-confirmation");
			const publishId = String(parked.structuredContent?.publishId);

			expect(await failureCode(() => r.runtime.confirmPublish(id, publishId, "model"))).toBe("human_driving");
			expect(site.submissions()).toEqual([]);
			const posted = await r.call("browser_publish_confirm", { browserId: id, publishId }, VIEW_OF_CHAT);
			expect(posted.structuredContent?.status).toBe("posted");
			expect(site.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// A task on the page
// ---------------------------------------------------------------------------

// The worker is the scripted FAKE of task.test.ts (test/fake-worker): only the agent loop is replaced. It needs an interpreter:
// the pack's pinned environment, or the one named in DIM_BROWSER_PYTHON (the fake worker uses the standard library only).
const PYTHON_DIR = fileURLToPath(new URL("../python/", import.meta.url));
const FAKE_WORKER = fileURLToPath(new URL("./fake-worker/", import.meta.url));
const PYTHON = process.env.DIM_BROWSER_PYTHON?.trim() || join(PYTHON_DIR, ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
const describeTasks = chromePath === undefined || !existsSync(PYTHON) ? describe.skip : describe;
if (!existsSync(PYTHON)) console.warn(`[browser tests] ${PYTHON} is missing; the take-over-vs-task test is SKIPPED. Run: cd python && uv sync --python 3.12`);

describeTasks("taking over while a task runs", () => {
	const ENV_KEYS = ["DIM_BROWSER_PYTHON", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE"] as const;
	const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeAll(() => {
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		process.env.DIM_BROWSER_PYTHON = PYTHON;
		// See fake-worker/sitecustomize.py for why this beats the real package in cwd.
		process.env.PYTHONPATH = FAKE_WORKER;
		process.env.PYTHONDONTWRITEBYTECODE = "1";
	});

	afterAll(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test(
		"the take is refused while a task runs — the View's list says one is running — and works once the task is stopped",
		async () => {
			const r = await rig();
			const opened = await open(r, CHAT, { profile: "tasked" });
			const id = opened.browserId;
			const running = await r.call("browser_task", { browserId: id, agent: "jev", task: JSON.stringify({ steps: [{ action: "thinking", url: "" }], hold: true }), waitSeconds: 0 }, CHAT);
			expect(running.isError).toBeFalsy();
			expect(running.structuredContent).toMatchObject({ status: "running" });
			expect(entry(await listAs(r, VIEW_OF_CHAT), "tasked")).toMatchObject({ hold: { by: "agent", task: true, takenOver: false } });

			refusal(await r.call("browser_control", { browserId: id, mode: "take" }, VIEW_OF_CHAT));
			expect(await failureCode(() => r.runtime.control(id, "take", "app"))).toBe("task_running");
			expect((await stateAs(r, VIEW_OF_CHAT, id)).takenOver).toBe(false);

			const stopped = await r.call("browser_task_cancel", { browserId: id }, CHAT);
			expect(stopped.structuredContent).toMatchObject({ status: "cancelled" });
			expect(stateOf(await r.call("browser_control", { browserId: id, mode: "take" }, VIEW_OF_CHAT)).takenOver).toBe(true);
			expect(entry(await listAs(r, VIEW_OF_CHAT), "tasked")).toMatchObject({ hold: { task: false, takenOver: true } });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the wheel is not on offer while a task is starting: the take is refused as task_running mid-start, the worker then runs, and nothing was taken",
		async () => {
			const r = await rig();
			const id = (await open(r, CHAT, { profile: "tasked" })).browserId;
			// Hold the task's first look at the page (the read before its worker spawns), so the start is provably in flight.
			// Reason: test seam into the runtime's private browser map (as publish.test.ts has); the driver's own state read is what the start awaits.
			const seam = r.runtime as unknown as { byId: Map<string, { driver: { state(): Promise<unknown> } }> };
			const entryOf = seam.byId.get(id);
			if (!entryOf) throw new Error("no such browser");
			const realState = entryOf.driver.state.bind(entryOf.driver);
			const reading = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			let gated = false;
			entryOf.driver.state = async () => {
				// Only the task's first read is held; any later one (the take-over's own) goes straight through.
				if (!gated) {
					gated = true;
					reading.resolve();
					await resume.promise;
				}
				return await realState();
			};
			const starting = r.call("browser_task", { browserId: id, agent: "jev", task: JSON.stringify({ steps: [{ action: "thinking", url: "" }], hold: true }), waitSeconds: 0 }, CHAT);
			try {
				await reading.promise;
				expect(refusal(await r.call("browser_control", { browserId: id, mode: "take" }, VIEW_OF_CHAT))).toContain("starting");
				expect(await failureCode(() => r.runtime.control(id, "take", "app"))).toBe("task_running");
			} finally {
				resume.resolve();
			}

			expect((await starting).structuredContent).toMatchObject({ status: "running" });
			expect((await stateAs(r, VIEW_OF_CHAT, id)).takenOver).toBe(false);
			expect(entry(await listAs(r, VIEW_OF_CHAT), "tasked")).toMatchObject({ hold: { by: "agent", task: true, takenOver: false } });
			expect((await r.call("browser_task_cancel", { browserId: id }, CHAT)).structuredContent).toMatchObject({ status: "cancelled" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
