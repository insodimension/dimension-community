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
  Store shortcut; it sets up a managed one through uv when uv is installed), checks
  yt-dlp, marks setup complete with browser-cookie reading off, copies the keys you
  connected on the card into the engine's config, removes them again after a
  disconnect, and reports which sources are working, which are not covered and why.
- **Rule `last30days-in-dimension`**: always-on routing. Setup goes through the tool
  instead of the upstream wizard, keys are added only on the card, and X comes from
  the X plugin's envelope (`x_posts_envelope`) instead of last30days reading browser
  cookies.
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
- Keys you add on the card are copied into `~/.config/last30days/.env` (owner-only
  file mode on macOS and Linux), because that is where the engine reads them.
- Local changes to the upstream copy, kept as small as possible: the skill's
  frontmatter moves its version, author and homepage under `metadata` so the skill
  loads under the Agent Skills rules, and `scripts/lib/skill_meta.py` reads an
  indented `version:` so the engine's badge still shows the version.

## Build and test

`bun test` runs the setup tests in `test/` (interpreter choice, config writes, key
removal, the source report). `bun run check` runs the formatter and linter.
