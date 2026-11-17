---
description: How the Sheets, Docs and Slides tools take file ids, which reads come before a write, and what a connection error means. Read it before you call a sheets, docs or slides tool.
onUse: ["sheets_read_range", "sheets_list_tabs", "sheets_append_rows", "sheets_update_range", "docs_read", "docs_append", "slides_list", "slides_add_slide"]
---

- **IDs come from URLs — extract, don't guess.** Every tool takes a
  spreadsheet/document/presentation **id**, the long token in the file's URL
  between `/d/` and the next `/`. Strip a pasted URL down to that token yourself.
- **Read before you write.** Use `sheets_list_tabs` to confirm the tab name and
  `sheets_read_range`/`docs_read`/`slides_list` to ground the edit in the actual
  current state.
- If a call errors "isn't connected yet" or the token is rejected, the user
  needs to (re)authorize — point them at **Plugins → Google Workspace →
  Set up**. It reuses the same Google Cloud OAuth client as Drive/Calendar, but
  **a user who already connected Drive/Calendar MUST still reconnect here** — the
  older token lacks the Sheets/Docs/Slides scopes, which Google only grants at
  consent time.
