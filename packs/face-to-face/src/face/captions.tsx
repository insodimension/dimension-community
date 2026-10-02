import { type CSSProperties, memo, useEffect, useMemo, useRef, useState } from "react";
import { type CaptionToken, captionTokens, colorAt, currentIndex, lineIndexOf, visibleLinesInto, wrapLines } from "./caption-model";
import type { CaptionWord } from "./lipsync";

export interface CaptionsProps {
	words: readonly CaptionWord[];
	/** Seconds on the words' timeline; read every animation frame. */
	getTime: () => number;
	dark?: boolean;
	maxChars?: number;
	style?: CSSProperties;
}

/**
 * Two centred lines under the face, coloured per word by the audio clock. Per frame it touches only the DOM of the
 * (at most two) lines on screen, and only the properties whose value moved: no React re-render, no allocation for a
 * settled word. Memoised: it re-renders for new words or a theme flip, never because its parent did.
 */
export const Captions = memo(function Captions({ words, getTime, dark = false, maxChars = 52, style }: CaptionsProps) {
	const tokens = useMemo(() => captionTokens(words), [words]);
	const lines = useMemo(() => wrapLines(tokens, maxChars), [tokens, maxChars]);
	const lineOf = useMemo(() => lineIndexOf(lines, tokens.length), [lines, tokens.length]);
	const [shown, setShown] = useState<[number, number]>([-1, -1]);
	const spans = useRef<Map<number, HTMLSpanElement>>(new Map());
	const lineEls = useRef<Map<number, HTMLDivElement>>(new Map());
	const appeared = useRef<Map<number, number>>(new Map());
	const live = useRef({ tokens, lines, lineOf, dark, shown, getTime });
	live.current = { tokens, lines, lineOf, dark, shown, getTime };
	const hasWords = tokens.length > 0;

	// Runs only while there are words to follow; with none, nothing is scheduled at all.
	useEffect(() => {
		if (!hasWords) return;
		let raf = 0;
		const want: [number, number] = [-1, -1];
		/** What each element last had written, so an unchanged frame writes nothing (a style write is never free, even when the value is the same). */
		const lineK = new WeakMap<HTMLElement, number>();
		const painted = new WeakMap<HTMLElement, string>();
		const tick = () => {
			raf = requestAnimationFrame(tick);
			const { tokens: tk, lines: ls, lineOf: lo, dark: dk, shown: sh, getTime: gt } = live.current;
			const t = gt();
			const cur = currentIndex(tk, t);
			visibleLinesInto(want, lo, ls.length, cur);
			if (want[0] !== sh[0] || want[1] !== sh[1]) setShown([want[0], want[1]]);
			for (let w = 0; w < 2; w++) {
				const li = want[w];
				if (li < 0) continue;
				const at = appeared.current.get(li);
				// the first lines of a turn are simply there; later lines ease in as the speech reaches them
				if (at === undefined || t < at) appeared.current.set(li, sh[0] < 0 && sh[1] < 0 ? Number.NEGATIVE_INFINITY : t);
			}
			// lines ease in on the audio clock, so a frame-stepped render is deterministic
			for (const [li, el] of lineEls.current) {
				const k = Math.min(1, Math.max(0, (t - (appeared.current.get(li) ?? t)) / 0.38));
				if (lineK.get(el) === k) continue;
				lineK.set(el, k);
				el.style.opacity = String(k * (2 - k));
				el.style.transform = `translateY(${(1 - k) * 8}px)`;
			}
			// only the words on screen are painted
			for (let w = 0; w < 2; w++) {
				const li = want[w];
				const line = li < 0 ? undefined : ls[li];
				if (!line) continue;
				for (const tok of line) {
					const el = spans.current.get(tok.index);
					if (!el) continue;
					const color = colorAt(tok, t, cur, dk);
					if (painted.get(el) === color) continue;
					painted.set(el, color);
					el.style.color = color;
				}
			}
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [hasWords]);

	// No words (a new turn, a barge): the lines reset, so the next turn's first lines are simply there again.
	useEffect(() => {
		if (hasWords) return;
		appeared.current.clear();
		setShown((prev) => (prev[0] < 0 && prev[1] < 0 ? prev : [-1, -1]));
	}, [hasWords]);

	const rows = shown.map((li, pos) =>
		li < 0 || !lines[li] ? (
			<div key={`gap${pos}`} style={{ ...LINE, visibility: "hidden" }}>
				&nbsp;
			</div>
		) : (
			<div key={li} ref={(el) => void (el ? lineEls.current.set(li, el) : lineEls.current.delete(li))} style={LINE}>
				{lines[li].map((tok: CaptionToken, i) => (
					<span key={tok.index} ref={(el) => void (el ? spans.current.set(tok.index, el) : spans.current.delete(tok.index))}>
						{i ? " " : ""}
						{tok.w}
					</span>
				))}
			</div>
		),
	);

	return (
		<div style={{ ...BOX, ...style }} aria-live="off">
			{rows}
		</div>
	);
});

const BOX: CSSProperties = {
	textAlign: "center",
	font: "400 clamp(18px, 2.45vh, 34px)/1.62 Inter, 'SF Pro Display', 'Helvetica Neue', system-ui, sans-serif",
	letterSpacing: "-0.005em",
	minHeight: "3.3em",
	pointerEvents: "none",
	userSelect: "none",
};
const LINE: CSSProperties = { whiteSpace: "pre-wrap" };
