# Dopamine Debt v2: the film psychology framework

**The idea:** every second, a film borrows the viewer's attention. Explanation runs up the debt. Laughs, "aha" moments and answered questions pay it back. A film that lets the debt pile up loses the viewer; a film that pays it back on time keeps them wanting the next second. "Dopamine" here means *wanting to keep watching*, not pleasure.

**v2 (2026-11-04)** applies five parallel reviews of v1 (psychology, measurement, craft, systems, audience). v1 is in `framework/history/FRAMEWORK.v1.md`; the changes are listed in §14.

**What it is and isn't:**
- **It decides through gates.** A film passes only when every gate holds for every audience.
- **The curve shows where it loses people.** The 0–100 score only ranks two versions of the same film against each other.
- **Constants marked *unfitted* are priors.** They stay that way until calibration (§11) fits them, and they are never presented as measurements.

---

## 1 · The root: who it's for (nothing is scored before this exists)

### 1.1 Two audiences, always
| Layer | Who | File | Lifetime |
|---|---|---|---|
| **Base** | the channel's subscribers and the people it's marketed to | `personas/channel/<channel>.md` | re-researched quarterly; corrected by each published film |
| **Topic** | the newcomers the topic brings in (a *Phantom Blade Zero* film brings gamers; the Anthropic IPO brings retail investors) | `personas/topic/<topic>.md` | researched fresh per film; expires after 45 days |
| **Mix** | the expected share of each, as a **range** `{lo, mid, hi}` for the first 48 h and for day 28 | `personas/mix/<film>.md` | per film; replaced by YouTube's subscriber vs non-subscriber split after publishing |

More than two audiences are allowed. Every audience with weight ≥ 0.15 at either end of the range is gated.

### 1.2 What a persona file holds (template)
```
---
id, kind: channel|topic, built, expires, basis: borrowed|own, card_hash
sources: [S1 {kind: yt|reddit|x|analytics|interview, url, date, n, slice}]
---
core          2 sentences, behaviour not demographics                       [S#]
floor         the least-informed viewer still in this audience; Get it is read as THIS person   [S#]
knowledge map | term | knows · shaky · doesn't | evidence |
compass       Hope · Pain · Barrier: claim · ≤15-word quote · S# · authors · H/M/L · stayer-complaint?
humour        laughs at (mechanism + quote) · doesn't · cringe triggers (each cited)
their words   what they call things
real voices   people and posts this crowd quotes or trusts
reference bank | item | pool | S#, likes, date | last seen | status | library asset | cringe-risk |
collisions    base in-jokes this audience won't get, and the reverse
open questions  uncited or single-source claims (never sent to the judge)
```
- **No cite, no line:** a claim needs ≥ 3 distinct authors in ≥ 2 sources. Otherwise it goes under *open questions*.
- **No age, gender, job or country guesses.** Segment by behaviour: quotes, asks, complains.
- `basis: borrowed` means the persona is inferred from comparable channels; `own` means it comes from our channel's data.

### 1.3 The persona research protocol (base quarterly, topic per film)
1. **Sources:**
   - 5 comparable videos (same format, ≤ 90 days old, ≥ 100k views) plus 1 failure comparator.
   - For a topic, go where that crowd lives: the topic's subreddit (top posts and comments over 12 months), 3 videos by creators outside our base, X posts by the topic's real people, and search autocomplete.
2. **Harvest raw and keep it unchanged:** top-200 and newest-200 comments, every timestamped comment, and the replies under the top 20 (pushback lives in replies). Store id, URL, date, likes and a hashed author. Drop duplicates, spam and LLM-style praise. Take at most 2 comments per author, weighted by log(likes).
3. **Code each comment** as one of: QUOTE-LAUGH, RIFF, REFERENCE, CONFUSION, COMPLAINT, CRINGE, CLARITY-PRAISE, CORRECTION, CHANNEL-META. A model does the first pass, Inso checks 10%, and the agreement is reported.
4. **Join timestamped comments to the video's lines.** Quoted-by and confused-by counts per line become free per-beat labels for calibration (§11).
5. **Compass:**
   - Hope comes from "waiting for someone to explain X" comments and search questions.
   - Pain comes from complaint clusters.
   - Barrier can't be mined from comments, because viewers who leave don't post. It comes from think-aloud calls, "why I stopped watching" threads, and our own retention dips. Barrier taken from comments is tagged *stayer-complaint*.
