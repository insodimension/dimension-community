---
description: How the Microsoft Teams tools resolve team and channel ids, which Graph permissions each needs, and what a 401 or 403 means. Read it before you call a teams tool.
onUse: ["teams_*"]
---

- Resolve names to IDs first: `teams_list_teams` → `teams_list_channels` → send.
  Quote the exact team/channel IDs in summaries.
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
