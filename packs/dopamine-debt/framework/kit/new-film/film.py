"""This production as a kit film: everything below is the film's own content; the machinery is DD/framework/kit
(README.md there holds the lines.json contract). `dd new-film` wrote this file with the plugin root it ran from;
DD_ROOT overrides it. The revision sits in `dd.home.films_for(ROOT)`, the folder the Video editor's script_gate
hashes and the house gate reads."""
from __future__ import annotations

import os
import sys
from pathlib import Path

DD = Path(os.environ.get("DD_ROOT") or r"__DD__")
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
