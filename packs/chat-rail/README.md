# Chat Rail

## What it is

The Chat space's session rail: only your conversations, newest first, with a search box, a New session button and collections you make yourself to group them. No repos, branches, PR chips or recaps. It is built from `@fraym/ui` primitives and the rail slot's channels only, with no shipped rail inside.

## What it contains

One component, `chat-rail`, filling the `rail` slot (`dist/index.mjs`). No tools, skills, prompts or rules.

## Who can use it

Anyone on Dimension 0.11.19 or later, on either release ring (`requires.dimension` `>=0.11.19`), on by default. It loads in the Chat space, which requires it.

## Limits and risks

- **Collections are kept in the webview's `localStorage`** (`src/collections-store.ts`, the pack's only persistence): shared by the app's windows (one origin) but not synced across machines, and lost on reinstall. The file says this is interim until a pack-state door exists.
- It lists sessions the host gives it and nothing else: no files, no repositories.

## Build and test

```
bun run build   # vite build -> dist/index.mjs (committed: the host loads the built bundle)
bun run test    # bun test test/
```
