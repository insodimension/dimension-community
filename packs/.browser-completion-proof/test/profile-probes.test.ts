/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a person signs in to X in the
 *  Browser View and the signed-in list stays empty until some agent happens to
 *  run a publish check; or the list says "signed in" for a site the person was
 *  only passing through (a guess), or for a session last seen weeks ago; or a
 *  page that shows a saved password in the account spot puts that password into
 *  the list an agent reads.
 *
 *  A probe is two selectors per known site, run by the pack itself after a page
 *  loads in a saved profile and once more as the browser closes. The pure half
 *  (what a look decides) runs on a fake page; the rest runs real Chrome against
 *  local pages that mimic a signed-in or signed-out site, on `*.localhost` names
 *  so one server is several sites. No real site is touched, nothing is typed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { buildConnectionReport } from "../src/connection";
import { type ProbeReader, probeFor, readProbe, SITE_PROBES, type SiteProbe } from "../src/probes";
import { SIGN_IN_SITES } from "../src/dock/sites";
import type { BrowserRuntime } from "../src/runtime";
import { ProfileStore } from "../src/store";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, perform, teardown, waitUntil } from "./fixture";
import { markerProbe, type ProfileSite, SAVED_PASSWORD, shippedProbeOn, startProfileSite } from "./profile-fixture";
import x from "../recipes/x-post.json";

const VIEWPORT = { width: 640, height: 480 };
const sites: ProfileSite[] = [];

