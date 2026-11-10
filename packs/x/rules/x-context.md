---
alwaysApply: true
description: X (Twitter) connector context
---

You have access to the **x** skill — an X (Twitter) connector with eleven read
tools (`x_me`, `x_mentions`, `x_my_posts`, `x_home_timeline`, `x_search`,
`x_posts_envelope`, `x_get_post`, `x_read_thread`, `x_user_lookup`,
`x_bookmarks`, `x_usage`) and five write tools (`x_post`, `x_thread`,
`x_delete`, `x_bookmark`, `x_dm`). It acts as the connected X account.
`x_posts_envelope` is X's share of a last30days run: call it before the engine
and pass the flags it returns.

- **One lane, billed per call.** Every read and write uses the official X API
  on the user's own developer app: $0.001 per post for owned reads
  (`x_mentions`, `x_my_posts`, `x_bookmarks`), $0.005 per post for `x_search`,
  `x_read_thread`, `x_home_timeline`, `x_get_post`. Set limits deliberately;
  `x_usage` shows reads against the monthly cap.
- **Never read the browser's cookies for X** and never ask for
  `auth_token`/`ct0`. Posts older than 7 days and analytics are read on x.com
  in the Browser pack's signed-in profile, a few page loads per task.
- `x_post`, `x_thread`, `x_delete` and `x_dm` are public or sent for real,
  immediate, attributed to the user, and cannot be silently undone.
- **Programmatic replies are restricted by X policy**: only reply via `x_post
  { replyTo }` when the original author @mentioned or quoted the user.
  Otherwise **draft the reply and let the user send it** — that is always
  allowed and is the default for anything unsolicited. Never auto-reply at
  volume, never mass-DM, never astroturf.
- `x_search` takes the API's operators (`min_likes:`, `min_reposts:`,
  `is:reply`, `has:links`); web spellings (`min_faves:`, `filter:replies`,
  `since:`) are translated and the output names the query sent. Prefer a
  narrow `x_search` over `x_home_timeline` for research.
- **A post containing a URL costs $0.20 instead of $0.015** — 13x. Worth
  mentioning once when the user is posting a link.
- **Like, follow, and quote-post do not exist here** — X removed them from all
  self-serve tiers on 2026-04-20. Never claim to have liked or followed.
- `x_search` and `x_read_thread` only reach the **last 7 days**. Older posts
  are read in the Browser (x.com advanced search); never report "nothing
  found" for a window the API cannot reach.
- Post ids: pass the numeric id or a full `https://x.com/…/status/…` URL —
  both work. Quote ids exactly from tool output; never invent one.
- `x_thread` is **not atomic**. If it fails mid-thread the earlier posts are
  LIVE; the error names how many went out and the last id — resolve that state
  with the user rather than retrying the whole thread.
- On **403**, name the likely cause (no purchased API credits / app permissions
  too low / missing OAuth scope) and point to **Plugins → X → Reconnect** after
  the fix. On **401**, the token is stale — reconnect. On **429**, the rate
  limit is separate from billing; wait rather than retry.
