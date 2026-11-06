# X

## What it is

An X (Twitter) connector for your agent over the official X API v2: it reads your mentions, your posts, threads, profiles and the last 7 days of search, and posts, replies, threads, bookmarks and DMs as your account when you approve each one.

## What it contains

- **Sixteen native tools.** Reads: `x_me`, `x_mentions`, `x_my_posts`, `x_home_timeline`, `x_search`, `x_posts_envelope` (X's share of a last30days run), `x_get_post`, `x_read_thread`, `x_user_lookup`, `x_bookmarks`, `x_usage`. Writes: `x_post`, `x_thread`, `x_delete`, `x_bookmark`, `x_dm`.
- **Skill `x`**: the tools, the cost of each call, the search operators, and how to read what the API does not give (older posts, analytics) in the Browser on your own signed-in profile.
- **Rule `x-context`**: always-on guidance for the tools.

## Who can use it

Off by default; turn it on in Plugins. It needs your own X developer app (OAuth 2.0, Native App, callback `http://localhost:53682/callback`) with purchased API credits: every read and write is billed by X.

## Limits and risks

- **Every call costs money.** As of 2026-11-06: $0.001 per post for your own mentions, posts and bookmarks; $0.005 per post for search, threads and timelines; $0.015 a post, $0.20 with a link. `x_usage` shows your reads against the monthly cap.
- **Search reaches 7 days.** Older posts are read on x.com in the Browser.
- **Nothing reads your browser's cookies.** The earlier free read lane, which took x.com cookies from Safari, Chrome or Firefox, was removed on 2026-11-06.
- **Posting, deleting and DMs ask you every time**, in every approval mode; the card shows the exact text and target. X restricts replies sent through the API to posts that mention or quote you.
- **Like, follow and quote-post do not exist**: X removed them from self-serve API tiers on 2026-04-20.

## Build and test

`bun test test/` from this folder (or `bun test packs/x/test` from the marketplace root) runs the approval, envelope and search tests against a stubbed X API.
