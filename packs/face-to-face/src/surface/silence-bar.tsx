import { memo, useEffect, useRef } from "react";

export interface SilenceBarProps {
	/** The send countdown, 0..1, read once per animation frame; never re-renders the component. */
	getSilence: () => number;
}

/** The thin line under the user's words that fills as the quiet runs out and empties when they speak again: "sending on
 * silence", the same countdown the composer's mic pill draws as a ring. It reaches full at the instant the words are sent.
 * Memoised; a frame writes the transform only when its thousandth moved (it holds still between words). */
export const SilenceBar = memo(function SilenceBar({ getSilence }: SilenceBarProps) {
	const fill = useRef<HTMLSpanElement>(null);
	const read = useRef(getSilence);
	read.current = getSilence;

	useEffect(() => {
		let raf = 0;
		let written = -1;
		const tick = () => {
			raf = requestAnimationFrame(tick);
			const thousandths = Math.round(Math.min(1, Math.max(0, read.current())) * 1000);
			if (thousandths === written) return;
			written = thousandths;
			const el = fill.current;
			if (el) el.style.transform = `scaleX(${thousandths / 1000})`;
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, []);

	return (
		<span className="f2f-silence" aria-hidden="true">
			<span ref={fill} className="f2f-silence-fill" />
		</span>
	);
});
