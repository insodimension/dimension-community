"""script/lines.json + voice takes -> build/timeline.json, through DD/framework/kit/timeline.py."""
from __future__ import annotations

from film import FILM

from framework.kit import timeline

if __name__ == "__main__":
    built = timeline.write(FILM)
    print("duration", built["duration"], "items", len(built["items"]))
