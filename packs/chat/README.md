# Chat

## What it is

Your personal assistant in a room of its own. A calm conversation with Aether, a rail of your past sessions beside it, and a viewer that opens the documents, slides and images it makes. No repo, no branches, no developer chrome: one layout and one space, assembled entirely from marketplace packs. Press **Face to face** in the rail to talk with it out loud.

## What it contains

Metadata only: a layout (`chat`, slots `switcher`, `rail`, `workspace`, `artifact-view`) and one space (`chat`). The space declares which pack fills each slot and requires them:

| slot or part | pack |
|---|---|
| switcher | `classic-switcher` |
| rail | `chat-rail` |
| workspace | `classic-workspace`, with the sections `chat-thread` (thread), `independent-composer` (composer) and `classic-start` (start) |
| also required | `swiss-knife`, `generative-ui` |
| `face` surface, opened from the rail's **Face to face** row | `face-to-face` |

It talks to the General Agent `aether` in the `inso-personal` workspace. It has no tools, skills, prompts or rules of its own; `generative-ui` is what gives Aether, and only Aether, the `render_ui` tool that draws a plan, a comparison or a checklist in the conversation.

`assets/preview/` is the space's listing: two screenshots and a 13-second clip of a real Live call (Face, **Talk live**, a spoken question, the voice answering), recorded on a dev lane of this checkout with a real ElevenLabs agent.

## Who can use it

Anyone on Dimension 0.11.19 or later, on either release ring: no pack of the Chat set carries a `channel` any more, and this pack and the three it requires that were Chat's own (`chat-rail`, `chat-thread`, `face-to-face`) declare `requires.dimension` `>=0.11.19`, the same floor `generative-ui` has, so a build older than the one that carries the whole set cannot use the space. It is on by default. On an older build the app keeps the space out of the switcher and the Space Store lists it as "Requires Dimension >=0.11.19" with Install disabled: the fix is updating Dimension. To talk, a voice profile must name a ready speech provider; **Talk live** needs a Live-capable provider (an ElevenLabs key with the Agents permissions, or Codex realtime) and a session in the pane, which a brand-new Chat does not have yet: send a first message, or press **Tap to talk** once.

## Limits and risks

- The space requires all nine packs it names, and its own pack floors Dimension at 0.11.19, the build that carries the whole set, so an older build gets no space at all (see Who can use it) rather than one that opens without what a skipped pack filled.
- Talking opens the microphone and sends audio to the voice profile's provider; see the Face's README for exactly what is sent and where.
- The space stores nothing itself: sessions live where every other space keeps them, scoped to the `inso-personal` workspace. The one exception is `chat-rail`, which keeps Collections in the webview's `localStorage` (see its README).
