"""The SEEN read's engine directory for a kit film (SKILL F-15): every lines.json row on the real cut clock.

Units come from build/timeline.json: a narrator row spans its voice item, a meme row its meme item(s), a creator clip
row its clip item(s). Each unit holds the frame description a viewer reads (`picture`, written by whoever looked at
the frames, never the builder's intent), its measured `sound`, and for a meme the `display` seen in the frames
(full | cutout | ghost | inset). Gaps between units are folded into the unit before, so the segments cover the film.

    seen.frames(film, video, out)      frames per unit from the render where the eye rests (`shot_times`: first look,
                                       each picture's settled state) + index.json, for whoever writes the descriptions
                                       (a fresh reader who sees only the frames)
    seen.write(film, descriptions, audiences, out=film.revision / "framework" / "seen")

`descriptions` is {row id: {"picture": str, "display"?: str}}; a row with none is an error, never a default.
"""
from __future__ import annotations

import json
from pathlib import Path

import yaml

from framework.scriptstage import write_engine_dir
from framework.tools import HIDDEN

from .film import Film

KEYS = ("plants", "calls", "opens", "pays", "confirms_promise")
DISPLAYS = ("full", "cutout", "ghost", "inset")


def _spans(film: Film, lines: list[dict], timeline: dict) -> dict[str, tuple[float, float]]:
    rows = {r["id"]: r for r in lines}
    by_lib: dict[str, str] = {}
    for r in lines:
        if r.get("speaker") == "meme":
            for lib in (r.get("meme") or {}).get("parts") or [r["pictures"][0]["id"]]:
                by_lib[lib] = r["id"]
    spans: dict[str, tuple[float, float]] = {}

    def grow(uid: str, a: float, b: float) -> None:
        lo, hi = spans.get(uid, (a, b))
        spans[uid] = (min(lo, a), max(hi, b))

    for it in timeline["items"]:
        if it["kind"] == "voice" or (it["kind"] == "clip" and rows.get(it["line"], {}).get("speaker") == "clip"):
            grow(it["line"], it["start"], it["end"])
        elif it["kind"] == "meme":
            uid = by_lib.get(it["lib"])
            if uid is None:
                raise ValueError(f"meme {it['lib']} at {it['start']} s has no meme row in lines.json")
            grow(uid, it["start"], it["end"])
    missing = [r["id"] for r in lines if r["id"] not in spans]
    if missing:
        raise ValueError(f"rows with no span on the cut: {missing}")
    return spans


def segments(film: Film, descriptions: dict[str, dict]) -> tuple[list[dict], float]:
    lines = json.loads(film.lines_file.read_text(encoding="utf-8"))
    timeline = json.loads(film.timeline_file.read_text(encoding="utf-8"))
    spans = _spans(film, lines, timeline)
    order = sorted(lines, key=lambda r: spans[r["id"]][0])
    dur = float(timeline["duration"])
    out = []
    for i, r in enumerate(order):
        d = descriptions.get(r["id"])
        if not d or not d.get("picture"):
            raise ValueError(f"{r['id']}: no seen description of its frames")
        t0 = 0.0 if i == 0 else round(spans[r["id"]][0], 3)
        t1 = round(spans[order[i + 1]["id"]][0], 3) if i + 1 < len(order) else dur
        s = {"id": r["id"], "act": r["act"], "bit": r["bit"], "carries": list(r.get("carries", [])), "t0": t0, "t1": t1,
             "dur": round(t1 - t0, 3), "picture": d["picture"]}
        s.update({k: r[k] for k in KEYS if r.get(k)})
        if r["kind"] == "voice":
            s.update(kind="voice", line=r["text"], sound="the narrator's voice; music bed under it")
        else:
            m = r.get("meme") or {}
            heard = m.get("line") or ""
            disp = d.get("display")
            if r.get("speaker") == "meme" and disp not in DISPLAYS:
                raise ValueError(f"{r['id']}: a meme needs a seen display, one of {DISPLAYS}")
            gag = m.get("library") or m.get("tag") or r["pictures"][0]["id"]
            s.update(kind="clip", sound_line=heard, library=gag, gag_id=gag, mode=m.get("mode"),
                     sound=f"the clip's own audio: \"{heard}\"; narration paused; music ducked" if heard else "the clip plays with a vine boom; no words")
            if disp:
                s["display"] = disp
        out.append(s)
    return out, dur


def write(film: Film, descriptions: dict[str, dict], audiences: dict[str, str], out: Path | None = None) -> Path:
    from dd.units import validate
    segs, dur = segments(film, descriptions)
    errs = validate(segs, dur)
    if errs:
        raise ValueError("\n".join(errs))
    rev = film.revision
    if rev is None:
        raise ValueError("a SEEN read needs Film.revision (the gate's film revision)")
    intent = json.loads((rev / "intent.json").read_text(encoding="utf-8"))
    spine = yaml.safe_load(film.spine_file.read_text(encoding="utf-8"))
    out = out or rev / "framework" / "seen"
    return write_engine_dir(out, segs, intent, spine, audiences, f"{rev.parent.name} {rev.name} seen", "seen", rev / "framework" / "script")


PICTURE_KINDS = ("mg", "doc", "post", "clip", "meme", "broll")
SETTLE_BEFORE_END = 0.3  # a picture's last held state: its entrances and count-ups have landed, its exit has not begun
FIRST_LOOK = 0.4         # the unit's first picture, once its entrance has played


def shot_times(a: float, b: float, items: list[dict], least: int = 3, most: int = 4) -> list[float]:
    """Where a viewer's eye rests in unit [a, b]: its first picture once in, then each picture's settled state (just
    before that picture ends or the unit does), then the middle of the longest stretch between those until there are
    `least`. Fixed fractions of the span alone catch count-ups mid-roll and bars mid-growth, so the reader describes
    numbers the film never lands on."""
    ends = sorted({round(min(it["end"], b) - SETTLE_BEFORE_END, 3) for it in items
                   if it["kind"] in PICTURE_KINDS and it["start"] < b and it["end"] > a})
    times = [round(min(a + FIRST_LOOK, (a + b) / 2), 3)] + [t for t in ends if t > a + FIRST_LOOK + 0.3]
    times = times[:1] + times[1:][-(most - 1):]
    while len(times) < least and b - a > 1.0:
        edges = [a, *times, b]
        lo, hi = max(zip(edges, edges[1:]), key=lambda g: g[1] - g[0])
        times = sorted([*times, round((lo + hi) / 2, 3)])
    return times


def frames(film: Film, video: Path, out: Path) -> Path:
    """JPEG frames per unit at `shot_times`, cut from the rendered film, and out/index.json {row id: {t0, t1, speaker, frames}}."""
    import subprocess
    lines = json.loads(film.lines_file.read_text(encoding="utf-8"))
    timeline = json.loads(film.timeline_file.read_text(encoding="utf-8"))
    spans = _spans(film, lines, timeline)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.jpg"):
        old.unlink()
    index = {}
    for r in lines:
        a, b = spans[r["id"]]
        shots = []
        for k, t in enumerate(shot_times(a, b, timeline["items"])):
            dst = out / f"{r['id']}-{k}.jpg"
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", str(video), "-frames:v", "1", "-q:v", "3",
                            "-vf", "scale=960:-2", str(dst)], check=True, creationflags=HIDDEN)
            shots.append({"t": t, "file": dst.name})
        index[r["id"]] = {"t0": round(a, 3), "t1": round(b, 3), "speaker": r["speaker"], "frames": shots}
    (out / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    return out / "index.json"
