---
description: What the Telegram bot may delete, edit and pin, how photos and chat ids work, and what an auth error means. Read it before you call a telegram tool.
onUse: ["telegram_*"]
---

- The bot can
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
