---
name: kit-film
description: "Build and render a Dopamine Debt film with its film kit: every picture cued to a spoken word, motion-graphic scenes written as code from real data, memes with a reason. Use for 'build the film', 'make the motion graphics', 'render the film'."
---

# Kit film: build and render

The kit lives in `DD/framework/kit` (`DD` is the folder `inso dd root` prints; an update replaces it, so never write into it). Its `README.md` is the contract for `lines.json`, `timeline.json`, `layout.json` and every module; `stage.py` holds the house stage and scene templates. The `dopamine-debt-film` skill says what the film should feel like; this one says how to build it.

## Building

1. **Start.** `inso dd new-film <production> [<film>/<rev>]` writes `<production>/build/` (`film.py`, `scenes.py`, `film.css`, `timeline.py`, `compose.py`, `g11.py`, `render.py`, `description.py`). Set the `FILM` fields in `film.py`: `revision`, `spoken_forms` (how the voice says acronyms), `music` beds, `persona`. A new film starts here, never from a copy of another production.
2. **A picture for every word.** In `lines.json` each narrator line has `pictures` cued to its own words (`on`, `from`, `until`): the counter lands on "thirty-nine", the bars grow on "six". A line that names a number shows it; a line that tells the analogy acts it out.
3. **Scenes are code, from real data.** Use the stage's templates first (`bars`, `counter`, `checklist`); a film's own goes in `build/scenes.py`, registered with `stage.scene(name, box=...)`, with word-cued reveals (`stage.cue`, `stage.later`) and a settled state that holds. Every number on screen comes from a sourced fact.
4. **Memes.** A `speaker: "meme"` row punches the line before it, with its reason in `meme.why`. Find clean in and out points with `framework/quiet.py` (`speech`, `clip_edges`, `_frames`), not Whisper word starts.
5. **Look.** `python timeline.py && python compose.py`, then snapshot the moments you changed (`npx -y hyperframes@0.8.217 snapshot build/film --at t1,t2 --no-end`) and look at them. `python g11.py` lists layout and pacing findings you can use as a checklist.
6. **Render.** `python render.py --draft` while the person is watching cuts: half the frames at draft quality, the same mix and checks, `renders/<production>-draft.mp4`, no proof. `python render.py` once, for the master: 1080p30, the mix normalised for YouTube, and a `proof/` folder with contact sheets and a transcript. A master takes about 18 minutes and one heavy render runs at a time, so batch your fixes and the person's notes into each render.
7. **Deliver.** The master, the YouTube description (`python description.py`), and a line on what you did not check.

## Things that bite

- Every subprocess is hidden (`creationflags=framework.tools.HIDDEN` in Python, `windowsHide: true` in Bun): a console over the person's screen is a defect.
- A render needs about 3 GB of temporary frame storage; when the system drive is short, point `TEMP`/`TMP` at a drive with room.
- A scene's wrapper id never reuses `{eid}-in`, and SVG defs are never repeated per scene: duplicate ids abort the render.
- A receipt held over about 4 seconds reads as a still: split the line on its words, the receipt `until` a word and the scene `from` it.
- A photo with gold or yellow above the highlighted sentence pulls the receipt ring off its card; recapture the page with images hidden.
- A sticker over a card hides its text: give each card one free edge for it.
- A drawn object faces the way its scene moves.
- A meme clip with burned-in subtitles is cropped above them with `picture` + `fill`; a silent beat over 1 second inside a clip is cut with the MEME row's `cuts`.
- The bed: make the film's own or reuse an approved one, and register it in the brand's music ledger as `references/stages.md` §Delivery (in `dopamine-debt-film`) says.
