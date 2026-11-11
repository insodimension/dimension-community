import difflib
import hashlib
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

from framework.scriptstage import MODE_TEXT, write_engine_dir

from .gate import check, g11_rules, write
from .home import LIBRARY, audience_file, films_for
from .read import DD, load_film, read, tunables
from .units import estimate_timing, validate

STAGES = ("script", "cut")
LINK = "dopamine-debt.json"
VOICE_WPS = 2.7
KEYS = ("plants", "calls", "opens", "pays", "confirms_promise")
REVISION_FILES = ("script/lines.json", "spine.yaml", "intent.json")
G11_RECEIPT = Path("review") / "g11.json"
CLIP_KEY = re.compile(r"^(clip-[a-z0-9_\-]+?)-\d+-\d+\.[a-z0-9]+$", re.I)


def load_json(p):
    return json.loads(Path(p).read_text(encoding="utf8"))


def norm(w):
    return re.sub(r"[^a-z0-9]", "", w.lower())


def media_key(name):
    name = Path(name).name
    m = CLIP_KEY.match(name)
    return m.group(1).lower() if m else Path(name).stem.lower()


def resolve_link(production):
    p = production / LINK
    if not p.is_file():
        return None, [f"{p} naming the film revision: {{\"revision\": \"<film>/<rev>\", \"audiences\": {{\"<audience>\": \"personas/...md\"}}}}"]
    try:
        d = load_json(p)
    except ValueError as e:
        return None, [f"{p} as valid JSON ({e})"]
    missing = []
    if not isinstance(d.get("revision"), str) or not d["revision"]:
        missing.append(f"'revision' in {p}")
    if not isinstance(d.get("audiences"), dict) or not d["audiences"]:
        missing.append(f"'audiences' in {p}")
    if d.get("root", "films") not in ("films", "production"):
        missing.append(f"'root' in {p} as \"films\" or \"production\"")
    if missing:
        return None, missing
    base = production if d.get("root") == "production" else films_for(production)
    audiences = {a: str(audience_file(p, production)) for a, p in d["audiences"].items()}
    return {"revision": (base / d["revision"]).resolve(), "audiences": audiences}, []


def meme_rows(lines):
    return [x for x in lines if x["kind"] != "voice"]


def library_entry(m):
    return LIBRARY / m["library"] / "entry.json"


def speech_clips(edl):
    return [c for t in edl.get("tracks", []) if t.get("kind") == "speech" for c in t.get("clips", [])]


def prerequisites(stage, production):
    missing = []
    if stage not in STAGES:
        return [f"a stage named one of {STAGES} (got {stage!r})"]
    if not production.is_dir():
        return [f"the production folder {production}"]
    for name in ("taste.json", "tunables.json"):
        if not (DD / name).is_file():
            missing.append(f"the framework data {DD / name}")
    try:
        import yaml
    except ImportError:
        missing.append("the Python package pyyaml (spine.yaml)")
    lk, miss = resolve_link(production)
    missing += miss
    if lk is None:
        return missing
    rev = lk["revision"]
    if not rev.is_dir():
        return missing + [f"the film revision folder {rev}"]
    missing += [f"{rev / f}" for f in REVISION_FILES if not (rev / f).is_file()]
    missing += [f"the persona {p} for audience {a} (a relative path is read from the brand's productions/dopamine-debt folder, else from the kit)" for a, p in lk["audiences"].items() if not Path(p).is_file()]
    if (rev / "script/lines.json").is_file():
        for x in meme_rows(load_json(rev / "script/lines.json")):
            m = x.get("meme") or {}
            if m.get("library") and not library_entry(m).is_file():
                missing.append(f"the media library entry {library_entry(m)} for {x['id']}")
            if not m.get("library") and not m.get("description"):
                missing.append(f"a description for {x['id']}'s meme (it has no library entry)")
            if stage == "cut" and not m.get("file"):
                missing.append(f"'file' on {x['id']}'s meme, so the gate can find it in the cut")
    if stage == "cut":
        edl = production / "edl.json"
        if not edl.is_file():
            return missing + [f"the cut {edl}"]
        try:
            clips = speech_clips(load_json(edl))
        except ValueError as e:
            return missing + [f"{edl} as valid JSON ({e})"]
        if not clips:
            missing.append(f"a speech track with clips in {edl}")
        for ref in sorted({c.get("transcriptRef") or "" for c in clips}):
            if not ref or not (production / ref).is_file():
                missing.append(f"the transcript {production / ref if ref else '(a speech clip has no transcriptRef)'}")
        prev = rev / "framework" / "script"
        need = [prev / "gates.json"] + [prev / f"ledger.{a}.json" for a in lk["audiences"]]
        missing += [f"the script stage record {p} (run `dd gate script` first)" for p in need if not p.is_file()]
    return missing


