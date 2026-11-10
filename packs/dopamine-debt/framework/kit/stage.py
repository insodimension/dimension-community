"""The stage: the house look of a kit film's motion graphics.

Every stage scene is drawn in 1920 x 1080 design pixels and shot by one camera (`scene(name, box=...)`): its subject
box is framed to fill about three quarters of the frame width, inside a stage window that sits within the 10% edge band
even while the kit pushes the scene in, over a floor in perspective that drifts under it. A scene may move the camera
(`cam`) and keep a heads-up layer that the camera does not scale (a third return value).

Every reveal lands on a spoken word named in the MG picture (`*_on`, `*_nth`); with no word given it falls at a fixed
fraction of the scene (`cue`), so a scene still builds while the script is being repaired. `beat_push` adds camera beats
so the picture never holds longer than 3.6 s between reveals.

A film registers its own templates here with `scene` and passes `Film(scenes=stage.SCENES, scene_css=stage.CSS + ...)`.
The stage's own `bars`, `counter` and `checklist` replace the kit's flat ones (`kit/scenes.py`) for such a film."""
from __future__ import annotations

import json
import math
from typing import Callable

from .art import Art, esc
from .scenes import PUSH, Cues, Scene, count_frames, stamps

SCENES: dict[str, Scene] = {}
Box = tuple[float, float, float, float]
WIN_X, WIN_Y, WIN_W, WIN_H = 236, 128, 1448, 790
STAGE_FADE, BEAT_LIFT = 28, 6
SAFE_X0 = 960 - (960 - WIN_X - STAGE_FADE) / PUSH
SAFE_X1 = 960 + (WIN_X + WIN_W - STAGE_FADE - 960) / PUSH
SAFE_Y0 = 540 - (540 - WIN_Y - STAGE_FADE) / PUSH + BEAT_LIFT
SAFE_Y1 = 540 + (WIN_Y + WIN_H - STAGE_FADE - 540) / PUSH - BEAT_LIFT
ZOOM_MAX = 1.6
FLOOR_DRIFT_PX = 160
DRIFT_SECONDS = 0.9


def framing(box: Box) -> tuple[float, float, float]:
    """Camera (x, y, scale) that centres `box` in the stage's safe area (SAFE_*: the window inside its STAGE_FADE edge,
    shrunk by the kit's scene push and the beat lift, so nothing framed ever reaches the fade) at the largest size that
    fits it."""
    x, y, w, h = box
    k = min((SAFE_X1 - SAFE_X0) / w, (SAFE_Y1 - SAFE_Y0) / h, ZOOM_MAX)
    return (SAFE_X0 + SAFE_X1) / 2 - k * (x + w / 2), (SAFE_Y0 + SAFE_Y1) / 2 - k * (y + h / 2), k


def frame_point(box: Box, x: float, y: float) -> tuple[float, float]:
    """Where design point (x, y) of a scene framed on `box` lands in the frame (before the kit's push)."""
    cx, cy, k = framing(box)
    return cx + k * x, cy + k * y


def cam(eid: str, box: Box, t: float, d: float, ease: str = "power2.inOut") -> str:
    """Move the scene's camera to frame `box` at `t`, over `d` seconds."""
    x, y, k = framing(box)
    return to(f"#{eid}-cam", {"x": round(x, 1), "y": round(y, 1), "scale": round(k, 4), "duration": d, "ease": ease}, t)


def scene(name: str, box: Box | Callable[[dict], Box | None] | None = None, floor: bool = True):
    """Register a template shot by the film's camera. The template returns (world, js) or (world, js, hud): the world
    is drawn in design pixels and framed on `box` (a fixed box, or one computed from the picture's params; None keeps
    the design frame), the hud sits over it unscaled. Both live in the stage window; `floor` lays the drifting floor
    under them."""
    def reg(fn: Callable[..., tuple]) -> Callable[..., tuple]:
        def shot(eid: str, p: dict, c: Cues, art: Art) -> tuple[str, list[str]]:
            world, js, *hud = fn(eid, p, c, art)
            b = box(p) if callable(box) else box
            x, y, k = framing(b) if b else (0.0, 0.0, 1.0)
            ground = '<div class="st-floor"></div>' if floor else ""
            html = (f'<div class="st-win">{ground}<div class="st-cam" id="{eid}-cam" style="transform:translate({x:.1f}px,{y:.1f}px) scale({k:.4f})">'
                    f'{world}</div>{"".join(hud)}</div>')
            if floor:
                js = [ft(f"#{eid} .st-floor", {"backgroundPositionX": "0px"}, {"backgroundPositionX": f"-{FLOOR_DRIFT_PX}px", "duration": span(c), "ease": "none"}, c.start)] + js
            return html, js

        SCENES[name] = shot
        return fn

    return reg


