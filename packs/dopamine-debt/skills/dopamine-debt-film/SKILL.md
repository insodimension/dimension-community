---
name: dopamine-debt-film
description: "Make a comedy explainer film for the person's channel through the Dopamine Debt framework, from the audience research to an approved render: spine, joke map, script, storyboard, voice, cut, gate, render, the person's review. Also turns their notes on a render into rules or calibration. Triggers: 'make the film', 'redo the film', 'rebuild the film from scratch', 'apply the framework', 'dopamine debt', 'debt curve', 'run the framework on', 'where do the memes go', 'place the memes', 'my notes on the render', 'calibrate the framework'. Self-improving: every run ends with a gotcha review."
---

# Dopamine Debt film workflow

This skill turns `DD/FRAMEWORK.md` into the order of work for making a film. Each stage writes files that the next stage checks, and the engine (`dd/`) reads every stage. A film reaches the person only through `dd/gate.py`, and **the person decides**. The output is a 1080p render, its curve page, the gate table with every advisory failure, and a short list of what was not checked.

This skill is **self-improving**. Every run ends with a gotcha review (see [Self-Improvement Protocol](#self-improvement-protocol)).

> **This skill is a checklist, not a suggestion.** Tick every `[ ]` by writing its status and its Exit outcome in your notes for the film (`films/<f>/WORKLOG.md`) before you move on. Skipping a step without writing down why breaks the skill.

Roots: `DD/` is the installed kit, the folder `inso dd root` prints (the engine `dd/`, `framework/` and its film kit, the shipped channel persona, `taste.json`, `tunables.json`). It is replaced on every update: never write into it. `BRAND/` is the brand's `productions/dopamine-debt/` (`dd.home.brand_dir(<production>)`), where everything you make for the framework lives: the films (`BRAND/films/<f>/<rev>/`), research, the brand's own personas (`BRAND/personas/channel/`, `BRAND/personas/topic/`), the music ledger (`BRAND/music.json`) and the review marks (`BRAND/calibration/marks.jsonl`). The house gate and the editor's `script_gate` both resolve a revision there from the production folder. `dd/home.py` resolves the engine home (media library, tools); `DD_ENGINE_HOME` and `DD_FILMS_ROOT` override them for a test home. A film's own production folder holds its build (`build/`, written by `inso dd new-film <production>`) and its media.

The gate takes no model: it measures and never calls one. It runs from a terminal or as the Video space's house gate: `inso dd gate <script|cut> <production folder> <report.json>`. It exits 0 (pass), 1 (fail, blockers in the report) or 2 (cannot run, `missing` in the report), and the report's `answered_by` names every model that answered the reads. Exit 2 saying reads are unanswered means the reads were never made or the film changed since: run the [Review](#review-the-session-answers-the-reads), then the gate again. A production names its revision in `dopamine-debt.json`: `{"revision": "<film>/<rev>", "audiences": {"<audience>": "personas/...md"}}`; a relative persona path is read from `BRAND/` when the file is there, else from `DD/`. The cut stage scores what is in the cut (edl.json speech clips, their transcripts and the memes placed), never script.md.

## Review: the session answers the reads

The reads are answered by the session that owns the model profile, so the roles the person configured apply and no second program picks a model. From the eval kernel, with `DD` (the folder `inso dd root` prints) on `sys.path`:

```python
import dd.house
await dd.house.review("script", PRODUCTION, judge_batch, completion, juror_model="provider/model", juror_role="default")
```

`"cut"` reviews the cut the same way. The kernel's `judge_batch` and `completion` are the session's own, so the active profile decides who answers:

| Read | Who answers | Role |
|---|---|---|
| Readouts: one per unit, audience and card variant (hundreds per film) | the kernel's `judge_batch` | the person's `judge` role. Never a chat model: it cannot reproduce the judge's calibrated probabilities |
| Bit jurors and the SEEN whole-cut watch (tens to hundreds, stateless, structured) | the kernel's `completion` at `juror_role` | `default`, `slow` or `smol`, resolved from the session's profile; pick a model family other than the judge's (FRAMEWORK §6, the second juror) |
| The blind reader of the frames, a second reviewer of a script or cut | a fresh `task` subagent that never saw the script | the profile's `task` role |

`juror_model` is the model `juror_role` resolves to in this session (`models op:profiles` shows the active profile). Juror answers are cached under it, so switching profile re-reads instead of reusing another model's answers, and the gate's report names it in `answered_by`. If a role fell back to another model during the run, say so in the report. Run the Review again after any edit to `lines.json`, `spine.yaml`, `intent.json`, a persona or the cut: the cache keys the content, so a stale read is a missing read and the gate exits 2.

---

## Pre-flight: ALWAYS

- [ ] **PF-1. Read [references/gotchas.md](references/gotchas.md) and [references/craft.md](references/craft.md).** Exit: you can name the person's last three rejections (from the brand's marks ledger) and what each one taught.
- [ ] **PF-2. Read `DD/FRAMEWORK.md` §3, §4, §7, §8, §10 and [references/framework-map.md](references/framework-map.md).** Exit: you can state the debt formula, θ, τ, the four moves and every hard gate in one line each.
- [ ] **PF-3. Check the personas.** The channel persona (`BRAND/personas/channel/*.md`, else the shipped `DD/personas/channel/ai-news.md`) and the film's topic persona (`BRAND/personas/topic/<topic>.md`) are not past their `expires` date. `DD/taste.json` and `DD/tunables.json` load. Exit: the expiry dates are written down, or a persona is rebuilt by the §1.3 protocol into `BRAND/personas/`.
- [ ] **PF-4. Check the tools.** Python 3.10 or newer with `DD/requirements.txt` installed. The brand's `productions/house-gates.json` exists (`inso dd setup <brand folder>` writes it). `inso dd gate script <production> <report>` runs (exit 2 lists what is missing, and before the first Review it asks for one). `ffmpeg`, `faster-whisper` (through `DD/framework/quiet.py`) and a headless Chrome or Edge (`DD/framework/tools.browser`) all run. `npx hyperframes` responds. Exit: a smoke call to each.
- [ ] **PF-5. Pick the mode.** Exit: Film, Notes or Calibrate is written down.

## Modes

| Mode | When | Output |
|---|---|---|
| **Film** | make or remake a film | `films/<f>/<rev>/`: spine, script, `lines.json`, voice, the kit build, render, page, gates |
| **Notes** | the person watched a render and commented | each note filed as a G11 rule, a calibration mark or a script repair, then a new revision |
| **Calibrate** | a film the person approved or rejected exists | `BRAND/calibration/targets|failures/<film>/` read by the same pipeline, plus §11 proposals |

---

## Mode: Film

Work in a fresh revision directory `films/<f>/<rev>/`. Never patch a rejected revision in place. Reuse only the **root** (personas, verified facts, the media library), never another revision's script or cut. Recipes and file schemas: [references/stages.md](references/stages.md).

### Stage 1: Packaging and spine (G1)
- [ ] **F-1. Packaging.** Write the title (it holds the title nouns), the thumbnail, `promise_q`, `confirmed_by_s: 10` and `answered_in: last-25%`. Exit: the title nouns are listed.
- [ ] **F-2. Spine (`spine.yaml`, frozen before the script).** Fill in premise ("[subject] says A but does B"), a falsifiable take, a narrator `{stance, flaw, never}`, voice_mode, anchor_world `{analogy, maps, breaks_at, extensions, lines}` (`lines`: the script lines that act the analogy out; each gets a motion-graphic scene, G11 `analogy-in-motion`), money_object, retell R1–R3, acts (each with `turn: but|therefore`, a rising `stake_rung`, loops and a button seed) and callbacks (each plant is itself funny and comes at least min(60 s, 30% of the film's runtime) before its first trigger). Exit: every field is present.
- [ ] **F-3. Intent (`intent.json`).** Write 3 retell facts, each resolving to a verified fact id, plus support facts and the ending feeling. Exit: every id resolves in the film's `sources_verified.json`.
- [ ] **F-4. Cold open plan.** Within 5 s, a thesis joke carrying the title nouns. A **real moment** (a clip of the subject, a news read, a real post) inside the first 20 s. The promise is confirmed by 10 s. No "This is X" opener. Exit: the first 20 s are written beat by beat.

### Stage 2: Joke map and script (G2–G10)
- [ ] **F-5. Joke map.** One row per bit: setup, punch (22 words or fewer, punch word last), mechanism, target, carries, `gag_id`, hold, plants/calls, build_id, opens/pays. **A meme is written as the punch of its bit**: the narration sets it up and the meme lands it, about the same fact. A meme never lands on a fact with no setup. Exit: every meme row names the line it punches.
- [ ] **F-6. Script.** Deadpan. One joke aimed at the narrator in every act. Filing mechanics get a move (Bake in, Carry or Pay; §7.3) before they get a meme. Exit: `script/lines.json` and `script/script.md` are written, and every fact id resolves.
- [ ] **F-7. Script read.** Build `framework/script/` with units timed at **2.7 words/s** (a measured narration pace, not `tunables.wps` 3.3: G2 and G7 are timing gates; measure your own voice's pace once and use it) and `root.json` `kind: "script"`, `previous: null` (`scriptstage.write_engine_dir` writes both, and the `juror_model` and `juror_role` the Review states).
  - Run `await dd.read.read(...)` (the Review) and `res = dd.gate.check(..., g11={})`.
  - Store the stage record with `dd.gate.write(film_dir, res)` (`gates.json` with every meme, `ledger.<aud>.json`: the next stage's G13 compares against it) and `page.html` with the revision's report driver.
  - Exit: `gates.json` and `page.html` are written, with 0 missing reads, and the cast of memes is in `gates.json` `memes`.
- [ ] **F-8. Repair loop (at most 3 passes).** Each pass must cut the hard blockers or the debt integral. Log each pass in `repairs.md` with the edit size against the score change, and treat a large jump from a small edit as a red flag.
  - Fix by **structure** (move, cut, re-anchor, add a laugh inside a long bit), never by rewording to please the judge.
  - A juror veto on a meme's bit is **G3m, advisory**: never cut the meme for it; log the juror's reason and its ablation for the person. G3 stays hard for written bits.
  - A pass may not lower laughs/min (G5) or drop a meme without a library replacement: repair by adding laughs, never by removing them (a script that passes by cutting its memes comes back as "almost no jokes").
  - If the passes run out, restore the best pass (fewest blockers, then lowest integral) before stopping.
  - Exit: every hard gate passes, or the stage stops and goes to the person with the blocker and a proposed fix.

### Stage 3: Pictures and memes in `lines.json` (G2–G11 planned)
- [ ] **F-9. Pictures (show, don't tell).** For each beat, choose a picture that **depicts** the fact: the money object, a motion-graphic scene that acts the fact out, the filing page with the spoken sentence highlighted for 3–4 s as proof, b-roll, a real post captured with its source and capture date.
  - Under narration the picture **changes at least every 5 s**; a sticker or a name stamp is not a change. A page holds 3–4 s and then a scene, a meme or the subject's face explains it: split a long line into pictures on its words (`from`/`until`).
  - A scene shows its first element within 1 s (no title-only screen). No riddle metaphors (an animal standing for regulators).
  - Exit: every picture is cued in `lines.json` (`DD/framework/kit/README.md`, `lines.json` contract), and every photo has its one-sentence "depicts" line.
- [ ] **F-10. Memes from the library.** Pick from the media library (`dd.home.LIBRARY/<id>/entry.json`; read-only, corrections go through `library_tag`, the strict schema rejects extra keys). Every meme's `library` and `gag_id` are its entry id; a longer source fetched for an entry's edges keeps that id, and a clip with no entry (`fetch-*`) is not a library meme.
  - **The script's cast is the floor:** every meme the script stage cast reaches the cut, or the meme that takes its place logs `replaces: <gag id>`, comes from the library and reads at least as funny for every audience (G13).
  - A meme is **the audience's reaction at that moment** (read the persona: a "nice" over a company's 80% margin is the company's feeling, not the viewer's), it is the template's **canonical** version (the entry's `canonical.is`; stages.md §Memes), and the line before it sets up exactly what it lands.
  - Transcribe each candidate with `quiet.speech()` and take the **whole spoken sentence, setup included**; a one-word `payoff.line` is not the line. Set in and out with `quiet.clip_edges()` so both edges sit in silence, and fetch the longer source when an edge is above `CLEAN_DB` (stages.md §Memes).
  - At most one per franchise. Mix the modes, play most meme time large (full frame, cutout or ghost: G12 wants ≥ 57%), and place each overlay on the thing the narration names.
  - Exit: every MEME row in `lines.json` has its measured in, out and full line, any `replaces`, and in `meme.why` the sentence "the viewer feels X because the line just said Y".

### Stage 4: Spend and voice
- [ ] **F-12a. Script gate receipt.** Run the Video editor's `script_gate` on the production (its `dopamine-debt.json` names the revision; `inso dd setup <brand folder>` wrote the house gate it runs). Follow a running gate with `job_status`. An exit 2 saying reads are unanswered is the cue to run the Review, then `script_gate` again. Exit: it passed, and its `inputsHash` is written down.
- [ ] **F-12b. Price the spend.** Price the voice, music and effects with `generation_quote` and write the total in the film's notes. Exit: F-12a's script gate passed for the current files and the price is written down. Any later edit to `lines.json`, `spine.yaml` or `intent.json` makes the gate stale: F-12a again before the next spend.
- [ ] **F-12. Voice.** `generation_submit` with model `elevenlabs/voice` and `options` `{production, voiceId, modelId}`: the brand's voice, the same pair on every job of the film. `kit.voice.brand_voice(FILM)` reads it from the brand kit's `<brand>/brand/voice.json` `{voiceId, modelId}`, else the Settings default voice (Media generation, which names no model: pick one modelId and keep it), else says where to declare it: then `ask` the person which voice is theirs and write it into the brand kit. Never change the voice model to fit time: another model makes a cloned voice sound like someone else; fix length in the script.
  - Record each job with `kit.voice.record_job(FILM, seg, job_id, text, options, dir)` (`voice/jobs.json`). G11 `brand-voice` fails a take off the brand's pair, naming it, and a cut that mixes pairs; it stays unchecked, so the cut blocks, while a played take has no recorded pair or there is no brand voice and no Settings default (`build/g11.json` `why` says which).
  - The tool returns `audio.mp3` with word timings and takes no endpoint, format or pronunciation option: apply the film's pronounce map (`Film.spoken_forms`) in the text.
  - One act per job, at most 2 at a time. Never time-stretch. Say which licence the voice audio is under.
  - Exit: every act has audio plus word timings in `voice/`, and its job in `voice/jobs.json` on the brand's pair.

### Stage 5: Build, read, review
- [ ] **F-13. Build, render and read with the kit.** Follow the `kit-film` skill K-1 … K-10: `inso dd new-film`, scenes as code, timeline (narration cut only in silence), compose, G11, render, the blind-reader loop, the SEEN gate. The bed: G8; stages.md §Delivery. Exit: K-9 passes (`dd.gate.write` stored the SEEN record) or its one blocker is with the person.
- [ ] **F-14. Self-check before the person sees it.** Transcribe each meme window in the render: the whole line must play. Look at a frame of each meme and of every picture change. Read every advisory G11 judge finding yourself. The bed is registered as G8 says. Exit: a table with time, meme, what plays, and its "viewer feels X because Y" sentence; any you could not write is cut before the person sees it.
- [ ] **F-15. Show the person.** Show the render, `page.html` (curve, laugh marks, memes, worst three stretches), the gate table **with advisory failures**, the music licence, and what was not checked. Say "the framework predicts", never "it passes, so it's good". Exit: presented, with the limits stated.
- [ ] **F-16. Gotcha review.** Exit: entries appended (see the protocol).

---

## Mode: Notes

The person's note is a symptom of a flow problem, not a to-do item (craft.md §Notes). Never patch a note literally.

- [ ] **N-1. Locate.** Map each note's timestamp to its unit, bit and meme in the cut's `segments.json`. Exit: each note has a unit id.
- [ ] **N-2. Classify.** Each note is one of:
  - (a) a measurable defect, which becomes a G11 rule with its check: write it as a rule of your own in the brand's notes and tell the person it needs a kit change (the kit folder is replaced on update, so never edit `DD/taste.json` or `DD/framework/g11.py` in place);
  - (b) a taste reading, which becomes labelled rows in `BRAND/calibration/marks.jsonl` (`dd.home.marks_file(<production>)`: the note in a few words, its unit, and for judged items the state with `label: rejected`; also add the items they praised as `approved`);
  - (c) a story problem, which goes back to the stage that owns it (spine, script, or the pictures in `lines.json`).
  - One note can be all three. Record every note in the marks ledger either way. Exit: a class for each note, and `g11.calibrate(completion, marks_file(<production>))` re-run.
- [ ] **N-3. Find every other instance.** Run the check over the whole film and every film that has a builder Plan. The check's findings ARE the instance list; a check that misses an instance the person marked is wrong, so fix the check before the film. Exit: the count of instances, where they are, and which are fixed in this revision.
- [ ] **N-4. Redo from the owning stage** in a new revision (Film mode, starting at that stage). Exit: the new revision passes the gate, and F-14 shows the note fixed.

## Mode: Calibrate

- [ ] **C-1.** Read the film through the same pipeline into `BRAND/calibration/targets/<film>/` (approved) or `failures/<film>/` (rejected), with TEXT and SEEN reads. Exit: ledgers and gates exist.
- [ ] **C-2.** Compare the prediction with the person's verdict. If people laughed and the judge didn't: re-read with picture and sound, then extend the reference bank. If the judge laughed and people didn't: the line becomes a cringe hard negative. Exit: each disagreement is listed.
- [ ] **C-3.** Write a §11 proposal `{target, before, after, evidence, golden_delta}`. **Never apply it without the person's yes.** Exit: the proposal file exists, and the person has been asked.

---

## Delivery Gate

Nothing reaches the person until every row is PASS. The kit's K-9 runs `dd.gate.check` (rows G0–G3, G7 and G8); rows G4–G6 are yours.

- [ ] **G0. Fresh ledger.** Every unit of the current cut, at its current state, has its readouts for every gated audience and both card variants, the juror has read every triggered bit, and the whole-cut juror has read the SEEN cut for every persona. A missing read is `incomplete`, never a pass.
- [ ] **G1. Hard G-gates.** Every gate outside `tunables.json` `advisory_gates` (G3m Meme cringe, G5f Fact laughs) holds for every audience. G4 Nobody lost and G5 Laugh rate are hard.
- [ ] **G2. G11 build checks.** `framework/g11.code_checks(plan)` on the current cut: every gate rule in `DD/taste.json` is answered, and an unchecked rule blocks. Advisory judge findings are listed for the person, never hidden.
- [ ] **G3. No bypass.** No flag, no hand-edited `gates.json`, no threshold lowered to pass (§8.1).
- [ ] **G4. Every meme plays its whole line, setup included,** cut on silence (F-10, F-14).
- [ ] **G5. Every fact on screen or in the narration resolves** to a verified source id.
- [ ] **G6. Nothing reaches the person below 1080p.** Every source is 720p or better.
- [ ] **G7. The laughs reached the cut.** G13 Laughs kept passes (every meme the script cast is here or replaced from the library with `replaces`), and G12 Entertainment passes on the SEEN read (landed laughs/min, library memes/min, no long voice run without a laugh, large meme display time, the whole-cut juror's keep-watching). No meme was cut for a juror veto (G3m is advisory).
- [ ] **G8. The bed is approved.** G11 `music-from-library` and `music-approved` pass: every bed's sha256 is in the brand's music ledger (`BRAND/music.json`) `approved`, by the person's own yes (`yes`) or, for a bed you made for this film, as `approved_by: "made for this film"` with `film` (counting for this film only); a rejected bed fails with what they said even if it is also approved. `music-under-voice`, `music-ducks-under-memes`, `music-drops-under-memes` and `music-no-vocals` pass on the kit's stems. No model listens for them: they judge the bed by ear in the render.

---

## Shared Infrastructure

- **Where each framework concept lives in code:** [references/framework-map.md](references/framework-map.md)
- **Stage recipes, file schemas and commands:** [references/stages.md](references/stages.md)
- **Craft: what reviewers approved and rejected, and why:** [references/craft.md](references/craft.md)
- **A worked example, stage by stage, with tools and outputs:** [references/production-recipe.md](references/production-recipe.md)
- **Gotchas log:** [references/gotchas.md](references/gotchas.md)
- **One implementation of each thing:** shared code lives in `DD/dd/` (the engine), `DD/framework/` (quiet, overlays, layout, tools) and `DD/framework/kit/` (the film builder, its stage camera and scene templates). A film's directory holds its data and a thin builder. Code two of your films need goes into a module of your own beside your productions, never into `DD/`.

---

## Self-Improvement Protocol

Every run must end with a gotcha review. New learnings die silently if you don't log them.

**During the run:**
- An undocumented error or dead end: capture the symptom and the resolution word for word.
- An API that didn't behave as documented: note its actual shape.
- A performance, cost or behaviour surprise: note the measurement.
- The person pushed back on your phrasing or method: ALWAYS log it. Pushback is the most valuable source of gotchas.

**At the end of the run:** append a 1–3 line entry to `BRAND/gotchas.md` (the brand's own log, beside its productions; the kit's `references/gotchas.md` is replaced on update). A lesson that needs a kit change is reported to the person as one.

**Gotcha entry format (1–3 lines):**
```markdown
### YYYY-MM-DD — <one-line title>
Symptom → cause → fix.
Context: <what you were doing + film / stage / note>.
```

Use today's absolute date. Never a relative one.

---

## Failure / Recovery

| Symptom | Cause / Fix |
|---|---|
| The viewer is bored in the first minute | No real moment and no written joke in the first 20 s → redo F-4 and F-5 (craft.md §Openings) |
| A meme "is not a meme" | Only the payoff word plays → F-10: whole sentence from `quiet.speech`, edges from `clip_edges` |
| Narration chopped before a meme | Cut on a timing boundary, not on silence → the kit's timeline cuts in the take's measured pause (kit-film K-5), G11 `narration-cut-in-silence` |
| The juror reads every meme as cringe | It read a text description → the SEEN read (kit-film K-9) decides, not the script read |
| A gate passes and the person rejects | The gates are necessary, not sufficient → Notes mode (each note becomes a check or a calibration mark), then Calibrate mode |
| "One still for too long", "just stamping names", "blank screen" | F-9 show-dont-tell / no-blank-stage: split the line into pictures on its words, act the fact out in a scene, receipts 3–4 s |
| "This meme doesn't fit / not the right one" | F-10: the audience's feeling, the canonical clip, a named setup; label it in the marks ledger |
| `dd.gate` says `incomplete` | Missing reads, a missing whole-cut read, an unchecked G11 rule, a `root.json` with no `kind` or `previous`, a previous stage with no `dd.gate.write` record, or a SEEN meme with no `display` → run `dd.read`, write the link or record, implement the check; never pass it by default |
| "Almost no memes and jokes" | Repairs removed laughs and nothing put them back → G13 (every cast meme reaches the cut or is replaced from the library) and G12 at the SEEN read; never cut a meme for an advisory G3m veto (F-8, F-10, kit-film K-9) |
| The person hates the music | A bed shipped that nobody made for the film or listened to → G8: make the film's own bed, register it in the brand's music ledger as made for this film, and record their verdict by ear there (`rejected` with what they said) |
| The gate exits 2 saying reads are unanswered | The script, a persona or the cut changed since the last Review, or none ran: run the Review (the cache keys the content), then the gate |
| A read is labelled with a model you did not choose | `answered_by` in the report lists every model that answered. A juror answer is cached under the `juror_model` the Review stated, a readout under `tunables.judge_model` |

---

## Related

- `DD/FRAMEWORK.md`: the framework itself (v2.1). This skill is its order of work.
- `filmmaker-core`: the short order of work and the house rules.
- `kit-film`: building, rendering and reading the film (F-13).
- `hyperframes-*` skills: composition and animation detail for the kit's page.
- `media-use`: capture and sourcing helpers.
