"""G11 (FRAMEWORK §8, taste.json): Inso's media, meme, narration and picture rules, checked from a film's build.

One implementation for every film. A film's builder fills a `Plan` from its own timeline and calls `code_checks(plan)`
(and, in the eval kernel, `await judge_checks(plan, judge_batch)`), then hands the merged result to `dd.gate.check` as
its `g11`. A rule the plan cannot answer is left out, so dd.gate reports it unchecked: unknown is never a pass.

Adding a rule (SKILL Notes mode N-2): write it in taste.json, then add its check here, keyed by the rule id, and the
Plan field it needs. Every film that builds a Plan picks it up on its next gate run.
"""
from __future__ import annotations

import functools
import hashlib
import json
import re
import statistics
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pyloudnorm
from PIL import Image

from framework.tools import HIDDEN

DD = Path(__file__).resolve().parent.parent
FRAME_W, FRAME_H = 1920, 1080
BAND_X, BAND_Y = FRAME_W * 0.1, FRAME_H * 0.1
MIN_LINES = 720
CUT_SILENCE_DBFS = -38  # a narration cut lands where the take is at least this quiet (10 ms RMS)
LABEL_MAX_SECONDS = 2.6
SENTENCE_END = re.compile(r"[.!?…][\"')\]]*$")
DEAD_AIR_SECONDS, QUIET_BELOW_NARRATION_DB = 1.0, 12
HOLD_MAX_SECONDS = 5.0  # show-dont-tell: the picture changes at least this often while the narration speaks
RECEIPT_MAX_SECONDS = 4.0  # a page shown as proof, before something explains it (FRAMEWORK §10)
BLANK_MAX_SECONDS = 1.5  # no-blank-stage
NO_CREW = 0.02  # tolerance on time comparisons
WALL_WORDS = 12
WALL_TOKEN = re.compile(r"[a-z][a-z'’-]*")
HR_MUSIC_RANGE = re.compile(r"(\d+)\s*-\s*(\d+)\s*BPM")
MUSIC_REGISTER = DD / "music.json"
PCM_RATE = 16000
LUFS_BLOCK_SECONDS = 0.4
MUSIC_UNDER_VOICE_LU = 12.0
MUSIC_DUCK_DB = 6.0
MUSIC_CLEAR_LU = 18.0
MUSIC_SILENT_DBFS = -60.0
MUSIC_VOCAL_SHARE = 0.05
STANDING_RULING = "standing ruling 2026-11-07"
REPLAY_MIN_SECONDS = 1.0  # no-scene-replay: a scene snapping back to an earlier frame for this long is a rebuild
FIRST_LAUGH_SECONDS = 4.0  # first-laugh-by-4s
QUESTION_TAIL_WORDS = 3  # statement-not-asked: a heard question matches its script sentence on its last words
JUDGE_VOTES = 3  # judge rules: reads per state; a state fails on a strict majority


@dataclass
class Plan:
    """What a film's builder drew and played, on the film clock (seconds). Fill what the builder knows; a check whose
    fields are empty is skipped, and dd.gate reports its rule as unchecked."""
    duration: float
    narration: list[tuple[float, float, str]] = field(default_factory=list)  # every heard narration word (clipped to its cut)
    voice: list[dict] = field(default_factory=list)  # {start, end, file, in, out, line}: each narration piece
    memes: list[dict] = field(default_factory=list)  # {start, end, mode, franchise, lib, audio, in, out}
    sfx: list[tuple[float, float]] = field(default_factory=list)
    labels: list[dict] = field(default_factory=list)  # {kind, start, end}: credit chips, source chips, price tags
    boxes: list[dict] = field(default_factory=list)  # {kind, start, end, box:[x,y,w,h]}: everything important drawn
    changes: list[tuple[float, str]] = field(default_factory=list)  # picture changes: new picture, scene reveal, meme, clip, cutout pose
    pictures: list[dict] = field(default_factory=list)  # {kind, start, end}: what fills the frame (receipt, photo, scene, cutout, clip...)
    scenes: list[dict] = field(default_factory=list)  # {start, end, first_reveal, line}: motion-graphic scenes
    analogy_lines: list[str] = field(default_factory=list)  # spine anchor_world.lines
    scene_lines: set[str] = field(default_factory=set)  # lines that carry a motion-graphic scene
    script_text: str = ""  # every narration line, joined
    source_files: list[str] = field(default_factory=list)  # every picture source file
    sources: list[dict] = field(default_factory=list)  # {kind, id, url, date}: posts and pages shown
    library: Path | None = None  # the meme library root
    audio_rows: list[tuple[float, float, bool]] = field(default_factory=list)  # instrument audio.txt rows (t, dB, speech)
    music: list[dict] = field(default_factory=list)
    stems: dict[str, str] = field(default_factory=dict)
    screen_text: list[dict] = field(default_factory=list)
    production: str = ""
    held: list[dict] = field(default_factory=list)
    returns: list[dict] = field(default_factory=list)  # {start, end, matches}: the render's frame snapping back to an earlier one
    punches: list[float] = field(default_factory=list)  # when each punch line's punch word is heard
    heard: list[dict] = field(default_factory=list)  # {w, t0, t1}: Whisper words of the render
    script_sentences: list[str] = field(default_factory=list)  # every narration sentence, as written


