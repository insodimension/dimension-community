"""lines.json + the voice takes -> timeline.json: every voice piece, clip, meme, sound effect and picture on the film clock."""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import numpy as np

from framework.tools import HIDDEN

from .film import Film
from .voice import CUT_AIR, VOICE_RATE, frames_db, timings_from_voice, voice_pcm

PAUSE_MIN, PAUSE_MAX = 0.14, 0.42
SEGMENT_JOIN_PAUSE = 0.28
FILM_START = 0.12
CLIP_AFTER_GAP = 0.12
END_HOLD_SECONDS = 0.9
MEME_LEAD_BEFORE_PAYOFF = 0.75
MEME_TAIL_AFTER_PAYOFF = 0.85
MEME_MIN_SECONDS = 1.1
SILENT_MEME_SECONDS = 1.45
SILENT_MEME_OVERLAP = 0.0
AUDIBLE_RMS_DBFS = -35.0
STATEMENT_GAP = 0.6
STATEMENT_LEAD, STATEMENT_TAIL = 0.15, 0.45
STATEMENT_MAX_SECONDS = 6.0
SILENT_BOOM_CLEAR = 0.7
SFX_CLEAR = 0.6
SFX_AUDIBLE_DB = 30
STICKER_MIN_SECONDS = 1.2
CUE_LEAD = 0.2
SFX_FILES = {
    "vine-boom": "sound-vine-boom-91c517be",
    "record-scratch": "sound-record-scratch-9bfae94b",
    "crickets": "sound-crickets-awkward-silence-b76e34d0",
    "bruh": "sound-bruh-48723c61",
    "xp-error": "sound-windows-xp-error-93d8fa8b",
    "sad-violin": "sound-sad-violin-7b985158",
    "get-over-here": "sound-get-over-here-bb51fcf9",
    "cash": "sound-cash-register-cha-ching-3fd7da7b",
    "stamp": "sound-stamp-f71839f5",
    "chomp": "sound-stamp-f71839f5",
    "impact": "sound-bass-drop-impact-69a70a47",
    "shutter": "sound-camera-shutter-click-74eb0bea",
    "ding": "sound-typewriter-bell-ding-7b5222af",
}
SILENT_MEME_SFX = "vine-boom"
STICKER_SFX = "stamp"
BASE_KINDS = ("DOC", "POST", "CUT", "BROLL", "TAG")
HELD_TO_END = ("cutout", "sticker", "doc", "post", "stock", "tag", "mg")
_whisper = None


@dataclass
class Item:
    kind: str
    start: float
    end: float
    data: dict = field(default_factory=dict)

    def json(self) -> dict:
        return {"kind": self.kind, "start": round(self.start, 3), "end": round(self.end, 3), **self.data}


def library_entry(film: Film, lib_id: str) -> dict:
    return json.loads((film.library / lib_id / "entry.json").read_text(encoding="utf-8"))


def meme_cut(film: Film, lib_id: str, span: tuple[float, float] | None = None) -> dict:
    """A meme plays its whole statement: the spoken phrase that holds the payoff, from its first word to its last plus a beat.

    A script `span` (in, out) overrides it; a clip with no words keeps the window around the payoff. A window quieter
    than AUDIBLE_RMS_DBFS cannot carry its beat and plays silent. `picture` is the library's frame inside letterbox bars."""
    entry = library_entry(film, lib_id)
    lo, hi = entry.get("inSeconds") or 0.0, entry.get("outSeconds") or entry["durationSeconds"]
    path = str(film.library / lib_id / entry["file"])
    phrase = None
    if span:
        start, end = max(lo, span[0]), min(hi, span[1])
    else:
        payoff = entry["payoff"]["atSeconds"]
        phrase = statement_around(film, path, lo, hi, payoff, entry["payoff"]["line"]) if spoken_payoff(entry) else None
        if phrase:
            start = max(lo, phrase[0] - STATEMENT_LEAD, phrase[2] + 0.05)
            end = min(hi, phrase[1] + STATEMENT_TAIL, phrase[3] - 0.05)
        else:
            start = max(lo, payoff - MEME_LEAD_BEFORE_PAYOFF)
            end = min(hi, payoff + MEME_TAIL_AFTER_PAYOFF)
        if end - start < MEME_MIN_SECONDS:
            start = max(lo, end - MEME_MIN_SECONDS)
            end = min(hi, start + MEME_MIN_SECONDS)
    audio = spoken_payoff(entry) and (bool(span) or phrase is not None or window_rms_dbfs(path, start, end) > AUDIBLE_RMS_DBFS)
    return {"lib": lib_id, "file": path, "in": round(start, 3), "out": round(end, 3), "audio": audio, "w": entry["width"], "h": entry["height"],
            "alpha": bool(entry.get("alpha")), "picture": entry.get("picture")}


