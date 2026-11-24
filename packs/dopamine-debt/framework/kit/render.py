"""A kit film's render and its proof: the HyperFrames picture, the delivery mix, the decode and A/V checks, and the
render's instrument (`proof/film-X`). A film's `build/render.py` calls `main(FILM)`; `--mix-only` reuses the picture and
`--draft` makes a viewing copy (15 fps, HyperFrames draft quality, no proof) at `renders/<production>-draft.mp4`."""
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
DRAFT_FPS = 15


def probe(path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_entries",
                          "stream=codec_type,width,height,r_frame_rate,nb_read_frames,duration:format=duration",
                          "-of", "json", str(path)], capture_output=True, text=True, check=True, creationflags=HIDDEN).stdout
    return json.loads(out)


def main(film: Film, mix_only: bool = False, draft: bool = False) -> None:
    """Render `build/film` to `build/renders/picture.mp4`, mix it into `renders/<production>-1080p.mp4`, check it decodes
    end to end at 1920x1080 with A/V within AV_GAP_MAX, then write `proof/film-X`. Exits with the failed check.
    `draft` (or `--draft` on the command line, so a film's older `build/render.py` takes it too) renders half the frames
    at draft quality into `-draft` files and skips the proof: a copy to watch, not to ship."""
    draft = draft or "--draft" in sys.argv
    tag = "draft" if draft else "1080p"
    picture = film.build / "renders" / f"picture{'-draft' if draft else ''}.mp4"
    final = film.root / "renders" / f"{film.root.name}-{tag}.mp4"
    picture.parent.mkdir(parents=True, exist_ok=True)
    final.parent.mkdir(parents=True, exist_ok=True)
    if not mix_only:
        print("render: start", flush=True)
        quality = ["--fps", str(DRAFT_FPS), "--quality", "draft"] if draft else ["--fps", "30", "--crf", "18"]
        proc = subprocess.Popen([shutil.which("npx") or "npx", "-y", HYPERFRAMES, "render", "-o", os.path.relpath(picture, film.page_dir),
                                 *quality, "--resolution", "1080p", "--quiet"], cwd=film.page_dir,
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
    gap_max = 1 / DRAFT_FPS if draft else AV_GAP_MAX
    if (v["width"], v["height"]) != FRAME_SIZE or gap >= gap_max:
        sys.exit(f"check failed: not {FRAME_SIZE[0]}x{FRAME_SIZE[1]} or A/V gap >= {gap_max:.3f} s")
    if not draft:
        instrument.main(final, film.root / "proof" / "film-X")
    print("final:", final, flush=True)
