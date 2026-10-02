# ElevenLabs voice

## What it is

A speech provider for Dimension: an agent's replies spoken by ElevenLabs (Eleven v4 Turbo by default, or Eleven v4,
or Flash v2.5) with word-level caption timing, and **live voice conversations** through an ElevenLabs agent that
hands repository work to your coding agent. A voice profile picks it by naming the provider `elevenlabs`.

## What it contains

- **The `elevenlabs` speech provider** (`src/index.ts`), declared `speak: true`, `converse: true`, `listen: false`.
  Eleven v3 and v4 are served over the Text-to-Dialogue socket, which streams audio with character alignment a few
  hundred milliseconds after the first text; every other model is spoken one segment per HTTP request. The caller
  sees the same speaking session either way. Listening is not offered: pair it with an on-device listener.
- **Live calls** (`src/converse.ts`, `src/convai.ts`, `src/agents.ts`). The engine holds the ElevenLabs Agents
  socket and carries microphone audio up and the voice down. On first use the pack creates one shared agent called
  `dimension-live` and one client tool, `delegate_to_agent`, on your account and keeps them in step with what the
  code wants; the persona, first message and voice arrive per call as overrides, so nothing about a session is
  written to your account.
- **A writing guide** (`src/guide.ts`) for Eleven v4 and v4 Turbo: how to place the short audio tags in square
  brackets, with punctuation and numbers written as words. The engine hands it to the small model that rewrites a
  reply into speech. Flash v2.5 gets none, and the rewriter is then told never to write a bracket.
- **The voice profile `live-eleven`** (`voice-profiles/live-eleven.yml`): ElevenLabs under `converse` and `speak`
  (with an on-device Kokoro voice as the spoken fallback) and a local Parakeet listener.
- **A connect form** (`connect/key.template.json`) for the API key.

No tools, skills, prompts or rules.

## Who can use it

Anyone on the canary release ring (`channel: "canary"`). It is off until you enable it (`defaultEnabled: false`) and
connect a key. You need an ElevenLabs account and an API key with the Text to Speech permission; to talk live the key
also needs the Agents (ConvAI) read and write permissions. Voices: Read is optional and lists your own voices in the
picker. `ELEVENLABS_API_KEY` in the environment works in place of the form.

## Limits and risks

- **The key.** It is stored only on this machine (`~/.config/dimension-speech/elevenlabs.json`, or the environment)
  and is sent only, as the `xi-api-key` header, to `api.elevenlabs.io`. A live call connects with a short-lived signed
  URL that the key mints, never with the key itself. The key is never logged, put in a URL or echoed in an error.
- **A live call leaves the machine.** Your microphone audio and the call's transcripts go to ElevenLabs, and the
  conversation half of the call runs on an LLM (`claude-haiku-4-5`) that ElevenLabs hosts. You pay ElevenLabs per
  connected second. A call ends at ElevenLabs' own ceiling of 7200 seconds; a call in which you say nothing is ended
  server-side after 900 seconds as a backstop, and the engine's own idle hang-up acts first.
- **It writes one agent and one tool to your ElevenLabs account** (`dimension-live`, `delegate_to_agent`), and the
  ids (never the key) are kept in `<engine home>/speech/elevenlabs-agents.json`. Deleting the agent remotely is
  safe: the next call recreates it. A key without the Agents permissions still speaks; only live calls report the
  missing permission.
- **What reaches the agent's mouth.** Progress while your coding agent works goes up as a silent context update
  and is never spoken; a final result is sent as a user message, which speaks, so it waits for the agent to stop
  talking: up to eight seconds by default, stretched to at most 32 seconds while the agent is still speaking, and
  then it is sent anyway.
- **The writing guide is advice, not a guarantee.** The engine strips a tag for a fallback voice only when it is 60
  characters or shorter; a longer one would be read aloud, so the guide keeps tags short and few.

## Build and test

```sh
bun test           # from this folder: provider, live calls, provisioning, catalog, guide
bun run check      # biome
```

There is no build step: the engine loads `src/index.ts`.
