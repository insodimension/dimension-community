/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the agent's browser_act stops
 *  doing exactly what it was told, exactly once. Either an action silently
 *  does something else (a `type` that appends to a field instead of replacing
 *  it, a `select` that picks the wrong option), a single click writes twice, a
 *  failure that provably did nothing is reported as "may have happened" (so
 *  the agent stalls) — or, worse, an action that DID reach the page is reported
 *  as a clean failure or quietly retried, so a purchase or form post happens
 *  twice. Also: a navigate that becomes script execution or a local file read.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
	BROWSER_TEST_TIMEOUT_MS,
	createRuntime,
	describeWithChrome,
	failureCode,
	perform,
	startFixture,
	submissionLanded,
	teardown,
	waitUntil,
} from "./fixture";

const VIEWPORT = { width: 800, height: 600 };

// Closing a real Chrome and deleting its profile on Windows takes longer than
// bun's default hook budget; a leaked browser poisons every later test.
afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

describeWithChrome("act", () => {
	test(
		"navigate, type, select and click run immediately, and one submit click is exactly one write",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "act-flow", viewport: VIEWPORT });

			const landed = await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/signup") });
			expect(landed.url).toBe(fixture.url("/signup"));
			// The field already holds "old name": `type` must REPLACE it.
			await perform(runtime, browserId, { kind: "type", selector: "#user", text: "new name" });
			// Chosen by visible text; the form must post the option's value.
			await perform(runtime, browserId, { kind: "select", selector: "#plan", value: "Pro plan" });
			await perform(runtime, browserId, { kind: "click", selector: "#go" });
			await submissionLanded(runtime, browserId, fixture);

			expect(fixture.submissions()).toEqual([{ user: "new name", plan: "pro" }]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a selector that matches nothing fails as provably-not-dispatched and writes nothing",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "act-miss", viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/signup") });

			const result = await runtime.act(browserId, { kind: "click", selector: "#no-such-button" });

			expect(result.status).toBe("failed");
			expect(result.state.url).toBe(fixture.url("/signup"));
			expect(fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an action that errors after it reached the page reports unknown and is never repeated",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "act-unknown", viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/guarded") });
			// Empty field: the guard lets the selection through.
			await perform(runtime, browserId, { kind: "type", selector: "#pass", text: "first" });

			// Filled field: the page's guard throws AFTER the browser focused it.
			const result = await runtime.act(browserId, { kind: "type", selector: "#pass", text: "second" });

			expect(result.status).toBe("unknown");
			expect(result.error).toContain("may or may not have taken effect");
			// The guard counts its runs in the live document. A retry inside act
			// would have run it again before act returned.
			const { text } = await runtime.snapshot(browserId);
			expect(text.split("\n")[0]).toBe("# guard fired 1");
			expect(fixture.hits("/submit")).toBe(0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"navigate refuses javascript: and file: URLs before touching the page",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "act-scheme", viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/signup") });

			for (const url of ['javascript:fetch("/js-ran")', "file:///etc/hosts", "file:///C:/Windows/win.ini"]) {
				expect(await failureCode(() => runtime.act(browserId, { kind: "navigate", url }))).toBe("bad_action");
			}

			expect(fixture.hits("/js-ran")).toBe(0);
			expect(fixture.hits("/signup")).toBe(1);
			expect((await runtime.state(browserId)).url).toBe(fixture.url("/signup"));
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"type and insert into a password field of an origin with a saved password type the saved one, name only the origin, and elsewhere type the text as given",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "act-saved", viewport: VIEWPORT });
			const origin = new URL(fixture.url("/")).origin;
			const saved = "Saved-Pw_7#fixture";
			await writeFile(join(rootDir, "profiles", "act-saved", "credentials.json"), JSON.stringify({ version: 1, origins: { [origin]: saved } }));

			// `type` on the saved origin: the saved password lands, the model's text does not.
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/") });
			const user = await runtime.act(browserId, { kind: "type", selector: "#user", text: "ada" });
			expect(user.savedPassword).toBeUndefined();
			const typed = await runtime.act(browserId, { kind: "type", selector: "#pass", text: "model-typed" });
			expect({ status: typed.status, savedPassword: typed.savedPassword }).toEqual({ status: "completed", savedPassword: { origin } });
			expect(JSON.stringify(typed)).not.toContain(saved);
			await perform(runtime, browserId, { kind: "click", selector: "#go" });
			await submissionLanded(runtime, browserId, fixture);

			// `insert` into the focused password field: the same.
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/") });
			await perform(runtime, browserId, { kind: "click", selector: "#pass" });
			const inserted = await runtime.act(browserId, { kind: "insert", text: "model-inserted" });
			expect(inserted.savedPassword).toEqual({ origin });
			await perform(runtime, browserId, { kind: "press", key: "Enter" });
			await submissionLanded(runtime, browserId, fixture);

			// Another origin (localhost, same server) has nothing saved: the text goes in as given.
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/", "localhost") });
			const plain = await runtime.act(browserId, { kind: "type", selector: "#pass", text: "model-typed" });
			expect(plain.savedPassword).toBeUndefined();
			await perform(runtime, browserId, { kind: "click", selector: "#go" });
			await waitUntil("the third form post", () => fixture.submissions().length, (count) => count === 3);

			expect(fixture.submissions()).toEqual([
				{ user: "ada", pass: saved },
				{ user: "", pass: saved },
				{ user: "", pass: "model-typed" },
			]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	// abp's refusal (and the profile surviving it) is pinned in profile.test.ts.
	test(
		"the refused browser4 engine reports its reason and leaves the profile openable",
		async () => {
			const { runtime } = await createRuntime();

			expect(await failureCode(() => runtime.open({ profile: "refused", engine: "browser4", viewport: VIEWPORT }))).toBe(
				"browser4_tls_verification_disabled",
			);
			const opened = await runtime.open({ profile: "refused", viewport: VIEWPORT });
			expect((await runtime.state(opened.browserId)).engine).toBe("chromium");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
