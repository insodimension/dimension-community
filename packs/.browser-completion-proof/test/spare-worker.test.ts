/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: every jev task after the first pays a cold Python interpreter start again
 *  (the spare worker the last task left waiting is no longer taken), or the server keeps interpreters it should have let
 *  go: a spare kept for a session with no jev key, one reused by a task whose environment (a rotated key) is not the one
 *  it was started in, or one that outlives the runtime that was disposed (including one a task kept while the dispose was
 *  already running).
 *
 *  The REAL `startWorker` launches the real interpreter on a scripted FAKE worker (test/fake-worker). Each fake worker
 *  records its pid, as an empty file, in FAKE_WORKER_PIDS the moment it starts, and answers a job with its own pid: a job
 *  that was served by a worker which already existed is one whose answer is a pid already on disk.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { releaseSpare, startWorker } from "../src/task";
import { BROWSER_TEST_TIMEOUT_MS, chromePath, createRoot, newRuntime, teardown, waitUntil } from "./fixture";
import { withJevKey } from "./jev-key";

withJevKey();

const PYTHON_DIR = fileURLToPath(new URL("../python/", import.meta.url));
const PYTHON = process.env.DIM_BROWSER_PYTHON?.trim() || join(PYTHON_DIR, ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
const FAKE_WORKER = fileURLToPath(new URL("./fake-worker/", import.meta.url));

if (!existsSync(PYTHON)) {
	console.warn(`[browser tests] ${PYTHON} is missing; the spare worker tests are SKIPPED. Run: cd python && uv sync --python 3.12`);
}
const describeWithPython = existsSync(PYTHON) ? describe : describe.skip;
const describeWithPythonAndChrome = existsSync(PYTHON) && chromePath !== undefined ? describe : describe.skip;

const ENV_KEYS = ["DIM_BROWSER_PYTHON", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE", "FAKE_WORKER_PIDS", "TYPESAFE_API_KEY"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

beforeAll(() => {
	// withJevKey's own beforeAll has already set the key; it is saved here too so a test may change it and put it back.
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	process.env.DIM_BROWSER_PYTHON = PYTHON;
	// See fake-worker/sitecustomize.py for why this beats the real package in cwd.
	process.env.PYTHONPATH = FAKE_WORKER;
	process.env.PYTHONDONTWRITEBYTECODE = "1";
});

afterAll(() => {
	for (const key of ENV_KEYS) {
		if (key === "TYPESAFE_API_KEY") continue; // withJevKey puts the real one back
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

// Deliberately no `releaseSpare()` here: it would hide a spare the code under test left behind. The describe whose tests leave spares
// on purpose releases them itself; the one that asserts dispose let go of a spare releases only after its assertions.
afterEach(async () => {
	process.env.TYPESAFE_API_KEY = savedEnv.TYPESAFE_API_KEY;
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

/** A directory for this test's workers to record their pids in. */
async function pidDirectory(): Promise<string> {
	const dir = join(await createRoot(), "worker-pids");
	await mkdir(dir);
	process.env.FAKE_WORKER_PIDS = dir;
	return dir;
}

/** Run one job through the real `startWorker`; the fake worker that served it answers with its own pid. */
async function serveJob(): Promise<string> {
	const task = JSON.stringify({ result: { status: "done", summary: "", steps: 0 }, pidInSummary: true });
	const result = await startWorker({ cdpUrl: "ws://127.0.0.1:1/devtools/browser/x", task, maxSteps: 1, startUrl: "about:blank" }, () => undefined).done;
	expect(result.status).toBe("done");
	return result.summary;
}

/** The pids of every worker started in `dir` that is not one of `known`. */
async function workersBeyond(dir: string, ...known: string[]): Promise<string[]> {
	return (await readdir(dir)).filter((pid) => !known.includes(pid)).sort();
}

function alive(pid: string): boolean {
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch {
		return false;
	}
}

describeWithPython("the jev worker's spare", () => {
	afterEach(() => releaseSpare());

	test(
		"a task is served by the spare the previous task left waiting, and leaves its own successor",
		async () => {
			const dir = await pidDirectory();

			const first = await serveJob();
			// The first task spawned its own worker and, right behind it, the spare the next one takes.
			const [spare] = await waitUntil("the spare worker to start", () => workersBeyond(dir, first), (pids) => pids.length === 1);
			const second = await serveJob();

			expect(second).toBe(spare as string);
			// ...and the task that took it spawned its successor in turn.
			const successors = await waitUntil("the next spare to start", () => workersBeyond(dir, first, second), (pids) => pids.length === 1);
			expect(successors).toHaveLength(1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"without jev's key no spare is kept: each task is served by a worker spawned for it, and nothing waits behind them",
		async () => {
			const dir = await pidDirectory();
			delete process.env.TYPESAFE_API_KEY;

			const first = await serveJob();
			const second = await serveJob();

			expect(second).not.toBe(first);
			// A real wall-clock wait, kept to the one place it is needed: the ABSENCE of an OS process is no event to await and a fake
			// clock moves no interpreter. A spare would have started by now (the interpreter's start-up is a fraction of this) and shown up.
			await Bun.sleep(1_000);
			expect(await workersBeyond(dir, first, second)).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a spare started under a different environment (a rotated key) is let go, never handed the next task",
		async () => {
			const dir = await pidDirectory();
			const first = await serveJob();
			const [stale] = await waitUntil("the spare worker to start", () => workersBeyond(dir, first), (pids) => pids.length === 1);

			process.env.TYPESAFE_API_KEY = "rotated-key";
			const second = await serveJob();

			expect(second).not.toBe(stale as string);
			await waitUntil("the stale spare to exit", () => alive(stale as string), (running) => !running);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"disposing the runtime lets the waiting spare go",
		async () => {
			const dir = await pidDirectory();
			const runtime = newRuntime(await createRoot());
			const first = await serveJob();
			const [spare] = await waitUntil("the spare worker to start", () => workersBeyond(dir, first), (pids) => pids.length === 1);
			expect(alive(spare as string)).toBe(true);

			await runtime.dispose();

			await waitUntil("the spare to exit", () => alive(spare as string), (running) => !running);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithPythonAndChrome("a task that starts while the runtime is being disposed", () => {
	test(
		"leaves no spare worker running once dispose has resolved",
		async () => {
			const dir = await pidDirectory();
			const runtime = newRuntime(await createRoot());
			const { browserId } = await runtime.open({ viewport: { width: 640, height: 480 } });

			// The task's start is queued on the browser before dispose begins, so dispose's own first `releaseSpare()` (nothing waits yet)
			// is behind it: the start runs while dispose is draining the browser's queue, spawns its worker and, right behind it, a spare.
			const started = runtime.startTask(browserId, { task: JSON.stringify({ hold: true }) }).catch(() => undefined);
			const disposed = runtime.dispose();
			await Promise.all([started, disposed]);

			try {
				// Both interpreters record their pid the moment they start, the spare's start-up trailing dispose's return by a moment:
				// wait for the two to exist, then every one of them must be gone. A spare nothing releases waits for ten minutes.
				const pids = await waitUntil("the task's worker and its spare to have started", () => readdir(dir), (found) => found.length === 2);
				for (const pid of pids) {
					await waitUntil(`worker ${pid} to exit`, () => alive(pid), (running) => !running);
				}
			} finally {
				releaseSpare(); // after the assertions only: a red run must not leave a Python holding the key
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
