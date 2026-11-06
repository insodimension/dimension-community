---
name: youtube
description: Search YouTube; inspect up to 50 videos per call and channels by handle; browse and add to your playlists; read comment threads and post public comments/replies via the YouTube Data API v3. Native youtube_* tools (no CLI, no MCP server). Use when the user asks to find, summarize, or act on YouTube videos, channels, playlists, or comments.
---

# YouTube

## Overview

Act on YouTube through nine tools backed by the YouTube Data API v3 (OAuth,
bring-your-own Google Cloud client). The agent searches, inspects videos and
channels, browses and edits the connected account's playlists, reads comment
threads, and posts public comments/replies. Keep answers grounded in the real
data the tools return — ids, view counts, published dates, comment text — never
a guessed or reconstructed transcript.

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

If a call returns "YouTube isn't connected yet", the user hasn't finished the
OAuth flow — point them at **Plugins → YouTube → Set up**. On an auth error, use
**Plugins → YouTube → Reconnect**.

**Scopes:** `https://www.googleapis.com/auth/youtube` (manage playlists, read
channel/video data) + `https://www.googleapis.com/auth/youtube.force-ssl`
(required to read and post comments).

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
- `youtube_list_playlists({ limit? })` — the connected account's own playlists:
  id, title, item count, privacy status. Grab a playlist id here. (read)
- `youtube_list_playlist_items({ playlistId, limit? })` — the videos in a
  playlist: position, video id, title, channel, publish date. A channel's
  uploads playlist is its channel id with `UC` replaced by `UU`, which shows how
  often it posts, at 1 unit instead of a search. (read)
- `youtube_playlist_add({ playlistId, videoId })` — add a video to one of your
  playlists (**mutating, confirm first**). (write)
- `youtube_list_comments({ videoId, limit? })` — top-level comment threads,
  plain text, most-relevant first: `[commentId] author (likes, replies)` + body.
  Quote the comment id to reply. (read)
- `youtube_post_comment({ text, videoId? | parentCommentId? })` — post a **new
  top-level comment** (`videoId`) OR a **reply** to an existing comment
  (`parentCommentId`) — exactly one. **Public, mutating, confirm first.** Asks
  the person in every mode. Refused after 5 comments in a UTC day, and refused
  when the text shares 80% of its words with any earlier comment: YouTube's spam
  policy names repetitive comments. (write)
- `youtube_get_captions({ videoId })` — list the caption **tracks** for a video
  (language, name, kind). See "Captions & transcripts". (read)
- `youtube_channel_stats({ handle? | channelId? })` — subscribers, total views,
  video count and the uploads playlist id, by `@handle` or channel id; omit
  both for your own channel. (read)

Reads are `read`-tier; `youtube_playlist_add` and `youtube_post_comment` are
`write`-tier and prompt for confirmation.

## Usage patterns

- "Find the top talks about X" → `youtube_search({ query: "X", limit: 5 })`,
  then one `youtube_get_videos` call on the ids you want to summarize.
- "What does @channel post and what works for them?" →
  `youtube_channel_stats({ handle })` → `youtube_list_playlist_items` on its
  uploads playlist → `youtube_get_videos` on those ids; compare each video's
  views to the channel's median.
- "How's this video doing?" → `youtube_get_videos` for public counts, stamped
  with the time read. Watch time, average view duration, retention, impressions
  and CTR live in YouTube Studio (Analytics trails 48-72 hours): read them in
  the Browser on the channel owner's signed-in profile.
- "Add this to my Watch Later–style playlist" → `youtube_list_playlists` to
  resolve the title → its id, confirm, then `youtube_playlist_add`.
- "What are people saying about this video?" → `youtube_list_comments`, then
  summarize the returned threads (quote comment ids, not paraphrased authors).
- "Reply to that comment" → get the comment id from `youtube_list_comments`,
  confirm the exact reply text, then `youtube_post_comment({ parentCommentId,
  text })`.
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

- **Comments are public and permanent-ish.** Before `youtube_post_comment`,
  confirm the exact target (video id, or the parent comment id and its author)
  and the **full comment text** with the user. It posts under the connected
  account's real identity and is visible to everyone; it cannot be silently
  undone from here.
- **Playlist edits are real.** Before `youtube_playlist_add`, confirm the exact
  playlist (by **title**, resolved via `youtube_list_playlists`) and the video —
  adding to the wrong playlist is the common mistake.
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

- **Video upload and metadata edits through the API** — a finished film goes up
  through YouTube Studio in the person's own signed-in browser: see the
  `youtube-package`, `youtube-thumbnail` and `youtube-studio-upload` skills,
  which need the Browser plugin.
- **Analytics and Reporting APIs** — watch time, retention, impressions and CTR
  are read in YouTube Studio in the Browser.
- **Live chat** (`liveChat*`) — requires an active broadcast and long-poll
  streaming, which doesn't fit a request/response tool.
- **Caption text download** (`captions.download`) — API-restricted to videos you
  own (see "Captions & transcripts"); only track listing is exposed.
- **Rating a video** (`videos.rate` like/dislike), subscriptions, and channel
  section management — low daily-driver value for v1; can be added if needed.
