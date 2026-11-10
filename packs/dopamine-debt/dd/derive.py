import math
from statistics import mean, pstdev

from .units import bits_of, entity_count

VARIANTS = [("A", 0), ("A", 1), ("B", 0), ("B", 1)]


def _choice_p(ans, label):
    return float(ans.get("probabilities", {}).get(label, 0.0))


def _heavy_p(ans):
    pr = ans.get("probabilities", {})
    return float(pr.get("2", 0.0)) + float(pr.get("3", 0.0))


def _pick(rows, variant):
    if variant is None:
        return rows
    return [r for r in rows if r["card"] == variant[0]]


def seg_probs(readouts, variant=None):
    acc = {}
    for r in readouts:
        if r["kind"] == "seg":
            acc.setdefault((r["unit"], r["aud"]), []).append(r)
    out = {}
    for k, rows in acc.items():
        rows = _pick(rows, variant)
        qs = ["follow", "follow_r"] if variant is None else (["follow"] if variant[1] == 0 else ["follow_r"])
        lost = [_choice_p(r["answers"][q], "lost") for r in rows for q in qs]
        clicked = [_choice_p(r["answers"][q], "clicked") for r in rows for q in qs]
        out[k] = {
            "lost": mean(lost), "lost_sd": pstdev(lost) if len(lost) > 1 else 0.0,
            "clicked": mean(clicked),
            "heavy": mean(_heavy_p(r["answers"]["load"]) for r in rows),
            "anchored": mean(float(r["answers"]["anchored"]["bool"]) for r in rows),
        }
    return out


def bit_probs(readouts, variant=None):
    acc = {}
    for r in readouts:
        if r["kind"] == "bit":
            acc.setdefault((r["unit"], r["aud"]), []).append(r)
    out = {}
    for k, rows in acc.items():
        rows = _pick(rows, variant)
        qs = ["affect", "affect_r"] if variant is None else (["affect"] if variant[1] == 0 else ["affect_r"])
        vals = {lab: [_choice_p(r["answers"][q], lab) for r in rows for q in qs] for lab in ("laugh", "smile", "flat", "cringe")}
        out[k] = {lab: mean(v) for lab, v in vals.items()}
        out[k]["laugh_sd"] = pstdev(vals["laugh"]) if len(vals["laugh"]) > 1 else 0.0
    return out


def carries_probs(readouts):
    return {r["unit"]: float(r["answers"]["carries"]["bool"]) for r in readouts if r["kind"] == "carries"}


def juror_probs(jurors):
    return {(r["unit"], r["aud"]): {"cringe": float(r["answers"].get("cringe", 0)), "laugh": float(r["answers"].get("laugh", 0)), "reason": r["answers"].get("reason", "")} for r in jurors}


def _tv(tun, k):
    return tun["values"][k]["v"]

def _cal_cringe(x, tun):
    m = tun["values"].get("juror_cringe_map", {}).get("v")
    if not m:
        return x
    xs, ys = m["x"], m["y"]
    if x <= xs[0]:
        return ys[0]
    for i in range(1, len(xs)):
        if x <= xs[i]:
            return ys[i - 1] if x < xs[i] else ys[i]
    return ys[-1]



