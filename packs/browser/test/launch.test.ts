/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: sites refuse the Browser View.
 *  x.com answered 403 before any page loaded, because the View's headless
 *  Chrome announced itself as `HeadlessChrome/<v>` in its User-Agent. The View
 *  must launch the user's real browser (Chrome, else Edge, else a Chromium) as
 *  that browser: its own headful User-Agent, and without puppeteer's
 *  `--enable-automation` switch. A regression here brings the 403s back, or
 *  launches a different browser than the one the user has. It also turns off
 *  Chrome's own password saving in profiles the pack owns (its save prompt
 *  steals focus after a sign-in, invisibly in a headless View) without
 *  clobbering the rest of the profile's settings.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserProbe, headfulUserAgent, resolveBrowser, turnOffPasswordSaving, viewLaunchOptions } from "../src/engines/launch";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, createRuntime, describeWithChrome, failureCode, perform, teardown } from "./fixture";

afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

const HEADLESS_CHROME_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36";
const HEADLESS_EDGE_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0";

// ---------------------------------------------------------------------------
// Chrome's own password saving
// ---------------------------------------------------------------------------

describe("turnOffPasswordSaving", () => {
	test("a fresh profile gets a Preferences file with password saving off", async () => {
		const dir = await createRoot();
		turnOffPasswordSaving(dir);
		const prefs = JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8"));
		expect(prefs).toEqual({ credentials_enable_service: false, profile: { password_manager_enabled: false } });
	});

	test("an existing profile keeps every other setting", async () => {
		const dir = await createRoot();
		mkdirSync(join(dir, "Default"));
		const existing = {
			browser: { has_seen_welcome_page: true, window_placement: { top: 10 } },
			credentials_enable_service: true,
			profile: { name: "x", exit_type: "Normal", password_manager_enabled: true },
		};
		writeFileSync(join(dir, "Default", "Preferences"), JSON.stringify(existing));
		turnOffPasswordSaving(dir);
		expect(JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8"))).toEqual({
			browser: existing.browser,
			credentials_enable_service: false,
			profile: { name: "x", exit_type: "Normal", password_manager_enabled: false },
		});
	});

	for (const [name, bytes] of [
		["corrupt JSON", '{"profile": {"name": "x"'],
		["JSON that is not an object", "[1,2]"],
	] as const) {
		test(`${name} in Preferences is left byte-identical`, async () => {
			const dir = await createRoot();
			mkdirSync(join(dir, "Default"));
			writeFileSync(join(dir, "Default", "Preferences"), bytes);
			turnOffPasswordSaving(dir);
			expect(readFileSync(join(dir, "Default", "Preferences"), "utf8")).toBe(bytes);
		});
	}
});

// ---------------------------------------------------------------------------
// Launch switches
// ---------------------------------------------------------------------------

describe("viewLaunchOptions", () => {
	const browser = { app: "chrome" as const, executablePath: "C:\\chrome.exe" };
	const ua = headfulUserAgent(HEADLESS_CHROME_UA);

	for (const headless of [true, false]) {
		test(`${headless ? "headless" : "headful"}: puppeteer's --enable-automation never reaches the browser, nothing replaces it`, () => {
			const options = viewLaunchOptions({ browser, userDataDir: "profile", headless, args: ["--no-first-run"], userAgent: ua, timeout: 1 });
			expect(options.ignoreDefaultArgs).toContain("--enable-automation");
			expect(options.args).not.toContain("--enable-automation");
			expect(options.args?.some((arg) => arg.includes("AutomationControlled"))).toBe(false);
			expect(options.args).toContain("--no-first-run");
		});
	}

	test("headless launches with the given headful User-Agent", () => {
		const options = viewLaunchOptions({ browser, userDataDir: "profile", headless: true, args: [], userAgent: ua, timeout: 1 });
		expect(options.args).toContain(`--user-agent=${ua}`);
	});

	test("headful launches with the browser's own User-Agent (no override)", () => {
		const options = viewLaunchOptions({ browser, userDataDir: "profile", headless: false, args: [], userAgent: ua, timeout: 1 });
		expect(options.args?.some((arg) => arg.startsWith("--user-agent="))).toBe(false);
	});
});

describe("headfulUserAgent", () => {
	test("a headless Chrome UA becomes the same Chrome's headful UA", () => {
		expect(headfulUserAgent(HEADLESS_CHROME_UA)).toBe(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
		);
	});

	test("a headless Edge UA keeps its Edg/ token and loses only the headless one", () => {
		expect(headfulUserAgent(HEADLESS_EDGE_UA)).toBe(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0",
		);
	});
});

// ---------------------------------------------------------------------------
// Which browser
// ---------------------------------------------------------------------------

