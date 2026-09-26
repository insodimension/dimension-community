/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: browser_task stops being a task
 *  the human can watch and stop. Either progress never reaches the View (steps
 *  not streamed or not in state), the finished run misreports what the agent
 *  spent, a crashed worker hangs the call or is reported as success, a cancel
 *  does not stop the agent — or the agent tool and the task agent drive the
 *  same browser at once. Also: when the agent opens its own tab, the View keeps
 *  showing the empty home tab instead of the agent's work.
 *
 *  The worker here is a scripted FAKE (test/fake-worker) speaking the real
 *  JSON-lines protocol through the real interpreter, launched by the real
 *  `startWorker` — only the agent loop is replaced, never the process boundary.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { BrowserRuntime } from "../src/runtime";
import { createBrowserServer } from "../src/server";
import type { TaskStep } from "../src/contracts";
import {
	BROWSER_TEST_TIMEOUT_MS,
	chromePath,
	createRuntime,
	failureCode,
	perform,
	startFixture,
	teardown,
	waitUntil,
	within,
} from "./fixture";

const VIEWPORT = { width: 640, height: 480 };
const PYTHON_DIR = fileURLToPath(new URL("../python/", import.meta.url));
const PYTHON = join(PYTHON_DIR, ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
const FAKE_WORKER = fileURLToPath(new URL("./fake-worker/", import.meta.url));

if (!existsSync(PYTHON)) {
	console.warn(`[browser tests] ${PYTHON} is missing; the task tests are SKIPPED. Run: cd python && uv sync --python 3.12`);
}
const describeTasks = chromePath === undefined || !existsSync(PYTHON) ? describe.skip : describe;

// The fake worker's script (see fake-worker/dim_browser_bridge/__main__.py) travels as the task text.

interface ToolResult {
	isError?: boolean;
	content: Array<{ type: string; text?: string }>;
	structuredContent?: Record<string, unknown>;
}

/** The real MCP server over `runtime`, reached the way a host reaches it. */
async function connect(runtime: BrowserRuntime, rootDir: string): Promise<(name: string, args: Record<string, unknown>) => Promise<ToolResult>> {
	const viewDir = join(rootDir, "view");
	await mkdir(viewDir, { recursive: true });
	await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
	const server = await createBrowserServer({ runtime, viewDir });
	const client = new Client({ name: "task-test", version: "0.0.0" });
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	return async (name, args) => (await client.callTool({ name, arguments: args })) as ToolResult;
}

/** A promise that resolves once `onStep` has seen `count` steps. */
function stepsSeen(count: number): { seen: TaskStep[]; reached: Promise<void>; onStep: (step: TaskStep) => void } {
	const seen: TaskStep[] = [];
	let reach!: () => void;
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	return {
		seen,
		reached,
		onStep: (step) => {
			seen.push(step);
			if (seen.length === count) reach();
		},
	};
}

const ENV_KEYS = ["DIM_BROWSER_PYTHON", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeAll(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	process.env.DIM_BROWSER_PYTHON = PYTHON;
	// See fake-worker/sitecustomize.py for why this beats the real package in cwd.
	process.env.PYTHONPATH = FAKE_WORKER;
	process.env.PYTHONDONTWRITEBYTECODE = "1";
});

afterAll(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

describeTasks("tasks", () => {
	test(
		"steps stream to onStep and into state while the task runs, then the final result is recorded",
		async () => {
			const { runtime, rootDir } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "task-steps", viewport: VIEWPORT });
			const gate = join(rootDir, "finish-task");
			const steps = [
				{ action: "open careers page", url: "https://a.example/", modelCalls: 1, inputTokens: 100, outputTokens: 10 },
				{ action: "fill name", url: "https://a.example/apply", modelCalls: 2, inputTokens: 250, outputTokens: 20 },
				{ action: "click Apply", url: "https://a.example/done", modelCalls: 3, inputTokens: 400, outputTokens: 30 },
			];
			const progress = stepsSeen(steps.length);

			const finished = runtime.runTask(
				browserId,
				{
					agent: "jev",
					task: JSON.stringify({
						steps,
						gate,
						result: { status: "done", summary: "applied", steps: 3, modelCalls: 4, inputTokens: 520, outputTokens: 41 },
					}),
				},
				progress.onStep,
			);
			await progress.reached;

			const expected = steps.map((step, i) => ({ n: i + 1, action: step.action, url: step.url }));
			expect(progress.seen.map(({ n, action, url }) => ({ n, action, url }))).toEqual(expected);
			const running = (await runtime.state(browserId)).task;
			expect(running?.status).toBe("running");
			expect(running?.steps.map(({ n, action, url }) => ({ n, action, url }))).toEqual(expected);
			expect(running?.stepCount).toBe(3);
			// Usage on the wire is CUMULATIVE: the latest step's totals, not a sum.
			expect(running?.usage).toEqual({ modelCalls: 3, inputTokens: 400, outputTokens: 30, costUsd: null });

			await writeFile(gate, "");
			const run = await finished;

			expect(run).toMatchObject({ status: "done", summary: "applied", stepCount: 3 });
			expect(run.usage).toEqual({ modelCalls: 4, inputTokens: 520, outputTokens: 41, costUsd: null });
			expect((await runtime.state(browserId)).task).toMatchObject({ status: "done", summary: "applied" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"while a task runs, act and a second task are refused; cancel stops it and frees the browser",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "task-cancel", viewport: VIEWPORT });
			const progress = stepsSeen(1);

			const running = runtime.runTask(
				browserId,
				{ agent: "browser-use", task: JSON.stringify({ steps: [{ action: "thinking", url: "" }], hold: true }) },
				progress.onStep,
			);
			await progress.reached;

			for (const refused of [
				() => runtime.act(browserId, { kind: "navigate", url: fixture.url("/page2") }),
				() => runtime.tab(browserId, { op: "new", url: fixture.url("/page2") }),
			]) {
				expect(await failureCode(refused)).toBe("task_running");
			}
			// A crash script: were the second task wrongly admitted, it would resolve at once and fail this.
			const second = JSON.stringify({ crash: { stderr: "second task ran", exit: 1 } });
			expect(await failureCode(() => runtime.runTask(browserId, { agent: "jev", task: second }))).toBe("task_running");
			expect(fixture.hits("/page2")).toBe(0);

			const cancelled = await runtime.cancelTask(browserId);
			expect(cancelled.status).toBe("cancelled");
			expect((await running).status).toBe("cancelled");

			// The task is over: the browser takes actions again.
			const after = await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/page2") });
			expect(after.url).toBe(fixture.url("/page2"));
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a worker that exits without a result fails the task with its stderr, and a new task can start",
		async () => {
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "task-crash", viewport: VIEWPORT });
			const crash = JSON.stringify({ crash: { stderr: "fake worker exploded: TYPESAFE_API_KEY is not set", exit: 3 } });

			const run = await runtime.runTask(browserId, { agent: "jev", task: crash });

			expect(run.status).toBe("failed");
			expect(run.summary).toContain("(3)");
			expect(run.summary).toContain("fake worker exploded: TYPESAFE_API_KEY is not set");
			expect((await runtime.state(browserId)).task?.status).toBe("failed");
			// The dead worker no longer holds the browser.
			expect((await runtime.runTask(browserId, { agent: "jev", task: crash })).status).toBe("failed");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a provider 402 or a worker exiting non-zero fails only the task: the tool call errors within seconds naming the cause and the next step, even when the worker's child holds its pipes, and the same server keeps serving",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const call = await connect(runtime, rootDir);
			const { browserId } = await runtime.open({ profile: "task-402", viewport: VIEWPORT });
			const failures = [
				{
					script: { holdPipes: 30, result: { status: "failed", summary: "Model provider returned HTTP 402; no action executed.", steps: 0 } },
					cause: "task failed: Model provider returned HTTP 402",
					next: "Next: the model provider's key has no credit (HTTP 402)",
				},
				{
					script: { holdPipes: 30, crash: { stderr: "openai.APIStatusError: Error code: 402 - insufficient credit", exit: 1 } },
					cause: "task failed: task worker exited (1): openai.APIStatusError: Error code: 402",
					next: "Next: the model provider's key has no credit (HTTP 402)",
				},
			];

			for (const [i, { script, cause, next }] of failures.entries()) {
				const failed = await within(10_000, `failed task ${i}'s tool result`, call("browser_task", { browserId, agent: "jev", task: JSON.stringify(script), waitSeconds: 20 }));
				expect(failed.isError).toBe(true);
				expect(failed.content[0]?.text).toContain(cause);
				expect(failed.content[0]?.text).toContain(next);
				const state = await within(5_000, `browser_state after failed task ${i}`, call("browser_state", { browserId }));
				expect({ isError: state.isError, browserId: state.structuredContent?.browserId }).toEqual({ isError: undefined, browserId });
			}
			const acted = await within(10_000, "browser_act after the failed tasks", call("browser_act", { browserId, action: { kind: "navigate", url: fixture.url("/page2") } }));
			expect(acted.isError).toBeUndefined();
			expect(fixture.hits("/page2")).toBe(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the browser follows a tab the task agent opens over CDP",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "task-tab", viewport: VIEWPORT });
			const progress = stepsSeen(1);

			const running = runtime.runTask(
				browserId,
				{
					agent: "jev",
					task: JSON.stringify({ openTab: fixture.url("/signup"), steps: [{ action: "opened tab", url: fixture.url("/signup") }], hold: true }),
				},
				progress.onStep,
			);
			await progress.reached;

			const shown = await waitUntil(
				"state to show the agent's tab",
				() => runtime.state(browserId),
				(state) => state.url === fixture.url("/signup"),
			);
			expect(shown.title).toBe("signup");

			await runtime.cancelTask(browserId);
			expect((await running).status).toBe("cancelled");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a BACKGROUND tab the task agent opened still takes input and yields frames after the task ends",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "task-bg-tab", viewport: VIEWPORT });
			const gate = join(rootDir, "finish-task");
			const progress = stepsSeen(1);

			const finished = runtime.runTask(
				browserId,
				{
					agent: "jev",
					task: JSON.stringify({
						openTab: fixture.url("/signup"),
						background: true,
						steps: [{ action: "opened tab", url: fixture.url("/signup") }],
						gate,
						result: { status: "done", summary: "opened", steps: 1 },
					}),
				},
				progress.onStep,
			);
			await progress.reached;
			// The driver has switched to the agent's tab before the task (and its follow) ends.
			await waitUntil(
				"state to show the agent's tab",
				() => runtime.state(browserId),
				(state) => state.url === fixture.url("/signup"),
			);
			await writeFile(gate, "");
			expect((await finished).status).toBe("done");

			// A hidden tab renders no frames: input waits forever for one and screenshots crawl.
			const scrolled = await within(8_000, "scroll on the followed tab", runtime.act(browserId, { kind: "scroll", deltaY: 200 }));
			expect(scrolled.status).toBe("completed");
			const frame = await within(8_000, "frame of the followed tab", runtime.frame(browserId));
			expect(frame.state.url).toBe(fixture.url("/signup"));
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a generated password a GET login form carries in the URL comes back, raw or encoded, in no act, state, snapshot, tab or task result",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const call = await connect(runtime, rootDir);
			const { browserId } = await runtime.open({ profile: "task-redact", viewport: VIEWPORT });
			const store = join(rootDir, "profiles", "task-redact", "credentials.json");
			const origin = new URL(fixture.url("/")).origin;
			const results: unknown[] = [];
			const act = async (action: Record<string, unknown>): Promise<ToolResult> => {
				const out = await call("browser_act", { browserId, action });
				results.push(out);
				expect(out.isError).toBeUndefined();
				return out;
			};

			// Mint until the password has a character a URL encodes (every one has a symbol; `-` and `_` stay as they are).
			let password = "";
			while (encodeURIComponent(password) === password || new URLSearchParams([["", password]]).toString().slice(1) === password) {
				await rm(store, { force: true });
				await act({ kind: "navigate", url: fixture.url("/get-login") });
				await act({ kind: "type", selector: "#pass", generatePassword: true });
				password = JSON.parse(await readFile(store, "utf8")).origins[origin];
			}
			await act({ kind: "click", selector: "#go" });
			await waitUntil("the GET login", () => fixture.submissions().length, (count) => count === 1);
			// The page's own URL really does carry it.
			expect(fixture.submissions()).toEqual([{ user: "", pass: password }]);
			const landed = `${fixture.url("/logged-in")}?${new URLSearchParams({ user: "", pass: password })}`;

			const state = await call("browser_state", { browserId });
			const tabId = state.structuredContent?.activeTabId as string;
			results.push(state, await call("browser_snapshot", { browserId }), await call("browser_tab", { browserId, op: "activate", tabId }));
			// A task whose steps and failure summary quote the URL, as jev's would after the filled form submits.
			const summary = `stopped at ${landed} (${encodeURIComponent(password)})`;
			const task = JSON.stringify({ steps: [{ action: `submitted ${landed}`, url: landed }], result: { status: "failed", summary, steps: 1 } });
			const failed = await call("browser_task", { browserId, agent: "jev", task, waitSeconds: 20 });
			expect(failed.isError).toBe(true);
			results.push(failed, await call("browser_task_wait", { browserId, waitSeconds: 1 }), await call("browser_task_cancel", { browserId }));

			const all = JSON.stringify(results);
			// Non-vacuous: the URL and the task were read back, redacted.
			expect(all).toContain(`${fixture.url("/logged-in")}?user=&pass=[saved password]`);
			expect(all).toContain("submitted ");
			for (const form of [password, encodeURIComponent(password), new URLSearchParams([["", password]]).toString().slice(1)]) {
				expect(all).not.toContain(form);
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
