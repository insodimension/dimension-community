// Bar heights for the waveform mark (0 = a resting dot, 1 = full height). Pure and deterministic in
// (time, level, phase), so the component only writes numbers to the DOM each frame.
import type { SurfacePhase } from "./surface-model";

export const BAR_COUNT = 7;

/** Louder in the middle, like a voice's spectrum seen edge-on. */
const PROFILE = [0.42, 0.7, 0.92, 1, 0.9, 0.66, 0.4] as const;

export function barHeights(t: number, level: number, phase: SurfacePhase, out: Float32Array): void {
	const live = Math.min(1, Math.max(0, level));
	for (let i = 0; i < BAR_COUNT; i++) {
		let h = 0;
		if (phase === "listening" || phase === "speaking") {
			// Each bar breathes at its own rate so the mark never moves in lockstep.
			const wobble = 0.62 + 0.38 * Math.sin(t * (5.1 + i * 1.7) + i * 2.3);
			h = live * PROFILE[i] * wobble;
		} else if (phase === "thinking") {
			// A slow wave travelling across the bars: something is happening, nobody is talking.
			h = 0.16 + 0.14 * Math.sin(t * 3.2 - i * 0.8);
		} else if (phase === "connecting" || phase === "checking") {
			h = 0.07 + 0.05 * Math.sin(t * 4 - i * 0.6);
		}
		out[i] = Math.min(1, Math.max(0, h));
	}
}
