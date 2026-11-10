"""Motion-graphic scenes, built with the Motion pack's kit (K) on the film's one GSAP timeline.

Each scene is data in `script/lines.json` (an `MG` picture: `{"k": "MG", "id": <template>, ...params}`); this module turns it
into markup and kit calls. Every reveal lands on a spoken word: `on` names the word and `Cues.at()` finds its time in the
scene's narration, minus LEAD so the picture arrives first (the kit's K.pre doctrine). A scene enters in ENTER seconds
(scale and position, never from nothing) and shows its first element within FIRST_REVEAL_MAX of its start.

A film adds its own templates with `Film.scenes` (name -> Scene) and their CSS with `Film.scene_css`."""
from __future__ import annotations

import json
from typing import Callable, Mapping

from .art import Art, esc

LEAD = 0.2
ENTER = 0.18
FIRST_REVEAL_MAX = 1.0
PUSH = 1.03


def _tok(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum())


class Cues:
    """Word times of a scene's narration; `at("word", nth)` is the nth match's start, minus the lead. Every cue time a
    scene asks for is a reveal, recorded in `reveals` (with `shown()` for content that appears without a cue), so the
    builder knows when the scene first shows something (G11 no-blank-stage, show-dont-tell). `spot()` records where a
    sticker landing during the scene sits clear of its content (`spots`, frame pixels)."""

    def __init__(self, words: list, start: float, end: float, held: bool = False):
        self.words, self.start, self.end, self.held = words, start, end, held
        self.reveals: list[float] = []
        self.spots: list[tuple[float, float, float]] = []

    def spot(self, x: float, y: float, rot: float = 0.0) -> None:
        """A sticker's centre (x, y) and tilt that keep it off every part of this scene; tried in the order given."""
        self.spots.append((x, y, rot))

    def word(self, w: str, nth: int = 1) -> float:
        """Start of the nth spoken word equal to `w` (whole word; a trailing * matches a prefix, "pan*" -> "pancakes")."""
        prefix, want = w.endswith("*"), _tok(w)
        hits = [t0 for text, t0, _t1 in self.words if (_tok(text).startswith(want) if prefix else _tok(text) == want)]
        if len(hits) < nth:
            said = " ".join(t for t, _, _ in self.words)
            raise ValueError(f'scene cue "{w}" (#{nth}) is not in its narration: "{said}"')
        return hits[nth - 1]

    def at(self, w: str | float | None, nth: int = 1, lead: float = LEAD) -> float:
        if w is None:
            t = self.start
        elif isinstance(w, (int, float)):
            t = self.start + float(w)
        else:
            t = max(self.start, self.word(w, nth) - lead)
        if not self.reveals and t > self.start + FIRST_REVEAL_MAX:
            t = self.start + ENTER
        return self.shown(t)

    def shown(self, t: float) -> float:
        self.reveals.append(t)
        return t



Scene = Callable[[str, dict, Cues, Art], tuple[str, list[str]]]
SCENES: dict[str, Scene] = {}


def scene(name: str):
    def reg(fn: Scene) -> Scene:
        SCENES[name] = fn
        return fn

    return reg


def render(eid: str, item: dict, start: float, end: float, words: list, art: Art, extra: Mapping[str, Scene] | None = None,
           held_scale: float | None = None) -> tuple[str, list[str], list[float], list[tuple[float, float, float]]]:
    """A scene's HTML, its timeline calls, the times it reveals content (sorted) and the sticker spots it declared
    (`Cues.spot`). `extra` holds the film's own templates, looked up before the kit's. `held_scale` is set when the line
    before ended on this same scene: the scene does not enter again but keeps pushing in from that scale, and the
    template sees `Cues.held` so it draws what was already up in its settled state (G11 `no-scene-replay`)."""
    p = item["mg"]
    cues = Cues(words, start, end, held_scale is not None)
    inner, js = ((extra.get(p["id"]) if extra else None) or SCENES[p["id"]])(eid, p, cues, art)
    title = f'<div class="mg-title" id="{eid}-ttl">{esc(p["title"])}</div>' if p.get("title") else ""
    src = f'<div class="mg-src">{esc(p["source"])}</div>' if p.get("source") else ""
    root = (f'<div id="{eid}" class="clip mg" data-start="{start:.3f}" data-duration="{max(0.05, end - start):.3f}" '
            f'data-track-index="20" style="z-index:20"><div class="mg-in" id="{eid}-in">{title}{inner}{src}</div></div>')
    if held_scale is not None:
        head = [f'K.push("#{eid}-in",{start:.3f},{max(start + 0.1, end):.3f},{{from:{held_scale:.4f},to:{held_scale + PUSH - 1:.4f}}});']
    else:
        head = [f'tl.fromTo("#{eid}-in",{{scale:1.06,y:30}},{{scale:1,y:0,duration:{ENTER},ease:"power3.out"}},{start:.3f});',
                f'K.push("#{eid}-in",{start + ENTER:.3f},{max(start + ENTER + 0.1, end):.3f},{{from:1,to:{PUSH}}});']
        if p.get("title"):
            head.append(f'tl.fromTo("#{eid}-ttl",{{x:-60}},{{x:0,duration:0.25,ease:"power3.out"}},{start:.3f});')
    return root, head + js, sorted(set(round(t, 3) for t in cues.reveals)), cues.spots


