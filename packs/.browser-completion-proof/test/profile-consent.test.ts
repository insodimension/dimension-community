import { afterEach, expect, setSystemTime, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACTORY_HOST_CONTEXT_ENDED_METHOD, ARTIFACTORY_HOST_CONTEXT_EXTENSION_ID, ARTIFACTORY_HOST_CONTEXT_META_KEY, ARTIFACTORY_HOST_CONTEXT_READ_METHOD } from "@dimension/sdk/artifactory";
import type { CodeHostPort } from "../src/code/contracts";
import type { EngineDriver } from "../src/engines/types";
import { z } from "zod";
import { createBrowserServer } from "../src/server";
import { ProfileStore } from "../src/store";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, failureCode, newRuntime, perform, startFixture, teardown, waitUntil } from "./fixture";

type Who = { caller: "model" | "app"; session?: string };
type Answer = { isError?: boolean; content: Array<{ text?: string }>; structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown> };
type Loop = { id: string; workspaceId: string; origin: string; label: string };
interface ConsentRig {
	rootDir: string;
	runtime: ReturnType<typeof newRuntime>;
	client: Client;
	fixture: ReturnType<typeof startFixture>;
	session(name: string): { token: string; active: boolean; loop?: Loop };
	beforeRead(callback?: () => Promise<void>): void;
	end(name: string): Promise<void>;
	call(name: string, args: Record<string, unknown>, who?: Who, token?: string): Promise<Answer>;
}
const model: Who = { caller: "model", session: "chat-a" };
const person: Who = { caller: "app", session: "chat-a" };
const other: Who = { caller: "model", session: "chat-b" };
const clients: Client[] = [];
afterEach(async () => {
	for (const client of clients.splice(0)) await client.close();
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

async function setup(runtimeOptions: Parameters<typeof newRuntime>[1] = {}, advertise = true): Promise<ConsentRig> {
	const rootDir = await createRoot();
	const runtime = newRuntime(rootDir, runtimeOptions);
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const codeHost: CodeHostPort = {
		run: async () => { throw new Error("saved-profile operation entered full-Node code host"); },
		resume: async () => { throw new Error("saved-profile operation entered full-Node code host"); },
		dispose: async () => {},
	};
	const server = await createBrowserServer({ runtime, viewDir, presets: [], codeHost });
	const client = new Client({ name: "profile-consent-test", version: "0.0.0" }, { capabilities: advertise ? { extensions: { [ARTIFACTORY_HOST_CONTEXT_EXTENSION_ID]: {} } } : {} });
	const sessions = new Map<string, { token: string; active: boolean; loop?: Loop }>();
	const session = (name: string) => {
		let entry = sessions.get(name);
		if (!entry) {
			entry = { token: randomBytes(32).toString("hex"), active: true };
			sessions.set(name, entry);
		}
		return entry;
	};
	let beforeRead: (() => Promise<void>) | undefined;
	client.setRequestHandler(z.object({ method: z.literal(ARTIFACTORY_HOST_CONTEXT_READ_METHOD), params: z.object({ sessionId: z.string(), token: z.string() }) }), async request => {
		await beforeRead?.();
		const { sessionId, token } = request.params;
		const entry = sessions.get(sessionId);
		if (!entry || token !== entry.token) throw new Error("Unknown host context");
		return entry.active ? { active: true, sessionId, ...(entry.loop ? { loop: entry.loop } : {}) } : { active: false, sessionId };
	});
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	return {
		rootDir, runtime, client,
		fixture: startFixture(),
		session,
		beforeRead: (callback?: () => Promise<void>) => { beforeRead = callback; },
		end: async (name: string) => {
			const entry = session(name);
			entry.active = false;
			await client.notification({ method: ARTIFACTORY_HOST_CONTEXT_ENDED_METHOD, params: { sessionId: name, token: entry.token } });
		},
		call: (name: string, args: Record<string, unknown>, who?: Who, token?: string): Promise<Answer> => {
			const loop = who?.session ? session(who.session).loop : undefined;
			const gesture = name === "browser_profile_consent" && who?.caller === "app" && loop && !("expectedSubject" in args)
				? { ...args, expectedSubject: { workspaceId: loop.workspaceId, id: loop.id, origin: loop.origin } }
				: args;
			return client.callTool({ name, arguments: gesture,
				...(who ? { _meta: { "ai.insodimension/caller": who.caller, ...(who.session ? {
					"ai.insodimension/session": { sessionId: who.session },
					[ARTIFACTORY_HOST_CONTEXT_META_KEY]: { sessionId: who.session, token: token ?? session(who.session).token },
				} : {}) } } : {}) }) as Promise<Answer>;
		},
	};
}
const text = (answer: Answer) => answer.content.map(block => block.text ?? "").join("");
const id = (answer: Answer): string => {
	if (answer.isError || typeof answer.structuredContent?.browserId !== "string") throw new Error(text(answer));
	return answer.structuredContent.browserId;
};

const verifiedLoop: Loop = { id: "loop-7", workspaceId: "workspace-a", origin: "durable", label: "Research Loop" };

async function savedProfile(r: ConsentRig): Promise<void> {
	const browserId = id(await r.call("browser_open", { profile: "work" }, person));
	expect((await r.call("browser_close", { browserId }, person)).isError).toBeFalsy();
}

async function grantLoop(r: ConsentRig): Promise<void> {
	await savedProfile(r);
	r.session("chat-a").loop = verifiedLoop;
	expect((await r.call("browser_open", { profile: "work" }, model)).isError).toBe(true);
	const approved = await r.call("browser_profile_consent", { name: "work", decision: "allow", scope: "loop" }, person);
	expect(approved.isError).toBeFalsy();
}

describeWithChrome("saved-profile consent at the MCP boundary", () => {
	test("a first model request cannot open or read a person's profile until that session's person allows it", async () => {
		const r = await setup();
		const site = r.fixture;
		const profile = id(await r.call("browser_open", { profile: "work" }, person));
		await r.call("browser_act", { browserId: profile, actions: [{ kind: "navigate", url: site.url("/page2") }] }, person);
		await r.call("browser_close", { browserId: profile }, person);
		const denied = await r.call("browser_open", { profile: "work", url: site.url("/show-cookie") }, model);
		expect(denied.isError).toBe(true);
		const pending = await r.call("browser_profiles", {}, person);
		expect(pending.structuredContent?.consents).toEqual(expect.arrayContaining([expect.objectContaining({ name: "work", status: "pending" })]));
		expect((await r.call("browser_profile_consent", { name: "work", decision: "allow" }, other)).isError).toBe(true);
		expect((await r.call("browser_profile_consent", { name: "work", decision: "allow" }, { caller: "app", session: "chat-b" })).isError).toBe(true);
		expect((await r.call("browser_open", { profile: "work" }, other)).isError).toBe(true);
		expect((await r.call("browser_open", { profile: "work" }, { caller: "model" })).isError).toBe(true);
		expect((await r.call("browser_profile_consent", { name: "work", decision: "allow" }, person)).isError).toBeFalsy();
		const opened = id(await r.call("browser_open", { profile: "work", url: site.url("/show-cookie") }, model));
		expect(opened).not.toBe(profile);
		expect(text(await r.call("browser_snapshot", { browserId: opened }, model))).toContain("COOKIE:none");
		expect((await r.call("browser_snapshot", { browserId: opened }, other)).isError).toBe(true);
		expect((await r.call("browser_act", { browserId: opened, actions: [{ kind: "navigate", url: site.url("/page2") }] }, other)).isError).toBe(true);
		const revoked = await r.call("browser_profile_consent", { name: "work", decision: "revoke" }, person);
		expect(revoked.isError).toBeFalsy();
		expect((await r.call("browser_snapshot", { browserId: opened }, model)).isError).toBe(true);
		expect((await r.call("browser_act", { browserId: opened, actions: [{ kind: "navigate", url: site.url("/page2") }] }, model)).isError).toBe(true);
		expect(text(await r.call("browser_snapshot", { browserId: opened }, person))).toContain("COOKIE:none");
		expect((await r.call("browser_close", { browserId: opened }, person)).isError).toBeFalsy();
	}, BROWSER_TEST_TIMEOUT_MS);
	test("two chats racing to create the same profile cannot both receive its browser or an enduring grant", async () => {
		const r = await setup();
		const [first, second] = await Promise.all([
			r.call("browser_open", { profile: "fresh" }, model),
			r.call("browser_open", { profile: "fresh" }, other),
		]);
		const winners = [first, second].filter(answer => !answer.isError);
		expect(winners).toHaveLength(1);
		const [winner, owner]: [Answer, Who] = first.isError ? [second, other] : [first, model];
		const loser = first.isError ? model : other;
		const browserId = id(winner);
		expect((await r.call("browser_state", { browserId }, loser)).isError).toBe(true);
		expect((await r.call("browser_close", { browserId }, owner)).isError).toBeFalsy();
		expect((await r.call("browser_open", { profile: "fresh" }, loser)).isError).toBe(true);
	}, BROWSER_TEST_TIMEOUT_MS);
	test("a failed first owned launch neither grants the model nor removes existing profile data", async () => {
		const r = await setup({ executablePath: "nonexistent-browser-executable" });
		const store = new ProfileStore(r.rootDir);
		const profileDir = store.ensureProfile("work");
		const marker = join(profileDir, "person-data");
		await writeFile(marker, "keep");
		const failed = await r.call("browser_open", { profile: "work" }, person);
		expect(failed.isError).toBe(true);
		expect(await readFile(marker, "utf8")).toBe("keep");
		const profiles = await r.call("browser_profiles", {}, person);
		expect(profiles.structuredContent?.consents).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "work", status: "allowed" })]));
		expect((await r.call("browser_open", { profile: "work" }, model)).isError).toBe(true);
		expect(await readFile(marker, "utf8")).toBe("keep");
	}, BROWSER_TEST_TIMEOUT_MS);
	test("a late failed open closes its real Chrome, releases its lock, and preserves saved cookies", async () => {
		const r = await setup();
		const store = new ProfileStore(r.rootDir);
		const original = id(await r.call("browser_open", { profile: "work", url: r.fixture.url("/set-cookie") }, person));
		expect((await r.call("browser_close", { browserId: original }, person)).isError).toBeFalsy();
		const marker = join(store.profileDir("work"), "login-marker");
		await writeFile(marker, "keep");
		let reachedLaunchedEntry = false;
		const refusal = new Error("late host refusal");
		const assertCurrent = () => {
			if (!store.heldElsewhere("work")) return;
			reachedLaunchedEntry = true;
			throw refusal;
		};
		const refuseAfterLaunch = Object.assign(assertCurrent, { assertCurrent });
		await expect(r.runtime.open({ profile: "work" }, { caller: "app", session: "late-open" }, undefined, undefined, refuseAfterLaunch)).rejects.toBe(refusal);
		expect(reachedLaunchedEntry).toBe(true);
		expect(store.heldElsewhere("work")).toBe(false);
		expect(await readFile(marker, "utf8")).toBe("keep");
		const second = newRuntime(r.rootDir);
		const reopened = await second.open({ profile: "work" }, { caller: "app", session: "second-runtime" });
		await perform(second, reopened.browserId, { kind: "navigate", url: r.fixture.url("/show-cookie") });
		expect((await second.snapshot(reopened.browserId)).text).toContain(`COOKIE:${r.fixture.cookieValue}`);
		await second.close(reopened.browserId, "app");
	}, BROWSER_TEST_TIMEOUT_MS);

	test("a failed late creator open grants no saved-profile authority", async () => {
		const r = await setup();
		const store = new ProfileStore(r.rootDir);
		let launched = false;
		const refusal = new Error("late creator refusal");
		const assertCurrent = () => {
			if (!store.heldElsewhere("fresh")) return;
			launched = true;
			throw refusal;
		};
		const guard = Object.assign(assertCurrent, { assertCurrent });
		await expect(r.runtime.open({ profile: "fresh" }, { caller: "model", session: "creator" }, undefined, undefined, guard)).rejects.toBe(refusal);
		expect(launched).toBe(true);
		expect(store.heldElsewhere("fresh")).toBe(false);
		expect(await failureCode(() => r.runtime.open({ profile: "fresh" }, { caller: "model", session: "creator" }))).toBe("profile_consent_required");
		const second = newRuntime(r.rootDir);
		const reopened = await second.open({ profile: "fresh" }, { caller: "app", session: "person" });
		await second.close(reopened.browserId, "app");
	}, BROWSER_TEST_TIMEOUT_MS);

	test("typed profileTool drives a consented saved page through ordinary operations without entering the code worker", async () => {
		const r = await setup();
		const saved = id(await r.call("browser_open", { profile: "work" }, person));
		await r.call("browser_close", { browserId: saved }, person);
		const request = await r.call("browser_run", { profileTool: { kind: "open", profile: "work" } }, model);
		expect(request.isError).toBe(true);
		expect((await r.call("browser_profile_consent", { name: "work", decision: "allow" }, person)).isError).toBeFalsy();
		const opened = await r.call("browser_run", { profileTool: { kind: "open", profile: "work", url: r.fixture.url("/page2") } }, model);
		expect(opened.isError).toBeFalsy();
		const browserId = z.object({ browserId: z.string() }).parse(JSON.parse(text(opened))).browserId;
		const snapshot = await r.call("browser_run", { profileTool: { kind: "snapshot", browserId } }, model);
		expect(snapshot.isError).toBeFalsy();
		expect(text(snapshot)).toContain(r.fixture.url("/page2"));
		const acted = await r.call("browser_run", { profileTool: { kind: "act", browserId, actions: [{ kind: "navigate", url: r.fixture.url("/show-cookie") }] } }, model);
		expect(acted.isError).toBeFalsy();
		expect(text(await r.call("browser_run", { profileTool: { kind: "snapshot", browserId } }, model))).toContain("COOKIE:none");
		const invalid = await r.call("browser_run", { profileTool: { kind: "state", browserId }, code: "display(1)" }, model);
		expect(invalid.isError).toBe(true);
		expect((await r.call("browser_run", { profileTool: { kind: "close", browserId } }, model)).isError).toBeFalsy();
	}, BROWSER_TEST_TIMEOUT_MS);

	test("consent revoked while an authenticated ordinary batch awaits late controls prevents its typing selection and submit", async () => {
		const r = await setup();
		await savedProfile(r);
		expect((await r.call("browser_open", { profile: "work" }, model)).isError).toBe(true);
		expect((await r.call("browser_profile_consent", { name: "work", decision: "allow", scope: "chat" }, person)).isError).toBeFalsy();
		const browserId = id(await r.call("browser_open", { profile: "work", url: r.fixture.url("/signup") }, model));
		// The page itself may add controls while the model's queue is waiting; the native driver keeps that setup outside the action queue.
		const seam = r.runtime as unknown as { byId: Map<string, { driver: EngineDriver }> };
		const entry = seam.byId.get(browserId);
		if (!entry) throw new Error("the adopted browser has no native driver");
		let reading!: () => void;
		let release!: () => void;
		const entered = new Promise<void>(resolve => { reading = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		r.beforeRead(async () => {
			r.beforeRead();
			reading();
			await gate;
		});
		const pending = r.call("browser_act", { browserId, actions: [
			{ kind: "wait", selector: "#queued-user" },
			{ kind: "type", selector: "#queued-user", text: "must not be typed" },
			{ kind: "select", selector: "#queued-plan", value: "after" },
			{ kind: "click", selector: "#queued-submit" },
		] }, model);
		await entered;
		release();
		expect((await r.call("browser_profiles", {}, person)).isError).toBeFalsy();
		expect(await entry.driver.evaluate(`document.querySelector("#queued-user") === null`, 100)).toMatchObject({ ok: true, value: "true" });
		expect((await r.call("browser_profile_consent", { name: "work", decision: "revoke" }, person)).isError).toBeFalsy();
		expect(await entry.driver.evaluate(`document.body.insertAdjacentHTML("beforeend", '<input id="queued-user" value="kept"><select id="queued-plan"><option value="before" selected>Before</option><option value="after">After</option></select><button id="queued-submit" onclick="document.querySelector(\\'#go\\').click()">Submit</button>'); true`, 100)).toMatchObject({ ok: true, value: "true" });
		expect((await pending).isError).toBe(true);
		expect(await entry.driver.readField("#queued-user")).toEqual({ state: "value", value: "kept" });
		expect(await entry.driver.evaluate(`document.querySelector("#queued-plan").value === "before"`, 100)).toMatchObject({ ok: true, value: "true" });
		expect(r.fixture.submissions()).toEqual([]);
	}, BROWSER_TEST_TIMEOUT_MS);
	test("revoking during an in-flight batch stops later steps and withholds queued model reads and actions, while the person keeps the page", async () => {
		const r = await setup();
		const saved = id(await r.call("browser_open", { profile: "work" }, person));
		await r.call("browser_close", { browserId: saved }, person);
		expect((await r.call("browser_open", { profile: "work" }, model)).isError).toBe(true);
		expect((await r.call("browser_profile_consent", { name: "work", decision: "allow" }, person)).isError).toBeFalsy();
		const browserId = id(await r.call("browser_open", { profile: "work" }, model));
		const batch = r.call("browser_act", { browserId, actions: [
			{ kind: "navigate", url: r.fixture.url("/slow") },
			{ kind: "navigate", url: r.fixture.url("/page2") },
		] }, model);
		await waitUntil("the first navigation to reach the fixture", () => r.fixture.hits("/slow"), hits => hits === 1);
		const queuedRead = r.call("browser_snapshot", { browserId }, model);
		const queuedAction = r.call("browser_act", { browserId, actions: [{ kind: "navigate", url: r.fixture.url("/show-cookie") }] }, model);
		const queuedClose = r.call("browser_run", { profileTool: { kind: "close", browserId } }, model);
		expect((await r.call("browser_profile_consent", { name: "work", decision: "revoke" }, person)).isError).toBeFalsy();
		const [batchResult, readResult, actionResult, closeResult] = await Promise.all([batch, queuedRead, queuedAction, queuedClose]);
		expect(batchResult.isError).toBe(true);
		expect(readResult.isError).toBe(true);
		expect(actionResult.isError).toBe(true);
		expect(closeResult.isError).toBe(true);
		expect(r.fixture.hits("/page2")).toBe(0);
		expect(r.fixture.hits("/show-cookie")).toBe(0);
		expect(text(await r.call("browser_snapshot", { browserId }, person))).toContain("slow");
		expect((await r.call("browser_close", { browserId }, person)).isError).toBeFalsy();
	}, BROWSER_TEST_TIMEOUT_MS);
	test("a saved-profile navigation emits an owned preview source without automatic title, URL or image bytes", async () => {
		const r = await setup();
		const saved = id(await r.call("browser_open", { profile: "work" }, person));
		await r.call("browser_close", { browserId: saved }, person);
		expect((await r.call("browser_open", { profile: "work" }, model)).isError).toBe(true);
		expect((await r.call("browser_profile_consent", { name: "work", decision: "allow" }, person)).isError).toBeFalsy();
		const opened = await r.call("browser_open", { profile: "work", url: r.fixture.url("/page2") }, model);
		const browserId = id(opened);
		const preview = z.object({ "ai.insodimension/preview": z.object({
			source: z.object({ kind: z.literal("browser"), browserId: z.string() }),
			profile: z.literal("saved"),
		}).passthrough() }).parse(opened._meta)["ai.insodimension/preview"];
		expect(preview.source.browserId).toBe(browserId);
		expect(preview).not.toHaveProperty("images");
		expect(preview).not.toHaveProperty("title");
		expect(preview).not.toHaveProperty("url");
		expect((await r.call("browser_close", { browserId }, person)).isError).toBeFalsy();
	}, BROWSER_TEST_TIMEOUT_MS);
	test("a model cannot create the person's default profile on a fresh root: it is refused for approval and made nothing, while any other new name stays its own", async () => {
		const r = await setup();
		const store = new ProfileStore(r.rootDir);
		expect(store.exists("default")).toBe(false);
		const refused = await r.call("browser_open", { profile: "default" }, model);
		expect(refused.isError).toBe(true);
		expect(store.exists("default")).toBe(false);
		// No grant was left behind: asking again is still a request for the person, not an open.
		expect(await failureCode(() => r.runtime.open({ profile: "default" }, { caller: "model", session: "chat-a" }))).toBe("profile_consent_required");
		expect(store.exists("default")).toBe(false);
		// The person must be able to see the request to decide it although its folder is not on disk yet; the repeated ask is still one row, and looking creates nothing.
		expect((await r.call("browser_profiles", {}, person)).structuredContent?.consents).toEqual([expect.objectContaining({ name: "default", status: "pending" })]);
		expect(store.exists("default")).toBe(false);
		// The person's allow needs a live pending request, so it also proves the refusal raised one.
		expect((await r.call("browser_profile_consent", { name: "default", decision: "allow", scope: "chat" }, person)).isError).toBeFalsy();
		expect((await r.call("browser_profiles", {}, person)).structuredContent?.consents).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "default", status: "pending" })]));
		const approved = id(await r.call("browser_open", { profile: "default" }, model));
		expect((await r.call("browser_close", { browserId: approved }, model)).isError).toBeFalsy();
		// Opened on the person's approval, `default` is on disk and the decided request shows as the chat's grant.
		expect((await r.call("browser_profiles", {}, person)).structuredContent?.consents).toEqual([expect.objectContaining({ name: "default", status: "granted", scope: "chat" })]);
		// Any other new name is still the model's to create, and is granted to its creator alone.
		const created = id(await r.call("browser_open", { profile: "fresh" }, model));
		expect((await r.call("browser_state", { browserId: created }, model)).isError).toBeFalsy();
		expect((await r.call("browser_state", { browserId: created }, other)).isError).toBe(true);
		expect((await r.call("browser_close", { browserId: created }, model)).isError).toBeFalsy();
	}, BROWSER_TEST_TIMEOUT_MS);
	test("a model's close of a saved profile, once admitted, finishes and frees the profile even if its authority is withdrawn during teardown", async () => {
		const r = await setup();
		const store = new ProfileStore(r.rootDir);
		await savedProfile(r);
		expect((await r.call("browser_open", { profile: "work" }, model)).isError).toBe(true);
		expect((await r.call("browser_profile_consent", { name: "work", decision: "allow", scope: "chat" }, person)).isError).toBeFalsy();
		const browserId = id(await r.call("browser_open", { profile: "work" }, model));
		// Authority is current for close()'s admission (guard, then its first assertCurrent) and withdrawn for every look after it.
		let admitted = false;
		const withdrawn = new Error("authority withdrawn after close admission");
		const assertCurrent = () => {
			if (admitted) throw withdrawn;
			admitted = true;
		};
		const guard = Object.assign(() => { if (admitted) throw withdrawn; }, { assertCurrent });
		await r.runtime.close(browserId, "model", guard);
		expect(admitted).toBe(true);
		expect(await failureCode(() => r.runtime.state(browserId))).toBe("unknown_browser");
		expect(store.heldElsewhere("work")).toBe(false);
		// A half-closed entry would still hold the profile for this chat: it opens again as a new browser.
		const reopened = id(await r.call("browser_open", { profile: "work" }, model));
		expect(reopened).not.toBe(browserId);
		expect((await r.call("browser_close", { browserId: reopened }, model)).isError).toBeFalsy();
	}, BROWSER_TEST_TIMEOUT_MS);
});

