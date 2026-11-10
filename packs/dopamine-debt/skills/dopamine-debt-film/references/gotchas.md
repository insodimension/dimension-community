# Gotchas — dopamine-debt-film skill

The traps real films met, one per entry, each with where its full fix now lives. This file ships with the kit and is replaced on every update; your own log is `gotchas.md` in the brand's `productions/dopamine-debt/` folder (SKILL.md, Self-Improvement Protocol).

---

### Planning to a meme rate replaced the framework
A film planned to "≥ 6 gags/min" never computed the debt curve and was rejected: placement must follow where the negative stretches start. The render needs `dd.gate`. See [framework-map.md](framework-map.md) (Ledger) and SKILL.md Delivery Gate.

### A one-word `payoff.line` made a meme play only its last word
The library entry's payoff line was the payoff word, so the cut started mid-sentence. Take the whole sentence with `quiet.speech` and the edges with `clip_edges`. See [stages.md#memes](stages.md#memes) and SKILL F-10.

### Narration was chopped before memes
Lines cut at the TTS timing boundaries put dozens of line ends on live speech. Cut with `quiet.point` (`DD/framework/quiet.py`), enforced by G11 `narration-cut-in-silence`. See [craft.md](craft.md).

### The juror read text-described memes as cringe
Meme punches scored cringe 0.40–0.55 when the judge saw only "cutout: X says Y". The SEEN read at the cut stage decides memes; storyboard ablations are provisional. See [framework-map.md](framework-map.md) (Memes in the ledger).

### Judge rows answered from a cache
The host's cache can answer retry batches, and `dd.run` can't see the batch model, so §6 "never mix judge versions" can't be verified. Disclose it in the report. See [framework-map.md](framework-map.md) (Readouts).

### A merged bit broke G7
Merging an analogy and its number into one 21 s bit fixed G9 but opened a 21 s laugh gap. Put a laugh inside a long bit instead of trimming words. See SKILL F-8.

### The framework can mispredict an approved film: the juror vetoes memes
The cringe map was fitted on text lines with no memes (0.35 → 0.176, 0.40 → 0.818), and `state.before` drops what clips said, so the juror can veto memes a reviewer loved. Meme bits are advisory G3m. See [framework-map.md](framework-map.md) (G3).

