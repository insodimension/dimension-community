---
name: x
description: Act on X (Twitter) from the agent — research free (search, threads, your own posts via x.com web GraphQL with your browser cookies) and publish via the official X API v2 (posts, replies, threads, bookmarks, DMs). Use when the user asks to check, search, monitor, summarize, draft for, reply on, or post to X/Twitter.
---

# X (Twitter) connector — free reads, paid writes

Act on the user's X account through fifteen tools. This is an **outbound**
connector — the agent reads mentions/timelines/threads/search and publishes as
the connected account. It is not an inbound bot listening for X events.

**Two lanes, and the split is the whole design.** Research reads go through
x.com's own web GraphQL using the browser cookies the user already has, at
**zero cost**. Every write goes through the official X API v2 on OAuth 2.0,
because posting through cookies gets accounts blocked. `x_usage` reports which
read lane is live at any moment.

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

## Setup — reads need nothing, writes need an app

**For reading: log into x.com in Safari, Chrome, or Firefox. That's it.** The
connector picks the cookies up automatically. If browser extraction can't work
(headless box, locked keychain), set `X_AUTH_TOKEN` and `X_CT0` instead — take
them from your browser's devtools cookie panel for x.com. Run `x_usage` to
confirm which lane is live; it names the exact blocker when the free lane is
unavailable.

**For writing** you need your own X developer app:

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

## Cost model — the two lanes

X went **pay-per-use** on 2026-02-06 and priced reads per post returned, which
makes naive research genuinely expensive: a single 100-result search is $0.50
on the official API. So reads default to the free lane.

### The free lane (reads)

Uses the same endpoint x.com's own web client uses, authenticated with the
user's existing login cookies (auto-extracted from Safari/Chrome/Firefox, or
`X_AUTH_TOKEN`/`X_CT0`). **Setup is "be logged into x.com".** Output is
identical to the official lane plus a `[free lane — this read cost $0]` footer.

|Tool|Free lane|Fallback|
|---|---|---|
|`x_search`|✅ yes|$0.005/post|
|`x_read_thread`|✅ yes|$0.005/post|
|`x_posts_envelope`|✅ yes|refuses unless `allowPaid`|
|`x_my_posts`|✅ yes (`from:` search)|$0.001/post|
|`x_mentions`|fallback only|official first, $0.001/post|
|`x_home_timeline`, `x_get_post`, `x_bookmarks`, `x_user_lookup`, `x_me`|❌|official|

`x_mentions` is deliberately official-FIRST: it reads X's own notification set,
so it is authoritative and complete where a search only approximates. At $0.001
per mention that accuracy costs essentially nothing. It falls back to a free
`@handle` search only when the official call fails, and **says so in the output**
when it does.

If cookies are absent the free lane silently becomes the official one — the
connector degrades to "costs money", never to "broken". Set
`INSO_X_READ_BACKEND=official` to disable it entirely, or `=bird` to pin it.

### The paid lane (writes — always)

|Action|Price|
|---|---|
|Post|**$0.015**|
|Post **containing a URL**|**$0.20**|
|DM send|$0.015|
|Bookmark|$0.005|

Consequences that should change your behavior:

- **Never route a write through the free lane.** It is not a policy in prose —
  the cookie client is built with the search mixin only, so it has no
  `createTweet`/`favoriteTweet` method to call. Don't try to add one: bird's
  author is explicit that posting this way gets accounts blocked fast.
- **A link makes a post 13x more expensive.** Worth saying once when the user is
  posting a URL — not to block them. `x_post` reports the tier it spent.
- **Reads are cheap now, but not free of consequence.** The free lane rides the
  user's real logged-in session. Fetch what was asked for, not a speculative
  sweep, and never poll in a tight loop.
- **Check `x_usage`** to answer "am I being charged for reads?" and to see the
  official monthly cap.
- Rate limits are **separate** from billing on both lanes. A 429 means wait.

## Tools

**Reads**

- `x_me` — the connected account: handle, name, numeric id, counts. Call it to
  confirm identity before any write.
- `x_mentions` — posts mentioning the user, newest first. `limit` (default 20,
  max 100), `cursor`. **The monitoring feed.**
- `x_my_posts` — the user's own recent posts with engagement metrics.
- `x_home_timeline` — reverse-chronological timeline of who they follow.
  Expensive tier.
- `x_search` — public posts from the **last 7 days**. Full operator syntax:
  `from:user`, `to:user`, `#tag`, `url:domain.com`, `-is:retweet`, `lang:en`,
  `min_faves:10`, `"quoted phrase"`. `sort: "top"` is the popular pass (X's
  most-engaged ranking instead of newest first); `since`/`until` (YYYY-MM-DD,
  UTC, `until` exclusive) narrow it to days. Expensive tier — set `limit`
  deliberately.
- `x_posts_envelope` — X's share of a last30days run. Give it the engine's exact
  topic, the plan's X queries, the depth and any `--x-handle`/`--x-related`
  accounts; it runs the newest-posts search, the popular pass (one top-ranked
  page per day of the week), the account calls and up to three discovered
  authors, writes a `last30days-x-posts/1` file, and returns the path plus the
  flags to add (`LAST30DAYS_X_HOST_LANE=1`, `--x-posts`, `--x-related`). It
  only covers the last 7 days of last30days' 30-day window. Without the free
  lane it answers "X not covered" instead of spending, unless `allowPaid`.
- `x_get_post` — one post by id **or URL**: text, author, metrics.
- `x_read_thread` — a whole conversation from any post in it, oldest-first.
  Built on recent search, so it only reaches the last 7 days.
- `x_user_lookup` — a public profile by handle.
- `x_bookmarks` — the user's saved posts.
- `x_usage` — post-read consumption vs the monthly cap.

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
  `x_posts_envelope` first, then run the engine with the flags it returns, so
  last30days never reads browser cookies itself.

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
  the mention/search/post loop covered here.
