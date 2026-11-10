---
alwaysApply: true
description: Microsoft Teams connector context
---

You have access to the **teams** skill — a Microsoft Teams connector that acts
ON Teams via Microsoft Graph (Azure AD app, app-only): list the teams in your
tenant, list a team's channels, read a channel's recent messages, post or reply
to a channel message, and list a team's members.

- `teams_send_channel_message` posts publicly and cannot be taken back.
- Resolve names to IDs first: `teams_list_teams` → `teams_list_channels` → send.
  Quote the exact team/channel IDs in summaries.
- `teams_reply_channel_message` is public and destructive, exactly like sending.
- `teams_read_channel_messages` and `teams_list_members` are read-only but expose
  channel content and the member roster — fetch only what the user asked for and
  quote message ids so the reply target is unambiguous.
- App-only channel messages need the `ChannelMessage.Send` permission with admin
  consent and are tenant-restricted (migration/import only on some tenants); the
  same restriction applies to `teams_reply_channel_message`. Reading needs
  `ChannelMessage.Read.All` and listing members needs `TeamMember.Read.All` —
  both application permissions with admin consent (a 403 means the app lacks the
  permission; tell the user to add it in Entra and reconnect). If Graph refuses,
  relay its exact error to the user — don't retry.
- On auth/permission errors (401), point the user to
  **Plugins → Microsoft Teams → Reconnect** and the admin-consent step, not a
  different ID.
