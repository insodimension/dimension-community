// What every popover menu in the View does: a pointer press outside closes it, Escape closes it, the arrow keys, Home and End walk
// its items, focus lands on the first item when it opens and goes back to its button when it closes. One copy, so the toolbar's
// menu and the profile menu behave alike.
import { type RefObject, useEffect, useRef } from "react";

const ITEMS = '[role^="menuitem"]:not([disabled])';

export interface MenuOptions {
	/** Escape is offered here first; true means it was used (a form closed) and the menu stays. */
	readonly onEscape?: () => boolean;
}

/** `ref` is the element that holds both the menu's button (`[aria-haspopup="menu"]`) and the menu itself. */
export function useMenu(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>, options: MenuOptions = {}): void {
	// The newest callbacks, read when an event arrives: a parent that makes new ones every render must not re-focus the menu every render.
	const latest = useRef({ close, onEscape: options.onEscape });
	latest.current = { close, onEscape: options.onEscape };
	useEffect(() => {
		if (!open) return;
		const items = () => [...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
		const onDown = (event: PointerEvent) => {
			if (!ref.current?.contains(event.target as Node)) latest.current.close();
		};
		const onKey = (event: KeyboardEvent) => {
			const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
			const list = items();
			const index = list.findIndex(item => item === document.activeElement);
			if (event.key === "Escape") {
				if (latest.current.onEscape?.() !== true) latest.current.close();
			} else if (typing) {
				// A text field in the menu keeps its own arrows, Home and End.
				return;
			} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				list[(index + step + list.length) % list.length]?.focus();
			} else if (event.key === "Home" || event.key === "End") {
				event.preventDefault();
				list[event.key === "Home" ? 0 : list.length - 1]?.focus();
			} else return;
			event.stopImmediatePropagation();
		};
		window.addEventListener("pointerdown", onDown);
		window.addEventListener("keydown", onKey, true);
		// An item may claim the first focus (`data-menu-initial`): the first one is not always a safe thing to press by accident.
		(ref.current?.querySelector<HTMLElement>("[data-menu-initial]") ?? items()[0])?.focus();
		return () => {
			window.removeEventListener("pointerdown", onDown);
			window.removeEventListener("keydown", onKey, true);
			// Focus goes back where it came from, so Tab continues from the menu button.
			ref.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
		};
	}, [open, ref]);
}
