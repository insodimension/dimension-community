import { type CSSProperties, memo, type Ref, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { type AnimatorInput, FaceAnimator, type PoseSource } from "./animator";
import { Captions } from "./captions";
import type { HeadAsset } from "./head-asset";
import type { CaptionWord } from "./lipsync";
import { createFaceRenderer, type FaceQuality, type FaceRenderer } from "./renderer";

export const CREAM = "#F4F2EE";

/**
 * The shortest gap between drawn frames. A 120/144/240 Hz display calls the loop that often; the face is a 60 fps
 * animation (dt-driven, so it looks the same), and drawing it every refresh would just spend the GPU and the main
 * thread. 15 ms, not 16.7, so a 60 Hz display's jittery frames (16.6 +/- 1 ms) are never skipped; a 120 Hz display
 * draws every second refresh, a 144 Hz one every third.
 */
const MIN_FRAME_MS = 15;
/** Warm near-black: the app's dark background (#0b0b0d) with a breath of warmth, so the surface sits in the host. */
export const INK_BG = "#0E0D0C";

export interface FaceViewHandle {
	/** Advance the animation by dt seconds and draw one frame (the rAF loop calls this too; useful for frame-stepped capture). */
	advance(dt: number): void;
	readonly canvas: HTMLCanvasElement | null;
}

export interface FaceViewProps {
	head: HeadAsset;
	animator: FaceAnimator;
	/** Read once per frame. */
	getInput: () => AnimatorInput;
	words: readonly CaptionWord[];
	/** Seconds on the words' timeline for captions. */
	getCaptionTime: () => number;
	dark: boolean;
	/** false = no rAF loop; the owner drives `advance` (deterministic capture). */
	autoRun?: boolean;
	/** Where the mouth comes from: the audio-to-face model or the procedural lip-sync (default). */
	poseSource?: PoseSource;
	/** 'low' draws a coarser dot grid from a coarser G-buffer at a lower canvas resolution, for weak GPUs. */
	quality?: FaceQuality;
	showCaptions?: boolean;
	/** Called after every rAF frame with the CPU milliseconds spent stepping + drawing. */
	onFrameCost?: (ms: number) => void;
	handle?: Ref<FaceViewHandle>;
	style?: CSSProperties;
}

/** Perceived host background darkness: walks up to the first painted background and uses its luminance; `fallback` when nothing on the way up is painted. */
export function detectDark(el: Element | null, fallback = false): boolean {
	for (let n: Element | null = el; n; n = n.parentElement) {
		const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(getComputedStyle(n).backgroundColor);
		if (!m || (m[4] !== undefined && Number(m[4]) < 0.5)) continue;
		return (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255 < 0.45;
	}
	return fallback;
}

export const FaceView = memo(function FaceView({ head, animator, getInput, words, getCaptionTime, dark, autoRun = true, showCaptions = true, poseSource, quality = "high", onFrameCost, handle, style }: FaceViewProps) {
	const host = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const renderer = useRef<FaceRenderer | null>(null);
	const clock = useRef(0);
	const live = useRef({ animator, getInput, onFrameCost });
	live.current = { animator, getInput, onFrameCost };

	useEffect(() => {
		const cv = canvas.current;
		const box = host.current;
		if (!cv || !box) return;
		const r = createFaceRenderer(cv, head, { dark, quality });
		renderer.current = r;
		const fit = () => r.resize(box.clientWidth, box.clientHeight, window.devicePixelRatio || 1);
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(box);
		return () => {
			ro.disconnect();
			r.dispose();
			renderer.current = null;
		};
	}, [head]);

	useEffect(() => {
		renderer.current?.setDark(dark);
	}, [dark]);

	useEffect(() => {
		renderer.current?.setQuality(quality);
	}, [quality]);

	useEffect(() => {
		animator.setPoseSource(poseSource ?? "procedural");
	}, [animator, poseSource]);

	const advance = useMemo(
		() => (dt: number) => {
			const { animator: a, getInput: gi } = live.current;
			clock.current += dt;
			renderer.current?.draw(a.step(dt, gi()), clock.current);
		},
		[],
	);
	useImperativeHandle(handle, () => ({ advance, get canvas() { return canvas.current; } }), [advance]);

	useEffect(() => {
		if (!autoRun) return;
		let raf = 0;
		/** When the last frame was DRAWN (or, while the face is out of sight, the last frame offered: so dt stays small on return). */
		let last = performance.now();
		let visible = true;
		const io = new IntersectionObserver((e) => {
			visible = e[e.length - 1].isIntersecting;
		});
		if (host.current) io.observe(host.current);
		const tick = (now: number) => {
			raf = requestAnimationFrame(tick);
			if (!visible || document.hidden) {
				last = now;
				return;
			}
			if (now - last < MIN_FRAME_MS) return;
			const dt = (now - last) / 1000;
			last = now;
			const t0 = performance.now();
			advance(dt);
			live.current.onFrameCost?.(performance.now() - t0);
		};
		raf = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(raf);
			io.disconnect();
		};
	}, [autoRun, advance]);

	return (
		<div ref={host} style={{ position: "relative", width: "100%", height: "100%", background: dark ? INK_BG : CREAM, overflow: "hidden", ...style }}>
			<canvas ref={canvas} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} />
			{showCaptions && (
				<Captions
					words={words}
					getTime={getCaptionTime}
					dark={dark}
					style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", bottom: "8.5%", width: "min(92%, 60em)" }}
				/>
			)}
		</div>
	);
});
