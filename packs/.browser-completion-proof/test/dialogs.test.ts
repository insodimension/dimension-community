/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: one `alert()` on a page freezes
 *  the whole browser — the click that opened it never returns, and state,
 *  snapshot and close then hang for minutes with no way back. Chrome blocks
 *  every command on a page that has an open JavaScript dialog until somebody
 *  answers it, so the browser must answer each one the moment it opens
 *  (alert and beforeunload accepted, confirm and prompt dismissed) and tell
 *  the model what it did. These tests open real dialogs in real Chrome,
 *  including one raised in a tab a task agent opened over its own connection.
 */
import { afterEach, expect, test } from "bun:test";
import puppeteer from "puppeteer-core";
import type { BrowserRuntime } from "../src/runtime";
import { BROWSER_TEST_TIMEOUT_MS, createRuntime, describeWithChrome, perform, startFixture, teardown, waitUntil, within } from "./fixture";

const VIEWPORT = { width: 640, height: 480 };
/** Far below the 35 s a wedged browser took to give up, far above any real dispatch. */
const PROMPT_MS = 8_000;

afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

describeWithChrome("page dialogs", () => {
	test(
		"an alert, a confirm and a prompt never block the browser: act returns at once, the page gets the decision, the model is told",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/dialogs") });

			const alert = await within(PROMPT_MS, "a click that opens an alert", runtime.act(browserId, { kind: "click", selector: "#alert" }));
			expect(alert.status).toBe("completed");
			expect(alert.dialogs).toEqual([{ type: "alert", message: "hello alert", handled: "accepted" }]);
			// The page carried on after the alert.
			expect(alert.state.title).toBe("after alert");

			const confirm = await within(PROMPT_MS, "a click that opens a confirm", runtime.act(browserId, { kind: "click", selector: "#confirm" }));
			expect(confirm.dialogs).toEqual([{ type: "confirm", message: "really?", handled: "dismissed" }]);
			expect(confirm.state.title).toBe("confirm:false");

			const prompt = await within(PROMPT_MS, "a click that opens a prompt", runtime.act(browserId, { kind: "click", selector: "#prompt" }));
			expect(prompt.dialogs).toEqual([{ type: "prompt", message: "your name?", handled: "dismissed" }]);
			expect(prompt.state.title).toBe("prompt:null");

			// Everything on this browser still answers, and what happened stays visible.
			const state = await within(PROMPT_MS, "state after dialogs", runtime.state(browserId));
			expect(state.dialogs.map(({ type, handled }) => `${type}:${handled}`)).toEqual(["alert:accepted", "confirm:dismissed", "prompt:dismissed"]);
			expect((await within(PROMPT_MS, "snapshot after dialogs", runtime.snapshot(browserId))).text).toContain("# prompt:null");
			await within(PROMPT_MS, "close after dialogs", runtime.close(browserId));
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a dialog raised inside a cross-origin iframe is answered too, and the page and the frame keep working",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/framed-dialogs") });
			const ALERT_IN_FRAME = /^(@1~[0-9a-f]{8}) #alert /m;
			const ref = ALERT_IN_FRAME.exec(await waitUntil("the iframe's buttons", async () => (await runtime.snapshot(browserId)).text, (text) => ALERT_IN_FRAME.test(text)))?.[1];
			if (!ref) throw new Error("no frame ref for the iframe");

			const alert = await within(PROMPT_MS, "a click that opens an alert in an iframe", runtime.act(browserId, { kind: "click", selector: `${ref} #alert` }));
			expect(alert.status).toBe("completed");
			expect(alert.dialogs).toEqual([{ type: "alert", message: "hello alert", handled: "accepted" }]);
			const confirm = await within(PROMPT_MS, "a click that opens a confirm in an iframe", runtime.act(browserId, { kind: "click", selector: `${ref} #confirm` }));
			expect(confirm.dialogs).toEqual([{ type: "confirm", message: "really?", handled: "dismissed" }]);
			expect((await within(PROMPT_MS, "snapshot after iframe dialogs", runtime.snapshot(browserId))).text).toContain("confirm:false");
			await within(PROMPT_MS, "close after iframe dialogs", runtime.close(browserId));
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"leaving a page that asks first is accepted, so a navigation is never held hostage, and the model is told",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/unload-guard") });

			const left = await within(PROMPT_MS, "a click on a link out of a beforeunload page", runtime.act(browserId, { kind: "click", selector: "#leave" }));
			expect(left.status).toBe("completed");
			expect(left.state.url).toBe(fixture.url("/page2"));
			expect(left.dialogs?.map(({ type, handled }) => ({ type, handled }))).toEqual([{ type: "beforeunload", handled: "accepted" }]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the state keeps only the last five handled dialogs, oldest first",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/dialogs") });

			await within(PROMPT_MS, "seven alerts in one click", runtime.act(browserId, { kind: "click", selector: "#many" }));

			const state = await runtime.state(browserId);
			expect(state.dialogs.map((dialog) => dialog.message)).toEqual(["dialog 3", "dialog 4", "dialog 5", "dialog 6", "dialog 7"]);
			expect(state.title).toBe("many done");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a dialog in a tab a task agent opened over its own connection is answered too",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			const endpoint = agentEndpoint(runtime);
			// What a task agent does: attach to the same Chrome, open its own tab, drive it.
			const agent = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
			try {
				const page = await agent.newPage();
				await page.goto(fixture.url("/page2"));
				await waitUntil("the agent's tab to become one of the browser's tabs", () => runtime.state(browserId), (state) => state.tabs.length === 2);

				await within(PROMPT_MS, "the agent's own alert", page.evaluate(() => alert("from the agent")));

				const state = await waitUntil("the alert to be reported", () => runtime.state(browserId), (seen) => seen.dialogs.length > 0);
				expect(state.dialogs).toEqual([{ type: "alert", message: "from the agent", handled: "accepted" }]);
				expect(state.url).toBe(fixture.url("/page2"));
			} finally {
				await agent.disconnect();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

/** The CDP endpoint a task agent is handed (`browser_task` passes exactly this), read off the runtime's only browser. */
function agentEndpoint(runtime: BrowserRuntime): string {
	// Reason: test seam into the runtime's private browser map; the endpoint is otherwise only handed to a task worker.
	const browsers = (runtime as unknown as { byId: Map<string, { driver: { cdpEndpoint(): string } }> }).byId;
	const [entry] = [...browsers.values()];
	if (!entry) throw new Error("no open browser");
	return entry.driver.cdpEndpoint();
}