def _num(v: float, dec: int) -> str:
    return f"{v:,.{dec}f}"


def stamps(eid: str, p: dict, c: Cues, x: int, y: int, rot: float, shake: str = "") -> tuple[str, list[str]]:
    """A scene's stamps (`stamp`, or a `stamps` list), each slammed on its word; `shake` jolts that selector on each."""
    out, js = [], []
    for k, st in enumerate(([p["stamp"]] if p.get("stamp") else []) + p.get("stamps", [])):
        t = c.at(st.get("on"), st.get("nth", 1))
        out.append(f'<div class="mg-stamp" id="{eid}-st{k}" style="left:{st.get("x", x)}px;top:{st.get("y", y + 110 * k)}px;--r:{st.get("rot", rot)}deg">{esc(st["text"])}</div>')
        js.append(f'K.slam("#{eid}-st{k}",{t:.3f});')
        if shake:
            js.append(f'K.shake("{shake}",{t + 0.12:.3f});')
    return "".join(out), js


def count_frames(a: float, b: float, dec: int = 0, prefix: str = "", suffix: str = "", steps: int = 14) -> list[str]:
    """The texts a K.count roll shows from a to b (eased out, so it slows into the number)."""
    out = []
    for i in range(steps + 1):
        f = 1 - (1 - i / steps) ** 3
        out.append(f"{prefix}{_num(a + (b - a) * f, dec)}{suffix}")
    return out


@scene("bars")
def bars(eid: str, p: dict, c: Cues, art: Art) -> tuple[str, list[str]]:
    """Horizontal bars, one per row (logo or label), each growing and counting to its value on its word. The label
    column fits the longest label on one line (Anton 58 px is about 30 px a character); the track keeps the row inside
    x 200-1720 (outside the 10% edge band) with about 260 px free for the value."""
    rows, top = p["rows"], 250
    vmax = p.get("max") or max(r["value"] for r in rows)
    gap = min(170, int(600 / max(1, len(rows))))
    head_w = max(330, 30 * max((len(r["label"]) for r in rows if not r.get("logo")), default=0))
    track = 1260 - head_w
    html_rows, js = [], []
    for i, r in enumerate(rows):
        y = top + i * gap
        w = int(track * r["value"] / vmax)
        lab = art.logo(r["logo"], 70, white=True, cls="bar-logo") if r.get("logo") else f'<span class="bar-lab">{esc(r["label"])}</span>'
        tone = r.get("tone", "accent")
        html_rows.append(
            f'<div class="bar-row" id="{eid}-r{i}" style="top:{y}px"><div class="bar-head" style="width:{head_w}px">{lab}</div>'
            f'<div class="bar-track"><div class="bar-fill t-{tone}" id="{eid}-f{i}" style="width:{w}px"></div>'
            f'<div class="bar-val" id="{eid}-v{i}" style="left:{w + 24}px">{esc(r.get("text", ""))}</div></div></div>')
        t = c.at(r.get("on"), r.get("nth", 1))
        js.append(f'tl.fromTo("#{eid}-r{i}",{{x:-80,opacity:0}},{{x:0,opacity:1,duration:0.22,ease:"power3.out"}},{t:.3f});')
        js.append(f'tl.fromTo("#{eid}-f{i}",{{scaleX:0}},{{scaleX:1,duration:0.6,ease:"power3.out",transformOrigin:"0% 50%"}},{t + 0.05:.3f});')
        if "text" not in r:
            frames = count_frames(0, r["value"], r.get("dec", 0), r.get("prefix", ""), r.get("suffix", ""))
            js.append(f'K.count("#{eid}-v{i}",{json.dumps(frames)},{t + 0.05:.3f},{t + 0.62:.3f});')
    st_html, st_js = stamps(eid, p, c, 1280, 760, -6)
    return "".join(html_rows) + st_html, js + st_js


