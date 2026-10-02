import { describe, expect, test } from "bun:test";
import { graphemesToVisemes, markTags, scheduleWord, VISEME_RIG, VISEMES, type Viseme, VisemeTrack } from "../src/face/lipsync";
import { arkitIndex, MOUTH_MASK } from "../src/face/shapes";

const seq = (w: string) => graphemesToVisemes(w).map((p) => p.viseme);
const idx = (v: Viseme) => VISEMES.indexOf(v);

describe("graphemesToVisemes", () => {
	test("bilabials close the lips, digraphs stay one sound", () => {
		expect(seq("baby")).toEqual(["PP", "aa", "PP", "I"]);
		expect(seq("phone")).toEqual(["FF", "O", "nn"]);
		expect(seq("she")).toEqual(["CH", "E"]);
		expect(seq("through")).toEqual(["TH", "RR", "O"]);
	});

	test("silent final e and doubled consonants do not add mouth shapes", () => {
		expect(seq("make")).toEqual(["PP", "aa", "KK"]);
		expect(seq("hello")).toEqual(["E", "DD", "O"]);
		expect(seq("night")).toEqual(["nn", "I", "DD"]);
	});

	test("nothing to say for punctuation and tags", () => {
		expect(seq("...")).toEqual([]);
		expect(seq("[chuckles]").length).toBeGreaterThan(0); // letters inside brackets are still letters; tags are filtered upstream by markTags
	});
});

describe("VISEME_RIG", () => {
	test("every viseme is a blend of mouth-group shapes only, so the fallback can never double-drive eyes or brows", () => {
		for (const v of VISEMES) {
			const shapes = Object.keys(VISEME_RIG[v]);
			expect(shapes.length).toBeGreaterThan(0);
			for (const name of shapes) expect(MOUTH_MASK[arkitIndex(name as never)]).toBe(1);
		}
	});

	test("bilabials press the lips instead of opening the jaw; the open vowel opens through the lower lip more than the jaw", () => {
		const pp = VISEME_RIG.PP;
		expect(pp.mouthClose).toBeGreaterThan(0.5);
		expect(pp.mouthPressLeft).toBeGreaterThan(0.5);
		expect(pp.jawOpen ?? 0).toBe(0);
		const aa = VISEME_RIG.aa;
		expect(aa.jawOpen).toBeGreaterThan(0.2);
		expect(aa.mouthLowerDownLeft ?? 0).toBeGreaterThan(aa.jawOpen ?? 0);
	});
});

describe("markTags", () => {
	test("single and split tags are separated from spoken words", () => {
		const out = markTags([
			{ w: "[warmly]", s: 0, e: 0.2 },
			{ w: "Morning.", s: 0.24, e: 0.9 },
			{ w: "[clapperboard", s: 1, e: 1.1 },
			{ w: "snap]", s: 1.1, e: 1.2 },
			{ w: "Go", s: 1.3, e: 1.4 },
		]);
		expect(out.map((t) => t.tag)).toEqual(["warmly", undefined, "clapperboard snap", "clapperboard snap", undefined]);
	});

	test("an unterminated tag swallows the rest instead of being spoken", () => {
		const out = markTags([{ w: "[building", s: 0, e: 0.3 }, { w: "excitement", s: 0.3, e: 0.6 }]);
		expect(out.every((t) => t.tag === "building excitement")).toBe(true);
	});
});

describe("scheduleWord + VisemeTrack", () => {
	test("events stay inside the word window, in order, and a bilabial reaches full closure", () => {
		const ev = scheduleWord("mama", 1, 1.4);
		expect(ev.length).toBe(4);
		for (let i = 0; i < ev.length; i++) {
			expect(ev[i].center).toBeGreaterThan(1);
			expect(ev[i].center).toBeLessThan(1.4);
			if (i) expect(ev[i].center).toBeGreaterThan(ev[i - 1].center);
		}
		const track = new VisemeTrack();
		track.setWords([{ w: "mama", s: 1, e: 1.4 }]);
		track.sample(ev[0].center);
		expect(track.out[idx("PP")]).toBeGreaterThan(0.95);
		track.sample(ev[1].center);
		expect(track.out[idx("aa")]).toBeGreaterThan(0.9);
	});

	test("silence between words closes the mouth completely", () => {
		const track = new VisemeTrack();
		track.setWords([{ w: "hi", s: 0, e: 0.3 }, { w: "there", s: 2, e: 2.4 }]);
		track.sample(1);
		expect(Array.from(track.out).every((v) => v === 0)).toBe(true);
	});

	test("overlapping neighbours (providers overlap words by ~0.1 s) never ask for more than one shape's worth", () => {
		const track = new VisemeTrack();
		const words = Array.from({ length: 12 }, (_, i) => ({ w: "aeiou", s: i * 0.1, e: i * 0.1 + 0.25 }));
		track.setWords(words);
		for (let t = 0; t < 1.4; t += 0.01) {
			track.sample(t);
			const sum = Array.from(track.out).reduce((a, b) => a + b, 0);
			expect(sum).toBeLessThanOrEqual(1 + 1e-6);
		}
	});

	test("tags are never lip-synced", () => {
		const track = new VisemeTrack();
		track.setWords([{ w: "[warmly]", s: 0, e: 0.4 }, { w: "hi", s: 0.5, e: 0.8 }]);
		for (let t = 0; t < 0.4; t += 0.02) {
			track.sample(t);
			expect(Array.from(track.out).every((v) => v === 0)).toBe(true);
		}
	});

	test("words arriving late in batches give the same schedule as all at once", () => {
		const words = [{ w: "one", s: 0.1, e: 0.4 }, { w: "two", s: 0.5, e: 0.8 }, { w: "three", s: 0.9, e: 1.3 }];
		const a = new VisemeTrack();
		a.setWords(words);
		const b = new VisemeTrack();
		b.setWords(words.slice(0, 1));
		b.setWords(words);
		for (const t of [0.2, 0.6, 1.1]) {
			a.sample(t);
			b.sample(t);
			expect(Array.from(b.out)).toEqual(Array.from(a.out));
		}
	});
});
