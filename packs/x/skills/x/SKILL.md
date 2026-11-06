---
name: x
description: Act on X (Twitter) from the agent through the official X API v2 - read mentions, your own posts, threads, profiles and search the last 7 days, and publish posts, replies, threads, bookmarks and DMs. Every read and write is billed to your own developer app. Use when the user asks to check, search, monitor, summarize, draft for, reply on, or post to X/Twitter.
---

# X (Twitter) connector — the official API, billed per call

Act on the user's X account through sixteen tools. This is an **outbound**
connector — the agent reads mentions/timelines/threads/search and publishes as
the connected account. It is not an inbound bot listening for X events.

**One lane.** Every read and every write goes through the official X API v2 on
the user's own developer app, and X bills each call. Nothing here reads the
browser's cookies. For what the API does not give (posts older than 7 days,
post and account analytics, notifications), read x.com in the Browser pack on
the account's own signed-in profile, at human pace (see "Reading x.com in the
Browser" below).

## Auth shape — OAuth 2.0 PKCE, public client, user context

Posting on X **requires user context**; app-only bearer tokens are rejected on
every write endpoint. So the connector uses OAuth 2.0 authorization-code +
PKCE through the engine's generic connect flow: you supply only a **Client ID**
from your own X developer app, the browser round-trip happens engine-side, and
`{access, refresh, expires, clientId, scopes}` lands at
`~/.config/dimension-x/token.json`. Access tokens live ~2 hours; `index.ts`
refreshes them on demand. **X rotates refresh tokens** — each refresh
invalidates the previous one, so the renewed credential is always persisted.

The connect card mandates app type **"Native App" (public client)**. A
confidential "Web App" client cannot connect: X requires confidential clients
to authenticate the token endpoint with HTTP Basic, which the engine's generic
OAuth executor does not send.

Two ceilings must BOTH be right, and they are different things:

- **App permissions** (developer console) — `Read`, `Read and write`, or
  `Read and write and Direct message`. This is a hard ceiling above scopes: a
  Read-only app cannot post no matter which scope option you chose. Changing
  permissions after connecting requires reconnecting.
- **OAuth scopes** (the connect modal's radio) — `Read only`,
  `Read and post` (default), or `Read, post, and DMs`.

## Setup — your own X developer app

Connect via **Plugins → X → Set up**. The wizard walks it; precisely:

1. Sign in at **console.x.com** as the account the agent will act as. Create a
   Project, then an App inside it.
2. **User authentication settings** → enable OAuth 2.0 → App type **Native
   App**.
3. **Callback URI / Redirect URL**: `http://localhost:53682/callback` —
   verbatim. X validates this string exactly; a different port or a trailing
   slash fails the connect. Port 53682 must be free when you connect (the flow
   refuses to fall back, because a fallback port would be rejected by X).
4. **App permissions**: *Read and write* (add *Direct message* only if you want
   `x_dm`).
5. **Buy API credits.** There is no usable free tier for new developers since
   February 2026 — without credits every call returns 403.
6. **Keys and tokens** → copy the **OAuth 2.0 Client ID** into the form. A
   Native App has no secret.

## Cost model

X went **pay-per-use** on 2026-02-06 and prices reads per post returned, so a
single 100-result search is $0.50.

|Call|Price|
|---|---|
|Owned read: `x_mentions`, `x_my_posts`, `x_bookmarks`|$0.001 per post|
|Other reads: `x_search`, `x_read_thread`, `x_home_timeline`, `x_get_post`, `x_posts_envelope`|$0.005 per post|
|Post|**$0.015**|
|Post **containing a URL**|**$0.20**|
|DM send|$0.015|
|Bookmark|$0.005|

Consequences that should change your behavior:

- **Fetch what was asked for, not a speculative sweep.** Set `limit`
  deliberately; `x_search` prints the query it sent and what the call cost.
- **A link makes a post 13x more expensive.** Worth saying once when the user is
  posting a URL — not to block them. `x_post` reports the tier it spent.
- **Check `x_usage`** for this app's reads against its monthly cap.
- Rate limits are **separate** from billing. A 429 means wait.

## Tools

**Reads**

- `x_me` — the connected account: handle, name, numeric id, counts. Call it to
  confirm identity before any write.
- `x_mentions` — posts mentioning the user, newest first. `limit` (default 20,
  max 100), `cursor`. **The monitoring feed.**
- `x_my_posts` — the user's own recent posts with engagement metrics.
- `x_home_timeline` — reverse-chronological timeline of who they follow.
  Expensive tier.
- `x_search` — public posts from the **last 7 days**, in the API's operator
  syntax: `from:user`, `to:user`, `#tag`, `url:domain.com`, `-is:retweet`,
  `is:reply`, `has:links`, `lang:en`, `min_likes:10`, `min_reposts:5`,
  `"quoted phrase"`. The x.com web spellings are translated before the call
  (`min_faves:` → `min_likes:`, `min_retweets:` → `min_reposts:`,
  `filter:replies` → `is:reply`, `filter:links` → `has:links`, `filter:media` →
  `has:media`, and `since:`/`until:` become the day window); the API rejects the
  web spellings with a 400, and the output names the query actually sent.
  `sort: "top"` is the popular pass (X's most-engaged ranking instead of newest
  first); `since`/`until` (YYYY-MM-DD, UTC, `until` exclusive) narrow it to
  days.
- `x_posts_envelope` — X's share of a last30days run. Give it the engine's exact
  topic, the plan's X queries, the depth, the run's `--x-handle` account
  (`handle`) and any `--x-related` accounts; it runs the newest-posts search, the
  popular pass (one top-ranked page per day of the week), the account calls and
  up to three discovered authors, writes a `last30days-x-posts/1` file, and
  returns the path plus the flags to add (`LAST30DAYS_X_HOST_LANE=1`,
  `--x-posts`, `--x-handle`, `--x-related`). It only covers the last 7 days of
  last30days' 30-day window, and stops at the first failed read, keeping what it
  has as partial. Every read in it is billed: without `allowPaid` it answers "X
  not covered" with a cost estimate; ask the person, and only on their yes call
  it with `allowPaid`, which shows them the estimate again before anything is
  billed.
- `x_get_post` — one post by id **or URL**: text, author, metrics.
- `x_read_thread` — a whole conversation from any post in it, oldest-first.
  Built on recent search, so it only reaches the last 7 days.
- `x_user_lookup` — a public profile by handle.
- `x_bookmarks` — the user's saved posts.
- `x_usage` — this app's post-read consumption vs the monthly cap.

**Writes** — `x_post`, `x_thread`, `x_delete`, and `x_dm` always ask the human
first, in every approval mode (yolo included), and the approval card shows the
exact text, reply target, recipient, or post id. `x_bookmark` is a plain write.

- `x_post` — publish a post, or a reply when `replyTo` is set. Reports the cost
  tier and warns past 280 characters.
- `x_thread` — publish several posts as one self-replying chain. **Not
  atomic**: on a mid-thread failure the earlier posts stay live, and the error
  names exactly how many went out and the last id, so you can continue or clean
  up.
- `x_delete` — delete one of the user's own posts. Irreversible.
- `x_bookmark` — add/remove a bookmark. Private.
- `x_dm` — send a direct message.

Post ids: every tool accepts a **numeric id or a `https://x.com/…/status/…`
URL**, and every read prints the id first. Quote ids exactly; never invent one.

## Usage patterns

- *"What do I need to reply to on X?"* → `x_mentions`, then `x_read_thread` on
  the ones with context worth reading, then **draft replies and show them** —
  see the reply rule below before sending any.
- *"What's the conversation about X this week?"* → `x_search { query: "…
  -is:retweet lang:en", limit: 25 }`, then summarize themes. State the cost if
  the user asks for a big sweep.
- *"How did that post do?"* → `x_my_posts`, or `x_get_post` with the id/URL.
- *"Post this thread"* → draft every post, show the full set, get an explicit
  yes, then `x_thread`.
- *"Track what @someone is saying"* → `x_search { query: "from:someone" }`
  (cheaper and more precise than the home timeline).
- *"What's the community saying this month?"* with last30days → call
  `x_posts_envelope` first (it states the cost and asks), then run the engine
  with the flags it returns, so last30days never reads browser cookies itself.

## Reading x.com in the Browser

The API stops at 7 days of search and at public metrics. For the rest, open
x.com in the Browser pack on the account's own saved profile (the one the user
signed in to; never ask for a password), a few page loads per task, reading
only:

