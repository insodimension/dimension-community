# ElevenLabs voice

## What it is

A speech provider for Dimension: dictation by ElevenLabs Scribe v2 Realtime, an agent's replies spoken by ElevenLabs
(Eleven v4 Turbo by default, or Eleven v4, or Flash v2.5) with word-level caption timing, and **live voice
conversations** through an ElevenLabs agent that hands repository work to your coding agent. A voice profile picks it
by naming the provider `elevenlabs`.

## What it contains

- **The `elevenlabs` speech provider** (`src/index.ts`), declared `speak: true`, `listen: true`, `converse: true`, and
  publishing a catalog model for each: `scribe_v2_realtime` (listen), `eleven_v4_turbo`, `eleven_v4` and
  `eleven_flash_v2_5` (speak), `eleven_v4_turbo` and `eleven_v4` (converse). Eleven v3 and v4 are spoken over the
  Text-to-Dialogue socket, which streams audio with character alignment a few hundred milliseconds after the first
  text; every other model is spoken one segment per HTTP request. The caller sees the same speaking session either way.
- **Listening** (`src/listen.ts`, `src/scribe.ts`). One WebSocket to Scribe v2 Realtime per microphone, 16 kHz PCM sent
  in chunks of at least 100 ms, committed by Scribe's voice activity detection after the profile's `endSilenceMs`
  (kept inside the 0.3 to 3 seconds Scribe accepts). Words arrive as `speech-start`, `partial`, `speech-end` and
  `final`. Muting commits what was said and lets go of the connection; the first audio after unmuting opens a new one,
  with what was said while it connected held and sent in order. A failure Scribe recovers from is retried after a
  pause, three in a row with no speech between them end the session, and a refusal that retrying cannot fix ends it at
  once.
- **Failures in plain words.** Whatever fails, the message is one of the pack's own sentences ("ElevenLabs rejected the
  API key", "ElevenLabs refused the voice request: the key needs the Text to Speech permission", "Could not reach
  ElevenLabs") and never the provider's text, a status number or JSON. An error thrown from opening a voice, a
  listener or a call also carries `status` (the HTTP class, or the class a Scribe error type belongs to) or
  `unreachable: true` with the runtime's network `code`, so the engine can classify it without reading the message.
  That includes a live call ElevenLabs refuses before it starts: the status it writes into the socket's close reason
  becomes `status`, and neither the close code nor the reason is repeated.
- **Live calls** (`src/converse.ts`, `src/convai.ts`, `src/agents.ts`). The engine holds the ElevenLabs Agents
  socket and carries microphone audio up and the voice down. A home with no ids (a new machine, a wiped engine home)
  adopts the agent your key's user created on the account called `dimension-live`, when it carries the
  `delegate_to_agent` client tool, also one your user created (the oldest such agent, never an archived one, never an
  agent that only shares the name, never one a teammate shared with you), records its ids and changes it only where it
  differs from what the code wants; with none it creates the agent and the tool. The persona, first message and voice
  arrive per call as overrides, so nothing about a session is written to your account.
- **A writing guide** (`src/guide.ts`) for Eleven v4 and v4 Turbo: how to place the short audio tags in square
  brackets, with punctuation and numbers written as words. The engine hands it to the small model that rewrites a
  reply into speech. Flash v2.5 gets none, and the rewriter is then told never to write a bracket.
- **Two voice profiles.** `eleven` (`voice-profiles/eleven.yml`) listens with Scribe (language `en`) and speaks with
  Eleven v4 Turbo and names nothing else, so choosing it can never start an on-device model download.
  `live-eleven` (`voice-profiles/live-eleven.yml`) puts ElevenLabs under `converse` and `speak` (with an on-device
  Kokoro voice as the spoken fallback) and a local Parakeet listener.
- **A connect form** (`connect/key.template.json`) for the API key.

No tools, skills, prompts or rules.

## Who can use it

Anyone, on every release ring, running Dimension 0.11.1 or newer (`requires.dimension`; the
pack-provided speech providers, listening and live calls it relies on first ship in that release). It is off until you
enable it (`defaultEnabled: false`) and connect a key. You need an ElevenLabs account and an API key with the Text to
Speech permission to hear replies and the Speech to Text permission to dictate; to talk live the key also needs the
Agents (ConvAI) read and write permissions.
Voices: Read is optional and lists your own voices in the picker. `ELEVENLABS_API_KEY` in the environment works in place
of the form.

## Limits and risks

- **The key.** It is stored only on this machine (`~/.config/dimension-speech/elevenlabs.json`, or the environment)
  and is sent only, as the `xi-api-key` header, to `api.elevenlabs.io`. A live call connects with a short-lived signed
  URL that the key mints, never with the key itself. The key is never logged, put in a URL or echoed in an error.
- **Dictation leaves the machine.** While you listen and are not muted, your microphone audio streams to ElevenLabs and
  is billed by the hour of audio streamed (ElevenLabs listed Scribe v2 Realtime at $0.39 per hour on
  https://elevenlabs.io/pricing/api on 2026-10-08; check it before relying on it). Muting stops the stream. Scribe
  needs about two seconds of audio before it starts transcribing a new connection.
- **Language.** The `eleven` profile asks for English. Leaving `language` out lets Scribe choose; on a short clip it
  once answered with a full-width Japanese full stop after an English sentence, so name the language you dictate in.
- **A live call leaves the machine.** Your microphone audio and the call's transcripts go to ElevenLabs, and the
  conversation half of the call runs on an LLM (`claude-haiku-4-5`) that ElevenLabs hosts. You pay ElevenLabs per
  connected second. A call ends at ElevenLabs' own ceiling of 7200 seconds; a call in which you say nothing is ended
  server-side after 900 seconds as a backstop, and the engine's own idle hang-up acts first.
- **It uses one agent and one tool on your ElevenLabs account** (`dimension-live`, `delegate_to_agent`). It creates
  them only when the account holds none of yours, and PATCHes them only when their body differs from what the code
  wants; the ids (never the key) are kept in `<engine home>/speech/elevenlabs-agents.json`. Deleting the agent remotely
  is safe: the next call adopts another of yours by name or recreates it. A key without the Agents permissions still
  speaks and dictates; only live calls report the missing permission.
- **One agent, one voice model at a time.** Every install that uses your key shares that one agent, and an agent holds
  a single TTS model (`eleven_v4_turbo` or `eleven_v4`). Before each call connects, the pack reads the agent back and,
  if another install left a different model on it, PATCHes its own model back, so a call speaks with the model its
  profile chose. Two installs on different models take turns.
- **What reaches the agent's mouth.** Progress while your coding agent works goes up as a silent context update
  and is never spoken; a final result is sent as a user message, which speaks, so it waits for the agent to stop
  talking: up to eight seconds by default, stretched to at most 32 seconds while the agent is still speaking, and
  then it is sent anyway.
- **The writing guide is advice, not a guarantee.** The engine strips a tag for a fallback voice only when it is 60
  characters or shorter; a longer one would be read aloud, so the guide keeps tags short and few.

## Build and test

```sh
bun test           # from this folder: provider, listening, live calls, provisioning, catalog, guide, profiles
bun run check      # biome
```

There is no build step: the engine loads `src/index.ts`.
