# Dopamine Debt: the film psychology framework

**The idea in one line:** every second a film borrows the viewer's attention, and it has to pay that back, with interest, in laughs, surprises and "aha" moments. A film that lets the debt pile up loses the viewer. A film that pays it back on time gets watched to the end, remembered and shared.

Built on the Product Psychology plugin (Imprint Loop: Filter → Frame → Act → Imprint; Charge: the user's health bar, −3 to +3), adapted from a product flow to a film, with tension and release added. Visual version: `framework.html`.

---

## 0 · The north star (intent)
> Someone who knows nothing about the topic watches once, laughs out loud several times, never thinks of leaving, and afterwards can retell the story to a friend in three sentences, remembering it through the jokes and images.

Each film fills this in with:
- **Retell:** the three sentences the viewer should be able to say afterwards. These are the film's key facts, and nothing else is essential.
- **Laughs:** the target rate (default 5 per minute).
- **Ending feeling:** how they should feel at the last frame (default: "ha, that's absurd, and now I get it").

## 1 · The root: who we are making it for
**Nothing is scored until the root exists. "Funny" and "clear" only mean something for a specific person.**

| Part | What it holds | Where it comes from |
|---|---|---|
| **Audience persona** | age · what they already know and don't · why they clicked · humour taste · cringe triggers · attention span · jargon tolerance | evidence only: comments on comparable videos, Reddit/X threads on the topic, retention of reference videos, our own stats |
| **Compass answers** (the plugin's three questions, turned to a viewer) | **Hope:** what they want from this video. **Pain:** what usually ruins explainers for them. **Barrier:** the last time they clicked away from one, and why. | comment mining; later, real viewers |
| **Reference bank** | what this viewer recognises instantly: memes, films, games, internet moments, everyday things (phone contract, gym, rent) | the same evidence; each entry records where it was seen |
| **Taste rules** | the channel's non-negotiables: deadpan, never cringe · no HR or corporate music · no text walls · real posts and real people · nothing important in corners · no end card | Inso |
| **Tunables** | debt limit θ · payback window · laugh target · score weights | defaults below; changed only through the root |

### Two audiences in every film: the channel's base, plus the topic's own
A film is watched by two groups at once, and they laugh at different things:

| Layer | Who | Lives in | Changes |
|---|---|---|---|
| **Base audience** | the channel's subscribers and the people it's marketed to | `personas/channel/<channel>.md` | slowly; corrected by every published film's stats |
| **Topic audience** | the newcomers the topic itself brings in. A film on *Phantom Blade Zero* brings in action-game players, and a film on the Anthropic IPO brings in retail investors. Many never heard of the channel. | `personas/topic/<topic>.md`, researched fresh for every film | every film |
| **Mix** | the expected share of each group in this film, e.g. 60% base and 40% topic | the film's root | per film; checked against real traffic afterwards |

Each topic persona is built the same way as the base: from evidence, with its own Hope, Pain, Barrier, humour, cringe triggers and reference bank. The evidence comes from where *that* crowd talks: the game's subreddit, the finance YouTubers' comments.

**The reference bank splits three ways:**
- **Shared:** things both groups recognise instantly. The universal memes and B-roll (This is fine, Dr. Evil, a health bar) live here, and they are the safest laughs.
- **Base only:** dev and AI in-jokes.
- **Topic only:** the game's own memes, or finance's own memes.

**How scoring changes:**
1. Every beat is read **once per audience**, so it gets two readouts. The film's score is the mix-weighted blend.
2. **Nobody gets lost:** a beat may make only one group laugh, but the other group must still follow it (Get it passes for both). An in-joke for one group must never cost the other a dip.
3. **The opening and the ending must work for both groups:** the first laugh in 5 s and the final surge. The topic audience decides in the first 10 s, and they owe the channel nothing.
4. **Shared anchors are worth more:** one laugh lands for everyone. Laughs that serve only one group are fine, but alternate them so neither group goes over its debt limit.
5. **Jargon depends on who hears it:** a term the base knows (tokens) is free for them and costs the topic audience; finance terms are the reverse. The load score is per audience.

The Dry Run base persona: [`personas/channel/dry-run.md`](personas/channel/dry-run.md). It is a **DRAFT, unverified until the evidence step is done**. In short:
- 18–35, uses AI tools daily, many are developers or tech-curious;
- knows AI products, knows almost nothing about finance or law;
- internet-native and meme-literate;
- loves deadpan sarcasm in the Fireship and Critical Drinker style;
- cringes at forced, explained or corporate jokes;
- leaves on lectures, text walls and unexplained jargon.

## 2 · The rubric compiler
It turns the root into the exact questions the judges ask, **once per audience in the mix**:
- "Does **this** viewer laugh?"
- "Does **this** viewer follow it on first hearing?"
- "Is the anchor in **this** viewer's reference bank, or in the shared bank?"
- "Is this line one of the three retell facts?"

**Change a persona, the mix, the intent or a taste rule, and every question and threshold regenerates.** That is what keeps the framework dynamic: you never edit a rubric by hand. A new topic means a new topic persona and a new mix; the base persona and the rest of the framework stay the same.

## 3 · Calibration: the framework earns trust before it judges a film
1. **Targets:** the best videos for this persona, chosen from evidence. Known **failures:** cuts Inso rejected, with his notes. The framework must score the targets clearly above the failures. If it doesn't, the persona or the rubric gets fixed, never the film.
2. **Inso's reaction taps:** Inso watches a few minutes and tags his reaction at each moment. The judges' readings are compared with his taps, and a reading that disagrees gets re-weighted or re-worded.
3. **After publishing:** the real YouTube retention curve is compared with the predicted health bar. Real dips correct the persona and the debt model.

## 4 · The pipeline: the same readout at every stage, and nothing moves on a fail
**Story Strip → Script → Storyboard → Cut**

- **Story Strip:** the viewer's journey in six panels, at most 5 words each, with the happy ending (panel 6) written first.
- **Beat:** the unit everything is scored on. It is one line, plus the picture on screen, plus the sound under it, plus its duration.
- The **script** is scored on its words.
- The **storyboard** is scored on words plus a description of each frame.
- The **cut** is scored on the words, the real frames (described by a vision model) and the measured timings.

## 5 · The beat readout
Every beat gets three readings, **as the persona**.

### 5a · The four checks (the plugin's Imprint Loop, turned to a film)
| Check | Plugin stage | The question | Psychology |
|---|---|---|---|
| **Hook** | Filter | Is something new or unexpected here, or is it a lull, a repeat or a text wall? | Attention filters out effort and repetition, and is captured by pattern breaks (von Restorff isolation; habituation). |
| **Get it** | Frame | Does this viewer follow it on first hearing? Is every number anchored to something familiar? | Working memory holds about 4 chunks (Cowan 2001). Load (Sweller 1988). Anchoring. Mayer's multimedia principles. |
| **Grin** | Act | Does it land as a joke (lands, flat, cringe), and does the joke **carry the fact**? | Incongruity-resolution (Suls 1972). Benign violation (McGraw & Warren 2010). Relief theory. |
| **Keep it** | Imprint | Is the fact tied to something in the reference bank: an analogy, a story, a cultural reference, a picture? | Dual coding (Paivio). Analogy as structure-mapping (Gentner 1983). Schemas (Bartlett 1932). Levels of processing (Craik & Lockhart 1972). Self-reference effect (Rogers et al. 1977). |

In a product, "Act" means clicking a button. **In our film it means learning while laughing**, so the best beat is the one where the joke *is* the explanation.

### 5b · The reaction
The viewer's main reaction at that moment, one of nine, with probabilities:

| Rewards | Neutral | Costs |
|---|---|---|
| 😄 amused · 😲 surprised · 💡 aha (the click of understanding) | 🤔 curious (a loop opened, which must be paid later) · 😐 neutral | 😵‍💫 confused · 😮‍💨 overloaded (the sigh) · 🥱 bored · 😬 cringe |

### 5c · Load and need
- **Load:** the mental effort to take the beat in on first hearing, from 0 (effortless) to 3 (exhausting).
- **Essential?:** whether the beat carries one of the retell facts. It may be reworded, but it can't be cut.

### 5d · The judge call, exactly
Jev (the classifier) is a **function**. It sees only what we pass it, so its inputs are defined here and nowhere else.

**One call = one beat × one audience:**

| Input | What goes in | Why |
|---|---|---|
| `instructions` | **the audience persona** (the full text from `personas/`), then the question | who is reacting; measured below to give sharper separation than putting the persona in the state |
| `criteria` | the fixed label definitions for that question (lands / flat / cringe, the nine reactions, load 0–3) | the same scale in every film, so scores stay comparable |
| `state.story_so_far` | the running ledger of the film up to this beat: the terms and facts already explained, the running gags and setups not yet paid off, and the retell facts | a payoff only lands if its setup is known; a term is only clear if it was explained earlier |
| `state.setup` | the previous one or two lines, verbatim | timing and rhythm of the joke |
| `state.line` | this beat's narration | the thing being judged |
| `state.picture` | what is on screen: the storyboard text, or a vision model's description of the real frames | a line that needs its picture to land (e.g. "it speeds up / it speeds up") is judged with the picture |
| `state.sound` | the meme's own audio, its sound effects, and whether the music drops out | the payoff of a meme is often its sound |

**Questions asked per call:**
- Grin (choice);
- Get it (bool);
- Keep it (bool, against this audience's reference bank plus the shared bank);
- Carries a fact (bool);
- Reaction (choice of nine);
- Load (score 0–3);
- Essential (bool, against the retell facts).

`story_so_far` is updated after every beat, so the judge watches the film in order, the way a viewer does.

**Proof that Jev reads the persona** (2026-11-04: 24 test lines, 6 written for each group, × 3 personas; persona in the instructions):

| P(understands) | dev lines | finance lines | gaming lines | universal lines |
|---|---|---|---|---|
| as the **dev** persona | **0.62** | 0.21 | 0.60 | 0.65 |
| as the **finance** persona | 0.27 | **0.76** | 0.33 | 0.78 |
| as the **gamer** persona | 0.25 | 0.08 | **0.55** | 0.47 |
| no persona | 0.40 | 0.31 | 0.41 | 0.58 |

- The highlighted diagonal (each persona on its own lines) averages **0.64**, against **0.29** off the diagonal.
- Humour separates the same way: the dev persona gives dev jokes 0.76 and gamer jokes 0.58; the gamer persona gives gamer jokes 0.60 and dev jokes 0.18.
- With **no persona**, Jev judges humour almost like the dev persona (0.69 on the dev jokes). Every earlier score was therefore implicitly "for a tech viewer", which is exactly why the persona must always be stated.

**Proof that it uses the story so far** (5 payoff lines, with and without the earlier explanation):
- P(lands) rises:
  - "And the risk is that it speeds up": 0.04 → 0.63;
  - "One share still outvotes you": 0.45 → 0.70;
  - "So the better Anthropic does, the bigger the loss": 0.52 → 0.73.
- Understanding rises on 3 of 5.
- One wobble: "That's the safety brake" scores 0.85 → 0.56, because with context it realises there is more to follow.
- **Take five was scored with only the previous line as context, so its payoffs were under-credited.** Every score from now on uses `story_so_far`.

**What this does not prove:**
- The test lines were written by me, not taken from real viewers.
- The finance test lines were dry facts, not jokes, so finance humour wasn't tested.
- Each persona is a paragraph of text: Jev reacts to that description, not to real people.
- The real check is calibration (section 3): your reaction taps, and the retention of published films.

## 6 · The ledger: health bar, debt meter and the Load–Release rule

### Per beat
- **Cost** = (load − 0.5, minimum 0) + 1 if confused, overloaded or bored + 2 if cringe + 1 if a text page is held over 4 s (Mayer: redundancy and coherence).
- **Reward:**
  - a landing joke = 2, or 3 if it carries the fact;
  - a surprise = 2;
  - an aha = 1.5;
  - a smile = 1;
  - a curiosity hook = 0.5;
  - +0.5 if the fact is anchored.
- **Charge** = reward − cost, rounded and clamped to −3…+3. These are the plugin's bands: surge +3 · lift +1/+2 · neutral 0 · dip −1/−2 · drain −3.

### Two curves
- **Health bar (HP)** = the running total of charge. It shows the trend of the whole film and should climb.
- **Debt meter** = D ← max(0, D × 0.85 + cost − reward × relief). It shows local strain.
  - The **0.85** is natural recovery: attention comes back on its own, slowly.
  - **Relief** = 1 + 0.15 × min(D, θ), applied to laughs and surprises only. **A joke after tension pays more than the same joke cold** (relief theory; reward prediction error, Schultz et al. 1997).
  - **D above θ (default 4) is the danger zone:** the moment people click away.

### The Load–Release rule
Every heavy beat (cost 1.5 or more) gets exactly one move:

| Move | When | What to do |
|---|---|---|
| **Cut** | heavy and **not essential** | remove it or merge it into a better line |
| **Bake in** | essential, and a joke can carry it | the joke *is* the explanation |
| **Carry** | essential and can't be lightened in words | lower the load *during* the beat: a picture does the explaining (modality, signalling, dual coding), a familiar analogy (anchoring, schema), a running gag on screen, a curiosity hook ("and that's not the weird part", Loewenstein's information gap 1994) |
| **Pay** | essential and still heavy | land a reward **within 8 s** that brings the debt under 1: a joke, a meme with its full payoff, a reveal |

Reward rules:
- **The payoff must be unexpected.** A repeat of the same gag, mechanism or meme inside 60 s pays 0.6× per repeat (habituation; dopamine answers the *unpredicted* reward).
- A **callback** at least 60 s later pays full value plus a bonus, because recalling it is itself a reward (testing effect, Roediger & Karpicke 2006; spacing).
- **Every curiosity hook must be paid before the film ends.** An open loop at the end is unpaid debt and fails the ethics gate (clickbait).

### Curve rules (the shape)
1. The first laugh comes within 5 s.
2. A laugh at least every 20 s.
3. The debt never goes over θ.
4. It ends high: the last beat is a laugh and the debt is cleared (Peak-End, Kahneman et al. 1993).
5. The health bar ends above where it started.

## 7 · The score out of 100
| Part | Points | How it's measured |
|---|---|---|
| **Grin** | 25 | laughs that land per minute ÷ target (5), capped at 1 |
| **Get it** | 20 | share of beats this viewer understands on first hearing |
| **Keep it** | 20 | share of fact-carrying beats anchored in the reference bank, confirmed by the retell test (a simulated viewer watches once and retells it; the three facts must survive) |
| **Hook** | 10 | share of beats with no lull (over 20 s without a laugh) and no text wall |
| **Load–Release** | 15 | share of heavy beats resolved (Bake in or paid in time); a heavy beat that should have been cut counts as a fail |
| **Curve** | 10 | the five shape rules, 2 points each |

The weights are tunables in the root. **The score ranks and guides. It is not a promise.** The ledger and the curve are the evidence: the score points to the biggest drop, and we fix the beat *before* it.

## 8 · Picture and sound in the readout
- **Picture:** narration plus a picture beats narration plus text (modality).
  - On-screen text that repeats the narration adds load (redundancy).
  - Highlight the one number that matters (signalling) and remove decoration (coherence).
  - A filing page appears only as proof, 3–4 s.
- **Memes:** a meme is a pattern break (Hook) plus a shared reference (Keep). Shared references also feed the belonging drive, the feeling of being "in on it" (the plugin's Drive levers). It must play its full payoff.
- **Music:** it sets the arousal level (Yerkes–Dodson: too flat bores, too busy overloads) and the mood, so the bed must fit the persona and the taste rules. Dropping it out on a punchline is a contrast that makes the punchline stand out.
- **Silence:** a beat of nothing before a reveal raises its surprise; dead air with no purpose is a lull.

## 8b · The meme and B-roll library: the reference bank you can actually use
The reference bank says *what* the audience recognises; the library holds the actual clips, images and sound bites. It is shared by every film, never kept inside one film's folder. Every asset is tagged with:

| Tag | Example | Used by |
|---|---|---|
| what it is, and its payoff (the line or moment that makes it land) | Dr. Evil, "one… *hundred billion* dollars", the payoff at 2.1 s | Grin; placing it so the payoff plays whole |
| who recognises it | shared · dev/AI · gamers · finance · Dota | the audience mix (an asset only counts for the audiences listed) |
| the joke it does | understatement, escalation, irony, fake confidence, doom… | matching the beat's mechanism |
| media facts | in and out points, its own audio, 720p minimum, a thumbnail, the source and credit | the cut and the YouTube credits |
| use count, per channel and per film | 3 uses, the last 2 films ago | habituation: a meme the audience saw last week pays less |

When nothing in the library fits a beat, a new asset is found online, tagged and added, so the library grows with every film. Jev then picks the asset that lands best for *this* beat and *this* audience mix.

## 9 · Gate, ship, learn
- **Ethics gate** (the plugin's `ethics-check`): title, thumbnail and hook must not over-promise, and every curiosity loop must be paid.
- **Inso sees** the cut together with its ledger, curve and score. He never sees a cut without them.
- **Learning:**
  - Inso's note on any beat becomes a label and re-weights the rubric.
  - Real retention after publishing corrects the persona, the reference bank, θ and the payback window.

## 10 · Limits, stated
- Classifiers are least reliable on fine-grained emotions, so "confused" against "overloaded" stays **uncalibrated until Inso's reaction taps** exist.
- Jev reads words. Frames reach it through descriptions, and timing is measured from the timeline, never judged.
- Jev over-calls "lands" on cringe lines (14 of 48 in calibration), so a second juror checks every landing line.
- The persona is a draft until the evidence step.
