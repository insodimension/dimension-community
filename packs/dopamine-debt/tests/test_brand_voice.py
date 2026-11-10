"""G11 brand-voice (taste.json): every take the cut plays is the brand's voice, one {voiceId, modelId} pair per cut.

Every voice and model id below is fake: no person's voice is named in this package.
"""
import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from dd.gate import g11_rules
from dd.home import settings_voice
from framework import g11
from framework.kit import g11plan, voice
from framework.kit.film import Film

KIT = Path(__file__).resolve().parents[1]
RULE = "brand-voice"
BRAND = {"voiceId": "fakeBrandVoice01", "modelId": "fake_model_a"}
FROM_KIT = "the brand kit (Brand/brand/voice.json)"


def piece(seg, line, start):
    return {"start": start, "end": start + 2.0, "file": f"voice/{seg}.mp3", "in": 0.0, "out": 2.0, "line": line, "seg": seg}


def cut(takes, brand=BRAND, source=FROM_KIT):
    return g11.Plan(duration=10.0, voice=[piece("A0", "a0.1", 0.0), piece("A1", "a0.2", 2.0), piece("A1", "a0.4", 4.0)],
                    voice_takes=takes, brand_voice=brand, brand_voice_from=source)


def checks(plan):
    """code_checks with the silence measure stubbed: these plans point at no audio, and brand-voice reads none."""
    original = g11._dbfs
    g11._dbfs = lambda *_: -90.0
    try:
        return g11.code_checks(plan)
    finally:
        g11._dbfs = original


def test_brand_voice_is_a_gate_rule_that_names_no_voice():
    assert RULE in g11_rules()
    rule = next(r for r in g11.taste()["rules"] if r["id"] == RULE)
    assert (rule["check"], rule["severity"]) == ("code", "gate")
    assert "brand/voice.json" in rule["text"] and "Settings" in rule["text"] and "fit time" in rule["text"]


def test_the_brand_kit_pair_passes():
    assert checks(cut({"A0": BRAND, "A1": BRAND}))[RULE] == []


def test_another_model_fails_naming_the_take():
    other = {"voiceId": BRAND["voiceId"], "modelId": "fake_model_b"}
    out = checks(cut({"A0": BRAND, "A1": other}))[RULE]
    takes = [f for f in out if f.startswith("A1:")]
    assert len(takes) == 1 and "fake_model_b" in takes[0] and "fake_model_a" in takes[0] and FROM_KIT in takes[0]
    assert not any(f.startswith("A0:") for f in out)


def test_another_voice_fails_naming_the_take():
    out = checks(cut({"A0": {"voiceId": "fakeOtherVoice", "modelId": BRAND["modelId"]}, "A1": BRAND}))[RULE]
    takes = [f for f in out if f.startswith("A0:")]
    assert len(takes) == 1 and "fakeOtherVoice" in takes[0]


def test_mixed_pairs_in_one_cut_fail_even_with_no_brand_voice():
    other = {"voiceId": "fakeOtherVoice", "modelId": "fake_model_b"}
    for brand in (BRAND, {}):
        out = checks(cut({"A0": BRAND, "A1": other}, brand=brand, source="why"))[RULE]
        mixed = [f for f in out if "2 voice pairs" in f]
        assert len(mixed) == 1 and "A0" in mixed[0] and "A1" in mixed[0]


def test_mixed_pairs_fail_even_when_another_take_is_unrecorded():
    plan = g11.Plan(duration=10.0, voice=[piece("A0", "a", 0.0), piece("A1", "b", 2.0), piece("A2", "c", 4.0)],
                    voice_takes={"A0": BRAND, "A1": {"voiceId": "fakeOtherVoice", "modelId": "fake_model_b"}, "A2": {}},
                    brand_voice=BRAND, brand_voice_from=FROM_KIT)
    out = checks(plan)[RULE]
    assert len(out) == 1 and "2 voice pairs" in out[0]


def test_no_brand_voice_and_no_settings_default_leaves_the_rule_unchecked_and_says_why():
    why = "no brand voice: write Brand/brand/voice.json"
    plan = cut({"A0": BRAND, "A1": BRAND}, brand={}, source=why)
    code = checks(plan)
    assert RULE not in code
    assert g11.unchecked_why(plan, code) == {RULE: why}


