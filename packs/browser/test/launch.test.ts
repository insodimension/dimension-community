/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: sites refuse the Browser View.
 *  x.com answered 403 before any page loaded, because the View's headless
 *  Chrome announced itself as `HeadlessChrome/<v>` in its User-Agent. The View
 *  must launch the user's real browser (Chrome, else Edge, else a Chromium) as
 *  that browser: its own headful User-Agent and client hints, in every page,
 *  frame and worker, and without puppeteer's `--enable-automation` switch. A
 *  regression here brings the 403s back, or launches a different browser than
 *  the one the user has. It also turns off Chrome's own password saving in
 *  profiles the pack owns (its save prompt steals focus after a sign-in,
 *  invisibly in a headless View) without clobbering the rest of the profile's
 *  settings.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Browser, BrowserPlatform, computeExecutablePath } from "@puppeteer/browsers";
import puppeteer, { type Protocol } from "puppeteer-core";
import { type BrowserProbe, headfulIdentity, type IdentityProbe, identityPerBinary, resolveBrowser, turnOffPasswordSaving, viewLaunchOptions, withTimeout } from "../src/engines/launch";
import { BROWSER_TEST_TIMEOUT_MS, chromePath, createRoot, createRuntime, describeWithChrome, failureCode, perform, teardown, waitUntil } from "./fixture";

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
// Launch switches and identity
// ---------------------------------------------------------------------------

describe("viewLaunchOptions", () => {
	const browser = { app: "chrome" as const, executablePath: "C:\\chrome.exe" };
	const ua = headfulIdentity({ userAgent: HEADLESS_CHROME_UA, hints: {} }).userAgent;

	for (const headless of [true, false]) {
		test(`${headless ? "headless" : "headful"}: puppeteer's --enable-automation never reaches the browser, nothing replaces it`, () => {
			const options = viewLaunchOptions({ browser, userDataDir: "profile", headless, args: ["--no-first-run"], userAgent: ua, timeout: 1 });
			expect(options.ignoreDefaultArgs).toContain("--enable-automation");
			expect(options.args).not.toContain("--enable-automation");
			expect(options.args?.some((arg) => arg.includes("AutomationControlled"))).toBe(false);
			expect(options.args).toContain("--no-first-run");
		});
	}

	describe("a throwaway agent browser", () => {
		test("headless: webdriver is off from the browser itself, and puppeteer's page-visible defaults (popup blocker off, IPC flooding protection off) stay out", () => {
			const options = viewLaunchOptions({ browser, userDataDir: "profile", headless: true, args: [], agent: true, timeout: 1 });
			expect(options.args).toContain("--disable-blink-features=AutomationControlled");
			expect(options.ignoreDefaultArgs).toEqual(expect.arrayContaining(["--enable-automation", "--disable-popup-blocking", "--disable-ipc-flooding-protection", "--allow-pre-commit-input"]));
		});

		test("with a window: no automation-hiding switch, because Chrome pins an 'unsupported command-line flag' bar to every window it opens with one", () => {
			const options = viewLaunchOptions({ browser, userDataDir: "profile", headless: false, args: [], agent: true, timeout: 1 });
			expect(options.args?.some((arg) => arg.includes("AutomationControlled"))).toBe(false);
		});

		test("the View and a saved profile keep puppeteer's popup blocker setting and IPC protection default", () => {
			const options = viewLaunchOptions({ browser, userDataDir: "profile", headless: true, args: [], timeout: 1 });
			expect(options.ignoreDefaultArgs).toEqual(["--enable-automation"]);
		});
	});

	test("headless launches with the given headful User-Agent", () => {
		const options = viewLaunchOptions({ browser, userDataDir: "profile", headless: true, args: [], userAgent: ua, timeout: 1 });
		expect(options.args).toContain(`--user-agent=${ua}`);
	});

	test("headful launches with the browser's own User-Agent (no override)", () => {
		const options = viewLaunchOptions({ browser, userDataDir: "profile", headless: false, args: [], userAgent: ua, timeout: 1 });
		expect(options.args?.some((arg) => arg.startsWith("--user-agent="))).toBe(false);
	});
});

