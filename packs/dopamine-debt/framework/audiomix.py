import json
import subprocess
import wave
from pathlib import Path

import numpy as np
import pyloudnorm
import soundfile
from scipy.ndimage import minimum_filter1d, uniform_filter1d
from scipy.signal import resample_poly

from framework.tools import HIDDEN

SR = 48000
FADE = 0.012


def decode(src, a=None, b=None, lufs=None):
    args = ["ffmpeg", "-v", "error"]
    if a is not None:
        args += ["-ss", f"{a:.3f}"]
    if b is not None:
        args += ["-to", f"{b:.3f}"]
    args += ["-i", str(src)]
    if lufs is not None:
        args += ["-af", f"loudnorm=I={lufs}:TP=-2:LRA=11"]
    args += ["-ac", "2", "-ar", str(SR), "-f", "f32le", "-"]
    raw = subprocess.run(args, capture_output=True, creationflags=HIDDEN, timeout=300).stdout
    x = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).copy()
    if not np.isfinite(x).all():
        if lufs is not None:
            return decode(src, a, b, None)
        x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    n = min(len(x), int(FADE * SR))
    if n:
        ramp = np.linspace(0, 1, n, dtype=np.float32)[:, None]
        x[:n] *= ramp
        x[-n:] *= ramp[::-1]
    return x


def place(buf, x, t, gain_db=0.0):
    i = int(round(t * SR))
    if i >= len(buf):
        return
    j = min(len(buf), i + len(x))
    buf[i:j] += x[: j - i] * (10 ** (gain_db / 20))


def free_slot(words, t0, length, t_max):
    t = t0
    for s, e in words:
        if e <= t:
            continue
        if s >= t + length:
            break
        t = e + 0.02
    return t if t <= t_max else None


def write_wav(buf, out_wav):
    out_wav = Path(out_wav)
    out_wav.parent.mkdir(exist_ok=True)
    peak = float(np.abs(buf).max())
    if peak > 0.98:
        buf = buf * (0.98 / peak)
    pcm = (buf * 32767).astype("<i2")
    with wave.open(str(out_wav), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return peak


def measure(src, target, tp, extra=""):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(src), "-af", f"loudnorm=I={target}:TP={tp}:LRA=11{extra}:print_format=json", "-f", "null", "-"], capture_output=True, text=True, creationflags=HIDDEN)
    return json.loads(r.stderr[r.stderr.rfind("{"): r.stderr.rfind("}") + 1])


def loudnorm(src, out, target=-14.0, tp=-1.5):
    m = measure(src, target, tp)
    af = f"loudnorm=I={target}:TP={tp}:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-af", af, "-ar", str(SR), "-c:a", "pcm_s24le", str(out)], check=True, creationflags=HIDDEN)
    j = measure(out, target, tp)
    return {"before_lufs": m["input_i"], "after_lufs": j["input_i"], "after_tp": j["input_tp"]}


def true_peak_gain(x, ceiling_db, hold=0.01):
    pad, step = 256, SR * 10
    pk = np.empty(len(x), dtype=np.float32)
    for i in range(0, len(x), step):
        a, b = max(0, i - pad), min(len(x), i + step + pad)
        o = np.abs(resample_poly(x[a:b], 4, 1, axis=0)).max(1)
        o = np.pad(o, (0, (-len(o)) % 4)).reshape(-1, 4).max(1)
        pk[i: min(len(x), i + step)] = o[i - a: i - a + min(step, len(x) - i)]
    need = np.minimum(1.0, 10 ** (ceiling_db / 20) / np.maximum(pk, 1e-9)).astype(np.float32)
    w = max(1, int(hold * SR))
    return uniform_filter1d(minimum_filter1d(need, size=2 * w + 1), size=w)


def master(x, out, target=-14.0, tp=-1.5, margin=0.4, rounds=4):
    meter = pyloudnorm.Meter(SR)
    gain_db = target - meter.integrated_loudness(x.astype(np.float64))
    for _ in range(rounds):
        lift = np.float32(10 ** (gain_db / 20))
        g = true_peak_gain(x * lift, tp - margin)
        y = x * (lift * g)[:, None]
        miss = target - meter.integrated_loudness(y.astype(np.float64))
        if abs(miss) < 0.05:
            break
        gain_db += miss
    soundfile.write(str(out), y, SR, subtype="PCM_24")
    j = measure(out, target, tp)
    return {"gain_db": round(float(gain_db), 2), "limited_ms": round(float((g < 0.999).sum()) / SR * 1000, 1), "min_limiter_db": round(float(20 * np.log10(g.min())), 2),
            "after_lufs": j["input_i"], "after_tp": j["input_tp"], "after_lra": j["input_lra"]}, lift * g