def taste() -> dict:
    return json.loads((DD / "taste.json").read_text(encoding="utf-8"))


def _size(path: str) -> tuple[int, int]:
    if path.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
        return Image.open(path).size
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
                         capture_output=True, text=True, creationflags=HIDDEN).stdout.strip().split(",")
    return int(out[0]), int(out[1])


@functools.lru_cache(maxsize=32)
def _pcm(path: str) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(PCM_RATE), "-f", "f32le", "-"], capture_output=True, creationflags=HIDDEN).stdout
    return np.frombuffer(raw, np.float32)


def _dbfs(path: str, t: float) -> float:
    x = _pcm(path)
    i = int(t * PCM_RATE)
    w = x[max(0, i - 80): i + 80]
    return float(20 * np.log10(np.sqrt(np.mean(w ** 2)) + 1e-9)) if w.size else -120.0


def _spoken(p: Plan, a: float, b: float) -> bool:
    return any(w0 < b - NO_CREW and w1 > a + NO_CREW for w0, w1, _ in p.narration)


def _hr_music(beds: list[dict], approved: set[str]) -> list[str]:
    rule = next(r for r in taste()["rules"] if r["id"] == "no-hr-music")
    lo, hi = (float(x) for x in HR_MUSIC_RANGE.search(rule["text"]).groups())
    out = []
    for bed in beds:
        if bed.get("file") and sha256(bed["file"]) in approved:
            continue
        if bed.get("bpm") is None or not bed.get("mode"):
            out.append(f"music bed {bed.get('id')}: no measured tempo or mode, so the {lo:.0f}-{hi:.0f} BPM minor rule cannot pass")
            continue
        if not lo <= float(bed["bpm"]) <= hi:
            out.append(f"music bed {bed['id']}: {float(bed['bpm']):.1f} BPM, outside {lo:.0f}-{hi:.0f}")
        if "minor" not in str(bed["mode"]).lower():
            out.append(f"music bed {bed['id']}: {bed['mode']}, not minor")
    return out


def music_register() -> dict:
    return json.loads(MUSIC_REGISTER.read_text(encoding="utf-8"))


def approved_beds(register: dict, production: str) -> set[str]:
    """The sha256 of every bed approved for this production, fail-closed: an entry with Inso's own `inso` yes counts for
    every film, a standing-ruling entry counts only for the film it names, anything else and any rejected bed count nowhere."""
    rejected = {r["sha256"] for r in register["rejected"]}
    return {a["sha256"] for a in register["approved"]
            if a["sha256"] not in rejected and (isinstance(a.get("inso"), dict)
                                                or (a.get("approved_by") == STANDING_RULING and production and a.get("film") == production))}


@functools.lru_cache(maxsize=64)
def _sha256_of(path: str, size: int, mtime_ns: int) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256(path: str) -> str:
    st = Path(path).stat()
    return _sha256_of(str(path), st.st_size, st.st_mtime_ns)


def edl_beds(production: Path) -> list[dict]:
    cut = json.loads((production / "edl.json").read_text(encoding="utf-8"))
    sources = {s["id"]: s for s in cut["sources"]}
    rows = []
    for sid in sorted({c["sourceId"] for t in cut["tracks"] if t["kind"] == "music" for c in t["clips"]}):
        s = sources[sid]
        file = production / s["path"]
        asset = file.with_suffix(".asset.json")
        measured = (json.loads(asset.read_text(encoding="utf-8")).get("audio") or {}).get("music") or {} if asset.exists() else {}
        rows.append({"id": s.get("assetId") or sid, "lib": s.get("assetId"), "file": str(file), "asset": str(asset) if asset.exists() else None,
                     "bpm": measured.get("bpm"), "mode": (measured.get("key") or {}).get("mode")})
    return rows


