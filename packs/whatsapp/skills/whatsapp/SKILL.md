---
name: whatsapp
description: Send WhatsApp messages (free-form text, pre-approved templates, images, and documents) via the Meta WhatsApp Cloud API. Use when the user asks to text/message/notify someone on WhatsApp, ping a phone number, send a WhatsApp template, or share an image/file over WhatsApp.
---

# WhatsApp (Meta Cloud API)

Send WhatsApp messages through Meta's WhatsApp Cloud API. This is an **outbound**
connector — the agent sends messages FROM the connected business/test number; it
does not receive or read incoming chats (see "What this connector can NOT do"
below). Four tools are provided:

- `whatsapp_send_message` — free-form text to one recipient.
- `whatsapp_send_template` — a pre-approved message template to one recipient.
- `whatsapp_send_image` — an image (from a public HTTPS URL) to one recipient.
- `whatsapp_send_document` — a document/file (from a public HTTPS URL) to one recipient.

## Setup

Connection is handled by the plugin's Connect dialog: **Plugins → WhatsApp → Set
up**. It walks the user through creating a Meta Business app, adding the WhatsApp
product (which grants a free test phone number), and pasting the **Phone number
ID** plus an **access token**. If a tool call fails with an auth/OAuthException
error, the token has expired (temporary tokens last only 24h) — send them back to
**Plugins → WhatsApp → Reconnect** to paste a fresh or permanent System User
token.

## The 24-hour window (the rule that governs which tool to use)

WhatsApp only allows **free-form text** to a person who messaged your number
within the **last 24 hours** (the "customer-service window"). Outside that window,
or for the very first message to someone, WhatsApp requires a **pre-approved
template**.

- Recipient replied to you in the last 24h → `whatsapp_send_message`.
- First contact, or the window has closed → `whatsapp_send_template`.

If `whatsapp_send_message` fails with a re-engagement / window error, fall back to
`whatsapp_send_template` and tell the user why.

## Sending a text message

`whatsapp_send_message` takes `to` (recipient in international format, digits
only — e.g. `447700900123`) and `body` (the text). It returns the sent message id.

> User: "Text +1 415 555 2671 that the deploy is done."
> → `whatsapp_send_message({ to: "14155552671", body: "The deploy is done ✅" })`

## Sending a template

`whatsapp_send_template` takes `to`, `template` (the approved template name, e.g.
`hello_world`), and optional `languageCode` (defaults to `en_US`). Templates with
variables are not parameterized by this tool — use a template whose body is fixed,
or one whose defaults suffice.

> User: "Send the hello_world template to +44 7700 900123."
> → `whatsapp_send_template({ to: "447700900123", template: "hello_world" })`

## Sending an image

`whatsapp_send_image` takes `to`, `imageUrl` (a **publicly reachable HTTPS URL** —
Meta downloads the file server-side, so it must load without auth), and an optional
`caption`. Same 24-hour window rule as text: media only reaches someone who
messaged your number within the last 24h; outside that window a pre-approved
template is required and the send will fail. Returns the sent message id.

> User: "Send this chart to +1 415 555 2671 on WhatsApp: https://example.com/chart.png"
> → `whatsapp_send_image({ to: "14155552671", imageUrl: "https://example.com/chart.png", caption: "Latest chart" })`

## Sending a document

`whatsapp_send_document` takes `to`, `documentUrl` (a **publicly reachable HTTPS
URL**), and optional `filename` (what the recipient sees, e.g. `invoice.pdf`) and
`caption`. Same 24-hour window rule as text and images. Returns the sent message id.

> User: "WhatsApp the invoice PDF to +44 7700 900123."
> → `whatsapp_send_document({ to: "447700900123", documentUrl: "https://example.com/invoice.pdf", filename: "invoice.pdf" })`

## Safety

- **Sending is destructive and irreversible.** Never guess a phone number.
- Phone numbers must be in international format (country code + number, digits
  only). Report the message id back so the send is traceable.
- Meta's error message is surfaced verbatim on failure — relay it to the user
  (common causes: recipient not in the test-number allow-list, or the 24h window
  has closed).
- Test numbers can only message up to 5 pre-registered recipients.

## What this connector can NOT do

This is an **outbound-only** connector. It has no way to READ or receive WhatsApp
messages — incoming chats are completely invisible to the agent. That is a
**platform constraint, not a missing tool**: WhatsApp delivers inbound messages
by POSTing them to a Meta **webhook**, which requires a publicly reachable
**inbound server** to receive and store them. This plugin is a stateless local
client that only calls the Cloud API's send endpoint; there is no server, no
inbox, and no message history to query.

So the agent CANNOT:

- read what someone sent you, or fetch a conversation/history;
- know whether a recipient has messaged you in the last 24h (you have to tell it,
  or find out when a text send fails with a re-engagement/window error);
- receive replies, delivery receipts, or read receipts.

If the user asks to "check my WhatsApp" or "read the last message", explain this
boundary — it needs a webhook-backed inbound service, which is out of scope for
this connector.
