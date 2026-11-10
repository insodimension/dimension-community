---
id: ai-news
kind: channel
built: 2026-11-03
expires: 2027-02-01
basis: borrowed
---
# Persona: the AI-news channel viewer (base audience)

A starting persona for a new comedy channel about AI news, which has no viewers of its own yet. It is a **proxy** (`basis: borrowed`): it was built from about 8,600 public comments on comparable AI-news and commentary channels and AI subreddits, counted and labelled, then summarised here in our own words. It quotes no comment. Replace it with your own channel's persona (the §1.3 protocol in FRAMEWORK.md) in your brand's `productions/dopamine-debt/personas/channel/` folder once your films have viewers, and name that file in each production's `dopamine-debt.json`.

## Core
Follows AI news to hear what happened without the lab's spin, and rewards jokes built from the company's own claims and numbers. Uses AI tools daily and speaks their slang. Sceptical by default: hype, ads, question-mark titles and anything that sounds paid or machine-written get called out fast.

## Floor
Knows the model names and calls the whole thing a bubble, but not finance terms: S-1, GAAP, dual-class and convertible notes are almost never used in these comments and nobody asks about them.

## Knowledge map
| term | level | usage |
|---|---|---|
| S-1, prospectus, dilution | doesn't | 0.08%, 0.1% use |
| convertible notes, dual-class, GAAP, hyperscaler | doesn't | almost never |
| IPO | shaky | 0.4% use, never asked about |
| revenue, profit, valuation | shaky | 0.2%, 0.5%, 0.3% use |
| bubble, dot-com, circular financing | knows as a story | 2.2%, 0.3%, 0.1% |
| model names and versions | knows; asks only about naming | 3.1% use |
| LLM, tokens, benchmarks, agents | knows | 2.3%, 1.5%, 2.2%, 1.6% |
| distillation, open weights, local models | knows | 1.8%, 1.1%, 0.9% |
| usage limits, lab lore | knows | 0.9%, 0.8% |
| AGI, RSI, slop, vibe coding | knows as memes | 0.8%, 0.4%, 0.4%, 0.3% |

## Humour
Laughs at sarcasm and absurd comparisons aimed at the company's own claims, numbers and names (62% of joke comments), then at the host's dry line and the video's running gags. Quotes the sound or picture payoff back. Ads land only as the punchline.

### Cringe triggers
Sounds paid, baited or machine-written: sponsor reads, question-mark titles, AI-voice scripts, an "AI slop" channel. Forced or explained jokes. Each is a small share of comments but each is repeated across sources.

## What the counts say
- About a fifth of comments laugh or joke. Most jokes are about the news or the company's absurdity (62%), then the host's line or delivery (12%); sarcastic irony and absurd comparison are the main forms. Viewers rarely name deadpan: it is the creators' mode, not theirs.
- What they repeat: "trust me, bro" as the claim's whole argument, the sponsor as the punchline, circular financing, "AGI is next year", slop, vibe coding, the dot-com bubble, Skynet and other film canon.
- What drives them away: being sold to or baited, and a script or voice that sounds machine-written. Explicit complaints about length or jargon are rare (each under 0.3% of comments).
- Comments cannot show first-seconds drop-off, pace or retention; age, job and country are not segmented.
