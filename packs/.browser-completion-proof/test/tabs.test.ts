/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the Browser View stops being a
 *  browser. Tabs the human opens, switches or closes do not become the tab the
 *  agent reads and drives (so it acts on a page nobody is looking at); a site's
 *  target=_blank link opens where nobody can see it; closing the last tab kills
 *  the browser; back/forward/reload do nothing; typing on the page goes
 *  nowhere; the live view stalls behind a capture per poll or freezes on the
 *  first page; tabs show no favicon.
 */
import { afterEach, expect, test } from "bun:test";
import type { LiveFrame } from "../src/engines/types";
import {
	BROWSER_TEST_TIMEOUT_MS,
	createRuntime,
	describeWithChrome,
	FAVICON_PNG,
	perform,
	SLOW_PAGE_MS,
	startFixture,
	teardown,
	waitUntil,
} from "./fixture";

const VIEWPORT = { width: 800, height: 600 };

afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

describeWithChrome("tabs", () => {
	test(
		"new, activate and close move the driven tab; closing the last tab leaves a blank one, not a dead browser",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "tabs-ops", viewport: VIEWPORT }, { caller: "app" });
			const first = await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/page2") });
			const firstId = first.activeTabId;

			const opened = await runtime.tab(browserId, { op: "new", url: fixture.url("/signup") });
			expect(opened.tabs.map((tab) => tab.url)).toEqual([fixture.url("/page2"), fixture.url("/signup")]);
			expect(opened.activeTabId).not.toBe(firstId);
			expect(opened.url).toBe(fixture.url("/signup"));
			// It starts at the URL: "back" does not lead to the blank page it was born on.
			expect(opened.canGoBack).toBe(false);
			const secondId = opened.activeTabId;

			// Activation moves what reads AND actions see.
			const back = await runtime.tab(browserId, { op: "activate", tabId: firstId });
			expect(back.url).toBe(fixture.url("/page2"));
			expect(back.tabs.filter((tab) => tab.active).map((tab) => tab.id)).toEqual([firstId]);
			expect((await runtime.snapshot(browserId)).text).toContain("second page");

			// Closing the active tab hands over to the remaining one.
			const closed = await runtime.tab(browserId, { op: "close", tabId: firstId });
			expect(closed.tabs.map((tab) => tab.id)).toEqual([secondId]);
			expect(closed.url).toBe(fixture.url("/signup"));

			const last = await runtime.tab(browserId, { op: "close", tabId: secondId });
			expect(last.tabs).toHaveLength(1);
			expect(last.activeTabId).not.toBe(secondId);
			expect(last.url).toBe("about:blank");
			// Still a working browser.
			expect((await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/page2") })).title).toBe("second page");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a target=_blank link opens a new tab that becomes the active one",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "tabs-blank", viewport: VIEWPORT }, { caller: "app" });
			const opener = await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/opener") });

			await perform(runtime, browserId, { kind: "click", selector: "#blank" });

			const shown = await waitUntil(
				"the site-opened tab to become active",
				() => runtime.state(browserId),
				(state) => state.tabs.length === 2 && state.url === fixture.url("/page2"),
			);
			expect(shown.activeTabId).not.toBe(opener.activeTabId);
			expect(shown.tabs.map((tab) => tab.url)).toEqual([fixture.url("/opener"), fixture.url("/page2")]);
			expect((await runtime.snapshot(browserId)).text).toContain("second page");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"back, forward and reload walk the active tab's history; back with no history provably does nothing",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "tabs-history", viewport: VIEWPORT }, { caller: "app" });
			const fresh = await runtime.tab(browserId, { op: "new" });
			expect(fresh.canGoBack).toBe(false);
			expect((await runtime.act(browserId, { kind: "back" })).status).toBe("failed");

			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/signup") });
			const second = await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/page2") });
			expect(second.canGoBack).toBe(true);
			expect(second.canGoForward).toBe(false);

			const back = await perform(runtime, browserId, { kind: "back" });
			expect(back.url).toBe(fixture.url("/signup"));
			expect(back.canGoForward).toBe(true);

			const forward = await perform(runtime, browserId, { kind: "forward" });
			expect(forward.url).toBe(fixture.url("/page2"));

			const hits = fixture.hits("/page2");
			const reloaded = await perform(runtime, browserId, { kind: "reload" });
			expect(reloaded.url).toBe(fixture.url("/page2"));
			expect(reloaded.revision).toBeGreaterThan(forward.revision);
			expect(fixture.hits("/page2")).toBe(hits + 1);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"insert types into whatever field has focus, and the form posts it",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "tabs-insert", viewport: VIEWPORT }, { caller: "app" });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/") });
			await perform(runtime, browserId, { kind: "click", selector: "#user" });

			await perform(runtime, browserId, { kind: "insert", text: "ada" });
			await perform(runtime, browserId, { kind: "insert", text: " lovelace" });
			await perform(runtime, browserId, { kind: "press", key: "Enter" });

			await waitUntil("the form post", () => fixture.submissions().length, (count) => count === 1);
			expect(fixture.submissions()[0]).toEqual({ user: "ada lovelace", pass: "" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"while a slow navigation is in flight, the live state still answers at once and reports loading, and the live picture keeps coming",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "tabs-inflight", viewport: VIEWPORT }, { caller: "app" });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/page2") });
			const frames: LiveFrame[] = [];
			const stop = runtime.watchFrames(browserId, (frame) => frames.push(frame));
			await waitUntil("the first picture", async () => frames.length, (count) => count >= 1);

			const landing = perform(runtime, browserId, { kind: "navigate", url: fixture.url("/slow") });
			// Once the request is on the wire, the navigation is certainly still pending.
			await waitUntil("the slow request to arrive", () => fixture.hits("/slow"), (hits) => hits === 1);
			const started = performance.now();
			const during = await runtime.liveState(browserId);
			expect(performance.now() - started).toBeLessThan(SLOW_PAGE_MS / 4);
			expect(during.loading).toBe(true);
			// Still the committed document until the new one arrives.
			expect(during.url).toBe(fixture.url("/page2"));

			expect((await landing).url).toBe(fixture.url("/slow"));
			await waitUntil("loading to clear", () => runtime.state(browserId), (state) => !state.loading);
			stop();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a page's declared favicon reaches its tab as a data: URL of the served bytes",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "tabs-icon", viewport: VIEWPORT }, { caller: "app" });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/with-icon") });

			const state = await waitUntil(
				"the tab's favicon",
				() => runtime.state(browserId),
				(s) => s.tabs[0]?.favicon !== null && s.tabs[0]?.favicon !== undefined,
			);
			expect(state.tabs[0]?.favicon).toBe(`data:image/png;base64,${FAVICON_PNG.toString("base64")}`);
			expect(fixture.hits("/brand.png")).toBeGreaterThan(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
