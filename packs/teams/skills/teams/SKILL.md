---
name: teams
description: Act on Microsoft Teams from the agent — list the teams in your tenant, list a team's channels, read a channel's recent messages, post or reply to a channel message, and list a team's members, over Microsoft Graph (Azure AD app, app-only). Use when the user asks to post/announce to a Teams channel, read a channel, reply in a channel, see their teams or a team's members, or find a team's channels.
---

# Microsoft Teams (Microsoft Graph, app-only)

Outbound connector: the agent acts ON Microsoft Teams via the Graph REST API
(`https://graph.microsoft.com/v1.0`) using an Azure AD app registration and the
**client-credentials** grant — an application identity, not a signed-in user.
The six tools are registered by the plugin's `index.ts`; it exchanges the
stored `{tenantId, clientId, clientSecret}` for a Graph token on demand and
caches it in memory.

## Setup

Connect via **Plugins → Microsoft Teams → Set up**. The wizard walks through
registering an Azure AD app, copying the tenant/client IDs, creating a client
secret, and — critically — granting these **Microsoft Graph application
permissions with admin consent**:

| Application permission | Enables |
| --- | --- |
| `Group.Read.All` | enumerate teams (`teams_list_teams`) |
| `Channel.ReadBasic.All` | list channels (`teams_list_channels`) |
| `ChannelMessage.Send` | post & reply to channel messages (`teams_send_channel_message`, `teams_reply_channel_message`) |
| `ChannelMessage.Read.All` | read channel messages (`teams_read_channel_messages`) |
| `TeamMember.Read.All` | list team members (`teams_list_members`) |

All five are **application** permissions, and each needs **admin consent**. If
you connected before the last two existed, re-add `ChannelMessage.Read.All` and
`TeamMember.Read.All` in Entra (App registrations → API permissions → Microsoft
Graph → Application permissions), **re-grant admin consent**, then
**Plugins → Microsoft Teams → Reconnect** — otherwise the read and members tools
return 403.

There is **no connection probe** for this plugin: the client-credentials token
exchange happens inside `index.ts`, out of the engine's reach. **The first tool
call is the real test** — if the app is misconfigured or lacks admin consent,
`teams_list_teams` returns a clear 401/permission error. Re-run
**Plugins → Microsoft Teams → Reconnect** after fixing consent in Azure.

## Tools

- **`teams_list_teams`** — no arguments. Lists teams in the tenant as
  `id  displayName — description`. Copy the id for the next call.
- **`teams_list_channels`** — `{ teamId }`. Lists that team's channels as
  `id  displayName — description`.
- **`teams_send_channel_message`** — `{ teamId, channelId, content }`. Posts
  `content` to the channel. `content` is plain text (Graph also accepts basic
  HTML like `<b>`, `<br>`, `<a>`).
- **`teams_read_channel_messages`** — `{ teamId, channelId, limit? }`. Reads the
  most recent messages (default 20, capped at 50) as `sender · timestamp` then
  the message text with HTML stripped and truncated. Needs
  `ChannelMessage.Read.All` (403 without it). Copy a message id from here to
  reply.
- **`teams_reply_channel_message`** — `{ teamId, channelId, messageId, content }`.
  Posts `content` as a reply under the given top-level message. Same app-only
  send caveats as `teams_send_channel_message`.
- **`teams_list_members`** — `{ teamId }`. Lists members as `displayName · roles`
  (e.g. owner/member). Needs `TeamMember.Read.All` (403 without it).

Typical flow — post to a named channel:

```
teams_list_teams                                  # find the team id
teams_list_channels { teamId: "<team-id>" }       # find the channel id
teams_send_channel_message { teamId, channelId, content: "Release 1.4 is live 🎉" }
```

Typical flow — read a channel, then reply:

```
teams_list_teams                                          # find the team id
teams_list_channels { teamId: "<team-id>" }               # find the channel id
teams_read_channel_messages { teamId, channelId }         # find a message id
teams_reply_channel_message { teamId, channelId, messageId, content: "On it 👍" }
```

Inspect a team's roster:

```
teams_list_members { teamId: "<team-id>" }                # displayName · roles
```

## App-only send restriction (important)

Posting a channel message **as an application** requires the
`ChannelMessage.Send` application permission with admin consent, and Microsoft
**restricts app-only channel messages to migration/import scenarios on some
tenants**. When a tenant refuses, Graph returns an error and the tool surfaces
that message **verbatim** — relay it to the user rather than retrying. On such
tenants, posting must be done by a signed-in user (delegated permissions),
which this connector does not use.

## Safety

- **Posting is destructive and public.** `teams_send_channel_message` cannot be
  taken back.
- **Replying is likewise destructive and public.**
- **Reading still exposes content:** `teams_read_channel_messages` and
  `teams_list_members` surface channel messages and the member roster — fetch
  only what the user asked for, and quote message ids so the reply target is
  unambiguous.
- Quote the exact team id and channel id in summaries so the target is
  unambiguous.
- On a 401 or permission error, don't guess at other IDs — point the user to
  **Plugins → Microsoft Teams → Reconnect** and the admin-consent step above.
