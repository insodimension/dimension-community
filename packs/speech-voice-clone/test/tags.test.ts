import { describe, expect, test } from "bun:test";
import type { TagStyle } from "../src/registry.js";
import { BRACKET_GUIDE, BREEZE_GUIDE, captionText, estimateWords, guideFor, voiceText } from "../src/tags.js";

const STYLES: readonly TagStyle[] = ["none", "brackets", "breeze"];

const CORPUS = [
	"Hello world.",
	"Well [laughs] that went [whisper] badly, didn't it?",
	"[sighs] Fine. [clears throat] Moving on.",
	"Stop 🎉 right there 👍🏽 please.",
	"Wait (laugh) what (sigh) no.",
	"He said \"go.\" Then he left\u2026 quietly\u2014very quietly.",
	"   spaced\n\nout\ttext   ",
	"[excited] [quiet, amused] Both tags lead.",
	"Footnote [1] and [x=1] stay as written.",
	"[pause]",
	"",
];

describe("voiceText: style none", () => {
	test.each([true, false])("strips [tags] whether or not tags are allowed (allowed=%p)", allowed => {
		expect(voiceText("Hello [whisper] world", "none", allowed)).toBe("Hello world");
		expect(voiceText("[sad] Hello world [pause]", "none", allowed)).toBe("Hello world");
		expect(voiceText("[quiet, amused] Hello", "none", allowed)).toBe("Hello");
	});

	test("a tag-only segment becomes empty", () => {
		expect(voiceText("[whisper]", "none", true)).toBe("");
		expect(voiceText("  [whisper]  [sad]  ", "none", true)).toBe("");
	});
});

describe("voiceText: style brackets", () => {
	test("keeps tags for the model when tags are allowed, with whitespace tidied", () => {
		expect(voiceText("[whisper]   Hello\n there", "brackets", true)).toBe("[whisper] Hello there");
		expect(voiceText("Well [laughing] okay [quiet, amused] then.", "brackets", true)).toBe("Well [laughing] okay [quiet, amused] then.");
	});

	test("strips them when tags are not allowed", () => {
		expect(voiceText("[whisper] Hello [sad] there", "brackets", false)).toBe("Hello there");
	});
});

describe("voiceText: style breeze", () => {
	test.each([
		["[laughs]", "(laugh)"],
		["[laugh]", "(laugh)"],
		["[laughing]", "(laugh)"],
		["[chuckles]", "(laugh)"],
		["[sigh]", "(sigh)"],
		["[sighs]", "(sigh)"],
		["[cough]", "(cough)"],
		["[coughs]", "(cough)"],
		["[clears throat]", "(clears throat)"],
		["[Laughs]", "(laugh)"],
		["[SIGHS]", "(sigh)"],
	])("maps %s to %s", (tag, event) => {
		expect(voiceText(`Well ${tag} okay.`, "breeze", true)).toBe(`Well ${event} okay.`);
	});

	test("drops every bracket the voice cannot perform, never speaking it", () => {
		expect(voiceText("Well [whisper] okay [pause] fine [excited] then.", "breeze", true)).toBe("Well okay fine then.");
	});

	test("mixes performed and dropped tags in one segment", () => {
		expect(voiceText("Well [laughs] okay [whisper] fine [coughs] now.", "breeze", true)).toBe("Well (laugh) okay fine (cough) now.");
	});

	test("a performed sound at the start or end of a segment keeps its place", () => {
		expect(voiceText("[sighs] Okay.", "breeze", true)).toBe("(sigh) Okay.");
		expect(voiceText("Okay. [laughs]", "breeze", true)).toBe("Okay. (laugh)");
	});

	test("an event already in parentheses passes through when tags are allowed", () => {
		expect(voiceText("Ha (laugh) ok", "breeze", true)).toBe("Ha (laugh) ok");
	});

	test("with tags not allowed, brackets and spoken-style events are all removed", () => {
		expect(voiceText("Ha [laughs] ok (laugh) then (sigh) (clears throat) fine", "breeze", false)).toBe("Ha ok then fine");
	});
});

