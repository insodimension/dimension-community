---
name: youtube
description: Search YouTube; inspect up to 50 videos per call and channels by handle; browse and add to your playlists; read comment threads and post public comments/replies; read your own channel's analytics (watch time, retention, traffic sources) and reach (thumbnail impressions, CTR); apply board-approved title and thumbnail changes. Native youtube_* tools (no CLI, no MCP server). Use when the user asks to find, summarize, measure, or act on YouTube videos, channels, playlists, or comments.
---

# YouTube

## Overview

Act on YouTube through fourteen tools backed by the YouTube Data API v3, the
YouTube Analytics API v2 and the YouTube Reporting API (OAuth, bring-your-own
Google Cloud client). The agent searches, inspects videos and channels, browses
and edits connected channels' playlists, reads comment threads, posts public
comments/replies, reads every connected channel's own analytics and reach, and
applies title and thumbnail changes the person approved on the Traction
campaign board. Keep answers grounded in the real data the tools return — ids,
view counts, published dates, comment text — never a guessed or reconstructed
transcript or number.

**Any number of channels.** Each Connect (Plugins → YouTube → Connect) adds the
channel picked at Google's sign-in (a Google account or any brand account it
manages); connect again to add the next. `youtube_channels` lists them. A tool
that acts on a video (`youtube_video_analytics`, `youtube_update_video`,
`youtube_reach_report` with `videoId`) uses the channel that owns the video, so
no channel is named. A tool that acts *as* a channel (playlists, comments) takes
`channel` (title, @handle or id) when more than one is connected.

## Setup

This connector reuses the **same** Google Cloud OAuth client as Google Drive and
Google Calendar. If you already set up one of those, you only need to:

1. Enable the **YouTube Data API v3** in that Cloud project — APIs & Services →
   Library → "YouTube Data API v3" → Enable. Creating the client is **not**
   enough; without this step the connection succeeds but every YouTube call fails.
2. Open **Plugins → YouTube → Set up** and paste the **same** Client ID and
   Client Secret you used for Drive/Calendar.

No new Cloud project is needed. If you don't have a client yet, follow the
"Before you connect" steps in the connect modal (create project → enable the
YouTube Data API v3 → Desktop-app OAuth client → copy creds).

