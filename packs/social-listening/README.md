# Social Listening

## What it is

Four research skills that tell you what communities actually say about a topic,
which live conversations are worth joining, which creators reach your audience, and
the exact words that audience uses. They read real threads and comment sections
through last30days and the Reddit, X and YouTube plugins, quote people verbatim with
dates and links, and say plainly which platforms they could not read. The pack is
not tied to one space: Traction uses it for marketing research, and the Video space
can use it for topics and creators.

## What it contains

- **Skill `community-pulse`**: a broad 30-day sweep with last30days (X fed in from
  the X plugin), then a close read of the threads that matter. Returns dated themes
  with verbatim quotes and links, and a coverage table.
- **Skill `engagement-targets`**: today's Reddit threads, X posts, YouTube comment
  sections and Hacker News threads worth joining, ranked by recency, momentum and fit,
  each checked against the place's own rules, with a suggested angle for whoever
  drafts the reply.
- **Skill `creator-prospecting`**: YouTubers, X accounts, newsletters and podcasts
  whose audience matches, scored on audience fit, cadence and engagement against
  their own baseline, with an outreach brief for each.
- **Skill `voice-of-customer`**: pains, triggers, desired outcomes, objections,
  alternatives and a bank of verbatim phrases, ready for positioning and copy.

## Who can use it

On by default, in every space. It works with whatever readers are present and
reports the rest as not covered:

- **last30days** for the broad sweep (Reddit, Hacker News, YouTube, GitHub,
  Polymarket and the web with no key; TikTok and Instagram with a ScrapeCreators key
  added on the last30days card).
- **X** for X posts (free when you are logged into x.com in your browser; search
  reaches the last 7 days).
- **Reddit** and **YouTube** for reading whole threads, comment sections, subreddit
  rules and channel numbers (each needs its own sign-in).
- **Browser** for Hacker News threads and newsletter or podcast pages.

## Limits and risks

- It never posts, replies, votes, follows or sends anything. Engagement targets are
  a shortlist with an angle; a person approves every reply.
- Public data only. It quotes public handles as shown and never looks for private
  contact details.
- X search covers 7 days, not 30. Platforms that cannot be read are named in every
  result, never reported as quiet.
- Engagement and follower counts are taken as shown by each platform at the time of
  the read; they change.
- The skills adapt MIT-licensed procedures from ScrapeCreators, Corey Haines'
  marketingskills, last30days and Agent Reach: see `THIRD_PARTY_NOTICES.md` and each
  skill's `SKILL.sources.yaml`.
