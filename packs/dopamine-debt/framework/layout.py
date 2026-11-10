import hashlib
import json
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from websockets.sync.client import connect

from framework.tools import HIDDEN, browser

MEASURE = r"""
async (o) => {
  if (document.readyState !== "complete") await new Promise(r => addEventListener("load", r, {once: true}));
  await document.fonts.ready;
  const vids = [...document.querySelectorAll("video")];
  await Promise.all(vids.map(v => v.readyState >= 1 ? 0 : new Promise(r => {
    v.addEventListener("loadedmetadata", r, {once: true}); v.addEventListener("error", r, {once: true}); setTimeout(r, 8000);
  })));
  const root = document.getElementById("root");
  const cid = root.dataset.compositionId, dur = +root.dataset.duration;
  const tl = window.__timelines[cid];
  const W = o.width, H = o.height, BX = o.band[0], BY = o.band[1];
  const ctxOf = el => { const c = []; for (let e = el; e && e !== root; e = e.parentElement) { if (e.id) c.push("#" + e.id); for (const k of e.classList) c.push("." + k); } return c; };
  const items = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) {
    const s = n.nodeValue;
    if (!s.trim() || n.parentElement.closest("script,style")) continue;
    const words = []; const re = /\S+/g;
    for (let m; (m = re.exec(s));) words.push([m.index, m.index + m[0].length, m[0]]);
    items.push({n, el: n.parentElement, words});
  }
  const media = [...root.querySelectorAll("video,img")];
  const marks = o.ids.map(i => [i, document.getElementById(i)]).filter(x => x[1]);
  let cache = new Map();
  const eff = e => {
    if (!e || e === document.documentElement) return 1;
    if (cache.has(e)) return cache.get(e);
    const cs = getComputedStyle(e);
    const v = cs.display === "none" || cs.visibility === "hidden" ? 0 : parseFloat(cs.opacity) * eff(e.parentElement);
    cache.set(e, v);
    return v;
  };
  const opaque = e => {
    if (e.tagName === "VIDEO") return !/\.webm$/i.test(e.getAttribute("src") || "");
    if (e.tagName === "IMG") return !/\.png$/i.test(e.getAttribute("src") || "");
    const m = getComputedStyle(e).backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const p = m[1].split(",").map(parseFloat);
    return p.length < 4 || p[3] >= 0.9;
  };
  const hidden = (x, y, el) => {
    for (const e of document.elementsFromPoint(x, y)) {
      if (e === el || el.contains(e) || e.contains(el)) return false;
      if (eff(e) < 0.9) continue;
      if (opaque(e)) return true;
    }
    return false;
  };
  const box = r => [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
  const onFrame = r => r.width > 0 && r.height > 0 && r.right > 0 && r.left < W && r.bottom > 0 && r.top < H;
  const inBand = r => r.left < BX || r.right > W - BX || r.top < BY || r.bottom > H - BY;
  let clips = new Map();
  const fadeInsets = (el, cs, r) => {
    const img = cs.webkitMaskImage || cs.maskImage || "none";
    const ins = {left: 0, top: 0, right: 0, bottom: 0};
    if (!img.startsWith("linear-gradient")) return ins;
    const sx = el.offsetWidth ? r.width / el.offsetWidth : 1, sy = el.offsetHeight ? r.height / el.offsetHeight : 1;
    for (const g of img.split(/,\s*(?=linear-gradient)/)) {
      const parts = g.replace(/^linear-gradient\(|\)$/g, "").split(/,(?![^(]*\))/).map(s => s.trim());
      const across = /^(90deg|270deg|to (left|right))/.test(parts[0]);
      const stops = /deg|^to /.test(parts[0]) ? parts.slice(1) : parts;
      const size = across ? el.offsetWidth : el.offsetHeight;
      const at = s => { const c = s.match(/calc\(100% - ([\d.]+)px\)/); if (c) return size - +c[1]; const p = s.match(/([\d.]+)px\s*$/); if (p) return +p[1]; const q = s.match(/([\d.]+)%\s*$/); return q ? size * q[1] / 100 : null; };
      const clear = s => /rgba\([^)]*,\s*0\)|transparent/.test(s);
      if (stops.length < 2) continue;
      const lead = clear(stops[0]) ? at(stops[1]) : 0, tail = clear(stops[stops.length - 1]) ? size - (at(stops[stops.length - 2]) ?? size) : 0;
      const k = across ? sx : sy;
      if (across) { ins.left = Math.max(ins.left, (lead || 0) * k); ins.right = Math.max(ins.right, tail * k); }
      else { ins.top = Math.max(ins.top, (lead || 0) * k); ins.bottom = Math.max(ins.bottom, tail * k); }
    }
    return ins;
  };
  const clipOf = el => {
    if (!el || el === root.parentElement) return null;
    if (clips.has(el)) return clips.get(el);
    const up = clipOf(el.parentElement);
    const cs = getComputedStyle(el);
    let c = up;
    const masked = (cs.webkitMaskImage || cs.maskImage || "none").startsWith("linear-gradient");
    if (cs.overflowX !== "visible" || cs.overflowY !== "visible" || masked) {
      const b = el.getBoundingClientRect();
      const f = fadeInsets(el, cs, b);
      const r = {left: b.left + f.left, top: b.top + f.top, right: b.right - f.right, bottom: b.bottom - f.bottom};
      const by = el.id ? "#" + el.id : el.classList.length ? "." + el.classList[0] : el.tagName.toLowerCase();
      c = up ? {left: Math.max(up.left, r.left), top: Math.max(up.top, r.top), right: Math.min(up.right, r.right), bottom: Math.min(up.bottom, r.bottom), by}
             : {left: r.left, top: r.top, right: r.right, bottom: r.bottom, by};
    }
    clips.set(el, c);
    return c;
  };
  const clipped = (r, el) => {
    const c = clipOf(el);
    if (!c) return r;
    const left = Math.max(r.left, c.left), top = Math.max(r.top, c.top), right = Math.min(r.right, c.right), bottom = Math.min(r.bottom, c.bottom);
    return {left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top)};
  };
  const rg = document.createRange();
  const samples = [];
  for (let k = 0; k * o.step < dur; k++) {
    const t = Math.round(k * o.step * 1000) / 1000;
    tl.seek(t, false);
    cache = new Map();
    clips = new Map();
    const text = [], vis = [], mk = [];
    items.forEach((it, i) => {
      const op = eff(it.el);
      if (op < o.min_opacity) return;
      const seen = [], band = []; let u = null;
      it.words.forEach((w, j) => {
        rg.setStart(it.n, w[0]); rg.setEnd(it.n, w[1]);
        const r = clipped(rg.getBoundingClientRect(), it.el);
        if (!onFrame(r)) return;
        if (hidden(Math.min(W - 1, Math.max(0, (r.left + r.right) / 2)), Math.min(H - 1, Math.max(0, (r.top + r.bottom) / 2)), it.el)) return;
        seen.push(j);
        if (inBand(r)) band.push(j);
        u = u ? [Math.min(u[0], r.left), Math.min(u[1], r.top), Math.max(u[2], r.right), Math.max(u[3], r.bottom)] : [r.left, r.top, r.right, r.bottom];
      });
      if (seen.length) text.push([i, seen, u.map(Math.round), band, Math.round(op * 100) / 100]);
    });
    media.forEach((e, i) => {
      const op = eff(e);
      if (op < o.min_opacity) return;
      const r = e.getBoundingClientRect();
      if (onFrame(r)) vis.push([i, box(r), Math.round(op * 100) / 100]);
    });
    for (const [id, e] of marks) {
      const op = eff(e);
      if (op < o.min_opacity) continue;
      const r = clipped(e.getBoundingClientRect(), e.parentElement);
      if (onFrame(r)) mk.push([id, box(r)]);
    }
    samples.push([t, text, vis, mk]);
  }
  const held = [];
  if (o.held && o.held.length) {
    const tagSel = o.tags || "";
    const inks = [], inkWords = [];
    const inkBoxEl = (parent, x, y, w, h) => {
      const d = document.createElement("g11-ink");
      d.style.cssText = `position:absolute;display:block;left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
      parent.appendChild(d);
      return d;
    };
    for (const img of root.querySelectorAll("img")) {
      const spec = (o.inks || {})[img.getAttribute("src")];
      if (!spec || !img.parentElement) continue;
      const k = parseFloat(img.style.width) / spec.w0, x0 = parseFloat(img.style.left) || 0, y0 = parseFloat(img.style.top) || 0;
      if (!k) continue;
      spec.lines.forEach((ln, n) => inks.push({el: inkBoxEl(img.parentElement, x0 + ln[0] * k, y0 + ln[1] * k, ln[2] * k, ln[3] * k), text: `${spec.name} line ${n + 1}`}));
      (spec.words || []).forEach(wd => inkWords.push({el: inkBoxEl(img.parentElement, x0 + wd[0] * k, y0 + wd[1] * k, wd[2] * k, wd[3] * k), text: `${spec.name} line ${wd[4] + 1}`}));
    }
    const rings = o.rings ? [...root.querySelectorAll(o.rings)] : [];
    const tags = tagSel ? [...root.querySelectorAll(tagSel)] : [];
    const corners = tags.map(tg => {
      if (getComputedStyle(tg).position === "static") tg.style.position = "relative";
      return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([a, b]) => {
        const d = document.createElement("g11-probe");
        d.style.cssText = `position:absolute;display:block;left:${a * 100}%;top:${b * 100}%;width:0;height:0;margin:0;padding:0;border:0`;
        tg.appendChild(d);
        return d;
      });
    });
    const inTag = e => tagSel && e.closest && e.closest(tagSel);
    const cv = document.createElement("canvas").getContext("2d");
    const metrics = new Map();
    const inkBox = (el, word, r) => {
      const cs = getComputedStyle(el);
      const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const key = font + "|" + word;
      let m = metrics.get(key);
      if (!m) {
        cv.font = font;
        const x = cv.measureText(word);
        m = [x.fontBoundingBoxAscent, x.fontBoundingBoxDescent, x.actualBoundingBoxAscent, x.actualBoundingBoxDescent];
        metrics.set(key, m);
      }
      const k = r.height / ((m[0] + m[1]) || 1);
      return {left: r.left, right: r.right, top: r.top + (m[0] - m[2]) * k, bottom: r.top + (m[0] + m[3]) * k};
    };
    const windowOf = el => {
      const c = clipOf(el) || {left: 0, top: 0, right: W, bottom: H};
      return {left: Math.max(0, c.left), top: Math.max(0, c.top), right: Math.min(W, c.right), bottom: Math.min(H, c.bottom), by: c.by || "the frame"};
    };
    const covered = (x, y, el) => {
      for (const e of document.elementsFromPoint(x, y)) {
        if (e === el || el.contains(e) || e.contains(el) || inTag(e)) return false;
        if (eff(e) < 0.9) continue;
        if (opaque(e)) return true;
      }
      return false;
    };
    const cut = (b, c) => {
      const over = [["left", c.left - b.left], ["right", b.right - c.right], ["top", c.top - b.top], ["bottom", b.bottom - c.bottom]].filter(s => s[1] > o.clip_tolerance);
      return over.length ? over.sort((a, z) => z[1] - a[1])[0] : null;
    };
    const polyArea = p => Math.abs(p.reduce((s, q, i) => { const n = p[(i + 1) % p.length]; return s + q[0] * n[1] - n[0] * q[1]; }, 0)) / 2;
    const clipPoly = (poly, b) => {
      let out = poly;
      for (const [inside, hit] of [
        [q => q[0] >= b.left, (p, q) => [b.left, p[1] + (q[1] - p[1]) * (b.left - p[0]) / (q[0] - p[0])]],
        [q => q[0] <= b.right, (p, q) => [b.right, p[1] + (q[1] - p[1]) * (b.right - p[0]) / (q[0] - p[0])]],
        [q => q[1] >= b.top, (p, q) => [p[0] + (q[0] - p[0]) * (b.top - p[1]) / (q[1] - p[1]), b.top]],
        [q => q[1] <= b.bottom, (p, q) => [p[0] + (q[0] - p[0]) * (b.bottom - p[1]) / (q[1] - p[1]), b.bottom]]]) {
        const src = out; out = [];
        src.forEach((q, i) => {
          const p = src[(i + src.length - 1) % src.length];
          if (inside(q)) { if (!inside(p)) out.push(hit(p, q)); out.push(q); } else if (inside(p)) out.push(hit(p, q));
        });
        if (!out.length) return out;
      }
      return out;
    };
    const label = s => s.replace(/\s+/g, " ").trim().slice(0, 60);
    const look = t => {
      tl.seek(t, false);
      cache = new Map();
      clips = new Map();
      const words = new Map(), quads = new Map(), obst = [], loops = new Map();
      items.forEach((it, i) => {
        if (eff(it.el) < o.min_opacity || it.el.closest('[aria-hidden="true"]')) return;
        it.words.forEach((w, j) => {
          rg.setStart(it.n, w[0]); rg.setEnd(it.n, w[1]);
          const r = rg.getBoundingClientRect();
          if (!r.width || !r.height) return;
          const b = inkBox(it.el, w[2], r), c = windowOf(it.el);
          const vl = Math.max(b.left, c.left), vr = Math.min(b.right, c.right), vt = Math.max(b.top, c.top), vb = Math.min(b.bottom, c.bottom);
          if (vr - vl < 1 || vb - vt < 1 || covered((vl + vr) / 2, (vt + vb) / 2, it.el)) return;
          words.set(`${i}.${j}`, {el: it.el, b, c, text: it.n.nodeValue, word: w[2], item: i});
          obst.push({el: it.el, b: {left: vl, right: vr, top: vt, bottom: vb}, text: it.n.nodeValue, word: w[2]});
        });
      });
      inks.forEach((ink, i) => {
        if (eff(ink.el) < o.min_opacity) return;
        const r = ink.el.getBoundingClientRect(), c = windowOf(ink.el);
        const b = {left: r.left, right: r.right, top: r.top, bottom: r.bottom};
        if (Math.min(b.right, c.right) - Math.max(b.left, c.left) < 1 || Math.min(b.bottom, c.bottom) - Math.max(b.top, c.top) < 1) return;
        words.set(`ink${i}`, {el: ink.el, b, c, text: ink.text, word: "", item: `ink${i}`});
      });
      inkWords.forEach(ink => {
        if (eff(ink.el) < o.min_opacity) return;
        const r = ink.el.getBoundingClientRect(), c = windowOf(ink.el);
        const b = {left: Math.max(r.left, c.left), right: Math.min(r.right, c.right), top: Math.max(r.top, c.top), bottom: Math.min(r.bottom, c.bottom)};
        if (b.right - b.left >= 1 && b.bottom - b.top >= 1) obst.push({el: ink.el, b, text: ink.text, word: ""});
      });
      tags.forEach((tg, i) => {
        if (eff(tg) < o.min_opacity) return;
        quads.set(i, corners[i].map(d => { const r = d.getBoundingClientRect(); return [r.left, r.top]; }));
      });
      rings.forEach((ring, i) => {
        const shape = ring.firstElementChild;
        if (!shape || eff(ring) < o.min_opacity || parseFloat(getComputedStyle(shape).strokeDashoffset) > 1) return;
        const r = shape.getBoundingClientRect(), k = ring.getBoundingClientRect().width / (ring.width.baseVal.value || 1);
        const hw = parseFloat(getComputedStyle(shape).strokeWidth) * k / 2;
        loops.set(i, {outer: {left: r.left - hw, right: r.right + hw, top: r.top - hw, bottom: r.bottom + hw},
                      inner: {left: r.left + hw, right: r.right - hw, top: r.top + hw, bottom: r.bottom - hw}, c: windowOf(ring)});
      });
      return {words, quads, obst, loops};
    };
    const drift = (a, b) => Math.max(Math.abs((a.b.left - a.c.left) - (b.b.left - b.c.left)), Math.abs((a.b.top - a.c.top) - (b.b.top - b.c.top)));
    for (const t of o.held) {
      const next = look(t + o.motion_dt), now = look(t);
      const shown = [];
      for (const [k, s] of now.words) {
        const n = next.words.get(k);
        if (n && drift(s, n) <= o.motion_px) shown.push(s);
      }
      const clipped = [], cover = [], worstByItem = new Map();
      for (const s of shown) {
        const over = cut(s.b, s.c);
        const w = worstByItem.get(s.item);
        if (over && (!w || over[1] > w.px)) worstByItem.set(s.item, {text: label(s.text), word: s.word, side: over[0], px: Math.round(over[1]), by: s.c.by});
      }
      clipped.push(...worstByItem.values());
      const shareOf = (quad, b) => {
        const xs = quad.map(q => q[0]), ys = quad.map(q => q[1]);
        if (b.right <= Math.min(...xs) || b.left >= Math.max(...xs) || b.bottom <= Math.min(...ys) || b.top >= Math.max(...ys)) return 0;
        return polyArea(clipPoly(quad, b)) / ((b.right - b.left) * (b.bottom - b.top));
      };
      for (const [i, quad] of now.quads) {
        const was = next.quads.get(i);
        if (!was || quad.some((q, n) => Math.abs(q[0] - was[n][0]) > o.motion_px || Math.abs(q[1] - was[n][1]) > o.motion_px)) continue;
        const tg = tags[i];
        const xs = quad.map(q => q[0]), ys = quad.map(q => q[1]);
        const bb = {left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys)};
        if (!onFrame({width: bb.right - bb.left, height: bb.bottom - bb.top, left: bb.left, right: bb.right, top: bb.top, bottom: bb.bottom})) continue;
        const worst = new Map();
        for (const [k, s] of now.words) {
          const n = next.words.get(k);
          if (!n || tg.contains(s.el) || s.el.contains(tg)) continue;
          const share = Math.min(shareOf(quad, s.b), shareOf(was, n.b));
          if (share > o.cover_max && share > (worst.get(s.text) || 0)) worst.set(s.text, share);
        }
        for (const [text, share] of worst) cover.push({tag: label(tg.textContent), text: label(text), share: Math.round(share * 100) / 100});
      }
      const sliced = [], worstSlice = new Map();
      for (const [i, lp] of now.loops) {
        const was = next.loops.get(i);
        if (!was || ["left", "right", "top", "bottom"].some(e => Math.abs(lp.outer[e] - was.outer[e]) > o.motion_px)) continue;
        const {outer: a, inner: n, c} = lp;
        const bands = [["top", a.left, a.right, a.top, n.top], ["bottom", a.left, a.right, n.bottom, a.bottom],
                       ["left", a.left, n.left, a.top, a.bottom], ["right", n.right, a.right, a.top, a.bottom]];
        for (const s of now.obst) {
          if (rings[i].contains(s.el)) continue;
          for (const [side, l, r, tp, bt] of bands) {
            const ox = Math.min(r, c.right, s.b.right) - Math.max(l, c.left, s.b.left), oy = Math.min(bt, c.bottom, s.b.bottom) - Math.max(tp, c.top, s.b.top);
            if (ox <= o.clip_tolerance || oy <= o.clip_tolerance) continue;
            const px = Math.round(side === "top" || side === "bottom" ? oy : ox), key = `${i}|${s.text}`;
            if (px > (worstSlice.get(key)?.px || 0)) worstSlice.set(key, {text: label(s.text), word: s.word, side, px});
          }
        }
      }
      sliced.push(...worstSlice.values());
      held.push([t, clipped, cover, sliced]);
    }
  }
  return {
    id: cid, duration: dur,
    items: items.map(it => ({words: it.words.map(w => w[2]), ctx: ctxOf(it.el)})),
    media: media.map(e => ({tag: e.tagName.toLowerCase(), src: e.getAttribute("src"), ctx: ctxOf(e)})),
    samples, held
  };
}
"""