6. **Humour and cringe:** tally QUOTE-LAUGH by mechanism. Cringe comes from CRINGE codes, pushback in replies, and what the crowd mocks in the failure comparator.
7. **Mix forecast:** base ≈ median 7-day subscriber views of the last 5 films. Topic pull ≈ the 14-day views per day of the top 3–5 non-base videos on the topic × a capture rate of 1–3% (*unfitted*). With no history, use 50/50 ± 20 and gate at both ends.
8. **Bias control:** extraction and synthesis are separate passes. Hold out 20% of threads and check that the judge, reading as the persona, predicts their quote and confusion labels.
9. **Reference bank:**
   - Entry: ≥ 3 unprompted mentions in ≥ 2 threads, or a response to a video's own use of it. Its pool (shared, base or topic) is where it was seen.
   - Freshness: current ≤ 30 days, ageing ≤ 90 days, stale beyond that. Film, TV and game canon gets 365 days.
   - Stale entries need a fresh sighting before use. Recognised-but-dead entries are tagged `cringe-risk`.

### 1.4 Intent, taste rules, tunables
- **Intent** (`films/<f>/intent.json`): the retell facts with ids, `[{id: R1, sentence, facts: [{id: R1.a, text}]}]`, and the ending feeling.
- **Taste rules** (`taste.json`): `{id, check: code|judge|human, severity: gate|score}`. The channel's rules:
  - deadpan, never cringe;
  - no HR or corporate music;
  - no text walls;
  - real posts and people, captured with their source;
  - nothing important in corners;
  - no end card;
  - no lower thirds everywhere;
  - no Fireship footage;
  - every source at least 720p.

  Only cringe is a judge rule; the rest are code checks.
- **Tunables** (`tunables.json`): every constant in this document, each tagged `fitted` or `unfitted` with its source. Precedence: defaults < channel persona < topic persona < film override.

## 2 · The compiler (pure, deterministic)
`compile(root.lock) → Rubric`:
- `root.lock.json` pins every root file by sha256, plus the judge model ids and the framework version. A film never reads a live file, and a persona changes only by writing a new version.
- For each audience it emits a **persona card**: at most 250 words from core, floor, knowledge map, humour and cringe, plus `card_hash`. The full file, its citations and the "DRAFT" notes are never sent to the judge.
- It also emits the question set (§6), the tunables in their order of precedence, the reference-bank pools (shared, base-only and topic-only are *derived*, not stored), and the gate list.

## 3 · The spine: story before jokes (a veto layer)
Beat-level scoring can't see story, so the spine is written and gated **before** any joke:

```yaml
# films/<f>/spine.yaml: frozen before the script
packaging: {title, thumbnail, promise_q, confirmed_by_s: 10, answered_in: last-25%}
premise:  "[subject] says A but does B"            # the one comic incongruity
take:     "a falsifiable one-sentence verdict"     # gate: a reasonable viewer could disagree
narrator: {stance, flaw, never: [taste rule ids]}  # a joke aimed at the narrator in every act
voice_mode: hold|picture                          # Drinker: 0.25-0.5 s hold before the punch; Fireship: the picture hits on the punch word
anchor_world: {analogy, maps: "what maps to what", breaks_at: "where the analogy fails", extensions: [3]}
money_object: {graphic, unit}                     # one persistent graphic; every number is a change to it, first given as a ratio to something familiar
retell: [R1, R2, R3]
acts:     [{id, job, turn: but|therefore, stake_rung, opens_loop, closes_loop, button_seed (≤8 words), retell: [ids]}]
callbacks: [{id, plant_act, triggers: [act], payoff: end, mutation}]   # the plant is itself funny; first trigger ≥ 60 s later
```
**The film shape:** a cold open, then 3–4 acts, then the take, a callback and a button. **The recap list is retired.**

## 4 · The pipeline: each stage writes JSON the next validates
**Packaging → Spine → Joke map → Script → Storyboard → Cut → Inso**

| Stage | Unit | Judge reads | Gates (§8) |
|---|---|---|---|
| Spine | act | none | G1 |
| Joke map | bit | planned only | G2, G5 (planned), G8, G9 (planned) |
| Script | bit and segment | words, plus the story so far | G2–G10 |
| Storyboard | segment | plus picture and sound descriptions | G2–G11 |
| Cut | segment, timed | plus real frames (vision description) and measured timings | all |

