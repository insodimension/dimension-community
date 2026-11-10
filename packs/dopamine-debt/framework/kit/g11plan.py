"""G11 for a kit-built film: fills the shared `framework/g11.Plan` from timeline.json, layout.json, lines.json,
spine.yaml, the voice timings, the built page measured in headless Chrome (on-screen text, scene elements in the edge
band), the music beds with their register entries, the mix stems in build/stems (`mix.stems`, after a mix) and (after
a render) the instrument's audio.txt, then runs the shared checks and writes build/g11.json."""
from __future__ import annotations

import json
import re
from pathlib import Path

import yaml
from PIL import Image

from dd.gate import g11_rules
from dd.home import brand_dir
from framework import g11
from framework import layout as page_layout

from .art import Art
from .compose import text_lines, text_words
from .film import Film
from .voice import brand_voice, take_voices

PERSONA_CHARS = 1200
FINDINGS_SHOWN = 10
ADVISORY_CHARS = 160
MEASURE_STEP_SECONDS = 0.5
MEASURE_MIN_OPACITY = 0.5
HELD_SETTLE_SECONDS = 0.6
HELD_POINTS = (0.2, 0.5, 0.8)
LAST_LOOK_SECONDS, OVERLAY_LOOK_SECONDS = 0.15, 0.25
CLIP_TOLERANCE_PX = 3
COVER_MAX_SHARE = 0.1
MOTION_DT_SECONDS, MOTION_PX = 0.1, 6
TAG_SELECTOR = ".stk,.tagrig .tag,.rcpt-chip,.credit,.mg-stamp,.mg-chip"
RING_SELECTOR = ".rcpt-ring"
SCENE_ROOT = re.compile(r'id="(e\d+)" class="clip mg"')
SCENE_WRAPPER_SUFFIXES = ("-in", "-ttl")
CLIP_CLOCK = """<script>(() => {
  const tl = window.__timelines.main;
  for (const el of document.querySelectorAll("#root [data-start]")) {
    const s = +el.dataset.start, d = +el.dataset.duration;
    tl.set(el, {display: "none"}, 0);
    tl.set(el, {display: ""}, s);
    tl.set(el, {display: "none"}, s + d);
  }
  tl.seek(tl.duration(), false).seek(0, false);
})();</script>"""


def _words(seg_file: str) -> list[dict]:
    return json.loads(Path(seg_file).with_suffix(".timing.json").read_text(encoding="utf-8"))["words"]


def _spine(film: Film) -> dict:
    return yaml.safe_load(film.spine_file.read_text(encoding="utf-8"))


def _scene_parts(html: str) -> list[str]:
    """Every element id inside a motion-graphic scene, except the scene's full-frame wrapper and its title."""
    roots = set(SCENE_ROOT.findall(html))
    ids = re.findall(r'\bid="(e\d+-[A-Za-z0-9_-]+)"', html)
    return [i for i in ids if i.split("-")[0] in roots and not i.endswith(SCENE_WRAPPER_SUFFIXES)]


def held_times(layout: dict) -> list[float]:
    """The held states of every picture: HELD_SETTLE_SECONDS after it enters and at HELD_POINTS of its span, each moved
    past any picture change or reveal still settling, so a sample never lands mid-entrance; every sticker and tag (it
    holds still while the picture under it may move) from HELD_SETTLE_SECONDS after it lands to its end, every
    OVERLAY_LOOK_SECONDS; and the last look before each change and each picture's end (LAST_LOOK_SECONDS before it, so
    the look and its motion probe both fall before the cut), the state the eye leaves on even when something is still
    moving there (clipping counts only text that holds still)."""
    changes = sorted(t for t, _k in layout["changes"])
    out = set()
    for p in layout["pictures"]:
        s, e = p["start"], p["end"]
        for t in [s + HELD_SETTLE_SECONDS] + [s + f * (e - s) for f in HELD_POINTS]:
            for c in changes:
                if c > t:
                    break
                if c > t - HELD_SETTLE_SECONDS:
                    t = c + HELD_SETTLE_SECONDS
            if t < e - 0.05:
                out.add(round(t, 2))
    for o in [b for b in layout["boxes"] if b["kind"] == "sticker"] + [lb for lb in layout["labels"] if lb["kind"] == "tag"]:
        t = o["start"] + HELD_SETTLE_SECONDS
        while t < o["end"] - LAST_LOOK_SECONDS:
            out.add(round(t, 2))
            t += OVERLAY_LOOK_SECONDS
    out |= {round(end - LAST_LOOK_SECONDS, 2) for end in changes + [p["end"] for p in layout["pictures"]] if end > LAST_LOOK_SECONDS}
    return sorted(out)


