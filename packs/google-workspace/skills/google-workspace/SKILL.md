---
name: google-workspace
description: Read and write Google Sheets, Docs, and Slides in the connected Google account — read cell ranges, list tabs, append/overwrite rows, read docs as text, append to docs, list slides, and add slides. Native sheets_*/docs_*/slides_* tools (no CLI, no MCP server). Use when the user asks to read from, edit, append to, or build a spreadsheet, document, or presentation.
---

# Google Workspace

## Overview

Use this skill to read and write the user's Google Sheets, Docs, and Slides. Keep every write grounded in the actual current state — read the range/doc/deck first, confirm the exact change, then apply it. Reads are `read`-tier; every write is `write`-tier and prompts for confirmation.

## Tools

All native, always-on — no bash, no CLI, no MCP server:

- `sheets_read_range({ spreadsheetId, range })` — read a cell grid by A1 range (e.g. `"Q3!A1:D20"`). **read**
- `sheets_list_tabs({ spreadsheetId })` — list tab titles, ids, and grid sizes. Call this first when you don't know the exact tab name. **read**
- `sheets_append_rows({ spreadsheetId, range, rows })` — append rows AFTER the last row of a table; never overwrites existing data. **write, confirm first.**
- `sheets_update_range({ spreadsheetId, range, rows })` — **OVERWRITE** the cells in an A1 range. **DESTRUCTIVE** — replaces whatever was there. **write, confirm the exact range + values first.**
- `docs_read({ documentId })` — read a doc flattened to plain text (paragraphs + table cells). **read**
- `docs_append({ documentId, text })` — append text to the end of a doc. **write, confirm first.**
- `slides_list({ presentationId })` — list slides (object id, index, title). **read**
- `slides_add_slide({ presentationId, title, body? })` — add a TITLE_AND_BODY slide with the given text. **write, confirm first.**

## Finding IDs — extract from the URL, or use Google Drive to search

Every tool takes an **id**, not a name or URL. The id is the long token in the file's URL between `/d/` and the next `/`:

| URL | id to pass |
|---|---|
| `https://docs.google.com/spreadsheets/d/`**`1AbC…xyz`**`/edit#gid=0` | `1AbC…xyz` (spreadsheetId) |
| `https://docs.google.com/document/d/`**`1DeF…uvw`**`/edit` | `1DeF…uvw` (documentId) |
| `https://docs.google.com/presentation/d/`**`1GhI…rst`**`/edit` | `1GhI…rst` (presentationId) |

If the user gives you a full URL, strip it down to that token yourself — don't pass the whole URL.

**Don't have a URL? Compose with the Google Drive connector.** This plugin has no search of its own by design — if the **google-drive** plugin is connected, use `google_drive_list_files({ query })` to FIND the file (e.g. `name contains 'budget' and mimeType = 'application/vnd.google-apps.spreadsheet'`), take the `id` from that result, and pass it here. Don't duplicate Drive's search; reuse it. If Drive isn't connected, ask the user for the file's link.

## Setup

If a call returns "Google Workspace isn't connected yet", the user hasn't completed the OAuth connect flow — point them at **Plugins → Google Workspace → Set up**. This connector reuses the **same** Google Cloud OAuth client as Google Drive/Calendar; the extra steps are enabling the **Google Sheets API**, **Google Docs API**, and **Google Slides API** in that project (creating the client is not enough).

**Already connected Drive or Calendar? You STILL must reconnect here.** The token from another Google connector was granted narrower scopes (`drive.readonly` / `calendar`) and does NOT include the Sheets/Docs/Slides write scopes this plugin needs. Google only grants scopes at consent time, so the user must run **Connect** for Google Workspace and approve the new permissions — the verify step will say "Reconnect to grant the Workspace scopes" if the scopes are missing.

## Workflow

1. **Resolve the id first.** Extract it from the URL the user gave, or find the file with `google_drive_list_files` (see above). Never guess an id.
2. **Read before you write.** For Sheets, `sheets_list_tabs` to confirm the tab name, then `sheets_read_range` to see the current cells. For Docs, `docs_read`. For Slides, `slides_list`. Ground every edit in what's actually there.
3. **Choose the right write.** Adding new rows to a table → `sheets_append_rows` (safe, never clobbers). Changing existing cells → `sheets_update_range` (destructive — only when the user wants those cells replaced).
4. **Confirm the exact change**, then apply it. For a destructive `sheets_update_range`, restate the range and the replacement values. For appends, restate the target and the row count.
5. **Report what changed** using the range/id the tool returns.

## Write Safety

- `sheets_update_range` is **destructive and not undoable** — it overwrites the target cells. Read the range first, and confirm the EXACT range + values with the user. Prefer `sheets_append_rows` whenever the intent is "add data", not "replace data".
- `sheets_append_rows` and `docs_append` are additive but still writes — confirm the content and target first.
- `slides_add_slide` adds a new slide; confirm the title and body first.
- When several tabs or similarly named files are in play, identify the intended one by id before writing.
- A1 ranges are the contract: a mismatched range writes to the wrong cells. Double-check the tab name (`sheets_list_tabs`) and the range bounds before a `sheets_update_range`.

## Capabilities & limits (deliberate V1 exclusions)

This connector covers the everyday read/write surface of Sheets, Docs, and Slides. It deliberately does **not** cover, and you should say so rather than fake it:

- **Docs rich formatting** — `docs_append` inserts plain text only. It does not set bold/italic, headings, styles, lists, images, or tables. If the user needs formatting, note it must be applied in Google Docs directly (or say the connector can't express it).
- **Slides layout/design** — `slides_add_slide` creates a standard TITLE_AND_BODY slide with title + body text. It does not do custom layouts, theming, shape/image placement, speaker notes, or per-run styling.
- **Google Forms** — not supported at all; there is no Forms tool.
- **Sheets structure ops** — no create-spreadsheet, add/delete/rename-tab, formatting, charts, or conditional formatting; only cell values (read/append/overwrite) and tab discovery.
- **No file discovery** — there is no "search my Sheets" tool here by design; use the **google-drive** connector to find files, then pass the id (see "Finding IDs").

## Example Requests

- "Read the 'Q3' tab of my budget sheet and total column D."
- "Append these three expense rows to the tracker spreadsheet."
- "Overwrite B2:B10 in the forecast tab with these updated numbers."
- "Add a paragraph summarizing the results to the end of my report doc."
- "Add a title slide and a bullet slide to my roadmap deck summarizing the plan."
