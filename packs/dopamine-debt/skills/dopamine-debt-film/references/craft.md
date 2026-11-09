# Craft: what Inso approved, what he rejected, and why

Ground truth is Inso's reaction. Gates are necessary, not sufficient: a film that passed every G-gate at script score 98.7 (Anthropic IPO v2, 2026-11-03) was rejected.

## What he approved
**Altman RAM roast** (`productions/altman-ram-roast/`, 2026-11-04). After the first minute: "fucking awesome… the music matches… memes are properly placed… funny."
- **Real moment first.** Altman's own podcast clip saying the quiet part plays within 20 s.
- **Every meme is the punchline of a line written for it,** about the same fact. "Quite terrible. Your thirty-two gigs of RAM is now a crime against efficiency." → Vince McMahon. "Same stick. Same RGB. It didn't get faster. It got famous." → Stonks. "Crucial. Turns out you weren't." → sticker and record scratch.
- **The narrator has a running flaw:** "Explained by a man with sixty-four gigs of RAM that he uses for Minecraft."
- **Planned music:** two cues, the bed at about −33 LUFS, ducking 9 dB under memes, and a switch at act 3.
- **Its defect, which Inso called out:** 33 narration line ends were cut on live speech, 11 of them right before a meme ("…called HB–" → clip). The cause was cutting at timestamp boundaries instead of in silence.

## What he rejected, and the lesson from each
| Film | His words | Lesson (now a rule) |
|---|---|---|
| Take three (11-02) | memes must flow like RIZPOL's Dota edits, not one full-frame cut-away at a time | Mix the meme modes; place each overlay on the named thing |
| Take four (11-03) | bankruptcy cut before "bankruptcy"; silent "step one" cards made no sense; "robot movies" | A meme plays whole; no dead air; no "step one", no "robot" |
| v2 DD film (11-03) | rejected despite G-gates at 98.7 | Jev numbers never certify a film |
| v3 render S (11-04) | "completely broken": 71 memes, memes interrupting his narration, words cut off, overused, didn't fit | Narration cut only in silence; memes stop narration only at a sentence end; no count floors |
| v3 22-meme cut (11-04) | "You didn't even show the full clip of the bankruptcy meme. Just saying bankruptcy is not a meme." | The meme plays its whole spoken line, setup included |
| v3 22-meme cut (11-04) | "bored till the first minute… no memes, no good content" | Memes cut to a count with no written jokes leaves a dead film; open on a real moment and write jokes |
| v3 (11-04) | "reduce jokes didn't mean every five seconds… it should depend on where the negative things start popping up" | Placement follows the debt curve, never a clock |
| Altman RAM roast redo (11-04), 10 marks | "You can do very good motion graphics about the grocery store… but you're keeping one still"; "show, don't just tell: you highlighted one number while speaking for more than three or five seconds"; "this screen is here more than five or ten seconds… instead of just stamping names"; "blank for more than two, three seconds: this should not happen"; "stuck on the same screen… bring his face with a meme"; "don't say 'that part is our joke'" | **Show, don't tell:** the picture changes at least every 5 s under narration; a sticker is not a change; a receipt holds 3–4 s, then something explains it. **No blank stage** (a scene's first element is up within 1 s). **An analogy is acted out in a motion-graphic scene.** **Deadpan never labels its own joke.** |
| Altman RAM roast redo (11-04), meme marks | Rosen "nice" over an 80% margin: "not the correct meme… why would the persona say nice? For us it's not nice"; Spider-Man pointing and Blinking White Guy: "didn't land with anything… what is the purpose"; a mantis for regulators: "I couldn't understand this" | **A meme voices the audience's feeling, not the subject's.** **Use the template's canonical version**, the clip the world uses (the library entry's `canonical.is`, ruled 2026-11-06). **Every meme lands something set up; no decoration.** **A picture depicts the fact; no riddle metaphors.** |
| Anthropic IPO v5 (11-05), whole film | "I don't recall any content… super boring… Nobody can understand anything. No information came out"; "where the fucking memes? … HR music"; "the roast quoted proper people: Reddit, X, YouTube"; "Well I didn't cancel twice while writing this. So don't mention that."; "Why don't you show the circle jerk?"; "I don't want this to be edited or fixed. This needs to be redone using the new tools" | **A gate in band is not a watchable film:** v5 was G5 in band (3.6/min) and lost him before 3:00. **The roast's surface is the recipe:** in its first 180 s, 6 meme templates, 6 stickers, 4 sound effects, 8 captured pages, 5 subject cutouts against v5's 3, 0, 0, 0, 0. **Inso overrides the persona:** the topic persona's 1.4% meme reading steered v5 off memes. **Understood first:** pick three facts and land each with a scene before joking. **The narrator never invents personal facts.** **Draw the money loop (circle jerk) when companies are investor, customer and seller at once.** The redo is made on the Video space tools (brief: `productions/anthropic-ipo-v6/brief.md`). |
| Worst week in security r1 (11-05), the bed | "fucking horrible" (a `motion_score` ABC score on CC0 samples, 95.7 BPM D minor) | **Never ship a `motion_score` render as a bed.** A bed passing `no-hr-music` is not a bed Inso likes; a bed clears only from `DD/music.json` `approved` or the library (`music-from-library`, `music-approved-by-inso`). No model here can listen, so his ear is the gate: since 2026-11-07 the Filmmaker makes each film's bed and he judges it in the render. |

## Rules (all in `DD/taste.json` as G11)
`DD/taste.json` is the one list: every rule with its id, its text and whether code (`framework/g11.py`) or the judge checks it, and `filmmaker-core` restates the gates in one paragraph. The lessons above are where each rule came from. Two that are easy to forget because a gate cannot fully see them:
- Music: the bed rule is in stages.md §Delivery and the G8 row of SKILL.md. The `no-hr-music` proxy passed the bed Inso called "fucking horrible" and failed both roast beds he praised, so his ear, not the proxy, is the measure.
- A meme is the audience's reaction at that moment, uses the template's canonical clip, and lands a setup a viewer can name; a picture depicts its fact. These are judged and still advisory (the judge is uncalibrated), so before showing Inso, write for every meme and every photo one sentence: "the viewer feels X because the line just said Y", and cut any you cannot write.

## Openings
- The thesis joke carrying the title nouns lands by 5 s. A real moment (a clip, a news read, a post) comes within 20 s. The promise is confirmed by 10 s.
- Never spend the first minute explaining the form (what an S-1 is). Put the form inside a joke, or later.

## Memes
- The written line sets the meme up, and the meme is the punch. The topic audience rarely laughs at memes dropped in as decoration (1.4% of their jokes) but does laugh at the subject's own words and numbers played straight. So a meme must land a fact, not decorate one.
- Choose by what the line needs, then measure the clip's whole sentence. Never choose by the library's `payoff.line`.
- Mix the modes: `fullscreen`, `cutout`, `spotlight` (on the named thing), `slot` (in the new row or cell), `ghost` (for a menacing beat).

## Notes from Inso
His notes are symptoms of a flow problem, not a to-do list. Never patch a note literally (for example, adding sound under a silent post). Find the cause in the stage that owns it, check every other instance, and redo from there.

## Reporting to Inso
- Measured proof only, with its limits stated. Say "the framework predicts", never "it passes". No excuses.
- He is suspicious of shortcuts: say plainly what was not checked.