def spoken_payoff(entry: dict) -> bool:
    """A meme whose payoff is a spoken line plays its own sound; a reaction face's background audio is not the joke."""
    return bool(entry["hasOwnAudio"]) and bool((entry["payoff"].get("line") or "").strip())


def statement_around(film: Film, path: str, lo: float, hi: float, payoff: float, line: str) -> tuple[float, float, float, float] | None:
    """(first word start, last word end, previous word end, next word start) of the statement that says the payoff line
    (else the one nearest the payoff time). A statement is a run of words that ends at a pause of STATEMENT_GAP or a
    sentence end; one longer than STATEMENT_MAX_SECONDS is a monologue, and the payoff window is kept instead (None)."""
    words = [w for w in clip_words(film, path) if w[1] > lo and w[0] < hi]
    if not words:
        return None
    runs, a = [], 0
    for i in range(len(words)):
        last = i == len(words) - 1
        if last or words[i + 1][0] - words[i][1] >= STATEMENT_GAP or words[i][2].rstrip().endswith((".", "!", "?")):
            runs.append((a, i))
            a = i + 1
    want = {token(t) for t in line.split()} - {""}

    def score(run: tuple[int, int]) -> tuple[int, float]:
        said = {token(words[k][2]) for k in range(run[0], run[1] + 1)}
        return (-len(want & said), min(abs(words[run[0]][0] - payoff), abs(words[run[1]][1] - payoff), 0 if words[run[0]][0] <= payoff <= words[run[1]][1] else 99))

    a, b = min(runs, key=score)
    if words[b][1] - words[a][0] > STATEMENT_MAX_SECONDS:
        return None
    return words[a][0], words[b][1], (words[a - 1][1] if a else -1.0), (words[b + 1][0] if b + 1 < len(words) else hi + 1.0)


def clip_words(film: Film, path: str) -> list[tuple[float, float, str]]:
    """Word timings of a library clip, transcribed once (CPU Whisper) and cached in the film's word cache by file content."""
    global _whisper
    cache = json.loads(film.word_cache.read_text(encoding="utf-8")) if film.word_cache.exists() else {}
    key = f"{Path(path).parent.name}/{Path(path).stat().st_size}"
    if key not in cache:
        from faster_whisper import WhisperModel
        _whisper = _whisper or WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=8)
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True, creationflags=HIDDEN).stdout
        segments, _ = _whisper.transcribe(np.frombuffer(raw, dtype=np.float32), word_timestamps=True, language="en", vad_filter=False)
        cache[key] = [[round(w.start, 3), round(w.end, 3), w.word.strip()] for s in segments for w in s.words]
        film.word_cache.parent.mkdir(parents=True, exist_ok=True)
        film.word_cache.write_text(json.dumps(cache, indent=0), encoding="utf-8")
    return [tuple(w) for w in cache[key]]


@lru_cache(maxsize=None)
def window_rms_dbfs(path: str, t0: float, t1: float) -> float:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t0:.3f}", "-to", f"{t1:.3f}", "-i", path, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"],
                         capture_output=True, creationflags=HIDDEN).stdout
    samples = np.frombuffer(raw, dtype=np.float32)
    return -120.0 if samples.size == 0 else float(20 * np.log10(np.sqrt(np.mean(samples ** 2)) + 1e-9))


def sfx_file(film: Film, name: str) -> str:
    lib_id = SFX_FILES[name]
    return str(film.library / lib_id / library_entry(film, lib_id)["file"])


@lru_cache(maxsize=None)
def _audible_seconds(path: str) -> float:
    pcm = voice_pcm(path)
    t, db = frames_db(pcm, 0.0, len(pcm) / VOICE_RATE)
    loud = t[db >= db.max() - SFX_AUDIBLE_DB]
    return round(float(loud[-1]) + 0.05, 3)