def derive(film, readouts, jurors, tun, aud, variant=None):
    segs = [s for s in film["segments"]]
    dur = segs[-1]["t1"]
    bits = bits_of(segs)
    sp = seg_probs(readouts, variant)
    bp = bit_probs(readouts, variant)
    cp = carries_probs(readouts)
    jp = juror_probs(jurors)
    W = _tv(tun, "reward")
    Cw = _tv(tun, "cost")
    tau = _tv(tun, "tau_s")
    theta = _tv(tun, "theta")
    wall = _tv(tun, "wall")
    tp = _tv(tun, "trust_penalty")
    lp = _tv(tun, "loop_pay")
    seen = set()
    opens_at = {s["opens"]: s["t1"] for s in segs if s.get("opens")}
    seg_of_bit = {}
    for b in bits:
        for s in b["segs"]:
            seg_of_bit[s["id"]] = b
    rows = {}
    for s in segs:
        if s["kind"] == "silence":
            rows[s["id"]] = {"id": s["id"], "kind": s["kind"], "t0": s["t0"], "t1": s["t1"], "cost": 0.0, "reward": 0.0, "parts": {}}
            continue
        p = sp.get((s["id"], aud), {"lost": 0.0, "clicked": 0.0, "heavy": 0.0, "anchored": 0.0, "lost_sd": 0.0})
        ent = entity_count(s.get("line", ""), seen) if s["kind"] == "voice" else 0
        over = max(0, ent - _tv(tun, "entity_free")) * _tv(tun, "entity_cost")
        parts = {"lost": Cw["lost"] * p["lost"], "heavy": Cw["heavy"] * p["heavy"], "entities": over, "open_loop": Cw["open_loop"] if s.get("opens") else 0.0}
        wall_s = 0.0
        if s.get("screen_words_unspoken", 0) >= wall["min_words"] and not s.get("proof_paused"):
            wall_s = s["t1"] - s["t0"]
        facts = [f for f in s.get("carries", []) if cp.get(f"{s['id']}::{f}", 0) >= 0.5]
        rows[s["id"]] = {"id": s["id"], "kind": s["kind"], "t0": s["t0"], "t1": s["t1"], "line": s.get("line", ""), "p": p, "entities": ent,
                         "parts": parts, "wall_s": wall_s, "facts": facts, "declared_facts": s.get("carries", []),
                         "clicked_r": W["clicked"] * p["clicked"], "bit": seg_of_bit[s["id"]]["id"]}
    bitrows = {}
    last_cringe_t = -1e9
    gags = set()
    for b in bits:
        p = dict(bp.get((b["id"], aud), {"laugh": 0.0, "smile": 0.0, "flat": 1.0, "cringe": 0.0, "laugh_sd": 0.0}))
        j = jp.get((b["id"], aud))
        cr = _cal_cringe(j["cringe"], tun) if j else p["cringe"]
        unrelated = any(x.get("unrelated") for x in b["segs"])
        rel = W["unrelated_gag"] if unrelated else 1.0
        gag = next((x.get("gag_id") for x in b["segs"] if x.get("gag_id")), None)
        build = any(x.get("build_id") for x in b["segs"])
        calls = next((x.get("calls") for x in b["segs"] if x.get("calls")), None)
        rep = W["repeat"] if (gag and gag in gags and not build and not calls) else 1.0
        if gag:
            gags.add(gag)
        trust = tp["factor"] if b["t1"] - last_cringe_t <= tp["seconds"] else 1.0
        r = rel * (W["laugh"] * p["laugh"] * trust + W["smile"] * p["smile"]) * rep
        if calls:
            r += W["callback_bonus"]
        pays = next((x.get("pays") for x in b["segs"] if x.get("pays")), None)
        loop = 0.0
        if pays and pays in opens_at:
            loop = min(lp["cap"], lp["base"] + lp["per_s"] * max(0.0, b["t1"] - opens_at[pays]))
        if cr >= tp["cringe_p"]:
            last_cringe_t = b["t1"]
        bitrows[b["id"]] = {"id": b["id"], "t0": b["t0"], "t1": b["t1"], "text": b["text"], "p": p, "juror": j, "cringe": cr,
                            "reward": r, "loop_pay": loop, "pays": pays, "cringe_cost": Cw["cringe"] * cr, "unrelated": unrelated,
                            "segs": [x["id"] for x in b["segs"]], "fun": p["laugh"] + 0.5 * p["smile"], "laugh": p["laugh"] + 0.5 * p["smile"] >= _tv(tun, "laugh_cut")}
    events = []
    for b in bits:
        br = bitrows[b["id"]]
        loan = 0.0
        for x in b["segs"][:-1]:
            rr = rows[x["id"]]
            c = sum(v for k2, v in rr["parts"].items() if k2 != "open_loop")
            loan += c
            rr["loan"] = c
            if rr["parts"]["open_loop"]:
                events.append((x["t1"], "cost", rr["parts"]["open_loop"], x["id"]))
            events.append((x["t1"], "reward", rr["clicked_r"], x["id"]))
        last = rows[b["segs"][-1]["id"]]
        events.append((last["t1"], "cost", sum(last["parts"].values()), last["id"]))
        events.append((last["t1"], "reward", last["clicked_r"], last["id"]))
        if loan and not br["laugh"]:
            events.append((br["t1"], "cost", loan, b["id"]))
        br["loan_forgiven"] = loan if br["laugh"] else 0.0
        if br["cringe_cost"]:
            events.append((br["t1"], "cost", br["cringe_cost"], b["id"]))
        events.append((br["t1"], "reward_loop" if br["pays"] else "reward", br["reward"] + br["loop_pay"], b["id"]))
    n = int(math.ceil(dur))
    wall_rate = [0.0] * (n + 1)
    for r in rows.values():
        if r.get("wall_s"):
            for t in range(int(r["t0"]), min(n, int(math.ceil(r["t1"])))):
                wall_rate[t] += wall["per_s"]
    events.sort(key=lambda e: (e[0], 0 if e[1] == "cost" else 1))
    D, series, ei = 0.0, [], 0
    decay = math.exp(-1.0 / tau)
    for t in range(n + 1):
        D *= decay
        D += wall_rate[t]
        while ei < len(events) and events[ei][0] < t + 1:
            _, kind, val, _uid = events[ei]
            if kind == "cost":
                D += val
            elif kind == "reward_loop":
                D = max(0.0, D - val)
            else:
                D = max(0.0, D - min(val, _tv(tun, "generic_clear_frac") * D))
            ei += 1
        series.append(round(D, 3))
    for r in rows.values():
        if r["kind"] == "silence":
            continue
        own_r = r["clicked_r"]
        b = bitrows[r["bit"]]
        if b["segs"][-1] == r["id"]:
            own_r += b["reward"]
        own_c = sum(r["parts"].values()) + r["wall_s"] * wall["per_s"]
        r["net"] = own_r - own_c
        r["heavy"] = (own_c - own_r) >= _tv(tun, "heavy_net")
        if r["heavy"]:
            wall_part = r["wall_s"] * wall["per_s"]
            if wall_part >= 0.5 * own_c:
                r["move"] = "RE-TIME PAGE"
            elif not r["facts"] and not r["declared_facts"]:
                r["move"] = "CUT? (ablation)"
            elif b["laugh"]:
                r["move"] = "BAKED IN"
            else:
                r["move"] = "CARRY or PAY"
    return {"aud": aud, "duration": dur, "series": series, "segments": rows, "bits": bitrows, "events": events, "theta": theta}


