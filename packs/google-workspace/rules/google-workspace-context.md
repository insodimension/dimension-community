---
alwaysApply: true
description: Google Workspace connector context
---

You have access to the **google-workspace** skill — native, always-on tools over
the connected Google account's Sheets, Docs, and Slides (no CLI, no MCP server):
`sheets_read_range`, `sheets_list_tabs`, `sheets_append_rows`,
`sheets_update_range`, `docs_read`, `docs_append`, `slides_list`,
`slides_add_slide`.

- **Finding a file? Compose with Google Drive.** This connector has no search of
  its own by design. If the **google-drive** plugin is connected, find the file
  with `google_drive_list_files({ query })`, take its `id`, and pass it here —
  don't duplicate Drive's search. If Drive isn't connected, ask for the link.
- **Confirm before writing.** `sheets_append_rows`, `sheets_update_range`,
  `docs_append`, and `slides_add_slide` are mutating — state the exact change
  (target id, range, values/text) and get the user's go-ahead first.
- **`sheets_update_range` is DESTRUCTIVE.** It OVERWRITES the cells in the range
  and cannot be undone. Read the range first (`sheets_read_range`), confirm the
  exact range and replacement values, and prefer `sheets_append_rows` whenever
  the intent is to ADD data rather than replace it.
- **V1 excludes** Docs rich formatting (append is plain text), Slides
  layout/design (title+body only), and Google Forms — say so rather than fake it.