@scene("line")
def line(eid: str, p: dict, c: Cues, art: Art) -> tuple[str, list[str]]:
    """A dated price line that draws itself on, with the last point's label slammed on its word."""
    pts = p["points"]
    x0, x1, y0, y1 = 220, 1700, 860, 300
    vmin, vmax = p.get("min", 0), p.get("max") or max(q["value"] for q in pts) * 1.1
    xy = [(x0 + (x1 - x0) * i / max(1, len(pts) - 1), y0 - (y0 - y1) * (q["value"] - vmin) / (vmax - vmin)) for i, q in enumerate(pts)]
    path = "M" + " L".join(f"{x:.0f},{y:.0f}" for x, y in xy)
    length = sum(((xy[i + 1][0] - xy[i][0]) ** 2 + (xy[i + 1][1] - xy[i][1]) ** 2) ** 0.5 for i in range(len(xy) - 1))
    ticks = "".join(f'<div class="ln-tick" style="left:{x - 80:.0f}px;top:{y0 + 26}px">{esc(q["label"])}</div>' for (x, _), q in zip(xy, pts))
    dots = "".join(f'<div class="ln-dot" id="{eid}-d{i}" style="left:{x - 14:.0f}px;top:{y - 14:.0f}px"></div>' for i, (x, y) in enumerate(xy))
    lx, ly = xy[-1]
    endlab = f'<div class="ln-end" id="{eid}-end" style="left:{min(lx - 340, 1400):.0f}px;top:{ly - 170:.0f}px">{esc(p["end_text"])}</div>'
    first = f'<div class="ln-first" id="{eid}-first" style="left:{xy[0][0] - 40:.0f}px;top:{xy[0][1] - 120:.0f}px">{esc(p.get("first_text", ""))}</div>' if p.get("first_text") else ""
    svg = (f'<svg class="ln-svg" width="1920" height="1080" viewBox="0 0 1920 1080"><line x1="{x0}" y1="{y0}" x2="{x1}" y2="{y0}" class="ln-axis"/>'
           f'<path id="{eid}-p" d="{path}" class="ln-path" style="stroke-dasharray:{length:.0f};stroke-dashoffset:{length:.0f}"/></svg>')
    t0, t1 = c.at(p.get("draw_from")), c.at(p.get("draw_to"))
    t1 = max(t1, t0 + 0.6)
    js = [f'tl.to("#{eid}-p",{{strokeDashoffset:0,duration:{t1 - t0:.3f},ease:"power1.inOut"}},{t0:.3f});']
    for i in range(len(xy)):
        js.append(f'K.pop("#{eid}-d{i}",{c.shown(t0 + (t1 - t0) * i / max(1, len(xy) - 1)):.3f},{{d:0.16}});')
    if first:
        js.append(f'K.pop("#{eid}-first",{t0:.3f});')
    js.append(f'K.slam("#{eid}-end",{c.at(p.get("end_on"), p.get("end_nth", 1)):.3f});')
    return svg + ticks + dots + first + endlab, js


