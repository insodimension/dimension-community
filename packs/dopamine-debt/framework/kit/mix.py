"""The delivery mix: every voice piece, meme, clip and sound effect of timeline.json, the music beds under them, mixed
at the film's `MixLevels` and normalised to the delivery loudness (stages.md Delivery), then muxed onto the picture."""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Callable

import numpy as np
import pyloudnorm

from framework.tools import HIDDEN

from .film import Film

RATE = 48000
GAIN_MIN_DB, GAIN_MAX_DB = -30.0, 18.0
SHORT_SECONDS = 0.4
QUIET_LUFS = -40.0
LRA = 11


def same_path(path: str) -> str:
    return path


def run(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, creationflags=HIDDEN)


def decode(path: str) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(RATE), "-f", "f32le", "-"], capture_output=True, check=True, creationflags=HIDDEN).stdout
    return np.frombuffer(raw, dtype=np.float32)


def loudness(path: str, t0: float = 0.0, t1: float | None = None) -> float:
    """Integrated loudness (LUFS) of a window; a window shorter than 0.4 s is padded with silence, silence reads -40."""
    audio = decode(path)
    audio = audio[int(t0 * RATE): int(t1 * RATE) if t1 else None]
    if len(audio) < RATE * SHORT_SECONDS:
        audio = np.pad(audio, (0, int(RATE * SHORT_SECONDS) - len(audio)))
    value = pyloudnorm.Meter(RATE).integrated_loudness(audio)
    return value if np.isfinite(value) else QUIET_LUFS


def music_spans(film: Film, timeline: dict) -> list[tuple[str, float, float]]:
    """(cue file, start, end) of each music bed (`media/music/<cue>.mp3` under the film root, so an off-machine mix
    relocates the root, not the bed): a bed starts at its line (the first at 0 s) and plays until the next."""
    starts = [0.0 if line is None else next(i["start"] for i in timeline["items"] if i.get("line") == line) for _cue, line in film.music]
    ends = starts[1:] + [timeline["duration"]]
    return [(str(film.media / "music" / f"{cue}.mp3"), a, b) for (cue, _line), a, b in zip(film.music, starts, ends)]


def build_graph(film: Film, timeline: dict, locate: Callable[[str], str] = same_path) -> tuple[list[str], str]:
    """ffmpeg inputs and the filter graph that mixes the timeline's sounds into `[mix]`. `locate` maps a path recorded
    in the timeline to this machine's copy (an off-machine mix)."""
    levels = film.levels
    items = [{**i, "file": locate(i.get("audio_file", i["file"])), "in": i.get("audio_in", i.get("in"))} for i in timeline["items"] if i["kind"] in ("voice", "meme", "clip", "sfx")]
    items = [i for i in items if i["kind"] != "meme" or i.get("audio")]
    files = sorted({i["file"] for i in items})
    inputs: list[str] = []
    index = {}
    for f in files:
        index[f] = len(inputs) // 2
        inputs += ["-i", f]
    voice_gain = {}
    for seg_file in {i["file"] for i in items if i["kind"] == "voice"}:
        voice_gain[seg_file] = levels.voice_lufs - loudness(seg_file)
    uses: dict[str, int] = {}
    for it in items:
        uses[it["file"]] = uses.get(it["file"], 0) + 1
    chains, labels = [], []
    split_labels: dict[str, list[str]] = {}
    for f, n in uses.items():
        src = f"[{index[f]}:a]aresample={RATE},aformat=channel_layouts=stereo"
        names = [f"s{index[f]}_{k}" for k in range(n)]
        chains.append(f"{src},asplit={n}" + "".join(f"[{x}]" for x in names) if n > 1 else f"{src}[{names[0]}]")
        split_labels[f] = names
    duck_spans = [(i["start"], i["end"]) for i in items if i["kind"] in ("meme", "clip")]
    for k, it in enumerate(items):
        lab = split_labels[it["file"]].pop()
        delay_ms = int(round(it["start"] * 1000))
        if it["kind"] == "voice":
            gain = voice_gain[it["file"]]
            trim = f"atrim=start={it['in']}:end={it['out']},asetpts=PTS-STARTPTS,afade=t=in:d=0.01,afade=t=out:st={it['out'] - it['in'] - 0.02:.3f}:d=0.02"
        elif it["kind"] in ("meme", "clip"):
            gain = levels.clip_lufs - loudness(it["file"], it["in"], it["out"])
            d = it["end"] - it["start"]
            trim = f"atrim=start={it['in']}:end={it['in'] + d:.3f},asetpts=PTS-STARTPTS,afade=t=in:d=0.02,afade=t=out:st={max(0, d - 0.06):.3f}:d=0.06"
        else:
            gain = levels.clip_lufs - loudness(it["file"]) + it.get("gain_db", 0)
            d = it["end"] - it["start"]
            trim = f"atrim=end={d:.3f},asetpts=PTS-STARTPTS,afade=t=out:st={max(0, d - 0.08):.3f}:d=0.08"
        gain = max(GAIN_MIN_DB, min(GAIN_MAX_DB, gain))
        out = f"a{k}"
        chains.append(f"[{lab}]{trim},volume={gain:.2f}dB,adelay={delay_ms}|{delay_ms}[{out}]")
        labels.append(out)
    duration = timeline["duration"]
    duck = "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in duck_spans) or "0"
    music_parts = []
    for n, (f, start, end) in enumerate(music_spans(film, timeline)):
        idx = inputs.count("-i")
        inputs += ["-stream_loop", "-1", "-i", f]
        gain = levels.music_lufs - loudness(f)
        chains.append(f"[{idx}:a]aresample={RATE},aformat=channel_layouts=stereo,atrim=end={end - start:.3f},asetpts=PTS-STARTPTS,"
                      f"afade=t=in:d=0.4,afade=t=out:st={max(0, end - start - 0.5):.3f}:d=0.5,volume={gain:.2f}dB,adelay={int(start * 1000)}|{int(start * 1000)}[m{n}r]")
        chains.append(f"[m{n}r]volume='if({duck},{10 ** (levels.music_duck_db / 20):.4f},1)':eval=frame[m{n}]")
        music_parts.append(f"m{n}")
    all_labels = labels + music_parts
    chains.append("".join(f"[{x}]" for x in all_labels) + f"amix=inputs={len(all_labels)}:normalize=0:dropout_transition=0,atrim=end={duration:.3f}[mix]")
    return inputs, ";\n".join(chains)


