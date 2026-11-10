---
name: kit-film
description: "Build a Dopamine Debt film with its film kit: every picture cued to a spoken word, motion-graphic scenes written as code from real data, memes with a reason, then render, a frames-only defect read, and fixes at the cause until G11 and the cut gate pass. Use after the dopamine-debt-film skill's script stage passes, for 'build the film', 'make the motion graphics', 'render the film', 'fix what the reader saw'."
---

# Kit film: build, render, read, fix

The `dopamine-debt-film` skill decides WHAT the film says (research, spine, joke map, `lines.json`, the script gate, the spend gate and the voice). This skill BUILDS it. The builder is `DD/framework/kit` (`DD` is the folder `inso dd root` prints; `README.md` there is the contract for `lines.json`, `timeline.json`, `layout.json` and every module); its stage camera and the house scene templates are `DD/framework/kit/stage.py`. The kit's stage is the house look, so a new film starts from `inso dd new-film`, never from a copy of another production's folder.

## The order of work

Tick each in the film's `WORKLOG.md` with its exit result.

- [ ] **K-1. Start the build.** `inso dd new-film <production> [<film>/<rev>]` writes `<production>/build/` (`film.py`, `scenes.py`, `film.css`, `timeline.py`, `compose.py`, `g11.py`, `render.py`, `description.py`); `film.py` finds the kit each time it runs (`DD_ROOT` when set, else `inso dd root`), so an update of the kit never breaks it.
  - Set the `FILM` fields in `film.py`: `revision` (the script's revision folder), `spoken_forms` (how the voice must say acronyms), `music` beds, `persona`.
  - Write `dopamine-debt.json` in the production (`{"revision": "<film>/<rev>", "audiences": {...}}`).
  - Exit: `python timeline.py` runs or names what is missing.
- [ ] **K-2. A picture for every word.** In `lines.json`, every narrator line has `pictures` cued to its own words (`on`, `from`, `until`, `<param>_on`): the counter lands on "thirty-nine", the bars grow on "six", the knob row lights on "numbers". The picture changes at least every 5 s. A line that names a number shows that number; a line that tells an analogy acts it out in a scene. Exit: no line is "voice over a held picture".
- [ ] **K-3. Scenes are code, from real data.** Each MG scene is a template parameterised by its `lines.json` picture. The data is real: the paper's table, the actual numbers, your own count from the source files, with the source in `research/facts.json`.
  - Use the stage's own templates first (`bars`, `counter`, `checklist` in `DD/framework/kit/stage.py`, and the kit's in `kit/scenes.py`); a film's own template goes in `build/scenes.py`, registered with `stage.scene(name, box=...)` and returning html + GSAP js.
  - A new template keeps the shape: word-cued reveals through `stage.cue` / `stage.later` (`Cues.at`), a settled state that holds, `stage.beat_push` so the stage breathes. A template two of your films need goes into a shared module of your own beside your productions; the kit folder is replaced on update.
  - Exit: every number on screen traces to a fact row.
- [ ] **K-4. Memes with a reason.** A meme punches the narrator line before it (a `speaker: "meme"` row). Pick it for a reason the film already set up (a "wait" loop earns a "wait for it" payoff), the canonical clip (`canonical.is` true in the library), its whole spoken line with its own audio, one per franchise, payoff 1.0 to 1.7 s.
  - Measure the clip's silence with `framework/quiet.py` `_frames` (10 ms dB), never Whisper word starts (they fall inside silence); cut a silent beat over 1 s with the MEME row's `cuts`.
  - Add a meme where the gate shows a laugh missing (a dry voice run, laughs/min short), never as decoration.
  - Exit: every meme row has its reason in `meme.why`.
- [ ] **K-5. Build and measure.** `python timeline.py && python compose.py && python g11.py` in `build/`. G11 measures the built page in headless Chrome: text walls, the edge band, cut-off text, labels covering text, blank stage, pace, memes, music. Fix every fail at its cause (the scene, the kit, the cue), never by moving a threshold. Snapshot the changed moments (`npx -y hyperframes@0.8.217 snapshot build/film --at t1,t2 --no-end`, at most 20) and LOOK at each. Exit: every rule passes except `no-dead-air`, which needs the render.
- [ ] **K-6. Render and its proof.** One heavy render at a time. `python render.py` (`kit/render.py`): 1080p30, the mix to −14 LUFS and under −1 dBTP, a decode check, A/V gap under 0.05 s, and `proof/film-X` (contact sheets, Whisper transcript, audio table). Run `mix.stems(FILM)` and `python g11.py ../proof/film-X`. Exit: G11 passes with nothing unchecked.
- [ ] **K-7. The frames-only defect read.** `seen.frames(FILM, <render>, proof/seen-frames-N)` cuts frames where the eye rests. Spawn a FRESH subagent that reads only that folder (never the script) and writes `descriptions.json` (`picture`, and `display` for memes) plus a strict list of frames that are blank, cramped, unreadable, cut off or covered. Look at the frames it names yourself. Exit: you have the defect list and you agree or disagree with each item, with the reason.
- [ ] **K-8. Fix at the cause, then read again.** Fix each real defect where it lives. When a reader finds a defect class G11 missed, add the G11 rule first, then fix. Re-render (K-6) and re-read (K-7) with a NEW reader each time; a good film takes several rounds. Exit: the reader lists only clip-footage limits and motion caught mid-move.
- [ ] **K-9. The SEEN gate.** First `g11plan.seen_judged(FILM, descriptions, completion)`: it judges `analogy-stays-in-its-world` on the reader's descriptions and merges it into `build/g11.json` (a later `python g11.py` drops it again, so run it after the last render's read).
  - Then `seen.write(FILM, descriptions, audiences)`, `await dd.read.read(<rev>/framework/seen, judge_batch, completion)` and `dd.gate.check(dir, film, g11)` with `g11` = `build/g11.json`'s `fails` (every rule G11 checked).
  - Fix failures structurally: a laugh missing is a beat or a meme, a picture the juror reads wrong is a picture fix, a voiced line that cannot pass is the person's call.
  - Exit: `dd.gate.write` and pass, or the one blocker taken to the person with its evidence.
