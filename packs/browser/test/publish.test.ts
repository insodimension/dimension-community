/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an agent posts to a real
 *  account something the human did not approve, posts it twice, types into a
 *  password field, or reports a URL that is not the post it made. Publishing
 *  may type into a signed-in compose page and park; only the human's Post in
 *  the Browser View (a call the host stamps `caller: "app"`) submits, exactly
 *  once, after re-checking that the page still shows what the human saw; the
 *  receipt is read from the page and nothing already there counts.
 *
 *  Real Chrome against a local fake site (publish-fixture.ts), driven through
 *  the real MCP server over an in-memory transport so the caller stamp is the
 *  one a host sends. The page counts field writes and submit clicks in its own
 *  title; the server counts the POSTs that actually landed.
 *
 *  The 15 s signed-in wait and the 20 s receipt wait are real-clock deadlines
 *  in publish.ts with no injection point. `racingClock` jumps `Date.now()` past
 *  them once the page has provably done everything it will do, so a test that
 *  expects "no receipt" does not sit through the real wait.
 */
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BrowserAction, PublishRecipe, PublishRecord } from "../src/contracts";
import type { EngineDriver } from "../src/engines/types";
import { confirm, prepare, validateRecipe, type Publication } from "../src/publish";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { ActionNotDispatched } from "../src/store";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, failureCode, newRuntime, perform, teardown } from "./fixture";
import { type ComposeVariant, type PublishFixture, startPublishFixture } from "./publish-fixture";

const CALLER = "ai.insodimension/caller";
const TEXT = "first line\nsecond line — ünïcødé 🚀";
const RICH = "rich line one\nrich line two 👋";
/** What an outcome that would otherwise say "nothing was posted" says once the human used the page while waiting. */
const TOUCHED = "The page was used in the Browser View while waiting, so it may have posted there. Check the account.";
const CLOSED = "The browser was closed. Nothing was submitted.";

interface ToolResult {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
}
type Call = (name: string, args: Record<string, unknown>, caller?: string) => Promise<ToolResult>;

const clients: Client[] = [];
const fixtures: PublishFixture[] = [];

afterEach(async () => {
	setSystemTime();
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	for (const fixture of fixtures.splice(0)) await fixture.stop();
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Session {
	call: Call;
	runtime: BrowserRuntime;
	browserId: string;
	fixture: PublishFixture;
}

/** The real MCP server over a real Chrome, a fresh profile, and the fake site. */
async function session(profile: string, { signIn = true } = {}): Promise<Session> {
	const fixture = startPublishFixture();
	fixtures.push(fixture);
	const rootDir = await createRoot();
	const runtime = newRuntime(rootDir);
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir });
	const client = new Client({ name: "publish-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	const call: Call = async (name, args, caller) =>
		(await client.callTool({ name, arguments: args, ...(caller === undefined ? {} : { _meta: { [CALLER]: caller } }) })) as ToolResult;
	const opened = await call("browser_open", { profile });
	expect(opened.isError).toBeFalsy();
	const browserId = opened.structuredContent?.browserId as string;
	if (signIn) await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/login") });
	return { call, runtime, browserId, fixture };
}

function recipe(fixture: PublishFixture, variant: ComposeVariant, overrides: Partial<PublishRecipe> = {}): PublishRecipe {
	return {
		origin: fixture.origin,
		composeUrl: fixture.url(`/compose?v=${variant}`),
		signedIn: "#me",
		fields: [{ selector: "#text", value: TEXT }, { selector: "#rich", value: RICH }],
		submit: "#post",
		// A path only: it matches on BOTH fixture hosts, so only the origin check can refuse the other one.
		receipt: { path: "/alice/status/{digits}" },
		...overrides,
	};
}

/** What the compose page counted in its own title. */
async function counters(runtime: BrowserRuntime, browserId: string): Promise<{ writes: number; clicks: number; secret: number }> {
	const title = (await runtime.snapshot(browserId)).text.split("\n")[0] ?? "";
	const found = /writes:(\d+) clicks:(\d+) secret:(\d+)/.exec(title);
	if (!found) throw new Error(`not on the compose page: ${title}`);
	return { writes: Number(found[1]), clicks: Number(found[2]), secret: Number(found[3]) };
}

async function post(s: Session, variant: ComposeVariant, overrides: Partial<PublishRecipe> = {}): Promise<PublishRecord> {
	const parked = await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture, variant, overrides), mode: "post" });
	expect(parked.isError).toBeFalsy();
	expect(parked.structuredContent?.status).toBe("awaiting-confirmation");
	return parked.structuredContent as unknown as PublishRecord;
}

