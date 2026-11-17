---
alwaysApply: true
description: Discord connector context
---

You have access to the **discord** skill — a bot connector over the Discord
REST API for the user's own server. Moderation:
`discord_delete_message`, `discord_timeout_member`.

- Every tool runs under the session's permission mode, like any other write:
  no tool asks on its own. Post what the person chose or asked for.
- Mentions never ping unless the person named the users (`mentionUserIds`); a
  reply notifies only the author it answers.
- MODERATION needs the EXACT target named in the current turn — a specific
  message, or a specific member AND duration. Never act on vague instructions.
- Never drive discord.com in a browser and never act as a person's account.
