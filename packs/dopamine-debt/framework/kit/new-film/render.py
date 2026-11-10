"""Picture render, mix, decode check and proof instrument for this film, through DD/framework/kit/render.py.

    python render.py              render build/film, mix into renders/<production>-1080p.mp4, check, instrument
    python render.py --mix-only   reuse build/renders/picture.mp4
"""
from __future__ import annotations

import sys

from film import FILM

from framework.kit import render

if __name__ == "__main__":
    render.main(FILM, "--mix-only" in sys.argv)
