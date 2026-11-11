# Stage recipes: files, schemas, commands

`DD` = the installed kit (`inso dd root`); `BRAND` = the brand's `productions/dopamine-debt/` (`dd.home.brand_dir(<production>)`). A revision lives in `BRAND/films/<f>/<rev>/`; the film's own production folder holds its kit build (`build/`), media, voice and renders.

## Layout of a revision
```
<rev>/
  WORKLOG.md                 checklist ticks with Exit outcomes (this skill)
  spine.yaml  intent.json    stage 1
  script/lines.json          joke map and script, one row per line (schema below)
  script/script.md           readable script, generated from lines.json
  script/build.py            lines.json + spine.yaml → framework/<stage>/{root,segments,intent,spine}.json (helpers in DD/framework/scriptstage.py)
  framework/script/          engine directory for the script read
  framework/seen/            engine directory for the SEEN read of the render (kit `seen.write`)
                             the build, voice and renders live in the film's production folder (kit-film)
```

## Engine directory (`framework/<stage>/`)
- `root.json`: `{"audiences": {"<channel>": "<path to the channel persona>", "<topic>": "<path to the topic persona>"}, "juror_model": "<provider/model the juror role resolved to>", "juror_role": "smol|default|slow", "stage": "<film> <stage>", "kind": "script|storyboard|cut|seen", "previous": "<path to the previous stage dir, relative to this one>" | null, "gated": [...]}`. Give the persona paths absolute (`dd.home.audience_file(<path>, <production>)` resolves a relative one from `BRAND`, else `DD`). `scriptstage.write_engine_dir(out, segs, intent, spine, audiences, label, kind, previous, juror_model, juror_role)` writes it; both juror fields are required, and a root without them is refused before any model is called. `juror_model` is part of every juror cache key, `juror_role` is the tier `completion()` is called with. `kind: "seen"` turns on G12 and the whole-cut juror read; `previous` feeds G13; an ablation or what-if copy is `kind: "cut"`, `previous: null`, so it is never gated as a stage.
- `segments.json`, `intent.json`, `spine.json`: written by the revision's `script/build.py`.
- After a read: `cache.jsonl`, `jury-cache.jsonl` (bit jurors, plus `kind: watch` whole-cut reads at kind `seen`), `readouts.jsonl`, `jury.jsonl`. `dd.gate.check` writes nothing; end every stage with `dd.gate.write(film_dir, res)`, which writes `gates.json` (status, blockers, gates, score and `memes`: one row per meme or clip with gag, library, mode, display, replaces, t, bit, laugh + ½ smile) and `ledger.<aud>.json`. The next stage's G13 reads exactly those two files. `page.html` and `report.md` come from the revision's own driver, and `repairs.md` is written by hand.

## Commands
The house gate (no kernel, no model): `inso dd gate <script|cut> <production> <report.json>`; exit 0/1/2 as SKILL.md says, and the report's `answered_by` lists the models that answered the reads. The reads are answered from the session with the Review, which builds the engine directory for a production and fills the caches:
```python
import dd.house
await dd.house.review("script", production, judge_batch, completion, juror_model="provider/model", juror_role="default")
```
Inside a driver of your own, in Python with `DD` on `sys.path`:
```python
import dd.read, dd.gate
res = await dd.read.read(film_dir, judge_batch, completion)
g = dd.gate.check(film_dir, film, g11)
```
- `film` comes from `dd.read.load_film(film_dir)`. At the script and storyboard stages, pass `g11={}` and report G11 as not yet checked.
- `dd.gate.blockers(g)` prints the refusal list.
- Script stage timing: `dd.units.estimate_timing(segments, wps)`. `tunables.wps` is 3.3, but a measured narration voice speaks about 2.7 words/s. Time the engine directory at your voice's measured pace, not 3.3: G2 (5 s, 10 s) and G7 (20 s gaps) are timing gates, and at 3.3 every bit reads about 18% shorter than the voice will make it (`script/build.py` `VOICE_WPS`).
- Shared stage helpers: `DD/framework/scriptstage.py` (`on_screen`, `unspoken`, `picture_text`, `MODE_TEXT`, `write_engine_dir`), imported by each revision's `script/build.py` and by the house gate.
- The carries read (`dd/run.py`) sends the line plus the segment's `picture`. At the script stage there is no picture, so a retell fact counts only if the narration says it; from the storyboard stage on, a picture that prints the fact (the money object) carries it too. This is the lever for a G9 restatement the juror rejects as a list.
- The fitted juror map (`tunables.juror_cringe_map`) jumps from 0.176 at a reading of 0.35 to 0.818 at 0.40. A bit the juror reads at exactly 0.40 is both a veto (G3 for a written bit, advisory G3m for a meme bit) and a cost of 4 × 0.818 = 3.27 debt; at the end of the film that one bit can also fail G10. Expect blockers to flip on 0.05 of juror noise there.
- The whole-cut watch juror (G12 keep watching) is noisy per prompt, not only per draw: the transcript carries every unit's start time, so any timing change re-draws all reads. Moving one meme by 1.4 s has moved a 24-draw mean from 0.438 to 0.401, and a set that passed on its first 6 draws (0.475) read 0.455 over 24. Before claiming a keep-watching pass near the line, draw at least 24 (`dd.run.WATCH_DRAWS`, extra keys per draw) on the final timing and report both means.
- Curve page: `dd.page.render(path, title, film, ledgers, per, fg, sc, frames=..., notes=...)`.

