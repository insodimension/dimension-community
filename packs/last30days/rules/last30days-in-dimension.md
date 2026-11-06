---
alwaysApply: true
description: How the last30days skill runs inside Dimension
---

The **last30days** skill runs the Dimension way here. These instructions win over
its own first-run, setup and X steps:

- **Setup is a tool, not the wizard.** Before the first last30days run in a
  session, call `last30days_setup` instead of the skill's setup wizard or its
  `setup` command. It finds Python 3.12+, marks setup complete with browser-cookie
  reading off, checks the keys the person connected on the last30days card, and
  lists which sources are live. Call it again after the person connects or
  removes a key.
- **Every engine command goes through the runner.** Where the skill runs
  `scripts/last30days.py`, run the interpreter and `run.py` exactly as
  `last30days_setup` prints them, with the same arguments. The runner passes the
  card's keys to that run only, forces browser cookies off and adds
  `--no-browser-cookies`. Never call `scripts/last30days.py` directly.
- **No browser cookies, no keys in chat.** Never run last30days `setup`, never
  pass `--allow-browser-cookies`, never set `FROM_BROWSER`, and never offer a
  browser-cookie scan or the GitHub signup flow. Optional keys (ScrapeCreators
  for TikTok and Instagram, a Bluesky app password) are added only on the
  last30days card: Capabilities, last30days, Connect. Never ask for one in chat.
- **X comes from the X plugin.** When `x_posts_envelope` is available, call it
  with the engine's exact topic, the plan's X queries, the depth and any
  `--x-handle`/`--x-related` accounts, then run the engine in one shell with the
  `LAST30DAYS_X_HOST_LANE=1` assignment and the `--x-posts`/`--x-related` flags it
  returns. It reaches only the last 7 days of the 30-day window: say so. When it
  answers that X is not covered, or the X plugin is off, run without
  `--x-posts` and report X as not covered.
- **Not covered is never quiet.** A source the setup lists as not covered, or the
  run reports as failed, skipped or partial, is named as not covered in the
  answer, never as having nothing to say.
