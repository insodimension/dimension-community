---
name: reddit
description: Act on Reddit from the agent — read your home feed and any subreddit, read a post's comment tree, search, submit posts, comment, vote, and read/reply to your inbox, over the Reddit OAuth API (script app). Use when the user asks to browse, search, summarize, post to, comment on, vote on, or check messages on Reddit.
---

# Reddit (OAuth API connector)

Act on the user's Reddit account through ten tools backed by the Reddit OAuth
API (`https://oauth.reddit.com`). This is an **outbound** connector — the agent
browses feeds and subreddits, reads posts + comment trees, searches, submits
posts, comments, votes, and reads/replies to the inbox as the connected account.
It is not an inbound bot that listens for Reddit events, and it does **not** do
moderation or Reddit Chat (see *Deliberate exclusions* below).

## Auth shape — why a "script" app + your Reddit login

Reddit's OAuth has a "script" app type meant for a developer acting as their own
account. The connector uses the OAuth2 **password grant** with that script app:
you paste the app's **client id/secret** and your **Reddit username/password**,
and `index.ts` exchanges them for a bearer token on demand and caches it in
memory. The credentials are stored only on this machine (never logged).

Why not the browser "Connect with Reddit" (authorization-code) flow? Reddit's
token endpoint requires HTTP **Basic auth** (client id/secret in the header, not
the body) and a unique **User-Agent** on every request — neither of which the
engine's generic OAuth executor sends — and that flow's consent server runs
engine-side, out of this extension's reach. The script-app password grant is the
shape that actually works here. There is **no connection probe**: the token
exchange happens inside `index.ts`, so **the first tool call is the real test**
— a bad app id/secret surfaces as a clear 401, a bad username/password as
`invalid_grant`. Fix and use **Plugins → Reddit → Reconnect**.

## Setup

Connect via **Plugins → Reddit → Set up**. The wizard walks through it; the
manual steps, described precisely:

1. Sign in to Reddit as the account the agent will act as, then open
   **reddit.com/prefs/apps**.