- [ ] **K-10. Show the person the film first.** The render, the YouTube description (`python description.py`), the G11 and gate tables, and what you could not check, in a few lines. The video comes before any process report.

## Craft rules

- Stage: one window inside the frame with a floor grid and a vignette; scenes frame into the window's SAFE area (inside its fade, shrunk for the push). Nothing touches the frame edge.
- Receipts: a captured page shows whole lines only (`read_geometry`, DOC `read: [top, bottom]` for the exact sentence), ringed, at a readable capital height (`Film.receipt_read_px`).
- Tags and stickers sit clear of the text they comment on; a scene declares its sticker spots.
- Every number lands exactly on its word and holds; counters roll, bars grow, rails fill to scale.
- A diagram's labels must match the source's frame of reference (a game grid's wall ring is a wall, so its last row is the floor).
- The voice is cut on word boundaries; the bed ducks under memes enough for the quietest meme line to clear 18 LU.
- Every subprocess is hidden (`creationflags=framework.tools.HIDDEN` in Python, `windowsHide: true` in Bun): a console over the person's screen is a defect.
- The cut gate counts laughs per bit, so a meme added inside an existing bit adds no laugh. Give the setup line and its new meme their own `bit` id to close a G7/G12 laugh gap.
- A scene's wrapper id never reuses `{eid}-in` (the kit's clip wrapper owns it) and SVG defs are never repeated per scene: the page aborts the render on duplicate ids (`K.done`).
- A meme window is the whole spoken line: word-time the library clip (faster-whisper on the decoded PCM) and pin `in`/`out` on the MEME picture when the kit's pick misses the payoff (G11 `meme-whole-line`). A clip with burned-in subtitles is cropped above them with `picture` + `fill`.
- A render needs about 3 GB of temporary frame storage. When the system drive is short, run `render.py` with `TEMP`/`TMP` on a drive with room (a scratch folder, removed afterwards).
- Every word on screen counts against `no-text-walls` unless the voice says it. Weekday headers, month labels on every date and sub-captions under timeline nodes will fail. Keep a label only when the line says it, and draw states as icons (a lock, a tick) instead of words.
- The receipt ring is drawn around the page's highlight colour wherever it appears. A photo above the sentence with gold or yellow in it pulls the ring up and off the card. Recapture the page with that image hidden (`css` override `img{visibility:hidden}`) before you try to fix it with a `read` band.
- A receipt held more than about 4 s fails `show-dont-tell`. Split the line on its words: the receipt `until` a word, then the scene `from` it.
- Show the real subject, never a drawn stand-in. A film about photographs shows real photographs: library thumbnails, store photos, captured renders, fetched by a subagent into `media/` with their source. One drawn stand-in reused across many scenes reads as filler; real pictures under every price tag carry the laughs.
- A kept scene continues, it never rebuilds. When the next line stays on the same scene, the kit no longer re-enters it (`Cues.held` is true). The template must draw what was already up in its settled state and animate only what the new line adds. A scene that comes back later shows a new state the line names; a running gag (the price tag on the same object) is fine because the tag changes each time. G11 `no-scene-replay` reads the render and fails any scene that snaps back to a frame it already showed for 1 s or more: a viewer sees the same frame repeated.
- An analogy's props live only in the world the analogy sets up. Reusing the analogy's props on lines the analogy never covered builds a world the script never set up, and it stops making sense. Off those lines, show the line's own fact in a scene the film already built (the chart, the report page, the cork board) in a new state. G11 `analogy-stays-in-its-world` gates it at K-9.
- A drawn object faces the way its scene moves. A side-view car on a road drawn toward a vanishing point drives across its own road; draw the road side-on too, or the car from behind.
- A punch is a picture joke. On the punch word the picture changes: the tag flips, the stamp lands, the counter overshoots, the grid relabels. A punch voiced over a diagram that does not move is a radio joke and does not land.
- Laugh inside the first 4 s (G11 `first-laugh-by-4s`). The cold open shows the thesis as a gag (a count-up wall, a price tag) and reaches its first meme or punch word before 4 s, and the punch is a picture joke (above), not a line over a held drawing.
- Voice lines are spoken sentences. Headline fragments ("Second sentence:", "Today: what's free, who gets money back, and what they are buying") come out of a voice model as odd lists or rising questions. G11 `statement-not-asked` reads the render's transcript: a statement that Whisper ends with "?" was voiced rising, so rewrite it before you revoice.
- A sticker placed over a card hides the card's own text: G11 `tag-clear-of-text` catches it. Give each card one free edge and put its sticker there.
- The Filmmaker makes the film's music bed after the script gate passes and registers it as `dopamine-debt-film` stages.md §Delivery says (G8).

## Self-improvement

End every film with a gotcha review: a lesson goes into code or notes of your own beside your productions (the kit folder is replaced on update), and into the brand's notes for the next film.
