"""G11: a rule measured on nothing passes; a rule not measured stays unchecked. A first film has no posts."""
import json

from framework import g11, scriptstage
from framework.kit import g11plan
from framework.kit.film import Film

MEASURED = ("safe-corners", "no-lower-thirds", "real-sources")


def test_measured_and_empty_passes():
    code = g11.code_checks(g11.Plan(duration=10.0, labels=[], boxes=[], sources=[]))
    assert {r: code.get(r) for r in MEASURED} == {r: [] for r in MEASURED}


def test_not_measured_stays_unchecked():
    code = g11.code_checks(g11.Plan(duration=10.0))
    assert not any(r in code for r in MEASURED)


def test_a_film_with_no_posts_builds_its_plan(tmp_path, monkeypatch):
    film = Film(root=tmp_path)
    (tmp_path / "build").mkdir()
    (tmp_path / "script").mkdir()
    (tmp_path / "build" / "timeline.json").write_text(json.dumps({"items": [{"kind": "mg", "id": "s1", "start": 0.0, "end": 5.0}]}), encoding="utf-8")
    (tmp_path / "build" / "layout.json").write_text(json.dumps({"labels": [], "boxes": [], "changes": [], "pictures": [], "scenes": []}), encoding="utf-8")
    (tmp_path / "script" / "lines.json").write_text("[]", encoding="utf-8")
    (tmp_path / "script" / "spine.yaml").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(g11plan, "measure_page", lambda _film: ([], [], []))
    plan = g11plan.plan(film)
    assert plan.sources == [] and plan.labels == [] and plan.boxes == []


def test_the_script_read_names_every_meme_mode():
    assert {"framed", "sound"} <= set(scriptstage.MODE_TEXT)
