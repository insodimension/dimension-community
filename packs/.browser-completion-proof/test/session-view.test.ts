/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the agent cannot find the
 *  browser the person opened for it (the View start page, the dock's "Open a
 *  page") — or, worse, it finds one that is not its own: a second conversation
 *  driving the first one's signed-in browser.
 *
 *  A browser id is a capability the model normally learns from the call that
 *  made it. A browser the HUMAN opened has no such call, and the View no longer
 *  pushes the id into every prompt. So a model may ask browser_state with no
 *  browserId and gets the browser the human opened or is viewing in ITS OWN
 *  session — keyed by the session the host stamped on the call, never by an
 *  argument; nothing for another session or an unstamped call; gone when that
 *  browser closes. Real Chrome, over an in-memory MCP transport.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createBrowserServer } from "../src/server";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, teardown } from "./fixture";

const CALLER = "ai.insodimension/caller";
const SESSION = "ai.insodimension/session";
const NONE = "no browser is open in this session; call browser_view";
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
/** `who`: the host's stamps on the call. No `session` is a call that did not come through a host lane. */
interface Who {
	caller: "model" | "app";
	session?: string;
}
type Call = (name: string, args: Record<string, unknown>, who?: Who) => Promise<ToolResult>;

async function connect(): Promise<Call> {
	const rootDir = await createRoot();
	const runtime = newRuntime(rootDir);
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir, presets: [] });
	const client = new Client({ name: "session-view-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	return async (name, args, who) =>
		Result.parse(
			await client.callTool({
				name,
				arguments: args,
				...(who === undefined ? {} : { _meta: { [CALLER]: who.caller, ...(who.session === undefined ? {} : { [SESSION]: { sessionId: who.session } }) } }),
			}),
		);
}

const idOf = (result: ToolResult): string => String(result.structuredContent?.browserId);
const errorOf = (result: ToolResult): string | undefined => (result.isError ? result.content[0]?.text : undefined);

describeWithChrome("the browser a person opened in a session", () => {
	test(
		"a model with no browserId gets the browser the human opened in its own session, and nothing for another session or an unstamped call",
		async () => {
			const call = await connect();
			const human = { caller: "app", session: "s-1" } as const;
			const opened = await call("browser_open", {}, human);
			const browserId = idOf(opened);

			const own = await call("browser_state", {}, { caller: "model", session: "s-1" });
			expect(own.isError).toBeFalsy();
			expect(own.structuredContent).toMatchObject({ browserId, profile: null });

			expect(errorOf(await call("browser_state", {}, { caller: "model", session: "s-2" }))).toBe(NONE);
			expect(errorOf(await call("browser_state", {}))).toBe(NONE);
			expect(errorOf(await call("browser_state", {}, { caller: "model" }))).toBe(NONE);
			// The id is for browser_state alone: every other tool still needs the one it acts on.
			expect((await call("browser_snapshot", {}, { caller: "model", session: "s-1" })).isError).toBe(true);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"only what the human opened or is viewing counts: a browser the model opened for itself is not found this way",
		async () => {
			const call = await connect();
			const model = { caller: "model", session: "s-3" } as const;

			await call("browser_open", {}, model);
			expect(errorOf(await call("browser_state", {}, model))).toBe(NONE);

			// Mounting the View on a browser is showing it to the human.
			const shown = await call("browser_view", {}, model);
			expect((await call("browser_state", {}, model)).structuredContent).toMatchObject({ browserId: idOf(shown) });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a browser the View reads from is the human's: an app call binds it, a model call does not",
		async () => {
			const call = await connect();
			const opened = await call("browser_open", {});
			const browserId = idOf(opened);

			await call("browser_state", { browserId }, { caller: "model", session: "s-4" });
			expect(errorOf(await call("browser_state", {}, { caller: "model", session: "s-4" }))).toBe(NONE);

			await call("browser_state", { browserId }, { caller: "app", session: "s-4" });
			expect((await call("browser_state", {}, { caller: "model", session: "s-4" })).structuredContent).toMatchObject({ browserId });
			// Another session's View did not read it.
			expect(errorOf(await call("browser_state", {}, { caller: "model", session: "s-5" }))).toBe(NONE);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"closing the browser clears it, and a later one the human opens is the one found",
		async () => {
			const call = await connect();
			const human = { caller: "app", session: "s-6" } as const;
			const first = idOf(await call("browser_open", {}, human));
			expect((await call("browser_state", {}, { caller: "model", session: "s-6" })).isError).toBeFalsy();

			await call("browser_close", { browserId: first }, human);
			expect(errorOf(await call("browser_state", {}, { caller: "model", session: "s-6" }))).toBe(NONE);

			const second = idOf(await call("browser_open", {}, human));
			expect((await call("browser_state", {}, { caller: "model", session: "s-6" })).structuredContent).toMatchObject({ browserId: second });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