def sfx_seconds(film: Film, name: str) -> float:
    """How long a sound effect is heard: to the last 10 ms frame within SFX_AUDIBLE_DB of its peak, plus a short decay."""
    return _audible_seconds(sfx_file(film, name))


def keyed_part(film: Film, part: dict) -> dict:
    """A cutout meme without alpha plays its keyed copy (`media/keyed/<lib>.json`) for picture and the original for sound."""
    record = json.loads((film.media / "keyed" / f"{part['lib']}.json").read_text(encoding="utf-8"))
    offset = record["source_in"]
    return {**part, "audio_file": part["file"], "audio_in": part["in"], "file": record["file"], "in": round(part["in"] - offset, 3), "out": round(part["out"] - offset, 3)}


def clip_record(film: Film, clip_id: str) -> dict:
    """A creator clip (`media/clips/<id>.json`) and its pieces: `cuts` in the record are source ranges a jump cut drops
    (each measured in the clip's own quiet, so a creator's pause never reaches 1 s of dead air, G11 no-dead-air)."""
    record = json.loads((film.media / "clips" / f"{clip_id}.json").read_text(encoding="utf-8"))
    edges = [record["in"], *(t for cut in sorted(record.get("cuts", [])) for t in cut), record["out"]]
    return {"file": str(film.media / "clips" / record["file"]), "audio": True, "w": record["w"], "h": record["h"],
            "creator": record.get("creator"), "pieces": list(zip(edges[::2], edges[1::2]))}


def _cut_part(part: dict, cuts: list[list[float]]) -> list[dict]:
    """A meme part split at the MEME row's `cuts`: source ranges (in the part's own file) a jump cut drops, each measured
    inside the clip's own silent beat so it never holds 1 s of dead air (G11 no-dead-air), as a creator clip's `cuts`."""
    inside = sorted((a, b) for a, b in cuts if part["in"] < a < b < part["out"])
    edges = [part["in"], *(t for cut in inside for t in cut), part["out"]]
    return [{**part, "in": round(a, 3), "out": round(b, 3)} for a, b in zip(edges[::2], edges[1::2])]


def token(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum())


def sticker_time(words: list, line_start: float, line_end: float, text: str) -> float:
    """Land the sticker on the first spoken word it echoes; with no echo, a little past the line's middle."""
    if not words:
        return line_start
    echo = {t for t in (token(w) for w in text.split()) if len(t) >= 3 or t.isdigit()}
    hit = next((w for w in words if token(w[0]) in echo), None)
    pick = hit or words[max(0, int(len(words) * 0.55))]
    return min(line_start + (pick[1] - words[0][1]), line_end - STICKER_MIN_SECONDS * 0.6)


def cue_time(words: list, w: str, nth: int, line_id: str) -> float:
    """Film time a picture changes on: the nth spoken word equal to `w` (a trailing * matches a prefix), minus the
    scene lead, so the new picture is up as the word is heard."""
    prefix, want = w.endswith("*"), token(w)
    hits = [s for text, s, _e in words if (token(text).startswith(want) if prefix else token(text) == want)]
    if len(hits) < nth:
        raise ValueError(f'{line_id}: picture cue "{w}" (#{nth}) is not in its narration: {" ".join(t for t, _, _ in words)!r}')
    return max(words[0][1], hits[nth - 1] - CUE_LEAD)


def memes_by_line(lines: list[dict]) -> dict[str, tuple[dict, list[str]]]:
    """{narrator line id: (MEME picture, library ids played in turn)} from each `speaker: "meme"` row. A meme row is the
    punch of the narrator line right before it and plays on that line's clock: its `pictures[0]` is the MEME (placement
    fields), its `meme.parts` the library ids in order (default: the picture's id alone)."""
    out: dict[str, tuple[dict, list[str]]] = {}
    for k, row in enumerate(lines):
        if row["speaker"] != "meme":
            if any(p["k"] == "MEME" for p in row["pictures"]):
                raise ValueError(f"{row['id']}: a MEME picture belongs on its own speaker: \"meme\" row after the line it punches")
            continue
        prev = lines[k - 1] if k else None
        if prev is None or prev["speaker"] != "narrator":
            raise ValueError(f"meme row {row['id']} does not follow a narrator line: a meme punches the narrator line before it")
        pic = row["pictures"][0]
        parts = (row.get("meme") or {}).get("parts") or [pic["id"]]
        if pic["k"] != "MEME" or parts[0] != pic["id"]:
            raise ValueError(f"meme row {row['id']}: pictures[0] must be the MEME whose id is meme.parts[0], got {pic} and parts {parts}")
        out[prev["id"]] = (pic, parts)
    return out


