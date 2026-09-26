# Brand Marks

Ten presence avatars ("Vibrs") for Dimension's well-known `avatar` slot — **X**,
**Reddit**, **YouTube**, **Discord**, **Y Combinator**, **Product Hunt**, **Bluesky**,
**Threads**, **Instagram** and **TikTok** — shipped from ONE bundle. Each paints the
brand's official mark and follows the session with container-only motion.

> The pack's code is MIT. The **marks are trademarks of their owners** and are not
> licensed by the MIT licence; no endorsement is implied. See `PROVENANCE.md`.

## How the host runs it

`plugin.json` declares ten components off one entry (`dist/avatar.js`), each with
`slot: "avatar"`. The engine publishes each as a presence record
`plugin:brand-marks/<id>`; the host mounts the bundle in a sandboxed iframe
(`allow-scripts allow-popups`, opaque origin) navigated to the engine's
`/pack-shell` document, which holds a single `#fraym-pack-root`. The host fetches
the bundle itself and posts its SOURCE to the shell, which imports it from a
`blob:` URL, so no asset URL or token ever reaches the frame.

### Which avatar am I? — `data-avatar`

The host writes the component id onto the root it hands the bundle:

```ts
document.getElementById("fraym-pack-root")?.dataset.avatar; // a MarkId: "x" | "reddit" | "youtube" | "discord" | "ycombinator" | …
```

No attribute → the first mark (`x`). An unknown id → the bundle posts an `error`
frame and paints nothing. The bundle is ONE self-contained ES module with no
imports: it boots from a `data:` URL, so a relative import has nothing to resolve
against.

### Protocol (pack bridge v5)

- pack → host: `{ __fraymPack: true, v: 5, kind: "ready", subscribe: ["theme", "presence"] }`,
  and `{ …, kind: "error", message }`.
- host → pack: `init` with `channels: { theme?, presence? }`, then `state` frames
  (`channel`, `value`) on every change. Frames without the brand or with `v > 5` are
  ignored; a malformed payload is ignored; an absent channel means "not offered".
- `theme.mode` (`dark` / `light`) picks the mono marks' (X, Threads, TikTok) white-on-dark or black-on-light variant and
  is declared as the document's `color-scheme`. Before a theme arrives: dark.
- `presence`: `state`, `mode`, `energy`, `emotion`, plus the cost contract
  (`motion`, `gateOpen`, `fpsCap`).

## Motion rules

| Presence | What moves (containers only) |
|---|---|
| `idle`, or no presence yet | **nothing** — the mark exactly as published |
| `thinking` | slow breathe (scale ≈ 1 → 1.03–1.07 by `energy`), brand-tinted halo pulses |
| `typing` | quicker bob + pulse, brighter halo |
| mode `run` / `edit` (while busy) | an orbiting brand-tinted ring |
| mode `search` / `read` (while busy) | a rotating sweep |
| emotion turns `pleased` / `proud` / `playful` mid-turn | one brief pop |

The glyph is never recoloured, distorted, skewed, cropped or re-lettered. Everything
is CSS animation driven by `data-*` attributes on the stage — no rAF loop.

**Cost contract.** `motion: "off"` or `"still"`, `gateOpen: false`, or the OS setting
`prefers-reduced-motion: reduce` stop every animation and hold the unmodified mark (a
busy session keeps a static halo, which costs nothing). `motion: "idle"` halves the
amplitude. `fpsCap` is intentionally unread: there is no frame loop to cap.

## Adding a mark

1. Take the glyph from [Simple Icons](https://github.com/simple-icons/simple-icons)
   (CC0 path data) at a pinned commit; copy the path string verbatim and the brand
   hex from `data/simple-icons.json`.
2. Add an entry to `MARKS` in `src/marks.ts`. If the official look needs a second
   colour inside a cut-out, add a `backing` shape that lies wholly inside the glyph's
   filled silhouette — never edit the path.
3. Add `{ "id", "slot": "avatar", "label" }` to `components` in `plugin.json`.
4. Record the source URL, commit, trademark owner and guidelines link in
   `PROVENANCE.md`, and check the brand's guidelines permit this presentation.
5. `bun run build`, commit `dist/avatar.js`, then from the marketplace root run
   `bun scripts/build-index.ts` and `bun scripts/validate-marketplace.mjs --check`.
