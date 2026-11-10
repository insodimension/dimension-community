"""This production as a kit film: everything below is the film's own content; the machinery is DD/framework/kit
(README.md there holds the lines.json contract). DD is the installed Dopamine Debt kit, found each time this runs:
DD_ROOT when it is set, else what `inso dd root` (or `omp dd root`) prints, so an update of the kit never breaks
this file. The revision sits in `dd.home.films_for(ROOT)`, the folder the Video editor's script_gate hashes and the
house gate reads."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def kit_root() -> Path:
    if os.environ.get("DD_ROOT"):
        return Path(os.environ["DD_ROOT"])
    for host in ("inso", "omp"):
        exe = shutil.which(host)
        if not exe:
            continue
        out = subprocess.run([exe, "dd", "root"], capture_output=True, text=True, encoding="utf-8", errors="replace",
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        found = out.stdout.strip().splitlines()[-1:] if out.returncode == 0 else []
        if found and (Path(found[0]) / "dd" / "home.py").is_file():
            return Path(found[0])
    raise SystemExit("film.py: the Dopamine Debt kit was not found: `inso dd root` printed no kit folder; install the "
                     "Video space, or set DD_ROOT to the kit folder")


DD = kit_root()
sys.path.insert(0, str(DD))

from dd.home import films_for  # noqa: E402
from framework.kit import Film, stage  # noqa: E402

import scenes  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

FILM = Film(
    root=ROOT,
    revision=films_for(ROOT) / "__FILM__" / "__REV__",
    spoken_forms=[],
    scenes=stage.SCENES,
    scene_css=stage.CSS + scenes.CSS,
    music=[("M1", None)],
    receipt_read_px=38,
    persona="__SLUG__.md",
)
