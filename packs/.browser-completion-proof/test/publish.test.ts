/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an agent posts to a real
 *  account something other than what was filled and shown, posts it twice,
 *  types into a password field, or reports a URL that is not the post it made.
 *  Publishing may type into a signed-in compose page and park; one confirm —
 *  the model's `browser_publish_confirm` or the View's Post (the same tool) —
 *  submits, exactly once, after re-checking that the page still shows what the
 *  View showed; the receipt is read from the page and nothing already there
 *  counts. While it is parked, only the View (`caller: "app"`) may drive the
 *  pinned page.
 *
 *  Only a post a human approved on the campaign board goes out, so every post
 *  here is approved first (`approvePublish` writes the board's record), and the
 *  tests at the end prove that gate against a real page.
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
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ARTIFACTORY_HOST_CONTEXT_EXTENSION_ID, ARTIFACTORY_HOST_CONTEXT_META_KEY, ARTIFACTORY_HOST_CONTEXT_READ_METHOD } from "@dimension/sdk/artifactory";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import puppeteer, { Frame, type Browser, type WaitForSelectorOptions } from "puppeteer-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BrowserAction, PublishRecipe, PublishRecord } from "../src/contracts";
import type { EngineDriver } from "../src/engines/types";
import { createPuppeteerDriver } from "../src/engines/puppeteer";
import { confirm, prepare, validateRecipe, type Publication } from "../src/publish";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { ActionNotDispatched } from "../src/store";
import { approvePublish, BROWSER_TEST_TIMEOUT_MS, chromePath, createRoot, describeWithChrome, failureCode, newRuntime, perform, racingClock, teardown } from "./fixture";
import { type ComposeVariant, type PublishFixture, startPublishFixture } from "./publish-fixture";
import { withJevKey } from "./jev-key";

withJevKey();

const CALLER = "ai.insodimension/caller";
const TEXT = "first line\nsecond line — ünïcødé 🚀";
const RICH = "rich line one\nrich line two 👋";
/** What an outcome that would otherwise say "nothing was posted" says once the human used the page while waiting. */
const TOUCHED = "The page was used in the Browser View while waiting, so it may have posted there. Check the account.";
const CLOSED = "The browser was closed. Nothing was submitted.";
/** The same, on the relay: the human's own Chrome, where the page can be used outside the View. */
const SHARED = "This page is in your own Chrome, where it can be used outside the Browser View, so it may have posted there. Check the account.";

interface ToolResult {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
}
type Call = (name: string, args: Record<string, unknown>, caller?: string) => Promise<ToolResult>;

const clients: Client[] = [];
const fixtures: PublishFixture[] = [];
const nativeDrivers: EngineDriver[] = [];
/** Stand-ins for the human's own Chrome, which the relay engine attaches to. */
const humanChromes: Browser[] = [];

afterEach(async () => {
	for (const driver of nativeDrivers.splice(0)) await driver.close().catch(() => undefined);
	setSystemTime();
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	for (const fixture of fixtures.splice(0)) await fixture.stop();
	await teardown();
	// The runtime detaches first; only then does the human's Chrome go away.
	for (const chrome of humanChromes.splice(0)) await chrome.close().catch(() => undefined);
}, BROWSER_TEST_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Session {
	call: Call;
	client: Client;
	runtime: BrowserRuntime;
	browserId: string;
	fixture: PublishFixture;
	rootDir: string;
	profile: string;
}

/**
 * The real MCP server over a real Chrome, a fresh profile, and the fake site.
 * `relay` attaches the chrome-relay engine to a separately launched Chrome
 * standing in for the human's own, on its one reserved profile.
 */
async function session(profile: string, { signIn = true, relay = false } = {}): Promise<Session> {
	const fixture = startPublishFixture();
	fixtures.push(fixture);
	const rootDir = await createRoot();
	const runtime = newRuntime(rootDir, relay ? { relayUrl: await launchHumanChrome() } : {});
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir });
	const client = new Client({ name: "publish-test", version: "0.0.0" }, { capabilities: { extensions: { [ARTIFACTORY_HOST_CONTEXT_EXTENSION_ID]: {} } } });
	const sessionId = "publish-chat";
	const token = randomBytes(32).toString("hex");
	client.setRequestHandler(z.object({ method: z.literal(ARTIFACTORY_HOST_CONTEXT_READ_METHOD), params: z.object({ sessionId: z.string(), token: z.string() }) }), async request => {
		if (request.params.sessionId !== sessionId || request.params.token !== token) throw new Error("Unknown host context");
		return { active: true, sessionId };
	});
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	const call: Call = async (name, args, caller) =>
		(await client.callTool({ name, arguments: args, _meta: {
			...(caller === undefined ? {} : { [CALLER]: caller }),
			"ai.insodimension/session": { sessionId },
			[ARTIFACTORY_HOST_CONTEXT_META_KEY]: { sessionId, token },
		} })) as ToolResult;
	const opened = await call("browser_open", { profile, ...(relay ? { engine: "chrome-relay" } : {}) });
	expect(opened.isError).toBeFalsy();
	const browserId = opened.structuredContent?.browserId as string;
	if (signIn) await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/login") });
	return { call, client, runtime, browserId, fixture, rootDir, profile };
}

