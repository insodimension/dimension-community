/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an agent clicks a link and is
 *  told the OLD url and title (it acts on a page it has already left), or its
 *  next browser_snapshot dies with "Execution context was destroyed", or a
 *  click below the fold "completes" without touching anything, or a snapshot
 *  shows a checkbox and a <select> but not what they are set to (verification
 *  is blind), or a link is listed as a bare `a` that no selector can tell from
 *  the next one. Every one of these was measured in real use of the browser.
 *  These tests drive real Chrome against the local fixture.
 */
import { afterEach, expect, test } from "bun:test";
import { BROWSER_TEST_TIMEOUT_MS, createRuntime, DELAYED_LANDING_MS, describeWithChrome, perform, startFixture, teardown, within } from "./fixture";

const VIEWPORT = { width: 640, height: 480 };

afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

async function opened(path: string) {
	const fixture = startFixture();
	const { runtime } = await createRuntime();
	const { browserId } = await runtime.open({ viewport: VIEWPORT });
	await perform(runtime, browserId, { kind: "navigate", url: fixture.url(path) });
	return { fixture, runtime, browserId };
}

describeWithChrome("a click that navigates", () => {
	test(
		"a link click returns the page it landed on, not the one it left, even when that page is slow to answer",
		async () => {
			const { fixture, runtime, browserId } = await opened("/nav");
			const clicked = await runtime.act(browserId, { kind: "click", selector: "#link" });
			expect(clicked.status).toBe("completed");
			expect(clicked.state.url).toBe(fixture.url("/delayed-landing?via=link"));
			expect(clicked.state.title).toBe("landed");
			expect(clicked.state.loading).toBe(false);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a form whose answer is slow is waited for: the result is the landed page, and the wait is bounded by the answer, not by a fixed delay",
		async () => {
			const { fixture, runtime, browserId } = await opened("/nav");
			const started = performance.now();
			const clicked = await runtime.act(browserId, { kind: "click", selector: "#slow-go" });
			const elapsed = performance.now() - started;
			expect(clicked.state.url).toBe(fixture.url("/delayed-landing?q=x"));
			expect(clicked.state.title).toBe("landed");
			expect(elapsed).toBeGreaterThanOrEqual(DELAYED_LANDING_MS * 0.8);
			expect(elapsed).toBeLessThan(DELAYED_LANDING_MS + 2_500);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a script that starts the navigation a moment after the click is still caught",
		async () => {
			const { fixture, runtime, browserId } = await opened("/nav");
			const clicked = await runtime.act(browserId, { kind: "click", selector: "#later" });
			expect(clicked.state.url).toBe(fixture.url("/page2"));
			expect(clicked.state.title).toBe("second page");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"Enter in a form field returns the page the form led to",
		async () => {
			const { fixture, runtime, browserId } = await opened("/nav");
			await perform(runtime, browserId, { kind: "type", selector: "#q", text: "hello" });
			const submitted = await runtime.act(browserId, { kind: "press", key: "Enter" });
			expect(submitted.state.url).toBe(fixture.url("/page2?q=hello"));
			expect(submitted.state.title).toBe("second page");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a click that navigates nowhere comes back promptly and leaves the page as it is",
		async () => {
			const { fixture, runtime, browserId } = await opened("/nav");
			const started = performance.now();
			const clicked = await runtime.act(browserId, { kind: "click", selector: "#idle" });
			expect(performance.now() - started).toBeLessThan(1_000);
			expect(clicked.state.url).toBe(fixture.url("/nav"));
			expect(clicked.state.title).toBe("idle clicked");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a snapshot right after a navigating click reads the new page instead of failing",
		async () => {
			const { runtime, browserId } = await opened("/nav");
			await runtime.act(browserId, { kind: "click", selector: "#slow-go" });
			const read = await within(10_000, "a snapshot after a navigating click", runtime.snapshot(browserId));
			expect(read.text).toContain("# landed");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a snapshot taken while the page navigates itself never fails with a destroyed execution context",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ viewport: VIEWPORT });
			// Each round the page swaps to another site's renderer as soon as it loads.
			for (let round = 0; round < 6; round += 1) {
				await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/bounce?left=1") });
				const read = await within(15_000, `snapshot in round ${round}`, runtime.snapshot(browserId));
				expect(read.text).toMatch(/# bounce/);
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithChrome("a click or hover at a point", () => {
	test(
		"outside the viewport is a failed action naming the viewport and telling the model to scroll, never a silent success",
		async () => {
			const { runtime, browserId } = await opened("/nav");
			for (const kind of ["click", "hover"] as const) {
				const result = await runtime.act(browserId, { kind, x: 100, y: 900 });
				expect(result.status).toBe("failed");
				expect(result.error).toContain("640x480");
				expect(result.error).toContain("scroll");
			}
			const inside = await runtime.act(browserId, { kind: "click", x: 5, y: 5 });
			expect(inside.status).toBe("completed");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

/** The selector a snapshot line offers for the control labelled `label` (its Nth listing). */
function selectorFor(text: string, label: string, nth = 0): string {
	const lines = text.split("\n").filter((line) => line.includes(` "${label}"`));
	const line = lines[nth];
	if (line === undefined) throw new Error(`no snapshot line for ${label}:\n${text}`);
	const parsed = /^(.+?)(?: \([a-z]+\))?(?: \[(?:un)?checked\])? "/.exec(line);
	if (!parsed?.[1]) throw new Error(`cannot read a selector from ${line}`);
	return parsed[1];
}

describeWithChrome("browser_snapshot", () => {
	test(
		"shows whether each checkbox and radio is checked and what each <select> holds, and never anything about a password",
		async () => {
			const { runtime, browserId } = await opened("/controls");
			const { text } = await runtime.snapshot(browserId);
			expect(text).toContain("#agree (checkbox) [checked]");
			expect(text).toContain("#news (checkbox) [unchecked]");
			expect(text).toMatch(/input\[name="size"\]\[value="s"\] \(radio\) \[unchecked\]/);
			expect(text).toMatch(/input\[name="size"\]\[value="m"\] \(radio\) \[checked\]/);
			expect(text).toMatch(/#plan .*options: Free \| Pro plan selected: Pro plan/);
			expect(text).toContain(`#secret (password) "[redacted]"`);
			expect(text).not.toContain("hunter2");

			await perform(runtime, browserId, { kind: "click", selector: "#news" });
			await perform(runtime, browserId, { kind: "select", selector: "#plan", value: "free" });
			const after = (await runtime.snapshot(browserId)).text;
			expect(after).toContain("#news (checkbox) [checked]");
			expect(after).toMatch(/#plan .*selected: Free/);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"gives every link a selector that reaches exactly that link, even when links share a href or a tag",
		async () => {
			const { runtime, browserId } = await opened("/controls");
			const { text } = await runtime.snapshot(browserId);
			const wanted: Array<[string, number, string]> = [["first", 0, "first"], ["second", 0, "second"], ["third", 0, "third"], ["list link", 0, "list 1"], ["list link", 1, "list 2"]];
			for (const [label, nth, clickedTitle] of wanted) {
				await perform(runtime, browserId, { kind: "click", selector: selectorFor(text, label, nth) });
				expect((await runtime.state(browserId)).title).toBe(clickedTitle);
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
