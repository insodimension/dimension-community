"""Write youtube-description.md from what the cut uses, through DD/framework/kit/description.py. Run after timeline.py.
INTRO is the film's own pitch and comedy disclaimer; OUTRO names the primary sources, the voice and the music."""
from __future__ import annotations

from film import FILM

from framework.kit import description

INTRO = ""
OUTRO = ""

if __name__ == "__main__":
    print("wrote", description.write(FILM, INTRO, OUTRO))
