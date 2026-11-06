import { expect, test } from "bun:test";
import { renderSubredditRules, renderUserAbout } from "../index";

test("a subreddit's profile and every rule are shown so a reply can be checked against them, with no member count", () => {
	const text = renderSubredditRules(
		"unrealengine",
		{
			display_name_prefixed: "r/unrealengine",
			public_description: "Unreal Engine community.\nBe kind.",
			submission_type: "any",
			subreddit_type: "public",
		},
		[
			{
				short_name: "No self-promotion outside Saturday",
				description: "Showcase posts\ngo in the weekly thread.",
				kind: "link",
			},
			{ short_name: "Be civil", kind: "all" },
		],
	);

	expect(text).toBe(
		[
			"r/unrealengine  accepts any posts",
			"Unreal Engine community. Be kind.",
			"",
			"Rules:",
			"1. No self-promotion outside Saturday (links): Showcase posts go in the weekly thread.",
			"2. Be civil",
		].join("\n"),
	);
	expect(text).not.toMatch(/members|online/);
});

test("a subreddit with no listed rules says where else to look", () => {
	const text = renderSubredditRules("tiny", undefined, []);

	expect(text).toBe(
		["r/tiny", "", "Rules:", "(none listed; read the sidebar, wiki and pinned posts in the Browser)"].join("\n"),
	);
});

test("the readiness read gives age in days, karma by kind and whether the email is verified", () => {
	const now = Date.parse("2026-11-06T00:00:00Z");
	const text = renderUserAbout(
		{
			name: "founder",
			created_utc: Date.parse("2026-10-27T00:00:00Z") / 1000,
			link_karma: 3,
			comment_karma: 41,
			has_verified_email: true,
		},
		now,
	);

	expect(text).toBe(
		[
			"u/founder",
			"account since: 2026-10-27 (10 days)",
			"post karma: 3",
			"comment karma: 41",
			"total karma: 44",
			"verified email: yes",
		].join("\n"),
	);
});

test("a suspended account says so and nothing else", () => {
	expect(renderUserAbout({ name: "gone", is_suspended: true }, Date.now())).toBe("u/gone  SUSPENDED");
});
