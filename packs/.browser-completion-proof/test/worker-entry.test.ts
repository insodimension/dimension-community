/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a task never reaches jev, or a request the worker cannot act on is
 *  started anyway. The worker is one process speaking JSON lines and jev is the only agent loop it runs, so a valid
 *  request must get as far as jev itself and an invalid one must come back as a `failed` result the server reports,
 *  with no agent started.
 *
 *  The REAL entry point (`python -m dim_browser_bridge`), launched the way `startWorker` launches it, with no fake
 *  worker on the path and no jev package or keys: a request the entry accepts gets as far as jev's own missing-key
 *  answer, which needs neither.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { BROWSER_TEST_TIMEOUT_MS } from "./fixture";

const PYTHON_DIR = fileURLToPath(new URL("../python/", import.meta.url));
const PYTHON = process.env.DIM_BROWSER_PYTHON?.trim() || join(PYTHON_DIR, ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));

if (!existsSync(PYTHON)) {
	console.warn(`[browser tests] ${PYTHON} is missing; the worker entry tests are SKIPPED. Run: cd python && uv sync --python 3.12`);
}
const describeWithPython = existsSync(PYTHON) ? describe : describe.skip;

interface ResultLine {
	type: string;
	status: string;
	summary: string;
}

/** Send one request line to the real worker and answer its `result` line. */
async function ask(request: Record<string, unknown>): Promise<ResultLine> {
	const env = { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" } as Record<string, string | undefined>;
	for (const key of ["PYTHONPATH", "TYPESAFE_API_KEY", "TEXT_MODEL_API_KEY"]) delete env[key];
	const child = spawn(PYTHON, ["-m", "dim_browser_bridge"], { cwd: PYTHON_DIR, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	let out = "";
	let err = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
	const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
	child.stdin.write(`${JSON.stringify(request)}\n`);
	try {
		await exited;
	} finally {
		child.kill();
	}
	const lines = out.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as ResultLine);
	const result = lines.find((line) => line.type === "result");
	if (!result) throw new Error(`the worker wrote no result line. stdout: ${out}; stderr: ${err}`);
	return result;
}

describeWithPython("the task worker's entry point", () => {
	test("a request without a Chrome to drive, or without a task, is invalid and starts no agent", async () => {
		const cdpUrl = "ws://127.0.0.1:1/devtools/browser/x";
		for (const request of [{ task: "fill the form" }, { cdpUrl }, { cdpUrl, task: "  " }]) {
			const result = await ask(request);
			expect({ request, status: result.status, invalid: result.summary.startsWith("invalid request:") }).toEqual({ request, status: "failed", invalid: true });
			// jev was never started: it would have answered for its missing keys.
			expect(result.summary).not.toContain("TYPESAFE_API_KEY");
		}
	}, BROWSER_TEST_TIMEOUT_MS);

	test("a valid request reaches jev: it is accepted and jev answers for its own missing keys", async () => {
		const result = await ask({ cdpUrl: "ws://127.0.0.1:1/devtools/browser/x", task: "fill the form" });

		expect(result.status).toBe("failed");
		expect(result.summary).not.toStartWith("invalid request");
		expect(result.summary).toContain("TYPESAFE_API_KEY");
		expect(result.summary).toContain("TEXT_MODEL_API_KEY");
	}, BROWSER_TEST_TIMEOUT_MS);
});
