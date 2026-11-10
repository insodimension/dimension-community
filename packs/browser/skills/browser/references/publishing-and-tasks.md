# Publishing and task agents

Traction sessions only. The five `browser_publish*` tools are offered to the
`traction` space and to no other; `browser_task`, `browser_task_wait` and
`browser_task_cancel` are offered there too, but only where jev's key is
configured (`TYPESAFE_API_KEY`). If you cannot see a tool, this file does not
apply to it. Open, view, snapshot, act, read and close are in [steps.md](steps.md) and [SKILL.md](../SKILL.md).

## Connect a platform

One named profile per account, signed in once; the login persists in it across
restarts. `browser_open({ profile, url })` on the site's login page, then sign in
yourself with `browser_act` (`useSavedPassword` or `generatePassword` for the password) or let
the user sign in in the Browser View (`browser_view`). `browser_task` refuses a
profile a Traction account posts from (below), so it never signs in such an account. A verification step (CAPTCHA, email or
phone code) is yours to handle however you can; use `ask` when you need the user for
it. Verify with `browser_publish` `mode: "check"` (below): `signed-in` means the
account is connected.

`browser_task` `credential` and `browser_publish` need a profile: on a throwaway
browser they fail `profile_required`, so close it and open again with a name. On
`engine: "chrome-relay"` (the user's own Chrome) `browser_task` is refused; use a
chromium browser for the task agent. `browser_task` also takes a password in `task`,
but anything put in `task` lands in the session transcript: prefer `credential`.

## Whole task (jev drives)

Best for well-specified, repetitive flows (forms, applications, sign-ups with given
data); for a step that needs judgment, drive with `browser_act` instead.

`browser_task({ browserId, task, maxSteps?, credential? })`
runs jev in this same browser while the user watches; it returns
status (`done`, `blocked`, `failed`, `cancelled`), a summary, steps, elapsed
time, model calls and tokens. Put every fact jev needs in `task` (names,
emails, answers) — it cannot ask you. jev makes one TypeSafe
decision per step and needs model keys in the browser server's environment
(`TYPESAFE_API_KEY` and
`TEXT_MODEL_API_KEY`). A `failed` task is a tool error naming the cause and
the next step (an unfunded key is HTTP 402); the browser stays open, so carry
on with `browser_act` — for a sign-up's password, `generatePassword: true`.
`browser_act` is refused (`task_running`) while a task runs;
`browser_task_wait` follows it and `browser_task_cancel` stops it. A tab jev
opens becomes the active tab. After a task, `browser_snapshot` to verify
the outcome yourself.

**Optional: let the browser hold the password.** For a jev sign-up you may pass
`credential: { origin: "https://site.example", mode: "signup" }` instead of a
password: the browser generates a strong password, saves it in this profile
for that origin and fills that origin's password fields itself, so it never
appears in the transcript — jev, you and the results never see it (the result
says `credential: { origin, created }`). To sign in again later to an account
the browser created, `mode: "login"`. It fills only documents of that exact
origin (https, or http on localhost), including one in an iframe on another
site's page (an embedded login form). An account made any other way has no
saved password: log in with `browser_act` (`useSavedPassword: true` needs a
saved one), or put the password in `task`.

Give a task **one clear goal with all its data**, start to finish. If a task
ends unfinished (`blocked`, `failed`, out of steps, or `done` but the snapshot
shows it is not), do NOT start a second task that says "continue the half-done
form" — jev loops on that. Inspect with `browser_snapshot` and finish the
remaining steps yourself with `browser_act`.

## Publishing

A new X post goes out through `browser_publish` and its `x-post` preset; every
other post on a profile a Traction account posts from is typed and posted with `browser_act`, as
Posting from a Traction account's profile (below) says. For `browser_publish`, prefer a **preset** over a hand-written recipe: list them with
`browser_publish_presets` (`name`, `platform`, `verified`, `fields`,
`needsTarget`), then pass `preset: { name, values }`, one value per field, in
the listed order. A preset with `needsTarget` (e.g. `reddit-comment`) also takes
`target`, the page on that site to post on (the thread's URL). Shipped presets:
`x-post`, `bluesky-post`, `linkedin-post`, `reddit-comment`. They are
`verified: false`: tested against copies of each site's page, not the live
site, so if one fails on a selector, report the error; never improvise a
different button.

Only for a site with no preset, pass a `recipe` instead (never both): the
site's `origin`, its `composeUrl`, a `signedIn` selector, the `fields`
(`selector`, exact `value`, optional `label` such as "Post text" that the user
sees above it), the `submit` button, and a `receipt`: `path`, a template for
the posted URL's path on the origin (`{segment}` = one path segment,
`{digits}` = a number; for X `"/{segment}/status/{digits}"`), plus an optional
`linkSelector`.

- `mode: "check"` only verifies that the profile is logged in (`signed-in` /
  `not-signed-in`). If it is not, log in first (`browser_act`, or the user in
  the View), then post. A password field is never a publish
  field.
- `mode: "post"` fills the fields and reads them back. It then returns
  `awaiting-confirmation` with a `publishId` and `composeUrl` (where it will
  post). **Nothing is sent yet.** The View shows the exact text with **Post**
  and **Cancel**. Post it yourself with
  `browser_publish_confirm({ browserId, publishId })`. Nobody is asked: the
  user picking the draft is the go-ahead. It re-checks the page against the
  pending record, clicks submit exactly once, never retried, and returns
  `posted` with the post's `url` read from the page, `failed` or `unknown`.
  Drop it with `browser_publish_cancel`. The user's Post button in the View
  posts it too.
- Don't act on the page while a publish awaits confirmation: `browser_act`,
  `browser_task`, `browser_publish` and `browser_close` are
  refused anyway (`publish_pending`) until it is posted, cancelled or expires
  (10 minutes).
- `browser_publish_wait({ browserId, publishId })` follows it to `posted`
  (with the post's `url`, read from the page), `unknown` (it may have posted:
  never post again), `failed`, `cancelled` or `expired`.

Post what the user picked; never post text they did not ask for. If something
is genuinely unclear or high-stakes (which account, a post that would reach
people the user did not mean), ask one short question in the session chat.

## Posting typed text

On a site with no preset, type the post with `browser_act` and click the site's
own button (or press Enter) in the same call. Nobody is asked.