def _bed_name(bed: dict) -> str:
    return bed.get("id") or Path(bed["file"]).stem


def _music_from_library(beds: list[dict], library: Path | None, approved: set[str]) -> list[str]:
    out = []
    for bed in beds:
        sha = sha256(bed["file"])
        if sha in approved:
            continue
        entry = library / bed["lib"] / "entry.json" if library and bed.get("lib") else None
        if entry and entry.exists():
            e = json.loads(entry.read_text(encoding="utf-8"))
            if e.get("kind") == "music" and e.get("sha256") == sha:
                continue
            out.append(f"music bed {_bed_name(bed)}: library entry {bed['lib']} is a {e.get('kind')}" + (", not a music track" if e.get("kind") != "music" else " holding a different file"))
            continue
        asset = json.loads(Path(bed["asset"]).read_text(encoding="utf-8")) if bed.get("asset") and Path(bed["asset"]).exists() else {}
        if asset.get("provider") == "motion score":
            out.append(f"music bed {_bed_name(bed)}: {Path(bed['file']).name} is a motion_score render, not a media-library track, and Inso has not approved it")
        else:
            out.append(f"music bed {_bed_name(bed)}: {Path(bed['file']).name} ({asset.get('provider') or 'unknown source'}) is neither a media-library music entry nor in music.json approved (Inso's yes, or this film's standing-ruling bed)")
    return out


def _music_approved(beds: list[dict], register: dict, approved: set[str]) -> list[str]:
    rejected = {r["sha256"]: r for r in register["rejected"]}
    out = []
    for bed in beds:
        sha = sha256(bed["file"])
        r = rejected.get(sha)
        if r:
            out.append(f"music bed {_bed_name(bed)}: Inso rejected this track on {r['date']} (\"{r['inso']}\")")
        elif sha not in approved:
            out.append(f"music bed {_bed_name(bed)}: the bed's sha256 {sha[:12]} is not in music.json approved (Inso's yes, or this film's standing-ruling bed)")
    return out


@functools.lru_cache(maxsize=16)
def _speech_share_of(path: str, size: int, mtime_ns: int) -> float:
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    x = _pcm(path)
    return sum(t["end"] - t["start"] for t in get_speech_timestamps(x, VadOptions())) / x.size if x.size else 0.0


def _music_vocals(beds: list[dict]) -> list[str]:
    out = []
    for bed in beds:
        st = Path(bed["file"]).stat()
        share = _speech_share_of(str(bed["file"]), st.st_size, st.st_mtime_ns)
        if share >= MUSIC_VOCAL_SHARE:
            out.append(f"music bed {_bed_name(bed)}: a voice (speech or singing) in {share:.0%} of the track by silero VAD, at or over {MUSIC_VOCAL_SHARE:.0%}")
    return out


def _plays(memes: list[dict]) -> list[dict]:
    """Meme items joined into plays: pieces of one library clip played back to back (a jump cut inside its own silent
    beat, `cuts` on the MEME row) are one play, its window from the first piece's in to the last piece's out."""
    out: list[dict] = []
    for m in sorted(memes, key=lambda m: m["start"]):
        last = out[-1] if out else None
        if last and last["lib"] == m["lib"] and abs(m["start"] - last["end"]) < 0.05 and m["in"] >= last["out"] - 0.05:
            out[-1] = {**last, "end": m["end"], "out": m["out"]}
        else:
            out.append(dict(m))
    return out


def _merged(spans: list[tuple[float, float]], gap: float = 0.25) -> list[tuple[float, float]]:
    out: list[list[float]] = []
    for a, b in sorted(spans):
        if out and a <= out[-1][1] + gap:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]


def _cut(x: np.ndarray, spans: list[tuple[float, float]]) -> np.ndarray:
    parts = [x[int(a * PCM_RATE): int(b * PCM_RATE)] for a, b in spans]
    return np.concatenate(parts) if parts else np.zeros(0, np.float32)