const PROGRAMFILES = "C:\\Program Files";
const PROGRAMFILES_X86 = "C:\\Program Files (x86)";
const LOCALAPPDATA = "C:\\Users\\u\\AppData\\Local";
const CACHE = "C:\\cache\\puppeteer";
const WIN_CHROME = join(PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe");
const WIN_EDGE = join(PROGRAMFILES_X86, "Microsoft", "Edge", "Application", "msedge.exe");

function probe(platform: NodeJS.Platform, files: string[], dirs: Record<string, string[]> = {}): BrowserProbe {
	const present = new Set(files);
	return {
		platform,
		env: { PROGRAMFILES, "PROGRAMFILES(X86)": PROGRAMFILES_X86, LOCALAPPDATA, PUPPETEER_CACHE_DIR: CACHE },
		home: platform === "win32" ? "C:\\Users\\u" : "/home/u",
		exists: (path) => present.has(path),
		list: (dir) => dirs[dir] ?? [],
	};
}

function cachedChrome(build: string): string {
	return join(CACHE, "chrome", build, "chrome-win64", "chrome.exe");
}

describe("resolveBrowser", () => {
	test("prefers the installed Google Chrome over Edge", () => {
		expect(resolveBrowser(undefined, probe("win32", [WIN_EDGE, WIN_CHROME]))).toEqual({ app: "chrome", executablePath: WIN_CHROME });
	});

	test("falls back to Edge when Chrome is not installed", () => {
		expect(resolveBrowser(undefined, probe("win32", [WIN_EDGE]))).toEqual({ app: "msedge", executablePath: WIN_EDGE });
	});

	test("falls back to the NEWEST Chromium in puppeteer's cache, by numeric version", () => {
		const builds = ["win64-99.0.4844.51", "win64-153.0.7000.0", "win64-151.0.1.2", "not-a-build"];
		const found = resolveBrowser(undefined, probe("win32", builds.map(cachedChrome), { [join(CACHE, "chrome")]: builds }));
		expect(found).toEqual({ app: "chromium", executablePath: cachedChrome("win64-153.0.7000.0") });
	});

	test("skips a cached build whose binary is missing", () => {
		const builds = ["win64-153.0.7000.0", "win64-151.0.1.2"];
		const found = resolveBrowser(undefined, probe("win32", [cachedChrome("win64-151.0.1.2")], { [join(CACHE, "chrome")]: builds }));
		expect(found).toEqual({ app: "chromium", executablePath: cachedChrome("win64-151.0.1.2") });
	});

	test("an explicit binary wins as `custom`, even with Chrome installed", () => {
		expect(resolveBrowser("D:\\my\\chrome.exe", probe("win32", [WIN_CHROME]))).toEqual({ app: "custom", executablePath: "D:\\my\\chrome.exe" });
	});

	test("linux: Edge is found at its system path when there is no Chrome", () => {
		expect(resolveBrowser(undefined, probe("linux", ["/usr/bin/microsoft-edge", "/usr/bin/chromium"]))).toEqual({
			app: "msedge",
			executablePath: "/usr/bin/microsoft-edge",
		});
	});

	test("no browser anywhere is refused with browser_not_found", async () => {
		expect(await failureCode(async () => resolveBrowser(undefined, probe("win32", [])))).toBe("browser_not_found");
	});
});

// ---------------------------------------------------------------------------
// The real View browser, as a site sees it
// ---------------------------------------------------------------------------

/** A page that shows what the server received and what page script sees. */
function startEcho(): { url: string; stop: () => void } {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const header = JSON.stringify(request.headers.get("user-agent") ?? "");
			const markup = `<!doctype html><title>pending</title><script>document.title = JSON.stringify({ header: ${header}, js: navigator.userAgent });</script>`;
			return new Response(markup, { headers: { "content-type": "text/html; charset=utf-8" } });
		},
	});
	return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

describeWithChrome("launch", () => {
	test(
		"the headless View presents as its own headful browser, to the server and to page script",
		async () => {
			const echo = startEcho();
			try {
				const { runtime } = await createRuntime();
				const opened = await runtime.open({ profile: "ua", viewport: { width: 640, height: 480 } });
				// The fixture passes Chrome's path explicitly, so the app is `custom`.
				expect(opened.app).toBe("custom");

				const state = await perform(runtime, opened.browserId, { kind: "navigate", url: echo.url });
				const seen = JSON.parse(state.title) as { header: string; js: string };
				expect(seen.header).toMatch(/ Chrome\/\d+/);
				expect(seen.header).not.toContain("HeadlessChrome");
				expect(seen.js).toBe(seen.header);
			} finally {
				echo.stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
