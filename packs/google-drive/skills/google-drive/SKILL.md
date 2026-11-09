---
name: google-drive
description: List, search, read — and with a full-access connection upload, organize, and share — files in the connected Google account's Drive via native `google_drive_*` tools (no CLI, no MCP server). Use when the user asks to find, open, summarize, upload, move, or share a file in their Google Drive/Docs/Sheets/Slides.
---

# Google Drive

Native tools — no bash, no CLI, no MCP server. The mounted set depends on the
access level chosen at connect time:

**Always (read-only scope, the default):**

- `google_drive_list_files({ query?, pageSize? })` — list/search files, newest-modified first.
- `google_drive_read_file({ fileId })` — read a file's content as text.

**Only with a full-access connection** (the "Full access" choice in the
connect dialog — `drive` scope):

- `google_drive_upload_file({ path, name?, folderId?, convertTo? })` — upload a
  local file; `convertTo` a Workspace mimeType creates a Doc/Sheet from it.
- `google_drive_create_folder({ name, parentId? })`
- `google_drive_move_file({ fileId, newName?, targetFolderId? })` — rename and/or move.
- `google_drive_share_file({ fileId, emailAddress?, role? })` — grant access
  (specific account, or anyone-with-the-link when no email) and return the link.

Every write tool MUTATES the user's Drive. If a write intent arrives but only the two read tools
are mounted, the connection is read-only: reconnect choosing "Full access",
then start a new conversation.

References (load on demand):

- `references/setup.md` — the Google Cloud OAuth client walkthrough (the one
  manual step; ~5 minutes, one-time, per user).

## Setup

If a call returns "Google Drive isn't connected yet", the user hasn't
completed the OAuth connect flow — point them at **Plugins → Google Drive →
Set up** in the app (or run `/plugins` if there's no GUI in scope). If they
ask HOW to get the Client ID/Secret the form wants, walk them through
`references/setup.md` — it needs a one-time Google Cloud project, not
anything Dimension can provision on their behalf.

## Query syntax cookbook

`query` uses [Drive's search syntax](https://developers.google.com/drive/api/guides/search-files)
(`q` parameter), not free text. Common intents:

| Ask | `query` |
|---|---|
| "find my budget spreadsheet" | `name contains 'budget' and mimeType = 'application/vnd.google-apps.spreadsheet'` |
| "PDFs from last week" | `mimeType = 'application/pdf' and modifiedTime > '2026-06-24T00:00:00'` |
| "anything named X" | `name contains 'X'` |
| "files in a folder" | `'<folderId>' in parents` (get `folderId` from a prior list call) |
| no filter | omit `query` — returns the most recently modified files |

Quote the exact `fileId` from a list result before reading it — never guess one.

## Reading files

`google_drive_read_file` handles both cases transparently:

- **Plain files** (PDFs, text, code, images-as-bytes) — downloaded raw.
- **Native Google Docs/Sheets/Slides** have no raw bytes; they're auto-**exported**
  (Docs/Slides → plain text, Sheets → CSV) so the content is always readable text.

Content over ~200KB is truncated — say so if you hit the limit and the user
needs the rest (there's no partial-range read yet; note it as a known gap).

## Safety / privacy

- Read-only connection: nothing can be mutated. Full access: the write tools
  mutate it.
- Don't paste a whole file's content into the transcript when a summary
  answers the question; large dumps cost context for no benefit.
- Respect that Drive contents may include other people's private data (shared
  files) — summarize rather than quote verbatim unless the user asks for exact text.
