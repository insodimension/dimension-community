import json
from pathlib import Path

from .derive import evaluate, memes
from .read import DD, context
from .run import Cache, collect, jurors_needed, reads_needed, watch_needed

JUDGE_RULES_READ_BY_DD_JURORS = {"deadpan"}
STAGE_KINDS = ("script", "storyboard", "cut", "seen")


def g11_rules():
    taste = json.loads((DD / "taste.json").read_text(encoding="utf8"))
    return [r["id"] for r in taste["rules"] if r["severity"] == "gate" and (r["check"] == "code" or (r["check"] == "judge" and r["id"] not in JUDGE_RULES_READ_BY_DD_JURORS))]


def previous_stage(film_dir, root, gated):
    if "previous" not in root:
        return {"missing": "root.json names no 'previous' stage directory (null at the first stage), so laugh conservation cannot be checked"}
    if root["previous"] is None:
        return None
    d = (Path(film_dir) / root["previous"]).resolve()
    record = d / "gates.json"
    ledgers = {a: d / f"ledger.{a}.json" for a in gated}
    absent = [p.name for p in [record, *ledgers.values()] if not p.is_file()]
    if absent:
        return {"missing": f"previous stage {d} has no {absent}: write it with dd.gate.write at the end of that stage"}
    rows = json.loads(record.read_text(encoding="utf8")).get("memes")
    if not rows or any(a not in rows for a in gated):
        return {"missing": f"previous stage {d}/gates.json holds no 'memes' record for {gated}"}
    lpm, duration = {}, None
    for a, p in ledgers.items():
        L = json.loads(p.read_text(encoding="utf8"))
        duration = L["duration"]
        lpm[a] = sum(b["fun"] for b in L["bits"].values()) / (duration / 60)
    return {"dir": str(d), "duration": duration, "lpm": lpm, "memes": rows}


def check(film_dir, film, g11):
    c = context(film_dir)
    tun = c["tun"]
    root = c["root"]
    gated = root["gated"]
    kind = root.get("kind")
    if kind is not None and kind not in STAGE_KINDS:
        raise ValueError(f"root.json kind {kind!r} is not one of {STAGE_KINDS}")
    rules = g11_rules()
    unknown = sorted(set(g11) - set(rules))
    if unknown:
        raise ValueError(f"G11 results for rules taste.json does not hold as code gates: {unknown}")
    out = {"status": None, "missing_reads": [], "missing_jurors": [], "hard_fails": [], "advisory_fails": [], "unmeasured": [],
           "g11_fails": {k: v for k, v in g11.items() if v}, "g11_unchecked": [r for r in rules if r not in g11],
           "per_audience": None, "film_gates": None, "score": None, "ledgers": None, "memes": None}
    readouts, out["missing_reads"] = collect(reads_needed(film, c["cards"], c["model"], c["window"]), Cache(c["cache"]))
    if out["missing_reads"]:
        out["status"] = "incomplete"
        return out
    jc = Cache(c["jury_cache"])
    jurors = []
    for n in jurors_needed(film, c["cards"], readouts, c["window"], root["juror_model"], c["trigger"]):
        hit = jc.get(n["key"])
        if hit:
            jurors.append(hit)
        else:
            out["missing_jurors"].append({"unit": n["unit"], "aud": n["aud"]})
    watch = {a: [] for a in gated}
    if kind == "seen":
        for n in watch_needed(film, c["cards"], root["juror_model"]):
            hit = jc.get(n["key"])
            if hit:
                watch[n["aud"]].append(hit["answers"])
            else:
                out["missing_jurors"].append({"unit": n["unit"], "aud": n["aud"], "draw": n["draw"]})
    if out["missing_jurors"]:
        out["status"] = "incomplete"
        return out
    stage = {"kind": kind, "previous": previous_stage(film_dir, root, gated), "watch": watch}
    ledgers, per, fg, sc = evaluate(film, readouts, jurors, tun, gated, stage)
    advisory = set(tun["values"]["advisory_gates"]["v"])
    rows = [(n, "film", x) for n, x in fg.items()] + [(n, a, x) for a in gated for n, x in per[a].items()]
    for n, who, x in rows:
        if x["status"] == "incomplete":
            out["unmeasured"].append({"gate": n, "for": who, "detail": x["detail"]})
        elif x["status"] != "pass":
            out["advisory_fails" if n in advisory else "hard_fails"].append({"gate": n, "for": who, "status": x["status"], "detail": x["detail"]})
    out.update({"per_audience": per, "film_gates": fg, "score": sc, "ledgers": ledgers, "memes": {a: memes(film, ledgers[a]) for a in gated},
                "reads": len(readouts), "juror_reads": len(jurors)})
    if out["hard_fails"] or out["g11_fails"]:
        out["status"] = "fail"
    elif out["g11_unchecked"] or out["unmeasured"]:
        out["status"] = "incomplete"
    else:
        out["status"] = "pass"
    return out


def write(film_dir, res):
    film_dir = Path(film_dir)
    if res["ledgers"] is None:
        raise ValueError(f"no ledger to write: dd.gate status {res['status']}\n{blockers(res)}")
    for a, L in res["ledgers"].items():
        (film_dir / f"ledger.{a}.json").write_text(json.dumps(L, ensure_ascii=False, indent=1, default=list), encoding="utf8")
    keep = ("status", "missing_reads", "missing_jurors", "hard_fails", "advisory_fails", "unmeasured", "g11_fails", "g11_unchecked", "film_gates", "per_audience", "score", "memes")
    record = {k: res[k] for k in keep} | {"blockers": blockers(res)}
    (film_dir / "gates.json").write_text(json.dumps(record, ensure_ascii=False, indent=1, default=list), encoding="utf8")


def blockers(res):
    lines = [f"render refused: dd.gate status {res['status']}" if res["status"] != "pass" else "dd.gate status pass"]
    if res["missing_reads"]:
        lines.append(f"  stale ledger: {len(res['missing_reads'])} readouts missing for the current units, e.g. {res['missing_reads'][:5]}")
    if res["missing_jurors"]:
        lines.append(f"  juror has not read {len(res['missing_jurors'])} triggered bits or whole-cut reads, e.g. {res['missing_jurors'][:5]}")
    for f in res["hard_fails"]:
        lines.append(f"  {f['gate']} [{f['for']}] {f['status']}: {f['detail']}")
    for rule, vs in res["g11_fails"].items():
        lines.append(f"  G11 {rule}: {len(vs)} violation(s)")
        lines.extend(f"    - {v}" for v in vs)
    if res["g11_unchecked"]:
        lines.append(f"  G11 not checked by this builder (unknown is not pass): {', '.join(res['g11_unchecked'])}")
    for f in res["unmeasured"]:
        lines.append(f"  {f['gate']} [{f['for']}] not measured (unknown is not pass): {f['detail']}")
    for f in res["advisory_fails"]:
        lines.append(f"  advisory {f['gate']} [{f['for']}] {f['status']}: {f['detail']}")
    return "\n".join(lines)
