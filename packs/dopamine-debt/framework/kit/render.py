"""A kit film's render and its proof: the HyperFrames picture, the delivery mix, the decode and A/V checks, and the
render's instrument (`proof/film-X`). A film's `build/render.py` calls `main(FILM)`; `--mix-only` reuses the picture."""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys

from framework.tools import HIDDEN

from . import instrument, mix
from .film import Film

HYPERFRAMES = "hyperframes@0.8.217"
FRAME_SIZE = (1920, 1080)
AV_GAP_MAX = 0.05
RENDER_TIMEOUT_SECONDS = 90 * 60


def probe(path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_entries",
                          "stream=codec_type,width,height,r_frame_rate,nb_read_frames,duration:format=duration",
                          "-of", "json", str(path)], capture_output=True, text=True, check=True, creationflags=HIDDEN).stdout
    return json.loads(out)


def main(film: Film, mix_only: bool = False) -> None:
    """Render `build/film` to `build/renders/picture.mp4`, mix it into `renders/<production>-1080p.mp4`, check it decodes
    end to end at 1920x1080 with A/V within AV_GAP_MAX, then write `proof/film-X`. Exits with the failed check."""
    picture = film.build / "renders" / "picture.mp4"
    final = film.root / "renders" / f"{film.root.name}-1080p.mp4"
    picture.parent.mkdir(parents=True, exist_ok=True)
    final.parent.mkdir(parents=True, exist_ok=True)
    if not mix_only:
        print("render: start", flush=True)
        proc = subprocess.Popen([shutil.which("npx") or "npx", "-y", HYPERFRAMES, "render", "-o", os.path.relpath(picture, film.page_dir), "--fps", "30",
                                 "--resolution", "1080p", "--crf", "18", "--quiet"], cwd=film.page_dir,
                                creationflags=HIDDEN, start_new_session=os.name != "nt")
        try:
            code = proc.wait(timeout=RENDER_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, creationflags=HIDDEN)
            else:
                os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
            sys.exit(f"render failed: hyperframes did not finish within {RENDER_TIMEOUT_SECONDS // 60} minutes; {picture} is incomplete")
        if code:
            sys.exit(f"render failed: hyperframes exited with code {code}")
        print("render: done", flush=True)
    loud = mix.mix(film, picture, final)
    print("mix:", json.dumps(loud["loudness"]), flush=True)
    dec = subprocess.run(["ffmpeg", "-v", "error", "-i", str(final), "-f", "null", "-"], capture_output=True, text=True, creationflags=HIDDEN)
    if dec.returncode or dec.stderr.strip():
        sys.exit(f"decode failed: {dec.stderr[:400]}")
    info = probe(final)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    a = next(s for s in info["streams"] if s["codec_type"] == "audio")
    gap = abs(float(v["duration"]) - float(a["duration"]))
    print(f"check: {v['width']}x{v['height']} {v['r_frame_rate']} frames {v['nb_read_frames']} A/V gap {gap:.3f}s", flush=True)
    if (v["width"], v["height"]) != FRAME_SIZE or gap >= AV_GAP_MAX:
        sys.exit(f"check failed: not {FRAME_SIZE[0]}x{FRAME_SIZE[1]} or A/V gap >= {AV_GAP_MAX} s")
    instrument.main(final, film.root / "proof" / "film-X")
    print("final:", final, flush=True)
