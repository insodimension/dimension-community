import ast
import re

import pytest

from dd.derive import film_gates
from dd.read import tunables

PLANT_ENDS = 2.0


def seg(t0, t1, **marks):
    return {"kind": "voice", "t0": t0, "t1": t1, **marks}


def gates(runtime, gap):
    """film_gates on a film whose one callback is planted by a segment ending at 2 s and first called `gap` s later.

    The cap and the share are pinned to the ruling, min(60 s, 30% of the runtime), so the test defends the formula, not whatever
    tunables.json holds today.
    """
    call = PLANT_ENDS + gap
    segs = [seg(0.0, PLANT_ENDS, plants="cb"), seg(call, call + 1.0, calls="cb"), seg(runtime - 1.0, runtime)]
    tun = tunables()
    tun["values"]["callback_min_gap_s"]["v"] = 60
    tun["values"]["callback_min_gap_frac"]["v"] = 0.3
    return film_gates({"spine": {}, "segments": segs}, {"a": {"bits": {}}}, tun, [], ["a"])


def listed(res):
    g1 = re.search(r"or unpaid (\[.*?\])", res["G1 Spine"]["detail"]).group(1)
    g8 = re.search(r"unpaid callbacks (\[.*?\]);", res["G8 Loops"]["detail"]).group(1)
    return ast.literal_eval(g1), ast.literal_eval(g8)


@pytest.mark.parametrize("runtime, gap, short", [
    (20, 6.5, False),
    (20, 5.0, True),
    (100, 31.0, False),
    (100, 29.0, True),
    (200, 60.0, False),
    (300, 60.0, False),
    (300, 45.0, True),
], ids=["20 s film, 6.5 s after the plant", "20 s film, 5 s after", "100 s film, 31 s after", "100 s film, 29 s after",
        "200 s film, 60 s after: the knee", "300 s film, 60 s after: the cap", "300 s film, 45 s after"])
def test_a_callback_is_short_under_the_smaller_of_the_cap_and_a_share_of_the_runtime(runtime, gap, short):
    assert listed(gates(runtime, gap)) == ((["cb"], ["cb"]) if short else ([], []))
