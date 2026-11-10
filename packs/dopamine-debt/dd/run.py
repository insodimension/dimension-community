import hashlib
import json
from pathlib import Path

from .derive import bit_probs
from .questions import (CARRIES, FALSIFIABLE, JUROR_SCHEMA, QUESTION_VERSION, WATCH_SCHEMA, bit_questions, juror_prompt,
                        segment_questions, watch_prompt)
from .units import before_text, bits_of, cut_transcript

WATCH_DRAWS = 3


def _key(model, qs, state):
    raw = json.dumps([model, QUESTION_VERSION, qs, state], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode()).hexdigest()


class Cache:
    def __init__(self, path):
        self.path = Path(path)
        self.rows = {}
        if self.path.exists():
            for line in self.path.read_text(encoding="utf8").splitlines():
                if line.strip():
                    r = json.loads(line)
                    self.rows[r["key"]] = r

    def get(self, k):
        return self.rows.get(k)

    def put(self, row):
        self.rows[row["key"]] = row
        with self.path.open("a", encoding="utf8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


async def _judge(judge_batch, states, qs, intent, attempts=3):
    out = {}
    todo = dict(states)
    errors = {}
    for _ in range(attempts):
        if not todo:
            break
        b = judge_batch(todo, qs, intent=intent)
        while True:
            got = await b.drain(timeout=180)
            for k, it in got:
                if getattr(it, "answers", None):
                    out[k] = it.answers
                else:
                    errors[k] = str(getattr(it, "error", "no answer"))
            st = b.status()
            if st["done"] >= st["total"]:
                break
        todo = {k: v for k, v in todo.items() if k not in out}
    if todo:
        raise RuntimeError(f"judge returned no answer for {len(todo)} states ({intent}): {[(k, errors.get(k)) for k in list(todo)[:3]]}")
    return out


def _state(seg, before):
    st = {"before": before, "line": seg.get("line") or seg.get("sound_line") or ""}
    if seg.get("picture"):
        st["picture"] = seg["picture"]
    if seg.get("sound"):
        st["sound"] = seg["sound"]
    return st


def _context(segs):
    plants = {s["plants"]: s.get("line", "") for s in segs if s.get("plants")}
    idx = {s["id"]: i for i, s in enumerate(segs)}
    return plants, idx


def _bit_media(b):
    pic = " / ".join(x["picture"] for x in b["segs"] if x.get("picture"))
    snd = " / ".join(x["sound"] for x in b["segs"] if x.get("sound"))
    return pic, snd


def _need(model, qs, st, kind, unit, aud=None, card=None):
    tag = {"kind": kind, "unit": unit}
    if aud is not None:
        tag.update({"aud": aud, "card": card})
    return {"key": _key(model, qs, st), "tag": tag, "state": st, "qs": qs}


def reads_needed(film, cards, model, window):
    segs = film["segments"]
    plants, idx = _context(segs)
    seg_states = {s["id"]: _state(s, before_text(segs, i, window, plants)) for i, s in enumerate(segs) if s["kind"] != "silence"}
    bit_states = {}
    for b in bits_of(segs):
        st = {"before": before_text(segs, idx[b["segs"][0]["id"]], window, plants), "line": b["text"]}
        pic, snd = _bit_media(b)
        if pic:
            st["picture"] = pic
        if snd:
            st["sound"] = snd
        for x in b["segs"]:
            cid = x.get("calls")
            if cid and cid in plants:
                st["before"] = f"(earlier in the video: \"{plants[cid]}\") " + st["before"]
        bit_states[b["id"]] = st
    needs = []
    for aud, card in cards.items():
        for v in ("A", "B"):
            for kind, states, qs in (("seg", seg_states, segment_questions(card[v])), ("bit", bit_states, bit_questions(card[v]))):
                needs.extend(_need(model, qs, st, kind, uid, aud, v) for uid, st in states.items())
    facts = {f["id"]: f["text"] for r in film["intent"]["retell"] for f in r["facts"]}
    facts.update({f["id"]: f["text"] for f in film["intent"].get("support", [])})
    for s in segs:
        for fid in s.get("carries", []):
            st = {"line": s.get("line") or s.get("sound_line") or "", "fact": facts[fid]}
            if s.get("picture"):
                st["picture"] = s["picture"]
            needs.append(_need(model, CARRIES, st, "carries", f"{s['id']}::{fid}"))
    take = film["spine"].get("take")
    if take:
        needs.append(_need(model, FALSIFIABLE, {"take": take}, "take", "take"))
    return needs


def collect(needs, cache):
    readouts, missing = [], []
    for n in needs:
        hit = cache.get(n["key"])
        if hit:
            r = dict(hit)
            r.update(n["tag"])
            readouts.append(r)
        else:
            missing.append(n["tag"])
    return readouts, missing


async def read_film(film, cards, judge_batch, cache_path, model, window, stage):
    cache = Cache(cache_path)
    needs = reads_needed(film, cards, model, window)
    groups = {}
    for n in needs:
        if not cache.get(n["key"]):
            t = n["tag"]
            label = f"{t['aud']}/{t['card']} {t['kind']}" if "aud" in t else t["kind"]
            groups.setdefault(label, []).append(n)
    judged = 0
    for label, group in groups.items():
        todo = {n["tag"]["unit"]: n for n in group if not cache.get(n["key"])}
        got = await _judge(judge_batch, {u: n["state"] for u, n in todo.items()}, group[0]["qs"], f"DD {stage} {label}")
        for u, ans in got.items():
            cache.put({"key": todo[u]["key"], **todo[u]["tag"], "model": model, "qv": QUESTION_VERSION, "answers": ans})
        judged += len(got)
    readouts, missing = collect(needs, cache)
    if missing:
        raise RuntimeError(f"{len(missing)} readouts still missing after the read: {missing[:3]}")
    return readouts, judged


def jurors_needed(film, cards, readouts, window, juror_model, trigger):
    segs = film["segments"]
    plants, idx = _context(segs)
    probs = bit_probs(readouts)
    needs = []
    for aud, card in cards.items():
        for b in bits_of(segs):
            p = probs.get((b["id"], aud))
            if not p or (p["laugh"] + 0.5 * p["smile"] < trigger["laugh"] and p["cringe"] < trigger["cringe"]):
                continue
            before = before_text(segs, idx[b["segs"][0]["id"]], window, plants)
            pic, snd = _bit_media(b)
            prompt = juror_prompt(card["A"], before, b["text"], pic, snd)
            needs.append({"key": _key(juror_model, JUROR_SCHEMA, prompt), "kind": "juror", "unit": b["id"], "aud": aud, "model": juror_model, "prompt": prompt, "schema": JUROR_SCHEMA})
    return needs


def watch_needed(film, cards, juror_model):
    segs = film["segments"]
    transcript = cut_transcript(segs)
    needs = []
    for aud, card in cards.items():
        prompt = watch_prompt(card["A"], transcript, segs[-1]["t1"])
        for draw in range(WATCH_DRAWS):
            needs.append({"key": _key(juror_model, [WATCH_SCHEMA, draw], prompt), "kind": "watch", "unit": "whole cut", "aud": aud, "draw": draw,
                          "model": juror_model, "prompt": prompt, "schema": WATCH_SCHEMA})
    return needs
