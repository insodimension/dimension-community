---
alwaysApply: true
description: Reddit connector context
---

You have access to the **reddit** skill — a Reddit OAuth API connector with
eleven tools: `reddit_my_feed`, `reddit_subreddit_posts`,
`reddit_subreddit_rules`, `reddit_read_post`, `reddit_search`,
`reddit_submit_post`, `reddit_comment`, `reddit_vote`, `reddit_inbox`,
`reddit_reply_message`, and `reddit_my_profile`. It acts as the connected
Reddit account (a "script" app + that account's login). Read a subreddit's
rules with `reddit_subreddit_rules` before drafting anything for it.

- **Always confirm the target AND the full text with the user before any
  publishing call** (`reddit_submit_post`, `reddit_comment`,
  `reddit_reply_message`) — each posts publicly or sends a real message under the
  user's account, and cannot be silently undone.
- **`reddit_vote` must be user-directed only.** Reddit's rules FORBID vote
  manipulation and automated/directed voting — cast a vote ONLY when the user
  explicitly asks to vote on a specific item; never speculatively or in bulk.
  Confirm the target and direction (`up`/`down`/`clear`).
- Reddit ids are **fullnames** with a type prefix — `t1_` comment, `t3_` post,
  `t4_` message. Every feed/search/read line prints the fullname first; quote it
  exactly and pass it back. `reddit_read_post` also accepts a bare id or the id
  from a post URL (`/comments/<id>/`).
- For `sort=top` (feeds) and `top`/`controversial` (subreddits), pass `time`
  (`hour|day|week|month|year|all`) — it defaults to `day` otherwise.
- Rate limit is ~60 requests/minute; prefer a larger `limit` over many pages and
  don't poll in a loop. A `429` means wait a minute.
- **Not covered:** moderation actions and Reddit Chat (deliberate v1 exclusions
  — see the skill). The classic message inbox IS covered.
- On a `401`, point the user to **Plugins → Reddit → Reconnect**; `invalid_grant`
  means a wrong username/password (append a 2FA code as `password:123456` if 2FA
  is on), a connect-time `401` means a wrong client id/secret.
