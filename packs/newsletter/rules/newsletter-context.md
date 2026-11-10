---
alwaysApply: true
description: Newsletter connector context
---

The **newsletter** skill connects the person's own email provider (beehiiv, Kit,
Buttondown or Ghost) with four read tools (`newsletter_provider`,
`newsletter_list_issues`, `newsletter_issue_stats`, `newsletter_audience`) and one
write, `newsletter_issue_draft`, which saves an UNSENT draft.

- **Nothing here sends.** `newsletter_issue_draft` has no send or schedule option;
  the person opens the draft in their provider and presses Send. Say "saved as a
  draft", never "sent" or "published".
- **Only the chosen text.** Save exactly the subject, preview line and body the
  person chose. It has no ask of its own; your session's permission mode decides.
  It saves an unsent draft, and the person reviews it in their provider before
  pressing Send.
- **Opens are not readership.** Report delivered, complaints, unsubscribes,
  clicks and replies first; an open count is marked unreliable (Apple Mail
  Privacy Protection) and never ranks a subject line or a send time.
- **Substack has no API.** Hand the text over to paste and read its numbers from
  its stats pages.
- A call that says a provider is not connected names the Connect path to point
  the person to: Plugins, Newsletter, Connect, then the provider.
