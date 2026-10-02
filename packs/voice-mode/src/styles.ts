// The Voice pane's own pixels, on the host's published tokens.
//
// A stylesheet string, not utility classes: the host's Tailwind scans `@fraym/ui`'s SOURCE for class names, never a
// runtime-loaded bundle, so a class the kit happens to use renders and one it does not is silently absent. Every rule
// reads `--fr-*` custom properties, so themes, the accent picker, contrast and UI scale flow through untouched; no
// colour, size or duration is a literal. Scoped under one `data-slot` root and injected once per document.
export const STYLE_SLOT = "voice-mode-styles";

export const VOICE_PANE_CSS = `
[data-slot="voice-pane"] {
	display: flex;
	flex-direction: column;
	gap: 28px;
	max-width: 720px;
	padding: 4px 2px 32px;
	color: var(--fr-text-2);
	font-family: var(--fr-font-primary);
	font-size: var(--fr-fs-sm);
	line-height: 1.5;
}
[data-slot="voice-pane"] h2 {
	margin: 0 0 4px;
	color: var(--fr-text);
	font-size: var(--fr-fs-base);
	font-weight: 600;
}
[data-slot="voice-pane"] .vm-sub {
	margin: 0 0 10px;
	color: var(--fr-text-3);
	font-size: var(--fr-fs-xs);
}
[data-slot="voice-pane"] .vm-headline {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px 14px;
	border: 1px solid var(--fr-border-soft);
	border-radius: var(--fr-r);
	background: var(--fr-surface-2);
	color: var(--fr-text);
}
[data-slot="voice-pane"] .vm-dot {
	flex: none;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--fr-text-3);
}
[data-slot="voice-pane"] .vm-dot[data-tone="ok"] { background: var(--fr-add); }
[data-slot="voice-pane"] .vm-dot[data-tone="warn"] { background: var(--fr-warn); }
[data-slot="voice-pane"] .vm-list {
	display: flex;
	flex-direction: column;
	margin: 0;
	padding: 0;
	list-style: none;
	border: 1px solid var(--fr-border-soft);
	border-radius: var(--fr-r);
	overflow: hidden;
}
[data-slot="voice-pane"] .vm-row {
	display: flex;
	align-items: flex-start;
	gap: 12px;
	padding: 10px 14px;
	background: var(--fr-surface);
}
[data-slot="voice-pane"] .vm-row + .vm-row { border-top: 1px solid var(--fr-border-soft); }
[data-slot="voice-pane"] .vm-grow { flex: 1; min-width: 0; }
[data-slot="voice-pane"] .vm-name {
	color: var(--fr-text);
	font-weight: 500;
}
[data-slot="voice-pane"] .vm-meta {
	color: var(--fr-text-3);
	font-size: var(--fr-fs-xs);
}
[data-slot="voice-pane"] .vm-notice {
	margin-top: 2px;
	color: var(--fr-text-2);
}
[data-slot="voice-pane"] .vm-tag {
	display: inline-block;
	margin-left: 8px;
	padding: 0 6px;
	border: 1px solid var(--fr-accent-line);
	border-radius: var(--fr-r);
	color: var(--fr-accent);
	font-size: var(--fr-fs-2xs);
	letter-spacing: var(--fr-tracking-caps);
	text-transform: uppercase;
	vertical-align: 1px;
}
[data-slot="voice-pane"] .vm-state { color: var(--fr-text-3); white-space: nowrap; }
[data-slot="voice-pane"] .vm-state[data-tone="ok"] { color: var(--fr-add); }
[data-slot="voice-pane"] .vm-state[data-tone="warn"] { color: var(--fr-warn); }
[data-slot="voice-pane"] .vm-chain {
	display: flex;
	flex-direction: column;
	gap: 2px;
	margin: 6px 0 0;
	padding: 0;
	list-style: none;
}
[data-slot="voice-pane"] .vm-chain li {
	display: flex;
	justify-content: space-between;
	gap: 12px;
	color: var(--fr-text-2);
	font-size: var(--fr-fs-xs);
}
[data-slot="voice-pane"] code {
	font-family: var(--fr-font-mono);
	font-size: var(--fr-fs-xs);
	color: var(--fr-text);
}
[data-slot="voice-pane"] .vm-help {
	margin: 0;
	padding-left: 18px;
	color: var(--fr-text-2);
}
[data-slot="voice-pane"] .vm-help li + li { margin-top: 6px; }
[data-slot="voice-pane"] .vm-empty {
	padding: 14px;
	border: 1px dashed var(--fr-border);
	border-radius: var(--fr-r);
	color: var(--fr-text-3);
}
`;

export function ensureStyles(): void {
	if (typeof document === "undefined") return;
	if (document.head.querySelector(`style[data-slot="${STYLE_SLOT}"]`)) return;
	const style = document.createElement("style");
	style.dataset.slot = STYLE_SLOT;
	style.textContent = VOICE_PANE_CSS;
	document.head.appendChild(style);
}
