/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an agent that can list profiles
 *  is handed a cookie, a saved password, a folder path or another chat's browser
 *  id — the one list every agent in every space may read; or it is told a
 *  profile is free when a person is typing in it, or signed in to a site it was
 *  last seen on a month ago; or the human's own Chrome or a throwaway browser
 *  shows up as a profile an agent could try to use.
 *
 *  `browser_profiles` answers from what is on disk (the folder names, each
 *  `profile.json`, each `connections.json`) and names every field it returns.
 *  Holders come from real Chrome browsers opened under different host stamps.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { ProfileListing } from "../src/contracts";
import { MAX_PROFILES_FOR_MODEL, profilesForModel } from "../src/profile-list";
import { SIGNED_IN_MAX_AGE_MS } from "../src/profile-meta";
import { BrowserRuntimeError, ProfileStore } from "../src/store";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, teardown } from "./fixture";

const VIEWPORT = { width: 640, height: 480 };
const NOW = Date.now();

afterEach(teardown, BROWSER_TEST_TIMEOUT_MS);

async function rootWith(seed: (store: ProfileStore) => void): Promise<{ rootDir: string; store: ProfileStore }> {
	const rootDir = await createRoot();
	const store = new ProfileStore(rootDir);
	seed(store);
	return { rootDir, store };
}

const codeOf = async (work: Promise<unknown>): Promise<{ code: string; message: string }> => {
	const error = await work.then(
		() => undefined,
		(thrown: unknown) => thrown,
	);
	if (!(error instanceof BrowserRuntimeError)) throw new Error("expected the open to be refused");
	return { code: error.code, message: error.message };
};

