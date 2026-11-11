import asyncio
import json

import pytest
import yaml

from dd import house

JUDGE_LABEL = "typesafe/jev-1.14.0"

LINES = [
    ("v1", "a1", "b1", ["F1"], "Acme Widgets announced a new pricing plan on Tuesday."),
    ("v2", "a1", "b1", [], "The plan costs forty dollars a month, which is the old price with a new name."),
    ("v3", "a1", "b2", ["F2"], "Customers get three widgets, and each widget is the same widget."),
    ("v4", "a2", "b3", [], "A spokesperson called this simplification, which is one word for it."),
    ("v5", "a2", "b3", ["F3"], "The company says nobody will notice, and so far nobody has."),
    ("v6", "a2", "b4", [], "Analysts described the move as bold, in the way a flat tire is bold."),
    ("v7", "a3", "b5", [], "Acme reports the new plan is going well, which is what Acme reports."),
    ("v8", "a3", "b5", [], "The old plan remains available for forty dollars a month."),
]

SPINE = {
    "packaging": {"title": "Acme Widgets prices", "thumbnail": "a widget with a price tag", "promise_q": "Is the plan new?", "confirmed_by_s": 10, "answered_in": "last-25%"},
    "premise": "Acme says the plan is new but sells the old one",
    "take": "A rename is not a new plan.",
    "narrator": {"stance": "unimpressed", "flaw": "keeps counting the widgets", "never": ["explains a joke"]},
    "voice_mode": "deadpan",
    "anchor_world": {"analogy": "a menu reprint", "maps": "price to menu", "breaks_at": "the kitchen", "extensions": ["the specials"], "lines": ["v3"]},
    "money_object": {"graphic": "price tag", "unit": "dollars"},
    "retell": ["the plan is the old plan"],
    "retell_facts": {"R1": "the plan costs forty dollars", "R2": "the widgets are identical", "R3": "the old plan is still sold"},
    "acts": [
        {"id": "a1", "job": "set up the claim", "turn": "but", "stake_rung": 1, "opens_loop": "is it new", "button_seed": "same widget"},
        {"id": "a2", "job": "the spokesperson", "turn": "therefore", "stake_rung": 2, "opens_loop": "who notices", "button_seed": "nobody"},
        {"id": "a3", "job": "the numbers", "turn": "but", "stake_rung": 3, "opens_loop": "what changed", "button_seed": "the price"},
    ],
    "callbacks": [],
}

INTENT = {
    "film": "acme-widgets",
    "retell": [{"id": f"R{i}", "sentence": f"retell {i}", "facts": [{"id": f"F{i}", "text": f"fact {i}", "sources": ["S1"]}]} for i in (1, 2, 3)],
    "support": [],
    "ending": "the old plan",
}


def lines_json(edit=None):
    rows = []
    for uid, act, bit, carries, text in LINES:
        rows.append({"id": uid, "kind": "voice", "act": act, "bit": bit, "carries": carries, "text": edit if edit and uid == "v2" else text, "speaker": "narrator", "pictures": []})
    return rows


@pytest.fixture
def production(tmp_path):
    brand = tmp_path / "brand"
    prod = brand / "productions" / "acme"
    rev = brand / "productions" / "dopamine-debt" / "films" / "acme" / "r1"
    (rev / "script").mkdir(parents=True)
    prod.mkdir(parents=True)
    (prod / "dopamine-debt.json").write_text(json.dumps({"revision": "acme/r1", "audiences": {"channel": "personas/channel/ai-news.md"}}), encoding="utf8")
    (rev / "script" / "lines.json").write_text(json.dumps(lines_json()), encoding="utf8")
    (rev / "spine.yaml").write_text(yaml.safe_dump(SPINE), encoding="utf8")
    (rev / "intent.json").write_text(json.dumps(INTENT), encoding="utf8")
    return prod


def engine_dir(production):
    return production.parent / "dopamine-debt" / "films" / "acme" / "r1" / "framework" / "script"


