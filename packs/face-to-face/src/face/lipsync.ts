// Grapheme -> viseme lip-sync from word timings. Words arrive with start/end seconds on the turn's audio
// timeline (protocol `words`); each word's letters become a short viseme sequence spread over its window,
// and the overlapping raised-cosine bumps give coarticulation for free. The viseme weights are then projected
// onto ARKit shapes through VISEME_RIG: the head has no Oculus viseme morphs, only the 52 ARKit ones, and this
// procedural mouth is the fallback that must land in the SAME shapes the audio model drives.
import type { ArkitName } from "./shapes";

export const VISEMES = ["PP", "FF", "TH", "DD", "KK", "CH", "SS", "nn", "RR", "aa", "E", "I", "O", "U"] as const;
export type Viseme = (typeof VISEMES)[number];

type Sided = "mouthPress" | "mouthStretch" | "mouthSmile" | "mouthLowerDown" | "mouthUpperUp";
const both = (n: Sided, v: number): Partial<Record<ArkitName, number>> => ({ [`${n}Left`]: v, [`${n}Right`]: v });

/**
 * Each viseme as a sparse blend of ARKit shapes at the weight a natural speaker reaches when that viseme is
 * fully on (the usual Oculus -> ARKit practice, scaled down: speech opens the lower lip far more than the jaw,
 * lip corners barely move). Bilabials press instead of opening; only mouth-group shapes appear here, so the
 * eyes, brows and blink can never be double-driven by the fallback.
 */
export const VISEME_RIG: Record<Viseme, Partial<Record<ArkitName, number>>> = {
	PP: { mouthClose: 0.7, ...both("mouthPress", 0.75), mouthRollLower: 0.15 },
	FF: { mouthRollLower: 0.55, mouthShrugUpper: 0.4, jawOpen: 0.06 },
	TH: { jawOpen: 0.1, ...both("mouthLowerDown", 0.25) },
	DD: { jawOpen: 0.08, ...both("mouthLowerDown", 0.12), ...both("mouthStretch", 0.15) },
	KK: { jawOpen: 0.1, ...both("mouthLowerDown", 0.15), ...both("mouthStretch", 0.08) },
	CH: { mouthFunnel: 0.4, jawOpen: 0.08, ...both("mouthLowerDown", 0.1), ...both("mouthStretch", 0.1) },
	SS: { jawOpen: 0.06, ...both("mouthStretch", 0.3), ...both("mouthSmile", 0.08) },
	nn: { jawOpen: 0.06, ...both("mouthLowerDown", 0.08), ...both("mouthStretch", 0.12) },
	RR: { mouthFunnel: 0.3, mouthPucker: 0.25, jawOpen: 0.1, ...both("mouthLowerDown", 0.15) },
	aa: { jawOpen: 0.36, ...both("mouthLowerDown", 0.5), ...both("mouthUpperUp", 0.2) },
	E: { jawOpen: 0.15, ...both("mouthLowerDown", 0.22), ...both("mouthStretch", 0.3), ...both("mouthSmile", 0.2) },
	I: { jawOpen: 0.1, ...both("mouthLowerDown", 0.12), ...both("mouthStretch", 0.25), ...both("mouthSmile", 0.22) },
	O: { jawOpen: 0.25, mouthFunnel: 0.5, mouthPucker: 0.3, ...both("mouthLowerDown", 0.3) },
	U: { jawOpen: 0.08, mouthPucker: 0.5, mouthFunnel: 0.35, ...both("mouthLowerDown", 0.08) },
};

export interface CaptionWord {
	w: string;
	s: number;
	e: number;
}

export interface Phone {
	viseme: Viseme;
	/** Peak weight 0..1. */
	strength: number;
	/** Relative duration inside the word. */
	dur: number;
}

export interface VisemeEvent {
	center: number;
	half: number;
	viseme: Viseme;
	strength: number;
}

const STRENGTH: Record<Viseme, number> = {
	PP: 1, FF: 0.9, TH: 0.6, DD: 0.5, KK: 0.35, CH: 0.7, SS: 0.55, nn: 0.4, RR: 0.55,
	aa: 0.95, E: 0.8, I: 0.7, O: 0.9, U: 0.85,
};
const VOWELS: ReadonlySet<Viseme> = new Set<Viseme>(["aa", "E", "I", "O", "U"]);

const DIGRAPHS: [string, Viseme | null][] = [
	["tch", "CH"], ["igh", "I"], ["sh", "CH"], ["ch", "CH"], ["th", "TH"], ["ph", "FF"], ["ng", "nn"], ["ck", "KK"],
	["kn", "nn"], ["wr", "RR"], ["wh", "U"],
	["oo", "U"], ["ou", "O"], ["ow", "O"], ["oa", "O"], ["oi", "O"], ["oy", "O"], ["ee", "I"], ["ea", "I"],
	["ie", "I"], ["ai", "E"], ["ay", "E"], ["ei", "E"], ["ey", "E"], ["au", "aa"], ["aw", "aa"], ["ew", "U"],
	["ue", "U"], ["ui", "I"],
];
const LETTER: Record<string, Viseme | null> = {
	a: "aa", e: "E", i: "I", o: "O", u: "U", y: "I",
	b: "PP", m: "PP", p: "PP", f: "FF", v: "FF",
	d: "DD", t: "DD", l: "DD", n: "nn", k: "KK", g: "KK", q: "KK",
	s: "SS", z: "SS", r: "RR", w: "U", j: "CH", c: "KK", x: "KK", h: null,
};