**The joke map**, one row per bit:
`id | act | t | setup | punch (≤22 words, punch word last) | mechanism | target | carries: [fact ids] | gag_id | visual punch? | asset | hold | plants/calls | build_id | opens/pays loop`

- **Bit:** a setup, a turn and an optional tag, at most 3 lines or 10 s. Grin and comprehension are read once per bit, with the whole bit in `state.line`. Setup lines are **loans**: free if the bit lands, charged if it doesn't.
- **Segment:** the timeline unit. `segments[]` covers the **whole** film, `kind: voice|clip|graphic|silence`, and a validator enforces Σ durations = the film length ± 1 frame. Clip segments are read with `picture` = the library asset's payoff description and `sound` = its audio. Ids are ULIDs with `parent: [id]`, so Inso's taps and notes survive edits.

**The repair loop:** score → diagnose → rewrite → re-score.
- At most 3 passes per stage.
- A pass must reduce the gate blockers or the debt integral, or the loop stops and goes to Inso.
- Every score change is logged against the size of the edit. A large jump from a small edit is a red flag: rewriting against the judge finds adversarial text.

## 5 · The four checks (Imprint Loop to film)
| Check | Plugin stage | The question | Grounding |
|---|---|---|---|
| **Hook** | Filter | Is there a pattern break, or a lull? (computed from the timeline and the laugh gaps, not asked) | orienting response to change (Sokolov; Lang 2000; Itti & Baldi 2009) |
| **Get it** | Frame | Does the **floor** viewer follow it on first hearing? | cognitive load (Sweller 1988); working memory of about 4 chunks (Cowan 2001); split attention (Chandler & Sweller 1991) |
| **Grin** | Act | Does it land, and is the joke **about** the fact? | incongruity-resolution (Suls 1972); benign violation (McGraw & Warren 2010); seductive details hurt learning (Rey 2012); humour aids attention, not cognition (Eisend 2009) |
| **Keep it** | Imprint | Does the anchor map the *mechanism* of the fact, with the fact stated in the same beat? Does the fact come back, re-encoded, later? | structure-mapping (Gentner 1983); dual coding only when the picture depicts the fact (Paivio); spacing (Cepeda et al. 2006); curiosity improves memory for the answer (Kang et al. 2009; Gruber et al. 2014) |

