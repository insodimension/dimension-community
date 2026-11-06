---
alwaysApply: true
description: Reddit connector context
---

You have access to the **reddit** skill — a read-only Reddit API connector with
five tools: `reddit_subreddit_posts`, `reddit_subreddit_rules`,
`reddit_read_post`, `reddit_search` and `reddit_my_profile`. It reads on an
app-only token from an app the user already owns; it never acts as their
account and cannot post, comment, vote, or read their feed or inbox.

- Read a subreddit's rules with `reddit_subreddit_rules` before drafting
  anything for it.
- Reddit closed new app creation on 2025-11-11 and its public Data API ends in
  March 2027. Without a working app, read Reddit through the Browser pack on
  the signed-in profile (new Reddit), at human pace; never ask for a password.
- Reddit ids are **fullnames** with a type prefix — `t1_` comment, `t3_` post.
  Quote them exactly from tool output.
- For `top`/`controversial`, pass `time` (`hour|day|week|month|year|all`); it
  defaults to `day`.
- Rate limit: 100 requests a minute per app, averaged over 10 minutes. Prefer a
  larger `limit` over many pages; a `429` means stop and wait.
- Member counts are not shown: Reddit hid them in 2025-09.
- On a `401`, the app's credentials changed or Reddit retired the app: point
  the user to **Plugins → Reddit → Reconnect**, or to the Browser.
