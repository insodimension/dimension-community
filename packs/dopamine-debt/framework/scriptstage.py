import json
import os
import re
from pathlib import Path

MODE_TEXT = {
    "fullscreen": "full frame",
    "spotlight": "a small round inset",
    "slot": "filling the cell",
    "ghost": "a large translucent ghost",
    "cutout": "keyed out, standing over the scene",
    "framed": "as a framed clip at the edge of the frame",
    "sound": "as sound only, over the narration's picture",
}
SKIP_TOKENS = ("CEO", "AI", "IOU", "IPO", "S-1", "S-1/A")


def picture_text(x):
    return " / ".join(p.get("what") or p.get("text") or "" for p in x.get("pictures", []))


def on_screen(x):
    found = []
    for p in x.get("pictures", []):
        if p["k"] == "STK":
            found.append(p["text"])
            continue
        what = p.get("what", "")
        found += re.findall(r"'([^']{2,})'", what)
        found += re.findall(r"(?<![a-z])((?:[A-Z0-9$][A-Z0-9$.,:%×→()/·&'’ -]*[A-Z0-9$%)])(?:\s*[:=]\s*[A-Z0-9$][A-Z0-9$.,%×()/ -]*)?)", re.sub(r"'[^']*'", " ", what))
    keep = [f.strip() for f in found if sum(c.isalpha() for c in f) >= 2 or "$" in f or "%" in f]
    return [k for k in keep if len(k) > 1 and k not in SKIP_TOKENS]


def unspoken(texts, line):
    spoken = {w.strip(".,:;'\"()").lower() for w in (line or "").split()}
    words = [w.strip(".,:;'\"()→·").lower() for t in texts for w in t.split()]
    return [w for w in words if w and w not in spoken and not re.fullmatch(r"[$\d.,%×:]+[bmk]?", w)]


def write_engine_dir(out, segs, intent, spine, audiences, stage_label, kind, previous, juror_model, juror_role):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "segments.json").write_text(json.dumps(segs, ensure_ascii=False, indent=1), encoding="utf8")
    (out / "intent.json").write_text(json.dumps(intent, ensure_ascii=False, indent=1), encoding="utf8")
    (out / "spine.json").write_text(json.dumps(spine, ensure_ascii=False, indent=1), encoding="utf8")
    link = None if previous is None else Path(os.path.relpath(Path(previous).resolve(), out.resolve())).as_posix()
    root = {"audiences": audiences, "juror_model": juror_model, "juror_role": juror_role, "stage": stage_label, "kind": kind, "previous": link, "gated": list(audiences)}
    (out / "root.json").write_text(json.dumps(root, ensure_ascii=False, indent=1), encoding="utf8")
    return out
