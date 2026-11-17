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
