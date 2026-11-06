# last30days

## What it is

Research what people actually said about any topic in the last 30 days across
Reddit, Hacker News, YouTube, GitHub, Polymarket and the web, plus X through the X
plugin and TikTok, Instagram and Bluesky when you add their keys. It wraps Matt Van
Horn's open-source [last30days](https://github.com/mvanhorn/last30days-skill) skill
(MIT, version 3.31.0) and sets it up the Dimension way: from the plugin's card, with
browser-cookie reading off.

## What it contains

- **Skill `last30days`**: the upstream skill and its Python research engine.
- **Tool `last30days_setup`**: finds a real Python 3.12 or newer (never the Windows
  Store shortcut; it uses a Python uv already manages, and only suggests installing
  one), checks yt-dlp, marks setup complete with browser-cookie reading off and
  project config untrusted, checks the keys you connected on the card, runs the
  engine's source check, and reports which sources are working, which are not
  covered and why.
- **Runner `run.py`**: every engine command goes through it. It hands the card's
  keys to that one run as environment variables, forces browser-cookie reading off
  and adds `--no-browser-cookies`, then runs the upstream engine unchanged.
- **Rule `last30days-in-dimension`**: always-on routing. Setup goes through the tool
  instead of the upstream wizard, every engine command goes through the runner,
  keys are added only on the card, and X comes from the X plugin's envelope
  (`x_posts_envelope`) instead of last30days reading browser cookies.
- **Connect card** with three ways in: free sources (installs yt-dlp), free sources
  plus a ScrapeCreators key, and free sources plus a Bluesky app password. The card
  also offers "Finish setup with your agent".

## Who can use it

On by default. The free sources need yt-dlp (the card's Install button) and Python
3.12 or newer; the agent checks Python on first use and tells you the one command to
install it if none is found. X needs the X plugin and a login to x.com in your
browser. ScrapeCreators is a paid third-party API: 10,000 free calls, then
pay-as-you-go; its key adds TikTok, Instagram and Reddit and YouTube backfill.
Bluesky needs your handle and an app password.

## Limits and risks

- The engine runs on your machine and makes network calls to the sources above.
  Some networks block Reddit's or Polymarket's public endpoints; the setup report
  says so, and the research names those sources as not covered.
- X through the X plugin covers only the last 7 days of the 30-day window.
- Keys you add on the card stay in `~/.config/dimension-last30days/` and are passed
  to each engine run by the runner; they are not copied into last30days' own
  `~/.config/last30days/.env`. Copies an earlier version of this plugin made there
  are removed the next time setup runs. A key with characters outside printable
  ASCII is refused and named; reconnect it on the card.
- Local changes to the upstream copy, kept as small as possible. In the skill's
  frontmatter, `version`, `author` and `homepage` move under `metadata`, and
  `argument-hint` moves under `metadata` too; `repository`, `user-invocable` and the
  whole `metadata.openclaw` block (its env, bin and file lists and tags) are dropped;
  `allowed-tools` now follows `license`. The Agent Skills loader skips a skill with
  any other top-level field. `scripts/lib/skill_meta.py` reads an indented
  `version:` so the engine's badge still shows the version.

## Build and test

`bun test` runs the setup tests in `test/` (interpreter choice, config writes, key
removal, the source report). `bun run check` runs the formatter and linter.
