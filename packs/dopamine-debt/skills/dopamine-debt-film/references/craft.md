# Craft: what reviewers approved, what they rejected, and why

Ground truth is the person's reaction to the render. Gates are necessary, not sufficient: a film that passed every G-gate at a script score near 99 was still rejected as boring.

## What an approved film did
- **Real moment first.** The subject's own clip saying the quiet part plays within 20 s.
- **Every meme is the punchline of a line written for it,** about the same fact. The line sets up a number or a claim; the meme reacts to exactly that.
- **The narrator has a running flaw,** a small self-own that returns as a callback.
- **Planned music:** two cues, the bed at about −33 LUFS, ducking 9 dB under memes, and a switch at act 3.
- **Its defect, which the reviewer called out:** narration line ends cut on live speech, many right before a meme. The cause was cutting at timestamp boundaries instead of in silence.

## What was rejected, and the lesson from each
| What the reviewer saw | Lesson (now a rule) |
|---|---|
| One full-frame meme cut-away at a time, with no flow | Mix the meme modes; place each overlay on the named thing |
| A meme cut before its word; silent "step one" cards; stock robot imagery | A meme plays whole; no dead air; no "step one", no "robot" |
| A film rejected despite G-gates near 99 | Judge numbers never certify a film |
| "Completely broken": dozens of memes interrupting the narration, words cut off, overused, not fitting | Narration cut only in silence; memes stop narration only at a sentence end; no count floors |
| "Just saying the word is not a meme" | The meme plays its whole spoken line, setup included |
| "Bored till the first minute… no memes, no good content" | Memes cut to a count with no written jokes leaves a dead film; open on a real moment and write jokes |
| "Fewer jokes didn't mean one every five seconds" | Placement follows the debt curve, never a clock |
| One still held while the narration talked; a number highlighted for more than three to five seconds; names stamped on a screen held for ten seconds; a blank stage for two or three seconds; the narrator explaining that a line was the joke | **Show, don't tell:** the picture changes at least every 5 s under narration; a sticker is not a change; a receipt holds 3–4 s, then something explains it. **No blank stage** (a scene's first element is up within 1 s). **An analogy is acted out in a motion-graphic scene.** **Deadpan never labels its own joke.** |
| A celebratory meme over a company's huge margin ("why would the viewer say nice? For us it's not nice"); pointing and double-take memes that landed on nothing; an animal standing in for regulators | **A meme voices the audience's feeling, not the subject's.** **Use the template's canonical version**, the clip the world uses (the library entry's `canonical.is`). **Every meme lands something set up; no decoration.** **A picture depicts the fact; no riddle metaphors.** |
| A whole film nobody could follow: no information came out, almost no memes, a generic corporate bed, a personal claim the narrator made up | **A gate in band is not a watchable film.** **Copy the surface of an approved film:** count its meme templates, stickers, sound effects, captured pages and subject cutouts in the first 180 s, and match them. **The reviewer overrides the persona** when a persona's reading steers a film off memes. **Understood first:** pick three facts and land each with a scene before joking. **The narrator never invents personal facts.** **Draw the money loop when companies are investor, customer and seller at once.** |
| A bed made from a `motion_score` render, rejected outright | **Never ship a `motion_score` render as a bed.** A bed passing `no-hr-music` is not a bed the person likes; a bed clears only from the brand's music ledger `approved` or the library (`music-from-library`, `music-approved`). No model here can listen, so the person's ear is the gate: the Filmmaker makes each film's bed and the person judges it in the render. |

## Rules (all in `DD/taste.json` as G11)
`DD/taste.json` is the one list: every rule with its id, its text and whether code (`framework/g11.py`) or the judge checks it, and `filmmaker-core` restates the gates in one paragraph. The lessons above are where each rule came from. Two that are easy to forget because a gate cannot fully see them:
- Music: the bed rule is in stages.md §Delivery and the G8 row of SKILL.md. The `no-hr-music` proxy has passed a bed a reviewer hated and failed beds a reviewer praised, so the person's ear, not the proxy, is the measure.
- A meme is the audience's reaction at that moment, uses the template's canonical clip, and lands a setup a viewer can name; a picture depicts its fact. These are judged and still advisory (the judge is uncalibrated), so before showing the person, write for every meme and every photo one sentence: "the viewer feels X because the line just said Y", and cut any you cannot write.

## Openings
- The thesis joke carrying the title nouns lands by 5 s. A real moment (a clip, a news read, a post) comes within 20 s. The promise is confirmed by 10 s.
- Never spend the first minute explaining the form (what a filing is). Put the form inside a joke, or later.

## Memes
- The written line sets the meme up, and the meme is the punch. A topic audience rarely laughs at memes dropped in as decoration but does laugh at the subject's own words and numbers played straight. So a meme must land a fact, not decorate one.
- Choose by what the line needs, then measure the clip's whole sentence. Never choose by the library's `payoff.line`.
- Mix the modes: `fullscreen`, `cutout`, `spotlight` (on the named thing), `slot` (in the new row or cell), `ghost` (for a menacing beat).

## Notes from the person
Their notes are symptoms of a flow problem, not a to-do list. Never patch a note literally (for example, adding sound under a silent post). Find the cause in the stage that owns it, check every other instance, and redo from there.

## Reporting to the person
- Measured proof only, with its limits stated. Say "the framework predicts", never "it passes". No excuses.
- Say plainly what was not checked.
