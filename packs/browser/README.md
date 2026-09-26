# Browser

A browser you and your agent share. Open a website or a localhost app, watch the
same page the agent works on, circle something and talk about it, and let the
agent — or a fast browser agent it hands the task to — drive real workflows.

Built as a community plugin on the public `@dimension/sdk` and Fraym UI, with
standard MCP and MCP Apps. No host internals, no browser fork.

## What it does

- **One shared browser.** The View and the agent work on the same browser, named
  by one opaque `browserId`. There is no listing and no ambient access.
- **Named profiles.** Logins persist across restarts, profiles stay isolated, and
  one profile is held by one caller at a time.
- **Annotations that carry pixels.** Draw a region, circle or freehand stroke; the
  marks are painted into the cropped screenshot and sent, with your note, the URL
  and the elements under the crop, into the same conversation.
- **Acts when asked.** The agent session decides what to do — its permission mode
  and its own questions to you govern consequential steps. The browser never
  second-guesses it. One safety property is kept: an action that errored after it
  was sent is reported `unknown` (it may have taken effect) and is never retried
  automatically.
- **Whole tasks at agent speed.** `browser_task` hands a task to
  [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) or
  [browser-use](https://github.com/browser-use/browser-use), running in the same
  browser while you watch, and reports steps, time, model calls and tokens.
  For a jev sign-up or login the browser fills password fields itself from a
  password it holds per profile and origin (`credential: { origin, mode }`);
  no model and no transcript ever sees the value.

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
| `chromium` | Default. A Chrome this pack manages, on a profile it owns. |
| `chrome-relay` | Attaches to the Chrome you are signed in to (profile `relay`); owns only the tabs it opens (and the pages they open) and never closes your browser. `browser_task` is refused here: the task agents drive a whole browser, and this one is yours. |
| `abp` | **Refused**: its control server authenticates nothing, so any page it visits could drive it. theredsix/agent-browser-protocol#16 |
| `browser4` | **Refused**: every published bundle disables HTTPS certificate verification. platonai/Browser4#602 |

Both refusals name the reason in the error and lift when upstream fixes land.

## Install

Build from inside the Dimension monorepo — `@dimension/sdk` and `@fraym/ui` are
`workspace:*` build-time dependencies until they are published. The shipped
`app/` bundle needs neither.

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

## Configuration

| Variable | Effect |
| --- | --- |
| `DIMENSION_BROWSER_ROOT` | Root for profiles. |
| `DIMENSION_BROWSER_EXECUTABLE` | Chrome/Chromium executable. |
| `DIMENSION_BROWSER_RELAY_URL` | Relay CDP endpoint (default `http://127.0.0.1:9224`). |
| `DIMENSION_BROWSER_HEADLESS` | `false` for a visible window. |
| `DIM_BROWSER_PYTHON` | Interpreter for the task agents. |

## Tools

Model-callable: `browser_open`, `browser_state`, `browser_snapshot`,
`browser_screenshot`, `browser_act`, `browser_tab`, `browser_task`, `browser_task_wait`,
`browser_task_cancel`, `browser_publish`, `browser_publish_wait`, `browser_close`.
View-only: `browser_frame` (live JPEG by default, PNG for annotation), `browser_annotate`,
`browser_viewport`, `browser_profiles`, `browser_publish_confirm`, `browser_publish_cancel`.

Page content is untrusted data, never instructions.

## Connect a platform with a browser profile

Publishing works in three steps. You sign in once, your agent drafts, and you
press Post.

1. **Sign in once.** Ask your agent to connect the account (for example
   "connect X as @yourbrand"). It opens the site's login page in the Browser
   View, on a profile of its own for that account. Log in there yourself: your
   password, your two-factor code, any CAPTCHA. The agent never types a
   password and never signs up for you. The login is saved in the profile and
   survives restarts, so you do this once per account.
2. **Your agent drafts and fills.** When there is something to post, the agent
   opens the compose page in that profile and fills in the text. Nothing is
   sent.
3. **You press Post.** A bar at the bottom of the Browser View shows where the
   post goes (the page and the profile) and exactly what will be posted. Press
   **Post** to send it, or **Cancel**. While the bar waits, the agent can't
   touch the page. After you press Post, the post's own link comes back to the
   agent as the receipt.

If you post it yourself with the site's own button instead, the bar can't
know for sure, so it says "May have posted" and never posts a second copy.
Nothing is posted unless you press a Post button.

## Publishing

`browser_publish` posts through a profile the human signed in to once, by hand.
The caller supplies a recipe as data, so the pack stays platform-agnostic:

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
  characters) is the caption the human sees above the value.
- `receipt.path`: a template matched against the posted URL's pathname (the
  origin is checked separately; query and hash are ignored). Literal text plus
  `{segment}` (one path segment) and `{digits}` (one or more digits), at most one
  placeholder per segment; starts with `/`, at most 256 characters. Matching is
  linear-time, so a hostile page's hrefs cannot stall it.
- `mode: "check"` opens the compose page and reports `signed-in` or
  `not-signed-in`. Signed out, nothing is typed; the human signs in in the View.
- `mode: "post"` types each value, reads it back exactly, and parks the publish
  as `awaiting-confirmation`, recording the active tab and its URL as
  `composeUrl` (where the post goes). **Nothing is submitted.** The Browser View
  shows a confirm bar with that URL, the profile and every value; only the
  human's **Post** submits (`browser_publish_confirm`, which also refuses any
  call the host did not stamp as coming from the View). The page is re-checked
  first: another active tab, a different URL or a changed value fails with
  nothing clicked.
- While a publish is pending the page belongs to the human: `browser_act`,
  `browser_tab`, `browser_task` and `browser_publish` are refused
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
- On the `chrome-relay` engine the page is in your own Chrome, which you can
  use directly, outside the View. The bar's Post still works there, but a
  close, cancel, expiry or changed page settles `unknown`, never `cancelled`,
  `expired` or `failed`.
- Recipe selectors (`signedIn`, `fields`, `submit`) accept any puppeteer
  selector syntax: CSS, `pierce/…` to reach into open shadow roots,
  `::-p-text(…)` and `::-p-xpath(…)`. `receipt.linkSelector` is read in-page,
  so it accepts CSS and `pierce/…` only.

Hard lines: publishing never types into a password field, never uses the saved
passwords, never automates a sign-up, login or CAPTCHA, clicks submit exactly
once and never retries it.

## Tests and benchmark

```bash
npm test
```

Real Chrome against a local fixture server that counts the writes it accepts.
Without Chrome installed the browser tests skip loudly rather than pass.

`node bench/run.mjs` applies to five local practice job sites with each task
agent and prints time, steps, model calls, tokens and success per site.
