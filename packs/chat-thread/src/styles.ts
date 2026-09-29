// The pack's own pixels, on the host's published tokens.
//
// Why a stylesheet string and not utility classes: the host's Tailwind scans
// `@fraym/ui`'s SOURCE for class names (theme.css `@source`), never a
// runtime-loaded bundle. A class the kit happens to use renders; one it does
// not (`px-[max(28px,calc(...))]`) is silently absent. Every rule below reads
// `--fr-*` custom properties (DESIGN.md), so themes, the UI-scale knob and the
// user's thread-width setting (`--fr-thread-w`) flow through untouched.
//
// The kit's `StoreThread` is a companion-sized scroller (`px-3 py-3`, full
// width). The main pane needs the classic thread's centred reading column
// (`max-w-[var(--fr-thread-w)] px-7 pt-8 pb-12`) with the scrollbar at the
// pane's edge, not the column's. Padding does both: the column is
// `--fr-thread-w` wide, centred by the pane's own width, floored at the
// classic's 28px gutter. Unlayered, so it outranks the scroller's utilities.
//
// Injected once per document (`ensureStyles`), keyed on `data-slot`, and every
// rule is scoped under this pack's root `[data-slot="chat-thread"]`: a sheet
// on `document.head` outlives the tree that installed it.
export const STYLE_SLOT = "chat-thread-styles";

export const EMBER_THREAD_CSS = `
[data-slot="chat-thread"] {
	display: flex;
	flex: 1 1 0%;
	flex-direction: column;
	min-height: 0;
	min-width: 0;
}
[data-slot="chat-thread"] > [data-slot="store-thread"] {
	padding-block: 32px 48px;
	padding-inline: max(28px, calc((100% - var(--fr-thread-w, 780px)) / 2 + 28px));
}
`;

export function ensureStyles(): void {
	if (typeof document === "undefined") return;
	if (document.head.querySelector(`style[data-slot="${STYLE_SLOT}"]`)) return;
	const style = document.createElement("style");
	style.dataset.slot = STYLE_SLOT;
	style.textContent = EMBER_THREAD_CSS;
	document.head.appendChild(style);
}
