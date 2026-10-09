/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a person names a profile "Work
 *  Account" and an agent cannot find it by that name, or "Work" quietly means
 *  two profiles and the agent signs in to the wrong one; a profile made before
 *  labels existed loses its colour on every restart or is renamed on disk; or a
 *  seven-day-old "signed in" is still told to an agent as true.
 *
 *  The slug names the folder and never changes. The label, colour and avatar are
 *  separate, optional, and read from `profile.json` beside `chrome/`.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { effectiveSignedIn, matchProfiles, PROFILE_COLOURS, resolveProfileMeta, SIGNED_IN_MAX_AGE_MS } from "../src/profile-meta";
import { ProfileStore } from "../src/store";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function store(): Promise<ProfileStore> {
	const root = await mkdtemp(join(tmpdir(), "profile-meta-"));
	roots.push(root);
	return new ProfileStore(root);
}

describe("defaults for a profile with no metadata", () => {
	test("the label comes from the slug, the colour is from the palette and never changes for that slug, and there is no avatar", () => {
		const first = resolveProfileMeta("traction-x-acme");
		expect(first.label).toBe("traction-x-acme");
		expect(PROFILE_COLOURS).toContain(first.colour);
		expect(resolveProfileMeta("traction-x-acme")).toEqual(first);
		expect(first).not.toHaveProperty("avatar");
		// The implicit profile has no name of its own.
		expect(resolveProfileMeta("default").label).toBe("Default");
		// Not one colour for everything.
		expect(new Set(["a", "work", "personal", "jobs", "default", "x-me", "zzz", "reddit-1"].map((slug) => resolveProfileMeta(slug).colour)).size).toBeGreaterThan(2);
	});

	test("stored fields win one by one; a stored field that is not valid is dropped, not trusted", () => {
		expect(resolveProfileMeta("work", { label: "  Work   Account ", colour: "teal", avatar: "💼" })).toEqual({ label: "Work Account", colour: "teal", avatar: "💼" });
		const bad = resolveProfileMeta("work", { label: "x".repeat(49), colour: "#ff0000" as never, avatar: "not an emoji" });
		expect(bad.label).toBe("work");
		expect(PROFILE_COLOURS).toContain(bad.colour);
		expect(bad).not.toHaveProperty("avatar");
		expect(resolveProfileMeta("work", { label: "   " }).label).toBe("work");
	});

	test("a profile folder with no profile.json still works and is never renamed; a damaged profile.json is the same as none", async () => {
		const s = await store();
		mkdirSync(s.profileDir("legacy"), { recursive: true });
		mkdirSync(s.profileDir("damaged"), { recursive: true });
		writeFileSync(join(s.profileDir("damaged"), "profile.json"), "{ not json");
		expect(s.meta("legacy")).toEqual({});
		expect(s.meta("damaged")).toEqual({});
		expect(s.list()).toEqual(["damaged", "legacy"]);

		s.saveMeta("legacy", { label: "Old Logins", colour: "red", lastUsed: 5, app: "chrome" });
		expect(s.meta("legacy")).toEqual({ label: "Old Logins", colour: "red", lastUsed: 5, app: "chrome" });
		// Saving a label never moves the folder, and a patch keeps the fields it does not name.
		expect(s.list()).toEqual(["damaged", "legacy"]);
		s.saveMeta("legacy", { lastUsed: 9 });
		expect(s.meta("legacy")).toEqual({ label: "Old Logins", colour: "red", lastUsed: 9, app: "chrome" });
		expect(readdirSync(s.profileDir("legacy")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("what is read back from disk is what the rules allow: unknown keys, a bad colour, a long label and a bad time never survive", async () => {
		const s = await store();
		mkdirSync(s.profileDir("p"), { recursive: true });
		writeFileSync(
			join(s.profileDir("p"), "profile.json"),
			JSON.stringify({ label: "Work", colour: "blue", avatar: "💼", lastUsed: "yesterday", app: "chrome", cookies: "SECRET", path: "C:/x" }),
		);
		expect(s.meta("p")).toEqual({ label: "Work", colour: "blue", avatar: "💼", app: "chrome" });
		writeFileSync(join(s.profileDir("p"), "profile.json"), JSON.stringify({ label: "x".repeat(200), colour: "chartreuse" }));
		expect(s.meta("p")).toEqual({});
	});
});

describe("naming a profile by slug or by label", () => {
	const profiles = [
		{ slug: "work", label: "Work" },
		{ slug: "personal", label: "Personal" },
		{ slug: "work-old", label: "Work (old)" },
	];

	test("the slug or the label matches, ignoring case and spaces", () => {
		expect(matchProfiles("work", profiles)).toEqual([profiles[0]]);
		expect(matchProfiles("  WORK ", profiles)).toEqual([profiles[0]]);
		expect(matchProfiles("work (OLD)", profiles)).toEqual([profiles[2]]);
		expect(matchProfiles("Work   (old)", profiles)).toEqual([profiles[2]]);
		expect(matchProfiles("personal", profiles)).toEqual([profiles[1]]);
	});

	test("no match is empty, never the closest: 'wor', 'Work Account' and a blank match nothing", () => {
		expect(matchProfiles("wor", profiles)).toEqual([]);
		expect(matchProfiles("work account", profiles)).toEqual([]);
		expect(matchProfiles("   ", profiles)).toEqual([]);
	});

	test("an exact slug always names its own profile, whatever another profile is labelled, in any case — no profile can become impossible to open", () => {
		const clash = [
			{ slug: "acme", label: "Work" },
			{ slug: "work", label: "Personal" },
			{ slug: "main", label: "Default" },
			{ slug: "default", label: "Default" },
		];
		for (const name of ["work", "Work", "WORK", "  work "]) expect(matchProfiles(name, clash).map((p) => p.slug)).toEqual(["work"]);
		for (const name of ["default", "Default", "DEFAULT"]) expect(matchProfiles(name, clash).map((p) => p.slug)).toEqual(["default"]);
		// The other profile is still reachable: by its own slug.
		expect(matchProfiles("acme", clash).map((p) => p.slug)).toEqual(["acme"]);
		// One profile whose slug and label are the same word is one match, not two.
		expect(matchProfiles("work", [{ slug: "work", label: "Work" }])).toHaveLength(1);
	});

	test("a label is a name only where no slug is: it opens its profile, and two profiles with one label are both returned so the caller refuses to guess", () => {
		expect(matchProfiles("WORK", [{ slug: "acme", label: "Work" }, { slug: "personal", label: "Personal" }]).map((p) => p.slug)).toEqual(["acme"]);
		const twins = [
			{ slug: "acme", label: "Team" },
			{ slug: "zeta", label: "team" },
			{ slug: "solo", label: "Solo" },
		];
		expect(matchProfiles(" TEAM", twins).map((p) => p.slug)).toEqual(["acme", "zeta"]);
	});
});

describe("how old an observation may be", () => {
	const NOW = 1_790_000_000_000;
	test("signed in is claimed for seven days and not a millisecond longer; so is signed out", () => {
		expect(effectiveSignedIn(true, NOW - SIGNED_IN_MAX_AGE_MS, NOW)).toBe(true);
		expect(effectiveSignedIn(true, NOW - SIGNED_IN_MAX_AGE_MS - 1, NOW)).toBeNull();
		expect(effectiveSignedIn(false, NOW - SIGNED_IN_MAX_AGE_MS - 1, NOW)).toBeNull();
		expect(effectiveSignedIn(false, NOW - 1_000, NOW)).toBe(false);
	});

	test("a site that was visited but never checked is never signed in, however fresh", () => {
		expect(effectiveSignedIn(null, NOW, NOW)).toBeNull();
	});

	test("an observation stamped in the future (a wrong clock, a copied file) is not known, never fresh — a sign-in is not claimed for days that have not happened; a small skew is allowed", () => {
		expect(effectiveSignedIn(true, NOW + 3 * 24 * 3_600_000, NOW)).toBeNull();
		expect(effectiveSignedIn(false, NOW + 3 * 24 * 3_600_000, NOW)).toBeNull();
		expect(effectiveSignedIn(true, NOW + 60_000, NOW)).toBe(true);
		expect(effectiveSignedIn(true, NOW + 60_001, NOW)).toBeNull();
	});
});