## lines.json row
`{id, act, speaker: narrator|clip, kind: voice|clip, text, bit, role: setup|punch|tag, mechanism, target, carries[R ids], sources[S/C/N/P ids], coverage[C ids], pictures[{k: DOC|MONEY|BROLL|POST|NEWS|GFX, what}], plants|calls|opens|pays, meme?}`
`meme = {library, franchise, mode: fullscreen|cutout|spotlight|slot|ghost, anchor, why, in, out, dur, edge_db[in, out], line, whisper_heard, line_source, replaces?}`

That is the script-stage row. A film built with the shared builder, `DD/framework/kit/`, reads a production `script/lines.json` whose picture kinds (`MG`, `DOC`, `BROLL`, `POST`, `CUT`, `TAG`, `STK`, `SFX`, `MEME`, `CLIP`), `from`/`until` word cues and MEME fields are specified in `DD/framework/kit/README.md` (`lines.json` contract), with the voice, clip, capture and music records it also reads.

Segment fields for memes: `library` and `gag_id` (both the media-library entry id), `mode` (what the builder drew), `replaces` (the gag id of the previous stage's meme this one takes the place of; G13), and at the SEEN read `display: full|cutout|ghost|inset`, written from the frames, never copied from `mode` (a meme built as `cutout` can render as a small boxed window).

- Face box: a picture entry may carry `face: {x, y, w, h}`, given as fractions 0–1 of the frame with the origin at the top left, measured on the payoff frame. Use it to centre a spotlight disc, crop a slot or anchor a ghost on the face. Sounds and faceless B-roll have no face box.
- `library_tag` can correct an entry's `payoffLine` and its `inSeconds`/`outSeconds`; the payoff second stays fixed. When F-10 measures a clip's whole spoken line, write that line and its silence-snapped in/out back with `library_tag`, so the library holds the full line and the next film starts from it.

## Sources
- Verified facts: `<film>/<rev>/build/sources_verified.json`, holding `sources` (S, filing grep with file and line), `calcs` (C), `news` (N, said as "reports say"), `posts` (P, with uid and full_text). Reuse a sibling revision's verified file only when the filing hasn't changed.
- A capture needs its source URL **and its capture date** for G11 `real-sources`. The post date alone doesn't count. When a post was read from a research evidence file, stamp `captured` with that file's fetch time and record the file as `capture_record`.
- Check the direction of every comparison you joke about against its numbers. A line that calls a sale "great timing" when investors paid twice as much a month later reads backwards, and the topic juror catches it.
- Captures (`capture.mjs`): some pages re-render on hydration and remove the marks (`firstMarkRect` null, "reading 'bottom'"); SEC EDGAR filings set `content-visibility:auto` on every page (blank screenshot, CDP timeout on a large filing). Capture the page's own HTML rendered locally through `overrides.json` `urls: [file:///…]`: for a Next.js page, the fetched HTML with every `<script>` stripped and `<base href>` set; for an EDGAR filing, only the `height:792pt` page div that holds the quote, with `content-visibility:auto` removed. `sourceUrl` stays the live page.
- Receipt size is width-bound: the card scales to the page's line length, so a desktop capture of a long-line page gives small text. Capture at a narrow viewport (`capture.mjs` `zoom` 2.3 → ~700 CSS px, `noZoomOut`) and hide side panels with a `css` visibility override; the page's own mobile layout gives short lines and big text. EDGAR filings cannot reflow (absolutely positioned lines): their receipts stay small, say so. Give each DOC a `read` band of the highlight plus one whole line each side until `read_geometry`'s context tolerance is fixed.

## Memes
- Library: `<engine home>/media-library/<id>/entry.json` (`file`, `payoff{line, t}`, `inSeconds`, `outSeconds`, `durationSeconds`, credit and franchise). `payoff.line` is often one word, so never treat it as the meme's line. `dd.read.load_film` resolves each segment's `library` against it (`film["library"]`); an id that starts `fetch-` or has no `entry.json` is not a library meme for G3m, G12 or a G13 replacement.
- `DD/framework/quiet.py`:
  - `speech(src, a, b)` returns `[word, start, end]` triples (faster-whisper, cached under the engine home's `productions/dopamine-debt/`);
  - `clip_edges(src, a0, z0)` snaps a span to silence;
  - `point(src, lo, hi, prefer)` finds the quietest cut point;
  - `_frames(src, a, b)` gives 10 ms dB frames;
  - `CLEAN_DB` is −18 dB below the body.
- Library media files are cut tight to the line, so a clip's in edge is at 0.0 s and usually not silent: most measured entries sit only 1 to 15 dB under the body at their edges, against `CLEAN_DB`. G11 `meme-whole-line` fails such a clip. Fetch the longer source from `entry.source.url` (`framework/media_fetch.download`; yt-dlp is found on PATH or in the engine's tools folder by `framework/tools`) and cut it with `clip_edges` there.
- faster-whisper mishears some lines ("I am the cynic" for "I am the Senate!" passes the 60% line match in `meme-whole-line`; a line heard 3 of 6 tokens fails, so the rule reads unknown). Check `whisper_heard` against the payoff line before choosing a clip.
- Movie memes ripped from clip-channel uploads are often 2.39:1 letterboxed inside 16:9 with a watermark in the bottom bar. Measure the picture rows (median luma > 18 over three frames; `cropdetect` is fooled by the watermark). The library carries the frame as `picture: {x, y, w, h}` in fractions of the frame; where it lacks one, record `picture: [x, y, w, h]` in source pixels and `picture_basis` on the film's MEME row, which overrides the library. The kit clips a fullscreen play to that rect over a matte of its own (`clip-path: inset(...)` plus a dark layer, `DD/framework/kit/compose.letterbox_inset`), so the scene underneath never shows through the bars; a cover crop to 16:9 would cut 25% of the width, faces included. The overlay modes (spotlight, slot, cutout, ghost) do not read `picture`.
- A creator clip that holds a silent beat of 1 s or more fails G11 `no-dead-air`. Measure the beat in the source (100 ms RMS) and record `cuts: [[a, b]]` in the clip's record: source ranges a jump cut drops, inside the quiet, leaving about 0.5 s of the beat. The kit emits one clip item per piece; a fullscreen piece opens with a 1.06→1 punch-in, which hides the cut (`DD/framework/kit/timeline.clip_record`).
- Overlay modes: `DD/framework/overlays.py` (size, mask, opacity, placement, motion). Spotlight discs clamp at `SPOT_Y_RANGE`; keep anchors out of the 10% band.

## Voice
- `generation_submit`, model `elevenlabs/voice`, options `{production, voiceId, modelId}` (also `stability`, `similarity`, `speed`): the brand's voice, one pair on every act. The brand kit declares it in `<brand>/brand/voice.json` as `{"voiceId": ..., "modelId": ...}`; `kit.voice.brand_voice(FILM)` returns that pair, else the Settings default voice (Media generation names a voice and no model: pass its voiceId with one modelId and keep that model for the whole film), else nothing and says where to declare it: then `ask` the person which voice is theirs and write it into the brand kit. Never invent a voice id or carry one over from another brand. The tool has no endpoint, output-format or pronunciation option: it always uses the timestamps endpoint and returns `audio.mp3` plus `timing.json` (`words[{text, startSeconds, endSeconds}]`), so apply the film's pronounce map in the text you send. Submit one act per job, with at most 2 running at once. Poll `generation_status`.
- Record each job with `kit.voice.record_job(FILM, seg, job_id, text, options, dir)`: `voice/jobs.json` keeps `{jobId, text, options, dir}` per take. G11 `brand-voice` fails a take on another voice or model than the brand's, naming it, and a cut whose takes use more than one pair; it stays unchecked, so the cut blocks, when a played take has no recorded pair or there is no brand voice and no Settings default (`build/g11.json` `why` says which).
- Never time-stretch the voice, and never change the voice model to fit time: another model makes a cloned voice sound like someone else. A take that runs long is trimmed by structure in a new revision. Say which licence the voice audio is under.
- A cloned voice can read long sentences at 2.5 to 2.9 words/s but short lines built on commas and full stops at about 1.8 to 2.0, and may ignore `speed`. Time a short script for those pauses. A real voice slower than the script read's pace stretches the SEEN cut, and G13 compares laughs per minute, so the same laughs read lower: report it to the person, the pace is their calibration call.
- Spend guard: every `generation_submit` into the production is refused until the Video editor's `script_gate` passes, read from that production's own `receipts/script-gate.json`.
  - Once per brand: `inso dd setup <brand folder>` writes `<brand>/productions/house-gates.json` (the gate runs as `inso dd gate`, so an update of the kit keeps it working), keeping any production's `exclude`. Any change to that file makes the gate stale.
  - Once per production: `dopamine-debt.json` in its folder with `"revision": "<film>/<rev>"` (resolved under `<brand>/productions/dopamine-debt/films/`: the folder the editor's `script_gate` hashes, the house gate reads and `inso dd new-film`'s `film.py` builds from; `DD_FILMS_ROOT` overrides all three) and the `audiences`.
  - Then SKILL F-12a (`script_gate`, follow it with `job_status`) and F-12b (`generation_quote`). Any later edit to lines.json, spine.yaml or intent.json makes the gate stale; run F-12a again before the next spend.

## Render
- One heavy render at a time. A full render takes about 18 minutes, and the hub flags it as stalled at 10 minutes, so keep waiting.
- G11 build checks: `DD/framework/g11.py` is the one implementation (`code_checks(plan)`, advisory `judge_checks(states, completion)`, `calibrate(completion, marks)`). A kit film gets its adapter from `DD/framework/kit/g11plan.py` (`plan(film)`, `checked(film)`, `judged(film, completion)`): `kit/compose.py` writes `layout.json` (boxes, labels, picture changes, pictures, scene reveals) at compose time, and `measure_page` reads the page's text in headless Chrome or Edge (`framework/layout.py`).
- A first film may have no `media/sourcing/posts.json` and no `build/cache/`; the kit needs neither (`g11plan.plan`, `layout.measure`). G11's `labels`, `boxes` and `sources` are `None` when not measured and a list when measured, so a film with no receipts, posts or labels passes `safe-corners`, `real-sources` and `no-lower-thirds` instead of reading unchecked.
- The G11 adapter's code half needs faster-whisper (silero VAD for `music-no-vocals`); a kernel without it runs only the judge half: `g11.judge_checks(g11plan.judge_states(film), completion)`, written with the code fails already in `build/g11.json` (`g11plan.write`), then `g11plan.seen_judged`.

## Delivery
- Mix: voice is the anchor. The bed sits at least 12 LU under the voice under the narration, ducks at least 6 dB and sits at least 18 LU under every meme that plays its own sound (an approved film measured −14.0 LU, −8.4 to −9.7 dB, −22.4 to −23.2 LU). Memes have their own audio. Sound effects stay off narration words. Deliver at −14 LUFS and −1.5 dBTP (`delivery: youtube`). A kit film mixes with `DD/framework/kit/mix.py` at its `Film.levels` (`MixLevels`: voice −19, clips −19, bed −33 LUFS, duck −9 dB, −14 LUFS / −1.5 dBTP by default).
- Music bed: a media-library music entry or a track in the brand's music ledger (`BRAND/music.json`) `approved` (G11 `music-from-library`, `music-approved`, hard). An `approved` entry carries the person's own yes (`yes`, what they said) or, for a bed the Filmmaker made for the film, `approved_by: "made for this film"` and `film: "<production id>"` (it counts for that film only; never a quoted yes they did not give); every entry names its licence, and an unreviewed one goes in the delivery note. `references` are beds they praised, kept for listening; `rejected` holds what they said (`said`). Never ship a `motion_score` render as the bed. The person judges the bed by ear in the render: no connected model accepts audio input, so there is no listening judge.
  - The builder fills each `Plan.music` row with `{id, file, asset, lib, bpm, mode}` and `Plan.stems` with `{voice, music, memes}`: each layer as mixed, on the film clock (`kit.mix.stems`).
  - G11 `music-no-vocals` runs silero VAD on each bed file (instrumentals 0%, a sung track 85%); never use faster-whisper text for it, it hallucinates "see you in the next video" on instrumentals.
- Final checks: decode end to end, frame count, A/V gap under 0.05 s, 1920×1080 at 30 fps.
- Keep every generation's prompt, options and job id in its asset record when the job finishes. The beds of an approved film were later the part the reviewer singled out, and their prompts could not be recovered: the asset records held levels only.

## Cut-stage lessons
- Voice: check the ElevenLabs credits against the characters before a re-voice; a quota run-out mid-act leaves the film at its recorded length.
- Music: a prompt asking for "minor key" can come back major. Measure each bed and rank by the minor-vs-major margin, then write bpm/mode into the Plan's `music` row.
- HyperFrames: set a GSAP-tweened element's initial state with `tl.set`/`fromTo`, never an inline CSS transform (lint flags it). Build ids as uid + a letter separator, never uid + a digit (collisions).
- Cold open: the real voice can push G2 past 5 s. Tighten only measured silent runs (−40 dBFS, ≥ 0.15 s, searched between word midpoints) to 40%; never time-stretch.
- The builder's estimated boxes miss real overflow. Measure band text with `framework/layout.py` and filter text clipped by overflow windows (receipt rows). Size Impact and Courier text from font metrics and clamp it out of the band in the kit.
- A persisting money object (receipt) is a text wall unless it shows only the new lines plus at most one context row.
- `meme-canonical-version` reads the library entry's `canonical` field `{is, basis, by, at}`. A placed meme fails when its entry has no `canonical` or `canonical.is` is false. Fill it from evidence with `library_tag canonical {is, basis}` (basis: the template's Know Your Meme page or its most-viewed upload); the person's switch on the Library page writes `by` and evidence never overwrites it. Never hand-edit the library.
- The media-library face box can mark the wrong person in a two-shot; look at the disc frame before trusting it.
- Re-voice only the acts whose text changed: compare each act's text with the `text` stored in `voice/jobs.json`. ElevenLabs bills about one credit per character sent. `generation_submit` reports cost on its unverified upper-bound basis, not the account's credits. A re-voice of one act moves only that act's rows.
- A storyboard picture that quotes a long filing passage in `what` counts every unspoken quoted word. At 12 or more, the whole unit is charged as a wall (`wall_s`, move RE-TIME PAGE); one such picture has raised a film's debt integral by half. Put on screen the narrated words plus the proof phrase, act the number out, and keep the composition's page text the same as `what`.
- `hyperframes lint` `composition_heavy_overlay_count_high` counts every element with `radial-gradient`, `filter:blur` or `clip-path`, hidden ones included, and the warning means a risk of black frames in the render. Draw repeated icons with borders and child divs instead.
- **SEEN frames.** `kit.seen.frames` samples each unit at its first look and at each picture's settled state, 0.3 s before it ends (`shot_times`). Fixed 20/50/80% frames catch a bar mid-growth, and the juror then vetoes a correct number line as a wrong number.
- **The blind reader is a defect finder.** Ask the fresh reader for a strict list of blank, cramped, cut-off or covered frames as well as the descriptions. `no-clipped-text` and `tag-clear-of-text` measure what it finds on the page's held states. Run the reader again on each new render: a second pass still finds defects.
- **Meme jump cuts.** A meme whose own silent beat runs over 1 s takes `cuts` on its MEME row (source ranges inside that beat, leaving about 0.5 s of it). G11 treats the pieces as one play for whole-line, payoff and franchise. Measure the cut with `quiet._frames`, not Whisper: Whisper's word starts land inside the silence.
- **A voice run is broken only by a laugh between its voice segments.** `dry_voice_run` counts voice up to the last segment of a laughing bit, so a meme after the run's final line doesn't shorten it. Put the meme after the line where the run should break, and give the following lines their own bit only when the meme really punches the line before it.
- **G2 is bounded by the voiced opening line.** First laugh is the end of the first laughing bit. When the opening line alone runs past `thesis_by_s` at the real voice, no picture change and no silence trim can pass it: re-voice a shorter line, or take it to the person.
- **The music bed ducks under quiet meme lines.** At the kit's 9 dB duck a bed can sit under 18 LU below a quiet meme line, against `music-drops-under-memes`; set a deeper duck (`MixLevels(music_duck_db=-11)`). Re-run `mix.stems` after every timeline change, because stale stems give false music fails.
- **Check what a diagram's labels claim against the source's own frame of reference.** When a source's grid has a wall border, the row the narration calls "bottom" is the one above the wall; label the row by the narration and draw the wall as a wall.