def receipt_inks(film: Film, items: list[dict]) -> dict[str, dict]:
    """{page asset url: {name, w0, lines, words}} for every captured page on the timeline: its text lines
    (`compose.text_lines`) in capture pixels, a line the capture itself cut at its edge carried past that edge by its
    own height (so a card that shows the capture's edge shows it cut); and its words (`compose.text_words`, each with
    its line's index), what a highlight ring's stroke must not cross."""
    art, out = Art(film), {}
    for it in items:
        if it["kind"] != "doc" or not it.get("file"):
            continue
        w0, h0 = Image.open(it["file"]).size
        lines = []
        for x, y, w, h in text_lines(it["file"]):
            x0, y0, x1, y1 = x, y, x + w, y + h
            x0, x1 = (x0 - h if x0 <= 0 else x0), (x1 + h if x1 >= w0 else x1)
            y0, y1 = (y0 - h if y0 <= 0 else y0), (y1 + h if y1 >= h0 else y1)
            lines.append([x0, y0, x1 - x0, y1 - y0])
        words = [list(wd) for wd in text_words(it["file"])]
        out[art.asset(it["file"])] = {"name": f"page {it['id']}", "w0": w0, "lines": lines, "words": words}
    return out


def where(items: list[dict], t: float) -> str:
    """'<unit> (<template or picture kind>[ of <its line>])' at t: the unit is the last narration, clip or meme line
    started by t, the picture the latest one on screen."""
    heard = [i for i in items if i["kind"] in ("voice", "clip", "meme") and i["start"] <= t]
    unit = max(heard, key=lambda i: i["start"])["line"] if heard else "stage"
    on = [i for i in items if i["kind"] in ("mg", "doc", "post", "clip", "meme", "stock") and i["start"] <= t < i["end"]]
    if not on:
        return unit
    it = max(on, key=lambda i: i["start"])
    what = it["mg"]["id"] if it["kind"] == "mg" else it["kind"]
    return f"{unit} ({what})" if it["line"] == unit else f"{unit} ({what} of {it['line']})"


