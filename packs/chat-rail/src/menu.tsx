// A small context menu, because the rail seat cannot borrow the host's.
//
// `actions.sessionContextMenu` opens the HOST's menu (`fraym-frame-model-core`'s
// `openSessionMenu`): it takes a row and a pointer and returns nothing, so a pack
// cannot add "Move to collection" to it, and the kit's own popover primitives are
// not among the granted externals. So the rail draws its own — a fixed panel in
// a portal on `document.body` (a rail is `overflow: hidden` and may sit inside a
// transformed ancestor, either of which would clip or misplace a `position:
// fixed` child; the body is neither).
//
// It does only what a menu owes its user: sit where the pointer was, stay on
// screen, close on an outside press / Escape / blur / scroll / resize, move with
// the arrow keys, and hand focus back where it came from — unless the choice
// just moved focus somewhere on purpose (Rename opens an input; stealing focus
// back to the row would blur that input and cancel the rename it just started).
import { Icon } from "@fraym/ui";
import {
	type ComponentProps,
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

export interface MenuAnchor {
	readonly x: number;
	readonly y: number;
}

/** Where a menu opens for a click or a keyboard-summoned context menu. A
 *  keyboard `contextmenu` arrives with no pointer (`0, 0`); the element's own
 *  corner is the honest anchor then. */
export function anchorOf(event: { readonly clientX: number; readonly clientY: number; readonly currentTarget: Element }): MenuAnchor {
	if (event.clientX === 0 && event.clientY === 0) {
		const rect = event.currentTarget.getBoundingClientRect();
		return { x: rect.left + 12, y: rect.bottom };
	}
	return { x: event.clientX, y: event.clientY };
}

const VIEWPORT_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, Math.max(min, max)));
}

const ITEM_SELECTOR = '[role^="menuitem"]:not(:disabled)';

export function MenuShell({
	anchor,
	label,
	onClose,
	children,
}: {
	readonly anchor: MenuAnchor;
	readonly label: string;
	readonly onClose: () => void;
	readonly children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [place, setPlace] = useState<{ readonly left: number; readonly top: number } | null>(null);

	// Clamp into the viewport before first paint, and again whenever the menu's
	// own size changes (the "new collection" view is taller than the list).
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const fit = (): void => {
			const { width, height } = el.getBoundingClientRect();
			const left = clamp(anchor.x, VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
			const top = clamp(anchor.y, VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
			setPlace(current => (current && current.left === left && current.top === top ? current : { left, top }));
		};
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(el);
		return () => observer.disconnect();
	}, [anchor]);

	// The close handler rides a ref so this effect mounts ONCE. Re-running it on a
	// new callback identity would refocus the first item and hand focus back to
	// the opener on every parent render — a menu that fights its own user.
	const closeRef = useRef(onClose);
	useLayoutEffect(() => {
		closeRef.current = onClose;
	});

	useEffect(() => {
		const opener = document.activeElement;
		const menu = ref.current;
		menu?.querySelector<HTMLElement>(`${ITEM_SELECTOR}, input`)?.focus({ preventScroll: true });
		const close = (): void => closeRef.current();
		const insideMenu = (event: Event): boolean => event.target instanceof Node && menu?.contains(event.target) === true;
		const onPointerDown = (event: PointerEvent): void => {
			if (!insideMenu(event)) close();
		};
		const onKeyDown = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			close();
		};
		const onScroll = (event: Event): void => {
			if (!insideMenu(event)) close();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeyDown, true);
		document.addEventListener("scroll", onScroll, true);
		window.addEventListener("blur", close);
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeyDown, true);
			document.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("blur", close);
			window.removeEventListener("resize", close);
			// Hand focus back only when nothing claimed it. By the time this runs the
			// menu's focused item is gone, so focus has fallen to <body> — unless the
			// chosen action focused something on purpose.
			const focused = document.activeElement;
			if ((focused === document.body || focused === null) && opener instanceof HTMLElement && opener.isConnected) {
				opener.focus({ preventScroll: true });
			}
		};
	}, []);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key === "Tab") {
			onClose();
			return;
		}
		const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
		const edge = event.key === "Home" ? 0 : event.key === "End" ? -1 : undefined;
		if (move === 0 && edge === undefined) return;
		const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEM_SELECTOR)];
		if (items.length === 0) return;
		event.preventDefault();
		const at = items.indexOf(document.activeElement as HTMLElement);
		const next = edge !== undefined ? (edge === 0 ? 0 : items.length - 1) : (at + move + items.length) % items.length;
		items[next]?.focus();
	};

	return createPortal(
		<div
			ref={ref}
			role="menu"
			aria-label={label}
			data-slot="chat-rail-menu"
			data-fr-enter="pop"
			style={{ left: place?.left ?? anchor.x, top: place?.top ?? anchor.y }}
			onKeyDown={onKeyDown}
			// The right button on the menu itself must not open the browser's menu.
			onContextMenu={event => event.preventDefault()}
		>
			{children}
		</div>,
		document.body,
	);
}

export function MenuItem({
	icon,
	checked,
	tone,
	onSelect,
	children,
}: {
	readonly icon?: ComponentProps<typeof Icon>["name"];
	/** Present ⇒ a choice among siblings, drawn with a tick when it is the one. */
	readonly checked?: boolean;
	readonly tone?: "danger";
	/** Receives the click, because "More actions" hands it to the host's own row
	 *  menu, which opens where the pointer is. */
	readonly onSelect: (event: MouseEvent<HTMLButtonElement>) => void;
	readonly children: ReactNode;
}) {
	return (
		<button
			type="button"
			role={checked === undefined ? "menuitem" : "menuitemradio"}
			aria-checked={checked}
			className="erm-item"
			data-tone={tone}
			onClick={onSelect}
		>
			<span className="erm-glyph" aria-hidden="true">
				{checked ? <Icon name="check" size={13} strokeWidth={2} /> : icon ? <Icon name={icon} size={13} strokeWidth={1.8} /> : null}
			</span>
			<span className="erm-label">{children}</span>
		</button>
	);
}

export function MenuHeading({ children }: { readonly children: ReactNode }) {
	return (
		<div className="erm-heading" role="presentation">
			{children}
		</div>
	);
}

export function MenuRule() {
	return <div className="erm-rule" role="separator" />;
}
