"""The YouTube description, written from what the cut uses: facts in order of first appearance, then the pages, clips,
posts, memes and logos the timeline puts on screen. Credits live here, never on an end card (G11 no-end-card).

    description.write(film, intro, outro, extra=[("PHOTOS", ["- ..."])])  -> film.root / "youtube-description.md"

A line names its facts in `facts` or `sources` (ids in research/facts.json); a clip row's record is
media/clips/<id>.json; a post is found in media/sourcing/posts.json by its id, else by the 15+ digit status id in it.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Iterable, Sequence

from .film import Film


def short(s: str, n: int = 160) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0] + "…"


def _json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def _clip_credit(r: dict) -> str:
    title = f", \"{r['video_title']}\"" if r.get("video_title") else ""
    when = ", ".join(x for x in (r.get("published"), r.get("source_timestamp")) if x)
    return f"- {r['creator']}{title}{f' ({when})' if when else ''}: {r.get('video_url') or r.get('url')}"


def _post_credit(p: dict) -> str:
    who = " ".join(x for x in (p.get("author"), p.get("handle")) if x)
    return f"- {who}, {str(p.get('published_utc', ''))[:10]}: {p['url']}"


def sections(film: Film) -> list[tuple[str, list[str]]]:
    lines = _json(film.lines_file)
    facts = {f["id"]: f for f in _json(film.root / "research" / "facts.json")}
    items = _json(film.timeline_file)["items"]
    out: list[tuple[str, list[str]]] = []
    seen: list[str] = []
    for line in lines:
        for fid in list(line.get("facts", [])) + list(line.get("sources", [])):
            if fid in facts and fid not in seen:
                seen.append(fid)
    out.append(("SOURCES (facts and quotes, in order of appearance)",
                [f"- {short(facts[f]['claim'])} | {short(facts[f]['outlet'], 120)}, {facts[f]['date']}: {facts[f]['source_url']}" for f in seen]))
    docs = list(dict.fromkeys(it["id"] for it in items if it["kind"] == "doc"))
    rows = []
    for d in docs:
        rec = _json(film.media / "captures" / f"{d}.asset.json")
        rows.append(f"- {rec.get('outlet', d)}, captured {rec['capturedAt'][:10]}: {rec.get('originalUrl') or rec['sourceUrl']}")
    out.append(("ON-SCREEN PAGES", list(dict.fromkeys(rows))))
    clips = [l for l in lines if l["speaker"] == "clip"]
    out.append(("CLIPS (commentary use)", [_clip_credit(_json(film.media / "clips" / f"{l['pictures'][0]['id']}.json")) for l in clips]))
    used = list(dict.fromkeys(it["id"] for it in items if it["kind"] == "post"))
    if used:
        posts = {p["id"]: p for p in _json(film.media / "sourcing" / "posts.json")["posts"]}
        rows = []
        for pid in used:
            sid = next(iter(re.findall(r"\d{15,}", pid)), None)
            p = posts.get(pid) or posts.get(sid)
            if p:
                rows.append(_post_credit(p))
        out.append(("POSTS", rows))
    rows = []
    for lib in dict.fromkeys(it["lib"] for it in items if it["kind"] == "meme"):
        e = _json(film.library / lib / "entry.json")
        rows.append(f"- {e['name']}: {e.get('origin') or e.get('credit')}")
    out.append(("MEMES (commentary/parody)", rows))
    logos = sorted({Path(m).stem.removesuffix("-white") for m in re.findall(r"media/logos/([\w.-]+)", json.dumps(lines))} |
                   {r.get("logo") for l in lines for p in l["pictures"] if p["k"] == "MG"
                    for r in (p.get("rows", []) + p.get("items", []) + p.get("sides", []) + [p]) if isinstance(r, dict) and r.get("logo")})
    if logos:
        out.append(("LOGOS (trademarks of their owners, shown to identify them; no endorsement)",
                    [f"- {(rec := _json(film.media / 'logos' / f'{s}.asset.json'))['brand']}: {rec['filePageUrl']}" for s in logos]))
    return out


def write(film: Film, intro: str, outro: str, extra: Iterable[tuple[str, Sequence[str]]] = ()) -> Path:
    parts = [intro]
    for head, rows in [*sections(film), *extra]:
        if rows:
            parts += ["", head, *rows]
    parts += ["", outro, ""]
    path = film.root / "youtube-description.md"
    path.write_text("\n".join(parts), encoding="utf-8")
    return path