afterEach(async () => {
	for (const site of sites.splice(0)) await site.stop();
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

// ---------------------------------------------------------------------------
// What a look decides (a fake page: no browser)
// ---------------------------------------------------------------------------

interface FakePage {
	present?: string[];
	text?: Record<string, string>;
	labels?: Record<string, string>;
	hrefs?: Record<string, string[]>;
}

/** A page as the driver's reads see it. `waits` records the longest wait a look asked for. */
function fakeReader(page: FakePage): ProbeReader & { waits: number[] } {
	const waits: number[] = [];
	const has = (selector: string): boolean => (page.present ?? []).includes(selector);
	return {
		waits,
		waitFor: async ({ selector }, timeoutMs) => {
			waits.push(timeoutMs);
			return has(selector);
		},
		hasElement: async (selector) => has(selector),
		readText: async (selector) => page.text?.[selector] ?? null,
		readLabel: async (selector) => page.labels?.[selector] ?? null,
		linkHrefs: async (selector, limit) => (page.hrefs?.[selector] ?? []).slice(0, limit),
	};
}

const probeOf = (host: string): SiteProbe => probeFor(host) ?? ((): never => { throw new Error(`no probe for ${host}`); })();

describe("what one look at a page decides", () => {
	test("the marker on the page is signed in, with the account the page names (an @handle, not a mention in the display name)", async () => {
		const probe = probeOf("x.com");
		const reader = fakeReader({ present: [probe.signedIn], text: { [x.account]: "Jane (CEO @acme)\n@jane" } });
		expect(await readProbe(reader, probe, "https://x.com/home", 50)).toEqual({ signedIn: true, account: "@jane" });
		// Signed in with no account to read is still signed in, never a guessed account.
		expect(await readProbe(fakeReader({ present: [probe.signedIn] }), probe, "https://x.com/home", 50)).toEqual({ signedIn: true });
	});

	test("no marker on a site's front page or login page is signed out, after waiting for a single-page app to draw it", async () => {
		const probe = probeOf("x.com");
		for (const url of ["https://x.com/", "https://x.com/login", "https://x.com/i/flow/login"]) {
			const reader = fakeReader({});
			expect(await readProbe(reader, probe, url, 1234)).toEqual({ signedIn: false });
			expect(reader.waits).toEqual([1234]);
		}
	});

	test("the look as a browser closes does not wait for a page to draw: it asks the page as it is, once, so a marker that is there is never lost to a timer", async () => {
		const probe = probeOf("x.com");
		const out = fakeReader({});
		expect(await readProbe(out, probe, "https://x.com/", 0)).toEqual({ signedIn: false });
		const inn = fakeReader({ present: [probe.signedIn] });
		expect(await readProbe(inn, probe, "https://x.com/", 0)).toEqual({ signedIn: true });
		expect([...out.waits, ...inn.waits]).toEqual([]);
	});

	test("no marker anywhere else is no verdict at all — a settings page without the nav does not sign anyone out — and costs no waiting", async () => {
		const reader = fakeReader({});
		expect(await readProbe(reader, probeOf("x.com"), "https://x.com/settings/account", 5_000)).toBeUndefined();
		expect(reader.waits).toEqual([]);
		// The marker on such a page is still proof.
		const probe = probeOf("reddit.com");
		expect(await readProbe(fakeReader({ present: [probe.signedIn] }), probe, "https://www.reddit.com/r/x/comments/1/", 50)).toEqual({ signedIn: true });
	});

	test("Google: the email in the account button's label — never the display name, and no email at all is no account", async () => {
		const probe = probeOf("google.com");
		const button = 'a[aria-label^="Google Account"]';
		const email = fakeReader({ present: [button], labels: { [button]: "Google Account: Jane Doe  \n(jane@gmail.com)" } });
		expect(await readProbe(email, probe, "https://www.google.com/", 50)).toEqual({ signedIn: true, account: "jane@gmail.com" });
		const named = fakeReader({ present: [button], labels: { [button]: "Google Account: Jane Doe" } });
		expect(await readProbe(named, probe, "https://www.google.com/", 50)).toEqual({ signedIn: true });
	});

	test("Google: no count of other accounts is taken from the page — a mail body holds any link its sender likes, so `authuser` links, foreign or on Google's own host, add nothing", async () => {
		const probe = probeOf("google.com");
		const button = 'a[aria-label^="Google Account"]';
		const forged = [
			...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((slot) => `https://evil.example/?authuser=${slot}`),
			"https://accounts.google.com/AccountChooser?authuser=10",
			"https://mail.google.com/mail/u/11/?authuser=11",
		];
		// Whatever selector the probe asks for, the page answers with the sender's links.
		const reader = { ...fakeReader({ present: [button], labels: { [button]: "Google Account: Jane Doe (jane@gmail.com)" } }), linkHrefs: async () => forged };
		expect(await readProbe(reader, probe, "https://mail.google.com/mail/u/0/", 50)).toEqual({ signedIn: true, account: "jane@gmail.com" });
	});

	test("Google: the page that adds another account shows no marker and says nothing — adding one never signs the first out", async () => {
		const reader = fakeReader({});
		expect(await readProbe(reader, probeOf("google.com"), "https://accounts.google.com/v3/signin/identifier", 50)).toBeUndefined();
		expect(await readProbe(fakeReader({}), probeOf("google.com"), "https://www.google.com/", 50)).toEqual({ signedIn: false });
	});

	test("Bluesky: the handle is in the profile link's address", async () => {
		const probe = probeOf("bsky.app");
		const reader = fakeReader({ present: [probe.signedIn], hrefs: { [probe.signedIn]: ["https://bsky.app/profile/alice.bsky.social"] } });
		expect(await readProbe(reader, probe, "https://bsky.app/", 50)).toEqual({ signedIn: true, account: "@alice.bsky.social" });
	});

	test("a read that throws leaves the verdict and drops the account: never a guess", async () => {
		const probe = probeOf("x.com");
		const reader = { ...fakeReader({ present: [probe.signedIn] }), readText: async () => { throw new Error("Execution context was destroyed"); } };
		expect(await readProbe(reader, probe, "https://x.com/home", 50)).toEqual({ signedIn: true });
	});
});

describe("one list of sites", () => {
	test("every site the dock can sign in to has a probe, and every probe is for a site the dock offers", () => {
		expect(SITE_PROBES.map((probe) => probe.host).sort()).toEqual(SIGN_IN_SITES.map((site) => site.host).sort());
		expect(SITE_PROBES.map((probe) => probe.host)).toContain("google.com");
	});
});

// ---------------------------------------------------------------------------
// The same, in real Chrome, with nobody driving
// ---------------------------------------------------------------------------

interface Rig {
	site: ProfileSite;
	rootDir: string;
	runtime: BrowserRuntime;
	store: ProfileStore;
	/** Resolves once a look has finished on `url`: the product's own signal, so "nothing was recorded" is a fact, not a wait. */
	lookedAt(url: string): Promise<unknown>;
}

async function setup(table: readonly SiteProbe[], extra: { recordVisit?: (url: string) => boolean; settleMs?: number } = {}): Promise<Rig> {
	const site = startProfileSite();
	sites.push(site);
	const looks: string[] = [];
	const rootDir = await createRoot();
	const runtime = newRuntime(rootDir, {
		probes: { table, settleMs: extra.settleMs ?? 300, looked: (url) => looks.push(url), ...(extra.recordVisit ? { recordVisit: extra.recordVisit } : {}) },
	});
	return { site, rootDir, runtime, store: new ProfileStore(rootDir), lookedAt: (url) => waitUntil(`a look at ${url}`, () => looks, (seen) => seen.includes(url)) };
}

const HUMAN = { caller: "app", session: "s-human" } as const;
const sitesOf = async (runtime: BrowserRuntime, profile: string) => (await runtime.profileList()).find((entry) => entry.name === profile)?.sites ?? [];

describeWithChrome("a sign-in the person makes in the View", () => {
	test(
		"shows up in the list with no agent doing anything: two profiles, a signed-in page and a signed-out one",
		async () => {
			const { site, runtime } = await setup([markerProbe("in.localhost"), markerProbe("out.localhost")]);
			const work = await runtime.open({ profile: "work", viewport: VIEWPORT }, HUMAN);
			const personal = await runtime.open({ profile: "personal", viewport: VIEWPORT }, HUMAN);
			// What the View's own navigation does; no publish check, no tool an agent calls.
			await perform(runtime, work.browserId, { kind: "navigate", url: site.url("in.localhost", "/signed-in") });
			await perform(runtime, personal.browserId, { kind: "navigate", url: site.url("out.localhost", "/") });

			const seenWork = await waitUntil("work's sign-in", () => sitesOf(runtime, "work"), (list) => list.length === 1);
			const seenPersonal = await waitUntil("personal's sign-out", () => sitesOf(runtime, "personal"), (list) => list.length === 1);
			expect(seenWork).toEqual([{ site: "in.localhost", account: "@alice", signedIn: true, seenAt: seenWork[0]?.seenAt as string }]);
			expect(Number.isNaN(Date.parse(seenWork[0]?.seenAt as string))).toBe(false);
			expect(seenPersonal).toEqual([{ site: "out.localhost", signedIn: false, seenAt: seenPersonal[0]?.seenAt as string }]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a page where a missing marker proves nothing records nothing, and a single-page app that draws its nav late is signed in, not signed out",
		async () => {
			const { site, runtime, lookedAt } = await setup([markerProbe("deep.localhost"), markerProbe("late.localhost", ["/late"])], { settleMs: 1_800 });
			const opened = await runtime.open({ profile: "work", viewport: VIEWPORT }, HUMAN);
			const deep = site.url("deep.localhost", "/deep/page");
			await perform(runtime, opened.browserId, { kind: "navigate", url: deep });
			// The page was looked at (the product says so) and said nothing.
			await lookedAt(deep);
			expect(await sitesOf(runtime, "work")).toEqual([]);

			// `/late` is a login page for this probe, and its marker appears 700 ms after load: waited for, then signed in.
			await perform(runtime, opened.browserId, { kind: "navigate", url: site.url("late.localhost", "/late") });
			const late = await waitUntil("the late marker", () => sitesOf(runtime, "work"), (list) => list.length === 1);
			expect(late[0]).toMatchObject({ site: "late.localhost", signedIn: true, account: "@late" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"done in place, with no page load to look at, it is found when the browser closes",
		async () => {
			const { site, runtime } = await setup([markerProbe("flip.localhost", ["/flip"])]);
			const opened = await runtime.open({ profile: "work", viewport: VIEWPORT }, HUMAN);
			await perform(runtime, opened.browserId, { kind: "navigate", url: site.url("flip.localhost", "/flip") });
			await waitUntil("signed out at first", () => sitesOf(runtime, "work"), (list) => list[0]?.signedIn === false);

			await perform(runtime, opened.browserId, { kind: "click", selector: "#go" });
			// Nothing loaded, so nothing was looked at: still what the last look said.
			expect((await sitesOf(runtime, "work"))[0]?.signedIn).toBe(false);
			await runtime.close(opened.browserId);
			expect(await sitesOf(runtime, "work")).toMatchObject([{ site: "flip.localhost", signedIn: true, account: "@bo" }]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a throwaway browser is never looked at and never listed, even on a page that is signed in",
		async () => {
			const { site, runtime } = await setup([markerProbe("in.localhost")]);
			const throwaway = await runtime.open({ viewport: VIEWPORT }, HUMAN);
			await perform(runtime, throwaway.browserId, { kind: "navigate", url: site.url("in.localhost", "/signed-in") });
			// The reference: a saved profile on the same page is looked at, so the throwaway had its chance.
			const saved = await runtime.open({ profile: "work", viewport: VIEWPORT }, HUMAN);
			await perform(runtime, saved.browserId, { kind: "navigate", url: site.url("in.localhost", "/signed-in") });
			await waitUntil("work's sign-in", () => sitesOf(runtime, "work"), (list) => list.length === 1);
			expect(Object.keys(await runtime.connections())).toEqual(["work"]);
			expect((await runtime.profileList()).map((profile) => profile.name)).toEqual(["work"]);
			expect(JSON.stringify(await runtime.profileList())).not.toContain("ephemeral");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the shipped Google and Bluesky probes read their accounts off pages with the sites' markup; a form control's label is never read",
		async () => {
			const { site, runtime } = await setup([shippedProbeOn("google.com", "g.localhost"), shippedProbeOn("bsky.app", "b.localhost"), { ...markerProbe("ctl.localhost"), account: { from: "label", selector: "#acct", pick: (label: string) => label } }]);
			const opened = await runtime.open({ profile: "work", viewport: VIEWPORT }, HUMAN);
			const seen = async (host: string, path: string) => {
				await perform(runtime, opened.browserId, { kind: "navigate", url: site.url(host, path) });
				return (await waitUntil(`${host}`, () => sitesOf(runtime, "work"), (list) => list.some((entry) => entry.site === host))).find((entry) => entry.site === host);
			};
			// The page also carries a mail body's worth of `authuser` links: none of them is a count.
			expect(await seen("g.localhost", "/google")).toMatchObject({ signedIn: true, account: "jane@gmail.com" });
			expect(await seen("b.localhost", "/bsky")).toMatchObject({ signedIn: true, account: "@alice.bsky.social" });
			const control = await seen("ctl.localhost", "/control");
			expect(control).toMatchObject({ signedIn: true });
			expect(control).not.toHaveProperty("account");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a page that shows a saved password where the account goes never puts it on disk, in the list or in the report",
		async () => {
			const { site, runtime, store } = await setup([markerProbe("pw.localhost")]);
			writeFileSync(join(store.ensureProfile("work"), "credentials.json"), `${JSON.stringify({ version: 1, origins: { "https://example.com": SAVED_PASSWORD } })}\n`);
			const opened = await runtime.open({ profile: "work", viewport: VIEWPORT }, HUMAN);
			await perform(runtime, opened.browserId, { kind: "navigate", url: site.url("pw.localhost", "/pw") });
			const [listed] = await waitUntil("the sign-in", () => sitesOf(runtime, "work"), (list) => list.length === 1);

			expect(listed?.account).toBe("Signed in as [saved password]");
			const everything = JSON.stringify([await runtime.profileList(), buildConnectionReport(await runtime.connections(), await runtime.profileMeta()), store.connections("work")]);
			expect(everything).not.toContain(SAVED_PASSWORD);
			expect(readFileSync(join(store.profileDir("work"), "connections.json"), "utf8")).not.toContain(SAVED_PASSWORD);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithChrome("a site with no probe", () => {
	test(
		"is only visited: not checked, never signed in or out, kept out of an agent's list, and never replacing a check that was made",
		async () => {
			const { site, runtime, store, lookedAt } = await setup([markerProbe("in.localhost")], { recordVisit: () => true });
			store.recordConnection("work", "seen.localhost", { signedIn: true, account: "@kept", observedAt: Date.now() });
			const opened = await runtime.open({ profile: "work", viewport: VIEWPORT }, HUMAN);
			await perform(runtime, opened.browserId, { kind: "navigate", url: site.url("plain.localhost", "/plain") });
			await waitUntil("the visit", () => runtime.connections(), (all) => all.work?.["plain.localhost"] !== undefined);
			expect((await runtime.connections()).work?.["plain.localhost"]).toMatchObject({ signedIn: null });
			expect((await runtime.connections()).work?.["plain.localhost"]).not.toHaveProperty("account");
			// The agent's list is of what was checked.
			expect((await sitesOf(runtime, "work")).map((entry) => entry.site)).toEqual(["seen.localhost"]);
			// A visit to a site that has a check on file does not downgrade it to "visited".
			await perform(runtime, opened.browserId, { kind: "navigate", url: site.url("seen.localhost", "/plain") });
			await lookedAt(site.url("seen.localhost", "/plain"));
			expect((await runtime.connections()).work?.["seen.localhost"]).toMatchObject({ signedIn: true, account: "@kept" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"on loopback, a private name or an IP address is not a visit at all: an agent testing its own app leaves no trace in a profile",
		async () => {
			const { site, runtime, lookedAt } = await setup([markerProbe("in.localhost")]);
			const opened = await runtime.open({ profile: "work", viewport: VIEWPORT }, HUMAN);
			const plain = site.url("plain.localhost", "/plain");
			await perform(runtime, opened.browserId, { kind: "navigate", url: plain });
			await lookedAt(plain);
			await perform(runtime, opened.browserId, { kind: "navigate", url: site.url("in.localhost", "/signed-in") });
			await waitUntil("the check after it", () => sitesOf(runtime, "work"), (list) => list.length === 1);
			expect(Object.keys((await runtime.connections()).work ?? {})).toEqual(["in.localhost"]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
