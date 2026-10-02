/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the agent's browser_act stops
 *  being ONE call for a whole job. Either a batch interleaves with another
 *  caller's action (a click lands between two typed fields), keeps going after
 *  a step did not complete (a submit clicked over a form that never filled),
 *  half-runs a batch that was never valid, or runs on past the time a host
 *  allows a call — after which the caller believes it failed and sends the same
 *  submit again.
 *
 *  `runtime.actMany` runs a batch under ONE per-browser lock, checks every step
 *  before any reaches the page, stops at the first step that is not
 *  `completed`, and answers once with the final state. Real Chrome, real pages;
 *  the tool-level shape (`actions` only, 1..25) is checked over an in-memory
 *  MCP transport.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BatchStep, BrowserRuntimePort } from "../src/contracts";
import { createBrowserServer } from "../src/server";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, createRuntime, describeWithChrome, failureCode, newRuntime, perform, startFixture, submissionLanded, teardown } from "./fixture";

const VIEWPORT = { width: 800, height: 600 };

const clients: Client[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.close().catch(() => undefined);
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

/** The value of the fixture form's #user field, read from the live page. */
async function userField(runtime: BrowserRuntimePort, browserId: string): Promise<string> {
	const listing = (await runtime.snapshot(browserId)).text;
	const found = /#user \(text\) "([^"]*)"/.exec(listing);
	if (!found) throw new Error(`no #user field in the snapshot:\n${listing}`);
	return found[1] ?? "";
}

describeWithChrome("actMany", () => {
	test(
		"a batch runs its steps in order and answers once with the final state; one submit click is exactly one write",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/signup") });

			const result = await runtime.actMany(browserId, [
				{ kind: "type", selector: "#user", text: "new name" },
				{ kind: "select", selector: "#plan", value: "Pro plan" },
				{ kind: "click", selector: "#go" },
			]);
			await submissionLanded(runtime, browserId, fixture);

			expect(result).toMatchObject({ status: "completed", completed: 3 });
			expect(result.steps.map((step) => [step.kind, step.status])).toEqual([["type", "completed"], ["select", "completed"], ["click", "completed"]]);
			expect(result.state.url).toBe(fixture.url("/submit"));
			expect(fixture.submissions()).toEqual([{ user: "new name", plan: "pro" }]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a batch holds the browser's one lock: another caller's action waits for the whole batch instead of landing between two steps",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/signup") });

			// Queued in this order, synchronously: the batch first, then a single action from someone else.
			const batch = runtime.actMany(browserId, [
				{ kind: "type", selector: "#user", text: "A1" },
				{ kind: "type", selector: "#user", text: "A2" },
				{ kind: "type", selector: "#user", text: "A3" },
			]);
			const other = runtime.act(browserId, { kind: "type", selector: "#user", text: "B" });
			await Promise.all([batch, other]);

			// Were the steps taken one lock at a time, B would run after A1 and A3 would win.
			expect(await userField(runtime, browserId)).toBe("B");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the first step that is not completed stops the batch: earlier steps stay done and later ones never reach the page",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/signup") });

			const missed = await runtime.actMany(browserId, [
				{ kind: "type", selector: "#user", text: "kept" },
				{ kind: "click", selector: "#no-such-button" },
				{ kind: "type", selector: "#user", text: "never typed" },
				{ kind: "click", selector: "#go" },
			]);

			expect(missed).toMatchObject({ status: "failed", completed: 1 });
			expect(missed.steps.map((step) => [step.kind, step.status])).toEqual([["type", "completed"], ["click", "failed"]]);
			expect(missed.steps[1]?.error).toContain("#no-such-button");
			expect(missed.error).toBe(missed.steps[1]?.error);
			expect(await userField(runtime, browserId)).toBe("kept");
			expect(fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a step that errors after it reached the page stops the batch as unknown, so the submit after it is never clicked",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			// A saved profile: its reads run in the page's own world, where the page's guard can throw into them (a throwaway's cannot, see below).
			const { browserId } = await runtime.open({ profile: "guarded", viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/guarded") });
			await perform(runtime, browserId, { kind: "type", selector: "#pass", text: "first" });

			// The page's guard throws AFTER the browser focused the filled field.
			const result = await runtime.actMany(browserId, [
				{ kind: "type", selector: "#pass", text: "second" },
				{ kind: "click", selector: "#go" },
			]);

			expect(result).toMatchObject({ status: "unknown", completed: 0 });
			expect(result.steps.map((step) => step.status)).toEqual(["unknown"]);
			expect(fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"on a throwaway browser the driver's reads run in an isolated world: a page's own override of a DOM method never fires and cannot stop a step",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/guarded") });
			await perform(runtime, browserId, { kind: "type", selector: "#pass", text: "first" });

			const result = await runtime.actMany(browserId, [
				{ kind: "type", selector: "#pass", text: "second" },
				{ kind: "click", selector: "#go" },
			]);

			expect(result).toMatchObject({ status: "completed", completed: 2 });
			expect(fixture.hits("/submit")).toBe(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"every step is checked before any runs: one malformed step refuses the batch and the page is untouched",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/signup") });

			const refused = await failureCode(() =>
				runtime.actMany(browserId, [
					{ kind: "type", selector: "#user", text: "would change the page" },
					{ kind: "navigate", url: "javascript:fetch('/js-ran')" },
				]),
			);

			expect(refused).toBe("bad_action");
			expect(await userField(runtime, browserId)).toBe("old name");
			expect(fixture.hits("/js-ran")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a wait step holds until the page shows it, and one that times out stops the batch as timeout",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });

			const arrived = await runtime.actMany(browserId, [
				{ kind: "navigate", url: fixture.url("/late") },
				{ kind: "wait", text: "late arrival text" },
				{ kind: "wait", url: "done=1" },
			]);
			expect(arrived).toMatchObject({ status: "completed", completed: 3 });
			expect(arrived.state.url).toBe(fixture.url("/late?done=1"));

			const gone = await runtime.actMany(browserId, [
				{ kind: "wait", text: "this text never appears", timeoutMs: 200 },
				{ kind: "navigate", url: fixture.url("/page2") },
			]);
			expect(gone).toMatchObject({ status: "timeout", completed: 0 });
			expect(gone.steps.map((step) => [step.kind, step.status])).toEqual([["wait", "timeout"]]);
			expect(fixture.hits("/page2")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"resize is a step: the page's viewport becomes what was asked, for responsive checks",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/signup") });

			const result = await runtime.actMany(browserId, [{ kind: "resize", width: 480, height: 640 }]);

			expect(result.status).toBe("completed");
			expect(result.state.viewport).toEqual({ width: 480, height: 640 });
			expect((await runtime.state(browserId)).viewport).toEqual({ width: 480, height: 640 });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a batch stops before a step once its time budget is spent, so it answers inside the time a host allows a call",
		async () => {
			const fixture = startFixture();
			const rootDir = await createRoot();
			// 1 ms: the first step always runs, and every step takes longer than that.
			const runtime = newRuntime(rootDir, { actBudgetMs: 1 });
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/signup") });

			const result = await runtime.actMany(browserId, [
				{ kind: "type", selector: "#user", text: "first" },
				{ kind: "type", selector: "#user", text: "second" },
				{ kind: "click", selector: "#go" },
			]);

			expect(result).toMatchObject({ status: "timeout", completed: 1 });
			expect(result.error).toContain("1 of 3");
			expect(await userField(runtime, browserId)).toBe("first");
			expect(fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// The tool's input: `actions` only, 1..25. No Chrome needed.
// ---------------------------------------------------------------------------

async function connectStub(seen: BatchStep[][]): Promise<Client> {
	const rootDir = await createRoot();
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const runtime: Pick<BrowserRuntimePort, "actMany" | "connections" | "profileMeta" | "onConnectionsChanged" | "dispose"> = {
		actMany: async (_browserId, steps) => {
			seen.push([...steps]);
			return { status: "completed", completed: steps.length, steps: steps.map((step) => ({ kind: step.kind, status: "completed" as const })), state: { url: "http://x.test/", title: "x", tabs: [] } as never };
		},
		connections: async () => ({}),
		profileMeta: async () => ({}),
		onConnectionsChanged: () => () => {},
		dispose: async () => {},
	};
	const server = await createBrowserServer({ runtime: runtime as BrowserRuntimePort, viewDir, presets: [] });
	const client = new Client({ name: "act-batch-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	clients.push(client);
	return client;
}

test("browser_act takes actions (1 to 25 steps) and nothing else: the single-action shape is gone", async () => {
	const seen: BatchStep[][] = [];
	const client = await connectStub(seen);
	const browserId = "b".repeat(32);
	const step = { kind: "reload" as const };

	const one = await client.callTool({ name: "browser_act", arguments: { browserId, actions: [step] } });
	const most = await client.callTool({ name: "browser_act", arguments: { browserId, actions: Array.from({ length: 25 }, () => step) } });
	expect([one.isError, most.isError]).toEqual([undefined, undefined]);
	expect(seen.map((steps) => steps.length)).toEqual([1, 25]);

	for (const args of [{ browserId, actions: [] }, { browserId, actions: Array.from({ length: 26 }, () => step) }, { browserId, action: step }]) {
		expect((await client.callTool({ name: "browser_act", arguments: args })).isError).toBe(true);
	}
	expect(seen).toHaveLength(2);
});
