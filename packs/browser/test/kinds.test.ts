/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a cell's `browser.open({ app })` drives the wrong browser or none. OMP's kinds are how the
 *  model reaches a Chrome it did not start (the human's own with a debugging port, an application it spawns, the relay) and the choice between
 *  them is OMP's fixed order: a standing setting must never beat what the cell asked for, a saved profile must always stay a Chromium the pack
 *  launches, and a machine without cmux must never be sent to a cmux socket. Past the choice, what must hold is that a kind attaches to what it
 *  names, never ends a browser it did not start, refuses an application that cannot be launched safely (a second launch on a profile in use
 *  only hands over to the first), reports the real reason when the application dies before its port opens, and that discovery finds a Chrome
 *  through puppeteer's own standard variable. The real-Chrome groups start a headless Chrome of their own and end it by pid.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connectAttached } from "../src/engines/attach";
import { KIND_TIMINGS, waitForCdp } from "../src/code/kinds/cdp";
import { establishKind, normalizeConnectedCdpUrl } from "../src/code/kinds/establish";
import { describeBrowser, describeKind, type KindEnv, resolveKind, sameBrowserKind } from "../src/code/kinds/resolve";
import {
	establishSpawned,
	findCdpPortInArgs,
	findUserDataDirInArgs,
	type ProcessScanner,
	splitWindowsCommandLine,
	type Spawner,
} from "../src/code/kinds/spawned";
import { type BrowserProbe, resolveBrowser } from "../src/engines/launch";
import { environmentLaunchArgs } from "../src/engines/launch-env";
import { BROWSER_TEST_TIMEOUT_MS, describeWithChrome, chromePath } from "./fixture";
import { alive, gone, killTree, startDebugChrome, startPageServer, stopDebugChromes } from "./kinds-fixture";

afterEach(stopDebugChromes, BROWSER_TEST_TIMEOUT_MS);

const CWD = process.platform === "win32" ? "C:\\work" : "/work";
const ABS_EXE = process.platform === "win32" ? "C:\\Apps\\Foo\\foo.exe" : "/opt/foo/foo";

// ---------------------------------------------------------------------------
// Which kind: OMP's browser.ts:103-142, with the environment where OMP read its settings
// ---------------------------------------------------------------------------

describe("resolveKind: OMP's order of choice", () => {
	// Every row is read off OMP's resolveBrowserKind (browser.ts:103-142), setting by setting. The settings are the pack's variables:
	// browser.relay = DIMENSION_BROWSER_RELAY (also OMP's kill switch), browser.relayUrl = _RELAY_URL, browser.cdpUrl = _CDP_URL, browser.cmux = _CMUX.
	type Row = [name: string, request: Parameters<typeof resolveKind>[0], env: KindEnv, expected: ReturnType<typeof resolveKind>];
	const rows: Row[] = [
		["nothing asked: a hidden headless browser", {}, {}, { kind: "headless", headless: true }],
		["DIMENSION_BROWSER_HEADLESS=false: a visible one", {}, { DIMENSION_BROWSER_HEADLESS: "false" }, { kind: "headless", headless: false }],
		["app.cdp_url: connected, trailing slashes dropped", { app: { cdp_url: "http://127.0.0.1:9222///" } }, {}, { kind: "connected", cdpUrl: "http://127.0.0.1:9222" }],
		["app.path: spawned, with its args", { app: { path: ABS_EXE, args: ["--x"] } }, {}, { kind: "spawned", path: ABS_EXE, args: ["--x"] }],
		["app.path wins over the relay setting", { app: { path: ABS_EXE } }, { DIMENSION_BROWSER_RELAY: "1" }, { kind: "spawned", path: ABS_EXE }],
		["app.cdp_url wins over the standing cdp url and the relay", { app: { cdp_url: "http://a:1" } }, { DIMENSION_BROWSER_CDP_URL: "http://b:2", DIMENSION_BROWSER_RELAY: "1" }, { kind: "connected", cdpUrl: "http://a:1" }],
		["app.relay: the relay at its default endpoint", { app: { relay: true } }, {}, { kind: "relay", cdpUrl: "http://127.0.0.1:9224" }],
		["app.relay: at the configured endpoint, slashes dropped", { app: { relay: true } }, { DIMENSION_BROWSER_RELAY_URL: "http://127.0.0.1:9333/" }, { kind: "relay", cdpUrl: "http://127.0.0.1:9333" }],
		["a blank relay url is the default one", { app: { relay: true } }, { DIMENSION_BROWSER_RELAY_URL: "   " }, { kind: "relay", cdpUrl: "http://127.0.0.1:9224" }],
		["the relay setting alone selects the relay", {}, { DIMENSION_BROWSER_RELAY: "1" }, { kind: "relay", cdpUrl: "http://127.0.0.1:9224" }],
		["app.relay: false beats the relay setting", { app: { relay: false } }, { DIMENSION_BROWSER_RELAY: "1" }, { kind: "headless", headless: true }],
		["app.relay: false still lets a standing cdp url through", { app: { relay: false } }, { DIMENSION_BROWSER_RELAY: "1", DIMENSION_BROWSER_CDP_URL: "http://127.0.0.1:9222" }, { kind: "connected", cdpUrl: "http://127.0.0.1:9222" }],
		["the relay setting comes before the standing cdp url", {}, { DIMENSION_BROWSER_RELAY: "1", DIMENSION_BROWSER_CDP_URL: "http://127.0.0.1:9222" }, { kind: "relay", cdpUrl: "http://127.0.0.1:9224" }],
		["a standing cdp url is connected, trimmed", {}, { DIMENSION_BROWSER_CDP_URL: "  http://127.0.0.1:9222/ " }, { kind: "connected", cdpUrl: "http://127.0.0.1:9222" }],
		["cmux: its socket in the environment selects it", {}, { CMUX_SOCKET_PATH: "/tmp/cmux.sock", CMUX_SOCKET_PASSWORD: "pw" }, { kind: "cmux", socketPath: "/tmp/cmux.sock", password: "pw" }],
		["cmux comes after the standing cdp url", {}, { CMUX_SOCKET_PATH: "/tmp/cmux.sock", DIMENSION_BROWSER_CDP_URL: "http://127.0.0.1:9222" }, { kind: "connected", cdpUrl: "http://127.0.0.1:9222" }],
		["cmux comes after the relay", {}, { CMUX_SOCKET_PATH: "/tmp/cmux.sock", DIMENSION_BROWSER_RELAY: "1" }, { kind: "relay", cdpUrl: "http://127.0.0.1:9224" }],
		["DIMENSION_BROWSER_CMUX=0 turns cmux off", {}, { CMUX_SOCKET_PATH: "/tmp/cmux.sock", DIMENSION_BROWSER_CMUX: "0" }, { kind: "headless", headless: true }],
		["without a cmux socket the cmux flag alone selects nothing", {}, { DIMENSION_BROWSER_CMUX: "1" }, { kind: "headless", headless: true }],
		["a saved profile is a Chromium the pack launches, whatever app says", { profile: "work", app: { cdp_url: "http://127.0.0.1:9222" } }, { DIMENSION_BROWSER_RELAY: "1" }, { kind: "headless", headless: true }],
	];
	for (const [name, request, env, expected] of rows) {
		test(name, () => {
			expect(resolveKind(request, env, CWD)).toEqual(expected);
		});
	}

	test("a path is made absolute against the session's folder, and ~ is the home folder", () => {
		expect(resolveKind({ app: { path: "bin/app" } }, {}, CWD)).toEqual({ kind: "spawned", path: resolve(CWD, "bin/app") });
		expect(resolveKind({ app: { path: "~/apps/app" } }, {}, CWD)).toEqual({ kind: "spawned", path: resolve(homedir(), "apps/app") });
	});

	test("an explicit app.relay while the relay is switched off is refused, not turned into another browser (DIMENSION_BROWSER_RELAY=0)", () => {
		// The one place the pack departs from OMP's order (matrix H3): OMP falls through to headless, so a model that asked for the person's own Chrome
		// would be typing into a throwaway without being told. The kill switch stays final, and the model hears it.
		expect(() => resolveKind({ app: { relay: true } }, { DIMENSION_BROWSER_RELAY: "0" }, CWD)).toThrow(/switched off/);
		expect(resolveKind({}, { DIMENSION_BROWSER_RELAY: "0" }, CWD)).toEqual({ kind: "headless", headless: true });
	});

	test("the words a cell is told match OMP's, and two requests for one tab name are the same browser only when they name the same endpoint", () => {
		expect(describeBrowser({ kind: "headless", headless: true })).toBe("headless browser (hidden)");
		expect(describeBrowser({ kind: "headless", headless: false })).toBe("headless browser (visible)");
		expect(describeBrowser({ kind: "spawned", path: ABS_EXE }, { pid: 4242 })).toBe(`spawned ${ABS_EXE} (pid 4242)`);
		expect(describeBrowser({ kind: "connected", cdpUrl: "http://127.0.0.1:9222" })).toBe("connected http://127.0.0.1:9222");
		expect(describeBrowser({ kind: "relay", cdpUrl: "http://127.0.0.1:9224" })).toBe("relay http://127.0.0.1:9224");
		expect(describeBrowser({ kind: "cmux", socketPath: "/s" })).toBe("cmux browser (split)");
		expect(describeKind({ kind: "relay", cdpUrl: "http://127.0.0.1:9224" })).toBe("relay:http://127.0.0.1:9224");
		expect(sameBrowserKind({ kind: "connected", cdpUrl: "http://a:1" }, { kind: "connected", cdpUrl: "http://a:1" })).toBe(true);
		expect(sameBrowserKind({ kind: "connected", cdpUrl: "http://a:1" }, { kind: "connected", cdpUrl: "http://a:2" })).toBe(false);
		expect(sameBrowserKind({ kind: "relay", cdpUrl: "http://a:1" }, { kind: "connected", cdpUrl: "http://a:1" })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Finding a Chrome, and what the environment adds to its command line
// ---------------------------------------------------------------------------

function probe(platform: NodeJS.Platform, existing: string[], env: Record<string, string | undefined> = {}, home = "/home/u"): BrowserProbe {
	// Paths are compared with forward slashes: `join` writes backslashes on Windows, and these tests describe a Linux machine.
	return { platform, browserPlatform: undefined, env, home, exists: (path) => existing.includes(path.replaceAll("\\", "/")) };
}

describe("executable discovery", () => {
	test("PUPPETEER_EXECUTABLE_PATH is used when DIMENSION_BROWSER_EXECUTABLE is unset, and reported as a custom binary", async () => {
		const found = await resolveBrowser(undefined, probe("linux", ["/usr/bin/google-chrome"], { PUPPETEER_EXECUTABLE_PATH: "/opt/mine/chrome" }));
		expect(found).toEqual({ app: "custom", executablePath: "/opt/mine/chrome" });
	});

	test("the configured binary beats PUPPETEER_EXECUTABLE_PATH, and an empty variable is not a path", async () => {
		expect(await resolveBrowser("/explicit/chrome", probe("linux", [], { PUPPETEER_EXECUTABLE_PATH: "/opt/mine/chrome" }))).toEqual({ app: "custom", executablePath: "/explicit/chrome" });
		expect(await resolveBrowser(undefined, probe("linux", ["/usr/bin/google-chrome"], { PUPPETEER_EXECUTABLE_PATH: "" }))).toEqual({ app: "chrome", executablePath: "/usr/bin/google-chrome" });
	});

	test("Linux finds the Chromiums distributions package in unusual places: flatpak, NixOS and ungoogled", async () => {
		const home = "/home/u";
		for (const path of [
			"/snap/bin/chromium",
			"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
			"/home/u/.local/share/flatpak/exports/bin/org.chromium.Chromium",
			"/home/u/.nix-profile/bin/chromium",
			"/run/current-system/sw/bin/chromium",
			"/usr/bin/ungoogled-chromium",
			"/var/lib/flatpak/exports/bin/io.github.ungoogled_software.ungoogled_chromium",
		]) {
			const found = await resolveBrowser(undefined, probe("linux", [path], {}, home));
			expect({ app: found.app, executablePath: found.executablePath.replaceAll("\\", "/") }).toEqual({ app: "chromium", executablePath: path });
		}
		const chrome = await resolveBrowser(undefined, probe("linux", ["/var/lib/flatpak/exports/bin/com.google.Chrome"], {}, home));
		expect({ app: chrome.app, executablePath: chrome.executablePath.replaceAll("\\", "/") }).toEqual({ app: "chrome", executablePath: "/var/lib/flatpak/exports/bin/com.google.Chrome" });
	});

	test("the order stays the pack's: Chrome before Edge before a Chromium", async () => {
		const everything = ["/usr/bin/chromium", "/usr/bin/microsoft-edge", "/usr/bin/google-chrome"];
		expect((await resolveBrowser(undefined, probe("linux", everything))).app).toBe("chrome");
		expect((await resolveBrowser(undefined, probe("linux", everything.slice(0, 2)))).app).toBe("msedge");
	});
});

describe("what the environment adds to a launch", () => {
	test("nothing, unless asked", () => {
		expect(environmentLaunchArgs({}, { platform: "win32", uid: undefined })).toEqual([]);
		expect(environmentLaunchArgs({}, { platform: "darwin", uid: 501 })).toEqual([]);
	});

	test("the sandbox is switched off only for a Linux root user, who cannot start Chrome with it", () => {
		expect(environmentLaunchArgs({}, { platform: "linux", uid: 0 })).toEqual(["--no-sandbox", "--disable-setuid-sandbox"]);
		expect(environmentLaunchArgs({}, { platform: "linux", uid: 1000 })).toEqual([]);
		expect(environmentLaunchArgs({}, { platform: "win32", uid: 0 })).toEqual([]);
	});

	test("PUPPETEER_PROXY routes the browser through it, and localhost only on request", () => {
		expect(environmentLaunchArgs({ PUPPETEER_PROXY: "http://127.0.0.1:9" }, { platform: "win32" })).toEqual(["--proxy-server=http://127.0.0.1:9"]);
		expect(environmentLaunchArgs({ PUPPETEER_PROXY: "http://p:1", PUPPETEER_PROXY_BYPASS_LOOPBACK: "TRUE" }, { platform: "win32" })).toEqual(["--proxy-server=http://p:1", "--proxy-bypass-list=<-loopback>"]);
		// The loopback switch means nothing without a proxy to send it to.
		expect(environmentLaunchArgs({ PUPPETEER_PROXY_BYPASS_LOOPBACK: "1" }, { platform: "win32" })).toEqual([]);
		expect(environmentLaunchArgs({ PUPPETEER_PROXY: "http://p:1", PUPPETEER_PROXY_BYPASS_LOOPBACK: "0" }, { platform: "win32" })).toEqual(["--proxy-server=http://p:1"]);
	});

	test("certificate errors are ignored only when the variable says so, in any of OMP's four spellings", () => {
		for (const on of ["true", "1", "yes", "on", "YES"]) {
			expect(environmentLaunchArgs({ PUPPETEER_PROXY_IGNORE_CERT_ERRORS: on }, { platform: "win32" })).toEqual(["--ignore-certificate-errors"]);
		}
		for (const off of ["", "0", "false", "no", "off"]) {
			expect(environmentLaunchArgs({ PUPPETEER_PROXY_IGNORE_CERT_ERRORS: off }, { platform: "win32" })).toEqual([]);
		}
	});
});

// ---------------------------------------------------------------------------
// Spawned: the decisions, on a fake process table
// ---------------------------------------------------------------------------

function scanner(processes: Array<{ pid: number; args: string[] }>, unreadable = false): ProcessScanner {
	return { running: async () => ({ processes, unreadable }) };
}

/** Starts a real process that is alive and never opens a port (a stand-in for an application that hangs), remembering its pid so the test can end it. */
function sleepers(): { spawner: Spawner; pids: number[] } {
	const pids: number[] = [];
	const spawner: Spawner = () => {
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
		if (child.pid !== undefined) pids.push(child.pid);
		const exited = Promise.withResolvers<number | null>();
		child.once("exit", (code) => exited.resolve(code));
		return { pid: child.pid, exited: exited.promise };
	};
	return { spawner, pids };
}

const NO_SPAWN = (): never => {
	throw new Error("nothing should have been started");
};

/** A server that answers like a DevTools endpoint: what a running instance's debugging port looks like to the probe. */
async function fakeDevtools(): Promise<{ port: number; stop(): Promise<void> }> {
	const server = createServer((request, response) => {
		response.statusCode = request.url === "/json/version" ? 200 : 404;
		response.end(JSON.stringify({ Browser: "Fake/1" }));
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	return {
		port: (server.address() as AddressInfo).port,
		stop() {
			const closed = Promise.withResolvers<void>();
			server.closeAllConnections();
			server.close(() => closed.resolve());
			return closed.promise;
		},
	};
}

describe("spawned: whether an application may be launched", () => {
	test("an instance that is running with a debugging port is attached to, not launched a second time", async () => {
		const live = await fakeDevtools();
		try {
			const app = await establishSpawned({ path: ABS_EXE }, { scanner: scanner([{ pid: 4242, args: ["--remote-debugging-port", String(live.port)] }]), spawner: NO_SPAWN });
			expect(app).toMatchObject({ cdpUrl: `http://127.0.0.1:${live.port}`, pid: 4242, reused: true });
		} finally {
			await live.stop();
		}
	});

	test("a debugging port nothing answers on is not reused: the instance is treated as having none", async () => {
		const dead = await fakeDevtools();
		await dead.stop();
		await expect(establishSpawned({ path: ABS_EXE }, { scanner: scanner([{ pid: 7, args: [`--remote-debugging-port=${dead.port}`] }]), spawner: NO_SPAWN })).rejects.toThrow(
			/already running without a reusable CDP endpoint/,
		);
	});

	test("an instance running without a debugging port refuses the launch, naming what to do", async () => {
		const name = ABS_EXE.split(/[\\/]/).pop();
		await expect(establishSpawned({ path: ABS_EXE }, { scanner: scanner([{ pid: 7, args: [] }]), spawner: NO_SPAWN })).rejects.toThrow(
			`Cannot launch ${name} because it is already running without a reusable CDP endpoint. Close ${name}, relaunch it with --remote-debugging-port, or pass app.cdp_url for an existing endpoint.`,
		);
	});

	test("a profile of its own makes a second launch safe; the profile the running one uses does not", async () => {
		const mine = join(tmpdir(), "kinds-profile-a");
		const theirs = join(tmpdir(), "kinds-profile-b");
		const started: string[][] = [];
		const sleeping = sleepers();
		const spawner: Spawner = (exe, args) => {
			started.push(args);
			return sleeping.spawner(exe, args);
		};
		const running = scanner([{ pid: 7, args: [`--user-data-dir=${theirs}`] }]);
		await expect(establishSpawned({ path: ABS_EXE, args: [`--user-data-dir=${theirs}`] }, { scanner: running, spawner })).rejects.toThrow(/already running/);
		expect(started).toEqual([]);
		// The same application with a profile no running instance uses is launched (it fails here only because the stand-in never opens a port).
		try {
			await expect(establishSpawned({ path: ABS_EXE, args: [`--user-data-dir=${mine}`] }, { scanner: running, spawner, waitMs: 200 })).rejects.toThrow(/Failed to attach to .* on http:\/\/127\.0\.0\.1:\d+: /);
		} finally {
			for (const pid of sleeping.pids) await killTree(pid);
		}
		expect(started).toHaveLength(1);
		expect(started[0]).toContain(`--user-data-dir=${mine}`);
		expect(started[0]!.some((arg) => /^--remote-debugging-port=\d+$/.test(arg))).toBe(true);
	});

	test("a command line that could not be read is not assumed safe: the launch is refused even with a profile of its own", async () => {
		await expect(establishSpawned({ path: ABS_EXE, args: [`--user-data-dir=${join(tmpdir(), "kinds-profile-c")}`] }, { scanner: scanner([{ pid: 7, args: [] }], true), spawner: NO_SPAWN })).rejects.toThrow(/already running/);
	});

	test("a relative path is refused with OMP's text", async () => {
		await expect(establishSpawned({ path: "Foo.app/Contents/MacOS/Foo" }, { scanner: scanner([]), spawner: NO_SPAWN })).rejects.toThrow(
			'app.path must be absolute (got "Foo.app/Contents/MacOS/Foo"). Pass the binary inside Foo.app/Contents/MacOS/, not the .app bundle.',
		);
	});

	test("an application that exits before its port opens fails the open at once with the real reason, not after the 30 s wait", async () => {
		const started = Date.now();
		await expect(establishSpawned({ path: process.execPath, args: ["-e", "process.exit(3)"] }, { scanner: scanner([]), waitMs: 30_000 })).rejects.toThrow(
			/the process exited \(code 3\) before opening its CDP endpoint/,
		);
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	test("an application that never opens its port is ended when the wait runs out, and the error names the endpoint", async () => {
		const sleeping = sleepers();
		const started = Date.now();
		try {
			await expect(establishSpawned({ path: process.execPath }, { scanner: scanner([]), spawner: sleeping.spawner, waitMs: 700 })).rejects.toThrow(
				/Failed to attach to .* on http:\/\/127\.0\.0\.1:\d+: Timed out waiting for CDP endpoint http:\/\/127\.0\.0\.1:\d+/,
			);
			expect(Date.now() - started).toBeGreaterThanOrEqual(600);
			expect(sleeping.pids).toHaveLength(1);
			expect(await gone(sleeping.pids[0]!)).toBe(true);
		} finally {
			for (const pid of sleeping.pids) await killTree(pid);
		}
	});
});

describe("spawned: reading a command line", () => {
	test("the debugging port in either of Chromium's forms, and none in a malformed one", () => {
		expect(findCdpPortInArgs(["--a", "--remote-debugging-port=9222"])).toBe(9222);
		expect(findCdpPortInArgs(["--remote-debugging-port", "9333"])).toBe(9333);
		expect(findCdpPortInArgs(["--remote-debugging-port=0"])).toBeNull();
		expect(findCdpPortInArgs(["--remote-debugging-port=abc", "--remote-debugging-port"])).toBeNull();
		expect(findCdpPortInArgs([])).toBeNull();
	});

	test("the profile directory: the last one wins, and a value that is another flag is not one", () => {
		expect(findUserDataDirInArgs(["--user-data-dir=/a", "--user-data-dir", "/b"])).toBe("/b");
		expect(findUserDataDirInArgs(["--user-data-dir", "--headless"])).toBeNull();
		expect(findUserDataDirInArgs(["--user-data-dir="])).toBeNull();
		expect(findUserDataDirInArgs(undefined)).toBeNull();
	});

	test("a Windows command line splits as the system does: quotes group, a backslash before a quote escapes it", () => {
		expect(splitWindowsCommandLine('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 "--user-data-dir=C:\\My Profile\\x" --flag')).toEqual([
			"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
			"--remote-debugging-port=9222",
			"--user-data-dir=C:\\My Profile\\x",
			"--flag",
		]);
		expect(splitWindowsCommandLine('app.exe --user-data-dir="C:\\a b\\c" "say \\"hi\\""')).toEqual(["app.exe", "--user-data-dir=C:\\a b\\c", 'say "hi"']);
		expect(splitWindowsCommandLine('app.exe "C:\\dir with space\\\\" next')).toEqual(["app.exe", "C:\\dir with space\\", "next"]);
		expect(splitWindowsCommandLine("   ")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Connected and spawned, on a real Chrome
// ---------------------------------------------------------------------------

describe("connected: attaching to a Chrome the person started", () => {
	test("a websocket URL is refused with OMP's text, an HTTP one is accepted without its trailing slash", async () => {
		expect(() => normalizeConnectedCdpUrl("ws://127.0.0.1:9222/devtools/browser/abc")).toThrow(
			"browser app.cdp_url must be the HTTP CDP discovery endpoint (for example http://127.0.0.1:9222), not a ws:// browser websocket URL.",
		);
		expect(() => normalizeConnectedCdpUrl("WSS://x/y")).toThrow(/HTTP CDP discovery endpoint/);
		expect(normalizeConnectedCdpUrl("http://127.0.0.1:9222//")).toBe("http://127.0.0.1:9222");
		await expect(establishKind({ kind: "connected", cdpUrl: "ws://x" })).rejects.toThrow(/not a ws:\/\/ browser websocket URL/);
	});

	test("an endpoint that does not answer fails at the wait's bound, naming the endpoint", async () => {
		const dead = await fakeDevtools();
		await dead.stop();
		const started = Date.now();
		await expect(establishKind({ kind: "connected", cdpUrl: `http://127.0.0.1:${dead.port}` }, { timings: { ...KIND_TIMINGS, connectedMs: 400 } })).rejects.toThrow(
			`Timed out waiting for CDP endpoint http://127.0.0.1:${dead.port}`,
		);
		const took = Date.now() - started;
		expect(took).toBeGreaterThanOrEqual(350);
		expect(took).toBeLessThan(5_000);
	});

	test("an endpoint that answers but is not a browser fails the connection with the endpoint named", async () => {
		const fake = await fakeDevtools();
		try {
			const established = await establishKind({ kind: "connected", cdpUrl: `http://127.0.0.1:${fake.port}` });
			if (!("attach" in established)) throw new Error("expected an attach target");
			await expect(connectAttached(established.attach)).rejects.toThrow(`Connected to http://127.0.0.1:${fake.port} but puppeteer.connect failed: `);
			await expect(connectAttached({ ...established.attach, kind: "relay" })).rejects.toThrow(`could not attach to chrome-relay at http://127.0.0.1:${fake.port}`);
		} finally {
			await fake.stop();
		}
	});
});

describeWithChrome("a real Chrome with a debugging port", () => {
	test("connected: the page of the person's Chrome is reachable, and giving it up leaves their Chrome running", async () => {
		const pages = await startPageServer();
		const chrome = await startDebugChrome();
		try {
			const established = await establishKind({ kind: "connected", cdpUrl: `${chrome.cdpUrl}/` });
			if (!("attach" in established)) throw new Error("expected an attach target");
			expect(established.attach).toMatchObject({ kind: "connected", cdpUrl: chrome.cdpUrl, label: `connected ${chrome.cdpUrl}` });
			expect(established.attach.terminate).toBeUndefined();

			const browser = await connectAttached(established.attach);
			const [page] = await browser.pages();
			await page!.goto(pages.url("/one"));
			expect(await page!.title()).toBe("Page one");
			expect(await page!.evaluate("document.querySelector('#hero').textContent")).toBe("one");

			// Never killed: our link goes, the browser and its page stay.
			await browser.disconnect();
			expect(alive(chrome.pid)).toBe(true);
			const reconnected = await connectAttached(established.attach);
			expect((await reconnected.pages()).map((p) => p.url())).toContain(pages.url("/one"));
			await reconnected.disconnect();
		} finally {
			await chrome.stop();
			await pages.stop();
		}
	}, BROWSER_TEST_TIMEOUT_MS);

	test("spawned: the application is started with a debugging port, said to be spawned with its pid, left running on disconnect and ended by terminate", async () => {
		if (chromePath === undefined) throw new Error("no Chrome");
		const pages = await startPageServer();
		const userDataDir = await mkdtemp(join(tmpdir(), "dimension-kinds-spawned-"));
		let pid: number | undefined;
		try {
			const kind = { kind: "spawned" as const, path: chromePath, args: ["--headless=new", `--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"] };
			const established = await establishKind(kind);
			if (!("attach" in established)) throw new Error("expected an attach target");
			const target = established.attach;
			pid = target.pid;
			expect(target.kind).toBe("spawned");
			expect(target.label).toBe(`spawned ${chromePath} (pid ${target.pid})`);
			expect(typeof target.pid).toBe("number");
			expect(alive(target.pid!)).toBe(true);

			const browser = await connectAttached(target);
			const page = (await browser.pages())[0] ?? (await browser.newPage());
			await page.goto(pages.url("/two"));
			expect(await page.title()).toBe("Page two");
			await browser.disconnect();
			// Not ours to end when the cell is done: it stays open, as in OMP.
			expect(alive(target.pid!)).toBe(true);

			// A second open of the same application and profile finds the running instance and its port instead of launching another.
			const again = await establishKind(kind);
			if (!("attach" in again)) throw new Error("expected an attach target");
			expect(again.attach.cdpUrl).toBe(target.cdpUrl);
			expect(again.attach.pid).toBe(target.pid);

			await target.terminate!();
			expect(await gone(target.pid!)).toBe(true);
			await expect(waitForCdp(target.cdpUrl, 300)).rejects.toThrow(/Timed out waiting for CDP endpoint/);
		} finally {
			if (pid !== undefined) await killTree(pid);
			await pages.stop();
			await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
		}
	}, BROWSER_TEST_TIMEOUT_MS);
});