def test_a_settings_voice_without_a_model_checks_the_voice_and_the_one_pair():
    settings = {"voiceId": BRAND["voiceId"]}
    src = "the Settings default voice"
    assert checks(cut({"A0": BRAND, "A1": BRAND}, brand=settings, source=src))[RULE] == []
    other = {"voiceId": "fakeOtherVoice", "modelId": BRAND["modelId"]}
    out = checks(cut({"A0": other, "A1": other}, brand=settings, source=src))[RULE]
    assert len(out) == 2 and out[0].startswith("A0:") and src in out[0]


def test_a_take_with_no_recorded_pair_leaves_the_rule_unchecked_and_names_it():
    for takes in ({"A0": BRAND, "A1": {}}, {"A0": BRAND, "A1": {"voiceId": BRAND["voiceId"]}}, {"A0": BRAND}, {}):
        plan = cut(takes)
        code = checks(plan)
        assert RULE not in code
        why = g11.unchecked_why(plan, code)[RULE]
        assert "A1" in why and "record_job" in why


def test_a_take_the_cut_does_not_play_is_not_judged():
    spare = {"voiceId": BRAND["voiceId"], "modelId": "fake_model_b"}
    assert checks(cut({"A0": BRAND, "A1": BRAND, "A9": spare}))[RULE] == []


def brand_film(tmp_path, record=None):
    brand = tmp_path / "Brand"
    root = brand / "productions" / "film-a"
    root.mkdir(parents=True)
    if record is not None:
        (brand / "brand").mkdir()
        (brand / "brand" / "voice.json").write_text(record, encoding="utf-8")
    return Film(root=root), brand


def settings(tmp_path, monkeypatch, text):
    agent = tmp_path / "agent"
    agent.mkdir()
    if text is not None:
        (agent / "config.yml").write_text(text, encoding="utf-8")
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(agent))


def test_a_production_in_a_brand_finds_its_kit(tmp_path):
    film, brand = brand_film(tmp_path)
    assert film.brand_kit == brand / "brand"


def test_brand_voice_reads_the_brand_kit_record_before_settings(tmp_path, monkeypatch):
    settings(tmp_path, monkeypatch, "mediaGen:\n  voiceId: fakeSettingsVoice\n")
    film, brand = brand_film(tmp_path, json.dumps(BRAND))
    pair, source = voice.brand_voice(film)
    assert pair == BRAND and str(brand / "brand" / "voice.json") in source


def test_brand_voice_falls_back_to_the_settings_default(tmp_path, monkeypatch):
    settings(tmp_path, monkeypatch, "mediaGen:\n  voiceId: fakeSettingsVoice\n  elevenlabsCommercialUse: \"yes\"\n")
    film, _ = brand_film(tmp_path)
    pair, source = voice.brand_voice(film)
    assert pair == {"voiceId": "fakeSettingsVoice"} and "Settings" in source


@pytest.mark.parametrize("config", [None, "mediaGen:\n  elevenlabsCommercialUse: \"yes\"\n", "mediaGen:\n  voiceId: \"../x\"\n", ": not yaml : ["])
def test_no_brand_voice_and_no_settings_default_tells_the_agent_to_set_the_kit(tmp_path, monkeypatch, config):
    settings(tmp_path, monkeypatch, config)
    film, brand = brand_film(tmp_path)
    pair, why = voice.brand_voice(film)
    assert pair == {} and str(brand / "brand" / "voice.json") in why and "Settings" in why
    assert settings_voice() is None


@pytest.mark.parametrize("record", ['{"voiceId": "fakeBrandVoice01"}', "not json", '["x"]', '{"voiceId": "", "modelId": "m"}'])
def test_a_brand_kit_record_without_its_pair_is_no_voice(tmp_path, monkeypatch, record):
    settings(tmp_path, monkeypatch, "mediaGen:\n  voiceId: fakeSettingsVoice\n")
    film, brand = brand_film(tmp_path, record)
    pair, why = voice.brand_voice(film)
    assert pair == {} and str(brand / "brand" / "voice.json") in why