describe("voiceText: all styles", () => {
	test.each(STYLES)("removes emoji, including skin-tone modifiers and joined sequences (%s)", style => {
		expect(voiceText("Great \ud83c\udf89 job \ud83d\udc4d\ud83c\udffd ok \ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 fine \u2764\ufe0f", style, true)).toBe("Great job ok fine");
	});

	test.each(STYLES)("brackets that are not short letter-led tags stay in the text (%s)", style => {
		expect(voiceText("Footnote [1] and [x=1] and [note: see below]", style, true)).toBe("Footnote [1] and [x=1] and [note: see below]");
	});

	test.each(STYLES)("a bracket longer than 32 characters is prose, not a tag (%s)", style => {
		const long = `[${"a".repeat(33)}]`;
		expect(voiceText(`Hi ${long} there`, style, true)).toBe(`Hi ${long} there`);
		const longest = `[${"a".repeat(32)}]`;
		expect(voiceText(`Hi ${longest} there`, "none", true)).toBe("Hi there");
	});

	test.each(STYLES)("collapses all whitespace to single spaces and trims (%s)", style => {
		expect(voiceText("  a\n\n b\t\tc  ", style, true)).toBe("a b c");
	});

	test.each(STYLES)("empty and emoji-only text become empty (%s)", style => {
		expect(voiceText("", style, true)).toBe("");
		expect(voiceText("\ud83c\udf89\ud83c\udf89", style, true)).toBe("");
	});
});

describe("captionText", () => {
	test("removes audio tags and spoken-style events, then tidies whitespace", () => {
		expect(captionText("Well [laughs] okay (sigh) then [clears throat]  fine")).toBe("Well okay then fine");
		expect(captionText("  [whisper]   Hello\n there  ")).toBe("Hello there");
	});

	test("tag-only text has no caption", () => {
		expect(captionText("[whisper]")).toBe("");
		expect(captionText("[excited] [quiet, amused] (laugh)")).toBe("");
	});

	test("leaves ordinary prose and non-tag brackets alone", () => {
		expect(captionText("Plain prose, with [1] a footnote.")).toBe("Plain prose, with [1] a footnote.");
		expect(captionText("It is (not) a sound.")).toBe("It is (not) a sound.");
	});

	test("removes emoji", () => {
		expect(captionText("Done \ud83c\udf89")).toBe("Done");
	});
});

describe("what the model speaks versus what the captions show", () => {
	test.each(STYLES.flatMap(style => [true, false].map(allowed => ({ style, allowed }))))("captions of the spoken text equal captions of the original ($style, tags allowed: $allowed)", ({ style, allowed }) => {
		for (const text of CORPUS) {
			expect(captionText(voiceText(text, style, allowed))).toBe(captionText(text));
		}
	});

	test.each(STYLES)("when tags are not allowed the spoken text is exactly the caption text (%s)", style => {
		for (const text of CORPUS) {
			expect(voiceText(text, style, false)).toBe(captionText(text));
		}
	});
});