def gates_for(film, L, tun, floored_audiences, other=None):
    segs = film["segments"]
    dur = L["duration"]
    bits = L["bits"]
    rows = L["segments"]
    g = {}
    laugh_bits = [b for b in bits.values() if b["laugh"]]
    laugh_t = sorted(b["t1"] for b in laugh_bits)
    co = _tv(tun, "cold_open")
    first = laugh_t[0] if laugh_t else None
    nouns = [w.lower() for w in film["spine"].get("packaging", {}).get("title_nouns", [])]
    thesis = next((b for b in bits.values() if b["laugh"]), None)
    has_nouns = bool(thesis and any(nn in thesis["text"].lower() for nn in nouns)) if nouns else None
    promise = any(s.get("confirms_promise") and s["t1"] <= co["promise_by_s"] for s in segs)
    opener = next((s.get("line", "") for s in segs if s["kind"] == "voice"), "")
    ok2 = bool(first is not None and first <= co["thesis_by_s"] and has_nouns is not False and promise and not opener.lower().startswith("this is"))
    g["G2 Cold open"] = {"status": "pass" if ok2 else "fail", "detail": f"first laugh at {first if first is None else round(first,1)} s (≤ {co['thesis_by_s']}); title nouns in it: {has_nouns}; promise confirmed by {co['promise_by_s']} s: {promise}; opener: \"{opener[:40]}\""}
    veto = _tv(tun, "cringe_veto_p")
    cr = [(b["id"], round((b["juror"] or {}).get("cringe", 0.0), 2), (b["juror"] or {}).get("reason", "")) for b in bits.values() if (b["juror"] or {}).get("cringe", 0.0) >= veto]
    mb = meme_bits(film)
    written = [x for x in cr if x[0] not in mb]
    memed = [x for x in cr if x[0] in mb]
    banned = [w for w in film.get("banned", []) for s in segs if w in (s.get("line", "") or "").lower()]
    g["G3 Cringe veto"] = {"status": "fail" if written or banned else "pass", "detail": f"{len(written)} written bits with juror cringe ≥ {veto} (fitted on text lines: recall 0.92, 2% false alarms): {written[:4]}; banned strings: {banned}"}
    g["G3m Meme cringe"] = {"status": "fail" if memed else "pass", "detail": f"{len(memed)} meme bits with juror cringe ≥ {veto}; advisory until the juror's meme calibration is ruled on, so a meme is never cut for this: {memed[:4]}"}
    vs = [r for r in rows.values() if r["kind"] == "voice"]
    vsec = sum(r["t1"] - r["t0"] for r in vs) or 1.0
    lost_p = _tv(tun, "lost_p")
    lost_sec = sum(r["t1"] - r["t0"] for r in vs if r["p"]["lost"] >= lost_p)
    share = 1 - lost_sec / vsec
    run, worst = 0, 0
    for r in vs:
        run = run + 1 if r["p"]["lost"] >= lost_p else 0
        worst = max(worst, run)
    rf = _tv(tun, "retell_follow_p")
    weak_facts = [r["id"] for r in vs if r["facts"] and (1 - r["p"]["lost"]) < rf]
    ok4 = share >= _tv(tun, "follow_seconds_share") and worst < 3 and not weak_facts
    g["G4 Nobody lost"] = {"status": "pass" if ok4 else "fail", "detail": f"{share:.0%} of voice seconds followed (≥ {_tv(tun,'follow_seconds_share'):.0%}); longest lost run {worst} (< 3); retell units below {rf}: {weak_facts[:5]}", "value": share}
    lo = _tv(tun, "laugh_floor_per_min")
    floored = L["aud"] in floored_audiences
    lpm = sum(b["p"]["laugh"] + 0.5 * b["p"]["smile"] for b in bits.values()) / (dur / 60)
    joke_share = sum(1 for r in vs if bits[r["bit"]]["laugh"] and bits[r["bit"]]["segs"][-1] == r["id"]) / max(1, len(vs))
    fact_bits = [b for b in laugh_bits if any(rows[s]["facts"] for s in b["segs"] if s in rows)]
    fact_share = len(fact_bits) / max(1, len(laugh_bits))
    ok5 = (lpm >= lo or not floored) and joke_share <= _tv(tun, "max_joke_sentence_share")
    floor_text = f"floor {lo}" if floored else "no floor for this audience"
    g["G5 Laugh rate"] = {"status": "pass" if ok5 else "fail", "detail": f"{lpm:.2f} E[laugh + ½ smile]/min ({floor_text}, fitted on SEEN reads); {joke_share:.0%} of lines in a landing bit (≤ {_tv(tun,'max_joke_sentence_share'):.0%})", "value": lpm, "floored": floored, "joke_ok": joke_share <= _tv(tun, "max_joke_sentence_share")}
    g["G5f Fact laughs"] = {"status": "pass" if fact_share >= _tv(tun, "min_fact_laugh_share") else "fail", "detail": f"{fact_share:.0%} of laughs carry a fact ({len(fact_bits)} of {len(laugh_bits)}; ≥ {_tv(tun,'min_fact_laugh_share'):.0%}, unfitted: the SEEN pair does not separate on it)", "value": fact_share}
    theta = L["theta"]
    s_ok = sum(1 for d in L["series"] if d <= theta) / len(L["series"])
    heavy = sorted((r["t1"], r["id"]) for r in rows.values() if r.get("heavy"))
    rewards = sorted(e[0] for e in L["events"] if e[1].startswith("reward") and e[2] >= 1.0)
    dbl = []
    for (t1, a), (t2, b2) in zip(heavy, heavy[1:]):
        if t2 - t1 <= _tv(tun, "double_heavy_s") and not any(t1 < x < t2 for x in rewards):
            dbl.append((a, b2))
    ok6 = s_ok >= _tv(tun, "strain_seconds_share") and not dbl
    g["G6 Strain"] = {"status": "pass" if ok6 else "fail", "detail": f"{s_ok:.0%} of seconds under θ={theta} (≥ {_tv(tun,'strain_seconds_share'):.0%}); unpaid double-heavy: {dbl[:4]}", "value": s_ok}
    gp = _tv(tun, "gaps")
    pts = [0.0] + laugh_t + [dur]
    bad, valleys = [], []
    for a, b2 in zip(pts, pts[1:]):
        gap = b2 - a
        edge = a < gp["open_s"] or b2 > dur - gp["close_s"]
        if edge and gap > gp["edge_gap_s"]:
            bad.append(f"{a:.0f}–{b2:.0f}s ({gap:.0f}s, edge)")
        elif not edge and gap > gp["edge_gap_s"]:
            opens = any(s.get("opens") and a <= s["t0"] <= b2 for s in segs)
            after = sum(1 for x in laugh_t if b2 <= x <= b2 + gp["after_valley_s"])
            valleys.append((a, b2))
            if gap > gp["valley_s"] or not opens or after < gp["after_valley_laughs"]:
                bad.append(f"{a:.0f}–{b2:.0f}s ({gap:.0f}s valley; opens loop {opens}; laughs after {after})")
    for v1, v2 in zip(valleys, valleys[1:]):
        if v2[0] - v1[0] < gp["valley_per_s"]:
            bad.append(f"two valleys within {gp['valley_per_s']}s at {v1[0]:.0f}s and {v2[0]:.0f}s")
    g["G7 Laugh gaps"] = {"status": "fail" if bad else "pass", "detail": "; ".join(bad[:6]) or "all gaps within rules"}
    facts = [f for r in film["intent"]["retell"] for f in r["facts"]]
    fe = _tv(tun, "fact_encodings")
    need_n = fe["min"] if dur >= fe["short_below_s"] else fe["short_min"]
    fact_detail, fact_ok, checks = [], True, []
    for f in facts:
        hits = sorted((r["t1"], r) for r in rows.values() if f["id"] in r.get("facts", []))
        times = [h[0] for h in hits]
        thirds = {min(2, int(3 * t / dur)) for t in times}
        anchored = any(h[1]["p"]["anchored"] >= 0.5 for h in hits)
        last_ok = bool(times) and times[-1] >= dur - fe["last_in_final_s"]
        c = [len(times) >= need_n, len(thirds) >= 2, last_ok, anchored]
        checks.extend(c)
        if not all(c):
            fact_ok = False
            fact_detail.append(f"{f['id']}: {len(times)}× in thirds {sorted(thirds)}, last {times[-1] if times else None}, anchored {anchored}")
    gag_after = []
    fact_ends = [r["t1"] for r in rows.values() if r.get("facts")]
    for b in bits.values():
        if b["unrelated"] and any(0 <= b["t0"] - t <= fe["no_gag_after_s"] for t in fact_ends):
            gag_after.append(b["id"])
    ok9 = fact_ok and not gag_after
    g["G9 Facts"] = {"status": "pass" if ok9 else "fail", "detail": ("; ".join(fact_detail) or f"all retell facts encoded ≥{need_n}×, spread, last in final 20 s, anchored") + (f"; unrelated gags right after facts: {gag_after}" if gag_after else ""), "value": sum(checks) / max(1, len(checks))}
    pk = _tv(tun, "peak")
    peak = [b for b in bits.values() if b["fun"] >= pk["fun"] and pk["window"][0] <= b["t1"] / dur <= pk["window"][1]]
    en = _tv(tun, "end")
    tail = [e for e in L["events"] if e[0] >= dur - en["window_s"]]
    units = {e[3] for e in tail}
    net = (sum(e[2] for e in tail if e[1].startswith("reward")) - sum(e[2] for e in tail if e[1] == "cost")) / max(1, len(units))
    d_end = L["series"][-1]
    ok10 = bool(peak) and net >= en["min_net"] and d_end < en["max_d"]
    g["G10 Peak and end"] = {"status": "pass" if ok10 else "fail", "detail": f"peak bits (laugh + ½ smile ≥ {pk['fun']} in middle 40%): {[b['id'] for b in peak][:3]}; mean net over last {en['window_s']} s {net:+.2f} (≥ {en['min_net']}); D at end {d_end:.2f} (< {en['max_d']})"}
    return g


