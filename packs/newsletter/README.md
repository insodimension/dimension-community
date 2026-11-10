# Newsletter

## What it is

A connector for the email newsletter you already run on beehiiv, Kit, Buttondown or Ghost.
Your agent saves an issue you chose as an unsent draft in your account, and reads how
your sent issues did and how many subscribers you have. It never sends: you open the draft
in your provider and press Send. Substack has no API for this, so for Substack your agent
hands you the text to paste.

## What it contains

- Tools:
  - `newsletter_provider`: which providers are connected and which publication each key reaches, checked live.
  - `newsletter_list_issues`: drafts and sent issues, newest first, with their ids.
  - `newsletter_issue_stats`: one sent issue's numbers (recipients, delivered, bounces, complaints, unsubscribes, clicks, replies; opens marked unreliable). A number the provider does not report says unknown.
  - `newsletter_audience`: subscriber counts, and growth over the last 90 days on Kit.
  - `newsletter_issue_draft`: saves the chosen subject, preview line and body as an unsent draft and returns where to open it.
- Skill: `newsletter`, with what each provider allows and how to read the numbers.
- Rule: `newsletter-context`, always on: nothing here sends, only the chosen text, opens are not readership.
- Connect flow with one option per provider (beehiiv, Kit, Buttondown, Ghost). Each keeps its own key in
  `~/.config/dimension-newsletter/<provider>.json`, written through `connect/<provider>.template.json`;
  beehiiv and Buttondown keys are checked when you connect, Kit and Ghost keys by `newsletter_provider`.

## Who can use it

Off by default; loads in every space once on. You need an account on one of the four providers and an API key from it:

- beehiiv: a workspace API key. Saving drafts needs a plan with the create-post API (Pro or Enterprise); reading stats works on every plan.
- Kit: a V4 API key (Settings, Developer). Works on the free plan.
- Buttondown: the API key from Settings, API. The API is part of Buttondown's paid plans.
- Ghost: the Admin API key and the https API URL of a custom integration.

## Limits and risks

- It cannot send, schedule or publish. `newsletter_issue_draft` creates a draft only (beehiiv `status: draft`, Kit `send_at: null` and not public, Buttondown `status: draft`, Ghost `status: draft` with no newsletter attached). If the provider answers with anything but a draft, the tool fails and names where to check it.
- Saving a draft does not ask you first: it only saves an unsent draft, and you review the provider, subject, preview line and body there before pressing Send.
- The body goes in as plain text with paragraphs and links, sent to every provider as the same simple escaped HTML. Add images and buttons in the provider's editor.
- Kit has no stable link to one draft, so the result points to Kit's Broadcasts page and names the draft's id.
- It reads counts only, never subscriber addresses. Open counts are inflated by Apple Mail Privacy Protection and missing for some EU readers; the tools say so beside every open figure.
- Your keys stay on this machine. A Ghost Admin API key can do anything an integration can on your site; this plugin only creates draft posts and reads posts, newsletters and member counts with it.

## Build and test

```sh
bun test marketplace/packs/newsletter
```

Run from the Dimension monorepo root. The tests stub `fetch` and a temporary home folder and never call a provider.