def J(d: dict) -> str:
    return json.dumps(d, separators=(",", ":"), ensure_ascii=False)


def ft(sel: str, a: dict, b: dict, t: float) -> str:
    return f'tl.fromTo("{sel}",{J(a)},{J(b)},{t:.3f});'


def to(sel: str, b: dict, t: float) -> str:
    return f'tl.to("{sel}",{J(b)},{t:.3f});'


def tset(sel: str, b: dict, t: float) -> str:
    return f'tl.set("{sel}",{J(b)},{t:.3f});'


def pop(sel: str, t: float, d: float = 0.28, f: float = 0.6) -> str:
    return ft(sel, {"scale": f, "opacity": 0}, {"scale": 1, "opacity": 1, "duration": d, "ease": "back.out(2.2)"}, t)


def rise(sel: str, t: float, d: float = 0.3, y: int = 40) -> str:
    return ft(sel, {"opacity": 0, "y": y}, {"opacity": 1, "y": 0, "duration": d, "ease": "power3.out"}, t)


def slam(sel: str, t: float) -> str:
    return f'K.slam("{sel}",{t:.3f});'


def roll(sel: str, a: float, b: float, t0: float, t1: float, dec: int = 0, prefix: str = "", suffix: str = "", steps: int = 18) -> str:
    return f'K.count("{sel}",{J(count_frames(a, b, dec, prefix, suffix, steps))},{t0:.3f},{max(t0 + 0.2, t1):.3f});'


def draw(sel: str, t: float, d: float, ease: str = "power2.inOut") -> str:
    return to(sel, {"strokeDashoffset": 0, "duration": d, "ease": ease}, t)


def span(c: Cues) -> float:
    return max(0.1, c.end - c.start)


def cue(c: Cues, p: dict, key: str, frac: float) -> float:
    """The time a part lands: the word `p[key]` (its `p[key + "_nth"]` repeat) minus the kit's lead, else `frac` of the
    scene."""
    if p.get(key):
        return c.at(p[key], p.get(f"{key}_nth", 1))
    s = span(c)
    return c.at(max(0.0, min(s * frac, s - 0.3)))


def later(c: Cues, p: dict, key: str, frac: float, after: float, gap: float = 0.35) -> float:
    """A cue that never lands before `after` + `gap` (two parts that share a word, or a fallback that would collide)."""
    return c.shown(max(cue(c, p, key, frac), after + gap))


