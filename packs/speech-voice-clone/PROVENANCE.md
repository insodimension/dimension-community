# Provenance — Local voice cloning

## What this pack ships, and what it fetches

- **The pack's code and docs** (`src/`, `python/`, `test/`, `README.md`, `models.json`, the voice profile) are MIT, see
  the repository `LICENSE`. `assets/icon.svg` is drawn for this pack and is MIT too.
- **No model weights or model code ship in the pack.** The first use of a model fetches them on the user's machine,
  each pinned to a full commit SHA in `models.json`, and each stays under its own licence:

  | Model | Weights (Hugging Face, pinned revision) | Code | Weights licence |
  |---|---|---|---|
  | Qwen3-TTS 1.7B | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | `qwen-tts` on PyPI | Apache-2.0 |
  | Breeze TTS 2 | `BreezeBlue/Breeze-TTS-2` | `breezeblue-ai/breeze-tts` on GitHub (Apache-2.0) | BreezeBlue Research and Non-Commercial License |
  | VoxCPM2 | `openbmb/VoxCPM2` | `voxcpm` on PyPI | Apache-2.0 |
  | Fish Audio S2 Pro | `fishaudio/s2-pro` | `fishaudio/fish-speech` on GitHub | Fish Audio Research License |
  | Chatterbox | `ResembleAI/chatterbox` (five files) | `chatterbox-tts` on PyPI | MIT; output carries the Perth watermark |

- **The Python environments** are installed from `python/requirements/<model>.<platform>.txt`: exact pins compiled
  with `uv pip compile --python-platform` from environments that ran each model on 2026-11-23, one lock for Windows
  x86_64 and one for Linux x86_64. Fish Audio S2 Pro's lock overrides `protobuf` to `>=3.20,<6`, as fish-speech's own
  `pyproject.toml` does.

## Where the comparison in the README comes from

Measured on 2026-11-23 on one machine (RTX 4080 SUPER, 16 GB), for one adult male English speaker:

- **Reference**: 25.3 seconds, mono 24 kHz, two sentences, with an exact transcript.
- **Held-out set**: 87 seconds of the same speaker, not overlapping the reference.
- **Each model**: one take of the same 40-word test text, seed 42, at the settings this pack uses (Qwen3-TTS bf16
  with SDPA attention; Breeze TTS 2 with no instruction; VoxCPM2 cfg 2 and 10 steps; Fish S2 Pro's default sampling;
  Chatterbox exaggeration 0.5 and cfg weight 0.5). Every take was transcribed with faster-whisper small.en and every
  transcript matched the text word for word.
- **Similarity**: cosine similarity between ECAPA embeddings (`speechbrain/spkrec-ecapa-voxceleb`, revision
  `0f99f2d0ebe89ac095bcc5903c4dd8f72b367286`) of each take and of the held-out set. The reference itself scored 0.956.

| Model | Similarity |
|---|---|
| Qwen3-TTS 1.7B | 0.895 |
| Breeze TTS 2 | 0.886 |
| VoxCPM2 | 0.874 |
| Fish Audio S2 Pro | 0.859 |
| Chatterbox | 0.772 |

The reference and held-out recordings were themselves produced by a commercial voice clone of the speaker, not by a
microphone, so the figures rank how well each model copies one voice; they are not a general quality benchmark. A
sixth model, Voxtral TTS, was left out: its open checkpoint has no audio encoder, so it cannot clone from a recording.

The provider speaks a reply one sentence at a time, which scores differently from one take of the whole text: the same
five models, driven through this pack on the same machine, scored 0.79 to 0.92 (VoxCPM2 highest, Chatterbox lowest).
