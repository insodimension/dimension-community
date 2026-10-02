import { Component, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { ARKIT_52_NAMES, useVoiceConversation } from "@fraym/ui";
//#region src/face/lipsync.ts
var VISEMES = [
	"PP",
	"FF",
	"TH",
	"DD",
	"KK",
	"CH",
	"SS",
	"nn",
	"RR",
	"aa",
	"E",
	"I",
	"O",
	"U"
];
var both$1 = (n, v) => ({
	[`${n}Left`]: v,
	[`${n}Right`]: v
});
/**
* Each viseme as a sparse blend of ARKit shapes at the weight a natural speaker reaches when that viseme is
* fully on (the usual Oculus -> ARKit practice, scaled down: speech opens the lower lip far more than the jaw,
* lip corners barely move). Bilabials press instead of opening; only mouth-group shapes appear here, so the
* eyes, brows and blink can never be double-driven by the fallback.
*/
var VISEME_RIG = {
	PP: {
		mouthClose: .7,
		...both$1("mouthPress", .75),
		mouthRollLower: .15
	},
	FF: {
		mouthRollLower: .55,
		mouthShrugUpper: .4,
		jawOpen: .06
	},
	TH: {
		jawOpen: .1,
		...both$1("mouthLowerDown", .25)
	},
	DD: {
		jawOpen: .08,
		...both$1("mouthLowerDown", .12),
		...both$1("mouthStretch", .15)
	},
	KK: {
		jawOpen: .1,
		...both$1("mouthLowerDown", .15),
		...both$1("mouthStretch", .08)
	},
	CH: {
		mouthFunnel: .4,
		jawOpen: .08,
		...both$1("mouthLowerDown", .1),
		...both$1("mouthStretch", .1)
	},
	SS: {
		jawOpen: .06,
		...both$1("mouthStretch", .3),
		...both$1("mouthSmile", .08)
	},
	nn: {
		jawOpen: .06,
		...both$1("mouthLowerDown", .08),
		...both$1("mouthStretch", .12)
	},
	RR: {
		mouthFunnel: .3,
		mouthPucker: .25,
		jawOpen: .1,
		...both$1("mouthLowerDown", .15)
	},
	aa: {
		jawOpen: .36,
		...both$1("mouthLowerDown", .5),
		...both$1("mouthUpperUp", .2)
	},
	E: {
		jawOpen: .15,
		...both$1("mouthLowerDown", .22),
		...both$1("mouthStretch", .3),
		...both$1("mouthSmile", .2)
	},
	I: {
		jawOpen: .1,
		...both$1("mouthLowerDown", .12),
		...both$1("mouthStretch", .25),
		...both$1("mouthSmile", .22)
	},
	O: {
		jawOpen: .25,
		mouthFunnel: .5,
		mouthPucker: .3,
		...both$1("mouthLowerDown", .3)
	},
	U: {
		jawOpen: .08,
		mouthPucker: .5,
		mouthFunnel: .35,
		...both$1("mouthLowerDown", .08)
	}
};
var STRENGTH = {
	PP: 1,
	FF: .9,
	TH: .6,
	DD: .5,
	KK: .35,
	CH: .7,
	SS: .55,
	nn: .4,
	RR: .55,
	aa: .95,
	E: .8,
	I: .7,
	O: .9,
	U: .85
};
var VOWELS = /* @__PURE__ */ new Set([
	"aa",
	"E",
	"I",
	"O",
	"U"
]);
var DIGRAPHS = [
	["tch", "CH"],
	["igh", "I"],
	["sh", "CH"],
	["ch", "CH"],
	["th", "TH"],
	["ph", "FF"],
	["ng", "nn"],
	["ck", "KK"],
	["kn", "nn"],
	["wr", "RR"],
	["wh", "U"],
	["oo", "U"],
	["ou", "O"],
	["ow", "O"],
	["oa", "O"],
	["oi", "O"],
	["oy", "O"],
	["ee", "I"],
	["ea", "I"],
	["ie", "I"],
	["ai", "E"],
	["ay", "E"],
	["ei", "E"],
	["ey", "E"],
	["au", "aa"],
	["aw", "aa"],
	["ew", "U"],
	["ue", "U"],
	["ui", "I"]
];
var LETTER = {
	a: "aa",
	e: "E",
	i: "I",
	o: "O",
	u: "U",
	y: "I",
	b: "PP",
	m: "PP",
	p: "PP",
	f: "FF",
	v: "FF",
	d: "DD",
	t: "DD",
	l: "DD",
	n: "nn",
	k: "KK",
	g: "KK",
	q: "KK",
	s: "SS",
	z: "SS",
	r: "RR",
	w: "U",
	j: "CH",
	c: "KK",
	x: "KK",
	h: null
};
/** Letters of one word as a viseme sequence; empty for a word with nothing to say (punctuation, tags). */
function graphemesToVisemes(word) {
	let w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (w.length > 3 && w.endsWith("e") && !/[aeiouy]e$/.test(w)) w = w.slice(0, -1);
	const out = [];
	const push = (v) => {
		const prev = out[out.length - 1];
		if (prev && prev.viseme === v && !VOWELS.has(v)) return;
		out.push({
			viseme: v,
			strength: STRENGTH[v],
			dur: VOWELS.has(v) ? 1 : v === "PP" ? .6 : .7
		});
	};
	for (let i = 0; i < w.length;) {
		const ch = w[i];
		if (ch >= "0" && ch <= "9") {
			push("E");
			i++;
			continue;
		}
		const hit = DIGRAPHS.find(([g]) => w.startsWith(g, i));
		if (hit) {
			if (hit[1]) push(hit[1]);
			i += hit[0].length;
			continue;
		}
		if (ch === "g" && w[i + 1] === "h") {
			if (i === 0 || !VOWELS.has(LETTER[w[i - 1]] ?? "PP")) push("KK");
			i += 2;
			continue;
		}
		if (ch === "c" && "eiy".includes(w[i + 1] ?? "")) push("SS");
		else if (ch === "x") {
			push("KK");
			push("SS");
		} else {
			const v = LETTER[ch];
			if (v) push(v);
		}
		i++;
	}
	return out;
}
var MIN_WORD = .06;
/** Spread a word's phones across [s, e]; each phone becomes a bump wide enough to overlap its neighbours. */
function scheduleWord(word, s, e) {
	const phones = graphemesToVisemes(word);
	if (phones.length === 0) return [];
	const total = phones.reduce((a, p) => a + p.dur, 0);
	const span = Math.max(e - s, MIN_WORD);
	const events = [];
	let at = s;
	for (const p of phones) {
		const width = span * p.dur / total;
		events.push({
			center: at + width / 2,
			half: Math.max(.7 * width + .03, .05),
			viseme: p.viseme,
			strength: p.strength
		});
		at += width;
	}
	return events;
}
/**
* Splits spoken words from audio tags. A tag is a bracketed run of tokens: "[chuckles]" is one token,
* "[clapperboard snap]" arrives as "[clapperboard" + "snap]"; an unterminated tag swallows the rest.
*/
function markTags(words) {
	const out = [];
	let open = null;
	const close = () => {
		if (!open) return;
		const name = open.map((t) => t.w).join(" ").replace(/^\[|\]$/g, "").trim();
		for (const t of open) t.tag = name;
		open = null;
	};
	for (const word of words) {
		const t = { ...word };
		out.push(t);
		if (!open && !word.w.startsWith("[")) continue;
		(open ??= []).push(t);
		if (word.w.endsWith("]")) close();
	}
	close();
	return out;
}
var VisemeTrack = class {
	events = [];
	maxHalf = 0;
	out = new Float32Array(VISEMES.length);
	clear() {
		this.events = [];
		this.maxHalf = 0;
	}
	get size() {
		return this.events.length;
	}
	/** Replace the schedule with the visemes of every spoken word (tags are skipped). */
	setWords(words) {
		this.clear();
		for (const { w, s, e, tag } of markTags(words)) {
			if (tag !== void 0) continue;
			for (const ev of scheduleWord(w, s, e)) {
				this.events.push(ev);
				this.maxHalf = Math.max(this.maxHalf, ev.half);
			}
		}
		this.events.sort((a, b) => a.center - b.center);
	}
	/** Viseme weights at time t (order of VISEMES), normalised so the mouth never asks for more than one shape's worth. Returns the raw sum. */
	sample(t) {
		const out = this.out;
		out.fill(0);
		const ev = this.events;
		let lo = 0;
		let hi = ev.length;
		const from = t - this.maxHalf;
		while (lo < hi) {
			const mid = lo + hi >> 1;
			if (ev[mid].center < from) lo = mid + 1;
			else hi = mid;
		}
		let sum = 0;
		for (let i = lo; i < ev.length && ev[i].center <= t + this.maxHalf; i++) {
			const x = (t - ev[i].center) / ev[i].half;
			if (x <= -1 || x >= 1) continue;
			const k = ev[i].viseme;
			out[VISEME_INDEX[k]] += ev[i].strength * .5 * (1 + Math.cos(Math.PI * x));
		}
		for (let i = 0; i < out.length; i++) {
			out[i] = Math.min(1, out[i]);
			sum += out[i];
		}
		if (sum > 1) for (let i = 0; i < out.length; i++) out[i] /= sum;
		return sum;
	}
};
var VISEME_INDEX = Object.fromEntries(VISEMES.map((v, i) => [v, i]));
//#endregion
//#region src/face/expressions.ts
var both = (a, b, v) => ({
	[a]: v,
	[b]: v
});
/** First matching rule wins; matched against the lower-cased tag text. */
var EXPRESSION_RULES = [
	{
		match: /laugh|chuckl|giggl|snicker|haha|amused/,
		expr: {
			shapes: {
				...both("mouthSmileLeft", "mouthSmileRight", .8),
				...both("cheekSquintLeft", "cheekSquintRight", .55),
				...both("eyeSquintLeft", "eyeSquintRight", .4),
				browOuterUpLeft: .15,
				browOuterUpRight: .15
			},
			pulseHz: 5.5,
			pitch: .03
		}
	},
	{
		match: /surpris|gasp|shock|amaz|astonish/,
		expr: {
			shapes: {
				...both("eyeWideLeft", "eyeWideRight", .7),
				browInnerUp: .55,
				...both("browOuterUpLeft", "browOuterUpRight", .6),
				jawOpen: .2
			},
			mouthScale: 1.2,
			pitch: -.03
		}
	},
	{
		match: /excit|thrill|enthusias|energ|eager|joy|delight|proud/,
		expr: {
			shapes: {
				...both("browOuterUpLeft", "browOuterUpRight", .5),
				browInnerUp: .25,
				...both("mouthSmileLeft", "mouthSmileRight", .45),
				...both("eyeWideLeft", "eyeWideRight", .2)
			},
			mouthScale: 1.25
		}
	},
	{
		match: /playful|tease|mischiev|cheeky|wink/,
		expr: {
			shapes: {
				mouthSmileLeft: .3,
				mouthSmileRight: .65,
				browOuterUpRight: .45,
				cheekSquintRight: .25,
				eyeSquintRight: .2
			},
			roll: .05
		}
	},
	{
		match: /warm|gentl|soft|kind|tender|affection|smil|reassur|friendly/,
		expr: { shapes: {
			...both("mouthSmileLeft", "mouthSmileRight", .38),
			...both("cheekSquintLeft", "cheekSquintRight", .18),
			browInnerUp: .1
		} }
	},
	{
		match: /sigh|exhale|weary|tired|relie/,
		expr: {
			shapes: {
				browInnerUp: .45,
				jawOpen: .12,
				...both("mouthFrownLeft", "mouthFrownRight", .15)
			},
			pitch: .06
		}
	},
	{
		match: /whisper|quiet|hush|murmur|low voice/,
		expr: {
			shapes: { ...both("eyeSquintLeft", "eyeSquintRight", .1) },
			mouthScale: .45,
			pitch: .03
		}
	},
	{
		match: /sad|sorrow|somber|melanchol|hurt|apolog|regret|disappoint/,
		expr: {
			shapes: {
				...both("mouthFrownLeft", "mouthFrownRight", .45),
				browInnerUp: .55,
				...both("eyeSquintLeft", "eyeSquintRight", .1)
			},
			pitch: .05
		}
	},
	{
		match: /nervous|anxious|worr|strain|tense|uneasy/,
		expr: { shapes: {
			browInnerUp: .4,
			...both("mouthFrownLeft", "mouthFrownRight", .1),
			...both("eyeWideLeft", "eyeWideRight", .15)
		} }
	},
	{
		match: /curious|wonder|question|thought|hmm|puzzl|ponder/,
		expr: {
			shapes: {
				browOuterUpLeft: .5,
				browInnerUp: .2,
				browDownRight: .12
			},
			roll: -.05
		}
	},
	{
		match: /serious|firm|stern|command|angry|frustrat|urgent|focus/,
		expr: {
			shapes: {
				...both("browDownLeft", "browDownRight", .5),
				...both("mouthFrownLeft", "mouthFrownRight", .15),
				...both("eyeSquintLeft", "eyeSquintRight", .15)
			},
			mouthScale: 1.05
		}
	}
];
var NEUTRAL = { shapes: {} };
function exprForTag(tag) {
	const t = tag.toLowerCase();
	return EXPRESSION_RULES.find((r) => r.match.test(t))?.expr ?? NEUTRAL;
}
var ATTACK = .18;
var RELEASE = .7;
var DEFAULT_HOLD = 1.5;
var MAX_HOLD = 3.5;
/** Envelope 0..1 of an event at time t: linear-smooth attack, flat hold, smooth release. */
function exprEnvelope(ev, t) {
	const x = t - ev.t0;
	if (x < 0) return 0;
	if (x < ATTACK) return smooth(x / ATTACK);
	if (x < ATTACK + ev.hold) return 1;
	const r = (x - ATTACK - ev.hold) / RELEASE;
	return r >= 1 ? 0 : smooth(1 - r);
}
function smooth(x) {
	return x * x * (3 - 2 * x);
}
/** One expression event per audio tag in the word stream; a tag holds until the next tag starts (capped). */
function expressionEvents(words) {
	const tags = [];
	let last;
	for (const w of markTags(words)) {
		if (w.tag === void 0 || w.tag === last) {
			if (w.tag === void 0) last = void 0;
			continue;
		}
		last = w.tag;
		tags.push({
			t0: w.s,
			name: w.tag
		});
	}
	return tags.map((tg, i) => {
		const next = tags[i + 1]?.t0;
		const hold = Math.min(MAX_HOLD, next !== void 0 ? Math.max(.4, next - tg.t0 - ATTACK) : DEFAULT_HOLD);
		return {
			t0: tg.t0,
			hold,
			expr: exprForTag(tg.name)
		};
	});
}
//#endregion
//#region src/face/shapes.ts
var ARKIT_52 = [
	"browDownLeft",
	"browDownRight",
	"browInnerUp",
	"browOuterUpLeft",
	"browOuterUpRight",
	"cheekPuff",
	"cheekSquintLeft",
	"cheekSquintRight",
	"eyeBlinkLeft",
	"eyeBlinkRight",
	"eyeLookDownLeft",
	"eyeLookDownRight",
	"eyeLookInLeft",
	"eyeLookInRight",
	"eyeLookOutLeft",
	"eyeLookOutRight",
	"eyeLookUpLeft",
	"eyeLookUpRight",
	"eyeSquintLeft",
	"eyeSquintRight",
	"eyeWideLeft",
	"eyeWideRight",
	"jawForward",
	"jawLeft",
	"jawOpen",
	"jawRight",
	"mouthClose",
	"mouthDimpleLeft",
	"mouthDimpleRight",
	"mouthFrownLeft",
	"mouthFrownRight",
	"mouthFunnel",
	"mouthLeft",
	"mouthLowerDownLeft",
	"mouthLowerDownRight",
	"mouthPressLeft",
	"mouthPressRight",
	"mouthPucker",
	"mouthRight",
	"mouthRollLower",
	"mouthRollUpper",
	"mouthShrugLower",
	"mouthShrugUpper",
	"mouthSmileLeft",
	"mouthSmileRight",
	"mouthStretchLeft",
	"mouthStretchRight",
	"mouthUpperUpLeft",
	"mouthUpperUpRight",
	"noseSneerLeft",
	"noseSneerRight",
	"tongueOut"
];
var POSE_SIZE = ARKIT_52.length;
var INDEX = Object.fromEntries(ARKIT_52.map((n, i) => [n, i]));
/** Index of an ARKit shape in the pose vector; throws on an unknown name so a typo cannot silently drop a morph. */
function arkitIndex(name) {
	const i = INDEX[name];
	if (i === void 0) throw new Error(`unknown ARKit shape ${name}`);
	return i;
}
/** Same, for a name that arrives as data (an asset header): undefined instead of a throw. */
function arkitIndexOf(name) {
	return INDEX[name];
}
/**
* The shapes the audio model owns: everything it actually emits (jaw, mouth, cheek, nose). Blink, gaze, brows,
* head pose and the [tag] expressions never come from the model (it emits eyeBlink max 0.001), so they stay
* procedural and are added on top of whichever source drives this group.
*/
function isMouthShape(name) {
	return name.startsWith("jaw") || name.startsWith("mouth") || name.startsWith("cheek") || name.startsWith("nose") || name === "tongueOut";
}
var MOUTH_MASK = Uint8Array.from(ARKIT_52, (n) => isMouthShape(n) ? 1 : 0);
var RIG = {};
var RIG_GAIN = Float32Array.from(ARKIT_52, (n) => RIG[n]?.gain ?? 1);
var RIG_MAX = Float32Array.from(ARKIT_52, (n) => RIG[n]?.max ?? 1);
//#endregion
//#region src/face/animator.ts
/**
* Critically damped spring, exact closed form (no integration error, any dt): advances `sp` in place
* by dt seconds toward `target` with natural frequency `omega` rad/s.
*/
function springStep(sp, target, omega, dt) {
	const k = Math.exp(-omega * dt);
	const d = sp[0] - target;
	const j = (sp[1] + omega * d) * dt;
	sp[0] = target + (d + j) * k;
	sp[1] = (sp[1] - omega * j) * k;
}
/** Eyelid closure 0..1 at `age` seconds into a blink: quick close, a beat shut, slower open. */
function blinkCurve(age) {
	if (age <= 0 || age >= .26) return 0;
	if (age < .07) return Math.sin(age / .07 * Math.PI * .5);
	if (age < .1) return 1;
	return Math.cos((age - .1) / .16 * Math.PI * .5);
}
/**
* Per-source gains, one place to trim how far each mouth source opens (1 = as designed). Per-shape limits of
* the model live in the renderer's rig table; `model` here is only a global trim on its whole mouth group.
*/
var GAIN = {
	/** Everything the viseme rig contributes (procedural path). */
	viseme: 1,
	/** The audio-RMS coupling of the jaw and lower lip (procedural path). */
	voice: 1,
	/** jawOpen itself on the procedural path: speech opens through mouthLowerDown far more than through the jaw. */
	jaw: 1,
	/** The audio model's whole mouth group. */
	model: 1
};
/** Soft ceilings of the summed procedural opening (viseme rig + voice) before the springs: x -> limit * tanh(x / limit). */
var LIMIT = {
	jaw: .42,
	lower: .62
};
/** How much the voice alone opens jaw / lower lip / upper lip at full loudness (before GAIN.voice and the compressor). */
var VOICE = {
	jaw: .2,
	lower: .3,
	upper: .08
};
/** Audio RMS that reads as fully loud; loudness beyond it only feeds the compressor. */
var VOICE_REF = .1;
/** Model open-proxy (the larger of jawOpen and the mean lower-lip drop) below REST_LO reads as a closed mouth; its opening ramps in until REST_HI. */
var REST_LO = .07;
var REST_HI = .2;
/** mouthClose held at rest (model below the knee, procedural without voice or visemes). */
var CLOSE_REST = .25;
/** Latched audioRms above this proves the host supplies audio energy this turn. */
var RMS_SEEN = .02;
/** How much an audibly silent moment (audioRms present and ~0) attenuates the model's opening. */
var RMS_CLOSE = .5;
/** Seconds to cross-fade the mouth group between the model and the procedural source, either way. */
var XFADE = .1;
/** Stress (brow lift, nod) from how fast the model's opening rises, when there is no audio energy to read it from. */
var MODEL_STRESS = 8;
/** Seconds the mouth leads the audio clock so closures land before the sound. */
var LEAD = .035;
var TAU = Math.PI * 2;
var ix = arkitIndex;
var JAW = ix("jawOpen");
var LOW_L = ix("mouthLowerDownLeft");
var LOW_R = ix("mouthLowerDownRight");
var UP_L = ix("mouthUpperUpLeft");
var UP_R = ix("mouthUpperUpRight");
var FUNNEL = ix("mouthFunnel");
var CLOSE = ix("mouthClose");
var SMILE_L = ix("mouthSmileLeft");
var SMILE_R = ix("mouthSmileRight");
var FROWN_L = ix("mouthFrownLeft");
var FROWN_R = ix("mouthFrownRight");
var BROW_IN = ix("browInnerUp");
var BROW_OUT_L = ix("browOuterUpLeft");
var BROW_OUT_R = ix("browOuterUpRight");
var BROW_DOWN_L = ix("browDownLeft");
var BROW_DOWN_R = ix("browDownRight");
var WIDE_L = ix("eyeWideLeft");
var WIDE_R = ix("eyeWideRight");
var SQUINT_L = ix("eyeSquintLeft");
var SQUINT_R = ix("eyeSquintRight");
var BLINK_L$1 = ix("eyeBlinkLeft");
var BLINK_R$1 = ix("eyeBlinkRight");
/** The shapes that widen the mouth: what the knee scales at rest and what a tag's mouthScale scales on the model. */
var OPEN_GROUP = Uint8Array.from([
	"jawOpen",
	"mouthLowerDownLeft",
	"mouthLowerDownRight",
	"mouthUpperUpLeft",
	"mouthUpperUpRight",
	"mouthShrugUpper",
	"mouthShrugLower",
	"mouthStretchLeft",
	"mouthStretchRight"
].map(ix));
/** VISEME_RIG as flat index/weight arrays, so a step never walks an object. */
var RIG_IDX = VISEMES.map((v) => Uint8Array.from(Object.keys(VISEME_RIG[v]), (n) => ix(n)));
var RIG_VAL = VISEMES.map((v) => Float32Array.from(Object.values(VISEME_RIG[v])));
var V_PP = VISEMES.indexOf("PP");
var V_FF = VISEMES.indexOf("FF");
var V_CLOSERS = [
	VISEMES.indexOf("nn"),
	VISEMES.indexOf("DD"),
	VISEMES.indexOf("SS"),
	VISEMES.indexOf("KK")
];
/** Vowels the mouth cycles through while the voice runs ahead of the word timings. */
var V_FALLBACK = [
	"aa",
	"E",
	"O",
	"I"
].map((v) => VISEMES.indexOf(v));
/**
* Natural frequency (rad/s) of the spring behind each channel: the lips and jaw fast (they carry the
* consonants), lip corners and cheeks slower, brows and lids slowest; a blink is near-instant.
*/
var OMEGA = Float32Array.from(ARKIT_52, (n) => {
	if (n.startsWith("eyeBlink")) return 90;
	if (n === "jawOpen") return 24;
	if (/^mouth(Smile|Frown|Dimple|Left|Right)/.test(n)) return 14;
	if (MOUTH_MASK[ARKIT_52.indexOf(n)] && !n.startsWith("cheek") && !n.startsWith("nose")) return 26;
	if (n.startsWith("cheek") || n.startsWith("nose")) return 14;
	return 11;
});
/** The model's frames are already smooth, so its mouth springs run this much tighter than the procedural ones (less lag). */
var MODEL_OMEGA_BOOST = .6;
function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = a + 1831565813 >>> 0;
		let t = Math.imul(a ^ a >>> 15, 1 | a);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}