def _rms_db(x: np.ndarray) -> float:
    return float(20 * np.log10(np.sqrt(np.mean(x.astype(np.float64) ** 2)) + 1e-9)) if x.size else -120.0


@functools.lru_cache(maxsize=1)
def _meter() -> pyloudnorm.Meter:
    return pyloudnorm.Meter(PCM_RATE)


def _lufs(x: np.ndarray) -> float:
    if x.size < int(LUFS_BLOCK_SECONDS * PCM_RATE):
        return -120.0
    v = _meter().integrated_loudness(x.astype(np.float64))
    return float(v) if np.isfinite(v) else -120.0


def _music_levels(p: Plan) -> dict[str, list[str]]:
    voice, music = _pcm(p.stems["voice"]), _pcm(p.stems["music"])
    talk = _merged([(a, b) for a, b, _ in p.narration])
    v, b = _lufs(_cut(voice, talk)), _lufs(_cut(music, talk))
    out = {"music-under-voice": [] if b <= v - MUSIC_UNDER_VOICE_LU else
           [f"under the narration the bed sits {v - b:.1f} LU below the voice (bed {b:.1f} LUFS, voice {v:.1f} LUFS); it must sit at least {MUSIC_UNDER_VOICE_LU:.0f} LU under"]}
    if not p.memes:
        return out
    ref = _rms_db(_cut(music, talk))
    lines = _pcm(p.stems["memes"]) if p.stems.get("memes") else None
    ducks, clear = [], []
    for m in sorted(p.memes, key=lambda m: m["start"]):
        if not m.get("audio"):
            continue
        a, z = m["start"], m["end"]
        bed = _rms_db(_cut(music, [(a, z)]))
        if bed <= MUSIC_SILENT_DBFS:
            continue
        name = m.get("franchise") or m.get("lib")
        if bed > ref - MUSIC_DUCK_DB:
            ducks.append(f"{name} at {a:.1f}s: the bed is {ref - bed:.1f} dB under its narration level ({ref:.1f} dBFS); it must duck at least {MUSIC_DUCK_DB:.0f} dB")
        if lines is not None:
            pad = max(0.0, (LUFS_BLOCK_SECONDS - (z - a)) / 2)
            span = [(max(0.0, a - pad), z + pad)]
            gap = _lufs(_cut(lines, span)) - _lufs(_cut(music, span))
            if gap < MUSIC_CLEAR_LU:
                clear.append(f"{name} at {a:.1f}s: the bed sits {gap:.1f} LU under the meme's line; it must drop at least {MUSIC_CLEAR_LU:.0f} LU under it")
    out["music-ducks-under-memes"] = ducks
    if lines is not None:
        out["music-drops-under-memes"] = clear
    return out


def _sentences(p: Plan) -> list[tuple[float, float, set[str]]]:
    out, cur = [], []
    for w0, w1, w in sorted(p.narration):
        cur.append((w0, w1, w))
        if SENTENCE_END.search(w):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return [(s[0][0], s[-1][1], {t for _, _, w in s for t in WALL_TOKEN.findall(w.lower())}) for s in out]


def _text_walls(p: Plan) -> list[str]:
    sents = _sentences(p)
    out = []
    for x in p.screen_text:
        said = set().union(*([s[2] for s in sents if s[0] < x["end"] - NO_CREW and s[1] > x["start"] + NO_CREW] or [set()]))
        extra = [t for t in WALL_TOKEN.findall(x["text"].lower()) if t not in said]
        if len(extra) >= WALL_WORDS:
            out.append(f"{x['start']:.1f}-{x['end']:.1f}s: {len(extra)} on-screen words not spoken, e.g. {' '.join(extra[:10])!r}")
    return out



def _tokens(text: str) -> tuple[str, ...]:
    return tuple(WALL_TOKEN.findall(text.lower()))


def _asked(p: Plan) -> list[str]:
    """Heard sentences that end in a question mark where the script sentence they voice ends without one: Whisper
    punctuates by intonation, so a written statement transcribed as a question was voiced rising. The heard words must
    be the written sentence's own ending (at least QUESTION_TAIL_WORDS of them), so a list read with rising commas
    inside a sentence ("Refunds? Store credit?") is not flagged."""
    written = [(_tokens(s), s) for s in p.script_sentences if not s.rstrip().endswith("?")]
    out, sentence = [], []
    for w in p.heard:
        sentence.append(w)
        if not re.search(r"[.!?]$", w["w"]):
            continue
        said = _tokens(" ".join(x["w"] for x in sentence))
        if sentence[-1]["w"].endswith("?") and len(said) >= QUESTION_TAIL_WORDS:
            line = next((s for toks, s in written if len(toks) >= len(said) and toks[-len(said):] == said), None)
            if line:
                out.append(f"{sentence[0]['t0']:.1f}s: '{line}' is voiced as a question")
        sentence = []
    return out