def film_gates(film, ledgers, tun, readouts, gated):
    g = {}
    sp = film["spine"]
    need = ["packaging", "premise", "take", "narrator", "voice_mode", "anchor_world", "money_object", "retell", "acts", "callbacks"]
    missing = [k for k in need if not sp.get(k)]
    fal = next((float(r["answers"]["falsifiable"]["bool"]) for r in readouts if r["kind"] == "take"), None)
    acts = sp.get("acts", [])
    turns = [a.get("turn") for a in acts[1:]]
    turn_ok = (sum(1 for t in turns if t in ("but", "therefore")) / max(1, len(turns))) >= 0.7
    rungs = [a.get("stake_rung", 0) for a in acts]
    rung_ok = all(b > a for a, b in zip(rungs, rungs[1:]))
    segs = film["segments"]
    plant_t = {s["plants"]: s["t1"] for s in segs if s.get("plants")}
    call_t = {}
    for s in segs:
        if s.get("calls"):
            call_t.setdefault(s["calls"], []).append(s["t0"])
    gap = min(_tv(tun, "callback_min_gap_s"), _tv(tun, "callback_min_gap_frac") * max((s["t1"] for s in segs), default=0))
    cb_bad = [c for c, t in plant_t.items() if not call_t.get(c) or min(call_t[c]) - t < gap]
    checks = [not missing, fal is not None and fal >= 0.6, turn_ok, rung_ok, not cb_bad]
    g["G1 Spine"] = {"status": "pass" if all(checks) else "fail", "detail": f"missing {missing}; take falsifiable {fal if fal is None else round(fal,2)}; but/therefore turns ok {turn_ok}; stakes rising {rung_ok}; callbacks short (under {round(gap,1)} s) or unpaid {cb_bad}", "value": sum(checks) / len(checks)}
    opens = {s["opens"]: s["t0"] for s in segs if s.get("opens")}
    pays = {s["pays"]: s["t0"] for s in segs if s.get("pays")}
    unclosed = [o for o, t in opens.items() if o not in pays or pays[o] < t]
    cold = [c for c, t in plant_t.items() if t <= 15]
    last_bit = [s for s in segs if s["kind"] != "silence"][-3:]
    final_calls = any(s.get("calls") in cold for s in last_bit)
    g["G8 Loops"] = {"status": "pass" if not unclosed and not cb_bad and final_calls else "fail", "detail": f"unclosed loops {unclosed}; unpaid callbacks {cb_bad}; ending calls the cold open: {final_calls}"}
    ms = _tv(tun, "min_shared_laugh_share")
    laughs_any = set()
    for a in gated:
        laughs_any |= {b for b, r in ledgers[a]["bits"].items() if r["laugh"]}
    shared = [b for b in laughs_any if all(ledgers[a]["bits"][b]["laugh"] for a in gated)]
    sh = len(shared) / max(1, len(laughs_any))
    singles = sorted(ledgers[gated[0]]["bits"][b]["t1"] for b in laughs_any - set(shared))
    crowd = [round(t) for a_, t in zip(singles, singles[1:]) if t - a_ < _tv(tun, "single_audience_joke_s")]
    ok = (sh >= ms or len(gated) == 1) and not crowd
    g["G5b Shared laughs"] = {"status": "pass" if ok else "fail", "detail": f"{sh:.0%} of laughs land for every gated audience (≥ {ms:.0%}); single-audience jokes closer than {_tv(tun,'single_audience_joke_s')} s at {crowd[:5]}"}
    return g


