import os
import re
from pathlib import Path

import yaml

KIT = Path(__file__).resolve().parents[1]
ENGINE_HOME = Path(os.environ.get("DD_ENGINE_HOME") or os.environ.get("INSO_HOME", "").strip() or Path.home() / ".inso")
PRODUCTIONS = ENGINE_HOME / "productions"
WORK = PRODUCTIONS / "dopamine-debt"
LIBRARY = ENGINE_HOME / "media-library"
TOOLS = ENGINE_HOME / "agent" / "tools"
SETTINGS_GROUP = "mediaGen"
VOICE_ID_SHAPE = re.compile(r"^[a-zA-Z0-9_-]+$")


def films_for(production) -> Path:
    """The Dopamine Debt films folder a production's revision lives in: DD_FILMS_ROOT, else the brand's
    `productions/dopamine-debt/films` beside the production (where the editor's script_gate hashes it)."""
    return Path(os.environ.get("DD_FILMS_ROOT") or brand_dir(production) / "films")


def brand_dir(production) -> Path:
    """The brand's own Dopamine Debt folder, `productions/dopamine-debt` beside the production. What the person makes
    for the kit (topic personas, their own channel persona) lives here, so an update of the kit never removes it."""
    return Path(production).parent / "dopamine-debt"


def audience_file(path, production=None) -> Path:
    """A persona named in `dopamine-debt.json`: an absolute path as given; a relative one from the brand's own folder
    when it holds that file, else from the kit (the shipped channel persona)."""
    p = Path(path)
    if p.is_absolute():
        return p
    if production is not None and (brand_dir(production) / p).is_file():
        return brand_dir(production) / p
    return KIT / p


def music_ledger(production) -> Path:
    """The brand's music ledger: the beds the person approved, praised or rejected (`inso dd import` carries an earlier one in)."""
    return brand_dir(production) / "music.json"


def marks_file(production) -> Path:
    """The brand's marks ledger: every review note, labelled, that `framework.g11.calibrate` scores the judge on."""
    return brand_dir(production) / "calibration" / "marks.jsonl"


def persona_kind(path) -> str | None:
    """The `kind:` in a persona's front matter (channel or topic), None when it names none."""
    p = Path(path)
    if not p.is_file():
        return None
    lines = p.read_text(encoding="utf8").splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for line in lines[1:]:
        if line.strip() == "---":
            return None
        key, _, value = line.partition(":")
        if key.strip() == "kind":
            return value.strip() or None
    return None


def brand_kit(production) -> Path | None:
    """The brand kit `<brand>/brand/` of a production at `<brand>/productions/<id>/` (the Video space's brand folder);
    None for a production under the engine's own `PRODUCTIONS`, or outside a `productions/` folder, which belongs to no brand."""
    productions = Path(production).parent
    return productions.parent / "brand" if productions.name == "productions" and productions != PRODUCTIONS else None


def settings_voice() -> str | None:
    """The default voice the person set in Settings, Media generation: `mediaGen.voiceId` in the engine's `config.yml`
    (`PI_CODING_AGENT_DIR`, else `<engine home>/agent`), read and shape-checked as the media-gen provider reads it. None
    when unset, not a voice id, or the file is absent or unreadable."""
    config = Path(os.environ.get("PI_CODING_AGENT_DIR") or ENGINE_HOME / "agent") / "config.yml"
    try:
        parsed = yaml.safe_load(config.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return None
    group = parsed.get(SETTINGS_GROUP) if isinstance(parsed, dict) else None
    voice_id = group.get("voiceId") if isinstance(group, dict) else None
    voice_id = voice_id.strip() if isinstance(voice_id, str) else ""
    return voice_id if VOICE_ID_SHAPE.match(voice_id) else None