def code_checks(p: Plan) -> dict[str, list[str]]:
    """{rule id: [violations]} for every code rule this plan can answer."""
    out: dict[str, list[str]] = {}
    memes = sorted(p.memes, key=lambda m: m["start"])

    if memes:
        first_use: dict[str, tuple[str, str | None]] = {}
        out["one-per-franchise"] = []
        for m in memes:
            lib, line = first_use.setdefault(m["franchise"], (m["lib"], m.get("line")))
            same_meme_row = line is not None and line == m.get("line")
            if lib != m["lib"] and not same_meme_row:
                out["one-per-franchise"].append(f"{m['franchise']}: {lib} and {m['lib']}")
        out["no-meme-tags"] = [f"{b['kind']} at {b['start']:.1f}s over the {m['franchise']} meme" for m in memes if m.get("mode") != "fullscreen"
                               for b in p.labels if b["start"] < m["end"] and b["end"] > m["start"]]
        out["no-meme-grids"] = [f"{m['franchise']} at {m['start']:.1f}s is a grid" for m in memes if m.get("mode") == "grid"]

    if p.source_files:
        out["min-720p"] = [f"{Path(f).name}: {w}x{h}" for f in sorted(set(p.source_files)) for w, h in [_size(f)] if min(w, h) < MIN_LINES]

    if p.script_text:
        low = p.script_text.lower()
        out["no-fireship"] = ["'fireship' in the script"] if "fireship" in low else []
        banned = taste()["banned_strings"]
        out["never-explain-the-joke"] = [f"'{s}' in the narration" for s in banned if s in low and any(k in s for k in ("joke", "kidding"))]

    if p.boxes:
        out["safe-corners"] = [f"{b['kind']} at {b['start']:.1f}s box {b['box']}" for b in p.boxes
                               if b["box"][0] < BAND_X or b["box"][1] < BAND_Y or b["box"][0] + b["box"][2] > FRAME_W - BAND_X or b["box"][1] + b["box"][3] > FRAME_H - BAND_Y]
    if p.labels:
        out["no-lower-thirds"] = [f"{b['kind']} at {b['start']:.1f}s shows {b['end'] - b['start']:.1f}s" for b in p.labels
                                  if b["kind"] != "tag" and b["end"] - b["start"] > LABEL_MAX_SECONDS]
    if p.sources:
        out["real-sources"] = [f"{s['kind']} {s['id']} has no captured url/date" for s in p.sources if not (s.get("url") and s.get("date"))]

    if p.voice:
        out["narration-cut-in-silence"] = [f"{v['line']} {edge} at {t:.2f}s of {Path(v['file']).stem}: {db:.0f} dBFS"
                                           for v in p.voice for t, edge in ((v["in"], "in"), (v["out"], "out"))
                                           if not (edge == "in" and t <= 0.01) for db in [_dbfs(v["file"], t)] if db > CUT_SILENCE_DBFS]
    if p.narration:
        out["no-sfx-on-words"] = [f"sfx at {a:.2f}s over '{w}'" for a, b in p.sfx for w0, w1, w in p.narration if a < w1 - NO_CREW and b > w0 + NO_CREW]
        stops = []
        for m in memes:
            if not m["audio"]:
                continue
            before = [w for w in p.narration if w[1] <= m["start"] + 0.05]
            if before and any(w[0] >= m["end"] - 0.05 for w in p.narration) and not SENTENCE_END.search(before[-1][2]):
                stops.append(f"{m['franchise']} at {m['start']:.1f}s stops narration after '{before[-1][2]}'")
            if _spoken(p, m["start"], m["end"]):
                stops.append(f"{m['franchise']} at {m['start']:.1f}s plays its sound over narration")
        out["meme-stops-at-sentence-end"] = stops
        out["no-end-card"] = [f"{x['kind']} at {x['start']:.1f}s alone in the last 6 s" for x in p.pictures
                              if x["kind"] in ("scene", "tag", "slate") and x["start"] >= p.duration - 6 and not _spoken(p, x["start"], x["end"])]

    if memes and p.library:
        whole, canon = [], []
        for m in _plays(memes):
            entry = p.library / m["lib"] / "entry.json"
            if not entry.exists():
                canon.append(f"{m['franchise']} at {m['start']:.1f}s: {m['lib']} is not in the media library, so no canonical version is recorded for it")
                continue
            e = json.loads(entry.read_text(encoding="utf-8"))
            pay = e.get("payoff") or {}
            if (pay.get("line") or "").strip() and e.get("hasOwnAudio") and not m["audio"]:
                whole.append(f"{m['franchise']} at {m['start']:.1f}s: its spoken line \"{pay['line']}\" plays muted")
            if pay.get("atSeconds") is not None and not (m["in"] - 0.05 <= pay["atSeconds"] <= m["out"] + 0.05):
                whole.append(f"{m['franchise']} at {m['start']:.1f}s: window {m['in']}-{m['out']} misses the payoff at {pay['atSeconds']}")
            canonical = e.get("canonical")
            if not isinstance(canonical, dict) or not isinstance(canonical.get("is"), bool):
                canon.append(f"{m['franchise']} at {m['start']:.1f}s: {m['lib']} has no canonical ruling in its library entry; library_tag canonical {{is, basis}} from its Know Your Meme page or most-viewed upload")
            elif not canonical["is"]:
                canon.append(f"{m['franchise']} at {m['start']:.1f}s: {m['lib']} is not the canonical (widely recognised) version, per {'Inso' if canonical.get('by') == 'inso' else 'evidence'}: {canonical.get('basis')}")
        out["meme-whole-line"] = whole
        out["meme-canonical-version"] = canon

    if p.changes and p.narration:
        # show-dont-tell: between picture changes, the narration may run at most HOLD_MAX_SECONDS
        ts = sorted({round(t, 3) for t, _ in p.changes} | {0.0, p.duration})
        holds = []
        for a, b in zip(ts, ts[1:]):
            talk = sum(max(0.0, min(b, w1) - max(a, w0)) for w0, w1, _ in p.narration)
            if b - a > HOLD_MAX_SECONDS and talk > 0.6 * HOLD_MAX_SECONDS:
                on = [x["kind"] for x in p.pictures if x["start"] <= a + NO_CREW and x["end"] >= b - NO_CREW]
                holds.append(f"{a:.1f}-{b:.1f}s ({b - a:.1f}s) one picture ({'/'.join(on) or 'stage'}) under {talk:.1f}s of narration")
        for x in p.pictures:
            if x["kind"] != "receipt":
                continue
            inside = sorted(t for t, k in p.changes if x["start"] + NO_CREW < t < x["end"] - NO_CREW)
            first = inside[0] if inside else x["end"]
            if first - x["start"] > RECEIPT_MAX_SECONDS + NO_CREW:
                holds.append(f"receipt at {x['start']:.1f}s holds {first - x['start']:.1f}s before anything explains it")
        out["show-dont-tell"] = holds

    if p.pictures or p.scenes:
        blank = [f"scene at {s['start']:.1f}s ({s['line']}) shows nothing for {s['first_reveal'] - s['start']:.1f}s"
                 for s in p.scenes if s["first_reveal"] - s["start"] >= BLANK_MAX_SECONDS]
        spans = sorted((x["start"], x["end"]) for x in p.pictures)
        cursor = 0.0
        for a, b in spans:
            if a - cursor >= BLANK_MAX_SECONDS:
                blank.append(f"{cursor:.1f}-{a:.1f}s: empty stage")
            cursor = max(cursor, b)
        if p.duration - cursor >= BLANK_MAX_SECONDS:
            blank.append(f"{cursor:.1f}-{p.duration:.1f}s: empty stage")
        out["no-blank-stage"] = blank

    if p.analogy_lines:
        out["analogy-in-motion"] = [f"{lid} acts out the analogy with no motion-graphic scene" for lid in p.analogy_lines if lid not in p.scene_lines]

    if p.audio_rows:
        rows = p.audio_rows
        ref = statistics.median([db for _, db, s in rows if s])
        runs, start = [], None
        for t, db, s in rows + [(rows[-1][0] + 0.5, 0.0, True)]:
            quiet = (not s) and db < ref - QUIET_BELOW_NARRATION_DB
            if quiet and start is None:
                start = t
            elif not quiet and start is not None:
                end = min(t, p.duration)  # the sentinel row past the last sample must not stretch a run beyond the film
                if end - start >= DEAD_AIR_SECONDS:
                    runs.append(f"{start:.1f}-{end:.1f}s")
                start = None
        out["no-dead-air"] = runs
    if p.music:
        register = music_register()
        approved = approved_beds(register, p.production)
        out["no-hr-music"] = _hr_music(p.music, approved)
        if all(bed.get("file") for bed in p.music):
            out["music-from-library"] = _music_from_library(p.music, p.library, approved)
            out["music-approved-by-inso"] = _music_approved(p.music, register, approved)
            out["music-no-vocals"] = _music_vocals(p.music)
    if p.narration and p.stems.get("voice") and p.stems.get("music"):
        out.update(_music_levels(p))

    if p.screen_text and p.narration:
        out["no-text-walls"] = _text_walls(p)

    if p.held:
        out["no-clipped-text"] = [f"{h['where']} at {h['t']:.1f}s: '{c['text']}' cut {c['px']}px past the {c['side']} edge of {c['by']}"
                                  + (f" (at '{c['word']}')" if c["word"] else "") for h in p.held for c in h["clipped"]]
        out["no-clipped-text"] += [f"{h['where']} at {h['t']:.1f}s: '{c['text']}' sliced {c['px']}px deep by the highlight ring's {c['side']} stroke"
                                   + (f" (at '{c['word']}')" if c["word"] else "") for h in p.held for c in h.get("sliced", [])]
        out["tag-clear-of-text"] = [f"{h['where']} at {h['t']:.1f}s: '{c['tag']}' covers {c['share']:.0%} of '{c['text']}'" for h in p.held for c in h["covered"]]

    if p.returns and p.scenes:
        replays = []
        for r in p.returns:
            scene = next((s for s in p.scenes if min(r["end"], s["end"]) - max(r["start"], s["start"]) >= REPLAY_MIN_SECONDS - NO_CREW), None)
            if scene:
                replays.append(f"{r['start']:.1f}-{r['end']:.1f}s ({scene['line']}) snaps back to the frame at {r['matches']:.1f}s")
        out["no-scene-replay"] = replays

    if p.memes or p.punches:
        first = min([m["start"] for m in p.memes] + p.punches)
        out["first-laugh-by-4s"] = [] if first <= FIRST_LAUGH_SECONDS + NO_CREW else [f"first meme or punch at {first:.1f}s"]

    if p.heard and p.script_sentences:
        out["statement-not-asked"] = _asked(p)

    return out


