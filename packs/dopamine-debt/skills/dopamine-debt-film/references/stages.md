# Files, sources, memes, voice and the mix

`DD` = the installed kit (`inso dd root`); `BRAND` = the brand's `productions/dopamine-debt/` (`dd.home.brand_dir(<production>)`), where everything you make for the style lives: films' scripts (`BRAND/films/<f>/<rev>/`), research, the brand's personas (`BRAND/personas/channel/`, `BRAND/personas/topic/`) and the music ledger (`BRAND/music.json`). The film's own production folder holds its kit build (`build/`), media, voice and renders. A production names its script revision in `dopamine-debt.json`: `{"revision": "<film>/<rev>", "audiences": {"<audience>": "personas/...md"}}`.

## lines.json
One row per spoken line or clip. The picture kinds (`MG`, `DOC`, `BROLL`, `POST`, `CUT`, `TAG`, `STK`, `SFX`, `MEME`, `CLIP`), the `from`/`until` word cues and the MEME fields are specified in `DD/framework/kit/README.md` (`lines.json` contract).

## Sources
- Verified facts live in the revision's `sources_verified.json`: `sources` (S, with file and line), `calcs` (C), `news` (N, said as "reports say"), `posts` (P, with uid and full text).
- A capture keeps its source URL and its capture date.
- Check the direction of every comparison you joke about against its numbers: a line that calls a sale "great timing" when investors paid twice as much a month later reads backwards.
- Some pages cannot be captured live (they re-render and drop the highlight; SEC EDGAR filings render blank). Capture the page's own HTML rendered locally through `overrides.json` `urls: [file:///…]`; `sourceUrl` stays the live page.
- Receipt text size follows the page's line length: capture at a narrow viewport (`capture.mjs` `zoom` 2.3, `noZoomOut`) and hide side panels with a `css` override.

## Memes
- Library: `<engine home>/media-library/<id>/entry.json` (`file`, `payoff{line, t}`, `inSeconds`, `outSeconds`, credit, franchise, `canonical`). It is read-only: correct an entry only with `library_tag`, and write a measured whole line and its in/out back with it so the next film starts from it.
- `DD/framework/quiet.py`: `speech(src, a, b)` gives `[word, start, end]` triples; `clip_edges(src, a0, z0)` snaps a span to silence; `point(src, lo, hi, prefer)` finds the quietest cut; `_frames(src, a, b)` gives 10 ms dB frames.
- Library clips are cut tight to the line, so their edges are rarely silent. Fetch the longer source from `entry.source.url` (`framework/media_fetch.download`) and cut it there with `clip_edges`.
- faster-whisper mishears some lines; check what it heard against the payoff line before choosing a clip.
- Letterboxed movie clips: the library's `picture: {x, y, w, h}` (or `picture` and `picture_basis` on the MEME row) clips the play to the real picture; a cover crop would cut faces.
- A silent beat of 1 s or more inside a clip: record `cuts: [[a, b]]` on the MEME row, leaving about 0.5 s of it.
- Overlay modes live in `DD/framework/overlays.py`. Keep anchors out of the 10% edge band.

## Voice
- `generation_submit`, model `elevenlabs/voice`, options `{production, voiceId, modelId}`: the brand's voice, one pair on every act. `kit.voice.brand_voice(FILM)` reads it from `<brand>/brand/voice.json`, else the Settings default voice (which names no model: pick one modelId and keep it); with neither, ask the person once and write it into the brand kit. Never invent a voice id or carry one over from another brand.
- The tool returns `audio.mp3` and `timing.json` (word times) and has no pronunciation option: apply the film's `spoken_forms` in the text.
- Record each job with `kit.voice.record_job(FILM, seg, job_id, text, options, dir)` (`voice/jobs.json`). One act per job, at most 2 at a time.
- Never time-stretch, and never change the voice model to fit time. Trim a long take in the script.
- A cloned voice reads long sentences at 2.5 to 2.9 words/s and short comma-and-full-stop lines at about 1.8 to 2.0.
- Re-voice only the acts whose text changed; ElevenLabs bills about one credit per character. Check the credits before a re-voice.

## Delivery
- Mix: voice is the anchor. The bed sits at least 12 LU under the voice, ducks at least 6 dB and sits at least 18 LU under every meme that plays its own sound. Sound effects stay off narration words. Deliver at −14 LUFS and −1.5 dBTP. A kit film mixes with `DD/framework/kit/mix.py` at its `Film.levels` (`MixLevels`: voice −19, clips −19, bed −33 LUFS, duck −9 dB by default; deepen the duck for a quiet meme line).
- Music bed: a media-library music entry or a track in the brand's music ledger (`BRAND/music.json`) `approved`. An `approved` entry carries the person's own yes (`yes`, what they said) or, for a bed made for the film, `approved_by: "made for this film"` and `film: "<production id>"` (that film only; never a quoted yes they did not give). Every entry names its licence. `references` are beds they praised; `rejected` holds what they said (`said`). No connected model can listen, so the person judges the bed by ear in the render.
- A prompt asking for "minor key" can come back major: measure each bed, and write its bpm and mode into the film's `music` row.
- Keep every generation's prompt, options and job id in its asset record.
- Final render: decodes end to end, 1920×1080 at 30 fps, A/V gap under 0.05 s.