def build(film: Film, lines: list[dict], timings: dict) -> dict:
    """The timeline: {duration, desk_until, items} with items sorted by start (README.md, timeline.json)."""
    items: list[Item] = []
    cursor = FILM_START
    desk_until = None if film.desk_until_line else 0.0
    open_mg: tuple[Item, str] | None = None
    narrator = [line for line in lines if line["speaker"] == "narrator"]
    next_line = {a["id"]: b["id"] for a, b in zip(narrator, narrator[1:])}
    memes = memes_by_line(lines)
    for line in lines:
        if line["speaker"] == "meme":
            continue
        pics = line["pictures"]
        if line["id"] == film.desk_until_line:
            desk_until = cursor
        if line["speaker"] == "clip":
            clip = clip_record(film, pics[0]["id"])
            credit_at = {"credit_at": pics[0]["credit_at"]} if "credit_at" in pics[0] else {}
            for a, b in clip.pop("pieces"):
                items.append(Item("clip", cursor, cursor + b - a, {"line": line["id"], **clip, "in": a, "out": b, "franchise": pics[0].get("franchise"), **credit_at}))
                cursor += b - a
            cursor += CLIP_AFTER_GAP
            continue
        t = timings[line["id"]]
        piece_in, piece_out = t["cut_in"], t["cut_out"]
        nxt = next_line.get(line["id"])
        consecutive = bool(nxt) and timings[nxt]["seg"] == t["seg"] and t["gap_after"] is not None and abs(t["t1"] + t["gap_after"] - timings[nxt]["t0"]) < 1e-3
        heard = min(PAUSE_MAX, max(PAUSE_MIN, timings[nxt]["cut_in"] - piece_out + 2 * CUT_AIR)) if consecutive else SEGMENT_JOIN_PAUSE
        pause = max(0.0, heard - 2 * CUT_AIR)
        start, end = cursor, cursor + (piece_out - piece_in)
        items.append(Item("voice", start, end, {"line": line["id"], "seg": t["seg"], "file": str(film.voice_dir / f"{t['seg']}.mp3"), "in": round(piece_in, 3), "out": round(piece_out, 3)}))
        words = [(w, min(s - piece_in + start, end), min(e - piece_in + start, end)) for w, s, e in t["words"]]
        gap_end = end + pause
        meme, meme_ids = memes.get(line["id"], (None, []))
        meme_parts = []
        if meme:
            span = (meme["in"], meme["out"]) if "in" in meme else None
            parts = [meme_cut(film, x, span) for x in meme_ids]
            mode = meme.get("mode", "fullscreen")
            extra = {"mode": mode, "side": meme.get("side"), "on": meme.get("on"), "box": meme.get("box"), "franchise": meme["franchise"], "line": line["id"]}
            if meme.get("cuts"):
                parts = [piece for p in parts for piece in _cut_part(p, meme["cuts"])]
            if meme.get("picture"):
                extra["picture"] = meme["picture"]
            if meme.get("fill"):
                extra["fill"] = True
            if mode == "cutout":
                parts = [p if p["alpha"] else keyed_part(film, p) for p in parts]
            if all(p["audio"] for p in parts):
                m0 = end + 0.04
                for part in parts:
                    d = part["out"] - part["in"]
                    meme_parts.append(Item("meme", m0, m0 + d, {**part, **extra}))
                    m0 += d
                gap_end = m0 + 0.08
            else:
                part = parts[0]
                m0 = max(start, end - SILENT_MEME_OVERLAP)
                d = min(SILENT_MEME_SECONDS, part["out"] - part["in"])
                boom = sfx_seconds(film, SILENT_MEME_SFX)
                meme_parts.append(Item("meme", m0, m0 + d, {**part, **extra, "out": round(part["in"] + d, 3)}))
                items.append(Item("sfx", end, end + boom, {"line": line["id"], "file": sfx_file(film, SILENT_MEME_SFX), "gain_db": -4}))
                gap_end = max(gap_end, m0 + (d + 0.05 if mode != "fullscreen" else SILENT_BOOM_CLEAR), end + boom)
        items.extend(meme_parts)
        if any(p["k"] == "SFX" for p in pics):
            gap_end = max(gap_end, end + max(SFX_CLEAR, max(sfx_seconds(film, p["id"]) for p in pics if p["k"] == "SFX")))
        covers_scene = bool(meme_parts) and meme_parts[0].data["mode"] == "fullscreen" and meme_parts[0].data["audio"]
        visual_end = meme_parts[0].start if covers_scene else gap_end
        if open_mg:
            mg_item, through = open_mg
            mg_item.end = visual_end
            mg_item.data["words"] += words
            if line["id"] == through:
                open_mg = None

        def span(p: dict) -> tuple[float, float]:
            """A picture fills its line unless it starts (`from`) or ends (`until`) on a spoken word: one line can show a
            scene, then the page that proves it, then another scene (G11 show-dont-tell)."""
            a = cue_time(words, p["from"], p.get("from_nth", 1), line["id"]) if p.get("from") else start
            b = cue_time(words, p["until"], p.get("until_nth", 1), line["id"]) if p.get("until") else visual_end
            return a, b

        for p in pics:
            if p["k"] == "MG":
                a, b = span(p)
                item = Item("mg", a, b, {"line": line["id"], "mg": p, "words": [w for w in words if w[1] >= a - 0.05]})
                items.append(item)
                if p.get("through"):
                    open_mg = (item, p["through"])
        if line["id"] in film.backdrops:
            items.append(Item("stock", start, visual_end, {"line": line["id"], "file": str(film.media / "stock" / f"{film.backdrops[line['id']]}.jpg")}))
        for p in (p for p in pics if p["k"] in BASE_KINDS):
            a, b = span(p)
            if p["k"] in ("DOC", "BROLL"):
                items.append(Item("doc", a, b, {"line": line["id"], "id": p["id"], "file": str(film.media / "captures" / f"{p['id']}.png"),
                                                **({"read": p["read"]} if p.get("read") else {})}))
            elif p["k"] == "POST":
                items.append(Item("post", a, b, {"line": line["id"], "id": p["id"], "file": str(film.media / "sourcing" / "posts" / f"{p['id']}.png")}))
            elif p["k"] == "CUT":
                items.append(Item("cutout", a, b, {"line": line["id"], "pose": p.get("pose", "stand")}))
            elif p["k"] == "TAG":
                items.append(Item("tag", a, b, {"line": line["id"], "text": p["text"]}))
        for p in pics:
            if p["k"] == "STK":
                s0 = sticker_time(words, start, end, p["text"])
                stamp = sfx_seconds(film, STICKER_SFX)
                items.append(Item("sticker", s0, max(s0 + STICKER_MIN_SECONDS, visual_end), {"line": line["id"], "text": p["text"]}))
                if s0 >= end and s0 + stamp <= gap_end:
                    items.append(Item("sfx", s0, s0 + stamp, {"line": line["id"], "file": sfx_file(film, STICKER_SFX), "gain_db": -10}))
            elif p["k"] == "SFX":
                items.append(Item("sfx", end, end + sfx_seconds(film, p["id"]), {"line": line["id"], "file": sfx_file(film, p["id"]), "gain_db": -6}))
        cursor = gap_end
    film_end = max(i.end for i in items if i.kind in ("voice", "clip", "meme")) + END_HOLD_SECONDS
    for i in items:
        if i.kind in HELD_TO_END and i.end > film_end - END_HOLD_SECONDS - 0.5:
            i.end = film_end
    if desk_until is None:
        raise ValueError(f"desk_until_line {film.desk_until_line} is not in the script")
    return {"duration": round(film_end, 3), "desk_until": round(desk_until, 3), "items": [i.json() for i in sorted(items, key=lambda i: i.start)]}


def write(film: Film) -> dict:
    """Build the timeline from the film's lines.json and voice takes and write it to build/timeline.json."""
    lines = json.loads(film.lines_file.read_text(encoding="utf-8"))
    timeline = build(film, lines, timings_from_voice(film, lines))
    film.timeline_file.write_text(json.dumps(timeline, indent=1), encoding="utf-8")
    return timeline
