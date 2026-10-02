/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a cell that attaches to the person's own Chrome damages it. The attach engine is the one place the pack
 *  touches a browser it does not own on the person's behalf: it must adopt the page the person is on (that is the point), leave that page exactly as it
 *  was (no resize, no raising, never closed), open nothing in their browser unasked, and on close let go without ending their Chrome or any page of it. The
 *  only thing it may end is an application the pack started itself, and only when asked (`kill`). A regression shows as a tab that vanishes, a window that
 *  changes size, or an application the person started that is gone after a cell is done. Each test attaches to a real headless Chrome started here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { KIND_TIMINGS } from "../src/code/kinds/cdp";
import { establishKind } from "../src/code/kinds/establish";
import { createEngineDriver } from "../src/engines";
import type { EngineDriver } from "../src/engines/types";
import { BROWSER_TEST_TIMEOUT_MS, chromePath, describeWithChrome, failureCode } from "./fixture";
import { alive, gone, killTree, startDebugChrome, startPageServer, stopDebugChromes } from "./kinds-fixture";

const drivers: EngineDriver[] = [];
afterEach(async () => {
	for (const driver of drivers.splice(0)) await driver.close().catch(() => undefined);
	await stopDebugChromes();
}, BROWSER_TEST_TIMEOUT_MS);

interface PageEntry {
	id: string;
	url: string;
	title: string;
	type: string;
}

async function pagesOf(cdpUrl: string): Promise<PageEntry[]> {
	return ((await (await fetch(`${cdpUrl}/json/list`)).json()) as PageEntry[]).filter((entry) => entry.type === "page");
}

/** The person's Chrome with two tabs on known pages, and a driver attached to it as a cell's `connected` kind would be. */
async function attachedToPersonsChrome(): Promise<{ driver: EngineDriver; chromeUrl: string; pid: number; pages: Awaited<ReturnType<typeof startPageServer>>; released: () => number }> {
	const pages = await startPageServer();
	const chrome = await startDebugChrome();
	// The person has two tabs open: the one Chrome started with, and one they opened by hand.
	const opener = await puppeteer.connect({ browserURL: chrome.cdpUrl, defaultViewport: null });
	const first = (await opener.pages())[0]!;
	await first.goto(pages.url("/one"));
	const second = await opener.newPage();
	await second.goto(pages.url("/two"));
	await opener.disconnect();
	const established = await establishKind({ kind: "connected", cdpUrl: chrome.cdpUrl }, { timings: KIND_TIMINGS });
	if (!("attach" in established)) throw new Error("expected an attach target");
	let released = 0;
	const driver = await createEngineDriver("chrome-relay", {
		profileDirectory: join(tmpdir(), "unused-by-attach"),
		viewport: { width: 640, height: 480 },
		attach: established.attach,
		onClosed: () => void (released += 1),
	});
	drivers.push(driver);
	return { driver, chromeUrl: chrome.cdpUrl, pid: chrome.pid, pages, released: () => released };
}

