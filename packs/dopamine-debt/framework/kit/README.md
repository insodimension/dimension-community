# Film kit (`DD/framework/kit`)

The builder every kit film shares: `script/lines.json` and the voice takes become `build/timeline.json`, the timeline becomes a HyperFrames page (`build/film/index.html`) and the layout record G11 reads (`build/layout.json`), then G11 (`build/g11.json`) and the delivery mix. A film's `timeline.py`, `compose.py`, `g11.py` and `render.py` are three-line entry points into it.

A film's own folder holds only its content: its `Film` config, its own scene templates (if any), and `build/film.css`. `inso dd new-film <production> [<film>/<rev>]` writes that folder's `build/` from `new-film/` here: `film.py` (the `Film`, with DD found each time it runs: `DD_ROOT` when set, else `inso dd root`), `scenes.py`, `film.css` (the house look), and the entry points `timeline.py`, `compose.py`, `g11.py`, `render.py`, `description.py`. It refuses a `build/` that already holds any of them. The kit finds the media library through `dd/home.py`, the Motion pack's kit through `film.motion_kit_folder()` (`DD_MOTION_KIT`, else the Motion pack in the engine home's plugin store) and GSAP through `film.gsap_file()` (`DD_GSAP`, else the global install Motion's setup makes).

```python
import sys; sys.path.insert(0, str(DD))
from dd.home import films_for
from framework.kit import Film, stage, timeline, compose, g11plan
FILM = Film(root=<production folder>, revision=films_for(<production folder>) / "<film>" / "<rev>", scenes=stage.SCENES, scene_css=stage.CSS, music=[("M1", None)], persona="<topic>.md")
timeline.write(FILM); compose.write(FILM); g11plan.checked(FILM)
```

The stage (`stage.py`) is the house look every new film starts from; the flat kit scenes (`scenes.py`) stay for films that want a plain desk-and-cards look.

## `Film` (`kit/film.py`)

| Field | Type | Meaning |
|---|---|---|
| `root` | `Path` | The production folder, `dd.home.PRODUCTIONS / <slug>`. Every file below is relative to it. |
| `revision` | `Path \| None` | The Dopamine Debt revision (`<brand>/productions/dopamine-debt/films/<film>/<rev>`, the folder the house gate and the editor's `script_gate` read); when set, `lines.json` and `spine.yaml` come from it (one script for the gate and the build). `None` keeps them in the production's `script/`. |
| `desk_until_line` | `str \| None` | The line that ends the cold open's fake desktop; `None` = no desk (`desk_until` is 0). |
| `desk_html` | `str` | The desk's markup (icons, taskbar), drawn from 0 s to `desk_until`. |
| `backdrops` | `{line id: stock stem}` | `media/stock/<stem>.jpg` shown full frame behind that line. |
| `cutout` | `Path \| None` | The host cutout a `CUT` picture draws. |
| `poses` | `{pose: {x, y, h, flip, rot, slide?}}` | Cutout placements; must hold `stand` (an unknown pose draws as `stand`). `slide` > 0 enters from the right, < 0 from the left; none rises from below. |
| `spoken_forms` | `[(written, spoken)]` | The pronounce map the voice was recorded with, applied in order (`voice.spoken`). Words are counted on the spoken text, so it must match the takes. |
| `scenes` | `{name: Scene}` | The film's own MG templates, looked up before the kit's. |
| `scene_css` | `str` | CSS for those templates, appended after the kit's. |
| `music` | `[(cue, line id \| None)]` | Music beds in order: `media/music/<cue>.mp3`, the first from 0 s (`None`), each until the next one's line starts. |
| `levels` | `MixLevels` | `target_lufs` −14, `true_peak_db` −1.5, `voice_lufs` −19, `clip_lufs` −19, `music_lufs` −33, `music_duck_db` −9 (stages.md Delivery). |
| `receipt_read_px` | `float \| None` | When set, every receipt after the cold open is cropped to whole text lines (`compose.text_lines`, `Captures.read_geometry`): the highlighted lines plus up to `READ_CONTEXT_LINES` of context each side, never past the highlight's own block (a gap between two lines wider than `READ_BLOCK_GAP` of the taller one's height: a heading, panel or section beyond it is not context), or exactly the lines a DOC picture's `read` band names; every line whole across, the crop's edges in the gaps between lines and never on a line the capture itself cut, scaled until the highlighted capitals stand this many frame pixels tall (estimated from the ink of the highlighted lines, `compose.CAP_PER_INK`) or the card box is full. The highlight is every row and column with more than `HIGHLIGHT_RUN` highlight pixels, and its ring (`Captures.ring_box`) keeps `RING_CLEAR` off every word of the page (`compose.text_words`), nestling into the highlight's yellow margin or taking a touching bracket or word inside. A camera inside the card (`#<id>-cm`) then pushes gently, never past the crop's ink-free margins nor so far that the ring loses its pad inside the card (`read_camera`). `None` keeps the card's slow push, its percentile highlight box and its fixed-pad ring. |
| `persona` | `str \| None` | Topic persona file under `personas/`; its `## Core` and `## Floor` feed the judge rules. |
| `library` | `Path` | Media library, default `dd.home.LIBRARY`. |
| `motion_kit` | `Path \| None` | The Motion pack's kit folder (`kit.js`, `kit.css`, `fonts/*.b64`); `None` finds it when the page is composed (`film.motion_kit_folder()`: `DD_MOTION_KIT`, else the Motion pack in `<engine home>/plugins/node_modules`). |
| `gsap` | `Path \| None` | The GSAP build the page loads (`assets/gsap.min.js`); `None` finds it when the page is composed (`film.gsap_file()`: `DD_GSAP`, else the global `gsap@3.14.2` install Motion's setup makes with bun or npm). |

Derived paths: `build`, `lines_file`, `timeline_file`, `layout_file`, `g11_file`, `page_dir` (`build/film`), `css_file` (`build/film.css`), `word_cache` (`build/cache/meme-words.json`), `voice_dir`, `media`, `brand_kit` (`<brand>/brand/` for a production at `<brand>/productions/<id>/`, `dd.home.brand_kit`; `None` for a production that belongs to no brand).

## Public API

| Module | Function | Does |
|---|---|---|
| `voice` | `timings_from_voice(film, lines) -> {line id: take}` | Each narrator line's words from the take that voiced exactly its current text, with `cut_in`/`cut_out` in the take's measured silence. |
| `voice` | `spoken(text, forms) -> str` | The pronounce map applied (what a voice job is sent). |
| `voice` | `record_job(film, seg, job_id, text, options, job_dir)`, `take_voices(film, segs) -> {seg: {voiceId, modelId}}` | Write one voice job into `voice/jobs.json` (refused without its voiceId and modelId); read each take's recorded pair for G11 `brand-voice` (`{}` when none is recorded). |
| `voice` | `brand_voice(film) -> (pair, source)` | The brand's voice: the brand kit's `brand/voice.json` `{voiceId, modelId}`, else the Settings default voice (`dd.home.settings_voice`: `mediaGen.voiceId` in the engine's `config.yml`, a voice with no model), each with where it came from; with neither, `({}, why)` naming the file to write. `g11plan.plan` puts both in `Plan.brand_voice` / `Plan.brand_voice_from`. |
| `voice` | `pause(pcm, last, nxt)`, `tail_end(pcm, t1)`, `voice_pcm(path)`, `frames_db(pcm, a, b)` | Silence-cut primitives (10 ms frames below −45 dBFS, 30 ms of air kept). |
| `timeline` | `build(film, lines, timings) -> dict` | The timeline (schema below). |
| `timeline` | `write(film) -> dict` | `build` from `lines.json` and the takes, written to `build/timeline.json`. |
| `timeline` | `meme_cut(film, lib_id, span=None) -> dict` | A library meme's in/out: its whole spoken statement around the payoff, or `span`. |
| `timeline` | `memes_by_line(lines) -> {line id: (MEME picture, parts)}`, `clip_record(film, clip_id)`, `keyed_part(film, part)`, `sfx_file(film, name)`, `sfx_seconds(film, name)`, `cue_time(words, w, nth, line_id)`, `sticker_time(...)` | Pieces the builder uses; `SFX_FILES` names the sound effects. |
| `compose` | `render(film, timeline) -> (layout, html)` | The page and the layout record. |
| `compose` | `write(film) -> layout` | `render` from `build/timeline.json` into `build/film/index.html` and `build/layout.json`. |
| `compose` | `picture_record(items, desk_until, reveals)`, `Captures(film, bands=None)`, `read_camera(eid, g, w, h, s, e)`, `text_lines(path)`, `text_words(path)`, `unlit_ink(path)`, `picture_on_frame(...)`, `bars_clip(...)` | What fills the frame; capture highlight (its rectangle, its text lines and their capital height, its ring), a capture's text lines and words (glyph boxes with their line index, read on the page with the highlight painted out to the page's ground, `unlit_ink`), receipt crop (whole lines with `Film.receipt_read_px`; `bands` holds each capture's DOC `read` band), the reading camera's bounded push and source chip; where a full-frame clip sits (`fill`) and which bars it clips (mapped through object-fit: cover). |
| `scenes` | `render(eid, item, start, end, words, art, extra=None) -> (html, js, reveals, spots)` | One MG scene, and the sticker spots it declared. |
| `scenes` | `Cues(words, start, end)`: `.at(word \| seconds \| None, nth=1)`, `.word(w, nth)`, `.shown(t)`, `.spot(x, y, rot)` | Word-cued reveal times; every reveal is recorded. `spot` declares where a sticker (STK) landing during the scene sits clear of its content (frame pixels, tried in order); a scene that declares none leaves stickers on the kit's `STICKER_SPOTS`. `PUSH` is the scene push (1 → 1.03) a film's framing must leave room for. |
| `scenes` | `scene(name)`, `SCENES`, `Scene = (eid, p, cues, art) -> (html, js)`, `stamps(...)`, `count_frames(...)`, `CSS` | Writing a flat template. |
| `stage` | `scene(name, box=None, floor=True)`, `SCENES`, `CSS` | The house stage: a template registered here is drawn in design pixels and framed by one camera on its subject `box` (fixed, or computed from the picture's params) inside a window clear of the 10% band even under the push, over a drifting perspective floor; it may return a third, unscaled heads-up layer. `SCENES` already holds the stage's `bars`, `counter` (odometer, optional rail) and `checklist` (ghosted plates filled on their words), which replace the flat ones. |
| `stage` | `framing(box)`, `frame_point(box, x, y)`, `cam(eid, box, t, d)`, `cue(c, p, key, frac)`, `later(c, p, key, frac, after)`, `beats(c, times)`, `beat_push(eid, c, times)`, `drift(sel, c, times)`, `corner_counter(eid, rows, note)`, tweens `ft`/`to`/`tset`/`pop`/`rise`/`slam`/`roll`/`draw` | Writing a stage template: word cues with a fallback fraction, extra camera beats so the picture never holds over 3.6 s, a money object pinned to the window's corner. |
| `art` | `Art(film)`: `.asset(src) -> "assets/..."`, `.logo(slug, h, white=False, cls="", maxw=300)`, `.motion_kit()` (GSAP, `kit.js`, `kit.css`, fonts); `esc(s)` | The page's asset folder, so the page needs nothing outside `build/film`; logos from `media/logos/<slug>[-white].svg|.png`. The page registers its one timeline as `window.__timelines["main"]`, where HyperFrames lint looks for it. |
| `g11plan` | `plan(film, film_x=None) -> g11.Plan` | The shared Plan from the build (and `proof/film-X/audio.txt` after a render), with `measure_page`'s on-screen text (no-text-walls) and edge-band boxes (safe-corners). |
| `g11plan` | `held_times(layout)`, `receipt_inks(film, items)`, `where(items, t)` | The held states sampled for `no-clipped-text` / `tag-clear-of-text`, the captured pages' text lines and words, and the '<unit> (<template>)' a finding names. |
| `g11plan` | `measure_page(film) -> (screen_text, band_boxes, held)` | `build/film/index.html` sampled every 0.5 s in headless Chrome (`framework/layout.measure`, cached in `build/cache/page-measure.json`), each clip shown only inside its `data-start`/`data-duration`: the runs of visible text, and every visible word or motion-graphic element (clipped to its overflow window) inside the 10% edge band; and the held states (`held_times`: each picture 0.6 s after it enters and at 20%, 50% and 80% of its span, moved past any change still settling; every sticker and tag every `OVERLAY_LOOK_SECONDS` from 0.6 s after it lands to its end; and `LAST_LOOK_SECONDS` before every change and picture end) with every visible word whose glyphs (canvas font metrics), or captured-page line (`receipt_inks`), run more than `CLIP_TOLERANCE_PX` past an `overflow` window, a linear `mask-image` fade, or the frame, and every word (a page word, or a captured-page word) a drawn highlight ring's stroke (`RING_SELECTOR`, `.rcpt-ring`) runs through by more than `CLIP_TOLERANCE_PX` both ways (G11 `no-clipped-text`), and every tag, sticker or chip (`TAG_SELECTOR`: `.stk`, `.tagrig .tag`, `.rcpt-chip`, `.credit`, `.mg-stamp`, and a film's own chips marked `.mg-chip`) holding still while it covers more than `COVER_MAX_SHARE` of a visible word's glyph box at the held moment and `MOTION_DT_SECONDS` later, even a word sliding under it (G11 `tag-clear-of-text`). For clipping, text moving more than `MOTION_PX` in `MOTION_DT_SECONDS` relative to its window (a rolling odometer, a scroll) is not held and is skipped; text under `aria-hidden="true"` is texture, not content, and is skipped. |
| `g11plan` | `checked(film, film_x=None)`, `judged(film, completion, film_x=None)`, `write(film, code, advisory=None, why=None)`, `judge_states(film)` | Code rules, plus the advisory judge rules, into `build/g11.json`; `why` (`g11.unchecked_why`) records why an unchecked rule could not be answered, e.g. `brand-voice` with no brand voice declared or a take with no recorded pair. |
| `g11plan` | `seen_judged(film, descriptions, completion)` | After the frames-only read: the gate judge rule `analogy-stays-in-its-world` on each narrator line's description, merged into `build/g11.json`. |
| `mix` | `build_graph(film, timeline, locate=same_path) -> (inputs, graph)` | ffmpeg inputs and filter graph to `[mix]`. `locate` maps a timeline path to this machine's copy. |
| `mix` | `mix(film, video, out, locate=same_path) -> {out, loudness}` | Mix, two-pass loudnorm to `levels`, mux onto the picture. |
| `mix` | `stems(film, out=None, locate=same_path) -> {voice, music, memes}` | The mix split by `STEM_GROUPS` into `build/stems/<group>.flac` at the delivery gain, for G11's music level rules (`music-ducks-under-memes`, `music-drops-under-memes`). |
| `g11plan` | `music_beds(film) -> list` | `Film.music` beds with bpm and mode read from the brand's music ledger (`music.json` in its `productions/dopamine-debt/`) by sha256; `Plan.music` and `Plan.stems` (from `build/stems`) feed the music rules. |
| `seen` | `frames(film, video, out) -> index.json`, `shot_times(a, b, items)` | The SEEN read's frames: per unit, its first look and each picture's settled state (0.3 s before it ends), at least 3, cut from the render. |
| `seen` | `write(film, descriptions, audiences, out=None) -> Path` | The SEEN engine directory (`<revision>/framework/seen`) from a fresh reader's `{row id: {picture, display?}}`; a row with none, or a meme with no seen `display`, is an error. |
| `description` | `write(film, intro, outro, extra=()) -> Path`, `sections(film)` | The YouTube description from the film's sources, pages, clips, posts and memes, with every credit. |
| `instrument` | `main(video, out)`; `python -m framework.kit.instrument <video> <out>` | The render's own proof (`proof/film-X`): 0.5 s contact sheets, the Whisper transcript with word times (`words.json`, `transcript.txt`) and the audio level/speech table (`audio.txt`) G11's `no-dead-air` reads. |
| `render` | `main(film, mix_only=False)` | `build/film` rendered with HyperFrames to `build/renders/picture.mp4`, mixed into `renders/<production>-1080p.mp4`, decoded end to end and checked for 1920x1080 and an A/V gap under 0.05 s, then `instrument.main` into `proof/film-X`. Every subprocess runs with `framework.tools.HIDDEN`. |

## Production layout the kit reads

```
script/lines.json            the rows below (Film.lines_file: `<revision>/script/lines.json` when Film.revision is set)
script/spine.yaml            anchor_world.lines, audience.order[].who (Film.spine_file: `<revision>/spine.yaml` when set)
personas/<persona>           ## Core / ## Floor (else ../dopamine-debt/personas/topic/<persona>, the brand's own topic persona)
voice/segments.json          {seg: {lines: [line ids in take order], line_text: {line id: text as voiced}}}
voice/<seg>.mp3              one take; <seg>.timing.json {words: [{text, startSeconds, endSeconds}]}
voice/jobs.json              {seg: {jobId, text, options: {voiceId, modelId, ...}, dir}}  (kit.voice.record_job; G11 brand-voice reads options)
media/clips/<id>.json        {file, in, out, w, h, creator, cuts?: [[a, b]]}  (file sits beside it; cuts are source ranges a jump cut drops)
media/keyed/<lib>.json       {file, source_in}  (a cutout meme without alpha plays this keyed copy)
media/captures/<id>.png      a page with the quoted words highlighted yellow (#ffe14d); <id>.asset.json {sourceUrl, originalUrl?, capturedAt}
media/sourcing/posts/<id>.png  and media/sourcing/posts.json {posts: [{id, url, published_utc}]} (a picture's post id is looked up as is, else by the 15+ digit status id inside it; a film with no posts needs no posts.json)
media/stock/<name>.jpg       backdrops
media/logos/<slug>.svg|png   scene logos
media/music/<cue>.mp3        beds
build/film.css               the film's style (Page classes)
```

The brand kit, beside the brand's `productions/`, holds the brand's voice:

```
<brand>/brand/voice.json     {"voiceId": "<the brand's voice id>", "modelId": "<its model id>"}  (kit.voice.brand_voice; G11 brand-voice holds every take to it)
```

## `lines.json` contract

A list of rows, in film order: the script stage's own `lines.json`, read as is. The kit reads only these fields; others (`kind: voice|clip`, `act`, `bit`, `facts`, `coverage`, `seg`) are the script stage's.

- `id` (unique), `speaker`: `narrator`, `clip` or `meme`, `text` (the narration; must equal the text a take voiced), `pictures`: a list of picture objects `{k, ...}`.
- A `clip` row plays `pictures[0]` = `{k: "CLIP", id: <media/clips id>, franchise?, credit_at?}` whole, piece by piece, and has no voice. `credit_at` ([x, y] frame pixels, the chip's top-left) moves the creator's credit chip off the footage's own text; without it the chip sits where `.credit` puts it (`compose.CREDIT_AT`).
- A `narrator` row is one voice piece. Its pictures fill the line from its first word to the end of its pause (`visual_end`), except where a cue narrows them.
- A `meme` row is the punch of the narrator row right before it and plays on that line's clock (its timeline items carry that line's id). `pictures[0]` is the `MEME` picture below (where and how it plays); `meme.parts` (optional) lists the library ids played in turn, starting with the picture's `id` (`["clip-what-did-it-cost-…", "clip-everything-…"]`). The kit reads nothing else from the row; `meme.library`, `line`, `dur`, `anchor`, `why` are the script stage's. A meme row after a clip or another meme, or a `MEME` picture on any other row, is an error.

Cues (on `MG`, `DOC`, `BROLL`, `POST`, `CUT`, `TAG`): `from` and `until` name a spoken word of this line (whole word, case and punctuation ignored; a trailing `*` matches a prefix), with `from_nth`/`until_nth` (default 1) for its repeat. The picture starts or ends 0.2 s before that word. A cue word that is not in the narration is an error naming the line.

| `k` | Fields | Draws |
|---|---|---|
| `MG` | `id` (template), `title?`, `source?`, `through?` (a later line id the scene runs on through), `from/until`, template params (below) | A motion-graphic scene. |
| `DOC`, `BROLL` | `id` (capture id), `from/until`, `read?` ([top, bottom] capture pixels: with `Film.receipt_read_px` the card shows exactly the whole text lines whose middles lie in it, e.g. the highlighted sentence whole when context lines would start or end it mid-sentence; a band holding no run of whole lines, or two pictures of one capture with different bands, is an error) | On the desk: a window. After: a receipt card around the highlight, with a source chip on the site's first showing. |
| `POST` | `id` (post image id), `from/until` | A post card. |
| `CUT` | `pose?` (default `stand`), `from/until` | The host cutout. |
| `TAG` | `text`, `from/until` | A hanging price tag (a label). |
| `STK` | `text` | A sticker landing on the first spoken word it echoes (else past mid-line), placed off every held overlay; a stamp sound plays only in the pause. |
| `SFX` | `id` (a `timeline.SFX_FILES` name) | Sound at the line end; the next line waits until it rings out (at least 0.6 s). |
| `MEME` | Only as `pictures[0]` of a `meme` row. `id` (library id), `franchise`, `mode?` (`fullscreen` default, `cutout`, `spotlight`, `slot`, `ghost`), `side?` (cutout/ghost), `on?` (capture id a spotlight or slot anchors to), `box?` ([x, y, w, h] capture pixels a slot fills; else the highlight), `in?`/`out?` (source seconds, overriding the statement cut; applies to every part), `cuts?` ([[a, b]] source ranges a jump cut drops inside the meme's own silent beat, leaving about 0.5 s of it, as a creator clip's `cuts`; G11 no-dead-air), `picture?` ([x, y, w, h] source pixels of the frame inside letterbox bars, overriding the library entry's `picture: {x, y, w, h}` fractions; `picture_basis` documents how it was measured), `fill?` (fullscreen: the picture is scaled to cover the frame, centred on it, instead of being clipped over a matte; a source that is not 16:9 is mapped through object-fit: cover either way) | The meme after its narrator line. One with its own spoken payoff plays after the last word and holds the next line, its parts back to back; a silent one plays its first part 1.45 s with a vine boom. A fullscreen meme with sound ends the line's pictures where it starts. A fullscreen meme with a `picture` is clipped to it over a dark matte. |

Kit MG templates and their params (`on`/`nth` keys name the word a part lands on; every template takes `stamp` or `stamps: [{text, on, nth?, x?, y?, rot?}]` where noted):

- `bars`: `rows[{label | logo, value, text? | prefix?, suffix?, dec?, tone?, on, nth?}]`, `max?`, stamps.
- `line`: `points[{label, value}]`, `min?`, `max?`, `draw_from`, `draw_to`, `end_text`, `end_on`, `end_nth?`, `first_text?`.
- `compare`: `sides[{caption, value, logo?, prefix?, suffix?, dec?, from?, sub?, tone?, on, nth?, count_on?, count_nth?}]`, `arrow?` (default true), stamps.
- `tags`: `items[{name, old, new, delta?, logo?, on, nth?}]`, stamps.
- `timeline`: `events[{year, text, tone?, on, nth?}]`.
- `counter`: `caption`, `value`, `from_value?`, `prefix?`, `suffix?`, `dec?`, `logo?`, `on`, stamps.
- `logos`: `items[{logo, caption?, on, nth?}]`, stamps.
- `bill`: `heading`, `rows[{part, old, new?, hot?, on?}]`, `rows_on?`, `total_old`, `total_new`, `jump_on`, stamps.
- `meter`: `heading`, `hours`, `dollars`, `run_from`, `run_to`, `caps[{text, on, x?, y?, rot?}]`.
- `checklist`: `heading?`, `rows[{text, mark? (✗ default, ✓, or a value), on, nth?, mark_on?, mark_nth?}]`, stamps.
- `cartel`: `firms[{name | logo, on, nth?}]`, `string_on`, `stamps`, `bars_on?`.

A scene shows its first element within 1 s of its start whatever its words (G11 no-blank-stage); every cue time is a reveal in `layout.scenes`.

## `timeline.json`

`{duration, desk_until, items}`; items sorted by `start`, each `{kind, start, end, line, ...}`:

- `voice`: `seg`, `file`, `in`, `out` (take seconds). `clip`: `file`, `in`, `out`, `audio`, `w`, `h`, `creator`, `franchise` (+ `credit_at` when the CLIP picture sets it).
- `meme`: `lib`, `file`, `in`, `out`, `audio`, `w`, `h`, `alpha`, `picture` (the MEME row's `[x, y, w, h]` pixels, else the library's `{x, y, w, h}` fractions, else null; `compose.letterbox_inset` reads both), `mode`, `side`, `on`, `box`, `franchise` (+ `audio_file`, `audio_in` for a keyed cutout).
- `sfx`: `file`, `gain_db`. `mg`: `mg` (the picture object), `words` ([text, start, end] on the film clock). `doc`/`post`: `id`, `file` (+ `read` for a DOC with a read band). `stock`: `file`. `cutout`: `pose`. `tag`/`sticker`: `text`.

## `layout.json`

`boxes[{kind, start, end, box}]` (receipts, posts, spotlights, slots, credits, stickers), `labels[{kind: source|credit|tag, start, end}]`, `scenes[{start, end, first_reveal, line}]`, `pictures[{kind, start, end}]`, `changes[[t, kind]]`. These are `g11.Plan` fields.

## Page classes (`build/film.css`)

The film's CSS styles what the kit draws: `:root` vars `--ground --ink --cream --accent --red --blue --green`; `.stage`; `.desk`, `.icons`, `.icon`, `.taskbar` (62 px high: `compose.TASKBAR_H`); `.win .bar .t .dots .body`; `.rcpt`, `.rcpt-chip`, `.rcpt-ring`; `.full`; `.post`; `.credit`; `.cut`; `.stk`; `.tagrig .stick .string .tag`; `.ring`, `.film-cut`, `.film-slot`. The overlay classes (`.ovl-*`) come from `framework/overlays.base_css()`, the scene classes from `kit/scenes.CSS`. `new-film/film.css` is a complete example.
