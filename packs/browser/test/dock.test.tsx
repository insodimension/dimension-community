/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the Browser dock panel tells a
 *  person they are signed in where they are not (or names the wrong account),
 *  or its Sign in opens the live Browser View on the wrong profile or the
 *  wrong site, or fires with no session to open it in, or starts a sign-in on
 *  a profile name the server will refuse — or its "Open a page" bar opens a
 *  browser that forgets their logins (or, when they asked for Private, one that
 *  saves them), or opens on an address the browser cannot load.
 *
 *  The panel's data is this pack's own connection report, so every fixture is
 *  built by the server's own `buildConnectionReport` (connection.ts): the two
 *  shapes cannot drift. The component is mounted live on a linkedom document
 *  (`dom-harness.ts`) against a fake host Store that serves one fact and
 *  records every intent.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { buildConnectionReport, type ConnectionObservations } from "../src/connection";
import { defaultColour, effectiveSignedIn } from "../src/profile-meta";
import { BrowserAccounts, type BrowserStoreShape } from "../src/dock/browser-accounts";
import { CONNECTION_KEY, observedAgo, profileRows } from "../src/dock/report";
import { mount, unmountAll } from "./dom-harness";

const T = 1_790_000_000_000;

/** Two profiles, a signed-out site, an account-less site, a site the panel has no login page for, and the human's own Chrome. */
const OBSERVED: ConnectionObservations = {
	work: {
		"x.com": { signedIn: true, account: "@acme", observedAt: T },
		"linkedin.com": { signedIn: false, observedAt: T - 60_000 },
	},
	alt: {
		"reddit.com": { signedIn: true, observedAt: T - 1 },
		"example.org": { signedIn: false, observedAt: T - 2 },
	},
	relay: { "x.com": { signedIn: true, account: "@me", observedAt: T } },
};

/** The host's `PluginConnectionFact` as it would publish this pack's report. */
const FACT = { connected: true, reported: buildConnectionReport(OBSERVED) };

// ---------------------------------------------------------------------------
// The report, as the panel reads it
// ---------------------------------------------------------------------------

describe("profileRows", () => {
	test("a real connection report becomes profiles → sites with signedIn, account and observedAt, both sorted by name", () => {
		expect(profileRows(FACT)).toEqual([
			{
				name: "alt",
				label: "alt",
				colour: defaultColour("alt"),
				sites: [
					{ host: "example.org", signedIn: false, observedAt: T - 2 },
					{ host: "reddit.com", signedIn: true, observedAt: T - 1 },
				],
			},
			{
				name: "work",
				label: "work",
				colour: defaultColour("work"),
				sites: [
					{ host: "linkedin.com", signedIn: false, observedAt: T - 60_000 },
					{ host: "x.com", signedIn: true, account: "@acme", observedAt: T },
				],
			},
		]);
	});

	test("no fact, a fact without a report, and a report with no profiles are all the empty state", () => {
		expect(profileRows(undefined)).toEqual([]);
		expect(profileRows({})).toEqual([]);
		expect(profileRows({ reported: buildConnectionReport({}) })).toEqual([]);
	});

	test("a malformed profile or site in the fact is skipped, never rendered or thrown on; its well-formed neighbours survive", () => {
		const reported = buildConnectionReport(OBSERVED);
		const damaged = {
			reported: {
				profiles: {
					...reported.profiles,
					work: { sites: { ...reported.profiles.work?.sites, "bsky.app": { signedIn: "yes", observedAt: T }, "reddit.com": { signedIn: true, observedAt: "now" } } },
					broken: { sites: null },
					listed: { sites: [{ signedIn: true, observedAt: T }] },
				},
			},
		};
		expect(profileRows(damaged)).toEqual(profileRows(FACT));
		expect(profileRows({ reported: { profiles: [] } })).toEqual([]);
		expect(profileRows("connected")).toEqual([]);
	});
});

describe("observedAgo", () => {
	const cases: ReadonlyArray<{ readonly name: string; readonly ageMs: number; readonly text: string }> = [
		{ name: "a clock a little behind the observation", ageMs: -5_000, text: "just now" },
		{ name: "under a minute", ageMs: 59_000, text: "just now" },
		{ name: "one minute", ageMs: 60_000, text: "1m ago" },
		{ name: "59 minutes", ageMs: 59 * 60_000, text: "59m ago" },
		{ name: "one hour", ageMs: 60 * 60_000, text: "1h ago" },
		{ name: "23 hours", ageMs: 23 * 3_600_000, text: "23h ago" },
		{ name: "one day", ageMs: 24 * 3_600_000, text: "1d ago" },
		{ name: "ten days", ageMs: 240 * 3_600_000, text: "10d ago" },
	];
	for (const { name, ageMs, text } of cases) {
		test(`${name} reads "${text}"`, () => {
			expect(observedAgo(T, T + ageMs)).toBe(text);
		});
	}
});

