import { useEffect, useRef } from "react";
import { createOrb } from "./orb";
import type { Intent } from "./surface-model";
import { STYLES } from "./styles";

const SIZE = 56;
const FRAME_MS = 33;

export interface FaceDoorProps {
	activeSurface: string;
	onIntent: (intent: Intent) => void;
}

/** The pinned widget that opens the face: a small living orb. Gone while the face is up. */
export function FaceDoor({ activeSurface, onIntent }: FaceDoorProps) {
	return activeSurface === "face" ? null : <DoorOrb onOpen={() => onIntent({ t: "mount", surface: "face" })} />;
}

function DoorOrb({ onOpen }: { onOpen: () => void }) {
	const canvas = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const cv = canvas.current;
		if (!cv) return;
		const orb = createOrb(cv, SIZE, Math.min(2, window.devicePixelRatio || 1));
		if (!orb) return;
		const still = window.matchMedia("(prefers-reduced-motion: reduce)");
		const origin = performance.now();
		let visible = true;
		let raf = 0;
		let last = 0;
		const frame = (now: number) => {
			raf = requestAnimationFrame(frame);
			if (now - last < FRAME_MS) return;
			last = now;
			orb.draw((now - origin) / 1000);
		};
		// One rule for "should this be running": on screen, tab visible, motion allowed. Anything else stops the loop.
		const sync = () => {
			const run = visible && !document.hidden && !still.matches;
			if (run && !raf) raf = requestAnimationFrame(frame);
			else if (!run && raf) {
				cancelAnimationFrame(raf);
				raf = 0;
			}
			if (still.matches) orb.draw(2);
		};
		const io = new IntersectionObserver((entries) => {
			visible = entries[entries.length - 1].isIntersecting;
			sync();
		});
		io.observe(cv);
		document.addEventListener("visibilitychange", sync);
		still.addEventListener("change", sync);
		sync();
		return () => {
			io.disconnect();
			document.removeEventListener("visibilitychange", sync);
			still.removeEventListener("change", sync);
			cancelAnimationFrame(raf);
		};
	}, []);

	return (
		<>
			<style>{STYLES}</style>
			<button type="button" className="f2f-door" aria-label="Talk face to face" onClick={onOpen}>
				<canvas ref={canvas} style={{ width: SIZE, height: SIZE }} />
				<span className="f2f-door-label" aria-hidden="true">
					Face to face
				</span>
			</button>
		</>
	);
}
