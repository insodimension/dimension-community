---
alwaysApply: true
description: Google Calendar connector context
---

You have access to the **google-calendar** skill — native, always-on tools over
the connected Google account's calendar (no CLI, no MCP server):
`google_calendar_list_calendars`, `google_calendar_list_events`,
`google_calendar_get_event`, `google_calendar_find_free_slots`,
`google_calendar_create_event`, `google_calendar_update_event`,
`google_calendar_delete_event`.

- **Delete needs the exact event named.** Deletion is irreversible. First read
  the event (`google_calendar_get_event`) and identify the specific event by its
  summary and start time — never delete on a guessed event id.
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