describe("estimateWords", () => {
	test("tag-only, emoji-only and empty text have no caption words", () => {
		expect(estimateWords("[whisper]", 0, 2)).toEqual([]);
		expect(estimateWords("\ud83c\udf89", 0, 2)).toEqual([]);
		expect(estimateWords("   ", 0, 2)).toEqual([]);
		expect(estimateWords("", 0, 2)).toEqual([]);
	});

	test("words are the caption's tokens, never a tag", () => {
		const words = estimateWords("Well [laughs] okay (sigh) then.", 0, 3);
		expect(words.map(word => word.w)).toEqual(["Well", "okay", "then."]);
	});

	test.each([
		{ text: "Hello world.", start: 0, duration: 1.7 },
		{ text: "One, two; three: four\u2014five. Six! Seven? Eight\u2026", start: 4.25, duration: 9.1234 },
		{ text: "A single", start: 12, duration: 0.5 },
		{ text: "x", start: 0, duration: 3 },
		{ text: "He said \"go.\" (then) left.", start: 1, duration: 2.5 },
	])("tiles the segment: contiguous, ordered, starting and ending with the audio ($text)", ({ text, start, duration }) => {
		const words = estimateWords(text, start, duration);
		expect(words.length).toBeGreaterThan(0);
		expect(words[0]?.s).toBeCloseTo(start, 3);
		expect(words.at(-1)?.e).toBeCloseTo(start + duration, 3);
		words.forEach((word, index) => {
			expect(word.e).toBeGreaterThanOrEqual(word.s);
			const previous = words[index - 1];
			if (previous) expect(word.s).toBe(previous.e);
		});
	});

	test("times are whole milliseconds", () => {
		for (const word of estimateWords("The quick brown fox jumps over the lazy dog.", 0.123456, 3.3333333)) {
			expect(Math.round(word.s * 1000)).toBeCloseTo(word.s * 1000, 6);
			expect(Math.round(word.e * 1000)).toBeCloseTo(word.e * 1000, 6);
		}
	});

	test("time is proportional to word length", () => {
		expect(estimateWords("aa bbbbbbbb", 0, 1)).toEqual([
			{ w: "aa", s: 0, e: 0.2 },
			{ w: "bbbbbbbb", s: 0.2, e: 1 },
		]);
	});

	test("a sentence end buys extra time, a comma a little", () => {
		expect(estimateWords("Hi. Hi", 0, 9)).toEqual([
			{ w: "Hi.", s: 0, e: 7 },
			{ w: "Hi", s: 7, e: 9 },
		]);
		expect(estimateWords("Hi, Hi", 0, 7)).toEqual([
			{ w: "Hi,", s: 0, e: 5 },
			{ w: "Hi", s: 5, e: 7 },
		]);
	});

	test.each([
		["Stop!", 4],
		["Why?", 4],
		["Well\u2026", 4],
		["Well;", 2],
		["Well:", 2],
		["Well\u2014", 2],
		["Well\u2013", 2],
	])("%s adds %i to its weight", (token, extra) => {
		const plain = "Well".length;
		const marked = estimateWords(`${token} Well`, 0, 100);
		const expectedFirst = ((token.length + extra) / (token.length + extra + plain)) * 100;
		expect(marked[0]?.e).toBeCloseTo(expectedFirst, 2);
	});

	test("a closing quote or bracket after the stop still counts as the end of the sentence", () => {
		const words = estimateWords("He said \"go.\" now", 0, 100);
		const total = "He".length + "said".length + "\"go.\"".length + 4 + "now".length;
		expect(words[2]?.e).toBeCloseTo(((total - "now".length) / total) * 100, 2);
	});

	test("a zero-length clip puts every word at the same instant instead of producing NaN", () => {
		const words = estimateWords("one two three", 5, 0);
		expect(words.map(word => [word.s, word.e])).toEqual([
			[5, 5],
			[5, 5],
			[5, 5],
		]);
	});

	test("shifting the start shifts every word by the same amount", () => {
		const base = estimateWords("Alpha beta, gamma delta.", 0, 4);
		const shifted = estimateWords("Alpha beta, gamma delta.", 10, 4);
		shifted.forEach((word, index) => {
			expect(word.w).toBe(base[index]?.w ?? "");
			expect(word.s).toBeCloseTo((base[index]?.s ?? 0) + 10, 3);
			expect(word.e).toBeCloseTo((base[index]?.e ?? 0) + 10, 3);
		});
	});
});

describe("a tag directly before punctuation", () => {
	test.each(["Fine [excited].", "Fine [excited]!", "Fine [excited], then", "Fine [excited]\u2026"])("leaves no stray space where the tag was: %s", text => {
		expect(captionText(text)).not.toMatch(/\s[.,!?\u2026]/);
		expect(voiceText(text, "none", true)).not.toMatch(/\s[.,!?\u2026]/);
	});

	test("captions do not turn the punctuation into a word of its own", () => {
		expect(estimateWords("Fine [excited].", 0, 1).map(word => word.w)).toEqual(["Fine."]);
	});
});

describe("guides", () => {
	test("only styles that perform tags have a guide", () => {
		expect(guideFor("none")).toBeUndefined();
		expect(guideFor("brackets")).toBe(BRACKET_GUIDE);
		expect(guideFor("breeze")).toBe(BREEZE_GUIDE);
	});

	test("every sound the Breeze guide offers is one the voice performs, not one that gets dropped", () => {
		const offered = [...BREEZE_GUIDE.matchAll(/\[([a-z ]+)\]/g)].map(match => match[1] ?? "");
		expect(offered.sort()).toEqual(["clears throat", "coughs", "laughs", "sighs"]);
		for (const tag of offered) {
			expect(voiceText(`[${tag}]`, "breeze", true)).toMatch(/^\((laugh|sigh|cough|clears throat)\)$/);
		}
	});

	test("every direction the bracket guide offers is kept for the model and never captioned", () => {
		const offered = [...BRACKET_GUIDE.matchAll(/\[([^\]]+)\]/g)].map(match => match[0]);
		expect(offered.length).toBeGreaterThanOrEqual(10);
		for (const tag of offered) {
			expect(voiceText(`${tag} Hello.`, "brackets", true)).toBe(`${tag} Hello.`);
			expect(captionText(`${tag} Hello.`)).toBe("Hello.");
		}
	});
});