# Judge rules. Measured 2026-11-04 with `calibrate()` on Inso's Altman RAM roast marks (calibration/inso-marks.jsonl):
# the tiny `judge_batch` model passed all five rejected items (0% recall); the slow chat model used here caught 5 of 7
# rejected reads but also failed all 6 reads of memes Inso approved (McMahon, Scarface, Stonks). Until `calibrate()`
# reaches recall >= 0.9 at <= 25% false alarms, these rules are advisory (taste.json severity) and their findings go to
# Inso as a list to look at, never as a verdict. Add every new approval and rejection to the marks file.
JUDGE_QUESTIONS = {
    "meme-is-the-audience": "Does the meme voice what THIS audience (the persona) feels at that moment, not what the subject, a company or the narrator feels? A celebration ('nice', 'yes!') over something that hurts the audience fails.",
    "meme-has-a-setup": "Did the narration right before set up exactly what this meme lands, so a typical viewer could say in one sentence why the meme is there? A meme that only loosely matches a word (e.g. 'pointing' because two things are compared) fails.",
    "picture-is-understood": "Would the least-informed viewer in this persona understand what this picture means for the spoken line without explanation? A riddle metaphor (an animal standing for an institution) fails.",
    "analogy-stays-in-its-world": "WORLD is the film's one analogy: its setting, its objects and its people, plus the extensions the script plans. Showing them is fine on any line, and so is a picture with no analogy object: a real document, a chart, a meme or a separate gag that is not one of WORLD's objects never fails. A situation the LINE or the NARRATION BEFORE names in words is set up too, so a picture acting out what the narration says never fails. It fails only when the PICTURE takes an analogy object (or a new object of the same kind) into a setting, situation or story that neither WORLD nor the narration sets up: for example the analogy's car shown driving on a road, racing a rival car or passing a road sign when the analogy is a car inspection and the narration never mentions a road or a race. Does this picture stay inside what WORLD and the narration set up? true if it does or shows no analogy object; false if it invents a new setting or story for the analogy's objects.",
}
_VERDICT = {"type": "object", "properties": {"ok": {"type": "boolean"}, "why": {"type": "string"}}, "required": ["ok", "why"]}
MARKS = DD / "calibration" / "inso-marks.jsonl"


