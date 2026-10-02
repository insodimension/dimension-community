/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: "use my work profile" does not
 *  work — the agent cannot see the tool in a Code, Build or Chat session, or is
 *  sent the list twice (the host appends `structuredContent` to a model's turn
 *  whenever it differs from the text), or is handed a payload that grows with
 *  every profile an agent ever left behind; or the Browser View, which reads
 *  the same tool as the human, stops getting its list; or the dock panel and
 *  the agent are told different things about the same profile.
 *
 *  The real MCP server over an in-memory transport, the way a host reaches it.
 *  Chrome only where a browser has to be open to be held.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { App } from "@modelcontextprotocol/ext-apps";
import { BrowserClient } from "../app/view/browser-client";
import { type ConnectionReport } from "../src/connection";
import { profileRows } from "../src/dock/report";
import { createBrowserServer } from "../src/server";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, teardown, waitUntil } from "./fixture";
import { ProfileStore } from "../src/store";

const textOf = (result: ToolResult): string => result.content.map((block) => block.text ?? "").join("");
const CALLER = "ai.insodimension/caller";
const SESSION = "ai.insodimension/session";
const SPACES = "ai.insodimension/spaces";
const REPORT = "notifications/ai.insodimension/connection";
const NOW = Date.now();
const clients: Client[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

const Result = z.object({
	isError: z.boolean().optional(),
	content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
	structuredContent: z.record(z.string(), z.unknown()).optional(),
});
type ToolResult = z.infer<typeof Result>;
/** The answer a model reads, exactly: any other key, at any depth, fails the parse. No `account`: that is shown to the person, not the model. */
const Listing = z
	.object({
		profiles: z.array(
			z
				.object({
					name: z.string(),
					label: z.string(),
					colour: z.string(),
					heldBy: z.string().nullable(),
					sites: z.array(z.object({ site: z.string(), signedIn: z.boolean().nullable(), seenAt: z.string() }).strict()),
				})
				.strict(),
		),
		omitted: z.number().optional(),
	})
	.strict();
/** What the View is sent: the same list, with each site's account. */
const ViewList = z.object({
	profiles: z.array(
		z.object({ name: z.string(), label: z.string(), colour: z.string(), sites: z.array(z.object({ site: z.string(), account: z.string().optional(), signedIn: z.boolean().nullable() })) }),
	),
});
const listOf = (result: ToolResult) => Listing.parse(JSON.parse(textOf(result)));
/** The markers a host reads off a tool: which spaces may see it, and whether only the View may call it. */
const ToolMeta = z.object({ ui: z.object({ visibility: z.array(z.string()).optional() }).optional(), [SPACES]: z.array(z.string()).optional() });
interface Who {
	caller: "model" | "app";
	session?: string;
}
interface Rig {
	call(name: string, args: Record<string, unknown>, who?: Who): Promise<ToolResult>;
	client: Client;
	store: ProfileStore;
	reports: ConnectionReport[];
}

async function connect(seed: (store: ProfileStore) => void = () => undefined): Promise<Rig> {
	const rootDir = await createRoot();
	const store = new ProfileStore(rootDir);
	seed(store);
	const runtime = newRuntime(rootDir);
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir, presets: [] });
	const client = new Client({ name: "profiles-tool-test", version: "0.0.0" });
	const reports: ConnectionReport[] = [];
	client.fallbackNotificationHandler = async (notification) => {
		const params = (notification as { method: string; params?: { report?: ConnectionReport | null } }).params;
		if (notification.method === REPORT && params?.report) reports.push(params.report);
	};
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	const call: Rig["call"] = async (name, args, who) =>
		Result.parse(
			await client.callTool({
				name,
				arguments: args,
				...(who === undefined ? {} : { _meta: { [CALLER]: who.caller, ...(who.session === undefined ? {} : { [SESSION]: { sessionId: who.session } }) } }),
			}),
		);
	return { call, client, store, reports };
}

const MODEL = { caller: "model", session: "s-1" } as const;
const VIEW = { caller: "app", session: "s-1" } as const;