describe("what the list says about each profile", () => {
	test("name, label, colour, who holds it, and the sites it was checked on — a profile with no metadata still has all of them", async () => {
		const { rootDir } = await rootWith((store) => {
			store.saveMeta("work", { label: "Work", colour: "blue", avatar: "💼" });
			store.recordConnection("work", "google.com", { signedIn: true, account: "work@acme.com", observedAt: NOW - 60_000 });
			store.recordConnection("work", "x.com", { signedIn: true, account: "@acmeco", observedAt: NOW - 1_000 });
			store.recordConnection("work", "reddit.com", { signedIn: false, observedAt: NOW - 120_000 });
			store.ensureProfile("legacy");
		});
		const list = await newRuntime(rootDir).profileList();
		expect(list.map((profile) => profile.name)).toEqual(["legacy", "work"]);
		expect(list[0]).toEqual({ name: "legacy", label: "legacy", colour: list[0]?.colour as ProfileListing["colour"], heldBy: null, sites: [] });
		// Newest look first; the account only where the page named one; times as ISO text.
		expect(list[1]).toEqual({
			name: "work",
			label: "Work",
			colour: "blue",
			avatar: "💼",
			heldBy: null,
			sites: [
				{ site: "x.com", account: "@acmeco", signedIn: true, seenAt: new Date(NOW - 1_000).toISOString() },
				{ site: "google.com", account: "work@acme.com", signedIn: true, seenAt: new Date(NOW - 60_000).toISOString() },
				{ site: "reddit.com", signedIn: false, seenAt: new Date(NOW - 120_000).toISOString() },
			],
		});
	});

	test("an observation over seven days old is never claimed — its account and time are still said, so the agent can ask the human", async () => {
		const { rootDir } = await rootWith((store) => {
			store.recordConnection("work", "x.com", { signedIn: true, account: "@old", observedAt: NOW - SIGNED_IN_MAX_AGE_MS - 60_000 });
			store.recordConnection("work", "reddit.com", { signedIn: true, account: "u/fresh", observedAt: NOW - SIGNED_IN_MAX_AGE_MS + 3_600_000 });
			store.recordConnection("work", "linkedin.com", { signedIn: false, observedAt: NOW - SIGNED_IN_MAX_AGE_MS - 60_000 });
		});
		const [work] = await newRuntime(rootDir).profileList();
		const bySite = Object.fromEntries((work?.sites ?? []).map((site) => [site.site, site]));
		expect(bySite["x.com"]).toMatchObject({ signedIn: null, account: "@old" });
		expect(bySite["reddit.com"]).toMatchObject({ signedIn: true, account: "u/fresh" });
		expect(bySite["linkedin.com"]?.signedIn).toBeNull();
	});

	test("a site that was only visited is the human's history, not the agent's: left out; an account over 256 bytes is omitted, not cut", async () => {
		const { rootDir } = await rootWith((store) => {
			store.recordConnection("work", "bbc.co.uk", { signedIn: null, observedAt: NOW });
			store.recordConnection("work", "x.com", { signedIn: true, account: "é".repeat(129), observedAt: NOW });
		});
		const [work] = await newRuntime(rootDir).profileList();
		expect(work?.sites).toEqual([{ site: "x.com", signedIn: true, seenAt: new Date(NOW).toISOString() }]);
	});

	test("the human's own Chrome (relay) and the throwaway browsers are not profiles, and a folder that is not a profile name is not one either", async () => {
		const { rootDir, store } = await rootWith((s) => {
			s.recordConnection("relay", "x.com", { signedIn: true, account: "@me", observedAt: NOW });
			s.ensureProfile("work");
		});
		mkdirSync(join(rootDir, "ephemeral", "abc123", "chrome"), { recursive: true });
		mkdirSync(join(store.profilesRoot, "Not A Profile"), { recursive: true });
		const list = await newRuntime(rootDir).profileList();
		expect(list.map((profile) => profile.name)).toEqual(["work"]);
		expect(JSON.stringify(list)).not.toMatch(/relay|ephemeral|abc123|@me/);
	});

	test("a model is sent the profiles in use and the signed-in ones first when there are more than it should carry, and told how many were left out", () => {
		const profile = (name: string, over: Partial<ProfileListing> = {}): ProfileListing => ({ name, label: name, colour: "blue", heldBy: null, sites: [], ...over });
		const many = Array.from({ length: MAX_PROFILES_FOR_MODEL + 10 }, (_, i) => profile(`p-${String(i).padStart(2, "0")}`));
		many[45] = profile("p-45", { heldBy: "human" });
		many[44] = profile("p-44", { sites: [{ site: "x.com", signedIn: true, seenAt: "2026-10-01T00:00:00.000Z" }] });
		const sent = profilesForModel(many);
		expect(sent.profiles).toHaveLength(MAX_PROFILES_FOR_MODEL);
		expect(sent.omitted).toBe(10);
		expect(sent.profiles.map((p) => p.name)).toContain("p-45");
		expect(sent.profiles.map((p) => p.name)).toContain("p-44");
		expect(sent.profiles.map((p) => p.name)).toEqual([...sent.profiles.map((p) => p.name)].sort());
		expect(profilesForModel(many.slice(0, 5))).toEqual({ profiles: many.slice(0, 5) });
	});

	test("what a model is sent leaves out every site's account, under the cap and over it — the listing itself keeps it for the person — and keeps the site, its state, its time and who holds the profile", () => {
		const seenAt = "2026-10-01T00:00:00.000Z";
		const site = (name: string, account?: string, signedIn: boolean | null = true): ProfileListing["sites"][number] => ({ site: name, ...(account === undefined ? {} : { account }), signedIn, seenAt });
		const mine: ProfileListing = {
			name: "work",
			label: "Work",
			colour: "blue",
			heldBy: "another chat",
			sites: [site("google.com", "work@acme.com"), site("x.com", "@acmeco", null), site("reddit.com", undefined, false)],
		};
		const sent = profilesForModel([mine]);
		expect(sent.profiles).toEqual([
			{
				name: "work",
				label: "Work",
				colour: "blue",
				heldBy: "another chat",
				sites: [
					{ site: "google.com", signedIn: true, seenAt },
					{ site: "x.com", signedIn: null, seenAt },
					{ site: "reddit.com", signedIn: false, seenAt },
				],
			},
		]);
		// The person's copy is not touched.
		expect(mine.sites[0]).toEqual(site("google.com", "work@acme.com"));

		const many = Array.from({ length: MAX_PROFILES_FOR_MODEL + 3 }, (_, i): ProfileListing => ({ ...mine, name: `p-${String(i).padStart(2, "0")}` }));
		const capped = profilesForModel(many);
		expect(capped.omitted).toBe(3);
		expect(JSON.stringify(capped)).not.toMatch(/acme|@/);
	});
});

