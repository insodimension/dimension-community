"""Narration takes on the film clock: which take voices each line, and where its cuts sit in the take's own silence."""
from __future__ import annotations

import json
import subprocess
from functools import lru_cache

import numpy as np

from framework.tools import HIDDEN

from .film import Film, SpokenForms

VOICE_RATE = 16000
SILENCE_DBFS = -45
PAUSE_SEARCH_BEFORE = 0.4
PAUSE_SEARCH_AFTER = 0.15
CUT_AIR = 0.03
TAIL_SEARCH_SECONDS = 0.5
TAIL_QUIET_FRAMES = 6


def spoken(text: str, forms: SpokenForms) -> str:
    """The text as the voice was asked to say it: each (written, spoken) form replaced in order, curly quotes straightened."""
    for written, said in forms:
        text = text.replace(written, said)
    return text.replace("\u201c", '"').replace("\u201d", '"')


@lru_cache(maxsize=None)
def voice_pcm(path: str) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(VOICE_RATE), "-f", "f32le", "-"], capture_output=True, creationflags=HIDDEN).stdout
    return np.frombuffer(raw, dtype=np.float32)


def frames_db(pcm: np.ndarray, a: float, b: float, hop: float = 0.01) -> tuple[np.ndarray, np.ndarray]:
    """(frame start times, frame RMS dBFS) of `hop`-long frames between a and b seconds."""
    i0, i1, h = int(a * VOICE_RATE), min(int(b * VOICE_RATE), len(pcm)), int(hop * VOICE_RATE)
    i0 = min(max(0, i0), max(0, len(pcm) - h))
    starts = np.arange(i0, max(i0 + h, i1 - h + 1), h)
    db = np.array([20 * np.log10(np.sqrt(np.mean(pcm[s:s + h] ** 2)) + 1e-9) for s in starts])
    return starts / VOICE_RATE, db


def pause(pcm: np.ndarray, last: tuple[float, float], nxt: tuple[float, float]) -> tuple[float, float]:
    """Cut points (out of one line, into the next) inside the measured pause between two words.

    `last`/`nxt` are the aligned (start, end) of the two words. The aligner's word ends lag the audio by up to
    PAUSE_SEARCH_BEFORE and its gap often sits on the next word's onset, so the pause is found in the level itself: the
    longest run of 10 ms frames below SILENCE_DBFS between the middle of the last word and the middle of the next. Each
    cut keeps CUT_AIR of decay or pre-roll. With no such run the take has no pause there, and the quietest frame is used
    for both points (the G11 check reports it)."""
    lo = max((last[0] + last[1]) / 2, last[1] - PAUSE_SEARCH_BEFORE)
    hi = min((nxt[0] + nxt[1]) / 2, nxt[0] + PAUSE_SEARCH_AFTER)
    t, db = frames_db(pcm, lo, hi)
    best, run = None, None
    for k, quiet in enumerate(list(db < SILENCE_DBFS) + [False]):
        if quiet and run is None:
            run = k
        elif not quiet and run is not None:
            if best is None or k - run > best[1] - best[0]:
                best = (run, k)
            run = None
    if best is None:
        q = float(t[int(np.argmin(db))] + 0.005)
        return q, q
    a, b = float(t[best[0]]), float(t[best[1] - 1] + 0.01)
    if b - a <= 2 * CUT_AIR:
        mid = (a + b) / 2
        return mid, mid
    return a + CUT_AIR, b - CUT_AIR


def tail_end(pcm: np.ndarray, t1: float) -> float:
    """End of a take's last word: where its sound stays below SILENCE_DBFS for 60 ms, within half a second."""
    t, db = frames_db(pcm, t1, min(len(pcm) / VOICE_RATE, t1 + TAIL_SEARCH_SECONDS))
    for k in range(len(db) - TAIL_QUIET_FRAMES):
        if (db[k:k + TAIL_QUIET_FRAMES] < SILENCE_DBFS).all():
            return float(t[k] + CUT_AIR)
    return float(min(len(pcm) / VOICE_RATE, t1 + TAIL_SEARCH_SECONDS))


def timings_from_voice(film: Film, lines: list[dict]) -> dict:
    """Each narrator line's words, from the latest take that voiced exactly its current text, with its cut points.

    A take (`voice/segments.json`: seg -> {lines, line_text}) records the text it spoke per line, so retired or
    reworded lines never shift another line's words. Words come from `voice/<seg>.timing.json`; cuts sit in the
    measured pause between this line and its neighbours in the take, never inside a word."""
    segments = json.loads((film.voice_dir / "segments.json").read_text(encoding="utf-8"))
    takes: dict[str, dict] = {}
    for seg, spec in segments.items():
        words = json.loads((film.voice_dir / f"{seg}.timing.json").read_text(encoding="utf-8"))["words"]
        pcm = voice_pcm(str(film.voice_dir / f"{seg}.mp3"))
        cursor, spans = 0, []
        for lid in spec["lines"]:
            n = len(spoken(spec["line_text"][lid], film.spoken_forms).split())
            chunk = words[cursor:cursor + n]
            cursor += n
            spans.append((lid, chunk))
        if cursor != len(words):
            raise ValueError(f"{seg}: mapped {cursor} of {len(words)} words")
        cuts = [pause(pcm, (a[-1]["startSeconds"], a[-1]["endSeconds"]), (b[0]["startSeconds"], b[0]["endSeconds"]))
                for (_, a), (_, b) in zip(spans, spans[1:])]
        first = spans[0][1][0]
        lead_in = pause(pcm, (0.0, 0.0), (first["startSeconds"], first["endSeconds"]))[1] if first["startSeconds"] > 0.05 else 0.0
        for k, (lid, chunk) in enumerate(spans):
            t0, t1 = chunk[0]["startSeconds"], chunk[-1]["endSeconds"]
            next_start = spans[k + 1][1][0]["startSeconds"] if k + 1 < len(spans) else None
            takes.setdefault(lid, {})[spec["line_text"][lid]] = {
                "seg": seg, "t0": t0, "t1": t1,
                "cut_in": cuts[k - 1][1] if k else lead_in,
                "cut_out": cuts[k][0] if k < len(cuts) else tail_end(pcm, t1),
                "gap_after": (next_start - t1) if next_start is not None else None,
                "words": [(w["text"], w["startSeconds"], w["endSeconds"]) for w in chunk]}
    out = {}
    for line in lines:
        if line["speaker"] != "narrator":
            continue
        take = takes.get(line["id"], {}).get(line["text"])
        if take is None:
            raise ValueError(f"{line['id']}: no take voices its current text; record it: {line['text']!r}")
        out[line["id"]] = take
    return out
