---
alwaysApply: true
description: Google Drive connector context
---

You have access to the **google-drive** skill — native tools over the connected
Google account's Drive. No CLI, no MCP server. The tool surface depends on the
access level chosen at connect time:

- **Read-only connection** (default): `google_drive_list_files`,
  `google_drive_read_file`. Nothing can be mutated.
- **Full-access connection** additionally mounts `google_drive_upload_file`,
  `google_drive_create_folder`, `google_drive_move_file`,
  `google_drive_share_file`. Every one of these MUTATES the user's Drive or its
  sharing.

- `query` is Drive search syntax (`name contains '...'`, `mimeType = '...'`),
  not free text — see the skill's `references/setup.md` cookbook.
- Quote the exact `fileId` a list call returned before reading it — never guess one.
- If a call errors "isn't connected yet", the user needs to complete the OAuth
  connect flow (Plugins → Google Drive → Set up) — point them at the skill's
  `references/setup.md` if they ask how to get a Client ID/Secret.
- If the user asks for an upload/move/share but only the two read tools are
  mounted, they connected read-only: tell them to reconnect choosing "Full
  access" (Plugins → Google Drive), then start a new conversation.
- Prefer summarizing file content over quoting large excerpts verbatim,
  especially for files that may contain another person's private data.
