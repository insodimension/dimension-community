# Chat Thread

## What it is

The Chat space's conversation and nothing else: your words, the assistant's words, and one quiet "Worked for" line per turn. It is built from the kit's `StoreThread` part, with no tool rows except a card for a file or an interface the assistant shows you, and no shipped thread inside.

## What it contains

One component, `chat-thread`, filling the `thread` slot (`dist/index.mjs`). No tools, skills, prompts or rules.

## Who can use it

Anyone on Dimension 0.11.19 or later, on either release ring (`requires.dimension` `>=0.11.19`), on by default. It loads in the Chat space, which requires it, as the space's `thread` section.

## Limits and risks

- It hides tool activity by design: what the agent ran is summarised as the "Worked for" line, not listed, apart from a card for a file the assistant shows you and an interface it draws (`render_ui`, pack `generative-ui`). Both are drawn by the kit, so this pack carries no code for them.
- It shows the conversation the host gives it and holds no data of its own.

## Build and test

```
bun run build   # vite build -> dist/index.mjs (committed: the host loads the built bundle)
```

This pack has no tests of its own.