// ---------------------------------------------------------------------------
// The panel, mounted
// ---------------------------------------------------------------------------

afterEach(unmountAll);
// The panel never claims a sign-in over 7 days old, and these fixtures are dated T: it reads them at that instant.
beforeEach(() => setSystemTime(new Date(T)));
afterEach(() => setSystemTime());

interface Act {
	readonly intent: string;
	readonly payload: unknown;
}

/** A host Store serving `fact` under this pack's connection key only, logging every intent. */
function fakeStore(fact: unknown): { readonly store: BrowserStoreShape; readonly acts: readonly Act[] } {
	const acts: Act[] = [];
	const store: BrowserStoreShape = {
		watch<T>(key: string) {
			return { getSnapshot: () => (key === CONNECTION_KEY ? (fact as T) : undefined), subscribe: () => () => {} };
		},
		act(intent: string, payload?: unknown) {
			acts.push({ intent, payload });
		},
	};
	return { store, acts };
}

async function mountPanel(sessionId: string | null, store: BrowserStoreShape) {
	const dom = await mount(<BrowserAccounts sessionId={sessionId} store={store} />);
	return {
		...dom,
		/** The site line for `label` under profile `profile`. */
		siteLine: (profile: string, label: string): Element => {
			const section = dom.find('[data-slot="browser-accounts-profile"]').filter(el => el.querySelector('[data-slot="browser-accounts-profile-label"]')?.textContent === profile);
			const lines = section.flatMap(el => [...el.querySelectorAll('[data-slot="browser-accounts-site"]')]);
			const matches = lines.filter(line => line.querySelector("span span span")?.textContent === label);
			if (matches.length !== 1) throw new Error(`expected one ${label} line under ${profile}, found ${matches.length}`);
			return matches[0] as Element;
		},
		/** The "Open a page" form, its address field and its Private box. */
		openForm: () => {
			const form = dom.find('[data-slot="browser-accounts-open"]')[0] as Element;
			return {
				form,
				address: form.querySelector('[data-slot="input"]') as Element,
				private: form.querySelector('input[type="checkbox"]') as Element,
				problem: () => form.querySelector('[data-slot="browser-accounts-problem"]')?.textContent ?? null,
			};
		},
	};
}

const signInButton = (line: Element): Element => {
	const button = [...line.querySelectorAll("button")].find(el => el.textContent?.trim() === "Sign in");
	if (!button) throw new Error("no Sign in button on the line");
	return button;
};

const openBrowser = (args: Record<string, string>): Act => ({ intent: "openArtifactoryView", payload: { tool: "browser_view", args } });
const openView = (profile: string, url: string): Act => openBrowser({ profile, url });