describe("headfulIdentity", () => {
	test("a headless Chrome UA becomes the same Chrome's headful UA", () => {
		expect(headfulIdentity({ userAgent: HEADLESS_CHROME_UA, hints: {} }).userAgent).toBe(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
		);
	});

	test("a headless Edge UA keeps its Edg/ token and loses only the headless one", () => {
		expect(headfulIdentity({ userAgent: HEADLESS_EDGE_UA, hints: {} }).userAgent).toBe(
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0",
		);
	});

	test("the binary's reported client hints become CDP UserAgentMetadata", () => {
		const brands = [{ brand: "Microsoft Edge", version: "154" }, { brand: "Chromium", version: "154" }, { brand: "Not)A;Brand", version: "8" }];
		const fullVersionList = [
			{ brand: "Microsoft Edge", version: "154.0.3100.12" },
			{ brand: "Chromium", version: "154.0.7700.4" },
			{ brand: "Not)A;Brand", version: "8.0.0.0" },
		];
		const { metadata } = headfulIdentity({
			userAgent: HEADLESS_EDGE_UA,
			hints: {
				brands, fullVersionList, uaFullVersion: "154.0.3100.12", platform: "Windows", platformVersion: "19.0.0",
				architecture: "x86", model: "", mobile: false, bitness: "64", wow64: false, formFactors: ["Desktop"],
			},
		});
		expect(metadata).toEqual({
			brands, fullVersionList, fullVersion: "154.0.3100.12", platform: "Windows", platformVersion: "19.0.0",
			architecture: "x86", model: "", mobile: false, bitness: "64", wow64: false, formFactors: ["Desktop"],
		});
	});
});

