---
name: hackernews
description: Read Hacker News with six keyless tools - search stories and comments (Algolia), read an item and its ranked comment tree, check an account, read the live front page and a rank, list every story for a domain, and watch a launch thread for new comments. Use when the user asks about Hacker News, a Show HN, a launch on HN, or what HN said about a topic, site or product. Read only; it never posts.
---

# Hacker News (read only)

Six tools over Hacker News's two public read APIs: Algolia search
(`hn.algolia.com/api/v1`) and the official Firebase API
(`hacker-news.firebaseio.com/v0`). No account, no key, no cookies. Nothing here
can submit, comment, vote or flag: Hacker News asks for hand-written text, so
the person writes and posts every title, intro and reply themselves.

## Tools

| Tool | Use it for |
|---|---|
| `hn_search` | Stories or comments about a topic, product or competitor. `kind`: story (default), comment, show_hn, ask_hn, front_page, poll, job, all. `author`, `since`/`until` (YYYY-MM-DD), `minPoints`, `minComments`, `sort` relevance or date. |
| `hn_item` | One story or comment by id or `item?id=` URL: points, comment count, `[dead]`/`[deleted]`, link, text, and comments with top-level order equal to HN's own rank. `maxComments` (default 60), `maxDepth` (default 4). |
| `hn_user` | Launch preflight on an account: age in days, karma, story, comment and Show HN counts, and the Show HNs of the last 365 days. Usernames are case-sensitive. |
| `hn_front` | The live `top` (front page), `new`, `best`, `show`, `ask` or `job` list with ranks. `find` gives one item's rank right now, up to 500 deep. |
| `hn_domain` | Every story for a domain (and its subdomains) or for one exact page, newest first: "has this been posted before, and how did it do". |
| `hn_thread_since` | A launch watch: the story's points, comments and rank on top and show, plus the comments after a cursor, oldest first, each with what it replies to. Pass back the `Cursor:` value next time. |

## Search traps

- Algolia fuzzes and prefix-matches bare words, so `hn_search` quotes each word
  by default (`"unreal" "camera"`). Pass `exact: false` for a loose search;
  `-word` excludes and is never quoted.
- The hit count is Algolia's estimate, and one query returns at most 1,000 hits.
  For a long history, walk the window with `since`/`until`.
- Comments carry no points in either API. Judge a comment by its replies and its
  rank in `hn_item`, never by a score.
- To find the thread for a link, use `hn_domain` with the URL, not a text search.
- `hn_thread_since` reads Algolia, which indexes a new comment within about a
  minute. Poll at human pace (every 10-30 minutes during a launch), never in a
  tight loop.

## Limits

Algolia allows about 10,000 requests an hour per IP; the Firebase API states no
limit. A `429` means wait. Dead items and items in the second-chance pool are
read with the Browser pack (`/pool`, `/invited`), not these tools.
