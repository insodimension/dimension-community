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

- **`telegram_delete_message` is IRREVERSIBLE** — never delete "just in case".
