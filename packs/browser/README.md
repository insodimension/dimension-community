# Browser

A browser you and your agent share. Open a website or a localhost app, watch the
same page the agent works on, circle something and talk about it, and let the
agent — or a fast browser agent it hands the task to — drive real workflows.

Built as a community plugin on the public `@dimension/sdk` and Fraym UI, with
standard MCP and MCP Apps. No host internals, no browser fork.

## What it does

- **One shared browser.** The View and the agent work on the same browser, named
  by one opaque `browserId`. There is no listing; the model of a session can read
  the one browser the human opened in it (`browser_state` with no `browserId`,
  answered from the session the host stamped on the call, never from an argument),
  and nothing in the View is sent to the model unless the human annotates.
- **Headless by default, the View on demand.** `browser_open` opens a headless
  browser: no window, no pane, no live screencast, so an agent testing a localhost
  app does not put a browser on your screen. `browser_view` shows you a browser
  the agent holds, or opens one you can watch.
- **Few calls, few tokens.** `browser_act` takes 1–25 steps and answers once
  ([One call for a job](#one-call-for-a-job)); a model is sent one compact text per
  call, never the state around it; a screenshot is a webp of at most 1024 px.
- **Throwaway by default, named profiles to keep logins.** A browser opened
  without a profile keeps nothing and is deleted when it closes. A named profile
  persists logins across restarts, stays isolated, and is held by one caller at
  a time. The exception is yours: the View's start page and the dock open the
  saved `default` profile unless you tick **Private** ([Browser panel](#browser-panel)).
- **Annotations that carry pixels.** Freeze the page, mark it with the shared
  annotation kit (pin, box, circle, arrow, pen, a note on each mark); the numbered
  marks are burned into the picture and staged as a chip on your next message,
  with the page's address, where it was scrolled and the elements under each mark.
  The kit is the one annotation component every View shares; the Browser adds only
  the page facts (`app/view/page-annotation.ts`).
- **Acts when asked.** The agent session decides what to do — its permission mode
  and its own questions to you govern consequential steps (except the publish
  confirm, which always asks you). The browser never
  second-guesses it. One safety property is kept: an action that errored after it
  was sent is reported `unknown` (it may have taken effect) and is never retried
  automatically.
- **Whole tasks at agent speed.** `browser_task` hands a task to
  [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) or
  [browser-use](https://github.com/browser-use/browser-use), running in the same
  browser while you watch, and reports steps, time, model calls and tokens.
  A failed task (an unfunded model key is HTTP 402) is a tool error naming the
  cause and the next step, within seconds; the server and the browser keep
  serving. `browser_act` is refused (`task_running`) while a task runs. Agents may log in and sign up. Optionally, for a jev sign-up or
  login, the browser generates and stores the password in the profile and fills
  password fields itself (`credential: { origin, mode }`), so the value never
  appears in a transcript.
- **Passwords without a task key.** A `browser_act` `type` or `insert` with
  `generatePassword: true` (instead of `text`) generates a strong password,
  saves it in the profile (the same store) for the password field's own frame
  origin (a saved one is reused), and types it, replacing the field's content;
  `useSavedPassword: true` types the saved one for a later login and fails,
  typing nothing, when nothing is saved there. The origin is read from the
  browser, never from page script; the result says `credential: { origin,
  created }`, never the value, and either flag on a field that is not a
  password input fails and types nothing. The View's own typing is always
  literal. Snapshots, states and act results never carry a password field's
  value or any saved password, even once a page reveals it as text.
  `browser_snapshot` and `browser_act` reach iframes, cross-origin ones
  included, through `@<ref> ` selector prefixes.
- **A View that stops when the host says no.** A third-party install's View
  calls are consent-gated by the host. When the host refuses one (denied or
  expired), the live view pauses with a **Resume** button instead of retrying
  and raising a fresh prompt every few seconds.

## What we maintain, and what we do not

| Piece | Maintained by | How it is used |
| --- | --- | --- |
| Chrome driving | Google (`puppeteer-core`, pinned) | public API |
| MCP server + View protocol | MCP (`@modelcontextprotocol/sdk`, `ext-apps`, pinned) | public API |
| jev agent loop | browser-use (`jev-ultrafast`, pinned git commit — not on PyPI) | its own `Agent` |
| browser-use agent loop | browser-use (`browser-use`, pinned) | its own `Agent` + `BrowserSession` |
| View, annotations, profiles, the MCP tools, the task protocol | this pack | — |

Nothing upstream is copied or forked. Updating an upstream is a version bump.

## Engines

| Engine | Status |
| --- | --- |
| `chromium` | Default. A Chrome this pack manages, in a directory it owns: a throwaway one, or a saved profile. |
| `chrome-relay` | Attaches to the Chrome you are signed in to (always profile `relay`, so `profile` may be omitted); owns only the tabs it opens (and the pages they open) and never closes your browser. `browser_task` is refused here: the task agents drive a whole browser, and this one is yours. |
| `abp` | **Refused**: its control server authenticates nothing, so any page it visits could drive it. theredsix/agent-browser-protocol#16 |
| `browser4` | **Refused**: every published bundle disables HTTPS certificate verification. platonai/Browser4#602 |

Both refusals name the reason in the error and lift when upstream fixes land.

## Install

Build from inside the Dimension monorepo — `@dimension/sdk` and `@fraym/ui` are
`workspace:*` build-time dependencies until they are published. The shipped
`app/` and `dist/` bundles need neither.

```bash
npm install
npm run build
```

### Task agents (`jev`, `browser-use`)

Opening a browser never installs anything. Prepare the pinned environment once:

```bash
cd python
uv sync --python 3.12
```

Or point `DIM_BROWSER_PYTHON` at an interpreter that already has it. Keys are
read from the environment of the pack's server, which inherits the engine's
environment (`ai.insodimension.dimension/mcp.json` declares an `env`, which
widens the host's minimal default):

| Agent | Needs |
| --- | --- |
| `jev` | `TYPESAFE_API_KEY`, plus `TEXT_MODEL_API_KEY` (and optionally `TEXT_MODEL_BASE_URL`, `TEXT_MODEL`) for the small model that writes field values |
| `browser-use` | `DIMENSION_BROWSER_USE_MODEL` (default `gpt-4.1-mini`). `gemini-*` models use browser-use's Google client with `DIMENSION_BROWSER_USE_API_KEY` or `GOOGLE_API_KEY`; anything else its OpenAI client with `DIMENSION_BROWSER_USE_API_KEY` or `OPENAI_API_KEY`, and `DIMENSION_BROWSER_USE_BASE_URL` for any OpenAI-compatible endpoint |

Once a task has run, the server keeps one worker pre-spawned with browser-use
already imported (~4 s of imports), so the next browser-use task starts at its
first step: 11–12 s to the first step cold, 4 s warm (browser-use, measured
through the MCP server, 2026-09-26); jev's harness reads its env at import
time, so a jev task saves only interpreter start-up. An unused spare exits
after ten minutes. browser-use runs in flash mode, without its planner or judge call:
on the 14-stage practice world with `gemini-3.1-flash-lite` both configurations
pass 14/14, in 558 s and 251k tokens against 726 s and 787k for the library
defaults.

jev always sends a `reasoning` object to `TEXT_MODEL_BASE_URL`; Gemini's
OpenAI-compatible endpoint rejects unknown fields, so a Gemini field-value model
needs a relay that drops them (upstream jev-ultrafast behaviour).

## Configuration

| Variable | Effect |
| --- | --- |
| `DIMENSION_BROWSER_ROOT` | Root for browser data: saved profiles in `profiles/`, throwaway browsers in `ephemeral/`. Default `$INSO_HOME/browser`, else `~/.inso/browser`. |
| `DIMENSION_BROWSER_EXECUTABLE` | Chrome/Chromium executable (overrides the choice below; `browser_state` then reports `app: "custom"`). |
| `DIMENSION_BROWSER_RELAY_URL` | Relay CDP endpoint (default `http://127.0.0.1:9224`). |
| `DIMENSION_BROWSER_HEADLESS` | `false` for a visible window. |
| `DIMENSION_BROWSER_THROWAWAY_IDLE_MS` | How long a throwaway browser a chat opened may go without a call before it is closed, in milliseconds (default `600000`, 10 minutes; at most `2147483647`, above which a server refuses to start). |
| `DIM_BROWSER_PYTHON` | Interpreter for the task agents. |

### How the browser launches

The View's browser is your real browser, started the way you would start it,
so sites treat it as one:

- **Which browser.** The installed Google Chrome; if there is none, Microsoft
  Edge; then a Chromium (a system install, then the newest Chrome for Testing
  puppeteer has already downloaded for this platform). Nothing is downloaded.
  `browser_state.app` says which (`chrome`, `msedge`, `chromium`, `custom`),
  and the server logs the path.
- **Headless, with its own identity.** The View is a live picture inside the
  app, not a desktop window, so the browser runs headless. Headless Chrome
  calls itself `HeadlessChrome` in its User-Agent, and some sites refuse that
  outright (x.com answers 403 before any page loads). The View replays what
  the same binary reports, changing only that token:
  - A throwaway headless launch of the binary reads its User-Agent and its
    own `navigator.userAgentData.getHighEntropyValues` (brands, full version
    list, full version, platform, platform version, architecture, bitness,
    model, mobile, wow64). It runs once per build: the cache is keyed on the
    path and the binary's modification time, so an in-place update is read
    again. Nothing is made up, and a failed read is not cached.
  - The User-Agent goes in as `--user-agent`. That switch alone would blank
    every high-entropy client hint, so the binary's hints are put back with
    `Emulation.setUserAgentOverride` on every target the View owns: tabs,
    popups, out-of-process frames, and dedicated, shared and service
    workers. Each new target is held at start until its override is set.
  - A page therefore sees the same thing it would see from that Chrome with a
    window: the `user-agent` header, `Sec-CH-UA`, `-Mobile`, `-Platform`,
    `-Full-Version-List`, `-Platform-Version`, `-Arch` and `-Bitness`, plus
    `navigator.userAgent` and every value above, in the page, a cross-site
    iframe and each kind of worker. The pack's tests check this against the
    binary itself (`test/launch.test.ts`). Requests that start inside a
    worker, and worker script fetches, carry the User-Agent and no `Sec-CH-UA`
    headers. The binary sends none there either (checked with and without a
    window on Chrome 154), so there is nothing to replay.
- **No automation switch.** puppeteer's `--enable-automation` is dropped.
  Nothing is added to hide the browser: no stealth plugin, no fingerprint
  changes, no `AutomationControlled` switch. `navigator.webdriver` stays
  whatever Chrome itself reports while it is driven over DevTools.
- **Chrome's own password saving is off** in the profiles the pack owns
  (`credentials_enable_service` and `profile.password_manager_enabled` in the
  profile's Preferences, the chrome://settings/passwords toggle). The pack
  keeps its own credentials; Chrome's save prompt — which `--enable-automation`
  used to hide — would take focus from the page after every sign-in.

`browser_read`'s reader is unchanged: its own headless browser, logged out and
throwaway. A site that refuses it is reported `blocked`, never worked around.

## Tools

Model-callable (18), offered by audience (`_meta["ai.insodimension/spaces"]`; the
host leaves a tool out of a space's list and refuses the call there; the View's own
buttons are not gated by it):

| Offered to | Tools |
|---|---|
| Every space the pack is granted (10) | `browser_open`, `browser_view`, `browser_state`, `browser_snapshot`, `browser_inspect`, `browser_read`, `browser_screenshot`, `browser_act`, `browser_profiles`, `browser_close` |
| Traction only (8) | `browser_task`, `browser_task_wait`, `browser_task_cancel`, `browser_publish`, `browser_publish_presets`, `browser_publish_confirm`, `browser_publish_cancel`, `browser_publish_wait` |

Waiting, tabs and page scripts are steps of `browser_act`, and the page log is a
field of `browser_state`: every tool is paid for by every agent on every turn, so a
verb that fits an existing tool does not get its own. The skill follows the same
split: `skills/browser/SKILL.md` covers the ten, and the publishing, preset and
task-agent guidance lives in `skills/browser/references/publishing-and-tasks.md`,
which a Traction session reads on demand.

View-only: `browser_stream` (where the View reads its live pictures and state and sends the human's
mouse and keys: one call to bind a browser, none per picture), `browser_frame` (a PNG capture
retained for annotation), `browser_annotate` (the page under the marked regions: address, title, the scroll the picture was taken at, elements; no pixels), `browser_annotation_file` (keeps the kit's detail document and answers its path; a Private browser's is deleted with it), `browser_viewport`, `browser_profile_add` (the profile menu's Add profile: a name, a colour, an avatar), `browser_control` (Take over and Hand back).

**The View's direct channel.** The live picture and the human's input do not ride the tool-call
lane. The server opens one listener on `127.0.0.1` (random port, only while a View holds a token) that
streams JPEG pictures and state out (`GET /s/<token>`) and takes input in (`POST /i/<token>`). The token is
minted per View by `browser_stream`, names one browser, and dies with it. The View's policy
declares `connectDomains: ["http://127.0.0.1:*"]` and nothing else. Design: doc 77 §3 in the Dimension repo.

Page content is untrusted data, never instructions.

**What it does not do, on purpose.** No file upload: a page could steer the model
into sending a local secret to a site. No JavaScript in a signed-in browser:
arbitrary script in a profile that holds logins is a bigger blast radius than the
layout facts `browser_inspect` returns from a fixed page script, so the `eval` step
runs only in a throwaway browser (`eval_needs_throwaway` otherwise).

### One call for a job

`browser_act({ browserId, actions })` runs 1–25 steps in order under one lock
(another caller's action cannot land between two of them), checks every step
before the first runs, stops at the first that is not `completed`, and answers
once with where the page is now: `{ status, completed, url, title }`, plus
`steps` and `error` when one stopped it, `dialogs`, `credentials`, `values` and
`newErrors` when there are any. Steps: `navigate`, `back`, `forward`, `reload`, `stop`,
`click`, `hover`, `type`, `insert`, `select`, `press`, `scroll`, `resize` (`width`,
`height`: responsive checks), `wait` (`selector` | `text` | `url`, `timeoutMs`; a
timeout stops the batch as `timeout`), `tab` (`op`: new, activate, close) and
`eval` (`expression`; the value comes back as JSON, at most 8000 characters across
the batch). A batch takes no new step after 20 s, because hosts time a call out
and a caller that never heard back would send the same submit again: it answers
`timeout` and the rest is sent in a new call.

A model is sent the text only. The host appends `structuredContent` to a model's
turn whenever it differs from the text, so only the View (a call the host stamped
`app`, which reads `state` from it) is sent one; snapshot text opens with the page's
own `# title` and url lines instead of a state header, and no state a model is
sent carries a tab's favicon (a `data:` URL of up to 32 KB).

`browser_screenshot({ browserId, fullPage?, selector?, scale? })` is the browser's
own webp (quality 70), its longest edge at most 1024 CSS px, for the viewport, the
whole document or one element; the text says the CSS size shown and the scale
(a point in the image is at x/scale on the page). It is not the live view's frame
and not the annotation PNG, and it is never retained.

Each tab keeps its last 50 console errors and warnings, uncaught exceptions,
responses of 400 or more and failed requests (urls without query strings, text cut
at 300 characters, never a body, header or cookie; Chrome's own echo of a failed
load and the browser's `/favicon.ico` fetch are left out). `browser_state` lists the
ones a model has not read (`logs`), and `browser_act` says `newErrors: n` when n new
ones appeared since the last result the model was handed. The View reads neither.

### Throwaway browsers and saved profiles

`browser_open({ profile?, engine?, url? })` opens headless. Leave `profile` out for a throwaway
browser: its own directory under `<root>/ephemeral/`, no lock, no saved sign-in,
deleted when it closes or the server exits, and any number can be open at once
(up to the pool bound). `browser_state.profile` is `null` for it and
`browser_profiles` never lists it. If the server is killed first, the next start
deletes the directory once its recorded owner (`owner.pid`) is provably dead and
no Chrome still holds it. Pass `profile` to run on the saved profile of that
name in `<root>/profiles/<name>`: it keeps logins, is held by one caller at a
time, and is never deleted. Saved passwords (`generatePassword`,
`useSavedPassword`), a `browser_task` `credential` and `browser_publish` need a
saved profile and fail `profile_required` on a throwaway browser, before
anything reaches the page.

**How a throwaway ends.** One server serves every chat on an engine, and the host
stamps each call with its session (`ai.insodimension/session`) but sends the
server no word when a session ends, so a forgotten `browser_close` cannot be seen
as such. A throwaway a chat opened is therefore closed when (1) `browser_close`
says so, (2) it has had no call for 10 minutes (nothing queued or running on it,
no task driving it, no View joined to its stream; `DIMENSION_BROWSER_THROWAWAY_IDLE_MS`
changes the 10 minutes), or (3) the pool (4 browsers) is full and another open, or
a `browser_read`, needs the slot: the one used longest ago that nothing is
happening on is given up. A saved profile, a browser with a task or a call
running, and one a View has joined are never given up; the Private browser a
person opened from the View is never closed for being quiet and is given up only
when no chat's browser can be, and never while its View is joined. When nothing
can be given up, `browser_open` is refused (`too_many_browsers`), naming the
browsers the asking chat holds and only those. The open takes at most one victim:
if that browser will not close, the open is refused instead of moving on to the
next chat's. A chat that returns to a browser closed this way is told so (and to
`browser_open` again) instead of "unknown browser", and `browser_close` on it
succeeds. By then its Chrome process has exited and its directory is deleted.

A close that hangs does not keep a slot. The polite close gets 20 s; after that the
throwaway's whole process tree is killed and its slot is freed only once the
process is seen to exit. A close that still cannot be confirmed is tried again
every 30 s (or each idle period, if shorter), whether it came from `browser_close`,
the idle timeout or an eviction. A saved profile is never killed: its lock holds
until its Chrome is provably gone.

**A profile has a name and a label.** The name is the folder (`[a-z0-9_-]`, 48
characters) and never changes. The label ("Work Account"), a colour from a fixed
palette (blue, orange, green, red, purple, pink, teal, grey) and an optional emoji
avatar are separate, optional, and kept in `profiles/<name>/profile.json` beside
`chrome/`, with when the profile was last used and the browser application that
last ran it (a profile opened by a different application, Chrome then Edge, may
have lost its logins: `browser_open` says so once, in `notice`). A profile with no
`profile.json` works: the label is the name, the colour comes from the name.

**`browser_profiles`** is read-only and offered to every space. It returns, for each
saved profile, `{ name, label, colour, heldBy, sites }`:

```json
{ "profiles": [
  { "name": "work", "label": "Work", "colour": "blue", "heldBy": null,
    "sites": [
      { "site": "x.com", "signedIn": true, "seenAt": "2026-10-01T09:14:00.000Z" },
      { "site": "google.com", "signedIn": null, "seenAt": "2026-09-20T17:02:00.000Z" } ] },
  { "name": "personal", "label": "Personal", "colour": "orange", "heldBy": "human", "sites": [] } ] }
```

`heldBy` is `null` (free), `"this chat"`, `"human"` (the person has it open in a View
of another chat) or `"another chat"`; never an id. `signedIn: null` is "not known
now": the last check is over 7 days old, or its time is in the future (an agent
can ask the person); a site that was only visited is not listed. **A site's account
(an email, a handle) is shown to the person, not to the model:** the model's answer
leaves it out until the consent gate (P4) exists. The Browser View reads the same tool
as the human and gets the same list as structured content, each site with its
`account`, and so does the dock. Never a cookie, a cookie name, an expiry, a token, a
password, whether a saved password exists, or a path; the relay and throwaway
browsers are never listed. More than 40 profiles: the ones in use and the signed-in
ones first, the rest counted in `omitted`.

**Naming a profile.** `profile` is a name or a label, in any case. An exact name is
always that profile, whatever another profile is labelled (so a label can never make a
profile impossible to open). A label that two profiles share (`profile_ambiguous`), or a
name that is not a valid name and matches no label (`profile_unknown`), is refused with
the profiles' names and labels, never resolved to the closest. A valid name that
matches nothing is a new profile, as it always was (an account's first sign-in). The
chat that already holds a profile gets its own browser back; anyone else is refused
`profile_held`, told whether the human or another chat has it, whether that profile is
open or still starting. There is no consent step yet: until one exists any agent can
open any saved profile, `default` included.

**The profile menu (the View).** The toolbar's chip is the browser's profile: its avatar (the emoji
the person chose, else the label's first letter, on the profile's colour) and its label; Private for a
throwaway browser, Your Chrome for the relay. Its face rides the browser's own state (`look`), so drawing it
costs no call. Opening the menu reads `browser_profiles` and lists the others, Default first and then by
label, each with where it is signed in or who has it: a profile open here (yours, or your agent's, or one
an agent task is running on) is one click away; a profile another chat holds, or you hold in another chat's
View, is shown dimmed and cannot be opened from here (the one-holder lock). A click calls `browser_open`
for that profile and the View shows it; **the browser you leave stays open**, as Chrome keeps the other
profile's window (its tabs, its sign-ins, a post awaiting its confirm), and shows as open in the menu.
**Add profile** is inside the menu: a name, one of the eight colours, an optional emoji. The name is shown
as typed (any script, up to 48 characters) and the folder is derived from it; a blank name, one that could
be a path (`\ / : * ? " < > |`, a leading dot), `relay` or a Windows device name, or one that matches
another profile's label or name in any case, is refused with a sentence and nothing is created
(`browser_profile_add` answers `bad_profile_name`). A new profile is opened at once. A throwaway browser an
agent opened is never listed.

**Taking over.** Whoever opened a browser, the person in the View can take the wheel: `browser_control`
`take` (the pill "Your agent is working here · Take over", or the profile menu). While they hold it, an
agent's `browser_act`, `browser_task`, publish and `browser_close` on it are refused `human_driving`
(reads — `browser_snapshot`, `browser_state` — still work, and say `takenOver: true`), an agent batch
already running stops before its next step, and `browser_profiles` reports the profile as held by the
human. `return` hands it back. It is refused while a task runs (`task_running`) and while a post awaits
confirmation (`publish_pending`): taking the wheel must never navigate away from, or lose, the page a post
is parked on. It lasts until handed back or the browser closes.

## Reading public pages

`browser_read({ url, maxChars? })` reads one public page logged out, with no
browser to open and no View. It has no profile: every read runs in a fresh
incognito context of this server's own headless reader browser, with no
cookies, and the context is discarded when the read ends. The reader never
shares a cookie jar or a user-data dir with a Browser View profile, so a read
is never made as a signed-in user. It waits up to 15 s for the page to load
and returns `{ status: "ok", url, title, text }`. `url` is where the page
landed; `text` is its readable text, cut at `maxChars` (default 20 000, max
100 000) with `truncated: true`. It only navigates and reads, so it is
annotated read-only and approved like the other read tools.

A page that will not serve a logged-out reader returns
`{ status: "blocked", url, reason }`, and the tool does not try another way
in. The reasons are checked in order:

- **An HTTP refusal.** Status 401, 403, 429, 451 or any 5xx (`HTTP 403`).
- **A CAPTCHA or bot check.** A "Just a moment" or "Attention Required"
  title, or a visible challenge frame (a `/recaptcha/` path other than
  reCAPTCHA v3's invisible scoring badge, `recaptcha.net`, `hcaptcha.com`,
  `challenges.cloudflare.com`) that is the page: in the first viewport of a
  short page (1 500 characters of text or less), or covering 40% of the
  viewport or more. A provider's script is not a challenge (reCAPTCHA v3 and
  Turnstile load site-wide), and neither is a checkbox widget in the comment
  or contact form under a long article.
- **A login wall.** A log-in, sign-in, sign-up or authwall path segment in the
  final URL (`/login`, `/users/sign_in`, `/sign-in`, `/signup`, `/authwall`),
  or a visible password field (open shadow roots included) on a short page,
  or inside a form or dialog covering half the viewport or more. A quick-login
  box beside a long public page is not a wall.
- **A timeout.**

The checks run as one fixed page script; no caller JavaScript reaches the
page. Two refusals apply to every request the read sends, redirects and
script navigations included, and are also checked before the reader
launches:

- **Mirror and proxy hosts** (`MIRROR_HOSTS` in `src/read.ts`: safereddit,
  redlib, libreddit, teddit, nitter, xcancel, pullpush, r.jina.ai, 12ft.io, the
  Wayback Machine, archive.today and its aliases, Google's cache and
  `translate.goog` proxy) are never navigated to:
  `mirror/proxy hosts are not a read path`.
- **Private addresses.** `localhost`, `*.localhost`, `*.local`, and any host
  that is or resolves to a loopback, RFC 1918, link-local (including
  169.254.169.254), CGNAT, IPv6 loopback, unique-local or link-local address.
  The address Chrome actually connected to is checked again, so a DNS answer
  that changes after the check is refused too.

The reader keeps one tab: Chrome's popup blocker stays on and any other page
is closed, and downloads are denied. The reader browser takes one of the four
browser slots while it lives, closes after 60 s without a read, and gives its
slot up to a `browser_open` when the pool is full.

## Connect a platform with a browser profile

Publishing works in three steps. The profile is signed in once, your agent
drafts, and the post is confirmed.

1. **Sign in once.** Ask your agent to connect the account (for example
   "connect X as @yourbrand"). It opens the site's login page in the Browser
   View, on a profile of its own for that account, and logs in or signs up
   there, verification steps included — or you do it yourself in the View. The
   login is saved in the profile and survives restarts, so this happens once
   per account.
2. **Your agent drafts and fills.** When there is something to post, the agent
   opens the compose page in that profile and fills in the text. Nothing is
   sent.
3. **Post.** A bar at the bottom of the Browser View shows where the post goes
   (the page and the profile) and exactly what will be posted, with **Post**
   and **Cancel**. Your agent can confirm it itself (`browser_publish_confirm`),
   but that ALWAYS asks you first, whatever your session's permission mode: an
   Allow card names the exact site, profile and text it will post. (Under a
   harness that can't guarantee that ask, Dimension refuses the agent's confirm
   instead.) Or you press Post. While the bar waits, the agent can't otherwise
   touch the page. After the post, its own link comes back to the agent as the
   receipt.

If you post it yourself with the site's own button instead, the bar can't
know for sure, so it says "May have posted" and never posts a second copy.
Nothing is posted until a confirm: your Post button, or the agent's
`browser_publish_confirm` once you allow it.

## Publishing

`browser_publish` posts through a signed-in profile.
The caller passes either a named preset (see [Presets](#presets)) or a recipe
as data, so the pack's code stays platform-agnostic:

```json
{
  "origin": "https://social.example",
  "composeUrl": "https://social.example/compose",
  "signedIn": "#account-menu",
  "fields": [{ "selector": "#post-text", "value": "Hello", "label": "Post text" }],
  "submit": "#post-button",
  "receipt": { "path": "/{segment}/status/{digits}", "linkSelector": ".toast a" }
}
```

(An X post's URL is `/<handle>/status/<id>`, hence that `path`.)

- `fields`: 1-8, each value at most 10 000 characters; `label` (at most 40
  characters) is the caption the confirm bar shows above the value.
- `receipt.path`: a template matched against the posted URL's pathname (the
  origin is checked separately; query and hash are ignored). Literal text plus
  `{segment}` (one path segment) and `{digits}` (one or more digits), at most one
  placeholder per segment; starts with `/`, at most 256 characters. Matching is
  linear-time, so a hostile page's hrefs cannot stall it.
- `mode: "check"` opens the compose page and reports `signed-in` or
  `not-signed-in`. Signed out, nothing is typed; sign in (the agent with
  `browser_act` / `browser_task`, or you in the View), then post.
  With the optional `account` selector, a signed-in check also reads the
  account from the page: the element's last `@handle` (`"Jane (CEO @acme)
  @jane"` → `"@jane"`; an email's `@domain` is not one), else its text. A form
  control is never read, and saved passwords are scrubbed from it like every
  other page read. It is returned as `account` and goes into the
  [connection report](#connection-report). `x-post` reads X's account switcher.
- `mode: "post"` types each value, reads it back exactly, and parks the publish
  as `awaiting-confirmation`, recording the active tab and its URL as
  `composeUrl` (where the post goes). **Nothing is submitted.** The Browser View
  shows a confirm bar with that URL, the profile and every value. A confirm
  submits: the model's `browser_publish_confirm` or the bar's **Post** (the same
  tool). The tool declares `_meta: { "ai.insodimension/approval": "prompt" }`,
  so the host ALWAYS asks the human before the agent's call runs, in every permission mode
  (yolo included); a harness that can't guarantee that ask has the call refused
  by the Dimension host instead. The model MUST pass `expect: { origin, profile, values }`
  copied exactly from the pending record (`values`: every field's value, in
  field order), so the Allow card states where the post goes, as which profile,
  and exactly what it says. A model call without `expect` fails
  `expect_required`; any `expect` (from any caller) that differs from the
  pending record fails `publish_mismatch`; either way nothing is clicked and the
  publish stays pending. The View's Post may omit `expect`. The page is then
  re-checked: another active tab, a different URL or a changed value fails with
  nothing clicked. `browser_publish_cancel` drops it.
- While a publish is pending the page is pinned: `browser_act`,
  `browser_task`, `browser_publish` and `browser_close` are refused
  (`publish_pending`) unless the host stamped the call as coming from the View.
- The receipt is the posted URL read from the page (the tab's URL, or a link the
  recipe names), on the recipe's origin, its path matching `receipt.path`, and
  not already on the page before submit. `browser_publish_wait` follows the
  outcome: `posted`, `unknown` (may have posted), `failed` (nothing submitted),
  `cancelled`, or `expired` after 10 minutes unconfirmed.
- If the human clicks, presses or types on the confirmed tab in the View while
  the publish waits, they may have used the site's own submit: the bar's Post
  then never clicks submit, and Post, Cancel, closing the browser or expiry all
  settle `unknown` ("Check the account") rather than claim nothing was posted.
  While the bar's Post is submitting (it has clicked submit and waits for the
  receipt), the View's input is refused `publish_pending` until the Post settles,
  so a click or key cannot post twice or change what is posted.
- On the `chrome-relay` engine the page is in your own Chrome, which you can
  use directly, outside the View. The bar's Post still works there, but a
  close, cancel, expiry or changed page settles `unknown`, never `cancelled`,
  `expired` or `failed`.
- A contenteditable is read back as its text: one newline per line. An editor
  that keeps one `<p>` per line (ProseMirror, Quill, Lexical) reads as those
  lines joined by one newline, not the blank line `innerText` would put between
  paragraphs.
- Recipe selectors (`signedIn`, `account`, `fields`, `submit`) accept any puppeteer
  selector syntax: CSS, `pierce/…` to reach into open shadow roots,
  `::-p-text(…)` and `::-p-xpath(…)`. `receipt.linkSelector` is read in-page,
  so it accepts CSS and `pierce/…` only.

Hard lines: a password field is never a publish field (its value is never read
back, so it could not be verified; logins go through `browser_act` or
`browser_task`), publishing never uses the saved passwords, and it clicks submit
exactly once and never retries it.

### Presets

Named recipes ship in `recipes/<name>.json`. Pass one instead of a recipe:
`preset: { name, values, target? }`. `values` fill the preset's fields in
order, and their count must match. A preset with `needsTarget` composes on the
page the caller names (a Reddit thread to comment on); `target` must be a URL on
the preset's origin. An unknown name is refused with the list of names. The
preset resolves to an ordinary recipe and takes the same path: the same checks,
the same parked publish, the same confirm, the receipt from the page. The record
carries `preset: { name, verified }`, and the confirm bar shows "Unverified
recipe" while `verified` is false. `browser_publish_presets` lists
`{ name, platform, verified, fields, needsTarget }`.

| Name | Platform | Verified | Needs target |
| --- | --- | --- | --- |
| `x-post` | X | no | no |
| `bluesky-post` | Bluesky | no | no |
| `linkedin-post` | LinkedIn | no | no |
| `reddit-comment` | Reddit | no | yes (the thread URL) |

Presets are modelled on each site's page as of 2026-09 and tested against
fixture copies, not the live sites. A preset becomes verified only after a real
post is observed through it. Each preset's `notes` say what every selector is
modelled on; the fixture copies are in `test/platform-fixtures/`.
`reddit-comment`'s receipt link matches any comment permalink, so another
user's comment that loads on the thread after submit could be taken as the
receipt: the receipt checks the path shape and that the link was not on the
page before submit, not who wrote the comment.

## Connection report

The pack's own MCP server tells the host which profiles are signed in to which
sites, so a campaign board such as Traction's can say whether an account can
post (dimension#1219) and the dock panel can list them. It sends the vendor notification
`notifications/ai.insodimension/connection` with
`{ report: { profiles: { <profile>: { label?, colour?, avatar?, sites: { <host>: { signedIn, account?, observedAt } } } } } }`
(`observedAt` is epoch ms; `signedIn` is `null` for a site only visited):

- **Only observed, never derived.** A site is in the report because a **site
  probe** looked at a page that finished loading in a saved profile (and once more
  as the browser closes), or a `browser_publish` result said `signed-in` or
  `not-signed-in`, or a publish reached `posted`. A probe is two selectors for a
  known site (`src/probes.ts`; X, LinkedIn, Reddit, Bluesky, Google): one on the page
  only when signed in, one that holds who. The marker found is signed in; its
  absence is signed out only on the site's front page or a login page, anywhere
  else no verdict. A site with no probe is recorded as visited (`signedIn: null`:
  "not checked"), only for a public site, never replacing a check that was made. A
  site never observed is absent, never `signedIn: false`. A later `not-signed-in`
  sets `signedIn: false`. Nothing is read from the saved passwords, and an
  account a page shows is scrubbed of them like every other page read. A
  throwaway browser and the relay are never looked at.
- **Hosts** are registrable domains under the Public Suffix List, private
  suffixes included (`https://www.linkedin.com` → `linkedin.com`,
  `https://shop.example.com.my` → `example.com.my`, `alice.github.io` stays
  itself). A local app on an IP or `localhost` is keyed by that name.
- **Never the relay.** The `relay` profile is your own Chrome and is never
  observed or reported.
- **Whole map every time.** Each report replaces the last one, so every send
  carries every profile. It is sent once the host connects (from the
  observations saved before), after every new observation, and when a profile
  directory with observations is deleted. The host retracts it when the server
  exits.
- **Within the host's caps.** The report JSON stays at or under 64 KiB, with the
  visited-only sites dropped first and then the oldest observations, and an
  `account` over 256 UTF-8 bytes is left out rather than cut into a different
  handle.
- **Never in a tool's way.** A report that cannot be sent is logged. The tool
  call that made the observation still returns its own result.

Observations are saved per profile in `profiles/<profile>/connections.json`,
next to that profile's Chrome data, at most 64 sites per profile. The selectors
for X, LinkedIn, Reddit and Bluesky are the presets' own (`recipes/`); Google's
account is read from the email in its account button's label (no count of other
accounts: a page can hold any link its author likes, so such a count proves nothing).
Like the presets, the selectors are modelled on each
site's page and tested against copies of it, not yet seen on the live sites.

## Browser panel

Installing the pack also adds a **Browser** tab to the dock (component
`browser-accounts`). At the top is an **Open a page** bar: type a website
address and **Open** shows the live Browser View beside the chat at it (an empty
bar opens a blank browser; something that is not an address opens nothing and
the [connection report](#connection-report) with its sites: signed in, signed out
or not checked, the account, and when the Browser last saw it (a sign-in last seen
over 7 days ago reads "not checked" with its age: it is never claimed from old data).
The profile is shown by its label. A site the Browser has never observed is not in
the report, so it is not listed. **Sign in** on a site, or
**New sign-in** (pick X, LinkedIn, Reddit, Bluesky or Google and name the logins; left
empty, they are the `default` set), opens the live Browser View beside the chat
at that site's login page on that set. You sign in there yourself, and the panel
shows the account once the Browser observes it, with no agent doing anything.

The View's start page and the panel's **Open a page** open on the saved `default`
set, so a person's own browser keeps their logins, unless **Private** is ticked.
Private sends no profile: a throwaway browser that saves nothing. One browser
holds a saved set at a time, so a second open of `default` is refused
(`profile_held`); the start page turns that into "That browser is already
open. Use it, or open a Private one."

The panel reads only this pack's own connection fact (`plugin/browser/connection`)
and acts only through `openArtifactoryView` (`browser_view` with
`{ url?, profile? }`), which its `artifactory:open` grant admits. The host mounts
the View from a tool's static `_meta.ui`, and `browser_open` has none (it is
headless), so the panel opens through `browser_view`. The host opens the View in the
active session, so with no session open the panel's **Open** and **Sign in**
buttons are disabled. Profile names follow the same rule as `browser_open`
(`src/profile-name.ts`). The site list takes its origins from the
shipped presets in `recipes/`. The panel is built by `npm run build` into
`dist/index.mjs`.

## Tests and benchmark

```bash
npm test
```

Real Chrome against a local fixture server that counts the writes it accepts.
Without Chrome installed the browser tests skip loudly rather than pass.

`node bench/run.mjs` applies to five local practice job sites with each task
agent and prints time, steps, model calls, tokens and success per site.
`--scenario full` chains account creation (mail, network, verification,
profile) into ten applications; when an agent fails an account stage the
harness completes that account from the fixture (`/__seed`) so the stages after
it measure their own task, and the report marks the stage `then seeded`.
`--record` writes one video per agent (the View's live frames with the stage,
stage timer and run timer burned in; needs `ffmpeg`).

The benchmark's browser data (its `bench-*` profiles and the saved fixture
password) lives in a directory it makes under `.scratch/browser-bench/`
(gitignored) and deletes when the run ends; it never uses `~/.inso` or
`~/.inso-dev`. It refuses to start when `DIMENSION_BROWSER_ROOT` or `INSO_HOME`
points into them, unless `--root <dir>` names a directory to use instead (kept
after the run).
