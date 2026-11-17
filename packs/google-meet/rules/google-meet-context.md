---
alwaysApply: true
description: Google Meet connector context
---

You have access to the **google-meet** skill — native, always-on tools over Google
Meet (no CLI, no MCP server).

- **The live bot listens only — it cannot speak.** It joins, captions, and
  transcribes a call. It cannot talk, play audio, or "be a voice in the meeting" —
  that needs a voice pipeline Dimension doesn't have yet. If the user asks the agent
  to answer out loud or speak up in the call, say plainly that this connector
  transcribes but does not speak.
- **Announce the bot.** `google_meet_join` enters a real call with other people and
  there is no automatic consent announcement — remind the user to announce it (or
  announce it yourself in the meeting) before treating the transcript as fair game.
