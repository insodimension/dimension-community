# Slack

## What it is

One Slack connector with two ways to connect. **Connect** asks which one, and you can connect either or both.

- **A Slack bot app.** Your Dimension agent lists channels and users, reads history and threads, and posts, replies, edits, deletes and reacts as a bot you add to channels. You paste a Bot User OAuth token.
- **As you.** Your Dimension agent searches, reads and sends Slack messages **as you**, through Slack's official MCP server (`mcp.slack.com`). It uses your own sign-in, so it sees what you see and what it sends appears in your name. You bring your own Slack app: the Connect steps give you a one-click link that creates it from a ready-made manifest, and an optional "Set up with your agent" button that has the Browser plugin do the clicking while you watch.

Each way keeps its own credential, so connecting one never disconnects the other. Slack counts as connected when either is.

This pack replaces the separate `slack-user` pack. If you had `slack-user` installed and signed in, installing or enabling this pack removes the old copy and the **As you** option picks your sign-in up again without asking you to connect.

## What it contains

- Bot tools: `slack_list_channels`, `slack_read_messages`, `slack_post_message`, `slack_read_thread`, `slack_reply_thread`, `slack_add_reaction`, `slack_edit_message`, `slack_delete_message`, `slack_list_users`, `slack_upload_file`. Posting, replying, editing, deleting and uploading are write-tier: your permission mode decides whether you are asked. `slack_upload_file` shares a file from the session's folder (hidden files, anything outside the folder or reached through a link, the saved Slack tokens, and files over 25 MB are refused) and needs the `files:write` bot scope; without it the error says what to add.
- As-you tools: `slack_tools` (what Slack offers, straight from Slack), `slack_read` (read-only calls), `slack_act` (calls that change Slack; write-tier).
- Skill: `slack`, covering both identities and how to choose between them.
- Rule: `slack-context`, always on, saying which identity a call acts as, to send only what was asked for, and how to choose when both are connected.
- Connect flows:
  - **A Slack bot app**: a form for the Bot User OAuth token, a verify probe against `auth.test`, and `connect/token.template.json`, which the token is written through.
  - **As you**: OAuth 2.0 with PKCE (no client secret by default; an optional field covers an app Slack rejects with `bad_client_secret`), three permission levels (Read only, Read and send, Everything), a verify probe against `auth.test`, and `connect/slack-app-manifest.json`, the manifest the setup link pre-fills.

## Who can use it

Off by default. The bot option needs a Slack workspace where you can create and install an app. The as-you option needs a workspace where you may create an app, or where an admin will approve one, and Slack's MCP server must be available to your app. The agent-assisted setup also needs the Browser plugin; the manual steps work without it. Loads in every space.

## Limits and risks

- **The bot acts as the bot.** It only sees channels it was invited to, and `slack_edit_message` and `slack_delete_message` only work on its own messages unless the token has admin scopes. A deleted message cannot be recovered.
- **As you acts as you.** A sent message cannot be silently unsent. `slack_act`'s approval card shows the Slack tool, its arguments (the channel and the text) and the account it acts as. The account is named once Slack has been asked who you are, which `slack_tools` and `slack_read` do; before that the prompt says "you (the signed-in Slack account)".
- Every bot send names the identity on its approval card too: `As: the Slack bot app`.
- As you can read everything you can read, including private channels and DMs, within the permission level you choose at Connect.
- Slack decides what the MCP server offers. `slack_tools` reads the list at run time, and a tool counts as read-only only if Slack marks it so.
- Slack's own MCP server appends a "Sent using <app>" footer to every message it sends, and offers no setting to turn it off. So `slack_send_message` and `slack_schedule_message` skip it: they post through Slack's Web API with the same sign-in (`chat.postMessage` and `chat.scheduleMessage`), and the message appears exactly as written. The tool names and the approval card are the same, and the arguments are the ones those two tools list today (`channel_id`, `message`, `thread_ts`, `reply_broadcast`, plus `unfurl_app_links` for a send and `post_at` for a schedule). A send that Slack refuses is an error, never a retry through the MCP server. Slack Connect channels and people outside your workspace, and `draft_id`, are refused. Every other tool still runs through Slack's MCP server.
- The bot token is stored in `~/.config/dimension-slack/token.json` and the as-you sign-in in `~/.config/dimension-slack-user/token.json`, both on this machine. Slack rotates the as-you sign-in; an app left unused for about 30 days can be signed out, and you click Connect again.
- Slack allows its MCP server only for apps it lists or for internal apps; a workspace may require an admin to approve yours.
- A tool that cannot find its credential says which option to connect: Plugins, Slack, Connect, A Slack bot app or As you.

## Build and test

```sh
bun test marketplace/packs/slack
```

Run from the Dimension monorepo root. The tests use local fakes of Slack's MCP server, Web API and token endpoint and never call Slack.
