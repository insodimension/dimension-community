# YouTube

## What it is

A YouTube connector for your agent, plus three skills that take a finished film from a render to a published video: they package it, design its thumbnails, and upload it through YouTube Studio in your own signed-in browser.

## What it contains

- **Nine native tools** over the YouTube Data API v3: `youtube_search`, `youtube_get_videos` (up to 50 videos per call), `youtube_list_playlists`, `youtube_list_playlist_items`, `youtube_playlist_add`, `youtube_list_comments`, `youtube_post_comment`, `youtube_get_captions`, `youtube_channel_stats` (by @handle or id). Sign in with your own Google Cloud OAuth client (the one Drive and Calendar use works), and publish its consent screen so the sign-in does not expire after 7 days.
- **Skill `youtube`**: how to use the nine tools, their quota costs and what the API will not do.
- **Skill `youtube-package`**: scored title options, a description with chapters built from the edit's markers, sources and credits, tags, captions, the AI-use disclosure decision, Shorts and end-screen plans. It writes `receipts/publish.json` in the production folder and checks it with `scripts/publish-check.mjs` (plain `node` or `bun`, nothing to install): chapter rules, title and description limits, file hashes, a verdict for every generated or commentary asset, credits present in the description.
- **Skill `youtube-thumbnail`**: one 1280×720 thumbnail, or three for an A/B test, as HyperFrames compositions, rendered with the Motion plugin, checked against the zones where YouTube draws over a thumbnail and at phone size with `scripts/thumbnail-pack.mjs` (needs `ffmpeg`).
- **Skill `youtube-studio-upload`**: a runbook that drives Studio with the Browser plugin's `browser_run`, reads every field back, and records the video id and the read-back in `receipts/publish.json`.
- **Rule `youtube-context`**: always-on guidance for the connector tools.

## Who can use it

Off by default; turn it on in Plugins. The connector needs a Google sign-in through your own OAuth client with the YouTube Data API v3 enabled and its OAuth consent screen published (In production): a client left in Testing gets refresh tokens that expire after 7 days. The three film skills also need the Browser plugin (upload), the Motion plugin (thumbnails) and a production made in the Video space; the package and thumbnail skills run anywhere a production folder exists.

## Limits and risks

- **The Studio upload has run once, on 2026-10-31, against a signed-in Studio;** the custom thumbnail was not seen to take. The labels come from YouTube's help pages and public automation projects. Studio changes its markup; the skill reads the page first and stops when a field will not read back.
- **It never handles your password.** Sign-in, two-step verification and CAPTCHA are yours, in the Browser View.
- **The upload runs `browser_run`, which has full Node access** on your machine and uses whichever saved browser profile you let it open, including its Google sign-in. The host asks before each run. Use a profile you are happy for the agent to act in, and watch in the Browser View.
- **Public needs your yes.** A private or unlisted upload is the default and can be deleted; a public one is asked for by title and channel.
- **Disclosure is your decision.** The skill sets out what YouTube says must carry the AI label and records your answer with reasons; it cannot tell whether a clip looks real, and commentary clips carry a fair-use judgement that is yours.
- **Thumbnails are 1280×720.** YouTube recommends larger; the Motion plugin's stills are this size. Custom thumbnails need a verified channel. The overlay zones and the title and thumbnail statistics the skills quote are third-party measurements, labelled as such, and can change.
- **The API connector** does not upload or edit videos (that is the Studio flow) and reads no analytics (watch time, retention and CTR are read in Studio). Comments are public: the tool asks every time, posts at most 5 a day and refuses repeated text. Quota (as of 2026-11-06): search has its own 100 calls a day since 2026-06-01; most other calls share 10,000 units a day at 1 unit each.
- **Captions after upload** go through Studio's Subtitles page and are the least certain step.

## Build and test

`bun run check` runs the formatter and linter. The two scripts are plain `.mjs` with no dependencies; their tests are in `test/` and run with `bun test`.
