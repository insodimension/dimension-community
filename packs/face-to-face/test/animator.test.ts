import { describe, expect, test } from "bun:test";
import { type AnimatorInput, blinkCurve, FaceAnimator, type Spring, springStep } from "../src/face/animator";
import { type ArkitName, arkitIndex, POSE_SIZE } from "../src/face/shapes";

const W = (a: FaceAnimator, n: ArkitName) => a.frame.weights[arkitIndex(n)];
/** How open the mouth reads: the larger of the jaw and the mean lower-lip drop (the model opens through the lip far more than the jaw). */
const openness = (a: FaceAnimator) => Math.max(W(a, "jawOpen"), (W(a, "mouthLowerDownLeft") + W(a, "mouthLowerDownRight")) / 2);
const pose = (over: Partial<Record<ArkitName, number>>) => {
	const v = new Float32Array(POSE_SIZE);
	for (const [k, x] of Object.entries(over)) v[arkitIndex(k as ArkitName)] = x;
	return v;
};
const DT = 1 / 60;
const quiet = (state: AnimatorInput["state"]): AnimatorInput => ({ state, playhead: null, audioRms: 0, micRms: 0 });

function run(a: FaceAnimator, seconds: number, input: (t: number) => AnimatorInput) {
	for (let i = 0; i < Math.round(seconds / DT); i++) a.step(DT, input(i * DT));
}

describe("springStep", () => {
	test("critically damped: reaches the target without overshoot", () => {
		const sp: Spring = [0, 0];
		let prev = 0;
		for (let i = 0; i < 240; i++) {
			springStep(sp, 1, 12, DT);
			expect(sp[0]).toBeLessThanOrEqual(1);
			expect(sp[0]).toBeGreaterThanOrEqual(prev);
			prev = sp[0];
		}
		expect(sp[0]).toBeGreaterThan(0.999);
	});

	test("frame-rate independent: two half steps equal one whole step", () => {
		const a: Spring = [0.3, -0.8];
		const b: Spring = [0.3, -0.8];
		springStep(a, 0.9, 20, 0.032);
		springStep(b, 0.9, 20, 0.016);
		springStep(b, 0.9, 20, 0.016);
		expect(b[0]).toBeCloseTo(a[0], 9);
		expect(b[1]).toBeCloseTo(a[1], 9);
	});
});

describe("blinkCurve", () => {
	test("closes fast, holds shut a beat, opens slower, and is open outside the window", () => {
		expect(blinkCurve(-0.1)).toBe(0);
		expect(blinkCurve(0.3)).toBe(0);
		expect(blinkCurve(0.085)).toBe(1);
		expect(blinkCurve(0.035)).toBeGreaterThan(0.6); // half way through the close is already mostly shut
		expect(blinkCurve(0.17)).toBeGreaterThan(0.3); // and the open is still under way
	});
});

