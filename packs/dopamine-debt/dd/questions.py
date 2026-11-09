QUESTION_VERSION = "2.0.0"

FOLLOW = {
    "lost": "lost: does not follow what was just said",
    "followed": "followed: understands it",
    "clicked": "clicked: a satisfying 'oh, that's how it works' moment of understanding",
}
AFFECT = {
    "cringe": "cringe: forced, try-hard, explained, corporate, or an in-joke meant for someone else",
    "flat": "flat: no comic reaction",
    "smile": "smile: mildly amused",
    "laugh": "laugh: a real laugh out loud",
}
LOAD = ["effortless", "light", "heavy", "exhausting"]


def _choice(card, ask, labels, reverse):
    keys = list(labels)[::-1] if reverse else list(labels)
    return {"type": "choice", "instructions": f"{card} {ask}", "criteria": {k: labels[k] for k in keys}}


def segment_questions(card):
    ask_f = ("'before' is what the video said in the previous seconds; 'line' is what is said now; 'picture' and 'sound' are what is on screen and heard, if given. "
             "Answer as the LEAST-informed viewer in this audience: after hearing 'line' once, are they lost, following, or did it click?")
    return {
        "follow": _choice(card, ask_f, FOLLOW, False),
        "follow_r": _choice(card, ask_f, FOLLOW, True),
        "load": {"type": "score", "instructions": f"{card} How much mental effort does it cost this viewer to take in 'line' on first hearing, at speaking speed, given 'before'?", "criteria": LOAD},
        "anchored": {"type": "bool", "instructions": f"{card} Does 'line' state its fact AND map it onto something this viewer already knows well (an everyday thing, an analogy, a film, game or internet reference), so the comparison explains how the fact works? A bare number, a quote or a joke unrelated to the fact does not count.", "criteria": {"true": "fact stated and mapped onto something familiar", "false": "no such mapping"}},
    }


def bit_questions(card):
    ask_a = ("'before' is what the video said earlier; 'line' is the joke or moment being judged (setup and punch together); 'picture' and 'sound' are what is on screen and heard, if given. "
             "How does this viewer react to 'line' as comedy?")
    return {"affect": _choice(card, ask_a, AFFECT, False), "affect_r": _choice(card, ask_a, AFFECT, True)}


CARRIES = {"carries": {"type": "bool", "instructions": "Does 'line' (with 'picture' if given) state the fact in 'fact', in any wording?", "criteria": {"true": "the fact is stated", "false": "it is not"}}}

FALSIFIABLE = {"falsifiable": {"type": "bool", "instructions": "Is 'take' an opinion that a reasonable, informed viewer could disagree with (not a truism, not a hedge that says both sides)?", "criteria": {"true": "a real, disputable position", "false": "a truism or a hedge"}}}

JUROR_SCHEMA = {
    "type": "object",
    "properties": {"cringe": {"type": "number"}, "laugh": {"type": "number"}, "reason": {"type": "string"}},
    "required": ["cringe", "laugh", "reason"],
}


def juror_prompt(card, before, line, picture, sound):
    return (
        "You are a strict comedy editor for a deadpan, sarcastic explainer channel (in the style of Fireship and Critical Drinker). "
        f"The audience: {card}\n\nWhat the video said just before: {before or '(start of video)'}\n"
        f"The moment being judged: {line}\n" + (f"On screen: {picture}\n" if picture else "") + (f"Heard: {sound}\n" if sound else "") +
        "\nGive two probabilities between 0 and 1: 'cringe' = this audience finds it forced, try-hard, explained, corporate, mean or an in-joke for someone else; "
        "'laugh' = this audience laughs out loud. Then one short reason."
    )


WATCH_SCHEMA = {
    "type": "object",
    "properties": {"keep_watching": {"type": "number"}, "left_at_s": {"type": "number"}, "reason": {"type": "string"}},
    "required": ["keep_watching", "left_at_s", "reason"],
}


def watch_prompt(card, transcript, duration):
    return (
        "You are one viewer from this audience, scrolling YouTube, who clicked a video from a deadpan, sarcastic explainer channel. "
        f"The audience: {card}\n\nBelow is the whole video as it plays ({duration:.0f} s), one line per moment, with the time it starts, "
        "what is said or heard, and what is on screen.\n\n" + transcript +
        "\n\nWould you keep watching to the end? Give 'keep_watching' = the probability between 0 and 1 that you watch to the end rather than click away; "
        f"'left_at_s' = the second at which you would most likely click away ({duration:.0f} if you would finish); "
        "and 'reason' = why, in two or three sentences that name the moments that kept or lost you."
    )
