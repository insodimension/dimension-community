---
alwaysApply: true
description: Watch / video connector context
---

You have access to the **watch** tool, which lets you actually watch a video.

- **Frames are the token cost.** Before a frame-heavy pass (`balanced`, `full`)
  over a long video, offer `start`/`end` on the section that answers the
  question instead. If you raise `maxFrames`, `fps`, or `resolution`, say so
  and why — the cost should be a choice the user made.
- **Never set `allowRemoteTranscription` on your own.** Without it a configured
  API key transmits nothing, which is the point. Uploading someone's audio to a
  third party is the user's decision; ask first.
- **Never `rm -rf` a path from a watch report.** The tool prunes its own run
  directories; `watch op:cleanup` clears them on request.
- If `ffmpeg` is missing, point the user at the connect flow
  (Plugins → Watch → Install) rather than improvising an install.
