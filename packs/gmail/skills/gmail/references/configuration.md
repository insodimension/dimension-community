# Gmail himalaya configuration

Configuration file location: `~/.config/himalaya/config.toml`

## 1. Create a Gmail App Password (no Google Cloud project needed)

App Passwords require 2-Step Verification to be ON:

1. Google Account → **Security**.
2. Enable **2-Step Verification** if it is not already on.
3. Security → **App passwords** → create one (name it e.g. "himalaya").
4. Copy the generated **16-character** value — that is the password himalaya uses (not your normal Google password).

> **Advanced Protection accounts cannot use App Passwords.** Those accounts must
> use the OAuth/MCP variant (see the package's plan Assumptions) or himalaya's
> `oauth2` backend (bottom of this file).

## 2. Gmail config block

```toml
[accounts.gmail]
email = "you@gmail.com"
display-name = "Your Name"
default = true

# IMAP — reading
backend.type = "imap"
backend.host = "imap.gmail.com"
backend.port = 993
backend.encryption.type = "tls"
backend.login = "you@gmail.com"
backend.auth.type = "password"
backend.auth.cmd = "pass show google/app-password"

# SMTP — sending
message.send.backend.type = "smtp"
message.send.backend.host = "smtp.gmail.com"
message.send.backend.port = 587
message.send.backend.encryption.type = "start-tls"
message.send.backend.login = "you@gmail.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.cmd = "pass show google/app-password"
```

## 3. Where to put the App Password (pick one — never paste it raw)

### Password from a command (recommended)

```toml
backend.auth.cmd = "pass show google/app-password"
# macOS keychain example:
# backend.auth.cmd = "security find-generic-password -a you@gmail.com -s gmail -w"
```

### System keyring (requires the keyring feature)

```toml
backend.auth.keyring = "gmail-imap"
```

Then run `himalaya account configure gmail` to store the password in the keyring.

### Raw (testing only — do not commit or share)

```toml
backend.auth.raw = "your-16-char-app-password"
```

## 4. Verify standalone

```bash
himalaya envelope list
```

Returns recent mail → the connector is ready.

## Folder aliases (optional)

Gmail labels surface as folders. Map friendly names if desired:

```toml
[accounts.gmail.folder.alias]
inbox = "INBOX"
sent = "[Gmail]/Sent Mail"
drafts = "[Gmail]/Drafts"
trash = "[Gmail]/Trash"
all = "[Gmail]/All Mail"
```

## Multiple accounts

```toml
[accounts.gmail]
email = "you@gmail.com"
default = true
# ... backend config ...

[accounts.work]
email = "you@company.com"
# ... backend config ...
```

Switch with `--account`:

```bash
himalaya --account work envelope list
```

The tools take the same name in their `account` argument, for example
`gmail_list_messages` with `account: "work"`. `himalaya account list` shows the
names. Left out, they use the account marked `default = true`.

## OAuth2 (Advanced Protection / no App Password)

```toml
backend.auth.type = "oauth2"
backend.auth.client-id = "your-client-id"
backend.auth.client-secret.cmd = "pass show google/oauth-client-secret"
backend.auth.access-token.cmd = "pass show google/oauth-access-token"
backend.auth.refresh-token.cmd = "pass show google/oauth-refresh-token"
backend.auth.auth-url = "https://accounts.google.com/o/oauth2/v2/auth"
backend.auth.token-url = "https://oauth2.googleapis.com/token"
```