def measure_page(film: Film) -> tuple[list[dict], list[dict], list[dict]]:
    """(screen text runs, boxes in the 10% edge band, held states) of the built page, sampled every
    MEASURE_STEP_SECONDS in headless Chrome on a copy whose clips show only inside their data-start/data-duration
    window, as the HyperFrames runtime shows them. A box is a word of on-screen text, or a scene element clipped to its
    overflow window; the kit's media and receipts are boxed by layout.json already. A held state (`held_times`) holds
    the text cut by an overflow window or the frame (a word's glyphs, or a captured page's text line, more than
    CLIP_TOLERANCE_PX past the window); the text a tag, sticker or chip (TAG_SELECTOR) that holds still lies over by
    more than COVER_MAX_SHARE of its glyph box at the held moment and MOTION_DT_SECONDS later (text sliding under a tag
    counts); and the text a highlight ring's stroke (RING_SELECTOR, once drawn) runs through by more than
    CLIP_TOLERANCE_PX both ways (a word on the page, `receipt_inks` words, or a word of page text)."""
    page = film.page_dir / "index.html"
    html = page.read_text(encoding="utf-8")
    items = json.loads(film.timeline_file.read_text(encoding="utf-8"))["items"]
    copy = page.with_name("measure.html")
    copy.write_text(html.replace("</body>", CLIP_CLOCK + "</body>"), encoding="utf-8")
    band_x, band_y = round(g11.BAND_X), round(g11.BAND_Y)
    opts = {"width": g11.FRAME_W, "height": g11.FRAME_H, "band": [band_x, band_y], "step": MEASURE_STEP_SECONDS,
            "min_opacity": MEASURE_MIN_OPACITY, "ids": _scene_parts(html),
            "held": held_times(json.loads(film.layout_file.read_text(encoding="utf-8"))), "tags": TAG_SELECTOR, "rings": RING_SELECTOR,
            "inks": receipt_inks(film, items), "clip_tolerance": CLIP_TOLERANCE_PX, "cover_max": COVER_MAX_SHARE,
            "motion_dt": MOTION_DT_SECONDS, "motion_px": MOTION_PX}
    try:
        res = page_layout.measure({"page": (copy, opts)}, film.build / "cache" / "page-measure.json")["page"]
    finally:
        copy.unlink()
    runs, band, prev = [], [], None
    for t, text, _media, marks in res["samples"]:
        words = " ".join(" ".join(res["items"][i]["words"][j] for j in seen) for i, seen, _u, _b, _op in text)
        if runs and words == prev:
            runs[-1]["end"] = t + MEASURE_STEP_SECONDS
        else:
            runs.append({"start": t, "end": t + MEASURE_STEP_SECONDS, "text": words})
        prev = words
        for i, _seen, u, in_band, _op in text:
            if in_band:
                said = " ".join(res["items"][i]["words"][j] for j in in_band)
                band.append({"kind": f"text '{said[:40]}'", "start": t, "end": t + MEASURE_STEP_SECONDS, "box": [u[0], u[1], u[2] - u[0], u[3] - u[1]]})
        for mid, (left, top, right, bottom) in marks:
            if left < band_x or top < band_y or right > g11.FRAME_W - band_x or bottom > g11.FRAME_H - band_y:
                band.append({"kind": f"element #{mid}", "start": t, "end": t + MEASURE_STEP_SECONDS, "box": [left, top, right - left, bottom - top]})
    held = [{"t": t, "where": where(items, t), "clipped": clipped, "covered": covered, "sliced": sliced} for t, clipped, covered, sliced in res["held"]]
    return [r for r in runs if r["text"]], band, held


def music_beds(film: Film) -> list[dict]:
    """One row per Film.music cue: its file, its asset record if any, and bpm/mode from the music register entry that
    holds the same sha256 (approved first, then references), so the music rules read the bed that plays."""
    register = g11.music_register(film.root)
    by_sha = {r["sha256"]: r for key in ("references", "approved") for r in register.get(key, [])}
    rows = []
    for cue, _line in film.music:
        file = film.media / "music" / f"{cue}.mp3"
        reg = by_sha.get(g11.sha256(str(file)), {})
        measured = reg.get("measured") or next((r.get("measured") for r in register.get("references", []) if r["id"] == reg.get("id")), None) or {}
        asset = file.with_suffix(".asset.json")
        rows.append({"id": reg.get("id") or cue, "file": str(file), "asset": str(asset) if asset.exists() else None,
                     "bpm": measured.get("bpm"), "mode": (measured.get("key") or "").split()[-1] if measured.get("key") else None})
    return rows


