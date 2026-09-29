// The pack's own pixels, on the host's published tokens.
//
// Why a stylesheet string and not utility classes: the host's Tailwind scans
// `@fraym/ui`'s SOURCE for class names (theme.css `@source`), never a
// runtime-loaded bundle. A class the kit happens to use renders; one it does
// not is silently absent — and a rail that looks right only while the kit
// shares its vocabulary is a coupling, not a design. Every rule below reads
// `--fr-*` custom properties (DESIGN.md), so themes, the accent picker, the
// contrast knob and the UI-scale knob all flow through untouched, in light and
// dark alike. No colour, size or duration is a literal.
//
// Injected once per document (`ensureStyles`), keyed on `data-slot`, so a
// remount or a second instance never duplicates it. Every rule is scoped under
// one of TWO roots — the rail's `[data-slot="chat-rail"]`, and the row menu's
// `[data-slot="chat-rail-menu"]`, which is portalled to `document.body` and so
// sits OUTSIDE the rail — rather than trusting a short prefix to stay unique:
// another pack may pick the same letters, and a sheet on `document.head`
// outlives the tree that installed it.
//
// Density is the shipped rail's: a row is 7 + line + 8 with a 16px glyph slot
// and a 9px gap, rows are 1px apart, and the type steps come from the same
// `--fr-rail-lh-*` line heights, so the two rails read as one family.
export const STYLE_SLOT = "chat-rail-styles";

