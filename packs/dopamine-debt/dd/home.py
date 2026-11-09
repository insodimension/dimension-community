import os
from pathlib import Path

ENGINE_HOME = Path(os.environ.get("DD_ENGINE_HOME") or os.environ.get("INSO_HOME", "").strip() or Path.home() / ".inso")
PRODUCTIONS = ENGINE_HOME / "productions"
WORK = PRODUCTIONS / "dopamine-debt"
LIBRARY = ENGINE_HOME / "media-library"
TOOLS = ENGINE_HOME / "agent" / "tools"


def films_for(production) -> Path:
    """The Dopamine Debt films folder a production's revision lives in: DD_FILMS_ROOT, else the brand's
    `productions/dopamine-debt/films` beside the production (where the editor's script_gate hashes it)."""
    return Path(os.environ.get("DD_FILMS_ROOT") or Path(production).parent / "dopamine-debt" / "films")
