import { describe, expect, test } from "bun:test";
import { ARKIT_52, arkitIndex, arkitIndexOf, isMouthShape, MOUTH_MASK, POSE_SIZE, RIG_GAIN, RIG_MAX } from "../src/face/shapes";

describe("pose vector layout", () => {
	test("52 ARKit names, alphabetical, no duplicates: the order the engine's model frames and the kit's faceAt() use", () => {
		expect(POSE_SIZE).toBe(52);
		expect(new Set(ARKIT_52).size).toBe(52);
		expect([...ARKIT_52].sort()).toEqual([...ARKIT_52]);
		// spot-check both ends and the shapes the mouth chain hangs on: a reorder here would drive the wrong morphs
		expect(ARKIT_52[0]).toBe("browDownLeft");
		expect(ARKIT_52[24]).toBe("jawOpen");
		expect(ARKIT_52[33]).toBe("mouthLowerDownLeft");
		expect(ARKIT_52[51]).toBe("tongueOut");
	});

	test("an unknown name throws for code, and is undefined for data", () => {
		expect(() => arkitIndex("jawOpn" as never)).toThrow();
		expect(arkitIndexOf("jawOpn")).toBeUndefined();
		expect(arkitIndexOf("jawOpen")).toBe(24);
	});
});

describe("the mouth group the model owns", () => {
	test("jaw, mouth, cheek, nose and tongue are the model's; blink, gaze, brows stay procedural", () => {
		for (const n of ARKIT_52) {
			const owned = /^(jaw|mouth|cheek|nose)/.test(n) || n === "tongueOut";
			expect(isMouthShape(n)).toBe(owned);
			expect(MOUTH_MASK[arkitIndex(n)]).toBe(owned ? 1 : 0);
		}
		expect(MOUTH_MASK[arkitIndex("eyeBlinkLeft")]).toBe(0);
		expect(MOUTH_MASK[arkitIndex("browInnerUp")]).toBe(0);
	});

	test("the rig table only trims: gains and caps are finite and positive", () => {
		for (let i = 0; i < POSE_SIZE; i++) {
			expect(RIG_GAIN[i]).toBeGreaterThan(0);
			expect(RIG_MAX[i]).toBeGreaterThan(0);
			expect(Number.isFinite(RIG_GAIN[i] * RIG_MAX[i])).toBe(true);
		}
	});
});
