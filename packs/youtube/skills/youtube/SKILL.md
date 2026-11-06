---
name: youtube
description: Search YouTube; inspect videos and channels; browse and add to your playlists; read comment threads and post public comments/replies via the YouTube Data API v3. Native youtube_* tools (no CLI, no MCP server). Use when the user asks to find, summarize, or act on YouTube videos, channels, playlists, or comments.
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
  line. **Search costs 100 quota units** — the most expensive call; keep
  `limit` tight. (read)
- `youtube_get_video({ videoId })` — one video's full detail: title, channel,
  duration, statistics (views/likes/comments), tags, and description. Use this
  (not the search summary) when the description or engagement numbers matter.
  (read)
- `youtube_list_playlists({ limit? })` — the connected account's own playlists:
  id, title, item count, privacy status. Grab a playlist id here. (read)
- `youtube_list_playlist_items({ playlistId, limit? })` — the videos in a
  playlist: position, video id, title, channel, publish date. A channel's
  uploads playlist is its channel id with `UC` replaced by `UU`, which shows how
  often it posts. (read)
- `youtube_playlist_add({ playlistId, videoId })` — add a video to one of your
  playlists (**mutating, confirm first**). (write)
- `youtube_list_comments({ videoId, limit? })` — top-level comment threads,
  plain text, most-relevant first: `[commentId] author (likes, replies)` + body.
  Quote the comment id to reply. (read)
- `youtube_post_comment({ text, videoId? | parentCommentId? })` — post a **new
  top-level comment** (`videoId`) OR a **reply** to an existing comment
  (`parentCommentId`) — exactly one. **Public, mutating, confirm first.** (write)
- `youtube_get_captions({ videoId })` — list the caption **tracks** for a video
  (language, name, kind). See "Captions & transcripts" — the API does **not**
  give you the caption text for videos you don't own. (read)
- `youtube_channel_stats({ channelId? })` — subscribers, total views, video
  count; omit `channelId` for your own channel. (read)

Reads are `read`-tier; `youtube_playlist_add` and `youtube_post_comment` are
`write`-tier and prompt for confirmation.

## Usage patterns

- "Find the top talks about X" → `youtube_search({ query: "X", limit: 5 })`,
  then `youtube_get_video` on the ids you want to summarize.
- "How's this video doing?" → `youtube_get_video` and report the view/like/
  comment counts and the like-to-view ratio.
- "Add this to my Watch Later–style playlist" → `youtube_list_playlists` to
  resolve the title → its id, confirm, then `youtube_playlist_add`.
- "What are people saying about this video?" → `youtube_list_comments`, then
  summarize the returned threads (quote comment ids, not paraphrased authors).
- "Reply to that comment" → get the comment id from `youtube_list_comments`,
  confirm the exact reply text, then `youtube_post_comment({ parentCommentId,
  text })`.
- "How big is this channel?" → `youtube_channel_stats` (with the channelId from
  a search/video, or omit it for the user's own channel).

## Captions & transcripts

`youtube_get_captions` lists the caption **tracks** (metadata) on a video. The
official YouTube Data API's `captions.download` endpoint **only works for videos
the connected account owns** — you cannot pull the transcript text of an
arbitrary third-party video through this API. If a user asks for the transcript
of a video they don't own, say so plainly: it is **not available via the
official API**. Do **not** fabricate a transcript, and do not claim to have read
captions you couldn't download.

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

The YouTube Data API bills per call against a daily project quota (10,000 units
default). Reads like `videos.list` / `channels.list` are cheap (1 unit);
**`search.list` is 100 units**; writes are ~50. If a call fails with
`quotaExceeded`, the project is out for the day (resets midnight Pacific) — avoid
repeated searches; per-id `youtube_get_video`/`youtube_channel_stats` reads cost
1 unit each, so several of those are still ~free next to one search.

## Deliberate exclusions (v1)

These are intentionally **not** implemented — say so honestly if asked, rather
than pretending:

- **Video upload through the API** (`videos.insert`) — needs a resumable multipart media upload
  (large binary streaming, distinct machinery). A finished film goes up through YouTube Studio
  in the person's own browser instead: see the `youtube-package`, `youtube-thumbnail` and
  `youtube-studio-upload` skills, which need the Browser plugin.
- **Live chat** (`liveChat*`) — requires an active broadcast and long-poll
  streaming, which doesn't fit a request/response tool.
- **Caption text download** (`captions.download`) — API-restricted to videos you
  own (see "Captions & transcripts"); only track listing is exposed.
- **Rating a video** (`videos.rate` like/dislike), subscriptions, and channel
  section management — low daily-driver value for v1; can be added if needed.
