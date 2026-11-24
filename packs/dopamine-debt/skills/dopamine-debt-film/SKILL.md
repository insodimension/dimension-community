---
name: dopamine-debt-film
description: "The Dopamine Debt style guide: what makes a deadpan, meme-led comedy explainer film good (voice, jokes, memes, pictures, sound) and how to turn the person's notes into fixes. Guidance for whoever makes the film. Triggers: 'make the film', 'dopamine debt', 'where do the memes go', 'my notes on the render'."
---

# Dopamine Debt: the style

A Dopamine Debt film explains something true about the channel's subject and pays the viewer back with a laugh before their attention runs out. Explanation borrows attention; laughs, "aha" moments and answered questions pay it back. This is a style guide, not a process: use what helps this film. The person's reaction to the render is the only verdict.

## The take

- One falsifiable take, usually "[subject] says A but does B". Every fact is sourced, dated and quoted verbatim; the narrator never invents a personal fact.
- Pick the three facts the viewer must leave with and land each with a picture before joking about it.
- One analogy carries the film. Act it out in a motion-graphic scene, and keep its props on the lines it covers.

## The voice

- Deadpan. The narrator never labels its own joke.
- The narrator has a small running flaw that comes back as a callback.
- Spoken sentences, not headline fragments: a fragment comes out of a voice model as an odd list or a rising question.
- One brand voice for the whole film (`<brand>/brand/voice.json`, else the Settings default). Never change the voice model to fit time; fix length in the script. About 2.7 words a second.

## Jokes

- Open on the thesis joke with the title's nouns in the first 5 seconds, and a real moment (the subject's own clip, a news read, a real post) within 20.
- Never spend the first minute explaining the form. Put it inside a joke, or later.
- A laugh every 10 to 15 seconds, placed where explanation has piled up, never on a clock.
- A punch is a picture joke: on the punch word the picture changes (the tag flips, the stamp lands, the counter overshoots).
- Callbacks: plant something funny early, pay it off at least a minute later.

## Memes

- A meme is the punch of a line written for it, about the same fact. The line sets it up; the meme lands it. No decoration.
- It voices the audience's feeling at that moment, not the subject's: a "nice" over a company's huge margin is the company's feeling.
- Use the template's canonical clip, the one the world uses.
- It plays its whole spoken line, setup included, cut on silence at both edges. One meme per franchise.
- Mix the modes (fullscreen, cutout, spotlight on the named thing, a slot in the new row, ghost for a menacing beat) and play most of it large.
- If you cannot finish "the viewer feels X because the line just said Y", cut the meme.

## Pictures

- Show, don't tell. Under narration the picture changes at least every 5 seconds; a sticker is not a change.
- A picture depicts its fact: the real subject, the real number, the real page. No riddle metaphors, no stock robots, no drawn stand-in for something you can show.
- A scene shows something within 1 second; no blank stage.
- A captured page shows the spoken sentence highlighted for 3 to 4 seconds, then a scene explains it. Real posts carry their source and capture date.
- No text walls: a word on screen the voice does not say counts against you. Nothing important near the frame edge, no cut-off text, no stickers over text.
- A kept scene continues; it never snaps back to a frame it already showed.
- 1920x1080 to the person. No end card, no lower thirds.

## Sound

- Voice is the anchor. Narration is cut only in silence; no sound effect on a word.
- The music bed has no vocals, sits far under the voice and ducks under every meme. Make the film's own bed or reuse an approved one; the person judges it by ear. Never ship a `motion_score` render as a bed.
- Deliver at about -14 LUFS.

## Notes from the person

Their notes are the review. Fix exactly what each note asks, where it lives (the line, the picture or the meme), and put the whole batch into one render. Re-voice only lines whose words changed.

## Reporting

Show the film first. Then a few lines: what you chose, what it cost, the music licence, and what you did not check.

## More, when you want it

- [references/craft.md](references/craft.md): what reviewers approved and rejected, and why.
- [references/stages.md](references/stages.md): file layout, `lines.json`, sources, memes, voice and the mix.
- `kit-film`: building and rendering with the kit (`inso dd new-film <production>`).
- `DD/FRAMEWORK.md` (`inso dd root` prints `DD`): the theory behind the style, and the optional score `inso dd gate <script|cut> <production> <report.json>`. Neither is needed to make a film.
