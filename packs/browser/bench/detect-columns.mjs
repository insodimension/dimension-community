#!/usr/bin/env bun
// One column of the headless-detection comparison, in its own process.
//
//   bun bench/detect-columns.mjs --column stock|throwaway|profile|omp [--runs 8] [--no-gpu] [--src <dir of a packs/browser/src>]
//                                [--omp <OMP's tools/browser/launch.ts> --omp-puppeteer <OMP's patched puppeteer-core, bundled as ESM>]
//
// Prints one JSON object: the rows the detection page (bench/sites/detect.mjs) reported and which of them a detector would flag, the
// row that needs the driver to have acted first, and how long opening a browser and its first navigation took (the first of `runs`
// is the cold one: it includes the once-per-binary identity probe).
//
//   stock       puppeteer-core `launch({ headless: true })`, nothing else
//   throwaway   BrowserRuntime.open({}) from `--src` (default: this checkout's src)  <- "ours"; `--src` of an older tree gives "before"
//   reader      browser_read's reader: the time of each BrowserRuntime.read of a 1 KB page (the first is the cold one: it launches the reader);
//               no rows (its page cannot POST them)
//   profile     BrowserRuntime.open({ profile }): the path the View and every saved profile take
//   omp         OMP's own launch argv and ignored default arguments (buildHeadlessLaunchArgs, stealthIgnoreDefaultArgs), applyStealthPatches and
//               applyViewport, as its tab worker calls them, on its patched puppeteer-core. Needs `--omp` (the file)
//               and `--omp-puppeteer` (OMP's puppeteer-core 25.x with omp/patches/puppeteer-core@25.3.0.patch applied), both outside this
//               pack; nothing here imports them unless asked. Run it with HOME/USERPROFILE pointing at an empty directory: OMP writes its
//               puppeteer directory under the home.
//
// The driver's action on the page is the same everywhere: a read that calls hooked page APIs (a snapshot for the pack, a querySelectorAll
// evaluate for the others).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDetectServer } from "./sites/detect.mjs";

const arg = (name, fallback) => {
	const at = process.argv.indexOf(`--${name}`);
	return at < 0 ? fallback : process.argv[at + 1];
};
const column = arg("column");
const runs = Number(arg("runs", "8"));
const noGpu = process.argv.includes("--no-gpu");
const CHROME = process.env.BROWSER_TEST_CHROME ?? process.env.PUPPETEER_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(arg("src", join(here, "../src")));
const GPULESS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const quartiles = (values) => { const sorted = [...values].sort((a, b) => a - b); return [sorted[Math.floor(sorted.length / 4)], sorted[Math.floor((sorted.length * 3) / 4)]]; };

/** A way to open a browser and show it a page: { open, navigate, act, close }. */
async function adapter() {
	if (column === "stock") {
		const { default: puppeteer } = await import("puppeteer-core");
		return {
			async open() {
				const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: noGpu ? GPULESS : [] });
				const page = await browser.newPage();
				return { browser, page };
			},
			navigate: (h, url) => h.page.goto(url),
			act: (h) => h.page.evaluate(() => document.querySelectorAll("a, button, input").length),
			close: (h) => h.browser.close(),
		};
	}
	if (column === "omp") {
		const launchFile = arg("omp");
		const puppeteerFile = arg("omp-puppeteer");
		if (!launchFile || !puppeteerFile) throw new Error("--column omp needs --omp and --omp-puppeteer");
		// OMP's own argv, ignored default arguments, stealth scripts and viewport, on OMP's patched puppeteer-core. Its `launchHeadlessBrowser` is
		// not called: it resolves puppeteer by name and, under this harness, did not connect; the options below are the ones it passes.
		const patched = (await import(pathToFileURL(resolve(puppeteerFile)).href)).default;
		const omp = await import(pathToFileURL(resolve(launchFile)).href);
		return {
			async open() {
				const userDataDir = mkdtempSync(join(tmpdir(), "omp-chrome-profile-"));
				const browser = await patched.launch({
					headless: true,
					defaultViewport: omp.DEFAULT_VIEWPORT,
					executablePath: CHROME,
					args: [...omp.buildHeadlessLaunchArgs(omp.DEFAULT_VIEWPORT), ...(noGpu ? GPULESS : []), `--user-data-dir=${userDataDir}`],
					ignoreDefaultArgs: omp.stealthIgnoreDefaultArgsForTest(CHROME),
					protocolTimeout: omp.BROWSER_PROTOCOL_TIMEOUT_MS,
				});
				const page = await browser.newPage();
				await omp.applyStealthPatches(browser, page, { browserSession: null, override: null });
				await omp.applyViewport(page);
				return { browser, page, userDataDir };
			},
			navigate: (h, url) => h.page.goto(url),
			act: (h) => h.page.evaluate(() => document.querySelectorAll("a, button, input").length),
			close: async (h) => { await h.browser.close(); rmSync(h.userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); },
		};
	}
	if (column === "throwaway" || column === "profile") {
		const { BrowserRuntime } = await import(pathToFileURL(join(src, "runtime.ts")).href);
		const root = mkdtempSync(join(tmpdir(), "detect-columns-"));
		const runtime = new BrowserRuntime({ headless: true, executablePath: CHROME, rootDir: root, ...(noGpu ? { launchArgs: GPULESS } : {}) });
		let n = 0;
		return {
			async open() {
				const { browserId } = await runtime.open(column === "profile" ? { profile: `p${n++}` } : {});
				return { browserId };
			},
			navigate: (h, url) => runtime.act(h.browserId, { kind: "navigate", url }),
			act: (h) => runtime.snapshot(h.browserId),
			close: async (h) => { await runtime.close?.(h.browserId); },
			dispose: async () => { await runtime.dispose(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); },
		};
	}
	throw new Error("--column must be stock, throwaway, profile or omp");
}