def beats(c: Cues, times: list[float], every: float = 3.6) -> list[float]:
    """Extra camera beats so the picture never holds longer than `every` between reveals (G11 show-dont-tell)."""
    marks = sorted({c.start, *times, c.end})
    out = []
    for a, b in zip(marks, marks[1:]):
        n = int((b - a) // every)
        out += [c.shown(a + (b - a) * k / (n + 1)) for k in range(1, n + 1)]
    return out


def drift_pose(k: int, amp: float) -> tuple[float, float, float]:
    """The wall's (x, y, scale) after the kth drift beat."""
    return round(amp * math.sin(k * 1.7)), round(amp * 0.6 * math.cos(k * 1.3)), 1 + 0.025 * (k % 3)


def drift(sel: str, c: Cues, times: list[float], amp: float = 26) -> list[str]:
    """A slow camera that moves on each beat: the frame changes without anything leaving it."""
    js = []
    for k, t in enumerate(times, start=1):
        x, y, s = drift_pose(k, amp)
        js.append(to(sel, {"x": x, "y": y, "scale": s, "duration": DRIFT_SECONDS, "ease": "power2.inOut"}, t))
    return js


def corner_counter(eid: str, rows: list[tuple[str, str]], note: str = "") -> str:
    """A money object pinned to the stage window's top-right corner: one `rows` (key, label) counter per row, each value
    at `#{eid}-{key}` for a roll, with `note` (`#{eid}-tn`, hidden until slammed) beside it on its left, in the same bar."""
    out = "".join(f'<div class="kc-row"><span>{esc(label)}</span><b id="{eid}-{key}">0</b></div>' for key, label in rows)
    tag = f'<div class="kc-note" id="{eid}-tn">{esc(note)}</div>' if note else ""
    return f'<div class="kc-bar">{tag}<div class="kc" id="{eid}-kc">{out}</div></div>'


def beat_push(eid: str, c: Cues, times: list[float]) -> list[str]:
    """The scene's inner layer lifts and settles on each extra camera beat (`beats`), so a held picture still moves."""
    return [to(f"#{eid}-in", {"y": -6 * (k % 2 * 2 - 1), "duration": 0.8, "ease": "sine.inOut"}, t) for k, t in enumerate(beats(c, times))]


BAR_LEFT, BAR_RIGHT, BAR_MID_Y = 260, 1660, 500
BAR_ROW_H = {1: 230, 2: 190}
BAR_ROW_H_MANY, BAR_GAP_SHARE, BAR_LABEL_SHARE, BAR_VALUE_SHARE = 150, 0.3, 0.42, 0.8
BAR_HEAD_MAX, BAR_VALUE_MAX, BAR_LABEL_EM, BAR_VALUE_EM = 420, 320, 0.47, 0.55
WAITING = 0.5  # opacity of a row that is on stage before its word lands (bars, checklist)


def bar_layout(p: dict) -> dict:
    """Where the bar chart sits in design pixels: row height (by row count), label and value type sized so neither
    column takes the track's room (Anton is about BAR_LABEL_EM / BAR_VALUE_EM of its size a character), the track, and
    the block's top."""
    rows = p["rows"]
    rh = BAR_ROW_H.get(len(rows), BAR_ROW_H_MANY)
    gap = round(rh * BAR_GAP_SHARE)
    vmax = p.get("max") or max(r["value"] for r in rows)
    texts = [r.get("text") or f'{r.get("prefix", "")}{r["value"]:,.{r.get("dec", 0)}f}{r.get("suffix", "")}' for r in rows]
    chars, digits = max(len(r["label"]) for r in rows), max(len(t) for t in texts)
    lf = min(rh * BAR_LABEL_SHARE, BAR_HEAD_MAX / (BAR_LABEL_EM * chars))
    vf = min(rh * BAR_VALUE_SHARE, BAR_VALUE_MAX / (BAR_VALUE_EM * digits))
    head_w, value_room = round(BAR_LABEL_EM * lf * chars) + 10, round(BAR_VALUE_EM * vf * digits) + 60
    track_x = BAR_LEFT + head_w + 28
    block = len(rows) * rh + (len(rows) - 1) * gap
    return {"rh": rh, "gap": gap, "vmax": vmax, "lf": round(lf), "vf": round(vf), "head_w": head_w, "track_x": track_x,
            "track_w": BAR_RIGHT - value_room - track_x, "block": block, "top": BAR_MID_Y - block // 2,
            "stamp_rows": stamp_rows(([p["stamp"]] if p.get("stamp") else []) + p.get("stamps", []), BAR_RIGHT - BAR_LEFT)}


STAMP_EM, STAMP_PX, STAMP_PAD, STAMP_GAP, STAMP_ROW_H, STAMP_BELOW = 0.47, 72, 60, 60, 150, 200


def stamp_rows(sts: list[dict], width: float) -> list[list[tuple[dict, float]]]:
    """Stamps packed into rows no wider than `width`, each with its estimated width (Anton is about STAMP_EM of its size
    a character), in order."""
    rows: list[list[tuple[dict, float]]] = []
    for st in sts:
        w = STAMP_EM * STAMP_PX * len(st["text"]) + STAMP_PAD
        if rows and sum(x for _, x in rows[-1]) + STAMP_GAP * len(rows[-1]) + w <= width:
            rows[-1].append((st, w))
        else:
            rows.append([(st, w)])
    return rows


def placed_stamps(rows: list[list[tuple[dict, float]]], cx: float, y: float) -> list[dict]:
    """Each stamp with its centre: rows centred on `cx`, the first row's centre at `y`, STAMP_ROW_H apart."""
    out = []
    for n, row in enumerate(rows):
        left = cx - (sum(w for _, w in row) + STAMP_GAP * (len(row) - 1)) / 2
        for st, w in row:
            out.append({**st, "x": round(left + w / 2), "y": round(y + n * STAMP_ROW_H)})
            left += w + STAMP_GAP
    return out


def bar_box(p: dict) -> Box:
    g = bar_layout(p)
    return (BAR_LEFT, g["top"] - 40, BAR_RIGHT - BAR_LEFT, g["block"] + 130 + STAMP_ROW_H * len(g["stamp_rows"]))


@scene("bars", box=bar_box)
def bars(eid: str, p: dict, c: Cues, art: Art) -> tuple[str, list[str]]:
    """Bars on a measured axis, composed around the frame's centre and sized by how many rows there are: the axis
    (gridlines at quarters of `max`, with their values) draws at the start with every row's label waiting, dimmed, in
    its place; then each row (`rows[{label, value, dec?, prefix?, suffix?, tone?, on, nth?}]`) lights on its word, its
    bar grows and its value counts to the paper's figure, landing on it exactly. `stamps` land below the rows."""
    rows, g = p["rows"], bar_layout(p)
    rh, top, block, track_x, track_w, vmax = g["rh"], g["top"], g["block"], g["track_x"], g["track_w"], g["vmax"]
    axis = "".join(f'<i class="br-grid" style="left:{track_x + track_w * k / 4:.0f}px;top:{top - 40}px;height:{block + 80}px"></i>'
                   f'<b class="br-tick" style="left:{track_x + track_w * k / 4 - 60:.0f}px;top:{top + block + 50}px">{vmax * k / 4:,.{0 if vmax >= 20 else 1}f}</b>'
                   for k in range(5))
    out = [f'<div class="br-axis">{axis}</div>']
    t0 = c.shown(c.start)
    js = [ft(f"#{eid} .br-grid", {"scaleY": 0}, {"scaleY": 1, "duration": 0.4, "stagger": 0.05, "ease": "power3.out"}, t0),
          ft(f"#{eid} .br-tick", {"opacity": 0, "y": 10}, {"opacity": 1, "y": 0, "duration": 0.3, "stagger": 0.05}, t0 + 0.1)]
    times = [t0]
    for i, r in enumerate(rows):
        y = top + i * (rh + g["gap"])
        w = track_w * r["value"] / vmax
        out.append(f'<div class="br-row" id="{eid}-r{i}" style="top:{y}px;--rh:{rh}px;--lf:{g["lf"]}px;--vf:{g["vf"]}px"><span class="br-lab" style="width:{g["head_w"]}px">{esc(r["label"])}</span>'
                   f'<i class="br-fill t-{r.get("tone", "accent")}" id="{eid}-f{i}" style="left:{track_x - BAR_LEFT}px;width:{max(8, w):.0f}px"></i>'
                   f'<b class="br-val" id="{eid}-v{i}" style="left:{track_x - BAR_LEFT + max(8, w) + 28:.0f}px">{esc(r.get("text", ""))}</b></div>')
        t = c.at(r.get("on"), r.get("nth", 1))
        times.append(t)
        settle = min(t + 0.62, max(t + 0.25, c.end - 0.15))
        tw = t0 + 0.08 * i
        js += ([ft(f"#{eid}-r{i}", {"x": -60, "opacity": 0}, {"x": 0, "opacity": WAITING, "duration": 0.3, "ease": "power3.out"}, tw),
                to(f"#{eid}-r{i}", {"opacity": 1, "duration": 0.18}, t)] if t >= tw + 0.35 else
               [ft(f"#{eid}-r{i}", {"x": -60, "opacity": 0}, {"x": 0, "opacity": 1, "duration": 0.22, "ease": "power3.out"}, t)])
        js.append(ft(f"#{eid}-f{i}", {"scaleX": 0}, {"scaleX": 1, "duration": settle - t - 0.03, "ease": "power3.out", "transformOrigin": "0% 50%"}, t + 0.05))
        if "text" not in r:
            frames = count_frames(0, r["value"], r.get("dec", 0), r.get("prefix", ""), r.get("suffix", ""))
            js.append(f'K.count("#{eid}-v{i}",{json.dumps(frames)},{t + 0.05:.3f},{settle:.3f});')
    st_html, st_js = stamps(eid, {"stamps": placed_stamps(g["stamp_rows"], (BAR_LEFT + BAR_RIGHT) / 2, top + block + STAMP_BELOW)}, c, 0, 0, -2)
    js += st_js + beat_push(eid, c, times)
    return "".join(out) + st_html, js


ODO_W, ODO_H, ODO_SEP_W, ODO_GLYPH_W, ODO_TURNS, ODO_SHORT, ODO_SHORT_SCALE = 210, 300, 96, 190, 20, 3, 1.3
ODO_TOP, ODO_CAPTION_GAP, RAIL_W, RAIL_GAP = 300, 80, 1240, 70


def odometer_cells(p: dict) -> list[tuple[str, int | None]]:
    """The counter's final text as cells: (glyph, units place) for a digit wheel, (glyph, None) for a fixed glyph."""
    dec = p.get("dec", 0)
    text = f'{p.get("prefix", "")}{p["value"]:,.{dec}f}{p.get("suffix", "")}'
    digits = sum(ch.isdigit() for ch in text)
    cells, place = [], digits
    for ch in text:
        if ch.isdigit():
            place -= 1
            cells.append((ch, place))
        else:
            cells.append((ch, None))
    return cells


def odo_scale(p: dict) -> float:
    """Wheels grow for a short number, so a two- or three-digit count still owns the frame."""
    return ODO_SHORT_SCALE if sum(place is not None for _, place in odometer_cells(p)) <= ODO_SHORT else 1.0


def odometer_width(p: dict) -> int:
    k = odo_scale(p)
    return round(k * sum(ODO_W if place is not None else ODO_SEP_W if ch in ",." else ODO_GLYPH_W for ch, place in odometer_cells(p)))


def counter_rail(p: dict) -> float | None:
    return p.get("max") or (100.0 if p.get("suffix") == "%" else None)


def counter_box(p: dict) -> Box:
    w = max(odometer_width(p) + 80, RAIL_W if counter_rail(p) else 0)
    h = ODO_CAPTION_GAP + round(ODO_H * odo_scale(p)) + 40 + (RAIL_GAP + 90 if counter_rail(p) else 0)
    return (960 - w / 2, ODO_TOP - ODO_CAPTION_GAP - 20, w, h + 20)


@scene("counter", box=counter_box)
def counter(eid: str, p: dict, c: Cues, art: Art) -> tuple[str, list[str]]:
    """One number on an odometer: a wheel per digit that rolls from `from_value` (default 0) and lands exactly on
    `value` on its word `on` (each wheel turns as many places as that digit really advances, capped at ODO_TURNS), under
    a `caption` saying what is counted. A percentage (or a `max`) also fills a rail to scale; `ticker` runs the caption
    past behind it, again and again."""
    dec = p.get("dec", 0)
    unit = 10 ** dec
    u0, u1 = round(p.get("from_value", 0) * unit), round(p["value"] * unit)
    cells = odometer_cells(p)
    width, scale = odometer_width(p), odo_scale(p)
    wheel_w, wheel_h = round(ODO_W * scale), round(ODO_H * scale)
    x = 960 - width // 2
    t0 = c.shown(c.start)
    t_roll = c.shown(t0 + 0.2)
    t_on = max(t_roll + 0.4, c.at(p.get("on"), p.get("nth", 1)))
    out, js = [], [ft(f"#{eid}-cp", {"opacity": 0, "y": 30}, {"opacity": 1, "y": 0, "duration": 0.3, "ease": "power3.out"}, t0),
                   ft(f"#{eid}-od", {"opacity": 0, "scale": 0.9}, {"opacity": 1, "scale": 1, "duration": 0.3, "ease": "back.out(1.8)"}, t0)]
    if p.get("ticker"):
        line = f'{esc(p["caption"])} \u00b7 ' * 6
        out.append(f'<div class="od-tick" id="{eid}-tk"><span>{line}</span><span>{line}</span></div>')
        js.append(ft(f"#{eid}-tk", {"xPercent": 0}, {"xPercent": -50, "duration": max(1.0, span(c)), "ease": "none"}, t0))
    wheels = []
    for n, (ch, place) in enumerate(cells):
        if place is None:
            wheels.append(f'<div class="od-glyph" style="width:{round(scale * (ODO_SEP_W if ch in ",." else ODO_GLYPH_W))}px">{esc(ch)}</div>')
            continue
        d0, adv = (u0 // 10 ** place) % 10, u1 // 10 ** place - u0 // 10 ** place
        steps = adv if adv <= ODO_TURNS else ODO_TURNS + (adv - ODO_TURNS) % 10
        strip = "".join(f"<b>{(d0 + k) % 10}</b>" for k in range(steps + 1))
        wheels.append(f'<div class="od-wheel"><div class="od-strip" id="{eid}-s{n}">{strip}</div></div>')
        if steps:
            js.append(ft(f"#{eid}-s{n}", {"y": 0}, {"y": -steps * wheel_h, "duration": round(t_on - t_roll, 3), "ease": "power3.out"}, t_roll))
    out.append(f'<div class="od-cap" id="{eid}-cp" style="top:{ODO_TOP - ODO_CAPTION_GAP}px">{esc(p["caption"])}</div>'
               f'<div class="od" id="{eid}-od" style="left:{x}px;top:{ODO_TOP}px;width:{width}px;--ow:{wheel_w}px;--oh:{wheel_h}px">{"".join(wheels)}</div>')
    js.append(f'K.shake("#{eid}-od",{t_on + 0.03:.3f});')
    rail = counter_rail(p)
    if rail:
        ry = ODO_TOP + wheel_h + RAIL_GAP
        f0, f1 = p.get("from_value", 0) / rail, p["value"] / rail
        out.append(f'<div class="od-rail" style="left:{960 - RAIL_W // 2}px;top:{ry}px;width:{RAIL_W}px"><i id="{eid}-rf" style="width:{RAIL_W * f1:.0f}px"></i>'
                   + "".join(f'<u style="left:{RAIL_W * k / 4:.0f}px"><em>{rail * k / 4:g}</em></u>' for k in range(5)) + "</div>")
        js.append(ft(f"#{eid}-rf", {"scaleX": round(f0 / f1, 4) if f1 else 0}, {"scaleX": 1, "duration": round(t_on - t_roll, 3), "ease": "power3.out", "transformOrigin": "0% 50%"}, t_roll))
    # The stamp lands on the wheels' top-right corner, clear of the caption (centred above) and of the rail below.
    st_html, st_js = stamps(eid, p, c, x + width - 220, ODO_TOP - 50, 6)
    js += st_js + beat_push(eid, c, [t0, t_on])
    return "".join(out) + st_html, js


CHECK_ROW_H, CHECK_GAP, CHECK_X, CHECK_W = 132, 22, 280, 1360
CHECK_GHOST_EM, CHECK_SHEEN_S, CHECK_SHEEN_REST, CHECK_SHEEN_LAG = 30, 0.8, 0.5, 0.12


def sheen(sel: str, t: float, until: float) -> str:
    """A light band sweeping across a ghosted placeholder from `t`, once every CHECK_SHEEN_S + CHECK_SHEEN_REST, every
    sweep starting before `until` (where the placeholder gives way to its text)."""
    period = CHECK_SHEEN_S + CHECK_SHEEN_REST
    sweeps = max(1, int((until - t) / period) + 1)
    return ft(sel, {"backgroundPositionX": "100%"}, {"backgroundPositionX": "0%", "duration": CHECK_SHEEN_S, "repeat": sweeps - 1,
                                                       "repeatDelay": CHECK_SHEEN_REST, "ease": "sine.inOut"}, t)


def checklist_box(p: dict) -> Box:
    n = len(p["rows"])
    h = n * CHECK_ROW_H + (n - 1) * CHECK_GAP
    return (CHECK_X - 20, 540 - h / 2 - 20, CHECK_W + 40, h + 40)


@scene("checklist", box=checklist_box)
def checklist(eid: str, p: dict, c: Cues, art: Art) -> tuple[str, list[str]]:
    """A list that fills the stage: every row's plate (an empty mark box and slot) is on stage from the start, so the
    frame is never bare; a plate waiting for its word holds a ghosted placeholder line the length of its text, a sheen
    sweeping down the list, so the empty list reads as one about to be filled; each row's text (`rows[{text, mark?, on,
    nth?, mark_on?, mark_nth?}]`) slides into its plate on its word, and the mark lands on `mark_on` (default its row's
    word): a tick drawn in, a red cross (✗, the default) drawn in, or any other text slammed into the box."""
    rows = p["rows"]
    h = len(rows) * CHECK_ROW_H + (len(rows) - 1) * CHECK_GAP
    top = 540 - h // 2
    t0 = c.shown(c.start)
    out, js, times = [], [], []
    for i, r in enumerate(rows):
        mark = r.get("mark", "\u2717")
        if mark == "\u2713":
            sign = f'<svg viewBox="0 0 100 100"><path id="{eid}-k{i}" d="M18 54 L42 76 L84 26" pathLength="1000" class="cl-yes"/></svg>'
        elif mark == "\u2717":
            sign = f'<svg viewBox="0 0 100 100"><path id="{eid}-k{i}" d="M24 24 L76 76 M76 24 L24 76" pathLength="1000" class="cl-no"/></svg>'
        else:
            sign = f'<b id="{eid}-k{i}">{esc(mark)}</b>'
        t = c.at(r.get("on"), r.get("nth", 1))
        tm = c.at(r.get("mark_on", r.get("on")), r.get("mark_nth", r.get("nth", 1))) + 0.15
        times += [t, tm]
        tw = t0 + 0.07 * i
        waiting = t >= tw + 0.35
        ghost = f'<i class="cl-ghost" id="{eid}-g{i}" style="width:{round(len(r["text"]) * CHECK_GHOST_EM)}px"></i>' if waiting else ""
        out.append(f'<div class="cl-row" id="{eid}-r{i}" style="left:{CHECK_X}px;top:{top + i * (CHECK_ROW_H + CHECK_GAP)}px;width:{CHECK_W}px">'
                   f'<div class="cl-box">{sign}</div>{ghost}<span id="{eid}-x{i}">{esc(r["text"])}</span></div>')
        if waiting:
            js += [ft(f"#{eid}-r{i}", {"y": 40, "opacity": 0}, {"y": 0, "opacity": WAITING, "duration": 0.3, "ease": "power3.out"}, tw),
                   sheen(f"#{eid}-g{i}", t0 + 0.3 + CHECK_SHEEN_LAG * i, t),
                   to(f"#{eid}-g{i}", {"opacity": 0, "scaleX": 0.4, "duration": 0.16, "ease": "power2.in", "transformOrigin": "0% 50%"}, t),
                   to(f"#{eid}-r{i}", {"opacity": 1, "duration": 0.18}, t)]
        else:
            js.append(ft(f"#{eid}-r{i}", {"y": 40, "opacity": 0}, {"y": 0, "opacity": 1, "duration": 0.24, "ease": "power3.out"}, t))
        js.append(ft(f"#{eid}-x{i}", {"x": -90, "opacity": 0}, {"x": 0, "opacity": 1, "duration": 0.24, "ease": "power3.out"}, t))
        if mark in ("\u2713", "\u2717"):
            js.append(ft(f"#{eid}-k{i}", {"strokeDashoffset": 1000}, {"strokeDashoffset": 0, "duration": 0.3, "ease": "power2.out"}, tm))
        else:
            js.append(slam(f"#{eid}-k{i}", tm))
        js.append(to(f"#{eid}-r{i}", {"keyframes": [{"scale": 1.03, "duration": 0.1}, {"scale": 1, "duration": 0.2}]}, tm))
    js += beat_push(eid, c, [c.start, *times])
    return "".join(out), js


STAGE_CSS = (
    f".st-win{{position:absolute;left:{WIN_X}px;top:{WIN_Y}px;width:{WIN_W}px;height:{WIN_H}px;overflow:hidden;"
    f"-webkit-mask-image:linear-gradient(90deg,transparent,#000 {STAGE_FADE}px,#000 calc(100% - {STAGE_FADE}px),transparent),linear-gradient(transparent,#000 {STAGE_FADE}px,#000 calc(100% - {STAGE_FADE}px),transparent);"
    "-webkit-mask-composite:source-in;mask-composite:intersect}\n"
    f".st-cam{{position:absolute;left:{-WIN_X}px;top:{-WIN_Y}px;width:1920px;height:1080px;transform-origin:0 0}}\n"
)

CSS = STAGE_CSS + """
.mg:before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse 60% 50% at 50% 34%,#1a1d24 0,transparent 70%),linear-gradient(#ffffff05 1px,transparent 1px) 0 0/48px 48px,linear-gradient(90deg,#ffffff05 1px,transparent 1px) 0 0/48px 48px}
.mg:after{content:"";position:absolute;inset:0;box-shadow:inset 0 0 320px 90px #000000b0;pointer-events:none}
.st-floor{position:absolute;left:-40%;right:-40%;top:60%;height:100%;background-image:linear-gradient(#ffffff16 2px,transparent 2px),linear-gradient(90deg,#ffffff16 2px,transparent 2px);background-size:140px 100px;transform:perspective(520px) rotateX(66deg);transform-origin:50% 0;-webkit-mask-image:linear-gradient(transparent,#000 22%,#000 60%,transparent)}
.st-floor:before{content:"";position:absolute;left:0;right:0;top:0;height:4px;background:linear-gradient(90deg,transparent,#ffa31a33,transparent)}
.br-axis{position:absolute;inset:0}
.br-grid{position:absolute;width:2px;background:#ffffff14;transform-origin:50% 100%}
.br-tick{position:absolute;width:120px;text-align:center;font:500 28px 'IBM Plex Mono';color:#6b7280}
.br-row{position:absolute;left:260px;right:260px;height:var(--rh);opacity:0}
.br-lab{position:absolute;left:0;top:0;height:var(--rh);display:flex;align-items:center;font:400 var(--lf) Anton;color:var(--ink);white-space:nowrap}
.br-fill{position:absolute;top:calc(var(--rh) * .13);height:calc(var(--rh) * .74);border-radius:14px;background:linear-gradient(#ffb84a,var(--accent) 60%,#e58a0c);box-shadow:0 24px 50px #000a}
.br-fill.t-red{background:linear-gradient(#ff6a5c,var(--red) 60%,#d83a2b)}.br-fill.t-ink{background:#5d6370}
.br-val{position:absolute;top:0;height:var(--rh);display:flex;align-items:center;font:400 var(--vf) Anton;color:var(--ink);white-space:nowrap}
.kc-bar{position:absolute;right:56px;top:48px;display:flex;align-items:center;gap:20px}
.kc{position:relative;padding:14px 28px;background:#12141ae6;border:2px solid #2a2f3a;border-radius:16px;opacity:0;box-shadow:0 20px 50px #000c}
.kc-row{display:flex;justify-content:space-between;align-items:baseline;gap:28px}
.kc-row span{font:700 22px 'IBM Plex Sans';letter-spacing:3px;color:#8b909c}
.kc-row b{font:400 64px Anton;color:var(--accent);line-height:1.1}
.kc-note{font:400 52px Anton;color:#111;background:var(--accent);padding:4px 20px;border-radius:10px;white-space:nowrap;opacity:0;box-shadow:0 18px 40px #000a}
.od{position:absolute;display:flex;height:var(--oh);opacity:0;filter:drop-shadow(0 30px 50px #000c)}
.od-wheel{position:relative;width:var(--ow);height:var(--oh);overflow:hidden;box-sizing:border-box;background:linear-gradient(#050608,#1b1f27 24%,#232833 50%,#1b1f27 76%,#050608);border:2px solid #2a2f3a;border-radius:16px}
.od-wheel:after{content:"";position:absolute;inset:0;background:linear-gradient(#000a,transparent 26%,transparent 74%,#000a)}
.od-strip{position:absolute;left:0;top:0;width:100%}
.od-strip b{display:block;height:var(--oh);font:400 calc(var(--oh) * .83)/var(--oh) Anton;color:var(--accent);text-align:center}
.od-glyph{height:var(--oh);font:400 calc(var(--oh) * .83)/var(--oh) Anton;color:var(--ink);text-align:center}
.od-cap{position:absolute;left:0;right:0;text-align:center;font:500 46px 'IBM Plex Mono';color:var(--ink);opacity:0;white-space:nowrap}
.od-tick{position:absolute;left:0;top:330px;white-space:nowrap;font:400 220px Anton;color:var(--ink);opacity:.07;letter-spacing:4px}
.od-rail{position:absolute;height:26px;border-radius:13px;background:#1b1e26;box-shadow:inset 0 0 0 2px #2a2f3a}
.od-rail i{position:absolute;left:0;top:0;height:100%;border-radius:13px;background:var(--accent);transform-origin:0 50%;box-shadow:0 0 30px #ffa31a66}
.od-rail u{position:absolute;top:36px;width:2px;height:14px;background:#5d6370}
.od-rail em{position:absolute;top:18px;left:-40px;width:80px;text-align:center;font:500 26px 'IBM Plex Mono';color:#8b909c;font-style:normal}
.cl-row{position:absolute;height:132px;display:flex;align-items:center;gap:44px;padding:0 44px;box-sizing:border-box;background:#12141a;border:2px solid #2a2f3a;border-radius:22px;box-shadow:0 30px 60px #0009;opacity:0}
.cl-row span{font:400 76px Anton;color:var(--ink);letter-spacing:1px;white-space:nowrap}
.cl-ghost{position:absolute;left:184px;top:50%;height:34px;margin-top:-17px;border-radius:17px;background:linear-gradient(90deg,#4a505c 0,#4a505c 38%,#9aa0ab 50%,#4a505c 62%,#4a505c 100%) 100% 0/300% 100% no-repeat}
.cl-box{position:relative;flex:none;width:96px;height:96px;box-sizing:border-box;border-radius:18px;border:4px solid #3a3f4b;display:flex;align-items:center;justify-content:center}
.cl-box svg{width:84px;height:84px;overflow:visible}
.cl-yes,.cl-no{fill:none;stroke-width:14;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1000;stroke-dashoffset:1000}
.cl-yes{stroke:var(--accent)}.cl-no{stroke:var(--red)}
.cl-box b{font:400 80px/1 Anton;color:var(--accent);opacity:0}
.mg-stamp{background:var(--accent);color:#111;border:0;box-shadow:none;border-radius:8px}
"""
