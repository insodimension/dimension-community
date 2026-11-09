import json
import subprocess
from functools import lru_cache
from pathlib import Path

import numpy as np

from dd.home import WORK
from framework.tools import HIDDEN

SR = 16000
HOP = 0.01
CLEAN_DB = -18.0
SPEECH_CACHE = WORK / "speech-cache.json"
_model = None


def _pcm(src, a, b):
    args = ["ffmpeg", "-v", "error", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", str(src), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    return np.nan_to_num(np.frombuffer(subprocess.run(args, capture_output=True, creationflags=HIDDEN, timeout=300).stdout, dtype=np.float32))


@lru_cache(maxsize=None)
def _frames(src, a, b):
    x = _pcm(src, a, b)
    n = int(HOP * SR)
    k = len(x) // n
    return 20 * np.log10(np.sqrt((x[: k * n].reshape(k, n) ** 2).mean(1)) + 1e-9)


@lru_cache(maxsize=None)
def body(src, a=0.0, b=36000.0):
    f = _frames(src, a, b)
    return float(np.percentile(f, 70)) if len(f) else -90.0


def point(src, lo, hi, ref=None, prefer=None):
    lo = max(0.0, lo)
    if hi - lo < HOP:
        hi = lo + HOP
    f = _frames(src, round(lo, 3), round(hi, 3))
    if not len(f):
        return round(lo, 3), -90.0
    ref = body(src) if ref is None else ref
    rel = f - ref
    ok = np.where(rel <= rel.min() + 3.0)[0]
    if prefer == "early":
        i = int(ok[0])
    elif prefer == "late":
        i = int(ok[-1])
    else:
        i = int(rel.argmin())
    return round(lo + (i + 0.5) * HOP, 3), round(float(rel[i]), 1)


def speech(src, a, b):
    global _model
    cache = json.loads(SPEECH_CACHE.read_text(encoding="utf-8")) if SPEECH_CACHE.exists() else {}
    st = Path(src).stat()
    key = f"{src}|{st.st_size}|{st.st_mtime_ns}|{a:.2f}|{b:.2f}"
    if key not in cache:
        from faster_whisper import WhisperModel
        if _model is None:
            _model = WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=6)
        segs, _ = _model.transcribe(_pcm(src, a, b), word_timestamps=True, vad_filter=False)
        cache[key] = [[w.word.strip(), round(a + w.start, 3), round(a + w.end, 3)] for s in segs for w in s.words]
        SPEECH_CACHE.write_text(json.dumps(cache, indent=1), encoding="utf-8")
    return cache[key]


def clip_edges(src, a0, z0):
    ws = speech(src, max(0.0, a0 - 1.5), z0 + 1.5)
    for _, s, e in ws:
        if s < a0 < e:
            a0 = s - 0.03
        if s < z0 < e:
            z0 = e + 0.05
    ref = body(src, round(a0, 3), round(z0, 3))
    a, ra = point(src, a0 - 0.12, a0 + 0.02, ref=ref, prefer="late") if a0 > 0.12 else (0.0, -90.0)
    z, rz = point(src, z0 - 0.02, z0 + 0.2, ref=ref, prefer="early")
    for _, s, e in ws:
        if s + 0.02 < a < e:
            a = max(0.0, s - 0.02)
        if s < z < e - 0.02:
            z = e + 0.02
    said = [w[0] for w in ws if a <= w[1] + 0.02 and w[2] <= z + 0.02]
    cut = [w[0] for w in ws if (w[1] + 0.02 < a < w[2]) or (w[1] < z < w[2] - 0.02)]
    return round(a, 3), round(z, 3), ra, rz, said, cut
