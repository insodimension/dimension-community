/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an agent that opens a browser
 *  "just to test localhost" makes a Browser View pane pop up on the person's
 *  screen (and a live screencast start) every single time — or, the other way
 *  round, the person can no longer ask to watch a browser the agent holds.
 *
 *  The host mounts the View from a tool's STATIC `_meta.ui.resourceUri`, never
 *  from its result. So which tools carry one IS the contract: `browser_open` is
 *  headless; `browser_view` (show the human a browser, or open one they watch)
 *  and `browser_publish` (the human must Post) are the only mounting tools.
 *  These run over an in-memory MCP transport against a recording runtime.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { BrowserAction, BrowserOpenOptions, BrowserRuntimePort, BrowserState, TaskRequest } from "../src/contracts";
import { BROWSER_VIEW_URI, createBrowserServer } from "../src/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRoot, teardown } from "./fixture";

const clients: Client[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	await teardown();
});

const stateOf = (browserId: string, url = "about:blank"): BrowserState => ({ browserId, url, tabs: [] }) as unknown as BrowserState;

const UiMeta = z.object({ resourceUri: z.string().optional(), visibility: z.array(z.string()).optional() });
const uiOf = (tool: { _meta?: Record<string, unknown> }) => UiMeta.parse(tool._meta?.ui ?? {});

interface Calls {
	opened: BrowserOpenOptions[];
	read: string[];
	navigated: string[];
	tasked: TaskRequest[];
}

/** Just enough runtime for the server to boot and answer open/view: every call recorded. */
function recordingRuntime(calls: Calls): BrowserRuntimePort {
	const runtime: Pick<BrowserRuntimePort, "open" | "state" | "liveState" | "watchFrames" | "viewing" | "act" | "startTask" | "connections" | "profileMeta" | "onConnectionsChanged" | "dispose"> = {
		open: async (options) => {
			calls.opened.push(options);
			return stateOf("o".repeat(32));
		},
		state: async (browserId) => {
			calls.read.push(browserId);
			return stateOf(browserId, "http://held.test/");
		},
		liveState: async (browserId) => stateOf(browserId, "http://held.test/"),
		watchFrames: () => () => {},
		viewing: () => () => {},
		act: async (browserId, action: BrowserAction) => {
			calls.navigated.push(action.url ?? "");
			return { status: "completed", state: stateOf(browserId, action.url) };
		},
		startTask: async (_browserId, request) => {
			calls.tasked.push(request);
			throw new Error("task recorded");
		},
		connections: async () => ({}),
		profileMeta: async () => ({}),
		onConnectionsChanged: () => () => {},
		dispose: async () => {},
	};
	return runtime as BrowserRuntimePort;
}

