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

- **Two lanes: reads are usually FREE, writes always cost.** `x_search`,
  `x_read_thread`, and `x_my_posts` run on x.com's own web endpoint using the
  user's browser cookies at $0 when they're logged into x.com; they fall back
  to the billed official API when cookies are absent. Writes ALWAYS use the
  official API. `x_usage` says which read lane is live.
- **Never try to write through the free lane** — it has no write methods by
  construction, and posting via cookies gets X accounts blocked. If a write
  fails for lack of credits, say so; do not look for a free workaround.
- **Confirm the exact text AND target with the user before every write**
  (`x_post`, `x_thread`, `x_delete`, `x_dm`). Each is public or sent for real,
  immediate, attributed to the user, and cannot be silently undone. Show the
  draft; get an explicit yes in the current turn.
- **Programmatic replies are restricted by X policy**: only reply via `x_post
  { replyTo }` when the original author @mentioned or quoted the user.
  Otherwise **draft the reply and let the user send it** — that is always
  allowed and is the default for anything unsolicited. Never auto-reply at
  volume, never mass-DM, never astroturf.
- **Still billed on the official lane:** `x_home_timeline`, `x_get_post`,
  `x_bookmarks` ($0.005/post for timeline and posts; $0.001 for owned reads),
  and `x_mentions`, which is official-FIRST on purpose because it is
  authoritative — $0.001 per mention buys completeness a search can't match.
  Prefer `x_search` (free) over `x_home_timeline` (billed) for research.
- **A post containing a URL costs $0.20 instead of $0.015** — 13x. Worth
  mentioning once when the user is posting a link.
- **Like, follow, and quote-post do not exist here** — X removed them from all
  self-serve tiers on 2026-04-20. Never claim to have liked or followed.
- `x_search` and `x_read_thread` only reach the **last 7 days**. Older posts
  are not retrievable on this tier; say so rather than reporting "nothing
  found".
- Post ids: pass the numeric id or a full `https://x.com/…/status/…` URL —
  both work. Quote ids exactly from tool output; never invent one.
- `x_thread` is **not atomic**. If it fails mid-thread the earlier posts are
  LIVE; the error names how many went out and the last id — resolve that state
  with the user rather than retrying the whole thread.
- On **403**, name the likely cause (no purchased API credits / app permissions
  too low / missing OAuth scope) and point to **Plugins → X → Reconnect** after
  the fix. On **401**, the token is stale — reconnect. On **429**, the rate
  limit is separate from billing; wait rather than retry.