def _prompt(rule: str, s: dict) -> str:
    head = f"PERSONA: {s['persona']}\n" if s.get("persona") else ""
    world = f"WORLD: {s['world']}\n" if s.get("world") else ""
    return (f"You review a comedy explainer for the channel's owner, who rejects lazy meme and picture choices.\n{head}{world}"
            f"NARRATION BEFORE: {s['before']}\nLINE: {s['line']}\nPICTURE/MEME: {s['picture']}\nQUESTION: {JUDGE_QUESTIONS[rule]}\nAnswer strictly; when in doubt, false.")


def analogy_world(spine: dict) -> str:
    aw = spine.get("anchor_world") or {}
    return f"{aw.get('analogy', '')}. Maps: {aw.get('maps', '')}. Extensions the script plans: {'; '.join(aw.get('extensions') or [])}"


def analogy_states(lines: list[dict], spine: dict, descriptions: dict[str, dict]) -> dict[str, dict]:
    """One `analogy-stays-in-its-world` state per narrator line the frames-only reader described: the spine's analogy,
    the two narrator lines before, the line and what the reader saw on it. A film with no `anchor_world` has none."""
    if not (spine.get("anchor_world") or {}).get("analogy"):
        return {}
    world = analogy_world(spine)
    said = [l for l in lines if l["speaker"] == "narrator"]
    return {f"analogy-stays-in-its-world|{l['id']}": {"rule": "analogy-stays-in-its-world", "world": world,
            "before": " ".join(x["text"] for x in said[max(0, i - 2):i]), "line": l["text"], "picture": descriptions[l["id"]]["picture"]}
            for i, l in enumerate(said) if descriptions.get(l["id"], {}).get("picture")}


