import { describe, expect, test } from "bun:test";
import { captionTokens, colorAt, currentIndex, lineIndexOf, paintColor, paintFor, visibleLines, visibleLinesInto, wrapLines } from "../src/face/caption-model";

const words = [
	{ w: "[warmly]", s: 0, e: 0.2 },
	{ w: "Morning.", s: 0.24, e: 0.96 },
	{ w: "You", s: 1.2, e: 1.28 },
	{ w: "shipped", s: 1.36, e: 1.68 },
	{ w: "three", s: 1.84, e: 2.0 },
	{ w: "things", s: 2.08, e: 2.32 },
];

describe("currentIndex", () => {
	const tk = captionTokens(words);

	test("before the first spoken word nothing is current; tags are never current", () => {
		expect(currentIndex(tk, 0.1)).toBe(-1);
		expect(tk[currentIndex(tk, 0.5)].w).toBe("Morning.");
	});

	test("the last word whose start has passed wins, even while its neighbour's end still overlaps", () => {
		const overlap = captionTokens([{ w: "a", s: 0, e: 0.5 }, { w: "b", s: 0.4, e: 0.9 }]);
		expect(overlap[currentIndex(overlap, 0.45)].w).toBe("b");
		expect(overlap[currentIndex(overlap, 0.39)].w).toBe("a");
	});

	test("stays on the final word after the audio ends", () => {
		expect(tk[currentIndex(tk, 99)].w).toBe("things");
	});
});

describe("wrapLines + visibleLines", () => {
	const many = captionTokens(Array.from({ length: 30 }, (_, i) => ({ w: `word${i}`, s: i * 0.3, e: i * 0.3 + 0.25 })));

	test("no line exceeds the width (except a single oversized word) and order is preserved", () => {
		const lines = wrapLines(many, 40);
		for (const l of lines) expect(l.map((t) => t.w).join(" ").length).toBeLessThanOrEqual(40);
		expect(lines.flat().map((t) => t.index)).toEqual(many.map((t) => t.index));
		const long = wrapLines(captionTokens([{ w: "supercalifragilistic", s: 0, e: 1 }, { w: "x", s: 1, e: 2 }]), 8);
		expect(long.map((l) => l.length)).toEqual([1, 1]);
	});

	test("the current line sits at the bottom with the previous one above; line 0 shows what follows", () => {
		const lines = wrapLines(many, 40);
		expect(lines.length).toBeGreaterThan(3);
		expect(visibleLines(lines, -1)).toEqual([0, 1]);
		expect(visibleLines(lines, lines[0][0].index)).toEqual([0, 1]);
		expect(visibleLines(lines, lines[2][1].index)).toEqual([1, 2]);
		expect(visibleLines([], 0)).toEqual([-1, -1]);
		expect(visibleLines(lines.slice(0, 1), 0)).toEqual([0, -1]);
	});
});

describe("paint", () => {
	const tk = captionTokens(words);
	const cur = currentIndex(tk, 1.4);

	test("current strong, spoken fading to rose, upcoming pale, tags grey", () => {
		const t = 1.4;
		expect(paintFor(tk[cur], t, cur).kind).toBe("current");
		expect(paintFor(tk[cur - 1], t, cur).kind).toBe("spoken");
		expect(paintFor(tk[cur + 1], t, cur).kind).toBe("upcoming");
		expect(paintFor(tk[0], t, cur).kind).toBe("tag");
	});

	test("a spoken word fades from red toward rose over time and never past it", () => {
		const morning = tk[1];
		const fresh = paintFor(morning, 1.0, cur);
		const old = paintFor(morning, 60, cur);
		expect(fresh.fade).toBeLessThan(0.1);
		expect(old.fade).toBe(1);
		expect(paintColor(fresh, false)).not.toBe(paintColor(old, false));
	});
});

// The per-frame forms are what actually paint the captions; the two-step forms above are their specification.
describe("the per-frame forms agree with the specification", () => {
	const many = captionTokens(Array.from({ length: 40 }, (_, i) => ({ w: i % 9 === 0 ? `[tag${i}]` : `word${i}`, s: i * 0.3, e: i * 0.3 + 0.25 })));
	const lines = wrapLines(many, 40);
	const lineOf = lineIndexOf(lines, many.length);

	test("visibleLinesInto picks the same two lines as visibleLines for every current word, before the first and with no lines", () => {
		const out: [number, number] = [9, 9];
		for (const current of [-1, ...many.map((t) => t.index)]) {
			visibleLinesInto(out, lineOf, lines.length, current);
			expect(out).toEqual(visibleLines(lines, current));
		}
		visibleLinesInto(out, new Int32Array(0), 0, 0);
		expect(out).toEqual([-1, -1]);
	});

	test("colorAt is paintColor(paintFor(...)) in light and dark, across every kind and the whole fade", () => {
		for (const dark of [false, true]) {
			for (const t of [0, 1.4, 3.1, 6, 12, 200]) {
				const cur = currentIndex(many, t);
				for (const tok of many) expect(colorAt(tok, t, cur, dark)).toBe(paintColor(paintFor(tok, t, cur), dark));
			}
		}
	});
});