describe("browser_profiles, as a host offers it", () => {
	test("it is on every space's tool list and read-only, unlike the Traction-only tools beside it; the View-only tools are not offered to a model", async () => {
		const { client } = await connect();
		const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
		const profiles = tools.get("browser_profiles");
		expect(profiles).toBeDefined();
		expect(profiles?.annotations?.readOnlyHint).toBe(true);
		// The host leaves a tool out of a space only by this marker, and out of a model's list only by `visibility: ["app"]`.
		const meta = ToolMeta.parse(profiles?._meta ?? {});
		expect(meta[SPACES]).toBeUndefined();
		expect(meta.ui?.visibility).toBeUndefined();
		expect(ToolMeta.parse(tools.get("browser_task")?._meta)[SPACES]).toEqual(["traction"]);
		expect(ToolMeta.parse(tools.get("browser_frame")?._meta).ui?.visibility).toEqual(["app"]);
	});

	test("its definition stays tiny: every agent in every space pays for it on every turn", async () => {
		const { client } = await connect();
		const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "browser_profiles");
		const bytes = Buffer.byteLength(JSON.stringify({ name: tool?.name, description: tool?.description, input_schema: tool?.inputSchema }));
		// 108 tokens (435 bytes) when measured (o200k_base); the bytes bound it without a tokenizer in the pack. The target was 110 tokens or less.
		expect(bytes).toBeLessThanOrEqual(450);
		expect(tool?.inputSchema.properties ?? {}).toEqual({});
	});
});

describe("what each caller is sent", () => {
	const seed = (store: ProfileStore): void => {
		store.saveMeta("work", { label: "Work", colour: "blue" });
		store.recordConnection("work", "x.com", { signedIn: true, account: "@acmeco", observedAt: NOW - 2 * 3_600_000 });
		store.ensureProfile("personal");
	};

	test("a model gets one compact text and no structured copy; the View gets the same list as structured content, with each site's account", async () => {
		const { call } = await connect(seed);
		const asModel = await call("browser_profiles", {}, MODEL);
		expect(asModel.isError).toBeFalsy();
		expect(asModel.structuredContent).toBeUndefined();
		const listed = listOf(asModel);
		expect(listed.profiles.map((profile) => profile.name)).toEqual(["personal", "work"]);
		const seenAt = new Date(NOW - 2 * 3_600_000).toISOString();
		expect(listed.profiles[1]).toEqual({ name: "work", label: "Work", colour: "blue", heldBy: null, sites: [{ site: "x.com", signedIn: true, seenAt }] });

		const asView = await call("browser_profiles", {}, VIEW);
		expect(asView.structuredContent).toEqual({
			profiles: [
				{ name: "personal", label: "personal", colour: expect.any(String), heldBy: null, sites: [] },
				{ name: "work", label: "Work", colour: "blue", heldBy: null, sites: [{ site: "x.com", account: "@acmeco", signedIn: true, seenAt }] },
			],
		});
		// An unstamped call (no host) is treated as a model.
		expect((await call("browser_profiles", {})).structuredContent).toBeUndefined();
	});

	test("a model is never told whose account a site is — no email, no handle — while the View is: until a consent gate exists, accounts are shown to the person, not to the model", async () => {
		const { call } = await connect((store) => {
			store.recordConnection("work", "google.com", { signedIn: true, account: "work@acme.com", observedAt: NOW - 1_000 });
			store.recordConnection("work", "x.com", { signedIn: true, account: "@acmeco", observedAt: NOW - 2_000 });
			store.recordConnection("work", "bsky.app", { signedIn: true, account: "@acme.bsky.social", observedAt: NOW - 3_000 });
			store.recordConnection("work", "reddit.com", { signedIn: true, observedAt: NOW - 4_000 });
		});
		for (const who of [MODEL, undefined]) {
			const text = textOf(await call("browser_profiles", {}, who));
			expect(text).not.toMatch(/acme|@/i);
			// What a model can still act on: which sites are signed in, and when that was seen.
			expect(listOf({ content: [{ type: "text", text }] }).profiles[0]?.sites.map((site) => [site.site, site.signedIn])).toEqual([
				["google.com", true],
				["x.com", true],
				["bsky.app", true],
				["reddit.com", true],
			]);
		}
		const view = JSON.stringify((await call("browser_profiles", {}, VIEW)).structuredContent);
		for (const account of ["work@acme.com", "@acmeco", "@acme.bsky.social"]) expect(view).toContain(account);
	});

	test("the View, which reads this tool for the saved profiles, gets each with its label, colour and where it is signed in", async () => {
		const { client } = await connect(seed);
		// The View's host is the same server, called as the human: exactly the stamp a host puts on its calls.
		const host = { callServerTool: (request: { name: string; arguments?: Record<string, unknown> }) => client.callTool({ ...request, _meta: { [CALLER]: "app" } }) } as unknown as App;
		const profiles = await new BrowserClient(host).profiles();
		expect(profiles.map((profile) => [profile.name, profile.label, profile.heldBy])).toEqual([["personal", "personal", null], ["work", "Work", null]]);
		expect(profiles[1]?.sites.map((site) => [site.site, site.account])).toEqual([["x.com", "@acmeco"]]);
	});

	test("the dock panel and the lists agree: the report the panel is sent carries the View's label, colour, sites and accounts, and the sites and sign-in state the agent reads", async () => {
		const { call, reports } = await connect(seed);
		// The first report is sent once the host has initialised.
		await waitUntil("the first report", () => reports, (seen) => seen.length > 0);
		const agent = listOf(await call("browser_profiles", {}, MODEL)).profiles;
		const person = ViewList.parse((await call("browser_profiles", {}, VIEW)).structuredContent).profiles;
		const rows = profileRows({ connected: true, reported: reports.at(-1) });
		expect(rows).toHaveLength(1);
		const [row] = rows;
		const mine = person.find((profile) => profile.name === "work");
		const theirs = agent.find((profile) => profile.name === "work");
		expect(row).toMatchObject({ name: "work", label: mine?.label, colour: mine?.colour });
		expect(row?.sites.map(({ host, account, signedIn }) => ({ site: host, ...(account === undefined ? {} : { account }), signedIn }))).toEqual(
			(mine?.sites ?? []).map(({ site, account, signedIn }) => ({ site, ...(account === undefined ? {} : { account }), signedIn })),
		);
		expect(row?.sites.map(({ host, signedIn }) => [host, signedIn])).toEqual((theirs?.sites ?? []).map(({ site, signedIn }) => [site, signedIn]));
	});
});

