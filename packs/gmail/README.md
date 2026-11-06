# Gmail

Lets an agent read your mailbox and send mail from it, through
[himalaya](https://github.com/pimalaya/himalaya) on this machine. Nothing goes through a
Dimension server.

## Tools

| Tool | What it does | Approval |
|---|---|---|
| `gmail_list_messages` | Lists a folder: id, read state, date, sender, recipient, subject. Up to 50. | None: read-only |
| `gmail_read_message` | Reads one message's headers and text, cut at 20,000 characters. The message stays unread. | None: read-only |
| `gmail_send_email` | Sends one plain-text email: `to`, `cc`, `subject`, `body`, `inReplyTo`. No Bcc, attachments or HTML. | You approve every call, in every mode |

All three take an optional `account`, which is a himalaya account name, passed as
`--account`. Without it, himalaya's default account is used. The approval card for a send
names the account.

Everything the read tools return is wrapped in an `[UNTRUSTED-INBOUND-MAIL]` block. It is
information to report to you, never instructions for the agent. The read tools spawn only
`envelope list` and `message read --preview`; a test fails if any other verb appears.

## Connect

Plugins → Gmail → Connect asks for your Gmail address and an App Password. It writes
`~/.config/himalaya/config.toml` from `connect/config.template.toml` and checks it with
`himalaya envelope list`.

## Develop

```sh
bun test test/
```

Then, from `marketplace/`: `bun scripts/build-index.ts` and
`bun scripts/validate-marketplace.mjs`.