describe("identityPerBinary", () => {
	/** A fake binary whose probe reports `Chrome/<version>` and records how it was retired. */
	function fakeBinary(close: () => Promise<void> = async () => undefined) {
		const binary = { version: 154, mtime: 1, launches: 0, closes: 0, kills: 0, failNextRead: false };
		const identities = identityPerBinary({
			stamp: () => binary.mtime,
			closeTimeoutMs: 1,
			async launch(): Promise<IdentityProbe> {
				binary.launches++;
				const version = binary.version;
				const fails = binary.failNextRead;
				binary.failNextRead = false;
				return {
					read: async () => {
						if (fails) throw new Error("probe crashed");
						return { userAgent: `Mozilla/5.0 HeadlessChrome/${version}.0.0.0`, hints: { uaFullVersion: `${version}.0.1.2` } };
					},
					close: () => {
						binary.closes++;
						return close();
					},
					kill: () => void binary.kills++,
				};
			},
		});
		return { binary, identities, identityOf: identities.of };
	}

	test("one probe per build; an in-place update at the same path is probed again", async () => {
		const { binary, identityOf } = fakeBinary();
		expect((await identityOf("chrome")).metadata.fullVersion).toBe("154.0.1.2");
		expect((await identityOf("chrome")).metadata.fullVersion).toBe("154.0.1.2");
		expect(binary.launches).toBe(1);
		binary.version = 155;
		binary.mtime = 2;
		const updated = await identityOf("chrome");
		expect({ ua: updated.userAgent, full: updated.metadata.fullVersion, launches: binary.launches }).toEqual({
			ua: "Mozilla/5.0 Chrome/155.0.0.0", full: "155.0.1.2", launches: 2,
		});
	});

	test("an update the stamp missed (the running version differs) is probed again exactly once per open", async () => {
		const { binary, identities, identityOf } = fakeBinary();
		const cached = await identityOf("chromium");
		expect(await identities.confirm("chromium", cached, "154.0.1.2")).toBe(cached);
		expect(binary.launches).toBe(1);
		// A snap refresh: same path, same stamp, a new binary behind it.
		binary.version = 155;
		const fresh = await identities.confirm("chromium", cached, "155.0.1.2");
		expect({ full: fresh.metadata.fullVersion, launches: binary.launches }).toEqual({ full: "155.0.1.2", launches: 2 });
		expect(await identityOf("chromium")).toBe(fresh);
		// A re-probe that still disagrees is taken as read: one probe, no loop.
		binary.version = 156;
		const once = await identities.confirm("chromium", fresh, "157.0.1.2");
		expect({ full: once.metadata.fullVersion, launches: binary.launches }).toEqual({ full: "156.0.1.2", launches: 3 });
	});

	test("an identity read from a browser that is already running is learned: no probe is launched for it, and nothing stands in for a binary never read", async () => {
		const { binary, identities, identityOf } = fakeBinary();
		expect(identities.known("chrome")).toBeUndefined();
		const learned = headfulIdentity({ userAgent: "Mozilla/5.0 HeadlessChrome/154.0.0.0", hints: { uaFullVersion: "154.0.9.9" } });
		identities.learn("chrome", learned);
		expect(await identities.known("chrome")).toBe(learned);
		expect(await identityOf("chrome")).toBe(learned);
		expect(binary.launches).toBe(0);
		// Another build of the binary was not read.
		binary.mtime = 2;
		expect(identities.known("chrome")).toBeUndefined();
	});

	test("a failed probe is retired and not cached: the next open probes again", async () => {
		const { binary, identityOf } = fakeBinary();
		binary.failNextRead = true;
		await expect(identityOf("chrome")).rejects.toThrow("probe crashed");
		expect((await identityOf("chrome")).metadata.fullVersion).toBe("154.0.1.2");
		expect({ launches: binary.launches, closes: binary.closes }).toEqual({ launches: 2, closes: 2 });
	});

	for (const [name, close] of [
		["hangs", () => new Promise<void>(() => undefined)],
		["fails", () => Promise.reject(new Error("close failed"))],
	] as const) {
		test(`a probe close that ${name} is killed, and the identity it read stands`, async () => {
			const { binary, identityOf } = fakeBinary(close);
			// A real deadline: an unbounded close leaves nothing pending but this
			// promise, and bun's own test timeout never fires on an idle loop.
			expect((await withTimeout(identityOf("chrome"), 2_000, "the identity, with the probe close unbounded")).userAgent).toBe("Mozilla/5.0 Chrome/154.0.0.0");
			expect(binary.kills).toBe(1);
		});
	}
});

// ---------------------------------------------------------------------------
// Which browser
// ---------------------------------------------------------------------------

/**
 * A machine inside a temp dir: Program Files, the home dir and puppeteer's
 * cache all live under it, and `exists` sees only files under it, so the
 * real browsers on this machine never answer.
 */
async function fakeMachine(platform: NodeJS.Platform, browserPlatform: BrowserPlatform | undefined) {
	const root = await createRoot();
	const cacheDir = join(root, "cache");
	const probe: BrowserProbe = {
		platform,
		browserPlatform,
		env: { PROGRAMFILES: join(root, "pf"), "PROGRAMFILES(X86)": join(root, "pf86"), LOCALAPPDATA: join(root, "local"), PUPPETEER_CACHE_DIR: cacheDir },
		home: join(root, "home"),
		exists: (path) => path.startsWith(root) && existsSync(path),
	};
	const touch = (path: string): string => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "");
		return path;
	};
	/** A Chrome for Testing build laid out the way @puppeteer/browsers installs it; `binary: false` leaves only its folder. */
	const cache = (platform: BrowserPlatform, buildId: string, binary = true): string => {
		const path = computeExecutablePath({ browser: Browser.CHROME, platform, buildId, cacheDir });
		if (binary) return touch(path);
		mkdirSync(join(cacheDir, "chrome", `${platform}-${buildId}`), { recursive: true });
		return path;
	};
	return { probe, touch, cache, env: probe.env as Record<string, string> };
}