describe("what the list never contains", () => {
	/** Values a profile folder holds that no agent may ever read. Every one is unique, so a leak is found by `includes`. */
	interface Secrets {
		cookie: string;
		cookieName: string;
		password: string;
		token: string;
		lockToken: string;
		extra: string;
	}
	const secretsFor = (seed: number): Secrets => ({
		cookie: `COOKIE-${seed}-sid=Zq7kPw9Lr4tVb8eXm2Na`,
		cookieName: `__Secure-3PSID-${seed}`,
		password: `Pw-${seed}-hunter2-Zx81`,
		token: `TOKEN-${seed}-eyJhbGciOi`,
		lockToken: `LOCKTOKEN-${seed}-9d2c`,
		extra: `EXTRA-${seed}-field`,
	});

	function seedProfile(store: ProfileStore, name: string, seed: number): Secrets {
		const secrets = secretsFor(seed);
		const dir = store.ensureProfile(name);
		// Chrome's own folder: cookies, and a login database.
		mkdirSync(join(dir, "chrome", "Default", "Network"), { recursive: true });
		writeFileSync(join(dir, "chrome", "Default", "Network", "Cookies"), `${secrets.cookieName}\0${secrets.cookie}`);
		writeFileSync(join(dir, "chrome", "Default", "Login Data"), secrets.password);
		// The pack's own: saved passwords and the lock of a live holder.
		writeFileSync(join(dir, "credentials.json"), `${JSON.stringify({ version: 1, origins: { "https://example.com": secrets.password } })}\n`);
		writeFileSync(join(dir, "runtime.lock"), `${JSON.stringify({ pid: 2_147_483_000, token: secrets.lockToken, at: new Date().toISOString() })}\n`);
		// Fields no rule allows, in the files the list DOES read: they must not ride along.
		writeFileSync(join(dir, "profile.json"), `${JSON.stringify({ label: `Label ${seed}`, colour: "teal", cookies: secrets.cookie, token: secrets.token, path: dir })}\n`);
		writeFileSync(
			join(dir, "connections.json"),
			`${JSON.stringify({
				sites: {
					"x.com": { signedIn: true, account: `@user${seed}`, observedAt: NOW, cookie: secrets.cookie, token: secrets.token, extra: secrets.extra },
					"reddit.com": { signedIn: false, observedAt: NOW - 5, password: secrets.password },
				},
				cookies: secrets.cookie,
			})}\n`,
		);
		return secrets;
	}

	test("over profiles full of cookies, saved passwords, locks and stray fields: only the named fields, no secret, no path, no id", async () => {
		const { rootDir, store } = await rootWith(() => undefined);
		const all: Secrets[] = [];
		for (let seed = 1; seed <= 12; seed += 1) all.push(seedProfile(store, `profile-${seed}`, seed));
		const list = await newRuntime(rootDir).profileList();
		expect(list).toHaveLength(12);

		const text = JSON.stringify(list);
		for (const secrets of all) for (const secret of Object.values(secrets)) expect(text).not.toContain(secret);
		// No folder, no drive, no separator: nothing here names where anything lives.
		expect(text).not.toContain(rootDir);
		expect(text).not.toMatch(/[\\/]|[A-Za-z]:|chrome|credentials|runtime\.lock|connections\.json|cookie|password|token/i);

		// And nothing outside the named fields, at any depth.
		for (const entry of list) {
			expect(Object.keys(entry)).toEqual(["name", "label", "colour", "heldBy", "sites"]);
			expect(["this chat", "human", "another chat", null]).toContain(entry.heldBy);
			for (const site of entry.sites) expect(Object.keys(site).every((key) => ["site", "account", "signedIn", "seenAt"].includes(key))).toBe(true);
		}
	});
});

