/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a coding agent testing its own
 *  localhost app cannot see what broke (the page threw, a request 404'd, the
 *  console says why) and has to screenshot its way to a guess — or, worse, JS
 *  the model wrote runs in a browser that holds the person's logins.
 *
 *  `eval` is a step of browser_act, and ONLY a throwaway browser runs it (no
 *  profile, engine chromium): refused, before any step of the batch runs, on
 *  anything signed in. Each page keeps a short bounded log of what went wrong
 *  in it; a model reads it through browser_state and is told, in the act result
 *  that follows, that something new went wrong. Real Chrome.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, createRuntime, describeWithChrome, failureCode, newRuntime, startFixture, teardown } from "./fixture";

const VIEWPORT = { width: 800, height: 600 };
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

async function connect(runtime: BrowserRuntime, rootDir: string): Promise<Call> {
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir, presets: [] });
	const client = new Client({ name: "dev-tools-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	return async (name, args, caller) => Result.parse(await client.callTool({ name, arguments: args, ...(caller === undefined ? {} : { _meta: { [CALLER]: caller } }) }));
}

/** Run `expression` as the only step of a batch and answer that step. */
async function evaluate(runtime: BrowserRuntime, browserId: string, expression: string) {
	const result = await runtime.actMany(browserId, [{ kind: "eval", expression }]);
	const step = result.steps[0];
	if (!step) throw new Error("no step ran");
	return { result, step };
}

describeWithChrome("eval", () => {
	test(
		"runs in the page's main world and answers its value as JSON, awaiting a promise",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			await runtime.act(browserId, { kind: "navigate", url: fixture.url("/app") });

			// The app's own global: only the main world sees it.
			expect((await evaluate(runtime, browserId, "window.appState")).step).toMatchObject({ status: "completed", value: '{"count":3,"items":["a","b"]}' });
			expect((await evaluate(runtime, browserId, "document.title + ':' + document.getElementById('out').textContent")).step.value).toBe('"app:ready"');
			expect((await evaluate(runtime, browserId, "fetch('/page2').then((r) => r.status)")).step.value).toBe("200");
			// A statement list answers its last value; declarations may repeat; an element is described, not walked.
			expect((await evaluate(runtime, browserId, "const n = 2; n * 21")).step.value).toBe("42");
			expect((await evaluate(runtime, browserId, "const n = 3; n")).step.value).toBe("3");
			expect((await evaluate(runtime, browserId, "document.getElementById('out')")).step.value).toBe('"[p#out]"');
			expect((await evaluate(runtime, browserId, "const o = { name: 'loop' }; o.self = o; o")).step.value).toBe('{"name":"loop","self":"[circular]"}');
			// Nothing to say is no value, not the text "undefined".
			const nothing = (await evaluate(runtime, browserId, "void 0")).step;
			expect(nothing.status).toBe("completed");
			expect(nothing.value).toBeUndefined();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a script that throws is unknown (it may have run in part); one that cannot parse is failed and never ran",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			await runtime.act(browserId, { kind: "navigate", url: fixture.url("/app") });

			const thrown = await runtime.actMany(browserId, [
				{ kind: "eval", expression: "document.title = 'half done'; missingFunction()" },
				{ kind: "eval", expression: "1" },
			]);
			expect(thrown).toMatchObject({ status: "unknown", completed: 0 });
			expect(thrown.error).toContain("missingFunction is not defined");
			expect(thrown.steps).toHaveLength(1);
			expect((await evaluate(runtime, browserId, "document.title")).step.value).toBe('"half done"');

			const unparsed = await runtime.actMany(browserId, [{ kind: "eval", expression: "let = = 1" }]);
			expect(unparsed.status).toBe("failed");
			expect(unparsed.error).toContain("SyntaxError");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a value is cut at 8000 characters and a batch's evals share that: the cut one says truncated",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			await runtime.act(browserId, { kind: "navigate", url: fixture.url("/app") });

			const big = await evaluate(runtime, browserId, "'x'.repeat(20000)");
			expect(big.step.truncated).toBe(true);
			expect(big.step.value?.length).toBe(8_000);

			const shared = await runtime.actMany(browserId, [
				{ kind: "eval", expression: "'a'.repeat(5000)" },
				{ kind: "eval", expression: "'b'.repeat(5000)" },
			]);
			expect(shared.steps.map((step) => [step.value?.length, step.truncated])).toEqual([[5_002, undefined], [2_998, true]]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"only a throwaway browser runs it: a signed-in profile and the user's own Chrome refuse the whole batch before any step touches the page",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "signed-in", viewport: VIEWPORT }, { caller: "app" });
			await runtime.act(browserId, { kind: "navigate", url: fixture.url("/app") });

			const code = await failureCode(() => runtime.actMany(browserId, [{ kind: "navigate", url: fixture.url("/page2") }, { kind: "eval", expression: "document.cookie" }]));

			expect(code).toBe("eval_needs_throwaway");
			expect(fixture.hits("/page2")).toBe(0);
			expect((await runtime.state(browserId)).url).toBe(fixture.url("/app"));
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithChrome("the page log", () => {
	/** A throwaway browser whose /broken page has finished going wrong; nothing of it has been read yet. */
	async function broken() {
		const fixture = startFixture();
		const rootDir = await createRoot();
		const runtime = newRuntime(rootDir);
		const call = await connect(runtime, rootDir);
		const opened = await call("browser_open", { url: fixture.url("/broken") });
		const browserId = String(opened.structuredContent?.browserId);
		// As the View, which reads without using anything up: the model has seen none of it.
		await runtime.actMany(browserId, [{ kind: "wait", selector: "#settled" }], "app");
		return { fixture, runtime, call, browserId };
	}

	const said = (result: ToolResult) => JSON.parse(result.content[0]?.text ?? "{}");

	test(
		"keeps console errors and warnings, an uncaught exception, a 404 and a refused connection — with query strings stripped",
		async () => {
			const { fixture, runtime, browserId } = await broken();

			const entries = await runtime.logs(browserId);

			for (const [type, text] of [
				["console.error", "boom from the app"],
				["console.warning", "careful now"],
				["exception", "uncaught in the app"],
				["http", `404 GET ${fixture.url("/nope")}`],
				["network", "http://127.0.0.1:1/unreachable failed:"],
			] as const) {
				expect(entries).toContainEqual(expect.objectContaining({ type, text: expect.stringContaining(text) }));
			}
			// The token in every query string never reaches the log, in a url or in a message that quotes one.
			expect(JSON.stringify(entries)).not.toContain("SECRET-TOKEN");
			const order = entries.map((entry) => entry.n);
			expect(order).toEqual([...order].sort((a, b) => a - b));
			expect(new Set(order).size).toBe(order.length);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"is bounded: a message is cut at 300 characters and a tab keeps only its newest 50 entries",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			await runtime.act(browserId, { kind: "navigate", url: fixture.url("/app") });

			// The events of a script arrive before its answer does: when this returns they have all been logged.
			await evaluate(runtime, browserId, "for (let i = 0; i < 60; i += 1) console.error('error ' + i + ' ' + 'z'.repeat(1000))");
			const entries = await runtime.logs(browserId);

			expect(entries).toHaveLength(50);
			expect(entries[0]?.text.startsWith("error 10 z")).toBe(true);
			expect(entries.at(-1)?.text.startsWith("error 59 z")).toBe(true);
			expect(entries.every((entry) => entry.text.length <= 300)).toBe(true);
			// Read once, it is read: the next read holds only what came after.
			expect(await runtime.logs(browserId)).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a model is told of new errors once, in its next act, and browser_state then lists them once; the View consumes neither",
		async () => {
			const { call, browserId } = await broken();

			// The View acts and reads the state: neither is a model's result, so neither uses up what the model has not seen.
			const human = await call("browser_act", { browserId, actions: [{ kind: "hover", x: 1, y: 1 }] }, "app");
			expect(human.structuredContent).not.toHaveProperty("newErrors");
			expect((await call("browser_state", { browserId }, "app")).structuredContent).not.toHaveProperty("logs");

			const told = await call("browser_act", { browserId, actions: [{ kind: "hover", x: 2, y: 2 }] }, "model");
			const count = said(told).newErrors;
			expect(count).toBeGreaterThanOrEqual(5);
			// Told once: the same errors are not announced again.
			expect(said(await call("browser_act", { browserId, actions: [{ kind: "hover", x: 3, y: 3 }] }, "model")).newErrors).toBeUndefined();

			// A count is not the errors: browser_state lists them, oldest first, and a read uses them up.
			const state = await call("browser_state", { browserId }, "model");
			const logs = z.array(z.object({ n: z.number(), type: z.string(), text: z.string() })).parse(state.structuredContent?.logs);
			expect(logs).toHaveLength(count);
			expect(logs[0]?.text).toContain("boom");
			expect((await call("browser_state", { browserId }, "model")).structuredContent).not.toHaveProperty("logs");

			// Something new is announced again, in the batch that caused it.
			const fresh = await call("browser_act", { browserId, actions: [{ kind: "eval", expression: "console.error('fresh')" }] }, "model");
			expect(said(fresh).newErrors).toBe(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an error a model has read in browser_state is not announced to it again as new",
		async () => {
			const { call, browserId } = await broken();

			const state = await call("browser_state", { browserId }, "model");
			expect(state.structuredContent?.logs).toBeDefined();
			const acted = await call("browser_act", { browserId, actions: [{ kind: "hover", x: 1, y: 1 }] }, "model");

			expect(said(acted).newErrors).toBeUndefined();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a batch's eval values ride in the text a model reads, as the values they are",
		async () => {
			const fixture = startFixture();
			const rootDir = await createRoot();
			const runtime = newRuntime(rootDir);
			const call = await connect(runtime, rootDir);
			const opened = await call("browser_open", { url: fixture.url("/app") });
			const browserId = String(opened.structuredContent?.browserId);

			const acted = await call("browser_act", { browserId, actions: [{ kind: "eval", expression: "window.appState" }, { kind: "eval", expression: "'x'.repeat(9000)" }] }, "model");

			const text = said(acted);
			expect(text.values[0]).toEqual({ step: 0, value: { count: 3, items: ["a", "b"] } });
			expect(text.values[1]).toMatchObject({ step: 1, truncated: true });
			expect(acted.structuredContent).toBeUndefined();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