describeWithChrome("the attach engine on the person's Chrome", () => {
	test(
		"it adopts a page that is already there, opens none, and leaves the page the size it was",
		async () => {
			const before = await startDebugChrome();
			const probe = await puppeteer.connect({ browserURL: before.cdpUrl, defaultViewport: null });
			const widthBefore = Number(await (await probe.pages())[0]!.evaluate("window.innerWidth"));
			await probe.disconnect();
			const established = await establishKind({ kind: "connected", cdpUrl: before.cdpUrl });
			if (!("attach" in established)) throw new Error("expected an attach target");
			const pageCount = (await pagesOf(before.cdpUrl)).length;
			const driver = await createEngineDriver("chrome-relay", { profileDirectory: join(tmpdir(), "unused-by-attach"), viewport: { width: 640, height: 480 }, attach: established.attach, onClosed: () => undefined });
			drivers.push(driver);

			expect((await pagesOf(before.cdpUrl)).length).toBe(pageCount);
			const state = await driver.state();
			expect(state.tabs).toHaveLength(1);
			// 640 wide is what the pack gives its OWN tabs; the person's page is not made that size.
			const after = await puppeteer.connect({ browserURL: before.cdpUrl, defaultViewport: null });
			const widthAfter = Number(await (await after.pages())[0]!.evaluate("window.innerWidth"));
			await after.disconnect();
			expect(widthAfter).toBe(widthBefore);
			expect(widthAfter).not.toBe(640);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a page is picked by what is on it, and one that is not there is refused with the pages listed",
		async () => {
			const { driver, pages } = await attachedToPersonsChrome();
			const ref = await driver.adoptTab({ match: "Page two" });
			expect(ref).toMatchObject({ url: pages.url("/two"), title: "Page two", active: true });
			expect(ref.targetId.length).toBeGreaterThan(8);
			expect((await driver.state()).url).toBe(pages.url("/two"));

			const other = await driver.adoptTab({ match: pages.url("/one") });
			expect(other.url).toBe(pages.url("/one"));
			expect(other.tabId).not.toBe(ref.tabId);
			// The same page again is the same tab, not a second adoption.
			expect((await driver.adoptTab({ match: "Page two" })).tabId).toBe(ref.tabId);
			expect((await driver.state()).tabs).toHaveLength(2);

			const refusal = await driver.adoptTab({ match: "no such page" }).then(
				() => "adopted",
				(error: Error) => error.message,
			);
			expect(refusal).toContain('No page target matched "no such page". Available pages:');
			expect(refusal).toContain(pages.url("/one"));
			expect(refusal).toContain(pages.url("/two"));
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"letting go closes nothing of the person's: every page stays open and their Chrome keeps running, and the lease is released once",
		async () => {
			const { driver, chromeUrl, pid, pages, released } = await attachedToPersonsChrome();
			await driver.adoptTab({ match: "Page one" });
			await driver.adoptTab({ match: "Page two" });
			const open = (await pagesOf(chromeUrl)).map((entry) => entry.url).sort();
			expect(open).toEqual([pages.url("/one"), pages.url("/two")].sort());

			await driver.close();
			expect(released()).toBe(1);
			expect(alive(pid)).toBe(true);
			expect((await pagesOf(chromeUrl)).map((entry) => entry.url).sort()).toEqual(open);
			await pages.stop();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"closing an adopted tab releases it and leaves the page open in the person's browser",
		async () => {
			const { driver, chromeUrl, pages } = await attachedToPersonsChrome();
			const one = await driver.adoptTab({ match: "Page one" });
			const two = await driver.adoptTab({ match: "Page two" });
			await driver.closeTab(two.tabId);
			expect((await pagesOf(chromeUrl)).map((entry) => entry.url).sort()).toEqual([pages.url("/one"), pages.url("/two")].sort());
			// The other adopted page is the active one now; nothing was opened in the person's browser to take the closed one's place.
			const state = await driver.state();
			expect(state.tabs.map((tab) => tab.id)).toEqual([one.tabId]);
			expect(state.url).toBe(pages.url("/one"));
			// Letting go of the last one leaves no tab, and says so rather than failing on a detached session.
			await driver.closeTab(one.tabId);
			expect(await failureCode(() => driver.state())).toBe("no_tab");
			expect((await pagesOf(chromeUrl)).length).toBe(2);
			await pages.stop();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test("an attach target belongs to the attach engine alone, and a launched browser has nothing to adopt", async () => {
		const target = { kind: "connected" as const, cdpUrl: "http://127.0.0.1:1", label: "connected http://127.0.0.1:1" };
		expect(await failureCode(() => createEngineDriver("chromium", { profileDirectory: tmpdir(), viewport: { width: 640, height: 480 }, attach: target, onClosed: () => undefined }))).toBe("bad_engine");
	});

	test("connecting to an endpoint that is not a browser says which kind failed, and releases the lease it never held", async () => {
		let released = 0;
		const target = { kind: "connected" as const, cdpUrl: "http://127.0.0.1:1", label: "connected http://127.0.0.1:1" };
		expect(await failureCode(() => createEngineDriver("chrome-relay", { profileDirectory: tmpdir(), viewport: { width: 640, height: 480 }, attach: target, onClosed: () => void (released += 1) }))).toBe("attach_failed");
		expect(released).toBe(1);
	});
});

describeWithChrome("an application the pack spawned", () => {
	test(
		"closing the driver leaves it running; kill ends it",
		async () => {
			if (chromePath === undefined) throw new Error("no Chrome");
			const userDataDir = await mkdtemp(join(tmpdir(), "dimension-attach-spawned-"));
			let pid: number | undefined;
			try {
				const established = await establishKind({ kind: "spawned", path: chromePath, args: ["--headless=new", `--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"] });
				if (!("attach" in established)) throw new Error("expected an attach target");
				pid = established.attach.pid;
				const driver = await createEngineDriver("chrome-relay", { profileDirectory: tmpdir(), viewport: { width: 640, height: 480 }, attach: established.attach, onClosed: () => undefined });
				await driver.close();
				expect(alive(pid!)).toBe(true);

				const again = await createEngineDriver("chrome-relay", { profileDirectory: tmpdir(), viewport: { width: 640, height: 480 }, attach: established.attach, onClosed: () => undefined });
				await again.kill();
				expect(await gone(pid!)).toBe(true);
			} finally {
				if (pid !== undefined) await killTree(pid);
				await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
