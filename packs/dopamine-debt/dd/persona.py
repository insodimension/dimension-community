import hashlib
import re

SECTION_KEYS = [
    ("core", ("core", "who")),
    ("floor", ("floor",)),
    ("knowledge", ("knowledge",)),
    ("humour", ("humour", "humor", "laugh")),
    ("cringe", ("cringe",)),
]


def _sections(md):
    out = {}
    cur = None
    for line in md.splitlines():
        m = re.match(r"^#{1,4}\s+(.*)", line)
        if m:
            head = m.group(1).lower()
            cur = None
            for key, words in SECTION_KEYS:
                if any(w in head for w in words) and key not in out:
                    cur = key
                    out[key] = []
                    break
            continue
        if cur:
            out[cur].append(line)
    return {k: "\n".join(v) for k, v in out.items()}


def _clean(text):
    text = re.sub(r"\[(S\d+[^\]]*|[a-z]+:[^\]]*|unverified[^\]]*|verified[^\]]*|revised[^\]]*|inferred[^\]]*)\]", "", text, flags=re.I)
    text = re.sub(r"`|\*\*|__|\*", "", text)
    rows = []
    for line in text.splitlines():
        s = line.strip()
        if not s or set(s) <= set("|-: "):
            continue
        if s.startswith("|"):
            cells = [c.strip() for c in s.strip("|").split("|") if c.strip()]
            s = " — ".join(cells[:3])
        s = re.sub(r"^[-*]\s+", "", s)
        rows.append(s)
    return " ".join(rows)


def _trim(words, n):
    return " ".join(words.split()[:n])


def compile_card(md, budget=250):
    sec = _sections(md)
    parts = {k: _clean(sec.get(k, "")) for k, _ in SECTION_KEYS}
    if not parts["core"]:
        raise ValueError("persona has no core/who section")
    share = {"core": 0.25, "floor": 0.15, "knowledge": 0.25, "humour": 0.2, "cringe": 0.15}
    a = (
        f"The viewer: {_trim(parts['core'], int(budget*share['core']))} "
        f"The least-informed viewer in this audience: {_trim(parts['floor'], int(budget*share['floor']))} "
        f"What they know and don't: {_trim(parts['knowledge'], int(budget*share['knowledge']))} "
        f"What makes them laugh: {_trim(parts['humour'], int(budget*share['humour']))} "
        f"What makes them cringe: {_trim(parts['cringe'], int(budget*share['cringe']))} "
        "They hear each line once, at speaking speed."
    )
    b = (
        f"Picture this person watching: they {_trim(parts['floor'] or parts['core'], int(budget*share['floor']))} "
        f"Background: {_trim(parts['knowledge'], int(budget*share['knowledge']))} "
        f"They cringe at: {_trim(parts['cringe'], int(budget*share['cringe']))} "
        f"They laugh at: {_trim(parts['humour'], int(budget*share['humour']))} "
        f"In short: {_trim(parts['core'], int(budget*share['core']))} "
        "One viewing, no rewinding."
    )
    a = re.sub(r"\s+", " ", a).strip()
    b = re.sub(r"\s+", " ", b).strip()
    h = hashlib.sha256((a + "\n" + b).encode()).hexdigest()[:16]
    return {"A": a, "B": b, "hash": h, "words": len(a.split())}
