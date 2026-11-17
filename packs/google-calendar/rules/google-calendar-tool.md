---
description: How the Google Calendar tools update events and recurring series, bound reads, show attendee emails, and what a connection error means. Read it before you call a google_calendar tool.
onUse: ["google_calendar_*"]
---

- **Preserve fields you weren't asked to change.** `google_calendar_update_event`
  patches only the fields you pass, so leave the rest out to keep title,
  attendees, location, meeting link, and notes intact — never re-send a field
  just to "be safe".
- **Recurring series:** patching an occurrence id edits that one occurrence; a
  series-level change needs the master event id (`recurringEventId`, from
  `google_calendar_get_event`). State which scope you're applying.
- **Bound your reads.** Prefer explicit `timeMin`/`timeMax` windows in the
  user's timezone; page or chunk before widening a date range.
- **Use the right surface for contact details.** The `google_calendar_list_events` summary omits
  attendee emails — read the event with `google_calendar_get_event` when emails
  or notes matter.
- If a call errors "isn't connected yet" or the token is rejected, the user
  needs to (re)authorize — point them at **Plugins → Google Calendar →
  Reconnect**. It reuses the same Google Cloud OAuth client as Google Drive.