@scene("compare")
def compare(eid: str, p: dict, c: Cues, art: Art) -> tuple[str, list[str]]:
    """Two tiles, then and now (or A and B): each tile pops on its word and its number counts up on `count_on` (default:
    the same word; until a later count the tile shows "?", never an empty box or a $0); an optional multiplier stamp."""
    out, js = [], []
    for i, side in enumerate(p["sides"]):
        x = 230 + i * 780
        img = art.logo(side["logo"], 90, white=True, cls="cmp-logo") if side.get("logo") else ""
        out.append(f'<div class="cmp-tile t-{side.get("tone", "ink" if i == 0 else "accent")}" id="{eid}-s{i}" style="left:{x}px">'
                   f'<div class="cmp-cap">{img}{esc(side["caption"])}</div><div class="cmp-num" id="{eid}-n{i}">{"?" if side.get("count_on") else esc(side.get("prefix", "")) + "0"}</div>'
                   f'<div class="cmp-sub">{esc(side.get("sub", ""))}</div></div>')
        t = c.at(side.get("on"), side.get("nth", 1))
        tc = c.at(side["count_on"], side.get("count_nth", 1)) if side.get("count_on") else t
        js.append(f'K.pop("#{eid}-s{i}",{t:.3f},{{f:0.8,d:0.2}});')
        frames = count_frames(side.get("from", 0), side["value"], side.get("dec", 0), side.get("prefix", ""), side.get("suffix", ""))
        js.append(f'K.count("#{eid}-n{i}",{json.dumps(frames)},{max(t, tc) + 0.04:.3f},{max(t, tc) + 0.6:.3f});')
    if p.get("arrow", True) and len(p["sides"]) == 2:
        out.append(f'<div class="cmp-arrow" id="{eid}-ar">\u2192</div>')
        js.append(f'K.pop("#{eid}-ar",{c.at(p["sides"][1].get("on"), p["sides"][1].get("nth", 1)):.3f});')
    st_html, st_js = stamps(eid, p, c, 1260, 740, -7, shake=f"#{eid}-in")
    return "".join(out) + st_html, js + st_js


@scene("tags")
def tags(eid: str, p: dict, c: Cues, art: Art) -> tuple[str, list[str]]:
    """A row of price tags (a product picture or logo, the old price struck through, the new price) flipping in on their words."""
    items = p["items"]
    w = min(420, int(1640 / len(items)) - 30)
    out, js = [], []
    for i, it in enumerate(items):
        x = 960 - (len(items) * (w + 30) - 30) / 2 + i * (w + 30)
        img = art.logo(it["logo"], 64, cls="tag-logo") if it.get("logo") else ""
        out.append(f'<div class="ptag" id="{eid}-t{i}" style="left:{x:.0f}px;width:{w}px">{img}<div class="ptag-name">{esc(it["name"])}</div>'
                   f'<div class="ptag-old"><s>{esc(it["old"])}</s></div><div class="ptag-new" id="{eid}-n{i}">{esc(it["new"])}</div>'
                   f'<div class="ptag-up">{esc(it.get("delta", ""))}</div></div>')
        t = c.at(it.get("on"), it.get("nth", 1))
        js.append(f'tl.fromTo("#{eid}-t{i}",{{rotationY:-90,y:40}},{{rotationY:0,y:0,duration:0.28,ease:"back.out(1.8)"}},{t:.3f});')
        js.append(f'K.slam("#{eid}-n{i}",{t + 0.22:.3f},{{f:1.5}});')
    st_html, st_js = stamps(eid, p, c, 960, 860, -4)
    return "".join(out) + st_html, js + st_js


@scene("timeline")
def timeline(eid: str, p: dict, c: Cues, art: Art) -> tuple[str, list[str]]:
    """Years on a rail; each event card pops on its word above or below its year."""
    evs, out, js = p["events"], [], []
    x0, x1, y = 200, 1720, 600
    out.append(f'<div class="tl-rail" id="{eid}-rail" style="left:{x0}px;width:{x1 - x0}px;top:{y}px"></div>')
    js.append(f'tl.fromTo("#{eid}-rail",{{scaleX:0}},{{scaleX:1,duration:0.5,ease:"power2.out",transformOrigin:"0% 50%"}},{c.start:.3f});')
    for i, ev in enumerate(evs):
        x = x0 + (x1 - x0) * (i + 0.5) / len(evs)
        up = i % 2 == 0
        out.append(f'<div class="tl-year" style="left:{x - 120:.0f}px;top:{y + (22 if up else -96)}px">{esc(ev["year"])}</div>'
                   f'<div class="tl-card t-{ev.get("tone", "cream")}" id="{eid}-e{i}" style="left:{x - 190:.0f}px;{"bottom" if up else "top"}:{(1080 - y + 30) if up else (y + 30)}px">{esc(ev["text"])}</div>'
                   f'<div class="tl-pin" style="left:{x - 12:.0f}px;top:{y - 12}px"></div>')
        js.append(f'K.pop("#{eid}-e{i}",{c.at(ev.get("on"), ev.get("nth", 1)):.3f});')
    return "".join(out), js