def answer_for(question):
    kind = question["type"]
    if kind == "bool":
        return {"type": "bool", "bool": 0.7}
    labels = list(question["criteria"])
    if kind == "score":
        return {"type": "score", "score": 1.0, "probabilities": {str(i): 1 / len(labels) for i in range(len(labels))}, "confidence": 0.5}
    weights = {"laugh": 0.6, "smile": 0.2, "flat": 0.1, "cringe": 0.1, "lost": 0.05, "followed": 0.6, "clicked": 0.35}
    return {"type": "choice", "choice": labels[0], "probabilities": {k: weights.get(k, 1 / len(labels)) for k in labels}, "confidence": 0.5}


class FakeBatch:
    def __init__(self, items, questions):
        self.items = items
        self.answers = {k: {q: answer_for(spec) for q, spec in questions.items()} for k in items}

    async def drain(self, timeout=None):
        done, self.items = self.items, {}
        return [(k, type("Item", (), {"answers": self.answers[k], "error": None})()) for k in done]

    def status(self):
        return {"done": 1, "total": 1}


class Session:
    def __init__(self):
        self.judged = 0
        self.completions = []

    def judge_batch(self, items, questions, intent=""):
        self.judged += len(items)
        return FakeBatch(items, questions)

    def completion(self, prompt, model="default", system=None, schema=None):
        self.completions.append(model)
        answer = {"cringe": 0.1, "laugh": 0.6, "reason": "fine"} if "cringe" in schema["properties"] else {"keep_watching": 0.8, "left_at_s": 0, "reason": "fine"}
        return type("Handle", (), {"wait": lambda self: answer})()


def review(production, session, juror_model="vendor/model-a", juror_role="default"):
    return asyncio.run(house.review("script", production, session.judge_batch, session.completion, juror_model, juror_role))


def gate(production, tmp_path):
    report = tmp_path / "report.json"
    code = house.run("script", production, report)
    return code, json.loads(report.read_text(encoding="utf8"))


def test_a_gate_with_no_review_cannot_run_and_names_the_review(production, tmp_path):
    code, report = gate(production, tmp_path)
    assert code == 2
    assert any("review" in m for m in report["missing"])
    assert not (engine_dir(production) / "cache.jsonl").exists()


def test_a_reviewed_gate_runs_and_names_every_model_that_answered(production, tmp_path):
    session = Session()
    review(production, session)
    code, report = gate(production, tmp_path)
    assert code in (0, 1)
    assert report["answered_by"]["readouts"] == {JUDGE_LABEL: session.judged}
    assert set(report["answered_by"]["jurors"]) == {"vendor/model-a"}
    assert set(session.completions) == {"default"}


def test_the_gate_reads_the_reviewer_the_review_recorded(production, tmp_path):
    review(production, Session(), juror_model="vendor/model-a", juror_role="slow")
    gate(production, tmp_path)
    root = json.loads((engine_dir(production) / "root.json").read_text(encoding="utf8"))
    assert (root["juror_model"], root["juror_role"]) == ("vendor/model-a", "slow")


def test_a_juror_answer_is_reused_only_for_the_model_that_gave_it(production, tmp_path):
    first = Session()
    review(production, first, juror_model="vendor/model-a")
    again = Session()
    review(production, again, juror_model="vendor/model-a")
    assert again.completions == []
    other = Session()
    review(production, other, juror_model="vendor/model-b")
    assert len(other.completions) == len(first.completions) > 0
    code, report = gate(production, tmp_path)
    assert set(report["answered_by"]["jurors"]) == {"vendor/model-b"}


def test_editing_the_script_after_a_review_sends_the_gate_back_to_the_review(production, tmp_path):
    review(production, Session())
    lines = production.parent / "dopamine-debt" / "films" / "acme" / "r1" / "script" / "lines.json"
    lines.write_text(json.dumps(lines_json(edit="The plan costs forty dollars a month, now with a ribbon.")), encoding="utf8")
    code, report = gate(production, tmp_path)
    assert code == 2
    assert any("unanswered" in m for m in report["missing"])


def test_an_unknown_juror_role_is_refused_before_any_model_is_called(production):
    session = Session()
    with pytest.raises(ValueError, match="juror_role"):
        review(production, session, juror_role="gpt")
    assert session.judged == 0
    assert session.completions == []
