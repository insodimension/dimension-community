# Reddit

## What it is

A read-only Reddit connector for your agent: a subreddit's posts and rules, a thread's comments, search, and your public profile, over the Reddit API with an app you already own.

## What it contains

- **Five native tools**: `reddit_subreddit_posts`, `reddit_subreddit_rules`, `reddit_read_post`, `reddit_search`, `reddit_my_profile`.
- **Skill `reddit`**: the tools, Reddit's search operators, the state of the Reddit API, and where to read the rest in the Browser.
- **Rule `reddit-context`**: always-on guidance for the tools.

## Who can use it

Off by default; turn it on in Plugins. It needs the client id and secret of a Reddit app you created before Reddit closed self-service app creation on 2025-11-11, and your username. It never asks for your password: it reads with an app-only token.

## Limits and risks

- **Read-only.** It cannot post, comment, vote, or read your feed or inbox; the earlier write tools and the password sign-in were removed on 2026-11-06.
- **The Reddit API is closing.** Reddit stopped new Data API requests on 2026-10-31; unregistered apps lose access from 2027-01-12 and all public access ends in March 2027. Without a working app, your agent reads Reddit in the Browser on your signed-in profile.
- **Numbers are coarse.** Scores are fuzzed and member counts are hidden (since 2025-09); a comment's views and upvote ratio are on your own Insights, read in the Browser.
- **Rate limit**: 100 requests a minute per app, averaged over 10 minutes.

## Build and test

`bun test test/` from this folder runs the credential-cache and rendering tests against a stubbed Reddit API.