def plan(film: Film, film_x: Path | None = None) -> g11.Plan:
    """The Plan. Aligned word times lag the audio and nothing is heard outside a voice piece, so each narration word is
    clipped to its piece. Posts are sourced from `media/sourcing/posts.json`, pages from their capture records."""
    items = json.loads(film.timeline_file.read_text(encoding="utf-8"))["items"]
    layout = json.loads(film.layout_file.read_text(encoding="utf-8"))
    lines = json.loads(film.lines_file.read_text(encoding="utf-8"))
    spine = _spine(film)
    voice = [i for i in items if i["kind"] == "voice"]
    narration = []
    for v in voice:
        off = v["start"] - v["in"]
        narration += [(max(v["start"], w["startSeconds"] + off), min(v["end"], w["endSeconds"] + off), w["text"]) for w in _words(v["file"])
                      if w["endSeconds"] > v["in"] + 0.01 and w["startSeconds"] < v["out"] - 0.01]
    posts_file = film.media / "sourcing" / "posts.json"
    posts = {p["id"]: p for p in json.loads(posts_file.read_text(encoding="utf-8"))["posts"]} if posts_file.is_file() else {}
    sources = []
    for i in items:
        if i["kind"] == "post":
            sid = next(iter(re.findall(r"\d{15,}", i["id"])), "")
            p = posts.get(i["id"]) or posts.get(sid, {})
            sources.append({"kind": "post", "id": i["id"], "url": p.get("url"), "date": p.get("published_utc")})
        elif i["kind"] == "doc":
            rec = film.media / "captures" / f"{i['id']}.asset.json"
            r = json.loads(rec.read_text(encoding="utf-8")) if rec.exists() else {}
            sources.append({"kind": "page", "id": i["id"], "url": r.get("sourceUrl"), "date": r.get("capturedAt")})
    rows = []
    if film_x and (film_x / "audio.txt").exists():
        for ln in (film_x / "audio.txt").read_text(encoding="utf-8").splitlines()[1:]:
            p = ln.split()
            if len(p) >= 2:
                rows.append((float(p[0]), float(p[1]), len(p) > 2 and p[2] == "S"))
    screen_text, band_boxes, held = measure_page(film)
    narrated = [l for l in lines if l["speaker"] == "narrator"]
    punches = []
    for l in narrated:
        if l.get("role") != "punch":
            continue
        spans = [(v["start"], v["end"]) for v in voice if v["line"] == l["id"]]
        said = [(t0, re.sub(r"[^a-z0-9']", "", w.lower())) for t0, t1, w in narration if any(a <= t0 < b for a, b in spans)]
        want = re.sub(r"[^a-z0-9']", "", (l.get("punch_word") or "").lower())
        hit = next((t0 for t0, w in said if want and w == want), None)
        punches.append(hit if hit is not None else max((b for _, b in spans), default=0.0))
    heard = json.loads((film_x / "words.json").read_text(encoding="utf-8")) if film_x and (film_x / "words.json").exists() else []
    replays = json.loads((film_x / "returns.json").read_text(encoding="utf-8")) if film_x and (film_x / "returns.json").exists() else []
    brand, brand_from = brand_voice(film)
    return g11.Plan(
        duration=max(i["end"] for i in items), narration=sorted(narration), voice=voice,
        voice_takes=take_voices(film, [v["seg"] for v in voice]), brand_voice=brand, brand_voice_from=brand_from,
        memes=[i for i in items if i["kind"] == "meme"], sfx=[(i["start"], i["end"]) for i in items if i["kind"] == "sfx"],
        labels=layout["labels"], boxes=layout["boxes"] + band_boxes, changes=[tuple(c) for c in layout["changes"]], pictures=layout["pictures"],
        scenes=layout["scenes"], analogy_lines=(spine.get("anchor_world") or {}).get("lines", []),
        scene_lines={v["line"] for v in voice for m in items if m["kind"] == "mg" and min(v["end"], m["end"]) - max(v["start"], m["start"]) >= 0.5 * (v["end"] - v["start"])},
        script_text=" ".join(l["text"] for l in narrated),
        script_sentences=[s for l in narrated for s in re.split(r"(?<=[.!?])\s+", l["text"].strip()) if s],
        punches=punches, heard=heard, returns=replays,
        source_files=[i["file"] for i in items if i["kind"] in ("clip", "meme", "stock", "doc", "post")], sources=sources,
        library=film.library, audio_rows=rows, screen_text=screen_text, held=held, music=music_beds(film), production=film.root.name, root=film.root,
        stems={s.stem: str(s) for s in (film.build / "stems").glob("*.flac")} if (film.build / "stems").is_dir() else {})