@scene("counter")
def counter(eid: str, p: dict, c: Cues, art: Art) -> tuple[str, list[str]]:
    """A caption that says what is being counted, and one giant number popping in at the scene start and rolling to its
    value on its word."""
    roll = c.shown(c.start + 0.2)
    t = c.at(p.get("on"), p.get("nth", 1))
    frames = count_frames(p.get("from_value", 0), p["value"], p.get("dec", 0), p.get("prefix", ""), p.get("suffix", ""), 18)
    pic = art.logo(p["logo"], 110, white=True, cls="ctr-logo") if p.get("logo") else ""
    out = (f'<div class="ctr">{pic}<div class="ctr-num" id="{eid}-n">{esc(frames[0])}</div><div class="ctr-cap" id="{eid}-c">{esc(p["caption"])}</div></div>')
    js = [f'tl.fromTo("#{eid}-c",{{y:40}},{{y:0,duration:0.25,ease:"power3.out"}},{c.start:.3f});',
          f'K.pop("#{eid}-n",{roll:.3f},{{f:0.7,d:0.2}});',
          f'K.count("#{eid}-n",{json.dumps(frames)},{roll:.3f},{max(roll + 0.3, t):.3f});']
    st_html, st_js = stamps(eid, p, c, 1240, 850, -6)
    return out + st_html, js + st_js


@scene("logos")
def logos(eid: str, p: dict, c: Cues, art: Art) -> tuple[str, list[str]]:
    """Logo cards slammed in a row on their words, with a caption line under each."""
    items, out, js = p["items"], [], []
    w = int(1600 / len(items))
    for i, it in enumerate(items):
        x = 160 + i * w
        out.append(f'<div class="lgc" id="{eid}-l{i}" style="left:{x + 20}px;width:{w - 40}px">{art.logo(it["logo"], 120)}'
                   f'<div class="lgc-cap">{esc(it.get("caption", ""))}</div></div>')
        js.append(f'K.slam("#{eid}-l{i}",{c.at(it.get("on"), it.get("nth", 1)):.3f},{{f:1.4}});')
    st_html, st_js = stamps(eid, p, c, 960, 820, -4)
    return "".join(out) + st_html, js + st_js


@scene("bill")
def bill(eid: str, p: dict, c: Cues, art: Art) -> tuple[str, list[str]]:
    """A parts receipt: rows tick in (together on `rows_on`, or each on its own `on`), a highlighted row's price rolls from
    its old to its new value, the total rolls too."""
    rows, out, js = p["rows"], [], []
    out.append(f'<div class="bill" id="{eid}-b"><div class="bill-h">{esc(p["heading"])}</div>')
    for i, r in enumerate(rows):
        hot = "hot" if r.get("hot") else ""
        out.append(f'<div class="bill-row {hot}" id="{eid}-r{i}"><span>{esc(r["part"])}</span><span id="{eid}-p{i}">${r["old"]:,}</span></div>')
    out.append(f'<div class="bill-tot"><span>TOTAL</span><span id="{eid}-tot">${p["total_old"]:,}</span></div></div>')
    t_rows = c.at(p.get("rows_on")) if p.get("rows_on") or not any(r.get("on") for r in rows) else None
    for i, r in enumerate(rows):
        tr = c.at(r["on"], r.get("nth", 1)) if r.get("on") else t_rows + i * 0.12
        js.append(f'tl.fromTo("#{eid}-r{i}",{{x:-40,opacity:0}},{{x:0,opacity:1,duration:0.16}},{tr:.3f});')
    t = c.at(p.get("jump_on"), p.get("jump_nth", 1))
    for i, r in enumerate(rows):
        if r.get("new") and r["new"] != r["old"]:
            js.append(f'K.count("#{eid}-p{i}",{json.dumps(count_frames(r["old"], r["new"], 0, "$"))},{t:.3f},{t + 0.7:.3f});')
            js.append(f'K.shake("#{eid}-r{i}",{t + 0.7:.3f});')
    js.append(f'K.count("#{eid}-tot",{json.dumps(count_frames(p["total_old"], p["total_new"], 0, "$"))},{t + 0.2:.3f},{t + 0.9:.3f});')
    st_html, st_js = stamps(eid, p, c, 1240, 720, -6)
    return "".join(out) + st_html, js + st_js


