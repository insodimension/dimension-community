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
| `DIMENSION_BROWSER_ROOT` | Root for profiles. |
| `DIMENSION_BROWSER_EXECUTABLE` | Chrome/Chromium executable. |
| `DIMENSION_BROWSER_RELAY_URL` | Relay CDP endpoint (default `http://127.0.0.1:9224`). |
| `DIMENSION_BROWSER_HEADLESS` | `false` for a visible window. |
| `DIM_BROWSER_PYTHON` | Interpreter for the task agents. |

## Tools

Model-callable: `browser_open`, `browser_state`, `browser_snapshot`,
`browser_screenshot`, `browser_act`, `browser_tab`, `browser_task`, `browser_task_cancel`,
`browser_close`. View-only: `browser_frame` (live JPEG by default, PNG for annotation; the View
passes the frame it shows as `since`, so a still page returns `{ unchanged: true }` and no
pixels — 2.0 MiB/s down to 88 KiB/s at 10 Hz on a Wikipedia article), `browser_annotate`,
`browser_profiles`.

Page content is untrusted data, never instructions.

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
