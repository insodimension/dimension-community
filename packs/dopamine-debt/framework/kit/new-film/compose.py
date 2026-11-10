"""build/timeline.json -> build/film/index.html + build/layout.json, through DD/framework/kit/compose.py."""
from __future__ import annotations

from film import FILM

from framework.kit import compose

if __name__ == "__main__":
    compose.write(FILM)
    print("wrote", FILM.page_dir / "index.html")
