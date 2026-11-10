---
name: youtube-package
description: "Turn a finished film into a checked YouTube package: scored title options, a description with real chapters, sources and credits, tags, captions, the AI-use disclosure decision, Shorts and end-screen plans, written to receipts/publish.json and verified by a script. Use when a final render exists and someone says package this, write the title and description, make the chapters, get it ready for YouTube, or does this need the AI label. Not for the thumbnail (youtube-thumbnail) or the upload (youtube-studio-upload)."
---

# YouTube package

A finished film goes to YouTube as one package: the words around it, the decisions about it, and the proof that the numbers are right. You produce `receipts/publish.json` in the production folder, and `scripts/publish-check.mjs` says whether it is ready. The thumbnail comes next (`youtube-thumbnail`) and the upload after that (`youtube-studio-upload`); both read this file.

`<SKILL_DIR>` below is the folder this SKILL.md is in; `scripts/` and `references/` sit beside it. Scripts run with `node` (22 or newer) or `bun` and use nothing to install. With no shell, do the same rules by hand from the references and say the gate was not run.

## What is decided by what

- **The script decides the arithmetic.** Chapters from the edit's markers, the 10 s minimum, the byte budgets, the file hashes, whether every generated asset has a verdict. A model gets these wrong without noticing; do not do them in your head.
- **You decide the words.** The title, the hook, which claims to link, what the film's AI use looks like to a viewer.
- **The person decides what is theirs to decide.** Whether a voice is theirs, whether a clip is fair to use, whether to run an A/B test, who the film is for. Put the facts in front of them, ask once, record the answer. Visibility is not one of these: it is public unless the person or the campaign said otherwise.

## Inputs, and when to stop

Read these from the production folder (its name is the production id):

| File | Used for |
|---|---|
| `receipts/render-*-final.json` and the master under `renders/` | what is being published; refuse a draft or proxy render |
| `edl.json` | chapter markers, duration |
| `receipts/claims.json` | every claim, its proof, its source link |
| `media/*.asset.json` | licences, credits, which assets are generated |
| `renders/*.srt` | captions |
| `brief.md` | who it is for and what it promises |

**Stop and tell the person, with the exact missing thing, when:** there is no final render receipt; the edit has changed since the render (the gate catches a master that no longer hashes to its receipt and a runtime that drifts from the edit by more than a second, `master-replaced` and `master-duration-drift`; it does not read the edit's own revision, so ask the person whether the edit changed after the last render); the claim list has a claim with no proof that the title or description would repeat; an asset record has no licence. Do not invent around any of them.

## Order of work

1. **Chapters.** Text from a model or a page never goes inside a shell string. Write the name of the opening to a small file and run `node "<SKILL_DIR>/scripts/publish-check.mjs" chapters "<production-dir>" --intro-title-file <that file>`. It prints the block to paste, and what it had to do. A marker too close to the next one is a fix in the edit, not here. A film under 30 s has no chapters; leave `description.chapters` empty and put no timestamps in the text.
2. **Titles.** Write at least five options in at least two patterns, lint each (`node "<SKILL_DIR>/scripts/publish-check.mjs" title --file <file holding one title>`), score them, choose one. Rules and the scoring table: [references/title-and-description.md](references/title-and-description.md).
3. **Description.** A hook that names what the film shows with the main phrase in its first 150 characters, then the chapters block, then sources, then credits, then at most three hashtags. One plain line about AI when the film carries the label.
4. **Sources and credits.** Each claim that rests on a page gets its link from `receipts/claims.json`. Each asset that needs a credit has its credit line in the description word for word; each commentary clip also has its source URL. [references/disclosure-and-credits.md](references/disclosure-and-credits.md).
5. **Disclosure.** Assess every generated, commentary or unknown asset against YouTube's AI-use rules, show the person the result, record verdicts. Same reference.
6. **Tags, captions, language, settings.** Tags may be empty. Captions are the film's own SRT, read against the script. Choose the category from Studio's names. `madeForKids` is `false`; a film for children is a different job. `visibility` is `public` unless the person or the campaign said unlisted, private or a time.
7. **Plans.** `shorts[]` for cut-downs (up to 180 s each) and `endScreen` when the film is 25 s or more. A/B test plan comes with the thumbnail, and only when the person chose to run a test; one thumbnail is a normal package.
8. **Write** `receipts/publish.json` (schema and a worked example: [references/publish-json.md](references/publish-json.md)). Copy `master` from the final render receipt: path, duration, `editRevision`, receipt path, `output.sha256`.
9. **Check.** `node <SKILL_DIR>/scripts/publish-check.mjs check <production-dir> --stage package`. Fix every error; read every warning and either fix it or write down why it stays in your answer. The package stage skips thumbnails because they do not exist yet.
10. **Thumbnails**, then `check` again with no `--stage` flag. The gate re-reads every file it names, so a thumbnail or master changed since it was measured is refused. When it says READY, the next step is `youtube-studio-upload`.

The `receipts/publish.json` path is yours to write. If the space's rules or tools refuse a write there, stop and say which rule; do not write around it with another tool.

## The title, in one paragraph

Accurate before clever, short with the important words first, 30 to 50 characters where it can be (that band did best across 18,080 channels measured by a third party), and a promise the film's own opening pays off. YouTube calls misleading titles and thumbnails "malicious clickbait" under its spam policy, and says the intro has to deliver what they promised. The chosen title needs accuracy and risk of at least 4 and a total of at least 22 out of 30, and it must be one of the scored options, word for word.

## The decision you must not make alone

A generated voice in the person's own cloned voice needs no label under YouTube's rules, but only if the voice is theirs. Ask: "Is this voice yours?" and set `confirmedByPerson: true` only on their yes. The gate refuses `own-voice-clone` without it. The same question stands for any real person's likeness or voice in generated or altered footage: that is a disclose case and a likeness question, and the person decides before it ships.

Say the licence as it is. A commentary clip is warned, credited and linked, and the fair-use judgement is the person's, not yours.

## When it goes wrong

- **The gate and the file disagree after an edit.** Re-run the render, copy the new receipt into `master`, re-measure what changed. Never edit the hash to match.
- **The chapters block fails after you changed a marker label.** Rebuild with `chapters`, paste the new block into the text, and set `description.chapters` from the same output.
- **A title scores under 22.** Write better options. Do not argue the score up.
- **A claim in the title has no proof in the ledger.** Drop the claim or add the proof to the film; do not keep it.
- **Shell not available.** Apply the references by hand, say in your answer that the package is unchecked, and do not hand it to the upload step as ready.

## What you leave behind

`receipts/publish.json` that `check` accepts, and an answer that says: the chosen title and the two next best, the chapters, what will carry the AI label and why, anything the person has to decide, and every warning left standing.