const server = await createDetectServer();
if (column === "reader") {
	const { BrowserRuntime } = await import(pathToFileURL(join(src, "runtime.ts")).href);
	const root = mkdtempSync(join(tmpdir(), "detect-columns-"));
	const runtime = new BrowserRuntime({ headless: true, executablePath: CHROME, rootDir: root, allowPrivateReadHosts: ["127.0.0.1"], ...(noGpu ? { launchArgs: GPULESS } : {}) });
	const reads = [];
	for (let i = 0; i < runs; i += 1) {
		const t0 = performance.now();
		const result = await runtime.read({ url: `${server.url}__detect/blank`, maxChars: 2000 });
		if (result.status !== "ok") throw new Error(`the read failed: ${JSON.stringify(result)}`);
		reads.push(Math.round(performance.now() - t0));
	}
	await runtime.dispose();
	await server.stop();
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	console.log(JSON.stringify({ column, noGpu, runs, reads, cold: reads[0], warm: { median: median(reads.slice(1)), iqr: quartiles(reads.slice(1)) } }));
	process.exit(0);
}
const driver = await adapter();
const out = { column, noGpu, chrome: CHROME, runs, open: [], firstNavigation: [] };
try {
	for (let i = 0; i < runs; i += 1) {
		const t0 = performance.now();
		const handle = await driver.open();
		const t1 = performance.now();
		await driver.navigate(handle, `${server.url}__detect/blank`);
		const t2 = performance.now();
		out.open.push(Math.round(t1 - t0));
		out.firstNavigation.push(Math.round(t2 - t1));
		await driver.close(handle);
	}
	const handle = await driver.open();
	server.reset();
	await driver.navigate(handle, server.url);
	for (let waited = 0; server.rows() === null && waited < 20_000; waited += 50) await sleep(50);
	await driver.act(handle);
	const seen = server.lates();
	for (let waited = 0; server.lates() < seen + 2 && waited < 5_000; waited += 50) await sleep(50);
	const rows = [...(server.rows() ?? []), ...(server.late() ? [server.late()] : [])];
	out.flagged = rows.filter((row) => row.tell).map((row) => row.id);
	out.signals = rows.length;
	out.rows = Object.fromEntries(rows.map((row) => [row.id, row.tell]));
	out.frame = server.frame();
	out.hookedByDriver = server.hooked().length;
	await driver.close(handle);
} finally {
	await driver.dispose?.();
	await server.stop();
}
out.cold = { open: out.open[0], firstNavigation: out.firstNavigation[0] };
out.later = { open: { median: median(out.open.slice(1)), iqr: quartiles(out.open.slice(1)) }, firstNavigation: { median: median(out.firstNavigation.slice(1)), iqr: quartiles(out.firstNavigation.slice(1)) } };
console.log(JSON.stringify(out));
process.exit(0);
