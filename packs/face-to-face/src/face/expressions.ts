// Audio tags ([chuckles], [warmly], ...) -> facial expression. Tags ride in the caption word stream;
// each one raises an expression for a moment: quick attack, a hold, a slower release.
import { type CaptionWord, markTags } from "./lipsync";
import type { ArkitName } from "./shapes";

export interface ExprDef {
	shapes: Partial<Record<ArkitName, number>>;
	/** Multiplier on how far the mouth opens while it is active (whispers < 1, excited > 1). */
	mouthScale?: number;
	/** Hz of a laugh-style pulse riding the expression (also bounces the jaw). */
	pulseHz?: number;
	/** Head offsets in radians (nod down +, tilt roll). */
	pitch?: number;
	roll?: number;
}

const both = (a: ArkitName, b: ArkitName, v: number): Partial<Record<ArkitName, number>> => ({ [a]: v, [b]: v });

/** First matching rule wins; matched against the lower-cased tag text. */
export const EXPRESSION_RULES: { match: RegExp; expr: ExprDef }[] = [
	{ match: /laugh|chuckl|giggl|snicker|haha|amused/, expr: { shapes: { ...both("mouthSmileLeft", "mouthSmileRight", 0.8), ...both("cheekSquintLeft", "cheekSquintRight", 0.55), ...both("eyeSquintLeft", "eyeSquintRight", 0.4), browOuterUpLeft: 0.15, browOuterUpRight: 0.15 }, pulseHz: 5.5, pitch: 0.03 } },
	{ match: /surpris|gasp|shock|amaz|astonish/, expr: { shapes: { ...both("eyeWideLeft", "eyeWideRight", 0.7), browInnerUp: 0.55, ...both("browOuterUpLeft", "browOuterUpRight", 0.6), jawOpen: 0.2 }, mouthScale: 1.2, pitch: -0.03 } },
	{ match: /excit|thrill|enthusias|energ|eager|joy|delight|proud/, expr: { shapes: { ...both("browOuterUpLeft", "browOuterUpRight", 0.5), browInnerUp: 0.25, ...both("mouthSmileLeft", "mouthSmileRight", 0.45), ...both("eyeWideLeft", "eyeWideRight", 0.2) }, mouthScale: 1.25 } },
	{ match: /playful|tease|mischiev|cheeky|wink/, expr: { shapes: { mouthSmileLeft: 0.3, mouthSmileRight: 0.65, browOuterUpRight: 0.45, cheekSquintRight: 0.25, eyeSquintRight: 0.2 }, roll: 0.05 } },
	{ match: /warm|gentl|soft|kind|tender|affection|smil|reassur|friendly/, expr: { shapes: { ...both("mouthSmileLeft", "mouthSmileRight", 0.38), ...both("cheekSquintLeft", "cheekSquintRight", 0.18), browInnerUp: 0.1 } } },
	{ match: /sigh|exhale|weary|tired|relie/, expr: { shapes: { browInnerUp: 0.45, jawOpen: 0.12, ...both("mouthFrownLeft", "mouthFrownRight", 0.15) }, pitch: 0.06 } },
	{ match: /whisper|quiet|hush|murmur|low voice/, expr: { shapes: { ...both("eyeSquintLeft", "eyeSquintRight", 0.1) }, mouthScale: 0.45, pitch: 0.03 } },
	{ match: /sad|sorrow|somber|melanchol|hurt|apolog|regret|disappoint/, expr: { shapes: { ...both("mouthFrownLeft", "mouthFrownRight", 0.45), browInnerUp: 0.55, ...both("eyeSquintLeft", "eyeSquintRight", 0.1) }, pitch: 0.05 } },
	{ match: /nervous|anxious|worr|strain|tense|uneasy/, expr: { shapes: { browInnerUp: 0.4, ...both("mouthFrownLeft", "mouthFrownRight", 0.1), ...both("eyeWideLeft", "eyeWideRight", 0.15) } } },
	{ match: /curious|wonder|question|thought|hmm|puzzl|ponder/, expr: { shapes: { browOuterUpLeft: 0.5, browInnerUp: 0.2, browDownRight: 0.12 }, roll: -0.05 } },
	{ match: /serious|firm|stern|command|angry|frustrat|urgent|focus/, expr: { shapes: { ...both("browDownLeft", "browDownRight", 0.5), ...both("mouthFrownLeft", "mouthFrownRight", 0.15), ...both("eyeSquintLeft", "eyeSquintRight", 0.15) }, mouthScale: 1.05 } },
];

const NEUTRAL: ExprDef = { shapes: {} };

export function exprForTag(tag: string): ExprDef {
	const t = tag.toLowerCase();
	return EXPRESSION_RULES.find((r) => r.match.test(t))?.expr ?? NEUTRAL;
}

export interface ExprEvent {
	t0: number;
	/** Hold time after the attack. */
	hold: number;
	expr: ExprDef;
}

const ATTACK = 0.18;
const RELEASE = 0.7;
const DEFAULT_HOLD = 1.5;
const MAX_HOLD = 3.5;

/** Envelope 0..1 of an event at time t: linear-smooth attack, flat hold, smooth release. */
export function exprEnvelope(ev: ExprEvent, t: number): number {
	const x = t - ev.t0;
	if (x < 0) return 0;
	if (x < ATTACK) return smooth(x / ATTACK);
	if (x < ATTACK + ev.hold) return 1;
	const r = (x - ATTACK - ev.hold) / RELEASE;
	return r >= 1 ? 0 : smooth(1 - r);
}

function smooth(x: number): number {
	return x * x * (3 - 2 * x);
}

/** One expression event per audio tag in the word stream; a tag holds until the next tag starts (capped). */
export function expressionEvents(words: readonly CaptionWord[]): ExprEvent[] {
	const tags: { t0: number; name: string }[] = [];
	let last: string | undefined;
	for (const w of markTags(words)) {
		if (w.tag === undefined || w.tag === last) {
			if (w.tag === undefined) last = undefined;
			continue;
		}
		last = w.tag;
		tags.push({ t0: w.s, name: w.tag });
	}
	return tags.map((tg, i) => {
		const next = tags[i + 1]?.t0;
		const hold = Math.min(MAX_HOLD, next !== undefined ? Math.max(0.4, next - tg.t0 - ATTACK) : DEFAULT_HOLD);
		return { t0: tg.t0, hold, expr: exprForTag(tg.name) };
	});
}
