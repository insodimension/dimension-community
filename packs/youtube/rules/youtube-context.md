---
alwaysApply: true
description: YouTube connector context
---

You have access to the **youtube** skill — native tools over every YouTube
channel the user connected: `youtube_search`, `youtube_get_videos`,
`youtube_list_playlists`, `youtube_list_playlist_items`, `youtube_playlist_add`,
`youtube_list_comments`, `youtube_post_comment`, `youtube_get_captions`,
`youtube_channel_stats`, `youtube_channels`, `youtube_forget_channel`,
`youtube_video_analytics`, `youtube_reach_report`, `youtube_update_video`.

- **Several channels.** `youtube_channels` lists the connected ones. Tools on a
  video use the channel that owns it; tools that act as a channel (playlists,
  comments) take `channel` when more than one is connected — ask which if the
  user didn't say. Each Connect adds the channel picked at sign-in.

- `youtube_playlist_add` and `youtube_post_comment` are mutating. A comment is
  **public** under the channel's name. The tool refuses a sixth comment in a UTC
  day and any text that repeats an earlier comment.
- **Video changes go through the board.** `youtube_update_video` changes a
  posted video's title or thumbnail only with an approved Traction
  `youtube-update` draft: pass its draft id and exactly the approved value. A
  `publish_unapproved` refusal means nothing changed; one saying the approval
  was used means the change may be live, so never send it again.
- **Resolve ids, don't guess.** Turn titles and names into ids with
  `youtube_search`, `youtube_list_playlists` or `youtube_channel_stats`
  (by `@handle`) before acting.
- **Reply vs. top-level comment.** `youtube_post_comment` takes EITHER `videoId`
  OR `parentCommentId` — exactly one.
- **Transcripts.** `youtube_get_captions` lists tracks; the API downloads text
  only for the account's own videos. For another channel's video, fetch
  captions with the watch pack. Never invent a transcript.
- **Mind the quota.** Since 2026-06-01 `search.list` has its own bucket of 100
  calls a day; most other calls share 10,000 units a day at 1 unit each.
  Search sparingly; to study a channel read its uploads playlist (`UC…` →
  `UU…`) with `youtube_list_playlist_items`, then up to 50 ids per
  `youtube_get_videos` call. `quotaExceeded` means the project is out for
  the day.
- **Numbers.** Public views count from the first frame since 2026-08-24. For any
  connected channel's own videos, `youtube_video_analytics` reads watch time,
  average view duration and percentage, traffic sources and retention, and
  `youtube_reach_report` reads thumbnail impressions and CTR. Both trail by
  about two days: a video's first 48 hours, and any channel that isn't
  connected, are read in YouTube Studio through the Browser. Name each number's
  source and the time it was read.
- If a call says no channel is connected, or a channel's token is rejected,
  point the user at **Plugins → YouTube → Connect** (pick that channel). A
  connection that dies every week means the Google OAuth consent screen is still
  in Testing: publish it.
