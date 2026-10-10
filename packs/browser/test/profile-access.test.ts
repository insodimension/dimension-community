/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a model that names a saved profile
 *  is stopped by a step nobody can answer (the host's permission mode is the
 *  only gate), or it is handed a profile another chat or the person's View
 *  holds, or learns that holder's browser id, or two chats racing for one new
 *  profile both get a Chrome on it; or an open that fails or is cancelled part
 *  way leaves the profile locked, its Chrome running, or its saved logins gone;
 *  or a saved profile's preview carries the page's title, address or pixels.
 *
 *  The real MCP server over an in-memory transport, stamped the way a host
 *  stamps a chat ("model") and the person's View ("app"), each with a session.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { CodeHostPort } from "../src/code/contracts";
import type { BrowserRuntime, BrowserRuntimeOptions } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { ProfileStore } from "../src/store";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, failureCode, type Fixture, newRuntime, perform, startFixture, teardown } from "./fixture";

const CALLER = "ai.insodimension/caller";
const SESSION = "ai.insodimension/session";
const PREVIEW = "ai.insodimension/preview";

interface Who {
	caller: "model" | "app";
	session: string;
}
const MODEL: Who = { caller: "model", session: "chat-a" };
const PERSON: Who = { caller: "app", session: "chat-a" };
const OTHER_MODEL: Who = { caller: "model", session: "chat-b" };
const OTHER_PERSON: Who = { caller: "app", session: "chat-b" };

const Answer = z.object({
	isError: z.boolean().optional(),
	content: z.array(z.object({ text: z.string().optional() }).passthrough()),
	structuredContent: z.record(z.string(), z.unknown()).optional(),
	_meta: z.record(z.string(), z.unknown()).optional(),
});
type Answer = z.infer<typeof Answer>;

const Listing = z.object({
	profiles: z.array(
		z.object({
			name: z.string(),
			heldBy: z.string().nullable(),
			sites: z.array(z.object({ site: z.string(), signedIn: z.boolean().nullable(), seenAt: z.string() }).strict()),
		}).passthrough(),
	),
});

const Preview = z.object({
	[PREVIEW]: z.object({
		source: z.object({ kind: z.literal("browser"), browserId: z.string() }),
		profile: z.literal("saved"),
	}).passthrough(),
});

interface Rig {
	rootDir: string;
	runtime: BrowserRuntime;
	client: Client;
	fixture: Fixture;
	call(name: string, args: Record<string, unknown>, who: Who): Promise<Answer>;
}

const clients: Client[] = [];
afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

const unusedCodeHost: CodeHostPort = {
	run: async () => { throw new Error("a saved-profile operation reached the code host"); },
	resume: async () => { throw new Error("a saved-profile operation reached the code host"); },
	dispose: async () => {},
};

async function setup(runtimeOptions: Omit<BrowserRuntimeOptions, "rootDir"> = {}): Promise<Rig> {
	const rootDir = await createRoot();
	const runtime = newRuntime(rootDir, runtimeOptions);
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir, presets: [], codeHost: unusedCodeHost });
	const client = new Client({ name: "profile-access-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	return {
		rootDir, runtime, client,
		fixture: startFixture(),
		call: async (name, args, who) => Answer.parse(await client.callTool({ name, arguments: args, _meta: { [CALLER]: who.caller, [SESSION]: { sessionId: who.session } } })),
	};
}

const text = (answer: Answer): string => answer.content.map((block) => block.text ?? "").join("");

const browserIdOf = (answer: Answer): string => {
	const browserId = answer.structuredContent?.browserId;
	if (answer.isError || typeof browserId !== "string") throw new Error(`expected a browser, got: ${text(answer)}`);
	return browserId;
};

const listedFor = async (r: Rig, who: Who) => Listing.parse(JSON.parse(text(await r.call("browser_profiles", {}, who)))).profiles;

test("the pack offers no approval tool, and browser_run has no typed route around the host's permission", async () => {
	const r = await setup();
	const tools = (await r.client.listTools()).tools;
	expect(tools.map((tool) => tool.name)).not.toContain("browser_profile_consent");
	const run = tools.find((tool) => tool.name === "browser_run");
	expect(run).toBeDefined();
	expect(Object.keys(run?.inputSchema.properties ?? {})).not.toContain("profileTool");
});

