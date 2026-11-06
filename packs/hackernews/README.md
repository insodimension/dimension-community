# Hacker News

## What it is

A read-only Hacker News connector. Your agent searches stories and comments,
reads a thread with its comments in Hacker News's own order, checks an account
before a Show HN, reads the live front page and where an item ranks on it, lists
every story ever submitted for your site, and watches a launch thread for new
comments. It reads Hacker News's two public APIs, Algolia search and the official
Firebase API, and needs no account or key.

## What it contains

- **Tools**: `hn_search`, `hn_item`, `hn_user`, `hn_front`, `hn_domain`,
  `hn_thread_since`. Every one is a read.
- **Skill `hackernews`**: when to use each tool and the search traps (quoted
  terms, the 1,000-hit cap, estimated counts, comments without scores).

## Who can use it

Anyone. Off by default; turn it on in Plugins. No sign-in, no key, no cookies.

## Limits and risks

- It cannot submit, comment, vote or flag, by design: Hacker News asks for
  hand-written text, so you write and post everything yourself.
- Algolia allows about 10,000 requests an hour per IP and returns at most 1,000
  hits per query; the tools say when a search is past that cap.
- Hit counts are Algolia's estimates. Comments have no public score.
- New comments reach Algolia's index about a minute after they are posted.
- Dead items, the second-chance pool and your own `/threads` page are read with
  the Browser pack, not these tools.

## Build and test

No build step: the host loads `index.ts`. Tests stub `fetch` and run the tools:

```sh
cd packs/hackernews && bun test
```