def judge_checks(states: dict[str, dict], completion, votes: int = JUDGE_VOTES) -> dict[str, list[str]]:
    """Judge rules over states the builder writes: {key: {rule, persona, before, line, picture}}; the key names the unit
    (time, line, asset). Run in the eval kernel with its `completion`. Each state is read `votes` times and fails on a
    strict majority, so one stray read never blocks a film. Returns {rule id: ["key: why"]} for each rule judged."""
    handles = {k: [completion(_prompt(s["rule"], s), model="slow", schema=_VERDICT) for _ in range(votes)] for k, s in states.items()}
    out: dict[str, list[str]] = {}
    for k, hs in handles.items():
        rule = states[k]["rule"]
        fails = [v["why"] for v in (h.wait() for h in hs) if not v["ok"]]
        out.setdefault(rule, [])
        if len(fails) * 2 > votes:
            out[rule].append(f"{k}: {fails[0]}")
    return out


def calibrate(completion, marks: Path = MARKS) -> dict:
    """Re-score the judge on every labelled mark (Inso's approvals and rejections) in `marks`: recall on rejections, false
    alarms on approvals, per rule. A judge rule becomes a gate only when this meets the bar in the note above."""
    rows = [json.loads(x) for x in marks.read_text(encoding="utf-8").splitlines() if x.strip() and json.loads(x).get("state")]
    states = {f"{r['rule']}|{i}": {**r["state"], "rule": r["rule"]} for i, r in enumerate(rows)}
    fails = {k.split(":")[0] for v in judge_checks(states, completion).values() for k in v}
    score: dict[str, dict] = {}
    for i, r in enumerate(rows):
        s = score.setdefault(r["rule"], {"rejected": 0, "caught": 0, "approved": 0, "false_alarms": 0})
        failed = f"{r['rule']}|{i}" in fails
        if r["label"] == "rejected":
            s["rejected"] += 1
            s["caught"] += failed
        else:
            s["approved"] += 1
            s["false_alarms"] += failed
    return score
