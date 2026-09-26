/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the agent's browser_act stops
 *  doing exactly what it was told, exactly once. Either an action silently
 *  does something else (a `type` that appends to a field instead of replacing
 *  it, a `select` that picks the wrong option), a single click writes twice, a
 *  failure that provably did nothing is reported as "may have happened" (so
 *  the agent stalls) — or, worse, an action that DID reach the page is reported
 *  as a clean failure or quietly retried, so a purchase or form post happens
 *  twice. Also: a navigate that becomes script execution or a local file read.
 */
import { existsSync, readFileSync } from "node:fs";
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

/** The `@<path>~<tag>` ref the snapshot `text` gives the frame at `path` (e.g. "1"), as browser_act takes it. */
function frameRef(text: string, path = "1"): string {
	const found = new RegExp(`^## frame (@${path.replace(".", "\\.")}~[0-9a-f]{8}):`, "m").exec(text);
	if (!found) throw new Error(`no frame @${path} in the snapshot:\n${text}`);
	return found[1] as string;
}
const FORM_IN_FRAME = /^@1~[0-9a-f]{8} #pass /m;

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
		"useSavedPassword REPLACES the field with the saved password for its origin and names only the origin; text is typed literally; nothing saved types nothing",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "act-saved", viewport: VIEWPORT });
			const origin = new URL(fixture.url("/")).origin;
			const other = new URL(fixture.url("/", "localhost")).origin;
			const saved = "Saved-Pw_7#fixture";
			await writeFile(join(rootDir, "profiles", "act-saved", "credentials.json"), JSON.stringify({ version: 1, origins: { [origin]: saved } }));

			// `type` with the flag over a field that already holds text: replaced, not appended.
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/") });
			await perform(runtime, browserId, { kind: "type", selector: "#user", text: "ada" });
			await perform(runtime, browserId, { kind: "type", selector: "#pass", text: "stale-" });
			const typed = await runtime.act(browserId, { kind: "type", selector: "#pass", useSavedPassword: true });
			expect({ status: typed.status, credential: typed.credential }).toEqual({ status: "completed", credential: { origin, created: false } });
			expect(JSON.stringify(typed)).not.toContain(saved);
			await perform(runtime, browserId, { kind: "click", selector: "#go" });
			await submissionLanded(runtime, browserId, fixture);

			// `insert` with the flag into the focused field after literal text: replaced too.
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/") });
			await perform(runtime, browserId, { kind: "click", selector: "#pass" });
			await perform(runtime, browserId, { kind: "insert", text: "abc" });
			const inserted = await runtime.act(browserId, { kind: "insert", useSavedPassword: true });
			expect(inserted.credential).toEqual({ origin, created: false });
			await perform(runtime, browserId, { kind: "press", key: "Enter" });
			await waitUntil("the second form post", () => fixture.submissions().length, (count) => count === 2);

			// No flag on the saved origin: the text as given.
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/") });
			const plain = await runtime.act(browserId, { kind: "type", selector: "#pass", text: "model-typed" });
			expect(plain.credential).toBeUndefined();
			await perform(runtime, browserId, { kind: "click", selector: "#go" });
			await waitUntil("the third form post", () => fixture.submissions().length, (count) => count === 3);

			// The flag where nothing is saved: an error, and the field stays empty.
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/", "localhost") });
			const missing = await runtime.act(browserId, { kind: "type", selector: "#pass", useSavedPassword: true });
			expect({ status: missing.status, error: missing.error }).toEqual({
				status: "failed",
				error: `no saved password for ${other}; for a sign-up pass generatePassword: true, or pass text`,
			});
			await perform(runtime, browserId, { kind: "click", selector: "#go" });
			await waitUntil("the fourth form post", () => fixture.submissions().length, (count) => count === 4);

			expect(fixture.submissions()).toEqual([
				{ user: "ada", pass: saved },
				{ user: "", pass: saved },
				{ user: "", pass: "model-typed" },
				{ user: "", pass: "" },
			]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the View's insert types the human's text literally into a password field of a saved origin, and the View cannot ask for the saved one",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "act-app", viewport: VIEWPORT });
			const saved = "Saved-Pw_app#fixture";
			await writeFile(join(rootDir, "profiles", "act-app", "credentials.json"), JSON.stringify({ version: 1, origins: { [new URL(fixture.url("/")).origin]: saved } }));
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/") });
			await perform(runtime, browserId, { kind: "click", selector: "#pass" });

			expect((await runtime.act(browserId, { kind: "insert", text: "hun" }, "app")).status).toBe("completed");
			expect((await runtime.act(browserId, { kind: "insert", text: "ter2" }, "app")).status).toBe("completed");
			expect(await failureCode(() => runtime.act(browserId, { kind: "insert", useSavedPassword: true }, "app"))).toBe("bad_action");
			await perform(runtime, browserId, { kind: "press", key: "Enter" });
			await submissionLanded(runtime, browserId, fixture);

			expect(fixture.submissions()).toEqual([{ user: "", pass: "hunter2" }]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a page that sets window.origin to a saved origin gets no saved password with the flag, and the literal text without it",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "act-spoof", viewport: VIEWPORT });
			const victim = new URL(fixture.url("/")).origin;
			const real = new URL(fixture.url("/", "localhost")).origin;
			const saved = "Victim-Pw_9#fixture";
			await writeFile(join(rootDir, "profiles", "act-spoof", "credentials.json"), JSON.stringify({ version: 1, origins: { [victim]: saved } }));

			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/spoofed", "localhost") });
			// The page's own world really does claim the victim's origin.
			expect((await runtime.snapshot(browserId)).text).toContain(`claims ${victim}`);
			const spoofed = await runtime.act(browserId, { kind: "type", selector: "#pass", useSavedPassword: true });
			expect({ status: spoofed.status, error: spoofed.error }).toEqual({
				status: "failed",
				error: `no saved password for ${real}; for a sign-up pass generatePassword: true, or pass text`,
			});
			await perform(runtime, browserId, { kind: "click", selector: "#go" });
			await waitUntil("the first form post", () => fixture.submissions().length, (count) => count === 1);

			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/spoofed", "localhost") });
			await perform(runtime, browserId, { kind: "type", selector: "#pass", text: "literal" });
			await perform(runtime, browserId, { kind: "click", selector: "#go" });
			await waitUntil("the second form post", () => fixture.submissions().length, (count) => count === 2);

			expect(fixture.submissions()).toEqual([
				{ user: "", pass: "" },
				{ user: "", pass: "literal" },
			]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a saved password the page reveals as text never comes back in a snapshot, state or act result",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "act-reveal", viewport: VIEWPORT });
			const saved = "Revealed-Pw_3#fixture";
			await writeFile(join(rootDir, "profiles", "act-reveal", "credentials.json"), JSON.stringify({ version: 1, origins: { [new URL(fixture.url("/")).origin]: saved } }));
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/revealable") });
			await perform(runtime, browserId, { kind: "type", selector: "#pass", useSavedPassword: true });

			const shown = await runtime.act(browserId, { kind: "click", selector: "#show" });
			const { text } = await waitUntil("the revealed field in the snapshot", () => runtime.snapshot(browserId), (read) => read.text.includes("#pass (text)"));

			expect(text).toContain(`#pass (text) "[saved password]"`);
			expect(JSON.stringify([shown, text, await runtime.state(browserId)])).not.toContain(saved);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a cross-origin iframe's form is in the snapshot under @1~<tag>; type, click and insert reach it, and ITS origin picks the saved password, never the top page's",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "act-framed", viewport: VIEWPORT });
			const top = new URL(fixture.url("/")).origin;
			const framed = new URL(fixture.url("/", "localhost")).origin;
			// Both origins have one; only the iframe's may ever go into the iframe.
			await writeFile(
				join(rootDir, "profiles", "act-framed", "credentials.json"),
				JSON.stringify({ version: 1, origins: { [top]: "top-page-password", [framed]: "iframe-password" } }),
			);
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/framed") });
			const loaded = await waitUntil("the iframe's form in the snapshot", async () => (await runtime.snapshot(browserId)).text, (text) => FORM_IN_FRAME.test(text));
			let f = frameRef(loaded);
			expect(loaded).toContain(`## frame ${f}: fixture form`);
			expect(loaded).toContain(`${framed}/`);
			expect(loaded).toMatch(new RegExp(`^${f} #user \\(text\\) "user" @\\d+,\\d+$`, "m"));

			await perform(runtime, browserId, { kind: "type", selector: `${f} #user`, text: "ada" });
			const typed = await runtime.act(browserId, { kind: "type", selector: `${f} #pass`, useSavedPassword: true });
			expect({ status: typed.status, credential: typed.credential }).toEqual({ status: "completed", credential: { origin: framed, created: false } });
			await perform(runtime, browserId, { kind: "click", selector: `${f} #go` });
			await waitUntil("the iframe's form post", () => fixture.submissions().length, (count) => count === 1);

			// insert goes wherever focus is: here, the iframe's password field.
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/framed") });
			f = frameRef(await waitUntil("the reloaded iframe's form", async () => (await runtime.snapshot(browserId)).text, (text) => FORM_IN_FRAME.test(text)));
			await perform(runtime, browserId, { kind: "click", selector: `${f} #pass` });
			const inserted = await runtime.act(browserId, { kind: "insert", useSavedPassword: true });
			expect(inserted.credential).toEqual({ origin: framed, created: false });
			await perform(runtime, browserId, { kind: "press", key: "Enter" });
			await waitUntil("the second iframe post", () => fixture.submissions().length, (count) => count === 2);

			// Literal text into the frame, then its submit.
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/framed") });
			f = frameRef(await waitUntil("the third iframe form", async () => (await runtime.snapshot(browserId)).text, (text) => FORM_IN_FRAME.test(text)));
			await perform(runtime, browserId, { kind: "type", selector: `${f} #pass`, text: "typed-in-frame" });
			await perform(runtime, browserId, { kind: "click", selector: `${f} #go` });
			await waitUntil("the third iframe post", () => fixture.submissions().length, (count) => count === 3);

			expect(fixture.submissions()).toEqual([
				{ user: "ada", pass: "iframe-password" },
				{ user: "", pass: "iframe-password" },
				{ user: "", pass: "typed-in-frame" },
			]);
			// The top page stayed put: the posts went from inside the iframe.
			expect((await runtime.state(browserId)).url).toBe(fixture.url("/framed"));
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"generatePassword mints a password for the FRAME's origin, saves it, types it and never returns it; a retry reuses it, useSavedPassword logs in with it, and a non-password field is refused with nothing saved",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "act-generate", viewport: VIEWPORT });
			const store = join(rootDir, "profiles", "act-generate", "credentials.json");
			const saved = (): Record<string, string> => (existsSync(store) ? JSON.parse(readFileSync(store, "utf8")).origins : {});
			const framed = new URL(fixture.url("/", "localhost")).origin;
			const openForm = async (): Promise<string> => {
				await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/framed") });
				return frameRef(await waitUntil("the iframe's form", async () => (await runtime.snapshot(browserId)).text, (text) => FORM_IN_FRAME.test(text)));
			};

			// Not a password field: refused before anything is minted or typed.
			let f = await openForm();
			const refused = await runtime.act(browserId, { kind: "type", selector: `${f} #user`, generatePassword: true });
			expect(refused.status).toBe("failed");
			expect(refused.error).toContain("generatePassword types only into a password field");
			expect(saved()).toEqual({});

			// Sign-up: minted for the iframe's origin (never the top page's), replacing what the field held.
			await perform(runtime, browserId, { kind: "type", selector: `${f} #pass`, text: "stale-" });
			const signup = await runtime.act(browserId, { kind: "type", selector: `${f} #pass`, generatePassword: true });
			expect({ status: signup.status, credential: signup.credential }).toEqual({ status: "completed", credential: { origin: framed, created: true } });
			expect(Object.keys(saved())).toEqual([framed]);
			const password = saved()[framed] as string;
			expect(password).toMatch(/^.{20}$/);
			const snapshot = await runtime.snapshot(browserId);
			expect(JSON.stringify([signup, snapshot, await runtime.state(browserId)])).not.toContain(password);
			await perform(runtime, browserId, { kind: "click", selector: `${f} #go` });
			await waitUntil("the sign-up post", () => fixture.submissions().length, (count) => count === 1);

			// A retried sign-up reuses the saved one (the account it made keeps its password).
			f = await openForm();
			await perform(runtime, browserId, { kind: "click", selector: `${f} #pass` });
			const retried = await runtime.act(browserId, { kind: "insert", generatePassword: true });
			expect(retried.credential).toEqual({ origin: framed, created: false });
			await perform(runtime, browserId, { kind: "press", key: "Enter" });
			await waitUntil("the retried post", () => fixture.submissions().length, (count) => count === 2);

			// Login later: the saved one.
			f = await openForm();
			const login = await runtime.act(browserId, { kind: "type", selector: `${f} #pass`, useSavedPassword: true });
			expect(login.credential).toEqual({ origin: framed, created: false });
			await perform(runtime, browserId, { kind: "click", selector: `${f} #go` });
			await waitUntil("the login post", () => fixture.submissions().length, (count) => count === 3);

			// The View never generates.
			expect(await failureCode(() => runtime.act(browserId, { kind: "insert", generatePassword: true }, "app"))).toBe("bad_action");

			expect(fixture.submissions().map((post) => post.pass)).toEqual([password, password, password]);
			expect(saved()).toEqual({ [framed]: password });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a frame ref from before an earlier sibling iframe went away is refused, and nothing is typed into the frame that took its index",
		async () => {
			const fixture = startFixture();
			const { runtime } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "act-frame-shift", viewport: VIEWPORT });
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/three-frames") });
			const bothForms = /^@2~[0-9a-f]{8} #user /m;
			const before = await waitUntil("both form iframes in the snapshot", async () => (await runtime.snapshot(browserId)).text, (text) => bothForms.test(text) && /^@3~[0-9a-f]{8} #user /m.test(text));
			const second = frameRef(before, "2");

			// The ad goes: the frame at index 2 is now the one that was @3, another site.
			await perform(runtime, browserId, { kind: "click", selector: "#drop" });
			await waitUntil("the ad gone", async () => (await runtime.snapshot(browserId)).text, (text) => !/^@3~/m.test(text));
			const stale = await runtime.act(browserId, { kind: "type", selector: `${second} #user`, text: "ada" });

			expect(stale.status).toBe("failed");
			expect(stale.error).toContain("frame changed");
			expect(stale.error).toContain("take a new browser_snapshot");
			const after = (await runtime.snapshot(browserId)).text;
			expect(after).not.toContain(`"ada"`);
			// The ref for the same frame, re-read, still reaches it.
			const again = frameRef(after, "1");
			expect(again.split("~")[1]).toBe(second.split("~")[1]);
			expect((await runtime.act(browserId, { kind: "type", selector: `${again} #user`, text: "ada" })).status).toBe("completed");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a page that moves focus off the password field right after it takes focus still gets the saved password in that field, never in the one it moved to",
		async () => {
			const fixture = startFixture();
			const { runtime, rootDir } = await createRuntime();
			const { browserId } = await runtime.open({ profile: "act-thief", viewport: VIEWPORT });
			const saved = "Thief-Pw_4#fixture";
			await writeFile(join(rootDir, "profiles", "act-thief", "credentials.json"), JSON.stringify({ version: 1, origins: { [new URL(fixture.url("/")).origin]: saved } }));
			await perform(runtime, browserId, { kind: "navigate", url: fixture.url("/focus-thief") });

			const typed = await runtime.act(browserId, { kind: "type", selector: "#pass", useSavedPassword: true });
			await perform(runtime, browserId, { kind: "click", selector: "#go" });
			await submissionLanded(runtime, browserId, fixture);

			expect(typed.status).toBe("completed");
			expect(fixture.submissions()).toEqual([{ user: "", pass: saved, decoy: "" }]);
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