- `https://x.com/search?q=<query>&f=live` — advanced search with the web
  operators (`min_faves:`, `since:`, `until:`), any date since the first post.
- A post's own analytics (`https://x.com/<handle>/status/<id>/analytics`), the
  account's `https://x.com/i/account_analytics`, and
  `https://x.com/notifications`.

Never compose, reply, like or follow from a page: posting is a write, and a
write here goes through `x_post` with the user's confirm, or through the
Browser pack's publish flow where the host uses it.

## Safety

- **Every write is public, immediate, and attributed to the user.** NEVER call
  `x_post`, `x_thread`, `x_delete`, or `x_dm` without confirming the exact
  target and the full final text with the user **in the current turn**. There
  is no draft state on X and no silent undo.
- **The reply rule is a platform policy, not a preference.** Since 2026-02-23
  X permits a *programmatic* reply only when the original author @mentioned or
  quoted the user. Replying to arbitrary posts via the API — even helpfully,
  even one at a time — violates the automation policy and risks the app and the
  account. **Drafting a reply for the user to send themselves is always fine
  and is the default for anything unsolicited.**
- **No astroturf, no mass DMs.** Do not post or DM at volume, do not simulate
  independent voices, do not send unsolicited outreach. If a request implies
  it, say so and offer the honest version instead.
- **Like, follow, and quote-post are not available.** X removed those writes
  from all self-serve tiers on 2026-04-20 — the tools don't exist here. Don't
  claim to have liked or followed anything.
- **Reads cost money and expose real people.** Fetch what was asked for, not a
  speculative sweep "for context".
- **Never read the browser's cookies** for X, and never ask the user for
  `auth_token`/`ct0`. Signed-in reads go through the Browser pack's own profile.
- On a **403**, the cause is almost always one of: no purchased credits, app
  permissions below what the call needs, or a token missing the scope. Say
  which and point to **Plugins → X → Reconnect** after the fix — don't retry
  with different ids.
- On a **401**, the token is the problem. Reconnect; don't guess.

## Deliberate exclusions (and why)

- **Like / follow / quote-post** — removed from all self-serve tiers by X on
  2026-04-20. Not buildable, not stubbed.
- **Media upload** — needs the chunked `media/upload` flow and a local file
  path contract; text-first v1. Add on request.
- **Streaming / filtered stream** — a long-lived connection, not a tool call.
  The autonomy Loop shape (poll `x_mentions` on a schedule, park drafts for
  approval) covers the monitoring need without it.
- **Lists, spaces, communities, analytics** — lower daily-use frequency than
  the mention/search/post loop covered here; analytics are read in the Browser.
- **A cookie read lane** — reading x.com's web endpoint with cookies taken from
  Safari, Chrome or Firefox was removed on 2026-11-06: it read browser cookies
  outside a Browser pack profile.