/** A headless Chrome on a throwaway profile with a DevTools port: the endpoint the relay engine attaches to. */
async function launchHumanChrome(): Promise<string> {
	const chrome = await puppeteer.launch({ executablePath: chromePath, headless: true, args: ["--no-first-run", "--no-default-browser-check"] });
	humanChromes.push(chrome);
	return `http://127.0.0.1:${new URL(chrome.wsEndpoint()).port}`;
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

/** The board's approval of exactly the text `posting` types, for the profile `s` opened. */
async function approve(s: Session, posting: PublishRecipe): Promise<void> {
	await approvePublish(s.rootDir, { origin: posting.origin, profile: s.profile, values: posting.fields.map((field) => field.value) });
}

/** The board approves what `variant` types, then a post of it is asked for: whatever comes back. */
async function requestPost(s: Session, variant: ComposeVariant, overrides: Partial<PublishRecipe> = {}): Promise<ToolResult> {
	const posting = recipe(s.fixture, variant, overrides);
	await approve(s, posting);
	return await s.call("browser_publish", { browserId: s.browserId, recipe: posting, mode: "post" });
}

async function post(s: Session, variant: ComposeVariant, overrides: Partial<PublishRecipe> = {}): Promise<PublishRecord> {
	const parked = await requestPost(s, variant, overrides);
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
	const acted = await s.call("browser_act", { browserId: s.browserId, actions: [action] }, "app");
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

/** The middle of `selector` in page pixels, where the View's mouse would aim. */
async function centerOf(s: Session, selector: string): Promise<{ x: number; y: number }> {
	const box = await s.runtime.inspect(s.browserId, selector);
	if (!box.found) throw new Error(`no ${selector} on the page`);
	return { x: box.rect.x + box.rect.width / 2, y: box.rect.y + box.rect.height / 2 };
}

/** One left click as the View's direct channel sends it. */
const pressAt = ({ x, y }: { x: number; y: number }) => [
	{ kind: "mouse", type: "down", x, y, buttons: 1 },
	{ kind: "mouse", type: "up", x, y },
];

/**
 * The browser's driver, whose `input` and `state` a test can hold or fail: the only way to stand at an exact point of a press (the real
 * calls are a few milliseconds).
 */
type DriverSeam = { input: EngineDriver["input"]; state: EngineDriver["state"] };
function driverOf(runtime: BrowserRuntime, browserId: string): DriverSeam {
	// Reason: test seam into the runtime's private map (as `entryOf` in wait-inspect.test.ts).
	const seam = runtime as unknown as { byId: Map<string, { driver: DriverSeam }> };
	const entry = seam.byId.get(browserId);
	if (!entry) throw new Error("no such browser");
	return entry.driver;
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
				requestPost(s, "nav"),
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
			// The View renders its bar from the state its stream carries: it must show the same record.
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
			const result = await requestPost(s, "nav", { fields: [{ selector: "#secret", value: "hunter2" }] });

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
			const result = await requestPost(s, "rewrite");

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
		"the model confirms a pending publish: exactly one submit, and the url is the one the page navigated to",
		async () => {
			const s = await session("pub-model-confirm");
			const parked = await post(s, "nav");
			expect(s.fixture.hits("/submit")).toBe(0);
			// The host shows the model every tool not marked app-only: confirm and cancel are not.
			const tools = (await s.client.listTools()).tools.filter((t) => t.name === "browser_publish_confirm" || t.name === "browser_publish_cancel");
			expect(tools.map((t) => ({ name: t.name, visibility: (t._meta?.ui as { visibility?: unknown } | undefined)?.visibility }))).toEqual([
				{ name: "browser_publish_confirm", visibility: undefined },
				{ name: "browser_publish_cancel", visibility: undefined },
			]);
			// The host asks the human before every call of a tool marked "prompt", yolo included: the Allow card is the gate.
			expect(tools[0]?._meta?.["ai.insodimension/approval"]).toBe("prompt");

			const shown = { origin: parked.origin, profile: parked.profile, values: parked.fields.map((field) => field.value) };
			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId, expect: shown }, "model");

			expect(confirmed.isError).toBeFalsy();
			expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: s.fixture.url("/alice/status/1") });
			// What landed is exactly what was filled and shown, once.
			expect(s.fixture.submissions()).toEqual([{ text: TEXT, rich: RICH }]);
			expect(s.fixture.hits("/submit")).toBe(1);
			expect(await record(s, parked.publishId)).toMatchObject({ status: "posted", url: s.fixture.url("/alice/status/1") });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a model confirm without expect is refused expect_required, clicks nothing, and leaves the publish pending",
		async () => {
			const s = await session("pub-model-no-expect");
			const parked = await post(s, "nav");

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "model");

			expect(confirmed.isError).toBe(true);
			expect(confirmed.content[0]?.text).toContain("expect_required");
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(0);
			expect(s.fixture.hits("/submit")).toBe(0);
			expect((await record(s, parked.publishId)).status).toBe("awaiting-confirmation");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a model confirm whose expect differs in one of origin, profile, or a value is refused publish_mismatch and does not consume the publish",
		async () => {
			const s = await session("pub-model-mismatch");
			const parked = await post(s, "nav");
			const shown = { origin: parked.origin, profile: parked.profile, values: parked.fields.map((field) => field.value) };
			const args = { browserId: s.browserId, publishId: parked.publishId };
			const differing = [
				{ name: "origin", expect: { ...shown, origin: s.fixture.origin.replace("127.0.0.1", "localhost") } },
				{ name: "profile", expect: { ...shown, profile: "someone-else" } },
				{ name: "values[1]", expect: { ...shown, values: [TEXT, `${RICH} `] } },
			];

			for (const row of differing) {
				const refused = await s.call("browser_publish_confirm", { ...args, expect: row.expect }, "model");
				expect({ row: row.name, isError: refused.isError, text: refused.content[0]?.text }).toMatchObject({
					row: row.name,
					isError: true,
					text: expect.stringContaining(`publish_mismatch: expect does not match the pending publish (mismatched: ${row.name})`),
				});
				expect((await counters(s.runtime, s.browserId)).clicks).toBe(0);
				expect(s.fixture.hits("/submit")).toBe(0);
				expect((await record(s, parked.publishId)).status).toBe("awaiting-confirmation");
			}

			const confirmed = await s.call("browser_publish_confirm", { ...args, expect: shown }, "model");

			expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: s.fixture.url("/alice/status/1") });
			expect(s.fixture.submissions()).toEqual([{ text: TEXT, rich: RICH }]);
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
		"a pierce/ linkSelector finds the receipt link inside an open shadow root",
		async () => {
			const s = await session("pub-link-shadow");
			const parked = await post(s, "shadow-toast", { receipt: { ...recipe(s.fixture, "shadow-toast").receipt, linkSelector: "pierce/a.toast" } });

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
		"the model's cancel ends the publish without submitting; a confirm after it is refused",
		async () => {
			const s = await session("pub-cancel");
			const parked = await post(s, "nav");
			const args = { browserId: s.browserId, publishId: parked.publishId };

			expect((await s.call("browser_publish_cancel", args, "model")).structuredContent?.status).toBe("cancelled");
			expect((await s.call("browser_publish_confirm", args, "model")).isError).toBe(true);

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
				["browser_act", { browserId: id, actions: [{ kind: "type", selector: "#text", text: "not what the human saw" }] }],
				["browser_act", { browserId: id, actions: [{ kind: "tab", op: "new", url: s.fixture.url("/compose?v=stay") }] }],
				["browser_task", { browserId: id, task: "post something else", waitSeconds: 0 }],
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
			// One refusal for a whole batch, before any of its steps reaches the page.
			expect(await failureCode(() => s.runtime.actMany(id, [{ kind: "type", selector: "#text", text: "x" }, { kind: "click", selector: "#post" }], "model"))).toBe("publish_pending");
			expect(await failureCode(() => s.runtime.startTask(id, { task: "post something else" }, "model"))).toBe("publish_pending");
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
			const opened = await s.call("browser_act", { browserId: s.browserId, actions: [{ kind: "tab", op: "new", url: parked.composeUrl }] }, "app");
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
			const result = await requestPost(s, "steal", { fields: [{ selector: "#text", value: TEXT }] });

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
		"the human clicking the site's own Post on the direct channel, while the bar waits, is the same: the bar's Post is unknown and submits nothing more; hover and wheel on it change nothing",
		async () => {
			const s = await session("pub-touched-direct");
			const parked = await post(s, "nav");
			const { x, y } = await centerOf(s, "#post");

			await s.runtime.input(s.browserId, [{ kind: "mouse", type: "move", x, y }, { kind: "wheel", x, y, deltaX: 0, deltaY: 10 }]);
			expect(await record(s, parked.publishId)).toMatchObject({ status: "awaiting-confirmation" });

			await s.runtime.input(s.browserId, [{ kind: "mouse", type: "down", x, y, buttons: 1 }, { kind: "mouse", type: "up", x, y }]);
			await s.fixture.reached("/landed");
			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(confirmed.structuredContent).toMatchObject({ status: "unknown", error: TOUCHED });
			expect(s.fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"while the bar's Post is submitting, the human's click, key and mouse move on the page are refused publish_pending and never reach it; input works again once the Post settles",
		async () => {
			const s = await session("pub-confirming-input");
			const parked = await post(s, "stay");
			const at = await centerOf(s, "#post");
			const confirming = s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");
			// A failed assertion below ends the test with this call still open; its rejection at teardown is not the failure.
			confirming.catch(() => undefined);
			// The bar clicked submit and the site keeps its text, so the Post now waits for a receipt that is not coming.
			await s.fixture.reached("/submit");

			expect(await failureCode(() => s.runtime.input(s.browserId, pressAt(at)))).toBe("publish_pending");
			expect(await failureCode(() => s.runtime.input(s.browserId, [{ kind: "key", type: "down", key: "Enter", code: "Enter", keyCode: 13 }]))).toBe("publish_pending");
			expect(await failureCode(() => s.runtime.input(s.browserId, [{ kind: "mouse", type: "move", ...at }]))).toBe("publish_pending");

			const confirmed = await racingClock(() => true, confirming);
			expect(confirmed.structuredContent).toMatchObject({ status: "unknown" });
			expect(confirmed.structuredContent?.error).not.toBe(TOUCHED);
			// The bar's one click is the only one the page ever saw.
			expect(s.fixture.submissions()).toHaveLength(1);
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(1);

			await s.runtime.input(s.browserId, pressAt(at));
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(2);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a press still being sent when the bar's Post starts already counts: the Post never clicks submit, and the human's press is the only post",
		async () => {
			const s = await session("pub-press-in-flight");
			const parked = await post(s, "nav");
			const at = await centerOf(s, "#post");
			const driver = driverOf(s.runtime, s.browserId);
			const send = driver.input.bind(driver);
			const sending = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			driver.input = async (events) => {
				sending.resolve();
				await release.promise;
				await send(events);
			};
			const press = s.runtime.input(s.browserId, pressAt(at));
			try {
				await sending.promise;
				const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");
				expect(confirmed.structuredContent).toMatchObject({ status: "unknown", error: TOUCHED });
			} finally {
				release.resolve();
				await press.catch(() => undefined);
			}
			await press;
			await s.fixture.reached("/landed");
			expect(s.fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a press that is still reading the page's state when the bar's Post starts is refused publish_pending, and never reaches the page",
		async () => {
			const s = await session("pub-press-state-read");
			const parked = await post(s, "stay");
			const at = await centerOf(s, "#post");
			const driver = driverOf(s.runtime, s.browserId);
			const read = driver.state.bind(driver);
			const reading = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			// Only the press's own read is held; the Post's reads go straight through.
			driver.state = async () => {
				driver.state = read;
				reading.resolve();
				await release.promise;
				return await read();
			};
			const press = s.runtime.input(s.browserId, pressAt(at));
			press.catch(() => undefined);
			await reading.promise;
			const confirming = s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");
			confirming.catch(() => undefined);
			// The Post found the page untouched and clicked submit; the site keeps its text, so it now waits for a receipt.
			await s.fixture.reached("/submit");
			release.resolve();

			expect(await failureCode(() => press)).toBe("publish_pending");

			const confirmed = await racingClock(() => true, confirming);
			expect(confirmed.structuredContent).toMatchObject({ status: "unknown" });
			expect(s.fixture.submissions()).toHaveLength(1);
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a press the browser provably never received leaves the publish untouched: the bar's Post still posts, once",
		async () => {
			const s = await session("pub-press-refused");
			const parked = await post(s, "nav");
			const at = await centerOf(s, "#post");
			driverOf(s.runtime, s.browserId).input = async () => {
				throw new ActionNotDispatched("unknown_tab", "no active tab");
			};
			expect(await failureCode(() => s.runtime.input(s.browserId, pressAt(at)))).toBe("unknown_tab");

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: s.fixture.url("/alice/status/1") });
			expect(s.fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a press that errors after it may have reached the page keeps the publish touched: the Post is unknown and clicks nothing",
		async () => {
			const s = await session("pub-press-errored");
			const parked = await post(s, "nav");
			const at = await centerOf(s, "#post");
			driverOf(s.runtime, s.browserId).input = async () => {
				throw new Error("target closed mid-press");
			};
			const sent = await s.runtime.input(s.browserId, pressAt(at)).catch((error: unknown) => error);
			expect(sent).toEqual(new Error("target closed mid-press"));

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(confirmed.structuredContent).toMatchObject({ status: "unknown", error: TOUCHED });
			expect(s.fixture.submissions()).toHaveLength(0);
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

	test(
		"a shadow-root page that moves focus off the field to another element in the same root fails the post and nothing is typed there",
		async () => {
			const s = await session("pub-shadow-steal");
			const result = await requestPost(s, "shadow-steal", { fields: [{ selector: "pierce/#inner", value: TEXT }] });

			expect(result.structuredContent?.status).toBe("failed");
			// `#decoy`'s input events count as writes: the document's own activeElement is the host either way.
			expect(await counters(s.runtime, s.browserId)).toEqual({ writes: 0, clicks: 0, secret: 0 });
			expect((await s.runtime.state(s.browserId)).publish).toBeNull();
			expect(s.fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"on chrome-relay, a cancel is unknown with the shared-page error, never cancelled, and nothing is submitted",
		async () => {
			const s = await session("relay", { relay: true });
			const parked = await post(s, "nav");

			const cancelled = await s.call("browser_publish_cancel", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(cancelled.structuredContent).toMatchObject({ status: "unknown", error: SHARED });
			expect(await record(s, parked.publishId)).toMatchObject({ status: "unknown", error: SHARED });
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(0);
			expect(s.fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"on chrome-relay, a page changed since shown is unknown with the shared-page error, and nothing is submitted",
		async () => {
			const s = await session("relay", { relay: true });
			const parked = await post(s, "nav");
			await humanAct(s, { kind: "navigate", url: parked.composeUrl });

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(confirmed.structuredContent).toMatchObject({ status: "unknown", error: SHARED });
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(0);
			expect(s.fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"on chrome-relay, the bar's Post still posts, clicking submit exactly once",
		async () => {
			const s = await session("relay", { relay: true });
			const parked = await post(s, "toast", { receipt: { ...recipe(s.fixture, "toast").receipt, linkSelector: "a.toast" } });

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: s.fixture.url("/alice/status/1") });
			// The toast page stays, so its own counter shows the one click.
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(1);
			expect(s.fixture.submissions()).toEqual([{ text: TEXT, rich: RICH }]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	// -----------------------------------------------------------------------
	// Board approvals: only a post a human approved goes out
	// -----------------------------------------------------------------------

	test(
		"text nobody approved never reaches the page: refused publish_unapproved, the compose page's own counters stay 0 and it is not even reloaded",
		async () => {
			const s = await session("pub-unapproved");
			// Stand on the compose page first: its own counters then say whether anything was typed or clicked there.
			await perform(s.runtime, s.browserId, { kind: "navigate", url: s.fixture.url("/compose?v=nav") });
			const loads = s.fixture.hits("/compose");

			const refused = await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture, "nav"), mode: "post" });

			expect(refused.isError).toBe(true);
			expect(refused.content[0]?.text).toContain("publish_unapproved: no board approval covers");
			expect(await counters(s.runtime, s.browserId)).toEqual({ writes: 0, clicks: 0, secret: 0 });
			expect(s.fixture.hits("/compose")).toBe(loads);
			expect(s.fixture.hits("/submit")).toBe(0);
			expect((await s.runtime.state(s.browserId)).publish).toBeNull();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an approved post posts exactly once, and a replay of the same text is refused 'already used' before the page is opened",
		async () => {
			const s = await session("pub-approved-once");
			const parked = await post(s, "nav");
			const shown = { origin: parked.origin, profile: parked.profile, values: parked.fields.map((field) => field.value) };

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId, expect: shown }, "model");

			expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: s.fixture.url("/alice/status/1") });
			expect(s.fixture.submissions()).toEqual([{ text: TEXT, rich: RICH }]);
			const loads = s.fixture.hits("/compose");

			const replay = await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture, "nav"), mode: "post" });

			expect(replay.isError).toBe(true);
			expect(replay.content[0]?.text).toContain("publish_unapproved");
			expect(replay.content[0]?.text).toContain("already used");
			expect(s.fixture.hits("/compose")).toBe(loads);
			expect(s.fixture.hits("/submit")).toBe(1);
			expect(s.fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an edit of the approved text between approval and park is refused before the page is touched, and the approved text still parks",
		async () => {
			const s = await session("pub-edited");
			await approve(s, recipe(s.fixture, "nav"));
			const edited = recipe(s.fixture, "nav", { fields: [{ selector: "#text", value: `${TEXT}!` }, { selector: "#rich", value: RICH }] });

			const refused = await s.call("browser_publish", { browserId: s.browserId, recipe: edited, mode: "post" });

			expect(refused.isError).toBe(true);
			expect(refused.content[0]?.text).toContain("publish_unapproved: no board approval covers");
			expect(s.fixture.hits("/compose")).toBe(0);
			expect((await s.runtime.state(s.browserId)).publish).toBeNull();
			// The refused edit spent nothing: the text the human approved parks.
			const parked = await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture, "nav"), mode: "post" });
			expect(parked.structuredContent?.status).toBe("awaiting-confirmation");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the View's Post spends the approval too: the agent cannot post the text the human just posted",
		async () => {
			const s = await session("pub-view-post");
			const parked = await post(s, "nav");

			const confirmed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(confirmed.structuredContent).toMatchObject({ status: "posted", url: s.fixture.url("/alice/status/1") });
			expect(s.fixture.submissions()).toHaveLength(1);
			const again = await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture, "nav"), mode: "post" });
			expect(again.isError).toBe(true);
			expect(again.content[0]?.text).toContain("already used");
			expect(s.fixture.submissions()).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a page that changed since it was shown settles failed and keeps the approval: the same text parks again, unapproved anew, and posts",
		async () => {
			const s = await session("pub-changed-keeps");
			const parked = await post(s, "nav");
			await humanAct(s, { kind: "navigate", url: parked.composeUrl });

			const failed = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.publishId }, "app");

			expect(failed.structuredContent?.status).toBe("failed");
			expect(failed.structuredContent?.error).toContain("changed since shown");
			expect((await counters(s.runtime, s.browserId)).clicks).toBe(0);
			expect(s.fixture.hits("/submit")).toBe(0);
			const again = await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture, "nav"), mode: "post" });
			expect(again.structuredContent?.status).toBe("awaiting-confirmation");

			const posted = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: again.structuredContent?.publishId as string }, "app");

			expect(posted.structuredContent).toMatchObject({ status: "posted", url: s.fixture.url("/alice/status/1") });
			expect(s.fixture.submissions()).toEqual([{ text: TEXT, rich: RICH }]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

// The hand-written publication engine below proves outcome mapping. These
// exercise the Chrome dispatch boundary itself, where a selector can resolve
// after the authority under which the action began has disappeared.
describeWithChrome("native publish authority at dispatch", () => {
	async function nativePage(): Promise<{ driver: EngineDriver; fixture: PublishFixture }> {
		const fixture = startPublishFixture();
		fixtures.push(fixture);
		const driver = await createPuppeteerDriver("chromium", {
			profileDirectory: await createRoot(),
			viewport: { width: 900, height: 700 },
			headless: true,
			executablePath: chromePath,
			onClosed: () => undefined,
		});
		nativeDrivers.push(driver);
		await driver.perform({ kind: "navigate", url: fixture.url("/compose?v=stay") });
		return { driver, fixture };
	}

	async function insert(driver: EngineDriver, markup: string): Promise<void> {
		expect(await driver.evaluate(`document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(markup)})`, 100)).toMatchObject({ ok: true });
	}
	// Observe the real Puppeteer selector wait, then let it run unchanged. A
	// page query alone cannot establish that the action entered resolution.
	async function lateSelector(
		selector: string,
		start: () => Promise<unknown>,
		withdraw: () => Promise<void>,
	): Promise<unknown> {
		const entered = Promise.withResolvers<void>();
		const original = Frame.prototype.waitForSelector;
		const wait = spyOn(Frame.prototype, "waitForSelector").mockImplementation(function <Selector extends string>(this: Frame, css: Selector, options: WaitForSelectorOptions | undefined) {
			if (css === selector) entered.resolve();
			return (original<Selector>).call(this, css, options);
		});
		try {
			const action = start();
			await Promise.race([
				entered.promise,
				action.then(
					() => { throw new Error(`action finished before selector ${selector} was awaited`); },
					error => { throw new Error(`action failed before selector ${selector} was awaited`, { cause: error }); },
				),
			]);
			await withdraw();
			return await action.then(() => { throw new Error("withdrawn action dispatched"); }, error => error);
		} finally {
			wait.mockRestore();
		}
	}

	test("late submit resolution after withdrawal does not dispatch a click or POST", async () => {
		const { driver, fixture } = await nativePage();
		let authorized = true;
		const assertCurrent = () => {
			if (!authorized) throw new ActionNotDispatched("approval_withdrawn", "approval withdrawn");
		};
		const error = await lateSelector("#late-post",
			() => driver.perform({ kind: "click", selector: "#late-post" }, undefined, Object.assign(assertCurrent, { assertCurrent })),
			async () => {
				expect(await driver.evaluate(`document.querySelector("#late-post") === null`, 100)).toMatchObject({ ok: true, value: "true" });
				authorized = false;
				await insert(driver, `<button id="late-post" onclick="document.querySelector('#post').click()">Post</button>`);
			});
		expect(error).toBeInstanceOf(ActionNotDispatched);
		expect(error).toMatchObject({ code: "approval_withdrawn" });
		expect(fixture.submissions()).toEqual([]);
		expect((await driver.state()).title).toContain("clicks:0");
	}, BROWSER_TEST_TIMEOUT_MS);

	test("late field resolution after withdrawal leaves the real field untouched", async () => {
		const { driver } = await nativePage();
		let authorized = true;
		const assertCurrent = () => {
			if (!authorized) throw new ActionNotDispatched("approval_withdrawn", "approval withdrawn");
		};
		const error = await lateSelector("#late-field",
			() => driver.fill("#late-field", "should not be typed", Object.assign(assertCurrent, { assertCurrent })),
			async () => {
				expect(await driver.evaluate(`document.querySelector("#late-field") === null`, 100)).toMatchObject({ ok: true, value: "true" });
				authorized = false;
				await insert(driver, `<textarea id="late-field"></textarea>`);
			});
		expect(error).toBeInstanceOf(ActionNotDispatched);
		expect(error).toMatchObject({ code: "approval_withdrawn" });
		expect(await driver.readField("#late-field")).toEqual({ state: "value", value: "" });
	}, BROWSER_TEST_TIMEOUT_MS);
	test("ordinary late type resolution after withdrawal cannot focus or change the field", async () => {
		const { driver } = await nativePage();
		let authorized = true;
		const assertCurrent = () => {
			if (!authorized) throw new ActionNotDispatched("authority_revoked", "authority revoked");
		};
		const error = await lateSelector("#late-type",
			() => driver.perform({ kind: "type", selector: "#late-type", text: "must not be typed" }, undefined, Object.assign(assertCurrent, { assertCurrent })),
			async () => {
				expect(await driver.evaluate(`document.querySelector("#late-type") === null`, 100)).toMatchObject({ ok: true, value: "true" });
				authorized = false;
				await insert(driver, `<input id="late-type" value="kept">`);
			});
		expect(error).toBeInstanceOf(ActionNotDispatched);
		expect(error).toMatchObject({ code: "authority_revoked" });
		expect(await driver.readField("#late-type")).toEqual({ state: "value", value: "kept" });
		expect(await driver.evaluate(`document.activeElement?.id !== "late-type"`, 100)).toMatchObject({ ok: true, value: "true" });
	}, BROWSER_TEST_TIMEOUT_MS);

	test("ordinary late select resolution after withdrawal preserves the selected option and emits no change", async () => {
		const { driver } = await nativePage();
		let authorized = true;
		const assertCurrent = () => {
			if (!authorized) throw new ActionNotDispatched("authority_revoked", "authority revoked");
		};
		const error = await lateSelector("#late-select",
			() => driver.perform({ kind: "select", selector: "#late-select", value: "after" }, undefined, Object.assign(assertCurrent, { assertCurrent })),
			async () => {
				expect(await driver.evaluate(`document.querySelector("#late-select") === null`, 100)).toMatchObject({ ok: true, value: "true" });
				authorized = false;
				await insert(driver, `<select id="late-select" onchange="document.title = 'selection changed'"><option value="before" selected>Before</option><option value="after">After</option></select>`);
			});
		expect(error).toBeInstanceOf(ActionNotDispatched);
		expect(error).toMatchObject({ code: "authority_revoked" });
		expect(await driver.evaluate(`document.querySelector("#late-select").value === "before"`, 100)).toMatchObject({ ok: true, value: "true" });
		expect((await driver.state()).title).not.toBe("selection changed");
	}, BROWSER_TEST_TIMEOUT_MS);

	test("local revocation after asynchronous refresh prevents navigation in the dispatch continuation", async () => {
		const { driver, fixture } = await nativePage();
		const initialUrl = (await driver.state()).url;
		let authorized = true;
		const assertCurrent = () => {
			if (!authorized) throw new ActionNotDispatched("authority_revoked", "authority revoked");
		};
		const guard = Object.assign(async () => {
			assertCurrent();
			queueMicrotask(() => { authorized = false; });
		}, { assertCurrent });
		await expect(driver.perform({ kind: "navigate", url: fixture.url("/page2") }, undefined, guard)).rejects.toBeInstanceOf(ActionNotDispatched);
		expect(fixture.hits("/page2")).toBe(0);
		expect((await driver.state()).url).toBe(initialUrl);
	}, BROWSER_TEST_TIMEOUT_MS);


	test("fill without an authority guard still refuses password fields without typing or submitting", async () => {
		const { driver, fixture } = await nativePage();
		await insert(driver, `<input id="guard-password" type="password">`);
		const refused = await driver.fill("#guard-password", "must not reach the page").then(() => undefined, error => error);
		expect(refused).toBeInstanceOf(Error);
		expect(await driver.evaluate(`document.querySelector("#guard-password").value === ""`, 100)).toMatchObject({ ok: true, value: "true" });
		expect(fixture.submissions()).toEqual([]);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("guarded fill refuses an actual password field even when page-world input.type is spoofed as text", async () => {
		const { driver, fixture } = await nativePage();
		await insert(driver, `<input id="guard-spoof-password" type="password">`);
		expect(await driver.evaluate(`Object.defineProperty(HTMLInputElement.prototype, "type", { configurable: true, get() { return "text"; } }); document.querySelector("#guard-spoof-password").type === "text"`, 100)).toMatchObject({ ok: true, value: "true" });
		let authorized = true;
		const assertCurrent = () => {
			if (!authorized) throw new ActionNotDispatched("approval_withdrawn", "approval withdrawn");
		};
		const refused = await driver.fill("#guard-spoof-password", "must not reach the page", Object.assign(assertCurrent, { assertCurrent })).then(() => undefined, error => error);
		expect(refused).toBeInstanceOf(Error);
		expect(await driver.evaluate(`document.querySelector("#guard-spoof-password").value === ""`, 100)).toMatchObject({ ok: true, value: "true" });
		expect(fixture.submissions()).toEqual([]);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("authority withdrawn after focus is not classified as undispatched and leaves the field and submission untouched", async () => {
		const { driver, fixture } = await nativePage();
		await insert(driver, `<textarea id="guard-focus"></textarea>`);
		let authorized = true;
		const assertCurrent = () => {
			if (!authorized) throw new ActionNotDispatched("approval_withdrawn", "approval withdrawn");
		};
		const guard = Object.assign(async () => {
			const focused = await driver.evaluate(`document.activeElement?.id === "guard-focus"`, 100);
			if (focused.ok && focused.value === "true") authorized = false;
			assertCurrent();
		}, { assertCurrent });
		const refused = await driver.fill("#guard-focus", "must not be typed", guard).then(() => undefined, error => error);
		expect(refused).toBeInstanceOf(Error);
		expect(refused).not.toBeInstanceOf(ActionNotDispatched);
		expect(await driver.evaluate(`document.activeElement?.id === "guard-focus"`, 100)).toMatchObject({ ok: true, value: "true" });
		expect(await driver.readField("#guard-focus")).toEqual({ state: "value", value: "" });
		expect(fixture.submissions()).toEqual([]);
	}, BROWSER_TEST_TIMEOUT_MS);
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
