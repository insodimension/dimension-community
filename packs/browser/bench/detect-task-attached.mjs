#!/usr/bin/env bun
// What a page sees of a throwaway agent browser while ANOTHER CDP client is attached to it, as a browser_task agent is.
//
//   bun bench/detect-task-attached.mjs [--no-gpu]
//
// Prints one JSON object: the detection page's flagged rows with the throwaway alone, and again with a second client attached to its DevTools port.
// The second client is stock puppeteer-core (it enables Runtime on the page); it stands in for a task agent's own client, and browser-use and jev
// themselves are not run. Run it under the memory guard, like every column (see detect-report-2026-10-02.md).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import { createDetectServer } from "./sites/detect.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.BROWSER_TEST_CHROME ?? process.env.PUPPETEER_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const noGpu = process.argv.includes("--no-gpu");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const { BrowserRuntime } = await import(pathToFileURL(resolve(here, "../src/runtime.ts")).href);

const root = mkdtempSync(join(tmpdir(), "task-attached-"));
const runtime = new BrowserRuntime({ headless: true, executablePath: CHROME, rootDir: root, ...(noGpu ? { launchArgs: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } : {}) });
const server = await createDetectServer();

/** Load the detection page in `browserId`, let the driver act once, and answer the rows a detector would flag. */
async function flaggedRows(browserId) {
	server.reset();
	await runtime.act(browserId, { kind: "navigate", url: server.url });
	for (let waited = 0; server.rows() === null && waited < 20_000; waited += 50) await sleep(50);
	await runtime.snapshot(browserId);
	const seen = server.lates();
	for (let waited = 0; server.lates() < seen + 2 && waited < 5_000; waited += 50) await sleep(50);
	const rows = [...(server.rows() ?? []), ...(server.late() ? [server.late()] : [])];
	return { flagged: rows.filter((row) => row.tell).map((row) => row.id), signals: rows.length };
}

try {
	const { browserId } = await runtime.open({});
	const alone = await flaggedRows(browserId);
	const ephemeral = join(root, "ephemeral");
	const chrome = readdirSync(ephemeral).map((name) => join(ephemeral, name, "chrome")).find((dir) => existsSync(join(dir, "DevToolsActivePort")));
	if (!chrome) throw new Error("the throwaway browser's DevToolsActivePort was not found");
	const [port, path] = readFileSync(join(chrome, "DevToolsActivePort"), "utf8").trim().split("\n");
	const other = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}${path}`, defaultViewport: null });
	const page = (await other.pages()).find((candidate) => candidate.url().startsWith(server.url));
	await page?.evaluate(() => 1);
	const attached = await flaggedRows(browserId);
	await other.disconnect();
	console.log(JSON.stringify({ noGpu, alone, attached }));
} finally {
	await runtime.dispose();
	await server.stop();
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
process.exit(0);
