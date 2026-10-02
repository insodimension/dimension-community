import { memo, useEffect, useRef } from "react";
import type { SurfacePhase } from "./surface-model";
import { BAR_COUNT, barHeights } from "./waveform-model";

const REST_PX = 5;
const FULL_PX = 34;

export interface WaveformProps {
	/** 0..1, read once per animation frame; never re-renders the component. */
	getLevel: () => number;
	phase: SurfacePhase;
}

/**
 * The rounded gradient-bar mark: a row of dots at rest that grows with the voice being heard or spoken. Memoised
 * (it re-renders only when the phase changes), and a frame writes a bar's height only when its tenth of a pixel moved:
 * a resting mark costs nothing, a live one costs a few style writes and no string building for the bars that held still.
 */
export const Waveform = memo(function Waveform({ getLevel, phase }: WaveformProps) {
	const bars = useRef<(HTMLSpanElement | null)[]>([]);
	const live = useRef({ getLevel, phase });
	live.current = { getLevel, phase };

	useEffect(() => {
		const heights = new Float32Array(BAR_COUNT);
		/** The tenth-pixel height each bar last had written (-1: never). */
		const written = new Int32Array(BAR_COUNT).fill(-1);
		let level = 0;
		let last = performance.now();
		let raf = 0;
		const tick = (now: number) => {
			raf = requestAnimationFrame(tick);
			if (document.hidden) return;
			const dt = Math.min(0.1, (now - last) / 1000);
			last = now;
			const { getLevel: read, phase: ph } = live.current;
			const target = ph === "listening" || ph === "speaking" ? Math.min(1, read()) : 0;
			// fast attack, slow release: the bars jump with a syllable and settle between them
			level += (target - level) * (1 - Math.exp(-dt / (target > level ? 0.03 : 0.16)));
			barHeights(now / 1000, level, ph, heights);
			for (let i = 0; i < BAR_COUNT; i++) {
				const tenths = Math.round((REST_PX + heights[i] * (FULL_PX - REST_PX)) * 10);
				if (tenths === written[i]) continue;
				written[i] = tenths;
				const el = bars.current[i];
				if (el) el.style.height = `${tenths / 10}px`;
			}
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, []);

	return (
		<div className="f2f-wave" aria-hidden="true">
			{Array.from({ length: BAR_COUNT }, (_, i) => (
				<span key={i} className="f2f-bar" ref={(el) => void (bars.current[i] = el)} style={{ height: REST_PX }} />
			))}
		</div>
	);
});
