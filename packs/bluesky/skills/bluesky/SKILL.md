---
name: bluesky
description: Research and post on Bluesky with eleven tools - authenticated post search, posts with their numbers, threads, quotes, profiles, an account's posts, custom feeds, starter packs, trends, your notifications, and publishing a board-approved post or thread. Use when the user asks what Bluesky says about a topic, how a Bluesky post or account is doing, which feeds or starter packs a niche reads, what needs a reply on Bluesky, or to post an approved Bluesky draft.
---

# Bluesky

Bluesky runs on the open AT Protocol. Most reads are public and keyless
(`public.api.bsky.app`); post search and notifications need the account the
person connected on the Bluesky card with a handle and an app password. The
plugin signs in once, keeps the session on this machine and refreshes it rather
than signing in again (Bluesky limits sign-ins: 30 per 5 minutes and 300 a day
documented, fewer observed).

## Tools

| Tool | Account | Use it for |
|---|---|---|
| `bluesky_search_posts` | yes | Topic research. `sort` top or latest, `since`/`until`, `author`, `mentions`, `lang`, `domain`, `url`, `tags`; the query also takes `from:`, `mentions:`, `domain:`, `lang:`, `"phrase"`, `#tag`, `-word`. The hit estimate (capped at 10,000) sizes a niche. |
| `bluesky_get_posts` | no | Up to 25 posts by link with likes, reposts, replies, quotes and bookmarks. |
| `bluesky_thread` | no | A post with its parents and replies. |
| `bluesky_quotes` | no | Who quoted a post and what they said. |
| `bluesky_profile` | no | Followers, follows, posts, join date, bio, labels, and how many starter packs, feeds and lists the account made. |
| `bluesky_author_feed` | no | One account's recent posts with numbers: measure the brand's posts or study a peer. |
| `bluesky_find_feeds` | no | Custom feeds on a topic, most liked first. |
| `bluesky_find_starter_packs` | no | Starter packs by name, with joins this week and all time. |
| `bluesky_trends` | no | What is trending now. |
| `bluesky_my_notifications` | yes | Mentions, replies and quotes by default (`reasons` adds likes, reposts, follows, starter-pack joins). Never marks them read. |
| `bluesky_publish` | yes | Posts a `bluesky-post` draft the person approved on the board. |

## Search traps

- Handles in operators are lowercase. `mentions:` matches real mentions only;
  search `"@handle"` for the text. `to:` is only an alias of `mentions:`.
- There is no OR and no engagement filter; run two searches instead.
- `bluesky_find_feeds` and `bluesky_trends` use endpoints Bluesky marks
  unstable; if one fails, read the feed or trend page with the Browser pack.

## Numbers

Bluesky has no impressions, views or profile visits, so no tool can show them.
Per post: likes, reposts, replies, quotes, bookmarks. Per account: followers and
posts. Per starter pack: joins. Clicks come only from a UTM-tagged link read in
the brand's own analytics.

## Publishing

`bluesky_publish` takes the board's `draftId` and the approved option exactly as
the board holds it: `posts` in order and `media` (`{ path, post, alt }`, images
only). It refuses with `publish_unapproved`, posting nothing, unless the board's
approval covers this exact text, these images and this account. It then asks the
person on an approval card in every mode, uploads images (PNG, JPEG, WebP, under
2 MB each, metadata stripped), turns links, `@handles` and `#tags` into rich
text, adds a link card for a post with a link and no image, and chains a thread
as replies. The receipt is one `bsky.app` link per post; record the first with
`draft_posted`.

- "already used" means the post may be up: check `bluesky_author_feed`, never
  post it again.
- "expired" means the person presses Retry on the board.
- Video and documents are posted by the person in the app.
- It never replies to other people's posts, likes, reposts or follows: Bluesky's
  developer guidelines bar automated interactions that notify people.
