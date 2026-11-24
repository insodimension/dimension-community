---
name: filmmaker-core
description: "The short guide to a Dopamine Debt film: a sensible order of work from research to the person's watch, the house style, the kit, and where to read more (dopamine-debt-film, kit-film). Guidance, not a pipeline: nothing waits on a gate. Load for any Dopamine Debt film."
---

# Filmmaker core

Dopamine Debt is a style and a kit, not a pipeline. The steps below are the order that usually works; skip or reorder what this film does not need. The gate (`inso dd gate`, `script_gate`) is an optional score: run it at most once on the script and once on the cut, when a number helps you; report what it says as advice, and never stop, loop or wait on it. Voice, generation and render never wait for it.

`DD/` is the Dopamine Debt kit folder: `inso dd root` prints it (the engine `dd/`, `framework/` and its film kit `framework/kit/`, the shipped channel persona, `taste.json`, `tunables.json`). Never write into it: an update of the kit replaces it. `dd/home.py` names the folders: `brand_dir(<production>)` is the brand's `productions/dopamine-debt/` (research, your personas, `music.json`, `calibration/marks.jsonl`, and `films/<f>/<rev>/`), `LIBRARY` is the shared meme library. A film is one production with its own folder and room; its build lives in `<production>/build/`.

Read on demand, never from memory:
- `dopamine-debt-film`: what makes these films work (spine, jokes, memes, pictures, sound) and `references/` (stages, craft, framework map, gotchas, the production recipe).
- `kit-film`: building and rendering with the kit, and the kit's craft rules.
- `DD/framework/kit/README.md`: the `Film` config, the `lines.json` contract, every kit module and scene template.

## A sensible order of work

1. **Research and take.** Sourced, dated facts with a verbatim quote each; one falsifiable take; the spine's analogy.
2. **Script.** Deadpan lines in `lines.json`, every picture cued to its words, memes from the library as the punch of a line that set them up. Read it aloud at about 2.7 words/s for length. One pass of fixes by structure is usually enough.
3. **Voice.** `generation_submit` model `elevenlabs/voice` with `options` `{production, voiceId, modelId}`: the brand's voice, one pair on every job of the film. `kit.voice.brand_voice(FILM)` reads it from `<brand>/brand/voice.json`, else the Settings default voice; with neither, `ask` the person once. Never change the voice model to fit time; fix length in the script. Record each job with `kit.voice.record_job(...)`. Re-voice only the lines that changed.
4. **Build.** `inso dd new-film <production>` writes `build/`. `python timeline.py && python compose.py && python g11.py`, snapshot the moments that matter and look at them, then `python render.py`. G11's findings are a checklist to look at, not a wall.
5. **Show the person the first render** as soon as it plays end to end, with a few lines: what you chose, any score as advice, the music licence, what you did not check.
6. **Look once, fix once.** While they watch, `kit.seen.frames(...)` and one fresh `task` reader on those frames only. Check what it names; put the real defects and the person's notes into one more render. Do not spawn reader after reader.

## Asking and money

- Ask only what you cannot decide (their voice, a spend the caps do not cover), once, everything in one message. Taste choices proceed on a sensible default and go in the report.
- Music: make the film's own bed, or reuse an approved one, and register it in the brand's music ledger (`dopamine-debt-film` stages.md §Delivery). Keep every generation's prompt, options and job id in its asset record.

## House style

What these films aim for (the full list is `DD/taste.json`; `framework/g11.py` measures most of it): deadpan, never labelling its own joke; the picture changes at least every 5 s under narration, a scene shows something within 1 s, no blank stage; the first laugh by 4 s; the spine's analogy acted out in a motion-graphic scene and kept in its own world; a meme plays its whole spoken line cut on silence, canonical version, one per franchise; one brand voice per cut; narration cut only in silence, no sound effect on a word; no text walls, nothing important in the 10% edge band, no cut-off text; real posts captured with source and date; 1920x1080 to the person; no end card, no lower thirds; the bed under the voice and ducked under memes, no vocals.

When a check and your eyes disagree, your eyes and the person's notes win. Never spend a pass rewording a line only to move a judge's score.

## The machine

- Hidden subprocesses and render temp space: `kit-film` craft rules. Programs come from PATH (`framework/tools.py`). One heavy render at a time; a full render takes about 18 minutes, so batch fixes into one render.
- The media library is read-only: correct entries only with `library_tag`.
- A HyperFrames render stops after 90 minutes (`render.RENDER_TIMEOUT_SECONDS`) and kills its whole process tree; a stopped render's `picture.mp4` is incomplete.
- Python 3.10 or newer with the packages in `DD/requirements.txt` (`python -m pip install -r <the folder inso dd root prints>/requirements.txt`).