async function record(s: Session, publishId: string): Promise<PublishRecord> {
	const waited = await s.call("browser_publish_wait", { browserId: s.browserId, publishId, waitSeconds: 0 });
	expect(waited.isError).toBeFalsy();
	return waited.structuredContent as unknown as PublishRecord;
}

/** The human's own input in the View: `browser_act` stamped "app", the only input a pending publish admits. */
async function humanAct(s: Session, action: BrowserAction): Promise<void> {
	const acted = await s.call("browser_act", { browserId: s.browserId, action }, "app");
	expect(acted.isError).toBeFalsy();
}

/**
 * The human clicks the SITE's own Post on the pinned tab while the bar waits;
 * returns once that submit landed and its receipt page loaded.
 */
async function humanPostsOnThePage(s: Session): Promise<void> {
	await humanAct(s, { kind: "click", selector: "#post" });
	await s.fixture.reached("/landed");
	expect(s.fixture.submissions()).toHaveLength(1);
}

/**
 * Settle `work`, and once `ready()` has held for `graceMs`, make `Date.now()`
 * race ahead so any real-clock deadline inside it passes within a poll. Timers
 * stay real. `ready` must name the last thing the page will ever do; the grace
 * (several of publish.ts's 250 ms polls) lets the code under test observe that
 * final page before its deadline is skipped, so skipping cannot hide an outcome.
 */
async function racingClock<T>(ready: () => boolean, work: Promise<T>, graceMs = 1_000): Promise<T> {
	const base = Date.now() - performance.now();
	let readyAt: number | undefined;
	let skip = 0;
	// A real interval, deliberately: the deadlines live in real Chrome round trips
	// that a fake timer cannot advance, and only Date.now() is jumped.
	const pump = setInterval(() => {
		if (readyAt === undefined && ready()) readyAt = performance.now();
		if (readyAt === undefined || performance.now() - readyAt < graceMs) return;
		skip += 30_000;
		setSystemTime(new Date(base + performance.now() + skip));
	}, 50);
	try {
		return await work;
	} finally {
		clearInterval(pump);
		setSystemTime();
	}
}

// ---------------------------------------------------------------------------
// Real Chrome, real MCP server
// ---------------------------------------------------------------------------

