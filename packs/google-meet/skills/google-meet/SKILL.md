---
name: google-meet
description: Work with Google Meet — create meetings and share join links, read post-call conference records, participants, recordings, and transcripts, and join a live call to transcribe it (listen-only). Native google_meet_* tools (no CLI, no MCP server). Use when the user asks to start a meeting, sit in on / take notes on a call, or summarize what was said in a past meeting.
prerequisites: none
---

# Google Meet

## Overview

Two capabilities, one connector:

1. **REST (after / around the meeting)** — create Meet spaces, look them up, end an
   active conference, and read the artifacts a finished conference leaves behind:
   who attended, the recordings (Drive links), and the transcripts (Google Docs
   links + structured speech entries). Cross-platform. Reading conference-record
   artifacts generally needs a **Google Workspace** account; a personal Gmail can
   create spaces and live-transcribe but has no conference-record history.
2. **Live transcribe (during the meeting)** — join a `meet.google.com` URL in a
   headless browser, turn on Meet's own live captions, and scrape them to a
   transcript you can poll while the call runs. **Listen-only.**

## Tools

All native, always-on — no bash, no CLI, no MCP server.

### REST — meetings & artifacts
- `google_meet_create_space({ accessType? })` — create a meeting; returns the join URL + meeting code. `accessType`: `OPEN` (anyone with the link, no knock), `TRUSTED` (org + invitees), `RESTRICTED` (invitees only). **write**.
- `google_meet_get_space({ space })` — look up a space by `spaces/{id}` name or a raw meeting code (`abc-mnop-xyz`); shows config + whether a conference is active + phone access. **read**.
- `google_meet_end_active_conference({ space })` — end the space's active conference. **write**.
- `google_meet_list_conference_records({ filter?, limit? })` — past conferences, newest first. `filter` is Meet EBNF, e.g. `space.meeting_code="abc-mnop-xyz"` or `start_time>="2024-01-01T00:00:00Z"`. **read**.
- `google_meet_get_conference_record({ conferenceRecord })` — one record's detail. **read**.
- `google_meet_list_participants({ conferenceRecord })` — who attended (signed-in / anonymous / phone), with the signed-in user id when present. **read**.
- `google_meet_list_recordings({ conferenceRecord })` — recordings + their Drive `exportUri` (MP4). **read**.
- `google_meet_list_transcripts({ conferenceRecord })` — transcripts + their Google Docs `exportUri`. **read**.
- `google_meet_list_transcript_entries({ transcript })` — structured `speaker: text` speech entries for a transcript resource name. Entries reference a participant *resource name*; use `google_meet_list_participants` to map names → people. **read**.

### Live transcribe — during a call
- `google_meet_join({ url, guestName?, duration?, headed? })` — join a live `meet.google.com` call and start scraping captions. Returns immediately; the bot runs in the background. **There is no automatic consent announcement — you should announce yourself in the meeting.** **write**.
- `google_meet_live_status({})` — is the bot alive, admitted, still in the lobby; caption/transcript progress. **read**.
- `google_meet_live_transcript({ last? })` — read the live transcript (all lines, or the last N). **read**.
- `google_meet_leave({})` — leave the call and finalize the transcript. **write**.

## NON-GOAL: the bot cannot speak in the call

The live bot **listens only** — it joins, captions, and transcribes. It **cannot**
speak, stream audio, play TTS, or "be a voice in the meeting." Doing that (Hermes'
"realtime" mode) requires a virtual-audio device (BlackHole / PulseAudio null-sink)
piping a realtime voice model into Chrome's fake microphone, plus a voice pipeline
Dimension does not have yet. It is a deliberate **future** capability, not silently
omitted. If the user asks the agent to "join and talk", "answer out loud", or "speak
up when X", say plainly that this connector transcribes but does not speak yet.

## Setup

If a call returns "Google Meet isn't connected yet", the user hasn't completed the
OAuth connect flow — point them at **Plugins → Google Meet → Set up**. It reuses the
**same** Google Cloud OAuth client as Google Drive / Calendar; the only extra step is
enabling the **Google Meet API** in that project. The live-transcribe tools need a
Chrome/Chromium on the machine (system Chrome, `PUPPETEER_EXECUTABLE_PATH`, or a
cached Chromium) — they do **not** need the OAuth connection, but a signed-in Chrome
profile avoids the guest lobby.

## Workflow

1. **Starting a meeting** — `google_meet_create_space`, share the returned `meetingUri`. Choose `accessType` deliberately: `OPEN` for a quick share link, `TRUSTED`/`RESTRICTED` for internal calls.
2. **Live note-taking** — `google_meet_join(url)`, announce the bot, then poll `google_meet_live_status` for liveness and `google_meet_live_transcript(last=20)` for recent lines (don't re-read the whole transcript each turn). `google_meet_leave` when done, or pass `duration` for auto-leave. Captions are only as good as Meet's live captions: English-biased, lossy on overlapping speakers.
3. **Post-meeting recap** — find the conference with `google_meet_list_conference_records` (filter by meeting code when you have it), then `google_meet_list_transcripts` → `google_meet_list_transcript_entries` for the words, `google_meet_list_participants` for who said what, and `google_meet_list_recordings` for the video. Summaries should cite whether they came from the live scrape or the official transcript.

## Write Safety

- `google_meet_create_space` and `google_meet_end_active_conference` are mutating — state the plan (and for end-conference, the exact space) before calling.
- `google_meet_join` puts a bot into a real call other people are in. Confirm the URL, and announce the bot's presence — there is no automatic consent notice.

## Output Conventions

- Share meeting links as the full `meetingUri`, with the meeting code for dial-in.
- For recaps, lead with decisions/action items, then attribute quotes to participants.
- When artifacts are missing on a personal Gmail account, say so — it's an account-type limit, not an error.