@scene("meter")
def meter(eid: str, p: dict, c: Cues, art: Art) -> tuple[str, list[str]]:
    """A taxi meter: hours tick and dollars roll under its `heading`; a cap line slams on its word."""
    out = (f'<div class="mtr" id="{eid}-m"><div class="mtr-h">{esc(p["heading"])}</div>'
           f'<div class="mtr-row"><span>HOURS</span><b id="{eid}-h">0</b></div><div class="mtr-row"><span>FARE</span><b id="{eid}-f">$0.00</b></div></div>')
    js = []
    t0, t1 = c.at(p.get("run_from")), c.at(p.get("run_to"))
    t1 = max(t1, t0 + 0.8)
    js.append(f'K.count("#{eid}-h",{json.dumps(count_frames(0, p["hours"], 0, steps=20))},{t0:.3f},{t1:.3f});')
    js.append(f'K.count("#{eid}-f",{json.dumps(count_frames(0, p["dollars"], 2, "$", steps=20))},{t0:.3f},{t1:.3f});')
    for i, cap in enumerate(p.get("caps", [])):
        out += f'<div class="mg-stamp" id="{eid}-c{i}" style="left:{cap.get("x", 1300)}px;top:{cap.get("y", 300 + 200 * i)}px;--r:{cap.get("rot", -5)}deg">{esc(cap["text"])}</div>'
        js.append(f'K.slam("#{eid}-c{i}",{c.at(cap.get("on"), cap.get("nth", 1)):.3f});')
    return out, js


@scene("checklist")
def checklist(eid: str, p: dict, c: Cues, art: Art) -> tuple[str, list[str]]:
    """A card of rows; each row slides in on its word and gets its mark (a red ✗, a green ✓ or a value) slammed on."""
    rows, out, js = p["rows"], [], []
    top = 540 - (len(rows) * 110 + (90 if p.get("heading") else 0)) / 2
    bottom = top + len(rows) * 110 + (102 if p.get("heading") else 0) + 72
    out.append(f'<div class="chk" style="top:{top:.0f}px">' + (f'<div class="chk-h">{esc(p["heading"])}</div>' if p.get("heading") else ""))
    for i, r in enumerate(rows):
        mark = r.get("mark", "✗")
        cls = "no" if mark == "✗" else "yes" if mark == "✓" else "val"
        out.append(f'<div class="chk-row" id="{eid}-r{i}"><span>{esc(r["text"])}</span><b class="{cls}" id="{eid}-m{i}">{esc(mark)}</b></div>')
    out.append("</div>")
    for i, r in enumerate(rows):
        t = c.at(r.get("on"), r.get("nth", 1))
        js.append(f'tl.fromTo("#{eid}-r{i}",{{x:-60,opacity:0}},{{x:0,opacity:1,duration:0.18,ease:"power3.out"}},{t:.3f});')
        js.append(f'K.slam("#{eid}-m{i}",{c.at(r.get("mark_on", r.get("on")), r.get("mark_nth", r.get("nth", 1))) + 0.15:.3f},{{f:2}});')
    st_html, st_js = stamps(eid, p, c, 1420, int(bottom + 60), -6)
    out.append(st_html)
    js += st_js
    return "".join(out), js


