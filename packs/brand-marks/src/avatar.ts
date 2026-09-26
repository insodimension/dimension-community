// Brand Marks — a presence ("Vibr") bundle for Dimension's `avatar` slot.
//
// The host mounts this module in a SANDBOXED iframe (opaque origin, scripts
// only) whose document holds one `#fraym-pack-root` div, and talks to it over
// the pack bridge protocol v5 (fraym `packages/ui/src/bridge/pack-protocol.ts`
// is the source of truth; the few shapes this pack reads are mirrored below,
// because a pack bundles its own copy and must import nothing).
//
// ONE bundle, TEN avatars: the manifest declares ten `avatar` components off
// this single entry, and the host writes `data-avatar="<component id>"` on
// `#fraym-pack-root` so the module knows which one it is.
//
// THE BRAND RULE, which every line of CSS below obeys:
//   - At rest (state `idle`, or no presence offered yet) the mark is painted
//     EXACTLY as published — no transform, no filter, no animation.
//   - Session motion lives on CONTAINERS only: wrappers are scaled/translated,
//     and a separate halo / ring / sweep BEHIND the mark carries the brand
//     tint. The glyph is never recoloured, distorted, skewed, cropped or
//     re-lettered.

import { MARKS, type Mark } from "./marks";

// ── Protocol (v5, mirrored subset) ─────────────────────────────────────────

const PROTOCOL_VERSION = 5;

type PresenceState = "idle" | "thinking" | "typing";

interface Presence {
	readonly state: PresenceState;
	readonly mode: string;
	readonly energy: number;
	readonly emotion: string;
	readonly motion?: string;
	readonly gateOpen?: boolean;
	/** Frames-per-second ceiling. Deliberately UNREAD: every animation here is
	 *  a CSS animation the browser composites, and there is no rAF loop to gate.
	 *  The cost levers that matter for CSS are `motion` and `gateOpen`, which
	 *  stop the animations outright. */
	readonly fpsCap?: number;
}

interface Theme {
	readonly mode: "dark" | "light";
}

type Frame = { readonly __fraymPack: true; readonly v: number; readonly kind: string } & Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Brand + version gate. A frame NEWER than this copy is ignored, not guessed at. */
function isFrame(data: unknown): data is Frame {
	return (
		isObject(data) &&
		data.__fraymPack === true &&
		typeof data.v === "number" &&
		data.v <= PROTOCOL_VERSION &&
		typeof data.kind === "string"
	);
}

function asTheme(value: unknown): Theme | undefined {
	if (!isObject(value) || typeof value.tokens !== "string") return undefined;
	return value.mode === "dark" || value.mode === "light" ? { mode: value.mode } : undefined;
}

function asPresence(value: unknown): Presence | undefined {
	if (!isObject(value)) return undefined;
	const { state, mode, energy, emotion, motion, gateOpen, fpsCap } = value;
	if (state !== "idle" && state !== "thinking" && state !== "typing") return undefined;
	if (typeof mode !== "string" || typeof energy !== "number" || typeof emotion !== "string") return undefined;
	if (motion !== undefined && typeof motion !== "string") return undefined;
	if (gateOpen !== undefined && typeof gateOpen !== "boolean") return undefined;
	if (fpsCap !== undefined && typeof fpsCap !== "number") return undefined;
	return { state, mode, energy, emotion, motion, gateOpen, fpsCap };
}

function post(frame: Record<string, unknown>): void {
	window.parent.postMessage({ __fraymPack: true, v: PROTOCOL_VERSION, ...frame }, "*");
}

// ── Styles ─────────────────────────────────────────────────────────────────

