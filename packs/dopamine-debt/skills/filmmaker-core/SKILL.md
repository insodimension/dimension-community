---
name: filmmaker-core
description: "The Filmmaker's must-knows for a Dopamine Debt film: the order of work from research to the person's watch, the spend gate, the blind-reader loop, the house rules, and where to read the rest (dopamine-debt-film, kit-film). Load for any Dopamine Debt film."
---

# Filmmaker core

`DD/` is the Dopamine Debt kit folder: `inso dd root` prints it (the engine `dd/`, `framework/` and its film kit `framework/kit/`, the shipped channel persona, `taste.json`, `tunables.json`). Never write into it: an update of the kit replaces it. `dd/home.py` names the folders: `brand_dir(<production>)` is the brand's `productions/dopamine-debt/` (research, your personas, `music.json`, `calibration/marks.jsonl`, and `films/<f>/<rev>/`, where the gate and `script_gate` find a revision; `films_for(<production>)` names its `films/`), `LIBRARY` is the shared meme library. A film is one production with its own folder and room; its build lives in `<production>/build/`.

Read on demand, never from memory:
- `dopamine-debt-film`: the checklist (F-1 … F-16, Notes and Calibrate modes) and `references/` (stages, craft, framework map, gotchas, the production recipe).
- `kit-film`: the build checklist (K-1 … K-10) and the kit's craft rules.
- `DD/framework/kit/README.md`: the `Film` config, the `lines.json` contract, every kit module and scene template.

## Order of work

Tick each step in the revision's `WORKLOG.md` with its exit result.

1. **Pre-flight.** Read `dopamine-debt-film` `references/gotchas.md` and `craft.md` for why the rules exist; the rules a check enforces are in `DD/taste.json`, not in the gotchas. Check personas are not expired; `inso dd gate script <production> <report>` runs (exit 2 lists what is missing). New machine or brand: `inso dd setup <brand folder>` writes the brand's `productions/house-gates.json`.
2. **Script stage** (dopamine-debt-film F-1 … F-10). Packaging, `spine.yaml` (frozen before the script), `intent.json`, cold open, joke map, `lines.json` with every picture cued to its words, the script read at 2.7 words/s, at most 3 repair passes by structure, memes from the library. Exit: the Dopamine Debt script gate passes.
3. **Spend gate** (F-12a, F-12b). `script_gate` on the production; price the voice, music and effects with `generation_quote`. Any edit to `lines.json`, `spine.yaml` or `intent.json` makes the gate stale: run it again before the next spend.
4. **Voice** (F-12). `generation_submit` model `elevenlabs/voice` with `options` `{production, voiceId, modelId}`: the brand's voice, one pair on every job of the film. `kit.voice.brand_voice(FILM)` reads it from the brand kit's `<brand>/brand/voice.json` `{voiceId, modelId}`, else the Settings default voice (Media generation); with neither, `ask` the person for their voice and write it into the brand kit. Never change the voice model to fit time: another model makes a cloned voice sound like someone else; fix length in the script. Record each job with `kit.voice.record_job(FILM, seg, job_id, text, options, dir)` (`voice/jobs.json`): G11 `brand-voice` reads it. Apply the film's pronounce map in the text, one act per job, at most 2 running. Never time-stretch.
5. **Build** (kit-film K-1 … K-6). `inso dd new-film <production>` writes `build/` (film.py, scenes.py, timeline, compose, g11, render, description, film.css); film.py finds the kit each time it runs (`DD_ROOT`, else `inso dd root`). Scenes are templates on the kit's stage camera (`framework/kit/stage.py`) fed real data. `python timeline.py && python compose.py && python g11.py`, snapshot and look, then `python render.py`.
6. **Blind-reader loop** (K-7, K-8). `kit.seen.frames(FILM, <render>, proof/seen-frames-N)`, then a FRESH `task` subagent that reads only those frames (never the script) and writes `descriptions.json` plus a strict list of blank, cramped, unreadable, cut-off or covered frames. Check each named frame yourself. Fix at the cause; a defect class G11 missed gets its G11 rule first (taste.json + `framework/g11.py`). Re-render and read with a NEW reader until it lists only clip-footage limits and motion caught mid-move.
7. **SEEN gate** (K-9). `g11plan.seen_judged`, `seen.write`, `dd.read.read`, `dd.gate.check` with G11's fails; `dd.gate.write`. A blocker you cannot fix by structure goes to the person with evidence.
8. **Show the person** (K-10, F-15). The render first, then the YouTube description (`python description.py`), the gate table with every advisory, the music licence, and what you could not check. Say "the framework predicts".
9. **Gotcha review** (F-16). A lesson goes into a skill of your own or the brand's notes; the kit folder is replaced on update.

The person's notes on a render: `dopamine-debt-film` Notes mode. Each note is a G11 rule with its check, a calibration label, or a story fix, redone from the stage that owns it.

## Asking and money

- The take and every spend wait for the person's answer through `ask`. A taste choice with a safe default (a meme, a scene, a cut) proceeds on the default and goes in the report. Ask once, everything in one message.
- Music: you make each film's own bed; register it in the brand's music ledger as `dopamine-debt-film` stages.md §Delivery says (G8). Never ship a `motion_score` render as a bed. Keep every generation's prompt, options and job id in its asset record.

## House rules

`DD/taste.json` holds every G11 rule; `framework/g11.py` checks each `code` rule, and an unchecked rule blocks. The gates in short: deadpan, never labelling its own joke; the picture changes at least every 5 s under narration, a scene shows something within 1 s, never 1.5 s of blank stage, a scene never snaps back to a frame it showed; the first laugh by 4 s; the spine's analogy acted out in a motion-graphic scene and kept in its own world; a meme plays its whole spoken line cut on silence, canonical version (`canonical.is` in the library), one per franchise, no tags or grids, stopping narration only at a sentence end; every take the brand's voice, one voice pair per cut; narration cut only in silence, no sound effect on a word, no 1 s of dead air, no statement voiced as a question; no text walls (12+ unspoken words), nothing important in the 10% edge band, no cut-off text, no tag over text; real posts captured with source and date; every source 720p+, only 1920x1080 reaches the person; no end card, no lower thirds, no Fireship; the bed approved in the brand's music ledger, 12 LU under the voice, ducked 6 dB and 18 LU under every sounding meme, no vocals. Advisory judge rules (meme is the audience's feeling, meme has a setup, picture is understood) are listed for the person, never hidden.

Never lower a threshold, edit `gates.json` by hand, or reword a line to please a judge: fix by structure (the beat, the picture, the meme, the kit). A check that did not run is not a pass.

## The machine

- Hidden subprocesses and render temp space: `kit-film` craft rules. Programs come from PATH (`framework/tools.py`). One heavy render at a time; a full render takes about 18 minutes.
- The media library is read-only: correct entries only with `library_tag`.
- A HyperFrames render stops after 90 minutes (`render.RENDER_TIMEOUT_SECONDS`) and kills its whole process tree; a stopped render's `picture.mp4` is incomplete.
- Python 3.10 or newer with the packages in `DD/requirements.txt` (`python -m pip install -r <the folder inso dd root prints>/requirements.txt`).
