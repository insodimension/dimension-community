# Framework map: each concept, its formula and where it runs

`DD` = the installed kit (`inso dd root`); films live in `dd.home.films_for(<production>)` (the brand's `productions/dopamine-debt/films/`, `DD_FILMS_ROOT` overrides it). Section numbers refer to `DD/FRAMEWORK.md` (v2.1). Constants marked *unfitted* are priors, never measurements.

## Audiences (§1)
- Every film has two gated audiences: the **base** channel persona (the brand's own `personas/channel/<channel>.md` in `productions/dopamine-debt/`, else the shipped `DD/personas/channel/ai-news.md`, `basis: borrowed` until the channel has its own analytics) and the **topic** persona (`personas/topic/<topic>.md` in the brand's folder, which expires 45 days after it is built). Any audience weighing 0.15 or more is gated.
- `dd/persona.compile_card(md)` turns a persona into a judge card of 250 words or fewer, in two variants (A and B) with a `card_hash`. The full persona file never reaches the judge.
- The **floor** reader is the least-informed viewer the persona still covers. "Get it" is always read as this person.
- A persona with `kind: channel` in its front matter carries the laugh floor (`tunables.laugh_floor_persona_kinds`).

## Spine (§3) → gate G1, G8
Fields: `packaging`, `premise`, `take`, `narrator{stance, flaw, never}`, `voice_mode`, `anchor_world{analogy, maps, breaks_at, extensions}`, `money_object{graphic, unit}`, `retell`, `acts[{id, job, turn, stake_rung, opens_loop, closes_loop, button_seed, retell}]`, `callbacks[{id, plant_act, triggers, payoff, mutation}]`.
- G1 fails when a field is missing, when the take reads as unfalsifiable (judge score below 0.6), when fewer than 70% of turns are *but* or *therefore*, when stakes don't rise, or when a callback comes sooner after its plant than min(60 s, 30% of the film's runtime).
- G8 fails when a loop stays open, a callback goes unpaid, or the last bit doesn't call back the cold open. In code: segments carry one id each in `plants`, `calls`, `opens` and `pays`; G1 measures each callback from its plant's `t1` to its first call's `t0`; "calls back the cold open" means one of the last three non-silence segments `calls` a plant that ends by 15 s. G9 counts a retell fact only where its `carries` read is ≥ 0.5, so the final-20 s restatement must state each fact plainly enough for that read.

## Units (§4)
- **Segment:** the timeline unit. Its `kind` is voice, clip, graphic or silence, and the segments cover the whole film (`dd/units.validate`).
- **Bit:** setup, turn, optional tag. At most 3 lines or 10 s. The comedy is read once per bit. Setup lines are **loans**: they cost nothing if the bit lands.
- Segment fields the engine reads: `id`, `kind`, `line` or `sound_line`, `bit`, `plants`, `calls`, `opens`, `closes`/`pays`, `carries[fact ids]`, `picture`, `sound`, `t0`, `t1`; for memes and clips also `gag_id`, `library`, `mode`, `replaces` (G13) and, at the SEEN read, `display` (G12).

## Readouts (§6) → `dd/run.py`, `dd/read.py`
- One judge request covers one unit, one audience and every question. The model that answers is the person's `judge` role; `tunables.judge_model` is the label the read cache keys on. K = 4 variants (2 cards × A/B).
- Segment questions give P(lost/followed/clicked) and load (effortless to exhausting). Bit questions give P(laugh), P(smile), P(cringe) and whether the bit is anchored. Carries asks whether the unit states the fact. Take asks whether the take is falsifiable.
- **Second juror:** a different model family reads every bit whose laugh + ½·smile ≥ 0.4 or whose cringe ≥ 0.15. A cringe reading of 0.4 or more is a veto (fitted: recall 0.92, false alarms 2%). The Review answers it through `completion` at `juror_role`; its cache key is `sha256(juror_model | qv | schema | prompt)` with the `juror_model` the Review states (a provider/model, never a tier name), so another model never reuses its answers.
- `reads_needed(film, cards, model, window)` is the one pure function behind every state and cache key. `before` holds the verbatim previous 45 s plus any plant line. The cache key is `sha256(model | qv | questions | state)`, so a unit is re-read only when its state changes.

