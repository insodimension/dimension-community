---
name: engagement-targets
description: Today's Reddit threads, X posts, YouTube comment sections and Hacker News threads worth joining for a product or topic, ranked by recency, momentum and fit to the audience, each checked against the place's own rules and given a suggested angle. A shortlist for whoever drafts the replies; it never posts.
license: MIT
---

# Engagement targets

A short, ranked list of places worth joining today, not an open feed. Each target is
a live conversation where a helpful reply from this product's team would be welcome
and allowed. The list feeds the agent or person who drafts; this skill never posts,
replies, votes or follows. [S-01]

## Inputs

- **What we offer**, in one sentence, and the **segment** it is for.
- **The segment's words** for the problem: take them from a voice-of-customer or
  community-pulse result when one exists, so searches match how people actually ask.
- **Platforms**: all that can be read now, or only the one the caller owns (a
  platform agent passes its own platform).
- **Freshness**: 48 hours by default; X and Hacker News 24 hours.

## Find candidates

Search for questions and pain, not for the brand: "looking for", "how do I",
"alternative to", "anyone tried", a competitor's name with "switched" or "issue".

- **Reddit**: `reddit_search` (time `day` or `week`, sort `new`, and again sort
  `comments`) and `reddit_subreddit_posts` (sort `new` and `rising`) on known
  watering holes. Open the strongest with `reddit_read_post`.
- **X**: every X read is billed ($0.005 per post X returns, at least 10 posts a
  call). Before the first call, state the estimate (calls planned × posts each ×
  $0.005) and ask the person; only on their yes run `x_search` with the phrases
  plus `-is:retweet` (sort `recent`, then sort `top` for the day) and
  `x_read_thread` for context. Without a yes, X is not covered. X reaches the
  last 7 days.
- **YouTube**: `youtube_search` (order `date`, publishedAfter about 7 days ago) on
  the problem and on tutorials in the niche; one `youtube_get_videos` call for views
  and comment counts; `youtube_list_comments` for open questions a reply could answer.
- **Hacker News**: the search API through `browser_read`:
  `https://hn.algolia.com/api/v1/search_by_date?query=<q>&tags=(story,comment)&numericFilters=created_at_i%3E<unix seconds>`;
  read the thread at `https://news.ycombinator.com/item?id=<id>`.

A platform that cannot be read (plugin off, not connected, out of API credits) is listed
as not covered at the top of the result.

## Check the rules before ranking

A target the place's rules forbid is dropped, however good the fit. [S-02]

- **Reddit**: `reddit_subreddit_rules` for every subreddit on the list. Note
  self-promotion rules, link rules, required flair, weekly promo threads and
  account-age or karma limits. Quote the rule that decides it.
- **X**: a reply is drafted for a person to send from their own account; the
  platform's automation rules forbid unsolicited automated replies.
- **YouTube**: comments are public and tied to the channel that posts them; no
  links in a first reply.
- **Hacker News**: the site guidelines forbid promotion and astroturfing; an
  affiliated person may answer when they say who they are.

Verdict per target: **allowed**, **allowed with conditions** (state them), or
**not allowed** (dropped, listed once with the rule).

## Score and rank

Score each surviving target 1 to 5 on each line, then rank by the weighted sum. [S-03]

| Dimension | Weight | What it measures |
|---|---|---|
| Fit | 2 | The author or audience is the segment |
| Intent | 2 | Someone asks, compares, complains or is shopping |
| Opening | 2 | A reply can add something specific and true |
| Momentum | 1 | Engagement per hour since posting, and still rising |
| Recency | 1 | Hours since posting; early replies are read |

Drop a target when the thread is past the freshness window and already crowded, when
the only possible reply is generic, or when it is a promotion thread where replies
get no reach. [S-03]

## Output

```markdown
## Engagement targets · {date} · {segment}

Not covered: {platforms and why}

| # | Place | Age | Momentum | Fit | Rules | Angle |
|---|---|---|---|---|---|---|
| 1 | [{title}]({link}) r/{sub} | 5h | 40 pts, 22 comments | 13/15 | allowed with conditions: "{rule}" | {angle} |

Per target, under the table:
1. **{title}** · {platform} · {link}
   - Why: {the question or pain, quoted}
   - Angle: {what a helpful reply would say, the proof it can point to, and the
     disclosure it needs}; drafted by {the platform's agent or the person}
   - Do not: {e.g. link in the first reply, mention pricing}

Dropped by rules: {place} · "{rule}"
```

## Rules

- An angle is a direction, never the finished reply: the platform's drafter writes
  it, and a person approves and sends it.
- Every reply discloses the affiliation; help first, product second or not at all.
- Never vote, follow, like, message or post. Never suggest coordinated accounts,
  upvote requests or replying from more than one account.
- Quote the post you are responding to verbatim and link it; never invent a link
  or a number.