class _Tab:
    def __init__(self, ws):
        self.ws = ws
        self.n = 0
        self.events = []

    def call(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv(timeout=900))
            if m.get("id") == self.n:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m["result"]
            self.events.append(m.get("method"))

    def wait(self, event, timeout=120):
        end = time.time() + timeout
        while event not in self.events:
            self.events.append(json.loads(self.ws.recv(timeout=max(0.1, end - time.time()))).get("method"))
        self.events.clear()


def _key(page, opts):
    h = hashlib.sha1(MEASURE.encode() + json.dumps(opts, sort_keys=True).encode())
    page = Path(page)
    h.update(page.read_bytes())
    for f in sorted((page.parent / "assets").iterdir()):
        st = f.stat()
        h.update(f"{f.name}|{st.st_size}|{st.st_mtime_ns}".encode())
    return h.hexdigest()


def measure(jobs, cache_path):
    cache = json.loads(Path(cache_path).read_text(encoding="utf-8")) if Path(cache_path).exists() else {}
    keys = {name: _key(page, opts) for name, (page, opts) in jobs.items()}
    todo = {name: job for name, job in jobs.items() if keys[name] not in cache}
    if todo:
        exe = browser()
        if exe is None:
            raise FileNotFoundError("no Chrome, Chromium or Edge on PATH or in Windows App Paths; set DD_BROWSER to its binary")
        tmp = tempfile.mkdtemp(prefix="layout-")
        width, height = max(o["width"] for _, o in todo.values()), max(o["height"] for _, o in todo.values())
        proc = subprocess.Popen([str(exe), "--headless=new", "--remote-debugging-port=0", f"--user-data-dir={tmp}", f"--window-size={width},{height}",
                                 "--hide-scrollbars", "--mute-audio", "--allow-file-access-from-files", "--no-first-run", "--no-default-browser-check", "about:blank"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=HIDDEN)
        try:
            port_file = Path(tmp) / "DevToolsActivePort"
            end = time.time() + 60
            while not port_file.exists() or not port_file.read_text().strip():
                if time.time() > end or proc.poll() is not None:
                    raise RuntimeError("headless browser did not open its debugging port")
                time.sleep(0.1)
            port = int(port_file.read_text().split()[0])
            targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=30).read())
            url = next(t["webSocketDebuggerUrl"] for t in targets if t["type"] == "page")
            with connect(url, max_size=None, open_timeout=30) as ws:
                tab = _Tab(ws)
                tab.call("Page.enable")
                for name, (page, opts) in todo.items():
                    tab.call("Emulation.setDeviceMetricsOverride", width=opts["width"], height=opts["height"], deviceScaleFactor=1, mobile=False)
                    tab.events.clear()
                    tab.call("Page.navigate", url=Path(page).resolve().as_uri())
                    tab.wait("Page.loadEventFired")
                    r = tab.call("Runtime.evaluate", expression=f"({MEASURE})({json.dumps(opts)})", awaitPromise=True, returnByValue=True, timeout=900000)
                    if "exceptionDetails" in r:
                        raise RuntimeError(f"{name}: {r['exceptionDetails'].get('exception', {}).get('description') or r['exceptionDetails']}")
                    cache[keys[name]] = r["result"]["value"]
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
            shutil.rmtree(tmp, ignore_errors=True)
        live = set(keys.values())
        Path(cache_path).parent.mkdir(parents=True, exist_ok=True)
        Path(cache_path).write_text(json.dumps({k: v for k, v in cache.items() if k in live}, separators=(",", ":")), encoding="utf-8")
    return {name: cache[keys[name]] for name in jobs}