@scene("cartel")
def cartel(eid: str, p: dict, c: Cues, art: Art) -> tuple[str, list[str]]:
    """The suspects board: company badges pinned in a row on their names, red string tying them together, then
    optional stamps (a fine, a verdict) and prison bars dropping over the board on their words."""
    firms, js = p["firms"], []
    out = [f'<div class="cr-string" id="{eid}-str"></div>']
    w = int(1440 / len(firms))
    for i, f in enumerate(firms):
        x = 240 + i * w
        pic = art.logo(f["logo"], 80, maxw=w - 80) if f.get("logo") else f'<span class="cr-name">{esc(f["name"])}</span>'
        out.append(f'<div class="cr-card" id="{eid}-f{i}" style="left:{x + 20}px;width:{w - 40}px;--r:{(i % 2 * 2 - 1) * 3}deg">{pic}</div>')
        js.append(f'K.slam("#{eid}-f{i}",{c.at(f.get("on"), f.get("nth", 1)):.3f},{{f:1.5}});')
    t_str = c.at(p.get("string_on"), p.get("string_nth", 1))
    js.append(f'tl.fromTo("#{eid}-str",{{scaleX:0}},{{scaleX:1,duration:0.4,ease:"power2.out",transformOrigin:"0% 50%"}},{t_str:.3f});')
    for k, st in enumerate(p.get("stamps", [])):
        out.append(f'<div class="mg-stamp" id="{eid}-s{k}" style="left:{st.get("x", 960)}px;top:{st.get("y", 760)}px;--r:{st.get("rot", -5)}deg">{esc(st["text"])}</div>')
        js.append(f'K.slam("#{eid}-s{k}",{c.at(st.get("on"), st.get("nth", 1)):.3f});')
    if p.get("bars_on"):
        out.append(f'<div class="cr-bars" id="{eid}-bars">{"<i></i>" * 12}</div>')
        js.append(f'tl.fromTo("#{eid}-bars",{{y:-1100}},{{y:0,duration:0.35,ease:"bounce.out"}},{c.at(p["bars_on"], p.get("bars_nth", 1)):.3f});')
    return "".join(out), js


