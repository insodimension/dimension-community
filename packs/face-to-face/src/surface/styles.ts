// One stylesheet for the pack, rendered inside each component (a bundle cannot ship a CSS file through the
// host's loader). Every rule is namespaced `f2f-`; the theme is a set of variables on `.f2f-root`.
export const STYLES = `
.f2f-root {
	--f2f-ink: #1c1a17; --f2f-ink-2: #55514b; --f2f-ink-3: #8a857d;
	--f2f-line: rgba(28,26,23,.16); --f2f-hover: rgba(28,26,23,.06);
	--f2f-coral: #e2613a; --f2f-red: #e5484d;
	--f2f-pill-bg: #1c1a17; --f2f-pill-fg: #f4f2ee;
	--f2f-bar-top: #2f5a45; --f2f-bar-bottom: #ee7a3f;
	--f2f-paper: #f4f2ee; --f2f-panel: #ffffff; --f2f-warn: #b4541f;
	position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden;
	font-family: Inter, "SF Pro Display", "Helvetica Neue", system-ui, sans-serif;
	color: var(--f2f-ink); background: var(--f2f-paper); -webkit-font-smoothing: antialiased;
}
/* a dark host: warm near-black (the face renderer's INK_BG), light text, the pill turns to light */
.f2f-root[data-dark="true"] {
	--f2f-ink: #ece9e4; --f2f-ink-2: #aba69f; --f2f-ink-3: #77726b;
	--f2f-line: rgba(236,233,228,.16); --f2f-hover: rgba(236,233,228,.07);
	--f2f-coral: #ee7d58; --f2f-red: #f0616a;
	--f2f-pill-bg: #ece9e4; --f2f-pill-fg: #141311;
	--f2f-bar-top: #5fae8a; --f2f-bar-bottom: #f08a4f;
	--f2f-paper: #0e0d0c; --f2f-panel: #1c1b19; --f2f-warn: #f0a15e;
	color-scheme: dark;
}
.f2f-root button { font: inherit; }
.f2f-top {
	position: absolute; top: 0; left: 0; right: 0; z-index: 3; pointer-events: none;
	display: flex; align-items: center; justify-content: space-between; gap: 12px;
	padding: 18px 22px;
}
.f2f-cluster { display: flex; align-items: center; gap: 10px; pointer-events: auto; }
.f2f-btn {
	display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
	padding: 9px 15px; border-radius: 999px; border: 1px solid var(--f2f-line);
	background: transparent; color: var(--f2f-ink-2);
	font-size: 13px; font-weight: 500; line-height: 1; letter-spacing: -0.005em;
	transition: background .16s ease, color .16s ease, border-color .16s ease;
}
.f2f-btn:hover { background: var(--f2f-hover); color: var(--f2f-ink); }
.f2f-btn[aria-pressed="true"] { color: var(--f2f-ink); border-color: var(--f2f-ink-3); }
.f2f-btn svg { width: 15px; height: 15px; flex: none; }
.f2f-root :focus-visible { outline: 2px solid var(--f2f-coral); outline-offset: 2px; }
.f2f-mic {
	display: inline-flex; align-items: center; gap: 8px; padding: 9px 4px;
	font-size: 13px; font-weight: 500; line-height: 1; color: var(--f2f-ink-3);
}
.f2f-mic[data-on="true"] { color: var(--f2f-ink); }
.f2f-dot { position: relative; width: 8px; height: 8px; border-radius: 50%; background: var(--f2f-ink-3); opacity: .5; }
.f2f-mic[data-on="true"] .f2f-dot { background: var(--f2f-red); opacity: 1; }
.f2f-mic[data-on="true"] .f2f-dot::after {
	content: ""; position: absolute; inset: -4px; border-radius: 50%;
	border: 1.5px solid var(--f2f-red); opacity: 0; animation: f2f-ring 1.8s ease-out infinite;
}
@keyframes f2f-ring { 0% { transform: scale(.55); opacity: .7; } 100% { transform: scale(1.35); opacity: 0; } }
.f2f-bottom {
	position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; pointer-events: none;
	display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
	gap: 14px; padding: 0 24px max(22px, 2.8vh);
}
.f2f-bottom > * { pointer-events: auto; }
.f2f-stage {
	position: absolute; left: 50%; transform: translateX(-50%); bottom: 8.5%; z-index: 2;
	width: min(92%, 60em); min-height: 3.3em; display: flex; flex-direction: column;
	align-items: center; justify-content: flex-start; text-align: center; pointer-events: none;
}
.f2f-stage > * { pointer-events: auto; }
/* the face itself could not be loaded or drawn: the card takes the face's place, above the stage's controls */
.f2f-center {
	position: absolute; inset: 0 0 22% 0; z-index: 2; display: grid; place-items: center;
	padding: 72px 24px 0; pointer-events: none;
}
.f2f-center > * { pointer-events: auto; }
.f2f-fade { animation: f2f-in .32s ease both; }
@keyframes f2f-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.f2f-talk {
	display: inline-flex; align-items: center; gap: 12px; cursor: pointer;
	padding: 13px 26px 13px 16px; border-radius: 999px; border: 0;
	background: var(--f2f-pill-bg); color: var(--f2f-pill-fg);
	font-size: 16px; font-weight: 500; letter-spacing: -0.01em; line-height: 1;
	box-shadow: 0 1px 2px rgba(0,0,0,.14), 0 10px 28px -12px rgba(0,0,0,.4);
	transition: transform .16s ease, box-shadow .16s ease;
}
.f2f-talk:hover { transform: translateY(-1px); box-shadow: 0 2px 4px rgba(0,0,0,.16), 0 14px 32px -12px rgba(0,0,0,.46); }
.f2f-talk:active { transform: none; }
.f2f-talk-orb {
	width: 26px; height: 26px; border-radius: 50%; flex: none;
	background: radial-gradient(circle at 30% 28%, #ffd2a1 0, #f08a4b 34%, #d8583a 58%, transparent 60%),
		radial-gradient(circle at 74% 30%, #7fdcae 0, #4fa57f 40%, transparent 62%),
		conic-gradient(from 210deg, #ee7a3f, #d8583a, #4f9d7c, #ee7a3f);
}
.f2f-note { font-size: 14px; line-height: 1.5; color: var(--f2f-ink-3); letter-spacing: -0.005em; }
.f2f-note[data-warn="true"] { color: var(--f2f-warn); }
.f2f-usercap {
	font-size: clamp(18px, 2.45vh, 34px); line-height: 1.62; letter-spacing: -0.005em;
	color: var(--f2f-ink-3); max-width: 100%;
	display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
}
/* "sending on silence": a hairline under the words that fills as the quiet runs out (width driven per frame, never a CSS animation) */
.f2f-silence {
	display: block; flex: none; width: min(11em, 38%); height: 2px; margin-top: 10px; border-radius: 2px; overflow: hidden; contain: layout paint;
	background: color-mix(in srgb, var(--f2f-ink-3) 22%, transparent);
}
.f2f-silence-fill {
	display: block; width: 100%; height: 100%; border-radius: 2px; transform-origin: left center; transform: scaleX(0);
	background: linear-gradient(to right, var(--f2f-bar-top), var(--f2f-bar-bottom));
}
.f2f-card {
	max-width: 36em; padding: 18px 22px; border-radius: 14px; text-align: center;
	border: 1px solid var(--f2f-line); background: color-mix(in srgb, var(--f2f-pill-fg) 78%, transparent);
	backdrop-filter: blur(6px);
}
.f2f-card h2 { margin: 0 0 6px; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; color: var(--f2f-ink); }
.f2f-card p { margin: 0; font-size: 14.5px; line-height: 1.55; color: var(--f2f-ink-2); overflow-wrap: anywhere; }
.f2f-card p + p { margin-top: 8px; font-size: 13.5px; color: var(--f2f-ink-3); }
.f2f-card .f2f-btn { margin-top: 14px; }
.f2f-state { display: flex; align-items: center; gap: 14px; min-height: 34px; }
.f2f-label { min-width: 6.5em; font-size: 13px; font-weight: 500; letter-spacing: .02em; color: var(--f2f-ink-2); text-transform: none; }
/* fixed size, so layout and paint are contained: a bar growing every frame re-lays-out these 56x34px, never the page */
.f2f-wave { display: flex; align-items: center; justify-content: center; gap: 4px; height: 34px; width: 56px; contain: strict; }
.f2f-bar {
	display: block; width: 5px; border-radius: 3px;
	background: linear-gradient(to bottom, var(--f2f-bar-top), var(--f2f-bar-bottom));
}
.f2f-door {
	position: relative; width: 56px; height: 56px; padding: 0; border: 0; border-radius: 50%;
	background: transparent; cursor: pointer; display: block;
	transition: transform .2s cubic-bezier(.3,.7,.3,1);
}
.f2f-door:hover, .f2f-door:focus-visible { transform: scale(1.08); }
.f2f-door canvas { display: block; width: 56px; height: 56px; pointer-events: none; }
.f2f-door-label {
	position: absolute; right: 66px; top: 50%; transform: translate(6px, -50%);
	padding: 7px 13px; border-radius: 999px; white-space: nowrap; pointer-events: none;
	background: #1c1a17; color: #f4f2ee; border: 1px solid rgba(255,255,255,.14);
	font: 500 13px/1 Inter, "SF Pro Display", system-ui, sans-serif; letter-spacing: -0.005em;
	opacity: 0; transition: opacity .16s ease, transform .16s ease;
}
.f2f-door:hover .f2f-door-label, .f2f-door:focus-visible .f2f-door-label { opacity: 1; transform: translate(0, -50%); }
.f2f-door:focus-visible { outline: 2px solid #e2613a; outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) {
	.f2f-root *, .f2f-door, .f2f-door * { animation: none !important; transition: none !important; }
}
`;
