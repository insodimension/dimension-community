"""After a render: 0.5 s contact sheets, a Whisper transcript with word times, the audio levels, and the moments the
picture snaps back to an earlier frame, which a film's G11 (`no-dead-air`, the music rules, `no-scene-replay`,
`statement-not-asked`) and the blind logger read. `python -m framework.kit.instrument <video> <out dir>` writes
proof/film-X."""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from framework.tools import HIDDEN

STEP_SECONDS = 0.5
COLS, ROWS = 8, 5
TILE_W, TILE_H, LABEL_H = 320, 180, 16
AUDIO_RATE = 16000
WHISPER_MODEL = "small.en"
RETURN_FPS, RETURN_W, RETURN_H = 5, 96, 54
RETURN_SAME, RETURN_MOVED, RETURN_AGO = 0.6, 4.0, 2.0


def run(args: list[str]) -> None:
    subprocess.run(args, check=True, capture_output=True, creationflags=HIDDEN)


def duration(video: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)], capture_output=True, text=True, creationflags=HIDDEN)
    return float(out.stdout.strip())


def label(seconds: float) -> str:
    return f"{int(seconds // 60)}:{seconds % 60:04.1f}"


def sheet_font(size: int = 13):
    """Consolas where Windows has it, else Pillow's own scalable font, so a contact sheet renders on every system."""
    try:
        return ImageFont.truetype("consola.ttf", size)
    except OSError:
        return ImageFont.load_default(size=size)


def contact_sheets(video: Path, out: Path) -> int:
    with tempfile.TemporaryDirectory() as tmp:
        run(["ffmpeg", "-v", "error", "-i", str(video), "-vf", f"fps=1/{STEP_SECONDS}:start_time=0,scale={TILE_W}:{TILE_H}", "-q:v", "3", str(Path(tmp) / "f%05d.jpg")])
        frames = sorted(Path(tmp).glob("f*.jpg"))
        font = sheet_font()
        per_sheet = COLS * ROWS
        for sheet_index in range(0, len(frames), per_sheet):
            sheet = Image.new("RGB", (COLS * TILE_W, ROWS * (TILE_H + LABEL_H)), "black")
            draw = ImageDraw.Draw(sheet)
            for i, frame in enumerate(frames[sheet_index:sheet_index + per_sheet]):
                x, y = (i % COLS) * TILE_W, (i // COLS) * (TILE_H + LABEL_H)
                draw.text((x + 3, y + 1), label((sheet_index + i) * STEP_SECONDS), fill=(220, 220, 90), font=font)
                sheet.paste(Image.open(frame), (x, y + LABEL_H))
            sheet.save(out / f"sheet-{sheet_index // per_sheet:02d}.jpg", quality=88)
        return len(frames)


def returns(video: Path) -> list[dict]:
    """Spans where the frame equals one shown at least RETURN_AGO s earlier although the picture changed in between:
    a scene rebuilding from scratch, or its animation replayed. Gray 96x54 frames at 5 fps, mean absolute difference."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-vf", f"fps={RETURN_FPS},scale={RETURN_W}:{RETURN_H},format=gray",
                          "-f", "rawvideo", "-"], capture_output=True, check=True, creationflags=HIDDEN).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, RETURN_W * RETURN_H).astype(np.int16)
    ago = int(RETURN_AGO * RETURN_FPS)
    spans: list[dict] = []
    for i in range(ago + 1, len(frames)):
        diff = np.abs(frames[:i - ago] - frames[i]).mean(1)
        j = int(diff.argmin())
        if diff[j] >= RETURN_SAME or np.abs(frames[j:i] - frames[i]).mean(1).max() <= RETURN_MOVED:
            continue
        t, was = round(i / RETURN_FPS, 2), round(j / RETURN_FPS, 2)
        if spans and t - spans[-1]["end"] <= 2.0 / RETURN_FPS:
            spans[-1]["end"] = t
        else:
            spans.append({"start": t, "end": t, "matches": was})
    return spans


def audio_samples(video: Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-ac", "1", "-ar", str(AUDIO_RATE), "-f", "s16le", "-"], capture_output=True, check=True, creationflags=HIDDEN).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def whisper_words(samples: np.ndarray) -> list[dict]:
    from faster_whisper import WhisperModel

    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", cpu_threads=12)
    segments, _ = model.transcribe(samples, word_timestamps=True, language="en", vad_filter=False, beam_size=5, condition_on_previous_text=False)
    words = []
    for segment in segments:
        for word in segment.words:
            words.append({"w": word.word.strip(), "t0": round(float(word.start), 2), "t1": round(float(word.end), 2)})
    return words


def transcript(words: list[dict]) -> str:
    lines, current, start = [], [], None
    for w in words:
        if start is None:
            start = w["t0"]
        current.append(w["w"])
        if re.search(r"[.!?]$", w["w"]):
            lines.append(f"[{label(start)}] {' '.join(current)}")
            current, start = [], None
    if current:
        lines.append(f"[{label(start)}] {' '.join(current)}")
    return "\n".join(lines) + "\n"


def audio_levels(samples: np.ndarray, words: list[dict], total: float) -> str:
    rows = ["t   dB  speech"]
    hop = int(AUDIO_RATE * STEP_SECONDS)
    t = 0.0
    while t < total - 1e-6:
        chunk = samples[int(t * AUDIO_RATE): int(t * AUDIO_RATE) + hop]
        rms = float(np.sqrt(np.mean(chunk ** 2))) if len(chunk) else 0.0
        db = 20 * np.log10(max(rms, 1e-6))
        spoken = any(w["t0"] < t + STEP_SECONDS and w["t1"] > t for w in words)
        rows.append(f"{t:6.1f} {db:6.1f}{' S' if spoken else ''}")
        t += STEP_SECONDS
    return "\n".join(rows) + "\n"


def main(video: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    total = duration(video)
    frames = contact_sheets(video, out)
    samples = audio_samples(video)
    words = whisper_words(samples)
    (out / "words.json").write_text(json.dumps(words), encoding="utf-8")
    (out / "transcript.txt").write_text(transcript(words), encoding="utf-8")
    (out / "audio.txt").write_text(audio_levels(samples, words, total), encoding="utf-8")
    (out / "returns.json").write_text(json.dumps(returns(video)), encoding="utf-8")
    print(f"{video.name}: {total:.1f}s, {frames} frames, {len(words)} words -> {out}")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