/** The jev tools are registered only where TYPESAFE_API_KEY is set when the server is created, so the key is set around that moment alone. */
async function connect(jevKey?: string): Promise<{ client: Client; calls: Calls; server: McpServer }> {
	const rootDir = await createRoot();
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const calls: Calls = { opened: [], read: [], navigated: [], tasked: [] };
	const savedKey = process.env.TYPESAFE_API_KEY;
	if (jevKey === undefined) delete process.env.TYPESAFE_API_KEY;
	else process.env.TYPESAFE_API_KEY = jevKey;
	let server: McpServer;
	try {
		server = await createBrowserServer({ runtime: recordingRuntime(calls), viewDir, presets: [] });
	} finally {
		if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = savedKey;
	}
	const client = new Client({ name: "view-mounting-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	return { client, calls, server };
}

test("only browser_view and browser_publish mount the View: browser_open is headless", async () => {
	const { client } = await connect();
	const tools = (await client.listTools()).tools;
	const mounting = tools.filter((tool) => uiOf(tool).resourceUri !== undefined).map((tool) => tool.name).sort();
	expect(mounting).toEqual(["browser_publish", "browser_view"]);
	expect(uiOf(tools.find((tool) => tool.name === "browser_view") ?? { _meta: {} }).resourceUri).toBe(BROWSER_VIEW_URI);
	// The View's own start page still opens browsers through browser_open (as the app), so the model may too.
	expect(uiOf(tools.find((tool) => tool.name === "browser_open") ?? { _meta: {} }).visibility).toBeUndefined();
});

test("publishing and task agents are offered to Traction alone; every browsing tool names no audience", async () => {
	const { client } = await connect("jev-key");
	const modelTools = (await client.listTools()).tools.filter((tool) => uiOf(tool).visibility === undefined);
	const audienceOf = (tool: { _meta?: Record<string, unknown> }) => tool._meta?.["ai.insodimension/spaces"];

	// A dev session is listed these ten and nothing else; a new tool must choose a side to get past this list.
	expect(modelTools.filter((tool) => audienceOf(tool) === undefined).map((tool) => tool.name).sort()).toEqual([
		"browser_act", "browser_close", "browser_inspect", "browser_open", "browser_profiles", "browser_read",
		"browser_screenshot", "browser_snapshot", "browser_state", "browser_view",
	]);
	const traction = modelTools.filter((tool) => audienceOf(tool) !== undefined);
	expect(traction.map((tool) => tool.name).sort()).toEqual([
		"browser_publish", "browser_publish_cancel", "browser_publish_confirm", "browser_publish_presets", "browser_publish_wait",
		"browser_task", "browser_task_cancel", "browser_task_wait",
	]);
	expect(traction.map(audienceOf)).toEqual(traction.map(() => ["traction"]));
});

test("without jev's key a session is offered no browser_task tool; with it, those three and nothing else are added", async () => {
	const names = async (key?: string): Promise<string[]> => (await (await connect(key)).client.listTools()).tools.map((tool) => tool.name).sort();

	const withKey = await names("jev-key");
	for (const unset of [undefined, "", "   "]) {
		const without = await names(unset);
		expect({ key: unset, task: without.filter((name) => name.startsWith("browser_task")) }).toEqual({ key: unset, task: [] });
		expect({ key: unset, rest: withKey.filter((name) => !without.includes(name)) }).toEqual({ key: unset, rest: ["browser_task", "browser_task_cancel", "browser_task_wait"] });
		expect(without.filter((name) => !withKey.includes(name))).toEqual([]);
	}
});

test("without jev's key no tool a session is offered names browser_task or a task running; with it, browser_act, browser_control, browser_leave and browser_publish do", async () => {
	const offered = async (key?: string) => (await (await connect(key)).client.listTools()).tools;
	const mentions = (tools: Array<{ name: string }>) => tools.filter((tool) => /browser_task|task runs/.test(JSON.stringify(tool)) && !tool.name.startsWith("browser_task")).map((tool) => tool.name).sort();

	expect(mentions(await offered("jev-key"))).toEqual(["browser_act", "browser_control", "browser_leave", "browser_publish"]);
	for (const unset of [undefined, "", "   "]) {
		expect({ key: unset, mentions: mentions(await offered(unset)) }).toEqual({ key: unset, mentions: [] });
	}
});

test("a browser_task call that still passes the removed `agent` is not an error and starts exactly the task asked for: the key is dropped like any unknown one", async () => {
	const { client, calls } = await connect("jev-key");
	const call = (extra: Record<string, unknown>) => client.callTool({ name: "browser_task", arguments: { browserId: "b".repeat(32), task: "fill the form", ...extra } });

	for (const agent of ["jev", "gpt"]) {
		const started = await call({ agent });
		// The runtime's own answer, not a refusal of the arguments.
		expect(JSON.stringify(started.content)).toContain("task recorded");
	}
	await call({});

	expect(calls.tasked).toEqual([{ task: "fill the form" }, { task: "fill the form" }, { task: "fill the form" }]);
});

test("browser_view with a browserId shows that browser and opens nothing; it never repoints a held browser", async () => {
	const { client, calls } = await connect();
	const held = "h".repeat(32);

	const shown = await client.callTool({ name: "browser_view", arguments: { browserId: held } });

	expect(shown.isError).toBeFalsy();
	expect(shown.structuredContent).toMatchObject({ browserId: held, url: "http://held.test/" });
	expect(calls).toMatchObject({ opened: [], read: [held], navigated: [] });
	// profile/engine/url describe a NEW browser: with a browserId they would be silently ignored, so they are refused.
	for (const stray of [{ profile: "work" }, { engine: "chromium" }, { url: "http://x.test/" }]) {
		const refused = await client.callTool({ name: "browser_view", arguments: { browserId: held, ...stray } });
		expect(refused.isError).toBe(true);
	}
	expect(calls).toMatchObject({ opened: [], read: [held], navigated: [] });
});

test("browser_view without a browserId opens the browser exactly as browser_open does and navigates to url", async () => {
	const { client, calls } = await connect();

	const opened = await client.callTool({ name: "browser_view", arguments: { profile: "work", url: "http://app.test/" } });

	expect(opened.isError).toBeFalsy();
	expect(calls.opened).toEqual([{ profile: "work" }]);
	expect(calls.navigated).toEqual(["http://app.test/"]);
	expect(opened.structuredContent).toMatchObject({ browserId: "o".repeat(32), url: "http://app.test/" });

	// Same door as browser_open: a name that cannot be a profile's name or label (empty, or longer than a label) never reaches the runtime.
	for (const profile of ["", "x".repeat(49)]) {
		expect((await client.callTool({ name: "browser_view", arguments: { profile } })).isError).toBe(true);
	}
	expect(calls.opened).toHaveLength(1);
});

test("browser_stream is the View's own tool: a model is never offered it, and the View gets the address and token of a listener that serves its browser", async () => {
	const { client } = await connect();
	const stream = (await client.listTools()).tools.find((tool) => tool.name === "browser_stream");
	expect(uiOf(stream ?? { _meta: {} }).visibility).toEqual(["app"]);

	const granted = await client.callTool({ name: "browser_stream", arguments: { browserId: "s".repeat(32) } });
	expect(granted.isError).toBeFalsy();
	const { origin, token } = z.object({ origin: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/), token: z.string().min(32) }).parse(granted.structuredContent);
	const streamed = await fetch(`${origin}/s/${token}`, { headers: { origin: "null" } });
	expect(streamed.status).toBe(200);
	await streamed.body?.cancel();
	expect((await fetch(`${origin}/s/${token}x`, { headers: { origin: "null" } })).status).toBe(404);
});

test("the View may reach 127.0.0.1 with fetch and nothing more: the policy it declares grants connect and no resource directive", async () => {
	const { client } = await connect();
	const resource = await client.readResource({ uri: BROWSER_VIEW_URI });
	const declared = z.object({ ui: z.object({ csp: z.record(z.string(), z.array(z.string())) }) }).parse(resource.contents[0]?._meta);
	// `resourceDomains` would reach script-src and style-src too; only `connectDomains` goes to connect-src alone.
	expect(declared.ui.csp).toEqual({ connectDomains: ["http://127.0.0.1:*"] });
});

test("stopping the server closes the listener: the View's door does not outlive the pack", async () => {
	const { client, server } = await connect();
	const granted = await client.callTool({ name: "browser_stream", arguments: { browserId: "s".repeat(32) } });
	const { origin, token } = z.object({ origin: z.string(), token: z.string() }).parse(granted.structuredContent);
	expect((await fetch(`${origin}/s/${token}`, { headers: { origin: "null" } }).then(async (response) => { await response.body?.cancel(); return response.status; }))).toBe(200);

	await server.close();

	await expect(fetch(`${origin}/s/${token}`, { headers: { origin: "null" } })).rejects.toThrow();
});