def meme_description(m):
    if m.get("library"):
        return load_json(library_entry(m)).get("description", "")
    return m["description"]


def unit_base(x):
    s = {"id": x["id"], "act": x["act"], "bit": x["bit"], "carries": list(x.get("carries", []))}
    for k in KEYS:
        if x.get(k):
            s[k] = x[k]
    return s


def meme_fields(x, line, shown):
    m = x["meme"]
    gag = m.get("library") or m["tag"]
    picture = meme_description(m)
    if shown:
        picture = f"{picture} Shown {MODE_TEXT.get(m.get('mode'), m.get('mode') or 'on screen')}."
    return {"kind": "clip", "sound_line": line, "library": gag, "gag_id": gag, "mode": m.get("mode"), "picture": picture,
            "sound": f"the clip's own audio: \"{line}\"" if line else "the clip plays muted: no words heard"}


def script_segments(rev):
    out = []
    for x in load_json(rev / "script/lines.json"):
        s = unit_base(x)
        if x["kind"] == "voice":
            s.update(kind="voice", line=x["text"])
        else:
            s.update(meme_fields(x, x["meme"]["line"], False), dur=x["meme"]["dur"])
        out.append(s)
    segs = estimate_timing(out, VOICE_WPS)
    return segs, segs[-1]["t1"] if segs else 0.0, {"source": f"{rev / 'script/lines.json'} timed at {VOICE_WPS} words/s"}


def spoken_words(production, edl):
    fps = edl["fps"]
    words = []
    for c in speech_clips(edl):
        tr = load_json(production / c["transcriptRef"])
        a, b, rec = c["srcInFrame"] / fps, c["srcOutFrame"] / fps, c["recordStartFrame"] / fps
        speed = c.get("speed") or 1.0
        for w in tr["words"]:
            lo, hi = max(w["startSeconds"], a), min(w["endSeconds"], b)
            if hi >= lo and hi - lo >= 0.5 * (w["endSeconds"] - w["startSeconds"]):
                words.append({"t0": rec + (lo - a) / speed, "t1": rec + (hi - a) / speed, "text": w["text"]})
    return sorted(words, key=lambda w: w["t0"])


class MediaTags(HTMLParser):
    def __init__(self):
        super().__init__()
        self.items = []

    def handle_starttag(self, tag, attrs):
        if tag not in ("video", "audio"):
            return
        a = dict(attrs)
        if "src" in a and "data-start" in a:
            muted = "muted" in a or a.get("data-has-audio") == "false" or a.get("data-volume") == "0"
            self.items.append({"tag": tag, "src": a["src"], "start": float(a["data-start"]),
                               "dur": float(a.get("data-duration") or 0), "muted": muted})


