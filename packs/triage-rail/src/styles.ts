// The pack's own pixels, on the host's published tokens.
//
// Why a stylesheet string and not utility classes: the host's Tailwind scans
// `@fraym/ui`'s SOURCE for class names (theme.css `@source`), never a
// runtime-loaded bundle. A class the kit happens to use renders; one it does
// not is silently absent — and a rail that looks right only while the kit
// shares its vocabulary is a coupling, not a design. Every rule below reads
// `--fr-*` custom properties (DESIGN.md), so themes, the accent picker, the
// contrast knob and the UI-scale knob all flow through untouched.
//
// Injected once per document (`ensureStyles`), keyed on `data-slot`, so a
// remount or a second instance never duplicates it. Every rule is scoped
// under the root's `[data-slot="triage-rail"]` rather than trusting a short
// `.tr-` prefix to stay unique: another pack may pick the same two letters,
// and a sheet on `document.head` outlives the tree that installed it.
export const STYLE_SLOT = "triage-rail-styles";

export const TRIAGE_RAIL_CSS = `
[data-slot="triage-rail"] {
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
[data-slot="triage-rail"] .tr-head {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 12px 10px 6px 14px;
}
[data-slot="triage-rail"] .tr-brand {
	display: flex;
	min-width: 0;
	flex: 1;
	flex-direction: column;
	gap: 1px;
}
[data-slot="triage-rail"] .tr-brand-name {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-size: var(--fr-fs-sm);
	font-weight: 600;
	letter-spacing: -0.01em;
	color: var(--fr-text);
}
[data-slot="triage-rail"] .tr-eyebrow {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-family: var(--fr-font-secondary);
	font-size: var(--fr-fs-2xs);
	font-weight: 600;
	letter-spacing: var(--fr-tracking-caps);
	text-transform: uppercase;
	color: var(--fr-text-3);
}
[data-slot="triage-rail"] .tr-search {
	position: relative;
	padding: 4px 10px 6px;
}
[data-slot="triage-rail"] .tr-search > svg {
	position: absolute;
	left: 19px;
	top: 50%;
	transform: translateY(-50%);
	color: var(--fr-text-3);
	pointer-events: none;
}
[data-slot="triage-rail"] .tr-search input {
	padding-left: 28px;
	background: transparent;
}
[data-slot="triage-rail"] .tr-search input:focus-visible {
	background: var(--fr-surface);
}
[data-slot="triage-rail"] .tr-list {
	flex: 1;
	min-height: 0;
	overflow-y: auto;
	padding: 2px 8px 12px;
}
[data-slot="triage-rail"] .tr-strip {
	margin: 4px 0 8px;
	padding: 3px;
	border-radius: 10px;
	border: 1px solid color-mix(in srgb, var(--fr-iris) 26%, transparent);
	background: color-mix(in srgb, var(--fr-iris) 6%, transparent);
}
[data-slot="triage-rail"] .tr-strip-head {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 6px 8px 4px;
}
[data-slot="triage-rail"] .tr-strip-head .tr-eyebrow {
	color: var(--fr-iris);
}
[data-slot="triage-rail"] .tr-strip-dot {
	width: 6px;
	height: 6px;
	flex-shrink: 0;
	border-radius: 999px;
	background: var(--fr-iris);
	box-shadow: 0 0 0 3px color-mix(in srgb, var(--fr-iris) 24%, transparent);
}
[data-slot="triage-rail"] .tr-strip .tr-row-time {
	color: var(--fr-iris);
}
[data-slot="triage-rail"] .tr-strip .tr-row:hover,
[data-slot="triage-rail"] .tr-strip .tr-row:focus-visible,
[data-slot="triage-rail"] .tr-strip .tr-row[data-active] {
	background: color-mix(in srgb, var(--fr-iris) 12%, transparent);
}
[data-slot="triage-rail"] .tr-section {
	margin-top: 4px;
}
[data-slot="triage-rail"] .tr-section-head {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 8px 4px 3px 8px;
}
[data-slot="triage-rail"] .tr-section-toggle {
	display: flex;
	min-width: 0;
	flex: 1;
	align-items: center;
	gap: 7px;
	border: 0;
	background: transparent;
	padding: 0;
	cursor: pointer;
	color: var(--fr-text-3);
	transition: color var(--fr-motion-fast);
}
[data-slot="triage-rail"] .tr-section-toggle:hover,
[data-slot="triage-rail"] .tr-section-toggle:focus-visible {
	color: var(--fr-text-2);
	outline: none;
}
[data-slot="triage-rail"] .tr-section-toggle > svg {
	flex-shrink: 0;
	transition: transform var(--fr-motion-fast);
}
[data-slot="triage-rail"] .tr-section[data-open] .tr-section-toggle > svg.tr-caret {
	transform: rotate(90deg);
}
[data-slot="triage-rail"] .tr-count {
	margin-left: auto;
	padding-left: 8px;
	font-family: var(--fr-font-secondary);
	font-size: var(--fr-fs-2xs);
	font-variant-numeric: tabular-nums;
	color: var(--fr-text-3);
}
[data-slot="triage-rail"] .tr-row {
	position: relative;
	display: flex;
	width: 100%;
	align-items: center;
	gap: 9px;
	border: 0;
	border-radius: 8px;
	padding: 5px 8px;
	background: transparent;
	text-align: left;
	font: inherit;
	color: var(--fr-text-2);
	cursor: pointer;
	transition: background-color var(--fr-motion-fast), color var(--fr-motion-fast);
}
[data-slot="triage-rail"] .tr-row:hover,
[data-slot="triage-rail"] .tr-row:focus-visible {
	background: var(--fr-surface-2);
	color: var(--fr-text);
	outline: none;
}
[data-slot="triage-rail"] .tr-row[data-active] {
	background: var(--fr-surface-2);
	color: var(--fr-text);
}
[data-slot="triage-rail"] .tr-row[data-active]::before {
	content: "";
	position: absolute;
	left: 0;
	top: 7px;
	bottom: 7px;
	width: 2px;
	border-radius: 999px;
	background: var(--fr-accent);
}
[data-slot="triage-rail"] .tr-row:disabled {
	cursor: default;
	opacity: 0.6;
}
[data-slot="triage-rail"] .tr-row-lead {
	display: flex;
	width: 16px;
	height: 16px;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	color: var(--fr-text-3);
}
[data-slot="triage-rail"] .tr-row-body {
	display: flex;
	min-width: 0;
	flex: 1;
	flex-direction: column;
}
[data-slot="triage-rail"] .tr-row-title {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	line-height: 1.35;
	font-weight: 400;
}
[data-slot="triage-rail"] .tr-row[data-unread] .tr-row-title {
	font-weight: 500;
	color: var(--fr-text);
}
[data-slot="triage-rail"] .tr-row[data-frozen] .tr-row-title {
	color: var(--fr-text-3);
}
[data-slot="triage-rail"] .tr-row-meta {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-family: var(--fr-font-secondary);
	font-size: var(--fr-fs-2xs);
	line-height: 1.3;
	color: var(--fr-text-3);
}
[data-slot="triage-rail"] .tr-row-time {
	flex-shrink: 0;
	font-family: var(--fr-font-secondary);
	font-size: var(--fr-fs-2xs);
	font-variant-numeric: tabular-nums;
	color: var(--fr-text-3);
}
/* The voice message mark (doc 91 §8): a sibling of the row button, drawn over its trailing padding. Every addressable row sits
   in the holder; the button gives up exactly the mark's width only while the mark is DRAWN (the kit's mark decides: it draws
   nothing with voice off, and stays up under its open popover after the last message is played), so title and time keep their
   columns. */
[data-slot="triage-rail"] .tr-row-holder {
	position: relative;
}
[data-slot="triage-rail"] .tr-row-holder:has(> .tr-mail) .tr-row {
	padding-right: 32px;
}
[data-slot="triage-rail"] .tr-mail {
	position: absolute;
	top: 50%;
	right: 8px;
	transform: translateY(-50%);
}
[data-slot="triage-rail"] .tr-more {
	display: block;
	width: 100%;
	border: 0;
	background: transparent;
	padding: 4px 8px 6px 33px;
	text-align: left;
	font-family: var(--fr-font-secondary);
	font-size: var(--fr-fs-2xs);
	color: var(--fr-text-3);
	cursor: pointer;
	transition: color var(--fr-motion-fast);
}
[data-slot="triage-rail"] .tr-more:hover,
[data-slot="triage-rail"] .tr-more:focus-visible {
	color: var(--fr-text-2);
	outline: none;
}
[data-slot="triage-rail"] .tr-sweep-card {
	margin: 2px 0 6px;
	padding: 9px 10px 8px;
	border-radius: 8px;
	border: 1px solid var(--fr-border);
	background: var(--fr-surface);
	display: flex;
	flex-direction: column;
	gap: 6px;
}
[data-slot="triage-rail"] .tr-sweep-title {
	font-size: var(--fr-fs-sm);
	font-weight: 500;
	color: var(--fr-text);
}
[data-slot="triage-rail"] .tr-sweep-list {
	display: flex;
	flex-direction: column;
	gap: 2px;
	margin: 0;
	padding: 0;
	list-style: none;
	font-size: var(--fr-fs-xs);
	color: var(--fr-text-2);
}
[data-slot="triage-rail"] .tr-sweep-list li {
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
[data-slot="triage-rail"] .tr-sweep-note {
	font-family: var(--fr-font-secondary);
	font-size: var(--fr-fs-2xs);
	color: var(--fr-text-3);
}
[data-slot="triage-rail"] .tr-sweep-actions {
	display: flex;
	gap: 6px;
	padding-top: 2px;
}
[data-slot="triage-rail"] .tr-empty {
	padding: 28px 12px;
	text-align: center;
	font-size: var(--fr-fs-sm);
	color: var(--fr-text-3);
}
[data-slot="triage-rail"] .tr-empty strong {
	display: block;
	margin-bottom: 4px;
	font-weight: 500;
	color: var(--fr-text-2);
}
[data-slot="triage-rail"] .tr-foot {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 10px 10px 14px;
	border-top: 1px solid var(--fr-border-soft);
}
[data-slot="triage-rail"] .tr-foot-user {
	display: flex;
	min-width: 0;
	flex: 1;
	flex-direction: column;
}
[data-slot="triage-rail"] .tr-avatar {
	width: 22px;
	height: 22px;
	flex-shrink: 0;
	border-radius: 999px;
	object-fit: cover;
	background: var(--fr-surface-3);
	display: flex;
	align-items: center;
	justify-content: center;
	font-size: var(--fr-fs-2xs);
	font-weight: 600;
	color: var(--fr-text);
}
[data-slot="triage-rail"] .tr-foot-user .tr-brand-name {
	font-weight: 500;
}

/* Compact: the 56px icon rail. Same facts, one glyph per row. */
[data-slot="triage-rail"][data-compact] .tr-head {
	flex-direction: column;
	padding: 10px 0 6px;
}
[data-slot="triage-rail"] .tr-compact-list {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 2px;
	padding: 2px 0 10px;
}
[data-slot="triage-rail"] .tr-compact-badge {
	margin: 2px 0 6px;
	padding: 2px 7px;
	border-radius: 999px;
	font-family: var(--fr-font-secondary);
	font-size: var(--fr-fs-2xs);
	font-weight: 600;
	font-variant-numeric: tabular-nums;
	color: var(--fr-iris);
	background: color-mix(in srgb, var(--fr-iris) 12%, transparent);
}
[data-slot="triage-rail"] .tr-compact-row {
	display: flex;
	width: 32px;
	height: 32px;
	align-items: center;
	justify-content: center;
	border: 0;
	border-radius: 8px;
	background: transparent;
	cursor: pointer;
	transition: background-color var(--fr-motion-fast);
}
[data-slot="triage-rail"] .tr-compact-row:hover,
[data-slot="triage-rail"] .tr-compact-row:focus-visible,
[data-slot="triage-rail"] .tr-compact-row[data-active] {
	background: var(--fr-surface-2);
	outline: none;
}
[data-slot="triage-rail"] .tr-compact-rule {
	width: 24px;
	height: 1px;
	margin: 4px 0;
	background: var(--fr-border-soft);
}

@media (prefers-reduced-motion: reduce) {
	[data-slot="triage-rail"] .tr-row,
	[data-slot="triage-rail"] .tr-compact-row,
	[data-slot="triage-rail"] .tr-section-toggle,
	[data-slot="triage-rail"] .tr-section-toggle > svg {
		transition: none;
	}
}
`;

export function ensureStyles(): void {
	if (typeof document === "undefined") return;
	if (document.head.querySelector(`style[data-slot="${STYLE_SLOT}"]`)) return;
	const style = document.createElement("style");
	style.dataset.slot = STYLE_SLOT;
	style.textContent = TRIAGE_RAIL_CSS;
	document.head.appendChild(style);
}
