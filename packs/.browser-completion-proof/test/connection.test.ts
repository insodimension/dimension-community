/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: Traction's campaign board says
 *  an account can post when it cannot (or cannot when it can), names the wrong
 *  account, leaks the human's own Chrome (the relay) into the report, or the
 *  host silently drops the whole report for being over its caps.
 *
 *  The report is built only from observations persisted per profile
 *  (store.ts) by the publish path (runtime.ts), and the Browser pack's own MCP
 *  server sends it as `notifications/ai.insodimension/connection` (the host
 *  contract, dimension#1219). The server half runs real Chrome against the
 *  local publish fixture over an in-memory MCP transport, capturing what the
 *  host would receive.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ARTIFACTORY_HOST_CONTEXT_EXTENSION_ID, ARTIFACTORY_HOST_CONTEXT_META_KEY, ARTIFACTORY_HOST_CONTEXT_READ_METHOD } from "@dimension/sdk/artifactory";
import * as fs from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { accountFromText, buildConnectionReport, type ConnectionReport, siteHost } from "../src/connection";
import type { PublishRecipe, PublishRecord } from "../src/contracts";
import { defaultColour } from "../src/profile-meta";
import { createBrowserServer } from "../src/server";
import { ProfileStore } from "../src/store";
import { approvePublish, BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, perform, racingClock, teardown } from "./fixture";
import { type PublishFixture, startPublishFixture } from "./publish-fixture";

