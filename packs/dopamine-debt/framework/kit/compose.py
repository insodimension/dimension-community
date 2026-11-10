"""timeline.json -> the HyperFrames page (build/film/index.html) and the layout record G11 reads (build/layout.json).

The page is one GSAP timeline on the Motion pack's kit (K). Before `desk_until` the film plays on the cold open's fake
desktop: pictures open as windows. After it, a page is a receipt card cropped around its yellow highlight, a photo fills
the frame, a post pops in, scenes come from `kit.scenes`, memes play in the overlay modes of `framework/overlays.py`.
The film's own CSS (build/film.css) styles the classes drawn here (README.md, Page classes)."""
from __future__ import annotations

import functools
import json
import subprocess
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
from PIL import Image

from framework import overlays as ov
from framework.tools import HIDDEN

from . import scenes
from .art import Art, esc
from .film import Film

TITLE_COLORS = ["#e8401c", "#2348d8", "#111111", "#0f8a5f", "#8a2be2"]
STICKER_SPOTS = [(960, 760, -4), (960, 210, 3), (700, 770, 2), (1220, 230, -3), (960, 820, -2), (1180, 760, 4)]
DOC_TITLES = ["evidence.png", "receipts.png", "proof_final_FINAL.png", "screenshot (3).png", "read_this.png", "source.png"]
MEME_TITLES = ["reaction.mp4", "me_irl.mp4", "mood.mp4", "live_footage.mp4"]
DOC_BOX = (190, 80, 1540, 850)
STOCK_BOX = (150, 70, 1620, 870)
POST_MAX_W, POST_MAX_H = 1320, 840
SAFE_X, SAFE_Y = 192, 108
HIGHLIGHT_RGB = (255, 225, 77)
HIGHLIGHT_INK_LUMA = 110
HIGHLIGHT_LINE_GAP, HIGHLIGHT_MIN_INK = 2, 8
HIGHLIGHT_RUN = 6
HIGHLIGHT_MAIN = 0.6
CAP_PER_INK = 0.66
READ_PUSH = 1.04
READ_LINE_PAD, READ_CONTEXT_LINES = 28, 2
READ_BLOCK_GAP = 1.5
RING_PAD_X, RING_PAD_Y, RING_STROKE, RING_CLEAR, RING_REACH = 14, 10, 8, 3, 120
TASKBAR_H = 62
RECEIPT_CROP_H = 700
RECEIPT_MIN_W, RECEIPT_PAD = 1000, 40
RECEIPT_BOX = (200, 170, 1520, 790)
RECEIPT_BOX_BESIDE = (200, 170, ov.SPOT_X_RANGE[1] - 40 - 200, 790)
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
SOURCE_LABEL_SECONDS = 2.0
CREDIT_H = 58
CREDIT_AT = (200, 1080 - 120 - CREDIT_H)
STICKER_FONT_PX = 76
STICKER_CHAR_EM = 0.72
STICKER_PAD_PX = 80
STICKER_MARGIN_PX = SAFE_X + 1
STICKER_MAX_W = 1920 - 2 * SAFE_X - STICKER_PAD_PX
DEFAULT_POSE = "stand"
PICTURE_KINDS = {"doc": "receipt", "stock": "photo", "post": "post", "mg": "scene", "clip": "clip", "cutout": "cutout", "tag": "tag"}
INK_CONTRAST, INK_BLUR_RADIUS = 40, 7
INK_RULE_RUN, TEXT_LINE_GAP, TEXT_LINE_MIN = 48, 2, 6
WORD_GAP_EM = 0.3


