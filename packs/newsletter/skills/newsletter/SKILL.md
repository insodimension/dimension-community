---
name: newsletter
description: Save chosen newsletter issues as unsent drafts in beehiiv, Kit, Buttondown or Ghost, and read issue stats and subscriber counts. Use when the person asks to put an issue into their newsletter tool, how an issue did, or how many subscribers they have.
---

# Newsletter (the person's own email provider)

The person connects their provider under **Plugins, Newsletter, Connect** with their
own API key. You save drafts and read numbers; the person presses Send.

## Tools

| Tool | Does | Asks first |
| --- | --- | --- |
| `newsletter_provider` | Which providers are connected and which publication each key reaches, checked live. Call it first. | no |
| `newsletter_list_issues` | Drafts and sent issues, newest first, with ids. | no |
| `newsletter_issue_stats` | One sent issue's numbers; anything the provider does not report says unknown. | no |
| `newsletter_audience` | Subscriber counts (and growth on Kit). Never addresses. | no |
| `newsletter_issue_draft` | Saves an UNSENT draft and returns where to open it. | no |

With several providers connected, pass `provider`. A draft the provider reports as
anything but a draft is an error that names where to check it: tell the person at once.

## What each provider allows

As of 2026-11-06.

| Provider | Draft by API | Stats by API | Plan gate |
| --- | --- | --- | --- |
| beehiiv | `status: draft` post [platform] [1] | per post with `expand=stats`, incl. verified clicks [platform] [2] | creating posts needs Pro or Enterprise; reading works on every plan [platform] [1][3] |
| Kit | broadcast with `send_at: null` [platform] [4] | per broadcast: recipients, opened, total clicks, unsubscribes [platform] [5] | free plan to 10,000 subscribers [platform] [6] |
| Buttondown | `status: draft` email [platform] [7] | recipients, deliveries, opens, clicks, failures, unsubscribes, complaints; replies as events [platform] [8] | the API is a paid feature [platform] [7] |
| Ghost | `status: draft` post [platform] [9] | sent email: recipients, delivered, opened, failed [platform] [10] | any site with a custom integration [platform] [9] |
| Substack | none | none by this plugin | no public write API: paste hand-off [practitioner] [11] |

The body is sent as written: plain text with blank lines between paragraphs and bare
https links, sent to every provider as the same simple escaped HTML. The person adds
images and buttons in the provider's editor.

## Reading the numbers

As of 2026-11-06.

- Opens are not readership. Apple Mail Privacy Protection fetches mail by itself, and
  Apple is about three quarters of tracked opens [measured: Litmus, Sep 2026] [12]. Readers
  in France and Italy may be untracked under 2026 consent rules [platform: Substack] [13].
  Use opens only as a trend inside one list.
- Judge an issue by, in order: delivered and bounces; complaints (keep under 0.10%,
  never reach 0.30%) [platform: Gmail] [14] and unsubscribes; clicks per delivered
  (verified clicks on beehiiv); replies; new subscribers [practitioner].
- Under about 1,000 recipients, report counts, not percentages [inference].
- Name the provider and the time read with every number; a number not read is unknown.

## Sources

1. https://developers.beehiiv.com/api-reference/posts/create
2. https://developers.beehiiv.com/api-reference/posts/show
3. https://www.beehiiv.com/pricing
4. https://developers.kit.com/api-reference/broadcasts/create-a-broadcast
5. https://developers.kit.com/api-reference/broadcasts/get-stats-for-a-broadcast
6. https://kit.com/pricing
7. https://docs.buttondown.com/drafting-emails-via-the-api
8. https://docs.buttondown.com/retrieving-analytics-data
9. https://docs.ghost.org/admin-api
10. https://docs.ghost.org/admin-api/posts/sending-a-post
11. https://substack.com/api-tos
12. https://www.litmus.com/email-client-market-share
13. https://support.substack.com/hc/en-us/articles/360044139052-How-are-Opens-captured-on-Substack
14. https://support.google.com/mail/answer/81126
