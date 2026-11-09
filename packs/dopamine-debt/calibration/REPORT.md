# Calibration run 1: the eight tone-study videos against take five (2026-11-04)

**Question:** with the identical instrument (Dopamine Debt v2, judge `typesafe/jev-1.14.0`, base persona card `7267b5a4c1216142`, K = 4 variants), does the narration of the eight reference videos score above take five's narration?

**Answer: no. On narration text alone, take five scores level with the best Fireship video.** The Jev-based measures do not separate them, so per §11 every Jev-derived gate is **advisory**, not decisive, until human calibration passes.

## Run 2 (uniform clause units, ≤ 22 words; run 1 used raw sentences and was unit-dependent)
| Video | Units | E[laughs]/min | E[laugh + ½ smile]/min | Followed (s-weighted) | Heavy | Cringe | Anchored | Max D | AUC vs human joke labels |
|---|---|---|---|---|---|---|---|---|---|
| Fireship `nEaJMdM1djM` (AI bubble) | 86 | 0.96 | 4.27 | 0.70 | 0.20 | 0.08 | 0.18 | 4.9 | 0.83 |
| Fireship `b2tjnxX8IHU` | 109 | 0.95 | 3.66 | 0.83 | 0.07 | 0.09 | 0.15 | 4.3 | 0.75 |
| Fireship `SMGg7iisHmc` | 83 | 0.87 | 3.65 | 0.82 | 0.11 | 0.08 | 0.14 | 5.6 | 0.77 |
| Fireship `7r4ikZHm9AI` | 91 | 0.84 | 3.79 | 0.83 | 0.09 | 0.09 | 0.16 | 2.7 | 0.65 |
| `BTJyt4yCaes` | 92 | 0.83 | 3.33 | 0.82 | 0.11 | 0.17 | 0.18 | 8.6 | 0.72 |
| `7FnVU4KaxPA` | 106 | 0.33 | 2.49 | 0.86 | 0.09 | 0.10 | 0.14 | 4.4 | 0.59 |
| Critical Drinker `dN4375kBtfo` | 105 | 0.28 | 2.15 | 0.89 | 0.07 | 0.07 | 0.12 | 3.9 | 0.72 |
| `N2TmzjbmjGM` | 97 | 0.23 | 1.78 | 0.92 | 0.06 | 0.05 | 0.14 | 2.4 | 0.78 |
| **Take five (rejected)** | 63 | **0.95** | **4.26** | 0.74 | 0.17 | 0.07 | 0.17 | 3.2 | n/a |

## What this means
1. **Jev finds jokes inside a video moderately well.** Its within-video AUC against the human joke annotations is 0.59–0.83, median 0.74. That is useful for *ranking lines within one script*.
2. **It does not rank films.** Take five's narration sits with the best Fireship video on every text measure. Two explanations remain open, and both are probably true:
   - take five's failure lives mostly *outside the words*: text walls, picture, music, structure, delivery. A text-only judge can't see any of it;
   - **judge self-preference** [INFERENCE]: lines written by a language model in a "deadpan" register look funny to a language-model judge. That makes the judge the easiest thing for a model-written script to game, and it is exactly why the reviewers required a human panel and a judge from a different model family.
3. **Absolute "laugh" probabilities are tiny** (0.2–1 laugh per minute for everyone). Jev reserves "laugh out loud" for very few lines, so the laugh band (4.5–6/min) can't be applied to Jev's P(laugh). The band was set from human joke annotations; the comparable Jev measure is E[laugh + ½ smile], at 3.3–4.3/min for Fireship. **The laugh band is re-based to E[laugh + ½ smile] ∈ [3.3, 4.3] per minute** (Fireship P25–max), and stays unfitted.
4. **Strain (max D) does not separate them either:** take five 3.2, Fireship 2.7–5.6.

## Consequences applied
- G5 (laugh band) is re-based as above. G3 (cringe) and G4 (nobody lost) are kept as **advisory** until the human item test (§11.3) passes.
- The gates that don't depend on Jev's taste stay **decisive**. They are the ones that would have caught take five:
  - G1 spine;
  - G2 cold open, measured by time;
  - G7 laugh gaps;
  - G8 loops and callbacks;
  - G9 facts encoded ≥ 3×;
  - G11 taste and media (text walls, music, corners, sources).
- **The next calibration step needs a human:** Inso's reaction taps on 3 targets and take five (§11.4). This is the only thing that can tell us whether the judge's taste matches his.

## Integrity notes
- About 10 of roughly 3,900 judge items were re-asked after a transient failure. The job log shows those retries answered by `typesafe/jev-latest`, not the pinned 1.14.0. They are under 0.3% of items, but the pinning rule says they must be re-read. They are marked for re-read on the next pass.
- Raw readouts: `calibration/readouts.jsonl`. The inputs are the eight `sent.txt` transcripts from the tone study, plus take five's word timings.