def placed_media(production, edl):
    fps = edl["fps"]
    sources = {s["id"]: s for s in edl.get("sources", [])}
    out = []
    for t in edl.get("tracks", []):
        if t.get("kind") == "speech":
            continue
        for c in t.get("clips", []):
            src = sources.get(c["sourceId"])
            if not src:
                continue
            a, b, rec = c["srcInFrame"] / fps, c["srcOutFrame"] / fps, c["recordStartFrame"] / fps
            comp = production / "media" / "motion" / Path(src["path"]).stem / "index.html"
            if t.get("kind") == "graphics" and comp.is_file():
                tags = MediaTags()
                tags.feed(comp.read_text(encoding="utf8"))
                for it in tags.items:
                    lo, hi = max(it["start"], a), min(it["start"] + it["dur"], b)
                    if hi > lo:
                        out.append({"key": media_key(it["src"]), "file": Path(it["src"]).name, "tag": it["tag"], "start": rec + lo - a,
                                    "end": rec + hi - a, "audible": not it["muted"], "where": f"{c['id']} > {comp.parent.name}/index.html"})
            elif src.get("kind") == "video" and t.get("kind") != "graphics":
                audible = "gainDb" in c if t.get("kind") == "broll" else c.get("gainDb", 0) > -60
                out.append({"key": media_key(src["path"]), "file": Path(src["path"]).name, "tag": "video", "start": rec,
                            "end": rec + b - a, "audible": audible, "where": c["id"]})
    return sorted(out, key=lambda m: m["start"])


def merge_spans(items):
    spans = []
    for m in sorted(items, key=lambda m: m["start"]):
        if spans and m["start"] <= spans[-1]["end"]:
            last = spans[-1]
            last["end"] = max(last["end"], m["end"])
            last["audible"] = last["audible"] or m["audible"]
            last["where"] = sorted(set(last["where"]) | {m["where"]})
        else:
            spans.append({"start": m["start"], "end": m["end"], "audible": m["audible"], "where": [m["where"]]})
    return spans