/** Letters of one word as a viseme sequence; empty for a word with nothing to say (punctuation, tags). */
export function graphemesToVisemes(word: string): Phone[] {
	let w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
	// silent final e ("make", "table"), but not "the"/"be" or "-ee"
	if (w.length > 3 && w.endsWith("e") && !/[aeiouy]e$/.test(w)) w = w.slice(0, -1);
	const out: Phone[] = [];
	const push = (v: Viseme) => {
		const prev = out[out.length - 1];
		if (prev && prev.viseme === v && !VOWELS.has(v)) return; // "ll", "ss", "tt", "mm"
		out.push({ viseme: v, strength: STRENGTH[v], dur: VOWELS.has(v) ? 1 : v === "PP" ? 0.6 : 0.7 });
	};
	for (let i = 0; i < w.length; ) {
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
			// "gh" is silent after a vowel ("night", "though")
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

const MIN_WORD = 0.06;

/** Spread a word's phones across [s, e]; each phone becomes a bump wide enough to overlap its neighbours. */
export function scheduleWord(word: string, s: number, e: number): VisemeEvent[] {
	const phones = graphemesToVisemes(word);
	if (phones.length === 0) return [];
	const total = phones.reduce((a, p) => a + p.dur, 0);
	const span = Math.max(e - s, MIN_WORD);
	const events: VisemeEvent[] = [];
	let at = s;
	for (const p of phones) {
		const width = (span * p.dur) / total;
		events.push({ center: at + width / 2, half: Math.max(0.7 * width + 0.03, 0.05), viseme: p.viseme, strength: p.strength });
		at += width;
	}
	return events;
}

export interface TaggedWord extends CaptionWord {
	/** Inner text of the audio tag this token belongs to ("building excitement"), or undefined for a spoken word. */
	tag?: string;
}

/**
 * Splits spoken words from audio tags. A tag is a bracketed run of tokens: "[chuckles]" is one token,
 * "[clapperboard snap]" arrives as "[clapperboard" + "snap]"; an unterminated tag swallows the rest.
 */
export function markTags(words: readonly CaptionWord[]): TaggedWord[] {
	const out: TaggedWord[] = [];
	let open: TaggedWord[] | null = null;
	const close = () => {
		if (!open) return;
		const name = open.map((t) => t.w).join(" ").replace(/^\[|\]$/g, "").trim();
		for (const t of open) t.tag = name;
		open = null;
	};
	for (const word of words) {
		const t: TaggedWord = { ...word };
		out.push(t);
		if (!open && !word.w.startsWith("[")) continue;
		(open ??= []).push(t);
		if (word.w.endsWith("]")) close();
	}
	close();
	return out;
}

export class VisemeTrack {
	private events: VisemeEvent[] = [];
	private maxHalf = 0;
	readonly out = new Float32Array(VISEMES.length);

	clear(): void {
		this.events = [];
		this.maxHalf = 0;
	}

	get size(): number {
		return this.events.length;
	}

	/** Replace the schedule with the visemes of every spoken word (tags are skipped). */
	setWords(words: readonly CaptionWord[]): void {
		this.clear();
		for (const { w, s, e, tag } of markTags(words)) {
			if (tag !== undefined) continue;
			for (const ev of scheduleWord(w, s, e)) {
				this.events.push(ev);
				this.maxHalf = Math.max(this.maxHalf, ev.half);
			}
		}
		this.events.sort((a, b) => a.center - b.center);
	}

	/** Viseme weights at time t (order of VISEMES), normalised so the mouth never asks for more than one shape's worth. Returns the raw sum. */
	sample(t: number): number {
		const out = this.out;
		out.fill(0);
		const ev = this.events;
		let lo = 0;
		let hi = ev.length;
		const from = t - this.maxHalf;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (ev[mid].center < from) lo = mid + 1;
			else hi = mid;
		}
		let sum = 0;
		for (let i = lo; i < ev.length && ev[i].center <= t + this.maxHalf; i++) {
			const x = (t - ev[i].center) / ev[i].half;
			if (x <= -1 || x >= 1) continue;
			const k = ev[i].viseme;
			out[VISEME_INDEX[k]] += ev[i].strength * 0.5 * (1 + Math.cos(Math.PI * x));
		}
		for (let i = 0; i < out.length; i++) {
			out[i] = Math.min(1, out[i]);
			sum += out[i];
		}
		if (sum > 1) for (let i = 0; i < out.length; i++) out[i] /= sum;
		return sum;
	}
}

const VISEME_INDEX = Object.fromEntries(VISEMES.map((v, i) => [v, i])) as Record<Viseme, number>;
