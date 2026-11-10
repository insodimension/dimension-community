---
alwaysApply: true
description: Google Meet connector context
---

You have access to the **google-meet** skill — native, always-on tools over Google
Meet (no CLI, no MCP server). Two families: REST (`google_meet_create_space`,
`google_meet_get_space`, `google_meet_end_active_conference`,
`google_meet_list_conference_records`, `google_meet_get_conference_record`,
`google_meet_list_participants`, `google_meet_list_recordings`,
`google_meet_list_transcripts`, `google_meet_list_transcript_entries`) and live
transcribe (`google_meet_join`, `google_meet_live_status`,
`google_meet_live_transcript`, `google_meet_leave`).

- **The live bot listens only — it cannot speak.** It joins, captions, and
  transcribes a call. It cannot talk, play audio, or "be a voice in the meeting" —
  that needs a voice pipeline Dimension doesn't have yet. If the user asks the agent
  to answer out loud or speak up in the call, say plainly that this connector
  transcribes but does not speak.
- **Announce the bot.** `google_meet_join` enters a real call with other people and
  there is no automatic consent announcement — remind the user to announce it (or
  announce it yourself in the meeting) before treating the transcript as fair game.
- **Conference records need Workspace.** Reading past-meeting records, recordings,
  and transcripts generally requires a Google Workspace account with Meet artifacts
  enabled. A personal Gmail can create spaces and live-transcribe but has no
  conference-record history — treat empty results as an account-type limit, not a
  bug, and say so.
- **Poll, don't spin.** During a live call, use `google_meet_live_transcript(last=N)`
  for recent lines instead of re-reading the whole transcript each turn.
- If a REST call errors "isn't connected yet" or the token is rejected, the user
  needs to (re)authorize — point them at **Plugins → Google Meet → Reconnect**. It
  reuses the same Google Cloud OAuth client as Google Drive / Calendar.