def judge_states(film: Film) -> dict[str, dict]:
    """One state per meme (two rules) and per photo (one rule), with the topic persona's Core and Floor and the spine's
    audience order."""
    items = json.loads(film.timeline_file.read_text(encoding="utf-8"))["items"]
    lines = {l["id"]: l for l in json.loads(film.lines_file.read_text(encoding="utf-8"))}
    order = [lid for lid, line in lines.items() if line["speaker"] != "meme"]
    own = film.root / "personas" / film.persona
    persona_md = (own if own.is_file() else brand_dir(film.root) / "personas" / "topic" / film.persona).read_text(encoding="utf-8")
    persona = " ".join(re.findall(r"## (?:Core|Floor)\n+(.+?)\n", persona_md))[:PERSONA_CHARS]
    spine = _spine(film)
    persona = f"Audience in order: {[a['who'] for a in spine['audience']['order']]}. {persona}"
    states = {}

    def before(lid: str) -> str:
        k = order.index(lid)
        return " ".join(lines[x]["text"] for x in order[max(0, k - 2): k + 1] if lines[x]["speaker"] == "narrator")

    for m in (i for i in items if i["kind"] == "meme"):
        e = json.loads((film.library / m["lib"] / "entry.json").read_text(encoding="utf-8"))
        meme = f"{e['name']} ({e.get('origin') or e.get('credit')}); its line: \"{(e.get('payoff') or {}).get('line', '')}\"; mode {m['mode']}"
        for rule in ("meme-is-the-audience", "meme-has-a-setup"):
            states[f"{rule}|{m['start']:.1f}s {m['line']} {e['name']}"] = {"rule": rule, "persona": persona, "before": before(m["line"]), "line": lines[m["line"]]["text"], "picture": meme}
    for s in (i for i in items if i["kind"] == "stock"):
        stk = [i["text"] for i in items if i["kind"] == "sticker" and i["line"] == s["line"]]
        states[f"picture-is-understood|{s['start']:.1f}s {s['line']} {Path(s['file']).stem}"] = {
            "rule": "picture-is-understood", "persona": persona, "before": before(s["line"]), "line": lines[s["line"]]["text"],
            "picture": f"full-frame stock photo of: {Path(s['file']).stem.replace('-', ' ')}; stickers on it: {stk}"}
    return states


def write(film: Film, code: dict, advisory: dict | None = None, why: dict | None = None) -> dict:
    """build/g11.json: the gate rules (dd.gate's g11), why each unchecked rule could not be answered when it can say
    (`g11.unchecked_why`), and, apart, the advisory judge findings for the person to look at. With no `advisory`, the
    previous file's advisory findings are kept."""
    out = film.g11_file
    rules = g11_rules()
    unchecked = [r for r in rules if r not in code]
    why = why or {}
    reasons = {r: why[r] for r in unchecked if r in why}
    status = "fail" if any(code.get(r) for r in rules) else ("incomplete" if unchecked else "pass")
    prev = json.loads(out.read_text(encoding="utf-8")).get("advisory") if out.exists() and advisory is None else None
    out.write_text(json.dumps({"status": status, "fails": {r: code[r] for r in rules if r in code}, "unchecked": unchecked, "why": reasons,
                               "advisory": advisory if advisory is not None else (prev or {})}, indent=1, ensure_ascii=False), encoding="utf-8")
    for r in rules:
        found = code.get(r, [reasons[r]] if r in reasons else [])
        print(("----" if r not in code else "PASS" if not code[r] else "FAIL") + f"  {r}" + "".join(f"\n      - {v}" for v in found[:FINDINGS_SHOWN]))
    for r, v in (advisory or {}).items():
        print(f"ADVISORY  {r}: {len(v)} to look at" + "".join(f"\n      - {x[:ADVISORY_CHARS]}" for x in v))
    print("G11:", status)
    return code


def _code_checked(film: Film, film_x: Path | None) -> tuple[dict, dict]:
    p = plan(film, film_x)
    code = g11.code_checks(p)
    return code, g11.unchecked_why(p, code)


def checked(film: Film, film_x: Path | None = None) -> dict:
    """Code rules only -> build/g11.json (judge rules listed as unchecked until judged)."""
    code, why = _code_checked(film, film_x)
    return write(film, code, why=why)


def judged(film: Film, completion, film_x: Path | None = None) -> dict:
    """Code rules plus the advisory judge rules (eval kernel: pass its `completion`)."""
    code, why = _code_checked(film, film_x)
    return write(film, code, g11.judge_checks(judge_states(film), completion), why)


def seen_judged(film: Film, descriptions: dict[str, dict], completion) -> dict:
    """The rules that need the frames-only reader's `descriptions` (`analogy-stays-in-its-world`), judged and merged
    into build/g11.json beside the code rules already there. Run at K-9, after the read of this render."""
    prev = json.loads(film.g11_file.read_text(encoding="utf-8"))
    lines = json.loads(film.lines_file.read_text(encoding="utf-8"))
    found = g11.judge_checks(g11.analogy_states(lines, _spine(film), descriptions), completion)
    return write(film, {**prev["fails"], "analogy-stays-in-its-world": found.get("analogy-stays-in-its-world", [])}, prev.get("advisory"),
                 prev.get("why"))
