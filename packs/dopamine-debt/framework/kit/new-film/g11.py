"""This film's G11, through DD/framework/kit/g11plan.py (the shared `framework/g11.Plan` filled from the build).

    python g11.py [../proof/film-X]      code rules -> build/g11.json (judge rules listed as unchecked until judged)
    eval: judged(completion)          adds the judge rules
"""
from __future__ import annotations

import sys
from pathlib import Path

from film import FILM

from framework.kit import g11plan


def judged(completion, film_x: Path | None = None) -> dict:
    return g11plan.judged(FILM, completion, film_x)


if __name__ == "__main__":
    g11plan.checked(FILM, Path(sys.argv[1]) if len(sys.argv) > 1 else None)
