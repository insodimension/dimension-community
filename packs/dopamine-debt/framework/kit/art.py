"""The page's asset folder: every picture, clip, logo and the Motion kit copied beside index.html, so a render needs
nothing outside build/film."""
from __future__ import annotations

import base64
import hashlib
import html
import shutil
from pathlib import Path

from .film import Film, gsap_file, motion_kit_folder


def esc(s: str) -> str:
    return html.escape(str(s), quote=True)


class Art:
    def __init__(self, film: Film):
        self.film = film
        self.folder = film.page_dir / "assets"
        self.logos = film.media / "logos"

    def asset(self, src: str | Path) -> str:
        """Copy `src` into the asset folder (named by its stem and a hash of its path) and return its page URL. The copy
        is refreshed whenever the source's size or modification time differs from it, so a recaptured file reaches the page."""
        src = Path(src)
        digest = hashlib.sha1(str(src).encode()).hexdigest()[:8]
        name = f"{src.stem[:40]}-{digest}{src.suffix}".replace(" ", "_")
        dst = self.folder / name
        st = src.stat()
        if not dst.exists() or (d := dst.stat()).st_size != st.st_size or d.st_mtime_ns != st.st_mtime_ns:
            shutil.copy2(src, dst)
        return f"assets/{name}"

    def logo(self, slug: str, h: int, white: bool = False, cls: str = "", maxw: int = 300) -> str:
        """An <img> of a brand logo from media/logos (`<slug>-white.svg` on dark ground when it exists, else
        `<slug>.svg` or `.png`); with no file, the slug in capitals."""
        for name in ([f"{slug}-white.svg"] if white else []) + [f"{slug}.svg", f"{slug}.png"]:
            if (self.logos / name).exists():
                return f'<img class="{cls}" src="{self.asset(self.logos / name)}" style="max-height:{h}px;max-width:{maxw}px;width:auto;height:auto">'
        return f'<span class="{cls} lg-txt" style="font-size:{int(h * 0.8)}px">{esc(slug.upper())}</span>'

    def motion_kit(self) -> None:
        """GSAP, the Motion pack's kit.js and kit.css, and its fonts (decoded from .b64) into the asset folder."""
        shutil.copy2(self.film.gsap or gsap_file(), self.folder / "gsap.min.js")
        kit = self.film.motion_kit or motion_kit_folder()
        for name in ("kit.js", "kit.css"):
            shutil.copy2(kit / name, self.folder / name)
        fonts = self.folder / "fonts"
        fonts.mkdir(exist_ok=True)
        for b64 in (kit / "fonts").glob("*.b64"):
            dst = fonts / b64.stem
            if not dst.exists():
                dst.write_bytes(base64.b64decode(b64.read_text()))