CSS = """
.mg-stamp,.lgc,.ln-dot,.ln-first,.ln-end,.cmp-tile,.cmp-arrow,.tl-card{opacity:0}
.mg{position:absolute;inset:0;background:var(--mg-ground)}
.mg-in{position:absolute;inset:0;transform-origin:50% 50%}
.mg-title{position:absolute;left:200px;top:115px;font:400 66px Anton;letter-spacing:1px;color:var(--ink);text-transform:uppercase}
.mg-title:after{content:"";display:block;width:140px;height:10px;margin-top:10px;background:var(--accent)}
.mg-src{position:absolute;left:200px;bottom:115px;font:500 26px 'IBM Plex Mono';color:#b9b3a8}
.mg-stamp{opacity:0;position:absolute;transform:translate(-50%,-50%) rotate(var(--r));background:var(--red);color:#fff;border:6px solid #111;padding:12px 30px 8px;font:400 72px Anton;letter-spacing:1px;white-space:nowrap;box-shadow:10px 10px 0 #111}
.t-accent{background:var(--accent)}.t-red{background:var(--red)}.t-blue{background:var(--blue)}.t-green{background:var(--green)}.t-ink{background:#2a2c33}.t-cream{background:var(--cream);color:#111}
.lg-txt{font:400 1em Anton;color:var(--ink)}
.bar-row{position:absolute;left:200px;right:200px;height:120px;display:flex;align-items:center}
.bar-head{width:330px;display:flex;align-items:center}
.bar-lab{font:400 58px Anton;color:var(--ink)}
.bar-track{position:relative;flex:1;height:96px}
.bar-fill{position:absolute;left:0;top:0;height:96px;border:5px solid #111;box-shadow:8px 8px 0 #000}
.bar-val{position:absolute;top:-6px;font:400 92px Anton;color:var(--ink)}
.ln-svg{position:absolute;inset:0}.ln-axis{stroke:#5a5c66;stroke-width:4}
.ln-path{fill:none;stroke:var(--red);stroke-width:14;stroke-linecap:round;stroke-linejoin:round}
.ln-dot{position:absolute;width:28px;height:28px;border-radius:50%;background:var(--accent);border:5px solid #111}
.ln-tick{position:absolute;width:160px;text-align:center;font:500 28px 'IBM Plex Mono';color:#b9b3a8}
.ln-end{position:absolute;background:var(--accent);color:#111;border:6px solid #111;padding:8px 26px;font:400 110px Anton;box-shadow:10px 10px 0 #000;white-space:nowrap}
.ln-first{position:absolute;color:var(--ink);font:400 64px Anton}
.cmp-tile{position:absolute;top:240px;width:680px;height:560px;border:6px solid #111;box-shadow:14px 14px 0 #000;color:#111;display:flex;flex-direction:column;align-items:center;justify-content:center}
.cmp-tile.t-ink{color:var(--ink)}
.cmp-cap{font:700 40px 'IBM Plex Sans';text-transform:uppercase;display:flex;gap:18px;align-items:center}
.cmp-num{font:400 210px Anton;line-height:1.05}
.cmp-sub{font:500 30px 'IBM Plex Mono'}
.cmp-arrow{position:absolute;left:910px;top:440px;font:400 120px Anton;color:var(--ink)}
.ptag{position:absolute;top:300px;height:520px;background:var(--cream);border:6px solid #111;border-radius:18px 18px 18px 60px;box-shadow:12px 12px 0 #000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#111;transform-origin:50% 0}
.ptag-name{font:700 38px 'IBM Plex Sans';text-align:center}
.ptag-old{font:400 52px Anton;color:#7a746a}
.ptag-new{font:400 104px Anton;color:var(--red)}
.ptag-up{font:500 30px 'IBM Plex Mono'}
.tl-rail{position:absolute;height:12px;background:var(--ink)}
.tl-pin{position:absolute;width:36px;height:36px;border-radius:50%;background:var(--accent);border:5px solid #111}
.tl-year{position:absolute;width:240px;text-align:center;font:400 64px Anton;color:var(--ink)}
.tl-card{position:absolute;width:380px;padding:22px 24px;border:5px solid #111;box-shadow:10px 10px 0 #000;font:700 36px/1.15 'IBM Plex Sans';color:#111}
.ctr{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
.ctr-num{opacity:0;font:400 300px Anton;color:var(--accent);line-height:1;text-shadow:12px 12px 0 #000}
.ctr-cap{font:700 52px 'IBM Plex Sans';color:var(--ink);text-transform:uppercase;text-align:center;max-width:1500px}
.lgc{position:absolute;top:330px;height:360px;background:var(--cream);border:6px solid #111;box-shadow:12px 12px 0 #000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px;padding:0 20px}
.lgc img{max-width:90%}
.lgc-cap{font:400 56px Anton;color:#111;text-align:center}
.bill{position:absolute;left:560px;top:150px;width:800px;padding:36px 46px;background:#fbf8f1;border:6px solid #111;box-shadow:14px 14px 0 #000;font:500 40px 'IBM Plex Mono';color:#111}
.bill-h{font:400 60px Anton;margin-bottom:16px}
.bill-row,.bill-tot{display:flex;justify-content:space-between;padding:8px 0;border-bottom:3px dashed #bbb}
.bill-row.hot{background:#ffd23f}
.bill-tot{font-weight:700;border-bottom:0;border-top:5px solid #111;margin-top:10px;font-size:48px}
.mtr{position:absolute;left:300px;top:250px;width:760px;padding:40px;background:#0b0b0d;border:8px solid #444;border-radius:20px;box-shadow:14px 14px 0 #000}
.mtr-h{font:400 54px Anton;color:var(--accent);margin-bottom:20px}
.mtr-row{display:flex;justify-content:space-between;align-items:baseline;font:500 40px 'IBM Plex Mono';color:#9aa}
.mtr-row b{font:400 150px Anton;color:#ff5d3a;letter-spacing:4px}
.chk{position:absolute;left:460px;width:1000px;padding:30px 44px;background:#fbf8f1;border:6px solid #111;box-shadow:14px 14px 0 #000;color:#111}
.chk-h{font:400 64px Anton;margin-bottom:12px}
.chk-row{display:flex;justify-content:space-between;align-items:center;height:110px;border-top:3px dashed #bbb;font:700 46px 'IBM Plex Sans';opacity:0}
.chk-row b{font:400 84px Anton;opacity:0}.chk-row b.no{color:var(--red)}.chk-row b.yes{color:#1d9a4a}.chk-row b.val{color:#111}
.cr-card{position:absolute;top:330px;height:230px;background:var(--cream);border:6px solid #111;box-shadow:12px 12px 0 #000;display:flex;align-items:center;justify-content:center;transform:rotate(var(--r));opacity:0}
.cr-name{font:400 64px Anton;color:#111}
.cr-string{position:absolute;left:260px;top:440px;width:1400px;height:8px;background:var(--red);box-shadow:0 0 12px #f33}
.cr-bars{position:absolute;left:200px;top:130px;width:1520px;height:820px;display:flex;justify-content:space-between}
.cr-bars i{display:block;width:28px;height:100%;background:linear-gradient(90deg,#555,#bbb 40%,#444);border:3px solid #111}
"""