describeWithChrome("host-authenticated saved profile authority", () => {
	test("forged and unadvertised references cannot open a saved profile or navigate its page", async () => {
		const r = await setup();
		await savedProfile(r);
		const site = r.fixture;
		const forged = await r.call("browser_open", { profile: "work", url: site.url("/page2") }, model, randomBytes(32).toString("hex"));
		expect(forged.isError).toBe(true);
		expect(site.hits("/page2")).toBe(0);
		const mismatch = await r.call("browser_open", { profile: "work", url: site.url("/page2") }, { caller: "model", session: "chat-b" }, r.session("chat-a").token);
		expect(mismatch.isError).toBe(true);
		expect(site.hits("/page2")).toBe(0);
		const unadvertised = await setup({}, false);
		await savedProfile(unadvertised);
		const blocked = await unadvertised.call("browser_open", { profile: "work", url: unadvertised.fixture.url("/page2") }, model);
		expect(blocked.isError).toBe(true);
		expect(unadvertised.fixture.hits("/page2")).toBe(0);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("verified Loop grant survives a new chat, but different subject, workspace and origin do not inherit it", async () => {
		const r = await setup();
		await grantLoop(r);
		for (const [name, loop] of [
			["different-id", { ...verifiedLoop, id: "loop-8" }],
			["different-workspace", { ...verifiedLoop, workspaceId: "workspace-b" }],
			["different-origin", { ...verifiedLoop, origin: "ephemeral" }],
		] as const) {
			r.session(name).loop = loop;
			expect((await r.call("browser_open", { profile: "work" }, { caller: "model", session: name })).isError).toBe(true);
		}
		r.session("chat-b").loop = verifiedLoop;
		const fresh = id(await r.call("browser_open", { profile: "work", url: r.fixture.url("/page2") }, other));
		expect(text(await r.call("browser_snapshot", { browserId: fresh }, other))).toContain(r.fixture.url("/page2"));
		expect((await r.call("browser_close", { browserId: fresh }, other)).isError).toBeFalsy();
	}, BROWSER_TEST_TIMEOUT_MS);

	test("a genuine session end while host read waits cannot restore chat or Loop authority", async () => {
		const r = await setup();
		await grantLoop(r);
		let entered!: () => void;
		let release!: () => void;
		const reading = new Promise<void>(resolve => { entered = resolve; });
		const gate = new Promise<void>(resolve => { release = resolve; });
		r.beforeRead(async () => { entered(); await gate; });
		const pending = r.call("browser_open", { profile: "work", url: r.fixture.url("/page2") }, model);
		await reading;
		await r.end("chat-a");
		release();
		expect((await pending).isError).toBe(true);
		expect(r.fixture.hits("/page2")).toBe(0);
		expect((await r.call("browser_open", { profile: "work" }, model)).isError).toBe(true);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("closing a browser leaves chat consent intact, but genuine session end clears it", async () => {
		const r = await setup();
		await savedProfile(r);
		expect((await r.call("browser_open", { profile: "work" }, model)).isError).toBe(true);
		expect((await r.call("browser_profile_consent", { name: "work", decision: "allow", scope: "chat" }, person)).isError).toBeFalsy();
		const first = id(await r.call("browser_open", { profile: "work" }, model));
		expect((await r.call("browser_close", { browserId: first }, model)).isError).toBeFalsy();
		const next = id(await r.call("browser_open", { profile: "work" }, model));
		expect(next).not.toBe(first);
		await r.end("chat-a");
		const replacement = r.session("chat-a");
		replacement.active = true;
		replacement.token = randomBytes(32).toString("hex");
		expect((await r.call("browser_snapshot", { browserId: next }, model)).isError).toBe(true);
		expect((await r.call("browser_open", { profile: "work" }, model)).isError).toBe(true);
	}, BROWSER_TEST_TIMEOUT_MS);

	test("expired approval and a changed verified Loop subject cannot authorize either scope", async () => {
		const r = await setup();
		await savedProfile(r);
		r.session("chat-a").loop = verifiedLoop;
		expect((await r.call("browser_open", { profile: "work" }, model)).isError).toBe(true);
		r.session("chat-a").loop = { ...verifiedLoop, id: "replacement-loop" };
		for (const scope of ["chat", "loop"] as const) {
			expect((await r.call("browser_profile_consent", { name: "work", decision: "allow", scope }, person)).isError).toBe(true);
		}
		r.session("chat-a").loop = verifiedLoop;
		expect((await r.call("browser_open", { profile: "work" }, model)).isError).toBe(true);
		try {
			setSystemTime(new Date(Date.now() + 11 * 60_000));
			for (const scope of ["chat", "loop"] as const) {
				expect((await r.call("browser_profile_consent", { name: "work", decision: "allow", scope }, person)).isError).toBe(true);
			}
		} finally {
			setSystemTime();
		}
		expect((await r.call("browser_open", { profile: "work" }, model)).isError).toBe(true);
	}, BROWSER_TEST_TIMEOUT_MS);
	test("a changed displayed subject cannot act on stale consent or alter the original Loop grant", async () => {
		const r = await setup();
		await grantLoop(r);
		const displayed = (await r.call("browser_profiles", {}, person)).structuredContent?.consents as Array<{ subject?: { workspaceId: string; id: string; origin: string } }>;
		const expectedSubject = displayed.find(row => row.subject)?.subject;
		expect(expectedSubject).toBeDefined();
		const stale = { name: "work", expectedSubject };
		r.session("chat-a").loop = { ...verifiedLoop, label: "Renamed Loop" };
		const sameIdentity = id(await r.call("browser_open", { profile: "work" }, model));
		expect((await r.call("browser_close", { browserId: sameIdentity }, model)).isError).toBeFalsy();
		const replacement = { ...verifiedLoop, id: "replacement-loop" };
		r.session("chat-c").loop = replacement;
		const changedModel: Who = { caller: "model", session: "chat-c" };
		const changedPerson: Who = { caller: "app", session: "chat-c" };
		expect((await r.call("browser_open", { profile: "work" }, changedModel)).isError).toBe(true);
		expect((await r.call("browser_profile_consent", { name: "work", decision: "allow", scope: "loop" }, changedPerson)).isError).toBeFalsy();
		r.session("chat-a").loop = replacement;
		expect((await r.call("browser_profile_consent", { ...stale, decision: "revoke", scope: "loop" }, person)).isError).toBe(true);
		const changedGranted = id(await r.call("browser_open", { profile: "work" }, changedModel));
		expect((await r.call("browser_close", { browserId: changedGranted }, changedModel)).isError).toBeFalsy();
		r.session("chat-b").loop = verifiedLoop;
		const originalGranted = id(await r.call("browser_open", { profile: "work" }, other));
		expect((await r.call("browser_close", { browserId: originalGranted }, other)).isError).toBeFalsy();
		r.session("chat-a").loop = undefined;
		expect((await r.call("browser_profile_consent", { ...stale, decision: "revoke", scope: "loop" }, person)).isError).toBe(true);
		const cleared = (await r.call("browser_profiles", {}, person)).structuredContent?.consents;
		expect(cleared).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "work", status: "pending" })]));
		expect((await r.call("browser_open", { profile: "work" }, model)).isError).toBe(true);
		const rows = (await r.call("browser_profiles", {}, person)).structuredContent?.consents as Array<{ name: string; status: string; scope: string; subject?: { workspaceId: string; id: string; origin: string } }>;
		const fresh = rows.find(row => row.name === "work" && row.status === "pending");
		expect(fresh).toBeDefined();
		expect(fresh?.scope).toBe("chat");
		expect(fresh?.subject).toBeUndefined();
	}, BROWSER_TEST_TIMEOUT_MS);
	test("stale subject decisions cannot deny or approve a fresh subject's pending request", async () => {
		const r = await setup();
		await savedProfile(r);
		r.session("chat-a").loop = verifiedLoop;
		expect((await r.call("browser_open", { profile: "work" }, model)).isError).toBe(true);
		const rows = (await r.call("browser_profiles", {}, person)).structuredContent?.consents as Array<{ name: string; status: string; subject?: { workspaceId: string; id: string; origin: string } }>;
		const original = rows.find(row => row.name === "work" && row.status === "pending");
		expect(original?.subject).toBeDefined();
		const replacement = { ...verifiedLoop, origin: "another-origin" };
		r.session("chat-a").loop = replacement;
		expect((await r.call("browser_open", { profile: "work" }, model)).isError).toBe(true);
		for (const decision of ["deny", "allow"] as const) {
			expect((await r.call("browser_profile_consent", { name: "work", decision, scope: "loop", expectedSubject: original?.subject }, person)).isError).toBe(true);
		}
		const pending = (await r.call("browser_profiles", {}, person)).structuredContent?.consents;
		expect(pending).toEqual(expect.arrayContaining([expect.objectContaining({ name: "work", status: "pending" })]));
		expect((await r.call("browser_profile_consent", { name: "work", decision: "allow", scope: "loop" }, person)).isError).toBeFalsy();
		const opened = id(await r.call("browser_open", { profile: "work" }, model));
		expect((await r.call("browser_close", { browserId: opened }, model)).isError).toBeFalsy();
	}, BROWSER_TEST_TIMEOUT_MS);


	test("revoking a persisted Loop grant blocks the next action in another chat", async () => {

		const r = await setup();
		await grantLoop(r);
		r.session("chat-b").loop = verifiedLoop;
		const browserId = id(await r.call("browser_open", { profile: "work" }, other));
		expect((await r.call("browser_profile_consent", { name: "work", decision: "revoke", scope: "loop" }, person)).isError).toBeFalsy();
		const denied = await r.call("browser_act", { browserId, actions: [{ kind: "navigate", url: r.fixture.url("/page2") }] }, other);
		expect(denied.isError).toBe(true);
		expect(r.fixture.hits("/page2")).toBe(0);
		expect((await r.call("browser_close", { browserId }, person)).isError).toBeFalsy();
	}, BROWSER_TEST_TIMEOUT_MS);
});