/** NaN reads as 0 so one bad input cannot poison a filter state for good. */
var clamp01 = (x) => x > 0 ? x < 1 ? x : 1 : 0;
var smoothstep = (a, b, x) => {
	const t = clamp01((x - a) / (b - a));
	return t * t * (3 - 2 * t);
};
var soft = (x, limit) => limit * Math.tanh(x / limit);
/**
* Size of the mouth opening 0..1 from the FINAL ARKit weights, for the renderer's mouth-interior dots (it fades
* them in over smoothstep(0.05, 0.38, mouthOpen)): the larger of the jaw and the mean lower-lip drop, plus half
* the mean upper-lip lift and 0.3 of the funnel (an O opens a hole without dropping the jaw). Closed lips read 0;
* natural speech reads about 0.3 mean, 0.55 at its widest.
*/
function mouthOpenOf(w) {
	return clamp01(Math.max(w[JAW], (w[LOW_L] + w[LOW_R]) / 2) + .25 * (w[UP_L] + w[UP_R]) + .3 * w[FUNNEL]);
}
/** Sustained three-quarter turn while speaking: how far, how long a side flip takes, and the gap between flips. */
var TURN = {
	amp: .45,
	flip: 3,
	every: [10, 14]
};
/** Smooth 0..1 tanh-shaped ease that starts and ends exactly at 0 and 1. */
var TANH3 = Math.tanh(3);
var ease = (u) => .5 + .5 * (Math.tanh(3 * (2 * clamp01(u) - 1)) / TANH3);
function makeState(seed) {
	const rnd = mulberry32(seed);
	const side = rnd() < .5 ? -1 : 1;
	return {
		rnd,
		time: 0,
		springs: Array.from({ length: POSE_SIZE }, () => [0, 0]),
		yaw: [0, 0],
		pitch: [0, 0],
		roll: [0, 0],
		gaze: {
			yaw: 0,
			pitch: 0,
			roll: 0
		},
		nextGaze: 0,
		nextBlink: 1 + rnd() * 2,
		blinkAt: -10,
		secondBlinkAt: -10,
		env: 0,
		prevEnv: 0,
		rmsSeen: false,
		mEnv: 0,
		prevMEnv: 0,
		micEnv: 0,
		nodCooldown: 0,
		warm: [0, 0],
		loosen: [0, 0],
		gazeX: [0, 0],
		gazeY: [0, 0],
		saccade: {
			x: 0,
			y: 0,
			next: .5
		},
		fallbackShape: 0,
		fallbackAt: 0,
		mix: 0,
		spoke: 0,
		sideFrom: side,
		sideTo: side,
		flipStart: -TURN.flip,
		flipNext: TURN.every[0] + rnd() * (TURN.every[1] - TURN.every[0])
	};
}
var FaceAnimator = class {
	/** Reused every step; the renderer reads it immediately. */
	frame = {
		weights: new Float32Array(POSE_SIZE),
		yaw: 0,
		pitch: 0,
		roll: 0,
		warm: 0,
		hue: 0,
		formation: 1,
		mouthOpen: 0,
		loosen: 0,
		breath: 0,
		gazeX: 0,
		gazeY: 0
	};
	s;
	track = new VisemeTrack();
	words = [];
	events = [];
	formationGoal = 1;
	pose = "procedural";
	tgt = new Float32Array(POSE_SIZE);
	/** The two mouth groups being cross-faded; only MOUTH_MASK entries are ever non-zero. */
	proc = new Float32Array(POSE_SIZE);
	model = new Float32Array(POSE_SIZE);
	vis = new Float32Array(VISEMES.length);
	constructor(seed = 1) {
		this.s = makeState(seed);
	}
	/** Back to a fresh session (same seed gives the same motion). */
	reset(seed = 1) {
		this.s = makeState(seed);
		this.frame.weights.fill(0);
		this.proc.fill(0);
		this.model.fill(0);
		this.frame.formation = 1;
		this.formationGoal = 1;
		this.setWords([]);
	}
	/** Replace the whole turn's caption words (also carries audio tags for expressions). */
	setWords(words) {
		this.words = words.slice();
		this.track.setWords(this.words);
		this.events = expressionEvents(this.words);
	}
	/** Append an in-order batch of words to the current turn. */
	appendWords(batch) {
		this.setWords([...this.words, ...batch]);
	}
	/** Choose where the mouth comes from; switching cross-fades over ~100 ms, so it is safe at any moment. */
	setPoseSource(src) {
		this.pose = src;
	}
	/** Orb -> face gathers over ~2.4 s (and disperses over ~1.2 s) toward `goal` in 0..1 (1 = face, 0 = orb). */
	setFormationTarget(goal) {
		this.formationGoal = clamp01(goal);
	}
	/** Jump the formation directly (0..1), e.g. to hold the intro at a fixed point (also set the target to hold it). */
	setFormation(v) {
		this.frame.formation = clamp01(v);
	}
	readPose() {
		const src = this.pose;
		if (src === "procedural") return null;
		const v = src.arkit();
		if (!v || v.length !== POSE_SIZE) return null;
		for (let i = 0; i < POSE_SIZE; i++) if (!Number.isFinite(v[i])) return null;
		return v;
	}
	/**
	* The model's mouth group, made to read closed at rest. The ONNX is never quite still (open-proxy ~0.12 over
	* near-silent frames), so the opening shapes are scaled by a smoothstep of the model's own open-proxy around
	* that rest level (quiet speech above the knee is untouched) and a small mouthClose fills in below it. When the
	* host also supplies audio energy, audible silence closes the mouth further. Returns the raw open-proxy.
	*/
	shapeModel(v, mouthScale, silence) {
		const M = this.model;
		for (let i = 0; i < POSE_SIZE; i++) M[i] = MOUTH_MASK[i] ? clamp01(v[i] * GAIN.model) : 0;
		const p = Math.max(M[JAW], (M[LOW_L] + M[LOW_R]) / 2);
		const g = smoothstep(REST_LO, REST_HI, p);
		const k = g * (1 - RMS_CLOSE * silence) * mouthScale;
		for (let j = 0; j < OPEN_GROUP.length; j++) M[OPEN_GROUP[j]] = clamp01(M[OPEN_GROUP[j]] * k);
		M[CLOSE] = Math.max(M[CLOSE], CLOSE_REST * Math.max(1 - g, silence));
		return p;
	}
	/**
	* The procedural mouth group: visemes from the word schedule projected through VISEME_RIG, the voice's own
	* loudness on the jaw and lower lip, both squeezed by a soft ceiling so a loud passage cannot pry the mouth
	* wide, and lips pressed shut wherever a bilabial or the lack of any voice calls for it.
	*/
	shapeProcedural(playhead, speaking, env, open, mouthScale) {
		const P = this.proc;
		P.fill(0);
		let presence = 0;
		if (speaking && playhead !== null) {
			const s = this.s;
			const track = this.track;
			const raw = track.sample(playhead + LEAD);
			const vis = this.vis;
			const gate = s.rmsSeen ? .3 + .7 * smoothstep(.004, .03, env) : 1;
			for (let k = 0; k < vis.length; k++) vis[k] = track.out[k] * (k === V_PP || k === V_FF ? 1 : gate);
			if (raw < .05 && open > .12) {
				if (s.time > s.fallbackAt) {
					s.fallbackShape = (s.fallbackShape + 1) % V_FALLBACK.length;
					s.fallbackAt = s.time + .13 + s.rnd() * .08;
				}
				const k = V_FALLBACK[s.fallbackShape];
				vis[k] = Math.max(vis[k], open * .6);
			}
			let closed = vis[V_PP] + .7 * vis[V_FF];
			for (const k of V_CLOSERS) closed += .25 * vis[k];
			closed = Math.min(1, closed);
			const wv = GAIN.viseme * mouthScale;
			for (let k = 0; k < vis.length; k++) {
				const w = vis[k] * wv;
				if (w === 0) continue;
				const idx = RIG_IDX[k];
				const val = RIG_VAL[k];
				for (let j = 0; j < idx.length; j++) P[idx[j]] += w * val[j];
			}
			const voice = open * GAIN.voice * mouthScale * (1 - closed);
			P[JAW] = soft(GAIN.jaw * P[JAW] + VOICE.jaw * voice, LIMIT.jaw);
			P[LOW_L] = soft(P[LOW_L] + VOICE.lower * voice, LIMIT.lower);
			P[LOW_R] = soft(P[LOW_R] + VOICE.lower * voice, LIMIT.lower);
			P[UP_L] += VOICE.upper * voice;
			P[UP_R] += VOICE.upper * voice;
			presence = clamp01(Math.max(raw, open * 2));
		}
		P[CLOSE] = Math.max(P[CLOSE], CLOSE_REST * (1 - presence));
	}
	step(rawDt, input) {
		const dt = rawDt > 1e-4 ? Math.min(.1, rawDt) : 1e-4;
		const s = this.s;
		s.time += dt;
		const t = s.time;
		const f = this.frame;
		const { state } = input;
		const speaking = state === "speaking";
		const tgt = this.tgt;
		tgt.fill(0);
		s.prevEnv = s.env;
		const rms = clamp01(input.audioRms);
		s.env += (rms - s.env) * (rms > s.env ? 1 - Math.exp(-dt / .012) : 1 - Math.exp(-dt / .05));
		const open = clamp01((s.env / VOICE_REF) ** .7);
		if (input.playhead === null) s.rmsSeen = false;
		else if (rms > RMS_SEEN) s.rmsSeen = true;
		s.micEnv += (clamp01(input.micRms) - s.micEnv) * (1 - Math.exp(-dt / .08));
		const audioStress = clamp01((s.env - s.prevEnv) * 14);
		let exprPulse = 0;
		let mouthScale = 1;
		let exprPitch = 0;
		let exprRoll = 0;
		if (input.playhead !== null) for (const ev of this.events) {
			const a = exprEnvelope(ev, input.playhead);
			if (a <= 0) continue;
			const phase = ev.expr.pulseHz ? Math.sin(TAU * ev.expr.pulseHz * (input.playhead - ev.t0)) : 0;
			const pulse = ev.expr.pulseHz ? .78 + .22 * phase : 1;
			for (const name in ev.expr.shapes) {
				const i = ix(name);
				tgt[i] = Math.min(1, tgt[i] + (ev.expr.shapes[name] ?? 0) * a * pulse);
			}
			if (ev.expr.pulseHz) exprPulse = Math.max(exprPulse, a * (.5 + .5 * phase));
			mouthScale *= 1 + ((ev.expr.mouthScale ?? 1) - 1) * a;
			exprPitch += (ev.expr.pitch ?? 0) * a;
			exprRoll += (ev.expr.roll ?? 0) * a;
		}
		const frameFromModel = this.readPose();
		const silence = s.rmsSeen ? 1 - smoothstep(.002, .015, s.env) : 0;
		const pModel = frameFromModel ? this.shapeModel(frameFromModel, mouthScale, silence) : 0;
		const xstep = dt / XFADE;
		s.mix += Math.max(-xstep, Math.min(xstep, (frameFromModel ? 1 : 0) - s.mix));
		const b = s.mix * s.mix * (3 - 2 * s.mix);
		if (b < 1) this.shapeProcedural(input.playhead, speaking, s.env, open, mouthScale);
		const proc = this.proc;
		const model = this.model;
		for (let i = 0; i < POSE_SIZE; i++) if (MOUTH_MASK[i]) tgt[i] += proc[i] * (1 - b) + model[i] * b;
		tgt[JAW] += exprPulse * .1;
		s.prevMEnv = s.mEnv;
		s.mEnv += (pModel - s.mEnv) * (pModel > s.mEnv ? 1 - Math.exp(-dt / .03) : 1 - Math.exp(-dt / .08));
		const stress = Math.max(audioStress, clamp01((s.mEnv - s.prevMEnv) * MODEL_STRESS));
		let warmGoal = .05;
		let loosenGoal = 0;
		tgt[WIDE_L] += .12;
		tgt[WIDE_R] += .12;
		if (state === "idle") {
			tgt[SMILE_L] += .05;
			tgt[SMILE_R] += .05;
		} else if (state === "listening") {
			tgt[BROW_IN] += .22;
			tgt[BROW_OUT_L] += .1;
			tgt[BROW_OUT_R] += .1;
			tgt[WIDE_L] += .03;
			tgt[WIDE_R] += .03;
			warmGoal = -.45;
		} else if (state === "thinking") {
			tgt[BROW_DOWN_L] += .12;
			tgt[BROW_DOWN_R] += .08;
			tgt[BROW_IN] += .08;
			tgt[FROWN_L] += .1;
			tgt[FROWN_R] += .1;
			tgt[SQUINT_L] += .03;
			tgt[SQUINT_R] += .03;
			tgt[WIDE_L] -= .02;
			tgt[WIDE_R] -= .02;
			warmGoal = -.15;
			loosenGoal = 1;
		} else {
			tgt[SMILE_L] += .1;
			tgt[SMILE_R] += .1;
			tgt[BROW_IN] += .06 + .3 * stress;
			tgt[BROW_OUT_L] += .2 * stress;
			tgt[BROW_OUT_R] += .2 * stress;
			warmGoal = .55;
		}
		if (t >= s.nextBlink) {
			s.blinkAt = t;
			s.secondBlinkAt = s.rnd() < .22 ? t + .2 : -10;
			s.nextBlink = t + 2 + s.rnd() * 4;
		}
		const blink = Math.max(blinkCurve(t - s.blinkAt), blinkCurve(t - s.secondBlinkAt));
		tgt[BLINK_L$1] = Math.max(tgt[BLINK_L$1], blink);
		tgt[BLINK_R$1] = Math.max(tgt[BLINK_R$1], blink);
		tgt[WIDE_L] *= 1 - blink;
		tgt[WIDE_R] *= 1 - blink;
		const w = f.weights;
		const boost = 1 + MODEL_OMEGA_BOOST * b;
		for (let i = 0; i < POSE_SIZE; i++) {
			springStep(s.springs[i], clamp01(tgt[i]), MOUTH_MASK[i] ? OMEGA[i] * boost : OMEGA[i], dt);
			w[i] = clamp01(s.springs[i][0]);
		}
		if (t >= s.nextGaze) {
			const side = s.rnd() < .5 ? -1 : 1;
			s.gaze.yaw = state === "thinking" ? side * (.16 + s.rnd() * .08) : state === "listening" ? (s.rnd() - .5) * .06 : (s.rnd() - .5) * .14;
			s.gaze.pitch = state === "thinking" ? -.07 : state === "listening" ? .02 : (s.rnd() - .5) * .06;
			s.gaze.roll = state === "listening" ? side * .035 : (s.rnd() - .5) * .06;
			s.nextGaze = t + (state === "thinking" ? 2.6 : 1.6) + s.rnd() * 2.4;
		}
		let yawGoal = s.gaze.yaw;
		let pitchGoal = s.gaze.pitch;
		let rollGoal = s.gaze.roll;
		if (speaking) {
			s.spoke += dt;
			if (s.spoke >= s.flipNext) {
				s.sideFrom = s.sideTo;
				s.sideTo = -s.sideTo;
				s.flipStart = s.spoke;
				s.flipNext = s.spoke + TURN.every[0] + s.rnd() * (TURN.every[1] - TURN.every[0]);
			}
			const turn = s.sideFrom + (s.sideTo - s.sideFrom) * ease((s.spoke - s.flipStart) / TURN.flip);
			yawGoal = TURN.amp * turn + .05 * Math.sin(TAU * t / 5.3 + 1.3) + .03 * Math.sin(TAU * t / 2.9);
			pitchGoal = .035 * Math.sin(TAU * t / 5.7) + .05 * stress;
			rollGoal = yawGoal * .12;
		}
		s.nodCooldown -= dt;
		if (state === "listening" && s.micEnv > .05 && s.nodCooldown <= 0) {
			s.pitch[1] += .9;
			s.nodCooldown = .8 + s.rnd() * .6;
		}
		if (speaking && stress > .6 && s.nodCooldown <= 0) {
			s.pitch[1] += .35;
			s.yaw[1] += (s.rnd() - .5) * .2;
			s.nodCooldown = .25;
		}
		const poseOmega = speaking ? 4.5 : 3.2;
		springStep(s.yaw, yawGoal, poseOmega, dt);
		springStep(s.pitch, pitchGoal + exprPitch, poseOmega, dt);
		springStep(s.roll, rollGoal + exprRoll, poseOmega, dt);
		f.yaw = Math.max(-.55, Math.min(.55, s.yaw[0]));
		f.pitch = Math.max(-.3, Math.min(.3, s.pitch[0]));
		f.roll = Math.max(-.2, Math.min(.2, s.roll[0]));
		if (t >= s.saccade.next) {
			const wander = state === "thinking" ? .9 : .25;
			s.saccade.x = (s.rnd() - .5) * 2 * wander + (state === "thinking" ? Math.sign(s.gaze.yaw) * .4 : 0);
			s.saccade.y = (s.rnd() - .5) * 1.2 * wander + (state === "thinking" ? .35 : 0);
			s.saccade.next = t + .4 + s.rnd() * (state === "thinking" ? 1.6 : 2.4);
		}
		springStep(s.gazeX, s.saccade.x, 40, dt);
		springStep(s.gazeY, s.saccade.y, 40, dt);
		f.gazeX = Math.max(-1, Math.min(1, s.gazeX[0]));
		f.gazeY = Math.max(-1, Math.min(1, s.gazeY[0]));
		springStep(s.warm, warmGoal, .9, dt);
		springStep(s.loosen, loosenGoal, 2, dt);
		f.warm = Math.max(-1, Math.min(1, s.warm[0] + .25 * Math.sin(TAU * t / 37)));
		f.hue = .1 * Math.sin(TAU * t / 53) + .08 * Math.sin(TAU * t / 29 + 2);
		f.loosen = clamp01(s.loosen[0]);
		f.breath = 7e-4 * Math.sin(TAU * t / 4.2);
		f.mouthOpen = mouthOpenOf(w);
		const rate = this.formationGoal > f.formation ? 1 / 2.4 : -1 / 1.2;
		f.formation = clamp01(f.formation + rate * dt);
		if (Math.abs(f.formation - this.formationGoal) < 1e-4) f.formation = this.formationGoal;
		return f;
	}
};
//#endregion
//#region src/face/caption-model.ts
function captionTokens(words) {
	return markTags(words).map((t, index) => ({
		w: t.w,
		s: t.s,
		e: t.e,
		tag: t.tag !== void 0,
		index
	}));
}
/** Index of the word being spoken at time t: the last spoken (non-tag) word whose start has passed. Words may overlap neighbours by ~0.1 s, so start time alone decides. -1 before the first word. */
function currentIndex(tokens, t) {
	let cur = -1;
	for (const tok of tokens) {
		if (tok.tag) continue;
		if (tok.s <= t) cur = tok.index;
		else break;
	}
	return cur;
}
/** Greedy wrap by character count; a single word longer than the line gets its own line. */
function wrapLines(tokens, maxChars) {
	const lines = [];
	let line = [];
	let len = 0;
	for (const tok of tokens) {
		const add = tok.w.length + (line.length ? 1 : 0);
		if (line.length && len + add > maxChars) {
			lines.push(line);
			line = [];
			len = 0;
		}
		len += tok.w.length + (line.length ? 1 : 0);
		line.push(tok);
	}
	if (line.length) lines.push(line);
	return lines;
}
/** Token index → the index of the line that holds it. The per-frame path reads this instead of searching the lines. */
function lineIndexOf(lines, tokenCount) {
	const out = new Int32Array(tokenCount).fill(-1);
	lines.forEach((line, li) => {
		for (const tok of line) out[tok.index] = li;
	});
	return out;
}
/** {@link visibleLines} for a frame loop: same answer from the precomputed `lineOf`, written into `out`, nothing allocated. */
function visibleLinesInto(out, lineOf, lineCount, current) {
	if (lineCount === 0) {
		out[0] = -1;
		out[1] = -1;
		return;
	}
	const li = current >= 0 ? Math.max(0, lineOf[current] ?? -1) : 0;
	out[0] = li === 0 ? 0 : li - 1;
	out[1] = li === 0 ? lineCount > 1 ? 1 : -1 : li;
}
var FADE_SECONDS = 1.6;
/** [r, g, b] per paint kind, light and dark. `recent` (a word just spoken) fades to `rose`. */
var PALETTE = {
	light: {
		current: [
			224,
			32,
			60
		],
		recent: [
			196,
			48,
			70
		],
		rose: [
			212,
			150,
			152
		],
		upcoming: [
			190,
			186,
			186
		],
		tag: [
			132,
			130,
			130
		]
	},
	dark: {
		current: [
			255,
			104,
			120
		],
		recent: [
			240,
			128,
			138
		],
		rose: [
			214,
			150,
			156
		],
		upcoming: [
			112,
			108,
			106
		],
		tag: [
			150,
			146,
			144
		]
	}
};
var rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
/** The colours that never change with time, built once: a frame loop paints most words with one of these. */
var SETTLED = {
	light: {
		current: rgb(PALETTE.light.current),
		rose: rgb(PALETTE.light.rose),
		upcoming: rgb(PALETTE.light.upcoming),
		tag: rgb(PALETTE.light.tag)
	},
	dark: {
		current: rgb(PALETTE.dark.current),
		rose: rgb(PALETTE.dark.rose),
		upcoming: rgb(PALETTE.dark.upcoming),
		tag: rgb(PALETTE.dark.tag)
	}
};
/**
* `paintColor(paintFor(tok, t, current), dark)` without the intermediate objects: the answer the caption loop asks
* for every visible word on every frame. Only a word still fading from "just spoken" builds a string; every
* other word is one of the constants above. (Equality with the two-step form is held by a test.)
*/
function colorAt(tok, t, current, dark) {
	const set = dark ? SETTLED.dark : SETTLED.light;
	if (tok.tag) return set.tag;
	if (tok.index === current) return set.current;
	if (tok.index > current) return set.upcoming;
	const k = Math.min(1, Math.max(0, (t - tok.e) / FADE_SECONDS));
	if (k >= 1) return set.rose;
	const { recent, rose } = dark ? PALETTE.dark : PALETTE.light;
	return `rgb(${Math.round(recent[0] + (rose[0] - recent[0]) * k)},${Math.round(recent[1] + (rose[1] - recent[1]) * k)},${Math.round(recent[2] + (rose[2] - recent[2]) * k)})`;
}
//#endregion
//#region src/face/captions.tsx
/**
* Two centred lines under the face, coloured per word by the audio clock. Per frame it touches only the DOM of the
* (at most two) lines on screen, and only the properties whose value moved: no React re-render, no allocation for a
* settled word. Memoised: it re-renders for new words or a theme flip, never because its parent did.
*/
var Captions = memo(function Captions({ words, getTime, dark = false, maxChars = 52, style }) {
	const tokens = useMemo(() => captionTokens(words), [words]);
	const lines = useMemo(() => wrapLines(tokens, maxChars), [tokens, maxChars]);
	const lineOf = useMemo(() => lineIndexOf(lines, tokens.length), [lines, tokens.length]);
	const [shown, setShown] = useState([-1, -1]);
	const spans = useRef(/* @__PURE__ */ new Map());
	const lineEls = useRef(/* @__PURE__ */ new Map());
	const appeared = useRef(/* @__PURE__ */ new Map());
	const live = useRef({
		tokens,
		lines,
		lineOf,
		dark,
		shown,
		getTime
	});
	live.current = {
		tokens,
		lines,
		lineOf,
		dark,
		shown,
		getTime
	};
	const hasWords = tokens.length > 0;
	useEffect(() => {
		if (!hasWords) return;
		let raf = 0;
		const want = [-1, -1];
		/** What each element last had written, so an unchanged frame writes nothing (a style write is never free, even when the value is the same). */
		const lineK = /* @__PURE__ */ new WeakMap();
		const painted = /* @__PURE__ */ new WeakMap();
		const tick = () => {
			raf = requestAnimationFrame(tick);
			const { tokens: tk, lines: ls, lineOf: lo, dark: dk, shown: sh, getTime: gt } = live.current;
			const t = gt();
			const cur = currentIndex(tk, t);
			visibleLinesInto(want, lo, ls.length, cur);
			if (want[0] !== sh[0] || want[1] !== sh[1]) setShown([want[0], want[1]]);
			for (let w = 0; w < 2; w++) {
				const li = want[w];
				if (li < 0) continue;
				const at = appeared.current.get(li);
				if (at === void 0 || t < at) appeared.current.set(li, sh[0] < 0 && sh[1] < 0 ? Number.NEGATIVE_INFINITY : t);
			}
			for (const [li, el] of lineEls.current) {
				const k = Math.min(1, Math.max(0, (t - (appeared.current.get(li) ?? t)) / .38));
				if (lineK.get(el) === k) continue;
				lineK.set(el, k);
				el.style.opacity = String(k * (2 - k));
				el.style.transform = `translateY(${(1 - k) * 8}px)`;
			}
			for (let w = 0; w < 2; w++) {
				const li = want[w];
				const line = li < 0 ? void 0 : ls[li];
				if (!line) continue;
				for (const tok of line) {
					const el = spans.current.get(tok.index);
					if (!el) continue;
					const color = colorAt(tok, t, cur, dk);
					if (painted.get(el) === color) continue;
					painted.set(el, color);
					el.style.color = color;
				}
			}
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [hasWords]);
	useEffect(() => {
		if (hasWords) return;
		appeared.current.clear();
		setShown((prev) => prev[0] < 0 && prev[1] < 0 ? prev : [-1, -1]);
	}, [hasWords]);
	const rows = shown.map((li, pos) => li < 0 || !lines[li] ? /* @__PURE__ */ jsx("div", {
		style: {
			...LINE,
			visibility: "hidden"
		},
		children: "\xA0"
	}, `gap${pos}`) : /* @__PURE__ */ jsx("div", {
		ref: (el) => void (el ? lineEls.current.set(li, el) : lineEls.current.delete(li)),
		style: LINE,
		children: lines[li].map((tok, i) => /* @__PURE__ */ jsxs("span", {
			ref: (el) => void (el ? spans.current.set(tok.index, el) : spans.current.delete(tok.index)),
			children: [i ? " " : "", tok.w]
		}, tok.index))
	}, li));
	return /* @__PURE__ */ jsx("div", {
		style: {
			...BOX,
			...style
		},
		"aria-live": "off",
		children: rows
	});
});
var BOX = {
	textAlign: "center",
	font: "400 clamp(18px, 2.45vh, 34px)/1.62 Inter, 'SF Pro Display', 'Helvetica Neue', system-ui, sans-serif",
	letterSpacing: "-0.005em",
	minHeight: "3.3em",
	pointerEvents: "none",
	userSelect: "none"
};
var LINE = { whiteSpace: "pre-wrap" };
/** 'low' spends fewer, larger dots. */
var LOW_CELL_SCALE = 1.35;
/** G-buffer texels per cell pitch: enough for the bilinear tone to stay smooth between neighbouring dots. */
var TEXELS_PER_CELL = {
	high: 3,
	low: 1.8
};
/** Cells whose centre lies within `half` of the anchor and inside the canvas, along one axis. */
function span(origin, half, size, cell) {
	const reach = Math.ceil(half / cell);
	const first = Math.max(-reach, -Math.floor(origin / cell));
	const last = Math.min(reach, Math.floor((size - origin) / cell));
	return [first, Math.max(0, last - first + 1)];
}
function halftoneGrid(i) {
	const cell = Math.max(4 * i.ratio, i.headPx / 72) * (i.low ? LOW_CELL_SCALE : 1);
	const [c0, cols] = span(i.origin[0], i.halfExtent[0], i.width, cell);
	const [r0, rows] = span(i.origin[1], i.halfExtent[1], i.height, cell);
	const texels = (i.low ? TEXELS_PER_CELL.low : TEXELS_PER_CELL.high) / cell;
	const scale = Math.min(1, texels);
	return {
		cell,
		cols,
		rows,
		x0: i.origin[0] + (c0 - .5) * cell,
		y0: i.origin[1] + (r0 - .5) * cell,
		gw: Math.max(1, Math.ceil(cols * cell * scale)),
		gh: Math.max(1, Math.ceil(rows * cell * scale))
	};
}
//#endregion
//#region src/face/halftone-shaders.ts
/** Width of the morph-delta texture; the splat shader addresses it with `& (TEX_W - 1)` and `>> 11`. */
var TEX_W = 2048;
var HASH = `
uint hash(uint x) {
	x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
	return x;
}
float h01(uint x) { return float(hash(x) & 0xffffffu) / 16777216.0; }`;
var SPLAT_VERT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define ACT ${POSE_SIZE}

in vec3 aPos;
in vec4 aNrm;
in vec4 aCol;

uniform sampler2D uDelta;
uniform vec2 uAct[ACT];
uniform int uActive;
uniform int uN;
uniform vec3 uCenter;
uniform vec3 uHalf;
uniform vec3 uPivot;
uniform vec3 uAnchor;
uniform mat3 uRot;
uniform float uBreath;
uniform vec2 uGRes;
uniform vec2 uOrigin;
uniform vec2 uTexPerM;
uniform float uSplat;
uniform float uTime;
uniform float uForm;
uniform float uMouth;
uniform float uBlink;
uniform vec2 uGaze;
uniform vec3 uDrift;
uniform float uLoosen;
uniform float uDark;
uniform vec3 uLight;
/** Head oval in model space: centre y, half width, half height (metres). */
uniform vec3 uOval;
/** The jaw line in model space: chin y, the chin's depth z, the ears' depth z (metres). */
uniform vec3 uJaw;
/** The eye line and the mouth line in model space, y (metres): the brows arch over one, the lips sit on the other. */
uniform vec2 uFace;

out vec4 vCol;
out vec3 vTone;
${HASH}
vec3 hueRot(vec3 c, float a) {
	const vec3 k = vec3(0.57735027);
	float ca = cos(a), sa = sin(a);
	return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}
void cull() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec4(0.0); vTone = vec3(0.0); }

void main() {
	int id = gl_VertexID;
	vec3 n = uRot * normalize(aNrm.xyz);
	float facing = n.z;
	// the far side of the head never reaches the paper; the depth test would hide it, this saves its fill. The
	// mouth's inside faces every way, so it is exempt (the lips occlude it until they part).
	bool inside = aCol.a > 0.75;
	if (uForm >= 1.0 && facing < -0.35 && !inside) { cull(); return; }

	vec3 p = uCenter + aPos * uHalf;
	// the reference is a head with no neck: outside an oval around the crown-to-chin span, and below the jaw line
	// (level with the chin at the front, rising ~5 cm toward the ears), the surface dissolves
	float oval = smoothstep(1.06, 0.84, length(vec2(p.x / uOval.y, (p.y - uOval.x) / uOval.z)));
	float jawY = uJaw.x + 0.05 * clamp((uJaw.y - p.z) / max(uJaw.y - uJaw.z, 1e-3), 0.0, 1.0);
	oval *= smoothstep(jawY - 0.03, jawY + 0.004, p.y);
	// the brows, placed on the rest pose (so the brow morphs carry them): an arch ~2.4 cm over the eye line. The bake
	// flattens their albedo toward the skin, which paper forgives and a lit surface does not, so dark mode draws
	// them from here.
	float bx = abs(p.x);
	float bt = clamp((bx - 0.034) / 0.024, -1.0, 1.0);
	float arch = 0.024 + 0.005 * (1.0 - bt * bt);
	float brow = smoothstep(0.009, 0.014, bx) * smoothstep(0.058, 0.048, bx) * smoothstep(0.0038, 0.0018, abs(p.y - uFace.x - arch)) * step(0.4, aNrm.z);
	// the lips the same way: a soft ellipse on the mouth line, for the coral that must read even with the mouth shut
	float lip = smoothstep(1.0, 0.7, length(vec2(p.x / 0.027, (p.y - uFace.y) / 0.011))) * step(0.3, aNrm.z);
	for (int k = 0; k < ACT; k++) {
		if (k >= uActive) break;
		int t = int(uAct[k].x) * uN + id;
		p += texelFetch(uDelta, ivec2(t & ${TEX_W - 1}, t >> 11), 0).rgb * uAct[k].y;
	}
	p = uRot * (p - uPivot) + uPivot;
	p.y += uBreath;

	float fade = aNrm.w;
	float vis = fade * fade * oval;
	if (inside) vis *= smoothstep(0.05, 0.38, uMouth); // mouth interior only exists once the lips part
	else if (aCol.a > 0.25) {
		vis *= (1.0 - smoothstep(0.25, 0.7, uBlink)) * 0.9; // eyeballs hide behind closing lids
		p.xy += uGaze * 0.0035;
	}

	// ---- tone. LIGHT (ink on paper), the way the reference reads: a side key light; the lit side is a fine grain
	// of tiny grey dots, the dots swell and turn rose into the shade, shadow creases (nose side, sockets, under the
	// brow) run red, features (brows, eyes, lips) carry the heaviest ink; the silhouette then thins to nothing.
	// DARK (light on near-black): the same light read the other way round. ink is how much light a dot gives:
	// the lit planes swell into warm peach/amber dots, the turn into shade dims to rose and coral, and brows,
	// eyes, nostrils and creases give almost none, so the features read as holes in a luminous surface.
	vec3 L = normalize(uLight);
	float ndl = max(dot(n, L), 0.0);
	float lit = 0.1 + 0.9 * ndl;
	float lum = dot(aCol.rgb, vec3(0.30, 0.59, 0.11));
	float feature = smoothstep(0.62, 0.3, lum);
	float side = 1.0 - smoothstep(0.2, 0.9, facing);
	float shade = 1.0 - lit;
	float crease = smoothstep(0.45, 0.85, shade) * 4.0 * side * (1.0 - side);
	float coral = smoothstep(0.10, 0.28, aCol.r - aCol.g);
	float eye = step(0.25, aCol.a) * (1.0 - step(0.75, aCol.a));
	float rim = smoothstep(0.08, 0.85, facing - uLoosen * 0.12);
	vec3 c = aCol.rgb;
	float ink;
	if (uDark < 0.5) {
		ink = clamp(0.1 + 0.75 * shade + 0.2 * side + 0.65 * feature + 0.25 * coral, 0.0, 1.0);
		float grey = mix(lum, 0.5, 0.35) * 0.92;
		vec3 skin = mix(vec3(grey) * vec3(1.0, 0.96, 0.96), vec3(0.8, 0.61, 0.65), clamp(smoothstep(0.12, 0.6, shade) * 0.85 + side * 0.4, 0.0, 1.0));
		// the lit front drifts toward olive/amber with the slow colour drift, as the reference's does
		skin = mix(skin, mix(vec3(0.5, 0.53, 0.32), vec3(0.74, 0.57, 0.34), uDrift.z), (1.0 - side) * (1.0 - smoothstep(0.1, 0.5, shade)) * 0.42);
		skin = mix(skin, vec3(0.72, 0.26, 0.28), clamp(crease * 0.65, 0.0, 1.0));
		// brows, lashes, pupils: dark ink so the eyes always read
		skin = mix(skin, vec3(0.26, 0.23, 0.24), feature * 0.55);
		vec3 accent = mix(mix(vec3(lum), c, 0.8), vec3(0.88, 0.3, 0.32), 0.55);
		c = mix(skin, accent, coral);
	} else {
		// the same key light, raked further round so the planes model (a frontal light would glow the whole face
		// evenly); a soft fill keeps the shaded cheek glowing faintly instead of dropping to black. The side of the
		// head that turns away from the viewer dims whatever the light does, so the face leads.
		float key = max(dot(n, normalize(vec3(uLight.x * 1.3, uLight.y * 1.2, 0.62))), 0.0);
		// ...and so does the side of the head in its own frame (temples, ears), so a turned head still leads with the face
		float glow = (0.48 + 0.52 * key) * mix(0.45, 1.0, smoothstep(0.1, 0.75, facing)) * mix(0.55, 1.0, smoothstep(0.05, 0.6, normalize(aNrm.xyz).z));
		// the bake flattens brow and lash contrast toward the skin mean; on dark the features need it back, so the
		// mask starts earlier and runs steeper than on paper
		feature = max(smoothstep(0.6, 0.42, lum), brow * 0.8);
		ink = glow * (1.0 - 0.92 * feature) * (1.0 - 0.6 * crease) * mix(1.0, 0.55, eye);
		// colour runs with the light: cream peach where it is lit (drifting olive / amber), rose peach through the
		// turn, rose into the shade; the cheeks (the face's sides) lean rose
		float dim = 1.0 - glow;
		vec3 skin = mix(vec3(1.0, 0.86, 0.72), vec3(1.0, 0.62, 0.6), smoothstep(0.12, 0.38, dim));
		skin = mix(skin, vec3(0.96, 0.42, 0.56), smoothstep(0.32, 0.62, dim));
		skin = mix(skin, mix(vec3(0.82, 0.86, 0.52), vec3(1.0, 0.74, 0.44), uDrift.z), (1.0 - side) * (1.0 - smoothstep(0.1, 0.35, dim)) * 0.32);
		skin = mix(skin, vec3(1.0, 0.5, 0.56), side * (1.0 - side) * 2.0 * (1.0 - feature));
		skin = mix(skin, vec3(0.9, 0.26, 0.34), clamp(crease * 0.8, 0.0, 1.0));
		skin = mix(skin, vec3(0.6, 0.4, 0.42), feature * 0.7);
		// lips: coral light of their own, brighter than the skin they sit in
		float lips = max(coral, lip * 0.85);
		c = mix(skin, vec3(1.0, 0.38, 0.36), lips);
		ink = mix(ink, 0.6 + 0.35 * glow, lips);
	}
	// the open mouth is the deepest tone on the face, a dark wine red: the one shape speech has to read by. Its
	// surfaces face every way, so it never reads as a turning-away rim.
	if (inside) {
		c = mix(c, vec3(0.36, 0.14, 0.16), 0.75);
		ink = uDark < 0.5 ? max(ink, 0.9) : min(ink, 0.08);
		rim = 1.0;
	}
	c = hueRot(c, uDrift.y);
	c *= vec3(1.0 + 0.05 * uDrift.x, 1.0, 1.0 - 0.06 * uDrift.x);

	float grow = 1.0;
	// ---- formation: an orb of loose gradient points that gathers into the head
	if (uForm < 1.0) {
		uint hb = uint(id) * 4u;
		float h1 = h01(hb + 1u), h2 = h01(hb + 2u), h3 = h01(hb + 3u), h4 = h01(hb + 4u);
		float local = clamp((uForm - h1 * 0.3) / 0.7, 0.0, 1.0);
		float e = local * local * (3.0 - 2.0 * local);
		float th = h2 * 6.2832 + uTime * 0.5, ph = acos(2.0 * h3 - 1.0);
		vec3 dir = vec3(sin(ph) * cos(th), cos(ph), sin(ph) * sin(th));
		vec3 orb = uAnchor + dir * (0.155 * pow(h4, 0.4));
		vec3 swirl = cross(dir, vec3(0.3, 1.0, 0.2)) * sin(e * 3.1416) * 0.09;
		p = mix(orb + swirl, p, e);
		float g = smoothstep(-0.7, 0.7, dot(dir, normalize(vec3(0.75, -0.5, 0.4))) + (h1 - 0.5) * 0.5);
		vec3 orbCol = mix(mix(vec3(0.94, 0.47, 0.30), vec3(0.98, 0.72, 0.52), h2), vec3(0.24, 0.50, 0.36), g);
		orbCol = mix(orbCol, pow(orbCol, vec3(0.6)), uDark);
		float ec = smoothstep(0.35, 1.0, e);
		c = mix(orbCol, c, ec);
		ink = mix(0.55 + 0.3 * h2, ink, ec);
		rim = mix(smoothstep(-0.4, 0.6, dir.z), rim, ec);
		vis = mix(1.0, vis, ec);
		grow = mix(2.2, 1.0, ec);
	}
	if (vis < 0.02) { cull(); return; }

	vec3 q = p - uAnchor;
	float pers = 1.0 / (1.0 - q.z * 0.8);
	vec2 t = uOrigin + vec2(q.x, -q.y) * uTexPerM * pers;
	gl_Position = vec4(t.x / uGRes.x * 2.0 - 1.0, 1.0 - t.y / uGRes.y * 2.0, clamp(-q.z * 2.5, -1.0, 1.0), 1.0);
	// lips splat tighter: a splat is wider than the gap it borders, and the full size would paper over a small
	// opening of the mouth (0.68 of the row spacing still closes the lattice)
	gl_PointSize = max(1.0, 2.0 * uSplat * pers * grow * mix(1.0, 0.62, coral));
	vCol = vec4(clamp(c, 0.0, 1.0), vis);
	// depth toward the viewer, 1 cm = 0.025: pass B reads it back for the creases (cavities) the key light misses
	vTone = vec3(ink, rim, clamp(0.5 + q.z * 2.5, 0.0, 1.0));
}`;
var SPLAT_FRAG = `#version 300 es
precision mediump float;
in vec4 vCol;
in vec3 vTone;
layout(location = 0) out vec4 g0;
layout(location = 1) out vec4 g1;
void main() {
	vec2 d = gl_PointCoord * 2.0 - 1.0;
	if (dot(d, d) > 1.2) discard;
	g0 = vec4(vCol.rgb * vCol.a, vCol.a);
	g1 = vec4(vTone * vCol.a, vCol.a);
}`;
var DOT_VERT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uG0;
uniform sampler2D uG1;
uniform int uCols;
uniform vec2 uGridTL;
uniform vec2 uGridSize;
uniform float uCell;
uniform vec2 uRes;
uniform float uAA;
uniform float uTime;
uniform float uLoosen;
uniform float uDark;
uniform float uForm;

out vec4 vCol;
flat out vec3 vDot;
${HASH}
void cull() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec4(0.0); vDot = vec3(1.0); }
vec2 uvOf(vec2 px) { return vec2((px.x - uGridTL.x) / uGridSize.x, 1.0 - (px.y - uGridTL.y) / uGridSize.y); }

void main() {
	int row = gl_VertexID / uCols;
	int col = gl_VertexID - row * uCols;
	uint hb = hash(uint(col) * 0x9E3779B1u ^ hash(uint(row) + 0x632BE5ABu)) * 8u;
	float h1 = h01(hb + 1u), h2 = h01(hb + 2u), h3 = h01(hb + 3u), h4 = h01(hb + 4u), h5 = h01(hb + 5u);

	vec2 c = uGridTL + (vec2(col, row) + 0.5) * uCell + (vec2(h1, h2) - 0.5) * uCell * 0.2;
	vec4 a = texture(uG0, uvOf(c));
	if (a.a < 0.03) { cull(); return; }
	vec4 b = texture(uG1, uvOf(c));
	float s = a.a;
	// neighbouring dots are not one flat tint: each leans a little rose or a little grey (on dark, a little rose or
	// a little peach, so the light keeps its colour), as the reference's do
	vec3 colour = a.rgb / s;
	vec3 lean = mix(vec3(dot(colour, vec3(0.3, 0.59, 0.11))), colour * vec3(1.04, 0.94, 0.86), uDark);
	colour = mix(colour, mix(lean, mix(vec3(0.86, 0.6, 0.63), vec3(1.0, 0.56, 0.58), uDark), h01(hb + 6u)), mix(0.32, 0.22, uDark));
	float ink = clamp(b.r / s, 0.0, 1.0);
	// ---- creases: a cell sitting a little deeper than its neighbours (sockets, the nose's flank, the lip line,
	// the nasolabial fold) takes more ink and runs red; a ridge (bridge, brow) lightens. A jump of more than ~1.6 cm
	// is one surface occluding another (jaw over neck, cheek over ear), not a crease: that neighbour is ignored.
	// The loose orb has no surface to crease, so the term waits for the face to form.
	float cav = 0.0;
	if (uForm > 0.6) {
		float d0 = b.b / s;
		float kc = uCell * 2.0;
		float dsum = 0.0, wsum = 0.0;
		for (int i = 0; i < 4; i++) {
			vec2 o = i == 0 ? vec2(kc, 0.0) : i == 1 ? vec2(-kc, 0.0) : i == 2 ? vec2(0.0, kc) : vec2(0.0, -kc);
			vec4 nb = texture(uG1, uvOf(c + o));
			float dd = nb.b / max(nb.a, 1e-3) - d0;
			float w = step(0.3, nb.a) * step(abs(dd), 0.04);
			dsum += w * dd;
			wsum += w;
		}
		cav = wsum > 0.0 ? clamp(dsum / wsum / 0.012, -1.0, 1.0) * smoothstep(0.6, 1.0, uForm) : 0.0;
	}
	// on paper a crease is more (red) ink; on dark it is less light: the dot shrinks and dims to a deep red
	float crease = max(cav, 0.0);
	ink = uDark < 0.5
		? clamp(ink + 0.45 * crease - 0.15 * max(-cav, 0.0), 0.0, 1.0)
		: clamp(ink * (1.0 - 0.75 * crease) + 0.1 * max(-cav, 0.0), 0.0, 1.0);
	colour = mix(colour, mix(vec3(0.7, 0.25, 0.27), vec3(0.78, 0.22, 0.27), uDark), crease * 0.5);
	// edge: 1 on the solid front of the face, falling to 0 where the surface turns away or the coverage ends
	float cover = smoothstep(0.03, 0.75, s);
	float edge = clamp(b.g / s + (h3 - 0.5) * 0.3, 0.0, 1.0) * cover;

	// ---- dissolve: toward the silhouette dots thin out and drift outward (further when thinking)
	float keep = mix(0.18, 1.0, smoothstep(0.0, 0.75, edge)) - 0.15 * uLoosen * (1.0 - edge);
	if (h4 > keep) { cull(); return; }
	vec2 off = vec2(0.0);
	float scat = pow(1.0 - edge, 1.5);
	if (edge < 0.97) {
		float k = uCell * 1.5;
		vec2 grad = vec2(texture(uG0, uvOf(c + vec2(k, 0.0))).a - texture(uG0, uvOf(c - vec2(k, 0.0))).a,
			texture(uG0, uvOf(c + vec2(0.0, k))).a - texture(uG0, uvOf(c - vec2(0.0, k))).a);
		vec2 dirOut = dot(grad, grad) > 1e-4 ? -normalize(grad) : normalize(vec2(h1, h2) - 0.5 + 1e-3);
		off = dirOut * scat * uCell * (0.3 + 1.8 * h3 * h3 + 2.5 * uLoosen * h3) + (vec2(h4, h1) - 0.5) * scat * uCell * 0.8;
		float stray = step(0.985, h5);
		off += dirOut * stray * uCell * (2.5 + 7.0 * h1) * (0.65 + 0.35 * sin(uTime * 0.35 + h2 * 20.0));
	}

	float r = uCell * mix(mix(0.14, 0.04, uDark), mix(0.46, 0.44, uDark), pow(ink, mix(0.9, 1.35, uDark))) * mix(0.55, 1.0, edge) * (0.8 + 0.4 * h2);
	float alpha = mix(mix(0.8, 0.95, pow(ink, 0.7)), mix(0.4, 1.0, pow(ink, 0.8)), uDark) * mix(0.18, 1.0, edge) * mix(0.6, 1.0, cover);
	float feather = uAA * mix(1.0, 3.0, 1.0 - edge);

	vec2 px = c + off;
	float half_ = r + feather + 1.0;
	gl_Position = vec4(px.x / uRes.x * 2.0 - 1.0, 1.0 - px.y / uRes.y * 2.0, 0.0, 1.0);
	gl_PointSize = 2.0 * half_;
	vCol = vec4(colour, alpha);
	vDot = vec3(r, feather, half_);
}`;
var DOT_FRAG = `#version 300 es
precision mediump float;
in vec4 vCol;
flat in vec3 vDot;
out vec4 outColor;
void main() {
	vec2 p = (gl_PointCoord * 2.0 - 1.0) * vDot.z;
	float cover = clamp((vDot.x - length(p)) / vDot.y + 0.5, 0.0, 1.0);
	float a = vCol.a * cover * cover * (3.0 - 2.0 * cover);
	outColor = vec4(vCol.rgb * a, a);
}`;
//#endregion
//#region src/face/renderer.ts
var BLINK_L = arkitIndex("eyeBlinkLeft");
var BLINK_R = arkitIndex("eyeBlinkRight");
/** Splat disc radius as a fraction of the baked row spacing: >= 0.64 closes the gap to the diagonal neighbour; the
* margin covers the rows' jitter and the skin stretching under the morphs. */
var SPLAT = 1.1;
/** The head oval the surface dissolves outside of (no neck, as in the reference): its half height as a multiple of
* half the crown-to-chin span, and its width over its height. */
var OVAL_REACH = 1.05;
var OVAL_ASPECT = .74;
/** Half size around the anchor, metres, of everything that can draw: the head, its scattered rim, the forming orb. */
var DRAW_EXTENT = [.2, .22];
/** The most canvas pixels per CSS pixel the renderer will use, by quality. */
var MAX_RATIO_HIGH = 1.5;
var MAX_RATIO_LOW = 1.25;
function compile(gl, type, src) {
	const sh = gl.createShader(type);
	if (!sh) throw new Error("createShader failed");
	gl.shaderSource(sh, src);
	gl.compileShader(sh);
	if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`face shader: ${gl.getShaderInfoLog(sh)}`);
	return sh;
}
function program(gl, vert, frag, attribs = []) {
	const prog = gl.createProgram();
	if (!prog) throw new Error("createProgram failed");
	const vs = compile(gl, gl.VERTEX_SHADER, vert);
	const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
	gl.attachShader(prog, vs);
	gl.attachShader(prog, fs);
	attribs.forEach((a, i) => gl.bindAttribLocation(prog, i, a));
	gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`face program: ${gl.getProgramInfoLog(prog)}`);
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	return prog;
}
function uniforms(gl, prog, names) {
	return Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(prog, n)]));
}
var SPLAT_UNIFORMS = [
	"uN",
	"uActive",
	"uCenter",
	"uHalf",
	"uPivot",
	"uAnchor",
	"uRot",
	"uBreath",
	"uGRes",
	"uOrigin",
	"uTexPerM",
	"uSplat",
	"uTime",
	"uForm",
	"uMouth",
	"uBlink",
	"uGaze",
	"uDrift",
	"uLoosen",
	"uDark",
	"uLight",
	"uOval",
	"uJaw",
	"uFace"
];
var DOT_UNIFORMS = [
	"uCols",
	"uGridTL",
	"uGridSize",
	"uCell",
	"uRes",
	"uAA",
	"uTime",
	"uLoosen",
	"uDark",
	"uForm"
];
function build(gl, head) {
	const splatProg = program(gl, SPLAT_VERT, SPLAT_FRAG, [
		"aPos",
		"aNrm",
		"aCol"
	]);
	const vao = gl.createVertexArray();
	const buffer = gl.createBuffer();
	if (!vao || !buffer) throw new Error("vertex allocation failed");
	gl.bindVertexArray(vao);
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, head.instances, gl.STATIC_DRAW);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 3, gl.SHORT, true, 16, 0);
	gl.enableVertexAttribArray(1);
	gl.vertexAttribPointer(1, 4, gl.BYTE, true, 16, 8);
	gl.enableVertexAttribArray(2);
	gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 16, 12);
	const dotVao = gl.createVertexArray();
	if (!dotVao) throw new Error("vertex allocation failed");
	gl.bindVertexArray(null);
	const delta = gl.createTexture();
	if (!delta) throw new Error("createTexture failed");
	gl.bindTexture(gl.TEXTURE_2D, delta);
	const rows = Math.ceil(head.header.shapes.length * head.header.n / TEX_W);
	const data = new Int8Array(TEX_W * rows * 4);
	data.set(head.deltas);
	gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8_SNORM, TEX_W, rows, 0, gl.RGBA, gl.BYTE, data);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	const su = uniforms(gl, splatProg, SPLAT_UNIFORMS);
	su.uAct = gl.getUniformLocation(splatProg, "uAct[0]");
	gl.useProgram(splatProg);
	gl.uniform1i(gl.getUniformLocation(splatProg, "uDelta"), 0);
	gl.uniform1i(su.uN, head.header.n);
	gl.uniform3fv(su.uCenter, head.header.center);
	gl.uniform3fv(su.uHalf, head.header.half);
	gl.uniform3fv(su.uPivot, head.header.landmarks.pivot);
	const lm = head.header.landmarks;
	const halfSpan = (lm.crownY - lm.chinY) / 2 * OVAL_REACH;
	gl.uniform3f(su.uOval, (lm.crownY + lm.chinY) / 2, halfSpan * OVAL_ASPECT, halfSpan);
	gl.uniform3f(su.uJaw, lm.chinY, lm.noseZ - .03, lm.pivot[2]);
	gl.uniform2f(su.uFace, lm.eyeY, lm.mouthY);
	const dotProg = program(gl, DOT_VERT, DOT_FRAG);
	gl.useProgram(dotProg);
	gl.uniform1i(gl.getUniformLocation(dotProg, "uG0"), 1);
	gl.uniform1i(gl.getUniformLocation(dotProg, "uG1"), 2);
	return {
		splat: {
			prog: splatProg,
			vao,
			buffer,
			u: su
		},
		dots: {
			prog: dotProg,
			vao: dotVao,
			u: uniforms(gl, dotProg, DOT_UNIFORMS)
		},
		delta,
		gbuf: null
	};
}
function gTexture(gl, w, h) {
	const tex = gl.createTexture();
	if (!tex) throw new Error("G-buffer allocation failed");
	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return tex;
}
function makeGBuffer(gl, w, h) {
	const fbo = gl.createFramebuffer();
	const depth = gl.createRenderbuffer();
	if (!fbo || !depth) throw new Error("G-buffer allocation failed");
	const g0 = gTexture(gl, w, h);
	const g1 = gTexture(gl, w, h);
	gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
	gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, g0, 0);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, g1, 0);
	gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
	gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
	if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("G-buffer incomplete");
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	return {
		fbo,
		g0,
		g1,
		depth,
		w,
		h
	};
}
function freeGBuffer(gl, gpu) {
	const b = gpu.gbuf;
	if (!b) return;
	gl.deleteFramebuffer(b.fbo);
	gl.deleteTexture(b.g0);
	gl.deleteTexture(b.g1);
	gl.deleteRenderbuffer(b.depth);
	gpu.gbuf = null;
}
function createFaceRenderer(canvas, head, opts) {
	const glOrNull = canvas.getContext("webgl2", {
		alpha: true,
		premultipliedAlpha: true,
		antialias: false,
		depth: false,
		stencil: false,
		powerPreference: "high-performance"
	});
	if (!glOrNull) throw new Error("WebGL2 is not available");
	const gl = glOrNull;
	const { header } = head;
	const lm = header.landmarks;
	const headFraction = opts.headFraction ?? .56;
	const anchorFrac = opts.anchor ?? [.5, .43];
	const gain = opts.morphGain ?? 1;
	const anchor = Float32Array.of(0, (lm.crownY + lm.chinY) / 2 - .015, lm.pivot[2]);
	const rot = /* @__PURE__ */ new Float32Array(9);
	const act = new Float32Array(POSE_SIZE * 2);
	let gpu = build(gl, head);
	let dark = opts.dark;
	let quality = opts.quality ?? "high";
	let cssW = 1, cssH = 1, dpr = 1;
	let grid = null;
	let lost = false;
	const onLost = (e) => {
		e.preventDefault();
		lost = true;
		gpu = null;
	};
	const onRestored = () => {
		gpu = build(gl, head);
		lost = false;
	};
	canvas.addEventListener("webglcontextlost", onLost);
	canvas.addEventListener("webglcontextrestored", onRestored);
	function setRot(yaw, pitch, roll) {
		const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(pitch), sx = Math.sin(pitch), cz = Math.cos(roll), sz = Math.sin(roll);
		const m00 = cy, m01 = sy * sx, m02 = sy * cx;
		const m10 = 0, m11 = cx, m12 = -sx;
		const m20 = -sy, m21 = cy * sx, m22 = cy * cx;
		rot[0] = m00 * cz + m01 * sz;
		rot[3] = -m00 * sz + m01 * cz;
		rot[6] = m02;
		rot[1] = m10 * cz + m11 * sz;
		rot[4] = -0 * sz + m11 * cz;
		rot[7] = m12;
		rot[2] = m20 * cz + m21 * sz;
		rot[5] = -m20 * sz + m21 * cz;
		rot[8] = m22;
	}
	const pxPerM = () => canvas.height * headFraction / (lm.crownY - lm.chinY);
	function applySize() {
		const ratio = Math.min(quality === "high" ? MAX_RATIO_HIGH : MAX_RATIO_LOW, Math.max(1, dpr));
		const w = Math.max(1, Math.round(cssW * ratio));
		const h = Math.max(1, Math.round(cssH * ratio));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		const ppm = pxPerM();
		grid = halftoneGrid({
			width: w,
			height: h,
			ratio: h / Math.max(1, cssH),
			headPx: h * headFraction,
			origin: [w * anchorFrac[0], h * anchorFrac[1]],
			halfExtent: [DRAW_EXTENT[0] * ppm * 1.12, DRAW_EXTENT[1] * ppm * 1.12],
			low: quality === "low"
		});
		if (gpu?.gbuf && (gpu.gbuf.w !== grid.gw || gpu.gbuf.h !== grid.gh)) freeGBuffer(gl, gpu);
	}
	return {
		resize(w, h, ratio) {
			cssW = w;
			cssH = h;
			dpr = ratio;
			applySize();
		},
		setDark(v) {
			dark = v;
		},
		setQuality(q) {
			if (q === quality) return;
			quality = q;
			applySize();
		},
		draw(f, t) {
			if (lost || !gpu) return;
			if (!grid) applySize();
			const g = gpu;
			const L = grid;
			const W = canvas.width, H = canvas.height;
			if (!g.gbuf) g.gbuf = makeGBuffer(gl, L.gw, L.gh);
			const gb = g.gbuf;
			let active = 0;
			for (let s = 0; s < head.pose.length; s++) {
				const pi = head.pose[s];
				const w = Math.min(f.weights[pi], RIG_MAX[pi]) * RIG_GAIN[pi];
				if (!(w > .003)) continue;
				act[active * 2] = s;
				act[active * 2 + 1] = w * header.scales[s] * gain;
				active++;
			}
			setRot(f.yaw, f.pitch, f.roll);
			const ppm = pxPerM();
			const gridW = L.cols * L.cell, gridH = L.rows * L.cell;
			const sx = gb.w / gridW, sy = gb.h / gridH;
			const lx = -.45 + .1 * Math.sin(t * .13), ly = .35 + .08 * Math.sin(t * .09 + 1);
			const time = t % 3600;
			const sp = g.splat, su = sp.u;
			gl.bindFramebuffer(gl.FRAMEBUFFER, gb.fbo);
			gl.viewport(0, 0, gb.w, gb.h);
			gl.clearColor(0, 0, 0, 0);
			gl.clearDepth(1);
			gl.enable(gl.DEPTH_TEST);
			gl.depthFunc(gl.LESS);
			gl.depthMask(true);
			gl.disable(gl.BLEND);
			gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
			gl.useProgram(sp.prog);
			gl.bindVertexArray(sp.vao);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, g.delta);
			gl.uniform2fv(su.uAct, act);
			gl.uniform1i(su.uActive, active);
			gl.uniform3fv(su.uAnchor, anchor);
			gl.uniformMatrix3fv(su.uRot, false, rot);
			gl.uniform1f(su.uBreath, f.breath);
			gl.uniform2f(su.uGRes, gb.w, gb.h);
			gl.uniform2f(su.uOrigin, (W * anchorFrac[0] - L.x0) * sx, (H * anchorFrac[1] - L.y0) * sy);
			gl.uniform2f(su.uTexPerM, ppm * sx, ppm * sy);
			gl.uniform1f(su.uSplat, Math.max(.75, SPLAT * header.rowSpacing * ppm * Math.min(sx, sy)));
			gl.uniform1f(su.uTime, time);
			gl.uniform1f(su.uForm, f.formation);
			gl.uniform1f(su.uMouth, f.mouthOpen);
			gl.uniform1f(su.uBlink, Math.max(f.weights[BLINK_L], f.weights[BLINK_R]));
			gl.uniform2f(su.uGaze, f.gazeX, f.gazeY);
			gl.uniform3f(su.uDrift, f.warm, f.hue, .5 + .5 * Math.sin(t * .07));
			gl.uniform1f(su.uLoosen, f.loosen);
			gl.uniform3f(su.uLight, lx, ly, .85);
			gl.uniform1f(su.uDark, dark ? 1 : 0);
			gl.drawArrays(gl.POINTS, 0, header.n);
			const dp = g.dots, du = dp.u;
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, W, H);
			gl.disable(gl.DEPTH_TEST);
			gl.clear(gl.COLOR_BUFFER_BIT);
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
			gl.useProgram(dp.prog);
			gl.bindVertexArray(dp.vao);
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, gb.g0);
			gl.activeTexture(gl.TEXTURE2);
			gl.bindTexture(gl.TEXTURE_2D, gb.g1);
			gl.activeTexture(gl.TEXTURE0);
			gl.uniform1i(du.uCols, L.cols);
			gl.uniform2f(du.uGridTL, L.x0, L.y0);
			gl.uniform2f(du.uGridSize, gridW, gridH);
			gl.uniform1f(du.uCell, L.cell);
			gl.uniform2f(du.uRes, W, H);
			gl.uniform1f(du.uAA, Math.max(.9, H / cssH * .8));
			gl.uniform1f(du.uTime, time);
			gl.uniform1f(du.uLoosen, f.loosen);
			gl.uniform1f(du.uDark, dark ? 1 : 0);
			gl.uniform1f(du.uForm, f.formation);
			gl.drawArrays(gl.POINTS, 0, L.cols * L.rows);
			gl.bindVertexArray(null);
		},
		dispose() {
			canvas.removeEventListener("webglcontextlost", onLost);
			canvas.removeEventListener("webglcontextrestored", onRestored);
			if (gpu) {
				freeGBuffer(gl, gpu);
				gl.deleteProgram(gpu.splat.prog);
				gl.deleteProgram(gpu.dots.prog);
				gl.deleteVertexArray(gpu.splat.vao);
				gl.deleteVertexArray(gpu.dots.vao);
				gl.deleteBuffer(gpu.splat.buffer);
				gl.deleteTexture(gpu.delta);
			}
			gpu = null;
		}
	};
}
//#endregion
//#region src/face/face-view.tsx
var CREAM = "#F4F2EE";
/**
* The shortest gap between drawn frames. A 120/144/240 Hz display calls the loop that often; the face is a 60 fps
* animation (dt-driven, so it looks the same), and drawing it every refresh would just spend the GPU and the main
* thread. 15 ms, not 16.7, so a 60 Hz display's jittery frames (16.6 +/- 1 ms) are never skipped; a 120 Hz display
* draws every second refresh, a 144 Hz one every third.
*/
var MIN_FRAME_MS = 15;
/** Warm near-black: the app's dark background (#0b0b0d) with a breath of warmth, so the surface sits in the host. */
var INK_BG = "#0E0D0C";
/** Perceived host background darkness: walks up to the first painted background and uses its luminance; `fallback` when nothing on the way up is painted. */
function detectDark(el, fallback = false) {
	for (let n = el; n; n = n.parentElement) {
		const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(getComputedStyle(n).backgroundColor);
		if (!m || m[4] !== void 0 && Number(m[4]) < .5) continue;
		return (.2126 * Number(m[1]) + .7152 * Number(m[2]) + .0722 * Number(m[3])) / 255 < .45;
	}
	return fallback;
}
var FaceView = memo(function FaceView({ head, animator, getInput, words, getCaptionTime, dark, autoRun = true, showCaptions = true, poseSource, quality = "high", onFrameCost, handle, style }) {
	const host = useRef(null);
	const canvas = useRef(null);
	const renderer = useRef(null);
	const clock = useRef(0);
	const live = useRef({
		animator,
		getInput,
		onFrameCost
	});
	live.current = {
		animator,
		getInput,
		onFrameCost
	};
	useEffect(() => {
		const cv = canvas.current;
		const box = host.current;
		if (!cv || !box) return;
		const r = createFaceRenderer(cv, head, {
			dark,
			quality
		});
		renderer.current = r;
		const fit = () => r.resize(box.clientWidth, box.clientHeight, window.devicePixelRatio || 1);
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(box);
		return () => {
			ro.disconnect();
			r.dispose();
			renderer.current = null;
		};
	}, [head]);
	useEffect(() => {
		renderer.current?.setDark(dark);
	}, [dark]);
	useEffect(() => {
		renderer.current?.setQuality(quality);
	}, [quality]);
	useEffect(() => {
		animator.setPoseSource(poseSource ?? "procedural");
	}, [animator, poseSource]);
	const advance = useMemo(() => (dt) => {
		const { animator: a, getInput: gi } = live.current;
		clock.current += dt;
		renderer.current?.draw(a.step(dt, gi()), clock.current);
	}, []);
	useImperativeHandle(handle, () => ({
		advance,
		get canvas() {
			return canvas.current;
		}
	}), [advance]);
	useEffect(() => {
		if (!autoRun) return;
		let raf = 0;
		/** When the last frame was DRAWN (or, while the face is out of sight, the last frame offered: so dt stays small on return). */
		let last = performance.now();
		let visible = true;
		const io = new IntersectionObserver((e) => {
			visible = e[e.length - 1].isIntersecting;
		});
		if (host.current) io.observe(host.current);
		const tick = (now) => {
			raf = requestAnimationFrame(tick);
			if (!visible || document.hidden) {
				last = now;
				return;
			}
			if (now - last < MIN_FRAME_MS) return;
			const dt = (now - last) / 1e3;
			last = now;
			const t0 = performance.now();
			advance(dt);
			live.current.onFrameCost?.(performance.now() - t0);
		};
		raf = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(raf);
			io.disconnect();
		};
	}, [autoRun, advance]);
	return /* @__PURE__ */ jsxs("div", {
		ref: host,
		style: {
			position: "relative",
			width: "100%",
			height: "100%",
			background: dark ? INK_BG : CREAM,
			overflow: "hidden",
			...style
		},
		children: [/* @__PURE__ */ jsx("canvas", {
			ref: canvas,
			style: {
				position: "absolute",
				inset: 0,
				width: "100%",
				height: "100%",
				display: "block"
			}
		}), showCaptions && /* @__PURE__ */ jsx(Captions, {
			words,
			getTime: getCaptionTime,
			dark,
			style: {
				position: "absolute",
				left: "50%",
				transform: "translateX(-50%)",
				bottom: "8.5%",
				width: "min(92%, 60em)"
			}
		})]
	});
});
//#endregion
//#region src/surface/face-boundary.tsx
/** The renderer creates its GL context in an effect, so a machine without WebGL2 throws there: catch it and say so. */
var FaceBoundary = class extends Component {
	state = { message: null };
	static getDerivedStateFromError(error) {
		return { message: error instanceof Error ? error.message : String(error) };
	}
	componentDidCatch(error, info) {
		console.warn("[face-to-face] the face could not be drawn", error, info.componentStack);
	}
	render() {
		return this.state.message === null ? this.props.children : this.props.fallback(this.state.message);
	}
};
//#endregion
//#region src/surface/mic-model.ts
/** Chrome lists every system default twice more, under virtual ids, with these label prefixes. */
var ALIAS_PREFIX = /^(default|communications)\s*-\s*/i;
/** A driver's channel name appended to the device's ("INZONE H9 II - Chat"): not part of what the device is called. */
var CHANNEL_SUFFIX = /\s+-\s+(chat|game|media|aux)$/i;
/**
* What to call a device in a sentence: "Default - Headset Microphone (INZONE H9 II - Chat)" is "INZONE H9 II".
* The label's generic front ("Headset Microphone") and the OS's alias and numbering noise go; a label with
* none of that is returned as it is. Undefined when there is no label to go on.
*/
function micName(label) {
	let name = label?.trim().replace(ALIAS_PREFIX, "");
	if (!name) return void 0;
	const inner = /^.+?\s\((.+)\)$/.exec(name)?.[1];
	if (inner) name = inner;
	name = name.replace(/^\d+-\s*/, "").replace(CHANNEL_SUFFIX, "").trim();
	return name || void 0;
}
/** The warning for a microphone that has delivered nothing but silence. */
function micSilentNotice(label) {
	return `No sound from ${micName(label) ?? "your microphone"}. Pick another microphone.`;
}
/**
* The entries of the input menu, the live one checked. The browser's own "communications" alias is left
* out (it repeats the default); the default entry says what it currently resolves to. The live entry is found
* by the id the capture reports, then by its label; with no capture and no choice it is the system default.
*/
function describeMicMenu(v) {
	const devices = v.micDevices.filter((device) => device.id !== "communications");
	const byId = v.micDeviceId === void 0 ? void 0 : devices.find((device) => device.id === v.micDeviceId);
	const byLabel = v.micLabel === void 0 ? void 0 : devices.find((device) => device.label === v.micLabel);
	const fallback = v.micDeviceId === void 0 ? devices.find((device) => device.id === "default") : void 0;
	const live = byId ?? byLabel ?? fallback;
	return devices.map((device) => {
		const rest = device.label.replace(ALIAS_PREFIX, "");
		const label = device.id === "default" ? rest ? `System default \u00b7 ${rest}` : "System default" : device.label;
		return {
			id: device.id,
			label,
			checked: device === live
		};
	});
}
//#endregion
//#region src/surface/mic-picker.tsx
var MIC_PICKER_STYLES = `
.f2f-mp { position: relative; display: inline-flex; }
.f2f-mp-btn { max-width: 16em; }
.f2f-mp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.f2f-mp-btn[data-warn="true"] { color: var(--f2f-warn, #e8a33d); border-color: currentColor; }
.f2f-mp-btn .f2f-mp-chev { width: 12px; height: 12px; opacity: .7; transition: transform .16s ease; }
.f2f-mp-btn[aria-expanded="true"] .f2f-mp-chev { transform: rotate(180deg); }
.f2f-mp-menu {
	position: absolute; right: 0; top: calc(100% + 8px); z-index: 6;
	min-width: 17em; max-width: min(30em, 86vw); padding: 6px; border-radius: 14px;
	display: flex; flex-direction: column; gap: 2px;
	border: 1px solid var(--f2f-line); background: var(--f2f-panel, #1d1c1a);
	box-shadow: 0 14px 34px -12px rgba(0,0,0,.55);
}
.f2f-mp-item {
	display: flex; align-items: center; gap: 10px; width: 100%; cursor: pointer;
	padding: 9px 10px; border: 0; border-radius: 9px; background: transparent;
	color: var(--f2f-ink-2); text-align: left; font-size: 13px; line-height: 1.35;
}
.f2f-mp-item:hover, .f2f-mp-item:focus-visible { background: var(--f2f-hover); color: var(--f2f-ink); }
.f2f-mp-item[aria-checked="true"] { color: var(--f2f-ink); }
.f2f-mp-check { width: 14px; height: 14px; flex: none; color: var(--f2f-coral); }
.f2f-mp-label { min-width: 0; overflow-wrap: anywhere; }
`;
var ICON$1 = {
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 2,
	strokeLinecap: "round",
	strokeLinejoin: "round",
	viewBox: "0 0 24 24"
};
/** The five fields of the voice the picker reads: the voice object itself changes with every word, these do not. */
function sameMicVoice({ voice: a }, { voice: b }) {
	return a.micDevices === b.micDevices && a.micDeviceId === b.micDeviceId && a.micLabel === b.micLabel && a.micSilent === b.micSilent && a.setMicDevice === b.setMicDevice;
}
/** The input menu: which microphone the conversation listens through, changeable without ending it. Re-renders only when one of those five fields moves. */
var MicPicker = memo(function MicPicker({ voice }) {
	const { micDevices, micDeviceId, micLabel, micSilent, setMicDevice } = voice;
	const [open, setOpen] = useState(false);
	const root = useRef(null);
	const button = useRef(null);
	const items = useMemo(() => describeMicMenu({
		micDevices,
		micDeviceId,
		micLabel
	}), [
		micDevices,
		micDeviceId,
		micLabel
	]);
	useEffect(() => {
		if (!open) return;
		const away = (e) => {
			if (!root.current?.contains(e.target)) setOpen(false);
		};
		document.addEventListener("pointerdown", away);
		return () => document.removeEventListener("pointerdown", away);
	}, [open]);
	useEffect(() => {
		if (!open) return;
		const entries = root.current?.querySelectorAll("[role=\"menuitemradio\"]");
		(root.current?.querySelector("[aria-checked=\"true\"]") ?? entries?.[0])?.focus();
	}, [open]);
	if (items.length === 0) return null;
	const close = () => {
		setOpen(false);
		button.current?.focus();
	};
	const choose = (id) => {
		setMicDevice(id);
		close();
	};
	const onMenuKey = (e) => {
		const entries = [...e.currentTarget.querySelectorAll("[role=\"menuitemradio\"]")];
		const at = entries.indexOf(document.activeElement);
		const move = (to) => {
			e.preventDefault();
			entries[(to + entries.length) % entries.length]?.focus();
		};
		if (e.key === "ArrowDown") move(at + 1);
		else if (e.key === "ArrowUp") move(at - 1);
		else if (e.key === "Home") move(0);
		else if (e.key === "End") move(entries.length - 1);
		else if (e.key === "Escape") {
			e.preventDefault();
			close();
		} else if (e.key === "Tab") setOpen(false);
	};
	return /* @__PURE__ */ jsxs("div", {
		className: "f2f-mp",
		ref: root,
		children: [
			/* @__PURE__ */ jsx("style", { children: MIC_PICKER_STYLES }),
			/* @__PURE__ */ jsxs("button", {
				type: "button",
				ref: button,
				className: "f2f-btn f2f-mp-btn",
				"aria-haspopup": "menu",
				"aria-expanded": open,
				"data-warn": micSilent,
				onClick: () => setOpen(!open),
				children: [/* @__PURE__ */ jsx("span", {
					className: "f2f-mp-name",
					children: micName(micLabel) ?? "Microphone"
				}), /* @__PURE__ */ jsx("svg", {
					...ICON$1,
					className: "f2f-mp-chev",
					"aria-hidden": "true",
					children: /* @__PURE__ */ jsx("path", { d: "M6 9l6 6 6-6" })
				})]
			}),
			open && /* @__PURE__ */ jsx("div", {
				className: "f2f-mp-menu f2f-fade",
				role: "menu",
				"aria-label": "Microphone",
				onKeyDown: onMenuKey,
				children: items.map((item) => /* @__PURE__ */ jsxs("button", {
					type: "button",
					role: "menuitemradio",
					"aria-checked": item.checked,
					className: "f2f-mp-item",
					onClick: () => choose(item.id),
					children: [/* @__PURE__ */ jsx("span", {
						className: "f2f-mp-check",
						"aria-hidden": "true",
						children: item.checked && /* @__PURE__ */ jsx("svg", {
							...ICON$1,
							width: "14",
							height: "14",
							children: /* @__PURE__ */ jsx("path", { d: "M5 12.5l4.5 4.5L19 7.5" })
						})
					}), /* @__PURE__ */ jsx("span", {
						className: "f2f-mp-label",
						children: item.label
					})]
				}, item.id))
			})
		]
	});
}, sameMicVoice);
//#endregion
//#region src/surface/silence-bar.tsx
/** The thin line under the user's words that fills as the quiet runs out and empties when they speak again: "sending on
* silence", the same countdown the composer's mic pill draws as a ring. It reaches full at the instant the words are sent.
* Memoised; a frame writes the transform only when its thousandth moved (it holds still between words). */
var SilenceBar = memo(function SilenceBar({ getSilence }) {
	const fill = useRef(null);
	const read = useRef(getSilence);
	read.current = getSilence;
	useEffect(() => {
		let raf = 0;
		let written = -1;
		const tick = () => {
			raf = requestAnimationFrame(tick);
			const thousandths = Math.round(Math.min(1, Math.max(0, read.current())) * 1e3);
			if (thousandths === written) return;
			written = thousandths;
			const el = fill.current;
			if (el) el.style.transform = `scaleX(${thousandths / 1e3})`;
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, []);
	return /* @__PURE__ */ jsx("span", {
		className: "f2f-silence",
		"aria-hidden": "true",
		children: /* @__PURE__ */ jsx("span", {
			ref: fill,
			className: "f2f-silence-fill"
		})
	});
});
//#endregion
//#region src/surface/styles.ts
var STYLES = `
.f2f-root {
	--f2f-ink: #1c1a17; --f2f-ink-2: #55514b; --f2f-ink-3: #8a857d;
	--f2f-line: rgba(28,26,23,.16); --f2f-hover: rgba(28,26,23,.06);
	--f2f-coral: #e2613a; --f2f-red: #e5484d;
	--f2f-pill-bg: #1c1a17; --f2f-pill-fg: #f4f2ee;
	--f2f-bar-top: #2f5a45; --f2f-bar-bottom: #ee7a3f;
	--f2f-paper: #f4f2ee; --f2f-panel: #ffffff; --f2f-warn: #b4541f;
	position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden;
	font-family: Inter, "SF Pro Display", "Helvetica Neue", system-ui, sans-serif;
	color: var(--f2f-ink); background: var(--f2f-paper); -webkit-font-smoothing: antialiased;
}
/* a dark host: warm near-black (the face renderer's INK_BG), light text, the pill turns to light */
.f2f-root[data-dark="true"] {
	--f2f-ink: #ece9e4; --f2f-ink-2: #aba69f; --f2f-ink-3: #77726b;
	--f2f-line: rgba(236,233,228,.16); --f2f-hover: rgba(236,233,228,.07);
	--f2f-coral: #ee7d58; --f2f-red: #f0616a;
	--f2f-pill-bg: #ece9e4; --f2f-pill-fg: #141311;
	--f2f-bar-top: #5fae8a; --f2f-bar-bottom: #f08a4f;
	--f2f-paper: #0e0d0c; --f2f-panel: #1c1b19; --f2f-warn: #f0a15e;
	color-scheme: dark;
}
.f2f-root button { font: inherit; }
.f2f-top {
	position: absolute; top: 0; left: 0; right: 0; z-index: 3; pointer-events: none;
	display: flex; align-items: center; justify-content: space-between; gap: 12px;
	padding: 18px 22px;
}
.f2f-cluster { display: flex; align-items: center; gap: 10px; pointer-events: auto; }
.f2f-btn {
	display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
	padding: 9px 15px; border-radius: 999px; border: 1px solid var(--f2f-line);
	background: transparent; color: var(--f2f-ink-2);
	font-size: 13px; font-weight: 500; line-height: 1; letter-spacing: -0.005em;
	transition: background .16s ease, color .16s ease, border-color .16s ease;
}
.f2f-btn:hover { background: var(--f2f-hover); color: var(--f2f-ink); }
.f2f-btn[aria-pressed="true"] { color: var(--f2f-ink); border-color: var(--f2f-ink-3); }
.f2f-btn svg { width: 15px; height: 15px; flex: none; }
.f2f-root :focus-visible { outline: 2px solid var(--f2f-coral); outline-offset: 2px; }
.f2f-mic {
	display: inline-flex; align-items: center; gap: 8px; padding: 9px 4px;
	font-size: 13px; font-weight: 500; line-height: 1; color: var(--f2f-ink-3);
}
.f2f-mic[data-on="true"] { color: var(--f2f-ink); }
.f2f-dot { position: relative; width: 8px; height: 8px; border-radius: 50%; background: var(--f2f-ink-3); opacity: .5; }
.f2f-mic[data-on="true"] .f2f-dot { background: var(--f2f-red); opacity: 1; }
.f2f-mic[data-on="true"] .f2f-dot::after {
	content: ""; position: absolute; inset: -4px; border-radius: 50%;
	border: 1.5px solid var(--f2f-red); opacity: 0; animation: f2f-ring 1.8s ease-out infinite;
}
@keyframes f2f-ring { 0% { transform: scale(.55); opacity: .7; } 100% { transform: scale(1.35); opacity: 0; } }
.f2f-bottom {
	position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; pointer-events: none;
	display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
	gap: 14px; padding: 0 24px max(22px, 2.8vh);
}
.f2f-bottom > * { pointer-events: auto; }
.f2f-stage {
	position: absolute; left: 50%; transform: translateX(-50%); bottom: 8.5%; z-index: 2;
	width: min(92%, 60em); min-height: 3.3em; display: flex; flex-direction: column;
	align-items: center; justify-content: flex-start; text-align: center; pointer-events: none;
}
.f2f-stage > * { pointer-events: auto; }
/* the face itself could not be loaded or drawn: the card takes the face's place, above the stage's controls */
.f2f-center {
	position: absolute; inset: 0 0 22% 0; z-index: 2; display: grid; place-items: center;
	padding: 72px 24px 0; pointer-events: none;
}
.f2f-center > * { pointer-events: auto; }
.f2f-fade { animation: f2f-in .32s ease both; }
@keyframes f2f-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.f2f-talk {
	display: inline-flex; align-items: center; gap: 12px; cursor: pointer;
	padding: 13px 26px 13px 16px; border-radius: 999px; border: 0;
	background: var(--f2f-pill-bg); color: var(--f2f-pill-fg);
	font-size: 16px; font-weight: 500; letter-spacing: -0.01em; line-height: 1;
	box-shadow: 0 1px 2px rgba(0,0,0,.14), 0 10px 28px -12px rgba(0,0,0,.4);
	transition: transform .16s ease, box-shadow .16s ease;
}
.f2f-talk:hover { transform: translateY(-1px); box-shadow: 0 2px 4px rgba(0,0,0,.16), 0 14px 32px -12px rgba(0,0,0,.46); }
.f2f-talk:active { transform: none; }
.f2f-talk-orb {
	width: 26px; height: 26px; border-radius: 50%; flex: none;
	background: radial-gradient(circle at 30% 28%, #ffd2a1 0, #f08a4b 34%, #d8583a 58%, transparent 60%),
		radial-gradient(circle at 74% 30%, #7fdcae 0, #4fa57f 40%, transparent 62%),
		conic-gradient(from 210deg, #ee7a3f, #d8583a, #4f9d7c, #ee7a3f);
}
.f2f-note { font-size: 14px; line-height: 1.5; color: var(--f2f-ink-3); letter-spacing: -0.005em; }
.f2f-note[data-warn="true"] { color: var(--f2f-warn); }
.f2f-usercap {
	font-size: clamp(18px, 2.45vh, 34px); line-height: 1.62; letter-spacing: -0.005em;
	color: var(--f2f-ink-3); max-width: 100%;
	display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
}
/* "sending on silence": a hairline under the words that fills as the quiet runs out (width driven per frame, never a CSS animation) */
.f2f-silence {
	display: block; flex: none; width: min(11em, 38%); height: 2px; margin-top: 10px; border-radius: 2px; overflow: hidden; contain: layout paint;
	background: color-mix(in srgb, var(--f2f-ink-3) 22%, transparent);
}
.f2f-silence-fill {
	display: block; width: 100%; height: 100%; border-radius: 2px; transform-origin: left center; transform: scaleX(0);
	background: linear-gradient(to right, var(--f2f-bar-top), var(--f2f-bar-bottom));
}
.f2f-card {
	max-width: 36em; padding: 18px 22px; border-radius: 14px; text-align: center;
	border: 1px solid var(--f2f-line); background: color-mix(in srgb, var(--f2f-pill-fg) 78%, transparent);
	backdrop-filter: blur(6px);
}
.f2f-card h2 { margin: 0 0 6px; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; color: var(--f2f-ink); }
.f2f-card p { margin: 0; font-size: 14.5px; line-height: 1.55; color: var(--f2f-ink-2); overflow-wrap: anywhere; }
.f2f-card p + p { margin-top: 8px; font-size: 13.5px; color: var(--f2f-ink-3); }
.f2f-card .f2f-btn { margin-top: 14px; }
.f2f-state { display: flex; align-items: center; gap: 14px; min-height: 34px; }
.f2f-label { min-width: 6.5em; font-size: 13px; font-weight: 500; letter-spacing: .02em; color: var(--f2f-ink-2); text-transform: none; }
/* fixed size, so layout and paint are contained: a bar growing every frame re-lays-out these 56x34px, never the page */
.f2f-wave { display: flex; align-items: center; justify-content: center; gap: 4px; height: 34px; width: 56px; contain: strict; }
.f2f-bar {
	display: block; width: 5px; border-radius: 3px;
	background: linear-gradient(to bottom, var(--f2f-bar-top), var(--f2f-bar-bottom));
}
.f2f-door {
	position: relative; width: 56px; height: 56px; padding: 0; border: 0; border-radius: 50%;
	background: transparent; cursor: pointer; display: block;
	transition: transform .2s cubic-bezier(.3,.7,.3,1);
}
.f2f-door:hover, .f2f-door:focus-visible { transform: scale(1.08); }
.f2f-door canvas { display: block; width: 56px; height: 56px; pointer-events: none; }
.f2f-door-label {
	position: absolute; right: 66px; top: 50%; transform: translate(6px, -50%);
	padding: 7px 13px; border-radius: 999px; white-space: nowrap; pointer-events: none;
	background: #1c1a17; color: #f4f2ee; border: 1px solid rgba(255,255,255,.14);
	font: 500 13px/1 Inter, "SF Pro Display", system-ui, sans-serif; letter-spacing: -0.005em;
	opacity: 0; transition: opacity .16s ease, transform .16s ease;
}
.f2f-door:hover .f2f-door-label, .f2f-door:focus-visible .f2f-door-label { opacity: 1; transform: translate(0, -50%); }
.f2f-door:focus-visible { outline: 2px solid #e2613a; outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) {
	.f2f-root *, .f2f-door, .f2f-door * { animation: none !important; transition: none !important; }
}
`;
//#endregion
//#region src/surface/surface-model.ts
function isOpen(phase) {
	return phase === "listening" || phase === "thinking" || phase === "speaking";
}
/** `engine` says a speech lane exists only after its probe answers; a surface that never gets one must say so. */
var UNAVAILABLE = {
	title: "Voice is not ready",
	detail: "Face to face needs an engine with a speech provider connected, and audio in this window.",
	hint: "Connect a speech provider in Capabilities (ElevenLabs needs an API key; an on-device voice may download a model first), then open this again."
};
var HINTS = [
	[/api key|apikey|unauthori[sz]ed|\b40[13]\b|invalid key/i, "Connect the provider's API key in Capabilities, then try again."],
	[/microphone|permission|denied|notallowed|not allowed/i, "Allow microphone access for this app in your system settings, then try again."],
	[/download|model|loading/i, "A speech model is loading or downloading. Wait for it to finish, then try again."],
	[/connection|disconnect|lost|closed|socket|unreachable/i, "Check that the engine is still running, then try again."]
];
function hintFor(message) {
	return HINTS.find(([pattern]) => pattern.test(message))?.[1];
}
function problemOf(v) {
	const detail = v.error?.trim() || "The voice conversation stopped.";
	const hint = hintFor(detail);
	return {
		title: "Voice stopped",
		detail,
		...hint ? { hint } : {}
	};
}
function surfacePhase(v, probeGraceOver) {
	if (v.phase !== "idle") return v.phase;
	if (v.supported) return "dormant";
	return probeGraceOver ? "unavailable" : "checking";
}
var LABELS = {
	checking: "Getting ready",
	connecting: "Connecting",
	listening: "Listening",
	thinking: "Thinking",
	speaking: "Speaking"
};
/** `probeGraceOver`: the engine has had time to answer whether it can speak; until then "not supported" means "not known yet". */
function describeSurface(v, probeGraceOver) {
	const phase = surfacePhase(v, probeGraceOver);
	const open = isOpen(phase);
	const muted = phase === "listening" && v.muted;
	const deaf = phase === "listening" && !muted && v.micSilent;
	const unsent = open && v.refusal !== void 0;
	return {
		phase,
		faceState: open && !muted && !deaf ? phase : "idle",
		label: muted ? "Muted" : deaf ? "No sound" : LABELS[phase] ?? "",
		tap: phase === "dormant" ? "talk" : phase === "error" ? "retry" : null,
		canMute: open,
		status: unsent ? v.refusal : deaf ? micSilentNotice(v.micLabel) : phase === "error" || phase === "unavailable" ? void 0 : v.notice,
		unsent,
		micSilent: deaf,
		userCaption: phase === "listening" && !muted ? v.partial.trim() : "",
		problem: phase === "error" ? problemOf(v) : phase === "unavailable" ? UNAVAILABLE : null
	};
}
/** Leave for the thread: end the conversation (releasing the microphone) and navigate. Both, whatever the phase. */
function leaveSurface(voice, onIntent) {
	voice.stop();
	onIntent({
		t: "mount",
		surface: "session"
	});
}
/** Whether two lists of blendshape names are the same names in the same order (the kit's `faceAt()` order vs this rig's). */
function sameArkitOrder(granted, ours) {
	return granted.length === ours.length && granted.every((name, i) => name === ours[i]);
}
/** Esc leaves, unless something else already used it or the person is typing. */
function isLeaveKey(e) {
	if (e.key !== "Escape" || e.defaultPrevented) return false;
	const el = e.target;
	const tag = el?.tagName?.toUpperCase();
	return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable === true);
}
/** Louder in the middle, like a voice's spectrum seen edge-on. */
var PROFILE = [
	.42,
	.7,
	.92,
	1,
	.9,
	.66,
	.4
];
function barHeights(t, level, phase, out) {
	const live = Math.min(1, Math.max(0, level));
	for (let i = 0; i < 7; i++) {
		let h = 0;
		if (phase === "listening" || phase === "speaking") {
			const wobble = .62 + .38 * Math.sin(t * (5.1 + i * 1.7) + i * 2.3);
			h = live * PROFILE[i] * wobble;
		} else if (phase === "thinking") h = .16 + .14 * Math.sin(t * 3.2 - i * .8);
		else if (phase === "connecting" || phase === "checking") h = .07 + .05 * Math.sin(t * 4 - i * .6);
		out[i] = Math.min(1, Math.max(0, h));
	}
}
//#endregion
//#region src/surface/waveform.tsx
var REST_PX = 5;
var FULL_PX = 34;
/**
* The rounded gradient-bar mark: a row of dots at rest that grows with the voice being heard or spoken. Memoised
* (it re-renders only when the phase changes), and a frame writes a bar's height only when its tenth of a pixel moved:
* a resting mark costs nothing, a live one costs a few style writes and no string building for the bars that held still.
*/
var Waveform = memo(function Waveform({ getLevel, phase }) {
	const bars = useRef([]);
	const live = useRef({
		getLevel,
		phase
	});
	live.current = {
		getLevel,
		phase
	};
	useEffect(() => {
		const heights = /* @__PURE__ */ new Float32Array(7);
		/** The tenth-pixel height each bar last had written (-1: never). */
		const written = (/* @__PURE__ */ new Int32Array(7)).fill(-1);
		let level = 0;
		let last = performance.now();
		let raf = 0;
		const tick = (now) => {
			raf = requestAnimationFrame(tick);
			if (document.hidden) return;
			const dt = Math.min(.1, (now - last) / 1e3);
			last = now;
			const { getLevel: read, phase: ph } = live.current;
			const target = ph === "listening" || ph === "speaking" ? Math.min(1, read()) : 0;
			level += (target - level) * (1 - Math.exp(-dt / (target > level ? .03 : .16)));
			barHeights(now / 1e3, level, ph, heights);
			for (let i = 0; i < 7; i++) {
				const tenths = Math.round((REST_PX + heights[i] * (FULL_PX - REST_PX)) * 10);
				if (tenths === written[i]) continue;
				written[i] = tenths;
				const el = bars.current[i];
				if (el) el.style.height = `${tenths / 10}px`;
			}
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, []);
	return /* @__PURE__ */ jsx("div", {
		className: "f2f-wave",
		"aria-hidden": "true",
		children: Array.from({ length: 7 }, (_, i) => /* @__PURE__ */ jsx("span", {
			className: "f2f-bar",
			ref: (el) => void (bars.current[i] = el),
			style: { height: REST_PX }
		}, i))
	});
});
//#endregion
//#region src/surface/face-surface.tsx
/** Long enough for an engine that has a speech lane to say so; past it, "not supported" is an answer. */
var PROBE_GRACE_MS = 2500;
/** Sustained CPU cost per frame (ms) above which the renderer drops to its lighter quality for good. */
var SLOW_FRAME_MS = 9;
var SLOW_FRAMES_TO_DEGRADE = 120;
var ANIMATOR_SEED = 7;
/** Where the captions sit: the same box `FaceView` gives them, for the fallback that draws them without a face. */
var CAPTION_BOX = {
	position: "absolute",
	left: "50%",
	transform: "translateX(-50%)",
	bottom: "8.5%",
	width: "min(92%, 60em)"
};
/** The face fills the surface. A constant, so the memoised `FaceView` sees the same style every render. */
var FACE_STYLE = {
	position: "absolute",
	inset: 0
};
/** The face draws no captions of its own here: the surface places them (below), so a new word re-renders them alone. */
var NO_WORDS = [];
var ICON = {
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.8,
	strokeLinecap: "round",
	strokeLinejoin: "round",
	viewBox: "0 0 24 24"
};
function MicIcon({ off }) {
	return /* @__PURE__ */ jsxs("svg", {
		...ICON,
		"aria-hidden": "true",
		children: [
			/* @__PURE__ */ jsx("rect", {
				x: "9",
				y: "3",
				width: "6",
				height: "12",
				rx: "3"
			}),
			/* @__PURE__ */ jsx("path", { d: "M5 11a7 7 0 0 0 14 0M12 18v3" }),
			off && /* @__PURE__ */ jsx("path", { d: "M4 4l16 16" })
		]
	});
}
function ProblemCard({ problem, action }) {
	return /* @__PURE__ */ jsxs("div", {
		className: "f2f-card f2f-fade",
		role: "alert",
		children: [
			/* @__PURE__ */ jsx("h2", { children: problem.title }),
			/* @__PURE__ */ jsx("p", { children: problem.detail }),
			problem.hint && /* @__PURE__ */ jsx("p", { children: problem.hint }),
			action && /* @__PURE__ */ jsx("button", {
				type: "button",
				className: "f2f-btn",
				onClick: action.run,
				children: action.label
			})
		]
	});
}
/** Back, the mic status, Mute and the input picker. It depends on six things that change when you act, not on the words being said, so it does not re-render with them. */
var TopBar = memo(function TopBar({ onBack, micLive, canMute, muted, voice }) {
	return /* @__PURE__ */ jsxs("div", {
		className: "f2f-top",
		children: [/* @__PURE__ */ jsxs("button", {
			type: "button",
			className: "f2f-btn",
			onClick: onBack,
			"aria-label": "Back to thread (Esc)",
			children: [/* @__PURE__ */ jsx("svg", {
				...ICON,
				"aria-hidden": "true",
				children: /* @__PURE__ */ jsx("path", { d: "M15 5l-7 7 7 7" })
			}), "Back to thread"]
		}), /* @__PURE__ */ jsxs("div", {
			className: "f2f-cluster",
			children: [/* @__PURE__ */ jsxs("span", {
				className: "f2f-mic",
				"data-on": micLive,
				role: "status",
				children: [/* @__PURE__ */ jsx("span", {
					className: "f2f-dot",
					"aria-hidden": "true"
				}), micLive ? "Mic on" : "Mic off"]
			}), canMute && /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsxs("button", {
				type: "button",
				className: "f2f-btn",
				onClick: () => voice.toggleMute(),
				"aria-pressed": muted,
				children: [/* @__PURE__ */ jsx(MicIcon, { off: muted }), muted ? "Unmute" : "Mute"]
			}), /* @__PURE__ */ jsx(MicPicker, { voice })] })]
		})]
	});
}, (a, b) => a.onBack === b.onBack && a.micLive === b.micLive && a.canMute === b.canMute && a.muted === b.muted && a.voice.toggleMute === b.voice.toggleMute && sameMicVoice(a, b));
/** The host's theme, read off the first painted background above the surface; re-read when the host flips its
* theme (an attribute on <html> or <body>) or the OS scheme changes. */
function useHostDark(root) {
	const [dark, setDark] = useState(false);
	useLayoutEffect(() => {
		const scheme = window.matchMedia("(prefers-color-scheme: dark)");
		const read = () => setDark(detectDark(root.current?.parentElement ?? null, scheme.matches));
		read();
		const watch = new MutationObserver(read);
		for (const el of [document.documentElement, document.body]) watch.observe(el, {
			attributes: true,
			attributeFilter: [
				"class",
				"style",
				"data-theme"
			]
		});
		scheme.addEventListener("change", read);
		return () => {
			watch.disconnect();
			scheme.removeEventListener("change", read);
		};
	}, [root]);
	return dark;
}
/** The full-screen face: paper, the face, captions, the waveform mark, and the four controls (Tap to talk, Mute, Back, Esc). */
function FaceSurfaceBody({ voice, head, onIntent }) {
	const [graceOver, setGraceOver] = useState(false);
	const [quality, setQuality] = useState("high");
	const root = useRef(null);
	const dark = useHostDark(root);
	const view = describeSurface(voice, graceOver);
	const live = useRef({
		voice,
		view
	});
	live.current = {
		voice,
		view
	};
	const animator = useMemo(() => {
		const a = new FaceAnimator(ANIMATOR_SEED);
		a.setFormation(0);
		a.setFormationTarget(1);
		return a;
	}, []);
	const input = useRef({
		state: "idle",
		playhead: null,
		audioRms: 0,
		micRms: 0
	}).current;
	const getInput = useCallback(() => {
		const { voice: v, view: s } = live.current;
		const speaking = s.phase === "speaking";
		input.state = s.faceState;
		input.playhead = speaking ? v.audioClock() : null;
		input.audioRms = speaking ? v.levels.getAgent() : 0;
		input.micRms = s.phase === "listening" ? v.levels.getMic() : 0;
		return input;
	}, [input]);
	const getCaptionTime = useCallback(() => live.current.voice.audioClock(), []);
	const getWaveLevel = useCallback(() => {
		const { voice: v, view: s } = live.current;
		return s.phase === "speaking" ? v.levels.getAgent() : v.levels.getMic();
	}, []);
	const getSilence = useCallback(() => live.current.voice.levels.getSilence(), []);
	useEffect(() => animator.setWords(voice.words), [animator, voice.words]);
	const poseSource = useMemo(() => voice.faceModel ? { arkit: () => live.current.voice.faceAt() } : "procedural", [voice.faceModel]);
	const slowFrames = useRef(0);
	const onFrameCost = useCallback((ms) => {
		slowFrames.current = ms > SLOW_FRAME_MS ? slowFrames.current + 1 : Math.max(0, slowFrames.current - 1);
		if (slowFrames.current > SLOW_FRAMES_TO_DEGRADE) setQuality("low");
	}, []);
	useEffect(() => {
		const id = setTimeout(() => setGraceOver(true), PROBE_GRACE_MS);
		return () => clearTimeout(id);
	}, []);
	const intentRef = useRef(onIntent);
	intentRef.current = onIntent;
	const leave = useCallback(() => leaveSurface(live.current.voice, (intent) => intentRef.current(intent)), []);
	useEffect(() => {
		const onKey = (e) => {
			if (!isLeaveKey(e)) return;
			e.preventDefault();
			leave();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [leave]);
	const startTalking = useCallback(() => void live.current.voice.start(), []);
	const faceFailed = head.status === "failed" ? head.message : null;
	const cannotLoad = (message) => ({
		title: "The face could not be loaded",
		detail: message,
		hint: "Update or reinstall Face to face, then open it again."
	});
	const cannotDraw = (message) => ({
		title: "The face could not be drawn",
		detail: message,
		hint: "Face to face draws with WebGL2. Turn on hardware acceleration for this window, then reopen it."
	});
	return /* @__PURE__ */ jsxs("div", {
		ref: root,
		className: "f2f-root",
		"data-dark": dark,
		"data-phase": view.phase,
		"data-quality": quality,
		children: [
			/* @__PURE__ */ jsx("style", { children: STYLES }),
			head.status === "ready" && /* @__PURE__ */ jsxs(FaceBoundary, {
				fallback: (message) => /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("div", {
					className: "f2f-center",
					children: /* @__PURE__ */ jsx(ProblemCard, { problem: cannotDraw(message) })
				}), !view.userCaption && /* @__PURE__ */ jsx(Captions, {
					words: voice.words,
					getTime: getCaptionTime,
					dark,
					style: CAPTION_BOX
				})] }),
				children: [/* @__PURE__ */ jsx(FaceView, {
					head: head.asset,
					animator,
					getInput,
					words: NO_WORDS,
					getCaptionTime,
					dark,
					showCaptions: false,
					poseSource,
					quality,
					onFrameCost,
					style: FACE_STYLE
				}), !view.userCaption && /* @__PURE__ */ jsx(Captions, {
					words: voice.words,
					getTime: getCaptionTime,
					dark,
					style: CAPTION_BOX
				})]
			}),
			/* @__PURE__ */ jsx(TopBar, {
				onBack: leave,
				micLive: voice.micLive,
				canMute: view.canMute,
				muted: voice.muted,
				voice
			}),
			faceFailed !== null && /* @__PURE__ */ jsx("div", {
				className: "f2f-center",
				children: /* @__PURE__ */ jsx(ProblemCard, { problem: cannotLoad(faceFailed) })
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "f2f-stage",
				children: [
					view.tap === "talk" && /* @__PURE__ */ jsxs("button", {
						type: "button",
						className: "f2f-talk f2f-fade",
						onClick: startTalking,
						children: [/* @__PURE__ */ jsx("span", {
							className: "f2f-talk-orb",
							"aria-hidden": "true"
						}), "Tap to talk"]
					}),
					view.problem && /* @__PURE__ */ jsx(ProblemCard, {
						problem: view.problem,
						action: view.tap === "retry" ? {
							label: "Try again",
							run: startTalking
						} : void 0
					}),
					view.userCaption && /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("p", {
						className: "f2f-usercap f2f-fade",
						style: { margin: 0 },
						children: view.userCaption
					}), /* @__PURE__ */ jsx(SilenceBar, { getSilence })] })
				]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "f2f-bottom",
				children: [view.status && /* @__PURE__ */ jsx("span", {
					className: "f2f-note",
					"data-warn": view.micSilent || view.unsent,
					role: "status",
					children: view.status
				}), view.label && /* @__PURE__ */ jsxs("div", {
					className: "f2f-state",
					children: [/* @__PURE__ */ jsx(Waveform, {
						getLevel: getWaveLevel,
						phase: view.phase
					}), /* @__PURE__ */ jsx("span", {
						className: "f2f-label",
						role: "status",
						children: view.label
					})]
				})]
			})
		]
	});
}
//#endregion
//#region src/face/head-asset.ts
var MAGIC = "DFH2";
async function decodeHead(bytes) {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== MAGIC) throw new Error("not a face head asset");
	const hl = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(4, true);
	const header = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hl)));
	if (header.v !== 2) throw new Error(`unsupported head asset v${header.v}`);
	const pose = Uint8Array.from(header.shapes, (name) => {
		const i = arkitIndexOf(name);
		if (i === void 0) throw new Error(`head asset carries unknown shape ${name}`);
		return i;
	});
	const inflated = await new Response(new Blob([u8.slice(8 + hl)]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
	const { n } = header;
	const shapeCount = header.shapes.length;
	const posQ = new Int16Array(inflated, 0, n * 3);
	const nrm = new Int8Array(inflated, n * 6, n * 4);
	const col = new Uint8Array(inflated, n * 10, n * 4);
	const raw = new Int8Array(inflated, n * 14);
	const instances = /* @__PURE__ */ new ArrayBuffer(n * 16);
	const i16 = new Int16Array(instances);
	const i8 = new Int8Array(instances);
	for (let i = 0; i < n; i++) {
		i16[i * 8] = posQ[i * 3];
		i16[i * 8 + 1] = posQ[i * 3 + 1];
		i16[i * 8 + 2] = posQ[i * 3 + 2];
		for (let c = 0; c < 4; c++) {
			i8[i * 16 + 8 + c] = nrm[i * 4 + c];
			i8[i * 16 + 12 + c] = col[i * 4 + c];
		}
	}
	const deltas = new Int8Array(shapeCount * n * 4);
	for (let s = 0; s < shapeCount; s++) {
		const base = s * n * 3;
		for (let c = 0; c < 3; c++) {
			let acc = 0;
			for (let i = 0; i < n; i++) {
				acc = acc + raw[base + i * 3 + c] << 24 >> 24;
				deltas[(s * n + i) * 4 + c] = acc;
			}
		}
	}
	return {
		header,
		instances,
		deltas,
		pose
	};
}
//#endregion
//#region src/surface/head.ts
var BASE64_PREFIX = /^data:[^,;]*;base64,/;
function dataUrlBytes(url) {
	const prefix = BASE64_PREFIX.exec(url);
	if (!prefix) throw new Error("the head asset is not a base64 data URL");
	const binary = atob(url.slice(prefix[0].length));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
var loading = /* @__PURE__ */ new Map();
/** Decode once per page per asset; a failure is not remembered, so the next mount tries again. */
function loadHead(dataUrl) {
	let started = loading.get(dataUrl);
	if (!started) {
		started = Promise.resolve().then(() => decodeHead(dataUrlBytes(dataUrl)));
		loading.set(dataUrl, started);
		const own = started;
		own.catch(() => {
			if (loading.get(dataUrl) === own) loading.delete(dataUrl);
		});
	}
	return started;
}
function useHead(dataUrl) {
	const [state, setState] = useState({ status: "loading" });
	useEffect(() => {
		let live = true;
		loadHead(dataUrl).then((asset) => live && setState({
			status: "ready",
			asset
		}), (error) => live && setState({
			status: "failed",
			message: error instanceof Error ? error.message : String(error)
		}));
		return () => {
			live = false;
		};
	}, [dataUrl]);
	return state;
}
//#endregion
//#region src/surface/head-source.ts
var head_source_default = "data:application/octet-stream;base64,REZIMtwKAAB7InYiOjIsImlkIjoiZjAxIiwibiI6ODk5OSwic2hhcGVzIjpbImJyb3dEb3duTGVmdCIsImJyb3dEb3duUmlnaHQiLCJicm93SW5uZXJVcCIsImJyb3dPdXRlclVwTGVmdCIsImJyb3dPdXRlclVwUmlnaHQiLCJjaGVla1B1ZmYiLCJjaGVla1NxdWludExlZnQiLCJjaGVla1NxdWludFJpZ2h0IiwiZXllQmxpbmtMZWZ0IiwiZXllQmxpbmtSaWdodCIsImV5ZUxvb2tEb3duTGVmdCIsImV5ZUxvb2tEb3duUmlnaHQiLCJleWVMb29rSW5MZWZ0IiwiZXllTG9va0luUmlnaHQiLCJleWVMb29rT3V0TGVmdCIsImV5ZUxvb2tPdXRSaWdodCIsImV5ZUxvb2tVcExlZnQiLCJleWVMb29rVXBSaWdodCIsImV5ZVNxdWludExlZnQiLCJleWVTcXVpbnRSaWdodCIsImV5ZVdpZGVMZWZ0IiwiZXllV2lkZVJpZ2h0IiwiamF3Rm9yd2FyZCIsImphd0xlZnQiLCJqYXdPcGVuIiwiamF3UmlnaHQiLCJtb3V0aENsb3NlIiwibW91dGhEaW1wbGVMZWZ0IiwibW91dGhEaW1wbGVSaWdodCIsIm1vdXRoRnJvd25MZWZ0IiwibW91dGhGcm93blJpZ2h0IiwibW91dGhGdW5uZWwiLCJtb3V0aExlZnQiLCJtb3V0aExvd2VyRG93bkxlZnQiLCJtb3V0aExvd2VyRG93blJpZ2h0IiwibW91dGhQcmVzc0xlZnQiLCJtb3V0aFByZXNzUmlnaHQiLCJtb3V0aFB1Y2tlciIsIm1vdXRoUmlnaHQiLCJtb3V0aFJvbGxMb3dlciIsIm1vdXRoUm9sbFVwcGVyIiwibW91dGhTaHJ1Z0xvd2VyIiwibW91dGhTaHJ1Z1VwcGVyIiwibW91dGhTbWlsZUxlZnQiLCJtb3V0aFNtaWxlUmlnaHQiLCJtb3V0aFN0cmV0Y2hMZWZ0IiwibW91dGhTdHJldGNoUmlnaHQiLCJtb3V0aFVwcGVyVXBMZWZ0IiwibW91dGhVcHBlclVwUmlnaHQiLCJub3NlU25lZXJMZWZ0Iiwibm9zZVNuZWVyUmlnaHQiLCJ0b25ndWVPdXQiXSwic2NhbGVzIjpbMC4wMDQ1ODM2NDIzNTIzNzI0MDgsMC4wMDQ0MzQxMzE1NTE1MzM5Mzc1LDAuMDA5OTcwMDc4MjQ0ODA1MzM2LDAuMDA0ODUwNDA2NjY1MzU0OTY3LDAuMDA1NTY3MTM2Njg2Mjk1MjcxLDAuMDA2MTUzMzQ4MzY3NjYxMjM4LDAuMDA2MDIxNzQzNjQwMzAzNjEyLDAuMDA2MTM3NTY0Nzc4MzI3OTQyLDAuMDA1NDM3MDAwMTg4OTc2NTI2LDAuMDA1ODEyOTc5NzY4OTYxNjY4LDAuMDAyNTMxMDc5MTA5NzU4MTM4NywwLjAwMjg0NTA1MzMyODIwMTE3NDcsMC4wMDQ2MjExNDI1MjE1MDA1ODc1LDAuMDA1MjAxMzM0NTk5NDA1NTI3LDAuMDA1MjUwNDIyMjg0MDA3MDcyNCwwLjAwNjE0NDY1MjE0MzEyMDc2NiwwLjAwMjA5OTIxNzM4MTMyODM0NDMsMC4wMDE5OTQzNTI3ODc3MzMwNzgsMC4wMDE4MTc1ODMxMDY0NTgxODcsMC4wMDE5MDQ2NTQ2NjU4NTAxMDMsMC4wMDEyNjI0ODg3NzQ5NTUyNzI3LDAuMDAxNzE4MzY1MzU0NDYzNDU4LDAuMDA4MjE1NDg5Nzk3Mjk0MTQsMC4wMDYwOTQwNTAxMjgwMTI4OTYsMC4wMTcwNzIzMDEzNTc5ODQ1NDMsMC4wMDU0MTE0NTA3NTExMjU4MTI1LDAuMDE3OTA5MjQxODQwMjQzMzQsMC4wMDM2OTE3ODQxMDYxOTQ5NzMsMC4wMDMwMTk3ODk2OTk0NjUwMzY0LDAuMDA0NjQzMjgxNDU2MDgzMDU5LDAuMDAyMDM2NTI3MDMyMDMyNjA5LDAuMDA4NDk5MzIwNTk2NDU2NTI4LDAuMDA0NjE5Nzk5MDg4Njg2NzA1LDAuMDA0MDczNzQ2OTY4MDYwNzMyLDAuMDAyODU0Njg4MzI1ODk2ODU5LDAuMDA0MjE5NjMwMjY3NDcxMDc1LDAuMDA2NTc2MjU4Njg5MTY1MTE1LDAuMDA0NTgwNzM5ODg1NTY4NjE5LDAuMDA3MTIxNTIyOTEwODkyOTYzLDAuMDA3NjcxNTIyNDQyMjUxNDQ0LDAuMDAzNjY2OTk1NzkxNzE4MzYzOCwwLjAxMTkzNzA3NjIyNTg3NjgwOCwwLjAwNDY0MDY2OTU2MTkyMjU1LDAuMDAzMzU5OTA3MzA2NzMwNzQ3MiwwLjAwNDI0OTIwMTE1NjE5ODk3OCwwLjAwNDEzODYzNDU0MDE0MDYyOSwwLjAwMzU1ODMyMTg1NTk2MjI3NjUsMC4wMDQ2NDQ0Mjk3NzY4MTc1NiwwLjAwMzU4ODE4MDA1NzcwNDQ0ODcsMC4wMDQzMTY4OTc1OTcxNjM5MTYsMC4wMDUyMTI1NDc3MjMyMDM4OTc1LDAuMDI1MjQzNDc5NzU4NTAxMDUzXSwiY2VudGVyIjpbLTAuMDAyMTk5MDM1MTM3ODkxNzY5NCwxLjU3ODMxNjMzMDkwOTcyOSwtMC4wNjkyMTAzODc3NjYzNjEyNF0sImhhbGYiOlswLjExNjQ0NjExMDE1OTE1ODcsMC4xODYxODMxMjM1ODg1NjIwNCwwLjE3NDIxMjM0Mjc5ODcwOTg3XSwibGFuZG1hcmtzIjp7ImV5ZVkiOjEuNjEzNTM5MzcyNTY5NjAxLCJtb3V0aFkiOjEuNTQ3NzU4MTY1Mzk0ODc1NSwiY2hpblkiOjEuNDg1NzU4MTY1Mzk0ODc1NSwiY3Jvd25ZIjoxLjczNjg1NjkzNzQwODQ0NzMsIm5vc2VaIjowLjA3NTAzNDc2NzM4OTI5NzQ5LCJuZWNrQm90dG9tIjoxLjQyMDc1ODE2NTM5NDg3NTUsInBpdm90IjpbMCwxLjUyMDc1ODE2NTM5NDg3NTQsLTAuMDU5NzAzMDUxOTU5MjQ5MTA0XX0sInJvd1NwYWNpbmciOjAuMDA0NDY2MzYyMDU0Mjg5ODIyLCJjb2xTcGFjaW5nIjowLjAwMzU3MzA4OTY0MzQzMTg1OCwic291cmNlIjp7InByb2plY3QiOiJNaWNyb3NvZnQgUm9ja2V0Ym94IEF2YXRhciBMaWJyYXJ5IChNSVQpIiwicmVwbyI6Imh0dHBzOi8vZ2l0aHViLmNvbS9taWNyb3NvZnQvTWljcm9zb2Z0LVJvY2tldGJveCIsImNvbW1pdCI6IjA5NDMwNTVkYjZlYzU3MGJjZWY5ZjJjOGI0MWM5ZTU0NjdjODA4ZjkiLCJmYngiOiJBc3NldHMvQXZhdGFycy9BZHVsdHMvRmVtYWxlX0FkdWx0XzAxL0V4cG9ydC9GZW1hbGVfQWR1bHRfMDFfZmFjaWFs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";
//#endregion
//#region src/surface/voice.ts
var NO_FACE = () => null;
var ORDER_AGREES = sameArkitOrder(ARKIT_52_NAMES, ARKIT_52);
if (!ORDER_AGREES) console.warn("[face-to-face] the host's ARKIT_52_NAMES order differs from this pack's rig; using the procedural mouth");
function useFaceVoice() {
	const voice = useVoiceConversation();
	return useMemo(() => ORDER_AGREES ? voice : {
		...voice,
		faceModel: false,
		faceAt: NO_FACE
	}, [voice]);
}
//#endregion
//#region src/surface/orb.ts
var DOTS = 360;
var GOLDEN = 2.399963229728653;
var BUCKETS = 24;
var SPRITE_PX = 32;
/** Coral -> orange -> peach -> mint -> deep green, the palette of the launch video's orb and waveform. */
var STOPS = [
	[
		226,
		84,
		52
	],
	[
		240,
		134,
		74
	],
	[
		246,
		196,
		146
	],
	[
		132,
		214,
		170
	],
	[
		58,
		118,
		88
	]
];
function orbColor(c) {
	const x = Math.min(1, Math.max(0, c)) * (STOPS.length - 1);
	const i = Math.min(STOPS.length - 2, Math.floor(x));
	const k = x - i;
	const a = STOPS[i];
	const b = STOPS[i + 1];
	return [
		a[0] + (b[0] - a[0]) * k,
		a[1] + (b[1] - a[1]) * k,
		a[2] + (b[2] - a[2]) * k
	];
}
function makeSprites() {
	return Array.from({ length: BUCKETS }, (_, i) => {
		const cv = document.createElement("canvas");
		cv.width = cv.height = SPRITE_PX;
		const g = cv.getContext("2d");
		if (g) {
			const [r, gg, b] = orbColor(i / (BUCKETS - 1)).map(Math.round);
			const grad = g.createRadialGradient(SPRITE_PX / 2, SPRITE_PX / 2, 0, SPRITE_PX / 2, SPRITE_PX / 2, SPRITE_PX / 2);
			grad.addColorStop(0, `rgba(${r},${gg},${b},1)`);
			grad.addColorStop(.5, `rgba(${r},${gg},${b},0.75)`);
			grad.addColorStop(1, `rgba(${r},${gg},${b},0)`);
			g.fillStyle = grad;
			g.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
		}
		return cv;
	});
}
function createOrb(canvas, size, dpr) {
	const g = canvas.getContext("2d");
	if (!g) return null;
	canvas.width = Math.round(size * dpr);
	canvas.height = Math.round(size * dpr);
	const half = size / 2;
	const radius = half - 6;
	const sprites = makeSprites();
	const dots = Array.from({ length: 370 }, (_, i) => {
		if (i >= DOTS) {
			const k = i - DOTS;
			return {
				r0: radius * (1.08 + .2 * (k * .37 % 1)),
				a0: k * 2.1,
				seed: k * 1.7,
				size: .9
			};
		}
		return {
			r0: radius * Math.sqrt((i + .5) / DOTS),
			a0: i * GOLDEN,
			seed: i * .618034,
			size: 1.15 + 1.1 * (i * 7919 % 97 / 97)
		};
	});
	return { draw(t) {
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.clearRect(0, 0, size, size);
		const breath = 1 + .035 * Math.sin(t * 1.1);
		const axis = t * .157 - .9;
		const ax = Math.cos(axis);
		const ay = Math.sin(axis);
		for (let i = 0; i < dots.length; i++) {
			const d = dots[i];
			const stray = i >= DOTS;
			const depth = stray ? .3 : Math.sqrt(Math.max(0, 1 - (d.r0 / radius) ** 2));
			const ang = d.a0 + t * (stray ? .05 : .11) * (1.15 - .6 * (d.r0 / radius));
			const r = d.r0 * breath * (1 + .05 * Math.sin(t * .9 + d.seed * 6.283));
			const x = half + Math.cos(ang) * r;
			const y = half + Math.sin(ang) * r;
			const field = ((x - half) * ax + (y - half) * ay) / radius;
			const c = .5 + .5 * Math.max(-1, Math.min(1, field * 1.1 + .25 * Math.sin(d.seed * 3 + t * .35)));
			const bucket = Math.round(c * (BUCKETS - 1));
			const s = d.size * (.75 + .55 * depth) * (stray ? 1 : 1 + .12 * Math.sin(t * 1.7 + d.seed * 9)) * 2.4;
			g.globalAlpha = stray ? .55 : .5 + .5 * depth;
			g.drawImage(sprites[bucket], x - s / 2, y - s / 2, s, s);
		}
		g.globalAlpha = 1;
	} };
}
//#endregion
//#region src/surface/face-door.tsx
var SIZE = 56;
var FRAME_MS = 33;
/** The pinned widget that opens the face: a small living orb. Gone while the face is up. */
function FaceDoor({ activeSurface, onIntent }) {
	return activeSurface === "face" ? null : /* @__PURE__ */ jsx(DoorOrb, { onOpen: () => onIntent({
		t: "mount",
		surface: "face"
	}) });
}
function DoorOrb({ onOpen }) {
	const canvas = useRef(null);
	useEffect(() => {
		const cv = canvas.current;
		if (!cv) return;
		const orb = createOrb(cv, SIZE, Math.min(2, window.devicePixelRatio || 1));
		if (!orb) return;
		const still = window.matchMedia("(prefers-reduced-motion: reduce)");
		const origin = performance.now();
		let visible = true;
		let raf = 0;
		let last = 0;
		const frame = (now) => {
			raf = requestAnimationFrame(frame);
			if (now - last < FRAME_MS) return;
			last = now;
			orb.draw((now - origin) / 1e3);
		};
		const sync = () => {
			const run = visible && !document.hidden && !still.matches;
			if (run && !raf) raf = requestAnimationFrame(frame);
			else if (!run && raf) {
				cancelAnimationFrame(raf);
				raf = 0;
			}
			if (still.matches) orb.draw(2);
		};
		const io = new IntersectionObserver((entries) => {
			visible = entries[entries.length - 1].isIntersecting;
			sync();
		});
		io.observe(cv);
		document.addEventListener("visibilitychange", sync);
		still.addEventListener("change", sync);
		sync();
		return () => {
			io.disconnect();
			document.removeEventListener("visibilitychange", sync);
			still.removeEventListener("change", sync);
			cancelAnimationFrame(raf);
		};
	}, []);
	return /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("style", { children: STYLES }), /* @__PURE__ */ jsxs("button", {
		type: "button",
		className: "f2f-door",
		"aria-label": "Talk face to face",
		onClick: onOpen,
		children: [/* @__PURE__ */ jsx("canvas", {
			ref: canvas,
			style: {
				width: SIZE,
				height: SIZE
			}
		}), /* @__PURE__ */ jsx("span", {
			className: "f2f-door-label",
			"aria-hidden": "true",
			children: "Face to face"
		})]
	})] });
}
//#endregion
//#region src/index.tsx
var Seated = memo(function Seated({ onIntent }) {
	return /* @__PURE__ */ jsx(FaceSurfaceBody, {
		voice: useFaceVoice(),
		head: useHead(head_source_default),
		onIntent
	});
});
var FaceSurfaceSeat = memo(function FaceSurfaceSeat({ store, onIntent }) {
	const latest = useRef(onIntent);
	latest.current = onIntent;
	const intent = useCallback((i) => latest.current(i), []);
	/** A surface the host seated has a `store`; without one there is nothing to talk through, and this says so. */
	if (store) return /* @__PURE__ */ jsx(Seated, { onIntent: intent });
	return /* @__PURE__ */ jsxs("div", {
		className: "f2f-root",
		role: "alert",
		style: {
			display: "grid",
			placeItems: "center",
			padding: 24
		},
		children: [/* @__PURE__ */ jsx("style", { children: STYLES }), /* @__PURE__ */ jsxs("div", {
			className: "f2f-card",
			children: [
				/* @__PURE__ */ jsx("h2", { children: "This build cannot seat surfaces" }),
				/* @__PURE__ */ jsx("p", { children: "Face to face talks through the seat the host gives it, and this host did not give it one." }),
				/* @__PURE__ */ jsx("p", { children: "Update the app, then open Face to face again." }),
				/* @__PURE__ */ jsx("button", {
					type: "button",
					className: "f2f-btn",
					onClick: () => latest.current({
						t: "mount",
						surface: "session"
					}),
					children: "Back to thread"
				})
			]
		})]
	});
}, (a, b) => a.store === b.store);
/** The workspace-surface fill (the bundle's default export stays a plain function component; the memo is the seat inside it). */
function FaceSurface(props) {
	return /* @__PURE__ */ jsx(FaceSurfaceSeat, { ...props });
}
//#endregion
export { FaceDoor, FaceSurface as default };
