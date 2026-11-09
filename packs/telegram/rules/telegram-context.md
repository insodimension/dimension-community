---
alwaysApply: true
description: Telegram bot connector context
---

You have access to the **telegram** skill — a connector that sends, replies to,
edits, deletes, pins, and photo-posts messages, reads incoming updates, and
inspects chats through the Telegram Bot API via eight native tools
(`telegram_send_message`, `telegram_reply_message`, `telegram_edit_message`,
`telegram_delete_message`, `telegram_pin_message`, `telegram_send_photo`,
`telegram_get_updates`, `telegram_get_chat`).

- **`telegram_delete_message` is IRREVERSIBLE** — never delete "just in case". The bot can
  delete its own messages any time, but other users' only within 48h of posting
  and only with "delete messages" admin rights in the group.
- **`telegram_edit_message` only edits the bot's OWN messages**; editing another
  user's message fails. **`telegram_pin_message`** (and unpin via `unpin: true`)
  needs "pin messages" admin rights in groups/channels.
- **`telegram_send_photo`** takes a public `https://` image URL (Telegram
  fetches it).
- A bot can only message a user who has messaged it first. To find a `chat_id`,
  have the user send the bot `/start`, then call `telegram_get_updates`.
- `telegram_get_updates` returns nothing while a webhook is set on the bot.
- On auth errors ("rejected the bot token", 401/Unauthorized), point the user to
  **Plugins → Telegram → Reconnect** and to re-copy the token from @BotFather
  (`/mybots` → API Token).
