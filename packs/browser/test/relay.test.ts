/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: chrome-relay stops respecting
 *  that it is the HUMAN's own Chrome. Either a task agent is let loose on it
 *  (and takes over the tab the human was using), or the relay adopts a tab the
 *  human opened by hand and starts driving it, or closing the relay browser
 *  closes the human's tabs or the human's Chrome. These tests launch a separate
 *  real Chrome with a remote-debugging port — standing in for the human's —
 *  and attach to it exactly as the relay engine does.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import puppeteer, { type Browser } from "puppeteer-core";
import type { BrowserState } from "../src/contracts";
import type { BrowserRuntime } from "../src/runtime";
import {
	BROWSER_TEST_TIMEOUT_MS,
	chromePath,
	createRoot,
	describeWithChrome,
	failureCode,
	newRuntime,
	perform,
	startFixture,
	submissionLanded,
	teardown,
	waitUntil,
	within,
} from "./fixture";

const VIEWPORT = { width: 640, height: 480 };
const FAKE_WORKER = fileURLToPath(new URL("./fake-worker/", import.meta.url));
const PYTHON_DIR = fileURLToPath(new URL("../python/", import.meta.url));
const PYTHON = join(PYTHON_DIR, ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));

// ---------------------------------------------------------------------------
// The human's Chrome: launched here, never by the runtime under test
// ---------------------------------------------------------------------------

interface TargetInfo {
	id: string;
	type: string;
	url: string;
	title: string;
}

interface UserChrome {
	/** The endpoint the relay engine attaches to. */
	relayUrl: string;
	/**
	 * Open a tab by hand — a separate CDP connection, so it has no opener — and
	 * wait for it to load. In the background unless `foreground`: in front, it
	 * hides our tab, which is its own contract (see the hidden-tab test).
	 */
	openByHand(url: string, title: string, foreground?: boolean): Promise<string>;
	/** Every page Chrome itself reports, from its HTTP endpoint (no event lag). */
	pages(): Promise<TargetInfo[]>;
	running(): boolean;
}

const chromes: Array<{ stop(): Promise<void> }> = [];