def score(film, ledgers, per_aud_gates, fgates, tun, gated):
    out = {}
    lo = _tv(tun, "laugh_floor_per_min")
    for a in gated:
        G = per_aud_gates[a]
        lpm = G["G5 Laugh rate"]["value"]
        band = 1.0 if not G["G5 Laugh rate"]["floored"] else min(1.0, lpm / lo)
        comp = min(1.0, G["G4 Nobody lost"]["value"] / _tv(tun, "follow_seconds_share"))
        keep = G["G9 Facts"]["value"]
        strain = G["G6 Strain"]["value"]
        spine = fgates["G1 Spine"]["value"]
        parts = {"laughs": band, "clarity": comp, "facts kept": keep, "strain": strain, "spine": spine}
        gm = math.exp(mean(math.log(max(0.01, v)) for v in parts.values()))
        out[a] = {"score": round(100 * gm, 1), "parts": {k: round(v, 3) for k, v in parts.items()}}
    advisory = set(_tv(tun, "advisory_gates"))
    allg = [(n, x) for n, x in fgates.items()] + [(n, x) for a in gated for n, x in per_aud_gates[a].items()]
    failing = [x for n, x in allg if x["status"] == "fail" and n not in advisory]
    advisory_fails = sorted({n for n, x in allg if x["status"] == "fail" and n in advisory})
    s = min(v["score"] for v in out.values())
    capped = min(s, 49.0) if failing else s
    return {"per_audience": out, "raw": s, "score": capped, "capped": bool(failing), "failing": len(failing), "advisory_fails": advisory_fails}


