import hashlib
import json
import shutil
from pathlib import Path


def r3(v):
    return round(float(v), 3)


def j(o):
    return json.dumps(o, separators=(",", ":"))


def grain(path):
    path = Path(path)
    if not path.exists():
        import numpy as np
        from PIL import Image
        n = np.random.default_rng(4).normal(235, 18, (512, 512)).clip(0, 255).astype(np.uint8)
        Image.fromarray(n, "L").convert("RGB").save(path)
    return path


class Section:
    def __init__(self, sid, t0, t1):
        self.id = sid
        self.t0 = t0
        self.t1 = t1
        self.dur = r3(t1 - t0)
        self.html = []
        self.js = []
        self.place = []
        self.assets = {}
        self.n = 0

    def uid(self, stem):
        self.n += 1
        return f"{self.id.lower()}{stem}{self.n}"

    def L(self, t):
        return r3(max(0.0, t - self.t0))

    def asset(self, path, name=None):
        path = Path(path)
        key = name or path.name
        if self.assets.get(key, path) != path:
            key = f"{hashlib.sha1(str(path).encode()).hexdigest()[:8]}-{key}"
        self.assets[key] = path
        return f"assets/{key}"

    def add(self, s):
        self.html.append(s)

    def set(self, sel, props, t):
        self.js.append(f'tl.set("{sel}",{j(props)},{self.L(t)});')

    def fromto(self, sel, a, b, t, dur=0.25, ease="power3.out"):
        self.js.append(f'tl.fromTo("{sel}",{j(a)},{j({**b, "duration": dur, "ease": ease})},{self.L(t)});')

    def to(self, sel, props, t, dur=0.25, ease="power2.inOut"):
        self.js.append(f'tl.to("{sel}",{j({**props, "duration": dur, "ease": ease})},{self.L(t)});')

    def shot(self, a, b, inner, z=10, style=""):
        el = self.uid("sh")
        self.add(f'<div id="{el}" class="shot" style="z-index:{z};{style}">{inner}</div>')
        self.set(f"#{el}", {"opacity": 1}, a)
        self.set(f"#{el}", {"opacity": 0}, b)
        return el

    def video(self, src, a, dur, media_start, cls="clip", style="", name=None, extra=""):
        vid = self.uid("v")
        s = self.asset(src, name)
        return vid, f'<video id="{vid}" class="clip {cls}" src="{s}" data-start="{self.L(a)}" data-duration="{r3(dur)}" data-media-start="{r3(media_start)}" muted playsinline style="{style}" {extra}></video>'

    def slam(self, sel, t, rot=0, frm=1.6, dur=0.14):
        self.fromto(sel, {"scale": frm, "rotation": rot, "opacity": 0}, {"scale": 1, "rotation": rot, "opacity": 1}, t, dur, "power4.in")
        for k, dx in enumerate((9, -7, 4, 0)):
            self.js.append(f'tl.to("{sel}",{{x:{dx},duration:0.04,ease:"none"}},{self.L(t + dur + 0.04 * k)});')

    def pop(self, sel, t, dur=0.2, frm=0.5):
        self.fromto(sel, {"scale": frm, "opacity": 0}, {"scale": 1, "opacity": 1}, t, dur, "back.out(2.2)")

    def drop_in(self, sel, t, rot):
        self.fromto(sel, {"y": -60, "rotation": rot - 3, "opacity": 0}, {"y": 0, "rotation": rot, "opacity": 1}, t, 0.22, "power3.out")

    def mark(self, sel, t, dur=0.32):
        self.fromto(sel, {"backgroundSize": "0% 100%"}, {"backgroundSize": "100% 100%"}, t, dur, "power2.out")

    def write(self, out_dir, css, gsap, fonts_dir, fonts, extra_files=(), backdrop=""):
        out_dir = Path(out_dir)
        if out_dir.exists():
            shutil.rmtree(out_dir)
        (out_dir / "assets").mkdir(parents=True)
        for key, path in self.assets.items():
            dst = out_dir / "assets" / key
            try:
                dst.hardlink_to(path)
            except OSError:
                shutil.copyfile(path, dst)
        shutil.copyfile(gsap, out_dir / "assets/gsap.min.js")
        for src, name in extra_files:
            shutil.copyfile(src, out_dir / "assets" / name)
        faces = []
        for fam, f in fonts.items():
            shutil.copyfile(Path(fonts_dir) / f, out_dir / "assets" / f)
            faces.append(f'@font-face{{font-family:{fam};src:url(assets/{f})}}')
        body = "\n".join(self.html)
        place = "\n".join(self.place)
        script = "\n".join(self.js)
        page = f"""<!doctype html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=1920, height=1080"/>
<script src="assets/gsap.min.js"></script>
<style>{''.join(faces)}{css}</style></head>
<body>
<div id="root" data-composition-id="{self.id}" data-start="0" data-duration="{self.dur}" data-width="1920" data-height="1080" data-fps="30">
{backdrop}
{body}
</div>
<script>
function R(id){{const e=document.getElementById(id);const r=e.getBoundingClientRect();const root=document.getElementById('root').getBoundingClientRect();return {{x:r.left-root.left,y:r.top-root.top,w:r.width,h:r.height}};}}
function P(id,css){{const e=document.getElementById(id);for(const k in css)e.style[k]=css[k];}}
{place}
const tl=gsap.timeline({{paused:true}});
{script}
tl.set({{}},{{}},{self.dur});
window.__timelines=window.__timelines||{{}};window.__timelines["{self.id}"]=tl;
</script>
</body></html>
"""
        (out_dir / "index.html").write_text(page, encoding="utf-8")
        return out_dir / "index.html"
