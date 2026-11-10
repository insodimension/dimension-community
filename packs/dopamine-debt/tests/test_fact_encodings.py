import re

import pytest

from dd.derive import derive, gates_for
from dd.read import tunables

FACT = "R1.a"
AUD = "a"
CARRY_S = 1.0


def voice(i, t0, t1, **marks):
    return {"id": f"v{i}", "kind": "voice", "t0": t0, "t1": t1, "line": "x", **marks}


def seg_read(unit, anchored):
    ans = {"probabilities": {"lost": 0.0, "clicked": 0.0}}
    return {"kind": "seg", "unit": unit, "aud": AUD, "card": "A", "answers": {"follow": ans, "follow_r": ans, "load": {"probabilities": {}}, "anchored": {"bool": anchored}}}


def g9(hits):
    """gates_for on a film that runs to the last of `hits` and carries one retell fact in a one-second voice unit ending at each of them.

    The last unit is the anchored statement. The length under which a film counts as short and the encodings it then needs are pinned to
    the ruling (2 under 60 s, 3 from 60 s up), so the test defends the formula, not whatever tunables.json holds today.
    """
    segs, readouts, carriers, at = [], [], [], 0.0
    for t in hits:
        if t - CARRY_S > at:
            segs.append(voice(len(segs), at, t - CARRY_S))
        segs.append(voice(len(segs), t - CARRY_S, t, carries=[FACT]))
        carriers.append(segs[-1]["id"])
        readouts.append({"kind": "carries", "unit": f"{carriers[-1]}::{FACT}", "answers": {"carries": {"bool": 1}}})
        at = t
    readouts.append(seg_read(carriers[-1], 1))
    film = {"spine": {}, "intent": {"retell": [{"facts": [{"id": FACT}]}]}, "segments": segs, "library": []}
    tun = tunables()
    tun["values"]["fact_encodings"]["v"].update(min=3, short_min=2, short_below_s=60)
    return gates_for(film, derive(film, readouts, [], tun, AUD), tun, set())["G9 Facts"]


def failing_facts(gate):
    return re.findall(r"(?:^|; )(\S+): \d+× in thirds", gate["detail"])


def test_the_shipped_tunables_carry_the_short_film_knee():
    fe = tunables()["values"]["fact_encodings"]["v"]
    assert (fe["min"], fe["short_min"], fe["short_below_s"]) == (3, 2, 60)


@pytest.mark.parametrize("hits, listed", [
    ([6, 20], False),
    ([20], True),
    ([10, 59], False),
    ([10, 60], True),
    ([10, 90], True),
    ([10, 50, 90], False),
], ids=["20 s film, 2 encodings", "20 s film, 1 encoding", "59 s film, 2 encodings: just under the knee", "60 s film, 2 encodings: the knee",
        "90 s film, 2 encodings", "90 s film, 3 encodings"])
def test_a_retell_fact_needs_two_encodings_in_a_film_under_a_minute_and_three_otherwise(hits, listed):
    assert failing_facts(g9(hits)) == ([FACT] if listed else [])
