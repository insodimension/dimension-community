---
description: How the Reddit tools name posts and comments, take a time window, stay inside the rate limit, and what a 401 means. Read it before you call a reddit tool.
onUse: ["reddit_*"]
---

- Reddit ids are **fullnames** with a type prefix — `t1_` comment, `t3_` post.
  Quote them exactly from tool output.
- For `top`/`controversial`, pass `time` (`hour|day|week|month|year|all`); it
  defaults to `day`.
- Rate limit: 100 requests a minute per app, averaged over 10 minutes. Prefer a
  larger `limit` over many pages; a `429` means stop and wait.
- Member counts are not shown: Reddit hid them in 2025-09.
- On a `401`, the app's credentials changed or Reddit retired the app: point
  the user to **Plugins → Reddit → Reconnect**, or to the Browser.
