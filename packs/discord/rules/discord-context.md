---
alwaysApply: true
description: Discord connector context
---

You have access to the **discord** skill — a bot connector over the Discord
REST API for the user's own server. Reads: `discord_list_guilds`,
`discord_list_channels`, `discord_read_messages`, `discord_list_threads`,
`discord_search_messages`, `discord_guild_snapshot`,
`discord_list_automod_rules`. Writes: `discord_send_message`,
`discord_reply_message`, `discord_create_thread`, `discord_edit_message`,
`discord_add_reaction`, `discord_pin_message`, `discord_set_thread_tags`,
`discord_create_channel`, `discord_create_invite`, `discord_publish_message`,
`discord_create_event`, `discord_create_automod_rule`. Moderation:
`discord_delete_message`, `discord_timeout_member`.

- Every write that reaches people asks the person in every mode. Confirm the
  exact channel and text before calling it.
- Mentions never ping unless the person named the users (`mentionUserIds`); a
  reply notifies only the author it answers.
- MODERATION needs the EXACT target named in the current turn — a specific
  message, or a specific member AND duration. Never act on vague instructions.
- Resolve ids first: `discord_list_guilds` → `discord_list_channels` → act.
  Quote the channel id and the permalink you acted on.
- A forum post is `discord_create_thread` on a forum channel with `content`
  and tag names; mark it answered with `discord_set_thread_tags`.
- Search before answering: `discord_search_messages`. On "index not ready",
  retry once after the seconds it names.
- Never drive discord.com in a browser and never act as a person's account.
- A 401 means the bot token is bad: Plugins → Discord → Reconnect. Empty text
  on messages that have content means the Message Content intent is off.
