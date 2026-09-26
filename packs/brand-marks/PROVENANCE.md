# Provenance — Brand Marks

## Two licences, kept apart

- **The pack's code** (`src/`, `dist/`, `assets/icon.svg`, docs) is MIT — see `LICENSE`.
- **The marks it renders** (X, Reddit, YouTube, Discord, Y Combinator, Product Hunt,
  Bluesky, Threads, Instagram, TikTok) are **trademarks of their owners**. They are NOT licensed by the MIT licence, and this pack implies no
  affiliation with or endorsement by any of them.
- **The glyph path DATA** is taken verbatim from [Simple Icons](https://github.com/simple-icons/simple-icons),
  released under **CC0-1.0** (public-domain dedication). CC0 covers the path data's
  copyright only; it grants no trademark rights. Simple Icons' own disclaimer says
  the same: using a brand's icon is subject to that brand's guidelines.

## Source

Simple Icons release **16.32.0**, commit
[`3173436c1255ab7cdc9c38ab85ca0fca333688d9`](https://github.com/simple-icons/simple-icons/tree/3173436c1255ab7cdc9c38ab85ca0fca333688d9)
(`master` on 2026-09-25). Brand hexes come from `data/simple-icons.json` at the same commit.

| Mark | Path data | Hex | Trademark owner | Official brand guidelines |
|---|---|---|---|---|
| X | [`icons/x.svg`](https://raw.githubusercontent.com/simple-icons/simple-icons/3173436c1255ab7cdc9c38ab85ca0fca333688d9/icons/x.svg) | `#000000` | X Corp. | https://about.x.com/en/who-we-are/brand-toolkit |
| Reddit | [`icons/reddit.svg`](https://raw.githubusercontent.com/simple-icons/simple-icons/3173436c1255ab7cdc9c38ab85ca0fca333688d9/icons/reddit.svg) | `#FF4500` | Reddit, Inc. | https://www.redditinc.com/brand |
| YouTube | [`icons/youtube.svg`](https://raw.githubusercontent.com/simple-icons/simple-icons/3173436c1255ab7cdc9c38ab85ca0fca333688d9/icons/youtube.svg) | `#FF0000` | Google LLC | https://www.youtube.com/howyoutubeworks/resources/brand-resources/ |
| Discord | [`icons/discord.svg`](https://raw.githubusercontent.com/simple-icons/simple-icons/3173436c1255ab7cdc9c38ab85ca0fca333688d9/icons/discord.svg) | `#5865F2` | Discord Inc. | https://discord.com/branding |
| Y Combinator | [`icons/ycombinator.svg`](https://raw.githubusercontent.com/simple-icons/simple-icons/3173436c1255ab7cdc9c38ab85ca0fca333688d9/icons/ycombinator.svg) | `#F0652F` | Y Combinator Management, LLC | none recorded (`guidelines` absent); source: https://www.ycombinator.com/press |
| Product Hunt | [`icons/producthunt.svg`](https://raw.githubusercontent.com/simple-icons/simple-icons/3173436c1255ab7cdc9c38ab85ca0fca333688d9/icons/producthunt.svg) | `#DA552F` | Product Hunt, Inc. | https://www.producthunt.com/branding |
| Bluesky | [`icons/bluesky.svg`](https://raw.githubusercontent.com/simple-icons/simple-icons/3173436c1255ab7cdc9c38ab85ca0fca333688d9/icons/bluesky.svg) | `#1185FE` | Bluesky Social, PBC | https://bsky.social/about/blog/press-faq |
| Threads | [`icons/threads.svg`](https://raw.githubusercontent.com/simple-icons/simple-icons/3173436c1255ab7cdc9c38ab85ca0fca333688d9/icons/threads.svg) | `#000000` | Meta Platforms, Inc. | https://www.meta.com/brand/resources/instagram/threads |
| Instagram | [`icons/instagram.svg`](https://raw.githubusercontent.com/simple-icons/simple-icons/3173436c1255ab7cdc9c38ab85ca0fca333688d9/icons/instagram.svg) | `#FF0069` | Meta Platforms, Inc. | https://about.meta.com/brand/resources/instagram |
| TikTok | [`icons/tiktok.svg`](https://raw.githubusercontent.com/simple-icons/simple-icons/3173436c1255ab7cdc9c38ab85ca0fca333688d9/icons/tiktok.svg) | `#000000` | ByteDance Ltd. | none recorded (`guidelines` absent); source: https://tiktok.com |

The guideline URLs are the ones Simple Icons records for each icon (`guidelines`
field), cross-checked against a web search on 2026-09-25. Where Simple Icons records
no `guidelines` (Y Combinator, TikTok), the table says so and gives its `source` URL
instead; no guideline URL is invented.

### Asked for, not carried

- **LinkedIn** — Simple Icons has no `linkedin` icon at this commit (`icons/linkedin.svg`
  is a 404, and `data/simple-icons.json` has no LinkedIn entry). No mark ships; the
  Traction `linkedin` agent uses a Vibr avatar instead.
- **Hacker News** — Simple Icons has no `hackernews` icon at this commit. It carries
  **Y Combinator** (`ycombinator`), the company that runs Hacker News, and that is what
  ships, named honestly as Y Combinator, not as a Hacker News logo.

## How each mark is presented

The path strings in `src/marks.ts` are byte-for-byte the Simple Icons data. No
path is edited, simplified, re-drawn or re-coloured beyond a single fill.

- **X** — the mono glyph, white on dark / black on light: the two colour variants
  X's toolkit publishes. The pack picks by the host's `theme.mode`.
- **Reddit** — the Simple Icons glyph is the one-colour cut-out (the Snoo is a hole
  in the orange bubble). The full-colour look is COMPOSED: a white disc
  (`r = 11.4`, wholly inside the `r = 12` bubble) sits behind the unedited
  orange glyph and shows only through the Snoo. Honest limit: Reddit's
  full-colour logo also carries a dark outline and details the one-colour data
  does not contain, so this is the one-colour cut-out presented white-on-orangered,
  not a reproduction of the full-colour artwork.
- **YouTube** — the red rounded tile with the play triangle as a cut-out; a white
  rect sits behind it inside the tile, so the triangle reads white — YouTube's
  icon presentation.
- **Discord** — Clyde in Blurple, the glyph alone.
- **Y Combinator** — the orange square with the Y as a cut-out; a white rect sits
  behind it inside the square, so the Y reads white — YC's orange-tile presentation.
- **Product Hunt** — the orange disc with the P as a cut-out; a white disc
  (`r = 11.4`, wholly inside the `r = 12` circle) shows only through the P.
- **Bluesky** — the butterfly in Bluesky blue, the glyph alone.
- **Threads** — the mono glyph, white on dark / black on light, picked by `theme.mode`
  like X.
- **Instagram** — the one-colour glyph in Simple Icons' `#FF0069`. Honest limit: this
  is Instagram's single-colour glyph, not its gradient artwork, which the one-path
  data does not contain.
- **TikTok** — the mono glyph, white on dark / black on light. Honest limit: TikTok's
  full-colour note carries cyan/red offsets the one-colour data does not contain.

## The rule this pack follows

1. **Unmodified at rest.** In `idle` (or before any presence arrives) the mark is
   painted exactly as above: no transform, no filter, no animation. Verified in a
   harness: the computed `transform` of every wrapper and of the mark is `none`.
2. **Container-only motion.** Session activity moves WRAPPERS (scale, translate)
   and separate elements BEHIND the mark (a halo, an orbit ring, a sweep) tinted in
   the brand colour. The glyph itself is never recoloured, distorted, skewed,
   cropped, rotated or re-lettered.
3. **No implied endorsement.** The pack is a community presentation; it is not made,
   sponsored or approved by X Corp., Reddit, Inc., Google LLC, Discord Inc., Y Combinator Management, LLC,
   Product Hunt, Inc., Bluesky Social, PBC, Meta Platforms, Inc. or ByteDance Ltd.

If a trademark owner asks for a mark to be removed or changed, remove it: delete its
entry from `src/marks.ts` and the matching `components[]` entry in `plugin.json`.
