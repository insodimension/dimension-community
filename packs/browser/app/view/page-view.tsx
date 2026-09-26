// The page itself: the live picture, fitted to the seat at the viewport's own
// aspect, and every direct input a human makes on it — click, double/triple
// click, right and middle click, wheel, hover and typing — mapped from seat
// pixels to viewport pixels and handed to `onAction`. In annotation mode the
// same surface becomes a drawing board over a frozen full-quality frame.
//
// One coordinate space rules: `viewport` CSS pixels. The SVG overlay uses
// `viewBox="0 0 width height"`, so drawings are stored in the same space
// clicks are, and never drift when the seat is resized.
import {
	type ClipboardEvent as ReactClipboardEvent,
	type CSSProperties,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import type { BrowserAction, BrowserFrame, BrowserRegion, Viewport } from "../../src/contracts";
import { ellipseOf, type Mark, type Point, regionFromDrag, toPixelPoint, toViewportPoint } from "./geometry";

export type DrawTool = "region" | "circle" | "freehand";

export interface Sketch {
	readonly region: BrowserRegion | null;
	readonly marks: readonly Mark[];
}

export const EMPTY_SKETCH: Sketch = { region: null, marks: [] };

/** Keys the runtime presses by name; everything printable is inserted. */
const NAMED_KEYS: Record<string, true> = {
	Enter: true, Tab: true, Escape: true, Backspace: true, Delete: true, ArrowUp: true, ArrowDown: true,
	ArrowLeft: true, ArrowRight: true, Home: true, End: true, PageUp: true, PageDown: true,
};
/** A sweep of the mouse is a hover where it rests, not a stream. */
const HOVER_INTERVAL_MS = 120;
/** A wheel line / page in pixels, for devices that report in those units. */
const WHEEL_LINE_PX = 40;
const MAX_FREEHAND_POINTS = 1024;
const MAX_MARKS = 64;

interface Ripple {
	readonly id: number;
	readonly x: number;
	readonly y: number;
	readonly kind: "left" | "right" | "middle";
}

interface Drag {
	readonly tool: DrawTool;
	readonly from: Point;
	readonly points: readonly Point[];
}

function SketchMark({ mark }: { readonly mark: Pick<Mark, "kind" | "points"> }) {
	if (mark.kind === "freehand") {
		return <polyline className="bx-mark" points={mark.points.map(point => `${point.x},${point.y}`).join(" ")} />;
	}
	const ellipse = ellipseOf(mark.points);
	if (ellipse === null) return null;
	return <ellipse className="bx-mark" cx={ellipse.cx} cy={ellipse.cy} rx={ellipse.rx} ry={ellipse.ry} />;
}

/** The floating layers' home. Every event that would otherwise bubble into
 *  the page's input handlers stops here, so typing a note or pressing Stop
 *  is never also sent to the web page underneath. */
export function Overlays({ children }: { readonly children: ReactNode }) {
	const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
	return (
		<div
			className="bx-floats"
			onPointerDown={stop}
			onPointerMove={stop}
			onPointerUp={stop}
			onMouseDown={stop}
			onClick={stop}
			onAuxClick={stop}
			onContextMenu={stop}
			onKeyDown={stop}
			onKeyUp={stop}
			onPaste={stop}
		>
			{children}
		</div>
	);
}

export interface PageViewProps {
	readonly frame: BrowserFrame | null;
	readonly viewport: Viewport;
	/** live: input goes to the page. annotate: draw. locked: an agent drives. */
	readonly mode: "live" | "annotate" | "locked";
	readonly tool: DrawTool;
	readonly sketch: Sketch;
	readonly onSketch: (next: Sketch) => void;
	readonly onAction: (action: BrowserAction) => void;
	readonly label: string;
	/**
	 * A post awaits the human's confirmation: Tab and Enter stay with the View
	 * (Tab moves on into the confirm bar) instead of reaching the page, where
	 * they could land on and press the site's own submit.
	 */
	readonly confirming?: boolean;
	/** The page area's size in CSS px, whenever it changes (and once on mount). */
	readonly onResize: (width: number, height: number) => void;
	/** Floating layers over the page (annotation strip, agent pill, toasts).
	 *  Their input stays theirs: nothing they receive is forwarded to the page. */
	readonly children?: ReactNode;
}

export function PageView({ frame, viewport, mode, tool, sketch, onSketch, onAction, onResize, label, confirming = false, children }: PageViewProps) {
	const pageRef = useRef<HTMLDivElement | null>(null);
	const stageRef = useRef<HTMLDivElement | null>(null);
	const onResizeRef = useRef(onResize);
	onResizeRef.current = onResize;
	// The seat's page area, in CSS px: the runtime sizes the viewport to it.
	useEffect(() => {
		const stage = stageRef.current;
		if (!stage) return;
		const observer = new ResizeObserver(entries => {
			const box = entries[0]?.contentRect;
			if (box) onResizeRef.current(Math.round(box.width), Math.round(box.height));
		});
		observer.observe(stage);
		return () => observer.disconnect();
	}, []);
	const [ripples, setRipples] = useState<readonly Ripple[]>([]);
	const [drag, setDrag] = useState<Drag | null>(null);
	const lastHoverRef = useRef(0);
	const rippleIdRef = useRef(0);
	const live = mode === "live" && frame !== null;

	const liveRef = useRef(live);
	liveRef.current = live;
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;
	const onActionRef = useRef(onAction);
	onActionRef.current = onAction;

	const pointAt = (clientX: number, clientY: number): Point | null => {
		const page = pageRef.current;
		if (!page) return null;
		return toViewportPoint(page.getBoundingClientRect(), clientX, clientY, viewport);
	};

	const ripple = (event: ReactMouseEvent, kind: Ripple["kind"]) => {
		const page = pageRef.current;
		if (!page) return;
		const box = page.getBoundingClientRect();
		const id = ++rippleIdRef.current;
		setRipples(current => [...current.slice(-4), { id, x: event.clientX - box.left, y: event.clientY - box.top, kind }]);
		window.setTimeout(() => setRipples(current => current.filter(entry => entry.id !== id)), 600);
	};

	const click = (event: ReactMouseEvent, button: "left" | "right" | "middle") => {
		if (!live) return;
		const point = pointAt(event.clientX, event.clientY);
		if (point === null) return;
		const pixel = toPixelPoint(point, viewport);
		const clickCount = Math.min(3, Math.max(1, event.detail)) as 1 | 2 | 3;
		ripple(event, button);
		onAction(button === "left" && clickCount === 1 ? { kind: "click", x: pixel.x, y: pixel.y } : { kind: "click", x: pixel.x, y: pixel.y, button, clickCount });
	};

	// Wheel must be a non-passive native listener to stop the seat scrolling.
	useEffect(() => {
		const page = pageRef.current;
		if (!page) return;
		const onWheel = (event: WheelEvent) => {
			// Wheel over a floating layer (agent steps, a toast) scrolls that layer.
			if (!liveRef.current || (event.target instanceof Element && event.target.closest(".bx-floats") !== null)) return;
			event.preventDefault();
			const box = page.getBoundingClientRect();
			const current = viewportRef.current;
			// Seat pixels → viewport pixels, so the page moves under the hand 1:1.
			const scale = box.width > 0 ? current.width / box.width : 1;
			const unit = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? current.height : 1;
			const deltaX = Math.round((event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX) * unit * scale);
			const deltaY = Math.round((event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY) * unit * scale);
			if (deltaX === 0 && deltaY === 0) return;
			onActionRef.current({ kind: "scroll", deltaX, deltaY });
		};
		page.addEventListener("wheel", onWheel, { passive: false });
		return () => page.removeEventListener("wheel", onWheel);
	}, [frame === null]);

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (mode === "annotate") {
			if (drag === null) return;
			const point = pointAt(event.clientX, event.clientY);
			if (point === null) return;
			if (drag.tool === "freehand") {
				const last = drag.points[drag.points.length - 1];
				if (last !== undefined && last.x === point.x && last.y === point.y) return;
				const points = drag.points.length >= MAX_FREEHAND_POINTS ? [...drag.points.slice(0, -1), point] : [...drag.points, point];
				setDrag({ ...drag, points });
			} else {
				setDrag({ ...drag, points: [drag.from, point] });
				if (drag.tool === "region") onSketch({ ...sketch, region: regionFromDrag(drag.from, point) });
			}
			return;
		}
		if (!live || event.pointerType !== "mouse" || event.buttons !== 0) return;
		const now = performance.now();
		if (now - lastHoverRef.current < HOVER_INTERVAL_MS) return;
		lastHoverRef.current = now;
		const point = pointAt(event.clientX, event.clientY);
		if (point === null) return;
		const pixel = toPixelPoint(point, viewport);
		onAction({ kind: "hover", x: pixel.x, y: pixel.y });
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		pageRef.current?.focus({ preventScroll: true });
		if (mode !== "annotate" || event.button !== 0 || frame === null) return;
		const point = pointAt(event.clientX, event.clientY);
		if (point === null) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		setDrag({ tool, from: point, points: [point] });
	};

	const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
		if (drag === null) return;
		if (drag.tool !== "region" && drag.points.length > 1) {
			const mark: Mark = { id: Date.now(), kind: drag.tool, points: drag.points };
			onSketch({ ...sketch, marks: [...sketch.marks, mark].slice(-MAX_MARKS) });
		}
		setDrag(null);
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (!live || event.ctrlKey || event.metaKey || event.altKey) return;
		// Shift+Tab is left to the host: it is the way out of the page for a keyboard user.
		if (event.key === "Tab" && event.shiftKey) return;
		if (confirming && (event.key === "Tab" || event.key === "Enter")) return;
		if (event.key === " ") {
			event.preventDefault();
			onAction({ kind: "press", key: "Space" });
			return;
		}
		if (NAMED_KEYS[event.key]) {
			event.preventDefault();
			onAction({ kind: "press", key: event.key });
			return;
		}
		if ([...event.key].length === 1) {
			event.preventDefault();
			onAction({ kind: "insert", text: event.key });
		}
	};

	const onPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
		if (!live) return;
		const text = event.clipboardData.getData("text/plain");
		if (text.length === 0) return;
		event.preventDefault();
		onAction({ kind: "insert", text: text.slice(0, 4096) });
	};

	const liveMark = drag !== null && drag.tool !== "region" ? drag : null;
	const style = { "--vw": viewport.width, "--vh": viewport.height } as CSSProperties;

	return (
		<div className="bx-stage" data-mode={mode} ref={stageRef}>
			<div
				ref={pageRef}
				className="bx-page"
				style={style}
				role="application"
				tabIndex={0}
				aria-roledescription="web page"
				aria-label={
					mode === "annotate"
						? `${label}. Annotation mode: drag to draw.`
						: mode === "locked"
							? `${label}. An agent is driving this page.`
							: confirming
								? `${label}. A post is waiting for your confirmation: Tab moves to it. Click, scroll and type to use the page.`
								: `${label}. Click, scroll and type to use the page. Shift+Tab leaves it.`
				}
				data-tool={mode === "annotate" ? tool : undefined}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
				onClick={event => click(event, "left")}
				onAuxClick={event => {
					if (event.button === 1) click(event, "middle");
				}}
				onMouseDown={event => {
					// Middle-button autoscroll belongs to the page, not the seat.
					if (event.button === 1) event.preventDefault();
				}}
				onContextMenu={event => {
					event.preventDefault();
					click(event, "right");
				}}
				onKeyDown={onKeyDown}
				onPaste={onPaste}
			>
				{frame === null ? (
					<div className="bx-page-skeleton" aria-hidden="true" />
				) : (
					<img
						className="bx-frame"
						src={`data:${frame.mimeType};base64,${frame.data}`}
						width={viewport.width}
						height={viewport.height}
						alt=""
						draggable={false}
						decoding="sync"
					/>
				)}
				{mode === "annotate" && (
					<svg className="bx-overlay" viewBox={`0 0 ${viewport.width} ${viewport.height}`} preserveAspectRatio="none" aria-hidden="true">
						{sketch.region !== null && (
							<rect className="bx-region" x={sketch.region.x} y={sketch.region.y} width={sketch.region.width} height={sketch.region.height} />
						)}
						{sketch.marks.map(mark => (
							<SketchMark key={mark.id} mark={mark} />
						))}
						{liveMark !== null && <SketchMark mark={{ kind: liveMark.tool === "circle" ? "circle" : "freehand", points: liveMark.points }} />}
					</svg>
				)}
				{ripples.map(entry => (
					<span key={entry.id} className="bx-ripple" data-kind={entry.kind} style={{ left: entry.x, top: entry.y }} aria-hidden="true" />
				))}
				{children !== undefined && <Overlays>{children}</Overlays>}
			</div>
		</div>
	);
}