Channel trust (the plugin's cross-visit Imprint) is handled by the cringe veto and the trust rule in §7. Negativity bias (Baumeister et al. 2001) means one cringe outweighs several laughs.

## 6 · The judge call, exactly
**One request = one unit (bit or segment) × one audience × all questions.** The model id is pinned (`typesafe/jev-1.14.0`, never an alias), and every readout is stamped with the model, the `rubric_id` and the framework version.

| Input | Contents |
|---|---|
| `instructions` | the compiled persona card (≤ 250 words), then the question |
| `criteria` | fixed label definitions, versioned |
| `state.before` | the **verbatim** narration of the previous 45 s, plus the verbatim setup line of any planted callback this unit pays. Built in code, never from judge output and never from the author's intent. |
| `state.line` | the unit's narration (the whole bit, for Grin) |
| `state.picture` | storyboard text or a vision description of the real frames (storyboard and cut stages) |
| `state.sound` | the meme's own audio, the effects, and whether the music drops |

**Questions** (single-judgment each; no compound questions):

| id | Type | Labels | Used as |
|---|---|---|---|
| `follow` | choice | lost · followed · clicked ("oh, *that's* how it works") | comprehension; P(lost) is a cost, P(clicked) a reward |
| `affect` | choice, **asked twice with the labels reversed and averaged** | cringe · flat · smile · laugh | P(laugh), P(smile), P(cringe) |
| `load` | score | effortless · light · heavy · exhausting | P(heavy or worse) |
| `anchored` | bool | the line maps the fact onto something this viewer already knows *and* states the fact | Keep it |
| `carries:<id>` | bool, per declared fact id | "Does this unit state *<fact text>*?" | verifies the writer's declared `carries` |

**Deterministic load:** in code, count the new terms, numbers and named entities per unit. More than 3 adds +0.5 cost each beyond 3. The judge's `load` covers the rest.

**Variance:**
- Each request runs **K = 4 variants** (2 persona paraphrases × 2 label orders), reporting the mean and SD.
- A decision within 1 SD of a cut-off is marked **uncertain** and goes to Inso, never decided automatically.

**The second juror (cringe only):**
- It is a model from a **different family** (a chat model through `completion`, temperature 0, pinned) with the cringe rubric.
- It reads every unit with P(laugh) ≥ 0.4 or P(cringe) ≥ 0.15.

**Cache:** the key is `sha256(model | question_version | instructions | criteria | state)`. An edit re-reads only the changed units and those whose `state.before` changed.

**Measured so far** (2026-11-04, n small, author-written lines):
- Persona conditioning separates foreign jargon (each persona's own-domain lines 0.64 against 0.29 for the others); it does not yet show a lift on own-domain lines.
- Context lifts payoff lines (0.04 → 0.63).
- Both are re-tested in calibration (§11) on real lines.

## 7 · The ledger: debt meter, per second, per audience
`derive(segments, readouts, tunables) → ledger.<aud>.json` is a **pure function**. Raw readouts are stored in `readouts.jsonl` with their full probabilities, so a change to the formula never needs a re-read.

### 7.1 Expected values, never argmax plus a cut-off
For each unit and each audience (the probabilities are the K-variant means):
- **Reward**
  `R = rel · (2·P(laugh) + 0.75·P(smile)) + 1.0·P(clicked) + loop_pay`
  - `rel` = 1 if the bit carries a retell fact or is about the unit's own topic, and 0.5 if it's an unrelated gag.
  - `loop_pay` = `1 + 0.1·seconds_open`, capped at 3, and only when the unit closes a declared loop.
- **Cost**
  `C = 1.0·P(lost) + 1.0·P(heavy+) + entity_overflow + 4·P(cringe) + 0.3·opens_loop + wall`
  - `wall` = 0.25 per second while **≥ 12 on-screen words that are not in the narration** play under a different narrated sentence (split attention). A label of 5 words or fewer, or a proof screen while the narration pauses or only points at it, costs nothing.
  - **Setup loans:** a setup line's cost is charged only if its bit's P(laugh) < 0.5.

### 7.2 The debt meter
- **Decay on a 1 Hz clock:** `D(t+1) = D(t)·e^(−1/τ)`, with **τ = 20 s** (unfitted prior).
- At each unit's end, D rises by C and falls by the reward:
  `D ← max(0, D + C − min(R, 0.5·D + R·[pays a declared loop]))`
  A generic laugh can clear at most half the pile. Only the declared payoff of a named loop clears it all.
- **Relief multiplier: removed.** The tension behind excitation transfer is *arousing* tension, not confusion. It returns only if a paired test shows the effect (n ≥ 40).
- **θ** (the click-away line) = the P90 of max D on the target videos (§11). The prior is 4, unfitted.
- **Trust after a cringe:** laugh rewards × 0.7 for 30 s after any unit with P(cringe) ≥ 0.3 (unfitted).

### 7.3 Heavy beats and the four moves
- A unit is **heavy** when `C − R ≥ 1.5` (net of its own reward).
- **Split heavy units by cause:**
  - wall-driven → re-time the page;
  - load- or comprehension-driven → choose a move.

| Move | When | Proof required |
|---|---|---|
| **Cut** | not carrying a retell fact | an ablation: re-score without the unit; D, the facts carried and the next bit's P(laugh) must not get worse |
| **Bake in** | a joke can carry it | the rewrite's bit carries the same fact id, and P(laugh) ≥ 0.5 |
| **Carry** | it can't be lighter in words | a picture that *depicts* the fact (the money object, a diagram), or the anchor world. Not a teaser line. |
| **Pay** | still heavy | a reward tied to the **same fact** within `W = τ·ln(D)` seconds |

- **Fail:** two heavy units within 15 s with no reward between them.

### 7.4 Habituation, builds and callbacks
- Repeats are keyed on **gag identity** (the same asset, frame or image), never on the mechanism.
- A recurrence that changes nothing pays 0.6×.
- A declared `build_id` (2–3 steps, each bigger) and a planned callback that **restates its fact in a new form** pay full, and the callback earns +0.5.
- A meme template with a fresh payoff costs nothing extra (fluency; Reber, Schwarz & Winkielman 2004).

## 8 · Gates (per audience; a film passes only if all hold)
| Gate | Rule | Check |
|---|---|---|
| **G1 Spine** | every spine field present. Take is falsifiable (judge bool: "could a reasonable viewer disagree?" ≥ 0.6). ≥ 70% of act turns are *but* or *therefore*. Stake rungs strictly rising. Every callback planted ≥ 60 s before its first trigger. | code + judge |
| **G2 Cold open** | a thesis joke carrying the title's nouns lands by 5 s (P(laugh) ≥ 0.5). Promise confirmed by 10 s. No "This is X" opener. | judge + code |
| **G3 Cringe veto** | no unit with P(cringe) ≥ τ_c from either juror. Zero banned strings. τ_c is set for ≥ 90% recall on the hard-negative set; the prior is 0.3. | both jurors + list |
| **G4 Nobody lost** | as the floor reader: ≥ 85% of *seconds* with P(lost) < 0.5, no run of ≥ 3 lost units, and every retell-fact unit has P(followed or clicked) ≥ 0.6. An edit made for one audience forces a re-read for the others. A gloss inside a punchline caps that audience's Grin at flat. | judge |
| **G5 Laugh band** | laughs per minute, E[Σ P(laugh)]/min, within the target band. The prior is [4.5, 6]; later the [P10, P90] of the targets. ≤ 65% of sentences carry a joke. ≥ 50% of laughs carry a fact. ≥ ⅔ of laughs land for **every** gated audience. A single-audience joke at most once per 30 s, and only while the other audience's D < θ/2. | judge + code |
| **G6 Strain** | D(t) ≤ θ for ≥ 95% of seconds. No double heavy unit within 15 s. | derive |
| **G7 Laugh gaps** | ≤ 20 s between laughs in the first 60 s and the last 30 s. Elsewhere, at most one valley of ≤ 45 s per 2 minutes, and only if it opens a named loop and ≥ 2 laughs land within 12 s after it. | derive |
| **G8 Loops** | every opened loop closed. Every callback paid. The final bit calls back the cold open. | code |
| **G9 Facts** | each retell fact appears ≥ 3 times (setup, payoff, callback), spread across the thirds, each time re-encoded, the last in the final 20 s. Each has one anchored statement. No unrelated gag within 8 s after a retell-fact unit. | code + judge |
| **G10 Peak and end** | one unit with P(laugh) ≥ 0.9 in the middle 40% of the runtime. Over the last 20 s, mean (R − C) ≥ +1 and D < 1 (Peak-End; Fredrickson & Kahneman 1993; Alaybek et al. 2022). | derive |
| **G11 Taste and media** | no text walls. Meme payoff inside the clip's in/out (library payoff time). Music ≤ −20 dB or absent under retell-fact units (coherence; Moreno & Mayer 2000). Punchline drop-outs allowed (orienting response). Nothing important in the 10% edge band (vision). Posts captured with source and date. Every source ≥ 720p. No Fireship. No end card. | code + vision |

**Unknown is not pass:** a missing readout, a judge outage, or a persona with `basis: borrowed` and no calibration all make the result `incomplete`. Never impute zeros, never fall back silently to no persona, and never mix judge versions within one film.

### 8.1 Film gates: measured on the rendered film, blind (v3, 2026-11-04). These decide.
The G-gates above read the **script**, scored by Jev. On 2026-11-04 they passed a film Inso rejected, at a score of 98.7. Jev also rates take five above every human-made reference, so **no Jev-derived number may pass or certify a film**. Jev only ranks alternative lines within one script.

**A film is done only when its 1080p render passes the F-gates**:
- **Measure:** cut 0.5 s contact sheets, transcribe it with Whisper and read 0.5 s audio levels.
- **Log it blind:** a fresh vision agent, not told what the film is, logs it with `validation/CODEBOOK.md`.
- **Compute** the gates in `validation/film-gates.json` from that log.

How the gates were checked: they were fitted on 3 Fireship videos against the 4 films Inso rejected (takes three, four and five, and the DD film), then frozen and run on a held-out Fireship video (`validation/validation-matrix.csv`).

| Gate | Rule | Good (4 Fireship) | Rejected (4) |
|---|---|---|---|
| **F2 Gag rate** (advisory since v3-2) | ≥ 6.0 meme or sticker gags a minute | 6.1–7.0 | 3.0–5.6 |
| **F4 First minute** (advisory since v3-2) | ≥ 6 gags in the first 60 s | 6–12 | 3–5 |
| **F5 Slates** | big text alone on a background ≤ 5% of the runtime | 1.6–3.1% | 1.7–14.7% |
| **F6 Diagrams** | charts, cards and diagrams ≤ 25% of the runtime | 5.4–21.6% | 31.6–70.8% |
| **F7 Tags** | no credit or source tag on memes; ≤ 5 name cards | 0–5 | 15–17 |
| **F8 Grids** | no captioned meme comic grid | 0 s | 3.5–5.5 s in 3 of 4 |
| **F9 Dead air** | no 1 s run without narration or sound near voice level | 0 s | 0–24.5 s |
| **F10 Ending** | a gag, meme or cutout in the last 6 s; no black at the end | all | 3 of 4 fail |
| **F11 Coverage** | every question in `films/<f>/coverage.json` (from the topic persona's confusion topics) answered in plain words | — | 3/10 for both scored |
| **F12 One per franchise** | no film, show, game or creator supplies more than one meme in a film (never two Star Wars); callbacks reusing the same asset count once | Inso's rule, 2026-11-04 (not reference-fitted) | the last film used two Star Wars memes |
| **F13 Narration seams** | every cut in the narration lands at ≤ −18 dB below the speech level (`make/flow.py`, measured on the source audio at each seam) | — | Anthropic IPO render S: 49 of 59 slices started or ended on live speech |
| **F14 Clip words** | no meme clip starts or ends inside a spoken word (Whisper word times on the clip source) | — | render S: Dr. Evil played only "…dollars!", Scarface lost "Say hello to" |
| **F15 Sound on narration** | no sound effect overlaps a narration word | — | render S: 31 stamps and stings landed on words |
| **F16 Narration stops** | memes that stop the narration ≤ 1.5 a minute (one per 40 s), each at a sentence end | — | render S: 55 stops in 12.3 min (4.5 a minute) |

- **Advisory only:** meme share ≥ 18% (F1), gag gaps ≤ 40 s (F3), gag rate (F2) and first-minute gags (F4).
  - F1 and F3 failed the held-out Fireship video, and on meme share a rejected take is level with it (16.7% vs 16.8%).
  - **F2 and F4 were demoted on 2026-11-04 (v3-2).** The Anthropic IPO render S passed them at 7.2 and 12 on both blind logs, and Inso rejected it as "completely broken". The memes interrupted his words, cut words off, were overused and did not fit. A floor on gag count rewards cramming; it never measured fit or flow.
  - F13–F16 are the measurable half of that rejection. They are read from the build (plan, clip registry and source audio) by `make/flow.py`, not from the blind log, and fixed at those values before the rebuild was measured.
  - **Meme fit is not gated.** No instrument here measures whether a meme suits its line, so the keep list is a judgement for Inso to check.
- **Limits:**
  - every good reference is one creator;
  - the logger is a model, not a person;
  - the F13 (−18 dB) and F16 (1.5 a minute) limits were set by judgement from one rejected render, not fitted on references.
- **What passing means:** it predicts Inso will not reject the film for the reasons he rejected these four. It does not prove he will laugh. Only his reaction calibrates that (§11).
- **Never shown as a grade:** a script score. What Inso sees is the F-gate table from the blind log of the real render, the coverage table, and the source list.
- **Not decisive while Inso has not calibrated them:** G5 and G10. Their Jev thresholds (P(laugh) ≥ 0.9) are unmeasurable with Jev, and lowering them to make a film pass is forbidden.

## 9 · The curve and the score
**What Inso sees** (`films/<f>/page.html`, Fraym Codex dark with the amber accent):
- the D(t) curve per audience, with θ;
- the laugh marks;
- the worst three stretches, each with its remedy;
- the frame storyboard, each frame with its readouts and its move;
- the gate table.

**The score (0–100), for ranking only:**
- Per audience, `S_a = 100 · geometric mean(laugh-band fit, comprehension seconds share, fact retention proxy, 1 − share of seconds over θ, spine checks passed)`.
- The **film score = min over gated audiences**, reported with its SD from the K variants.
- **It is capped at 49 while any gate fails.**
- Differences under 2 SD are noise.
- The plugin's own warning stands: never present a total as a KPI.

## 10 · Picture, sound, memes and the library
- **Picture:**
  - a picture depicts the fact, or it is decoration;
  - the money object carries every number;
  - a filing page is proof only, 3–4 s, with the narration pausing or pointing.
- **Memes** come only from the **shared library in the Video space plugin**. Each entry holds its payoff time and line, the audiences that recognise it, its mechanisms, media facts, credit and use log. Each meme is linked to a fact id or a bit. Its payoff must play whole. A meme plays under continuous narration, or with its own sound or an impact effect, never in silence. No credit tags on screen: credits go in the description. No captioned still grids. Rate and placement follow F2 and F4 (RIZPOL: 1.71 memes a minute, each 1.0–1.7 s, own-sound peak about 0.4–0.5 s in).
- **Meme modes:** mix these in every film (Inso, 2026-11-04, from Holy E's "I Found the Most BROKEN Bounty Hunter Build"):
  - `fullscreen`: the clip fills the frame and plays its payoff whole;
  - `cutout`: the person is keyed out (transparent background) and stands over the scene, bottom-anchored, about half the frame tall;
  - `spotlight`: a small round inset with a feathered edge, sitting ON the exact thing the line names (a logo, a line on the page, a character), at the word;
  - `slot`: the clip fills the exact rectangle of a new row, entry, seat or item the line introduces (a table cell, a list row, an inventory square), as if the new thing itself reacts (Holy E: a Top Gun clip inside the newly bought item's slot);
  - `ghost`: a large semi-transparent face on one side, fading into the scene, for a menacing or dramatic beat.
  
  Placement is the joke: an overlay sits on, or points at, what the narration names.

  One implementation: `framework/overlays.py` holds every mode's size, mask, opacity, placement and motion (values from the Anthropic IPO builder's `overlay()`, where Inso approved them). A film's builder imports it and adds only its own colours and outlines. Cutouts are keyed with rembg on CPU into VP9-alpha WebM (`films/anthropic-ipo/v3/make/key.py`; `keep_x` masks out bystanders).
- **Music:** a cue sheet per act. It is ≤ −20 dB or absent under retell-fact units, and may drop out on punchlines. No numeric arousal claims.
- **Voice:** one `voice_mode` per film. The pause before the punch is a persona tunable, measured at the cut (Drinker holds before 45% of his jokes; Fireship before 23%).

## 11 · Calibration: trust is earned, constants are fitted
1. **Instrument (no humans):**
   - re-run Spearman ≥ 0.9 and decision flips ≤ 10% across the K variants;
   - run the tone-study corpus (8 annotated reference videos) and report the judge's precision and recall against the joke annotations.
2. **Targets vs failures (film level):**
   - The target videos and Inso's rejected cuts go through this same pipeline.
   - θ, the laugh band and the gap rules are set as percentiles of the targets.
   - Targets must beat failures on held-out pairs (≥ 0.85).
   - Take five is excluded from the test half, because v1's cut-offs were read from it.
3. **Items:**
   - ≥ 300 real lines, ≥ 100 of them cringe hard negatives, labelled blind by ≥ 3 persona-matched raters.
   - Pass: AUC (target vs cringe) ≥ 0.80, cringe recall ≥ 0.90 at ≤ 25% false alarms, and a joint two-juror miss ≤ 0.05.
   - Persona sign test ≥ 75% on real lines where humans differ.
4. **Taps:**
   - Inso, plus a panel of ≥ 8 viewers when one exists, taps laugh / lost / cringe / bored on ≥ 6 films (3 targets, 3 rejected cuts).
   - Pass: Spearman(reward EV, laugh-tap rate) ≥ 0.5; negative-tap AUC ≥ 0.7.
   - **Inso calibrates the taste gates; the panel calibrates audience response.** Inso alone is n = 1 and knows the punchlines.
5. **After publishing:**
   - Fit τ, θ and the weights by hazard model against YouTube audience retention (100 buckets) on ≥ 8 films, leave-one-film-out.
   - Pass at a held-out retention Spearman ≥ 0.6.
   - Free labels: timestamped comments and *Most replayed*.
   - Until then, D, θ and τ are labelled **unfitted**.
6. **Disagreements:**
   - The judge laughs and humans don't → the line joins the cringe hard negatives.
   - Humans laugh and the judge doesn't → re-read with picture and sound, and extend the reference bank.
   - A systematic offset → an isotonic map per persona.
   - Inso overrides gates only.

**Goodhart suite (run before trusting any change):** the readout must hold under each of these.

| Change | Required |
|---|---|
| Shuffled beats | score lower |
| 30% filler added | lower or equal |
| Best joke duplicated 5× | lower or equal |
| Content-free quips added | lower or equal |
| Lines re-split at clause boundaries | within ±2 |

## 12 · Data layout
```
dopamine-debt/
  FRAMEWORK.md  tunables.json  taste.json
  framework/history/                 previous versions
  personas/channel/<ch>.md  personas/topic/<t>.md  personas/mix/<film>.md   (versioned on change)
  calibration/{golden.jsonl, targets/, failures/, taps/, jev-<ver>.json}
  dd/                                the implementation: compile, states, questions, derive, gates, page
  films/<f>/{root.lock.json, intent.json, spine.yaml, jokemap.json, segments.json,
             readouts.jsonl, ledger.<aud>.json, gates/<stage>-<rev>.json, page.html}
library: the Video space plugin (packages/video-editor), shared by every film; never copied here
```
- Taps go to `taps/<film>/<rev>/<session>.jsonl` as `{t_ms, label}`.
- Retention goes to `retention.json`.
- Learning writes proposals (`{target, before, after, evidence, golden_delta}`), applied only if they improve the golden set, as a new version.

## 13 · Psychology, corrected
| Principle | Use |
|---|---|
| Cognitive load (Sweller 1988); working memory of about 4 chunks (Cowan 2001); split attention (Chandler & Sweller 1991) | cost, entity overflow, the wall rule |
| Multimedia coherence, also for sound (Moreno & Mayer 2000) | the picture depicts the fact; music under retell units |
| Dual coding, only when the picture depicts the fact (Paivio) | Carry |
| Structure-mapping analogy (Gentner 1983), with its breaking point named | the anchor world |
| Incongruity-resolution (Suls 1972); benign violation (McGraw & Warren 2010) | Grin |
| Seductive details (Rey 2012); humour aids attention, not cognition (Eisend 2009); the humour memory effect is within-list only (Schmidt 2002) | the `rel` weight, the gag gap after facts, the cap of ≤ 65% joke sentences |
| Curiosity as deprivation, rewarding on closure (Loewenstein 1994); curiosity improves memory for the answer (Kang 2009; Gruber 2014) | loops cost, closure pays; a retell fact goes right after a specific question |
| Spacing (Cepeda 2006); serial position | G9: ≥ 3 re-encodings, the last in the final 20 s |
| Peak-End (Fredrickson & Kahneman 1993; Alaybek 2022: as predictive as the mean, unlike trend and duration) | G10 |
| Negativity bias (Baumeister 2001) | cringe cost 4, the veto, the trust penalty |
| Orienting response (Sokolov; Lang 2000: faster edits raise arousal and memory without extra load) | Hook; no per-cut penalty |
| Fluency (Reber, Schwarz & Winkielman 2004) | familiar meme templates are cheap |
| In-group humour and common ground | the reference-bank pools; "nobody lost" |
| Encoding specificity (Tulving & Thomson 1973) | the cue retell in calibration: show a frame and ask which fact it carried |

**Removed:**
- Zeigarnik: a 2025 meta-analysis found no memory effect.
- Yerkes–Dodson as an engagement law.
- Fogg as evidence.
- Schultz 1997 as a basis for the relief multiplier.
- "Dopamine" as a liking mechanism.

## 14 · What changed from v1, and why
| v1 | v2 | Found by |
|---|---|---|
| additive 0–100 decides | gates decide; the score ranks only, min over audiences, capped at 49 on any fail | measurement (90 one-liners scored 100), systems, audience |
| debt decays per beat | decays per second (τ = 20 s); shares weighted by time | measurement, systems, craft, psychology |
| argmax plus hidden cut-offs | expected values, K = 4 variants, uncertain decisions go to Inso | measurement, systems |
| cringe +2 | a veto with a second juror from a different family, plus banned strings | measurement, psychology |
| relief multiplier | removed until tested | psychology, measurement, craft |
| one laugh wipes the debt | a generic laugh clears at most half; declared loop payoffs clear all | craft, measurement |
| mix-weighted blend | per-audience ledgers, gate on the minimum at both ends of the mix range | audience, systems, measurement |
| beats = narration lines | segments cover the whole timeline; bits are the comedy unit; setups are loans | systems, craft |
| no story layer | spine, joke map, cold open, take, narrator, callbacks, money object | craft |
| habituation by mechanism | by gag identity; builds and callbacks pay | craft |
| 9-way reaction | comprehension and affect axes, labels reversed and averaged | psychology, systems, measurement |
| "layman" undefined | the floor reader per persona | audience |
| persona from guesses | research protocol; no cite, no line; behaviour not demographics | audience |
| story_so_far from the author's intent | the verbatim previous 45 s, built in code | measurement, systems |
| simulated retell as a score | a computable proxy (anchored, spaced re-encodings) plus a cue retell in calibration | systems, psychology |
| HP and the ±3 charge | a diagnostic picture only | all five |
