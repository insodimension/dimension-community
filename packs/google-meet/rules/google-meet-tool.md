---
description: The two families of Google Meet tools, why conference records can be empty, how to poll a live transcript, and what a connection error means. Read it before you call a google_meet tool.
onUse: ["google_meet_*"]
---

Two families: REST (`google_meet_create_space`,
`google_meet_get_space`, `google_meet_end_active_conference`,
`google_meet_list_conference_records`, `google_meet_get_conference_record`,
`google_meet_list_participants`, `google_meet_list_recordings`,
`google_meet_list_transcripts`, `google_meet_list_transcript_entries`) and live
transcribe (`google_meet_join`, `google_meet_live_status`,
`google_meet_live_transcript`, `google_meet_leave`).

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