const CSS = `
#fraym-pack-root{display:grid;place-items:center;overflow:hidden}
.bm{--bm-amp:.04;--bm-bob:2%;--bm-orbit:1.8s;position:relative;width:min(100vw,100vh);height:min(100vw,100vh);color:#fff}
.bm[data-theme="light"]{color:#000}
.bm-halo,.bm-ring,.bm-sweep{position:absolute;border-radius:50%;opacity:0;pointer-events:none;transition:opacity .45s ease}
.bm-halo{inset:2%;background:radial-gradient(circle,color-mix(in srgb,var(--bm-tint) 55%,transparent) 0%,color-mix(in srgb,var(--bm-tint) 18%,transparent) 45%,transparent 70%)}
.bm-ring{inset:5%;border:2px solid transparent;border-top-color:var(--bm-tint);border-right-color:color-mix(in srgb,var(--bm-tint) 35%,transparent)}
.bm-sweep{inset:5%;background:conic-gradient(from 0deg,transparent 0 70%,color-mix(in srgb,var(--bm-tint) 45%,transparent) 100%);-webkit-mask:radial-gradient(circle,transparent 60%,#000 61%);mask:radial-gradient(circle,transparent 60%,#000 61%)}
.bm-motion,.bm-pop{position:absolute;inset:0}
.bm-mark{position:absolute;inset:14%;width:72%;height:72%;display:block}

/* Static cue (costs nothing): the halo shows whenever the session is busy. */
.bm:not([data-state="idle"]) .bm-halo{opacity:.55}
.bm[data-state="typing"] .bm-halo{opacity:.8}

/* Everything below animates, and ONLY while data-live="1". */
.bm[data-live="1"][data-state="thinking"] .bm-motion{animation:bm-breathe 3.2s ease-in-out infinite}
.bm[data-live="1"][data-state="typing"] .bm-motion{animation:bm-bob .9s ease-in-out infinite}
.bm[data-live="1"][data-state="thinking"] .bm-halo{animation:bm-glow 3.2s ease-in-out infinite}
.bm[data-live="1"]:not([data-state="idle"]):is([data-mode="run"],[data-mode="edit"]) .bm-ring{opacity:1;animation:bm-orbit var(--bm-orbit) linear infinite}
.bm[data-live="1"]:not([data-state="idle"]):is([data-mode="search"],[data-mode="read"]) .bm-sweep{opacity:1;animation:bm-orbit calc(var(--bm-orbit) * 1.3) linear infinite}
.bm[data-live="1"]:not([data-state="idle"])[data-pop="1"] .bm-pop{animation:bm-pop .52s cubic-bezier(.3,1.6,.5,1) 1}

@keyframes bm-breathe{0%,100%{transform:scale(1)}50%{transform:scale(calc(1 + var(--bm-amp)))}}
@keyframes bm-bob{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(calc(-1 * var(--bm-bob))) scale(calc(1 + var(--bm-amp) / 2))}}
@keyframes bm-glow{0%,100%{opacity:.35}50%{opacity:.75}}
@keyframes bm-orbit{to{transform:rotate(1turn)}}
@keyframes bm-pop{0%,100%{transform:scale(1)}40%{transform:scale(1.1)}}

/* Reduced motion: no animation AND no transition, whatever the host says. */
@media (prefers-reduced-motion: reduce){
	.bm *{animation:none!important;transition:none!important}
}
`;

// ── Rendering ──────────────────────────────────────────────────────────────

const SVG_NS = "http://www.w3.org/2000/svg";

/** The mark exactly as published: the Simple Icons glyph, unedited, on its
 *  own 24×24 box, fitted `meet` so it is never cropped. */
function markSvg(mark: Mark): string {
	const fill = mark.fill === "theme" ? "currentColor" : mark.fill;
	return (
		`<svg class="bm-mark" xmlns="${SVG_NS}" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${mark.label}">` +
		`<title>${mark.label}</title>${mark.backing ?? ""}<path fill="${fill}" d="${mark.path}"/></svg>`
	);
}

/** The emotions that earn a one-shot pop when they ARRIVE mid-turn. */
const POP_EMOTIONS: Record<string, true> = { pleased: true, proud: true, playful: true };

