---
name: google-calendar
description: Manage scheduling and conflicts in the connected Google Calendar — inspect calendars, compare availability, review conflicts, read event notes and attendees, place holds, and draft or apply exact create/update/reschedule/cancel changes with timezone-aware details. Native google_calendar_* tools (no CLI, no MCP server). Use when the user asks about their agenda, availability, meetings, or events.
prerequisites: none
---

# Google Calendar

## Overview

Use this skill to turn raw calendar data into clear scheduling decisions and safe event changes. Keep answers grounded in exact dates, times, timezones, and calendar evidence — never a reconstructed or guessed schedule.

## Tools

All native, always-on — no bash, no CLI, no MCP server:

- `google_calendar_list_calendars({})` — list the account's calendars (id, name, primary flag, timezone). Grab a calendar id here; everything else defaults to `"primary"`.
- `google_calendar_list_events({ calendarId?, timeMin?, timeMax?, query?, limit? })` — list/search events in a window. This is the **summary** surface (start–end, title, id, location, attendee count).
- `google_calendar_get_event({ calendarId?, eventId })` — one event's **full** detail: attendees with RSVP status, description, recurrence rule, conferencing link, reminders. Use this (not the list summary) whenever attendee emails or notes matter.
- `google_calendar_find_free_slots({ timeMin, timeMax, calendarIds? })` — busy blocks per calendar/attendee via the freeBusy API. It returns busy intervals; **you** compute the open gaps.
- `google_calendar_create_event({ calendarId?, summary, startIso, endIso, allDay?, description?, location?, attendeeEmails? })` — create an event.
- `google_calendar_update_event({ calendarId?, eventId, summary?, startIso?, endIso?, description?, location? })` — patch only the fields you pass; the rest are preserved.
- `google_calendar_delete_event({ calendarId?, eventId })` — permanently delete.

Reads are `read`-tier; create/update/delete are `write`-tier.

## References (load on demand)

- `references/daily-brief.md` — build a polished one-day agenda brief.
- `references/meeting-prep.md` — prep brief for an upcoming meeting from its own context.
- `references/free-up-time.md` — open contiguous focus blocks with the smallest edit set.
- `references/group-scheduler.md` — find and rank meeting times across several attendees.

## Setup

If a call returns "Google Calendar isn't connected yet", the user hasn't completed the OAuth connect flow — point them at **Plugins → Google Calendar → Set up**. This connector reuses the **same** Google Cloud OAuth client as Google Drive; the only extra step is enabling the **Google Calendar API** in that project (creating the client is not enough). No new Cloud project is needed.

## Workflow

1. Read the relevant calendar state first so the request is grounded in actual events, calendars, and time windows.
2. Normalize relative time language ("Thursday afternoon", "next week") into explicit dates, times, and timezone-aware ranges before reasoning about availability.
3. Keep reads bounded. Pass explicit `timeMin`/`timeMax` to `google_calendar_list_events` whenever possible, avoid unbounded broad searches, and choose a small default window when the user doesn't state one.
4. When a bounded search returns too much, raise `limit` or page within that same window before widening the date range. For longer historical, precedent, or preference discovery, chunk the search into smaller windows instead of one giant pull.
5. When the user leaves something ambiguous, inspect previous calendar data for a clear precedent before choosing a default — follow obvious patterns, such as the user's usual meeting duration if similar events are consistently 30 minutes.
6. When a participant, attendee, manager, room, or contact is referenced indirectly ("my manager", "same attendees"), search a bounded relevant window with `google_calendar_list_events` and read the likely source event with `google_calendar_get_event` before asking the user. The list summary does **not** include attendee emails — use `google_calendar_get_event` when contact details matter.
7. If a found event belongs to a recurring series and the user wants a series-level change, read it with `google_calendar_get_event` and note its `recurringEventId` (the master event id) before editing. Don't infer cadence or scope from a single occurrence.
8. Recurring edits — scope matters: `google_calendar_update_event` PATCHes exactly the `eventId` you give it, so passing an **occurrence** id edits that one occurrence. For an **entire-series** change, pass the **master** event id (`recurringEventId`). State which scope you're applying, and if a COUNT-based future-only split is needed that the connector can't express, say so rather than guessing.
9. For room/resource requests, don't assume a reliable global room directory. Mine a reasonable window of past meetings' locations and resource attendees with `google_calendar_list_events`, build a concrete candidate list, then check availability on that set with `google_calendar_find_free_slots`.
10. For bulk reminder or classification-based edit requests, inspect a reasonable upcoming window first instead of asking for extra scoping immediately. If the prompt doesn't bound the horizon, use a narrow default such as the next 30 days and say so.
11. When notes, prep context, or missing details matter, read the event payload with `google_calendar_get_event` before proposing a change.
12. For free-slot and hold requests, if the prompt already gives the window and duration, check availability with `google_calendar_find_free_slots` and move directly to proposing or placing the hold. (See "Capabilities & limits" for what a "hold" means with this connector.)
13. Surface conflicts, holds, and missing meeting details before suggesting any write.
14. If the request is still ambiguous after checking for precedent or scanning a reasonable bounded window, summarize the candidate slots or the exact diff before writing anything.

## Write Safety

- Preserve source event details unless the user asked to change them. `google_calendar_update_event` only writes the fields you pass, so leave the rest out to keep them intact — never re-send a field just to "be safe".
- Treat deletes and broad availability changes as high-impact. Before `google_calendar_delete_event`, read the event and identify the **exact** one by its summary and start time — the tool cannot be undone.
- For bulk reminder or hold writes, restate the qualifying event set and time window before applying anything.
- If multiple calendars or similarly named events are in play, identify the intended one explicitly (by id) before editing.
- Treat a missing title, attendees, location, meeting link, or timezone as a confirmation point rather than an assumption — but only after checking whether the detail is recoverable from a bounded calendar search or the source event.

## Capabilities & limits

- Create/update write core fields only: `summary`, start/end (`startIso`/`endIso`, or dates when `allDay`), `description`, `location`, and (create only) `attendeeEmails`.
- This connector's write tools do **not** set custom reminder overrides or free/busy transparency in V1. `google_calendar_get_event` can *read* an event's reminders, but if the user wants custom reminder timing or a transparent hold, say so and either confirm the plan or note it's applied in Google Calendar directly. A "temporary hold" here is a normal event named as a placeholder.

## Output Conventions

- Present scheduling summaries with exact weekday, date, time, and timezone.
- When sharing availability, say *why* a slot works or conflicts instead of listing raw times without context.
- When suggesting a room or resource, name the likely room and why it fits (prior usage, matching location, open busy windows).
- When comparing options, keep the list short and explain the tradeoff for each slot.
- When the user asks for meeting notes or prep context, say whether the answer came from the event description, a linked doc, or both.

## Example Requests

- "Check my availability with Priya this Thursday afternoon and suggest the best two meeting slots."
- "Find a 1-hour slot next week where I'm free and place a temporary hold on it."
- "Move the design review to next week and keep the same attendees and Zoom link."
- "Summarize my calendar for tomorrow and flag anything that overlaps or leaves no travel time."
- "Draft and create a 30-minute customer sync at 2 PM Pacific on Friday."

---

_Workflow guidance adapted from OpenAI's Codex google-calendar plugin (MIT). The hosted-connector actions were reauthored as local-first `google_calendar_*` tools._