describeWithChrome("who holds a profile", () => {
	test(
		"the chat that opened it, the human in a View, another chat — and nobody once it is closed — with no id in any answer",
		async () => {
			const { rootDir } = await rootWith((store) => {
				store.ensureProfile("work");
				store.ensureProfile("personal");
				store.ensureProfile("idle");
			});
			const runtime = newRuntime(rootDir);
			const mine = await runtime.open({ profile: "work", viewport: VIEWPORT }, { caller: "model", session: "s-1" });
			const theirs = await runtime.open({ profile: "personal", viewport: VIEWPORT }, { caller: "app", session: "s-3" });
			await runtime.open({ viewport: VIEWPORT }, { caller: "model", session: "s-1" });
			const heldBy = async (asker?: string) => Object.fromEntries((await runtime.profileList(asker)).map((profile) => [profile.name, profile.heldBy]));

			expect(await heldBy("s-1")).toEqual({ idle: null, personal: "human", work: "this chat" });
			expect(await heldBy("s-2")).toEqual({ idle: null, personal: "human", work: "another chat" });
			// The View in s-3's seat is that chat's own browser: it is "this chat" there.
			expect(await heldBy("s-3")).toEqual({ idle: null, personal: "this chat", work: "another chat" });
			// A call with no host stamp is nobody's chat.
			expect(await heldBy()).toEqual({ idle: null, personal: "human", work: "another chat" });
			for (const id of [mine.browserId, theirs.browserId]) expect(JSON.stringify(await runtime.profileList("s-1"))).not.toContain(id);

			await runtime.close(mine.browserId);
			expect((await heldBy("s-1")).work).toBeNull();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a profile held by another server on this folder is not free either",
		async () => {
			const { rootDir, store } = await rootWith((s) => s.ensureProfile("work"));
			const holder = newRuntime(rootDir);
			await holder.open({ profile: "work", viewport: VIEWPORT }, { caller: "model", session: "s-1" });
			// A second runtime on the same root (another server) sees the lock, not the browser.
			expect(store.heldElsewhere("work")).toBe(true);
			expect((await newRuntime(rootDir).profileList("s-1"))[0]?.heldBy).toBe("another chat");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithChrome("asking for a profile by name", () => {
	test(
		"the same chat gets its own browser back, once or twice at once; anyone else is refused and told whose it is, never its id",
		async () => {
			const { rootDir } = await rootWith((store) => store.ensureProfile("work"));
			const runtime = newRuntime(rootDir);
			const chat = { caller: "model", session: "s-1" } as const;
			const first = await runtime.open({ profile: "work", viewport: VIEWPORT }, chat);
			expect((await runtime.open({ profile: "work", viewport: VIEWPORT }, chat)).browserId).toBe(first.browserId);

			const refused = await codeOf(runtime.open({ profile: "work", viewport: VIEWPORT }, { caller: "model", session: "s-2" }));
			expect(refused.code).toBe("profile_held");
			expect(refused.message).toContain("another chat");
			expect(refused.message).not.toContain(first.browserId);
			// An unstamped call is nobody's chat either.
			expect((await codeOf(runtime.open({ profile: "work", viewport: VIEWPORT }))).code).toBe("profile_held");

			// Parallel tool calls from one chat on a profile that is still starting: one browser.
			const both = await Promise.all([runtime.open({ profile: "fresh", viewport: VIEWPORT }, chat), runtime.open({ profile: "fresh", viewport: VIEWPORT }, chat)]);
			expect(both[1].browserId).toBe(both[0].browserId);
			expect((await runtime.profileList("s-1")).filter((profile) => profile.heldBy === "this chat").map((profile) => profile.name)).toEqual(["fresh", "work"]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"what the refusal says depends on who holds it: the human in the View, or another chat",
		async () => {
			const { rootDir } = await rootWith((store) => store.ensureProfile("personal"));
			const runtime = newRuntime(rootDir);
			await runtime.open({ profile: "personal", viewport: VIEWPORT }, { caller: "app", session: "s-view" });
			const refused = await codeOf(runtime.open({ profile: "personal", viewport: VIEWPORT }, { caller: "model", session: "s-other" }));
			expect(refused.code).toBe("profile_held");
			expect(refused.message).toContain("the human in the View");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a label opens its profile, in any case; the folder keeps its slug and is never renamed",
		async () => {
			const { rootDir, store } = await rootWith((s) => s.saveMeta("acme-work", { label: "Work Account" }));
			const runtime = newRuntime(rootDir);
			const opened = await runtime.open({ profile: "  work ACCOUNT ", viewport: VIEWPORT });
			expect(opened.profile).toBe("acme-work");
			expect(store.list()).toEqual(["acme-work"]);
			// The slug still works.
			await runtime.close(opened.browserId);
			expect((await runtime.open({ profile: "acme-work", viewport: VIEWPORT })).profile).toBe("acme-work");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a name that two profiles answer to by label, or none can be, is refused with the choices — names and labels only — never resolved to the closest",
		async () => {
			const { rootDir } = await rootWith((store) => {
				store.saveMeta("acme", { label: "Team" });
				store.saveMeta("zeta", { label: "team" });
				store.saveMeta("personal", { label: "Personal" });
				store.recordConnection("personal", "x.com", { signedIn: true, account: "@secret_handle", observedAt: NOW });
			});
			const runtime = newRuntime(rootDir);
			const two = await codeOf(runtime.open({ profile: "TEAM", viewport: VIEWPORT }));
			expect(two.code).toBe("profile_ambiguous");
			expect(two.message).toContain("Team (acme)");
			expect(two.message).toContain("team (zeta)");
			// A name no profile has and no slug can be: the list, so the agent can ask the human.
			const none = await codeOf(runtime.open({ profile: "Team Account", viewport: VIEWPORT }));
			expect(none.code).toBe("profile_unknown");
			expect(none.message).toContain("Personal (personal)");
			// Names and labels only: not where anything is signed in.
			expect(`${two.message}${none.message}`).not.toMatch(/secret_handle|x\.com/);
			// Nothing was opened or created by a refusal.
			expect((await runtime.profileList("s-1")).map((profile) => profile.heldBy)).toEqual([null, null, null]);
			expect(JSON.stringify(await runtime.profileList())).not.toContain("team-account");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"an exact slug opens its own profile even when another profile is labelled the same, in any case — `work` and `default` stay openable",
		async () => {
			const { rootDir } = await rootWith((store) => {
				store.ensureProfile("work");
				store.saveMeta("acme", { label: "Work" });
				store.ensureProfile("default");
				store.saveMeta("main", { label: "Default" });
			});
			const runtime = newRuntime(rootDir);
			for (const [name, slug] of [["Work", "work"], ["Default", "default"]] as const) {
				const opened = await runtime.open({ profile: name, viewport: VIEWPORT });
				expect(opened.profile).toBe(slug);
				await runtime.close(opened.browserId);
			}
			// The other profiles are still reachable, by their own slugs.
			expect((await runtime.open({ profile: "acme", viewport: VIEWPORT })).profile).toBe("acme");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a profile still launching is refused to another chat as profile_held, naming the holder — the same refusal as one that is already open",
		async () => {
			const { rootDir } = await rootWith((store) => store.ensureProfile("work"));
			const runtime = newRuntime(rootDir);
			const person = { caller: "app", session: "s-view" } as const;
			const starting = runtime.open({ profile: "work", viewport: VIEWPORT }, person);
			// Same tick: the first open has not finished launching.
			const byChat = await codeOf(runtime.open({ profile: "work", viewport: VIEWPORT }, { caller: "model", session: "s-other" }));
			expect(byChat.code).toBe("profile_held");
			expect(byChat.message).toContain("the human in the View");
			const first = await starting;
			const again = await codeOf(runtime.open({ profile: "work", viewport: VIEWPORT }, { caller: "model", session: "s-other" }));
			// Launching or open, the refusal reads the same.
			expect(again).toEqual(byChat);
			expect(byChat.message).not.toContain(first.browserId);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a valid name that matches nothing is a new profile (an account's first sign-in), as it always was",
		async () => {
			const { rootDir } = await rootWith((store) => store.ensureProfile("work"));
			const runtime = newRuntime(rootDir);
			const created = await runtime.open({ profile: "traction-x-acme", viewport: VIEWPORT });
			expect(created.profile).toBe("traction-x-acme");
			expect((await runtime.profileList()).map((profile) => profile.name)).toEqual(["traction-x-acme", "work"]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
