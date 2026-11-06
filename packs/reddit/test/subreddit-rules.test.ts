import { expect, test } from "bun:test";
import { renderSubredditRules } from "../index";

test("a subreddit's profile and every rule are shown so a reply can be checked against them", () => {
	const text = renderSubredditRules(
		"unrealengine",
		{
			display_name_prefixed: "r/unrealengine",
			subscribers: 312456,
			active_user_count: 812,
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
			"r/unrealengine  312,456 members  812 online  accepts any posts",
			"Unreal Engine community. Be kind.",
			"",
			"Rules:",
			"1. No self-promotion outside Saturday (links): Showcase posts go in the weekly thread.",
			"2. Be civil",
		].join("\n"),
	);
});

test("a subreddit with no listed rules says where else to look", () => {
	const text = renderSubredditRules("tiny", undefined, []);

	expect(text).toBe(["r/tiny", "", "Rules:", "(none listed; read the sidebar and pinned posts)"].join("\n"));
});