describeWithChrome("browser_publish", () => {
	test(
		"a signed-out profile is reported not-signed-in and nothing is typed or parked",
		async () => {
			const s = await session("pub-signed-out", { signIn: false });
			const result = await racingClock(
				() => s.fixture.hits("/compose") > 0,
				s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture, "nav"), mode: "post" }),
			);

			expect(result.structuredContent).toMatchObject({ status: "not-signed-in", url: s.fixture.url("/compose?v=nav"), profile: "pub-signed-out" });
			expect(await counters(s.runtime, s.browserId)).toEqual({ writes: 0, clicks: 0, secret: 0 });
			expect((await s.runtime.state(s.browserId)).publish).toBeNull();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"check reports signed-in once the login cookie is set, and types nothing",
		async () => {
			const s = await session("pub-check");
			const result = await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture, "nav"), mode: "check" });

			expect(result.structuredContent).toMatchObject({ status: "signed-in", url: s.fixture.url("/compose?v=nav"), profile: "pub-check" });
			expect(await counters(s.runtime, s.browserId)).toEqual({ writes: 0, clicks: 0, secret: 0 });
			expect((await s.runtime.state(s.browserId)).publish).toBeNull();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"post types the exact values (textarea with a newline, contenteditable), parks for the human, and submits nothing",
		async () => {
			const s = await session("pub-post");
			const parked = await post(s, "nav");

			expect(parked).toMatchObject({
				status: "awaiting-confirmation",
				origin: s.fixture.origin,
				profile: "pub-post",
				fields: [{ selector: "#text", value: TEXT }, { selector: "#rich", value: RICH }],
			});
			// The View renders its bar from the state poll: it must show the same record.
			const { state: _state, ...shown } = parked as PublishRecord & { state?: unknown };
			expect((await s.runtime.state(s.browserId)).publish).toEqual(shown);
			const seen = await counters(s.runtime, s.browserId);
			expect(seen.clicks).toBe(0);
			expect(seen.writes).toBeGreaterThan(0);
			expect(s.fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a password field fails the post before anything reaches it",
		async () => {
			const s = await session("pub-password");
			const result = await s.call("browser_publish", {
				browserId: s.browserId,
				recipe: recipe(s.fixture, "nav", { fields: [{ selector: "#secret", value: "hunter2" }] }),
				mode: "post",
			});

			expect(result.structuredContent?.status).toBe("failed");
			expect(result.structuredContent?.error).toContain("password");
			expect(await counters(s.runtime, s.browserId)).toEqual({ writes: 0, clicks: 0, secret: 0 });
			expect((await s.runtime.state(s.browserId)).publish).toBeNull();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a page that rewrites what was typed fails field-mismatch and nothing is submitted",
		async () => {
			const s = await session("pub-rewrite");
			const result = await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture, "rewrite"), mode: "post" });

			expect(result.structuredContent?.status).toBe("failed");
			expect(result.structuredContent?.error).toContain("field-mismatch");
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(0);
			expect(s.fixture.hits("/submit")).toBe(0);
			expect((await s.runtime.state(s.browserId)).publish).toBeNull();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a field changed after the human was shown it fails the confirm as changed-since-shown and nothing is submitted",
		async () => {
			const s = await session("pub-changed");
			const parked = await post(s, "nav");
			// A fresh load of the same compose URL empties the fields: changed, with no human input on the page
			// (input would make the outcome `unknown`: the human may have posted from the page).
			await humanAct(s, { kind: "navigate", url: parked.composeUrl });

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(confirmed.structuredContent?.status).toBe("failed");
			expect(confirmed.structuredContent?.error).toContain("changed since shown");
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(0);
			expect(s.fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a tab moved to another origin showing the same values fails the confirm and nothing is submitted there",
		async () => {
			const s = await session("pub-tab-left");
			const parked = await post(s, "nav");
			// Same compose page, same values, different site: not what the human approved.
			// The page prefills the values itself, so no human input touched it.
			await humanAct(s, { kind: "navigate", url: `${s.fixture.url("/compose?v=nav", "localhost")}&${new URLSearchParams({ text: TEXT, rich: RICH })}` });

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(confirmed.structuredContent?.status).toBe("failed");
			expect(confirmed.structuredContent?.error).toContain("changed since shown");
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(0);
			expect(s.fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"only an app-stamped confirm submits: none and 'model' are refused; 'app' posts once and the url is the page's navigation",
		async () => {
			const s = await session("pub-caller");
			const parked = await post(s, "nav");
			const args = { browserId: s.browserId, publishId: parked.publishId };

			for (const caller of [undefined, "model"]) {
				expect((await s.call("browser_publish_confirm", args, caller)).isError).toBe(true);
				expect((await s.call("browser_publish_cancel", args, caller)).isError).toBe(true);
			}
			expect((await record(s, parked.publishId)).status).toBe("awaiting-confirmation");
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(0);
			expect(s.fixture.hits("/submit")).toBe(0);

			const confirmed = await s.call("browser_publish_confirm", args, "app");

			expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: s.fixture.url("/alice/status/1") });
			// What landed is exactly what the human was shown.
			expect(s.fixture.submissions()).toEqual([{ text: TEXT, rich: RICH }]);
			expect(await record(s, parked.publishId)).toMatchObject({ status: "posted", url: s.fixture.url("/alice/status/1") });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a second confirm of a posted publish is refused and nothing is submitted again",
		async () => {
			const s = await session("pub-once");
			const parked = await post(s, "toast", { receipt: { ...recipe(s.fixture, "toast").receipt, linkSelector: "a.toast" } });
			const args = { browserId: s.browserId, publishId: parked.publishId };
			expect((await s.call("browser_publish_confirm", args, "app")).structuredContent?.status).toBe("posted");

			const again = await s.call("browser_publish_confirm", args, "app");

			expect(again.isError).toBe(true);
			// The toast page stays: its own click counter is the proof no second click landed.
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(1);
			expect(s.fixture.submissions()).toHaveLength(1);
			expect((await record(s, parked.publishId)).status).toBe("posted");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"with linkSelector the receipt is the NEW link's href, never a matching link already on the page",
		async () => {
			const s = await session("pub-link");
			const parked = await post(s, "stale-new", { receipt: { ...recipe(s.fixture, "stale-new").receipt, linkSelector: "a.toast" } });

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: s.fixture.url("/alice/status/1") });
			expect(s.fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"no new receipt (only a stale matching link) is unknown after exactly one submit, never retried",
		async () => {
			const s = await session("pub-stale");
			const parked = await post(s, "stale", { receipt: { ...recipe(s.fixture, "stale").receipt, linkSelector: "a.toast" } });

			const confirmed = await racingClock(
				() => s.fixture.submissions().length > 0,
				s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app"),
			);

			expect(confirmed.structuredContent?.status).toBe("unknown");
			expect(confirmed.structuredContent?.url).toBeUndefined();
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(1);
			expect(s.fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a post that lands on another origin is not a receipt: unknown, no url",
		async () => {
			const s = await session("pub-offsite");
			const parked = await post(s, "offsite");

			const confirmed = await racingClock(
				// The off-origin receipt page loaded: the tab has nowhere further to go.
				() => s.fixture.hits("/landed") > 0,
				s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app"),
			);

			expect(confirmed.structuredContent?.status).toBe("unknown");
			expect(confirmed.structuredContent?.url).toBeUndefined();
			expect(s.fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"cancel ends the publish without submitting; a confirm after it is refused",
		async () => {
			const s = await session("pub-cancel");
			const parked = await post(s, "nav");
			const args = { browserId: s.browserId, publishId: parked.publishId };

			expect((await s.call("browser_publish_cancel", args, "app")).structuredContent?.status).toBe("cancelled");
			expect((await s.call("browser_publish_confirm", args, "app")).isError).toBe(true);

			expect((await record(s, parked.publishId)).status).toBe("cancelled");
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(0);
			expect(s.fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an unconfirmed publish expires after 10 minutes; expiry is terminal and refuses confirm",
		async () => {
			const s = await session("pub-expire");
			const parked = await post(s, "nav");
			const args = { browserId: s.browserId, publishId: parked.publishId };

			setSystemTime(new Date(Date.parse(parked.expiresAt) + 1_000));
			expect((await s.call("browser_publish_confirm", args, "app")).isError).toBe(true);
			expect((await record(s, parked.publishId)).status).toBe("expired");
			setSystemTime();

			// Back inside the window, it stays expired.
			expect((await s.call("browser_publish_confirm", args, "app")).isError).toBe(true);
			expect((await record(s, parked.publishId)).status).toBe("expired");
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(0);
			expect(s.fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a second post while one awaits confirmation is refused and does not touch the page",
		async () => {
			const s = await session("pub-pending");
			const parked = await post(s, "nav");
			const writes = (await counters(s.runtime, s.browserId)).writes;

			const second = await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture, "nav"), mode: "post" });

			expect(second.isError).toBe(true);
			expect(s.fixture.hits("/compose")).toBe(1);
			expect((await counters(s.runtime, s.browserId)).writes).toBe(writes);
			expect((await record(s, parked.publishId)).status).toBe("awaiting-confirmation");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an invalid recipe is refused before the page is touched",
		async () => {
			const s = await session("pub-invalid");
			const base = recipe(s.fixture, "nav");
			const cases: Array<{ name: string; recipe: PublishRecipe }> = [
				{ name: "http on a non-loopback origin", recipe: { ...base, origin: "http://example.com", composeUrl: "http://example.com/compose" } },
				{ name: "composeUrl off the origin", recipe: { ...base, composeUrl: s.fixture.url("/compose?v=nav", "localhost") } },
				{ name: "receipt path with an unknown placeholder", recipe: { ...base, receipt: { path: "/{user}/status/{digits}" } } },
			];
			for (const row of cases) {
				const result = await s.call("browser_publish", { browserId: s.browserId, recipe: row.recipe, mode: "post" });
				expect({ name: row.name, isError: result.isError }).toEqual({ name: row.name, isError: true });
			}
			expect(s.fixture.hits("/compose")).toBe(0);
			expect((await s.runtime.state(s.browserId)).publish).toBeNull();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"while a publish awaits the human, an unstamped or model act, tab, task and check are refused publish_pending and leave the page alone; the View's app act still works",
		async () => {
			const s = await session("pub-locked");
			const parked = await post(s, "nav");
			const id = s.browserId;
			const before = await s.runtime.state(id);
			const seen = await counters(s.runtime, id);
			const calls: Array<[string, Record<string, unknown>]> = [
				["browser_act", { browserId: id, action: { kind: "type", selector: "#text", text: "not what the human saw" } }],
				["browser_tab", { browserId: id, op: "new", url: s.fixture.url("/compose?v=stay") }],
				["browser_task", { browserId: id, agent: "jev", task: "post something else", waitSeconds: 0 }],
				["browser_publish", { browserId: id, recipe: recipe(s.fixture, "stay"), mode: "check" }],
			];
			for (const caller of [undefined, "model"]) {
				for (const [name, args] of calls) {
					const refused = await s.call(name, args, caller);
					expect({ name, caller, isError: refused.isError }).toEqual({ name, caller, isError: true });
				}
			}
			// The code behind those messages, at each gated runtime entry point.
			expect(await failureCode(() => s.runtime.act(id, { kind: "type", selector: "#text", text: "x" }, "model"))).toBe("publish_pending");
			expect(await failureCode(() => s.runtime.tab(id, { op: "new" }, "model"))).toBe("publish_pending");
			expect(await failureCode(() => s.runtime.startTask(id, { agent: "jev", task: "post something else" }, "model"))).toBe("publish_pending");
			expect(await failureCode(() => s.runtime.publish(id, recipe(s.fixture, "stay"), "check", "model"))).toBe("publish_pending");

			const after = await s.runtime.state(id);
			expect({ url: after.url, activeTabId: after.activeTabId, tabs: after.tabs.length, task: after.task }).toEqual({
				url: before.url,
				activeTabId: before.activeTabId,
				tabs: before.tabs.length,
				task: null,
			});
			expect(await counters(s.runtime, id)).toEqual(seen);
			expect(s.fixture.hits("/compose")).toBe(1);
			expect((await record(s, parked.publishId)).status).toBe("awaiting-confirmation");

			await humanAct(s, { kind: "type", selector: "#rich", text: "the human's own edit" });
			expect((await counters(s.runtime, id)).writes).toBeGreaterThan(seen.writes);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"another tab showing the same compose URL and values fails the confirm as changed-since-shown and nothing is submitted",
		async () => {
			const s = await session("pub-other-tab");
			const parked = await post(s, "nav");
			expect(parked.composeUrl).toBe(s.fixture.url("/compose?v=nav"));
			const opened = await s.call("browser_tab", { browserId: s.browserId, op: "new", url: parked.composeUrl }, "app");
			expect(opened.isError).toBeFalsy();
			await humanAct(s, { kind: "type", selector: "#text", text: TEXT });
			await humanAct(s, { kind: "type", selector: "#rich", text: RICH });

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(confirmed.structuredContent?.status).toBe("failed");
			expect(confirmed.structuredContent?.error).toContain("changed since shown");
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(0);
			expect(s.fixture.submissions()).toHaveLength(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the same tab moved to another URL on the origin, showing the same values, fails the confirm and nothing is submitted",
		async () => {
			const s = await session("pub-moved");
			const parked = await post(s, "nav");
			await humanAct(s, { kind: "navigate", url: `${s.fixture.url("/compose?v=stay")}&${new URLSearchParams({ text: TEXT, rich: RICH })}` });

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(confirmed.structuredContent?.status).toBe("failed");
			expect(confirmed.structuredContent?.error).toContain("changed since shown");
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(0);
			expect(s.fixture.submissions()).toHaveLength(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"field labels reach the record the View renders; a label over 40 characters is refused before the page is touched",
		async () => {
			const s = await session("pub-labels");
			const tooLong = await s.call("browser_publish", {
				browserId: s.browserId,
				recipe: recipe(s.fixture, "nav", { fields: [{ selector: "#text", value: TEXT, label: "L".repeat(41) }] }),
				mode: "post",
			});
			expect(tooLong.isError).toBe(true);
			expect(s.fixture.hits("/compose")).toBe(0);

			const labelled = [{ selector: "#text", value: TEXT, label: "Post text" }, { selector: "#rich", value: RICH, label: "L".repeat(40) }];
			await post(s, "nav", { fields: labelled });

			expect((await s.runtime.state(s.browserId)).publish?.fields).toEqual(labelled);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a page that moves focus off the field fails the post and nothing is typed into the element that took focus",
		async () => {
			const s = await session("pub-steal");
			const result = await s.call("browser_publish", {
				browserId: s.browserId,
				recipe: recipe(s.fixture, "steal", { fields: [{ selector: "#text", value: TEXT }] }),
				mode: "post",
			});

			expect(result.structuredContent?.status).toBe("failed");
			// `#other`'s input events count as writes on this variant.
			expect(await counters(s.runtime, s.browserId)).toEqual({ writes: 0, clicks: 0, secret: 0 });
			expect((await s.runtime.state(s.browserId)).publish).toBeNull();
			expect(s.fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the human posting with the site's own button while waiting makes the bar's Post unknown (may have posted), and it never submits a second time",
		async () => {
			const s = await session("pub-touched-confirm");
			const parked = await post(s, "nav");
			await humanPostsOnThePage(s);

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(confirmed.structuredContent).toMatchObject({ status: "unknown", error: TOUCHED });
			expect(await record(s, parked.publishId)).toMatchObject({ status: "unknown", error: TOUCHED });
			expect(s.fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"cancel after the human used the page while waiting is unknown, never cancelled",
		async () => {
			const s = await session("pub-touched-cancel");
			const parked = await post(s, "nav");
			await humanPostsOnThePage(s);

			const cancelled = await s.call("browser_publish_cancel", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(cancelled.structuredContent).toMatchObject({ status: "unknown", error: TOUCHED });
			expect(s.fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"scrolling and hovering the page while waiting cannot post, so a cancel after them is still cancelled",
		async () => {
			const s = await session("pub-looked");
			const parked = await post(s, "nav");
			await humanAct(s, { kind: "scroll", deltaX: 0, deltaY: 200 });
			await humanAct(s, { kind: "hover", x: 20, y: 20 });

			const cancelled = await s.call("browser_publish_cancel", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(cancelled.structuredContent?.status).toBe("cancelled");
			expect(cancelled.structuredContent?.error).toBeUndefined();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an unstamped or model browser_close while a publish awaits the human is refused publish_pending and the browser stays open",
		async () => {
			const s = await session("pub-close-refused");
			const parked = await post(s, "nav");

			for (const caller of [undefined, "model"]) {
				const refused = await s.call("browser_close", { browserId: s.browserId }, caller);
				expect({ caller, isError: refused.isError }).toEqual({ caller, isError: true });
			}
			expect(await failureCode(() => s.runtime.close(s.browserId, "model"))).toBe("publish_pending");

			// Still open: the human's Post still posts.
			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");
			expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: s.fixture.url("/alice/status/1") });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the View closing the browser while a publish awaits settles it cancelled, so a waiter hears it at once",
		async () => {
			const s = await session("pub-close");
			const parked = await post(s, "nav");
			// Registered on the runtime before the close is queued (MCP handlers give no such ordering);
			// after the close the browserId is revoked, so only an already-waiting caller can hear the outcome.
			const waiting = s.runtime.waitPublish(s.browserId, parked.publishId, 20_000);

			expect((await s.call("browser_close", { browserId: s.browserId }, "app")).isError).toBeFalsy();

			expect(await waiting).toMatchObject({ status: "cancelled", error: CLOSED });
			expect(s.fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"closing the browser after the human typed on the page while waiting is unknown, never cancelled",
		async () => {
			const s = await session("pub-close-touched");
			const parked = await post(s, "nav");
			await humanAct(s, { kind: "type", selector: "#rich", text: "the human's own edit" });
			const waiting = s.runtime.waitPublish(s.browserId, parked.publishId, 20_000);

			expect((await s.call("browser_close", { browserId: s.browserId }, "app")).isError).toBeFalsy();

			expect(await waiting).toMatchObject({ status: "unknown", error: TOUCHED });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a site that keeps the text after its own submit: once the human pressed it while waiting, the bar's Post never clicks submit again",
		async () => {
			const s = await session("pub-touched-stay");
			const parked = await post(s, "stay");
			await humanAct(s, { kind: "click", selector: "#post" });
			await s.fixture.reached("/submit");

			// Today confirm finds the page unchanged, clicks, and waits out the real 20 s receipt deadline; jump it.
			const confirmed = await racingClock(
				() => s.fixture.submissions().length > 0,
				s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app"),
			);

			expect(confirmed.structuredContent).toMatchObject({ status: "unknown", error: TOUCHED });
			// The human's one POST, and none from the bar.
			expect(s.fixture.submissions()).toHaveLength(1);
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a textarea inside an open shadow root is filled, read back and posted",
		async () => {
			const s = await session("pub-shadow");
			const parked = await post(s, "shadow", { fields: [{ selector: "pierce/#inner", value: TEXT }] });
			expect((await counters(s.runtime, s.browserId)).writes).toBeGreaterThan(0);

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: s.fixture.url("/alice/status/1") });
			expect(s.fixture.submissions()).toEqual([{ text: TEXT, rich: "" }]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// The submit's failure classification, against a hand-written engine
// ---------------------------------------------------------------------------

/**
 * Real Chrome offers no deterministic way to make a click throw AFTER it
 * reached the page, so this drives `confirm` through a small in-memory engine
 * whose click either lands and then errors, or provably never lands.
 */
describe("confirm: a submit that errors", () => {
	const ORIGIN = "https://social.example";

	async function parkedOn(click: () => void): Promise<{ driver: EngineDriver; publication: Publication; clicks: () => number }> {
		const values = new Map<string, string>();
		let clicks = 0;
		const driver = {
			state: async () => ({ url: `${ORIGIN}/compose` }),
			perform: async (action: { kind: string }) => {
				if (action.kind !== "click") return;
				clicks++;
				click();
			},
			hasElement: async () => true,
			readField: async (selector: string) => ({ state: "value", value: values.get(selector) ?? "" }),
			fill: async (selector: string, value: string) => {
				values.set(selector, value);
			},
			linkHrefs: async () => [],
		} as unknown as EngineDriver;
		const valid = validateRecipe({
			origin: ORIGIN,
			composeUrl: `${ORIGIN}/compose`,
			signedIn: "#me",
			fields: [{ selector: "#text", value: "hello" }],
			submit: "#post",
			receipt: { path: "/alice/status/{digits}" },
		});
		const publication = await prepare(driver, "p", valid, "post");
		if (!("record" in publication)) throw new Error(`expected a parked publish, got ${publication.status}`);
		return { driver, publication, clicks: () => clicks };
	}

	test("an error after the click landed is unknown, with exactly one click", async () => {
		const { driver, publication, clicks } = await parkedOn(() => {
			throw new Error("target closed mid-click");
		});
		await confirm(driver, publication);
		expect(publication.record.status).toBe("unknown");
		expect(publication.record.url).toBeUndefined();
		expect(clicks()).toBe(1);
	});

	test("a click that provably never landed is failed, with nothing retried", async () => {
		const { driver, publication, clicks } = await parkedOn(() => {
			throw new ActionNotDispatched("no_element", "submit is not on the page");
		});
		await confirm(driver, publication);
		expect(publication.record.status).toBe("failed");
		expect(clicks()).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// receipt.path: a template over the receipt URL's pathname, on the origin
// ---------------------------------------------------------------------------

describe("receipt.path", () => {
	const ORIGIN = "https://social.example";
	const base: PublishRecipe = {
		origin: ORIGIN,
		composeUrl: `${ORIGIN}/compose`,
		signedIn: "#me",
		fields: [{ selector: "#text", value: "hello" }],
		submit: "#post",
		receipt: { path: "/{segment}/status/{digits}" },
	};
	const matcher = (path: string): ((pathname: string) => boolean) => validateRecipe({ ...base, receipt: { path } }).matchesPath;

	/** Park on an in-memory page, submit, and let `links` appear: the receipt `confirm` reads from them. */
	async function receiptAmong(links: string[]): Promise<PublishRecord> {
		const values = new Map<string, string>();
		let clicked = false;
		const driver = {
			state: async () => ({ url: `${ORIGIN}/compose`, activeTabId: "tab-1" }),
			perform: async (action: { kind: string }) => {
				if (action.kind === "click") clicked = true;
			},
			hasElement: async () => true,
			readField: async (selector: string) => ({ state: "value", value: values.get(selector) ?? "" }),
			fill: async (selector: string, value: string) => {
				values.set(selector, value);
			},
			linkHrefs: async () => (clicked ? links : []),
		} as unknown as EngineDriver;
		const publication = await prepare(driver, "p", validateRecipe({ ...base, receipt: { ...base.receipt, linkSelector: "a.toast" } }), "post");
		if (!("record" in publication)) throw new Error(`expected a parked publish, got ${publication.status}`);
		await confirm(driver, publication);
		return publication.record;
	}

	test("the receipt is the first link whose pathname matches on the origin; query and hash are ignored, and neither can smuggle a match", async () => {
		const real = `${ORIGIN}/alice/status/7?ref=share#top`;
		const decoys = [
			{ name: "the path in the query", href: `${ORIGIN}/search?next=/alice/status/8` },
			{ name: "the path in the hash", href: `${ORIGIN}/#/alice/status/9` },
			{ name: "another origin", href: "https://elsewhere.example/alice/status/10" },
			{ name: "another port", href: "https://social.example:8443/alice/status/11" },
			{ name: "a trailing segment", href: `${ORIGIN}/alice/status/12/likes` },
			{ name: "a leading segment", href: `${ORIGIN}/x/alice/status/13` },
			{ name: "a 5000+ character href", href: `${ORIGIN}/alice/status/${"1".repeat(5_000)}` },
		];
		for (const decoy of decoys) {
			const settled = await receiptAmong([decoy.href, real]);
			expect({ name: decoy.name, status: settled.status, url: settled.url }).toEqual({ name: decoy.name, status: "posted", url: real });
		}
	});

	test("literal text matches only itself, and placeholders stay inside their segment", () => {
		const rows = [
			{ name: "a literal dot is a dot", path: "/p/{digits}.html", pathname: "/p/12.html", match: true },
			{ name: "a literal dot is not any character", path: "/p/{digits}.html", pathname: "/p/12xhtml", match: false },
			{ name: "literal regex syntax matches itself", path: "/(a+)+b/{digits}", pathname: "/(a+)+b/7", match: true },
			{ name: "literal regex syntax is not a group", path: "/(a+)+b/{digits}", pathname: "/aab/7", match: false },
			{ name: "a literal bar is not alternation", path: "/a|b/{digits}", pathname: "/a", match: false },
			{ name: "{segment} is one segment", path: "/{segment}/status/{digits}", pathname: "/alice/status/7", match: true },
			{ name: "{segment} never crosses a slash", path: "/{segment}/status/{digits}", pathname: "/a/b/status/7", match: false },
			{ name: "{digits} is digits only", path: "/{segment}/status/{digits}", pathname: "/alice/status/7a", match: false },
			{ name: "anchored at the start", path: "/alice/status/{digits}", pathname: "/x/alice/status/7", match: false },
			{ name: "anchored at the end", path: "/alice/status/{digits}", pathname: "/alice/status/7/likes", match: false },
		];
		for (const row of rows) {
			expect({ name: row.name, match: matcher(row.path)(row.pathname) }).toEqual({ name: row.name, match: row.match });
		}
	});

	test("a 5000+ character pathname gets the right answer, even against a template spelled like a catastrophic regex", () => {
		// JavaScriptCore caps regex backtracking and then reports NO match, so a
		// super-linear compile shows up here as a wrong `false`, not as a hang.
		const a = "a".repeat(5_000);
		const digits = "1".repeat(5_000);
		const rows = [
			{ name: "segment then digits", path: "/{segment}/{digits}", pathname: `/${a}/${digits}`, match: true },
			{ name: "segment then digits, one stray letter", path: "/{segment}/{digits}", pathname: `/${a}/${digits}x`, match: false },
			{ name: "a placeholder then a literal", path: "/{segment}x", pathname: `/${a}x`, match: true },
			{ name: "a placeholder missing its literal", path: "/{segment}x", pathname: `/${a}`, match: false },
			{ name: "nested-quantifier spelling, literal", path: "/(a+)+b/{digits}", pathname: `/(a+)+b/${digits}`, match: true },
			{ name: "nested-quantifier spelling, attack input", path: "/(a+)+b/{digits}", pathname: `/${a}!`, match: false },
		];
		for (const row of rows) {
			expect({ name: row.name, match: matcher(row.path)(row.pathname) }).toEqual({ name: row.name, match: row.match });
		}
	});

	test("an invalid template or label is refused as bad_recipe", async () => {
		const rows: Array<{ name: string; recipe: PublishRecipe }> = [
			{ name: "unknown placeholder", recipe: { ...base, receipt: { path: "/{user}/status/{digits}" } } },
			{ name: "no leading slash", recipe: { ...base, receipt: { path: "alice/status/{digits}" } } },
			{ name: "two placeholders in a segment", recipe: { ...base, receipt: { path: "/{segment}{digits}/status" } } },
			{ name: "an Object.prototype key as a placeholder", recipe: { ...base, receipt: { path: "/{constructor}/status/{digits}" } } },
			{ name: "an unmatched brace", recipe: { ...base, receipt: { path: "/a{b/{digits}" } } },
			{ name: "a path over 256 characters", recipe: { ...base, receipt: { path: `/${"a".repeat(256)}` } } },
			{ name: "a label over 40 characters", recipe: { ...base, fields: [{ selector: "#text", value: "hello", label: "L".repeat(41) }] } },
			{ name: "a blank label", recipe: { ...base, fields: [{ selector: "#text", value: "hello", label: "   " }] } },
		];
		for (const row of rows) {
			const code = await failureCode(async () => validateRecipe(row.recipe));
			expect({ name: row.name, code }).toEqual({ name: row.name, code: "bad_recipe" });
		}
	});
});