function mount(root: HTMLElement, mark: Mark): (presence: Presence | undefined, theme: Theme | undefined) => void {
	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	const stage = document.createElement("div");
	stage.className = "bm";
	stage.dataset.mark = mark.id;
	stage.innerHTML =
		`<div class="bm-halo"></div><div class="bm-sweep"></div><div class="bm-ring"></div>` +
		`<div class="bm-motion"><div class="bm-pop">${markSvg(mark)}</div></div>`;
	root.replaceChildren(stage);

	// The pop is one-shot. `animationcancel` fires instead of `animationend` when
	// the session goes idle or motion stops mid-pop; clearing on both keeps a
	// stale `data-pop` from replaying at the start of the next turn.
	const pop = stage.querySelector<HTMLElement>(".bm-pop");
	const clearPop = (): void => {
		delete stage.dataset.pop;
	};
	pop?.addEventListener("animationend", clearPop);
	pop?.addEventListener("animationcancel", clearPop);

	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
	let lastPresence: Presence | undefined;
	let lastTheme: Theme | undefined;
	let lastEmotion = "";

	const paint = (presence: Presence | undefined, theme: Theme | undefined): void => {
		lastPresence = presence;
		lastTheme = theme;
		// Default white-on-dark until a theme arrives (X's dark-surface variant).
		const mode = theme?.mode ?? "dark";
		stage.dataset.theme = mode;
		// Declare the host's scheme on this document too: an iframe whose used
		// color-scheme differs from its embedder's gets an OPAQUE canvas, which
		// would paint a dark box behind a light-theme mark.
		if (theme) document.documentElement.style.colorScheme = mode;
		// A mono mark's (X, Threads, TikTok) brand colour IS its ink, so its tint follows the theme.
		stage.style.setProperty("--bm-tint", mark.fill === "theme" ? (mode === "dark" ? "#FFFFFF" : "#000000") : mark.hex);

		// No presence offered yet reads as rest, never as a guessed state.
		const state = presence?.state ?? "idle";
		stage.dataset.state = state;
		stage.dataset.mode = presence?.mode ?? "";

		// The cost contract: `off`/`still`, a closed gate, or the OS asking for
		// less motion all hold the mark still — nothing is left scheduled.
		const motion = presence?.motion;
		const live =
			presence !== undefined &&
			motion !== "off" &&
			motion !== "still" &&
			presence.gateOpen !== false &&
			!reducedMotion.matches;
		stage.dataset.live = live ? "1" : "0";

		// Energy scales the amplitude; `motion: "idle"` (a lower rung) halves it.
		const energy = Number.isFinite(presence?.energy) ? Math.min(1, Math.max(0, presence?.energy ?? 0)) : 0;
		const damp = motion === "idle" ? 0.5 : 1;
		stage.style.setProperty("--bm-amp", ((0.025 + 0.045 * energy) * damp).toFixed(4));
		stage.style.setProperty("--bm-bob", `${((1 + 2.5 * energy) * damp).toFixed(2)}%`);
		stage.style.setProperty("--bm-orbit", `${(2.4 - 1.2 * energy).toFixed(2)}s`);

		// A flourish on the EDGE into a success-ish emotion, mid-turn only — a
		// pop at rest would break the unmodified-at-rest rule.
		const emotion = presence?.emotion ?? "";
		if (!live || state === "idle") clearPop();
		else if (emotion !== lastEmotion && POP_EMOTIONS[emotion] === true) {
			clearPop();
			void stage.offsetWidth; // restart the one-shot animation
			stage.dataset.pop = "1";
		}
		lastEmotion = emotion;
	};

	reducedMotion.addEventListener("change", () => paint(lastPresence, lastTheme));
	return paint;
}

// ── Boot ───────────────────────────────────────────────────────────────────

function boot(): void {
	const root = document.getElementById("fraym-pack-root");
	// Which of this pack's avatars THIS frame is: the host writes the component
	// id onto the root it hands us. (Not the module URL — the host boots the
	// bundle from its source, so no asset URL or token ever reaches this realm.)
	const requested = root?.dataset.avatar ?? null;
	const mark = requested === null ? MARKS[0] : MARKS.find(m => m.id === requested);
	if (!root) {
		post({ kind: "error", message: "brand-marks: #fraym-pack-root is missing from the host document" });
		return;
	}
	if (!mark) {
		post({
			kind: "error",
			message: `brand-marks: unknown avatar "${requested}" (this bundle ships ${MARKS.map(m => m.id).join(", ")})`,
		});
		return;
	}

	const paint = mount(root, mark);
	let presence: Presence | undefined;
	let theme: Theme | undefined;
	paint(presence, theme);

	window.addEventListener("message", event => {
		if (event.source !== window.parent || !isFrame(event.data)) return;
		const frame = event.data;
		if (frame.kind === "init") {
			// A channel absent from `init` is "not offered": keep rest / default theme.
			const channels = isObject(frame.channels) ? frame.channels : {};
			theme = asTheme(channels.theme) ?? theme;
			presence = asPresence(channels.presence) ?? presence;
		} else if (frame.kind === "state") {
			if (frame.channel === "theme") theme = asTheme(frame.value) ?? theme;
			else if (frame.channel === "presence") presence = asPresence(frame.value) ?? presence;
			else return;
		} else {
			return;
		}
		paint(presence, theme);
	});

	post({ kind: "ready", subscribe: ["theme", "presence"] });
}

boot();