2. Scroll to the bottom and click **"create another app…"**.
3. Give it a **name** (e.g. `Dimension`) and select the **"script"** radio
   button (the three types are *web app*, *installed app*, *script* — pick
   **script**; it's the personal-use type owned by its developer).
4. In **redirect uri** enter `http://localhost:8080`. Script apps never
   redirect, but the field is required. Leave **about url** blank.
5. Click **"create app"**.
6. On the created app's card: the **client ID** is the short string shown
   directly under the app's name (under the label *"personal use script"*); the
   **secret** is the longer string on the *"secret"* line. Copy both.
7. Paste the client id, secret, your **Reddit username** (without `u/`), and
   your **password** into the form. If your account has **2FA** enabled, append
   the current 6-digit code to the password as `password:123456`.

## Tools

- `reddit_my_feed` — your home feed (subscribed subreddits). `sort` =
  `best|hot|new|top|rising` (default `best`); `time` for `top`. Returns
  `fullname  r/sub  score pts  N cmts  age  u/author  title` per line (age is
  `5h ago` or `3d ago`). A post's link is `https://www.reddit.com/comments/<id>`
  (the fullname without `t3_`). Paginate with the printed `after` cursor.
- `reddit_subreddit_posts` — posts in a subreddit. `subreddit` (without `r/`),
  `sort` = `hot|new|top|rising|controversial` (default `hot`), `time` for
  `top`/`controversial`. Same line format; paginate with `after`.
- `reddit_subreddit_rules` — a subreddit's member and online counts, which post
  kinds it accepts, its description and every rule with its text. Read it
  before suggesting or drafting a post or reply there: self-promotion, link and
  flair rules live here.
- `reddit_read_post` — a post + its comment tree. `post` is the id or `t3_`
  fullname (optionally its `subreddit` and comment `sort`). Prints the post
  header/body, then comments as `t1_id  u/author (score): text`, indented by
  reply depth; deep/collapsed branches show `… (N more replies collapsed)`.
- `reddit_search` — search posts. `query`; optional `subreddit` to scope, `sort`
  = `relevance|hot|top|new|comments`, `time`. Returns post lines; paginate with
  `after`.
- `reddit_submit_post` — submit a self (text) or link post. `subreddit`,
  `title`, and **either** `text` **or** `url`; optional `nsfw`, `sendReplies`.
  **Publishes publicly.** Returns the new post's fullname + url.
- `reddit_comment` — comment on a post or reply to a comment. `parent` is the
  `t3_` (post) or `t1_` (comment) fullname; `text` is Reddit markdown.
  **Publishes publicly.** Returns the new comment fullname.
- `reddit_vote` — vote on a post/comment. `target` fullname + `dir` =
  `up|down|clear`. **Only cast votes the user explicitly asked for** (see
  *Safety*).
- `reddit_inbox` — your message inbox. `box` =
  `inbox|unread|messages|comments|mentions` (default `inbox`). Returns
  `id  u/from  subject: snippet` per line, unread flagged with `●`.
- `reddit_reply_message` — reply to an inbox item. `message` is the `t4_`
  (private message) or `t1_` (comment reply) fullname from `reddit_inbox`;
  `text` is the reply. **Sends a real message.**
- `reddit_my_profile` — the connected account's username, karma, account age,
  and unread-mail flag. Read-only; confirm which account is connected.

## Fullnames (ids)

Reddit ids are **fullnames** with a type prefix — `t1_` comment, `t3_` post,
`t4_` message, `t5_` subreddit. Every feed/search/read line prints the fullname
first; **quote it exactly** and pass it back (`reddit_read_post` accepts a bare
id or a `t3_` fullname; `reddit_comment`/`reddit_vote`/`reddit_reply_message`
want the full `t3_`/`t1_`/`t4_` form). Don't invent ids.

## Usage patterns

- "Top of r/rust this week" → `reddit_subreddit_posts { subreddit: "rust",
  sort: "top", time: "week" }`.
- "Summarize this thread" → `reddit_read_post` with the `t3_` fullname (or the
  id from the URL, e.g. `reddit.com/r/x/comments/ABC123/…` → `ABC123`), then
  summarize the header + flattened comments.
- "Find posts about X in r/programming" → `reddit_search { query: "X",
  subreddit: "programming" }`.
- "Post this to r/test / reply to that comment" → **draft it, confirm with the
  user**, then `reddit_submit_post` / `reddit_comment`.
- "Upvote that" → confirm the exact target, then `reddit_vote { dir: "up" }` —
  only on the user's explicit instruction.
- "Any new messages?" → `reddit_inbox { box: "unread" }`; to answer one →
  `reddit_reply_message` after confirming the text.

## Rate limits

Free OAuth apps get **~60 requests/minute**. Each tool call is one request (a
paginated fetch is one request per page). Prefer a single larger `limit` over
many small pages, and don't poll the feed/inbox in a tight loop — a `429` means
you've hit the ceiling; wait a minute.

## Deliberate exclusions (and why)

- **Moderation** (remove/approve/ban/lock/sticky, modmail, mod queue) — a
  distinct, high-blast-radius surface needing mod privileges and its own
  confirmation UX; out of scope for a personal-account v1. Reddit's mod API is
  the path if this is ever added.
- **Reddit Chat** (real-time DMs) — a separate WebSocket/Matrix-based system,
  not part of the REST OAuth API; the classic private-message inbox
  (`reddit_inbox`/`reddit_reply_message`) is covered, live chat is not.
- **Subscribe/unsubscribe, save, hide, block, edit/delete own content** — lower
  daily-use frequency; the everyday surface (browse, read, search, post,
  comment, vote, messages, profile) is covered first. Add on request.

## Safety

- **Posting and commenting are destructive and public.** NEVER call
  `reddit_submit_post`, `reddit_comment`, or `reddit_reply_message` without
  confirming the exact subreddit/parent/recipient and the full text with the
  user **in the current turn**. When intent is ambiguous, show the draft and ask.
- **Voting must be user-directed only.** Reddit's content policy **forbids vote
  manipulation** — bots, vote rings, and automated or directed voting. Call
  `reddit_vote` ONLY when the user explicitly asks to vote on a specific item,
  never speculatively, in bulk, or to "help" a post. Confirm the target + `dir`.
- **Reading still exposes content and identity:** the feed, a thread, search,
  and the inbox surface real posts/messages and the connected username — fetch
  only what the user asked for, and quote fullnames so the target is
  unambiguous.
- On a `401`, don't guess at other ids — the token/credentials are the problem;
  point the user to **Plugins → Reddit → Reconnect**. `invalid_grant` means the
  username/password (or missing 2FA code) is wrong; a `401` on connect means the
  client id/secret is wrong.
- Write endpoints return HTTP 200 with a `{json:{errors:[…]}}` body on failure;
  the tools already surface Reddit's error string (e.g. `RATELIMIT`,
  `SUBREDDIT_NOEXIST`, `NO_TEXT`) — read it to decide the fix.