def align(lines, words):
    script = [(x["id"], w) for x in lines if x["kind"] == "voice" for w in x["text"].split()]
    sm = difflib.SequenceMatcher(None, [norm(w) for _, w in script], [norm(w["text"]) for w in words], autojunk=False)
    owner = [None] * len(words)
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            for k in range(j2 - j1):
                owner[j1 + k] = script[i1 + k][0]
        elif op == "replace":
            for j in range(j1, j2):
                owner[j] = script[i1 + (j - j1) * (i2 - i1) // (j2 - j1)][0]
    for j in range(len(owner)):
        if owner[j] is None:
            owner[j] = owner[j - 1] if j > 0 else next((o for o in owner if o is not None), None)
    return owner


def cut_segments(production, rev):
    edl = load_json(production / "edl.json")
    fps = edl["fps"]
    lines = load_json(rev / "script/lines.json")
    by_id = {x["id"]: x for x in lines}
    words = spoken_words(production, edl)
    owner = align(lines, words)
    units, seen = [], {}
    for w, uid in zip(words, owner):
        if uid is None:
            uid = "unscripted"
        if units and units[-1]["src"] == uid:
            units[-1]["words"].append(w)
            continue
        seen[uid] = seen.get(uid, 0) + 1
        units.append({"src": uid, "id": uid if seen[uid] == 1 else f"{uid}~{seen[uid]}", "words": [w]})
    segs = []
    for u in units:
        x = by_id.get(u["src"])
        line = " ".join(w["text"] for w in u["words"])
        if x is None or u["id"] != u["src"]:
            bit = f"{x['bit']}~{u['id'].split('~')[-1]}" if x else u["id"]
            s = {"id": u["id"], "act": x["act"] if x else "", "bit": bit, "carries": []}
        else:
            s = unit_base(x)
        s.update(kind="voice", line=line, t0=u["words"][0]["t0"], heard1=u["words"][-1]["t1"])
        segs.append(s)
    media = placed_media(production, edl)
    rows = {media_key(x["meme"]["file"]): x for x in meme_rows(lines)}
    placed, not_in_cut, undescribed = [], [], []
    for key, x in rows.items():
        spans = merge_spans([m for m in media if m["key"] == key])
        if not spans:
            not_in_cut.append(x["id"])
        for k, sp in enumerate(spans):
            uid = x["id"] if k == 0 else f"{x['id']}~{k + 1}"
            line = x["meme"]["line"] if sp["audible"] else ""
            s = unit_base(x) if k == 0 else {"id": uid, "act": x["act"], "bit": f"{x['bit']}~{k + 1}", "carries": []}
            s.update(meme_fields(x, line, True), id=uid, t0=sp["start"], heard1=sp["end"])
            segs.append(s)
            placed.append({"unit": uid, "clip": key, "start": round(sp["start"], 3), "end": round(sp["end"], 3), "audible": sp["audible"], "where": sp["where"]})
    for m in media:
        if m["key"] not in rows and m["audible"] and (m["tag"] == "video" or m["key"].startswith("clip-")):
            undescribed.append({"clip": m["key"], "file": m["file"], "start": round(m["start"], 3), "where": m["where"]})
    duration = max((c["recordStartFrame"] + (c["srcOutFrame"] - c["srcInFrame"]) / (c.get("speed") or 1.0)) / fps
                   for t in edl.get("tracks", []) for c in t.get("clips", []))
    segs.sort(key=lambda s: s["t0"])
    for i, s in enumerate(segs):
        s["t0"] = 0.0 if i == 0 else round(s["t0"], 3)
        s["t1"] = round(segs[i + 1]["t0"], 3) if i + 1 < len(segs) else round(duration, 3)
        s["heard1"] = round(s["heard1"], 3)
    voiced = {u["src"] for u in units}
    info = {"source": f"{production / 'edl.json'} speech clips and their transcripts, plus the memes placed in its clips and compositions",
            "spokenUnits": sum(1 for s in segs if s["kind"] == "voice"),
            "memesPlaced": placed, "memesNotInCut": not_in_cut,
            "linesNotInCut": [x["id"] for x in lines if x["kind"] == "voice" and x["id"] not in voiced],
            "unscripted": [s["id"] for s in segs if s["id"].startswith("unscripted")]}
    return segs, round(duration, 3), info, undescribed


def g11_receipt(production, rules):
    p = production / G11_RECEIPT
    edl_hash = hashlib.sha256((production / "edl.json").read_bytes()).hexdigest()
    if not p.is_file():
        return {}, f"{p} is absent: the film's builder runs framework/g11.code_checks on this cut and writes {{edlHash, checked, unchecked}}"
    r = load_json(p)
    if r.get("edlHash") != edl_hash:
        return {}, f"{p} is not bound to this cut: its edlHash is {r.get('edlHash')!r}, the cut's is {edl_hash}"
    return {k: v for k, v in r.get("checked", {}).items() if k in rules}, None


def entry(gate, kind):
    return {"id": f"{gate['gate']} [{gate['for']}]", "message": f"{kind}{gate.get('status', '')}: {gate['detail']}"}


def verdict(stage, res, extra_blockers, notes):
    blockers = [entry(f, "") for f in res["hard_fails"]]
    blockers += [{"id": f"G11 {rule}", "message": "; ".join(map(str, vs))} for rule, vs in res["g11_fails"].items()]
    blockers += [entry(f | {"status": ""}, "not measured (unknown is not pass)") for f in res.get("unmeasured", [])]
    advisories = [entry(f, "advisory ") for f in res["advisory_fails"]]
    if res["g11_unchecked"]:
        item = {"id": "G11 unchecked", "message": f"not checked (unknown is not pass): {', '.join(res['g11_unchecked'])}"}
        if stage == "script":
            item["message"] = f"G11 build checks run on the cut, not the script: {', '.join(res['g11_unchecked'])}"
            advisories.append(item)
        else:
            blockers.append(item)
    blockers += extra_blockers
    advisories += notes
    score = res["score"]["score"] if res.get("score") else None
    return {"pass": not blockers, **({"score": score} if score is not None else {}), "blockers": blockers, "advisories": advisories}


def write_report(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n", encoding="utf8")


def cannot_run(path, missing, extra=None):
    write_report(path, {"pass": False, "blockers": [], "advisories": [], "missing": missing, **(extra or {})})
    print(f"missing: {'; '.join(missing)}", file=sys.stderr)
    return 2


class Unrunnable(Exception):
    def __init__(self, missing, context=None):
        super().__init__("; ".join(missing))
        self.missing = missing
        self.context = context or {}


def recorded_reviewer(engine_dir):
    path = engine_dir / "root.json"
    root = load_json(path) if path.is_file() else {}
    return root.get("juror_model"), root.get("juror_role")


def prepare(stage, production, juror_model=None, juror_role=None):
    import yaml
    missing = prerequisites(stage, production)
    if missing:
        raise Unrunnable(missing)
    lk, _ = resolve_link(production)
    rev = lk["revision"]
    engine_dir = rev / "framework" / stage
    extra_blockers, notes = [], []
    if stage == "script":
        segs, duration, info = script_segments(rev)
    else:
        segs, duration, info, undescribed = cut_segments(production, rev)
        extra_blockers += [{"id": f"unscored clip {u['clip']}", "message": f"the cut places {u['file']} at {u['start']} s ({u['where']}) but no lines.json meme row describes it, so its line cannot be read"} for u in undescribed]
        notes.append({"id": "cut read", "message": "a read of what is spoken in the cut and the memes placed in it; pictures are not read here (no vision pass), so on-screen facts do not count as carried"})
    errs = validate(segs, duration)
    context = {"stage": stage, "production": str(production), "revision": str(rev), "engineDir": str(engine_dir), stage: info}
    if errs:
        raise Unrunnable([f"a valid {stage} timeline ({e})" for e in errs], context)
    if juror_model is None or juror_role is None:
        juror_model, juror_role = recorded_reviewer(engine_dir)
    if not juror_model or not juror_role:
        raise Unrunnable([f"a review of the {stage} reads: nothing in {engine_dir} records which model read the jurors (the session runs dd.house.review, dopamine-debt-film Review)"], context)
    spine = yaml.safe_load((rev / "spine.yaml").read_text(encoding="utf8"))
    intent = load_json(rev / "intent.json")
    previous = None if stage == "script" else rev / "framework" / "script"
    write_engine_dir(engine_dir, segs, intent, spine, lk["audiences"], f"{rev.parent.name} {rev.name} {stage}", stage, previous, juror_model, juror_role)
    return engine_dir, segs, context, extra_blockers, notes


async def review(stage, production, judge_batch, completion, juror_model, juror_role):
    try:
        engine_dir, *_ = prepare(stage, Path(production).resolve(), juror_model, juror_role)
    except Unrunnable as e:
        raise RuntimeError(f"cannot review the {stage}: missing {e}") from e
    return await read(engine_dir, judge_batch, completion)


def run(stage, production, report_path):
    try:
        engine_dir, segs, context, extra_blockers, notes = prepare(stage, production)
    except Unrunnable as e:
        return cannot_run(report_path, e.missing, e.context)
    g11 = {}
    if stage == "cut":
        rules = set(g11_rules())
        g11, stale = g11_receipt(production, rules)
        if stale:
            notes.append({"id": "G11 receipt", "message": stale})
    res = check(engine_dir, load_film(engine_dir, tunables()), g11)
    unanswered = len(res["missing_reads"]) + len(res["missing_jurors"])
    if unanswered:
        return cannot_run(report_path, [f"{len(res['missing_reads'])} judge readouts and {len(res['missing_jurors'])} juror reads in {engine_dir} are unanswered: the session answers them with dd.house.review (dopamine-debt-film Review), then this gate runs again"], context)
    if res["ledgers"] is not None:
        write(engine_dir, res)
    report = verdict(stage, res, extra_blockers, notes) | context | {"status": res["status"], "units": len(segs), "answered_by": res["answered_by"]}
    write_report(report_path, report)
    return 0 if report["pass"] else 1


def main(argv):
    op, stage, production = argv[0], argv[1], Path(argv[2]).resolve()
    if op == "check":
        print(json.dumps({"missing": prerequisites(stage, production)}))
        return 0
    return run(stage, production, Path(argv[3]).resolve())


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
