# Bluesky

## What it is

A Bluesky connector. Your agent searches posts, reads posts with their numbers,
threads, quotes, profiles, an account's recent posts, custom feeds, starter packs,
trends and your notifications, and publishes a post or thread you approved on
Traction's campaign board. Most reads are public and need no account; post search,
notifications and publishing use the account you connect with an app password.

## What it contains

- **Read tools**: `bluesky_search_posts`, `bluesky_get_posts`, `bluesky_thread`,
  `bluesky_quotes`, `bluesky_profile`, `bluesky_author_feed`, `bluesky_find_feeds`,
  `bluesky_find_starter_packs`, `bluesky_trends`, `bluesky_my_notifications`,
  `bluesky_link_card`.
- **Write tool**: `bluesky_publish`, for a post or thread approved on the board.
- **Skill `bluesky`**: which tool for which question, search traps, what Bluesky
  can and cannot measure, and how publishing is checked.
- **Connect card**: your handle and an app password.

## Who can use it

Anyone with a Bluesky account. Off by default; turn it on in Plugins. The keyless
reads work before you connect. For search, notifications and publishing, make an
app password in Bluesky (Settings, Privacy and security, App passwords; leave
direct messages off) and enter it with your handle on the card.

## Limits and risks

- The handle and app password are stored in `~/.config/dimension-bluesky/`, with
  the session beside them so the plugin refreshes it rather than signing in again.
  Revoke the app password in Bluesky to cut access.
- `bluesky_publish` posts only what the board approved, character for character
  and image file for image file, from the account the approval names, and only
  once per approval; it also asks you on an approval card in every mode, showing
  every post, image and link card (title, description and image address). It
  cannot like, repost, follow or reply to other people's posts.
- Link cards are read only from public http(s) pages: addresses on your machine
  or private network are refused, at every redirect.
- Images must be PNG, JPEG or WebP under 2 MB; metadata is stripped before upload,
  except a photo's rotation.
  Video and documents are posted by you in the app.
- Bluesky has no impressions or views, so no tool reports them.
- The feed and trend reads use endpoints Bluesky marks unstable.
- Bluesky limits sign-ins (30 per 5 minutes and 300 a day documented) and writes
  (5,000 points an hour).

## Build and test

No build step: the host loads `index.ts`. Tests stub `fetch` and point the
config and approval folders at a temp directory:

```sh
cd packs/bluesky && bun test
```