def _box_blur(a: np.ndarray, r: int) -> np.ndarray:
    p = np.pad(a, r, mode="edge")
    c = np.pad(p.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    n = 2 * r + 1
    return (c[n:, n:] - c[:-n, n:] - c[n:, :-n] + c[:-n, :-n]) / (n * n)


def _yellow(px: np.ndarray) -> np.ndarray:
    r, g, b = HIGHLIGHT_RGB
    return (abs(px[..., 0] - r) < 26) & (abs(px[..., 1] - g) < 30) & (abs(px[..., 2] - b) < 46)


def _ink(luma: np.ndarray) -> np.ndarray:
    return np.abs(luma - _box_blur(luma, INK_BLUR_RADIUS)) > INK_CONTRAST


@functools.lru_cache(maxsize=64)
def _text_lines(path: str, size: int, mtime_ns: int) -> tuple[tuple[int, int, int, int], ...]:
    ink = _ink(np.asarray(Image.open(path).convert("L")).astype(np.float32))
    cols = np.pad(ink.T.astype(np.int8), ((0, 0), (1, 1)))
    edges = np.diff(cols, axis=1)
    for x in np.nonzero(ink.sum(axis=0) >= INK_RULE_RUN)[0]:
        for a, b in zip(np.nonzero(edges[x] == 1)[0], np.nonzero(edges[x] == -1)[0]):
            if b - a >= INK_RULE_RUN:
                ink[a:b, x] = False
    rows = ink.sum(axis=1) >= 2
    lines, y, h0 = [], 0, len(rows)
    while y < h0:
        if not rows[y]:
            y += 1
            continue
        y0 = last = y
        while y < h0 and y - last <= TEXT_LINE_GAP:
            last = y if rows[y] else last
            y += 1
        if last - y0 + 1 >= TEXT_LINE_MIN:
            xs = np.nonzero(ink[y0:last + 1].any(axis=0))[0]
            lines.append((int(xs[0]), y0, int(xs[-1] - xs[0] + 1), last - y0 + 1))
    return tuple(lines)


def text_lines(path: str | Path) -> tuple[tuple[int, int, int, int], ...]:
    """Every line of text on a captured page, top to bottom, as (x, y, w, h) in capture pixels: runs of rows holding
    ink (pixels that stand INK_CONTRAST off their local background, on light and dark pages alike), with vertical rules
    and borders taken out so they never join two lines. A line that touches the capture's edge was cut by the capture."""
    st = Path(path).stat()
    return _text_lines(str(path), st.st_size, st.st_mtime_ns)


@functools.lru_cache(maxsize=16)
def _unlit_ink(path: str, size: int, mtime_ns: int) -> np.ndarray:
    px = np.asarray(Image.open(path).convert("RGB")).astype(int)
    luma = np.asarray(Image.open(path).convert("L"))
    lit = np.pad(_yellow(px), 1)
    lit = lit[1:-1, 1:-1] | lit[:-2, 1:-1] | lit[2:, 1:-1] | lit[1:-1, :-2] | lit[1:-1, 2:]
    ground = np.bincount(luma[~lit].ravel(), minlength=256).argmax() if (~lit).any() else 255
    return _ink(np.where(lit, ground, luma).astype(np.float32))


def unlit_ink(path: str | Path) -> np.ndarray:
    """The page's ink (as `text_lines` sees it) with the yellow highlight painted out to the page's ground (its
    commonest shade): the glyphs beside and under a highlight stay, the highlight's own edge does not (on a dark page it
    stands out as ink)."""
    st = Path(path).stat()
    return _unlit_ink(str(path), st.st_size, st.st_mtime_ns)


def text_words(path: str | Path) -> tuple[tuple[int, int, int, int, int], ...]:
    """Every word of text on a captured page as (x, y, w, h, line) in capture pixels, its glyphs' own box and the index
    of its `text_lines` line: each line split where its ink (`unlit_ink`, so a highlight's own edge is no word) leaves
    a gap wider than WORD_GAP_EM of the line's height."""
    ink, out = unlit_ink(path), []
    for n, (x, y, w, h) in enumerate(text_lines(path)):
        line = ink[y:y + h, x:x + w]
        cols = np.nonzero(line.any(axis=0))[0]
        if not cols.size:
            continue
        cuts = np.nonzero(np.diff(cols) > WORD_GAP_EM * h)[0]
        for a, b in zip(np.r_[0, cuts + 1], np.r_[cuts, cols.size - 1]):
            rows = np.nonzero(line[:, cols[a]:cols[b] + 1].any(axis=1))[0]
            out.append((x + int(cols[a]), y + int(rows[0]), int(cols[b] - cols[a] + 1), int(rows[-1] - rows[0] + 1), n))
    return tuple(out)


def _free_edge(occupied: np.ndarray, edge: float, content: float, sw: float, clear: float, side: int, reach: float) -> float:
    """Where a ring's stroke (`sw` wide, outer edge at `edge`) keeps `clear` off every word on one side of `content`
    (`side` -1: the stroke lies before it, +1: after it), given the words' occupancy along that axis: the ideal place,
    else as near the content as a clear stroke fits, else out past the words in the way (within `reach`); the ideal
    place if none is clear."""
    n = len(occupied)

    def free(e: float) -> bool:
        a, b = (e, e + sw) if side < 0 else (e - sw, e)
        return 0 <= a and b <= n and not occupied[max(0, int(a - clear)):int(np.ceil(b + clear))].any()

    near = np.arange(edge, content - (sw + clear) * (1 if side < 0 else -1), -side)
    far = np.arange(edge + side, edge + side * reach, side)
    return next((float(e) for e in (*near, *far) if free(e)), edge)


def clip_attrs(eid: str, start: float, end: float, z: int) -> str:
    return f'id="{eid}" class="clip" data-start="{start:.3f}" data-duration="{max(0.05, end - start):.3f}" data-track-index="{z}" style="z-index:{z}"'


class Captures:
    """A film's captured pages (`media/captures/<id>.png` + `<id>.asset.json`) and where they land in the frame."""

    def __init__(self, film: Film, bands: dict[str, tuple[float, float]] | None = None):
        self.folder = film.media / "captures"
        self.read_px = film.receipt_read_px
        self.bands = bands or {}

    def capture_to_frame(self, capture_id: str, rect: tuple[float, float, float, float], desk: bool, beside: bool = False) -> ov.Rect:
        """Map a rectangle in capture pixels to frame pixels, as the capture is drawn: in the cold open's DOC window
        (object-fit: contain) or, after it, on a receipt card cropped around the capture's highlight (narrower when a
        spotlight sits `beside` it)."""
        rx, ry, rw, rh = rect
        if not desk:
            g = self.receipt_geometry(capture_id, beside)
            return (g["x"] + (rx - g["cx"]) * g["s"], g["y"] + (ry - g["cy"]) * g["s"], rw * g["s"], rh * g["s"])
        w0, h0 = Image.open(self.folder / f"{capture_id}.png").size
        x, y, w, h = DOC_BOX
        bx, by, bw, bh = x + 3, y + 43, w - 6, h - 46
        scale = min(bw / w0, bh / h0)
        ox, oy = bx + (bw - w0 * scale) / 2, by + (bh - h0 * scale) / 2
        return (ox + rx * scale, oy + ry * scale, rw * scale, rh * scale)

    def highlight_raw(self, capture_id: str) -> tuple[float, float, float, float] | None:
        """Capture-pixel rectangle of the capture's yellow highlight, or None if it has none. With
        `Film.receipt_read_px` it holds every row and column with more than HIGHLIGHT_RUN highlight pixels, so a thin
        last line or one long line counts whole and a stray tinted pixel does not; without it it spans the
        1st to 99th percentile of the highlight pixels, which can leave a thin last line or a long line's end outside."""
        mask = _yellow(np.asarray(Image.open(self.folder / f"{capture_id}.png").convert("RGB")).astype(int))
        if not self.read_px:
            if not mask.any():
                return None
            ys, xs = np.nonzero(mask)
            x0, x1 = np.percentile(xs, 1), np.percentile(xs, 99)
            y0, y1 = np.percentile(ys, 1), np.percentile(ys, 99)
            return (float(x0), float(y0), float(x1 - x0), float(y1 - y0))
        rows, cols = np.nonzero(mask.sum(axis=1) > HIGHLIGHT_RUN)[0], np.nonzero(mask.sum(axis=0) > HIGHLIGHT_RUN)[0]
        if not rows.size or not cols.size:
            return None
        return (float(cols[0]), float(rows[0]), float(cols[-1] + 1 - cols[0]), float(rows[-1] + 1 - rows[0]))

    def highlight_rect(self, capture_id: str, desk: bool, beside: bool = False) -> ov.Rect | None:
        """Frame rectangle of the capture's yellow highlight as drawn, or None if it has none."""
        raw = self.highlight_raw(capture_id)
        return None if raw is None else self.capture_to_frame(capture_id, raw, desk, beside)

    def highlight_lines(self, capture_id: str) -> list[tuple[float, float, float, float]]:
        """The highlighted text lines of a capture, top to bottom, as (x, y, w, h) in capture pixels: each line's
        yellow span across, and the dark ink inside it (ascender to descender) down. Empty without a highlight."""
        px = np.asarray(Image.open(self.folder / f"{capture_id}.png").convert("RGB")).astype(int)
        mask = _yellow(px)
        dark = px.mean(axis=2) < HIGHLIGHT_INK_LUMA
        inked = np.zeros(len(mask), dtype=bool)
        spans: dict[int, tuple[int, int]] = {}
        for y in np.nonzero(mask.sum(axis=1) > HIGHLIGHT_RUN)[0]:
            xs = np.nonzero(mask[y])[0]
            spans[int(y)] = (int(xs[0]), int(xs[-1]))
            inked[y] = dark[y, xs[0]:xs[-1] + 1].sum() > 2
        lines, y = [], 0
        while y < len(inked):
            if not inked[y]:
                y += 1
                continue
            y0, last = y, y
            while y < len(inked) and y - last <= HIGHLIGHT_LINE_GAP:
                last = y if inked[y] else last
                y += 1
            if last - y0 + 1 >= HIGHLIGHT_MIN_INK:
                band = [spans[k] for k in range(y0, last + 1) if k in spans]
                x0, x1 = min(a for a, _ in band), max(b for _, b in band)
                lines.append((float(x0), float(y0), float(x1 - x0), float(last - y0 + 1)))
        return lines

    def highlight_cap(self, capture_id: str) -> float | None:
        """Capital-letter height (capture pixels) of the highlighted words: the ink of its main lines (those at least
        HIGHLIGHT_MAIN of the tallest, so a headline's byline does not count) times CAP_PER_INK."""
        inks = [ln[3] for ln in self.highlight_lines(capture_id)]
        if not inks:
            return None
        main = sorted(i for i in inks if i >= HIGHLIGHT_MAIN * max(inks))
        return main[len(main) // 2] * CAP_PER_INK

    def receipt_geometry(self, capture_id: str, beside: bool = False) -> dict:
        """Crop of a capture around its highlight, scaled up onto a receipt card: the words being read fill the frame.
        Vertically the crop centres the highlight; horizontally it spans the page's text column in that band (the inked
        columns), so a headline or a line is never cut off at the side. With `Film.receipt_read_px` the crop is
        `read_geometry`."""
        if self.read_px:
            return self.read_geometry(capture_id, beside)
        img = Image.open(self.folder / f"{capture_id}.png").convert("L")
        w0, h0 = img.size
        hl = self.highlight_raw(capture_id) or (w0 / 2, h0 / 2, 0, 0)
        ch = min(h0, RECEIPT_CROP_H)
        cy = min(max(0, hl[1] + hl[3] / 2 - ch * 0.45), h0 - ch)
        band = np.asarray(img.crop((0, int(cy), w0, int(cy + ch))))
        inked = np.nonzero((band < 140).sum(axis=0) > 2)[0]
        x0, x1 = (float(inked[0]), float(inked[-1])) if inked.size else (0.0, float(w0))
        x0, x1 = min(x0, hl[0]) - RECEIPT_PAD, max(x1, hl[0] + hl[2]) + RECEIPT_PAD
        cw = min(w0, max(RECEIPT_MIN_W, x1 - x0))
        cx = min(max(0, (x0 + x1) / 2 - cw / 2), w0 - cw)
        bx, by, bw, bh = RECEIPT_BOX_BESIDE if beside else RECEIPT_BOX
        s = min(bw / cw, bh / ch)
        x, y = bx + (bw - cw * s) / 2, by + (bh - ch * s) / 2
        return {"w0": w0, "h0": h0, "cx": cx, "cy": cy, "cw": cw, "ch": ch, "s": s, "x": x, "y": y}

    def read_geometry(self, capture_id: str, beside: bool = False) -> dict:
        """The reading crop (`Film.receipt_read_px`): whole text lines only (`text_lines`), from the highlighted ones out
        to at most READ_CONTEXT_LINES of context on each side while the card still shows the highlight at the reading
        size and the context stays in the highlight's own block (a gap between two lines wider than READ_BLOCK_GAP of
        the taller one's height ends a block: a heading, a panel or a section beyond it is not context), every line
        whole across, edges in the gaps between lines and never on a line the capture itself cut. A DOC picture's
        `read` band (`bands`: [top, bottom] in capture pixels, a sentence or two) replaces the search: the crop holds
        exactly the whole lines whose middles lie in it. The card scales the crop up to where the highlight's capitals
        stand `read_px` tall, or as far as the card box allows. `mx`/`my` are the capture pixels free of ink inside the
        crop's sides and ends (what `read_camera` may push past)."""
        path = self.folder / f"{capture_id}.png"
        w0, h0 = Image.open(path).size
        lines = text_lines(path)
        whole = {i for i, (x, y, w, h) in enumerate(lines) if x > 0 and y > 0 and x + w < w0 and y + h < h0}
        hl = self.highlight_raw(capture_id) or (w0 / 2, h0 / 2, 0, 0)
        cap = self.highlight_cap(capture_id)
        bx, by, bw, bh = RECEIPT_BOX_BESIDE if beside else RECEIPT_BOX
        s_read = self.read_px / cap if cap else bw / w0

        def crop(a: int, b: int) -> dict:
            sel = lines[a:b + 1]
            above = lines[a - 1][1] + lines[a - 1][3] if a > 0 else 0
            below = lines[b + 1][1] if b + 1 < len(lines) else h0
            top, bottom = sel[0][1], sel[-1][1] + sel[-1][3]
            x0, x1 = min(ln[0] for ln in sel), max(ln[0] + ln[2] for ln in sel)
            mx0, mx1 = min(RECEIPT_PAD, x0), min(RECEIPT_PAD, w0 - x1)
            my0, my1 = min(READ_LINE_PAD, (top - above) / 2), min(READ_LINE_PAD, (below - bottom) / 2)
            cw, ch = x1 + mx1 - (x0 - mx0), bottom + my1 - (top - my0)
            return {"cx": x0 - mx0, "cy": top - my0, "cw": cw, "ch": ch, "s": min(bw / cw, bh / ch, s_read),
                    "mx": min(mx0, mx1), "my": min(my0, my1)}

        def same_block_as_next(i: int) -> bool:
            (_, y0, _, h0_), (_, y1, _, h1) = lines[i], lines[i + 1]
            return y1 - (y0 + h0_) <= READ_BLOCK_GAP * max(h0_, h1)

        band = self.bands.get(capture_id)
        if band:
            sel = [i for i in range(len(lines)) if band[0] <= lines[i][1] + lines[i][3] / 2 <= band[1]]
            if not sel or any(i not in whole for i in sel) or sel != list(range(sel[0], sel[-1] + 1)):
                raise ValueError(f"DOC {capture_id}: read band {band} holds no run of whole text lines")
            g = crop(sel[0], sel[-1])
        else:
            core = [i for i in sorted(whole) if lines[i][1] < hl[1] + hl[3] and lines[i][1] + lines[i][3] > hl[1]]
            core = core or [min(whole, key=lambda i: abs(lines[i][1] + lines[i][3] / 2 - hl[1] - hl[3] / 2))]
            a, b = core[0], core[-1]
            g = crop(a, b)
            for step in range(2 * READ_CONTEXT_LINES):
                na, nb = (a, b + 1) if step % 2 == 0 else (a - 1, b)
                if na not in whole or nb not in whole or not same_block_as_next(b if nb > b else na):
                    continue
                wider = crop(na, nb)
                if wider["s"] < g["s"] - 1e-6:
                    continue
                a, b, g = na, nb, wider
        x, y = bx + (bw - g["cw"] * g["s"]) / 2, by + (bh - g["ch"] * g["s"]) / 2
        return {"w0": w0, "h0": h0, **g, "x": x, "y": y}

    def ring_box(self, capture_id: str, s: float) -> tuple[float, float, float, float]:
        """Capture-pixel (left, top, right, bottom) of the outer edge of the ring a reading card (`Film.receipt_read_px`)
        draws round the highlight at scale `s`: RING_STROKE frame pixels wide, RING_PAD_X/Y off the highlight, each
        stroke kept RING_CLEAR off every word of the page (`text_words`, the boxes G11 no-clipped-text checks the ring
        against): nearer, as far as the highlighted glyphs themselves (the dark ink with highlight on both sides of it
        along its row; the stroke may cross the highlight's own yellow margin), where a clear stroke fits, else out past
        the words in its way (a bracket or a word touching the highlight is taken inside), within RING_REACH."""
        x, y, w, h = self.highlight_raw(capture_id)
        px_ = np.asarray(Image.open(self.folder / f"{capture_id}.png").convert("RGB")).astype(int)
        lit, dark = _yellow(px_), px_.mean(axis=2) < HIGHLIGHT_INK_LUMA
        glyphs = []
        for lx, ly, lw, lh in self.highlight_lines(capture_id):
            band = lit[int(ly):int(ly + lh)]
            inside = np.maximum.accumulate(band, axis=1) & np.maximum.accumulate(band[:, ::-1], axis=1)[:, ::-1]
            cols = np.nonzero((dark[int(ly):int(ly + lh)] & inside).any(axis=0))[0]
            if cols.size:
                glyphs.append((float(cols[0]), ly, float(cols[-1] + 1), ly + lh))
        gx0, gy0, gx1, gy1 = ((min(gl[0] for gl in glyphs), min(gl[1] for gl in glyphs), max(gl[2] for gl in glyphs), max(gl[3] for gl in glyphs))
                              if glyphs else (x, y, x + w, y + h))
        sw, px, py, clear = RING_STROKE / s, RING_PAD_X / s, RING_PAD_Y / s, RING_CLEAR / s
        left, top, right, bottom = x - px, y - py, x + w + px, y + h + py
        words, reach = text_words(self.folder / f"{capture_id}.png"), RING_REACH / s
        h0, w0 = dark.shape
        for _ in range(2):
            cols, rows = np.zeros(w0, dtype=bool), np.zeros(h0, dtype=bool)
            for wx, wy, ww, wh, _n in words:
                if wy < bottom and wy + wh > top:
                    cols[wx:wx + ww] = True
            left = _free_edge(cols, x - px, gx0, sw, clear, -1, reach)
            right = _free_edge(cols, x + w + px, gx1, sw, clear, 1, reach)
            for wx, wy, ww, wh, _n in words:
                if wx < right and wx + ww > left:
                    rows[wy:wy + wh] = True
            top = _free_edge(rows, y - py, gy0, sw, clear, -1, reach)
            bottom = _free_edge(rows, y + h + py, gy1, sw, clear, 1, reach)
        return left, top, right, bottom

    def receipt_chip(self, capture_id: str) -> str:
        """'site · captured Nov 3, 2026' from the capture's record: the source line a receipt keeps while it is on screen.
        An archived page names the site it archived, not the archive."""
        rec = json.loads((self.folder / f"{capture_id}.asset.json").read_text(encoding="utf-8"))
        url = rec.get("originalUrl") or rec["sourceUrl"]
        if "web.archive.org/web/" in url:
            url = "http" + url.split("/http", 1)[1]
        host = (urlparse(url).hostname or "").removeprefix("www.")
        y, m, d = rec["capturedAt"][:10].split("-")
        return f"{host} · captured {MONTHS[int(m) - 1]} {int(d)}, {y}"


def gsap_rows(sel: str, rows: list, start: float) -> list[str]:
    """GSAP calls for overlay motion rows (framework/overlays.motion) starting at `start`."""
    out = []
    for method, a, b, off, dur, ease in rows:
        at = start + off
        if method == "set":
            out.append(f'tl.set("{sel}",{json.dumps(a)},{at:.3f});')
            continue
        tail = {"duration": dur, **({"ease": ease} if ease else {})}
        if method == "fromTo":
            out.append(f'tl.fromTo("{sel}",{json.dumps(a)},{json.dumps({**b, **tail})},{at:.3f});')
        else:
            out.append(f'tl.to("{sel}",{json.dumps({**a, **tail})},{at:.3f});')
    return out


def post_box(path: str) -> tuple[int, int, int, int]:
    w, h = Image.open(path).size
    scale = min(POST_MAX_W / w, (POST_MAX_H - 46) / h)
    bw, bh = int(w * scale) + 6, int(h * scale) + 46
    return (960 - bw // 2, max(SAFE_Y - 20, 540 - bh // 2), bw, bh)


def overlay_box(caps: Captures, it: dict, desk: bool) -> tuple[int, int, int, int]:
    """Frame box of a cutout, spotlight or slot meme: where it is drawn, and what stickers must stay off. On the desk a
    spotlight sits on its anchor's corner; on a receipt, in the column the receipt leaves free."""
    mode = it["mode"]
    floor = TASKBAR_H if desk else 0
    if mode == "cutout":
        w = int(ov.CUT_HEIGHT * it["w"] / it["h"])
        return ov.cut_x(ov.cut_side(it.get("side"), None), w), ov.FRAME_H - floor - ov.CUT_HEIGHT, w, ov.CUT_HEIGHT
    if mode == "spotlight":
        return ov.spot_box(caps.highlight_rect(it["on"], True)) if desk else ov.spot_beside(caps.highlight_rect(it["on"], False, beside=True))
    if mode == "slot":
        rect = caps.capture_to_frame(it["on"], it["box"], desk) if it.get("box") else caps.highlight_rect(it["on"], desk)
        if rect is None:
            raise ValueError(f"slot meme on {it['on']}: no box given and the capture has no highlight to fill")
        return ov.slot_box(rect)
    return 0, 0, 0, 0


def centre_luma(path: str, t0: float, t1: float) -> float:
    """Mean luma (0-1) of the middle third of the frame over the clip window, the part a round inset shows."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t0:.3f}", "-to", f"{t1:.3f}", "-i", path, "-vf", "fps=4,crop=iw/3:ih/3,scale=64:36,format=gray",
                          "-f", "rawvideo", "-"], capture_output=True, creationflags=HIDDEN).stdout
    px = np.frombuffer(raw, dtype=np.uint8)
    return float(px.mean() / 255) if px.size else 1.0


def letterbox_inset(pic: dict | list, w: int, h: int) -> tuple[float, float, float, float]:
    """(top, right, bottom, left) fractions of the source frame outside its picture. `pic` is the media library's
    `{x, y, w, h}` in fractions of the frame, or a film MEME row's `[x, y, w, h]` in source pixels of a `w` x `h` clip."""
    if isinstance(pic, dict):
        return pic["y"], 1 - (pic["x"] + pic["w"]), 1 - (pic["y"] + pic["h"]), pic["x"]
    x, y, pw, ph = pic
    return y / h, 1 - (x + pw) / w, 1 - (y + ph) / h, x / w


def picture_on_frame(pic: dict | list, w: int, h: int, fill: bool) -> tuple[float, float, float, float]:
    """Where a full-frame clip's video element sits, (left, top, width, height) in frame pixels. Without `fill` it is the
    frame (object-fit: cover); with `fill` the source is scaled so its picture (`letterbox_inset`) covers the frame,
    centred on the picture, and the bars and anything in them fall outside."""
    if not fill:
        return 0.0, 0.0, 1920.0, 1080.0
    top, right, bottom, left = letterbox_inset(pic, w, h)
    pw, ph = (1 - left - right) * w, (1 - top - bottom) * h
    k = max(1920 / pw, 1080 / ph)
    return 960 - k * (left * w + pw / 2), 540 - k * (top * h + ph / 2), w * k, h * k


def bars_clip(pic: dict | list, w: int, h: int) -> tuple[float, float, float, float]:
    """(top, right, bottom, left) fractions of the 1920 x 1080 element outside the picture, as the frame shows the
    source (object-fit: cover crops a source that is not 16:9 before any bar is clipped)."""
    top, right, bottom, left = letterbox_inset(pic, w, h)
    k = max(1920 / w, 1080 / h)
    ox, oy = (1920 - w * k) / 2, (1080 - h * k) / 2
    return (max(0.0, (oy + top * h * k) / 1080), max(0.0, (1920 - ox - (1 - right) * w * k) / 1920),
            max(0.0, (1080 - oy - (1 - bottom) * h * k) / 1080), max(0.0, (ox + left * w * k) / 1920))


def _overlaps(a: tuple, b: tuple) -> bool:
    return a[0] < b[0] + b[2] and b[0] < a[0] + a[2] and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]


def window(eid: str, start: float, end: float, z: int, title: str, color: str, inner: str, box: tuple[int, int, int, int]) -> str:
    """A desktop window: a coloured title bar with `title`, and `inner` in its body."""
    x, y, w, h = box
    return (f'<div {clip_attrs(eid, start, end, z)}><div class="win" id="{eid}-w" style="left:{x}px;top:{y}px;width:{w}px;height:{h}px">'
            f'<div class="bar" style="background:{color}"><span class="t">{esc(title)}</span><span class="dots"><i></i><i></i><i>×</i></span></div>'
            f'<div class="body">{inner}</div></div></div>')


def read_camera(eid: str, g: dict, w: float, h: float, s: float, e: float) -> list[str]:
    """The receipt reading its highlight (`Film.receipt_read_px`): the card already frames whole lines at the reading
    size (`Captures.read_geometry`), so the camera inside it (`#{eid}-cm`) only pushes gently toward the card's centre,
    at most READ_PUSH and never so far that a side or an end of the view reaches a line (`mx`/`my`; `receipt` narrows
    them so the highlight ring keeps its pad inside the card)."""
    room = min(g["cw"] / max(1e-6, g["cw"] - 2 * g["mx"]), g["ch"] / max(1e-6, g["ch"] - 2 * g["my"]))
    z = min(READ_PUSH, room)
    if z <= 1.001:
        return []
    t0 = s + min(0.7, 0.28 * (e - s))
    return [f'tl.fromTo("#{eid}-cm",{{x:0,y:0,scale:1}},{{x:{w / 2 * (1 - z):.1f},y:{h / 2 * (1 - z):.1f},scale:{z:.4f},duration:{max(0.3, e - t0):.3f},ease:"sine.inOut"}},{t0:.3f});']


def receipt(art: Art, caps: Captures, eid: str, it: dict, s: float, e: float, label: bool, beside: bool,
            read_px: float | None = None) -> tuple[str, list[str], tuple]:
    """A captured page after the cold open: a paper card cropped around its highlight, a ring drawn on the highlighted
    words, a slow push toward them (or, with `read_px`, whole lines at the reading size and the camera's bounded push:
    `Captures.read_geometry`, `read_camera`), and (on its site's first appearance) a source chip for
    SOURCE_LABEL_SECONDS."""
    g = caps.receipt_geometry(it["id"], beside)
    hl = caps.highlight_raw(it["id"])
    w, h = g["cw"] * g["s"], g["ch"] * g["s"]
    img = (f'<img src="{art.asset(it["file"])}" style="position:absolute;left:{-g["cx"] * g["s"]:.0f}px;top:{-g["cy"] * g["s"]:.0f}px;'
           f'width:{g["w0"] * g["s"]:.0f}px;height:{g["h0"] * g["s"]:.0f}px">')
    ring, js = "", [f'tl.fromTo("#{eid}-r",{{y:50,scale:1.04,rotation:-1.2}},{{y:0,scale:1,rotation:0,duration:0.2,ease:"power3.out"}},{s:.3f});']
    origin = "50% 50%"
    room = g
    if hl:
        if read_px:
            left, top, right, bottom = caps.ring_box(it["id"], g["s"])
            rx, ry, rw, rh = (left - g["cx"]) * g["s"], (top - g["cy"]) * g["s"], (right - left) * g["s"], (bottom - top) * g["s"]
            room = {**g, "mx": max(0.0, min(g["mx"], left - g["cx"] - RING_PAD_X / g["s"], g["cx"] + g["cw"] - right - RING_PAD_X / g["s"])),
                    "my": max(0.0, min(g["my"], top - g["cy"] - RING_PAD_Y / g["s"], g["cy"] + g["ch"] - bottom - RING_PAD_Y / g["s"]))}
        else:
            rx, ry = (hl[0] - g["cx"]) * g["s"] - 14, (hl[1] - g["cy"]) * g["s"] - 10
            rw, rh = hl[2] * g["s"] + 28, hl[3] * g["s"] + 20
        perim = 2 * (rw + rh)
        ring = (f'<svg class="rcpt-ring" style="left:{rx:.0f}px;top:{ry:.0f}px" width="{rw:.0f}" height="{rh:.0f}"><rect x="4" y="4" width="{rw - 8:.0f}" height="{rh - 8:.0f}" rx="18" '
                f'id="{eid}-ring" style="stroke-dasharray:{perim:.0f};stroke-dashoffset:{perim:.0f}"/></svg>')
        js.append(f'tl.to("#{eid}-ring",{{strokeDashoffset:0,duration:0.35,ease:"power2.out"}},{s + 0.35:.3f});')
        origin = f"{100 * (rx + rw / 2) / w:.0f}% {100 * (ry + rh / 2) / h:.0f}%"
    if read_px:
        moves = read_camera(eid, room, w, h, s, e)
        js += moves
        if moves:
            img, ring = f'<div id="{eid}-cm" style="position:absolute;left:0;top:0;width:{w:.0f}px;height:{h:.0f}px;transform-origin:0 0">{img}{ring}</div>', ""
    else:
        js.append(f'K.push("#{eid}-r",{s + 0.2:.3f},{max(s + 0.3, e):.3f},{{from:1,to:1.07,fx:{float(origin.split("%")[0]) / 100:.2f},fy:{float(origin.split()[1][:-1]) / 100:.2f}}});')
    chip = (f'<div class="rcpt-chip" id="{eid}-ch" style="left:{g["x"]:.0f}px;top:{g["y"] - 52:.0f}px">{esc(caps.receipt_chip(it["id"]))}</div>' if label else "")
    if label:
        js.append(f'tl.to("#{eid}-ch",{{opacity:0,duration:0.2}},{min(e - 0.2, s + SOURCE_LABEL_SECONDS):.3f});')
    html_ = (f'<div {clip_attrs(eid, s, e, 11)}><div class="rcpt" id="{eid}-r" style="left:{g["x"]:.0f}px;top:{g["y"]:.0f}px;width:{w:.0f}px;height:{h:.0f}px">'
             f'{img}{ring}</div>{chip}</div>')
    return html_, js, (g["x"], g["y"] - 52, w, h + 52)


def picture_record(items: list[dict], desk_until: float, reveals: list[float]) -> dict:
    """What fills the frame and when the picture changes. A sticker is not a change (show-dont-tell); an overlay meme
    or a scene reveal is; a cutout continuing in the same pose straight into the next line is not."""
    pictures, changes = [], [(t, "reveal") for t in reveals]
    last_cut: tuple[str, float] | None = None
    for it in sorted(items, key=lambda i: i["start"]):
        k, s, e = it["kind"], it["start"], it["end"]
        if k == "meme":
            changes.append((s, f"meme-{it.get('mode') or 'fullscreen'}"))
            if (it.get("mode") or "fullscreen") == "fullscreen":
                pictures.append({"kind": "meme", "start": s, "end": e})
            continue
        if k not in PICTURE_KINDS:
            continue
        kind = ("page" if k == "doc" else PICTURE_KINDS[k]) if s < desk_until and k in ("doc", "stock", "post") else PICTURE_KINDS[k]
        pictures.append({"kind": kind, "start": s, "end": e})
        if k == "cutout":
            if last_cut and last_cut[0] == it["pose"] and abs(last_cut[1] - s) < 0.3:
                last_cut = (it["pose"], e)
                continue
            last_cut = (it["pose"], e)
        changes.append((s, kind))
    return {"pictures": pictures, "changes": sorted(changes)}


def render(film: Film, timeline: dict) -> tuple[dict, str]:
    """The page, and the layout record G11 reads (framework/g11.Plan): boxes of everything important drawn, labels,
    picture changes, what fills the frame, and each scene's first reveal."""
    bands: dict[str, tuple[float, float]] = {}
    for it in timeline["items"]:
        if it["kind"] == "doc" and it.get("read"):
            if bands.setdefault(it["id"], tuple(it["read"])) != tuple(it["read"]):
                raise ValueError(f"DOC {it['id']}: two pictures give it different read bands")
    art, caps = Art(film), Captures(film, bands)
    art.folder.mkdir(parents=True, exist_ok=True)
    art.motion_kit()
    desk_until = timeline["desk_until"]
    els, tweens, drawn = [], [], []
    scene_rows, labels, reveals = [], [], []
    counters = {"doc": 0, "meme": 0, "sticker": 0}
    labelled: set[str] = set()
    anchored_docs = {it["on"] for it in timeline["items"] if it["kind"] == "meme" and it.get("mode") in ("spotlight", "slot")}
    spotlit = [(it["on"], it["start"], it["end"]) for it in timeline["items"] if it["kind"] == "meme" and it.get("mode") == "spotlight" and it["start"] >= desk_until]
    overlays = [(it["start"], it["end"], overlay_box(caps, it, it["start"] < desk_until)) for it in timeline["items"]
                if it["kind"] == "meme" and it.get("mode") in ("spotlight", "slot", "cutout")]
    held = overlays + [(it["start"], it["end"], (0, 0, 1920, 1080)) for it in timeline["items"] if it["kind"] == "mg"]
    scene_spots: list[tuple[float, float, list]] = []
    kept: tuple[str, float, float] | None = None
    for n, it in enumerate(timeline["items"]):
        k, s, e = it["kind"], it["start"], it["end"]
        desk = s < desk_until
        eid = f"e{n}"
        if k in ("doc", "stock", "post") and desk:
            i = counters["doc"]
            counters["doc"] += 1
            title = {"stock": "photo.jpg", "post": "post.png"}.get(k, DOC_TITLES[i % len(DOC_TITLES)])
            fit = "cover" if k == "stock" else "contain"
            inner = f'<img id="{eid}-img" src="{art.asset(it["file"])}" style="width:100%;height:100%;object-fit:{fit};background:#fff">'
            box = STOCK_BOX if k == "stock" else (post_box(it["file"]) if k == "post" else DOC_BOX)
            els.append(window(eid, s, e, 10 + (1 if k == "doc" else 0), title, TITLE_COLORS[i % len(TITLE_COLORS)], inner, box))
            tweens.append(f'tl.fromTo("#{eid}-w",{{scale:0.92,opacity:0}},{{scale:1,opacity:1,duration:0.16,ease:"back.out(2)"}},{s:.3f});')
            if it.get("id") not in anchored_docs:
                tweens.append(f'tl.fromTo("#{eid}-img",{{scale:1}},{{scale:1.05,duration:{max(0.3, e - s):.3f},ease:"none"}},{s:.3f});')
        elif k == "doc":
            site = caps.receipt_chip(it["id"]).split(" · ")[0]
            beside = any(on == it["id"] and a < e and b > s for on, a, b in spotlit)
            h, js, box = receipt(art, caps, eid, it, s, e, site not in labelled, beside, film.receipt_read_px)
            drawn.append(("receipt", s, e, box))
            if site not in labelled:
                labels.append({"kind": "source", "start": s, "end": min(e, s + SOURCE_LABEL_SECONDS)})
            labelled.add(site)
            els.append(h)
            tweens.extend(js)
        elif k == "stock":
            els.append(f'<div {clip_attrs(eid, s, e, 10)}><img id="{eid}-img" class="full" src="{art.asset(it["file"])}"></div>')
            tweens.append(f'tl.fromTo("#{eid}-img",{{scale:1.12}},{{scale:1.0,duration:{max(0.3, e - s):.3f},ease:"none"}},{s:.3f});')
        elif k == "post":
            x, y, w, h = post_box(it["file"])
            els.append(f'<div {clip_attrs(eid, s, e, 12)}><img id="{eid}-p" class="post" src="{art.asset(it["file"])}" style="left:{x}px;top:{y + 20}px;width:{w - 6}px"></div>')
            drawn.append(("post", s, e, (x, y + 20, w - 6, h - 46)))
            tweens.append(f'K.pop("#{eid}-p",{s:.3f},{{f:0.85,r0:-3,r1:0,d:0.2}});')
            tweens.append(f'K.push("#{eid}-p",{s + 0.2:.3f},{max(s + 0.3, e):.3f},{{from:1,to:1.05}});')
        elif k == "mg":
            from_scale = kept[2] if kept and kept[0] == it["mg"]["id"] and abs(kept[1] - s) < 0.05 else None
            h, js, shows, spots = scenes.render(eid, it, s, e, it["words"], art, film.scenes, from_scale)
            kept = (it["mg"]["id"], e, (from_scale or 1.0) + scenes.PUSH - 1)
            scene_spots.append((s, e, spots))
            scene_rows.append({"start": s, "end": e, "first_reveal": shows[0] if shows else e, "line": it["line"]})
            reveals += [t for t in shows if t > s + 0.05]
            els.append(h)
            tweens.extend(js)
        elif k in ("meme", "clip"):
            meme_or_clip(art, caps, it, eid, s, e, k, desk, counters, els, tweens, drawn, labels, labelled)
        elif k == "cutout":
            p = film.poses.get(it["pose"], film.poses[DEFAULT_POSE])
            sx = -1 if p["flip"] else 1
            els.append(f'<div {clip_attrs(eid, s, e, 30)}><img id="{eid}-c" class="cut" src="{art.asset(film.cutout)}" style="left:{p["x"]}px;top:{p["y"]}px;height:{p["h"]}px"></div>')
            slide = p.get("slide", 0)
            if slide:
                tweens.append(f'tl.fromTo("#{eid}-c",{{x:{-slide if slide < 0 else slide},rotation:{p["rot"]},scaleX:{sx}}},{{x:0,rotation:{p["rot"]},scaleX:{sx},duration:0.35,ease:"power3.out"}},{s:.3f});')
            else:
                tweens.append(f'tl.fromTo("#{eid}-c",{{y:600,rotation:{p["rot"]},scaleX:{sx}}},{{y:0,rotation:{p["rot"]},scaleX:{sx},duration:0.28,ease:"back.out(1.6)"}},{s:.3f});')
        elif k == "tag":
            els.append(f'<div {clip_attrs(eid, s, e, 50)}><div class="tagrig" id="{eid}-t"><div class="stick"><b></b><b></b><b></b><b></b><b></b><b></b><b></b><b></b></div>'
                       f'<div class="string"></div><div class="tag">{esc(it["text"])}</div></div></div>')
            tweens.append(f'tl.fromTo("#{eid}-t",{{y:-700,rotation:-8}},{{y:0,rotation:0,duration:0.45,ease:"bounce.out"}},{s:.3f});')
        elif k == "sticker":
            i = counters["sticker"]
            counters["sticker"] += 1
            size = min(STICKER_FONT_PX, int(STICKER_MAX_W / (len(it["text"]) * STICKER_CHAR_EM)))
            half = (len(it["text"]) * STICKER_CHAR_EM * size + STICKER_PAD_PX) / 2
            declared = [sp for a, b, sps in scene_spots if a < e and b > s for sp in sps]
            busy = [b for t0, t1, b in (overlays if declared else held) if t0 < e and t1 > s]
            order = declared or [STICKER_SPOTS[(i + j) % len(STICKER_SPOTS)] for j in range(len(STICKER_SPOTS))]
            placed = [(int(min(1920 - STICKER_MARGIN_PX - half, max(STICKER_MARGIN_PX + half, x))), y, r) for x, y, r in order]
            cx, cy, rot = next((p for p in placed if not any(_overlaps((p[0] - half, p[1] - size, 2 * half, 2 * size), b) for b in busy)), placed[0])
            els.append(f'<div {clip_attrs(eid, s, e, 60)}><div class="stk" id="{eid}-s" style="left:{cx}px;top:{cy}px;font-size:{size}px;--r:{rot}deg">{esc(it["text"])}</div></div>')
            drawn.append(("sticker", s, e, (cx - half, cy - size, 2 * half, 2 * size)))
            tweens.append(f'tl.fromTo("#{eid}-s",{{xPercent:-50,yPercent:-50,scale:2.2,opacity:0,rotation:{rot * 3}}},{{xPercent:-50,yPercent:-50,scale:1,opacity:1,rotation:{rot},duration:0.14,ease:"power4.out"}},{s:.3f});')
    duration = timeline["duration"]
    css = ov.base_css() + film.css_file.read_text(encoding="utf-8") + scenes.CSS + film.scene_css
    layout = {"boxes": [{"kind": k, "start": s, "end": e, "box": [round(v) for v in b]} for k, s, e, b in drawn],
              "labels": labels + [{"kind": "tag", "start": it["start"], "end": it["end"]} for it in timeline["items"] if it["kind"] == "tag"],
              "scenes": scene_rows, **picture_record(timeline["items"], desk_until, reveals)}
    desk_layer = f'<div {clip_attrs("desk", 0, desk_until, 1)}>{film.desk_html}</div>' if desk_until > 0 else ""
    return layout, f"""<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="assets/kit.css"><style>{css}</style><script src="assets/gsap.min.js"></script></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="{duration:.3f}" data-width="1920" data-height="1080">
<div class="stage"></div>
{desk_layer}
{chr(10).join(els)}
</div>
<script src="assets/kit.js"></script>
<script>
const tl = K.timeline("main");
window.__timelines["main"] = tl;
{chr(10).join(tweens)}
K.done();
</script>
</body></html>
"""


def meme_or_clip(art: Art, caps: Captures, it: dict, eid: str, s: float, e: float, k: str, desk: bool, counters: dict,
                 els: list, tweens: list, drawn: list, labels: list, labelled: set) -> None:
    """A meme or creator clip: an overlay mode (cutout, spotlight, slot, ghost), a window on the desk, or full frame.
    Full frame covers every sticker and tag; letterbox bars (and any watermark in them) are clipped off over a matte of
    the meme's own, so the scene underneath never shows through the bars. A creator's first clip shows a credit chip."""
    i = counters["meme"]
    counters["meme"] += 1
    src = art.asset(it["file"])
    mode = it.get("mode") or "fullscreen"
    base = f'id="{eid}-v" src="{src}" muted playsinline data-track-index="41"'
    timing = f'data-start="{s:.3f}" data-duration="{e - s:.3f}" data-media-start="{it["in"]:.3f}"'

    def video(cls: str = "", style: str = "object-fit:cover") -> str:
        return f'<video {base} class="{" ".join(["clip", *cls.split()])}" {timing} style="{style}"></video>'

    if mode in ov.MODES and mode != "fullscreen":
        x, y, w, h = overlay_box(caps, it, desk)
        if mode in ("spotlight", "slot"):
            drawn.append((mode, s, e, (x, y, w, h)))
        inset = ";".join(filter(None, ["object-fit:cover", ov.luma_filter(centre_luma(it["file"], it["in"], it["out"]) if mode in ("spotlight", "slot") else None)]))
        if mode == "cutout":
            els.append(f'<div id="{eid}-o" style="position:absolute;inset:0;opacity:0;z-index:45">'
                       f'{video("ovl-cut film-cut", f"left:{x}px;bottom:{TASKBAR_H if desk else 0}px;width:{w}px;opacity:1")}</div>')
        elif mode == "spotlight":
            els.append(f'<div id="{eid}-o" style="position:absolute;left:{x}px;top:{y}px;width:{w}px;height:{h}px;opacity:0;z-index:45">'
                       f'<div class="ring"></div><div class="ovl-spot" style="left:0;top:0;opacity:1">{video(style=inset)}</div></div>')
        elif mode == "slot":
            els.append(f'<div id="{eid}-o" class="ovl-slot film-slot" style="left:{x}px;top:{y}px;width:{w}px;height:{h}px;z-index:45">'
                       f'{video(style=inset)}</div>')
        else:
            els.append(f'<div id="{eid}-o" class="ovl-ghost" style="{ov.ghost_style(it.get("side"))};z-index:44">{video()}</div>')
        tweens.extend(gsap_rows(f"#{eid}-o", ov.motion(mode, e - s), s))
    elif desk:
        title = "podcast.mp4" if k == "clip" else MEME_TITLES[i % len(MEME_TITLES)]
        x, y, w, h = (210, 75, 1500, 844) if k == "clip" else (240, 95, 1440, 810)
        color = "#111" if k == "clip" else TITLE_COLORS[(i + 2) % 5]
        z = 70 if k == "meme" else 40
        els.append(window(eid, s, e, z, title, color, "", (x, y, w, h)))
        vs = s + 0.1
        els.append(f'<video {base} class="clip" data-start="{vs:.3f}" data-duration="{e - vs:.3f}" data-media-start="{it["in"] + 0.1:.3f}" '
                   f'style="position:absolute;left:{x + 6}px;top:{y + 46}px;width:{w - 12}px;height:{h - 52}px;object-fit:cover;background:#000;z-index:{z + 1}"></video>')
        tweens.append(f'tl.fromTo("#{eid}-w",{{scale:0.8,opacity:0}},{{scale:1,opacity:1,duration:0.1,ease:"back.out(2.5)"}},{s:.3f});')
    else:
        pic = it.get("picture")
        z = 70 if k == "meme" else 40
        fill = bool(pic and it.get("fill"))
        bars = bars_clip(pic, it["w"], it["h"]) if pic and not fill else (0.0, 0.0, 0.0, 0.0)
        if any(bars):
            els.append(f'<div {clip_attrs(eid + "m", s, e, z - 1)}><div style="position:absolute;inset:0;background:#0e0f12"></div></div>')
        clip_bars = ";clip-path:inset({:.2%} {:.2%} {:.2%} {:.2%})".format(*bars) if any(bars) else ""
        if fill:
            x, y, w, h = picture_on_frame(pic, it["w"], it["h"], True)
            els.append(video("full", f"z-index:{z};left:{x:.0f}px;top:{y:.0f}px;right:auto;bottom:auto;width:{w:.0f}px;height:{h:.0f}px;object-fit:fill"))
        else:
            els.append(video("full", f"z-index:{z}{clip_bars}"))
        if k == "clip" and it.get("creator") and it["creator"] not in labelled:
            labelled.add(it["creator"])
            cx, cy = it.get("credit_at") or CREDIT_AT
            at = f' style="left:{cx}px;top:{cy}px;bottom:auto"' if it.get("credit_at") else ""
            els.append(f'<div {clip_attrs(eid + "c", s, e, 42)}><div class="credit" id="{eid}-cr"{at}>{esc(it["creator"])}</div></div>')
            drawn.append(("credit", s, min(e, s + SOURCE_LABEL_SECONDS), (cx, cy, 17 * len(it["creator"]) + 52, CREDIT_H)))
            labels.append({"kind": "credit", "start": s, "end": min(e, s + SOURCE_LABEL_SECONDS)})
            tweens.append(f'tl.fromTo("#{eid}-cr",{{y:30,opacity:0}},{{y:0,opacity:1,duration:0.2,ease:"power3.out"}},{s + 0.1:.3f});')
            tweens.append(f'tl.to("#{eid}-cr",{{opacity:0,duration:0.2}},{min(e - 0.25, s + SOURCE_LABEL_SECONDS):.3f});')
        tweens.append(f'tl.fromTo("#{eid}-v",{{scale:1.06}},{{scale:1,duration:0.12,ease:"power3.out"}},{s:.3f});')


def write(film: Film) -> dict:
    """Compose build/timeline.json into build/film/index.html and build/layout.json; returns the layout."""
    timeline = json.loads(film.timeline_file.read_text(encoding="utf-8"))
    layout, page = render(film, timeline)
    (film.page_dir / "index.html").write_text(page, encoding="utf-8")
    film.layout_file.write_text(json.dumps(layout, indent=0), encoding="utf-8")
    return layout