DISPLAYS = {"full", "cutout", "ghost", "inset"}
LARGE = {"full", "cutout", "ghost"}


def meme_bits(film):
    lib = set(film["library"])
    return {s["bit"] for s in film["segments"] if s["kind"] == "clip" and s.get("library") in lib}


def memes(film, L):
    lib = set(film["library"])
    return [{"unit": s["id"], "gag": s["gag_id"], "library": s.get("library") if s.get("library") in lib else None, "mode": s.get("mode"), "display": s.get("display"),
             "replaces": s.get("replaces"), "t": s["t0"], "dur": round(s["t1"] - s["t0"], 3), "bit": s["bit"], "fun": L["bits"][s["bit"]]["fun"]}
            for s in film["segments"] if s.get("gag_id")]


def dry_voice_run(film, L):
    last = {b["segs"][-1]: b for b in L["bits"].values()}
    run, worst, start, span = 0.0, 0.0, 0.0, (0.0, 0.0)
    for s in film["segments"]:
        if s["kind"] == "voice":
            if not run:
                start = s["t0"]
            run += s["t1"] - s["t0"]
        b = last.get(s["id"])
        if b and b["laugh"]:
            if run > worst:
                worst, span = run, (start, s["t1"])
            run = 0.0
    if run > worst:
        worst, span = run, (start, film["segments"][-1]["t1"])
    return worst, span


