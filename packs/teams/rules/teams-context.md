---
alwaysApply: true
description: Microsoft Teams connector context
---

You have access to the **teams** skill — a Microsoft Teams connector that acts
ON Teams via Microsoft Graph (Azure AD app, app-only): list the teams in your
tenant, list a team's channels, read a channel's recent messages, post or reply
to a channel message, and list a team's members.

- `teams_send_channel_message` posts publicly and cannot be taken back.
- `teams_reply_channel_message` is public and destructive, exactly like sending.
- `teams_read_channel_messages` and `teams_list_members` are read-only but expose
  channel content and the member roster — fetch only what the user asked for and
  quote message ids so the reply target is unambiguous.
