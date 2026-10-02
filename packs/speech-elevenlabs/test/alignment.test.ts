import { describe, expect, test } from "bun:test";
import type { CaptionWord } from "@dimension/sdk/provider";
import { DialogueTimeline, stripAudioTags, WordAssembler } from "../src/alignment.js";

/** A dialogue alignment fragment: `stepMs` per character, times restarting at 0 like the real socket. */
function fragment(text: string, stepMs = 40) {
	const chars = [...text];
	return {
		chars,
		startsMs: chars.map((_, i) => i * stepMs),
		durationsMs: chars.map(() => stepMs),
	};
}

/** Character timings in absolute seconds, for feeding a `WordAssembler` directly. */
function spoken(text: string, from = 0, step = 0.04) {
	const chars = [...text];
	return {
		chars,
		starts: chars.map((_, i) => from + i * step),
		ends: chars.map((_, i) => from + (i + 1) * step),
	};
}

/** Seconds of PCM16 mono audio at 24 kHz as a byte count. */
function bytesFor(seconds: number): number {
	return Math.round(seconds * 24_000) * 2;
}

function assemble(text: string): CaptionWord[] {
	const assembler = new WordAssembler();
	const f = spoken(text);
	return [...assembler.push(f.chars, f.starts, f.ends), ...assembler.flush()];
}

describe("DialogueTimeline", () => {
	test.each([
		{
			name: "a leading tag, and a word split from its punctuation across fragments",
			fragments: ["[warmly] ", "Morning", ". You've", " got two meetings", " before ", "noon. "],
			words: ["Morning.", "You've", "got", "two", "meetings", "before", "noon."],
		},
		{
			name: "a tag split inside its name",
			fragments: ["[warm", "ly] Hi ", "there"],
			words: ["Hi", "there"],
		},
		{
			name: "a multi-word tag with a comma split after the comma",
			fragments: ["[lower,", " thoughtful] Keep it ", "covered."],
			words: ["Keep", "it", "covered."],
		},
		{
			name: "a tag whose closing bracket opens the next fragment",
			fragments: ["Hello [warmly", "] there"],
			words: ["Hello", "there"],
		},
	])("tags never become caption words: $name", ({ fragments, words }) => {
		const timeline = new DialogueTimeline();
		const out: CaptionWord[] = [];
		for (const text of fragments) {
			timeline.audio(bytesFor(0.3), 24_000);
			out.push(...timeline.alignment(fragment(text)));
		}
		out.push(...timeline.flush());
		expect(out.map(word => word.w)).toEqual([...words]);
	});

	test("a fragment starts where the audio before it ended, so words stay locked to the samples", () => {
		const timeline = new DialogueTimeline();
		// 0.5 s of audio arrives with a fragment that only spans 0.12 s of its own timeline…
		timeline.audio(bytesFor(0.5), 24_000);
		const first = timeline.alignment(fragment("One ", 40));
		// …then more audio; the next fragment must begin at 0.5 s, not at 0.12 s.
		timeline.audio(bytesFor(0.7), 24_000);
		const second = timeline.alignment(fragment("two ", 40));
		expect(first[0]?.s).toBe(0);
		expect(second[0]?.s).toBeCloseTo(0.5, 3);
		expect(second[0]?.e).toBeGreaterThan(second[0]!.s);
	});

	test("flush starts the next unit after all audio delivered so far, including audio no fragment covered", () => {
		const timeline = new DialogueTimeline();
		timeline.audio(bytesFor(0.5), 24_000);
		// No trailing space: the word stays open until the unit is flushed.
		expect(timeline.alignment(fragment("One"))).toEqual([]);
		// Audio-only message after the unit's last alignment fragment (a pause, a breath).
		timeline.audio(bytesFor(0.4), 24_000);
		const closed = timeline.flush();
		expect(closed.map(word => word.w)).toEqual(["One"]);
		expect(closed[0]?.s).toBe(0);

		timeline.audio(bytesFor(0.3), 24_000);
		const next = timeline.alignment(fragment("Two "));
		// Anchored at 0.9 s (0.5 + 0.4). Without the flush re-anchor it would sit at 0.5 s.
		expect(next[0]?.w).toBe("Two");
		expect(next[0]?.s).toBeCloseTo(0.9, 3);
	});

	test("words stay in start order and keep their own end when an alignment runs past its audio", () => {
		const timeline = new DialogueTimeline();
		// "world" is timed 0.30-0.55 s, but only 0.5 s of audio came with this fragment.
		const first = {
			chars: [..."hello world "],
			startsMs: [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550],
			durationsMs: Array.from({ length: 12 }, () => 50),
		};
		timeline.audio(bytesFor(0.5), 24_000);
		const words = timeline.alignment(first);
		timeline.audio(bytesFor(0.6), 24_000);
		words.push(...timeline.alignment(fragment("again ")), ...timeline.flush());

		expect(words.map(word => word.w)).toEqual(["hello", "world", "again"]);
		for (const word of words) expect(word.e).toBeGreaterThanOrEqual(word.s);
		for (let i = 1; i < words.length; i += 1) expect(words[i]!.s).toBeGreaterThanOrEqual(words[i - 1]!.s);
		// The overlap is tolerated, not clamped away: "world" still ends at 0.55 while "again" starts at 0.5.
		expect(words[1]!.e).toBeCloseTo(0.55, 3);
		expect(words[2]!.s).toBeCloseTo(0.5, 3);
		expect(words[2]!.s).toBeLessThan(words[1]!.e);
	});

	test("an alignment with fewer durations than characters still yields finite, ordered words", () => {
		const timeline = new DialogueTimeline();
		timeline.audio(bytesFor(0.5), 24_000);
		const f = fragment("ab cd ");
		const words = timeline.alignment({ chars: f.chars, startsMs: f.startsMs, durationsMs: [] });
		expect(words.map(word => word.w)).toEqual(["ab", "cd"]);
		for (const word of words) {
			expect(Number.isFinite(word.s)).toBe(true);
			expect(word.e).toBeGreaterThanOrEqual(word.s);
		}
	});
});