describe("the Browser panel", () => {
	test("each site line shows its report state, and its Sign in opens the live View on that profile at that site's login page", async () => {
		const { store, acts } = fakeStore(FACT);
		const panel = await mountPanel("session-1", store);

		const x = panel.siteLine("work", "X");
		expect(x.getAttribute("data-signed-in")).toBe("true");
		expect(x.textContent).toContain("Signed in");
		expect(x.textContent).toContain("@acme");
		const linkedin = panel.siteLine("work", "LinkedIn");
		expect(linkedin.getAttribute("data-signed-in")).toBe("false");
		expect(linkedin.textContent).toContain("Signed out");
		// The human's own Chrome is never a profile here.
		expect(panel.text()).not.toContain("relay");

		await panel.click(signInButton(linkedin));
		await panel.click(signInButton(panel.siteLine("alt", "Reddit")));
		await panel.click(signInButton(panel.siteLine("alt", "example.org")));

		expect(acts).toEqual([
			openView("work", "https://www.linkedin.com/login"),
			openView("alt", "https://www.reddit.com/login"),
			// A site the panel has no login page for opens at the site itself.
			openView("alt", "https://example.org/"),
		]);
	});

	test("a New sign-in opens the View on the typed profile's slug at the chosen site's login page", async () => {
		const { store, acts } = fakeStore(FACT);
		const panel = await mountPanel("session-1", store);
		const form = panel.find('[data-slot="browser-accounts-new"]')[0] as Element;
		const bluesky = [...form.querySelectorAll('[role="radio"]')].find(el => el.textContent === "Bluesky") as Element;

		await panel.click(bluesky);
		await panel.type(form.querySelector("input") as Element, "  Personal ");
		await panel.submit(form);

		expect(acts).toEqual([openView("personal", "https://bsky.app/")]);
	});

	test("a New sign-in starts with no name, and left that way is for the logins the browser itself opens with", async () => {
		const { store, acts } = fakeStore({ connected: true, reported: buildConnectionReport({}) });
		const panel = await mountPanel("session-1", store);
		const form = panel.find('[data-slot="browser-accounts-new"]')[0] as Element;

		expect((form.querySelector("input") as HTMLInputElement).value).toBe("");
		expect(form.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(false);
		await panel.submit(form);

		expect(acts).toEqual([openView("default", "https://x.com/login")]);
	});

	test("picking a set fills the name as the panel labels it, never the slug, and signing in sends its slug", async () => {
		const seen = { "x.com": { signedIn: true, observedAt: T } };
		const { store, acts } = fakeStore({ connected: true, reported: buildConnectionReport({ default: seen, work: seen }) });
		const panel = await mountPanel("session-1", store);
		const form = panel.find('[data-slot="browser-accounts-new"]')[0] as Element;
		const name = form.querySelector("input") as HTMLInputElement;
		const header = (label: string): Element => {
			const found = panel.find('[data-slot="browser-accounts-profile"]').find(el => el.querySelector('[data-slot="browser-accounts-profile-label"]')?.textContent === label)?.querySelector("button");
			if (!found) throw new Error(`no "${label}" set`);
			return found;
		};

		await panel.click(header("Default"));
		const defaultShown = name.value;
		await panel.submit(form);
		await panel.click(header("work"));
		const workShown = name.value;
		await panel.submit(form);

		expect([defaultShown, workShown]).toEqual(["Default", "work"]);
		expect(acts).toEqual([openView("default", "https://x.com/login"), openView("work", "https://x.com/login")]);
	});

	test("a New sign-in on a name profileSlug refuses, or on the reserved relay, acts nothing and gives a different reason for each", async () => {
		const { store, acts } = fakeStore(FACT);
		const panel = await mountPanel("session-1", store);
		const form = panel.find('[data-slot="browser-accounts-new"]')[0] as Element;
		const input = form.querySelector("input") as Element;
		const problem = () => form.querySelector('[data-slot="browser-accounts-problem"]')?.textContent ?? null;

		await panel.type(input, "Bad Name!");
		await panel.submit(form);
		expect(acts).toEqual([]);
		expect(input.getAttribute("aria-invalid")).toBe("true");
		const badChars = problem();
		expect(badChars).toBeTruthy();

		await panel.type(input, "relay");
		await panel.submit(form);
		expect(acts).toEqual([]);
		expect(problem()).toBeTruthy();
		expect(problem()).not.toBe(badChars);
	});

	test("with no session every Sign in and Open is disabled and nothing is acted, and the panel says what to do", async () => {
		const { store, acts } = fakeStore(FACT);
		const panel = await mountPanel(null, store);
		const buttons = panel.find("button").filter(el => el.textContent?.trim() === "Sign in");

		// Four site lines plus the New sign-in submit.
		// Flags, not elements: a failing diff of linkedom nodes never finishes printing.
		expect(buttons.map(el => el.hasAttribute("disabled"))).toEqual([true, true, true, true, true]);
		for (const button of buttons) await panel.click(button);

		const form = panel.find('[data-slot="browser-accounts-new"]')[0] as Element;
		await panel.type(form.querySelector("input") as Element, "work");
		await panel.submit(form);
		const open = panel.openForm();
		await panel.type(open.address, "example.com");
		await panel.submit(open.form);

		expect(acts).toEqual([]);
		expect(open.form.querySelector("button")?.hasAttribute("disabled")).toBe(true);
		expect(panel.find('[data-slot="browser-accounts-hint"]')).toHaveLength(1);
	});

	test("each profile starts with an avatar disc — its emoji when it has one, else its label's first letter in capitals — beside its label", async () => {
		const seen = { "x.com": { signedIn: true, observedAt: T } };
		const meta = { acme: { label: "Work Account", colour: "teal" as const, avatar: "💼" }, side: { label: "side project", colour: "pink" as const } };
		const { store } = fakeStore({ connected: true, reported: buildConnectionReport({ acme: seen, plain: seen, side: seen }, meta) });
		const panel = await mountPanel("session-1", store);

		const sections = panel.find('[data-slot="browser-accounts-profile"]');

		expect(sections.map(el => [el.querySelector('[data-slot="browser-accounts-avatar"]')?.textContent, el.querySelector('[data-slot="browser-accounts-profile-label"]')?.textContent])).toEqual([
			["💼", "Work Account"],
			["P", "plain"],
			["S", "side project"],
		]);
	});
});

describe("what the panel says of a profile and of a site it cannot vouch for", () => {
	test("a profile is shown by its label, and the report carries the label, colour and avatar the agent's list uses", () => {
		const fact = { connected: true, reported: buildConnectionReport({ acme: { "x.com": { signedIn: true, observedAt: T } } }, { acme: { label: "Work Account", colour: "teal", avatar: "💼" } }) };
		expect(profileRows(fact)).toEqual([{ name: "acme", label: "Work Account", colour: "teal", avatar: "💼", sites: [{ host: "x.com", signedIn: true, observedAt: T }] }]);
		// Metadata that crossed the host Store damaged falls back to what the slug gives.
		const damaged = { reported: { profiles: { acme: { label: "x".repeat(99), colour: "chartreuse", avatar: "no", sites: { "x.com": { signedIn: true, observedAt: T } } } } } };
		expect(profileRows(damaged)).toEqual([{ name: "acme", label: "acme", colour: defaultColour("acme"), sites: [{ host: "x.com", signedIn: true, observedAt: T }] }]);
	});

	test("a visited site with no check reads Not checked, and a sign-in last seen over 7 days ago is not claimed either, though its account and age are shown", async () => {
		const old = T - 8 * 24 * 3_600_000;
		const fact = {
			connected: true,
			reported: buildConnectionReport(
				{ acme: { "bbc.co.uk": { signedIn: null, observedAt: T }, "x.com": { signedIn: true, account: "@acme", observedAt: old }, "reddit.com": { signedIn: true, observedAt: T - 1_000 } } },
				{ acme: { label: "Work Account", colour: "blue" } },
			),
		};
		// The rows keep what was observed; the claim is made at the moment of reading, with the same rule the agent's list uses.
		expect(profileRows(fact)[0]?.sites.map((site) => effectiveSignedIn(site.signedIn, site.observedAt, T))).toEqual([null, true, null]);
		const { store } = fakeStore(fact);
		const panel = await mountPanel("session-1", store);
		expect(panel.find('[data-slot="browser-accounts-profile"]').map((el) => el.querySelector('[data-slot="browser-accounts-profile-label"]')?.textContent)).toEqual(["Work Account"]);
		const visited = panel.siteLine("Work Account", "bbc.co.uk");
		expect(visited.textContent).toContain("Not checked");
		expect(visited.hasAttribute("data-signed-in")).toBe(false);
		const stale = panel.siteLine("Work Account", "X");
		expect(stale.textContent).toContain("Not checked");
		expect(stale.textContent).not.toContain("Signed in");
		expect(stale.textContent).toContain("@acme");
		expect(stale.textContent).toContain("8d ago");
		expect(panel.siteLine("Work Account", "Reddit").getAttribute("data-signed-in")).toBe("true");
	});
});

describe("the Browser panel's Open a page bar", () => {
	test("a typed address opens the live browser on the person's saved logins, the address made loadable", async () => {
		const { store, acts } = fakeStore(FACT);
		const panel = await mountPanel("session-1", store);
		const open = panel.openForm();

		await panel.type(open.address, "  example.com/docs ");
		await panel.submit(open.form);

		expect(acts).toEqual([openBrowser({ url: "https://example.com/docs", profile: "default" })]);
	});

	test("Private opens with no profile at all, so nothing is saved", async () => {
		const { store, acts } = fakeStore(FACT);
		const panel = await mountPanel("session-1", store);
		const open = panel.openForm();

		await panel.check(open.private, true);
		await panel.type(open.address, "example.com");
		await panel.submit(open.form);

		// Strict: a `profile` key present with any value, even undefined, is not "no profile".
		expect(acts).toStrictEqual([openBrowser({ url: "https://example.com/" })]);
	});

	test("an empty bar opens a blank browser on the saved logins; a bar that is not an address opens nothing and says why", async () => {
		const { store, acts } = fakeStore(FACT);
		const panel = await mountPanel("session-1", store);
		const open = panel.openForm();

		await panel.submit(open.form);
		expect(acts).toEqual([openBrowser({ profile: "default" })]);

		await panel.type(open.address, "two words");
		await panel.submit(open.form);
		expect(acts).toHaveLength(1);
		expect(open.problem()).toBeTruthy();
		expect(open.address.getAttribute("aria-invalid")).toBe("true");
	});
});