def test_g11_json_records_why_a_rule_is_unchecked_and_the_cut_blocks(tmp_path, capsys):
    film = Film(root=tmp_path)
    (tmp_path / "build").mkdir()
    code = {r: [] for r in g11_rules() if r != RULE}
    g11plan.write(film, code, {}, {RULE: "no brand voice: write it"})
    report = json.loads(film.g11_file.read_text(encoding="utf-8"))
    assert report["status"] == "incomplete" and report["unchecked"] == [RULE]
    assert report["why"] == {RULE: "no brand voice: write it"}
    assert "no brand voice: write it" in capsys.readouterr().out


def test_jobs_json_entries_give_each_take_its_pair_and_bare_ids_give_none(tmp_path):
    (tmp_path / "jobs.json").write_text(json.dumps({
        "A0": {"jobId": "gen_1", "text": "x", "options": {"voiceId": "v", "modelId": "m"}, "dir": "voice/jobs/A0"},
        "V1": "gen_bare",
        "_unused": {"note": ["gen_2"]}}), encoding="utf-8")
    film = SimpleNamespace(voice_dir=tmp_path)
    assert voice.take_voices(film, ["A0", "V1", "B2"]) == {"A0": {"voiceId": "v", "modelId": "m"}, "V1": {}, "B2": {}}


def test_take_voices_without_jobs_json_records_nothing(tmp_path):
    assert voice.take_voices(SimpleNamespace(voice_dir=tmp_path), ["A0"]) == {"A0": {}}


def test_record_job_writes_the_entry_take_voices_reads(tmp_path):
    film = SimpleNamespace(voice_dir=tmp_path)
    voice.record_job(film, "A0", "gen_1", "Hello.", {"voiceId": "v", "modelId": "m", "production": "p"}, "voice/jobs/A0")
    voice.record_job(film, "A1", "gen_2", "There.", {"voiceId": "v", "modelId": "m"}, "voice/jobs/A1")
    jobs = json.loads((tmp_path / "jobs.json").read_text(encoding="utf-8"))
    assert jobs["A0"] == {"jobId": "gen_1", "text": "Hello.", "options": {"voiceId": "v", "modelId": "m", "production": "p"}, "dir": "voice/jobs/A0"}
    assert voice.take_voices(film, ["A0", "A1"]) == {"A0": {"voiceId": "v", "modelId": "m"}, "A1": {"voiceId": "v", "modelId": "m"}}


def test_record_job_refuses_a_job_without_its_voice_pair(tmp_path):
    with pytest.raises(ValueError, match="A0"):
        voice.record_job(SimpleNamespace(voice_dir=tmp_path), "A0", "gen_1", "Hello.", {"modelId": "m"}, "voice/jobs/A0")
    assert not (tmp_path / "jobs.json").exists()


ELEVENLABS_VOICE_ID = re.compile(r"\b(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{20}\b")
SHIPPED = ("taste.json", "tunables.json", "*.ts", "dd/**/*.py", "framework/**/*.py", "framework/**/*.md", "gate/**/*.ts",
           "skills/**/*.md", "general-agents/**/*.md")


def test_the_voice_id_shape_matches_an_elevenlabs_id_and_nothing_hex():
    assert ELEVENLABS_VOICE_ID.fullmatch("aB3dE5gH7jK9mN1pQ3sT")
    assert not ELEVENLABS_VOICE_ID.search("c0b9ac616f1cb1895255cee245ad451357b02b05")


def test_no_voice_id_ships_in_the_rules_code_or_skills():
    """A voice id belongs to one person's account; it lives in their brand kit or Settings, never in the kit."""
    files = sorted({p for pattern in SHIPPED for p in KIT.glob(pattern) if p.is_file()})
    assert len(files) > 20
    found = {str(p.relative_to(KIT)): ids for p in files if (ids := ELEVENLABS_VOICE_ID.findall(p.read_text(encoding="utf-8")))}
    assert found == {}


def test_no_skill_tells_the_agent_to_change_the_voice_model_or_pins_one():
    """The model is the brand's pair; a skill never names one, and never trades it for time."""
    skills = sorted(KIT.glob("skills/**/*.md")) + sorted(KIT.glob("general-agents/**/*.md"))
    pinned = {str(p.relative_to(KIT)): hits for p in skills if (hits := re.findall(r"eleven_[a-z0-9_]+", p.read_text(encoding="utf-8")))}
    assert pinned == {}