describe("WordAssembler", () => {
	// `stripAudioTags` (text bound for a voice that cannot perform tags) and the assembler (captions
	// for a voice that can) must agree on what a tag is, or captions and speech drift apart.
	test.each([
		{ name: "leading tag", text: "[warmly] Hello there", words: ["Hello", "there"] },
		{ name: "tag between words", text: "Hello [laughs] there", words: ["Hello", "there"] },
		{ name: "multi-word tag with a comma", text: "[lower, thoughtful] Keep it covered.", words: ["Keep", "it", "covered."] },
		{ name: "trailing tag", text: "Bye now [sighs]", words: ["Bye", "now"] },
		{ name: "adjacent tags", text: "[whispers][laughs] hi", words: ["hi"] },
		{ name: "index in brackets is text", text: "array[0] and [ok", words: ["array[0]", "and", "[ok"] },
		{ name: "empty brackets are text", text: "[] empty", words: ["[]", "empty"] },
		{ name: "digits disqualify a tag", text: "a [b1] c", words: ["a", "[b1]", "c"] },
		{ name: "punctuation disqualifies a tag", text: "see [note: this] here", words: ["see", "[note:", "this]", "here"] },
		{ name: "longest tag (32-letter body)", text: `[${"a".repeat(32)}] x`, words: ["x"] },
		{ name: "one letter too long is text", text: `[${"a".repeat(33)}] x`, words: [`[${"a".repeat(33)}]`, "x"] },
	])("assembler and stripAudioTags agree: $name", ({ text, words }) => {
		expect(assemble(text).map(word => word.w)).toEqual([...words]);
		expect(stripAudioTags(text).split(" ").filter(Boolean)).toEqual([...words]);
	});

	test("flush emits the word still open at the end of the unit, and only once", () => {
		const assembler = new WordAssembler();
		const f = spoken("end", 2);
		expect(assembler.push(f.chars, f.starts, f.ends)).toEqual([]);
		const flushed = assembler.flush();
		expect(flushed).toHaveLength(1);
		expect(flushed[0]).toEqual({ w: "end", s: 2, e: 2.12 });
		expect(assembler.flush()).toEqual([]);
	});

	test("a bracket that proves to be text after a fragment boundary keeps the original character timing", () => {
		const assembler = new WordAssembler();
		const one = spoken("[note", 1);
		const two = spoken(" that: hi ", 1.2);
		const words = assembler.push(one.chars, one.starts, one.ends);
		// Still undecided: it could yet be a tag.
		expect(words).toEqual([]);
		words.push(...assembler.push(two.chars, two.starts, two.ends), ...assembler.flush());

		expect(words.map(word => word.w)).toEqual(["[note", "that:", "hi"]);
		expect(words[0]!.s).toBeCloseTo(1, 3);
		expect(words[0]!.e).toBeCloseTo(1.2, 3);
		expect(words[1]!.s).toBeCloseTo(1.24, 3);
		expect(words[1]!.e).toBeCloseTo(1.44, 3);
	});

	test("a character timed to end before it starts cannot produce a word that ends before it starts", () => {
		const assembler = new WordAssembler();
		const words = [...assembler.push(["a", " "], [2, 2.1], [1, 2.2]), ...assembler.flush()];
		expect(words).toEqual([{ w: "a", s: 2, e: 2 }]);
	});
});

describe("stripAudioTags", () => {
	test.each([
		{ text: "[warmly] Hello [laughs] there", expected: "Hello there" },
		{ text: "see array[0] here", expected: "see array[0] here" },
		{ text: "[warmly]", expected: "" },
		{ text: "Hello [laughs]  there", expected: "Hello there" },
	])("$text", ({ text, expected }) => {
		expect(stripAudioTags(text)).toBe(expected);
	});
});