describeWithChrome("opening a profile by the name an agent was given", () => {
	const errorOf = (result: ToolResult): string | undefined => (result.isError ? textOf(result) : undefined);

	test(
		"a label opens it, the same chat asking again gets the same browser, and another chat is told who holds it — in words, never an id",
		async () => {
			const { call } = await connect((store) => store.saveMeta("acme-work", { label: "Work Account" }));
			const first = await call("browser_open", { profile: "work account" }, MODEL);
			expect(first.structuredContent).toMatchObject({ profile: "acme-work" });
			const again = await call("browser_open", { profile: "ACME-WORK" }, MODEL);
			expect(again.structuredContent?.browserId).toBe(first.structuredContent?.browserId);

			const other = errorOf(await call("browser_open", { profile: "Work Account" }, { caller: "model", session: "s-2" }));
			expect(other).toContain("held by another chat");
			expect(other).not.toContain(String(first.structuredContent?.browserId));
			// The View's own message for a taken profile still recognises it.
			expect(other).toMatch(/profile "[^"]*" is already (?:open|in use)/);

			expect(listOf(await call("browser_profiles", {}, { caller: "model", session: "s-2" })).profiles.map((profile) => profile.heldBy)).toEqual(["another chat"]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a name two profiles answer to is an error that lists them, and nothing is opened",
		async () => {
			const { call } = await connect((store) => {
				store.saveMeta("a", { label: "Shared" });
				store.saveMeta("b", { label: "shared" });
			});
			const refused = await call("browser_open", { profile: "SHARED" }, MODEL);
			expect(refused.isError).toBe(true);
			expect(textOf(refused)).toContain("Shared (a)");
			expect(textOf(refused)).toContain("shared (b)");
			expect(listOf(await call("browser_profiles", {}, MODEL)).profiles.map((profile) => profile.heldBy)).toEqual([null, null]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"opening a profile after the browser build under it changed tells the person once, in the open result alone",
		async () => {
			const { call, store } = await connect((s) => s.saveMeta("work", { app: "msedge" }));
			const opened = await call("browser_open", { profile: "work" }, MODEL);
			// The test browser is a `custom` build; the profile was last run in Edge.
			expect(String(opened.structuredContent?.notice)).toMatch(/last opened in Edge; this browser is a custom browser/);
			expect(store.meta("work").app).toBe("custom");
			const state = await call("browser_state", { browserId: opened.structuredContent?.browserId }, MODEL);
			expect(textOf(state)).not.toContain("notice");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the connection report the host receives carries each profile's label and colour, and a visited site as not checked",
		async () => {
			const { reports, store } = await connect((s) => {
				s.saveMeta("work", { label: "Work", colour: "orange" });
				s.recordConnection("work", "x.com", { signedIn: true, observedAt: NOW });
				s.recordConnection("work", "bbc.co.uk", { signedIn: null, observedAt: NOW - 1 });
			});
			await waitUntil("the first report", () => reports, (seen) => seen.length > 0);
			expect(reports.at(-1)?.profiles.work).toEqual({
				label: "Work",
				colour: "orange",
				sites: { "x.com": { signedIn: true, observedAt: NOW }, "bbc.co.uk": { signedIn: null, observedAt: NOW - 1 } },
			});
			expect(store.meta("work")).toMatchObject({ label: "Work" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