describe("resolveBrowser", () => {
	test("prefers the installed Google Chrome over Edge", async () => {
		const machine = await fakeMachine("win32", BrowserPlatform.WIN64);
		machine.touch(join(machine.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"));
		const chrome = machine.touch(join(machine.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"));
		expect(await resolveBrowser(undefined, machine.probe)).toEqual({ app: "chrome", executablePath: chrome });
	});

	test("falls back to Edge when Chrome is not installed", async () => {
		const machine = await fakeMachine("win32", BrowserPlatform.WIN64);
		const edge = machine.touch(join(machine.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"));
		machine.cache(BrowserPlatform.WIN64, "153.0.7000.0");
		expect(await resolveBrowser(undefined, machine.probe)).toEqual({ app: "msedge", executablePath: edge });
	});

	test("macOS: Edge in the user's own Applications folder", async () => {
		const machine = await fakeMachine("darwin", BrowserPlatform.MAC_ARM);
		const edge = machine.touch(join(machine.probe.home, "Applications", "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"));
		expect(await resolveBrowser(undefined, machine.probe)).toEqual({ app: "msedge", executablePath: edge });
	});

	// Every machine's cache holds builds for all three platforms, and the other
	// platforms' builds are NEWER: only this platform's newest may be picked.
	for (const [platform, own] of [
		["win32", BrowserPlatform.WIN64],
		["linux", BrowserPlatform.LINUX],
		["darwin", BrowserPlatform.MAC_ARM],
	] as const) {
		test(`${own}: the newest cached Chrome for Testing of THIS platform, by numeric version`, async () => {
			const machine = await fakeMachine(platform, own);
			for (const other of [BrowserPlatform.WIN64, BrowserPlatform.LINUX, BrowserPlatform.MAC_ARM]) {
				if (other !== own) machine.cache(other, "160.0.8000.0");
			}
			machine.cache(own, "99.0.4844.51");
			const newest = machine.cache(own, "153.0.7000.0");
			machine.cache(own, "151.0.1.2");
			expect(await resolveBrowser(undefined, machine.probe)).toEqual({ app: "chromium", executablePath: newest });
		});
	}

	test("skips a cached build whose binary is missing", async () => {
		const machine = await fakeMachine("win32", BrowserPlatform.WIN64);
		machine.cache(BrowserPlatform.WIN64, "153.0.7000.0", false);
		const present = machine.cache(BrowserPlatform.WIN64, "151.0.1.2");
		expect(await resolveBrowser(undefined, machine.probe)).toEqual({ app: "chromium", executablePath: present });
	});

	test("an explicit binary wins as `custom`, even with Chrome installed", async () => {
		const machine = await fakeMachine("win32", BrowserPlatform.WIN64);
		machine.touch(join(machine.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"));
		expect(await resolveBrowser("D:\\my\\chrome.exe", machine.probe)).toEqual({ app: "custom", executablePath: "D:\\my\\chrome.exe" });
	});

	test("no browser anywhere (only another platform's cached build) is refused with browser_not_found", async () => {
		const machine = await fakeMachine("win32", BrowserPlatform.WIN64);
		machine.cache(BrowserPlatform.LINUX, "153.0.7000.0");
		expect(await failureCode(() => resolveBrowser(undefined, machine.probe))).toBe("browser_not_found");
	});
});

// ---------------------------------------------------------------------------
// The real View browser, as a site sees it
// ---------------------------------------------------------------------------

/** The high-entropy client hints the site asks for (Accept-CH + Critical-CH) and delegates to its cross-site iframe. */
const HINT_HEADERS = ["sec-ch-ua-full-version-list", "sec-ch-ua-platform-version", "sec-ch-ua-arch", "sec-ch-ua-bitness"];
/** Every identity header a request carries: the User-Agent, the default low-entropy hints, and the ones asked for. */
const IDENTITY_HEADERS = ["user-agent", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", ...HINT_HEADERS];
/** What each context asks `navigator.userAgentData.getHighEntropyValues` for. */
const HIGH_ENTROPY = ["brands", "fullVersionList", "uaFullVersion", "platform", "platformVersion", "architecture", "bitness", "model", "mobile", "wow64"];

interface BrandVersion {
	brand: string;
	version: string;
}

/** What one context (page, frame, worker) sees of itself. */
interface Identity {
	ua: string;
	hints: Record<string, unknown> & { fullVersionList: BrandVersion[]; uaFullVersion: string; platformVersion: string; architecture: string; bitness: string };
}

/** Script that defines `identity()`: this context's User-Agent and high-entropy client hints. */
const IDENTITY_JS = `const identity = async () => ({ ua: navigator.userAgent, hints: await navigator.userAgentData.getHighEntropyValues(${JSON.stringify(HIGH_ENTROPY)}) });`;

/**
 * The page asks for the high-entropy hints and delegates them to a cross-site
 * iframe (an out-of-process frame), then collects `identity()` from itself, a
 * dedicated worker, a shared worker and a service worker and POSTs them to
 * `/report`; the iframe POSTs its own.
 */
const IDENTITY_PAGE = (frameUrl: string): string => `<!doctype html><title>identity</title>
<iframe src="${frameUrl}"></iframe>
<script>
${IDENTITY_JS}
(async () => {
  const out = {};
  const ask = (start) => { const { promise, resolve } = Promise.withResolvers(); start(resolve); return promise; };
  try {
    out.page = await identity();
    out.worker = await ask((resolve) => { new Worker("/worker.js").onmessage = (e) => resolve(e.data); });
    out.shared = await ask((resolve) => { new SharedWorker("/shared.js").port.onmessage = (e) => resolve(e.data); });
    await navigator.serviceWorker.register("/sw.js");
    const active = (await navigator.serviceWorker.ready).active;
    out.service = await ask((resolve) => { navigator.serviceWorker.onmessage = (e) => resolve(e.data); active.postMessage("identity"); });
  } catch (err) {
    out.error = String(err);
  }
  await fetch("/report", { method: "POST", body: JSON.stringify(out) });
})();
</script>`;

/** The cross-site frame: loads a subresource of its own, then reports its identity. */
const FRAME_PAGE = `<!doctype html><script src="/frame.js"></script><script>
${IDENTITY_JS}
identity().then((frame) => ({ frame }), (err) => ({ frameError: String(err) }))
  .then((out) => fetch("/report", { method: "POST", body: JSON.stringify(out) }));
</script>`;

/** Each worker fetches once from inside itself (a request the worker makes, not its script's own fetch), then reports. */
const SCRIPTS: Record<string, string> = {
	"/frame.js": "",
	"/worker.js": `${IDENTITY_JS} fetch("/from-worker").then(identity).then(postMessage);`,
	"/shared.js": `${IDENTITY_JS} onconnect = async (e) => { await fetch("/from-shared"); e.ports[0].postMessage(await identity()); };`,
	"/sw.js": `${IDENTITY_JS} self.addEventListener("message", async (e) => { await fetch("/from-service"); e.source.postMessage(await identity()); });`,
};

const CONTEXTS = ["page", "frame", "worker", "shared", "service"] as const;
/** The requests a site sees, as `host + path`: the top document, the iframe and its subresource, each worker's script and a request from inside each worker. */
const REQUESTS = [
	"127.0.0.1/", "localhost/frame", "localhost/frame.js",
	"127.0.0.1/worker.js", "127.0.0.1/from-worker", "127.0.0.1/shared.js", "127.0.0.1/from-shared", "127.0.0.1/sw.js", "127.0.0.1/from-service",
] as const;

/** What a site saw of the browser: each context's own report, and each request's identity headers. */
interface Seen {
	contexts: Record<(typeof CONTEXTS)[number], Identity>;
	requests: Record<string, Record<string, string | null> | undefined>;
}

/** A local site that echoes what every context and request says about the browser. */
function startIdentitySite() {
	const seen = new Map<string, Record<string, string | null>>();
	const report: Record<string, unknown> = {};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			seen.set(`${url.hostname}${url.pathname}`, Object.fromEntries(IDENTITY_HEADERS.map((name) => [name, request.headers.get(name)])));
			if (url.pathname === "/") {
				return new Response(IDENTITY_PAGE(`http://localhost:${url.port}/frame`), {
					headers: {
						"content-type": "text/html; charset=utf-8",
						"accept-ch": HINT_HEADERS.join(", "),
						"critical-ch": HINT_HEADERS.join(", "),
						"permissions-policy": HINT_HEADERS.map((name) => `${name.slice("sec-".length)}=*`).join(", "),
					},
				});
			}
			if (url.pathname === "/frame") return new Response(FRAME_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
			const script = SCRIPTS[url.pathname];
			if (script !== undefined) return new Response(script, { headers: { "content-type": "text/javascript" } });
			if (url.pathname === "/report") {
				Object.assign(report, await request.json());
				return new Response("ok");
			}
			return new Response("not found", { status: 404 });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/`,
		/** Once every context has reported: what each said of itself, and each request's identity headers. */
		async seen(): Promise<Seen> {
			await waitUntil("every context's report", () => report, (r) => ("service" in r || "error" in r) && ("frame" in r || "frameError" in r));
			expect({ error: report.error, frameError: report.frameError }).toEqual({ error: undefined, frameError: undefined });
			return {
				contexts: Object.fromEntries(CONTEXTS.map((name) => [name, report[name] as Identity])) as Seen["contexts"],
				requests: Object.fromEntries(REQUESTS.map((key) => [key, seen.get(key)])),
			};
		},
		stop: () => server.stop(true),
	};
}

/** What the binary reports of itself with nothing overridden: a plain headless launch of the same Chrome. */
async function binaryReport(): Promise<{ seen: Seen; version: string }> {
	const site = startIdentitySite();
	const reference = await puppeteer.launch({ executablePath: chromePath, headless: true });
	try {
		await (await reference.newPage()).goto(site.url);
		return { seen: await site.seen(), version: (await reference.version()).split("/")[1] };
	} finally {
		await reference.close();
		site.stop();
	}
}

/** One DevTools call on a browser endpoint, over a connection of its own that attaches to nothing. */
async function devtools<T>(endpoint: string, method: string): Promise<T> {
	const socket = new WebSocket(endpoint);
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	socket.onopen = () => socket.send(JSON.stringify({ id: 1, method }));
	socket.onmessage = (event) => {
		const message = JSON.parse(String(event.data));
		if (message.id === 1) message.error ? reject(new Error(message.error.message)) : resolve(message.result);
	};
	socket.onerror = () => reject(new Error(`DevTools ${method} failed`));
	try {
		return await promise;
	} finally {
		socket.close();
	}
}

/** What survives in a service worker once the View lets go of it; see `comparable`. */
const SERVICE_WORKER_HINTS = ["brands", "mobile", "platform"];

/**
 * A context's identity as far as the View replays it. The View detaches from
 * a service worker once it is released (attached, it would never be stopped
 * when idle), and the override goes with the session: the worker keeps the
 * headful User-Agent (`--user-agent`) and its low-entropy hints, but its own
 * `getHighEntropyValues` answers empty. That trade-off is in the README.
 */
const comparable = (name: (typeof CONTEXTS)[number], identity: Identity | undefined) =>
	name === "service" && identity ? { ua: identity.ua, hints: Object.fromEntries(SERVICE_WORKER_HINTS.map((hint) => [hint, identity.hints[hint]])) } : identity;

describeWithChrome("launch", () => {
	test(
		"the headless View presents the binary's own headful identity: UA and client hints, in the page, an out-of-process frame and every kind of worker",
		async () => {
			const binary = await binaryReport();
			const headful = (ua: string | null | undefined) => ua?.replace("HeadlessChrome/", "Chrome/");

			// The binary's own high-entropy hints are real (non-empty) and name its full version.
			const own = binary.seen.contexts.page.hints;
			expect(own.fullVersionList).toContainEqual({ brand: "Chromium", version: binary.version });
			expect(own.uaFullVersion).toBe(binary.version);
			for (const hint of ["platformVersion", "architecture", "bitness"] as const) expect({ hint, empty: !own[hint] }).toEqual({ hint, empty: false });
			const top = binary.seen.requests["127.0.0.1/"];
			for (const header of ["sec-ch-ua", ...HINT_HEADERS]) expect({ header, empty: !top?.[header] || top[header] === '""' }).toEqual({ header, empty: false });

			const site = startIdentitySite();
			try {
				const { runtime } = await createRuntime();
				const opened = await runtime.open({ profile: "ua", viewport: { width: 640, height: 480 } });
				// The fixture passes Chrome's path explicitly, so the app is `custom`.
				expect(opened.app).toBe("custom");
				await perform(runtime, opened.browserId, { kind: "navigate", url: site.url });
				const view = await site.seen();

				// Every context and every request sees exactly what the binary reports,
				// with only the headless token taken out of the User-Agent.
				expect({
					contexts: Object.fromEntries(CONTEXTS.map((name) => [name, comparable(name, view.contexts[name])])),
					requests: view.requests,
				}).toEqual({
					contexts: Object.fromEntries(CONTEXTS.map((name) => [name, comparable(name, { ...binary.seen.contexts[name], ua: headful(binary.seen.contexts[name].ua) ?? "" })])),
					requests: Object.fromEntries(REQUESTS.map((key) => [key, { ...binary.seen.requests[key], "user-agent": headful(binary.seen.requests[key]?.["user-agent"]) ?? null }])),
				});
				expect(JSON.stringify(view)).not.toMatch(/Headless/i);

				const { byId } = runtime as unknown as { byId: Map<string, { driver: { cdpEndpoint(): string } }> };
				const endpoint = byId.get(opened.browserId)?.driver.cdpEndpoint() ?? "";
				// The cross-site frame really is out of process: its own target in the View.
				const targets = (await devtools<Protocol.Target.GetTargetsResponse>(endpoint, "Target.getTargets")).targetInfos;
				expect(targets.filter((target) => target.type === "iframe").map((target) => new URL(target.url).hostname)).toContain("localhost");
			} finally {
				site.stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a service worker the View registers is left unattached once it carries the identity, so Chrome can stop it when idle",
		async () => {
			const site = startIdentitySite();
			try {
				const { runtime } = await createRuntime();
				const opened = await runtime.open({ profile: "sw", viewport: { width: 640, height: 480 } });
				await perform(runtime, opened.browserId, { kind: "navigate", url: site.url });
				const view = await site.seen();
				// The worker ran with the replayed identity before it was let go.
				expect(view.contexts.service.ua).toBe(view.contexts.page.ua);
				expect(view.contexts.service.ua).not.toMatch(/Headless/i);

				// `attached` counts every DevTools client, and `devtools` attaches to
				// nothing and puppeteer detaches from service workers itself, so this
				// is the View's own identity session letting go.
				const { byId } = runtime as unknown as { byId: Map<string, { driver: { cdpEndpoint(): string } }> };
				const endpoint = byId.get(opened.browserId)?.driver.cdpEndpoint() ?? "";
				const targets = async () => (await devtools<Protocol.Target.GetTargetsResponse>(endpoint, "Target.getTargets")).targetInfos;
				await waitUntil("the service worker, running and detached", targets, (infos) => {
					const workers = infos.filter((target) => target.type === "service_worker");
					return workers.length > 0 && workers.every((target) => !target.attached);
				});
			} finally {
				site.stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