describe("FaceAnimator", () => {
	test("same seed and inputs give identical motion; reset() replays it", () => {
		const inp = (t: number): AnimatorInput => ({ state: t < 1 ? "listening" : "thinking", playhead: null, audioRms: 0, micRms: t > 0.5 ? 0.1 : 0 });
		const a = new FaceAnimator(3);
		const b = new FaceAnimator(3);
		run(a, 4, inp);
		run(b, 4, inp);
		expect(Array.from(a.frame.weights)).toEqual(Array.from(b.frame.weights));
		expect(a.frame.yaw).toBe(b.frame.yaw);
		a.reset(3);
		run(a, 4, inp);
		expect(Array.from(a.frame.weights)).toEqual(Array.from(b.frame.weights));
	});

	test("blinks every 2-6 s and the eyes always reopen", () => {
		const a = new FaceAnimator(5);
		let blinks = 0;
		let wasShut = false;
		let shutFrames = 0;
		let maxShut = 0;
		for (let i = 0; i < 60 * 60; i++) {
			a.step(DT, quiet("idle"));
			const shut = W(a, "eyeBlinkLeft") > 0.7;
			if (shut && !wasShut) blinks++;
			shutFrames = shut ? shutFrames + 1 : 0;
			maxShut = Math.max(maxShut, shutFrames);
			wasShut = shut;
		}
		expect(blinks).toBeGreaterThanOrEqual(12);
		expect(blinks).toBeLessThanOrEqual(35);
		expect(maxShut).toBeLessThan(15); // never stuck closed
		expect(W(a, "eyeBlinkLeft")).toBeCloseTo(W(a, "eyeBlinkRight"), 6);
	});

	test("lip closure: a bilabial keeps the lips shut while the voice is loud, an open vowel opens the mouth", () => {
		const words = [
			{ w: "mmm", s: 1, e: 1.5 },
			{ w: "aaa", s: 2, e: 2.5 },
		];
		const a = new FaceAnimator(1);
		a.setWords(words);
		const speak = (t: number): AnimatorInput => ({ state: "speaking", playhead: t, audioRms: 0.12, micRms: 0 });
		let closed = 1;
		let press = 0;
		let open = 0;
		for (let i = 0; i < 3 * 60; i++) {
			const t = i * DT;
			a.step(DT, speak(t));
			if (Math.abs(t - 1.25) < DT / 2) {
				closed = openness(a);
				press = W(a, "mouthPressLeft");
			}
			if (Math.abs(t - 2.25) < DT / 2) open = openness(a);
		}
		expect(closed).toBeLessThan(0.1);
		expect(press).toBeGreaterThan(0.4);
		expect(open).toBeGreaterThan(0.3);
	});

	test("the mouth follows the voice without waiting for word timings (no lag behind the audio)", () => {
		const a = new FaceAnimator(1);
		run(a, 0.5, (t) => ({ state: "speaking", playhead: t, audioRms: 0, micRms: 0 }));
		let opened = -1;
		for (let i = 0; i < 12; i++) {
			a.step(DT, { state: "speaking", playhead: 0.5 + i * DT, audioRms: 0.15, micRms: 0 });
			if (opened < 0 && openness(a) > 0.1) opened = i;
		}
		expect(opened).toBeGreaterThanOrEqual(0);
		expect(opened).toBeLessThan(6); // within ~100 ms
	});

	test("loud continuous speech stays a natural mouth: jaw p95 <= 0.35 and never past 0.5, opening p95 <= 0.5", () => {
		const words = Array.from({ length: 40 }, (_, i) => ({ w: ["amazing", "problem", "over", "happy", "wonderful", "you"][i % 6], s: i * 0.3, e: i * 0.3 + 0.32 }));
		const a = new FaceAnimator(4);
		a.setWords(words);
		const jaw: number[] = [];
		const open: number[] = [];
		for (let i = 0; i < 12 * 60; i++) {
			// 0.3 is well above the loudest speech (peak 20 ms RMS of the sample clip is 0.37 only in isolated syllables)
			a.step(DT, { state: "speaking", playhead: i * DT, audioRms: 0.3, micRms: 0 });
			jaw.push(W(a, "jawOpen"));
			open.push(openness(a));
		}
		const p95 = (x: number[]) => [...x].sort((p, q) => p - q)[Math.floor((x.length - 1) * 0.95)];
		expect(p95(jaw)).toBeLessThanOrEqual(0.35);
		expect(Math.max(...jaw)).toBeLessThanOrEqual(0.5);
		expect(p95(open)).toBeLessThanOrEqual(0.5);
	});

	test("the mouth closes after speech stops", () => {
		const a = new FaceAnimator(1);
		a.setWords([{ w: "hello", s: 0, e: 0.5 }]);
		run(a, 0.6, (t) => ({ state: "speaking", playhead: t, audioRms: 0.12, micRms: 0 }));
		run(a, 0.8, () => quiet("idle"));
		expect(W(a, "jawOpen")).toBeLessThan(0.02);
		expect(a.frame.mouthOpen).toBeLessThan(0.05);
	});

	test("[chuckles] lifts the smile while its window is active and lets go afterwards", () => {
		const a = new FaceAnimator(1);
		a.setWords([{ w: "[chuckles]", s: 1, e: 1.6 }, { w: "ok", s: 2, e: 2.2 }]);
		let smileDuring = 0;
		let smileAfter = 1;
		for (let i = 0; i < 12 * 60; i++) {
			const t = i * DT;
			a.step(DT, { state: "speaking", playhead: t, audioRms: 0, micRms: 0 });
			if (Math.abs(t - 1.6) < DT / 2) smileDuring = W(a, "mouthSmileLeft");
			if (Math.abs(t - 11.5) < DT / 2) smileAfter = W(a, "mouthSmileLeft");
		}
		expect(smileDuring).toBeGreaterThan(0.4);
		expect(smileAfter).toBeLessThan(0.2);
	});

	test("states: thinking loosens the edge dots and turns the head off-axis; listening nods on mic energy", () => {
		const t = new FaceAnimator(2);
		run(t, 6, () => quiet("thinking"));
		expect(t.frame.loosen).toBeGreaterThan(0.85);
		expect(Math.abs(t.frame.yaw)).toBeGreaterThan(0.05);

		const l = new FaceAnimator(2);
		run(l, 2, () => quiet("listening"));
		let minPitch = 0;
		let maxPitch = 0;
		for (let i = 0; i < 90; i++) {
			l.step(DT, { state: "listening", playhead: null, audioRms: 0, micRms: 0.15 });
			minPitch = Math.min(minPitch, l.frame.pitch);
			maxPitch = Math.max(maxPitch, l.frame.pitch);
		}
		expect(maxPitch - minPitch).toBeGreaterThan(0.03);
		expect(l.frame.loosen).toBeLessThan(0.1);
	});

	test("speaking drifts the head through a three-quarter range and stays bounded", () => {
		const a = new FaceAnimator(9);
		a.setWords([]);
		let lo = 0;
		let hi = 0;
		for (let i = 0; i < 20 * 60; i++) {
			a.step(DT, { state: "speaking", playhead: i * DT, audioRms: 0.1, micRms: 0 });
			lo = Math.min(lo, a.frame.yaw);
			hi = Math.max(hi, a.frame.yaw);
			expect(Math.abs(a.frame.yaw)).toBeLessThanOrEqual(0.55);
		}
		expect(hi - lo).toBeGreaterThan(0.4);
	});

	test("a stalled tab (huge dt) and NaN-free weights", () => {
		const a = new FaceAnimator(1);
		a.setWords([{ w: "hello", s: 0, e: 0.4 }]);
		a.step(5, { state: "speaking", playhead: 0.1, audioRms: 0.2, micRms: 0 });
		a.step(0, { state: "idle", playhead: null, audioRms: Number.NaN, micRms: 0 });
		for (const w of a.frame.weights) expect(Number.isFinite(w)).toBe(true);
		expect(Number.isFinite(a.frame.yaw)).toBe(true);
	});

	test("formation gathers toward the face and can be held mid-way", () => {
		const a = new FaceAnimator(1);
		a.setFormation(0);
		a.setFormationTarget(1);
		run(a, 1.2, () => quiet("idle"));
		expect(a.frame.formation).toBeGreaterThan(0.4);
		expect(a.frame.formation).toBeLessThan(0.6);
		a.setFormationTarget(a.frame.formation);
		const held = a.frame.formation;
		run(a, 1, () => quiet("idle"));
		expect(a.frame.formation).toBeCloseTo(held, 6);
		a.setFormationTarget(1);
		run(a, 3, () => quiet("idle"));
		expect(a.frame.formation).toBe(1);
	});
});