def entertainment(film, ledgers, watch, tun, gated):
    e = _tv(tun, "entertainment")
    segs = film["segments"]
    dur = segs[-1]["t1"]
    lib = set(film["library"])
    ms = [s for s in segs if s["kind"] == "clip" and s.get("library") in lib]
    unseen = [s["id"] for s in ms if s.get("display") not in DISPLAYS]
    if unseen:
        return {"status": "incomplete", "detail": f"memes with no seen 'display' (full|cutout|ghost|inset from the F-15 frames): {unseen}"}
    mpm = len(ms) / (dur / 60)
    shown = sum(s["t1"] - s["t0"] for s in ms)
    large = sum(s["t1"] - s["t0"] for s in ms if s["display"] in LARGE) / shown if shown else 0.0
    fails = []
    parts = [f"memes/min {mpm:.2f} ({len(ms)} library memes; ≥ {e['memes_per_min']})", f"large meme share {large:.0%} of {shown:.1f} s (≥ {e['large_meme_share']:.0%})"]
    if mpm < e["memes_per_min"]:
        fails.append("memes/min")
    if large < e["large_meme_share"]:
        fails.append("large meme share")
    for a in gated:
        L = ledgers[a]
        lpm = sum(1 for b in L["bits"].values() if b["laugh"]) / (dur / 60)
        dry, span = dry_voice_run(film, L)
        reads = watch[a]
        keep = mean(float(r["keep_watching"]) for r in reads)
        left = mean(float(r["left_at_s"]) for r in reads)
        why = min(reads, key=lambda r: float(r["keep_watching"]))["reason"]
        parts.append(f"{a}: landed laughs/min {lpm:.2f} (≥ {e['laughs_per_min']}); longest voice run without a laugh or smile {dry:.1f} s at {span[0]:.0f}–{span[1]:.0f} s (≤ {e['max_dry_voice_s']}); "
                     f"keep watching {keep:.2f} over {len(reads)} reads (≥ {e['keep_watching']}), leaves at {left:.0f} s: \"{why}\"")
        if lpm < e["laughs_per_min"]:
            fails.append(f"{a} landed laughs/min")
        if dry > e["max_dry_voice_s"]:
            fails.append(f"{a} voice run without a laugh")
        if keep < e["keep_watching"]:
            fails.append(f"{a} keep watching")
    return {"status": "fail" if fails else "pass", "detail": (f"failing: {', '.join(fails)}; " if fails else "") + "; ".join(parts), "failing": fails}


