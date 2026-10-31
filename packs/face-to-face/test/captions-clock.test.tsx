// The highlighted word is a function of the audio clock and nothing else: not of how many frames have been drawn,
// not of how long the reply has run. A long reply must end with the highlight on the word being heard, a stalled
// audio clock must hold it, and a clock that jumps must take it along.
import { afterEach, describe, expect, test } from "bun:test";
import { colorAt } from "../src/face/caption-model";
import { Captions } from "../src/face/captions";
import { mountPage, runFrame, unmountAll } from "./surface-dom";

afterEach(unmountAll);

const WORD_SECONDS = 0.55;
const REPLY = Array.from({ length: 40 }, (_, i) => ({ w: `w${i}`, s: i * WORD_SECONDS, e: i * WORD_SECONDS + 0.45 }));
const CURRENT = colorAt({ w: "w", s: 0, e: 1, tag: false, index: 0 }, 0, 0, false).replaceAll(" ", "");
const spokenAt = (seconds: number) => Math.min(REPLY.length - 1, Math.floor(seconds / WORD_SECONDS));

async function mountReply(clock: { at: number }) {
	const page = await mountPage(<Captions words={REPLY} getTime={() => clock.at} />);
	const settle = async (frames = 3) => {
		for (let i = 0; i < frames; i++) await runFrame();
	};
	const highlighted = () =>
		[...page.container.querySelectorAll("span")]
			.filter((span) => span.style.color.replaceAll(" ", "") === CURRENT)
			.map((span) => span.textContent?.trim());
	await settle();
	return { settle, highlighted };
}

describe("the captions follow the audio clock", () => {
	test("through a 22 s reply the highlight is on the word the clock is in, from the first line to the last", async () => {
		const clock = { at: 0 };
		const reply = await mountReply(clock);

		for (const seconds of [0, 0.3, 0.56, 3.2, 8.2, 12.34, 16.6, 19.9, 21.9]) {
			clock.at = seconds;
			await reply.settle();
			expect(reply.highlighted()).toEqual([`w${spokenAt(seconds)}`]);
		}
	});

	test("a stalled clock holds the highlight however many frames are drawn, and a clock that jumps takes it along", async () => {
		const clock = { at: 8.2 };
		const reply = await mountReply(clock);
		expect(reply.highlighted()).toEqual([`w${spokenAt(8.2)}`]);

		await reply.settle(120);
		expect(reply.highlighted()).toEqual([`w${spokenAt(8.2)}`]);

		clock.at = 19.9;
		await reply.settle();
		expect(reply.highlighted()).toEqual([`w${spokenAt(19.9)}`]);
	});
});