## Ledger (§7) → `dd/derive.py`
- Reward `R = rel·(2·P(laugh) + 0.75·P(smile)) + P(clicked) + loop_pay`. `rel` is 1 when the bit carries a fact or stays on the unit's topic, and 0.5 for an unrelated gag. `loop_pay = 1 + 0.1·seconds_open`, capped at 3.
- Cost `C = P(lost) + P(heavy+) + entity_overflow + 4·P(cringe) + 0.3·opens_loop + wall`. `wall` adds 0.25 per second while 12 or more unspoken words sit on screen.
- Debt: `D(t+1) = D(t)·e^(−1/τ)` with τ = 20 s (*unfitted*). At each unit's end, `D ← max(0, D + C − min(R, 0.5·D + R·[pays a declared loop]))`: a generic laugh clears at most half the pile.
- θ = 4 (*unfitted*) is the click-away line.
- Trust after a cringe: laugh rewards are multiplied by 0.7 for 30 s.
- A unit is **heavy** when C − R ≥ 1.5. Four moves answer it: **Cut** (prove it with an ablation), **Bake in** (a joke carries the same fact, P(laugh) ≥ 0.5), **Carry** (a picture that depicts the fact), **Pay** (a reward tied to the same fact within W = τ·ln(D) seconds).
- Habituation is keyed on gag identity. An unchanged repeat pays 0.6×. A build or a callback that restates its fact pays in full, plus 0.5.

## Memes in the ledger (§10)
- A meme's reward is the reward of the **bit it punches**. A meme dropped on a fact with no setup has nothing to pay off and reads as a non-sequitur, so the juror rates it cringe.
- Placement follows the ledger. A meme lands on a heavy unit or a rising-D stretch, about the same fact. It stays only if the ablation (the curve read with it against without it) favours it.
- The judge sees only text until the cut stage. The SEEN read (snapshot frames described by vision, plus the measured sound) is the decisive meme read.