### Juror readings of exactly 0.40 can end a script stage
Two bits at the cliff of the fitted map can be the only blockers left after 3 passes, and a small edit moves them by ±0.05. Stop, restore the best pass, and take both to the person. See [stages.md#commands](stages.md#commands) and SKILL F-8.

### The G9 restatement reads as a machine-written list
A final-20 s line restating all three retell facts reads as "a recap, not a punchline". At the script stage only the narration carries a fact; from the storyboard stage the picture can print the facts. See [stages.md#commands](stages.md#commands).

### Library meme files have no silent edges
Most clips start at 0.0 s on sound, 1 to 15 dB under the body, so G11 `meme-whole-line` fails them. Fetch the longer source and cut it with `clip_edges`. See [stages.md#memes](stages.md#memes).

### The voice tool has no endpoint, format or pronounce option
Apply the pronounce map in the text; the output is always `audio.mp3` + `timing.json`. See [stages.md#voice](stages.md#voice).

### Timing the script read at 3.3 words/s understates G2 and G7
Time the engine directories at the measured voice pace (about 2.7). See [stages.md#commands](stages.md#commands) and SKILL F-7.

### G2's "first laugh" is the 0.2 laugh mark, and `dd.gate.check` writes no files
G2 takes the first bit with laugh + ½ smile ≥ `laugh_cut`; `dd.gate.write` stores the stage record. See [framework-map.md](framework-map.md) (Gates) and [stages.md](stages.md) (Engine directory).

### A joke on a comparison ran backwards
Check each comparison's direction against its numbers; the topic juror catches a backwards one. See [stages.md#sources](stages.md#sources).

### Stills held too long, blank scenes, the wrong memes
A receipt held 8–18 s, scenes sitting on their title, an analogy given one stock photo, a meme voicing the company's joy, a narrator explaining its joke: G11 `show-dont-tell`, `no-blank-stage`, `analogy-in-motion`, `never-explain-the-joke`, `meme-canonical-version`. See [craft.md](craft.md) and SKILL F-9, F-10.

### The judge models miss meme rejections
The tiny `judge_batch` model passed every rejected meme; the slow model caught most but failed every approved one too. The judge rules stay advisory until `g11.calibrate` on the brand's marks ledger says otherwise. See [framework-map.md](framework-map.md) (G11 judge rules).

### Voice word ends lag the audio by up to 0.3 s
Cutting at the "quietest 10 ms between aligned words" lands on the next word's onset. Find the measured pause (frames below −45 dBFS) between the middle of the two words, and clip every word time to its cut. See SKILL F-13.

### `show-dont-tell` passed while the stage still looked empty
G11 counts every cued reveal as a picture change, so a tile waiting for its count word or a stamp alone on black passes. A tile that counts later shows "?"; a shelf goes up with its scene; always run the blind reader before the person sees a cut. See kit-film K-7.

### Hand-edited library entries break the library
Writing fields straight into `entry.json` makes the strict schema refuse them, and a payoff moved by hand leaves the thumbnail and face box on the wrong frame. Correct entries only through `library_tag`. See [stages.md#memes](stages.md#memes).

### A review reel had audio out of sync
`-ss` before `-i`, per-clip `loudnorm` and `concat -c copy` drift by over a second. Cut with `-ss` after `-i`, no per-clip loudnorm, the concat filter (`setsar=1`, `aformat`, `asetpts`), then cross-correlate each clip's audio against its source. Measure sync on anything you show the person.

### Voice quota, major-key "minor" beds, lint transforms, uid collisions; a cold-open laugh pushed late by the real voice; estimated boxes and full receipts; a quoted filing in `what`; re-voice cost; heavy-overlay warnings
See [stages.md](stages.md) (Cut-stage lessons).

### A film passed G5 in band and was still boring and not understood
Copy an approved film's measured surface, land three facts with scenes, and never let a persona's low meme reading steer a film off memes. See [craft.md](craft.md).

### An unfunny film passed while G4 and G5 were advisory
G4 and G5 are hard, fitted on SEEN reads. See [framework-map.md](framework-map.md) (Gates).

### Repairs cut memes to clear a juror veto
Meme bits report as advisory G3m; G3 stays hard for written bits only. See SKILL F-8.

### The memes the script cast drifted away stage by stage
G13 checks each stage against the previous record (`root.json` `previous`, `replaces`, library only), and G12 at the SEEN read counts memes/min and large display time from the frames. See [stages.md](stages.md) (Engine directory) and SKILL F-10.

### A home-made `motion_score` bed shipped because no rule asked where the music came from
Hard G11 `music-from-library` and `music-approved`: a bed passes only when it is on the brand's approved-music list (the brand's music ledger); no connected model hears audio. See [stages.md#delivery](stages.md#delivery).

### SEEN frames at fixed fractions made a correct number read as wrong
`seen.frames` samples settled states. See [stages.md](stages.md) (Cut-stage lessons).

### Cut-off text and labels covering their subject passed G11
G11 `no-clipped-text` and `tag-clear-of-text`, and stage framing inside the window's fade. See [stages.md](stages.md) (Cut-stage lessons).

### G2 cannot pass when the voiced opening line is longer than the limit
Re-voice a shorter line or ask the person. See [stages.md](stages.md) (Cut-stage lessons).

### An unlabelled empty card, a see-through close-up and a sticker on a full-bleed wall passed G11
A deliberately empty card carries its label outside the cross-out, a close-up gets its own opaque, blurred backdrop panel, and a scene whose content fills the stage clears its content under the sticker spot it declares.

### A keep-watching pass on 6 draws was noise
Draw 24 on the final timing before claiming a G12 keep-watching pass. See [stages.md#commands](stages.md#commands).

### A page photo pulled the receipt ring off its card; unspoken calendar labels failed `no-text-walls`
See kit-film, Craft rules.

### Asking the person to pick every bed
Generate the film's beds yourself, register each as made for this film, ask once, then carry on with the default. See kit-film, Craft rules.

### Spend refused until the Video editor's own script gate ran
Set up the brand production once, in order (`inso dd setup`, `dopamine-debt.json`), then one session runs `script_gate`. See [stages.md#voice](stages.md#voice).

### Some pages cannot be captured live
Hydrating pages drop the marks, and EDGAR filings render blank. Capture the page's own HTML rendered locally. See [stages.md#sources](stages.md#sources).

### The repair loop overran its cap
The cap of 3 passes stands; an overrun is reported to the person with the film.

### A receipt crop drops its context lines, so the ring is clipped
`Captures.read_geometry` adds a context line only when the card scale does not drop at all. Give each DOC a `read` band (highlight ± one whole line). See [stages.md#sources](stages.md#sources).

### A meme inside an existing bit does not move its laugh
dd places a bit's laugh at the bit's end (`derive.py` `laugh_t`). The meme and its setup get their own bit. See kit-film, Craft rules.

### An analogy's props reused off its lines
Each line off the analogy shows its own fact in a scene the film already built. See kit-film, Craft rules. Not yet a check on motion-graphic scenes.

### A bed made for one film is approved for that film only
Register it with `approved_by: "made for this film"` and `film: "<production id>"`; G11 counts it for that film only, and a `rejected` sha fails even when it is also approved (`framework/g11.approved_beds`). See [stages.md#delivery](stages.md#delivery).

### Changing the voice model to fit time made a cloned voice sound like someone else
A film shipped on another model to land its opening sooner, and the person heard a stranger. The voice is always the brand's pair (brand kit, else the Settings default), one pair per cut, enforced by G11 `brand-voice`; a long take is trimmed by structure in a new revision. No voice id ships in a rule, a skill or the kit. See [stages.md#voice](stages.md#voice).

### A first film's G11 read "unchecked" for rules it had measured and found clean
`safe-corners`, `real-sources` and `no-lower-thirds` read unchecked on a film with no receipts, posts or labels, and the kit stopped on a missing `posts.json` and `build/cache/`. G11's Plan now tells not-measured (`None`) from measured-empty (`[]`), and both files are optional. See [stages.md#render](stages.md#render).
