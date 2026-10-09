// The page itself: the live picture (a canvas the stream draws into), fitted to
// the seat at the viewport's own aspect, and every direct input a human makes on
// it — press and release of any button (so a drag selects), wheel, hover and
// keys — mapped from seat pixels to viewport pixels and handed to `onInput`
// as the browser's own events. Marking the page up is not done here: the human
// freezes it into one picture and the annotation seat (annotation-seat.tsx)
// lays the shared annotation kit over that picture.
//
// One coordinate space rules: `viewport` CSS pixels, so a click lands on the
// same pixel of the page whatever size the seat renders the picture at.
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
import type { Viewport } from "../../src/contracts";
import type { PageInputEvent } from "../../src/input";
import { type Point, toViewportPoint } from "./geometry";
import type { Picture } from "./use-browser-stream";

/** Keys the runtime presses by name; everything printable is inserted. */
const NAMED_KEYS: Record<string, true> = {
	Enter: true, Tab: true, Escape: true, Backspace: true, Delete: true, ArrowUp: true, ArrowDown: true,
	ArrowLeft: true, ArrowRight: true, Home: true, End: true, PageUp: true, PageDown: true,
};
/** Modifier bits of the browser's input events. */
const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;
const modifiersOf = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
	(event.altKey ? ALT : 0) | (event.ctrlKey ? CTRL : 0) | (event.metaKey ? META : 0) | (event.shiftKey ? SHIFT : 0);
const BUTTONS = ["left", "middle", "right"] as const;
/** A wheel line / page in pixels, for devices that report in those units. */
const WHEEL_LINE_PX = 40;

