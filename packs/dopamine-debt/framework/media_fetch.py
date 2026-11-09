import json
import subprocess
from pathlib import Path

from framework.tools import HIDDEN, YTDLP

FORMAT_720_1080 = "bv*[height<=1080][height>=720]+ba/b[height<=1080][height>=720]"


def run(args, timeout=600):
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=HIDDEN, timeout=timeout)


def search(query, n=8):
    out = run([YTDLP, f"ytsearch{n}:{query}", "--flat-playlist", "-J", "--no-warnings"], 180)
    data = json.loads(out.stdout or "{}")
    return [{"id": e.get("id"), "title": e.get("title"), "dur": e.get("duration"), "channel": e.get("channel") or e.get("uploader")} for e in data.get("entries", [])]


def best_height(url):
    out = run([YTDLP, url, "-J", "--no-warnings", "--no-playlist"], 180)
    if out.returncode:
        return 0, out.stderr[-300:]
    info = json.loads(out.stdout)
    hs = [f.get("height") or 0 for f in info.get("formats", []) if f.get("vcodec") not in (None, "none")]
    return max(hs or [0]), {"title": info.get("title"), "channel": info.get("channel") or info.get("uploader"), "duration": info.get("duration")}


def download(dest_dir, url, start=None, end=None):
    d = Path(dest_dir)
    d.mkdir(parents=True, exist_ok=True)
    args = [YTDLP, url, "--no-playlist", "--no-warnings", "-f", FORMAT_720_1080, "--merge-output-format", "mp4", "-o", str(d / "src.%(ext)s"), "--force-overwrites"]
    if start is not None:
        args += ["--download-sections", f"*{start}-{end}", "--force-keyframes-at-cuts"]
    out = run(args, 900)
    f = d / "src.mp4"
    return f if f.exists() else None, out.stderr[-400:]


def probe(f):
    out = run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", str(f)])
    return json.loads(out.stdout)


def sheet(f, out, every=0.25, cols=8, limit=48):
    dur = float(probe(f)["format"]["duration"])
    step = max(every, dur / limit)
    run(["ffmpeg", "-v", "error", "-y", "-i", str(f), "-vf", f"fps=1/{step},scale=240:-2,drawtext=text='%{{pts\\:hms}}':x=4:y=4:fontsize=18:fontcolor=yellow:box=1:boxcolor=black@0.6,tile={cols}x{max(1, min(limit, int(dur / step) + 1) // cols + 1)}", "-frames:v", "1", str(out)])
    return step
