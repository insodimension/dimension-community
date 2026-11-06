# Gotchas — gmail skill

Append-only log of real send/threading incidents and their fixes. The fix
lives in `composition.md`/`SKILL.md` where it's promoted into the default
workflow — entries here are breadcrumbs for WHY that guidance exists.

**Format:**
```markdown
### YYYY-MM-DD — <one-line title>
Symptom → cause → fix. See <promoted-ref> for the full pattern.
Context: <what the task was>.
```

---

### 2026-07-02 — a hand-built reply template landed as a NEW Gmail conversation, not in the thread
Symptom → user reported "I don't see it in that thread" after a reply sent successfully (confirmed present in Sent/`[Gmail]/Sent Mail`, correct `In-Reply-To`, correct recipients). Cause → two silent threading breaks in the same message: (1) the raw template only set `In-Reply-To`, never `References` — Gmail's own conversation view folds a reply into its thread by matching the `References` chain, not just `In-Reply-To` + subject; (2) the original subject contained an en-dash (`–`) that got flattened to a plain hyphen (`-`) when retyped from a rendered header/table view, breaking Gmail's exact-subject thread match too. Fix → always set `References` = original's `References` + original's `Message-Id`, space-separated; always pull `Subject` via `himalaya message read <id> -H Subject` (never retype from a table) and reuse it byte-for-byte. See [composition.md § Replying in the same thread](composition.md#replying-in-the-same-thread).
Context: replying to a multi-message business thread (OPC company registration) with attachments, built by hand with no human at an editor (needed to attach files pulled from the Locker).

### 2026-07-02 — `himalaya message delete` fails on Gmail: no folder named "Trash"
Symptom → `himalaya message delete <id> -f "[Gmail]/Drafts"` → `unexpected NO response: No folder Trash`. Cause → the command's default move-to-trash target is the literal name `Trash`; Gmail's trash folder is `[Gmail]/Trash`, and there's no flag to override the target folder name on `message delete` in the installed version. Fix → `himalaya flag add <id> -f <folder> deleted` instead — sets the `\Deleted` flag directly, works regardless of trash-folder naming, and Gmail purges flagged messages on its own schedule. Run `himalaya folder list` first if a folder name is ever assumed rather than confirmed (Gmail's Drafts is `[Gmail]/Drafts`, not `Drafts`, for the same reason).
Context: cleaning up a stale draft after sending a corrected version of the same reply directly instead.

### 2026-11-04 — sending moved into one tool; hand-built mail is no longer a path
Symptom → mail sent from bash never reached the approval card or the Clients send gate, both of which watch tool calls by name; and a message body that carries markup tags for attachments can pull a local file (for example the stored mailbox password) into the outgoing mail. Cause → sending was a himalaya command typed by the agent, with the body handed to himalaya's message-markup compiler unescaped. Fix → `gmail_send_email` is the only way mail leaves. It writes the message itself, turns every markup tag in the body into plain text, and sets both reply headers from `inReplyTo`. This supersedes the 2026-07-02 reply-threading guidance about building headers by hand; the exact-subject rule from that entry still applies and is in `composition.md`. See `SKILL.md` and `composition.md`.
Context: building the native send tool for the Clients space, which needs every email to be a tool call a person can approve.

### 2026-11-04 — reading moved into two read-only tools; a bash read marks the message seen
Symptom → the Clients agents have no bash, so they could not read replies; and `himalaya message read` in bash marks the message as seen, so reading quietly changed the mailbox the person relies on. Cause → reading was a himalaya command typed by the agent, whose output (a stranger's words) arrived with no label saying it was data. Fix → `gmail_list_messages` and `gmail_read_message` run only `envelope list` and `message read --preview` (preview is the flag that leaves the seen state alone), never a verb that sends or sets a flag, and return everything inside an `[UNTRUSTED-INBOUND-MAIL]` block. `himalaya message read` is not for reading in bash any more. See `SKILL.md` § Read / search.
Context: giving the Clients space's agents the mailbox, so a campaign can see replies without a human pasting them.

### 2026-11-04 — the tools could only use the default account, so campaign mail could not go out from the `company` mailbox
Symptom → the owner wanted Clients campaign mail sent from his `company` himalaya account, but `gmail_list_messages`, `gmail_read_message` and `gmail_send_email` ran every himalaya call without `--account`, so they always used the default account (`gmail`); a bash send with `--account` is not an answer, because mail only leaves through the tool. Cause → the tools had no way to name an account. Fix → all three take an optional `account`, a plain himalaya account name (letters, digits, `_`, `.`, `-`, at most 64 characters), passed as `--account <name>` to every himalaya call the tool makes, before any `--`. The sender lookup reads the chosen account's address, and the send approval card shows `From account:`. Without `account` nothing changes. See `SKILL.md` § Accounts and `composition.md`.
Context: pointing the Clients space's campaign mail at the `company` account.

## Append-only rules

1. Promote the fix into `composition.md`/`SKILL.md` BEFORE appending here — this file is the breadcrumb, not the source of truth.
2. Use absolute dates. Never relative.
3. One entry per discrete learning.
4. Never edit existing entries — supersede with a new dated entry instead.