describe("pose source (the audio model's 52 ARKit weights)", () => {
	const speaking = (t: number): AnimatorInput => ({ state: "speaking", playhead: t, audioRms: 0, micRms: 0 });
	const wide = pose({ jawOpen: 0.3, mouthLowerDownLeft: 0.5, mouthLowerDownRight: 0.5 });

	test("its mouth group drives the mouth; its eyes and brows are never taken", () => {
		const a = new FaceAnimator(1);
		a.setPoseSource({ arkit: () => pose({ jawOpen: 0.3, mouthLowerDownLeft: 0.5, mouthLowerDownRight: 0.5, eyeBlinkLeft: 1, eyeBlinkRight: 1, browInnerUp: 1 }) });
		let blink = 0;
		let brow = 0;
		const n = 5 * 60;
		for (let i = 0; i < n; i++) {
			a.step(DT, speaking(i * DT));
			blink += W(a, "eyeBlinkLeft");
			brow += W(a, "browInnerUp");
		}
		expect(W(a, "mouthLowerDownLeft")).toBeGreaterThan(0.4);
		expect(W(a, "jawOpen")).toBeGreaterThan(0.25);
		expect(blink / n).toBeLessThan(0.15); // only the procedural blinks, not a held 1.0
		expect(brow / n).toBeLessThan(0.3);
	});

	test("a model that is barely moving reads as closed, pressed lips", () => {
		const a = new FaceAnimator(1);
		a.setPoseSource({ arkit: () => pose({ jawOpen: 0.05, mouthLowerDownLeft: 0.12, mouthLowerDownRight: 0.12, mouthUpperUpLeft: 0.08, mouthUpperUpRight: 0.08 }) });
		run(a, 1, speaking);
		expect(openness(a)).toBeLessThan(0.05);
		expect(W(a, "mouthClose")).toBeGreaterThan(0.15);
	});

	test("losing the model cross-fades to the procedural mouth over ~100 ms instead of snapping", () => {
		let frame: Float32Array | null = wide;
		const a = new FaceAnimator(1);
		a.setPoseSource({ arkit: () => frame });
		run(a, 1, speaking);
		const before = openness(a);
		expect(before).toBeGreaterThan(0.4);
		frame = null;
		a.step(DT, quiet("idle"));
		expect(openness(a)).toBeGreaterThan(before * 0.7); // one frame later the mouth has not jumped shut
		let prev = openness(a);
		let biggest = 0;
		for (let i = 0; i < 90; i++) {
			a.step(DT, quiet("idle"));
			biggest = Math.max(biggest, Math.abs(openness(a) - prev));
			prev = openness(a);
		}
		expect(biggest).toBeLessThan(0.08);
		expect(openness(a)).toBeLessThan(0.05); // and it does end up closed
	});

	test("a malformed vector (wrong length, NaN) is treated as no frame, never drawn", () => {
		const nan = wide.slice();
		nan[arkitIndex("jawOpen")] = Number.NaN;
		for (const bad of [new Float32Array(10).fill(1), nan]) {
			const a = new FaceAnimator(1);
			a.setPoseSource({ arkit: () => bad });
			run(a, 1, () => quiet("idle"));
			for (const w of a.frame.weights) expect(Number.isFinite(w)).toBe(true);
			expect(openness(a)).toBeLessThan(0.05);
		}
	});

	test("[chuckles] still lifts the smile on top of a model pose that has none", () => {
		const a = new FaceAnimator(1);
		a.setWords([{ w: "[chuckles]", s: 0.2, e: 0.8 }, { w: "ok", s: 1.5, e: 1.7 }]);
		a.setPoseSource({ arkit: () => wide });
		let smile = 0;
		for (let i = 0; i < 90; i++) {
			a.step(DT, speaking(i * DT));
			if (Math.abs(i * DT - 0.9) < DT / 2) smile = W(a, "mouthSmileLeft");
		}
		expect(smile).toBeGreaterThan(0.4);
	});

	test("audible silence closes the mouth even when the model's frame keeps it a little open", () => {
		const a = new FaceAnimator(1);
		a.setPoseSource({ arkit: () => pose({ jawOpen: 0.1, mouthLowerDownLeft: 0.22, mouthLowerDownRight: 0.22 }) });
		run(a, 1, (t) => ({ state: "speaking", playhead: t, audioRms: t < 0.5 ? 0.1 : 0, micRms: 0 }));
		expect(openness(a)).toBeLessThan(0.12);
	});
});
