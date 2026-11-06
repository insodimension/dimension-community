---
name: creator-prospecting
description: Find the YouTubers, X accounts, newsletters and podcasts whose audience is the one you want to reach, scored on audience fit, how often they publish and how their audience engages, with a short outreach brief for each. Public data only; it never contacts anyone.
license: MIT
---

# Creator prospecting

A prospect list is creators whose audience already is the segment, who publish
steadily, and whose audience actually responds. Size is a filter, not the score: a
large account with the wrong audience is a worse fit than a small one with the right
one. [S-01]

## Inputs

- **Segment and topic**: who the audience must be, and what the creator should
  already cover.
- **Kinds**: YouTube, X, newsletters, podcasts (default all four).
- **Size band** (optional): for example 5,000 to 100,000 followers. Smaller,
  growing accounts are often the best first partners. [S-04]
- **How many**: 10 by default.

## Discover

Start from people the community already cites, then widen.

- **From a community pulse** when one exists: channels, authors and newsletters that
  its threads link to or argue about.
- **YouTube**: `youtube_search` kind `channel` on the niche; kind `video` with order
  `viewCount` and publishedAfter about 90 days ago, then the channels behind those
  videos (each result carries its channel id).
- **X**: `x_search` on the niche (sort `top`, then `recent`); authors with two or more
  relevant posts in the week are candidates. `x_user_lookup` for each.
- **Newsletters and podcasts**: `web_search` for the niche with "newsletter",
  "substack", "podcast", and directory pages; read each with `browser_read`.

## Measure, from public numbers only

Never estimate a number a page does not show; write "not shown". [S-03]

- **YouTube**: `youtube_channel_stats` (subscribers, views, video count). Uploads:
  `youtube_list_playlist_items` on the uploads playlist (the channel id with `UC`
  replaced by `UU`) for the last 15 videos and their dates. `youtube_get_video` on
  the last 10 for views, likes and comments.
- **X**: `x_user_lookup` (followers, posts, joined), then `x_search` with
  `from:<handle> -is:retweet` for the last 7 days: posts per week, and likes and
  replies per post.
- **Newsletters and podcasts**: the archive page for cadence; subscriber or download
  numbers only where the creator publishes them.

Engagement is judged against the creator's own baseline: take the median of their
recent posts (views for video, likes plus replies for text), not the mean, so one
viral post does not set the bar; a post above twice the median is an outlier worth
reading. Fewer than 10 recent posts means low confidence. [S-02]

## Score

Score 1 to 5 on each, with the evidence beside each score. [S-01]

| Dimension | What earns a 5 |
|---|---|
| Audience fit | Comments and replies come from the segment (their questions, their tools, their words) |
| Topic fit | Recent work is on the niche, not one old video |
| Cadence | Published steadily for the last 90 days |
| Engagement | Comments per view or replies per post above peers of similar size, and real conversation, not bots |
| Reach | Inside the size band, rising rather than flat |
| Brand safety | No recent controversy or obvious mismatch |
| Contactability | A public business email, contact page or sponsorship page |

## Output

```markdown
## Creator prospects · {segment} · {date}

| # | Creator | Kind | Audience | Cadence | Median engagement | Fit | Contact |
|---|---|---|---|---|---|---|---|
| 1 | [{name}]({link}) | YouTube | 48k subs | 3 videos / month | 9.2k views, 1.1% comments per view | 31/35 | business email on About page |

Outreach brief per creator:
1. **{name}** · {link}
   - Why them: {dated evidence: the video or post, its numbers, what the audience said}
   - Their best recent piece: [{title}]({link}) · {date} · {lift}x their median
   - Angle: {what we would offer, why their audience would care, which format}
   - Contact path: {public link}
   - Risk: {anything that would make this a bad fit}
```

## Rules

- Public profiles and published contact paths only; never guess an email or look
  for a private one.
- A creator's audience is inferred from what their audience writes, never from
  how the creator looks or sounds; say when the evidence is thin.
- This skill finds and briefs. It never follows, messages, emails or comments.
