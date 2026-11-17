---
description: When WhatsApp needs a template instead of free text, which file URLs work, how to write phone numbers, and what an auth error means. Read it before you call a whatsapp tool.
onUse: ["whatsapp_*"]
---

- Free-form text, images, and documents (`whatsapp_send_message` /
  `whatsapp_send_image` / `whatsapp_send_document`) only reach people who messaged
  your number in the last 24h; for first contact or outside that window use
  `whatsapp_send_template`. If a send fails with a window/re-engagement error,
  fall back to a template and say why.
- `imageUrl` / `documentUrl` must be publicly reachable HTTPS URLs — Meta fetches
  the file server-side, so anything behind auth or on localhost will fail.
- Phone numbers must be international format, digits only (e.g. 447700900123).
  Report the returned message id so sends are traceable.
- On an auth / OAuthException / expired-token error, point the user to
  Plugins → WhatsApp → Reconnect (temporary tokens die after 24h; a System User
  token is permanent).
