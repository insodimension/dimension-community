import inspect
import json
from pathlib import Path

from .home import LIBRARY
from .persona import compile_card
from .run import Cache, jurors_needed, read_film, watch_needed

DD = Path(__file__).resolve().parents[1]
JUROR_CONCURRENCY = 6
JUROR_ATTEMPTS = 3


def load_jsonl(p):
    p = Path(p)
    return [json.loads(x) for x in p.read_text(encoding="utf8").splitlines() if x.strip()] if p.exists() else []


def write_jsonl(p, rows):
    Path(p).write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf8")


def tunables():
    return json.loads((DD / "tunables.json").read_text(encoding="utf8"))


def context(film_dir):
    film_dir = Path(film_dir)
    root = json.loads((film_dir / "root.json").read_text(encoding="utf8"))
    tun = tunables()
    cards = {aud: compile_card((DD / p).read_text(encoding="utf8")) for aud, p in root["audiences"].items()}
    return {"dir": film_dir, "root": root, "tun": tun, "cards": cards, "model": tun["judge_model"],
            "window": tun["values"]["before_window_s"]["v"], "trigger": tun["values"]["juror_trigger"]["v"],
            "cache": film_dir / "cache.jsonl", "jury_cache": film_dir / "jury-cache.jsonl"}


def library_ids(segments):
    ids = {s["library"] for s in segments if s.get("library") and not s["library"].startswith("fetch-")}
    return sorted(i for i in ids if (LIBRARY / i / "entry.json").is_file())


def load_film(film_dir, tun):
    film_dir = Path(film_dir)
    film = {k: json.loads((film_dir / f"{k}.json").read_text(encoding="utf8")) for k in ("segments", "intent", "spine")}
    return film | {"judge_model": tun["judge_model"], "library": library_ids(film["segments"])}


async def _settle(h):
    r = h.wait()
    if inspect.isawaitable(r):
        r = await r
    return json.loads(r) if isinstance(r, str) else r


async def _jury(completion, todo, cache):
    pending = list(todo)
    for _ in range(JUROR_ATTEMPTS):
        failed = []
        for i in range(0, len(pending), JUROR_CONCURRENCY):
            wave = pending[i:i + JUROR_CONCURRENCY]
            handles = [(n, completion(n["prompt"], model=n["model"], schema=n["schema"])) for n in wave]
            for n, h in handles:
                try:
                    ans = await _settle(h)
                except Exception as e:
                    failed.append((n, e))
                    continue
                cache.put({"key": n["key"], "kind": n["kind"], "unit": n["unit"], "aud": n["aud"], "model": n["model"], "answers": ans} | ({"draw": n["draw"]} if "draw" in n else {}))
        pending = [n for n, _ in failed]
        if not pending:
            return
    raise RuntimeError(f"juror returned no answer for {len(pending)} bits: {[(n['unit'], n['aud']) for n in pending[:3]]}")


async def read(film_dir, judge_batch, completion):
    c = context(film_dir)
    root = c["root"]
    film = load_film(c["dir"], c["tun"])
    readouts, judged = await read_film(film, c["cards"], judge_batch, c["cache"], c["model"], c["window"], root["stage"])
    needs = jurors_needed(film, c["cards"], readouts, c["window"], root["juror_model"], c["trigger"])
    watch = watch_needed(film, c["cards"], root["juror_model"]) if root.get("kind") == "seen" else []
    jcache = Cache(c["jury_cache"])
    todo = [n for n in needs + watch if not jcache.get(n["key"])]
    await _jury(completion, todo, jcache)
    jurors = [jcache.get(n["key"]) for n in needs]
    write_jsonl(c["dir"] / "readouts.jsonl", readouts)
    write_jsonl(c["dir"] / "jury.jsonl", jurors)
    return {"readouts": len(readouts), "judged": judged, "jurors": len(needs), "watch_reads": len(watch), "juror_calls": len(todo)}
