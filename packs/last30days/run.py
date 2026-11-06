import json
import os
import runpy
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parent / "skills" / "last30days" / "scripts" / "last30days.py"
CONNECTORS = Path.home() / ".config" / "dimension-last30days"
FORCED = {"FROM_BROWSER": "off", "BROWSER_CONSENT": "false", "LAST30DAYS_TRUST_PROJECT_CONFIG": "false"}
CONNECTOR_FIELDS = {
    "scrapecreators.json": {"access": "SCRAPECREATORS_API_KEY"},
    "bluesky.json": {"handle": "BSKY_HANDLE", "access": "BSKY_APP_PASSWORD"},
}


def is_printable_ascii(value):
    return isinstance(value, str) and value.strip() != "" and all(32 <= ord(char) < 127 for char in value)


def connector_env():
    found = {}
    for file_name, fields in CONNECTOR_FIELDS.items():
        try:
            stored = json.loads((CONNECTORS / file_name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        values = {name: stored.get(field, "").strip().lstrip("@") for field, name in fields.items()}
        refused = [name for name, value in values.items() if not is_printable_ascii(value)]
        if refused:
            sys.stderr.write(f"[dimension] {file_name}: {', '.join(refused)} empty or not printable ASCII; reconnect it on the last30days card\n")
            continue
        found.update(values)
    return found


os.environ.update(connector_env())
os.environ.update(FORCED)
arguments = sys.argv[1:]
if "--no-browser-cookies" not in arguments:
    arguments.append("--no-browser-cookies")
sys.argv = [str(ENGINE), *arguments]
sys.path.insert(0, str(ENGINE.parent))
runpy.run_path(str(ENGINE), run_name="__main__")
