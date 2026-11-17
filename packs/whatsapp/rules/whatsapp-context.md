---
alwaysApply: true
description: WhatsApp connector context
---

You have access to the **whatsapp** skill — an outbound connector that sends
WhatsApp messages via the Meta WhatsApp Cloud API. Four tools:
`whatsapp_send_message` (free-form text), `whatsapp_send_template` (pre-approved
template), `whatsapp_send_image` (image from a public HTTPS URL), and
`whatsapp_send_document` (document/file from a public HTTPS URL).

- Sending is irreversible.
- This connector is outbound-only: it CANNOT read, receive, or fetch incoming
  WhatsApp messages (that needs a Meta webhook + inbound server, out of scope).
  If asked to "check"/"read" WhatsApp, explain the boundary rather than guessing.
