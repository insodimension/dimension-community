---
description: How the X tools take search operators and post ids, what a thread that fails part way leaves live, and what a 401, 403 or 429 means. Read it before you call an x tool.
onUse: ["x_*"]
---

- `x_search` takes the API's operators (`min_likes:`, `min_reposts:`,
  `is:reply`, `has:links`); web spellings (`min_faves:`, `filter:replies`,
  `since:`) are translated and the output names the query sent. Prefer a
  narrow `x_search` over `x_home_timeline` for research.
- Post ids: pass the numeric id or a full `https://x.com/…/status/…` URL —
  both work. Quote ids exactly from tool output; never invent one.
- `x_thread` is **not atomic**. If it fails mid-thread the earlier posts are
  LIVE; the error names how many went out and the last id — resolve that state
  with the user rather than retrying the whole thread.
- On **403**, name the likely cause (no purchased API credits / app permissions
  too low / missing OAuth scope) and point to **Plugins → X → Reconnect** after
  the fix. On **401**, the token is stale — reconnect. On **429**, the rate
  limit is separate from billing; wait rather than retry.
