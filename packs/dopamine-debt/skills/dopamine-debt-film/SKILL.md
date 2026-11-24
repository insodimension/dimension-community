---
name: dopamine-debt-film
description: "Guidance for a deadpan, meme-led comedy explainer film in the Dopamine Debt style: spine, joke map, script, memes, pictures, voice, cut, the person's review, and an optional score from the gate. Also turns their notes on a render into fixes. Triggers: 'make the film', 'redo the film', 'apply the framework', 'dopamine debt', 'debt curve', 'where do the memes go', 'place the memes', 'my notes on the render', 'calibrate the framework'."
---

# Dopamine Debt film guide

This skill turns `DD/FRAMEWORK.md` into guidance for making a film: what each stage is for, what tends to work, and the files the kit reads. **It is guidance, not a checklist.** Use the stages that help this film, in the order that suits it; nothing waits on a gate. The output is a 1080p render in front of the person as early as it plays end to end, and a few lines on what you chose and did not check. **The person decides**; their notes are the review.

End a film with a short gotcha note (see [Self-Improvement Protocol](#self-improvement-protocol)).

Roots: `DD/` is the installed kit, the folder `inso dd root` prints (the engine `dd/`, `framework/` and its film kit, the shipped channel persona, `taste.json`, `tunables.json`). It is replaced on every update: never write into it. `BRAND/` is the brand's `productions/dopamine-debt/` (`dd.home.brand_dir(<production>)`), where everything you make for the framework lives: the films (`BRAND/films/<f>/<rev>/`), research, the brand's own personas (`BRAND/personas/channel/`, `BRAND/personas/topic/`), the music ledger (`BRAND/music.json`) and the review marks (`BRAND/calibration/marks.jsonl`). The house gate and the editor's `script_gate` both resolve a revision there from the production folder. `dd/home.py` resolves the engine home (media library, tools); `DD_ENGINE_HOME` and `DD_FILMS_ROOT` override them for a test home. A film's own production folder holds its build (`build/`, written by `inso dd new-film <production>`) and its media.

**The gate is an optional score.** `inso dd gate <script|cut> <production folder> <report.json>` measures and never calls a model. It exits 0 (pass), 1 (fail, findings in the report) or 2 (cannot run, `missing` in the report); `script_gate` runs it as the brand's house gate. Voice, generation and render never wait for it. Run it at most once on the script and once on the cut, when a number helps, and report what it found as advice; never loop on it or rerun the Review for a small edit. A production names its revision in `dopamine-debt.json`: `{"revision": "<film>/<rev>", "audiences": {"<audience>": "personas/...md"}}`; a relative persona path is read from `BRAND/` when the file is there, else from `DD/`. The cut stage scores what is in the cut (edl.json speech clips, their transcripts and the memes placed), never script.md.

## Review (only when you run the gate): the session answers the reads

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

`juror_model` is the model `juror_role` resolves to in this session (`models op:profiles` shows the active profile). Juror answers are cached under it, and the gate's report names it in `answered_by`. A Review is hundreds of model calls and several minutes: run it when you want the score, not after every edit.

---

## Before you start

- Skim [references/gotchas.md](references/gotchas.md) and [references/craft.md](references/craft.md) for what the person approved and rejected before, and the brand's marks ledger for their last notes.
- `DD/FRAMEWORK.md` §3, §4, §7 and [references/framework-map.md](references/framework-map.md) explain the debt curve and the moves, when you want the why.
- Personas: the channel persona (`BRAND/personas/channel/*.md`, else `DD/personas/channel/ai-news.md`) and the film's topic persona (`BRAND/personas/topic/<topic>.md`). A stale one is still a useful guide; refresh it only when the topic moved.
- Tools the kit uses: Python 3.10+ with `DD/requirements.txt`, `ffmpeg`, `faster-whisper` (through `DD/framework/quiet.py`), a headless Chrome or Edge, `npx hyperframes`. Find a missing one when a step needs it, not by smoke-testing everything first.

## Modes

| Mode | When | Output |
|---|---|---|
| **Film** | make or remake a film | `films/<f>/<rev>/`: spine, script, `lines.json`, voice, the kit build, render |
| **Notes** | the person watched a render and commented | each note fixed in the film, in one render; a lesson worth keeping goes in the brand's notes |
| **Calibrate** | only when the person asks to tune the framework | `BRAND/calibration/targets|failures/<film>/` read by the same pipeline, plus §11 proposals |

---

## Mode: Film

Work in a fresh revision directory `films/<f>/<rev>/`. Reuse the **root** (personas, verified facts, the media library). Recipes and file schemas: [references/stages.md](references/stages.md). The items below say what each stage aims for, and "Exit" says what good looks like; none of them blocks the next stage, and you need not tick or log them.

### Stage 1: Packaging and spine (G1)
- [ ] **F-1. Packaging.** Write the title (it holds the title nouns), the thumbnail, `promise_q`, `confirmed_by_s: 10` and `answered_in: last-25%`. Exit: the title nouns are listed.
- [ ] **F-2. Spine (`spine.yaml`, frozen before the script).** Fill in premise ("[subject] says A but does B"), a falsifiable take, a narrator `{stance, flaw, never}`, voice_mode, anchor_world `{analogy, maps, breaks_at, extensions, lines}` (`lines`: the script lines that act the analogy out; each gets a motion-graphic scene, G11 `analogy-in-motion`), money_object, retell R1–R3, acts (each with `turn: but|therefore`, a rising `stake_rung`, loops and a button seed) and callbacks (each plant is itself funny and comes at least min(60 s, 30% of the film's runtime) before its first trigger). Exit: every field is present.
- [ ] **F-3. Intent (`intent.json`).** Write 3 retell facts, each resolving to a verified fact id, plus support facts and the ending feeling. Exit: every id resolves in the film's `sources_verified.json`.
- [ ] **F-4. Cold open plan.** Within 5 s, a thesis joke carrying the title nouns. A **real moment** (a clip of the subject, a news read, a real post) inside the first 20 s. The promise is confirmed by 10 s. No "This is X" opener. Exit: the first 20 s are written beat by beat.

### Stage 2: Joke map and script (G2–G10)
- [ ] **F-5. Joke map.** One row per bit: setup, punch (22 words or fewer, punch word last), mechanism, target, carries, `gag_id`, hold, plants/calls, build_id, opens/pays. **A meme is written as the punch of its bit**: the narration sets it up and the meme lands it, about the same fact. A meme never lands on a fact with no setup. Exit: every meme row names the line it punches.
- [ ] **F-6. Script.** Deadpan. One joke aimed at the narrator in every act. Filing mechanics get a move (Bake in, Carry or Pay; §7.3) before they get a meme. Exit: `script/lines.json` and `script/script.md` are written, and every fact id resolves.
- [ ] **F-7. Script read.** Read the script aloud at about **2.7 words/s** (a measured narration pace; measure your own voice once) for length and laugh spacing. When you want the framework's score, build `framework/script/` (`scriptstage.write_engine_dir`), run the Review and `dd.gate.check(..., g11={})` once, and `dd.gate.write(film_dir, res)`; it is advice. Exit: the script reads at the target length with a laugh every 10–15 s.
- [ ] **F-8. One repair pass, by structure.** Fix what the read (or the score, if you ran it) shows: move, cut, re-anchor, add a laugh inside a long bit. Add laughs, never remove them to move a number; never cut a meme for a juror's opinion. One pass, then voice it.

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
- [ ] **F-12a. Price the spend.** Price the voice, music and effects with `generation_quote` and write the total in the film's notes. Nothing waits on `script_gate`; run it only if you want its score.
- [ ] **F-12. Voice.** `generation_submit` with model `elevenlabs/voice` and `options` `{production, voiceId, modelId}`: the brand's voice, the same pair on every job of the film. `kit.voice.brand_voice(FILM)` reads it from the brand kit's `<brand>/brand/voice.json` `{voiceId, modelId}`, else the Settings default voice (Media generation, which names no model: pick one modelId and keep it), else says where to declare it: then `ask` the person which voice is theirs and write it into the brand kit. Never change the voice model to fit time: another model makes a cloned voice sound like someone else; fix length in the script.
  - Record each job with `kit.voice.record_job(FILM, seg, job_id, text, options, dir)` (`voice/jobs.json`). G11 `brand-voice` flags a take off the brand's pair, naming it, and a cut that mixes pairs.
  - The tool returns `audio.mp3` with word timings and takes no endpoint, format or pronunciation option: apply the film's pronounce map (`Film.spoken_forms`) in the text.
  - One act per job, at most 2 at a time. Never time-stretch. Say which licence the voice audio is under.
  - Exit: every act has audio plus word timings in `voice/`, and its job in `voice/jobs.json` on the brand's pair.

### Stage 5: Build, read, review
- [ ] **F-13. Build, render and look with the kit.** Follow the `kit-film` skill: `inso dd new-film`, scenes as code, timeline (narration cut only in silence), compose, G11 as a checklist, render, one fresh read of the frames. The bed: stages.md §Delivery. Exit: a render that plays end to end.
- [ ] **F-14. Self-check before the person sees it.** Transcribe each meme window in the render: the whole line must play. Look at a frame of each meme and of every picture change. Read every advisory G11 judge finding yourself. The bed is registered as G8 says. Exit: a table with time, meme, what plays, and its "viewer feels X because Y" sentence; any you could not write is cut before the person sees it.
- [ ] **F-15. Show the person.** Show the render as soon as it plays end to end, then a few lines: what you chose, any score as advice ("the framework predicts"), the music licence, and what was not checked.
- [ ] **F-16. Gotcha review.** Exit: entries appended (see the protocol).

---

## Mode: Notes

A note is the person's review: fix exactly what it asks, in the film, and batch the notes into one render. When a note hints at a deeper flow problem (craft.md §Notes), fix it at its cause in the line, picture or meme it belongs to.

- [ ] **N-1. Locate.** Map each note's timestamp to its line, picture or meme in the cut.
- [ ] **N-2. Fix.** Change only what the notes ask; re-voice only lines whose words changed; one render for the batch.
- [ ] **N-3. Keep the lesson.** A lesson worth keeping is one line in the brand's notes (`BRAND/gotchas.md`), and a taste call may go in `BRAND/calibration/marks.jsonl`. Do not write new framework rules or sweep other films during a film.

## Mode: Calibrate

- [ ] **C-1.** Read the film through the same pipeline into `BRAND/calibration/targets/<film>/` (approved) or `failures/<film>/` (rejected), with TEXT and SEEN reads. Exit: ledgers and gates exist.
- [ ] **C-2.** Compare the prediction with the person's verdict. If people laughed and the judge didn't: re-read with picture and sound, then extend the reference bank. If the judge laughed and people didn't: the line becomes a cringe hard negative. Exit: each disagreement is listed.
- [ ] **C-3.** Write a §11 proposal `{target, before, after, evidence, golden_delta}`. **Never apply it without the person's yes.** Exit: the proposal file exists, and the person has been asked.

---

## Before you show (a quick self-check, not a gate)

- Each meme plays its whole line, setup included, cut on silence.
- Every fact on screen or in the voice comes from a source you read; quotes are verbatim.
- 1080p to the person; sources 720p or better.
- The bed sits under the voice and ducks under memes, by ear in the render.

Anything you did not check goes in the report as not checked. The person decides.

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
| The juror reads every meme as cringe | It read a text description → judge the meme in the render by eye; the juror's view is advice |
| A score passes and the person rejects | Scores are hints, not verdicts → Notes mode: fix what the person said |
| "One still for too long", "just stamping names", "blank screen" | F-9 show-dont-tell / no-blank-stage: split the line into pictures on its words, act the fact out in a scene, receipts 3–4 s |
| "This meme doesn't fit / not the right one" | F-10: the audience's feeling, the canonical clip, a named setup; label it in the marks ledger |
| `dd.gate` says `incomplete` | Reads or records are missing → it is only a score: report it as not run and carry on, or run the Review once if you want the number |
| "Almost no memes and jokes" | Repairs removed laughs and nothing put them back → G13 (every cast meme reaches the cut or is replaced from the library) and G12 at the SEEN read; never cut a meme for an advisory G3m veto (F-8, F-10, kit-film K-9) |
| The person hates the music | A bed shipped that nobody made for the film or listened to → G8: make the film's own bed, register it in the brand's music ledger as made for this film, and record their verdict by ear there (`rejected` with what they said) |
| The gate exits 2 saying reads are unanswered | The script or cut changed since the last Review → the score is stale; that is fine, the film does not wait for it |
| A read is labelled with a model you did not choose | `answered_by` in the report lists every model that answered. A juror answer is cached under the `juror_model` the Review stated, a readout under `tunables.judge_model` |

---

## Related

- `DD/FRAMEWORK.md`: the framework itself (v2.1). This skill is guidance drawn from it.
- `filmmaker-core`: the short order of work and the house rules.
- `kit-film`: building, rendering and reading the film (F-13).
- `hyperframes-*` skills: composition and animation detail for the kit's page.
- `media-use`: capture and sourcing helpers.
