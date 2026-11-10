import json
import re
from pathlib import Path

NUM_WORDS = {"one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
             "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred", "thousand",
             "million", "billion", "trillion", "percent", "half", "quarter", "twice", "double"}


def load_json(p):
    return json.loads(Path(p).read_text(encoding="utf8"))


def words(text):
    return re.findall(r"[A-Za-z0-9$%'.,-]+", text or "")


def estimate_timing(segments, wps, pause=0.25):
    t = 0.0
    for s in segments:
        if s.get("t0") is not None and s.get("t1") is not None:
            t = s["t1"]
            continue
        if s["kind"] == "voice":
            d = max(0.6, len(words(s.get("line", ""))) / wps) + pause
        else:
            d = float(s.get("dur", 2.0))
        s["t0"], s["t1"] = round(t, 3), round(t + d, 3)
        s["estimated"] = True
        t += d
    return segments



def chunk_voice(segments, max_words=22, min_words=6):
    out = []
    for s in segments:
        toks = (s.get("line") or "").split()
        if s["kind"] != "voice" or len(toks) <= max_words:
            out.append(s)
            continue
        pieces, cur = [], []
        for i, w in enumerate(toks):
            cur.append(w)
            rest = len(toks) - i - 1
            brk = w.endswith((",", ";", ":", "—", "–")) or (i + 1 < len(toks) and toks[i + 1].lower() in ("but", "and", "while", "because", "which", "so") and len(cur) >= 10)
            if (brk and len(cur) >= min_words and rest >= min_words) or len(cur) >= max_words and rest >= min_words:
                pieces.append(cur)
                cur = []
        if cur:
            pieces.append(cur)
        total = sum(len(p) for p in pieces)
        t, span = s["t0"], s["t1"] - s["t0"]
        bit = s.get("bit") or s["id"]
        for k, p in enumerate(pieces):
            d = span * len(p) / total
            n = dict(s)
            n.update({"id": f"{s['id']}.{k}", "line": " ".join(p), "t0": round(t, 3), "t1": round(t + d, 3), "bit": f"{bit}.{k}", "parent": [s["id"]]})
            out.append(n)
            t += d
        out[-1]["t1"] = s["t1"]
    return out
def validate(segments, duration=None, tol=0.05):
    errs = []
    for a, b in zip(segments, segments[1:]):
        if abs(b["t0"] - a["t1"]) > tol:
            errs.append(f"gap or overlap between {a['id']} ({a['t1']}) and {b['id']} ({b['t0']})")
    if segments and segments[0]["t0"] > tol:
        errs.append(f"timeline starts at {segments[0]['t0']}")
    if duration is not None and segments and abs(segments[-1]["t1"] - duration) > tol:
        errs.append(f"timeline ends at {segments[-1]['t1']} not {duration}")
    for s in segments:
        if s["kind"] not in ("voice", "clip", "graphic", "silence"):
            errs.append(f"{s['id']}: bad kind {s['kind']}")
    return errs


def bits_of(segments):
    order, bits = [], {}
    for s in segments:
        if s["kind"] == "silence":
            continue
        bid = s.get("bit") or s["id"]
        if bid not in bits:
            bits[bid] = []
            order.append(bid)
        bits[bid].append(s)
    return [{"id": b, "segs": bits[b], "text": " ".join(x.get("line") or x.get("sound_line") or "" for x in bits[b]).strip(),
             "t0": bits[b][0]["t0"], "t1": bits[b][-1]["t1"], "punch": bits[b][-1]["id"]} for b in order]


def entity_count(line, seen):
    toks = words(line)
    found = set()
    for i, w in enumerate(toks):
        bare = w.strip(".,'")
        lw = bare.lower()
        if any(ch.isdigit() for ch in bare) or lw in NUM_WORDS:
            found.add(lw)
        elif i > 0 and bare[:1].isupper() and not toks[i - 1].endswith((".", "?", "!")):
            found.add(lw)
    new = found - seen
    seen |= found
    return len(new)


def before_text(segments, idx, window, plants):
    s = segments[idx]
    lines = [x.get("line", "") for x in segments[:idx] if x["kind"] == "voice" and x["t1"] >= s["t0"] - window and x.get("line")]
    extra = []
    for cid in s.get("calls", []) if isinstance(s.get("calls"), list) else ([s["calls"]] if s.get("calls") else []):
        if cid in plants and plants[cid] not in lines:
            extra.append(f"(earlier in the video: \"{plants[cid]}\")")
    return " ".join(extra + lines).strip()


def cut_transcript(segments):
    rows = []
    for s in segments:
        if s["kind"] == "silence":
            continue
        t = f"[{int(s['t0'] // 60)}:{s['t0'] % 60:04.1f}]"
        said = f"narrator: {s['line']}" if s["kind"] == "voice" else f"clip: {s.get('sound_line') or '(no words)'}"
        parts = [t, said]
        if s.get("picture"):
            parts.append(f"on screen: {s['picture']}")
        if s.get("sound"):
            parts.append(f"heard: {s['sound']}")
        rows.append(" | ".join(parts))
    return "\n".join(rows)
