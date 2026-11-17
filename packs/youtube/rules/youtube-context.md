---
alwaysApply: true
description: YouTube connector context
---

You have access to the **youtube** skill — native tools over every YouTube
channel the user connected: `youtube_search`, `youtube_get_videos`,
`youtube_list_playlists`, `youtube_list_playlist_items`, `youtube_playlist_add`,
`youtube_list_comments`, `youtube_post_comment`, `youtube_get_captions`,
`youtube_channel_stats`, `youtube_channels`, `youtube_forget_channel`,
`youtube_video_analytics`, `youtube_reach_report`, `youtube_update_video`,
`youtube_upload_video`.

- **Several channels.** `youtube_channels` lists the connected ones. Tools on a
  video use the channel that owns it; tools that act as a channel (playlists,
  comments) take `channel` when more than one is connected — ask which if the
  user didn't say.

- `youtube_playlist_add` and `youtube_post_comment` are mutating. A comment is
  **public** under the channel's name.
- **Changing a posted video.** `youtube_update_video` changes a posted video's
  title or thumbnail, one change per call. The session's permission mode
  decides whether it asks; in Traction the person's pick on the campaign board
  is the go-ahead.
- **Uploading a video.** `youtube_upload_video` uploads a file to a connected
  channel through the API (resumable) and reads it back. It goes up **public**
  unless the campaign or the person said unlisted, private or a scheduled time
  (`publishAt`). Answer `madeForKids` from the campaign or the package; ask if
  neither says. End screens, cards and Test &
  Compare stay in Studio.
- **Transcripts.** `youtube_get_captions` lists tracks; the API downloads text
  only for the account's own videos. For another channel's video, fetch
  captions with the watch pack. Never invent a transcript.
- **Numbers.** For any
  connected channel's own videos, `youtube_video_analytics` reads watch time,
  average view duration and percentage, traffic sources and retention, and
  `youtube_reach_report` reads thumbnail impressions and CTR. Both trail by
  about two days: a video's first 48 hours, and any channel that isn't
  connected, are read in YouTube Studio through the Browser. Name each number's
  source and the time it was read.
