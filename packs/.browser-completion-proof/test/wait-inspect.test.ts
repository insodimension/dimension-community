/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an agent cannot wait for a
 *  page that fills in late (it polls with sleeps, or acts on a half-loaded
 *  page), or a coding agent cannot tell why a box overflows (it has only a
 *  screenshot to guess from). The `wait` step and `browser_inspect` give it the
 *  two missing facts: "it is there now" and "here are the box and the styles
 *  that made it this size". They must also stay inside the rules of the other
 *  tools: a wait is refused where an act is, and inspect runs no code the
 *  caller wrote. Real Chrome, the local fixture.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { BrowserRuntime } from "../src/runtime";
import { BROWSER_TEST_TIMEOUT_MS, createRuntime, describeWithChrome, failureCode, perform, startFixture, teardown } from "./fixture";

const VIEWPORT = { width: 640, height: 480 };

afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

async function opened(path: string, host?: "localhost") {
	const fixture = startFixture();
	const { runtime } = await createRuntime();
	const { browserId } = await runtime.open({ viewport: VIEWPORT });
	await perform(runtime, browserId, { kind: "navigate", url: fixture.url(path, host) });
	return { fixture, runtime, browserId };
}

describeWithChrome("wait", () => {
	test(
		"returns the fresh state once a selector, some text or a URL fragment shows up, and status timeout when it never does",
		async () => {
			const { fixture, runtime, browserId } = await opened("/late");

			const selector = await runtime.wait(browserId, { selector: "#late", timeoutMs: 5_000 });
			expect(selector.status).toBe("completed");
			expect(selector.state.url).toBe(fixture.url("/late"));

			const text = await runtime.wait(browserId, { text: "late arrival text", timeoutMs: 5_000 });
			expect(text.status).toBe("completed");

			const url = await runtime.wait(browserId, { url: "done=1", timeoutMs: 5_000 });
			expect(url.status).toBe("completed");
			expect(url.state.url).toBe(fixture.url("/late?done=1"));

			const started = performance.now();
			const never = await runtime.wait(browserId, { selector: "#never-there", timeoutMs: 400 });
			expect(never.status).toBe("timeout");
			expect(never.state.url).toBe(fixture.url("/late?done=1"));
			expect(performance.now() - started).toBeLessThan(3_000);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"waits for something that has not happened yet rather than reporting the page as it is now",
		async () => {
			const { runtime, browserId } = await opened("/late");
			const started = performance.now();
			const waited = await runtime.wait(browserId, { text: "late arrival text", timeoutMs: 5_000 });
			expect(waited.status).toBe("completed");
			expect(performance.now() - started).toBeGreaterThanOrEqual(150);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"asks for exactly one condition and no more than 15 s",
		async () => {
			const { runtime, browserId } = await opened("/late");
			expect(await failureCode(() => runtime.wait(browserId, {}))).toBe("bad_wait");
			expect(await failureCode(() => runtime.wait(browserId, { selector: "#late", text: "x" }))).toBe("bad_wait");
			expect(await failureCode(() => runtime.wait(browserId, { selector: "#late", timeoutMs: 15_001 }))).toBe("bad_wait");
			expect(await failureCode(() => runtime.wait(browserId, { selector: "#late", timeoutMs: -1 }))).toBe("bad_wait");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"is refused while a publish awaits confirmation, as an act is",
		async () => {
			const { runtime, browserId } = await opened("/late");
			markPublishPending(runtime, browserId);
			expect(await failureCode(() => runtime.wait(browserId, { selector: "#late" }))).toBe("publish_pending");
			// The View's own input is the one caller allowed through.
			expect((await runtime.wait(browserId, { selector: "#late", timeoutMs: 5_000 }, "app")).status).toBe("completed");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"cannot be used to confirm a saved password the page shows, in its text or in its URL, one prefix at a time",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "wait-oracle", viewport: VIEWPORT }, { caller: "app" });
			const saved = "Revealed-Pw_3#fixture";
			await writeFile(join(rootDir, "profiles", "wait-oracle", "credentials.json"), JSON.stringify({ version: 1, origins: { [new URL(fixture.url("/")).origin]: saved } }));

			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/revealable") });
			await perform(runtime, browserId, { kind: "type", selector: "#pass", useSavedPassword: true });
			await perform(runtime, browserId, { kind: "click", selector: "#echo" });
			// The page now holds the password in its text: a real wait still sees the page around it...
			expect((await runtime.wait(browserId, { text: "echo:", timeoutMs: 2_000 })).status).toBe("completed");
			// ...but not the secret, whole or in part.
			for (const guess of [saved, "echo:Revealed", "Revealed-Pw", "Pw_3#fix"]) {
				expect((await runtime.wait(browserId, { text: guess, timeoutMs: 300 })).status, guess).toBe("timeout");
			}

			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/get-login") });
			await perform(runtime, browserId, { kind: "type", selector: "#pass", useSavedPassword: true });
			await perform(runtime, browserId, { kind: "click", selector: "#go" });
			expect((await runtime.wait(browserId, { url: "/logged-in?", timeoutMs: 2_000 })).status).toBe("completed");
			for (const guess of ["pass=Revealed", `pass=${encodeURIComponent(saved)}`]) {
				expect((await runtime.wait(browserId, { url: guess, timeoutMs: 300 })).status, guess).toBe("timeout");
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"takes plain CSS only: a query handler that matches on page text is refused",
		async () => {
			const { runtime, browserId } = await opened("/late");
			for (const selector of ["text/late arrival", "xpath///p", "aria/late", "pierce/#late", "p::-p-text(late)", "@1~abcd12ef text/x"]) {
				expect(await failureCode(() => runtime.wait(browserId, { selector })), selector).toBe("bad_action");
				expect(await failureCode(() => runtime.inspect(browserId, selector)), selector).toBe("bad_action");
			}
			expect((await runtime.wait(browserId, { selector: "#late", timeoutMs: 5_000 })).status).toBe("completed");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"is refused while a task owns the page",
		async () => {
			const { runtime, browserId } = await opened("/late");
			markTaskRunning(runtime, browserId);
			expect(await failureCode(() => runtime.wait(browserId, { selector: "#late" }))).toBe("task_running");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithChrome("browser_inspect", () => {
	test(
		"reports the box, the overflow and the styles behind an element that sticks out of its parent",
		async () => {
			const { runtime, browserId } = await opened("/layout");
			const card = await runtime.inspect(browserId, "#card");
			if (!card.found) throw new Error("the card was not found");
			// content-box: 480 + 2 x 20 padding + 2 x 2 border = 524 px in a 360 px panel.
			expect(card.rect.width).toBe(524);
			expect(card.parent?.width).toBe(362);
			expect(card.styles["box-sizing"]).toBe("content-box");
			expect(card.styles.width).toBe("480px");
			expect(card.styles.padding).toBe("20px");
			expect(card.styles["border-width"]).toBe("2px");
			expect(card.styles.overflow).toBe("visible");
			expect(card.clientWidth).toBe(520);
			expect(card.scrollWidth).toBeGreaterThanOrEqual(card.clientWidth);
			// Only the allowlist: nothing the page could use to smuggle data back out.
			expect(Object.keys(card.styles).sort()).toEqual([
				"border-width", "box-sizing", "display", "flex", "grid-template-columns", "height", "margin", "object-fit", "opacity",
				"overflow", "overflow-x", "overflow-y", "padding", "position", "visibility", "width", "z-index",
			]);

			const panel = await runtime.inspect(browserId, "#panel");
			if (!panel.found) throw new Error("the panel was not found");
			expect(panel.rect.width).toBeLessThan(card.rect.width);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"says so when nothing matches, and changes nothing on the page",
		async () => {
			const { runtime, browserId } = await opened("/layout");
			const before = (await runtime.snapshot(browserId)).text;
			expect(await runtime.inspect(browserId, "#not-here")).toEqual({ found: false });
			await runtime.inspect(browserId, "#card");
			expect((await runtime.snapshot(browserId)).text).toBe(before);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"reaches into an iframe through the same @ref prefix browser_act takes",
		async () => {
			const { runtime, browserId } = await opened("/framed");
			const listing = (await runtime.snapshot(browserId)).text;
			const ref = /^@(\d+~[0-9a-f]{8}) #user /m.exec(listing)?.[1];
			if (!ref) throw new Error(`no frame control in the snapshot:\n${listing}`);
			const field = await runtime.inspect(browserId, `@${ref} #user`);
			expect(field.found).toBe(true);
			expect(await runtime.inspect(browserId, "#user")).toEqual({ found: false });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

/**
 * Put the runtime into the states another tool would: a pending publish, a
 * running task. A real one needs a whole site or a model key; these carry
 * every field the runtime reads, so closing the browser settles them as usual.
 */
function markPublishPending(runtime: BrowserRuntime, browserId: string): void {
	const now = Date.now();
	entryOf(runtime, browserId).publish = {
		record: {
			publishId: "p".repeat(32),
			status: "awaiting-confirmation",
			origin: "https://example.com",
			composeUrl: "https://example.com/compose",
			tabId: "tab",
			profile: "work",
			fields: [],
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + 60_000).toISOString(),
		},
		confirming: false,
		touchedWhilePending: false,
		sharedPage: false,
		settled: Promise.withResolvers<void>(),
	};
}

function markTaskRunning(runtime: BrowserRuntime, browserId: string): void {
	entryOf(runtime, browserId).task = {
		id: "t",
		task: "hold the page",
		status: "running",
		summary: "",
		steps: [],
		stepCount: 0,
		startedAt: new Date().toISOString(),
		elapsedMs: 0,
		usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
	};
}

interface EntrySeam {
	publish: object | null;
	task: object | null;
}

function entryOf(runtime: BrowserRuntime, browserId: string): EntrySeam {
	// Reason: test seam into the runtime's private map (see the note above).
	const browsers = (runtime as unknown as { byId: Map<string, EntrySeam> }).byId;
	const entry = browsers.get(browserId);
	if (!entry) throw new Error("no such browser");
	return entry;
}
