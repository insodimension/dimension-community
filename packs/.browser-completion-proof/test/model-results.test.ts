/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an agent driving a page pays
 *  for every result twice (the host appends a copy of `structuredContent`
 *  whenever it differs from the text) and carries every tab's favicon — up to
 *  32 KB of base64 — through every call, so a 15-step job costs several times
 *  what the page needed. Or the opposite: the Browser View stops getting the
 *  structured `state` it draws from and freezes on the first frame.
 *
 *  A model gets one compact text from act, snapshot and inspect; only the View
 *  (`caller: "app"`) is sent structured content. No model-facing state carries
 *  a tab's favicon; the View's does. Real Chrome, over an in-memory MCP transport.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, startFixture, teardown, waitUntil } from "./fixture";

const CALLER = "ai.insodimension/caller";
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
type Call = (name: string, args: Record<string, unknown>, caller?: "model" | "app") => Promise<ToolResult>;

/** The real MCP server over a real Chrome, reached the way a host reaches it (`caller` is the host's stamp). */
async function connect(): Promise<{ call: Call; runtime: BrowserRuntime }> {
	const rootDir = await createRoot();
	const runtime = newRuntime(rootDir);
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir, presets: [] });
	const client = new Client({ name: "model-results-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	const call: Call = async (name, args, caller) =>
		Result.parse(await client.callTool({ name, arguments: args, ...(caller === undefined ? {} : { _meta: { [CALLER]: caller } }) }));
	return { call, runtime };
}

const textOf = (result: ToolResult): string => result.content.map((block) => block.text ?? "").join("");

describeWithChrome("what a model is sent", () => {
	test(
		"act, snapshot and inspect answer a model in one compact text; only the View is sent structured content",
		async () => {
			const fixture = startFixture();
			const { call } = await connect();
			const opened = await call("browser_open", { url: fixture.url("/signup") });
			const browserId = String(opened.structuredContent?.browserId);

			// Unstamped (a harness with no host) is not the View: it is treated as a model.
			for (const caller of [undefined, "model"] as const) {
				const acted = await call("browser_act", { browserId, actions: [{ kind: "type", selector: "#user", text: "ada" }] }, caller);
				expect(acted.isError).toBeFalsy();
				expect(acted.structuredContent).toBeUndefined();
				// Where the page is, and nothing of the state around it.
				expect(JSON.parse(textOf(acted))).toEqual({ status: "completed", completed: 1, url: fixture.url("/signup"), title: "signup" });

				const snapshot = await call("browser_snapshot", { browserId }, caller);
				expect(snapshot.structuredContent).toBeUndefined();
				// The page's own `# title` and url lines head the text, so no state header is repeated.
				expect(textOf(snapshot).startsWith(`# signup\n${fixture.url("/signup")}\n`)).toBe(true);
				expect(textOf(snapshot)).toContain("#user");

				const inspected = await call("browser_inspect", { browserId, selector: "#user" }, caller);
				expect(inspected.structuredContent).toBeUndefined();
				expect(JSON.parse(textOf(inspected))).toMatchObject({ found: true });
			}

			// The View reads `state` out of an act's structured content, and the page text out of a snapshot's.
			const humanActed = await call("browser_act", { browserId, actions: [{ kind: "hover", x: 5, y: 5 }] }, "app");
			expect(humanActed.structuredContent).toMatchObject({ status: "completed", state: { browserId, url: fixture.url("/signup") } });
			const humanSnapshot = await call("browser_snapshot", { browserId }, "app");
			expect(humanSnapshot.structuredContent).toMatchObject({ state: { browserId }, text: textOf(humanSnapshot) });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"no state a model is sent carries a tab's favicon; the View's does",
		async () => {
			const fixture = startFixture();
			const { call, runtime } = await connect();
			const opened = await call("browser_open", { url: fixture.url("/with-icon") });
			const browserId = String(opened.structuredContent?.browserId);
			// The icon is fetched in the background once the page has loaded.
			await waitUntil("the tab's favicon", () => runtime.state(browserId), (state) => state.tabs[0]?.favicon?.startsWith("data:image/png") === true);

			const asked = async (caller?: "model" | "app"): Promise<string[]> => {
				const state = await call("browser_state", { browserId }, caller);
				const acted = await call("browser_act", { browserId, actions: [{ kind: "reload" }] }, caller);
				const shown = await call("browser_view", { browserId }, caller);
				const tab = await call("browser_act", { browserId, actions: [{ kind: "tab", op: "new" }] }, caller);
				return [JSON.stringify(state), JSON.stringify(acted), JSON.stringify(shown), JSON.stringify(tab)];
			};
			for (const caller of [undefined, "model"] as const) {
				for (const seen of await asked(caller)) expect(seen).not.toContain("data:image");
			}
			const [state, acted] = await asked("app");
			expect(state).toContain("data:image/png");
			expect(acted).toContain("data:image/png");
			// A model still learns everything else about its tabs.
			const modelState = await call("browser_state", { browserId });
			const tabs = z.array(z.record(z.string(), z.unknown())).parse(modelState.structuredContent?.tabs);
			expect(tabs[0]).toMatchObject({ url: fixture.url("/with-icon"), active: false, loading: false });
			expect(tabs.some((tab) => "favicon" in tab)).toBe(false);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a step that failed is a tool error naming where it stopped; a wait that ran out is a result, not an error",
		async () => {
			const fixture = startFixture();
			const { call } = await connect();
			const opened = await call("browser_open", { url: fixture.url("/signup") });
			const browserId = String(opened.structuredContent?.browserId);

			const missed = await call("browser_act", { browserId, actions: [{ kind: "type", selector: "#user", text: "kept" }, { kind: "click", selector: "#no-such-button" }, { kind: "reload" }] });
			expect(missed.isError).toBe(true);
			const said = JSON.parse(textOf(missed));
			expect(said).toMatchObject({ status: "failed", completed: 1, steps: [{ kind: "type", status: "completed" }, { kind: "click", status: "failed" }] });
			expect(said.error).toContain("#no-such-button");

			const gone = await call("browser_act", { browserId, actions: [{ kind: "wait", text: "never on this page", timeoutMs: 100 }] });
			expect(gone.isError).toBeFalsy();
			expect(JSON.parse(textOf(gone))).toMatchObject({ status: "timeout", completed: 0 });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
