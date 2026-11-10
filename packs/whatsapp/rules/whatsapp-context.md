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
- Free-form text, images, and documents (`whatsapp_send_message` /
  `whatsapp_send_image` / `whatsapp_send_document`) only reach people who messaged
  your number in the last 24h; for first contact or outside that window use
  `whatsapp_send_template`. If a send fails with a window/re-engagement error,
  fall back to a template and say why.
- `imageUrl` / `documentUrl` must be publicly reachable HTTPS URLs — Meta fetches
  the file server-side, so anything behind auth or on localhost will fail.
- This connector is outbound-only: it CANNOT read, receive, or fetch incoming
  WhatsApp messages (that needs a Meta webhook + inbound server, out of scope).
  If asked to "check"/"read" WhatsApp, explain the boundary rather than guessing.
- Phone numbers must be international format, digits only (e.g. 447700900123).
  Report the returned message id so sends are traceable.
- On an auth / OAuthException / expired-token error, point the user to
  Plugins → WhatsApp → Reconnect (temporary tokens die after 24h; a System User
  token is permanent).