## Gates (§8) → `dd/derive.gates_for`, `film_gates`; `dd/gate.check`
- G2 Cold open: the first laugh mark lands by 5 s and carries the title nouns (`packaging.title_nouns`, matched as substrings of that bit's text), a segment with `confirms_promise` ends by 10 s, and the film doesn't open with "This is X". In code a "laugh mark" is any bit with laugh + ½ smile ≥ `laugh_cut` (0.2), the same mark G7 counts, not P(laugh) ≥ 0.5.
- G3 Cringe veto: no **written** bit reaches a raw juror reading of 0.4, and none of the banned strings in `taste.json` appear. A bit holding a media-library meme (`dd.derive.meme_bits`: a clip segment whose `library` resolves under the media library (`dd.home.LIBRARY`), never `fetch-*`) goes to **G3m Meme cringe**, advisory (`advisory_gates`) until the juror's meme calibration is ruled on. The veto reads the raw juror number; the ledger's cringe cost still reads it through `juror_cringe_map`, which jumps 0.176 → 0.818 between 0.35 and 0.40 (stages.md §Commands).
- G4 Nobody lost (hard): 85% or more of seconds followed, no run of 3 lost units, and every retell unit at 0.6 or more. Fitted on SEEN reads of one approved and one rejected film: the rejected film fails it for its topic audience (67%), the approved one passes (100%).
- G5 Laugh rate (hard): E[laugh + ½ smile] per minute ≥ `laugh_floor_per_min` 2.99 for every audience whose persona has `kind: channel` (`laugh_floor_persona_kinds`), no ceiling, and 65% or fewer of lines in a landing bit; within 1 K-variant SD of the floor it reads `uncertain`. **G5f Fact laughs** (50% or more of laughs carrying a fact) is advisory and unfitted: the SEEN pair does not separate on it.
- G5b Shared laughs: two thirds or more of laughs land for every audience, and a joke that lands for only one audience comes at most once per 30 s.
- G6 Strain: D ≤ θ for 95% or more of seconds, and no two heavy units within 15 s without a reward between them.
- G7 Laugh gaps: 20 s or less between laughs in the first 60 s and the last 30 s. Elsewhere, at most one valley of 45 s or less per 2 minutes, and only if it opens a loop and 2 or more laughs land within 12 s after it.
- G9 Facts: each retell fact appears 3 or more times (2 or more in a film under 60 s: `tunables.fact_encodings` `short_min` below `short_below_s`), spread across the film's thirds, re-encoded each time, the last within the final 20 s, and anchored once.
- G10 Peak and end: a peak bit in the middle 40%, a mean net of +0.16 or more over the last 20 s, and D below 1 at the end.
- G11 Taste and media: every gate rule in `taste.json`, checked by **one implementation, `DD/framework/g11.py`**. A film's builder fills a `g11.Plan` from its own timeline and layout (narration words clipped to each cut, memes, sound effects, labels, the boxes it drew, picture changes, what fills the frame, each scene's first reveal, the spine's `anchor_world.lines`, the script, sources, the instrument's `audio.txt`) and calls `g11.code_checks(plan)`. A rule with no Plan data is left out, so it reads unchecked. Every kit film gets this through `DD/framework/kit/g11plan.py` (`compose.py` writes `layout.json`, `scenes.Cues` records reveals).
- Judge rules in `taste.json` (`check: judge`) other than `deadpan` (read by the dd jurors) run through `g11.judge_checks(states, completion)` on the slow model. They are `severity: advisory` until `g11.calibrate(completion, dd.home.marks_file(<production>))` on the brand's marks ledger reaches recall ≥ 0.9 at ≤ 25% false alarms; on the first labelled marks the slow model caught 5 of 7 rejections but falsely failed 6 of 6 approvals, and the tiny `judge_batch` model caught none.
- G12 Entertainment (`dd/derive.entertainment`, only when `root.json` `kind` is `seen`): landed laughs/min ≥ 6.0 per audience (bits over `laugh_cut`); library memes/min ≥ 1.67; the longest stretch of voice seconds between two landing bits ≤ 16.0 s per audience (`dry_voice_run`); ≥ 57% of library-meme time with a seen `display` of `full`, `cutout` or `ghost` (`inset` is a small box or disc); and the whole-cut juror (`dd/run.watch_needed`, `questions.watch_prompt`: the whole SEEN transcript with pictures and sound, 3 draws per persona on the bit juror's model, cached in `jury-cache.jsonl` as `kind: watch`) at keep-watching ≥ 0.47 per audience. Thresholds in `tunables.entertainment`, midpoints between one approved and one rejected film. A meme with no `display` makes G12 `incomplete`.
- G13 Laughs kept (`dd/derive.conservation`, `dd/gate.previous_stage`): reads the previous stage dir named in `root.json` `previous` (its `gates.json` `memes` and `ledger.<aud>.json`, both written by `dd.gate.write`). Fails when laughs/min (G5's measure) falls by more than `uncertain_sd` K-variant SDs; when a previous gag id is gone and no segment logs `replaces: <that gag id>`; when a replacement's `library` is not a media-library entry; when its bit's laugh + ½ smile is lower than the replaced one's for any audience; or when the count of memes and clips is below the previous rate × the new length. `previous: null` is the first stage; a missing key or record is `incomplete`.
- `dd.gate.check(film_dir, film, g11)` returns `pass`, `fail` or `incomplete`. Any missing read (bit juror or whole-cut juror) gives `incomplete`, and so does an unchecked G11 gate rule (code, or a calibrated judge rule; `dd.gate.g11_rules()`) or a gate that cannot be measured (`unmeasured`). `dd.gate.write(film_dir, res)` stores `gates.json` (status, blockers, gates, score, `memes`) and the ledgers; every stage ends with it.

## Score (§9)
For ranking only: the minimum over audiences, capped at 49 while any gate fails. **Never show it as quality.** The person sees the curve page, the gate table and the render.

## Calibration (§11)
- Targets and failures go through the same pipeline, on SEEN reads (the judge does not separate films on text). One approved and one rejected film fitted G4, G5 and G12; the fact-laugh share did not separate (0.31–0.33 against 0.29) and stays advisory; the whole-cut juror separates them only through the topic audience. Your own calibration reads live in the brand's `productions/dopamine-debt/calibration/targets|failures/<film>/`.
- People laugh and the judge doesn't: re-read with picture and sound, and extend the reference bank.
- The judge laughs and people don't: the line becomes a cringe hard negative.
- The person's taps go to `calibration/taps/<film>/<rev>/<session>.jsonl` in the brand's folder as `{t_ms, label}`.
- A proposal is applied only with the person's yes.