test("an open that fails to launch leaves the saved profile's data in place and its lock free", async () => {
	const r = await setup({ executablePath: "nonexistent-browser-executable" });
	const store = new ProfileStore(r.rootDir);
	const marker = join(store.ensureProfile("work"), "person-data");
	await writeFile(marker, "keep");
	expect((await r.call("browser_open", { profile: "work" }, MODEL)).isError).toBe(true);
	expect(await readFile(marker, "utf8")).toBe("keep");
	expect(store.heldElsewhere("work")).toBe(false);
});

describeWithChrome("a model opening a saved profile", () => {
	test("reads which sites it is signed in to, then opens it with no approval step in between and finds the person's login", async () => {
		const r = await setup();
		const signedIn = browserIdOf(await r.call("browser_open", { profile: "work", url: r.fixture.url("/set-cookie") }, PERSON));
		expect((await r.call("browser_close", { browserId: signedIn }, PERSON)).isError).toBeFalsy();
		new ProfileStore(r.rootDir).recordConnection("work", "x.com", { signedIn: true, account: "@acmeco", observedAt: Date.now() });

		const [listed] = await listedFor(r, MODEL);
		expect(listed).toMatchObject({ name: "work", heldBy: null });
		expect(listed?.sites.find((site) => site.site === "x.com")).toEqual({ site: "x.com", signedIn: true, seenAt: expect.any(String) });
		expect(text(await r.call("browser_profiles", {}, MODEL))).not.toContain("acmeco");

		const opened = await r.call("browser_open", { profile: "work", url: r.fixture.url("/show-cookie") }, MODEL);
		const browserId = browserIdOf(opened);
		expect(text(await r.call("browser_snapshot", { browserId }, MODEL))).toContain(`COOKIE:${r.fixture.cookieValue}`);
		expect((await r.call("browser_act", { browserId, actions: [{ kind: "navigate", url: r.fixture.url("/page2") }] }, MODEL)).isError).toBeFalsy();
		expect((await listedFor(r, MODEL))[0]?.heldBy).toBe("this chat");
		expect((await r.call("browser_close", { browserId }, MODEL)).isError).toBeFalsy();
		expect((await listedFor(r, MODEL))[0]?.heldBy).toBeNull();
	}, BROWSER_TEST_TIMEOUT_MS);

	test("every seat joins a profile's one browser, each told its own word for it; the id never reaches a seat that holds nothing, and a close behind it mints the next", async () => {
		const r = await setup();
		const mine = browserIdOf(await r.call("browser_open", { profile: "work" }, MODEL));
		expect(browserIdOf(await r.call("browser_open", { profile: "work" }, PERSON))).toBe(mine);
		expect(browserIdOf(await r.call("browser_open", { profile: "work" }, MODEL))).toBe(mine);

		for (const who of [OTHER_MODEL, OTHER_PERSON]) {
			expect(browserIdOf(await r.call("browser_open", { profile: "work" }, who))).toBe(mine);
			expect((await listedFor(r, who))[0]?.heldBy).toBe("this chat");
		}
		expect((await listedFor(r, MODEL))[0]?.heldBy).toBe("this chat");
		const stranger: Who = { caller: "model", session: "chat-c" };
		expect((await listedFor(r, stranger))[0]?.heldBy).toBe("human");
		expect(text(await r.call("browser_profiles", {}, stranger))).not.toContain(mine);

		expect((await r.call("browser_close", { browserId: mine }, MODEL)).isError).toBeFalsy();
		expect(browserIdOf(await r.call("browser_open", { profile: "work" }, OTHER_MODEL))).not.toBe(mine);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("two chats racing to open the same new profile: one browser, both called the same id, neither refused", async () => {
		const r = await setup();
		const [first, second] = await Promise.all([
			r.call("browser_open", { profile: "fresh" }, MODEL),
			r.call("browser_open", { profile: "fresh" }, OTHER_MODEL),
		]);
		const browserId = browserIdOf(first);
		expect(browserIdOf(second)).toBe(browserId);
		for (const who of [MODEL, OTHER_MODEL]) {
			expect((await listedFor(r, who))[0]?.heldBy).toBe("this chat");
		}
		const racingStranger = { caller: "model", session: "chat-z" } as Who;
		expect((await listedFor(r, racingStranger))[0]?.heldBy).toBe("another chat");
		expect(text(await r.call("browser_profiles", {}, racingStranger))).not.toContain(browserId);
		expect((await r.call("browser_close", { browserId }, MODEL)).isError).toBeFalsy();
		expect(browserIdOf(await r.call("browser_open", { profile: "fresh" }, OTHER_MODEL))).not.toBe(browserId);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("a close named by its chat takes only that chat's seat: the browser outlives one chat, and the last one out turns off the lights", async () => {
		const r = await setup();
		const browserId = browserIdOf(await r.call("browser_open", { profile: "work" }, MODEL));
		expect(browserIdOf(await r.call("browser_open", { profile: "work" }, OTHER_MODEL))).toBe(browserId);
		expect((await listedFor(r, OTHER_MODEL))[0]?.heldBy).toBe("this chat");

		await r.runtime.close(browserId, "model", undefined, MODEL);

		expect((await r.runtime.state(browserId)).browserId).toBe(browserId);
		expect((await listedFor(r, OTHER_MODEL))[0]?.heldBy).toBe("this chat");
		expect((await listedFor(r, MODEL))[0]?.heldBy).toBe("another chat");
		await expect(r.runtime.close(browserId, "model", undefined, MODEL)).resolves.toBeUndefined();
		expect((await r.runtime.state(browserId)).browserId).toBe(browserId);

		await r.runtime.close(browserId, "model", undefined, OTHER_MODEL);
		expect(await failureCode(() => r.runtime.state(browserId))).toBe("unknown_browser");
		expect(browserIdOf(await r.call("browser_open", { profile: "work" }, MODEL))).not.toBe(browserId);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("an open refused after its Chrome launched closes that Chrome, frees the profile and keeps the saved cookies", async () => {
		const r = await setup();
		const store = new ProfileStore(r.rootDir);
		const original = browserIdOf(await r.call("browser_open", { profile: "work", url: r.fixture.url("/set-cookie") }, PERSON));
		expect((await r.call("browser_close", { browserId: original }, PERSON)).isError).toBeFalsy();
		const marker = join(store.profileDir("work"), "login-marker");
		await writeFile(marker, "keep");
		let launched = false;
		const refusal = new Error("refused after launch");
		const assertCurrent = () => {
			if (!store.heldElsewhere("work")) return;
			launched = true;
			throw refusal;
		};
		await expect(r.runtime.open({ profile: "work" }, { caller: "app", session: "late-open" }, undefined, undefined, Object.assign(assertCurrent, { assertCurrent }))).rejects.toBe(refusal);
		expect(launched).toBe(true);
		expect(store.heldElsewhere("work")).toBe(false);
		expect(await readFile(marker, "utf8")).toBe("keep");

		const second = newRuntime(r.rootDir);
		const reopened = await second.open({ profile: "work" }, { caller: "app", session: "second-runtime" });
		await perform(second, reopened.browserId, { kind: "navigate", url: r.fixture.url("/show-cookie") });
		expect((await second.snapshot(reopened.browserId)).text).toContain(`COOKIE:${r.fixture.cookieValue}`);
		await second.close(reopened.browserId, "app");
	}, BROWSER_TEST_TIMEOUT_MS);

	test("a close that was admitted finishes and frees the profile although its guard goes stale during teardown", async () => {
		const r = await setup();
		const store = new ProfileStore(r.rootDir);
		const browserId = browserIdOf(await r.call("browser_open", { profile: "work" }, MODEL));
		let admitted = false;
		const cancelled = new Error("cancelled after close admission");
		const assertCurrent = () => {
			if (admitted) throw cancelled;
			admitted = true;
		};
		const guard = Object.assign(() => { if (admitted) throw cancelled; }, { assertCurrent });
		await r.runtime.close(browserId, "model", guard);
		expect(admitted).toBe(true);
		expect(await failureCode(() => r.runtime.state(browserId))).toBe("unknown_browser");
		expect(store.heldElsewhere("work")).toBe(false);
		const reopened = browserIdOf(await r.call("browser_open", { profile: "work" }, MODEL));
		expect(reopened).not.toBe(browserId);
		expect((await r.call("browser_close", { browserId: reopened }, MODEL)).isError).toBeFalsy();
	}, BROWSER_TEST_TIMEOUT_MS);

	test("a saved profile's open emits a preview source with no automatic title, address or image", async () => {
		const r = await setup();
		const opened = await r.call("browser_open", { profile: "work", url: r.fixture.url("/page2") }, MODEL);
		const browserId = browserIdOf(opened);
		const preview = Preview.parse(opened._meta)[PREVIEW];
		expect(preview.source.browserId).toBe(browserId);
		expect(preview).not.toHaveProperty("images");
		expect(preview).not.toHaveProperty("title");
		expect(preview).not.toHaveProperty("url");
		expect((await r.call("browser_close", { browserId }, MODEL)).isError).toBeFalsy();
	}, BROWSER_TEST_TIMEOUT_MS);
});
