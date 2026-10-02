import { describe, expect, test } from "bun:test";
import { expressionEvents, exprEnvelope, exprForTag } from "../src/face/expressions";

describe("tag -> expression", () => {
	test("chuckles is a smile with cheek and eye squint, not a neutral face", () => {
		const e = exprForTag("chuckles");
		expect(e.shapes.mouthSmileLeft).toBeGreaterThan(0.5);
		expect(e.shapes.cheekSquintLeft).toBeGreaterThan(0.3);
		expect(e.shapes.eyeSquintLeft).toBeGreaterThan(0.2);
		expect(e.pulseHz).toBeGreaterThan(0);
	});

	test("whispers shrinks the mouth, excited widens it", () => {
		expect(exprForTag("Whispers").mouthScale).toBeLessThan(0.6);
		expect(exprForTag("excited").mouthScale).toBeGreaterThan(1.1);
	});

	test("multi-word and unknown tags: keyword match wins, otherwise no expression", () => {
		expect(exprForTag("building excitement").shapes.browOuterUpLeft).toBeGreaterThan(0);
		expect(Object.keys(exprForTag("clapperboard snap").shapes)).toEqual([]);
	});
});

describe("expression events and envelope", () => {
	const words = [
		{ w: "[warmly]", s: 0, e: 0.2 },
		{ w: "hello", s: 0.3, e: 0.7 },
		{ w: "[chuckles]", s: 5, e: 5.6 },
		{ w: "ok", s: 6, e: 6.2 },
	];

	test("one event per tag; a tag holds until the next tag starts, capped", () => {
		const ev = expressionEvents(words);
		expect(ev.map((e) => e.t0)).toEqual([0, 5]);
		expect(ev[0].hold).toBeLessThanOrEqual(3.5);
		expect(ev[1].hold).toBeGreaterThan(1);
	});

	test("envelope: silent before, full while held, gone after the release", () => {
		const [warm] = expressionEvents(words);
		expect(exprEnvelope(warm, -0.1)).toBe(0);
		expect(exprEnvelope(warm, 0.5)).toBe(1);
		expect(exprEnvelope(warm, warm.t0 + 0.18 + warm.hold + 0.71)).toBe(0);
		const mid = exprEnvelope(warm, 0.09);
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(1);
	});

	test("a multi-token tag is one event", () => {
		const ev = expressionEvents([{ w: "[clapperboard", s: 1, e: 1.2 }, { w: "snap]", s: 1.2, e: 1.4 }]);
		expect(ev.length).toBe(1);
	});
});