**Publish the OAuth consent screen.** In Google Auth Platform → Audience, press
**Publish app**. A client left in "Testing" gets refresh tokens that expire
after 7 days (Google's OAuth documentation), so the connection dies every week.
For your own client no review is needed; an "unverified app" notice at sign-in
is expected.

If a call says no channel is connected, the user hasn't finished the OAuth flow
— point them at **Plugins → YouTube → Connect**. On an auth error for one
channel, connect that channel again.

**Scopes:** `https://www.googleapis.com/auth/youtube` (manage playlists, read
channel/video data, update your videos) + `https://www.googleapis.com/auth/youtube.force-ssl`
(required to read and post comments) + `https://www.googleapis.com/auth/yt-analytics.readonly`
(Analytics and Reporting reads). Enable the **YouTube Analytics API** and the
**YouTube Reporting API** in the same Cloud project. A channel connected before
plugin 0.4.0 lacks the analytics scope: the analytics tools say so, and the fix
is to connect that channel again.

## Tools

All native, always-on — no bash, no CLI, no MCP server:

- `youtube_search({ query, kind?, limit?, order?, publishedAfter? })` — search
  **videos** (default), **channels**, or **playlists**. `order` is `relevance`
  (default), `date` or `viewCount`; `publishedAfter` (YYYY-MM-DD) keeps only
  recent results. Returns `[kind] id  title  — channel [channelId]  date` per
  line. **Search has its own bucket of 100 calls a day** (since 2026-06-01);
  spend it on discovery, not on channels you already know. (read)
- `youtube_get_videos({ videoIds })` — 1 to 50 videos (ids or watch,
  `youtu.be` or Shorts URLs) in one 1-unit call: title, published date,
  duration, privacy, made-for-kids and altered/synthetic flags, public views,
  likes and comments, and the time they were read. One id adds the channel,
  tags and description. (read)
- `youtube_list_playlists({ limit?, channel? })` — a connected channel's own
  playlists: id, title, item count, privacy status. Grab a playlist id here. (read)
- `youtube_list_playlist_items({ playlistId, limit? })` — the videos in a
  playlist: position, video id, title, channel, publish date. A channel's
  uploads playlist is its channel id with `UC` replaced by `UU`, which shows how
  often it posts, at 1 unit instead of a search. (read)
- `youtube_playlist_add({ playlistId, videoId, channel? })` — add a video to one
  of that channel's playlists (**mutating**). (write)
- `youtube_list_comments({ videoId, limit? })` — top-level comment threads,
  plain text, most-relevant first: `[commentId] author (likes, replies)` + body.
  Quote the comment id to reply. (read)
- `youtube_post_comment({ text, videoId? | parentCommentId?, channel? })` — post a **new
  top-level comment** (`videoId`) OR a **reply** to an existing comment
  (`parentCommentId`) — exactly one. **Public, mutating.** Refused after 5 comments in a UTC day, and refused
  when the text shares 80% of its words with any earlier comment: YouTube's spam
  policy names repetitive comments. (write)
- `youtube_get_captions({ videoId })` — list the caption **tracks** for a video
  (language, name, kind). See "Captions & transcripts". (read)
- `youtube_channel_stats({ handle? | channelId? })` — subscribers, total views,
  video count and the uploads playlist id, by `@handle` or channel id; omit
  both for every connected channel. (read)
- `youtube_channels()` — every connected channel: title, @handle, id, when it
  was connected. (read)
- `youtube_forget_channel({ channel })` — remove a connected channel's stored
  sign-in from this machine. (write)

- `youtube_video_analytics({ videoId, startDate?, endDate? })` — a video on any
  connected channel, read with the owning channel's sign-in (default the last 28 days): views, engaged views,
  watch time, average view duration and average percentage viewed; views,
  engaged views and watch time by traffic source (YouTube reports no average
  duration or percentage per source; the tool shows watch time over views); and
  the retention curve (audienceWatchRatio and relativeRetentionPerformance at
  1/10/25/50/75/90/100%). Retention is not broken down by traffic source in the
  API. (read)
- `youtube_reach_report({ videoId?, channel?, days?, bySource? })` — thumbnail
  impressions and impressions CTR from the Reporting API's daily reach reports
  (`channel_reach_basic_a1`; with `bySource`, `channel_reach_combined_a1` by
  traffic source). A `videoId` reports on its own channel; otherwise one
  `channel`, or every connected channel, a section each. The plugin creates both
  report jobs for each channel at the first session after it connects; YouTube
  backfills only 30 days before a job exists, and the first reports take up to
  48 hours. (read)
- `youtube_update_video({ draftId, videoUrl, title? | thumbnailPath? })` —
  apply an **approved** Traction `youtube-update` draft: a new title
  (videos.update, resending the video's whole snippet so description, tags and
  category stay) or a new thumbnail (thumbnails.set, PNG or JPEG ≤ 2 MB).
  The video's owning channel is used. Refused with `publish_unapproved`, nothing changed, unless the board's
  Approve covers this exact change on this exact video and the thumbnail file is
  byte-identical to the approved one. An approval is spent once. Asks the
  person every time. (write)

Reads are `read`-tier; `youtube_playlist_add`, `youtube_post_comment`,
`youtube_forget_channel` and `youtube_update_video` are `write`-tier.

## Usage patterns

- "Find the top talks about X" → `youtube_search({ query: "X", limit: 5 })`,
  then one `youtube_get_videos` call on the ids you want to summarize.
- "What does @channel post and what works for them?" →
  `youtube_channel_stats({ handle })` → `youtube_list_playlist_items` on its
  uploads playlist → `youtube_get_videos` on those ids; compare each video's
  views to the channel's median.
- "How's this video doing?" → `youtube_get_videos` for public counts, stamped
  with the time read; `youtube_video_analytics` for watch time, retention and
  traffic sources and `youtube_reach_report({ videoId })` for impressions and
  CTR on the connected channel's own videos. Analytics trail about two days and
  reach reports arrive daily, so for a video's first 48 hours read Studio in
  the Browser on the channel owner's signed-in profile.
- "Change this video's title/thumbnail" → only through a Traction
  `youtube-update` draft the person approves on the board, then
  `youtube_update_video` with that draft's id and exactly its approved value.
  Test & Compare, pinned comments and end screens have no API: apply those in
  Studio with the Browser tools.
- "Add this to my Watch Later–style playlist" → `youtube_list_playlists` to
  resolve the title → its id, then `youtube_playlist_add`.
- "What are people saying about this video?" → `youtube_list_comments`, then
  summarize the returned threads (quote comment ids, not paraphrased authors).
- "Reply to that comment" → get the comment id from `youtube_list_comments`,
  then `youtube_post_comment({ parentCommentId, text })`.
- "How big is this channel?" → `youtube_channel_stats` (by `@handle`, a
  channel id, or none for the user's own channel).

## Captions & transcripts

`youtube_get_captions` lists the caption **tracks** (metadata) on a video. The
official YouTube Data API's `captions.download` endpoint **only works for videos
the connected account owns**. For another channel's video, fetch its captions
with the watch pack (it pulls public captions without browser cookies). Do
**not** fabricate a transcript, and do not claim to have read captions you
couldn't download.

## Safety

- **Comments are public and permanent-ish.** `youtube_post_comment` posts under the connected
  account's real identity and is visible to everyone; it cannot be silently
  undone from here.
- **Playlist edits are real.** Resolve the playlist by **title** via
  `youtube_list_playlists` before `youtube_playlist_add` — adding to the wrong
  playlist is the common mistake.
- Resolve names to ids with a read tool (`youtube_search`,
  `youtube_list_playlists`) rather than guessing an id.
- The tools surface Google's own `error.message` verbatim — read it
  (`quotaExceeded`, `commentsDisabled`, `insufficientPermissions`) to decide the
  fix.

## Quota

As of 2026-11-06 (YouTube Data API quota page and revision history): since
2026-06-01 `search.list` and `videos.insert` each have their own bucket of 100
calls a day; every other method shares the project's 10,000 units a day.
`videos.list`, `channels.list` and `playlistItems.list` cost 1 unit; a comment
insert costs 50. More quota needs YouTube's compliance audit. On
`quotaExceeded` the project is out until midnight Pacific.

## Deliberate exclusions (v1)

These are intentionally **not** implemented — say so honestly if asked, rather
than pretending:

- **Video upload and most metadata edits through the API** — a finished film
  goes up through YouTube Studio in the person's own signed-in browser: see the
  `youtube-package`, `youtube-thumbnail` and `youtube-studio-upload` skills,
  which need the Browser plugin. The only API edits are an approved title or
  thumbnail (`youtube_update_video`).
- **Test & Compare, pinned comments, end screens** — no API exists; Studio only.
- **Live chat** (`liveChat*`) — requires an active broadcast and long-poll
  streaming, which doesn't fit a request/response tool.
- **Caption text download** (`captions.download`) — API-restricted to videos you
  own (see "Captions & transcripts"); only track listing is exposed.
- **Rating a video** (`videos.rate` like/dislike), subscriptions, and channel
  section management — low daily-driver value for v1; can be added if needed.