const METHOD = "notifications/ai.insodimension/connection";
const T = 1_790_000_000_000;
/** What an unstamped confirm must carry: the pending record exactly as it was shown. */
const expectOf = (record: PublishRecord) => ({ origin: record.origin, profile: record.profile, values: record.fields.map((field) => field.value) });
const clients: Client[] = [];
const fixtures: PublishFixture[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	for (const fixture of fixtures.splice(0)) await fixture.stop();
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

async function storeAt(): Promise<ProfileStore> {
	return new ProfileStore(await createRoot());
}

// ---------------------------------------------------------------------------
// The report, from persisted observations
// ---------------------------------------------------------------------------

describe("connection report", () => {
	test("a check observed signed-in on x.com for traction-x-acme is exactly that entry, with observedAt and account", async () => {
		const store = await storeAt();
		const host = siteHost("https://x.com");
		expect(host).toBe("x.com");
		store.recordConnection("traction-x-acme", host as string, { signedIn: true, account: "@acme", observedAt: T });
		expect(buildConnectionReport(store.allConnections())).toEqual({
			profiles: { "traction-x-acme": { sites: { "x.com": { signedIn: true, account: "@acme", observedAt: T } } } },
		});
		// Keyed by the bare registrable domain, whatever subdomain the recipe's origin used.
		expect([siteHost("https://www.linkedin.com"), siteHost("https://old.reddit.com"), siteHost("https://www.bbc.co.uk")]).toEqual(["linkedin.com", "reddit.com", "bbc.co.uk"]);
	});

	test("sites key by the Public Suffix List's registrable domain, so unrelated sites under one suffix never share an entry", () => {
		expect(siteHost("https://shop.example.com.my")).toBe("example.com.my");
		expect(siteHost("https://mobile.x.com")).toBe("x.com");
		// Private suffixes too: two people's GitHub Pages are two sites.
		expect(siteHost("https://alice.github.io")).toBe("alice.github.io");
		expect(siteHost("https://bob.github.io")).toBe("bob.github.io");
		// No registrable domain: the host itself.
		expect([siteHost("http://localhost:3000"), siteHost("http://127.0.0.1:8080"), siteHost("http://[::1]:9")]).toEqual(["localhost", "127.0.0.1", "[::1]"]);
	});

	test("the account is the handle, not a mention in the display name nor an email's domain", () => {
		expect(accountFromText("Jane Doe (CEO @acme)\n@janedoe")).toBe("@janedoe");
		expect(accountFromText("alice@gmail.com")).toBe("alice@gmail.com");
		expect(accountFromText("Signed in as alice@gmail.com")).toBe("Signed in as alice@gmail.com");
	});

	test("a write that fails before the rename leaves the last file and no staging file behind", async () => {
		const store = await storeAt();
		store.recordConnection("acme", "x.com", { signedIn: true, account: "@acme", observedAt: T });
		const dir = store.profileDir("acme");
		const before = await readFile(join(dir, "connections.json"), "utf8");
		const fsync = spyOn(fs, "fsyncSync").mockImplementation(() => {
			throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
		});
		try {
			expect(() => store.recordConnection("acme", "x.com", { signedIn: false, observedAt: T + 1 })).toThrow("EIO");
		} finally {
			fsync.mockRestore();
		}
		expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(await readFile(join(dir, "connections.json"), "utf8")).toBe(before);
	});

	test("failed lock initialization releases only its own file so the same profile can be acquired and released again", async () => {
		const store = await storeAt();
		const slug = "lock-init-failure";
		const path = join(store.ensureProfile(slug), "runtime.lock");
		const realFsync = fs.fsyncSync;
		const fault = Object.assign(new Error("lock initialization I/O failure"), { code: "EIO" });
		let injected = false;
		const syncing = spyOn(fs, "fsyncSync").mockImplementation(fd => {
			let owned: fs.BigIntStats;
			let current: fs.BigIntStats;
			try {
				owned = fs.fstatSync(fd, { bigint: true });
				current = fs.lstatSync(path, { bigint: true });
			} catch {
				return realFsync(fd);
			}
			if (!injected && owned.dev === current.dev && owned.ino === current.ino) {
				injected = true;
				throw fault;
			}
			return realFsync(fd);
		});
		let failed: unknown;
		try {
			try {
				store.acquireLock(slug);
			} catch (error) {
				failed = error;
			}
		} finally {
			syncing.mockRestore();
		}
		expect(failed).toBe(fault);
		const acquired = store.acquireLock(slug);
		expect(store.heldElsewhere(slug)).toBe(true);
		store.releaseLock(acquired);
		expect(store.heldElsewhere(slug)).toBe(false);
		expect(fs.existsSync(path)).toBe(false);
	});

	test("failed lock initialization and release of the old token preserve a replacement owner's lock", async () => {
		const store = await storeAt();
		const slug = "lock-init-replaced";
		const path = join(store.ensureProfile(slug), "runtime.lock");
		const replacement = { pid: process.pid, token: "0".repeat(32), at: new Date().toISOString() };
		const realFsync = fs.fsyncSync;
		const fault = Object.assign(new Error("lock initialization I/O failure"), { code: "EIO" });
		let originalToken: string | undefined;
		const syncing = spyOn(fs, "fsyncSync").mockImplementation(fd => {
			let owned: fs.BigIntStats;
			let current: fs.BigIntStats;
			try {
				owned = fs.fstatSync(fd, { bigint: true });
				current = fs.lstatSync(path, { bigint: true });
			} catch {
				return realFsync(fd);
			}
			if (originalToken === undefined && owned.dev === current.dev && owned.ino === current.ino) {
				originalToken = z.object({ token: z.string() }).parse(JSON.parse(fs.readFileSync(path, "utf8"))).token;
				fs.unlinkSync(path);
				replacement.token = `${originalToken[0] === "0" ? "1" : "0"}${originalToken.slice(1)}`;
				fs.writeFileSync(path, `${JSON.stringify(replacement)}\n`, { flag: "wx", mode: 0o600 });
				throw fault;
			}
			return realFsync(fd);
		});
		let failed: unknown;
		try {
			try {
				store.acquireLock(slug);
			} catch (error) {
				failed = error;
			}
		} finally {
			syncing.mockRestore();
		}
		expect(failed).toBe(fault);
		expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual(replacement);
		let blocked: unknown;
		try {
			store.acquireLock(slug);
		} catch (error) {
			blocked = error;
		}
		expect(blocked).toMatchObject({ code: "profile_locked" });
		if (originalToken === undefined) throw new Error("the original lock was not initialized");
		store.releaseLock({ path, token: originalToken });
		expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual(replacement);
		store.releaseLock({ path, token: replacement.token });
		expect(fs.existsSync(path)).toBe(false);
	});

	test("an observed sign-out sets signedIn:false, and a deleted profile leaves the report", async () => {
		const store = await storeAt();
		store.recordConnection("traction-x-acme", "x.com", { signedIn: true, account: "@acme", observedAt: T });
		store.recordConnection("other", "x.com", { signedIn: true, observedAt: T });
		store.recordConnection("traction-x-acme", "x.com", { signedIn: false, observedAt: T + 1 });
		expect(buildConnectionReport(store.allConnections()).profiles["traction-x-acme"]).toEqual({ sites: { "x.com": { signedIn: false, observedAt: T + 1 } } });

		await rm(store.profileDir("traction-x-acme"), { recursive: true, force: true });
		expect(Object.keys(buildConnectionReport(store.allConnections()).profiles)).toEqual(["other"]);
	});

	test("the relay profile never appears", () => {
		const report = buildConnectionReport({
			relay: { "x.com": { signedIn: true, account: "@me", observedAt: T } },
			acme: { "x.com": { signedIn: true, observedAt: T } },
		});
		expect(Object.keys(report.profiles)).toEqual(["acme"]);
		expect(JSON.stringify(report)).not.toContain("relay");
	});

	test("each report is the whole map: a later observation, on another profile or another site, still carries the first", async () => {
		const store = await storeAt();
		store.recordConnection("traction-x-acme", "x.com", { signedIn: true, observedAt: T });
		store.recordConnection("traction-li-acme", "linkedin.com", { signedIn: false, observedAt: T + 5 });
		store.recordConnection("traction-x-acme", "reddit.com", { signedIn: true, observedAt: T + 9 });
		expect(buildConnectionReport(store.allConnections())).toEqual({
			profiles: {
				"traction-li-acme": { sites: { "linkedin.com": { signedIn: false, observedAt: T + 5 } } },
				"traction-x-acme": { sites: { "x.com": { signedIn: true, observedAt: T }, "reddit.com": { signedIn: true, observedAt: T + 9 } } },
			},
		});
	});

	test("over 64 KiB the oldest observations are dropped until it fits; an account over 256 UTF-8 bytes is omitted", () => {
		// 200 profiles × 20 sites, each observation one ms newer than the last.
		const observations: Record<string, Record<string, { signedIn: boolean; account: string; observedAt: number }>> = {};
		let n = 0;
		for (let p = 0; p < 200; p += 1) {
			const sites: Record<string, { signedIn: boolean; account: string; observedAt: number }> = {};
			for (let s = 0; s < 20; s += 1) sites[`site-${s}.example.com`] = { signedIn: true, account: `@account_${p}_${s}`, observedAt: T + n++ };
			observations[`profile-${String(p).padStart(3, "0")}`] = sites;
		}
		expect(Buffer.byteLength(JSON.stringify(buildConnectionReport({})))).toBeLessThan(100);
		const report = buildConnectionReport(observations);
		const bytes = Buffer.byteLength(JSON.stringify(report), "utf8");
		expect(bytes).toBeLessThanOrEqual(64 * 1024);
		const kept = Object.values(report.profiles).flatMap((profile) => Object.values(profile.sites).map((site) => site.observedAt));
		// It keeps as much as fits (not an empty map), and exactly the newest ones.
		expect(bytes).toBeGreaterThan(60 * 1024);
		expect(Math.min(...kept)).toBe(T + n - kept.length);
		expect(kept).toContain(T + n - 1);
		expect(report.profiles["profile-000"]).toBeUndefined();

		// 129 × "é" is 258 bytes: omitted, never cut to a different handle. 128 × "é" (256 bytes) is kept.
		const long = "é".repeat(129);
		const fits = "é".repeat(128);
		const capped = buildConnectionReport({ a: { "x.com": { signedIn: true, account: long, observedAt: T } }, b: { "x.com": { signedIn: true, account: fits, observedAt: T } } });
		expect(capped.profiles.a.sites["x.com"]).toEqual({ signedIn: true, observedAt: T });
		expect(capped.profiles.b.sites["x.com"].account).toBe(fits);
	});
});

// ---------------------------------------------------------------------------
// The server sends it
// ---------------------------------------------------------------------------

interface Captured {
	method: string;
	params: { report: ConnectionReport | null };
}
interface ToolResult {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
}

interface Session {
	server: McpServer;
	call: (name: string, args: Record<string, unknown>, caller?: "model" | "app") => Promise<ToolResult>;
	reports: Captured[];
	/** The first captured report (from `after` on) that satisfies `accept`. */
	report: (accept: (report: ConnectionReport) => boolean, after?: number) => Promise<ConnectionReport>;
	fixture: PublishFixture;
	store: ProfileStore;
	browserId: string;
	rootDir: string;
}

async function session(profile: string, seed?: (store: ProfileStore) => void, openerCaller: "model" | "app" = "model"): Promise<Session> {
	const fixture = startPublishFixture();
	fixtures.push(fixture);
	const rootDir = await createRoot();
	const store = new ProfileStore(rootDir);
	seed?.(store);
	const runtime = newRuntime(rootDir);
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir, presets: [] });
	const reports: Captured[] = [];
	// Each waiter is re-checked on every notification: the test awaits the report itself, never a guessed delay.
	const waiters: Array<() => void> = [];
	const client = new Client({ name: "connection-test", version: "0.0.0" }, { capabilities: { extensions: { [ARTIFACTORY_HOST_CONTEXT_EXTENSION_ID]: {} } } });
	const sessionId = "connection-chat";
	const token = randomBytes(32).toString("hex");
	client.setRequestHandler(z.object({ method: z.literal(ARTIFACTORY_HOST_CONTEXT_READ_METHOD), params: z.object({ sessionId: z.string(), token: z.string() }) }), async request => {
		if (request.params.sessionId !== sessionId || request.params.token !== token) throw new Error("Unknown host context");
		return { active: true, sessionId };
	});
	client.fallbackNotificationHandler = async (notification) => {
		reports.push(notification as unknown as Captured);
		for (const wake of waiters.splice(0)) wake();
	};
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	const call = async (name: string, args: Record<string, unknown>, caller: "model" | "app" = "model") => (await client.callTool({ name, arguments: args, _meta: {
		"ai.insodimension/caller": caller,
		"ai.insodimension/session": { sessionId },
		[ARTIFACTORY_HOST_CONTEXT_META_KEY]: { sessionId, token },
	} })) as ToolResult;
	const report = async (accept: (report: ConnectionReport) => boolean, after = 0): Promise<ConnectionReport> => {
		for (;;) {
			const found = reports.slice(after).find((note) => note.method === METHOD && note.params.report !== null && accept(note.params.report));
			if (found) return found.params.report as ConnectionReport;
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push(resolve);
			await promise;
		}
	};
	const opened = await call("browser_open", { profile }, openerCaller);
	expect(opened.isError).toBeFalsy();
	const browserId = opened.structuredContent?.browserId as string;
	await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/login") });
	return { server, call, reports, report, fixture, store, browserId, rootDir };
}