interface Ripple {
	readonly id: number;
	readonly x: number;
	readonly y: number;
	readonly kind: "left" | "right" | "middle";
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
	/** Null until the stream has drawn the first picture. */
	readonly picture: Picture | null;
	/** The ref the stream draws the live picture into. */
	readonly canvas: (element: HTMLCanvasElement | null) => void;
	readonly viewport: Viewport;
	/** live: input goes to the page. frozen: the page is being captured for marking, so it takes no input. locked: an agent drives. */
	readonly mode: "live" | "frozen" | "locked";
	readonly onInput: (event: PageInputEvent) => void;
	readonly label: string;
	/**
	 * A post awaits confirmation: Tab and Enter stay with the View
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

export function PageView({ picture, canvas, viewport, mode, onInput, onResize, label, confirming = false, children }: PageViewProps) {
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
	const rippleIdRef = useRef(0);
	const live = mode === "live" && picture !== null;

	const liveRef = useRef(live);
	liveRef.current = live;
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;
	const onInputRef = useRef(onInput);
	onInputRef.current = onInput;
	// A mouse can report hundreds of moves a second; the page needs the last one of each display frame.
	const moveRef = useRef<PageInputEvent | null>(null);
	const moveFrameRef = useRef(0);
	const flushMove = () => {
		window.cancelAnimationFrame(moveFrameRef.current);
		moveFrameRef.current = 0;
		const move = moveRef.current;
		moveRef.current = null;
		if (move !== null) onInputRef.current(move);
	};
	useEffect(() => () => window.cancelAnimationFrame(moveFrameRef.current), []);
	const heldKeysRef = useRef(new Set<string>());

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

	const mouse = (event: ReactMouseEvent, type: "down" | "up") => {
		const button = BUTTONS[event.button];
		if (!live || button === undefined) return;
		const point = pointAt(event.clientX, event.clientY);
		if (point === null) return;
		// Whatever was moving goes first: the press lands where the pointer is.
		flushMove();
		if (type === "down") ripple(event, button);
		onInput({ kind: "mouse", type, x: point.x, y: point.y, button, buttons: event.buttons, clickCount: Math.min(3, Math.max(1, event.detail)) as 1 | 2 | 3, modifiers: modifiersOf(event) });
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
			const at = toViewportPoint(box, event.clientX, event.clientY, current);
			onInputRef.current({ kind: "wheel", x: at.x, y: at.y, deltaX, deltaY, modifiers: modifiersOf(event) });
		};
		page.addEventListener("wheel", onWheel, { passive: false });
		return () => page.removeEventListener("wheel", onWheel);
	}, []);

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!live || event.pointerType !== "mouse") return;
		const point = pointAt(event.clientX, event.clientY);
		if (point === null) return;
		const held = event.buttons & 1 ? "left" : event.buttons & 4 ? "middle" : event.buttons & 2 ? "right" : "left";
		moveRef.current = { kind: "mouse", type: "move", x: point.x, y: point.y, button: held, buttons: event.buttons, modifiers: modifiersOf(event) };
		if (moveFrameRef.current === 0) moveFrameRef.current = window.requestAnimationFrame(flushMove);
	};

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		pageRef.current?.focus({ preventScroll: true });
		// A drag that leaves the picture still ends on it: the release is delivered here whatever is under the pointer.
		if (live) event.currentTarget.setPointerCapture(event.pointerId);
	};

	/** The browser's own key event for one DOM key event, or null for a key this View keeps (host shortcuts, IME, keys the page is never sent). */
	const keyOf = (event: ReactKeyboardEvent<HTMLDivElement>, type: "down" | "up"): PageInputEvent | null => {
		if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing || event.keyCode === 229) return null;
		// Shift+Tab is left to the host: it is the way out of the page for a keyboard user.
		if (event.key === "Tab" && event.shiftKey) return null;
		if (confirming && (event.key === "Tab" || event.key === "Enter")) return null;
		const typed = [...event.key].length === 1;
		if (!typed && !NAMED_KEYS[event.key]) return null;
		// Enter types a line break, and the page sees keypress for it as for any character.
		const text = typed ? event.key : event.key === "Enter" ? "\r" : undefined;
		return { kind: "key", type, key: event.key, code: event.code, keyCode: event.keyCode, ...(text === undefined ? {} : { text }), modifiers: modifiersOf(event), repeat: event.repeat, location: event.location };
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (!live) return;
		const key = keyOf(event, "down");
		if (key === null) return;
		event.preventDefault();
		heldKeysRef.current.add(event.code);
		onInput(key);
	};

	// A key is released only if its press was sent: a shortcut the View took (Ctrl+L) never sends half a key.
	const onKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (!live || !heldKeysRef.current.delete(event.code)) return;
		const key = keyOf(event, "up");
		if (key !== null) onInput(key);
	};

	const onPaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
		if (!live) return;
		const text = event.clipboardData.getData("text/plain");
		if (text.length === 0) return;
		event.preventDefault();
		onInput({ kind: "text", text: text.slice(0, 4096) });
	};

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
					mode === "frozen"
						? `${label}. Capturing the page for marking.`
						: mode === "locked"
							? `${label}. An agent is driving this page.`
							: confirming
								? `${label}. A post is waiting for your confirmation: Tab moves to it. Click, scroll and type to use the page.`
								: `${label}. Click, scroll and type to use the page. Shift+Tab leaves it.`
				}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onMouseDown={event => {
					// Middle-button autoscroll belongs to the page, not the seat.
					if (event.button === 1) event.preventDefault();
					mouse(event, "down");
				}}
				onMouseUp={event => mouse(event, "up")}
				onContextMenu={event => event.preventDefault()}
				onKeyDown={onKeyDown}
				onKeyUp={onKeyUp}
				onPaste={onPaste}
			>
				<canvas ref={canvas} className="bx-frame" aria-hidden="true" />
				{picture === null && <div className="bx-page-skeleton" aria-hidden="true" />}
				{ripples.map(entry => (
					<span key={entry.id} className="bx-ripple" data-kind={entry.kind} style={{ left: entry.x, top: entry.y }} aria-hidden="true" />
				))}
				{children !== undefined && <Overlays>{children}</Overlays>}
			</div>
		</div>
	);
}