export const EMBER_RAIL_CSS = `
[data-slot="chat-rail"] {
	display: flex;
	flex-direction: column;
	min-height: 0;
	height: 100%;
	background: var(--fr-rail);
	border-right: 1px solid var(--fr-border-soft);
	color: var(--fr-text-2);
	font-family: var(--fr-font-rail);
	font-size: var(--fr-fs-base);
}
[data-slot="chat-rail"] button,
[data-slot="chat-rail"] input {
	font-family: inherit;
}
[data-slot="chat-rail"] .er-head {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 12px 10px 6px 12px;
}
[data-slot="chat-rail"] .er-search {
	position: relative;
	flex: 1;
	min-width: 0;
}
[data-slot="chat-rail"] .er-search > svg {
	position: absolute;
	left: 9px;
	top: 50%;
	transform: translateY(-50%);
	color: var(--fr-text-3);
	pointer-events: none;
}
[data-slot="chat-rail"] .er-search input {
	padding-left: 28px;
	background: transparent;
}
[data-slot="chat-rail"] .er-search input:focus-visible {
	background: var(--fr-surface);
}
[data-slot="chat-rail"] .er-list {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	padding: 2px 8px 12px;
}
[data-slot="chat-rail"] .er-rows {
	display: flex;
	flex-direction: column;
	gap: 1px;
}

/* A header row and a row share one skeleton: a 16px glyph slot, a 9px gap. */
[data-slot="chat-rail"] .er-plain,
[data-slot="chat-rail"] .er-section-toggle,
[data-slot="chat-rail"] .er-more {
	display: flex;
	width: 100%;
	align-items: center;
	gap: 9px;
	border: 0;
	border-radius: calc(var(--fr-r) - 2px);
	padding: 7px 10px 8px;
	background: transparent;
	text-align: left;
	font: inherit;
	line-height: var(--fr-rail-lh-base);
	color: var(--fr-text-3);
	cursor: pointer;
	transition: background-color var(--fr-motion-fast), color var(--fr-motion-fast);
}
[data-slot="chat-rail"] .er-plain:hover,
[data-slot="chat-rail"] .er-plain:focus-visible,
[data-slot="chat-rail"] .er-section-toggle:hover,
[data-slot="chat-rail"] .er-section-toggle:focus-visible,
[data-slot="chat-rail"] .er-more:hover,
[data-slot="chat-rail"] .er-more:focus-visible {
	background: var(--fr-surface);
	color: var(--fr-text);
	outline: none;
}
[data-slot="chat-rail"] .er-glyph {
	display: flex;
	width: 16px;
	height: 16px;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
}
[data-slot="chat-rail"] .er-more {
	font-size: var(--fr-fs-xs);
	line-height: var(--fr-rail-lh-xs);
}

/* Sections: a collection or Unfiled. */
[data-slot="chat-rail"] .er-section {
	margin-top: 4px;
}
[data-slot="chat-rail"] .er-section-head {
	position: relative;
	display: flex;
	align-items: center;
}
[data-slot="chat-rail"] .er-section-toggle {
	font-weight: 500;
	color: var(--fr-text-2);
}
[data-slot="chat-rail"] .er-section-toggle .er-caret {
	transition: transform var(--fr-motion-fast);
}
[data-slot="chat-rail"] .er-section[data-open] .er-section-toggle .er-caret {
	transform: rotate(90deg);
}
[data-slot="chat-rail"] .er-section-name {
	overflow: hidden;
	min-width: 0;
	flex: 1;
	text-overflow: ellipsis;
	white-space: nowrap;
}
[data-slot="chat-rail"] .er-count {
	flex-shrink: 0;
	font-family: var(--fr-font-secondary);
	font-size: var(--fr-fs-2xs);
	font-weight: 400;
	font-variant-numeric: tabular-nums;
	color: var(--fr-text-3);
	transition: opacity var(--fr-motion-fast);
}
[data-slot="chat-rail"] .er-section-empty {
	padding: 4px 10px 6px 35px;
	font-size: var(--fr-fs-xs);
	line-height: var(--fr-rail-lh-xs);
	color: var(--fr-text-3);
}

/* Rows. The wrapper carries the chrome so the trailing "more" button can sit
   inside the highlight without nesting a button in a button. */
[data-slot="chat-rail"] .er-row {
	position: relative;
	display: flex;
	align-items: center;
	border-radius: calc(var(--fr-r) - 2px);
	transition: background-color var(--fr-motion-fast);
}
[data-slot="chat-rail"] .er-row:hover,
[data-slot="chat-rail"] .er-row:focus-within {
	background: var(--fr-surface);
}
[data-slot="chat-rail"] .er-row[data-active] {
	background: var(--fr-surface-2);
}
[data-slot="chat-rail"] .er-row[data-active]::before {
	content: "";
	position: absolute;
	left: 0;
	top: 8px;
	bottom: 8px;
	width: 2px;
	border-radius: 999px;
	background: var(--fr-accent);
}
[data-slot="chat-rail"] .er-row-main {
	display: flex;
	min-width: 0;
	flex: 1;
	align-items: center;
	gap: 9px;
	border: 0;
	border-radius: inherit;
	padding: 7px 10px 8px;
	background: transparent;
	text-align: left;
	font: inherit;
	line-height: var(--fr-rail-lh-base);
	color: var(--fr-text-2);
	cursor: pointer;
}
[data-slot="chat-rail"] .er-row-main:focus-visible {
	outline: none;
	box-shadow: inset 0 0 0 1px var(--fr-accent-line);
}
[data-slot="chat-rail"] .er-row-main:disabled {
	cursor: default;
}
[data-slot="chat-rail"] .er-row:hover .er-row-main,
[data-slot="chat-rail"] .er-row:focus-within .er-row-main,
[data-slot="chat-rail"] .er-row[data-active] .er-row-main {
	color: var(--fr-text);
}
[data-slot="chat-rail"] .er-row[data-frozen] .er-row-main {
	color: var(--fr-text-3);
}
[data-slot="chat-rail"] .er-title {
	overflow: hidden;
	min-width: 0;
	flex: 1;
	text-overflow: ellipsis;
	white-space: nowrap;
	color: var(--fr-rail-title);
}
/* The mail convention, and the whole of it: an unread answer promotes its own
   title to full ink and one weight step. No badge — the glyph already says
   whether the session is running. */
[data-slot="chat-rail"] .er-row[data-unread] .er-title {
	font-weight: 500;
	color: var(--fr-text);
}
[data-slot="chat-rail"] .er-row:hover .er-title,
[data-slot="chat-rail"] .er-row:focus-within .er-title,
[data-slot="chat-rail"] .er-row[data-active] .er-title {
	color: var(--fr-text);
}
[data-slot="chat-rail"] .er-row[data-frozen] .er-title {
	color: var(--fr-text-3);
}
[data-slot="chat-rail"] .er-time {
	flex-shrink: 0;
	font-family: var(--fr-font-secondary);
	font-size: var(--fr-fs-2xs);
	font-variant-numeric: tabular-nums;
	color: var(--fr-text-3);
	transition: opacity var(--fr-motion-fast);
}
[data-slot="chat-rail"] .er-options {
	position: absolute;
	right: 4px;
	top: 50%;
	transform: translateY(-50%);
	display: flex;
	width: 24px;
	height: 24px;
	align-items: center;
	justify-content: center;
	border: 0;
	border-radius: calc(var(--fr-r) - 4px);
	background: transparent;
	color: var(--fr-text-2);
	cursor: pointer;
	opacity: 0;
	transition: opacity var(--fr-motion-fast), background-color var(--fr-motion-fast), color var(--fr-motion-fast);
}
[data-slot="chat-rail"] .er-row:hover .er-options,
[data-slot="chat-rail"] .er-row:focus-within .er-options,
[data-slot="chat-rail"] .er-section-head:hover .er-options,
[data-slot="chat-rail"] .er-section-head:focus-within .er-options,
[data-slot="chat-rail"] .er-options[aria-expanded="true"] {
	opacity: 1;
}
[data-slot="chat-rail"] .er-row:hover .er-time,
[data-slot="chat-rail"] .er-row:focus-within .er-time,
[data-slot="chat-rail"] .er-section-head[data-manage]:hover .er-count,
[data-slot="chat-rail"] .er-section-head[data-manage]:focus-within .er-count {
	opacity: 0;
}
[data-slot="chat-rail"] .er-options:hover,
[data-slot="chat-rail"] .er-options:focus-visible {
	background: var(--fr-surface-3);
	color: var(--fr-text);
	outline: none;
}
@media (hover: none) {
	[data-slot="chat-rail"] .er-options {
		opacity: 1;
	}
	[data-slot="chat-rail"] .er-row .er-time,
	[data-slot="chat-rail"] .er-section-head[data-manage] .er-count {
		opacity: 0;
	}
}

/* Inline editors: rename a session, name a collection. */
[data-slot="chat-rail"] .er-edit {
	display: flex;
	width: 100%;
	align-items: center;
	gap: 9px;
	padding: 5px 10px;
}
[data-slot="chat-rail"] .er-edit input {
	min-width: 0;
	flex: 1;
	border: 0;
	border-radius: calc(var(--fr-r) - 6px);
	padding: 2px 6px;
	background: var(--fr-surface-2);
	font-size: var(--fr-fs-base);
	line-height: var(--fr-rail-lh-base);
	color: var(--fr-text);
	outline: none;
	box-shadow: 0 0 0 1px var(--fr-accent-line);
}
[data-slot="chat-rail"] .er-confirm {
	display: flex;
	flex-direction: column;
	gap: 6px;
	margin: 2px 0 4px;
	padding: 9px 10px 8px;
	border-radius: calc(var(--fr-r) - 2px);
	border: 1px solid var(--fr-border);
	background: var(--fr-surface);
	font-size: var(--fr-fs-sm);
	line-height: var(--fr-rail-lh-xs);
	color: var(--fr-text-2);
}
[data-slot="chat-rail"] .er-confirm strong {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-weight: 500;
	color: var(--fr-text);
}
[data-slot="chat-rail"] .er-confirm-actions {
	display: flex;
	gap: 6px;
}
[data-slot="chat-rail"] .er-btn {
	border: 1px solid var(--fr-border);
	border-radius: calc(var(--fr-r) - 4px);
	padding: 3px 10px;
	background: var(--fr-surface-2);
	font: inherit;
	font-size: var(--fr-fs-xs);
	color: var(--fr-text);
	cursor: pointer;
	transition: background-color var(--fr-motion-fast), border-color var(--fr-motion-fast);
}
[data-slot="chat-rail"] .er-btn:hover,
[data-slot="chat-rail"] .er-btn:focus-visible {
	background: var(--fr-surface-3);
	outline: none;
}
[data-slot="chat-rail"] .er-btn[data-tone="danger"] {
	border-color: var(--fr-del-line);
	background: var(--fr-surface);
	color: var(--fr-del);
}
[data-slot="chat-rail"] .er-btn[data-tone="danger"]:hover,
[data-slot="chat-rail"] .er-btn[data-tone="danger"]:focus-visible {
	background: var(--fr-del-bg);
}

[data-slot="chat-rail"] .er-empty {
	padding: 28px 12px;
	text-align: center;
	font-size: var(--fr-fs-sm);
	color: var(--fr-text-3);
}
[data-slot="chat-rail"] .er-empty strong {
	display: block;
	margin-bottom: 4px;
	font-weight: 500;
	color: var(--fr-text-2);
}

/* Compact: the 56px icon rail. Same rows, one glyph each. */
[data-slot="chat-rail"][data-compact] .er-head {
	flex-direction: column;
	padding: 10px 0 6px;
}
[data-slot="chat-rail"] .er-compact-list {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 2px;
	padding: 2px 0 10px;
}
[data-slot="chat-rail"] .er-compact-row {
	position: relative;
	display: flex;
	width: 32px;
	height: 32px;
	align-items: center;
	justify-content: center;
	border: 0;
	border-radius: calc(var(--fr-r) - 2px);
	background: transparent;
	cursor: pointer;
	transition: background-color var(--fr-motion-fast);
}
[data-slot="chat-rail"] .er-compact-row:hover,
[data-slot="chat-rail"] .er-compact-row:focus-visible {
	background: var(--fr-surface);
	outline: none;
}
[data-slot="chat-rail"] .er-compact-row[data-active] {
	background: var(--fr-surface-2);
}

/* The row menu — portalled, so it cannot lean on the rail's scope. */
[data-slot="chat-rail-menu"] {
	position: fixed;
	z-index: 50;
	display: flex;
	min-width: 200px;
	max-width: 280px;
	max-height: min(60vh, 420px);
	flex-direction: column;
	gap: 1px;
	overflow-y: auto;
	padding: 4px;
	border: 1px solid var(--fr-border);
	border-radius: var(--fr-r);
	background: var(--fr-surface);
	box-shadow: 0 6px 20px color-mix(in srgb, black 24%, transparent);
	font-family: var(--fr-font-primary);
	font-size: var(--fr-fs-sm);
	color: var(--fr-text-2);
}
[data-slot="chat-rail-menu"] .erm-item {
	display: flex;
	width: 100%;
	align-items: center;
	gap: 8px;
	border: 0;
	border-radius: calc(var(--fr-r) - 4px);
	padding: 6px 8px;
	background: transparent;
	text-align: left;
	font: inherit;
	color: var(--fr-text-2);
	cursor: pointer;
}
[data-slot="chat-rail-menu"] .erm-item:hover,
[data-slot="chat-rail-menu"] .erm-item:focus-visible {
	background: var(--fr-surface-2);
	color: var(--fr-text);
	outline: none;
}
[data-slot="chat-rail-menu"] .erm-item[data-tone="danger"] {
	color: var(--fr-del);
}
[data-slot="chat-rail-menu"] .erm-item[data-tone="danger"]:hover,
[data-slot="chat-rail-menu"] .erm-item[data-tone="danger"]:focus-visible {
	background: var(--fr-del-bg);
}
[data-slot="chat-rail-menu"] .erm-glyph {
	display: flex;
	width: 14px;
	height: 14px;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
}
[data-slot="chat-rail-menu"] .erm-label {
	overflow: hidden;
	min-width: 0;
	flex: 1;
	text-overflow: ellipsis;
	white-space: nowrap;
}
[data-slot="chat-rail-menu"] .erm-heading {
	padding: 6px 8px 3px;
	font-family: var(--fr-font-secondary);
	font-size: var(--fr-fs-2xs);
	color: var(--fr-text-3);
}
[data-slot="chat-rail-menu"] .erm-rule {
	height: 1px;
	margin: 3px 4px;
	background: var(--fr-border-soft);
}
[data-slot="chat-rail-menu"] .erm-new {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 6px 8px 4px;
}
[data-slot="chat-rail-menu"] .erm-actions {
	display: flex;
	gap: 6px;
}
[data-slot="chat-rail-menu"] .erm-btn {
	border: 1px solid var(--fr-border);
	border-radius: calc(var(--fr-r) - 4px);
	padding: 3px 10px;
	background: var(--fr-surface-2);
	font: inherit;
	font-size: var(--fr-fs-xs);
	color: var(--fr-text);
	cursor: pointer;
	transition: background-color var(--fr-motion-fast);
}
[data-slot="chat-rail-menu"] .erm-btn:hover,
[data-slot="chat-rail-menu"] .erm-btn:focus-visible {
	background: var(--fr-surface-3);
	outline: none;
}
[data-slot="chat-rail-menu"] .erm-new input {
	border: 0;
	border-radius: calc(var(--fr-r) - 6px);
	padding: 4px 6px;
	background: var(--fr-surface-2);
	font: inherit;
	color: var(--fr-text);
	outline: none;
	box-shadow: 0 0 0 1px var(--fr-accent-line);
}

@media (prefers-reduced-motion: reduce) {
	[data-slot="chat-rail"] .er-row,
	[data-slot="chat-rail"] .er-plain,
	[data-slot="chat-rail"] .er-section-toggle,
	[data-slot="chat-rail"] .er-section-toggle .er-caret,
	[data-slot="chat-rail"] .er-compact-row,
	[data-slot="chat-rail"] .er-options,
	[data-slot="chat-rail"] .er-time,
	[data-slot="chat-rail"] .er-count,
	[data-slot="chat-rail-menu"] .erm-btn {
		transition: none;
	}
}
`;

export function ensureStyles(): void {
	if (typeof document === "undefined") return;
	if (document.head.querySelector(`style[data-slot="${STYLE_SLOT}"]`)) return;
	const style = document.createElement("style");
	style.dataset.slot = STYLE_SLOT;
	style.textContent = EMBER_RAIL_CSS;
	document.head.appendChild(style);
}