def conservation(film, ledgers, per, prev, tun, gated):
    if prev is None:
        return {"status": "pass", "detail": "first stage: nothing to conserve"}
    if "missing" in prev:
        return {"status": "incomplete", "detail": prev["missing"]}
    segs = film["segments"]
    dur = segs[-1]["t1"]
    k = _tv(tun, "uncertain_sd")
    fails, parts = [], []
    for a in gated:
        g5 = per[a]["G5 Laugh rate"]
        was = prev["lpm"][a]
        if g5["value"] < was - k * g5["sd"]:
            fails.append(f"{a} lost laughs/min {was:.2f} → {g5['value']:.2f} (more than {k} SD = {g5['sd']:.2f})")
        else:
            parts.append(f"{a} laughs/min {was:.2f} → {g5['value']:.2f}")
    then = {a: {r["gag"]: r for r in prev["memes"][a]} for a in gated}
    cur = {s["gag_id"] for s in segs if s.get("gag_id")}
    repl = {s["replaces"]: s for s in segs if s.get("replaces")}
    lib = set(film["library"])
    for gag, r in then[gated[0]].items():
        if gag in cur:
            continue
        s = repl.get(gag)
        if not s:
            fails.append(f"lost {gag} ({r['unit']}) with no logged replacement")
            continue
        if s.get("library") not in lib:
            fails.append(f"{s['gag_id']} replaces {gag} from outside the media library ({s.get('library')})")
        worse = [f"{a} {ledgers[a]['bits'][s['bit']]['fun']:.2f} < {then[a][gag]['fun']:.2f}" for a in gated if ledgers[a]["bits"][s["bit"]]["fun"] < then[a][gag]["fun"]]
        if worse:
            fails.append(f"{s['gag_id']} replaces {gag} at a lower value: {', '.join(worse)}")
    had = len(prev["memes"][gated[0]])
    need = round(had * dur / prev["duration"])
    have = sum(1 for s in segs if s.get("gag_id"))
    (fails if have < need else parts).append(f"memes and clips {had} in {prev['duration']:.0f} s → {have} in {dur:.0f} s (needs ≥ {need} to keep the previous rate)")
    return {"status": "fail" if fails else "pass", "detail": f"against {prev['dir']}: " + "; ".join(fails + parts), "failing": fails}


def evaluate(film, readouts, jurors, tun, gated, stage, floored):
    ledgers = {a: derive(film, readouts, jurors, tun, a) for a in gated}
    per = {a: gates_for(film, ledgers[a], tun, floored) for a in gated}
    lo = _tv(tun, "laugh_floor_per_min")
    dur = film["segments"][-1]["t1"]
    for a in gated:
        vals = []
        for v in VARIANTS:
            bp = bit_probs(readouts, v)
            vals.append(sum(bp[(b["id"], a)]["laugh"] + 0.5 * bp[(b["id"], a)]["smile"] for b in bits_of(film["segments"])) / (dur / 60))
        sd = pstdev(vals)
        g5 = per[a]["G5 Laugh rate"]
        g5["sd"] = sd
        x = g5["value"]
        if g5["status"] == "fail" and g5["joke_ok"] and g5["floored"] and lo - x <= _tv(tun, "uncertain_sd") * sd:
            g5["status"] = "uncertain"
            g5["detail"] += f"; within 1 SD ({sd:.2f}) of the floor across the K variants, so it goes to the person, not decided automatically"
    fg = film_gates(film, ledgers, tun, readouts, gated)
    fg["G13 Laughs kept"] = conservation(film, ledgers, per, stage["previous"], tun, gated)
    if stage["kind"] == "seen":
        fg["G12 Entertainment"] = entertainment(film, ledgers, stage["watch"], tun, gated)
    elif stage["kind"] is None:
        fg["G12 Entertainment"] = {"status": "incomplete", "detail": "root.json has no 'kind' (script|storyboard|cut|seen), so it is unknown whether the SEEN entertainment gate applies"}
    sc = score(film, ledgers, per, fg, tun, gated)
    sds = []
    for v in VARIANTS:
        lv = {a: derive(film, readouts, jurors, tun, a, v) for a in gated}
        pv = {a: gates_for(film, lv[a], tun, floored) for a in gated}
        sds.append(score(film, lv, pv, film_gates(film, lv, tun, readouts, gated), tun, gated)["raw"])
    sc["sd"] = round(pstdev(sds), 1)
    sc["variants"] = sds
    return ledgers, per, fg, sc