function recipe(fixture: PublishFixture, overrides: Partial<PublishRecipe> = {}): PublishRecipe {
	return {
		origin: fixture.origin,
		composeUrl: fixture.url("/compose?v=nav"),
		signedIn: "#me",
		account: "#me",
		fields: [{ selector: "#text", value: "hello" }],
		submit: "#post",
		receipt: { path: "/alice/status/{digits}" },
		...overrides,
	};
}

const seedAcme = (store: ProfileStore): void => store.recordConnection("traction-x-acme", "x.com", { signedIn: true, account: "@acme", observedAt: T });
/** A profile as the host is told of it: its sites, and the label and colour a profile with no profile.json gets. */
const ACME = { label: "traction-x-acme", colour: defaultColour("traction-x-acme"), sites: { "x.com": { signedIn: true, account: "@acme", observedAt: T } } };

describeWithChrome("the server's connection report", () => {
	test(
		"at startup it sends the persisted observations under the exact method",
		async () => {
			const s = await session("fresh", seedAcme);
			const report = await s.report(() => true);
			expect(s.reports[0].method).toBe(METHOD);
			expect(report).toEqual({ profiles: { "traction-x-acme": ACME } });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a check and a post each send the whole map, with the account read from the page",
		async () => {
			const s = await session("acme", seedAcme);
			const checked = await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture), mode: "check" });
			expect(checked.structuredContent).toMatchObject({ status: "signed-in", account: "@alice" });
			const afterCheck = await s.report((report) => report.profiles.acme !== undefined);
			const seen = afterCheck.profiles.acme.sites["127.0.0.1"];
			expect(seen).toMatchObject({ signedIn: true, account: "@alice" });
			expect(afterCheck.profiles["traction-x-acme"]).toEqual(ACME);

			const mark = s.reports.length;
			// A post goes out only if the board approved exactly this text for this profile.
			const posting = recipe(s.fixture);
			await approvePublish(s.rootDir, { origin: posting.origin, profile: "acme", values: posting.fields.map((field) => field.value) });
			const parked = await s.call("browser_publish", { browserId: s.browserId, recipe: posting, mode: "post" });
			const publishId = parked.structuredContent?.publishId as string;
			// Parking is not an observation; only the post reaching `posted` is.
			const posted = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId, expect: expectOf(parked.structuredContent as unknown as PublishRecord) });
			expect(posted.structuredContent?.status).toBe("posted");
			const afterPost = await s.report((report) => (report.profiles.acme?.sites["127.0.0.1"]?.observedAt ?? 0) > seen.observedAt, mark);
			expect(afterPost.profiles.acme.sites["127.0.0.1"]).toMatchObject({ signedIn: true, account: "@alice" });
			expect(afterPost.profiles["traction-x-acme"]).toEqual(ACME);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a check that reaches no verdict (the compose page never opened) records nothing for its host",
		async () => {
			const s = await session("acme");
			const unreachable = "http://localhost:1";
			const failed = await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture, { origin: unreachable, composeUrl: `${unreachable}/compose` }), mode: "check" });
			expect(failed.structuredContent?.status).toBe("failed");
			await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture), mode: "check" });
			const report = await s.report((next) => next.profiles.acme !== undefined);
			expect(Object.keys(report.profiles.acme.sites)).toEqual(["127.0.0.1"]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a check that finds the profile signed out sends signedIn:false, and deleting a profile sends the map without it",
		async () => {
			const s = await session("acme", seedAcme);
			await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture), mode: "check" });
			await s.report((report) => report.profiles.acme?.sites["127.0.0.1"]?.signedIn === true);
			const compose = s.fixture.hits("/compose");
			const out = await racingClock(
				() => s.fixture.hits("/compose") > compose,
				s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture, { signedIn: "#nobody-signed-in" }), mode: "check" }),
			);
			expect(out.structuredContent?.status).toBe("not-signed-in");
			const signedOut = await s.report((report) => report.profiles.acme?.sites["127.0.0.1"]?.signedIn === false);
			expect(Object.keys(signedOut.profiles.acme.sites["127.0.0.1"]).sort()).toEqual(["observedAt", "signedIn"]);

			const mark = s.reports.length;
			await rm(s.store.profileDir("traction-x-acme"), { recursive: true, force: true });
			const afterDelete = await s.report(() => true, mark);
			expect(Object.keys(afterDelete.profiles)).toEqual(["acme"]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a send that fails is logged and the tool call still succeeds",
		async () => {
			const s = await session("acme");
			await s.report(() => true);
			s.server.server.notification = async () => {
				throw new Error("transport gone");
			};
			const { promise: failureLogged, resolve } = Promise.withResolvers<string>();
			const logged = spyOn(console, "error").mockImplementation((...args: unknown[]) => resolve(args.map(String).join(" ")));
			try {
				const checked = await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture), mode: "check" });
				expect(checked.isError).toBeFalsy();
				expect(checked.structuredContent?.status).toBe("signed-in");
				expect(await failureLogged).toBe("Browser connection report was not sent: transport gone");
			} finally {
				logged.mockRestore();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an account element showing a saved password in plain text never puts the password on disk or in a report, on a check or a post",
		async () => {
			const PASSWORD = "Zq7kPw9Lr4tVb8eXm2Na";
			const s = await session("acme", (store) => {
				fs.writeFileSync(join(store.ensureProfile("acme"), "credentials.json"), `${JSON.stringify({ version: 1, origins: { "https://example.com": PASSWORD } })}\n`);
			}, "app");
			expect((await s.call("browser_close", { browserId: s.browserId }, "app")).isError).toBeFalsy();
			expect((await s.call("browser_open", { profile: "acme" }, "model")).isError).toBe(true);
			expect((await s.call("browser_profile_consent", { name: "acme", decision: "allow", scope: "chat" }, "app")).isError).toBeFalsy();
			const adopted = await s.call("browser_open", { profile: "acme" }, "model");
			expect(adopted.isError).toBeFalsy();
			s.browserId = adopted.structuredContent?.browserId as string;
			const revealed = recipe(s.fixture, { composeUrl: s.fixture.url(`/compose?v=nav&shown=${encodeURIComponent(`Your new password is ${PASSWORD}`)}`), account: "#shown" });
			const onDisk = (): string => fs.readFileSync(join(s.store.profileDir("acme"), "connections.json"), "utf8");

			const checked = await s.call("browser_publish", { browserId: s.browserId, recipe: revealed, mode: "check" });
			expect(checked.structuredContent?.status).toBe("signed-in");
			expect(onDisk()).not.toContain(PASSWORD);
			const afterCheck = await s.report((report) => report.profiles.acme !== undefined);
			expect(afterCheck.profiles.acme.sites["127.0.0.1"].account).toBe("Your new password is [saved password]");

			const mark = s.reports.length;
			const seen = afterCheck.profiles.acme.sites["127.0.0.1"].observedAt;
			await approvePublish(s.rootDir, { origin: revealed.origin, profile: "acme", values: revealed.fields.map((field) => field.value) });
			const parked = await s.call("browser_publish", { browserId: s.browserId, recipe: revealed, mode: "post" });
			const posted = await s.call("browser_publish_confirm", { browserId: s.browserId, publishId: parked.structuredContent?.publishId as string, expect: expectOf(parked.structuredContent as unknown as PublishRecord) });
			expect(posted.structuredContent?.status).toBe("posted");
			expect(onDisk()).not.toContain(PASSWORD);
			const afterPost = await s.report((report) => (report.profiles.acme?.sites["127.0.0.1"]?.observedAt ?? 0) > seen, mark);
			expect(afterPost.profiles.acme.sites["127.0.0.1"].account).toBe("Your new password is [saved password]");
			expect(JSON.stringify(s.reports)).not.toContain(PASSWORD);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an account selector on a form control (password input, textarea, select), or on an element holding them, reads nothing: no account in the result or the report",
		async () => {
			const s = await session("acme");
			const controls = s.fixture.url("/compose?v=nav&controls");
			for (const account of ["#secret", "#draft", "#pick", "#controls"]) {
				const checked = await s.call("browser_publish", { browserId: s.browserId, recipe: recipe(s.fixture, { composeUrl: controls, account }), mode: "check" });
				expect(checked.structuredContent?.status).toBe("signed-in");
				expect(checked.structuredContent?.account).toBeUndefined();
				expect(s.store.connections("acme")["127.0.0.1"]).not.toHaveProperty("account");
			}
			const report = await s.report((next) => next.profiles.acme !== undefined);
			expect(report.profiles.acme.sites["127.0.0.1"]).not.toHaveProperty("account");
			expect(JSON.stringify(s.reports)).not.toMatch(/@typed|@drafted|@picked|@other/);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
