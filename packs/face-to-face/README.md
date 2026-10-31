# Face to face

## What it is

Talk to your agent and watch it answer. A full-screen surface for the Chat space: a halftone dot-matrix head
that turns, blinks and lip-syncs to the **actual spoken audio**, and captions every word as it is said. It opens from
the Chat space's rail, on its **Face to face** row.

## What it contains

One bundle, one component (`plugin.json`):

| id | export | fills |
|---|---|---|
| `face-to-face` | default (`FaceSurface`) | the space's `face` workspace surface (`components.face`) |

A space opts in with `workspace.surfaces: [..., "face"]`, `workspace.chrome.face: "none"`,
`components.face: "face-to-face"`, a rail action `{ target: "surface", surface: "face" }` and
`requires.plugins: ["face-to-face"]` (the Chat space's `packs/chat/plugin.json` is the wiring proof). The rail row is the
only way in: the pack ships no pinned door or other launcher of its own.

No tools, skills, prompts or rules.

### How it talks

The pack has **no transport of its own**. All voice comes from the kit hook `useVoiceConversation()` (granted in
`fraym/packages/ui/src/shell/space/host-externals.ts`); `src/surface/voice.ts` is the only file that touches it.

| hook | on screen |
|---|---|
| `phase` | face state (`listening` / `thinking` / `speaking`), the label beside the waveform, which controls exist |
| `levels.getAgent()` / `getMic()` | the waveform mark, the jaw coupling in the procedural mouth |
| `words` + `audioClock()` | the two-line captions and the procedural lip timing |
| `faceAt()` (52 ARKit weights, `ARKIT_52_NAMES` order) | the mouth, when non-null; otherwise the procedural mouth, cross-faded |
| `partial` | the person's live words, in the captions' place |
| `notice` / `error` | shown verbatim (a key to connect, a model downloading, a voice or lip-sync model skipped), with a hint only when the words name the cause. In the voice conversation the notice has its own line above the captions and the person's words, and it grows upward, so it never covers them; in a Live call it sits above the Live bar |
| `micLive` | the red dot and **Mic on**, always visible |

### Talk live

Beside **Tap to talk**, the surface offers **Talk live** when the engine can open a realtime voice for the session (the
profile names a `converse` choice that is ready; doc 92 of the Dimension repository). A realtime model (Codex realtime, or
an ElevenLabs agent) talks with you and hands anything about your work to the session's agent, then says the agent's
answer in its own words. The button names where the microphone goes (`Mic → <voice>`); the same name stays on screen
while the call lasts.

**The call itself is the kit's own Live bar, drawn below the face**: the orb with its eyes, the waves that flow out of it as
either side speaks, the two-line caption, the call's clock, and Mute and End. It is the bar you see above the composer
when you press Live there (`LivePresence`, granted in `host-externals.ts`), so a call looks and behaves the same in both
places and this pack carries no second copy of it. Its Mute, End and clock reveal on hover or keyboard focus and stay
visible on touch.

| from `useLiveConversation()` (`src/surface/live.ts` is the only file that touches it) | on screen |
|---|---|
| the whole call | the Live bar below the face: phase prompt or the newest line (either speaker; a finished line stays while the voice is still saying it, then fades), the clock, **Mute**, **End call** |
| `enginePhase` | the face state. It is the call's own phase, which the engine goes on telling through a mute, so the face keeps showing the voice answering or the agent working |
| `getOutputLevel()` / `getInputLevel()` | the jaw (below); the Live bar reads the same levels for its waves |
| `phase` (`muted`) / `muted` | the microphone dot in the top bar and a relaxed face while the call is listening |
| `voice` | the status note above the bar: **Live · <voice>**, always visible |
| `error` | the card, verbatim, with **Try again** (starts the CALL again) and **Dismiss** (hangs up, which clears the failure and offers Tap to talk and Talk live again); the bar steps aside for it |

A Live call's voice is the realtime provider's own audio (the browser plays it; Codex realtime streams to the browser
directly, an ElevenLabs agent through the engine), and nothing times it to words or runs the audio-to-face model on it, so
there is no word schedule and no model to read: while the voice speaks the mouth gets a playhead that simply runs plus the voice's own loudness (`src/surface/live-mouth.ts`), and the
animator's "voice with no viseme data yet" path moves the lips with the sound. It is a level-driven mouth, not the
phoneme-accurate one of the voice conversation. A call and a voice conversation never run at once: either start button
is gone while the other is open, and Back and Esc end whichever is. The voice conversation keeps its own waveform mark, captions, Mute and microphone picker.

If the host order of `ARKIT_52_NAMES` ever differs from this pack's rig, the model is ignored and the procedural
mouth is used.

**A fresh start.** With no session yet (the Chat space's first contact, before anything was sent) the surface still reads as
ready: readiness is the engine's and the window's. **Tap to talk** there opens the microphone in the click, asks the host
for the pane's session (the hook's `act("ensureSession")`, which carries no message) and talks on it as soon as the seat
reports it, so pressing it once creates one session and starts the conversation.

**With voice mode.** Voice mode (doc 91 of the Dimension repository) is the reply hook that speaks any session's
replies once you choose Conversation in the voice panel the composer microphone opens (hold it, or right-click it); the Face is its cascaded-loop front. While a conversation is open for a
session the voice desk is silent for THAT session, because the conversation's own voice carries its audio and its face frames;
every other session keeps the desk's behaviour. The kit's `useVoiceConversation` tells the desk when it starts and stops, so
this pack does nothing for it.

### The head asset (an SDK gap, solved by inlining)

A pack bundle is fetched, hash-checked and `import()`ed from a **Blob URL**, so it has no file path of its own; the
fill props carry no asset base (`resolvePluginAssetUrl` is a host-frame prop, never passed to a fill); and the
engine's `/plugin-assets` route serves only allow-listed extensions, `.bin` not among them. The baked head
(`assets/head-f01.bin`, ~130 KB, already deflate-raw inside) therefore ships **inside the bundle** as a base64
data URL (`vite build` with `assetsInclude: ["**/*.bin"]` and `import ... ?inline` in `src/surface/head-source.ts`),
~175 KB of `dist/index.mjs`.

### Layout

- `src/index.tsx` — the component; the only wiring to the host.
- `src/surface/` — the surface: `surface-model.ts` (pure: phase to screen, Back/Esc), `face-surface.tsx`,
  `waveform*.ts(x)`, `voice.ts` and `live.ts` (hook adapters), `live-mouth.ts` (how a call moves the mouth), `head*.ts` (asset), `styles.ts`.
- `src/face/` — the face itself: animator, lip-sync, expressions, WebGL2 dot renderer, captions (see `PROVENANCE.md`
  for the head's licence).

## Who can use it

Anyone on the canary release ring for now (`"channel": "canary"`; hidden on stable until the Chat set is promoted with 0.11.16). It is on by default
(`defaultEnabled: true`) and loads only in the Chat space, the one space that opts in. It needs Dimension 0.11.16 or
newer (`requires.dimension`), because the Live bar it draws (`LivePresence`) is first granted to packs there: on an older
build the engine skips the pack and the Face's place in the Chat space reads "This space surface is not installed" (its text says to reinstall; updating Dimension is the fix). To talk you
need a voice profile whose speech provider is ready (a key connected, a model downloaded); until then the surface shows
what is missing. **Talk live** is offered once the pane has a session (send a first message, or press Tap to talk once):
the call is placed on a session, and a brand-new Chat has none yet.

## Limits and risks

- **It opens the microphone and sends audio through the configured speech provider.** Which provider that is, and
  whether your audio leaves this machine, is up to the voice profile you chose; the surface shows the red dot and
  **Mic on** whenever it is open.
- **Talk live sends your microphone to the live voice's provider** (Codex realtime or ElevenLabs, whichever the profile's
  first ready choice is) for as long as the call is open, and the button says which. The Voice pane in Settings lists it.
- **Consent.** The microphone opens from one place per conversation: the click on **Tap to talk** or on **Talk live**
  (or **Try again** after a failure). Mounting the surface, in any state, never starts a conversation. Back to thread and Esc call `stop()`
  (which releases the mic) and mount the `session` surface.
- **No transport, no storage of its own.** The pack holds no key and no connection; everything it shows comes from
  the kit's `useVoiceConversation` and `useLiveConversation` hooks.
- **The head is inlined.** A bundle importing an ungranted name is refused whole, so the bundle's runtime imports are
  exactly `react`, `react/jsx-runtime` and the granted `@fraym/ui` names `useVoiceConversation`, `useLiveConversation`, `LivePresence` and `ARKIT_52_NAMES`.

## Build and test

```
bun run build      # vite build -> dist/index.mjs (committed: the host loads the built bundle)
bun test           # this pack's tests
bun run typecheck  # tsc (the kit's own sources add one unrelated error in presence/wisp-geometry.ts)
```

**Re-bake the head, then `bun run build`**; `test/externals-grant.test.ts` fails when the committed bundle carries a
different head than `assets/`. The same test checks the bundle's runtime imports (above) against the built file and
the sources.
