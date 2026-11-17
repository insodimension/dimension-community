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