/** Start a headless Chrome on a fresh profile with one tab already at `userUrl`. */
async function launchUserChrome(userUrl: string, userTitle: string): Promise<UserChrome> {
	if (chromePath === undefined) throw new Error("no Chrome");
	const dataDir = await mkdtemp(join(tmpdir(), "dimension-browser-relay-"));
	const proc = Bun.spawn(
		[
			chromePath,
			"--headless=new",
			"--remote-debugging-port=0",
			`--user-data-dir=${dataDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			userUrl,
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	let human: Browser | undefined;
	chromes.push({
		stop: async () => {
			if (human) await human.close().catch(() => undefined);
			if (proc.exitCode === null) proc.kill();
			await proc.exited;
			await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
		},
	});

	// Chrome writes the port it actually bound to here: port 0 never collides.
	// The file is "<port>\n<browser ws path>"; until both lines are there (or
	// while Windows still holds it open for writing) it is not ready.
	const portFile = join(dataDir, "DevToolsActivePort");
	const readPort = (): number => {
		try {
			const [port, path] = readFileSync(portFile, "utf8").split("\n");
			return path?.startsWith("/devtools/browser/") ? Number(port) : 0;
		} catch {
			return 0;
		}
	};
	const port = await waitUntil(
		"Chrome to publish its DevTools port",
		readPort,
		(value) => value > 0,
	);
	const relayUrl = `http://127.0.0.1:${port}`;
	human = await puppeteer.connect({ browserURL: relayUrl, defaultViewport: null });
	const pages = async (): Promise<TargetInfo[]> => {
		const list = (await (await fetch(`${relayUrl}/json/list`)).json()) as TargetInfo[];
		return list.filter((target) => target.type === "page");
	};
	await waitUntil(
		"the USER tab to finish loading",
		pages,
		(list) => list.some((target) => target.url === userUrl && target.title === userTitle),
	);
	const hands = await human.target().createCDPSession();
	const openByHand = async (url: string, title: string, foreground = false): Promise<string> => {
		const { targetId } = await hands.send("Target.createTarget", { url, background: !foreground });
		await waitUntil(
			"the hand-opened tab to finish loading",
			pages,
			(list) => list.some((target) => target.id === targetId && target.title === title),
		);
		return targetId;
	};
	return { relayUrl, openByHand, pages, running: () => proc.exitCode === null };
}

const ENV_KEYS = ["DIM_BROWSER_PYTHON", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

// Were the relay guard ever lost, the task must be able to really run — so the
// refusal, not a missing interpreter, is what these tests observe.
beforeAll(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	process.env.DIM_BROWSER_PYTHON = PYTHON;
	process.env.PYTHONPATH = FAKE_WORKER;
	process.env.PYTHONDONTWRITEBYTECODE = "1";
});

afterAll(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

afterEach(async () => {
	// The runtime detaches first; only then does the human's Chrome go away.
	await teardown();
	for (const chrome of chromes.splice(0)) await chrome.stop();
}, BROWSER_TEST_TIMEOUT_MS);

async function openRelay(relayUrl: string): Promise<{ runtime: BrowserRuntime; browserId: string }> {
	const runtime = newRuntime(await createRoot(), { relayUrl });
	// No profile, the way an agent calls it: the relay is always the reserved "relay" profile, never a throwaway browser.
	const { browserId } = await runtime.open({ engine: "chrome-relay", viewport: VIEWPORT });
	expect((await runtime.state(browserId)).profile).toBe("relay");
	return { runtime, browserId };
}

describeWithChrome("chrome-relay", () => {
	test(
		"a task is refused on the relay before any worker starts, and the USER tab is untouched",
		async () => {
			const fixture = startFixture();
			const userUrl = fixture.url("/signup");
			const chrome = await launchUserChrome(userUrl, "signup");
			const [userTab] = (await chrome.pages()).filter((target) => target.url === userUrl);
			const { runtime, browserId } = await openRelay(chrome.relayUrl);

			// A script that would complete, and leave a trace in the server, if it ran.
			const script = JSON.stringify({
				openTab: fixture.url("/worker-ran"),
				steps: [{ action: "take over", url: userUrl }],
				result: { status: "done", summary: "ran on the relay", steps: 1 },
			});
			for (const agent of ["jev", "browser-use"] as const) {
				expect(await failureCode(() => runtime.runTask(browserId, { agent, task: script }))).toBe("task_unsupported_engine");
			}

			expect((await runtime.state(browserId)).task).toBeNull();
			expect(fixture.hits("/worker-ran")).toBe(0);
			const after = (await chrome.pages()).find((target) => target.id === userTab?.id);
			expect(after).toMatchObject({ url: userUrl, title: "signup" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a tab the human opens is never adopted or activated; a target=_blank from our tab is",
		async () => {
			const fixture = startFixture();
			const userUrl = fixture.url("/signup");
			const humanUrl = fixture.url("/");
			const chrome = await launchUserChrome(userUrl, "signup");
			const { runtime, browserId } = await openRelay(chrome.relayUrl);
			const seen: BrowserState[] = [];
			const observe = async (): Promise<BrowserState> => {
				const state = await runtime.state(browserId);
				seen.push(state);
				return state;
			};

			// The human opens a tab by hand in their Chrome while ours is open: no opener.
			const handOpened = await chrome.openByHand(humanUrl, "fixture form");

			// Only after that does our tab open a popup, so the hand-opened tab's
			// creation event is already behind us when the popup is seen.
			const opener = await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/opener") });
			await perform(runtime, browserId, { kind: "click", selector: "#blank" });
			const shown = await waitUntil(
				"the tab our page opened to become active",
				observe,
				(state) => state.url === fixture.url("/page2"),
			);

			expect(shown.activeTabId).not.toBe(opener.activeTabId);
			expect(shown.tabs.map((tab) => tab.url)).toEqual([fixture.url("/opener"), fixture.url("/page2")]);
			const final = await observe();
			expect(final.tabs.map((tab) => tab.url)).toEqual([fixture.url("/opener"), fixture.url("/page2")]);
			for (const state of seen) {
				expect(state.url).not.toBe(humanUrl);
				expect(state.url).not.toBe(userUrl);
			}
			// Still exactly where the human left it.
			expect((await chrome.pages()).find((target) => target.id === handOpened)).toMatchObject({ url: humanUrl, title: "fixture form" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"closing the relay browser closes only our tabs; the human's tabs and Chrome live on",
		async () => {
			const fixture = startFixture();
			const userUrl = fixture.url("/signup");
			const humanUrl = fixture.url("/");
			const chrome = await launchUserChrome(userUrl, "signup");
			const { runtime, browserId } = await openRelay(chrome.relayUrl);
			await chrome.openByHand(humanUrl, "fixture form");
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/opener") });
			await perform(runtime, browserId, { kind: "click", selector: "#blank" });
			await waitUntil(
				"the tab our page opened to be adopted",
				() => runtime.state(browserId),
				(state) => state.tabs.length === 2 && state.url === fixture.url("/page2"),
			);

			await runtime.close(browserId);

			const left = await chrome.pages();
			expect(left.map((target) => target.url).sort()).toEqual([humanUrl, userUrl].sort());
			expect(left.find((target) => target.url === userUrl)?.title).toBe("signup");
			expect(chrome.running()).toBe(true);
			expect((await fetch(`${chrome.relayUrl}/json/version`)).ok).toBe(true);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"with the human's tab in front, a selector click on our hidden tab still completes and takes effect",
		async () => {
			const fixture = startFixture();
			const chrome = await launchUserChrome(fixture.url("/signup"), "signup");
			const { runtime, browserId } = await openRelay(chrome.relayUrl);
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/") });
			await perform(runtime, browserId, { kind: "type", selector: "#user", text: "ada" });

			// The human switches to a tab of their own: ours is now behind it.
			await chrome.openByHand(fixture.url("/page2"), "second page", true);

			// A click that waits on rendering never returns from a hidden tab; well
			// under the action bound, so a regression names itself instead of hanging.
			await within(10_000, "a click on the hidden relay tab", perform(runtime, browserId, { kind: "click", selector: "#go" }));
			await submissionLanded(runtime, browserId, fixture);
			expect(fixture.submissions()).toEqual([{ user: "ada", pass: "" }]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the person leaving their own Chrome in the View for another profile does not close the tabs they were working in: the relay stays attached and listed, and only an explicit close ends it",
		async () => {
			const fixture = startFixture();
			const userUrl = fixture.url("/signup");
			const chrome = await launchUserChrome(userUrl, "signup");
			const runtime = newRuntime(await createRoot(), { relayUrl: chrome.relayUrl });
			const view = { caller: "app", session: "s-view" } as const;
			const { browserId } = await runtime.open({ engine: "chrome-relay", viewport: VIEWPORT }, view);
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/page2") });

			expect(await runtime.leave(browserId, "app")).toEqual({ closed: false });

			expect((await runtime.state(browserId)).url).toBe(fixture.url("/page2"));
			expect(await runtime.openBrowsers("s-view")).toMatchObject([{ browserId, kind: "chrome", hold: { by: "person" } }]);
			await runtime.close(browserId, "app");
			expect(await runtime.openBrowsers("s-view")).toEqual([]);
			expect(chrome.running()).toBe(true);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
