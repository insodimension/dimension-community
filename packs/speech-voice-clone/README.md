# Local voice cloning

## What it is

A `speech` provider that speaks an agent's replies in a voice cloned from one short recording, on this machine's NVIDIA
GPU, with an open-weight model. It needs no account and no key, and costs nothing per character. A voice profile picks
it by naming provider `voice-clone`, a model and a voice.

## What it contains

- **One speech provider, `voice-clone`** (speak only), offering five models. Similarity is how close each model's take
  came to held-out speech of the cloned voice in one test; `PROVENANCE.md` says how it was measured.

  | Model id | Model | Similarity | Delivery control | Weights licence |
  |---|---|---|---|---|
  | `qwen3-tts` | Qwen3-TTS 1.7B Base | 0.895 | none: copies the recording's delivery | Apache-2.0 |
  | `breeze-tts-2` | Breeze TTS 2 | 0.886 | `instruction` option; performs `[laughs]` `[sighs]` `[coughs]` `[clears throat]` | research and non-commercial only |
  | `voxcpm2` | VoxCPM2 | 0.874 | none | Apache-2.0 |
  | `fish-s2-pro` | Fish Audio S2 Pro | 0.859 | performs any short `[direction]` in the text | research only |
  | `chatterbox` | Chatterbox | 0.772 | `exaggeration` option | MIT, Perth-watermarked output |

- **Profile options** (a speak entry's `options`): `seed` for every model (default 42). Breeze TTS 2 takes
  `instruction`, for example `"Dry, deadpan and unhurried."`, and with it `cfgScale` (default 4); without an
  instruction `cfgScale` is not used. Chatterbox takes `exaggeration` (0.25 to 2, default 0.5) and `cfgWeight`
  (default 0.5). VoxCPM2 takes `cfgScale` (default 2).
- **A writing guide** for the two models that perform directions, which the engine hands the reply rewriter.
- **The voice profile `my-voice`**: speaks with Qwen3-TTS in the voice `me`, falls back to on-device Kokoro, and
  listens with on-device Parakeet (English).
- **`python/worker.py`**, the one program every model runs in, and exact per-platform package locks under
  `python/requirements/`.

## Who can use it

Anyone on the canary release ring, running Dimension 0.11.4 or newer (`requires.dimension`). It is off until you
enable it. It needs:

- **An NVIDIA GPU with CUDA, on Windows or Linux** (x86_64). Qwen3-TTS peaked at 4.4 GB of video memory and VoxCPM2 at
  6.1 GB in testing; Fish Audio S2 Pro's weights alone are 11 GB, so it needs a card with at least 12 GB. macOS is
  reported as unavailable.
- **[uv](https://docs.astral.sh/uv/getting-started/installation/)**, which the pack's connect step checks for and can
  install. `UV` may name its path instead.
- **A voice**: `<name>.wav` (10 to 30 seconds of clean speech, no music) and `<name>.txt` holding its exact words, in
  the voices folder. `<name>` is the voice id.

Everything lives in one data folder: `DIMENSION_VOICE_CLONE_HOME` when it is set, else
`<engine home>/speech/voice-clone`. It holds `voices/`, `envs/<model>/` (the Python environments), `sources/` (Breeze
and Fish code) and `hf/` (the weights).

## Limits and risks

- **The first use of a model downloads a lot.** Its Python environment (PyTorch with CUDA and the model's packages) and
  its weights: about 4.5 GB of weights for Qwen3-TTS, 5 GB for VoxCPM2, 7.7 GB for Breeze TTS 2, 11 GB for Fish S2 Pro
  and 3.2 GB for Chatterbox, about 8 to 19 GB per model with its environment. A model downloads only when you press
  Download for it in the voice settings; until then the engine reports it as needing a download and the profile's
  next voice speaks.
- **uv keeps its own cache** of the downloaded packages and any Python it installs, outside the data folder (uv's
  default cache and Python directories).
- **One model is loaded at a time.** A switch to another model waits until every reply using the loaded one has
  ended, then unloads it. The engine can also ask the pack to unload an idle model when memory runs low.
  A loaded model holds its video memory until it has been idle for five minutes. The first reply after a load waits
  for it: 22 to 34 seconds in testing, and nearly four minutes for Fish S2 Pro.
- **Speed.** With the model loaded, on an RTX 4080 SUPER, one sentence of 4 to 5 seconds took: Chatterbox 3.3 s,
  VoxCPM2 7.7 s, Qwen3-TTS 8.4 s, Breeze TTS 2 13.9 s, Fish S2 Pro 37 s. Only Chatterbox kept ahead of real time, so a
  long reply in the others trails behind the text.
- **After setup it runs offline.** A speaking process starts with `HF_HUB_OFFLINE=1`. Only setup reaches the network:
  PyPI, the PyTorch package index, Hugging Face, and for Breeze and Fish a pinned source archive on GitHub.
- **Licences travel with the weights.** Breeze TTS 2 and Fish S2 Pro forbid commercial use. Clone only a voice you
  have the right to use.
- **Captions are estimated**, spread over each sentence's audio by word length; none of these models returns word
  timing.
- **Not streamed within a sentence**, except by Breeze TTS 2: the other models deliver each sentence once it is
  synthesized.
- **The model processes get the engine's environment**, as the bundled on-device speech does, and run third-party
  Python code from the pinned packages and sources.

## Build and test

```sh
bun test           # from this folder
bun run check      # biome
```

There is no build step: the engine loads `src/index.ts`, which spawns `python/worker.py` in the model's environment.
