---
description: How the YouTube tools add and forget channels, limit comments, recover from a failed update or upload, resolve ids, reply to comments, spend quota and count views, and what a connection error means. Read it before you call a youtube tool.
onUse: ["youtube_*"]
---

- **Several channels.** Each Connect adds the channel picked at sign-in; Disconnect
  removes them all, `youtube_forget_channel` removes one.
- **Comments.** The tool refuses a sixth comment in a UTC
  day and any text that repeats an earlier comment.
- **Changing a posted video.** A clear refusal means nothing changed; an unclear failure
  means it may be live, so read the video before sending it again.
- **Uploading a video.** Thumbnail, playlist and captions ride along; a failed one is
  reported and fixed with `youtube_update_video` or `youtube_playlist_add`,
  never by uploading again. Upload a film once: after an unclear failure, list
  the channel's uploads before calling again.
- **Resolve ids, don't guess.** Turn titles and names into ids with
  `youtube_search`, `youtube_list_playlists` or `youtube_channel_stats`
  (by `@handle`) before acting.
- **Reply vs. top-level comment.** `youtube_post_comment` takes EITHER `videoId`
  OR `parentCommentId` — exactly one.
- **Mind the quota.** Since 2026-06-01 `search.list` has its own bucket of 100
  calls a day; most other calls share 10,000 units a day at 1 unit each.
  Search sparingly; to study a channel read its uploads playlist (`UC…` →
  `UU…`) with `youtube_list_playlist_items`, then up to 50 ids per
  `youtube_get_videos` call. `quotaExceeded` means the project is out of quota:
  spent for the day, or its daily limit is 0 and never refills.
- **Numbers.** Public views count from the first frame since 2026-08-24.
- If a call says no channel is connected, or a channel's token is rejected,
  point the user at **Plugins → YouTube → Connect** (pick that channel). A
  connection that dies every week means the Google OAuth consent screen is still
  in Testing: publish it.
