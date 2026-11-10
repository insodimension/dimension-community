"""What one film hands the kit: its production folder and the content that is the film's alone.

Everything the kit reads or writes sits at a fixed place under `root` (the production layout in README.md); the
fields below are what differs between films. A film builds one `Film` and passes it to every kit call.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Mapping, Sequence

from dd.home import ENGINE_HOME, LIBRARY

SceneFn = Callable[..., tuple[str, list[str]]]
SpokenForms = Sequence[tuple[str, str]]
MOTION_PACK_FOLDERS = ("motion", "@dimension/motion")
GSAP_PIN = "gsap@3.14.2"
GLOBAL_NODE_MODULES = (
    Path.home() / ".bun" / "install" / "global" / "node_modules",
    Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "npm" / "node_modules",
    Path("/usr/local/lib/node_modules"),
    Path("/opt/homebrew/lib/node_modules"),
    Path("/usr/lib/node_modules"),
)


def motion_kit_folder() -> Path:
    """The Motion pack's kit folder (kit.js, kit.css, fonts/): DD_MOTION_KIT, else the Motion pack installed in the engine
    home's plugin store (it ships with Dimension and lands at `plugins/node_modules/motion`; a store or linked copy
    lands under its package name)."""
    tried = [Path(os.environ["DD_MOTION_KIT"])] if os.environ.get("DD_MOTION_KIT") else []
    tried += [ENGINE_HOME / "plugins" / "node_modules" / folder / "kit" for folder in MOTION_PACK_FOLDERS]
    for kit in tried:
        if (kit / "kit.js").is_file() and (kit / "kit.css").is_file():
            return kit
    raise FileNotFoundError("the page needs the Motion pack's kit (kit.js, kit.css), and it is in none of "
                            + ", ".join(str(k) for k in tried) + ": enable Motion in Plugins, or set DD_MOTION_KIT to its kit folder")


def gsap_file() -> Path:
    """The GSAP build the page loads: DD_GSAP, else the global install Motion's setup makes (`bun add --global` or
    `npm install --global` of the pin)."""
    tried = [Path(os.environ["DD_GSAP"])] if os.environ.get("DD_GSAP") else []
    tried += [root / "gsap" / "dist" / "gsap.min.js" for root in GLOBAL_NODE_MODULES]
    for gsap in tried:
        if gsap.is_file():
            return gsap
    raise FileNotFoundError("the page needs GSAP, and it is in none of " + ", ".join(str(g) for g in tried)
                            + f": run Motion's setup in Plugins, or `bun add --global {GSAP_PIN}`, or set DD_GSAP")


@dataclass(frozen=True)
class MixLevels:
    """Stem levels of the delivery mix (stages.md Delivery): voice is the anchor, the bed sits far under it and
    ducks under every clip or meme that plays its own sound, and the whole mix lands on the platform loudness."""
    target_lufs: float = -14.0
    true_peak_db: float = -1.5
    voice_lufs: float = -19.0
    clip_lufs: float = -19.0
    music_lufs: float = -33.0
    music_duck_db: float = -9.0


@dataclass(frozen=True)
class Film:
    """One film's configuration.

    root: the production folder (`dd.home.PRODUCTIONS / <slug>`).
    revision: the Dopamine Debt film revision (`dd.home.films_for(root) / <film> / <rev>`) whose `script/lines.json` and
        `spine.yaml` the house gate reads; None keeps both in the production's `script/`.
    desk_until_line: the line that ends the cold open's fake desktop; None when the film has no desk.
    desk_html: the desk's markup (icons, taskbar) drawn from 0 s to that line.
    backdrops: line id -> `media/stock/<name>.jpg` stem shown full frame behind that line.
    cutout: the host cutout image a CUT picture draws; poses: pose name -> {x, y, h, flip, rot, slide?}
        (an unknown pose draws as "stand").
    spoken_forms: (written, spoken) replacements the voice takes were recorded with, in order.
    scenes / scene_css: the film's own MG templates and their CSS, beside the kit's.
    music: (cue, from line id) beds in order; the first starts at 0 (its line is None) and each plays until the next
        one's line starts. Cue files are `media/music/<cue>.mp3`.
    levels: the mix levels.
    receipt_read_px: when set, every receipt after the cold open reads its highlight to the viewer: after an
        establishing beat a camera inside the card zooms toward the highlighted words until their capital letters stand
        this many frame pixels tall, panning along the highlighted lines when they do not fit at that size. The card
        itself stays in place (inside the safe area, its source chip beside it). None keeps the card's slow push.
    persona: the topic persona file under `personas/` the judge reads its Core and Floor from.
    library: the shared media library.
    motion_kit / gsap: the Motion pack's kit folder and the GSAP build the page loads; None finds them when the page is
        composed (`motion_kit_folder()`, `gsap_file()`).
    """
    root: Path
    revision: Path | None = None
    desk_until_line: str | None = None
    desk_html: str = ""
    backdrops: Mapping[str, str] = field(default_factory=dict)
    cutout: Path | None = None
    poses: Mapping[str, Mapping[str, float | bool]] = field(default_factory=dict)
    spoken_forms: SpokenForms = ()
    scenes: Mapping[str, SceneFn] = field(default_factory=dict)
    scene_css: str = ""
    music: Sequence[tuple[str, str | None]] = ()
    levels: MixLevels = MixLevels()
    receipt_read_px: float | None = None
    persona: str | None = None
    library: Path = LIBRARY
    motion_kit: Path | None = None
    gsap: Path | None = None

    @property
    def build(self) -> Path:
        return self.root / "build"

    @property
    def lines_file(self) -> Path:
        return (self.revision or self.root) / "script" / "lines.json"

    @property
    def spine_file(self) -> Path:
        return self.revision / "spine.yaml" if self.revision else self.root / "script" / "spine.yaml"

    @property
    def timeline_file(self) -> Path:
        return self.build / "timeline.json"

    @property
    def layout_file(self) -> Path:
        return self.build / "layout.json"

    @property
    def g11_file(self) -> Path:
        return self.build / "g11.json"

    @property
    def page_dir(self) -> Path:
        return self.build / "film"

    @property
    def css_file(self) -> Path:
        return self.build / "film.css"

    @property
    def word_cache(self) -> Path:
        return self.build / "cache" / "meme-words.json"

    @property
    def voice_dir(self) -> Path:
        return self.root / "voice"

    @property
    def media(self) -> Path:
        return self.root / "media"