def loudnorm_two_pass(film: Film, src: Path, dst: Path) -> dict:
    """Two-pass ffmpeg loudnorm of `src` to the film's target loudness and true peak, written as 24-bit WAV."""
    target, peak = film.levels.target_lufs, film.levels.true_peak_db
    first = run(["ffmpeg", "-hide_banner", "-i", str(src), "-af", f"loudnorm=I={target}:TP={peak}:LRA={LRA}:print_format=json", "-f", "null", "-"])
    stats = json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", first.stderr, re.S).group(0))
    af = (f"loudnorm=I={target}:TP={peak}:LRA={LRA}:linear=true:measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:"
          f"measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:offset={stats['target_offset']}")
    second = run(["ffmpeg", "-hide_banner", "-y", "-i", str(src), "-af", af, "-ar", str(RATE), "-c:a", "pcm_s24le", str(dst)])
    if second.returncode:
        raise RuntimeError(second.stderr[-2000:])
    return stats


def measure(path: Path) -> dict:
    """Integrated loudness I (LUFS) and true peak TP (dBFS) of a file, from ffmpeg ebur128."""
    out = run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"]).stderr
    tail = out[out.rfind("Summary:"):]
    return {"I": float(re.search(r"I:\s+(-?[\d.]+) LUFS", tail).group(1)), "TP": float(re.search(r"Peak:\s+(-?[\d.]+) dBFS", tail).group(1))}


def mix(film: Film, video: Path, out: Path, locate: Callable[[str], str] = same_path) -> dict:
    """Mix build/timeline.json (work files in build/audio), mux it onto `video` as `out`, and return its loudness."""
    timeline = json.loads(film.timeline_file.read_text(encoding="utf-8"))
    inputs, graph = build_graph(film, timeline, locate)
    work = film.build / "audio"
    work.mkdir(exist_ok=True)
    (work / "graph.txt").write_text(graph, encoding="utf-8")
    raw = work / "mix-raw.wav"
    done = run(["ffmpeg", "-hide_banner", "-y", *inputs, "-filter_complex_script", str(work / "graph.txt"), "-map", "[mix]", "-ar", str(RATE), "-c:a", "pcm_s24le", str(raw)])
    if done.returncode:
        raise RuntimeError(done.stderr[-3000:])
    final_wav = work / "mix-final.wav"
    loudnorm_two_pass(film, raw, final_wav)
    mux = run(["ffmpeg", "-hide_banner", "-y", "-i", str(video), "-i", str(final_wav), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-ar", str(RATE), "-shortest", "-movflags", "+faststart", str(out)])
    if mux.returncode:
        raise RuntimeError(mux.stderr[-2000:])
    return {"out": str(out), "loudness": measure(out)}


STEM_GROUPS = {"voice": ("voice",), "music": (), "memes": ("meme", "clip")}


def stems(film: Film, out: Path | None = None, locate: Callable[[str], str] = same_path) -> dict[str, Path]:
    """The mix split into voice, music and meme stems (mono 16 kHz FLAC) on the film clock, from the same graph as the
    delivery mix, for G11's music level rules. Written to `out` (default build/stems)."""
    timeline = json.loads(film.timeline_file.read_text(encoding="utf-8"))
    inputs, graph = build_graph(film, timeline, locate)
    chains = graph.split(";\n")[:-1]
    items = [i for i in timeline["items"] if i["kind"] in ("voice", "meme", "clip", "sfx") and (i["kind"] != "meme" or i.get("audio"))]
    kinds = {f"a{k}": it["kind"] for k, it in enumerate(items)}
    labels = [*kinds, *(f"m{n}" for n in range(len(music_spans(film, timeline))))]
    duration = timeline["duration"]
    out = out or film.build / "stems"
    out.mkdir(parents=True, exist_ok=True)
    files = {}
    for name, ks in STEM_GROUPS.items():
        keep = [x for x in labels if (kinds.get(x) in ks if ks else x not in kinds)]
        sinks = [f"[{x}]anullsink" for x in labels if x not in keep]
        anchor = f"anullsrc=r={RATE}:cl=stereo,atrim=end={duration:.3f}[anchor]"
        tail = "[anchor]" + "".join(f"[{x}]" for x in keep) + f"amix=inputs={len(keep) + 1}:normalize=0:dropout_transition=0,atrim=end={duration:.3f}[stem]"
        script = out / f"{name}.graph.txt"
        script.write_text(";\n".join([*chains, *sinks, anchor, tail]), encoding="utf-8")
        target = out / f"{name}.flac"
        done = run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex_script", str(script), "-map", "[stem]", "-ac", "1", "-ar", "16000", "-c:a", "flac", str(target)])
        script.unlink()
        if done.returncode:
            raise RuntimeError(done.stderr[-2000:])
        files[name] = target
    return files
