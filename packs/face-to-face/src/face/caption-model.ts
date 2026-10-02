// Pure caption logic: which word is current, how words wrap into lines, which two lines show, and how each
// word is painted (current strong red, spoken words fading to rose, upcoming pale grey, audio tags grey).
import { type CaptionWord, markTags } from "./lipsync";

export interface CaptionToken {
	w: string;
	s: number;
	e: number;
	/** Part of an audio tag such as [chuckles]; never highlighted. */
	tag: boolean;
	index: number;
}

export function captionTokens(words: readonly CaptionWord[]): CaptionToken[] {
	return markTags(words).map((t, index) => ({ w: t.w, s: t.s, e: t.e, tag: t.tag !== undefined, index }));
}

/** Index of the word being spoken at time t: the last spoken (non-tag) word whose start has passed. Words may overlap neighbours by ~0.1 s, so start time alone decides. -1 before the first word. */
export function currentIndex(tokens: readonly CaptionToken[], t: number): number {
	let cur = -1;
	for (const tok of tokens) {
		if (tok.tag) continue;
		if (tok.s <= t) cur = tok.index;
		else break;
	}
	return cur;
}

/** Greedy wrap by character count; a single word longer than the line gets its own line. */
export function wrapLines(tokens: readonly CaptionToken[], maxChars: number): CaptionToken[][] {
	const lines: CaptionToken[][] = [];
	let line: CaptionToken[] = [];
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

/** The two lines on screen: the current line at the bottom with the previous one above; at the very start, line 0 with whatever follows. */
export function visibleLines(lines: readonly CaptionToken[][], current: number): [number, number] {
	if (lines.length === 0) return [-1, -1];
	let li = 0;
	if (current >= 0) li = Math.max(0, lines.findIndex((l) => l.some((t) => t.index === current)));
	return li === 0 ? [0, lines.length > 1 ? 1 : -1] : [li - 1, li];
}

/** Token index → the index of the line that holds it. The per-frame path reads this instead of searching the lines. */
export function lineIndexOf(lines: readonly CaptionToken[][], tokenCount: number): Int32Array {
	const out = new Int32Array(tokenCount).fill(-1);
	lines.forEach((line, li) => {
		for (const tok of line) out[tok.index] = li;
	});
	return out;
}

/** {@link visibleLines} for a frame loop: same answer from the precomputed `lineOf`, written into `out`, nothing allocated. */
export function visibleLinesInto(out: [number, number], lineOf: Int32Array, lineCount: number, current: number): void {
	if (lineCount === 0) {
		out[0] = -1;
		out[1] = -1;
		return;
	}
	const li = current >= 0 ? Math.max(0, lineOf[current] ?? -1) : 0;
	out[0] = li === 0 ? 0 : li - 1;
	out[1] = li === 0 ? (lineCount > 1 ? 1 : -1) : li;
}

export type PaintKind = "current" | "spoken" | "upcoming" | "tag";

export interface Paint {
	kind: PaintKind;
	/** For spoken words: 0 just spoken .. 1 fully faded to rose. */
	fade: number;
}

const FADE_SECONDS = 1.6;

export function paintFor(tok: CaptionToken, t: number, current: number): Paint {
	if (tok.tag) return { kind: "tag", fade: 0 };
	if (tok.index === current) return { kind: "current", fade: 0 };
	if (tok.index < current) return { kind: "spoken", fade: Math.min(1, Math.max(0, (t - tok.e) / FADE_SECONDS)) };
	return { kind: "upcoming", fade: 0 };
}

/** [r, g, b] per paint kind, light and dark. `recent` (a word just spoken) fades to `rose`. */
const PALETTE = {
	light: { current: [224, 32, 60], recent: [196, 48, 70], rose: [212, 150, 152], upcoming: [190, 186, 186], tag: [132, 130, 130] },
	dark: { current: [255, 104, 120], recent: [240, 128, 138], rose: [214, 150, 156], upcoming: [112, 108, 106], tag: [150, 146, 144] },
} as const;

const rgb = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** The colours that never change with time, built once: a frame loop paints most words with one of these. */
const SETTLED = {
	light: { current: rgb(PALETTE.light.current), rose: rgb(PALETTE.light.rose), upcoming: rgb(PALETTE.light.upcoming), tag: rgb(PALETTE.light.tag) },
	dark: { current: rgb(PALETTE.dark.current), rose: rgb(PALETTE.dark.rose), upcoming: rgb(PALETTE.dark.upcoming), tag: rgb(PALETTE.dark.tag) },
} as const;

export function paintColor(p: Paint, dark: boolean): string {
	const pal = dark ? PALETTE.dark : PALETTE.light;
	let c: readonly number[];
	if (p.kind === "spoken") {
		const k = p.fade;
		c = pal.recent.map((v, i) => Math.round(v + (pal.rose[i] - v) * k));
	} else c = pal[p.kind];
	return rgb(c);
}

/**
 * `paintColor(paintFor(tok, t, current), dark)` without the intermediate objects: the answer the caption loop asks
 * for every visible word on every frame. Only a word still fading from "just spoken" builds a string; every
 * other word is one of the constants above. (Equality with the two-step form is held by a test.)
 */
export function colorAt(tok: CaptionToken, t: number, current: number, dark: boolean): string {
	const set = dark ? SETTLED.dark : SETTLED.light;
	if (tok.tag) return set.tag;
	if (tok.index === current) return set.current;
	if (tok.index > current) return set.upcoming;
	const k = Math.min(1, Math.max(0, (t - tok.e) / FADE_SECONDS));
	if (k >= 1) return set.rose;
	const pal = dark ? PALETTE.dark : PALETTE.light;
	const { recent, rose } = pal;
	return `rgb(${Math.round(recent[0] + (rose[0] - recent[0]) * k)},${Math.round(recent[1] + (rose[1] - recent[1]) * k)},${Math.round(recent[2] + (rose[2] - recent[2]) * k)})`;
}
