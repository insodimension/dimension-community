"""Meme overlay modes (FRAMEWORK §10): one implementation for every film.

Holds the mechanics only: size, mask, opacity, placement and motion. Colours, outlines and window chrome stay in
each film's own style.

Placement comes in two forms built from the same constants: `*_box()` takes a rect measured in Python (a capture's
highlight), `*_js()` returns a JS expression for builders that measure the anchor in the page. In the JS, `r` is a
rect {x, y, w, h} and `P(id, style)` applies left/top/width/height.

Motion is data: a list of (method, from_vars, to_vars, offset, duration, ease), where method is "fromTo", "to" or
"set" and offset is seconds after the overlay starts. Each builder turns the rows into its own GSAP calls.
"""
from __future__ import annotations

FRAME_W, FRAME_H = 1920, 1080

SPOT_D = 460
SPOT_MASK = "radial-gradient(circle,#000 60%,transparent 71%)"
SPOT_DX, SPOT_DY = -200, -340
EDGE_X, EDGE_Y = FRAME_W // 10, FRAME_H // 10  # the 10% edge band nothing important enters (taste.json safe-corners)
SPOT_X_RANGE, SPOT_Y_RANGE = (EDGE_X, FRAME_W - EDGE_X - SPOT_D), (EDGE_Y, FRAME_H - EDGE_Y - SPOT_D)
SPOT_FALLBACK = (SPOT_X_RANGE[1], SPOT_Y_RANGE[0])

DARK_LUMA = 0.22  # a spotlight/slot clip darker than this (mean centre luma, 0-1) is lifted so the face reads
LUMA_TARGET = 0.32
LUMA_MAX_GAIN = 1.6

CUT_HEIGHT = 600
CUT_EDGE = 40

GHOST_W = 1100
GHOST_OPACITY = 0.62
GHOST_MASK_STOP = "45%"

SLOT_MIN_H = 150

MODES = ("fullscreen", "cutout", "spotlight", "slot", "ghost")

Rect = tuple[float, float, float, float]


def _clamp(v: float, lo: float, hi: float) -> int:
    return int(max(lo, min(hi, v)))


def spot_box(r: Rect | None) -> tuple[int, int, int, int]:
    """Top-left and size of the spotlight disc, on the anchor's top-right corner."""
    if r is None:
        return (*SPOT_FALLBACK, SPOT_D, SPOT_D)
    x, y, w, _ = r
    return (_clamp(x + w + SPOT_DX, *SPOT_X_RANGE), _clamp(y + SPOT_DY, *SPOT_Y_RANGE), SPOT_D, SPOT_D)


def spot_beside(r: Rect | None) -> tuple[int, int, int, int]:
    """The spotlight disc in the right-hand column beside a page laid out to leave it free, level with the anchor, so
    the words it reacts to stay readable."""
    if r is None:
        return (*SPOT_FALLBACK, SPOT_D, SPOT_D)
    _, y, _, h = r
    return (SPOT_X_RANGE[1], _clamp(y + h / 2 - SPOT_D / 2, *SPOT_Y_RANGE), SPOT_D, SPOT_D)


def spot_js(el: str) -> str:
    return (f'(()=>{{let x=r.x+r.w{SPOT_DX:+d},y=r.y{SPOT_DY:+d};x=Math.max({SPOT_X_RANGE[0]},Math.min({SPOT_X_RANGE[1]},x));'
            f'y=Math.max({SPOT_Y_RANGE[0]},Math.min({SPOT_Y_RANGE[1]},y));P("{el}",{{left:x+"px",top:y+"px"}});}})()')


def slot_box(r: Rect) -> tuple[int, int, int, int]:
    """The anchor's own rectangle, at least SLOT_MIN_H tall, centred on it."""
    x, y, w, h = r
    hh = max(h, SLOT_MIN_H)
    return int(x), int(y + h / 2 - hh / 2), int(w), int(hh)


def slot_js(el: str) -> str:
    return (f'(()=>{{const h=Math.max(r.h,{SLOT_MIN_H}),y=r.y+r.h/2-h/2;'
            f'P("{el}",{{left:r.x+"px",top:y+"px",width:r.w+"px",height:h+"px"}});}})()')


def luma_filter(luma: float | None) -> str:
    """CSS filter that lifts a dark spotlight/slot clip; empty when it is bright enough."""
    if luma is None or luma >= DARK_LUMA:
        return ""
    return f"filter:brightness({min(LUMA_MAX_GAIN, LUMA_TARGET / max(luma, 0.05)):.2f}) contrast(1.06)"


def cut_side(side: str | None, anchor: Rect | None) -> str:
    """Which edge the cutout stands at: the given side, else away from the anchor, else right."""
    if side in ("left", "right"):
        return side
    if anchor is not None and anchor[0] + anchor[2] / 2 > FRAME_W / 2:
        return "left"
    return "right"


def cut_x(side: str, width: float) -> int:
    return CUT_EDGE if side == "left" else int(FRAME_W - CUT_EDGE - width)


def ghost_style(side: str | None) -> str:
    """Edge position and fade mask: the face sits on `side` and fades towards the centre."""
    if side == "left":
        return f"left:0;-webkit-mask-image:linear-gradient(270deg,transparent,#000 {GHOST_MASK_STOP});mask-image:linear-gradient(270deg,transparent,#000 {GHOST_MASK_STOP})"
    return f"right:0;-webkit-mask-image:linear-gradient(90deg,transparent,#000 {GHOST_MASK_STOP});mask-image:linear-gradient(90deg,transparent,#000 {GHOST_MASK_STOP})"


def motion(mode: str, dur: float) -> list[tuple[str, dict, dict | None, float, float, str]]:
    if mode == "cutout":
        return [("set", {"opacity": 1}, None, 0.0, 0.0, ""),
                ("fromTo", {"y": 160}, {"y": 0}, 0.0, 0.18, "power3.out"),
                ("set", {"opacity": 0}, None, dur, 0.0, "")]
    if mode == "spotlight":
        return [("fromTo", {"scale": 0.2, "opacity": 0}, {"scale": 1, "opacity": 1}, 0.0, 0.16, "back.out(2)"),
                ("to", {"scale": 0.2, "opacity": 0}, None, dur - 0.12, 0.12, "power2.in")]
    if mode == "slot":
        return [("set", {"opacity": 1}, None, 0.0, 0.0, ""),
                ("set", {"opacity": 0}, None, dur, 0.0, "")]
    if mode == "ghost":
        return [("fromTo", {"opacity": 0}, {"opacity": GHOST_OPACITY}, 0.0, 0.3, "power1.out"),
                ("to", {"opacity": 0}, None, dur - 0.25, 0.25, "")]
    raise ValueError(f"{mode}: fullscreen is drawn by the film's own window or full-frame clip, not an overlay")


def base_css() -> str:
    """Mechanics shared by every film; a film adds its own outline and shadow on .ovl-cut / .ovl-slot."""
    return (f".ovl-spot{{position:absolute;width:{SPOT_D}px;height:{SPOT_D}px;-webkit-mask-image:{SPOT_MASK};mask-image:{SPOT_MASK};overflow:hidden;opacity:0}}\n"
            ".ovl-spot video,.ovl-spot img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}\n"
            f".ovl-cut{{position:absolute;height:{CUT_HEIGHT}px;opacity:0}}\n"
            ".ovl-slot{position:absolute;overflow:hidden;opacity:0}\n"
            ".ovl-slot video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}\n"
            f".ovl-ghost{{position:absolute;top:0;width:{GHOST_W}px;height:{FRAME_H}px;opacity:0}}\n"
            ".ovl-ghost video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}\n")
