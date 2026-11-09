---
name: telegram
description: Send, reply, edit, delete, pin, and photo-post messages, read incoming updates, and inspect chats on Telegram via the Bot API — using native telegram_send_message / telegram_reply_message / telegram_edit_message / telegram_delete_message / telegram_pin_message / telegram_send_photo / telegram_get_updates / telegram_get_chat tools (no CLI, no MCP server). Use when the user asks to send/reply/edit/delete/pin a Telegram message, post a photo, read their latest bot messages, or find a chat id.
---

# Telegram (Bot API)

Eight always-on, native tools — no bash, no CLI, no MCP server:

- `telegram_send_message({ chatId, text })` — send a text message. **DESTRUCTIVE.**
- `telegram_reply_message({ chatId, messageId, text })` — reply threaded under a message. **DESTRUCTIVE.**
- `telegram_edit_message({ chatId, messageId, text })` — rewrite one of the bot's OWN messages. **DESTRUCTIVE.**
- `telegram_delete_message({ chatId, messageId })` — delete a message. **IRREVERSIBLE.**
- `telegram_pin_message({ chatId, messageId, unpin?, disable_notification? })` — pin/unpin a message. **DESTRUCTIVE.**
- `telegram_send_photo({ chatId, photoUrl, caption? })` — post a photo by https URL. **DESTRUCTIVE.**
- `telegram_get_updates({ limit?, offset? })` — read recent incoming messages.
- `telegram_get_chat({ chatId })` — look up a chat's title/type/username/description.

The connector talks to `https://api.telegram.org/bot<token>/METHOD`. The bot
token rides the URL path — there is no separate login. Telegram replies
`{ok, result|description}`; the tools throw the `description` on failure.

## Setup

If a call returns "Telegram isn't connected yet", the user hasn't finished the
connect flow — point them at **Plugins → Telegram → Set up** in the app (or run
`/plugins` if there's no GUI). Setup is quick and one-time:

1. Open **@BotFather** in Telegram and send `/newbot`.
2. Pick a display name and a unique username ending in `bot`.
3. Copy the HTTP API token BotFather replies with into the connect form.

BotFather is the only way to mint a bot token — Dimension can't provision one.

## Discovering a chat_id (the key gotcha)

**A bot can only message a user who has messaged it first.** So the first send
to a new person always needs their `chat_id`:

1. Ask the user (or the recipient) to open the bot and send it `/start`.
2. Call `telegram_get_updates` — each line shows `[chat <id> "<title>"] <sender>: <text>`.
3. Use that `<id>` as `chatId` in `telegram_send_message`.

`telegram_get_updates` returns nothing while a **webhook** is set on the bot
(getUpdates and webhooks are mutually exclusive). Groups/channels: add the bot
as a member first; channel usernames can be passed as `@channelusername`.

## Usage patterns

Send a notification:

```text
telegram_send_message({ chatId: "123456789", text: "Build finished ✅" })
→ Sent to Sameer (chat 123456789) — message_id 42.
```

Read recent messages / find who wrote:

```text
telegram_get_updates({ limit: 20 })
→ [chat 123456789 "Sameer"] @sameer: what's the status?
```

Inspect a chat:

```text
telegram_get_chat({ chatId: "-1001122334455" })
→ id: -1001122334455 / type: supergroup / title: Dev Alerts
```

## Editing & moderation


All of these take a numeric `messageId` (from `telegram_get_updates`) alongside
the `chatId`. Acting on the wrong id is easy and, for delete, unrecoverable.

Reply threaded under a message:

```text
telegram_reply_message({ chatId: "123456789", messageId: 42, text: "On it 👍" })
→ Replied in Sameer (chat 123456789) to message 42 — new message_id 43.
```

Edit — the bot can ONLY edit **its own** messages (`editMessageText`); editing
someone else's fails. Pass the full replacement text:

```text
telegram_edit_message({ chatId: "123456789", messageId: 43, text: "Done ✅" })
→ Edited message 43 in Sameer (chat 123456789).
```

Delete — **irreversible.** The
bot deletes its **own** messages at any time; **other users' messages only within
48 hours** of posting AND only when the bot has "delete messages" **admin
rights** in the group. Outside those bounds Telegram rejects the call:

```text
telegram_delete_message({ chatId: "-1001122334455", messageId: 99 })
→ Deleted message 99 from chat -1001122334455.
```

Pin / unpin — needs "pin messages" **admin rights** in groups/channels. Pass
`unpin: true` to unpin; `disable_notification: true` pins silently:

```text
telegram_pin_message({ chatId: "-1001122334455", messageId: 42, disable_notification: true })
→ Pinned message 42 in chat -1001122334455.
telegram_pin_message({ chatId: "-1001122334455", messageId: 42, unpin: true })
→ Unpinned message 42 in chat -1001122334455.
```

Send a photo — pass a public `https://` image URL (Telegram fetches it, <5MB):

```text
telegram_send_photo({ chatId: "123456789", photoUrl: "https://example.com/chart.png", caption: "Latest chart" })
→ Sent photo to Sameer (chat 123456789) — message_id 44.
```

## Safety

- A sent Telegram message can't be recalled after 48h and is instantly visible
  to the recipient.
- Never send to a `chat_id` you're unsure about; verify it with
  `telegram_get_chat` or `telegram_get_updates` first.
- Reply/edit/pin/photo are destructive; **delete is irreversible**.
- **Delete rule:** the bot deletes its own messages any time, but other users'
  messages only within **48h** of posting and only with "delete messages" admin
  rights. **Pin rule:** pinning/unpinning in groups/channels needs "pin
  messages" admin rights. If Telegram returns a rights/time error, the bot lacks
  the permission or the window has passed — don't retry blindly.
- On "rejected the bot token" / 401, the token is stale — reconnect via
  **Plugins → Telegram → Reconnect** (re-copy from @BotFather `/mybots`).
