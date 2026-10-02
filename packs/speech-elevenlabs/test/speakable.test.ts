import { describe, expect, test } from "bun:test";
import { SpeakableText } from "../src/speakable.js";

/** Feed segments in order and collect what each call returns. */
function feed(tags: boolean, segments: string[]): (string | null)[] {
	const speakable = new SpeakableText(tags);
	return segments.map(segment => speakable.next(segment));
}

describe("SpeakableText with tags on", () => {
	test("bare directions are held and lead the next segment that has something to say", () => {
		expect(feed(true, ["[sighs]", "[whispers]", "All right, let's begin.", "Next."])).toEqual([
			null,
			null,
			"[sighs] [whispers] All right, let's begin.",
			"Next.",
		]);
	});

	test("a segment with words goes out trimmed and as written", () => {
		expect(feed(true, ["  [warmly] Hello there.  "])).toEqual(["[warmly] Hello there."]);
	});

	test("an empty segment between a direction and its text does not lose the direction", () => {
		expect(feed(true, ["[sighs]", "", "   ", "Go."])).toEqual([null, null, null, "[sighs] Go."]);
	});

	test("only the directions are held: an emoji beside them does not ride onto the next segment", () => {
		expect(feed(true, ["[sighs] 🙂", "Go."])).toEqual([null, "[sighs] Go."]);
		expect(feed(true, ["🙂", "Go."])).toEqual([null, "Go."]);
		expect(feed(true, ["[sighs]", "🙂", "Go."])).toEqual([null, null, "[sighs] Go."]);
	});

	test.each([
		{ name: "tags and emoji only", segment: "[laughs] 🙂" },
		{ name: "emoji only", segment: "🙂" },
		{ name: "emoji with modifier and joiner", segment: "👍🏽 👨‍👩‍👧" },
		{ name: "blank", segment: "   " },
	])("nothing speakable is never sent on its own: $name", ({ segment }) => {
		expect(feed(true, [segment])).toEqual([null]);
	});
});

describe("SpeakableText with tags off", () => {
	test("tags are stripped from what is sent", () => {
		expect(feed(false, ["[warmly] Hello [laughs] there."])).toEqual(["Hello there."]);
	});

	test("a bare tag is dropped, not held for the next segment", () => {
		expect(feed(false, ["[sighs]", "[whispers]", "All right.", "Next."])).toEqual([null, null, "All right.", "Next."]);
	});

	test("an emoji-only segment is dropped, and the next segment is not prefixed with it", () => {
		expect(feed(false, ["🙂", "Hello."])).toEqual([null, "Hello."]);
	});
});

describe("what counts as something to say", () => {
	// The service accepts these; only text that is empty after removing tags and emoji is refused.
	test.each([
		{ name: "ellipsis", segment: "..." },
		{ name: "dash", segment: "—" },
		{ name: "digits", segment: "1 2 3" },
		{ name: "words with a trailing emoji", segment: "Hi there. 🙂" },
	])("$name is sent, in either mode", ({ segment }) => {
		expect(feed(true, [segment])).toEqual([segment]);
		expect(feed(false, [segment])).toEqual([segment]);
	});

	test("emoji and tags mixed with words are kept when words exist", () => {
		expect(feed(true, ["[laughs] 🙂 Hello"])).toEqual(["[laughs] 🙂 Hello"]);
		expect(feed(false, ["[laughs] 🙂 Hello"])).toEqual(["🙂 Hello"]);
	});
});
