# Voice mode

## What it is

The **Voice** pane in Settings: it tells you whether voice mode can speak right now, which speech engines are
ready, which voices exist and what each would really speak with, which agent sounds like what, and how to change
any of it. Voice mode itself (the engine's reply vocalizer, the voice desk, the composer's speaker toggle) is the
engine's, not this pack's; this pack is the window onto it.

## What it contains

One component, `voice-settings`, filling the `settings` slot with the label `Voice`. It shows:

- **A headline** saying whether voice mode can speak, from the speech profiles the engine publishes.
- **Speech engines**: each installed provider, whether it is ready to speak and to listen, and why not.
- **Voices**: every voice profile visible from the workspace (workspace, yours, a plugin's, built-in), its
  fallback chain step by step, and the voice it would speak with now.
- **Agents**: the voice each agent ships with, and the default for the agent that names none.
- **Models**: the two small models that make voice mode feel attentive (the `voice` role that rewrites a reply into
  spoken prose, and the `classifier` role). Neither is required.
- **Change it**: where to assign an agent a voice (`voice:` in `agent.md`, or `voice.agents.<agent>` in
  `config.json`), where to drop a new voice profile (`voice-profiles/`), and the `voice` block keys that tune
  behaviour (`vocalizer.mode`, `vocalizer.enhanced`, `attention.catchUpAfterMinutes`, `attention.chimes`).

No tools, skills, prompts or rules. The pack imports only `react`.

## Who can use it

Anyone on the canary release ring (`channel: "canary"`). It is on by default (`defaultEnabled: true`) and is
listed by the Chat pack, so enabling Chat brings it along. It works in every space and with every agent. No
sign-in, key or CLI.

## Limits and risks

- **Read-only.** The pane reads three public root facts (`speech/profiles`, `agents/list`, `models`) through the
  root-fenced Store and writes nothing. Choosing an agent's voice, trying a voice and showing which model the `voice`
  and `classifier` roles resolve to each need a door the Store does not give a root seat yet; the pane says how to
  do them by hand instead of drawing controls that would not work.
- **It shows facts the engine publishes.** On an engine that publishes none of them the pane says there is no
  speech engine, never throws; a malformed row is dropped.
- **The tuning values are not shown.** The `voice` block of `config.json` is not in the Store, so the pane lists
  the keys and their defaults, not what you set.

## Build and test

```sh
bun run build   # dist/index.mjs
bun run test    # bun test test/
```

The host loads the committed `dist/index.mjs`, not `src/`: rebuild and commit it with every change.
