# Discord

## What it is

A Discord connector for your own server, through a bot you create: your agent reads channels and forum posts, searches for earlier answers, replies, posts announcements, opens forum posts, creates invites and events, sets up AutoMod, and reads a snapshot of the server's state.

## What it contains

- **Twenty-one native tools** over the Discord REST API v10. Reads: `discord_list_guilds`, `discord_list_channels`, `discord_read_messages`, `discord_list_threads`, `discord_search_messages`, `discord_guild_snapshot`, `discord_list_automod_rules`. Writes: `discord_send_message`, `discord_reply_message`, `discord_create_thread`, `discord_edit_message`, `discord_add_reaction`, `discord_pin_message`, `discord_set_thread_tags`, `discord_create_channel`, `discord_create_invite`, `discord_publish_message`, `discord_create_event`, `discord_create_automod_rule`. Moderation: `discord_delete_message`, `discord_timeout_member`.
- **Skill `discord`**: setup and bot permissions, every tool, the mention policy, formatting and safety.
- **Rule `discord-context`**: always-on guidance for the tools.

## Who can use it

Off by default; turn it on in Plugins. You create a bot in the Discord Developer Portal, turn on the Message Content intent, paste its token, and invite it to your server with the permissions the setup lists.

## Limits and risks

- **Only your bot, only your servers.** It never acts as your Discord account and never drives discord.com in a browser: Discord bans automating user accounts.
- **Posting goes straight out; edits and moderation ask you.** Messages, replies, forum posts, publishes and events post as soon as you choose or ask for them. Edits, deletes, timeouts, invites and AutoMod rules ask you every time, in every approval mode.
- **Mentions never ping by default.** `@everyone`, `@here`, roles and users in the text notify nobody unless you name the users; a reply notifies only the person it answers.
- **Server Insights are not readable by a bot.** Joins, retention and Discovery reach stay in the Discord app.
- **Search may be warming up.** On a new or large server Discord answers "index not ready" for a while.

## Build and test

`bun test test/` from this folder runs the approval, mention, message-rendering, forum, search, snapshot and AutoMod tests against a stubbed Discord API.
