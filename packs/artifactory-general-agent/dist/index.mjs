import { ActivityDot, Badge, Button, CapabilityChip, Icon, Input, MarketplaceFilterPills, McpMark, NebulaBackdrop, PluginMark, PresenceSurface, ProviderBrandIcon, Segmented, Skeleton, SkillMark, Switch, Textarea, ToolMark, agentPresenceFace, cn, useObservable } from "@fraym/ui";
import { memo, useCallback, useEffect, useInsertionEffect, useMemo, useRef, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
Object.freeze({
	/**
	* Low — for a thin client, a busy machine, or a shared GPU. Ambient motion
	* off, no WebGL, no blur. Everything still RENDERS; nothing loops.
	*/
	low: Object.freeze({
		frameCap: 30,
		webglFrameCap: 10,
		ambientMotion: false,
		avatarMotion: "still",
		webgl: "off",
		postProcessing: false,
		blurScale: 0,
		renderScale: .6,
		maxPixelRatio: 1,
		pollScale: 3,
		decorativeShadows: false
	}),
	/**
	* Medium — the shape of the product with its ambient life parked. WebGL
	* surfaces hold one still frame rather than vanishing, so composition and
	* colour survive; only the motion goes.
	*/
	medium: Object.freeze({
		frameCap: 30,
		webglFrameCap: 15,
		ambientMotion: false,
		avatarMotion: "idle",
		webgl: "still",
		postProcessing: false,
		blurScale: .5,
		renderScale: .75,
		maxPixelRatio: 1.5,
		pollScale: 2,
		decorativeShadows: true
	}),
	/**
	* High — the intended default, and deliberately EQUAL to what shipped.
	*
	* The nebula keeps its hand-tuned 30 fps at 0.85 render scale and a DPR
	* ceiling of 1.5. What changes versus the old build is only the part that
	* was never governed: continuous canvas loops are capped at 60 fps instead
	* of running at the panel's native refresh. On a 239 Hz display that is a
	* ~4x reduction in avatar frame work for motion no eye tracks at that rate.
	*/
	high: Object.freeze({
		frameCap: 60,
		webglFrameCap: 30,
		ambientMotion: true,
		avatarMotion: "full",
		webgl: "full",
		postProcessing: true,
		blurScale: 1,
		renderScale: .85,
		maxPixelRatio: 1.5,
		pollScale: 1,
		decorativeShadows: true
	}),
	/**
	* Cinematic — the only tier that costs MORE than the old build: canvas
	* loops run at native refresh, the nebula doubles to 60 fps, and it draws
	* at full render scale and a DPR ceiling of 2. For a machine with headroom
	* to spend, and disclosed as such in Settings.
	*/
	cinematic: Object.freeze({
		frameCap: 0,
		webglFrameCap: 60,
		ambientMotion: true,
		avatarMotion: "full",
		webgl: "full",
		postProcessing: true,
		blurScale: 1,
		renderScale: 1,
		maxPixelRatio: 2,
		pollScale: 1,
		decorativeShadows: true
	})
});
Object.freeze({
	low: Object.freeze({
		label: "Low",
		blurb: "Nothing loops. No WebGL, no blur, 30 fps — for a busy machine or a shared GPU."
	}),
	medium: Object.freeze({
		label: "Medium",
		blurb: "Ambient motion parked, effects held as still frames. 30 fps."
	}),
	high: Object.freeze({
		label: "High",
		blurb: "Everything alive, capped at 60 fps. Recommended on any high-refresh display."
	}),
	cinematic: Object.freeze({
		label: "Cinematic",
		blurb: "Uncapped at your display's native refresh, every effect on. Costs the most."
	})
});
/** Vibr presence avatar ids — the allowlist a persisted {@link FraymUiConfig.avatar}
*  is validated against. Mirrors `@fraym/vibr`'s `AvatarId` union by hand because this
*  contract package stays dependency-free (`@fraym/vibr` needs React, and non-React
*  hosts resolve this config); the two rosters are pinned together by a drift test in
*  `@fraym/ui`, which depends on both. */
var AVATAR_IDS = [
	"blob",
	"static",
	"rorschach",
	"inkblot",
	"aurora",
	"nebula",
	"siri",
	"quasar",
	"matrix",
	"lattice",
	"liquid",
	"koi",
	"duel",
	"smiley",
	"cat",
	"octo",
	"cham",
	"cube",
	"orb",
	"mochi",
	"none"
];
/** First-install defaults: recent (within 3d) sessions, sorted by activity. */
var DEFAULT_SESSION_FILTERS = Object.freeze({
	status: "All",
	project: "All",
	activity: "3d",
	group: "Project",
	sort: "Activity",
	metadata: [],
	hiddenNotice: "Hide",
	collapseAfter: 5
});
Object.freeze({
	narrow: 560,
	default: 780,
	wide: 940,
	max: 1120
});
Object.freeze({
	themeMode: "dark",
	accent: "theme",
	accentStyle: "gradient",
	shellChrome: "inset",
	spaceDockEdge: "bleed",
	motion: "system",
	uiFont: "",
	codeFont: "",
	fontPreset: "",
	themePreset: "",
	uiFontSize: 14,
	codeFontSize: 12,
	contrast: 50,
	motionSpeed: 100,
	collapseCurve: "exit",
	collapsePace: "balanced",
	scalability: "high",
	density: "comfortable",
	showAvatars: false,
	avatar: "blob",
	vibrEnabled: true,
	railVibr: true,
	railVibrAllSessions: false,
	replyVoice: false,
	maxVisibleBlocks: 10,
	maxVisibleTurns: 12,
	collapseMode: "worked",
	verberProfile: "tui",
	streamWisp: false,
	streamWispPreset: "auto",
	vibrSize: "sm",
	mochiSkin: "ink",
	mochiAccent: "theme",
	mdBoldWeight: 600,
	mdBoldColor: "default",
	showTokenUsage: true,
	cacheMarkers: "off",
	cacheMarkersHandled: {},
	toolOutputDefault: "none",
	showReasoning: true,
	groupConsecutiveTools: true,
	groupThreshold: 2,
	toolGroupIconStack: true,
	toolGroupIconStackMax: 5,
	telemetry: {},
	studioPersona: "",
	layout: void 0,
	slashEntries: void 0,
	composerSendWhileRunning: "steer",
	keybindingOverrides: {},
	customProviderBrands: {},
	sessionFilters: { ...DEFAULT_SESSION_FILTERS },
	sessionRailStyle: "classic",
	railWidth: void 0,
	threadWidth: "default",
	textOverflow: "fade",
	projectSessionFilters: {},
	modelUsage: {},
	favoriteModels: [],
	modelCapabilityOverrides: {},
	usageWarnEnabled: true,
	usageWarnThreshold: 60,
	usageWarnRedThreshold: 90,
	usageWarnDismissed: {}
});
Object.freeze({});
//#endregion
//#region ../../../fraym/packages/vibr/src/avatars/mochi-skins.ts
/**
* The picker's rows, in the order a picker should show them — and the order IS
* the explanation, because the axis is "how much colour the body carries":
* none, one hue, four hues, then the one inverted-value material.
*
* Every hint names the MATERIAL and hands the colour question to the other
* control, which is the whole fix for "I'm confused — the two levels of
* configuration". A hint that named a colour here would be describing the wrong
* axis.
*/
var MOCHI_SKINS = [
	{
		id: "ink",
		label: "Ink",
		hint: "A near-black body. Colour only in the glow around it — the original."
	},
	{
		id: "accent",
		label: "Solid",
		hint: "The body is one solid colour, whichever hue you pick."
	},
	{
		id: "opal",
		label: "Opal",
		hint: "An iridescent body — four shades of your hue at once, in a glow that shifts with it."
	},
	{
		id: "pearl",
		label: "Pearl",
		hint: "A pale body with dark eyes. The hue stays in the glow."
	}
];
/** `#rgb` / `#rrggbb` → three 0–255 channels. Throws on anything else, loudly. */
function parseHex(hex) {
	const s = hex.trim().replace(/^#/, "");
	const full = s.length === 3 ? `${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}` : s;
	if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);
	return [
		Number.parseInt(full.slice(0, 2), 16),
		Number.parseInt(full.slice(2, 4), 16),
		Number.parseInt(full.slice(4, 6), 16)
	];
}
/** WCAG relative luminance. sRGB → linear → the 0.2126/0.7152/0.0722 mix. */
function relativeLuminance(hex) {
	const lin = parseHex(hex).map((c) => {
		const v = c / 255;
		return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
	});
	return .2126 * lin[0] + .7152 * lin[1] + .0722 * lin[2];
}
/** White or black, whichever wins against `bodyHex`. Never anything in between. */
function derivedEyeInk(bodyHex) {
	return relativeLuminance(bodyHex) < .1791 ? "#ffffff" : "#000000";
}
/**
* THE NAMED PALETTE. Thirteen accents that are a CHOICE rather than a theme
* consequence, orthogonal to the four skins: a skin says what mochi is made of,
* an accent says what colour that material is. `"theme"` is deliberately not in
* this table — it is the absence of a choice, so it has no hex to name.
*
* EVERY HEX HERE IS A MEASUREMENT, not a swatch someone liked. Three floors were
* solved simultaneously, all of them on the shipping `#0b0b0d` chrome at the
* shipping 26px tile, and `test/accents.test.ts` re-derives all three:
*
*  1. **Distinguishable at tile size.** At 26px the aura is the whole read and
*     it arrives at roughly {@link MOCHI_AURA_EDGE_ALPHA} alpha, which compresses
*     every difference by about half. So the separation floor is measured on the
*     COMPOSITED colour in OKLab, not on the raw hexes — see
*     {@link MOCHI_ACCENT_MIN_DELTA_E}. The worst surviving pair is ember/coral
*     at 0.056, about 2.8× the just-noticeable difference; two earlier candidates
*     (a spring-green `fern` next to `jade`, and a `sulphur` next to `amber`)
*     were re-tuned because they measured under the floor.
*  2. **The halo still reads.** Composited at the resting edge alpha every accent
*     measures at least 1.96:1 against the chrome — above the 1.91:1 the DEFAULT
*     theme accent (`#7a60c1`) already ships, so no named accent is dimmer than
*     the one the product hands out today.
*  3. **A hue-coloured body keeps a face.** `accent` makes the BODY the accent and
*     derives its eye from that one colour — `lch(from … calc((49.44 - l) *
*     infinity) 0 0)`, which collapses to pure white or pure black depending on
*     which side of {@link EYE_INK_CROSSOVER} the hex sits. One flat eye per hex,
*     so what every hex here must keep is a decisive distance from the crossover
*     rather than a close call that flips under a host theme's own accent.
*     `iris` is the tuned case, and the tuning is HISTORICAL: the constraint that
*     forced it was the retired `gradient` skin, which ramped the accent into a
*     second stop and derived ONE eye ink from the first, so a ramp STRADDLING
*     the crossover could not be served by any flat eye at 4.5:1. The natural
*     indigo (`#7060f0`, luminance 0.181) sat just above the line and its darker
*     stop measured 3.72:1 with a black eye; pulling it to luminance 0.175
*     flipped the ramp to a white eye and 4.67:1, which is still the worst
*     measured contrast in the palette. `gradient` retired on 2026-08-16 (it
*     measured 0.0292 from `accent` at best, under {@link
*     MOCHI_ACCENT_MIN_DELTA_E}), so no ramp constrains this table any more —
*     `#6d5cf5` stays because re-tuning a shipped hue to recover 0.006 of
*     luminance would be a change nobody asked for, not because a ramp needs it.
*/
var MOCHI_ACCENTS = [
	{
		id: "orchid",
		label: "Orchid",
		hex: "#b07dff"
	},
	{
		id: "iris",
		label: "Iris",
		hex: "#6d5cf5"
	},
	{
		id: "azure",
		label: "Azure",
		hex: "#4f9bff"
	},
	{
		id: "lagoon",
		label: "Lagoon",
		hex: "#2fc4e0"
	},
	{
		id: "jade",
		label: "Jade",
		hex: "#2fd39b"
	},
	{
		id: "fern",
		label: "Fern",
		hex: "#8ecf4a"
	},
	{
		id: "amber",
		label: "Amber",
		hex: "#f0b24b"
	},
	{
		id: "ember",
		label: "Ember",
		hex: "#ff8340"
	},
	{
		id: "coral",
		label: "Coral",
		hex: "#ff5f5f"
	},
	{
		id: "rose",
		label: "Rose",
		hex: "#ff6fb8"
	},
	{
		id: "fuchsia",
		label: "Fuchsia",
		hex: "#e04cd8"
	},
	{
		id: "porcelain",
		label: "Porcelain",
		hex: "#eef0f5"
	},
	{
		id: "slate",
		label: "Slate",
		hex: "#8fa3bd"
	}
];
[{
	id: "theme",
	label: "Theme",
	hint: "Follow the app's own accent — the default.",
	hex: null
}, ...MOCHI_ACCENTS.map((a) => ({
	id: a.id,
	label: a.label,
	hint: `${a.label} — ${a.hex}, independent of the app accent.`,
	hex: a.hex
}))].map((o) => o.id);
/**
* The accent chain every skin writes.
*
* `--mo-accent` is FIRST and is the named-palette hop: `[data-accent="jade"]`
* sets it, and nothing else in the product ever does, so with no accent chosen
* the chain is character-for-character the fallback order mochi always had
* (`--accent` → `--fr-accent` → the standalone literal) and the resolved colour
* is unchanged. A named accent therefore overrides the theme for MOCHI ONLY —
* it cannot leak into `--fr-accent` and repaint the app.
*/
var ACCENT_CSS = "var(--mo-accent,var(--accent,var(--fr-accent,#b78cff)))";
/**
* What that chain resolves to under the DEFAULT theme — the measurable form. The
* tests measure every other palette from `MOCHI_THEME_ACCENTS` rather than from a
* second literal here, so this one hex cannot drift into being the only theme the
* suite actually checks.
*/
var ACCENT_MEASURED = "#7a60c1";
/** A hex decomposed into HSL, hue in degrees and S/L in 0–1 — what `hsl(from …)` sees. */
function hslOf(hex) {
	const [r255, g255, b255] = parseHex(hex);
	const r = r255 / 255;
	const g = g255 / 255;
	const b = b255 / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;
	const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
	let h = 0;
	if (d !== 0) {
		if (max === r) h = (g - b) / d % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h *= 60;
	}
	return [
		h,
		s,
		l
	];
}
/** HSL → hex, hue in degrees (wrapped) and S/L in 0–1. The inverse of {@link hslOf}. */
function hslHex(hDeg, s, l) {
	const h = (hDeg % 360 + 360) % 360;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(h / 60 % 2 - 1));
	const m = l - c / 2;
	const seg = Math.floor(h / 60) % 6;
	const rgb = seg === 0 ? [
		c,
		x,
		0
	] : seg === 1 ? [
		x,
		c,
		0
	] : seg === 2 ? [
		0,
		c,
		x
	] : seg === 3 ? [
		0,
		x,
		c
	] : seg === 4 ? [
		x,
		0,
		c
	] : [
		c,
		0,
		x
	];
	const hex2 = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
	return `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;
}
/** Rotate a hex's HSL hue by `deg`, preserving S and L. Models the CSS at test time. */
function rotateHue(hex, deg) {
	const [h, s, l] = hslOf(hex);
	return hslHex(h + deg, s, l);
}
/**
* OPAL'S HUE OFFSETS, in degrees from the resolved accent's own hue. Four stops,
* evenly spaced 44° apart, so the total span is **132°** and the ramp reads as a
* shifting material rather than as a fade between two colours (which is what
* `gradient` already is, at 0° of hue travel and one ΔE of separation).
*
* WHY FOUR AND WHY 132°. Three stops is aurora's shape and two is gradient's, so
* a fourth stop is what makes the surface read as iridescence: at four the ramp
* turns twice, which is the cue that says "one object catching several lights"
* instead of "two colours meeting in the middle". 132° is the widest span that
* survives the eye floor with margin — see {@link OPAL_BODY_LIGHT} — while still
* landing every stop inside a recognisable neighbourhood of the accent (a violet
* runs teal → indigo → violet → magenta, never all the way round to green).
*/
var OPAL_HUE_OFFSETS = [
	-66,
	-22,
	22,
	66
];
/**
* One body stop: the accent's hue rotated by `offsetDeg`, at opal's own fixed S
* and L. Models `hsl(from var(--mo-accent) calc(h + N) 64% 27%)` at test time.
*/
function opalBody(accentHex, offsetDeg) {
	return hslHex(hslOf(accentHex)[0] + offsetDeg, 64 / 100, 27 / 100);
}
/**
* Opal's four stops. Body and glow share the `a…d` suffix order, so the two ramps
* travel in the SAME direction across the SAME hues — the
* body gradient is an objectBoundingBox diagonal and the glow gradient is the
* filter region's diagonal, so a stop's hue lands on the same corner in both and
* the halo is the body's own colour spread outward, not a second palette.
*
* The offsets are even quarters of the ramp rather than the ends only: with four
* stops the turn points ARE the read.
*/
var OPAL_STOP_OFFSETS = [
	0,
	.34,
	.66,
	1
];
OPAL_HUE_OFFSETS.map((deg, i) => ({
	className: `mo-opal-${"abcd"[i]}`,
	offset: OPAL_STOP_OFFSETS[i] ?? 1,
	measured: opalBody(ACCENT_MEASURED, deg)
}));
OPAL_HUE_OFFSETS.map((deg, i) => ({
	className: `mo-opalaura-${"abcd"[i]}`,
	offset: OPAL_STOP_OFFSETS[i] ?? 1,
	measured: rotateHue(ACCENT_MEASURED, deg)
}));
({ ...MOCHI_SKINS[0] }), { ...MOCHI_SKINS[1] }, `${ACCENT_CSS}`, derivedEyeInk(ACCENT_MEASURED), { ...MOCHI_SKINS[2] }, { ...MOCHI_SKINS[3] };
//#endregion
//#region page/faces.ts
/** Every face an agent may wear: the host's first-party roster minus `none`
*  (the user's Vibr switch, never an agent's to pick), then every contributed
*  face the host lends. */
function faceOptions(bridged) {
	const own = AVATAR_IDS.filter((id) => id !== "none").map((id) => ({
		id,
		label: faceLabel(id),
		bridged: false
	}));
	const lent = (bridged ?? []).map((def) => ({
		id: def.id,
		label: def.label,
		bridged: true
	}));
	return [...own, ...lent];
}
/** A face's name, as the gallery prints it. */
function faceLabel(id) {
	return id.charAt(0).toUpperCase() + id.slice(1);
}
/** The colour an agent's face carries when it pinned one (Mochi's accent), for
*  the wash behind it; `undefined` (the app accent's wash) otherwise. `theme`
*  is no colour of its own: it follows the app accent. */
function faceHue(face) {
	return MOCHI_ACCENTS.find((option) => option.id === face.accent)?.hex;
}
/** The wash behind a face tile: the pinned accent, else the app's. */
function faceWash(face, strength) {
	return `color-mix(in oklab, ${faceHue(face) ?? "var(--fr-accent)"} ${strength}%, transparent)`;
}
/** `resolve`, remembered per name. The host's rule builds a new binding on every
*  call, so a card handed a fresh one each render could never be skipped; one
*  memo per (avatar, bindings) hands every card the same object until they change. */
function rememberFaces(resolve) {
	const faces = /* @__PURE__ */ new Map();
	return (name) => {
		let face = faces.get(name);
		if (face === void 0) {
			face = resolve(name);
			faces.set(name, face);
		}
		return face;
	};
}
//#endregion
//#region page/kpis.ts
var WEEK_MS = 10080 * 60 * 1e3;
var NO_ACTIVITY = {
	sessions7d: 0,
	sessionsTotal: 0,
	lastActive: null,
	working: 0,
	needsYou: 0,
	roomsLed: 0,
	runs7d: 0
};
function foldActivity(rows, now, defaultAgent) {
	const out = /* @__PURE__ */ new Map();
	if (rows === void 0) return out;
	const tally = (agent) => {
		let entry = out.get(agent);
		if (entry === void 0) {
			entry = { ...NO_ACTIVITY };
			out.set(agent, entry);
		}
		return entry;
	};
	const superseded = /* @__PURE__ */ new Set();
	for (const row of rows) if (row.continuedFrom !== void 0) superseded.add(row.continuedFrom);
	const since = now - WEEK_MS;
	for (const row of rows) {
		if (row.kind === "room") {
			if (row.archivedAt === void 0 && row.roomAuthority !== void 0) tally(row.roomAuthority).roomsLed += 1;
			continue;
		}
		const entry = tally(row.profile ?? defaultAgent);
		const at = Date.parse(row.updatedAt);
		if (Number.isFinite(at) && (entry.lastActive === null || at > entry.lastActive)) entry.lastActive = at;
		if (row.archivedAt !== void 0) continue;
		const recent = Number.isFinite(at) && at >= since;
		if (row.source === "autonomy") {
			if (recent) entry.runs7d += 1;
			continue;
		}
		if (row.continuedInto !== void 0 || superseded.has(row.ref.sessionId)) continue;
		entry.sessionsTotal += 1;
		if (recent) entry.sessions7d += 1;
		if (row.liveStatus === "running" || row.liveStatus === "background") entry.working += 1;
		if (row.blockedOnInput === true || row.attention !== void 0) entry.needsYou += 1;
	}
	return out;
}
/**
* `next`, with each agent's entry swapped for the one in `previous` when every
* number in it is the same. A fold builds fresh objects on every coalesced
* `sessions/list`, so without this each card sees new props four times a second
* while any session streams, even when its own numbers did not move; with it,
* only the card whose agent changed is handed a different `activity`.
*/
function shareActivity(previous, next) {
	if (previous === void 0) return next;
	const shared = /* @__PURE__ */ new Map();
	for (const [agent, activity] of next) {
		const before = previous.get(agent);
		shared.set(agent, before !== void 0 && sameActivity(before, activity) ? before : activity);
	}
	return shared;
}
function sameActivity(a, b) {
	return a.sessions7d === b.sessions7d && a.sessionsTotal === b.sessionsTotal && a.lastActive === b.lastActive && a.working === b.working && a.needsYou === b.needsYou && a.roomsLed === b.roomsLed && a.runs7d === b.runs7d;
}
function liveStateOf(activity) {
	if (activity.needsYou > 0) return "needs-you";
	if (activity.working > 0) return "working";
	return "idle";
}
/** `3h ago`, `2d ago`, `just now`; `Never` for no row. */
function agoLabel(at, now) {
	if (at === null) return "Never";
	const seconds = Math.max(0, Math.round((now - at) / 1e3));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.round(days / 30);
	return months < 12 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`;
}
/** `812`, `12.4k`, `3.1M`. */
function tokenLabel(tokens) {
	if (tokens < 1e3) return `${Math.round(tokens)}`;
	if (tokens < 1e6) return `${(tokens / 1e3).toFixed(tokens < 1e4 ? 1 : 0)}k`;
	return `${(tokens / 1e6).toFixed(1)}M`;
}
/** `$0.00`, `$1.24`, `$312`. */
function money(usd) {
	if (usd >= 100) return `$${Math.round(usd)}`;
	return `$${usd.toFixed(2)}`;
}
//#endregion
//#region page/types.ts
var AGENTS_KEY = "agents/list";
var SESSIONS_KEY = "sessions/list";
var USAGE_KEY = "agents/usage";
var CATALOG_KEY = "capabilities/catalog";
var MODELS_KEY = "models";
/** The page's root element's `data-slot`: the scope `page.css` puts every utility under. */
var PAGE_SLOT = "general-agents-page";
//#endregion
//#region page/facts.ts
var ABSENT = {
	getSnapshot: () => void 0,
	subscribe: () => () => void 0
};
/** A root fact, live. */
function useFact(store, key) {
	return useObservable(useMemo(() => store.watch(key) ?? ABSENT, [store, key]));
}
/** A fact read at most once per `ms`: the newest value after a quiet window,
*  so a stream of republishes costs one render, not one per event. */
function useCoalescedFact(store, key, ms) {
	const observable = useMemo(() => store.watch(key) ?? ABSENT, [store, key]);
	const [value, setValue] = useState(() => observable.getSnapshot());
	useEffect(() => {
		let timer;
		const flush = () => {
			timer = void 0;
			setValue(observable.getSnapshot());
		};
		const unsubscribe = observable.subscribe(() => {
			timer ??= setTimeout(flush, ms);
		});
		setValue(observable.getSnapshot());
		return () => {
			unsubscribe();
			if (timer !== void 0) clearTimeout(timer);
		};
	}, [observable, ms]);
	return value;
}
/** Wall-clock time, ticking every `ms` (relative times and the 7-day window). */
function useNow(ms) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(id);
	}, [ms]);
	return now;
}
/** Every agent's activity, folded once per coalesced catalog. An agent whose
*  numbers did not move keeps the object it had (`shareActivity`), so its card
*  can be skipped. */
function useActivity(store, now, defaultAgent) {
	const rows = useCoalescedFact(store, SESSIONS_KEY, 250);
	const previous = useRef(void 0);
	return useMemo(() => {
		const next = shareActivity(previous.current, foldActivity(rows, now, defaultAgent));
		previous.current = next;
		return next;
	}, [
		rows,
		now,
		defaultAgent
	]);
}
/** `key` re-reads at once when it changes (the workspace the read is for). */
function usePolled(read, ms, key) {
	const [value, setValue] = useState(void 0);
	const [error, setError] = useState(void 0);
	const readRef = useRef(read);
	readRef.current = read;
	const seq = useRef(0);
	const refresh = useCallback(() => {
		const mine = ++seq.current;
		return readRef.current().then((next) => {
			if (mine !== seq.current) return;
			setValue(next);
			setError(void 0);
		}, (cause) => {
			if (mine !== seq.current) return;
			setError(cause instanceof Error ? cause.message : String(cause));
		});
	}, []);
	useEffect(() => {
		refresh();
		if (ms === null) return;
		const id = setInterval(() => {
			if (typeof document === "undefined" || document.visibilityState === "visible") refresh();
		}, ms);
		return () => clearInterval(id);
	}, [
		refresh,
		ms,
		key
	]);
	return {
		value,
		error,
		refresh
	};
}
//#endregion
//#region page/forge.ts
var NO_CALL_DOOR = "This host does not let the General Agents page call its server (the artifactory:call grant), so agents cannot be read or saved here.";
function forgeOf(store, workspace) {
	const tool = async (name, args = {}) => {
		if (store.call === void 0) throw new Error(NO_CALL_DOOR);
		const scoped = workspace === void 0 ? args : {
			...args,
			workspace
		};
		return await store.call("callOwnServerTool", {
			tool: name,
			args: scoped
		});
	};
	return {
		listAgents: () => tool("list_agents"),
		validate: (draft) => tool("validate_agent", { draft }),
		save: (draft, target) => tool("save_agent", target.create ? {
			draft,
			create: true,
			...target.tier !== void 0 ? { tier: target.tier } : {}
		} : {
			draft,
			create: false,
			tier: target.tier,
			revision: target.revision
		}),
		home: (name) => tool("agent_home", { name }),
		saveInstructions: (name, text, revision) => tool("save_instructions", {
			name,
			text,
			revision
		}),
		pendingProposals: () => tool("pending_proposals"),
		dismissProposal: async (id) => {
			if (store.call === void 0) throw new Error(NO_CALL_DOOR);
			return await store.call("callOwnServerTool", {
				tool: "dismiss_proposal",
				args: { id }
			});
		},
		configure: async (name, patch) => {
			if (store.call === void 0) throw new Error(NO_CALL_DOOR);
			await store.call("configureGeneralAgent", {
				name,
				...patch
			});
		}
	};
}
function errorText(cause) {
	return cause instanceof Error ? cause.message : String(cause);
}
//#endregion
//#region page/chrome.tsx
/** A panel's or a column's label: the kit's eyebrow size and weight in the
*  secondary face, sentence case (DESIGN.md: no uppercase eyebrows), text-2 for
*  contrast on a surface. */
var LABEL = "font-secondary text-fr-2xs font-semibold tracking-fr-label text-fr-text-2";
/** One scrolling column. Container queries, not the viewport: the Machinist's
*  dock opening beside the page reflows it. */
function ViewColumn({ slot, children, footer }) {
	return /* @__PURE__ */ jsxs("div", {
		className: "relative flex h-full min-h-0 flex-col",
		children: [/* @__PURE__ */ jsx("div", {
			className: "min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]",
			children: /* @__PURE__ */ jsx("div", {
				"data-slot": slot,
				className: "@container mx-auto flex w-full max-w-295 flex-col gap-7 px-5 pt-5 pb-12",
				children
			})
		}), footer]
	});
}
/** Section chrome: a real heading with a quiet count, a lede and an aside. */
function Section({ title, count, lede, aside, children, className, id }) {
	return /* @__PURE__ */ jsxs("section", {
		id,
		"aria-label": title,
		className: cn("flex scroll-mt-16 flex-col gap-3", className),
		children: [/* @__PURE__ */ jsxs("div", {
			className: "flex min-h-5 flex-wrap items-end justify-between gap-x-3 gap-y-1",
			children: [/* @__PURE__ */ jsxs("div", {
				className: "flex min-w-0 flex-col gap-1",
				children: [/* @__PURE__ */ jsxs("h2", {
					className: "m-0 flex items-baseline gap-2 text-fr-md font-semibold text-fr-text",
					children: [title, count !== void 0 ? /* @__PURE__ */ jsx("span", {
						className: "font-secondary text-fr-sm font-normal text-fr-text-2 tabular-nums",
						children: count
					}) : null]
				}), lede ? /* @__PURE__ */ jsx("p", {
					className: "m-0 max-w-prose text-fr-sm leading-relaxed text-pretty text-fr-text-2",
					children: lede
				}) : null]
			}), aside]
		}), children]
	});
}
/** One figure in a card's footer: the reading over its label. */
function CardStat({ value, label, title, quiet }) {
	return /* @__PURE__ */ jsxs("div", {
		title,
		className: "flex min-w-0 flex-col-reverse items-center gap-1 px-2 py-2.5",
		children: [/* @__PURE__ */ jsx("dt", {
			className: cn("fr-overflow leading-none", LABEL),
			children: label
		}), /* @__PURE__ */ jsx("dd", {
			className: cn("m-0 fr-overflow font-secondary text-fr-sm leading-none font-medium tabular-nums", quiet ? "text-fr-text-2" : "text-fr-text"),
			children: value
		})]
	});
}
/** The agent's vitals as one instrument strip on a solid card (the Autonomy
*  page's `VitalsStrip`): each cell a small glyph beside the reading, which
*  leads, over its label. Two across a page at its floor, three from 28rem,
*  six across a wide one; a reading wraps rather than ellipsizes. */
function VitalsStrip({ vitals, caption, className }) {
	return /* @__PURE__ */ jsxs("div", {
		"data-slot": "agent-vitals",
		className: cn("overflow-hidden rounded-lg border border-fr-border-soft bg-fr-surface", className),
		children: [/* @__PURE__ */ jsx("dl", {
			className: "m-0 grid grid-cols-2 gap-y-1 py-1 @md:grid-cols-3 @4xl:grid-cols-6",
			children: vitals.map((vital) => /* @__PURE__ */ jsxs("div", {
				title: vital.title,
				className: "flex min-w-0 items-start gap-2 px-3.5 py-2",
				children: [/* @__PURE__ */ jsx("span", {
					"aria-hidden": "true",
					className: "flex size-5 shrink-0 items-center justify-center rounded-md text-fr-text-2",
					children: /* @__PURE__ */ jsx(Icon, {
						name: vital.icon,
						size: 12,
						strokeWidth: 2
					})
				}), /* @__PURE__ */ jsxs("div", {
					className: "flex min-w-0 flex-col-reverse gap-1.5",
					children: [/* @__PURE__ */ jsx("dt", {
						className: cn("leading-tight break-words", LABEL),
						children: vital.label
					}), /* @__PURE__ */ jsx("dd", {
						className: cn("m-0 font-secondary text-fr-lg leading-tight break-words tabular-nums", vital.quiet ? "font-medium text-fr-text-2" : "font-semibold text-fr-text"),
						children: vital.value
					})]
				})]
			}, vital.key))
		}), caption ? /* @__PURE__ */ jsx("p", {
			className: "m-0 border-t border-fr-border-soft px-3.5 py-2 font-secondary text-fr-2xs text-fr-text-2",
			children: caption
		}) : null]
	});
}
/** Whether `ref`'s element is on screen or near it (300px). A face's frame,
*  WebGL context or sandboxed iframe is paid for only while it can be seen. */
function useNearViewport() {
	const ref = useRef(null);
	const [near, setNear] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element || typeof IntersectionObserver === "undefined") {
			setNear(true);
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			for (const entry of entries) setNear(entry.isIntersecting);
		}, { rootMargin: "300px" });
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return [ref, near];
}
/** A face on its tile: the agent's accent washed behind it, still unless
*  `live` (the hovered or focused card), mounted only near the viewport, with
*  the name's initial underneath for a face that paints nothing (the user's
*  Vibr switch off, a contributed face whose pack is gone). */
function FaceTile({ face, tile, presence, live, bridged, name, className, ring = true }) {
	const [ref, near] = useNearViewport();
	const initial = name.charAt(0).toUpperCase();
	return /* @__PURE__ */ jsxs("span", {
		ref,
		"aria-hidden": "true",
		"data-slot": "agent-face",
		"data-live": live || void 0,
		className: cn("relative isolate flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-fr-bg", ring && "border border-fr-border-soft", className),
		style: {
			width: tile,
			height: tile
		},
		children: [/* @__PURE__ */ jsx("span", {
			className: "absolute inset-0",
			style: { background: `radial-gradient(circle at 50% 42%, ${faceWash(face, 26)}, transparent 72%)` }
		}), near && face.avatar !== "none" ? /* @__PURE__ */ jsx("span", {
			className: "relative flex items-center justify-center",
			style: {
				width: presence,
				height: presence
			},
			children: /* @__PURE__ */ jsx(PresenceSurface, {
				avatar: face.avatar,
				skin: face.skin,
				accent: face.accent,
				bridgedPresences: bridged,
				size: presence,
				state: "idle",
				mode: "",
				energy: live ? .35 : 0,
				...live ? {} : { motion: "still" }
			})
		}) : /* @__PURE__ */ jsx("span", {
			className: "relative font-secondary text-fr-lg font-semibold text-fr-text-3",
			children: initial
		})]
	});
}
/** Only a human sets this (doc 58 §3): the lock, spoken once in words by the
*  profile's legend and marked per control with this glyph. */
function GrantLock({ className }) {
	return /* @__PURE__ */ jsx("span", {
		"data-slot": "grant-lock",
		role: "img",
		"aria-label": "Only you can change this",
		title: "Only you can change this",
		className: cn("inline-flex text-fr-text-2", className),
		children: /* @__PURE__ */ jsx(Icon, {
			name: "lock",
			size: 12,
			strokeWidth: 2,
			"aria-hidden": "true"
		})
	});
}
/** One option of a choice drawn as a card: its glyph on a tile, its name, and
*  what it means. A radio in a radiogroup; checked reads in the accent. */
function ChoiceCard({ icon, title, detail, checked, disabled, onSelect, illustration }) {
	return /* @__PURE__ */ jsxs("button", {
		type: "button",
		role: "radio",
		"aria-checked": checked,
		disabled,
		onClick: onSelect,
		className: cn("group/choice relative flex min-w-0 flex-col items-start gap-2.5 rounded-lg border p-3.5 text-left fr-t-colors", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line", checked ? "border-fr-accent-line bg-fr-accent-dim" : "border-fr-border-soft bg-fr-surface", disabled ? "cursor-default" : checked ? "" : "hover:border-fr-border hover:bg-fr-surface-2", disabled && !checked && "opacity-60"),
		children: [
			illustration ?? /* @__PURE__ */ jsx("span", {
				className: cn("flex size-8 items-center justify-center rounded-md", checked ? "bg-fr-accent text-fr-accent-ink" : "bg-fr-surface-3 text-fr-text-2"),
				children: /* @__PURE__ */ jsx(Icon, {
					name: icon,
					size: 16,
					strokeWidth: 1.8
				})
			}),
			/* @__PURE__ */ jsxs("span", {
				className: "flex min-w-0 flex-col gap-0.5",
				children: [/* @__PURE__ */ jsx("span", {
					className: cn("text-fr-sm font-semibold", checked ? "text-fr-text" : "text-fr-text"),
					children: title
				}), /* @__PURE__ */ jsx("span", {
					className: "text-fr-xs leading-relaxed text-pretty text-fr-text-2",
					children: detail
				})]
			}),
			checked ? /* @__PURE__ */ jsx("span", {
				"aria-hidden": "true",
				className: "absolute top-3 right-3 flex size-4 items-center justify-center rounded-full bg-fr-accent text-fr-accent-ink",
				children: /* @__PURE__ */ jsx(Icon, {
					name: "check",
					size: 10,
					strokeWidth: 3
				})
			}) : null
		]
	});
}
/** A labelled group of choice cards (one radiogroup). */
function ChoiceGroup({ label, columns = 3, children }) {
	return /* @__PURE__ */ jsx("div", {
		role: "radiogroup",
		"aria-label": label,
		className: cn("grid grid-cols-1 gap-2.5", columns === 2 ? "@xl:grid-cols-2" : columns === 3 ? "@xl:grid-cols-3" : "@xl:grid-cols-2 @4xl:grid-cols-4"),
		children
	});
}
/** A labelled field row inside a panel: the label and its hint on the left, the
*  control on the right; stacks on a narrow page. */
function FieldRow({ label, hint, locked, children }) {
	return /* @__PURE__ */ jsxs("div", {
		className: "flex flex-col gap-2 @2xl:flex-row @2xl:items-start @2xl:gap-6",
		children: [/* @__PURE__ */ jsxs("div", {
			className: "flex w-full shrink-0 flex-col gap-0.5 @2xl:w-56",
			children: [/* @__PURE__ */ jsxs("span", {
				className: "flex items-center gap-1.5 text-fr-sm font-medium text-fr-text",
				children: [label, locked ? /* @__PURE__ */ jsx(GrantLock, {}) : null]
			}), hint ? /* @__PURE__ */ jsx("span", {
				className: "text-fr-xs leading-relaxed text-fr-text-2",
				children: hint
			}) : null]
		}), /* @__PURE__ */ jsx("div", {
			className: "min-w-0 flex-1",
			children
		})]
	});
}
/** The page's one panel: a bordered surface holding a section's body. */
var PANEL = "rounded-lg border border-fr-border-soft bg-fr-surface";
/** An "add one" control: a search field that lists what matches beneath it,
*  each a button. The kit grants no menu primitive to a pack, and a native
*  select cannot draw a face or a vendor mark. */
function PickList({ placeholder, options, onPick, disabled }) {
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const needle = query.trim().toLowerCase();
	const shown = (needle === "" ? options : options.filter((option) => `${option.id} ${option.label} ${option.detail ?? ""}`.toLowerCase().includes(needle))).slice(0, 8);
	return /* @__PURE__ */ jsxs("div", {
		className: "relative w-full max-w-md",
		onBlur: (event) => {
			if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
		},
		children: [
			/* @__PURE__ */ jsx(Icon, {
				name: "plus",
				size: 13,
				strokeWidth: 2,
				className: "pointer-events-none absolute top-1/2 left-2.5 z-[1] -translate-y-1/2 text-fr-text-3"
			}),
			/* @__PURE__ */ jsx(Input, {
				size: "sm",
				value: query,
				disabled,
				placeholder,
				"aria-label": placeholder,
				onFocus: () => setOpen(true),
				onChange: (event) => {
					setQuery(event.target.value);
					setOpen(true);
				},
				className: "pl-8"
			}),
			open && !disabled ? /* @__PURE__ */ jsxs("ul", {
				className: "absolute top-full right-0 left-0 z-20 m-0 mt-1 flex max-h-72 list-none flex-col overflow-y-auto rounded-md border border-fr-border bg-fr-surface p-1 shadow-md",
				children: [shown.length === 0 ? /* @__PURE__ */ jsx("li", {
					className: "px-2.5 py-2 text-fr-xs text-fr-text-2",
					children: "Nothing matches."
				}) : null, shown.map((option) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsxs("button", {
					type: "button",
					onClick: () => {
						onPick(option.id);
						setQuery("");
						setOpen(false);
					},
					className: "flex w-full min-w-0 items-center gap-2.5 rounded-sm px-2 py-1.5 text-left fr-t-colors hover:bg-fr-surface-2 focus-visible:bg-fr-surface-2 focus-visible:outline-none",
					children: [option.lead, /* @__PURE__ */ jsxs("span", {
						className: "flex min-w-0 flex-col",
						children: [/* @__PURE__ */ jsx("span", {
							className: "fr-overflow text-fr-sm text-fr-text",
							children: option.label
						}), option.detail ? /* @__PURE__ */ jsx("span", {
							className: "fr-overflow font-secondary text-fr-xs text-fr-text-2",
							children: option.detail
						}) : null]
					})]
				}) }, option.id))]
			}) : null
		]
	});
}
//#endregion
//#region src/guards.ts
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
//#endregion
//#region src/extra.ts
var KEY_LINE = /^( *)("[^"]+"|'[^']+'|[A-Za-z0-9_][\w./-]*) *:(?: +(.*))?$/;
function indentOf(line) {
	return line.length - line.trimStart().length;
}
function isBlank(line) {
	return line.trim() === "";
}
function unquote(key) {
	return key.startsWith("\"") || key.startsWith("'") ? key.slice(1, -1) : key;
}
/** Split `lines` into the blocks whose key line sits at exactly `indent`. */
function splitLevel(lines, indent) {
	const blocks = [];
	const stray = [];
	let current = null;
	let pending = [];
	for (const line of lines) {
		const match = KEY_LINE.exec(line);
		if (match && (match[1] ?? "").length === indent) {
			current = {
				key: unquote(match[2] ?? ""),
				lines: [...pending, line],
				rest: match[3] ?? ""
			};
			pending = [];
			blocks.push(current);
		} else if (isBlank(line) || line.trimStart().startsWith("#") && indentOf(line) <= indent) pending.push(line);
		else if (current) {
			current.lines.push(...pending, line);
			pending = [];
		} else {
			stray.push(line);
			pending = [];
		}
	}
	for (const block of blocks) {
		while (block.lines.length > 0 && isBlank(block.lines[0] ?? "")) block.lines.shift();
		while (block.lines.length > 0 && isBlank(block.lines[block.lines.length - 1] ?? "")) block.lines.pop();
	}
	return {
		blocks,
		stray
	};
}
function describe(raw, depth) {
	const inline = raw.rest.replace(/^#.*$/, "").replace(/\s+#.*$/, "").trim();
	const keyAt = raw.lines.findIndex((line) => {
		const match = KEY_LINE.exec(line);
		return match !== null && unquote(match[2] ?? "") === raw.key;
	});
	const body = raw.lines.slice(keyAt + 1);
	const first = body.find((line) => !isBlank(line) && !line.trimStart().startsWith("#"));
	const base = {
		key: raw.key,
		lines: raw.lines,
		inline
	};
	if (depth > 0 || inline !== "") return {
		...base,
		children: null,
		childIndent: 0
	};
	if (first === void 0) return {
		...base,
		children: [],
		childIndent: 2
	};
	const childIndent = indentOf(first);
	if (childIndent === 0 || !KEY_LINE.test(first)) return {
		...base,
		children: null,
		childIndent: 0
	};
	return {
		...base,
		children: splitLevel(body, childIndent).blocks.map((child) => describe(child, 1)),
		childIndent
	};
}
/** Read `text` as the two-level mapping a manifest is. Never throws: what it
*  cannot place is reported in `stray`; YAML itself is the server's to judge. */
function parseExtra(text) {
	const { blocks, stray } = splitLevel(text.replace(/\r\n?/g, "\n").split("\n"), 0);
	return {
		blocks: blocks.map((block) => describe(block, 0)),
		stray
	};
}
/** Every path the text names: `key`, and `key.child` for a block mapping. */
function extraPaths(blocks) {
	const paths = /* @__PURE__ */ new Set();
	for (const block of blocks) {
		paths.add(block.key);
		for (const child of block.children ?? []) paths.add(`${block.key}.${child.key}`);
	}
	return paths;
}
/** Each path's text, so two readings of the same file compare. A section's keys are paths of their own (`key.child`,
*  at 2 spaces whatever the depth they were written at); every other block is one path. */
function pathTexts(blocks) {
	const texts = /* @__PURE__ */ new Map();
	for (const block of blocks) if (block.children === null || block.children.length === 0) texts.set(block.key, block.lines.join("\n"));
	else for (const child of block.children) texts.set(`${block.key}.${child.key}`, reindent(child.lines, block.childIndent, 2).join("\n"));
	return texts;
}
/**
* The paths whose text differs between two readings of the same "Everything else": added, changed or gone, in the
* order the second reads them (the gone ones last). What marks the parts of Other settings a proposal moved: the
* proposal banner names fields, and `extra` alone says nothing about WHICH of its keys changed.
*/
function changedExtraPaths(before, after) {
	const was = pathTexts(parseExtra(before).blocks);
	const now = pathTexts(parseExtra(after).blocks);
	const changed = [...now].filter(([path, text]) => was.get(path) !== text).map(([path]) => path);
	const gone = [...was.keys()].filter((path) => !now.has(path));
	return [...changed, ...gone];
}
/** `lines` moved from `from` spaces of indent to `to` — what lets one section
*  hold the profile's keys (written at 2) and the author's (written at any depth). */
function reindent(lines, from, to) {
	return lines.map((line) => isBlank(line) ? "" : " ".repeat(to) + line.slice(Math.min(from, indentOf(line))));
}
/** A block mapping's children as lines at `indent` spaces. */
function childLines(block, indent) {
	return (block.children ?? []).flatMap((child) => reindent(child.lines, block.childIndent, indent));
}
/**
* Lay `patch` over `base`, path by path: a key the patch names replaces the
* same key in `base` (a section merges child by child), the rest of `base` is
* kept as written, and new keys are appended. Both are YAML mapping text.
*/
function overlayExtra(base, patch) {
	const target = parseExtra(base).blocks.map((block) => ({
		block,
		lines: [...block.lines]
	}));
	for (const incoming of parseExtra(patch).blocks) {
		const at = target.findIndex((entry) => entry.block.key === incoming.key);
		const entry = target[at];
		if (entry === void 0) target.push({
			block: incoming,
			lines: [...incoming.lines]
		});
		else if (entry.block.children === null || incoming.children === null) target[at] = {
			block: incoming,
			lines: [...incoming.lines]
		};
		else {
			const merged = /* @__PURE__ */ new Map();
			for (const child of entry.block.children) merged.set(child.key, reindent(child.lines, entry.block.childIndent, 2));
			for (const child of incoming.children) merged.set(child.key, reindent(child.lines, incoming.childIndent, 2));
			target[at] = {
				block: incoming,
				lines: [`${incoming.key}:`, ...[...merged.values()].flat()]
			};
		}
	}
	return target.map((entry) => entry.lines.join("\n")).join("\n");
}
/** Sections every key of which grants something (an approval mode, a workspace). */
var GRANT_SECTIONS = {
	gate: true,
	workspace: true
};
/** Sections that hold some grants and some harmless keys. */
var MIXED_SECTIONS = {
	capabilities: true,
	subagents: true
};
/**
* The manifest keys that GRANT — tool reach, approval, workspace reach, the
* control lanes, plugins, MCP, delegation, harnesses (doc 58 §3; the flat
* `tools` and `spawns` are the legacy spellings of two of them). Only a human
* gesture on the profile sets these; the model's `forge_propose` never does.
*
* `capabilities.ignore` is one: it is subtractive and wins over every allowlist
* (the engine applies it AFTER them, `agent-root.ts`), so an agent's reach is
* `capabilities.tools` minus `capabilities.ignore`. Emptying it widens the reach
* exactly as editing `tools` does, and `optIn` is already a grant for being
* additive. Naming it, to add or to remove, is refused whole like the rest.
*/
var GRANT_PATHS = {
	"capabilities.tools": true,
	"capabilities.mcp": true,
	"capabilities.plugins": true,
	"capabilities.control": true,
	"capabilities.optIn": true,
	"capabilities.ignore": true,
	"subagents.allowed": true,
	harness: true,
	allowedHarnesses: true,
	tools: true,
	spawns: true
};
/**
* The rule. Each top-level key comes with the keys under it: a list, or `null`
* when a value is there that cannot be read key by key. A mixed section
* (`capabilities`, `subagents`) with `null` counts as holding a grant — inline,
* a flow mapping or explicit keys on the next line, a sequence — because the
* keys it really names are unknown.
*/
function grantPathsOf(sections) {
	const found = [];
	for (const [key, children] of sections) if (Object.hasOwn(GRANT_SECTIONS, key) || Object.hasOwn(GRANT_PATHS, key)) found.push(key);
	else if (Object.hasOwn(MIXED_SECTIONS, key)) {
		if (children === null) found.push(`${key} (inline)`);
		else for (const child of children) if (Object.hasOwn(GRANT_PATHS, `${key}.${child}`)) found.push(`${key}.${child}`);
	}
	return found;
}
/**
* The grant-class paths `text` names. `parseExtra` gives a section
* `children: null` exactly when something follows its key line that is not a
* block mapping of `key: value` lines; an empty section, or one holding only
* comments, has `[]`.
*/
function grantPathsIn(text) {
	return grantPathsOf(parseExtra(text).blocks.map((block) => [block.key, block.children === null ? null : block.children.map((child) => child.key)]));
}
//#endregion
//#region page/roster.ts
/** Prefer the engine's explicit scope; preserve the previous display for older engines. */
function tierOfFact(fact) {
	if (fact.scope === "plugin") return "pack";
	if (fact.scope === "project") return "workspace";
	if (fact.scope === "global") return "user";
	if (fact.pluginId !== void 0) return "pack";
	if (fact.provenance === "local") return "user";
	if (fact.provenance === "workspace") return "workspace";
	return "pack";
}
/** Host facts first (their order is the catalog's), then files the host does
*  not list (a project agent of a workspace the host is not showing). */
function joinRoster(facts, listed) {
	const files = new Map((listed ?? []).map((agent) => [agent.name, agent]));
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const fact of facts ?? []) {
		if (seen.has(fact.name)) continue;
		seen.add(fact.name);
		const file = files.get(fact.name);
		out.push({
			name: fact.name,
			fact,
			...file !== void 0 ? { listed: file } : {},
			tier: file?.source ?? tierOfFact(fact)
		});
	}
	for (const file of listed ?? []) {
		if (seen.has(file.name)) continue;
		seen.add(file.name);
		out.push({
			name: file.name,
			listed: file,
			tier: file.source
		});
	}
	return out;
}
var FACETS = [
	"all",
	"yours",
	"packs",
	"project",
	"off"
];
var FACET_LABEL = {
	all: "All",
	yours: "Yours",
	packs: "From packs",
	project: "This project",
	off: "Off"
};
var FACET_TIER = {
	yours: "user",
	packs: "pack",
	project: "workspace"
};
/** Whether `agent` belongs under `facet`. `off` is the host's word: an agent
*  the host lends no record for is not known to be off. */
function inFacet(agent, facet) {
	if (facet === "all") return true;
	if (facet === "off") return agent.fact?.enabled === false;
	return agent.tier === FACET_TIER[facet];
}
function facetCounts(agents) {
	const counts = {
		all: 0,
		yours: 0,
		packs: 0,
		project: 0,
		off: 0
	};
	for (const facet of FACETS) counts[facet] = agents.filter((agent) => inFacet(agent, facet)).length;
	return counts;
}
/** The tier, as a person says it: the card's badge, in the filter pills' words. */
var TIER_LABEL = {
	pack: "From a pack",
	user: "Yours",
	workspace: "This project"
};
/** A host-only record remains visible, but the page cannot read a file it may edit. */
function isEditable(agent) {
	return agent.tier !== "pack" && agent.listed?.editable === true;
}
/** A scalar written in YAML, unquoted: `"Chief of Staff"` → `Chief of Staff`. */
function plain(value) {
	const trimmed = value.trim();
	if (trimmed.startsWith("\"") && trimmed.endsWith("\"") || trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
	return trimmed;
}
/** The value lines of a block: its inline value, or the `- item` lines under it. */
function listOf(block) {
	const inline = block.inline.trim();
	if (inline.startsWith("[") && inline.endsWith("]")) {
		const inner = inline.slice(1, -1).trim();
		return inner === "" ? [] : inner.split(",").map(plain);
	}
	if (inline !== "") return [plain(inline)];
	const items = block.lines.slice(1).map((line) => line.trim()).filter((line) => line.startsWith("- ")).map((line) => plain(line.slice(2)));
	return items.length > 0 ? items : null;
}
function blockAt(extra, path) {
	const [head, child] = path.split(".");
	const top = parseExtra(extra).blocks.find((block) => block.key === head);
	if (child === void 0 || top === void 0) return top;
	return top.children?.find((block) => block.key === child);
}
/** A key of the extra text read as a list (`[a, b]`, `- a` lines or one
*  scalar); `null` when the text does not set it, or sets it as a shape this
*  reader does not read (a mapping) — Advanced shows it as written. */
function extraList(extra, path) {
	const block = blockAt(extra, path);
	if (block === void 0 || block.children !== null) return null;
	return listOf(block);
}
/** A key of the extra text read as one scalar; `null` when it is not set as one. */
function extraScalar(extra, path) {
	const block = blockAt(extra, path);
	if (block === void 0 || block.children !== null || block.inline.trim() === "") return null;
	return plain(block.inline);
}
/** A slug as a person reads it: `release-herald` → `Release herald`. */
function humanize(slug) {
	const words = slug.replace(/-+/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}
/** What the agent is called on screen: the host's `title`, the file's own
*  `title:`, else its name read as words. */
function displayName(agent) {
	return agent.fact?.title ?? (agent.listed ? extraScalar(agent.listed.draft.extra, "title") : null) ?? humanize(agent.name);
}
/** An agent named by its id (a lineage entry), as a person reads it. */
function titleOf(name, roster) {
	const agent = roster.find((candidate) => candidate.name === name);
	return agent === void 0 ? humanize(name) : displayName(agent);
}
/** An agent's allowlist of one kind, off its draft: the drawn list, else the
*  held text in Other settings (`*` or `[]`, a plugins list), else every one. */
function allowlistOf(draft, kind) {
	if (kind !== "plugins" && draft[kind].length > 0) return {
		kind: "some",
		names: draft[kind]
	};
	const held = extraList(draft.extra, `capabilities.${kind}`) ?? (kind === "tools" ? extraList(draft.extra, "tools") : null);
	if (held === null) return { kind: "all" };
	if (held.length === 0) return { kind: "none" };
	if (held.length === 1 && held[0] === "*") return { kind: "all" };
	return {
		kind: "some",
		names: held
	};
}
//#endregion
//#region page/voice.ts
var SPEECH_PROFILES_KEY = "speech/profiles";
var SPEECH_AGENTS_KEY = "speech/agents";
/** The on-device provider: a profile with no reachable entry falls back to it. */
var LOCAL_PROVIDER = "local";
var LAYER_LABELS = {
	workspace: "This project",
	user: "Yours",
	pack: "From a plugin",
	builtin: "Built in"
};
var text = (value) => typeof value === "string" && value !== "" ? value : void 0;
function readReadiness(value) {
	if (!isRecord(value) || typeof value.ready !== "boolean") return void 0;
	const reason = text(value.reason);
	const detail = text(value.detail);
	return {
		ready: value.ready,
		...reason ? { reason } : {},
		...detail ? { detail } : {}
	};
}
function readStep(value) {
	if (!isRecord(value)) return void 0;
	const provider = text(value.provider);
	const model = text(value.model);
	if (!provider || !model) return void 0;
	const voice = text(value.voice);
	return {
		provider,
		model,
		...voice ? { voice } : {}
	};
}
function readProfile(value) {
	if (!isRecord(value)) return void 0;
	const name = text(value.name);
	const layer = value.layer;
	if (!name || layer !== "workspace" && layer !== "user" && layer !== "pack" && layer !== "builtin") return void 0;
	const description = text(value.description);
	return {
		name,
		layer,
		speak: Array.isArray(value.speak) ? value.speak.flatMap((step) => readStep(step) ?? []) : [],
		...description ? { description } : {}
	};
}
function readProvider(value) {
	if (!isRecord(value)) return void 0;
	const id = text(value.id);
	if (!id) return void 0;
	const speak = readReadiness(value.speak);
	return {
		id,
		label: text(value.label) ?? id,
		...speak ? { speak } : {}
	};
}
/** The `speech/profiles` fact; null when the engine published none (no speech lane in this build). */
function readProfilesFact(raw) {
	if (!isRecord(raw)) return null;
	return {
		profiles: Array.isArray(raw.profiles) ? raw.profiles.flatMap((row) => readProfile(row) ?? []) : [],
		providers: Array.isArray(raw.providers) ? raw.providers.flatMap((row) => readProvider(row) ?? []) : [],
		defaultName: isRecord(raw.default) ? text(raw.default.name) ?? null : null
	};
}
/** What a provider that cannot speak is missing: a label (`Needs an API key`) and the same fact as a
*  predicate (`needs an API key`), so a sentence can say WHO is missing it. */
var REASONS = {
	"needs-key": {
		text: "Needs an API key",
		phrase: "needs an API key"
	},
	"needs-download": {
		text: "Needs a download",
		phrase: "needs a download"
	},
	unavailable: {
		text: "Unavailable",
		phrase: "is unavailable"
	}
};
/** One readiness as a sentence a person can act on. */
function stateLine(readiness) {
	if (!readiness) return {
		tone: "off",
		text: "Does not speak",
		phrase: "does not speak"
	};
	if (readiness.ready) return {
		tone: "ok",
		text: "Ready",
		phrase: "is ready"
	};
	const reason = readiness.reason !== void 0 && Object.hasOwn(REASONS, readiness.reason) ? REASONS[readiness.reason] : void 0;
	return {
		tone: "warn",
		text: reason?.text ?? "Not ready",
		phrase: reason?.phrase ?? "is not ready"
	};
}
function stepOf(step, providers) {
	const provider = providers.get(step.provider);
	const state = provider ? stateLine(provider.speak) : {
		tone: "warn",
		text: "Not installed",
		phrase: "is not installed"
	};
	const detail = provider?.speak && !provider.speak.ready ? provider.speak.detail : void 0;
	return {
		providerLabel: provider?.label ?? step.provider,
		model: step.model,
		...step.voice ? { voice: step.voice } : {},
		state,
		...detail ? { detail } : {},
		ready: state.tone === "ok"
	};
}
function profileCards(view) {
	const providers = new Map(view.providers.map((provider) => [provider.id, provider]));
	const local = providers.get(LOCAL_PROVIDER);
	const localReady = local?.speak?.ready === true;
	return view.profiles.map((profile) => {
		const steps = profile.speak.map((step) => stepOf(step, providers));
		const firstReady = steps.findIndex((step) => step.ready);
		const head = steps[0];
		const spoken = steps[firstReady];
		const speaksWith = spoken ? {
			label: spoken.providerLabel,
			fellBack: firstReady > 0
		} : localReady ? {
			label: local?.label ?? "On-device voice",
			fellBack: true
		} : null;
		const blocked = head !== void 0 && firstReady !== 0 ? head : void 0;
		const needs = blocked ? `${blocked.providerLabel} ${blocked.state.phrase}.${blocked.detail ? ` ${blocked.detail}` : ""}` : void 0;
		return {
			name: profile.name,
			layer: profile.layer,
			layerLabel: LAYER_LABELS[profile.layer],
			...profile.description ? { description: profile.description } : {},
			steps,
			speaksWith,
			...needs ? { needs } : {}
		};
	});
}
/** Two letters for a provider's mark: its initials, or its first two characters. */
function monogram(label) {
	const words = label.trim().split(/[\s._-]+/).filter(Boolean);
	return (words.length > 1 ? words.map((word) => word[0] ?? "").join("") : (words[0] ?? "").slice(0, 2)).slice(0, 2).toUpperCase();
}
var SOURCES = /* @__PURE__ */ new Set([
	"session",
	"workspace-config",
	"user-config",
	"agent",
	"default",
	"builtin"
]);
var SOURCE_LABELS = {
	session: "Chosen for this session",
	"workspace-config": "Set for this project",
	"user-config": "Set by you",
	agent: "The agent's own choice",
	default: "The default voice",
	builtin: "The built-in on-device voice"
};
function readLayers(value) {
	if (!isRecord(value)) return void 0;
	const workspace = text(value.workspace);
	const user = text(value.user);
	const agent = text(value.agent);
	return {
		...workspace ? { workspace } : {},
		...user ? { user } : {},
		...agent ? { agent } : {}
	};
}
/** The `speech/agents` fact: agent name to its resolved voice. Empty when the fact is absent. */
function readAgentVoices(raw) {
	const out = /* @__PURE__ */ new Map();
	if (!isRecord(raw)) return out;
	for (const [agent, value] of Object.entries(raw)) {
		if (!isRecord(value)) continue;
		const name = text(value.name);
		const source = text(value.source);
		if (!name || !source || !SOURCES.has(source)) continue;
		const layers = readLayers(value.layers);
		out.set(agent, {
			name,
			source,
			why: text(value.why) ?? "",
			...layers ? { layers } : {}
		});
	}
	return out;
}
var SCOPE_ORDER = [
	"workspace",
	"user",
	"agent"
];
var SCOPE_LABELS = {
	workspace: "This project",
	user: "You",
	agent: "The agent",
	default: "Default"
};
var SCOPE_OF_SOURCE = {
	"workspace-config": "workspace",
	"user-config": "user",
	agent: "agent",
	default: "default",
	builtin: "default"
};
/**
* The four layers, most specific first, with the one the engine says wins marked. Every layer the page can
* write is always a row, so what a pick writes to is always on screen. `agentFile` is the agent's own
* choice as the page holds it (the draft, so an unsaved edit shows at once) and `savedAgentFile` what the
* file holds now: a difference marks the row `pending` and never moves `wins`, which stays the engine's
* word until a save republishes.
*/
function ladder(voice, agentFile, defaultName, savedAgentFile = agentFile) {
	const winning = voice ? SCOPE_OF_SOURCE[voice.source] : void 0;
	const layers = voice?.layers;
	const rows = [];
	for (const scope of SCOPE_ORDER) {
		const wins = winning === scope;
		if (scope === "agent") {
			rows.push({
				scope,
				label: SCOPE_LABELS[scope],
				value: agentFile === "" ? null : agentFile,
				reported: true,
				wins,
				pending: agentFile !== savedAgentFile
			});
			continue;
		}
		const value = layers?.[scope] ?? (wins && voice ? voice.name : null);
		rows.push({
			scope,
			label: SCOPE_LABELS[scope],
			value,
			reported: layers !== void 0 || wins,
			wins,
			pending: false
		});
	}
	const fallback = winning === "default" ? voice?.name ?? defaultName : defaultName;
	rows.push({
		scope: "default",
		label: SCOPE_LABELS.default,
		value: fallback,
		reported: true,
		wins: winning === "default",
		pending: false
	});
	return rows;
}
/** Whether somebody CHOSE this voice (a project, you, or the agent's own file) rather than it being the
*  default. Only a choice is worth a mark on a card: a default voice would be the same chip on every one. */
function isExplicitVoice(voice) {
	return voice !== void 0 && (voice.source === "workspace-config" || voice.source === "user-config" || voice.source === "agent");
}
/** The row, above `scope`, whose choice still outranks one made there; null when none does. */
function outrankedBy(scope, rows) {
	const at = SCOPE_ORDER.indexOf(scope);
	return rows.find((row) => row.scope !== "default" && row.value !== null && SCOPE_ORDER.indexOf(row.scope) < at) ?? null;
}
/** Which layers this page can write right now. A user or project choice is stored by agent name, so
*  it needs the agent to exist (`exists`); the agent's own choice rides in its file, so it needs the
*  file to be writable (`editable`). */
function scopeStates(options) {
	const config = (scope, needsProject) => {
		if (!options.exists) return {
			scope,
			enabled: false,
			reason: "Save the agent first."
		};
		if (!options.canAssign) return {
			scope,
			enabled: false,
			reason: "This build cannot save a voice choice yet."
		};
		if (needsProject && !options.hasWorkspace) return {
			scope,
			enabled: false,
			reason: "Open a project to set one for it."
		};
		return {
			scope,
			enabled: true
		};
	};
	const agent = () => {
		if (!options.editable) return {
			scope: "agent",
			enabled: false,
			reason: "Ships in a pack, so read-only. Extend it to change this."
		};
		if (options.heldInFile) return {
			scope: "agent",
			enabled: false,
			reason: "Its file sets this in Other settings, under Advanced. Change it there."
		};
		return {
			scope: "agent",
			enabled: true
		};
	};
	return [
		config("workspace", true),
		config("user", false),
		agent()
	];
}
/** The layer a pick lands on by default: yours, else the agent's own file. */
function defaultScope(states) {
	return [
		"user",
		"agent",
		"workspace"
	].find((scope) => states.find((state) => state.scope === scope)?.enabled) ?? "user";
}
//#endregion
//#region page/home.tsx
var GRID = "grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3";
/** A label on the hero: text at 80%, which the lit nebula keeps above AA. */
var HERO_LABEL = "font-secondary text-fr-2xs font-semibold tracking-fr-label text-fr-text/80";
var LANES$1 = [
	{
		facet: "yours",
		heading: "Yours"
	},
	{
		facet: "project",
		heading: "This project"
	},
	{
		facet: "packs",
		heading: "From packs",
		note: "Read-only here. Extend one to make an agent of your own that starts from it."
	}
];
function usageOf(usage, name) {
	return usage?.agents.find((row) => row.name === name);
}
/** The live badge: an accent pill while it works, the fixed violet while it waits on you. */
function LivePill({ state, count }) {
	if (state === "idle") return null;
	const needs = state === "needs-you";
	return /* @__PURE__ */ jsxs("span", {
		className: cn("inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-1.5 font-secondary text-fr-xs", needs ? "bg-fr-iris/15 text-fr-iris" : "bg-fr-accent-dim text-fr-accent"),
		children: [
			/* @__PURE__ */ jsx(ActivityDot, { state }),
			needs ? "Needs you" : "Working",
			count > 1 ? /* @__PURE__ */ jsx("span", {
				className: "tabular-nums opacity-80",
				children: count
			}) : null
		]
	});
}
/** What the agent may use, as the Capabilities page draws it: the first few
*  skills, plugins and servers it is limited to as marks and a count of the
*  rest, else what it is not limited in. */
function CapabilityStrip({ agent, catalog, max = 3 }) {
	const draft = agent.listed?.draft;
	const hostTools = agent.fact?.capabilities?.tools;
	const named = useMemo(() => namedCapabilities(draft), [draft]);
	const tools = useMemo(() => toolsSummary(draft, hostTools), [draft, hostTools]);
	const chips = named.slice(0, max).map((item) => /* @__PURE__ */ jsx(CapabilityChip, {
		mark: markOf(item.kind, item.name, catalog, 14),
		label: humanize(item.name)
	}, `${item.kind}:${item.name}`));
	const rest = Math.max(0, named.length - max);
	return /* @__PURE__ */ jsxs("div", {
		"data-slot": "agent-capabilities",
		className: "flex min-h-7 min-w-0 flex-wrap items-center gap-1.5",
		children: [
			chips,
			rest > 0 ? /* @__PURE__ */ jsxs("span", {
				className: "rounded-sm bg-fr-surface-3 px-2 py-1 font-secondary text-fr-xs text-fr-text-2 tabular-nums",
				children: ["+", rest]
			}) : null,
			tools !== null ? /* @__PURE__ */ jsxs("span", {
				className: cn("inline-flex items-center gap-1.5 font-secondary text-fr-xs text-fr-text-2", chips.length === 0 && "rounded-sm bg-fr-surface-3 px-2 py-1"),
				children: [/* @__PURE__ */ jsx(Icon, {
					name: tools.every ? "layers" : "sliders",
					size: 12,
					strokeWidth: 2,
					"aria-hidden": "true"
				}), tools.words]
			}) : null
		]
	});
}
/** The skills, plugins and servers a draft is limited to, in the order the strip draws them. */
function namedCapabilities(draft) {
	const named = [];
	if (draft === void 0) return named;
	for (const kind of [
		"skills",
		"plugins",
		"mcp"
	]) {
		const list = allowlistOf(draft, kind);
		if (list.kind === "some") for (const name of list.names) named.push({
			kind,
			name
		});
	}
	return named;
}
/** The agent's tool reach in words: its file's allowlist, else the host's count. */
function toolsSummary(draft, hostTools) {
	if (draft !== void 0) {
		const list = allowlistOf(draft, "tools");
		if (list.kind === "all") return {
			words: "Every tool",
			every: true
		};
		if (list.kind === "none") return {
			words: "No tools",
			every: false
		};
		return {
			words: `${list.names.length} ${list.names.length === 1 ? "tool" : "tools"}`,
			every: false
		};
	}
	if (hostTools === void 0) return null;
	if (hostTools === "all") return {
		words: "Every tool",
		every: true
	};
	return {
		words: `${hostTools} ${hostTools === 1 ? "tool" : "tools"}`,
		every: false
	};
}
/** The mark of one capability, drawn from the catalog record when there is one. */
function markOf(kind, name, catalog, size) {
	if (kind === "plugins") {
		const plugin = catalog?.plugins.find((record) => pluginMatches(record.name, name));
		return /* @__PURE__ */ jsx(PluginMark, {
			plugin: plugin ?? { name },
			size
		});
	}
	if (kind === "skills") {
		const skill = catalog?.skills.find((record) => record.name === name);
		const owner = skill?.pluginId === void 0 ? void 0 : catalog?.plugins.find((record) => record.id === skill.pluginId);
		return /* @__PURE__ */ jsx(SkillMark, {
			name,
			...owner !== void 0 ? { pluginIcon: owner } : {},
			size
		});
	}
	return /* @__PURE__ */ jsx(McpMark, {
		name,
		size
	});
}
/** A plugin allowlist entry names a package, or its unscoped basename. */
function pluginMatches(recordName, entry) {
	if (recordName === entry) return true;
	return (recordName.startsWith("@") ? recordName.slice(recordName.indexOf("/") + 1) : recordName) === entry;
}
function standing(activity, state, now) {
	if (state === "needs-you") return {
		text: activity.needsYou === 1 ? "Waiting on your answer" : `${activity.needsYou} sessions waiting on you`,
		tone: "iris"
	};
	if (state === "working") return {
		text: activity.working === 1 ? "Working now" : `Working in ${activity.working} sessions`,
		tone: "accent"
	};
	return {
		text: activity.lastActive === null ? "Never used" : `Last active · ${agoLabel(activity.lastActive, now)}`,
		tone: "mute"
	};
}
/** Memoized: the page re-renders on every coalesced session update, and a card
*  whose props are the same objects as last time draws the same thing. Its
*  handlers take the name, so one stable function serves every card. */
var AgentCard = memo(function AgentCard({ agent, activity, usage, now, face, bridged, catalog, voice, busy, onOpen, onToggle }) {
	const [live, setLive] = useState(false);
	const state = liveStateOf(activity);
	const stand = standing(activity, state, now);
	const title = displayName(agent);
	const enabled = agent.fact?.enabled !== false;
	const description = agent.fact?.description ?? agent.listed?.description ?? "";
	return /* @__PURE__ */ jsxs("article", {
		"data-slot": "agent-card",
		"data-state": state,
		onPointerEnter: () => setLive(true),
		onPointerLeave: () => setLive(false),
		onFocus: () => setLive(true),
		onBlur: (event) => {
			if (!event.currentTarget.contains(event.relatedTarget)) setLive(false);
		},
		className: cn("group/card relative flex flex-col overflow-hidden rounded-lg border bg-fr-surface fr-t-colors", state === "needs-you" ? "border-fr-iris/40 hover:border-fr-iris/70" : "border-fr-border-soft hover:border-fr-border"),
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "flex items-start gap-3.5 px-4 pt-4",
				children: [
					/* @__PURE__ */ jsx(FaceTile, {
						face,
						tile: 64,
						presence: 52,
						live,
						bridged,
						name: title,
						className: cn(!enabled && "opacity-55 saturate-0")
					}),
					/* @__PURE__ */ jsxs("div", {
						className: "flex min-w-0 flex-1 flex-col gap-1 pt-0.5",
						children: [
							/* @__PURE__ */ jsxs("h3", {
								className: "m-0 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1",
								children: [
									/* @__PURE__ */ jsx("button", {
										type: "button",
										onClick: onOpen === void 0 ? void 0 : () => onOpen(agent.name),
										disabled: onOpen === void 0,
										title: agent.name,
										className: cn("min-w-0 fr-overflow text-left text-fr-md font-semibold fr-t-colors after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-fr-accent-line disabled:cursor-default", enabled ? "text-fr-text" : "text-fr-text-2"),
										children: title
									}),
									/* @__PURE__ */ jsx(Badge, {
										tone: "mute",
										variant: "soft",
										children: TIER_LABEL[agent.tier]
									}),
									/* @__PURE__ */ jsx(LivePill, {
										state,
										count: state === "needs-you" ? activity.needsYou : activity.working
									})
								]
							}),
							/* @__PURE__ */ jsx("p", {
								className: "m-0 line-clamp-2 min-h-[2lh] text-fr-sm leading-relaxed text-pretty text-fr-text-2",
								children: description || "No description yet."
							}),
							agent.listed === void 0 ? /* @__PURE__ */ jsx("p", {
								className: "m-0 text-fr-xs text-fr-text-3",
								children: "The page cannot read this agent's file from here, so it is read-only. If it is your own agent, check that its folder is under general-agents/."
							}) : null
						]
					}),
					onToggle !== void 0 ? /* @__PURE__ */ jsx("span", {
						className: "relative z-[1] pt-0.5",
						children: /* @__PURE__ */ jsx(Switch, {
							"aria-label": `${title} enabled`,
							checked: enabled,
							disabled: busy,
							onCheckedChange: (on) => onToggle(agent.name, on)
						})
					}) : /* @__PURE__ */ jsx("span", {
						className: cn("relative pt-1 font-secondary text-fr-xs", enabled ? "text-fr-text-2" : "text-fr-text-3"),
						children: enabled ? "On" : "Off"
					})
				]
			}),
			/* @__PURE__ */ jsx("div", {
				className: "mx-4 mt-3.5 rounded-lg border border-fr-border-soft bg-fr-bg px-3 py-2.5 fr-t-colors group-hover/card:border-fr-border",
				children: /* @__PURE__ */ jsx(CapabilityStrip, {
					agent,
					catalog
				})
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "mt-auto flex items-center justify-between gap-3 px-4 pt-3",
				children: [/* @__PURE__ */ jsxs("span", {
					className: cn("flex min-w-0 items-center gap-2 font-secondary text-fr-xs", stand.tone === "accent" ? "text-fr-accent" : stand.tone === "iris" ? "text-fr-iris" : "text-fr-text-2"),
					children: [/* @__PURE__ */ jsx(ActivityDot, { state: state === "idle" ? enabled ? "idle" : "off" : state }), /* @__PURE__ */ jsx("span", {
						className: "fr-overflow",
						children: stand.text
					})]
				}), /* @__PURE__ */ jsxs("span", {
					className: "flex shrink-0 items-center gap-2.5",
					children: [isExplicitVoice(voice) ? /* @__PURE__ */ jsxs("span", {
						title: `Speaks with ${voice.name}. ${SOURCE_LABELS[voice.source]}.`,
						className: "flex min-w-0 items-center gap-1 font-secondary text-fr-xs text-fr-text-2",
						children: [/* @__PURE__ */ jsx(Icon, {
							name: "waveform",
							size: 12,
							strokeWidth: 1.8,
							"aria-hidden": "true"
						}), /* @__PURE__ */ jsx("span", {
							className: "fr-overflow max-w-24",
							children: voice.name
						})]
					}) : null, agent.fact !== void 0 && enabled && !agent.fact.listed ? /* @__PURE__ */ jsx("span", {
						className: "font-secondary text-fr-xs text-fr-text-2",
						children: "Hidden from rail"
					}) : null]
				})]
			}),
			/* @__PURE__ */ jsxs("dl", {
				className: "m-0 mt-3 grid grid-cols-4 divide-x divide-fr-border-soft border-t border-fr-border-soft",
				children: [
					/* @__PURE__ */ jsx(CardStat, {
						value: `${activity.sessions7d}`,
						label: "Sessions 7d",
						title: `${activity.sessions7d} sessions active in the last 7 days, ${activity.sessionsTotal} in all`,
						quiet: activity.sessions7d === 0
					}),
					/* @__PURE__ */ jsx(CardStat, {
						value: usage ? tokenLabel(usage.tokens) : "–",
						label: "Tokens 7d",
						title: usage ? `${usage.tokens.toLocaleString("en-US")} tokens in the last 7 days` : "Not measured yet",
						quiet: !usage || usage.tokens === 0
					}),
					/* @__PURE__ */ jsx(CardStat, {
						value: usage ? money(usage.cost) : "–",
						label: "Cost 7d",
						title: usage ? `${money(usage.cost)} in the last 7 days` : "Not measured yet",
						quiet: !usage || usage.cost === 0
					}),
					/* @__PURE__ */ jsx(CardStat, {
						value: `${activity.roomsLed}`,
						label: "Rooms led",
						title: `Leads ${activity.roomsLed} ${activity.roomsLed === 1 ? "room" : "rooms"}`,
						quiet: activity.roomsLed === 0
					})
				]
			})
		]
	});
});
function HomeSkeleton() {
	return /* @__PURE__ */ jsxs("div", {
		role: "status",
		"aria-busy": "true",
		className: GRID,
		children: [/* @__PURE__ */ jsx("span", {
			className: "sr-only",
			children: "Loading your agents…"
		}), [
			0,
			1,
			2,
			3,
			4,
			5
		].map((key) => /* @__PURE__ */ jsxs("div", {
			className: "flex flex-col gap-3.5 rounded-lg border border-fr-border-soft bg-fr-surface p-4",
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "flex items-start gap-3.5",
					children: [/* @__PURE__ */ jsx(Skeleton, {
						className: "size-16 shrink-0",
						rounded: "lg"
					}), /* @__PURE__ */ jsxs("div", {
						className: "flex min-w-0 flex-1 flex-col gap-2 pt-1",
						children: [
							/* @__PURE__ */ jsx(Skeleton, {
								className: "h-4 w-32",
								rounded: "sm"
							}),
							/* @__PURE__ */ jsx(Skeleton, {
								className: "h-3 w-full max-w-56",
								rounded: "sm"
							}),
							/* @__PURE__ */ jsx(Skeleton, {
								className: "h-3 w-40",
								rounded: "sm"
							})
						]
					})]
				}),
				/* @__PURE__ */ jsx(Skeleton, {
					className: "h-11 w-full",
					rounded: "lg"
				}),
				/* @__PURE__ */ jsx(Skeleton, {
					className: "h-3 w-36",
					rounded: "sm"
				}),
				/* @__PURE__ */ jsx(Skeleton, {
					className: "h-9 w-full",
					rounded: "sm"
				})
			]
		}, key))]
	});
}
/** Things to say to the Machinist, which builds agents with you. */
var ASK_FOR = [
	"An agent that writes our changelog in my voice",
	"A researcher that reads papers and keeps notes",
	"A reviewer that only comments, never edits"
];
function EmptyHome({ onCreate, onDock }) {
	return /* @__PURE__ */ jsxs("div", {
		className: "grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3.5 gap-y-5 rounded-lg border border-fr-border-soft bg-fr-surface px-5 py-6",
		children: [
			/* @__PURE__ */ jsx("span", {
				className: "flex size-10 items-center justify-center rounded-lg bg-fr-surface-3 text-fr-text-2",
				children: /* @__PURE__ */ jsx(Icon, {
					name: "bot",
					size: 20,
					strokeWidth: 1.7
				})
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex min-w-0 flex-col gap-1",
				children: [/* @__PURE__ */ jsx("h2", {
					className: "m-0 text-fr-lg font-semibold text-fr-text",
					children: "No agents here yet"
				}), /* @__PURE__ */ jsx("p", {
					className: "m-0 max-w-prose text-fr-sm leading-relaxed text-pretty text-fr-text-2",
					children: "A General Agent is someone you can open a session as: its own charter, face, tools and memory. Create one by hand, or tell the Machinist what you want and it drafts one for you to accept."
				})]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "col-start-2 flex flex-col gap-3",
				children: [
					/* @__PURE__ */ jsxs("div", {
						className: "flex flex-wrap gap-2",
						children: [/* @__PURE__ */ jsxs(Button, {
							size: "sm",
							onClick: onCreate,
							children: [/* @__PURE__ */ jsx(Icon, {
								name: "plus",
								strokeWidth: 2
							}), "Create agent"]
						}), onDock ? /* @__PURE__ */ jsxs(Button, {
							size: "sm",
							variant: "outline",
							onClick: onDock,
							children: [/* @__PURE__ */ jsx(Icon, {
								name: "bot",
								strokeWidth: 2
							}), "Ask the Machinist"]
						}) : null]
					}),
					/* @__PURE__ */ jsx("span", {
						className: "font-secondary text-fr-xs text-fr-text-2",
						children: "Try asking the Machinist"
					}),
					/* @__PURE__ */ jsx("ul", {
						className: "m-0 flex list-none flex-col gap-1.5 p-0",
						children: ASK_FOR.map((line) => /* @__PURE__ */ jsxs("li", {
							className: "flex items-baseline gap-2 text-fr-sm text-fr-text",
							children: [/* @__PURE__ */ jsx(Icon, {
								name: "caretR",
								size: 12,
								strokeWidth: 2,
								className: "shrink-0 translate-y-px text-fr-accent"
							}), /* @__PURE__ */ jsxs("span", { children: [
								"“",
								line,
								"”"
							] })]
						}, line))
					})
				]
			})
		]
	});
}
/** The Machinist's undecided proposals, each one a door to its profile. */
function ProposalsBanner({ proposals, roster, faceOf, bridged, onReview }) {
	return /* @__PURE__ */ jsx(Section, {
		title: "Proposed by the Machinist",
		count: proposals.length,
		lede: "Drafts it made while you talked. Open one to accept, change or discard it; nothing is written until you save.",
		children: /* @__PURE__ */ jsx("ul", {
			className: "m-0 grid list-none grid-cols-1 gap-2 p-0 @4xl:grid-cols-2",
			children: proposals.map((entry) => {
				const known = roster.find((agent) => agent.name === entry.proposal.name);
				const fields = Object.keys(entry.proposal).filter((field) => field !== "name");
				return /* @__PURE__ */ jsxs("li", {
					className: "flex items-center gap-3 rounded-lg border border-fr-accent-line bg-fr-accent-dim/40 px-3.5 py-3",
					children: [
						/* @__PURE__ */ jsx(FaceTile, {
							face: entry.proposal.vibr ? { avatar: entry.proposal.vibr } : faceOf(entry.proposal.name),
							tile: 40,
							presence: 32,
							live: false,
							bridged,
							name: entry.proposal.name,
							ring: false
						}),
						/* @__PURE__ */ jsxs("div", {
							className: "flex min-w-0 flex-1 flex-col gap-0.5",
							children: [/* @__PURE__ */ jsx("span", {
								className: "fr-overflow text-fr-sm font-semibold text-fr-text",
								children: known ? `Changes to ${displayName(known)}` : `A new agent: ${humanize(entry.proposal.name)}`
							}), /* @__PURE__ */ jsx("span", {
								className: "fr-overflow font-secondary text-fr-xs text-fr-text-2",
								children: fields.length > 0 ? `Sets ${fields.join(", ")}` : "Names it"
							})]
						}),
						/* @__PURE__ */ jsx(Button, {
							size: "sm",
							variant: "outline",
							onClick: () => onReview(entry),
							children: "Review"
						})
					]
				}, entry.id);
			})
		})
	});
}
function AgentsHome({ roster, loading, listingError, activity, usage, catalog, voices, now, faceOf, bridged, proposals, onReview, onOpen, onCreate, onDock, configure, busy, notice }) {
	const [facet, setFacet] = useState("all");
	const toggle = useCallback((name, on) => void configure?.(name, { enabled: on }), [configure]);
	const counts = facetCounts(roster);
	const filters = [
		"all",
		"yours",
		"project",
		"packs",
		"off"
	].map((id) => ({
		id,
		label: FACET_LABEL[id],
		count: counts[id],
		disabled: id !== "all" && id !== facet && counts[id] === 0
	}));
	const working = roster.filter((agent) => liveStateOf(activity.get(agent.name) ?? NO_ACTIVITY) !== "idle").length;
	const weekCost = usage?.agents.reduce((sum, row) => sum + row.cost, 0);
	const renderCard = (agent) => /* @__PURE__ */ jsx(AgentCard, {
		agent,
		activity: activity.get(agent.name) ?? NO_ACTIVITY,
		usage: usageOf(usage, agent.name),
		now,
		face: faceOf(agent.name),
		bridged,
		catalog,
		voice: voices.get(agent.name),
		busy: busy.has(agent.name),
		onOpen: agent.listed !== void 0 ? onOpen : void 0,
		onToggle: configure !== void 0 && isEditable(agent) && agent.fact !== void 0 ? toggle : void 0
	}, agent.name);
	return /* @__PURE__ */ jsxs(ViewColumn, {
		slot: "general-agents-home",
		children: [
			/* @__PURE__ */ jsxs("header", {
				className: "relative isolate flex flex-wrap items-end justify-between gap-x-6 gap-y-5 overflow-hidden rounded-lg border border-fr-accent-line px-6 pt-8 pb-7 shadow-[inset_0_1px_0_color-mix(in_oklab,var(--fr-text)_10%,transparent)]",
				children: [
					/* @__PURE__ */ jsx(NebulaBackdrop, {
						colors: ["var(--fr-accent)", "var(--fr-iris)"],
						intensity: "lit"
					}),
					/* @__PURE__ */ jsxs("div", {
						className: "relative flex min-w-0 max-w-prose flex-col gap-1.5",
						children: [
							/* @__PURE__ */ jsx("h1", {
								className: "m-0 text-fr-2xl leading-tight font-semibold tracking-[-0.01em] text-balance text-fr-text",
								children: "General Agents"
							}),
							/* @__PURE__ */ jsx("p", {
								className: "m-0 text-fr-sm leading-relaxed text-pretty text-fr-text/80",
								children: "Everyone you can open a session as. Open one to see its face, charter, tools and memory, and change what is yours; extend a pack's agent to make it your own."
							}),
							/* @__PURE__ */ jsxs("div", {
								className: "mt-3 flex flex-wrap gap-2",
								children: [/* @__PURE__ */ jsxs(Button, {
									onClick: onCreate,
									children: [/* @__PURE__ */ jsx(Icon, {
										name: "plus",
										strokeWidth: 2
									}), "Create agent"]
								}), onDock ? /* @__PURE__ */ jsxs(Button, {
									variant: "outline",
									onClick: onDock,
									children: [/* @__PURE__ */ jsx(Icon, {
										name: "bot",
										strokeWidth: 2
									}), "Ask the Machinist"]
								}) : null]
							})
						]
					}),
					roster.length > 0 ? /* @__PURE__ */ jsxs("dl", {
						className: "relative m-0 flex items-end gap-6",
						children: [
							working > 0 ? /* @__PURE__ */ jsxs("div", {
								className: "flex flex-col gap-1",
								children: [/* @__PURE__ */ jsx("dt", {
									className: HERO_LABEL,
									children: "Working"
								}), /* @__PURE__ */ jsxs("dd", {
									className: "m-0 flex items-center gap-2 font-secondary text-fr-lg leading-none font-semibold text-fr-text tabular-nums",
									children: [/* @__PURE__ */ jsx(ActivityDot, { state: "working" }), working]
								})]
							}) : null,
							/* @__PURE__ */ jsxs("div", {
								className: "flex flex-col gap-1",
								children: [/* @__PURE__ */ jsx("dt", {
									className: HERO_LABEL,
									children: roster.length === 1 ? "Agent" : "Agents"
								}), /* @__PURE__ */ jsx("dd", {
									className: "m-0 font-secondary text-fr-lg leading-none font-semibold text-fr-text tabular-nums",
									children: roster.length
								})]
							}),
							weekCost !== void 0 ? /* @__PURE__ */ jsxs("div", {
								className: "flex flex-col gap-1",
								children: [/* @__PURE__ */ jsx("dt", {
									className: HERO_LABEL,
									children: "Cost 7d"
								}), /* @__PURE__ */ jsx("dd", {
									className: "m-0 font-secondary text-fr-lg leading-none font-semibold text-fr-text tabular-nums",
									children: money(weekCost)
								})]
							}) : null
						]
					}) : null
				]
			}),
			proposals.length > 0 ? /* @__PURE__ */ jsx(ProposalsBanner, {
				proposals,
				roster,
				faceOf,
				bridged,
				onReview
			}) : null,
			roster.length > 1 ? /* @__PURE__ */ jsx(MarketplaceFilterPills, {
				filters,
				active: facet,
				onChange: setFacet,
				ariaLabel: "Filter agents"
			}) : null,
			notice ? /* @__PURE__ */ jsx("p", {
				role: "alert",
				className: "m-0 -mt-4 text-fr-xs text-fr-warn",
				children: notice
			}) : null,
			listingError ? /* @__PURE__ */ jsxs("div", {
				role: "alert",
				className: "-mt-2 flex items-start gap-2.5 rounded-lg border border-fr-border-soft bg-fr-surface px-4 py-3",
				children: [/* @__PURE__ */ jsx(Icon, {
					name: "warnTri",
					size: 14,
					strokeWidth: 2,
					className: "mt-0.5 shrink-0 text-fr-warn"
				}), /* @__PURE__ */ jsxs("div", {
					className: "flex min-w-0 flex-col gap-0.5",
					children: [/* @__PURE__ */ jsx("span", {
						className: "text-fr-sm font-medium text-fr-text",
						children: "Could not read the agents' files"
					}), /* @__PURE__ */ jsxs("span", {
						className: "text-fr-xs text-fr-text-2",
						children: [listingError, " Cards show what the host knows; profiles open once the files can be read."]
					})]
				})]
			}) : null,
			loading ? /* @__PURE__ */ jsx(HomeSkeleton, {}) : null,
			!loading && roster.length === 0 ? /* @__PURE__ */ jsx(EmptyHome, {
				onCreate,
				onDock
			}) : null,
			!loading && facet !== "all" ? /* @__PURE__ */ jsx(Section, {
				title: FACET_LABEL[facet],
				count: roster.filter((agent) => inFacet(agent, facet)).length,
				children: /* @__PURE__ */ jsx("div", {
					className: GRID,
					children: roster.filter((agent) => inFacet(agent, facet)).map(renderCard)
				})
			}) : null,
			!loading && facet === "all" ? LANES$1.map((lane) => {
				const inLane = roster.filter((agent) => inFacet(agent, lane.facet));
				if (inLane.length === 0) return null;
				return /* @__PURE__ */ jsx(Section, {
					title: lane.heading,
					count: inLane.length,
					lede: lane.note,
					children: /* @__PURE__ */ jsx("div", {
						className: GRID,
						children: inLane.map(renderCard)
					})
				}, lane.facet);
			}) : null,
			/* @__PURE__ */ jsx("p", {
				className: cn("m-0 -mt-3", LABEL, "font-normal"),
				children: usage ? `Tokens and cost cover the last 7 days, measured ${agoLabel(usage.updatedAt, now)}.` : "Tokens and cost appear once this host measures them."
			})
		]
	});
}
//#endregion
//#region page/profile-save.ts
/** Write what changed, agent first. Rejects with the words to show; when the
*  agent was already written, they say so and name only the instructions as
*  failed (the profile has been reopened on the saved agent by then). */
async function saveProfile(forge, request, hooks) {
	if (request.agent !== void 0) {
		await forge.save(request.agent.draft, request.agent.target);
		hooks.agentWritten();
	}
	if (request.instructions === void 0) return;
	const { name, text, revision } = request.instructions;
	try {
		await forge.saveInstructions(name, text, revision);
	} catch (cause) {
		throw new Error(request.agent === void 0 ? errorText(cause) : `The agent was saved, but its standing instructions were not: ${errorText(cause)}`);
	}
	await hooks.instructionsWritten();
}
//#endregion
//#region src/agent-md.ts
var THINKING_STEPS = [
	"inherit",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh"
];
/** The fields the WORKSHOP (the model, through `forge_propose`) may fill. The
*  grant-class fields — `tools` (`capabilities.tools`), `mcp`
*  (`capabilities.mcp`, which servers the agent may call), `approval`
*  (`gate.approval`), `memoryScope` (`workspace.reach`, a cross-project grant),
*  `habitat` (`workspace.policy`, where it works) and `lineage` (`extends`,
*  which composes each base's WHOLE grant into this agent) — are deliberately
*  absent: doc 58 §3, only a human gesture in the View changes them. `extra`
*  IS proposable, minus every grant-class key it could carry (`grantPathsIn`):
*  the proposal is refused, and never applied, if it names one. */
var PROPOSABLE_FIELDS = [
	"name",
	"description",
	"charter",
	"vibr",
	"voice",
	"skills",
	"memory",
	"thinking",
	"personality",
	"extra"
];
/** A voice profile name: kebab-case, the stem of its `<name>.yml` and the value of `voice:`. Mirrors the
*  SDK's `VOICE_PROFILE_NAME`; a manifest that fails it does not load, so a draft is refused before a write. */
var VOICE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
/**
* A name as it is typed: lowercase, anything that is not a letter or digit
* becomes one dash. A trailing dash survives on purpose — the next keystroke
* is usually the rest of `release-herald`.
*/
function normalizeTypedName(raw) {
	return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 64);
}
/**
* A new agent. `promptMode` is `replace`, the manifest's own default: the
* charter is the agent's whole persona. `append` would put it after the full
* default CODING prompt — right for an agent that extends `coding`, wrong for a
* CMO or a scribe (dimension#1355), so it is a choice the human makes.
*/
function blankDraft(key) {
	return {
		key,
		name: "",
		description: "",
		vibr: "orb",
		voice: "",
		personality: "default",
		promptMode: "replace",
		thinking: "inherit",
		models: [],
		tools: [],
		skills: [],
		mcp: [],
		memory: "inherit",
		memoryScope: "project",
		approval: "always-ask",
		habitat: "bound",
		lineage: [],
		charter: "",
		extra: ""
	};
}
/** Whether two reads of the grant-class paths name the same ones. */
function sameGrants(a, b) {
	return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}
/** Lay a workshop proposal over a draft: only the fields it names change, and
*  `tools`/`approval`/`memoryScope`/`habitat`/`lineage` never do — whatever the
*  object carries at runtime. `extra` is overlaid key by key, and not at all
*  when it names a grant-class key. */
function applyProposal(draft, proposal) {
	const next = { ...draft };
	const patch = next;
	for (const field of PROPOSABLE_FIELDS) {
		const value = proposal[field];
		if (value === void 0 || field === "extra") continue;
		patch[field] = Array.isArray(value) ? [...value] : value;
	}
	if (proposal.extra !== void 0 && grantPathsIn(proposal.extra).length === 0) {
		const merged = overlayExtra(draft.extra, proposal.extra);
		if (sameGrants(grantPathsIn(merged), grantPathsIn(draft.extra))) next.extra = merged;
	}
	return next;
}
/** The top-level keys the profile draws. */
var DRAWN_TOP = [
	"name",
	"description",
	"avatar",
	"voice",
	"specVersion",
	"extends"
];
/** The legacy flat spellings that fold into a key the profile draws. A file that uses one keeps
*  it in Everything else, and the profile's own control for the key it folds into stands aside:
*  the file's flat line is what the engine reads, and writing the nested key beside it is a
*  manifest the engine refuses (`both 'tools' and 'capabilities.tools' set`). */
var FLAT_ALIASES = {
	tools: "capabilities.tools",
	thinkingLevel: "engine.thinkingLevel",
	thinking: "engine.thinkingLevel",
	model: "engine.model"
};
/** The keys the profile draws inside each section it draws. */
var DRAWN_CHILDREN = {
	identity: ["personality", "prompt"],
	engine: ["thinkingLevel", "model"],
	capabilities: [
		"tools",
		"skills",
		"mcp"
	],
	gate: ["approval"],
	memory: ["backend"],
	workspace: [
		"policy",
		"id",
		"reach"
	]
};
/** The drawn paths Everything else may NOT carry: the profile's name,
*  description, lineage and charter own them outright. Every other drawn path
*  yields to a line the author wrote in Everything else (and its control says so). */
var FIXED_PATHS = {
	name: true,
	description: true,
	specVersion: true,
	extends: true,
	"identity.prompt": true
};
/** Whether `path` is a key the profile draws — `true` for `avatar`, `gate.approval`, … */
function isDrawnPath(path) {
	const [head, child] = path.split(".");
	if (head === void 0) return false;
	if (child === void 0) return DRAWN_TOP.includes(head);
	return DRAWN_CHILDREN[head]?.includes(child) ?? false;
}
/** The profile-drawn paths Everything else holds in this draft: each one's
*  control is set aside and says so, and the file keeps the author's line. */
function heldByExtra(draft) {
	const held = /* @__PURE__ */ new Set();
	for (const path of extraPaths(parseExtra(draft.extra).blocks)) {
		if (isDrawnPath(path) && FIXED_PATHS[path] === void 0) held.add(path);
		const folded = FLAT_ALIASES[path];
		if (folded !== void 0) held.add(folded);
	}
	return held;
}
/** Why the draft cannot be written yet; empty = it can. */
function draftProblems(draft) {
	const problems = [];
	if (!NAME_RE.test(draft.name)) problems.push("Name it: 2–64 lowercase letters, digits or dashes.");
	if (draft.voice !== "" && !VOICE_NAME_RE.test(draft.voice)) problems.push("A voice is a profile name: lowercase letters, digits and single dashes.");
	if (draft.description.trim() === "") problems.push("Give it one line that says what it is for.");
	if (draft.charter.trim() === "") problems.push("Write its charter: the instructions it runs by.");
	problems.push(...manifestDocument(draft).problems);
	return problems;
}
var PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9 _./@:+-]*$/;
var YAML_WORDS = /^(true|false|yes|no|on|off|null|~)$/i;
/** Whether YAML would read this plain text as a number (`2026`, `1e3`, `0x10`, `0o7`) and so not hand back
*  the string that was written. A profile name, an agent name or a skill can be all digits. The SDK reads
*  with `yaml` (1.2), so `1_000` stays a string and needs no quoting. */
function readsAsNumber(value) {
	return value.trim() !== "" && !Number.isNaN(Number(value));
}
function scalar(value) {
	if (PLAIN_SCALAR.test(value) && !YAML_WORDS.test(value) && !readsAsNumber(value) && !/:\s/.test(value) && !/\s$/.test(value)) return value;
	return JSON.stringify(value);
}
function list(values) {
	return `[${values.map(scalar).join(", ")}]`;
}
/**
* The agent.md as lines: what the profile draws, merged with Everything else.
*
* `homeId` is the managed-workspace id of the agent's own home — the SDK's
* `agentHomeWorkspaceId(name)`, which the SERVER supplies (the View cannot
* bundle the SDK, and the spelling must exist once). Lives = home writes it as
* `workspace.id`; without it a preview shows a placeholder and is never saved.
*/
function manifestDocument(draft, homeId) {
	const parsed = parseExtra(draft.extra);
	const problems = [];
	for (const stray of parsed.stray) problems.push(`Other settings must be \`key: value\` lines, not “${stray.trim()}”.`);
	if (draft.extra.split("\n").some((line) => /^(---|\.\.\.)/.test(line))) problems.push("Other settings cannot hold a document separator (---).");
	const byKey = new Map(parsed.blocks.map((block) => [block.key, block]));
	const held = extraPaths(parsed.blocks);
	const fixed = [...held].filter((path) => FIXED_PATHS[path] !== void 0);
	for (const path of fixed) problems.push(`\`${path}\` is set on the profile itself (identity, lineage or charter). Remove it from Other settings.`);
	const yields = (path) => held.has(path) && FIXED_PATHS[path] === void 0;
	const line = (field, text) => ({
		field,
		text
	});
	const units = [
		{
			key: "name",
			lines: [line("name", `name: ${scalar(draft.name || "unnamed")}`)]
		},
		{
			key: "description",
			lines: [line("description", `description: ${scalar(draft.description || "…")}`)]
		},
		{
			key: "avatar",
			lines: draft.vibr === "" ? [] : [line("avatar", `avatar: ${scalar(draft.vibr)}`)]
		},
		{
			key: "voice",
			lines: draft.voice === "" ? [] : [line("voice", `voice: ${scalar(draft.voice)}`)]
		},
		{
			key: "specVersion",
			lines: [line("specVersion", "specVersion: 1")]
		}
	];
	if (draft.lineage.length > 0) units.push({
		key: "extends",
		lines: [line("extends", `extends: ${list(draft.lineage)}`)]
	});
	const child = (path, text) => ({
		key: path.split(".")[1] ?? path,
		lines: [line(path, text)]
	});
	const section = (key, children) => units.push({
		key,
		children
	});
	section("identity", [...draft.personality !== "default" ? [child("identity.personality", `  personality: ${draft.personality}`)] : [], child("identity.prompt", `  prompt: ${draft.promptMode}`)]);
	section("engine", [...draft.thinking !== "inherit" ? [child("engine.thinkingLevel", `  thinkingLevel: ${draft.thinking}`)] : [], ...draft.models.length > 0 ? [child("engine.model", `  model: ${list(draft.models)}`)] : []]);
	section("capabilities", [
		...draft.tools.length > 0 ? [child("capabilities.tools", `  tools: ${list(draft.tools)}`)] : [],
		...draft.skills.length > 0 ? [child("capabilities.skills", `  skills: ${list(draft.skills)}`)] : [],
		...draft.mcp.length > 0 ? [child("capabilities.mcp", `  mcp: ${list(draft.mcp)}`)] : []
	]);
	section("gate", draft.approval !== "inherit" ? [child("gate.approval", `  approval: ${draft.approval}`)] : []);
	section("memory", draft.memory !== "inherit" ? [child("memory.backend", `  backend: ${draft.memory}`)] : []);
	const reachAll = draft.memory !== "off" && draft.memoryScope === "global";
	const extraWorkspace = (byKey.get("workspace")?.children?.length ?? 0) > 0 || (byKey.get("workspace")?.inline ?? "") !== "";
	section("workspace", draft.habitat !== "bound" || reachAll || extraWorkspace ? [
		child("workspace.policy", `  policy: ${draft.habitat}`),
		...draft.habitat === "home" ? [child("workspace.id", `  id: ${scalar(homeId ?? "(its home id)")}`)] : [],
		...reachAll ? [child("workspace.reach", "  reach: all")] : []
	] : []);
	const used = /* @__PURE__ */ new Set();
	const lines = [line("fence", "---")];
	const pushAll = (field, texts) => {
		for (const text of texts) lines.push(line(field, text));
	};
	for (const unit of units) {
		const block = byKey.get(unit.key);
		if (unit.lines !== void 0) {
			if (block !== void 0 && yields(unit.key)) {
				used.add(unit.key);
				pushAll(`extra.${unit.key}`, block.lines);
			} else {
				if (block !== void 0) used.add(unit.key);
				lines.push(...unit.lines);
			}
			continue;
		}
		const kept = (unit.children ?? []).filter((entry) => !yields(`${unit.key}.${entry.key}`));
		if (block === void 0) {
			if (kept.length > 0) {
				lines.push(line(unit.key, `${unit.key}:`));
				for (const entry of kept) lines.push(...entry.lines);
			}
			continue;
		}
		used.add(unit.key);
		if (kept.length === 0) pushAll(`extra.${unit.key}`, block.lines);
		else if (block.children === null) {
			problems.push(`\`${unit.key}\` is written inline in Other settings, so the profile's own ${unit.key} settings cannot join it. Write its keys indented, one per line.`);
			lines.push(line(unit.key, `${unit.key}:`));
			for (const entry of kept) lines.push(...entry.lines);
		} else {
			lines.push(line(unit.key, `${unit.key}:`));
			for (const entry of kept) lines.push(...entry.lines);
			pushAll(`extra.${unit.key}`, childLines(block, 2));
		}
	}
	for (const block of parsed.blocks) if (!used.has(block.key)) pushAll(`extra.${block.key}`, block.lines);
	lines.push(line("fence", "---"));
	const body = draft.charter.trim() === "" ? ["…"] : draft.charter.replace(/\s+$/, "").split("\n");
	for (const text of body) lines.push(line("body", text));
	return {
		lines,
		problems
	};
}
//#endregion
//#region page/profile-state.ts
var drafts = 0;
/** A local identity for a draft not yet on disk; survives renames. */
function newDraftKey() {
	drafts += 1;
	return `draft-${Date.now().toString(36)}-${drafts}`;
}
function isNew(state) {
	return state.agent === void 0;
}
/** A profile opened on a listed agent. */
function openListed(agent) {
	return {
		draft: { ...agent.draft },
		agent,
		...agent.editable ? {} : { readOnly: agent.readOnlyReason ?? "This agent is read-only here." }
	};
}
/** A new agent: a blank charter, speaking only as itself. */
function openBlank() {
	return { draft: blankDraft(newDraftKey()) };
}
/**
* A read-only agent's way forward: a NEW agent that extends it, prefilled with
* its settings so the human sees what they start from. Its name is theirs to
* give. `extra` stays behind: the keys it holds reach the new agent through
* `extends` anyway, and copying them would make every one an override.
*/
function extendFrom(base) {
	const blank = blankDraft(newDraftKey());
	return { draft: {
		...base,
		key: blank.key,
		name: "",
		vibr: base.vibr === "" ? blank.vibr : base.vibr,
		models: [...base.models],
		tools: [...base.tools],
		skills: [...base.skills],
		mcp: [...base.mcp],
		lineage: [base.name],
		extra: ""
	} };
}
/**
* A proposal arrives. It rides on the profile it names: the open one when it is
* that agent (or a new agent still unnamed), else the listed, editable agent of
* that name, else a new agent. Only the fields it actually changed are marked
* (a grant it tried to carry changed nothing, so it is not claimed); fields
* proposed earlier and not yet decided stay marked, and Discard still returns
* to the draft before the FIRST of them.
*/
function receiveProposal(current, id, proposal, agents) {
	let base;
	let before;
	if (current !== null && (current.draft.name === proposal.name || isNew(current) && current.draft.name === "")) {
		base = current;
		before = current.proposal?.before ?? current.draft;
	} else {
		const listed = agents.find((agent) => agent.name === proposal.name && agent.editable);
		base = listed !== void 0 ? openListed(listed) : openBlank();
		before = listed !== void 0 ? base.draft : null;
	}
	const draft = applyProposal(base.draft, proposal);
	const changed = PROPOSABLE_FIELDS.filter((field) => field !== "name" && JSON.stringify(draft[field]) !== JSON.stringify(base.draft[field]));
	const kept = base === current ? current?.proposal : void 0;
	const marked = /* @__PURE__ */ new Set([...kept?.fields ?? [], ...changed]);
	const ids = [...kept?.ids ?? [], id];
	return {
		...base,
		draft,
		proposal: {
			ids,
			fields: [...marked],
			before
		}
	};
}
/** Keep the proposal: the draft stays as it is, unmarked. */
function acceptProposal(state) {
	const { proposal: _decided, ...rest } = state;
	return rest;
}
/** Throw the proposal away: back to the draft before it, or, when it started
*  a new agent, no profile at all (`null`). */
function discardProposal(state) {
	if (state.proposal === void 0) return state;
	const { proposal, ...rest } = state;
	return proposal.before === null ? null : {
		...rest,
		draft: proposal.before
	};
}
/**
* The proposals still waiting on the human: not carried by the open profile
* (which answers for them) and not decided. Read off what the profile holds
* each time rather than remembered, so a proposal on a profile that closed
* without a decision is waiting again, as it still is on the server.
*/
function proposalsToReview(all, open, decided) {
	const carried = open?.proposal?.ids ?? [];
	return all.filter((entry) => !decided.has(entry.id) && !carried.includes(entry.id));
}
/**
* Which of the waiting proposals land on `profile` as soon as they are read:
* those that name its agent, or, for a new agent still unnamed, the first one
* alone. That one names the draft; the next is another agent's and keeps
* waiting on the home, instead of replacing the profile and vanishing.
*/
function proposalsForProfile(profile, waiting) {
	if (isNew(profile) && profile.draft.name === "") return waiting.slice(0, 1);
	return waiting.filter((entry) => entry.proposal.name === profile.draft.name);
}
function fieldErrors(state, agents) {
	const { draft } = state;
	const errors = {};
	if (isNew(state)) {
		if (draft.name === "") errors.name = "Give it an id: lowercase letters, digits and dashes.";
		else if (!NAME_RE.test(draft.name)) errors.name = "2 to 64 lowercase letters, digits or dashes, starting with a letter or digit.";
		else if (agents.some((agent) => agent.name === draft.name)) errors.name = `An agent with the id “${draft.name}” already exists.`;
	}
	if (draft.description.trim() === "") errors.description = "Say in one line what it is for.";
	if (draft.charter.trim() === "") errors.charter = "Write its charter: the instructions it runs by.";
	return errors;
}
/**
* Everything standing between the profile and a save, in the order a person
* fixes them: why it is read-only, an undecided proposal, the fields, then the
* document's own problems (Other settings) and the server's verdict.
*/
function saveBlockers(state, agents, serverProblems) {
	if (state.readOnly !== void 0) return [state.readOnly];
	const errors = fieldErrors(state, agents);
	const fieldMessages = [
		errors.name,
		errors.description,
		errors.charter
	].filter((message) => message !== void 0);
	const documentProblems = draftProblems(state.draft).filter((problem) => !problem.startsWith("Name it") && !problem.startsWith("Give it one line") && !problem.startsWith("Write its charter"));
	return [
		...state.proposal !== void 0 ? ["Accept or discard the Machinist’s proposal first."] : [],
		...fieldMessages,
		...documentProblems,
		...serverProblems
	];
}
/** Whether the draft differs from the file it was opened from; a new agent always does. */
function isDirty(state) {
	if (state.agent === void 0) return true;
	return JSON.stringify(state.draft) !== JSON.stringify(state.agent.draft);
}
/** What a save asks the server to do, or why it cannot. */
function saveTargetOf(state) {
	if (state.agent === void 0) return { create: true };
	const { source, revision } = state.agent;
	if (source === "pack" || revision === void 0) return "This agent was opened without its tier and revision, so it cannot be rewritten; reopen it.";
	return {
		create: false,
		tier: source,
		revision
	};
}
//#endregion
//#region page/extra-edit.ts
/** `extra` with `path` (`key` or `section.key`) set to the YAML `value`, or
*  removed when `value` is null; an emptied section goes with it. */
function setExtraPath(extra, path, value) {
	const [head, child] = path.split(".");
	const out = [];
	let placed = false;
	for (const block of parseExtra(extra).blocks) {
		if (block.key !== head) {
			out.push([...block.lines]);
			continue;
		}
		if (child !== void 0 && block.children === null && block.inline !== "") {
			out.push([...block.lines]);
			placed = true;
			continue;
		}
		placed = true;
		if (child === void 0) {
			if (value !== null) out.push([`${head}: ${value}`]);
			continue;
		}
		const kept = (block.children ?? []).filter((entry) => entry.key !== child).map((entry) => reindent(entry.lines, block.childIndent, 2));
		if (value !== null) kept.push([`  ${child}: ${value}`]);
		if (kept.length > 0) out.push([`${head}:`, ...kept.flat()]);
	}
	if (!placed && value !== null) out.push(child === void 0 ? [`${head}: ${value}`] : [`${head}:`, `  ${child}: ${value}`]);
	return out.map((lines) => lines.join("\n")).join("\n");
}
/** A YAML flow list of plain names. */
function flowList(names) {
	return `[${names.join(", ")}]`;
}
//#endregion
//#region page/sections-identity.tsx
/** The Machinist set this and the human has not decided yet. */
function ProposedBadge() {
	return /* @__PURE__ */ jsx(Badge, {
		tone: "accent",
		variant: "soft",
		className: "text-fr-xs",
		children: "Proposed"
	});
}
function InlineError({ text }) {
	if (text === void 0) return null;
	return /* @__PURE__ */ jsxs("span", {
		role: "alert",
		className: "mt-1.5 flex items-center gap-1.5 text-fr-xs text-fr-del",
		children: [/* @__PURE__ */ jsx(Icon, {
			name: "warnTri",
			size: 12,
			strokeWidth: 2
		}), text]
	});
}
var PERSONALITY = [
	{
		id: "default",
		icon: "aether",
		title: "Dimension's default",
		detail: "Whatever personality you set for Dimension."
	},
	{
		id: "friendly",
		icon: "chat",
		title: "Friendly",
		detail: "Warm, encouraging, explains as it goes."
	},
	{
		id: "pragmatic",
		icon: "bolt",
		title: "Pragmatic",
		detail: "Direct and brief; the answer first."
	},
	{
		id: "none",
		icon: "minus",
		title: "No personality",
		detail: "Only its charter shapes how it talks."
	}
];
var SPEAKS = [{
	id: "replace",
	icon: "user",
	title: "Only as itself",
	detail: "Its charter is its whole voice. Right for a writer, a researcher, a CMO."
}, {
	id: "append",
	icon: "layers",
	title: "As Dimension, plus its charter",
	detail: "The full coding prompt first, then its charter. Right for an agent that codes."
}];
function GalleryFace({ id, label, checked, disabled, bridged, onPick, skin, accent }) {
	const [live, setLive] = useState(false);
	return /* @__PURE__ */ jsxs("button", {
		type: "button",
		role: "radio",
		"aria-checked": checked,
		"aria-label": label,
		disabled,
		onClick: onPick,
		onPointerEnter: () => setLive(true),
		onPointerLeave: () => setLive(false),
		onFocus: () => setLive(true),
		onBlur: () => setLive(false),
		className: cn("group/face flex min-w-0 flex-col items-center gap-1.5 rounded-lg p-1.5 fr-t-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line", checked ? "bg-fr-accent-dim" : "hover:bg-fr-surface-2", disabled && "cursor-default"),
		children: [/* @__PURE__ */ jsx(FaceTile, {
			face: {
				avatar: id,
				...checked && skin ? { skin } : {},
				...checked && accent ? { accent } : {}
			},
			tile: 72,
			presence: 56,
			live,
			bridged,
			name: label,
			className: cn(checked && "border-fr-accent")
		}), /* @__PURE__ */ jsx("span", {
			className: cn("fr-overflow max-w-full font-secondary text-fr-xs", checked ? "text-fr-text" : "text-fr-text-2"),
			children: label
		})]
	});
}
function IdentitySection({ draft, set, editable, creating, errors, face, bridged, marked }) {
	const heldFace = heldByExtra(draft).has("avatar");
	const faces = faceOptions(bridged);
	const current = draft.vibr === "" ? null : draft.vibr;
	return /* @__PURE__ */ jsxs(Section, {
		id: "agent-identity",
		title: "Identity",
		lede: "Its name, its line, the face it wears everywhere it appears, and how it talks.",
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: cn(PANEL, "flex flex-col gap-5 p-4"),
				children: [/* @__PURE__ */ jsx(FieldRow, {
					label: "Name",
					hint: creating ? "Its id: lowercase letters, digits and dashes. It cannot change once written." : "Its id. Fixed once written.",
					children: creating ? /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(Input, {
						value: draft.name,
						placeholder: "release-herald",
						"aria-invalid": errors.name !== void 0,
						onChange: (event) => set({ name: normalizeTypedName(event.target.value) }),
						className: "max-w-md font-secondary"
					}), /* @__PURE__ */ jsx(InlineError, { text: errors.name })] }) : /* @__PURE__ */ jsx("span", {
						className: "inline-flex items-center rounded-sm bg-fr-surface-3 px-2 py-1 font-secondary text-fr-sm text-fr-text",
						children: draft.name
					})
				}), /* @__PURE__ */ jsxs(FieldRow, {
					label: "What it is for",
					hint: "One line. Rooms route to it by this when it declares no card.",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "flex items-center gap-2",
						children: [/* @__PURE__ */ jsx(Input, {
							value: draft.description,
							disabled: !editable,
							placeholder: "Writes our changelog in my voice",
							"aria-invalid": errors.description !== void 0,
							onChange: (event) => set({ description: event.target.value })
						}), marked.has("description") ? /* @__PURE__ */ jsx(ProposedBadge, {}) : null]
					}), /* @__PURE__ */ jsx(InlineError, { text: errors.description })]
				})]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: cn(PANEL, "flex flex-col gap-3 p-4"),
				children: [/* @__PURE__ */ jsxs("div", {
					className: "flex flex-wrap items-center justify-between gap-2",
					children: [/* @__PURE__ */ jsxs("span", {
						className: "flex items-center gap-2 text-fr-sm font-medium text-fr-text",
						children: ["Face", marked.has("vibr") ? /* @__PURE__ */ jsx(ProposedBadge, {}) : null]
					}), /* @__PURE__ */ jsx("span", {
						className: "font-secondary text-fr-xs text-fr-text-2",
						children: heldFace ? "It wears a face with its own skin or accent, set in Other settings under Advanced." : current === null ? "It wears the neutral agent face until you pick one." : "Point at a face to see it move."
					})]
				}), /* @__PURE__ */ jsx("div", {
					role: "radiogroup",
					"aria-label": "Face",
					className: "grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1",
					children: faces.map((option) => /* @__PURE__ */ jsx(GalleryFace, {
						id: option.id,
						label: option.label,
						checked: !heldFace && option.id === current,
						disabled: !editable || heldFace,
						bridged,
						onPick: () => set({ vibr: option.id }),
						...face.skin ? { skin: face.skin } : {},
						...face.accent ? { accent: face.accent } : {}
					}, option.id))
				})]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "grid grid-cols-1 gap-4 @4xl:grid-cols-[3fr_2fr]",
				children: [/* @__PURE__ */ jsxs("div", {
					className: "flex flex-col gap-2.5",
					children: [/* @__PURE__ */ jsxs("span", {
						className: "flex items-center gap-2 text-fr-sm font-medium text-fr-text",
						children: ["Personality", marked.has("personality") ? /* @__PURE__ */ jsx(ProposedBadge, {}) : null]
					}), /* @__PURE__ */ jsx(ChoiceGroup, {
						label: "Personality",
						columns: 2,
						children: PERSONALITY.map((option) => /* @__PURE__ */ jsx(ChoiceCard, {
							icon: option.icon,
							title: option.title,
							detail: option.detail,
							checked: draft.personality === option.id,
							disabled: !editable,
							onSelect: () => set({ personality: option.id })
						}, option.id))
					})]
				}), /* @__PURE__ */ jsxs("div", {
					className: "flex flex-col gap-2.5",
					children: [/* @__PURE__ */ jsx("span", {
						className: "text-fr-sm font-medium text-fr-text",
						children: "Speaks as"
					}), /* @__PURE__ */ jsx("div", {
						role: "radiogroup",
						"aria-label": "Speaks as",
						className: "grid grid-cols-1 gap-2.5",
						children: SPEAKS.map((option) => /* @__PURE__ */ jsx(ChoiceCard, {
							icon: option.icon,
							title: option.title,
							detail: option.detail,
							checked: draft.promptMode === option.id,
							disabled: !editable,
							onSelect: () => set({ promptMode: option.id })
						}, option.id))
					})]
				})]
			})
		]
	});
}
/** A file, as the page draws one: its glyph, its name, where it lives and what it is. */
function FileCard({ name, path, note, tone = "mute" }) {
	return /* @__PURE__ */ jsxs("div", {
		"data-slot": "file-card",
		className: "flex min-w-0 items-center gap-3",
		children: [/* @__PURE__ */ jsx("span", {
			className: cn("flex size-9 shrink-0 items-center justify-center rounded-md", tone === "accent" ? "bg-fr-accent-dim text-fr-accent" : "bg-fr-surface-3 text-fr-text-2"),
			children: /* @__PURE__ */ jsx(Icon, {
				name: "file",
				size: 16,
				strokeWidth: 1.8
			})
		}), /* @__PURE__ */ jsxs("div", {
			className: "flex min-w-0 flex-col gap-0.5",
			children: [/* @__PURE__ */ jsxs("span", {
				className: "flex items-center gap-2 text-fr-sm font-medium text-fr-text",
				children: [name, note ? /* @__PURE__ */ jsx("span", {
					className: "font-secondary text-fr-xs font-normal text-fr-text-2",
					children: note
				}) : null]
			}), /* @__PURE__ */ jsx("span", {
				className: "fr-overflow font-secondary text-fr-xs text-fr-text-2",
				title: path,
				children: path
			})]
		})]
	});
}
function CharterSection({ draft, set, editable, errors, agent, marked }) {
	const words = draft.charter.trim() === "" ? 0 : draft.charter.trim().split(/\s+/).length;
	const path = agent?.path ?? `Your agents / ${draft.name || "<name>"} / agent.md`;
	return /* @__PURE__ */ jsxs(Section, {
		id: "agent-charter",
		title: "Charter",
		lede: "The instructions it runs by: the body of its agent.md. It is never inherited from an agent it extends.",
		children: [/* @__PURE__ */ jsxs("div", {
			className: cn(PANEL, "overflow-hidden", errors.charter !== void 0 && "border-fr-del/60"),
			children: [/* @__PURE__ */ jsxs("div", {
				className: "flex flex-wrap items-center justify-between gap-3 border-b border-fr-border-soft bg-fr-surface-2/50 px-4 py-3",
				children: [/* @__PURE__ */ jsx(FileCard, {
					name: "agent.md",
					path,
					note: agent?.source === "pack" ? "Shipped with its pack" : agent === void 0 ? "Written when you create it" : "The file it loads",
					tone: "accent"
				}), /* @__PURE__ */ jsxs("span", {
					className: "flex items-center gap-2 font-secondary text-fr-xs text-fr-text-2 tabular-nums",
					children: [
						marked.has("charter") ? /* @__PURE__ */ jsx(ProposedBadge, {}) : null,
						words,
						" ",
						words === 1 ? "word" : "words"
					]
				})]
			}), /* @__PURE__ */ jsx(Textarea, {
				variant: "ghost",
				resize: "vertical",
				value: draft.charter,
				readOnly: !editable,
				"aria-label": "Charter",
				"aria-invalid": errors.charter !== void 0,
				placeholder: "You write the changelog.\n\nRead the merged pull requests since the last release, group them by what a user notices, and never invent a change.",
				onChange: (event) => set({ charter: event.target.value }),
				className: "max-h-none min-h-72 rounded-none border-0 px-4 py-3 font-code text-fr-sm leading-relaxed"
			})]
		}), /* @__PURE__ */ jsx(InlineError, { text: errors.charter })]
	});
}
var TIER_OF_FILE = {
	"workspace-copy": "This project's copy",
	home: "Its home",
	pack: "Beside it in its pack",
	"agent-dir": "Beside its agent.md"
};
function InstructionsSection({ home, error, creating, text, onText, editable }) {
	const winner = home?.instructions.files.find((file) => file.wins);
	const writable = editable && home?.instructions.editable === true && home.instructions.target !== null;
	return /* @__PURE__ */ jsx(Section, {
		id: "agent-instructions",
		title: "Standing instructions",
		lede: "The AGENTS.md it reads at the start of every session, wherever it works. The first file that exists wins.",
		children: creating ? /* @__PURE__ */ jsx("p", {
			className: "m-0 rounded-lg border border-dashed border-fr-border px-4 py-3 text-fr-sm text-fr-text-2",
			children: "Create the agent first: its standing instructions live in its home, which it gets when it is written."
		}) : error !== void 0 ? /* @__PURE__ */ jsx("p", {
			role: "alert",
			className: "m-0 rounded-lg border border-fr-border-soft bg-fr-surface px-4 py-3 text-fr-sm text-fr-warn",
			children: error
		}) : home === void 0 ? /* @__PURE__ */ jsx("div", { className: cn(PANEL, "h-40 animate-pulse") }) : /* @__PURE__ */ jsxs("div", {
			className: cn(PANEL, "overflow-hidden"),
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "flex flex-col gap-3 border-b border-fr-border-soft bg-fr-surface-2/50 px-4 py-3",
					children: [/* @__PURE__ */ jsx(FileCard, {
						name: "AGENTS.md",
						path: winner?.path ?? home.instructions.target?.path ?? "No file yet",
						note: winner ? `${TIER_OF_FILE[winner.kind]} · in force` : "None yet",
						tone: winner ? "accent" : "mute"
					}), /* @__PURE__ */ jsx("ul", {
						className: "m-0 flex list-none flex-wrap gap-1.5 p-0",
						"aria-label": "Where it looks",
						children: home.instructions.files.map((file) => /* @__PURE__ */ jsxs("li", {
							title: file.path,
							className: cn("inline-flex items-center gap-1.5 rounded-sm px-2 py-1 font-secondary text-fr-xs", file.wins ? "bg-fr-accent-dim text-fr-accent" : file.exists ? "bg-fr-surface-3 text-fr-text-2" : "border border-dashed border-fr-border text-fr-text-3"),
							children: [
								/* @__PURE__ */ jsx(Icon, {
									name: file.wins ? "check" : file.exists ? "file" : "minus",
									size: 11,
									strokeWidth: 2
								}),
								TIER_OF_FILE[file.kind],
								file.wins ? "" : file.exists ? " · set aside" : " · none"
							]
						}, file.path))
					})]
				}),
				/* @__PURE__ */ jsx(Textarea, {
					variant: "ghost",
					resize: "vertical",
					value: text,
					readOnly: !writable,
					"aria-label": "Standing instructions",
					placeholder: "Nothing here yet. What should it always know, whichever project it is working in?",
					onChange: (event) => onText(event.target.value),
					className: "max-h-none min-h-44 rounded-none border-0 px-4 py-3 font-code text-fr-sm leading-relaxed"
				}),
				/* @__PURE__ */ jsx("p", {
					className: "m-0 border-t border-fr-border-soft px-4 py-2 font-secondary text-fr-xs text-fr-text-2",
					children: home.instructions.note
				})
			]
		})
	});
}
//#endregion
//#region page/sections-capabilities.tsx
var TABS = [
	"skills",
	"plugins",
	"mcp",
	"tools"
];
var WORDS = {
	skills: {
		tab: "Skills",
		every: "Every skill",
		one: "skill",
		many: "skills"
	},
	plugins: {
		tab: "Plugins",
		every: "Every plugin",
		one: "plugin",
		many: "plugins"
	},
	mcp: {
		tab: "MCP",
		every: "Every MCP server",
		one: "server",
		many: "servers"
	},
	tools: {
		tab: "Tools",
		every: "Every tool",
		one: "tool",
		many: "tools"
	}
};
/** Which allowlists grant (doc 58 §3): only a human sets them. */
var GRANTS = {
	skills: false,
	plugins: true,
	mcp: true,
	tools: true
};
function itemsOf(kind, catalog, allowed) {
	const pluginTitle = (id) => {
		if (id === void 0) return void 0;
		const plugin = catalog?.plugins.find((record) => record.id === id);
		return plugin?.title ?? plugin?.name ?? id;
	};
	const items = [];
	if (kind === "skills") for (const skill of catalog?.skills ?? []) {
		const owner = skill.pluginId === void 0 ? void 0 : catalog?.plugins.find((record) => record.id === skill.pluginId);
		const source = pluginTitle(skill.pluginId);
		items.push({
			name: skill.name,
			label: humanize(skill.name),
			...skill.description ? { detail: skill.description } : {},
			...source ? { source } : {},
			mark: /* @__PURE__ */ jsx(SkillMark, {
				name: skill.name,
				...owner ? { pluginIcon: owner } : {},
				size: "include"
			}),
			known: true
		});
	}
	else if (kind === "plugins") for (const plugin of catalog?.plugins ?? []) items.push({
		name: plugin.name,
		label: plugin.title ?? humanize(plugin.name),
		...plugin.description ? { detail: plugin.description } : {},
		source: plugin.enabled ? plugin.kind : `${plugin.kind} · off`,
		mark: /* @__PURE__ */ jsx(PluginMark, {
			plugin,
			size: "include"
		}),
		known: true
	});
	else if (kind === "mcp") for (const server of catalog?.mcp ?? []) {
		const source = pluginTitle(server.pluginId);
		items.push({
			name: server.name,
			label: server.name,
			...server.description ? { detail: server.description } : {},
			...source ? { source } : server.status ? { source: server.status } : {},
			mark: /* @__PURE__ */ jsx(McpMark, {
				name: server.name,
				size: "include"
			}),
			known: true
		});
	}
	else for (const tool of catalog?.tools ?? []) {
		const source = tool.source === "builtin" ? "Built in" : pluginTitle(tool.pluginId);
		items.push({
			name: tool.name,
			label: tool.name,
			...tool.description ? { detail: tool.description } : {},
			...source ? { source } : {},
			mark: /* @__PURE__ */ jsx(ToolMark, {
				name: tool.name,
				size: "include"
			}),
			known: true
		});
	}
	const matches = (item, name) => kind === "plugins" ? pluginMatches(item.name, name) : item.name === name;
	for (const name of allowed) {
		if (items.some((item) => matches(item, name))) continue;
		const mark = kind === "plugins" ? /* @__PURE__ */ jsx(PluginMark, {
			plugin: { name },
			size: "include"
		}) : kind === "skills" ? /* @__PURE__ */ jsx(SkillMark, {
			name,
			size: "include"
		}) : kind === "mcp" ? /* @__PURE__ */ jsx(McpMark, {
			name,
			size: "include"
		}) : /* @__PURE__ */ jsx(ToolMark, {
			name,
			size: "include"
		});
		items.push({
			name,
			label: kind === "tools" || kind === "mcp" ? name : humanize(name),
			detail: "Not installed here. It still counts when it is.",
			mark,
			known: false
		});
	}
	return items;
}
function MarkItem({ item, checked, every, disabled, onToggle }) {
	return /* @__PURE__ */ jsxs("button", {
		type: "button",
		role: "checkbox",
		"aria-checked": checked || every,
		disabled,
		onClick: onToggle,
		className: cn("relative flex min-w-0 items-start gap-3 rounded-lg border p-3 text-left fr-t-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line", checked ? "border-fr-accent-line bg-fr-accent-dim" : "border-fr-border-soft bg-fr-surface", !disabled && !checked && "hover:border-fr-border hover:bg-fr-surface-2", disabled && "cursor-default", !item.known && "border-dashed"),
		children: [
			/* @__PURE__ */ jsx("span", {
				className: "shrink-0",
				children: item.mark
			}),
			/* @__PURE__ */ jsxs("span", {
				className: "flex min-w-0 flex-1 flex-col gap-0.5 pr-5",
				children: [
					/* @__PURE__ */ jsx("span", {
						className: "fr-overflow text-fr-sm font-medium text-fr-text",
						children: item.label
					}),
					item.detail ? /* @__PURE__ */ jsx("span", {
						className: "line-clamp-2 text-fr-xs leading-relaxed text-fr-text-2",
						children: item.detail
					}) : null,
					item.source ? /* @__PURE__ */ jsx("span", {
						className: "fr-overflow font-secondary text-fr-2xs text-fr-text-3",
						children: item.source
					}) : null
				]
			}),
			/* @__PURE__ */ jsx("span", {
				"aria-hidden": "true",
				className: cn("absolute top-3 right-3 flex size-4 items-center justify-center rounded-sm border", checked ? "border-fr-accent bg-fr-accent text-fr-accent-ink" : every ? "border-fr-border bg-fr-surface-3 text-fr-text-2" : "border-fr-border bg-fr-bg text-transparent"),
				children: /* @__PURE__ */ jsx(Icon, {
					name: "check",
					size: 10,
					strokeWidth: 3
				})
			})
		]
	});
}
function CapabilitiesSection({ draft, set, editable, catalog, marked }) {
	const [tab, setTab] = useState("skills");
	const [query, setQuery] = useState("");
	const [picking, setPicking] = useState({});
	const held = heldByExtra(draft);
	const lists = Object.fromEntries(TABS.map((kind) => [kind, allowlistOf(draft, kind)]));
	const list = lists[tab];
	const words = WORDS[tab];
	const inlineSection = parseExtra(draft.extra).blocks.some((block) => block.key === "capabilities" && block.children === null && block.inline !== "");
	const isHeld = tab === "plugins" ? inlineSection || list.kind === "none" : held.has(`capabilities.${tab}`);
	const names = list.kind === "some" ? list.names : [];
	const mode = list.kind === "some" || picking[tab] === true ? "some" : "every";
	const canEdit = editable && !isHeld;
	const write = (next) => {
		if (tab === "plugins") set({ extra: setExtraPath(draft.extra, "capabilities.plugins", next.length === 0 ? null : flowList(next)) });
		else set({ [tab]: [...next] });
	};
	const toggle = (name) => {
		const has = tab === "plugins" ? names.some((entry) => pluginMatches(name, entry)) : names.includes(name);
		write(has ? names.filter((entry) => tab === "plugins" ? !pluginMatches(name, entry) : entry !== name) : [...names, name]);
	};
	const setMode = (next) => {
		setPicking((current) => ({
			...current,
			[tab]: next === "some"
		}));
		if (next === "every") write([]);
	};
	const items = itemsOf(tab, catalog, names);
	const needle = query.trim().toLowerCase();
	const shown = needle === "" ? items : items.filter((item) => `${item.name} ${item.label} ${item.detail ?? ""}`.toLowerCase().includes(needle));
	const isChecked = (item) => tab === "plugins" ? names.some((entry) => pluginMatches(item.name, entry)) : names.includes(item.name);
	shown.sort((a, b) => Number(isChecked(b)) - Number(isChecked(a)));
	const filters = TABS.map((kind) => {
		const entry = lists[kind];
		return {
			id: kind,
			label: WORDS[kind].tab,
			count: entry.kind === "some" ? entry.names.length : entry.kind === "none" ? 0 : void 0
		};
	});
	const countLine = list.kind === "some" ? `${names.length} ${names.length === 1 ? words.one : words.many} of ${items.length}` : list.kind === "none" ? `No ${words.many}` : `${words.every}${catalog ? ` (${items.length})` : ""}`;
	return /* @__PURE__ */ jsx(Section, {
		id: "agent-capabilities",
		title: "Capabilities",
		lede: "What it may use. Leave a kind at Every to follow what is installed; choose to limit it to the ones you check.",
		aside: marked.has("skills") ? /* @__PURE__ */ jsx(ProposedBadge, {}) : void 0,
		children: /* @__PURE__ */ jsxs("div", {
			className: cn(PANEL, "flex flex-col gap-4 p-4"),
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "flex flex-wrap items-center justify-between gap-3",
					children: [/* @__PURE__ */ jsx(MarketplaceFilterPills, {
						filters,
						active: tab,
						onChange: (next) => {
							setTab(next);
							setQuery("");
						},
						ariaLabel: "Capability kind"
					}), /* @__PURE__ */ jsxs("span", {
						className: "flex items-center gap-2 font-secondary text-fr-xs text-fr-text-2",
						children: [GRANTS[tab] ? /* @__PURE__ */ jsx(GrantLock, {}) : null, countLine]
					})]
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "flex flex-wrap items-center gap-3",
					children: [/* @__PURE__ */ jsx(Segmented, {
						options: ["every", "some"],
						value: mode,
						onChange: (next) => canEdit && setMode(next),
						label: (value) => value === "every" ? words.every : "Only the ones I check",
						className: cn(!canEdit && "pointer-events-none opacity-70")
					}), /* @__PURE__ */ jsxs("div", {
						className: "relative min-w-48 flex-1",
						children: [/* @__PURE__ */ jsx(Icon, {
							name: "search",
							size: 13,
							strokeWidth: 2,
							className: "pointer-events-none absolute top-1/2 left-2.5 z-[1] -translate-y-1/2 text-fr-text-3"
						}), /* @__PURE__ */ jsx(Input, {
							size: "sm",
							value: query,
							onChange: (event) => setQuery(event.target.value),
							placeholder: `Search ${words.many}`,
							"aria-label": `Search ${words.many}`,
							className: "pl-8"
						})]
					})]
				}),
				isHeld ? /* @__PURE__ */ jsxs("p", {
					className: "m-0 flex items-center gap-2 text-fr-xs text-fr-text-2",
					children: [
						/* @__PURE__ */ jsx(Icon, {
							name: "sliders",
							size: 12,
							strokeWidth: 2
						}),
						list.kind === "none" ? `It may use no ${words.many}.` : `Its ${words.many} are set in Other settings.`,
						" Change it there, under Advanced."
					]
				}) : mode === "some" && names.length === 0 ? /* @__PURE__ */ jsxs("p", {
					className: "m-0 text-fr-xs text-fr-accent",
					children: [
						"Check the ",
						words.many,
						" it may use. Until you check one it keeps ",
						words.every.toLowerCase(),
						"."
					]
				}) : null,
				catalog === void 0 ? /* @__PURE__ */ jsx("p", {
					className: "m-0 rounded-md border border-dashed border-fr-border px-3 py-3 text-fr-xs text-fr-text-2",
					children: "The host has not published its capabilities catalog yet, so only what this agent names is shown."
				}) : null,
				shown.length === 0 ? /* @__PURE__ */ jsx("p", {
					className: "m-0 py-6 text-center text-fr-sm text-fr-text-2",
					children: needle === "" ? `No ${words.many} installed.` : `No ${words.many} match “${query}”.`
				}) : /* @__PURE__ */ jsx("div", {
					className: "grid grid-cols-1 gap-2 @2xl:grid-cols-2 @5xl:grid-cols-3",
					children: shown.map((item) => /* @__PURE__ */ jsx(MarkItem, {
						item,
						checked: mode === "some" && isChecked(item),
						every: mode === "every" && list.kind === "all",
						disabled: !canEdit || mode === "every",
						onToggle: () => toggle(item.name)
					}, item.name))
				})
			]
		})
	});
}
//#endregion
//#region page/sections-settings.tsx
var BACKENDS = [
	{
		id: "inherit",
		icon: "aether",
		title: "Dimension's default",
		detail: "Whatever memory you run Dimension with."
	},
	{
		id: "engram",
		icon: "memory",
		title: "Engram",
		detail: "Local, recalls by meaning across its rooms."
	},
	{
		id: "local",
		icon: "db",
		title: "Local notes",
		detail: "Plain notes on this machine."
	},
	{
		id: "hindsight",
		icon: "history",
		title: "Hindsight",
		detail: "Learns from what happened in its sessions."
	},
	{
		id: "mnemopi",
		icon: "layers",
		title: "Mnemopi",
		detail: "A memory bank of its own, kept apart."
	},
	{
		id: "off",
		icon: "minus",
		title: "No memory",
		detail: "Starts every session knowing nothing."
	}
];
function MemoryTile({ icon, title, detail, lit }) {
	return /* @__PURE__ */ jsxs("div", {
		className: cn("relative z-[1] flex min-w-0 flex-col gap-2 rounded-lg border p-3 fr-t-colors", lit ? "border-fr-accent-line bg-fr-surface" : "border-dashed border-fr-border bg-fr-bg opacity-70"),
		children: [
			/* @__PURE__ */ jsx("span", {
				className: cn("flex size-8 items-center justify-center rounded-md", lit ? "bg-fr-accent-dim text-fr-accent" : "bg-fr-surface-3 text-fr-text-3"),
				children: /* @__PURE__ */ jsx(Icon, {
					name: icon,
					size: 16,
					strokeWidth: 1.8
				})
			}),
			/* @__PURE__ */ jsxs("span", {
				className: "flex min-w-0 flex-col gap-0.5",
				children: [/* @__PURE__ */ jsx("span", {
					className: cn("text-fr-sm font-semibold", lit ? "text-fr-text" : "text-fr-text-2"),
					children: title
				}), /* @__PURE__ */ jsx("span", {
					className: "fr-overflow font-secondary text-fr-xs text-fr-text-2",
					title: detail,
					children: detail
				})]
			}),
			/* @__PURE__ */ jsx("span", {
				className: cn("font-secondary text-fr-2xs", lit ? "text-fr-accent" : "text-fr-text-3"),
				children: lit ? "Reads" : "Does not read"
			})
		]
	});
}
function MemorySection({ draft, set, editable, homeId, marked }) {
	const off = draft.memory === "off";
	const held = heldByExtra(draft);
	const everyProject = draft.memoryScope === "global";
	return /* @__PURE__ */ jsxs(Section, {
		id: "agent-memory",
		title: "Memory",
		lede: "What it remembers and where it recalls from. Its home's notes follow it into every project.",
		aside: marked.has("memory") ? /* @__PURE__ */ jsx(ProposedBadge, {}) : void 0,
		children: [/* @__PURE__ */ jsxs("div", {
			className: cn(PANEL, "flex flex-col gap-4 p-4"),
			children: [/* @__PURE__ */ jsxs("div", {
				className: "relative grid grid-cols-2 gap-3 @3xl:grid-cols-4",
				children: [
					/* @__PURE__ */ jsx("span", {
						"aria-hidden": "true",
						className: "absolute top-1/2 right-8 left-8 hidden h-px bg-fr-border @3xl:block"
					}),
					/* @__PURE__ */ jsx(MemoryTile, {
						icon: "folder",
						title: "This project",
						detail: "Notes of the project it works in",
						lit: !off
					}),
					/* @__PURE__ */ jsx(MemoryTile, {
						icon: "pin",
						title: "Its home",
						detail: homeId ?? "No home: a project agent",
						lit: !off && homeId !== void 0
					}),
					/* @__PURE__ */ jsx(MemoryTile, {
						icon: "book",
						title: "Shared notes",
						detail: "Your notes kept for every agent",
						lit: !off
					}),
					/* @__PURE__ */ jsx(MemoryTile, {
						icon: "globe",
						title: "Other projects",
						detail: "Only when it recalls from every project",
						lit: !off && everyProject
					})
				]
			}), /* @__PURE__ */ jsxs("label", {
				className: "flex items-center justify-between gap-3 rounded-md border border-fr-border-soft bg-fr-bg px-3 py-2.5",
				children: [/* @__PURE__ */ jsxs("span", {
					className: "flex min-w-0 flex-col gap-0.5",
					children: [/* @__PURE__ */ jsxs("span", {
						className: "flex items-center gap-1.5 text-fr-sm text-fr-text",
						children: ["Recall from every project", /* @__PURE__ */ jsx(GrantLock, {})]
					}), /* @__PURE__ */ jsx("span", {
						className: "text-fr-xs text-fr-text-2",
						children: held.has("workspace.reach") ? "Its reach is set in Other settings." : "Also lets its control verbs reach every project: the grant is one."
					})]
				}), /* @__PURE__ */ jsx(Switch, {
					"aria-label": "Recall from every project",
					checked: everyProject && !off,
					disabled: !editable || off || held.has("workspace.reach"),
					onCheckedChange: (on) => set({ memoryScope: on ? "global" : "project" })
				})]
			})]
		}), /* @__PURE__ */ jsx(ChoiceGroup, {
			label: "Memory engine",
			columns: 3,
			children: BACKENDS.map((option) => /* @__PURE__ */ jsx(ChoiceCard, {
				icon: option.icon,
				title: option.title,
				detail: option.detail,
				checked: !held.has("memory.backend") && draft.memory === option.id,
				disabled: !editable || held.has("memory.backend"),
				onSelect: () => set({ memory: option.id })
			}, option.id))
		})]
	});
}
function HomeSection({ draft, home, homeId }) {
	const worksHere = draft.habitat === "home";
	const winner = home?.instructions.files.find((file) => file.wins);
	return /* @__PURE__ */ jsx(Section, {
		id: "agent-home",
		title: "Home",
		lede: "Its own folder under your Dimension home: where it works when it lives at home, and where its standing instructions and notes follow it from.",
		children: /* @__PURE__ */ jsxs("div", {
			className: cn(PANEL, "flex flex-col gap-4 p-4 @3xl:flex-row @3xl:items-center"),
			children: [
				/* @__PURE__ */ jsx("span", {
					className: "flex size-16 shrink-0 items-center justify-center rounded-xl bg-fr-accent-dim text-fr-accent",
					children: /* @__PURE__ */ jsx(Icon, {
						name: "folder",
						size: 28,
						strokeWidth: 1.6
					})
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "flex min-w-0 flex-1 flex-col gap-1.5",
					children: [
						/* @__PURE__ */ jsxs("span", {
							className: "flex flex-wrap items-center gap-2",
							children: [
								/* @__PURE__ */ jsx("span", {
									className: "text-fr-md font-semibold text-fr-text",
									children: homeId ?? "No home"
								}),
								homeId !== void 0 ? /* @__PURE__ */ jsx(Badge, {
									tone: worksHere ? "accent" : "mute",
									variant: "soft",
									children: worksHere ? "Works here" : "Works where you open it"
								}) : null,
								home !== void 0 && homeId !== void 0 ? /* @__PURE__ */ jsx(Badge, {
									tone: home.folderExists ? "add" : "mute",
									variant: "soft",
									children: home.folderExists ? "Set up" : "Set up on its first session"
								}) : null
							]
						}),
						/* @__PURE__ */ jsx("span", {
							className: "fr-overflow font-secondary text-fr-xs text-fr-text-2",
							title: home?.folder ?? void 0,
							children: home?.folder ?? (homeId === void 0 ? "A project's own agent belongs to that project and has no home." : "Its folder under your Dimension home.")
						}),
						home !== void 0 ? /* @__PURE__ */ jsx("span", {
							className: "text-fr-xs text-fr-text-2",
							children: home.homeNote
						}) : null
					]
				}),
				winner !== void 0 ? /* @__PURE__ */ jsx("div", {
					className: "shrink-0 rounded-md border border-fr-border-soft bg-fr-bg px-3 py-2 @3xl:max-w-80",
					children: /* @__PURE__ */ jsx(FileCard, {
						name: "AGENTS.md",
						path: winner.path,
						note: `${winner.bytes} bytes`
					})
				}) : null
			]
		})
	});
}
function modelFor(pattern, models) {
	return models?.find((model) => `${model.providerId}/${model.modelId}` === pattern || model.modelId === pattern || model.label === pattern);
}
function contextLabel(tokens) {
	if (tokens === void 0) return void 0;
	return tokens >= 1e6 ? `${(tokens / 1e6).toFixed(tokens % 1e6 === 0 ? 0 : 1)}M context` : `${Math.round(tokens / 1e3)}k context`;
}
function ModelCard({ pattern, model, rank, editable, onUp, onDown, onRemove }) {
	const context = contextLabel(model?.contextWindow);
	return /* @__PURE__ */ jsxs("li", {
		className: "flex min-w-0 items-center gap-3 rounded-lg border border-fr-border-soft bg-fr-surface p-3",
		children: [
			/* @__PURE__ */ jsx("span", {
				className: "w-5 shrink-0 text-center font-secondary text-fr-xs text-fr-text-3 tabular-nums",
				children: rank
			}),
			model ? /* @__PURE__ */ jsx(ProviderBrandIcon, {
				providerId: model.providerId,
				providerName: model.providerName,
				size: "md"
			}) : /* @__PURE__ */ jsx(ProviderBrandIcon, {
				providerId: "",
				providerName: pattern,
				monogram: pattern.charAt(0).toUpperCase(),
				size: "md"
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex min-w-0 flex-1 flex-col gap-0.5",
				children: [/* @__PURE__ */ jsxs("span", {
					className: "flex min-w-0 items-center gap-2",
					children: [
						/* @__PURE__ */ jsx("span", {
							className: "fr-overflow text-fr-sm font-medium text-fr-text",
							children: model?.label ?? pattern
						}),
						rank === 1 ? /* @__PURE__ */ jsx(Badge, {
							tone: "accent",
							variant: "soft",
							children: "First choice"
						}) : null,
						model?.reasoning ? /* @__PURE__ */ jsx(Badge, {
							tone: "mute",
							variant: "soft",
							children: "Reasons"
						}) : null
					]
				}), /* @__PURE__ */ jsx("span", {
					className: "fr-overflow font-secondary text-fr-xs text-fr-text-2",
					children: model ? [
						model.providerName,
						context,
						model.available ? void 0 : "not connected"
					].filter(Boolean).join(" · ") : "Not in this host's catalog; used when it is"
				})]
			}),
			editable ? /* @__PURE__ */ jsxs("span", {
				className: "flex shrink-0 items-center gap-0.5",
				children: [
					/* @__PURE__ */ jsx("button", {
						type: "button",
						"aria-label": "Move up",
						disabled: onUp === void 0,
						onClick: onUp,
						className: "flex size-7 items-center justify-center rounded-md text-fr-text-2 hover:bg-fr-surface-2 hover:text-fr-text disabled:opacity-30",
						children: /* @__PURE__ */ jsx(Icon, {
							name: "arrowU",
							size: 13,
							strokeWidth: 2
						})
					}),
					/* @__PURE__ */ jsx("button", {
						type: "button",
						"aria-label": "Move down",
						disabled: onDown === void 0,
						onClick: onDown,
						className: "flex size-7 items-center justify-center rounded-md text-fr-text-2 hover:bg-fr-surface-2 hover:text-fr-text disabled:opacity-30",
						children: /* @__PURE__ */ jsx(Icon, {
							name: "arrowD",
							size: 13,
							strokeWidth: 2
						})
					}),
					/* @__PURE__ */ jsx("button", {
						type: "button",
						"aria-label": `Remove ${model?.label ?? pattern}`,
						onClick: onRemove,
						className: "flex size-7 items-center justify-center rounded-md text-fr-text-2 hover:bg-fr-surface-2 hover:text-fr-del",
						children: /* @__PURE__ */ jsx(Icon, {
							name: "x",
							size: 13,
							strokeWidth: 2
						})
					})
				]
			}) : null
		]
	});
}
var METER = THINKING_STEPS.filter((step) => step !== "inherit");
function ThinkingMeter({ value, editable, onChange }) {
	const level = METER.indexOf(value);
	return /* @__PURE__ */ jsxs("div", {
		className: "flex flex-wrap items-end gap-4",
		children: [/* @__PURE__ */ jsx("div", {
			role: "radiogroup",
			"aria-label": "Thinking",
			className: "flex items-end gap-1.5",
			children: METER.map((step, index) => {
				const on = value !== "inherit" && index <= level;
				return /* @__PURE__ */ jsxs("button", {
					type: "button",
					role: "radio",
					"aria-checked": value === step,
					"aria-label": humanize(step),
					disabled: !editable,
					onClick: () => onChange(step),
					className: "group/step flex flex-col items-center gap-1.5 disabled:cursor-default",
					children: [/* @__PURE__ */ jsx("span", {
						className: cn("w-9 rounded-sm fr-t-colors", on ? "bg-fr-accent" : "bg-fr-surface-3", editable && !on && "group-hover/step:bg-fr-border"),
						style: { height: `${10 + index * 7}px` }
					}), /* @__PURE__ */ jsx("span", {
						className: cn("font-secondary text-fr-2xs", value === step ? "text-fr-text" : "text-fr-text-2"),
						children: step === "xhigh" ? "Max" : humanize(step)
					})]
				}, step);
			})
		}), /* @__PURE__ */ jsx("button", {
			type: "button",
			role: "radio",
			"aria-checked": value === "inherit",
			disabled: !editable,
			onClick: () => onChange("inherit"),
			className: cn("rounded-full border px-3 py-1 font-secondary text-fr-xs fr-t-colors disabled:cursor-default", value === "inherit" ? "border-fr-accent-line bg-fr-accent-dim text-fr-accent" : "border-fr-border-soft text-fr-text-2 hover:border-fr-border"),
			children: "Dimension's default"
		})]
	});
}
function BrainSection({ draft, set, editable, models, marked }) {
	const held = heldByExtra(draft);
	const canModels = editable && !held.has("engine.model");
	const move = (from, to) => {
		const next = [...draft.models];
		const [moved] = next.splice(from, 1);
		if (moved !== void 0) next.splice(to, 0, moved);
		set({ models: next });
	};
	const options = (models ?? []).filter((model) => model.kind !== "classify" && !draft.models.includes(`${model.providerId}/${model.modelId}`)).map((model) => ({
		id: `${model.providerId}/${model.modelId}`,
		label: model.label,
		detail: [
			model.providerName,
			contextLabel(model.contextWindow),
			model.available ? void 0 : "not connected"
		].filter(Boolean).join(" · "),
		lead: /* @__PURE__ */ jsx(ProviderBrandIcon, {
			providerId: model.providerId,
			providerName: model.providerName,
			size: 20
		})
	}));
	return /* @__PURE__ */ jsx(Section, {
		id: "agent-brain",
		title: "Brain",
		lede: "The models it runs on, first available wins, and how hard it thinks.",
		aside: marked.has("thinking") ? /* @__PURE__ */ jsx(ProposedBadge, {}) : void 0,
		children: /* @__PURE__ */ jsxs("div", {
			className: "grid grid-cols-1 gap-4 @4xl:grid-cols-[3fr_2fr]",
			children: [/* @__PURE__ */ jsxs("div", {
				className: cn(PANEL, "flex flex-col gap-3 p-4"),
				children: [
					/* @__PURE__ */ jsx("span", {
						className: "text-fr-sm font-medium text-fr-text",
						children: "Model stack"
					}),
					held.has("engine.model") ? /* @__PURE__ */ jsx("p", {
						className: "m-0 text-fr-xs text-fr-text-2",
						children: "Its models are set in Other settings, under Advanced."
					}) : null,
					draft.models.length === 0 ? /* @__PURE__ */ jsxs("div", {
						className: "flex items-center gap-3 rounded-lg border border-dashed border-fr-border px-3 py-3",
						children: [/* @__PURE__ */ jsx("span", {
							className: "flex size-8 items-center justify-center rounded-md bg-fr-surface-3 text-fr-text-2",
							children: /* @__PURE__ */ jsx(Icon, {
								name: "aether",
								size: 16,
								strokeWidth: 1.8
							})
						}), /* @__PURE__ */ jsxs("span", {
							className: "flex flex-col gap-0.5",
							children: [/* @__PURE__ */ jsx("span", {
								className: "text-fr-sm font-medium text-fr-text",
								children: "Dimension's default model"
							}), /* @__PURE__ */ jsx("span", {
								className: "text-fr-xs text-fr-text-2",
								children: "Whatever model a session picks. Add one to pin it."
							})]
						})]
					}) : /* @__PURE__ */ jsx("ol", {
						className: "m-0 flex list-none flex-col gap-2 p-0",
						children: draft.models.map((pattern, index) => /* @__PURE__ */ jsx(ModelCard, {
							pattern,
							model: modelFor(pattern, models),
							rank: index + 1,
							editable: canModels,
							...index > 0 ? { onUp: () => move(index, index - 1) } : {},
							...index < draft.models.length - 1 ? { onDown: () => move(index, index + 1) } : {},
							onRemove: () => set({ models: draft.models.filter((entry) => entry !== pattern) })
						}, pattern))
					}),
					canModels ? /* @__PURE__ */ jsx(PickList, {
						placeholder: "Add a model",
						options,
						onPick: (id) => set({ models: [...draft.models, id] })
					}) : null
				]
			}), /* @__PURE__ */ jsxs("div", {
				className: cn(PANEL, "flex flex-col gap-3 p-4"),
				children: [
					/* @__PURE__ */ jsx("span", {
						className: "text-fr-sm font-medium text-fr-text",
						children: "Thinking"
					}),
					held.has("engine.thinkingLevel") ? /* @__PURE__ */ jsx("p", {
						className: "m-0 text-fr-xs text-fr-text-2",
						children: "Its thinking level is set in Other settings, under Advanced."
					}) : /* @__PURE__ */ jsx(ThinkingMeter, {
						value: draft.thinking,
						editable,
						onChange: (thinking) => set({ thinking })
					}),
					/* @__PURE__ */ jsx("span", {
						className: "text-fr-xs text-fr-text-2",
						children: "A session can still turn it up or down; this is where it starts."
					})
				]
			})]
		})
	});
}
var APPROVALS = [
	{
		id: "always-ask",
		icon: "hand",
		title: "Ask before everything",
		detail: "Every tool call waits for you."
	},
	{
		id: "write",
		icon: "edit",
		title: "Ask before writes",
		detail: "Reads freely; asks before it changes anything."
	},
	{
		id: "yolo",
		icon: "bolt",
		title: "Never asks",
		detail: "Runs every tool on its own. Only for agents you trust."
	}
];
var HABITATS = [
	{
		id: "bound",
		icon: "folder",
		title: "Where you open it",
		detail: "Works in the project you start its session in."
	},
	{
		id: "home",
		icon: "pin",
		title: "In its own home",
		detail: "Always works in its home folder, whatever is open."
	},
	{
		id: "ephemeral",
		icon: "branch",
		title: "A scratch copy",
		detail: "A throwaway worktree; nothing lands until you merge."
	}
];
/** The Dimension Control lanes (`capabilities.control`) and what each lets it do. */
var LANES = [
	{
		id: "observe",
		icon: "eye",
		label: "Observe",
		detail: "Read other sessions"
	},
	{
		id: "create",
		icon: "plus",
		label: "Create",
		detail: "Start sessions"
	},
	{
		id: "steer",
		icon: "send",
		label: "Steer",
		detail: "Message running sessions"
	},
	{
		id: "command",
		icon: "terminal",
		label: "Command",
		detail: "Run slash commands"
	},
	{
		id: "end",
		icon: "x",
		label: "End",
		detail: "Stop sessions"
	},
	{
		id: "rooms",
		icon: "orbit",
		label: "Rooms",
		detail: "Open and run rooms"
	},
	{
		id: "agents",
		icon: "bot",
		label: "Agents",
		detail: "Create agents"
	}
];
var DEFAULT_LANES = [
	"observe",
	"create",
	"steer",
	"command"
];
function SafetySection({ draft, set, editable }) {
	const held = heldByExtra(draft);
	const approval = draft.approval;
	const controlHeld = parseExtra(draft.extra).blocks.find((block) => block.key === "capabilities")?.children?.find((child) => child.key === "control") !== void 0 && extraList(draft.extra, "capabilities.control") === null;
	const declared = extraList(draft.extra, "capabilities.control");
	const lanes = declared ?? DEFAULT_LANES;
	const toggleLane = (lane) => {
		const next = lanes.includes(lane) ? lanes.filter((entry) => entry !== lane) : [...lanes, lane];
		const ordered = LANES.map((entry) => entry.id).filter((id) => next.includes(id));
		const same = ordered.length === DEFAULT_LANES.length && DEFAULT_LANES.every((id) => ordered.includes(id));
		set({ extra: setExtraPath(draft.extra, "capabilities.control", same ? null : flowList(ordered)) });
	};
	return /* @__PURE__ */ jsxs(Section, {
		id: "agent-safety",
		title: "Safety",
		lede: "How far it may go on its own. Only you set these: the Machinist can never propose them.",
		aside: /* @__PURE__ */ jsx(GrantLock, {}),
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "flex flex-col gap-2.5",
				children: [/* @__PURE__ */ jsxs("span", {
					className: "flex items-center justify-between gap-2 text-fr-sm font-medium text-fr-text",
					children: [/* @__PURE__ */ jsxs("span", {
						className: "flex items-center gap-1.5",
						children: ["Approval", /* @__PURE__ */ jsx(GrantLock, {})]
					}), /* @__PURE__ */ jsx("button", {
						type: "button",
						disabled: !editable || held.has("gate.approval"),
						onClick: () => set({ approval: "inherit" }),
						className: cn("rounded-full border px-3 py-1 font-secondary text-fr-xs font-normal fr-t-colors disabled:cursor-default", approval === "inherit" ? "border-fr-accent-line bg-fr-accent-dim text-fr-accent" : "border-fr-border-soft text-fr-text-2 hover:border-fr-border"),
						children: "Follow Dimension's setting"
					})]
				}), /* @__PURE__ */ jsx(ChoiceGroup, {
					label: "Approval",
					children: APPROVALS.map((option) => /* @__PURE__ */ jsx(ChoiceCard, {
						icon: option.icon,
						title: option.title,
						detail: option.detail,
						checked: approval === option.id,
						disabled: !editable || held.has("gate.approval"),
						onSelect: () => set({ approval: option.id })
					}, option.id))
				})]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex flex-col gap-2.5",
				children: [
					/* @__PURE__ */ jsxs("span", {
						className: "flex items-center gap-1.5 text-fr-sm font-medium text-fr-text",
						children: ["Where it runs", /* @__PURE__ */ jsx(GrantLock, {})]
					}),
					held.has("workspace.policy") ? /* @__PURE__ */ jsx("p", {
						className: "m-0 text-fr-xs text-fr-text-2",
						children: "Its workspace is set in Other settings, under Advanced."
					}) : null,
					/* @__PURE__ */ jsx(ChoiceGroup, {
						label: "Where it runs",
						children: HABITATS.map((option) => /* @__PURE__ */ jsx(ChoiceCard, {
							icon: option.icon,
							title: option.title,
							detail: option.detail,
							checked: !held.has("workspace.policy") && draft.habitat === option.id,
							disabled: !editable || held.has("workspace.policy"),
							onSelect: () => set({ habitat: option.id })
						}, option.id))
					})
				]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex flex-col gap-2.5",
				children: [
					/* @__PURE__ */ jsxs("span", {
						className: "flex items-center gap-1.5 text-fr-sm font-medium text-fr-text",
						children: [
							"Session lanes",
							/* @__PURE__ */ jsx(GrantLock, {}),
							/* @__PURE__ */ jsx("span", {
								className: "font-secondary text-fr-xs font-normal text-fr-text-2",
								children: declared === null ? "Dimension's default lanes" : `${lanes.length} of ${LANES.length}`
							})
						]
					}),
					controlHeld ? /* @__PURE__ */ jsx("p", {
						className: "m-0 text-fr-xs text-fr-text-2",
						children: "Its lanes carry per-lane approvals, set in Other settings under Advanced."
					}) : null,
					/* @__PURE__ */ jsx("div", {
						className: "flex flex-wrap gap-2",
						role: "group",
						"aria-label": "Session lanes",
						children: LANES.map((lane) => {
							const on = lanes.includes(lane.id);
							return /* @__PURE__ */ jsxs("button", {
								type: "button",
								"aria-pressed": on,
								disabled: !editable || controlHeld,
								onClick: () => toggleLane(lane.id),
								title: lane.detail,
								className: cn("inline-flex items-center gap-2 rounded-full border py-1.5 pr-3 pl-2 text-fr-sm fr-t-colors disabled:cursor-default", on ? "border-fr-accent-line bg-fr-accent-dim text-fr-text" : "border-fr-border-soft bg-fr-surface text-fr-text-2", editable && !controlHeld && !on && "hover:border-fr-border hover:text-fr-text"),
								children: [
									/* @__PURE__ */ jsx("span", {
										className: cn("flex size-5 items-center justify-center rounded-full", on ? "bg-fr-accent text-fr-accent-ink" : "bg-fr-surface-3 text-fr-text-3"),
										children: /* @__PURE__ */ jsx(Icon, {
											name: lane.icon,
											size: 11,
											strokeWidth: 2.2
										})
									}),
									lane.label,
									/* @__PURE__ */ jsx("span", {
										className: "font-secondary text-fr-xs text-fr-text-2",
										children: lane.detail
									})
								]
							}, lane.id);
						})
					})
				]
			})
		]
	});
}
function LineageSection({ draft, set, editable, roster, self, faceOf, bridged }) {
	const options = roster.filter((agent) => agent.name !== self && agent.name !== draft.name && !draft.lineage.includes(agent.name)).map((agent) => ({
		id: agent.name,
		label: displayName(agent),
		detail: `${agent.name} · ${TIER_LABEL[agent.tier]}`,
		lead: /* @__PURE__ */ jsx(FaceTile, {
			face: faceOf(agent.name),
			tile: 24,
			presence: 20,
			live: false,
			bridged,
			name: displayName(agent),
			ring: false,
			className: "rounded-md"
		})
	}));
	return /* @__PURE__ */ jsx(Section, {
		id: "agent-lineage",
		title: "Lineage",
		lede: "The agents it extends: it takes their settings, key by key, and its own win. Their charters are never inherited.",
		children: /* @__PURE__ */ jsxs("div", {
			className: cn(PANEL, "flex flex-col gap-3 p-4"),
			children: [draft.lineage.length === 0 ? /* @__PURE__ */ jsx("p", {
				className: "m-0 text-fr-sm text-fr-text-2",
				children: "It extends no agent: everything it is, it says itself."
			}) : /* @__PURE__ */ jsx("ul", {
				className: "m-0 grid list-none grid-cols-1 gap-2 p-0 @2xl:grid-cols-2 @5xl:grid-cols-3",
				children: draft.lineage.map((base, index) => {
					const agent = roster.find((candidate) => candidate.name === base);
					const title = agent ? displayName(agent) : humanize(base);
					return /* @__PURE__ */ jsxs("li", {
						className: "flex min-w-0 items-center gap-3 rounded-lg border border-fr-border-soft bg-fr-bg p-3",
						children: [
							/* @__PURE__ */ jsx(FaceTile, {
								face: faceOf(base),
								tile: 44,
								presence: 36,
								live: false,
								bridged,
								name: title
							}),
							/* @__PURE__ */ jsxs("div", {
								className: "flex min-w-0 flex-1 flex-col gap-0.5",
								children: [/* @__PURE__ */ jsx("span", {
									className: "fr-overflow text-fr-sm font-medium text-fr-text",
									children: title
								}), /* @__PURE__ */ jsx("span", {
									className: "fr-overflow font-secondary text-fr-xs text-fr-text-2",
									children: agent ? `${base} · ${TIER_LABEL[agent.tier]}` : `${base} · not installed`
								})]
							}),
							index === 0 && draft.lineage.length > 1 ? /* @__PURE__ */ jsx("span", {
								className: "font-secondary text-fr-2xs text-fr-text-3",
								children: "First"
							}) : null,
							editable ? /* @__PURE__ */ jsx("button", {
								type: "button",
								"aria-label": `Stop extending ${title}`,
								onClick: () => set({ lineage: draft.lineage.filter((entry) => entry !== base) }),
								className: "flex size-7 items-center justify-center rounded-md text-fr-text-2 hover:bg-fr-surface-2 hover:text-fr-del",
								children: /* @__PURE__ */ jsx(Icon, {
									name: "x",
									size: 13,
									strokeWidth: 2
								})
							}) : null
						]
					}, base);
				})
			}), editable ? /* @__PURE__ */ jsx(PickList, {
				placeholder: "Extend another agent",
				options,
				onPick: (name) => set({ lineage: [...draft.lineage, name] })
			}) : null]
		})
	});
}
function AdvancedSection({ draft, set, editable, homeId, problems, marked, proposedFrom }) {
	const grants = grantPathsIn(draft.extra);
	const document = manifestDocument(draft, homeId ?? null);
	const issues = [...document.problems, ...problems.filter((problem) => !document.problems.includes(problem))];
	const proposed = marked.has("extra") ? changedExtraPaths(proposedFrom, draft.extra) : [];
	return /* @__PURE__ */ jsx(Section, {
		id: "agent-advanced",
		title: "Advanced",
		lede: "Every manifest key the profile does not draw, as the file says it, and the agent.md this profile writes.",
		aside: proposed.length > 0 ? /* @__PURE__ */ jsx(ProposedBadge, {}) : void 0,
		children: /* @__PURE__ */ jsxs("div", {
			className: "grid grid-cols-1 gap-4 @5xl:grid-cols-2",
			children: [/* @__PURE__ */ jsxs("div", {
				className: cn(PANEL, "flex flex-col overflow-hidden"),
				children: [
					/* @__PURE__ */ jsxs("div", {
						className: "flex items-center justify-between gap-2 border-b border-fr-border-soft px-4 py-2.5",
						children: [/* @__PURE__ */ jsx("span", {
							className: "text-fr-sm font-medium text-fr-text",
							children: "Other settings"
						}), /* @__PURE__ */ jsx("span", {
							className: "font-secondary text-fr-xs text-fr-text-2",
							children: "YAML"
						})]
					}),
					/* @__PURE__ */ jsx(Textarea, {
						variant: "ghost",
						resize: "vertical",
						value: draft.extra,
						readOnly: !editable,
						"aria-label": "Other settings",
						spellCheck: false,
						placeholder: "title: Release Herald\nrouting:\n  card: Writes the changelog",
						onChange: (event) => set({ extra: event.target.value }),
						className: "max-h-none min-h-56 flex-1 rounded-none border-0 px-4 py-3 font-code text-fr-sm leading-relaxed"
					}),
					proposed.length > 0 ? /* @__PURE__ */ jsxs("p", {
						"data-slot": "proposed-keys",
						className: "m-0 flex items-center gap-2 border-t border-fr-accent-line bg-fr-accent-dim px-4 py-2 text-fr-xs text-fr-text",
						children: [
							/* @__PURE__ */ jsx(ProposedBadge, {}),
							"The Machinist set ",
							proposed.join(", "),
							"."
						]
					}) : null,
					grants.length > 0 ? /* @__PURE__ */ jsxs("p", {
						className: "m-0 flex items-center gap-2 border-t border-fr-border-soft px-4 py-2 text-fr-xs text-fr-text-2",
						children: [
							/* @__PURE__ */ jsx(GrantLock, {}),
							"Sets ",
							grants.join(", "),
							", which only you may set."
						]
					}) : null,
					issues.length > 0 ? /* @__PURE__ */ jsx("ul", {
						role: "alert",
						className: "m-0 flex list-none flex-col gap-1 border-t border-fr-border-soft px-4 py-2.5",
						children: issues.map((issue) => /* @__PURE__ */ jsxs("li", {
							className: "flex items-start gap-1.5 text-fr-xs text-fr-del",
							children: [/* @__PURE__ */ jsx(Icon, {
								name: "warnTri",
								size: 12,
								strokeWidth: 2,
								className: "mt-0.5 shrink-0"
							}), issue]
						}, issue))
					}) : null
				]
			}), /* @__PURE__ */ jsxs("div", {
				className: cn(PANEL, "flex flex-col overflow-hidden"),
				children: [/* @__PURE__ */ jsxs("div", {
					className: "flex items-center justify-between gap-2 border-b border-fr-border-soft px-4 py-2.5",
					children: [/* @__PURE__ */ jsx("span", {
						className: "text-fr-sm font-medium text-fr-text",
						children: "agent.md"
					}), /* @__PURE__ */ jsx("span", {
						className: "font-secondary text-fr-xs text-fr-text-2",
						children: "What a save writes"
					})]
				}), /* @__PURE__ */ jsx("pre", {
					className: "m-0 max-h-120 min-h-56 flex-1 overflow-auto bg-fr-bg px-4 py-3 font-code text-fr-xs leading-relaxed text-fr-text-2",
					children: document.lines.map((line, index) => /* @__PURE__ */ jsx(Line, {
						n: index + 1,
						extra: line.field.startsWith("extra."),
						children: line.text
					}, `${index}:${line.field}`))
				})]
			})]
		})
	});
}
function Line({ n, extra, children }) {
	return /* @__PURE__ */ jsxs("span", {
		className: "flex gap-3",
		children: [/* @__PURE__ */ jsx("span", {
			className: "w-6 shrink-0 text-right text-fr-text-3 select-none tabular-nums",
			children: n
		}), /* @__PURE__ */ jsx("span", {
			className: cn("min-w-0 whitespace-pre-wrap", extra ? "text-fr-text-2" : "text-fr-text"),
			children
		})]
	});
}
//#endregion
//#region page/sections-voice.tsx
/** What a pick at each layer is called in a sentence. */
var PICKING = {
	workspace: "this project",
	user: "you",
	agent: "the agent's own file"
};
/** What happens when a pick lands, so nobody wonders whether to press Save. */
var LANDS = {
	workspace: "Applies as soon as you pick it, to this agent in this project only.",
	user: "Applies as soon as you pick it, to this agent in every project that does not choose its own.",
	agent: "Saved with the rest of the profile, in its agent.md."
};
function InlineAlert({ text }) {
	return /* @__PURE__ */ jsxs("span", {
		role: "alert",
		className: "flex items-center gap-1.5 text-fr-xs text-fr-del",
		children: [/* @__PURE__ */ jsx(Icon, {
			name: "warnTri",
			size: 12,
			strokeWidth: 2
		}), text]
	});
}
/** A provider's mark: its initials on a tile. The state rides beside it as a dot, never as colour alone. */
function ProviderMark({ label, ready, speaking }) {
	return /* @__PURE__ */ jsxs("span", {
		"aria-hidden": "true",
		className: cn("relative flex size-5 shrink-0 items-center justify-center rounded-md font-secondary text-[9px] font-semibold", speaking ? "bg-fr-accent text-fr-accent-ink" : ready ? "bg-fr-surface-3 text-fr-text-2" : "bg-fr-surface-3 text-fr-text-3"),
		children: [monogram(label), !ready ? /* @__PURE__ */ jsx("span", { className: "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-fr-warn ring-1 ring-fr-surface" }) : null]
	});
}
/** The fallback chain in order: the step that will speak is lit, the ones tried first and unready are flagged. */
function Chain({ steps, speaking }) {
	return /* @__PURE__ */ jsx("ol", {
		className: "m-0 flex list-none flex-wrap items-center gap-x-1 gap-y-1 p-0",
		children: steps.map((step, index) => /* @__PURE__ */ jsxs("li", {
			className: "flex items-center gap-1",
			children: [
				/* @__PURE__ */ jsx(ProviderMark, {
					label: step.providerLabel,
					ready: step.ready,
					speaking: index === speaking
				}),
				/* @__PURE__ */ jsx("span", {
					className: cn("fr-overflow max-w-32 font-secondary text-fr-xs", index === speaking ? "text-fr-text" : step.ready ? "text-fr-text-2" : "text-fr-text-3"),
					children: step.providerLabel
				}),
				/* @__PURE__ */ jsx("span", {
					className: "sr-only",
					children: step.state.text
				}),
				index < steps.length - 1 ? /* @__PURE__ */ jsx("span", {
					"aria-hidden": "true",
					className: "text-fr-text-3",
					children: "›"
				}) : null
			]
		}, `${step.providerLabel}:${step.model}`))
	});
}
/** One sample at a time: pressed while this profile speaks (or is being made ready), a second press stops it. */
function PlayButton({ card, sampler, className }) {
	const phase = sampler.state.profile === card.name ? sampler.state.phase : "idle";
	const going = phase === "playing" || phase === "preparing";
	const cannot = card.speaksWith === null;
	return /* @__PURE__ */ jsx("button", {
		type: "button",
		"aria-label": going ? `Stop the ${card.name} sample` : `Play a sample of ${card.name}`,
		"aria-pressed": going,
		disabled: cannot,
		title: cannot ? "Nothing can speak this profile yet." : void 0,
		onClick: () => going ? sampler.stop() : sampler.play(card.name),
		className: cn("flex size-8 shrink-0 items-center justify-center rounded-full border fr-t-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line", going ? "border-fr-accent bg-fr-accent text-fr-accent-ink" : "border-fr-border bg-fr-bg text-fr-text-2 hover:bg-fr-surface-3 hover:text-fr-text", phase === "preparing" && "animate-pulse", cannot && "cursor-default opacity-50", className),
		children: /* @__PURE__ */ jsx(Icon, {
			name: going ? "pause" : "play",
			size: 13,
			strokeWidth: 2
		})
	});
}
/** The line under a profile: what speaks, and when something is in the way, a note saying what, in words a person can act on. */
function speaksLine(card) {
	const note = card.needs === void 0 ? {} : { note: card.needs };
	if (card.speaksWith === null) return {
		text: "Cannot speak yet",
		...note,
		warn: true
	};
	if (card.speaksWith.fellBack) return {
		text: `Falls back to ${card.speaksWith.label}`,
		...note,
		warn: true
	};
	return {
		text: `Speaks with ${card.speaksWith.label}`,
		warn: false
	};
}
function SoundsLike({ name, why, card, sampler }) {
	const line = card ? speaksLine(card) : void 0;
	return /* @__PURE__ */ jsxs("div", {
		className: "flex flex-wrap items-center gap-4",
		children: [
			/* @__PURE__ */ jsx("span", {
				className: cn("flex size-12 shrink-0 items-center justify-center rounded-xl", card !== void 0 && card.speaksWith !== null ? "bg-fr-accent-dim text-fr-accent" : "bg-fr-surface-3 text-fr-text-2"),
				children: /* @__PURE__ */ jsx(Icon, {
					name: "waveform",
					size: 22,
					strokeWidth: 1.6
				})
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex min-w-0 flex-1 flex-col gap-0.5",
				children: [
					/* @__PURE__ */ jsx("span", {
						className: LABEL,
						children: "Sounds like"
					}),
					/* @__PURE__ */ jsx("span", {
						className: "fr-overflow text-fr-md font-semibold text-fr-text",
						children: name ?? "No voice chosen"
					}),
					/* @__PURE__ */ jsxs("span", {
						className: "text-fr-xs leading-relaxed text-fr-text-2",
						children: [why, line ? /* @__PURE__ */ jsxs("span", {
							className: cn("ml-1.5", line.warn && "text-fr-warn"),
							children: ["· ", line.text]
						}) : null]
					}),
					line?.note ? /* @__PURE__ */ jsx("span", {
						className: "text-fr-xs leading-relaxed text-fr-text-2",
						children: line.note
					}) : null
				]
			}),
			card && sampler ? /* @__PURE__ */ jsx(PlayButton, {
				card,
				sampler
			}) : null
		]
	});
}
function LadderRowView({ row, state, selected, busy, onSelect, onClear }) {
	const body = /* @__PURE__ */ jsxs(Fragment, { children: [
		/* @__PURE__ */ jsx("span", {
			"aria-hidden": "true",
			className: cn("flex size-3.5 shrink-0 items-center justify-center rounded-full border", selected ? "border-fr-accent bg-fr-accent" : "border-fr-border", state === void 0 && "border-transparent"),
			children: selected ? /* @__PURE__ */ jsx("span", { className: "size-1.5 rounded-full bg-fr-accent-ink" }) : null
		}),
		/* @__PURE__ */ jsx("span", {
			className: "w-24 shrink-0 text-fr-sm text-fr-text",
			children: row.label
		}),
		/* @__PURE__ */ jsx("span", {
			className: cn("fr-overflow min-w-0 font-secondary text-fr-sm", row.value === null ? "text-fr-text-3" : "text-fr-text"),
			children: row.value ?? (row.reported ? "Nothing set" : "Not reported")
		}),
		row.pending ? /* @__PURE__ */ jsx(Badge, {
			tone: "mute",
			variant: "soft",
			className: "shrink-0 text-fr-xs",
			children: "Unsaved"
		}) : row.wins ? /* @__PURE__ */ jsx(Badge, {
			tone: "accent",
			variant: "soft",
			className: "shrink-0 text-fr-xs",
			children: "In use"
		}) : null
	] });
	const reason = state && !state.enabled ? state.reason : void 0;
	return /* @__PURE__ */ jsxs("div", {
		className: cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2", selected ? "border-fr-accent-line bg-fr-accent-dim" : "border-fr-border-soft bg-fr-bg", reason && !selected && "opacity-70"),
		children: [
			state === void 0 ? /* @__PURE__ */ jsx("div", {
				className: "flex min-w-0 flex-1 items-center gap-3",
				children: body
			}) : /* @__PURE__ */ jsx("button", {
				type: "button",
				role: "radio",
				"aria-checked": selected,
				disabled: !state.enabled || busy,
				onClick: onSelect,
				className: "flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line disabled:cursor-default",
				children: body
			}),
			state?.enabled && (row.value !== null || !row.reported) ? /* @__PURE__ */ jsx("button", {
				type: "button",
				disabled: busy,
				"aria-label": `Clear what ${PICKING[state.scope]} chose`,
				onClick: onClear,
				className: "shrink-0 rounded-md px-2 py-1 text-fr-xs text-fr-text-2 fr-t-colors hover:bg-fr-surface-3 hover:text-fr-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line disabled:cursor-default disabled:opacity-50",
				children: "Clear"
			}) : null,
			reason ? /* @__PURE__ */ jsx("span", {
				className: "w-full pl-[1.625rem] text-fr-xs text-fr-text-2",
				children: reason
			}) : null
		]
	});
}
function VoiceCard({ card, held, inUse, disabled, sampler, onPick }) {
	const line = speaksLine(card);
	const speaking = card.steps.findIndex((step) => step.ready);
	return /* @__PURE__ */ jsxs("div", {
		className: "relative",
		children: [/* @__PURE__ */ jsxs("button", {
			type: "button",
			role: "radio",
			"aria-checked": held,
			disabled,
			onClick: onPick,
			className: cn("flex h-full w-full min-w-0 flex-col items-start gap-2 rounded-lg border p-3.5 text-left fr-t-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fr-accent-line", sampler && "pr-14", held ? "border-fr-accent-line bg-fr-accent-dim" : "border-fr-border-soft bg-fr-surface", disabled ? "cursor-default" : held ? "" : "hover:border-fr-border hover:bg-fr-surface-2", disabled && !held && "opacity-60"),
			children: [
				/* @__PURE__ */ jsxs("span", {
					className: "flex min-w-0 items-center gap-2",
					children: [/* @__PURE__ */ jsx("span", {
						className: "fr-overflow text-fr-sm font-semibold text-fr-text",
						children: card.name
					}), inUse ? /* @__PURE__ */ jsx(Badge, {
						tone: "accent",
						variant: "soft",
						className: "shrink-0 text-fr-xs",
						children: "In use"
					}) : null]
				}),
				card.description ? /* @__PURE__ */ jsx("span", {
					className: "text-fr-xs leading-relaxed text-pretty text-fr-text-2",
					children: card.description
				}) : null,
				/* @__PURE__ */ jsx(Chain, {
					steps: card.steps,
					speaking
				}),
				/* @__PURE__ */ jsxs("span", {
					className: "flex flex-wrap items-center gap-x-2 text-fr-xs",
					children: [/* @__PURE__ */ jsx("span", {
						className: "text-fr-text-3",
						children: card.layerLabel
					}), /* @__PURE__ */ jsx("span", {
						className: line.warn ? "text-fr-warn" : "text-fr-text-2",
						children: line.text
					})]
				}),
				line.note ? /* @__PURE__ */ jsx("span", {
					className: "pr-6 text-fr-xs leading-relaxed text-pretty text-fr-text-2",
					children: line.note
				}) : null,
				held ? /* @__PURE__ */ jsx("span", {
					"aria-hidden": "true",
					className: "absolute right-3 bottom-3 flex size-4 items-center justify-center rounded-full bg-fr-accent text-fr-accent-ink",
					children: /* @__PURE__ */ jsx(Icon, {
						name: "check",
						size: 10,
						strokeWidth: 3
					})
				}) : null
			]
		}), sampler ? /* @__PURE__ */ jsx(PlayButton, {
			card,
			sampler,
			className: "absolute top-3 right-3"
		}) : null]
	});
}
function VoiceSection({ draft, set, editable, agentName, savedVoice, creating, kit, hasWorkspace, marked }) {
	const { profiles, agents, sampler, assigner } = kit;
	const lede = "How it sounds when it speaks. How it talks is its Spoken line, in Standing instructions.";
	const aside = marked.has("voice") ? /* @__PURE__ */ jsx(ProposedBadge, {}) : void 0;
	const [picked, setPicked] = useState(void 0);
	const [inflight, setInflight] = useState(0);
	const [error, setError] = useState(void 0);
	if (profiles === null) return /* @__PURE__ */ jsx(Section, {
		id: "agent-voice",
		title: "Voice",
		lede,
		aside,
		children: /* @__PURE__ */ jsxs("div", {
			className: cn(PANEL, "flex items-center gap-4 p-4"),
			children: [/* @__PURE__ */ jsx("span", {
				className: "flex size-10 shrink-0 items-center justify-center rounded-xl bg-fr-surface-3 text-fr-text-2",
				children: /* @__PURE__ */ jsx(Icon, {
					name: "waveform",
					size: 20,
					strokeWidth: 1.6
				})
			}), /* @__PURE__ */ jsxs("div", {
				className: "flex min-w-0 flex-col gap-0.5",
				children: [/* @__PURE__ */ jsx("span", {
					className: "text-fr-sm font-medium text-fr-text",
					children: "This build has no voice engine"
				}), /* @__PURE__ */ jsx("span", {
					className: "text-fr-xs leading-relaxed text-fr-text-2",
					children: "There is nothing to choose yet. A voice named in the agent's file is kept as written."
				})]
			})]
		})
	});
	const cards = profileCards(profiles);
	const resolved = agentName === void 0 ? void 0 : agents.get(agentName);
	const rows = ladder(resolved, draft.voice, profiles.defaultName, savedVoice);
	const writing = inflight > 0;
	const states = scopeStates({
		editable,
		canAssign: assigner !== void 0,
		hasWorkspace,
		exists: !creating,
		heldInFile: heldByExtra(draft).has("voice")
	});
	const active = picked !== void 0 && states.find((state) => state.scope === picked)?.enabled ? picked : defaultScope(states);
	const nowName = resolved?.name ?? (draft.voice !== "" ? draft.voice : profiles.defaultName);
	const nowWhy = resolved ? SOURCE_LABELS[resolved.source] : draft.voice !== "" ? SOURCE_LABELS.agent : profiles.defaultName ? SOURCE_LABELS.default : "";
	const heldHere = rows.find((row) => row.scope === active)?.value ?? null;
	const above = outrankedBy(active, rows);
	const write = (target, profile) => {
		setError(void 0);
		if (target === "agent") {
			set({ voice: profile ?? "" });
			return;
		}
		if (assigner === void 0 || agentName === void 0) return;
		setInflight((count) => count + 1);
		assigner.assign(agentName, profile, target).catch((cause) => setError(errorText(cause))).finally(() => setInflight((count) => count - 1));
	};
	return /* @__PURE__ */ jsx(Section, {
		id: "agent-voice",
		title: "Voice",
		lede,
		aside,
		children: /* @__PURE__ */ jsxs("div", {
			className: cn(PANEL, "flex flex-col gap-5 p-4"),
			children: [
				/* @__PURE__ */ jsx(SoundsLike, {
					name: nowName,
					why: nowWhy,
					card: cards.find((card) => card.name === nowName),
					sampler
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "flex flex-col gap-2",
					children: [
						/* @__PURE__ */ jsx("span", {
							className: "text-fr-sm font-medium text-fr-text",
							children: "Who decides"
						}),
						/* @__PURE__ */ jsx("span", {
							className: "text-fr-xs leading-relaxed text-fr-text-2",
							children: "The most specific choice wins. Pick the row you want to set, then a voice below."
						}),
						/* @__PURE__ */ jsx("div", {
							role: "radiogroup",
							"aria-label": "Set the voice for",
							className: "flex flex-col gap-1.5",
							children: rows.map((row) => {
								const state = states.find((entry) => entry.scope === row.scope);
								return /* @__PURE__ */ jsx(LadderRowView, {
									row,
									state,
									selected: state !== void 0 && row.scope === active,
									busy: writing,
									onSelect: () => state && setPicked(state.scope),
									onClear: () => state && write(state.scope, null)
								}, row.scope);
							})
						})
					]
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "flex flex-col gap-2.5",
					children: [
						/* @__PURE__ */ jsxs("div", {
							className: "flex flex-col gap-0.5",
							children: [
								/* @__PURE__ */ jsxs("span", {
									className: "text-fr-sm font-medium text-fr-text",
									children: ["Pick a voice for ", PICKING[active]]
								}),
								/* @__PURE__ */ jsx("span", {
									className: "text-fr-xs leading-relaxed text-fr-text-2",
									children: LANDS[active]
								}),
								above && above.value !== null ? /* @__PURE__ */ jsxs("span", {
									className: "text-fr-xs leading-relaxed text-fr-text-2",
									children: [
										above.label,
										" already chose ",
										/* @__PURE__ */ jsx("span", {
											className: "font-secondary text-fr-text",
											children: above.value
										}),
										", which outranks this."
									]
								}) : null
							]
						}),
						cards.length === 0 ? /* @__PURE__ */ jsx("p", {
							className: "m-0 rounded-lg border border-dashed border-fr-border px-4 py-3 text-fr-sm text-fr-text-2",
							children: "No voice profile is visible from this project."
						}) : /* @__PURE__ */ jsx(ChoiceGroup, {
							label: "Voice profiles",
							columns: 4,
							children: cards.map((card) => /* @__PURE__ */ jsx(VoiceCard, {
								card,
								held: heldHere === card.name,
								inUse: nowName === card.name,
								disabled: writing || states.find((state) => state.scope === active)?.enabled !== true,
								sampler,
								onPick: () => write(active, card.name)
							}, card.name))
						}),
						error !== void 0 ? /* @__PURE__ */ jsx(InlineAlert, { text: error }) : null,
						sampler?.state.phase === "error" && sampler.state.message ? /* @__PURE__ */ jsx(InlineAlert, { text: sampler.state.message }) : null
					]
				}),
				/* @__PURE__ */ jsx("p", {
					className: "m-0 border-t border-fr-border-soft pt-3 text-fr-xs leading-relaxed text-fr-text-2",
					children: "To write a new profile or add a provider key, open Settings, then Voice. This page only chooses between the profiles that exist."
				})
			]
		})
	});
}
//#endregion
//#region page/profile.tsx
var NAV = [
	{
		id: "identity",
		label: "Identity"
	},
	{
		id: "voice",
		label: "Voice"
	},
	{
		id: "charter",
		label: "Charter"
	},
	{
		id: "capabilities",
		label: "Capabilities"
	},
	{
		id: "memory",
		label: "Memory"
	},
	{
		id: "home",
		label: "Home"
	},
	{
		id: "brain",
		label: "Brain"
	},
	{
		id: "safety",
		label: "Safety"
	},
	{
		id: "lineage",
		label: "Lineage"
	},
	{
		id: "advanced",
		label: "Advanced"
	}
];
/** A face the human just picked shows as picked; otherwise the host's answer. */
function previewFace(state, faceOf) {
	const opened = state.agent?.draft.vibr;
	if (state.agent !== void 0 && state.draft.vibr === opened) return faceOf(state.agent.name);
	return { avatar: state.draft.vibr === "" ? "nebula" : state.draft.vibr };
}
function ProposalBanner({ fields, onDecide }) {
	return /* @__PURE__ */ jsxs("div", {
		role: "status",
		"data-slot": "agent-proposal",
		className: "flex flex-wrap items-center gap-3 rounded-lg border border-fr-accent-line bg-fr-accent-dim px-4 py-3",
		children: [
			/* @__PURE__ */ jsx("span", {
				className: "flex size-8 shrink-0 items-center justify-center rounded-md bg-fr-accent text-fr-accent-ink",
				children: /* @__PURE__ */ jsx(Icon, {
					name: "bot",
					size: 16,
					strokeWidth: 1.9
				})
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex min-w-0 flex-1 flex-col gap-0.5",
				children: [/* @__PURE__ */ jsx("span", {
					className: "text-fr-sm font-semibold text-fr-text",
					children: "Proposed by the Machinist"
				}), /* @__PURE__ */ jsx("span", {
					className: "text-fr-xs text-fr-text-2",
					children: fields.length > 0 ? `It set ${fields.join(", ")}. The marked parts below are its; accept to keep them, then save.` : "It named this agent. Accept to keep the draft, then save."
				})]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "flex gap-2",
				children: [/* @__PURE__ */ jsx(Button, {
					size: "sm",
					variant: "ghost",
					onClick: () => onDecide(false),
					children: "Discard"
				}), /* @__PURE__ */ jsxs(Button, {
					size: "sm",
					onClick: () => onDecide(true),
					children: [/* @__PURE__ */ jsx(Icon, {
						name: "check",
						strokeWidth: 2
					}), "Accept"]
				})]
			})
		]
	});
}
function SwitchField({ label, checked, disabled, onChange, locked }) {
	return /* @__PURE__ */ jsxs("label", {
		className: "flex items-center justify-between gap-3 rounded-md border border-fr-border-soft bg-fr-bg px-3 py-2",
		children: [/* @__PURE__ */ jsxs("span", {
			className: "flex items-center gap-1.5 text-fr-sm text-fr-text",
			children: [label, locked ? /* @__PURE__ */ jsx(GrantLock, {}) : null]
		}), onChange !== void 0 ? /* @__PURE__ */ jsx(Switch, {
			checked,
			disabled,
			onCheckedChange: onChange,
			"aria-label": label
		}) : /* @__PURE__ */ jsx("span", {
			className: cn("font-secondary text-fr-xs", checked ? "text-fr-text" : "text-fr-text-3"),
			children: checked ? "On" : "Off"
		})]
	});
}
function AgentProfile({ state, onChange, onClose, onExtend, onDecide, onSaved, forge, roster, listed, activity, usage, catalog, models, now, faceOf, bridged, onDock, configure, busy, notice, voice, hasWorkspace }) {
	const { draft } = state;
	const creating = isNew(state);
	const editable = state.readOnly === void 0;
	const agentName = state.agent?.name;
	const rosterAgent = roster.find((agent) => agent.name === agentName);
	const fact = rosterAgent?.fact;
	const set = useCallback((patch) => onChange({
		...state,
		draft: {
			...state.draft,
			...patch
		}
	}), [onChange, state]);
	const [live, setLive] = useState(false);
	const home = usePolled(useCallback(() => agentName === void 0 ? Promise.resolve(void 0) : forge.home(agentName), [forge, agentName]), null, `${agentName}`);
	const onDisk = home.value?.instructions.text ?? "";
	const [instructions, setInstructions] = useState(null);
	const instructionsText = instructions ?? onDisk;
	const instructionsDirty = instructions !== null && instructions !== onDisk;
	const agentDirty = isDirty(state);
	const [serverProblems, setServerProblems] = useState([]);
	useEffect(() => {
		if (!editable) return;
		let current = true;
		const timer = setTimeout(() => {
			forge.validate(draft).then((check) => current && setServerProblems(check.problems), () => current && setServerProblems([]));
		}, 400);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [
		forge,
		draft,
		editable
	]);
	const others = useMemo(() => listed.filter((agent) => agent.name !== agentName), [listed, agentName]);
	const errors = fieldErrors(state, others);
	const blockers = saveBlockers(state, others, serverProblems.filter((problem) => !problem.startsWith("Name it") && !problem.startsWith("Give it one line") && !problem.startsWith("Write its charter")));
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState(void 0);
	const save = async () => {
		setSaving(true);
		setSaveError(void 0);
		try {
			const target = agentDirty ? saveTargetOf(state) : void 0;
			if (typeof target === "string") throw new Error(target);
			const written = home.value?.instructions.target;
			await saveProfile(forge, {
				...target !== void 0 ? { agent: {
					draft,
					target
				} } : {},
				...instructionsDirty && agentName !== void 0 && written ? { instructions: {
					name: agentName,
					text: instructionsText,
					revision: written.revision
				} } : {}
			}, {
				agentWritten: () => onSaved(draft.name),
				instructionsWritten: async () => {
					await home.refresh();
					setInstructions(null);
				}
			});
		} catch (cause) {
			setSaveError(errorText(cause));
		} finally {
			setSaving(false);
		}
	};
	const title = creating ? draft.name === "" ? "New agent" : humanize(draft.name) : rosterAgent ? displayName(rosterAgent) : humanize(draft.name);
	const face = previewFace(state, faceOf);
	const act = agentName === void 0 ? NO_ACTIVITY : activity.get(agentName) ?? NO_ACTIVITY;
	const liveState = liveStateOf(act);
	const week = agentName === void 0 ? void 0 : usageOf(usage, agentName);
	const homeId = fact?.homeWorkspaceId ?? home.value?.homeId;
	const vitals = [
		{
			key: "sessions",
			icon: "chat",
			label: "Sessions 7d",
			value: `${act.sessions7d}`,
			title: `${act.sessionsTotal} sessions in all`,
			quiet: act.sessions7d === 0
		},
		{
			key: "tokens",
			icon: "waveform",
			label: "Tokens 7d",
			value: week ? tokenLabel(week.tokens) : "–",
			quiet: !week || week.tokens === 0,
			...week ? { title: `${week.turns} turns` } : {}
		},
		{
			key: "cost",
			icon: "chart",
			label: "Cost 7d",
			value: week ? money(week.cost) : "–",
			quiet: !week || week.cost === 0
		},
		{
			key: "active",
			icon: "clock",
			label: "Last active",
			value: agoLabel(act.lastActive, now),
			quiet: act.lastActive === null
		},
		{
			key: "rooms",
			icon: "orbit",
			label: "Rooms led",
			value: `${act.roomsLed}`,
			quiet: act.roomsLed === 0
		},
		{
			key: "home",
			icon: "folder",
			label: "Home",
			value: homeId ?? "None",
			quiet: homeId === void 0,
			...homeId ? { title: home.value?.folder ?? homeId } : {}
		}
	];
	const primary = !editable ? /* @__PURE__ */ jsxs(Button, {
		onClick: () => onExtend(draft),
		children: [/* @__PURE__ */ jsx(Icon, {
			name: "copy",
			strokeWidth: 2
		}), "Extend as a new agent"]
	}) : /* @__PURE__ */ jsxs(Button, {
		onClick: () => void save(),
		disabled: saving || blockers.length > 0 || !(agentDirty || instructionsDirty),
		children: [/* @__PURE__ */ jsx(Icon, {
			name: creating ? "plus" : "check",
			strokeWidth: 2
		}), creating ? "Create agent" : "Save"]
	});
	const dirty = editable && (agentDirty || instructionsDirty);
	const marked = new Set(state.proposal?.fields ?? []);
	return /* @__PURE__ */ jsxs(ViewColumn, {
		slot: "general-agent-profile",
		footer: dirty ? /* @__PURE__ */ jsx("div", {
			className: "pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-5",
			children: /* @__PURE__ */ jsxs("div", {
				"data-slot": "agent-save-bar",
				className: "pointer-events-auto flex w-full max-w-285 flex-wrap items-center gap-3 rounded-xl border border-fr-border bg-fr-surface px-4 py-3 shadow-md",
				children: [
					/* @__PURE__ */ jsx("span", {
						className: cn("flex size-2 shrink-0 rounded-full", blockers.length > 0 ? "bg-fr-warn" : "bg-fr-accent"),
						"aria-hidden": "true"
					}),
					/* @__PURE__ */ jsxs("div", {
						className: "flex min-w-0 flex-1 flex-col gap-0.5",
						children: [/* @__PURE__ */ jsx("span", {
							className: "text-fr-sm font-medium text-fr-text",
							children: creating ? "A new agent, not written yet" : agentDirty && instructionsDirty ? "Unsaved changes to the agent and its instructions" : instructionsDirty ? "Unsaved standing instructions" : "Unsaved changes"
						}), /* @__PURE__ */ jsx("span", {
							role: blockers.length > 0 || saveError ? "alert" : void 0,
							className: cn("fr-overflow text-fr-xs", saveError || blockers.length > 0 ? "text-fr-warn" : "text-fr-text-2"),
							children: saveError ?? (blockers.length > 0 ? blockers[0] + (blockers.length > 1 ? ` (and ${blockers.length - 1} more)` : "") : creating ? "Written into your own agents, where it gets a home." : `Writes ${state.agent?.source === "workspace" ? "this project's" : "your"} agent.md${instructionsDirty ? " and its AGENTS.md" : ""}.`)
						})]
					}),
					/* @__PURE__ */ jsx(Button, {
						size: "sm",
						variant: "ghost",
						onClick: () => {
							setInstructions(null);
							setSaveError(void 0);
							if (state.agent !== void 0) onChange({
								...state,
								draft: { ...state.agent.draft }
							});
							else onClose();
						},
						children: creating ? "Cancel" : "Discard changes"
					}),
					/* @__PURE__ */ jsxs(Button, {
						size: "sm",
						onClick: () => void save(),
						disabled: saving || blockers.length > 0,
						children: [/* @__PURE__ */ jsx(Icon, {
							name: creating ? "plus" : "check",
							strokeWidth: 2
						}), saving ? "Saving…" : creating ? "Create agent" : agentDirty && instructionsDirty ? "Save agent and instructions" : instructionsDirty ? "Save instructions" : "Save agent"]
					})
				]
			})
		}) : null,
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "-mb-3 flex items-center justify-between gap-3",
				children: [/* @__PURE__ */ jsxs(Button, {
					variant: "ghost",
					size: "sm",
					onClick: onClose,
					children: [/* @__PURE__ */ jsx(Icon, {
						name: "back",
						strokeWidth: 2
					}), "All agents"]
				}), onDock ? /* @__PURE__ */ jsxs(Button, {
					variant: "outline",
					size: "sm",
					onClick: onDock,
					children: [/* @__PURE__ */ jsx(Icon, {
						name: "bot",
						strokeWidth: 2
					}), "Ask the Machinist"]
				}) : null]
			}),
			state.proposal !== void 0 ? /* @__PURE__ */ jsx(ProposalBanner, {
				fields: state.proposal.fields,
				onDecide
			}) : null,
			/* @__PURE__ */ jsxs("header", {
				"data-slot": "agent-header",
				onPointerEnter: () => setLive(true),
				onPointerLeave: () => setLive(false),
				className: "relative isolate flex flex-col gap-5 overflow-hidden rounded-lg border border-fr-border-soft bg-fr-surface p-5 @3xl:flex-row @3xl:items-start",
				children: [
					/* @__PURE__ */ jsx("span", {
						"aria-hidden": "true",
						className: "pointer-events-none absolute -top-24 -left-16 size-80 rounded-full",
						style: { background: `radial-gradient(circle, ${faceWash(face, 16)}, transparent 70%)` }
					}),
					/* @__PURE__ */ jsx(FaceTile, {
						face,
						tile: 112,
						presence: 96,
						live,
						bridged,
						name: title,
						className: "relative"
					}),
					/* @__PURE__ */ jsxs("div", {
						className: "relative flex min-w-0 flex-1 flex-col gap-2",
						children: [
							/* @__PURE__ */ jsxs("div", {
								className: "flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5",
								children: [
									/* @__PURE__ */ jsx("h1", {
										className: "m-0 min-w-0 text-fr-2xl leading-tight font-semibold tracking-[-0.01em] text-fr-text",
										children: title
									}),
									/* @__PURE__ */ jsx(Badge, {
										tone: state.agent?.source === "pack" ? "mute" : "accent",
										variant: "soft",
										children: creating ? "New" : TIER_LABEL[state.agent?.source ?? "user"]
									}),
									/* @__PURE__ */ jsx(LivePill, {
										state: liveState,
										count: liveState === "needs-you" ? act.needsYou : act.working
									})
								]
							}),
							!creating ? /* @__PURE__ */ jsx("span", {
								className: "font-secondary text-fr-xs text-fr-text-2",
								children: draft.name
							}) : null,
							/* @__PURE__ */ jsx("p", {
								className: "m-0 max-w-prose text-fr-sm leading-relaxed text-pretty text-fr-text-2",
								children: draft.description || (creating ? "Say in one line what it is for, under Identity." : "No description yet.")
							}),
							draft.lineage.length > 0 ? /* @__PURE__ */ jsxs("span", {
								className: "flex flex-wrap items-center gap-1.5 font-secondary text-fr-xs text-fr-text-2",
								children: [
									/* @__PURE__ */ jsx(Icon, {
										name: "branch",
										size: 12,
										strokeWidth: 2
									}),
									"Extends",
									draft.lineage.map((base) => /* @__PURE__ */ jsx("span", {
										className: "rounded-sm bg-fr-surface-3 px-2 py-0.5 text-fr-text",
										children: titleOf(base, roster)
									}, base))
								]
							}) : null,
							state.readOnly !== void 0 ? /* @__PURE__ */ jsxs("span", {
								className: "flex items-center gap-1.5 text-fr-xs text-fr-text-2",
								children: [
									/* @__PURE__ */ jsx(Icon, {
										name: "lock",
										size: 12,
										strokeWidth: 2
									}),
									state.readOnly,
									" Extend it to make an agent of your own that starts from it."
								]
							}) : null
						]
					}),
					/* @__PURE__ */ jsxs("div", {
						className: "relative flex w-full shrink-0 flex-col gap-2 @3xl:w-60",
						children: [fact !== void 0 ? /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx(SwitchField, {
							label: "Enabled",
							checked: fact.enabled,
							disabled: busy.has(fact.name),
							onChange: configure !== void 0 && editable ? (on) => void configure(fact.name, { enabled: on }) : void 0
						}), /* @__PURE__ */ jsx(SwitchField, {
							label: "Show in rail",
							checked: fact.listed,
							disabled: busy.has(fact.name),
							onChange: configure !== void 0 ? (on) => void configure(fact.name, { listed: on }) : void 0
						})] }) : null, /* @__PURE__ */ jsx("div", {
							className: "flex [&>button]:w-full [&>button]:justify-center",
							children: primary
						})]
					})
				]
			}),
			!creating ? /* @__PURE__ */ jsx(VitalsStrip, {
				vitals,
				caption: usage ? `Sessions, tokens and cost cover the last 7 days; tokens and cost measured ${agoLabel(usage.updatedAt, now)}.` : "Sessions cover the last 7 days. Tokens and cost appear once this host measures them.",
				className: "-mt-2"
			}) : null,
			notice ? /* @__PURE__ */ jsx("p", {
				role: "alert",
				className: "m-0 -mt-3 text-fr-xs text-fr-warn",
				children: notice
			}) : null,
			/* @__PURE__ */ jsxs("nav", {
				"aria-label": "Profile sections",
				className: "sticky top-0 z-[5] -mx-1 -my-2 flex flex-wrap gap-1 border-b border-fr-border-soft bg-fr-bg px-1 py-2",
				children: [NAV.map((entry) => /* @__PURE__ */ jsx("button", {
					type: "button",
					onClick: () => document.getElementById(`agent-${entry.id}`)?.scrollIntoView({
						behavior: "smooth",
						block: "start"
					}),
					className: "rounded-full px-2.5 py-1 font-secondary text-fr-xs text-fr-text-2 fr-t-colors hover:bg-fr-surface-2 hover:text-fr-text",
					children: entry.label
				}, entry.id)), editable ? /* @__PURE__ */ jsxs("span", {
					className: "ml-auto flex items-center gap-1.5 px-2 font-secondary text-fr-xs text-fr-text-2",
					children: [/* @__PURE__ */ jsx(GrantLock, {}), " Only you set these; the Machinist can propose the rest."]
				}) : null]
			}),
			/* @__PURE__ */ jsx(IdentitySection, {
				draft,
				set,
				editable,
				creating,
				errors,
				face,
				faceOf,
				bridged,
				marked
			}),
			/* @__PURE__ */ jsx(VoiceSection, {
				draft,
				set,
				editable,
				agentName,
				savedVoice: state.agent?.draft.voice ?? "",
				creating,
				kit: voice,
				hasWorkspace,
				marked
			}),
			/* @__PURE__ */ jsx(CharterSection, {
				draft,
				set,
				editable,
				errors,
				agent: state.agent,
				marked
			}),
			/* @__PURE__ */ jsx(InstructionsSection, {
				home: home.value,
				error: home.error,
				creating,
				text: instructionsText,
				onText: setInstructions,
				editable
			}),
			/* @__PURE__ */ jsx(CapabilitiesSection, {
				draft,
				set,
				editable,
				catalog,
				marked
			}),
			/* @__PURE__ */ jsx(MemorySection, {
				draft,
				set,
				editable,
				homeId,
				marked
			}),
			/* @__PURE__ */ jsx(HomeSection, {
				draft,
				home: home.value,
				homeId
			}),
			/* @__PURE__ */ jsx(BrainSection, {
				draft,
				set,
				editable,
				models,
				marked
			}),
			/* @__PURE__ */ jsx(SafetySection, {
				draft,
				set,
				editable,
				marked
			}),
			/* @__PURE__ */ jsx(LineageSection, {
				draft,
				set,
				editable,
				roster,
				self: agentName,
				faceOf,
				bridged
			}),
			/* @__PURE__ */ jsx(AdvancedSection, {
				draft,
				set,
				editable,
				homeId,
				problems: serverProblems,
				marked,
				proposedFrom: state.proposal?.before?.extra ?? ""
			}),
			dirty ? /* @__PURE__ */ jsx("div", {
				"aria-hidden": "true",
				className: "h-16"
			}) : null
		]
	});
}
//#endregion
//#region page/page.css?inline
var page_default = "/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */\n@layer properties {\n  @supports (((-webkit-hyphens: none)) and (not (margin-trim: inline))) or ((-moz-orient: inline) and (not (color: rgb(from red r g b)))) {\n    *, :before, :after, ::backdrop {\n      --tw-translate-x: 0;\n      --tw-translate-y: 0;\n      --tw-translate-z: 0;\n      --tw-divide-x-reverse: 0;\n      --tw-border-style: solid;\n      --tw-leading: initial;\n      --tw-font-weight: initial;\n      --tw-tracking: initial;\n      --tw-ordinal: initial;\n      --tw-slashed-zero: initial;\n      --tw-numeric-figure: initial;\n      --tw-numeric-spacing: initial;\n      --tw-numeric-fraction: initial;\n      --tw-shadow: 0 0 #0000;\n      --tw-shadow-color: initial;\n      --tw-shadow-alpha: 100%;\n      --tw-inset-shadow: 0 0 #0000;\n      --tw-inset-shadow-color: initial;\n      --tw-inset-shadow-alpha: 100%;\n      --tw-ring-color: initial;\n      --tw-ring-shadow: 0 0 #0000;\n      --tw-inset-ring-color: initial;\n      --tw-inset-ring-shadow: 0 0 #0000;\n      --tw-ring-inset: initial;\n      --tw-ring-offset-width: 0px;\n      --tw-ring-offset-color: #fff;\n      --tw-ring-offset-shadow: 0 0 #0000;\n      --tw-outline-style: solid;\n      --tw-blur: initial;\n      --tw-brightness: initial;\n      --tw-contrast: initial;\n      --tw-grayscale: initial;\n      --tw-hue-rotate: initial;\n      --tw-invert: initial;\n      --tw-opacity: initial;\n      --tw-saturate: initial;\n      --tw-sepia: initial;\n      --tw-drop-shadow: initial;\n      --tw-drop-shadow-color: initial;\n      --tw-drop-shadow-alpha: 100%;\n      --tw-drop-shadow-size: initial;\n      --tw-content: \"\";\n    }\n  }\n}\n\n@layer theme, base, components;\n\n@layer utilities {\n  :where([data-slot=\"general-agents-page\"]) .\\@container {\n    container-type: inline-size;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pointer-events-auto {\n    pointer-events: auto;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pointer-events-none {\n    pointer-events: none;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .visible {\n    visibility: visible;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .sr-only {\n    clip-path: inset(50%);\n    white-space: nowrap;\n    border-width: 0;\n    width: 1px;\n    height: 1px;\n    margin: -1px;\n    padding: 0;\n    position: absolute;\n    overflow: hidden;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .absolute {\n    position: absolute;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .fixed {\n    position: fixed;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .relative {\n    position: relative;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .sticky {\n    position: sticky;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .inset-0 {\n    inset: 0;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .inset-x-0 {\n    inset-inline: 0;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .-top-24 {\n    top: calc(var(--spacing, .25rem) * -24);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .top-0 {\n    top: 0;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .top-1\\/2 {\n    top: 50%;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .top-3 {\n    top: calc(var(--spacing, .25rem) * 3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .top-full {\n    top: 100%;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .-right-0\\.5 {\n    right: calc(var(--spacing, .25rem) * -.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .right-0 {\n    right: 0;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .right-3 {\n    right: calc(var(--spacing, .25rem) * 3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .right-8 {\n    right: calc(var(--spacing, .25rem) * 8);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .-bottom-0\\.5 {\n    bottom: calc(var(--spacing, .25rem) * -.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .bottom-3 {\n    bottom: calc(var(--spacing, .25rem) * 3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .bottom-4 {\n    bottom: calc(var(--spacing, .25rem) * 4);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .-left-16 {\n    left: calc(var(--spacing, .25rem) * -16);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .left-0 {\n    left: 0;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .left-2\\.5 {\n    left: calc(var(--spacing, .25rem) * 2.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .left-8 {\n    left: calc(var(--spacing, .25rem) * 8);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .isolate {\n    isolation: isolate;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .z-10 {\n    z-index: 10;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .z-20 {\n    z-index: 20;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .z-\\[1\\] {\n    z-index: 1;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .z-\\[5\\] {\n    z-index: 5;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .col-start-2 {\n    grid-column-start: 2;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .m-0 {\n    margin: 0;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .-mx-1 {\n    margin-inline: calc(var(--spacing, .25rem) * -1);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .mx-4 {\n    margin-inline: calc(var(--spacing, .25rem) * 4);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .mx-auto {\n    margin-inline: auto;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .-my-2 {\n    margin-block: calc(var(--spacing, .25rem) * -2);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .-mt-2 {\n    margin-top: calc(var(--spacing, .25rem) * -2);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .-mt-3 {\n    margin-top: calc(var(--spacing, .25rem) * -3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .-mt-4 {\n    margin-top: calc(var(--spacing, .25rem) * -4);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .mt-0\\.5 {\n    margin-top: calc(var(--spacing, .25rem) * .5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .mt-1 {\n    margin-top: var(--spacing, .25rem);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .mt-1\\.5 {\n    margin-top: calc(var(--spacing, .25rem) * 1.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .mt-3 {\n    margin-top: calc(var(--spacing, .25rem) * 3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .mt-3\\.5 {\n    margin-top: calc(var(--spacing, .25rem) * 3.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .mt-auto {\n    margin-top: auto;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .-mb-3 {\n    margin-bottom: calc(var(--spacing, .25rem) * -3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .ml-1\\.5 {\n    margin-left: calc(var(--spacing, .25rem) * 1.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .ml-auto {\n    margin-left: auto;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .line-clamp-2 {\n    -webkit-line-clamp: 2;\n    -webkit-box-orient: vertical;\n    display: -webkit-box;\n    overflow: hidden;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .block {\n    display: block;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .contents {\n    display: contents;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .flex {\n    display: flex;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .grid {\n    display: grid;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .hidden {\n    display: none;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .inline {\n    display: inline;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .inline-flex {\n    display: inline-flex;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .size-1\\.5 {\n    width: calc(var(--spacing, .25rem) * 1.5);\n    height: calc(var(--spacing, .25rem) * 1.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .size-2 {\n    width: calc(var(--spacing, .25rem) * 2);\n    height: calc(var(--spacing, .25rem) * 2);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .size-3\\.5 {\n    width: calc(var(--spacing, .25rem) * 3.5);\n    height: calc(var(--spacing, .25rem) * 3.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .size-4 {\n    width: calc(var(--spacing, .25rem) * 4);\n    height: calc(var(--spacing, .25rem) * 4);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .size-5 {\n    width: calc(var(--spacing, .25rem) * 5);\n    height: calc(var(--spacing, .25rem) * 5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .size-7 {\n    width: calc(var(--spacing, .25rem) * 7);\n    height: calc(var(--spacing, .25rem) * 7);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .size-8 {\n    width: calc(var(--spacing, .25rem) * 8);\n    height: calc(var(--spacing, .25rem) * 8);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .size-9 {\n    width: calc(var(--spacing, .25rem) * 9);\n    height: calc(var(--spacing, .25rem) * 9);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .size-10 {\n    width: calc(var(--spacing, .25rem) * 10);\n    height: calc(var(--spacing, .25rem) * 10);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .size-12 {\n    width: calc(var(--spacing, .25rem) * 12);\n    height: calc(var(--spacing, .25rem) * 12);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .size-16 {\n    width: calc(var(--spacing, .25rem) * 16);\n    height: calc(var(--spacing, .25rem) * 16);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .size-80 {\n    width: calc(var(--spacing, .25rem) * 80);\n    height: calc(var(--spacing, .25rem) * 80);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .h-3 {\n    height: calc(var(--spacing, .25rem) * 3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .h-4 {\n    height: calc(var(--spacing, .25rem) * 4);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .h-9 {\n    height: calc(var(--spacing, .25rem) * 9);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .h-11 {\n    height: calc(var(--spacing, .25rem) * 11);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .h-16 {\n    height: calc(var(--spacing, .25rem) * 16);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .h-40 {\n    height: calc(var(--spacing, .25rem) * 40);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .h-full {\n    height: 100%;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .h-px {\n    height: 1px;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .max-h-72 {\n    max-height: calc(var(--spacing, .25rem) * 72);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .max-h-120 {\n    max-height: calc(var(--spacing, .25rem) * 120);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .max-h-none {\n    max-height: none;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .min-h-0 {\n    min-height: 0;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .min-h-5 {\n    min-height: calc(var(--spacing, .25rem) * 5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .min-h-7 {\n    min-height: calc(var(--spacing, .25rem) * 7);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .min-h-44 {\n    min-height: calc(var(--spacing, .25rem) * 44);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .min-h-56 {\n    min-height: calc(var(--spacing, .25rem) * 56);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .min-h-72 {\n    min-height: calc(var(--spacing, .25rem) * 72);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .min-h-\\[2lh\\] {\n    min-height: 2lh;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .w-5 {\n    width: calc(var(--spacing, .25rem) * 5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .w-6 {\n    width: calc(var(--spacing, .25rem) * 6);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .w-9 {\n    width: calc(var(--spacing, .25rem) * 9);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .w-24 {\n    width: calc(var(--spacing, .25rem) * 24);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .w-32 {\n    width: calc(var(--spacing, .25rem) * 32);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .w-36 {\n    width: calc(var(--spacing, .25rem) * 36);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .w-40 {\n    width: calc(var(--spacing, .25rem) * 40);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .w-full {\n    width: 100%;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .max-w-24 {\n    max-width: calc(var(--spacing, .25rem) * 24);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .max-w-32 {\n    max-width: calc(var(--spacing, .25rem) * 32);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .max-w-56 {\n    max-width: calc(var(--spacing, .25rem) * 56);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .max-w-285 {\n    max-width: calc(var(--spacing, .25rem) * 285);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .max-w-295 {\n    max-width: calc(var(--spacing, .25rem) * 295);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .max-w-full {\n    max-width: 100%;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .max-w-md {\n    max-width: var(--container-md, 28rem);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .max-w-prose {\n    max-width: 65ch;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .min-w-0 {\n    min-width: 0;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .min-w-48 {\n    min-width: calc(var(--spacing, .25rem) * 48);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .flex-1 {\n    flex: 1;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .shrink-0 {\n    flex-shrink: 0;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .-translate-y-1\\/2 {\n    --tw-translate-y: calc(calc(1 / 2 * 100%) * -1);\n    translate: var(--tw-translate-x) var(--tw-translate-y);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .translate-y-px {\n    --tw-translate-y: 1px;\n    translate: var(--tw-translate-x) var(--tw-translate-y);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .animate-pulse {\n    animation: var(--animate-pulse, pulse 2s cubic-bezier(.4, 0, .6, 1) infinite);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .cursor-default {\n    cursor: default;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .resize {\n    resize: both;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .scroll-mt-16 {\n    scroll-margin-top: calc(var(--spacing, .25rem) * 16);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .\\[scrollbar-gutter\\:stable\\] {\n    scrollbar-gutter: stable;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .list-none {\n    list-style-type: none;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .grid-cols-1 {\n    grid-template-columns: repeat(1, minmax(0, 1fr));\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .grid-cols-2 {\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .grid-cols-4 {\n    grid-template-columns: repeat(4, minmax(0, 1fr));\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .grid-cols-\\[2\\.5rem_minmax\\(0\\,1fr\\)\\] {\n    grid-template-columns: 2.5rem minmax(0, 1fr);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .grid-cols-\\[repeat\\(auto-fill\\,minmax\\(5\\.5rem\\,1fr\\)\\)\\] {\n    grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr));\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .flex-col {\n    flex-direction: column;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .flex-col-reverse {\n    flex-direction: column-reverse;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .flex-wrap {\n    flex-wrap: wrap;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .items-baseline {\n    align-items: baseline;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .items-center {\n    align-items: center;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .items-end {\n    align-items: flex-end;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .items-start {\n    align-items: flex-start;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .justify-between {\n    justify-content: space-between;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .justify-center {\n    justify-content: center;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-0\\.5 {\n    gap: calc(var(--spacing, .25rem) * .5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-1 {\n    gap: var(--spacing, .25rem);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-1\\.5 {\n    gap: calc(var(--spacing, .25rem) * 1.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-2 {\n    gap: calc(var(--spacing, .25rem) * 2);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-2\\.5 {\n    gap: calc(var(--spacing, .25rem) * 2.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-3 {\n    gap: calc(var(--spacing, .25rem) * 3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-3\\.5 {\n    gap: calc(var(--spacing, .25rem) * 3.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-4 {\n    gap: calc(var(--spacing, .25rem) * 4);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-5 {\n    gap: calc(var(--spacing, .25rem) * 5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-6 {\n    gap: calc(var(--spacing, .25rem) * 6);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-7 {\n    gap: calc(var(--spacing, .25rem) * 7);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-x-1 {\n    column-gap: var(--spacing, .25rem);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-x-2 {\n    column-gap: calc(var(--spacing, .25rem) * 2);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-x-2\\.5 {\n    column-gap: calc(var(--spacing, .25rem) * 2.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-x-3 {\n    column-gap: calc(var(--spacing, .25rem) * 3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-x-3\\.5 {\n    column-gap: calc(var(--spacing, .25rem) * 3.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-x-6 {\n    column-gap: calc(var(--spacing, .25rem) * 6);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-y-1 {\n    row-gap: var(--spacing, .25rem);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-y-1\\.5 {\n    row-gap: calc(var(--spacing, .25rem) * 1.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .gap-y-5 {\n    row-gap: calc(var(--spacing, .25rem) * 5);\n  }\n\n  :where(:where([data-slot=\"general-agents-page\"]) .divide-x > :not(:last-child)) {\n    --tw-divide-x-reverse: 0;\n    border-inline-style: var(--tw-border-style);\n    border-inline-start-width: calc(1px * var(--tw-divide-x-reverse));\n    border-inline-end-width: calc(1px * calc(1 - var(--tw-divide-x-reverse)));\n  }\n\n  :where(:where([data-slot=\"general-agents-page\"]) .divide-fr-border-soft > :not(:last-child)) {\n    border-color: var(--fr-border-soft);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .overflow-auto {\n    overflow: auto;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .overflow-hidden {\n    overflow: hidden;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .overflow-y-auto {\n    overflow-y: auto;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .rounded {\n    border-radius: .25rem;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .rounded-full {\n    border-radius: 3.40282e38px;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .rounded-lg {\n    border-radius: var(--fr-r);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .rounded-md {\n    border-radius: calc(var(--fr-r) - 2px);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .rounded-none {\n    border-radius: 0;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .rounded-sm {\n    border-radius: calc(var(--fr-r) - 4px);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .rounded-xl {\n    border-radius: calc(var(--fr-r) + 4px);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .border {\n    border-style: var(--tw-border-style);\n    border-width: 1px;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .border-0 {\n    border-style: var(--tw-border-style);\n    border-width: 0;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .border-t {\n    border-top-style: var(--tw-border-style);\n    border-top-width: 1px;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .border-b {\n    border-bottom-style: var(--tw-border-style);\n    border-bottom-width: 1px;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .border-dashed {\n    --tw-border-style: dashed;\n    border-style: dashed;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .border-fr-accent {\n    border-color: var(--fr-accent);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .border-fr-accent-line {\n    border-color: var(--fr-accent-line);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .border-fr-border {\n    border-color: var(--fr-border);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .border-fr-border-soft {\n    border-color: var(--fr-border-soft);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .border-fr-del\\/60 {\n    border-color: var(--fr-del);\n  }\n\n  @supports (color: color-mix(in lab, red, red)) {\n    :where([data-slot=\"general-agents-page\"]) .border-fr-del\\/60 {\n      border-color: color-mix(in oklab, var(--fr-del) 60%, transparent);\n    }\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .border-fr-iris\\/40 {\n    border-color: var(--fr-iris);\n  }\n\n  @supports (color: color-mix(in lab, red, red)) {\n    :where([data-slot=\"general-agents-page\"]) .border-fr-iris\\/40 {\n      border-color: color-mix(in oklab, var(--fr-iris) 40%, transparent);\n    }\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .border-transparent {\n    border-color: #0000;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .bg-fr-accent {\n    background-color: var(--fr-accent);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .bg-fr-accent-dim, :where([data-slot=\"general-agents-page\"]) .bg-fr-accent-dim\\/40 {\n    background-color: var(--fr-accent-dim);\n  }\n\n  @supports (color: color-mix(in lab, red, red)) {\n    :where([data-slot=\"general-agents-page\"]) .bg-fr-accent-dim\\/40 {\n      background-color: color-mix(in oklab, var(--fr-accent-dim) 40%, transparent);\n    }\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .bg-fr-accent-ink {\n    background-color: var(--fr-accent-ink);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .bg-fr-bg {\n    background-color: var(--fr-bg);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .bg-fr-border {\n    background-color: var(--fr-border);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .bg-fr-iris\\/15 {\n    background-color: var(--fr-iris);\n  }\n\n  @supports (color: color-mix(in lab, red, red)) {\n    :where([data-slot=\"general-agents-page\"]) .bg-fr-iris\\/15 {\n      background-color: color-mix(in oklab, var(--fr-iris) 15%, transparent);\n    }\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .bg-fr-surface {\n    background-color: var(--fr-surface);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .bg-fr-surface-2\\/50 {\n    background-color: var(--fr-surface-2);\n  }\n\n  @supports (color: color-mix(in lab, red, red)) {\n    :where([data-slot=\"general-agents-page\"]) .bg-fr-surface-2\\/50 {\n      background-color: color-mix(in oklab, var(--fr-surface-2) 50%, transparent);\n    }\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .bg-fr-surface-3 {\n    background-color: var(--fr-surface-3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .bg-fr-warn {\n    background-color: var(--fr-warn);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .p-0 {\n    padding: 0;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .p-1 {\n    padding: var(--spacing, .25rem);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .p-1\\.5 {\n    padding: calc(var(--spacing, .25rem) * 1.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .p-3 {\n    padding: calc(var(--spacing, .25rem) * 3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .p-3\\.5 {\n    padding: calc(var(--spacing, .25rem) * 3.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .p-4 {\n    padding: calc(var(--spacing, .25rem) * 4);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .p-5 {\n    padding: calc(var(--spacing, .25rem) * 5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .px-1 {\n    padding-inline: var(--spacing, .25rem);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .px-2 {\n    padding-inline: calc(var(--spacing, .25rem) * 2);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .px-2\\.5 {\n    padding-inline: calc(var(--spacing, .25rem) * 2.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .px-3 {\n    padding-inline: calc(var(--spacing, .25rem) * 3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .px-3\\.5 {\n    padding-inline: calc(var(--spacing, .25rem) * 3.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .px-4 {\n    padding-inline: calc(var(--spacing, .25rem) * 4);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .px-5 {\n    padding-inline: calc(var(--spacing, .25rem) * 5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .px-6 {\n    padding-inline: calc(var(--spacing, .25rem) * 6);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .py-0\\.5 {\n    padding-block: calc(var(--spacing, .25rem) * .5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .py-1 {\n    padding-block: var(--spacing, .25rem);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .py-1\\.5 {\n    padding-block: calc(var(--spacing, .25rem) * 1.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .py-2 {\n    padding-block: calc(var(--spacing, .25rem) * 2);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .py-2\\.5 {\n    padding-block: calc(var(--spacing, .25rem) * 2.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .py-3 {\n    padding-block: calc(var(--spacing, .25rem) * 3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .py-6 {\n    padding-block: calc(var(--spacing, .25rem) * 6);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pt-0\\.5 {\n    padding-top: calc(var(--spacing, .25rem) * .5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pt-1 {\n    padding-top: var(--spacing, .25rem);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pt-3 {\n    padding-top: calc(var(--spacing, .25rem) * 3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pt-4 {\n    padding-top: calc(var(--spacing, .25rem) * 4);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pt-5 {\n    padding-top: calc(var(--spacing, .25rem) * 5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pt-8 {\n    padding-top: calc(var(--spacing, .25rem) * 8);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pr-2 {\n    padding-right: calc(var(--spacing, .25rem) * 2);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pr-3 {\n    padding-right: calc(var(--spacing, .25rem) * 3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pr-5 {\n    padding-right: calc(var(--spacing, .25rem) * 5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pr-6 {\n    padding-right: calc(var(--spacing, .25rem) * 6);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pr-14 {\n    padding-right: calc(var(--spacing, .25rem) * 14);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pb-7 {\n    padding-bottom: calc(var(--spacing, .25rem) * 7);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pb-12 {\n    padding-bottom: calc(var(--spacing, .25rem) * 12);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pl-1\\.5 {\n    padding-left: calc(var(--spacing, .25rem) * 1.5);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pl-2 {\n    padding-left: calc(var(--spacing, .25rem) * 2);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pl-8 {\n    padding-left: calc(var(--spacing, .25rem) * 8);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .pl-\\[1\\.625rem\\] {\n    padding-left: 1.625rem;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-center {\n    text-align: center;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-left {\n    text-align: left;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-right {\n    text-align: right;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .font-code {\n    font-family: var(--fr-font-code);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .font-secondary {\n    font-family: var(--fr-font-secondary);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-\\[9px\\] {\n    font-size: 9px;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-fr-2xl {\n    font-size: var(--fr-fs-2xl);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-fr-2xs {\n    font-size: var(--fr-fs-2xs);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-fr-lg {\n    font-size: var(--fr-fs-lg);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-fr-md {\n    font-size: var(--fr-fs-md);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-fr-sm {\n    font-size: var(--fr-fs-sm);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-fr-xs {\n    font-size: var(--fr-fs-xs);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .leading-none {\n    --tw-leading: 1;\n    line-height: 1;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .leading-relaxed {\n    --tw-leading: var(--leading-relaxed, 1.625);\n    line-height: var(--leading-relaxed, 1.625);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .leading-tight {\n    --tw-leading: var(--leading-tight, 1.25);\n    line-height: var(--leading-tight, 1.25);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .font-medium {\n    --tw-font-weight: var(--font-weight-medium, 500);\n    font-weight: var(--font-weight-medium, 500);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .font-normal {\n    --tw-font-weight: var(--font-weight-normal, 400);\n    font-weight: var(--font-weight-normal, 400);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .font-semibold {\n    --tw-font-weight: var(--font-weight-semibold, 600);\n    font-weight: var(--font-weight-semibold, 600);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .tracking-\\[-0\\.01em\\] {\n    --tw-tracking: -.01em;\n    letter-spacing: -.01em;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .tracking-fr-label {\n    --tw-tracking: var(--fr-tracking-label);\n    letter-spacing: var(--fr-tracking-label);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-balance {\n    text-wrap: balance;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-pretty {\n    text-wrap: pretty;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .break-words {\n    overflow-wrap: break-word;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .whitespace-pre-wrap {\n    white-space: pre-wrap;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-fr-accent {\n    color: var(--fr-accent);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-fr-accent-ink {\n    color: var(--fr-accent-ink);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-fr-del {\n    color: var(--fr-del);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-fr-iris {\n    color: var(--fr-iris);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-fr-text {\n    color: var(--fr-text);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-fr-text-2 {\n    color: var(--fr-text-2);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-fr-text-3 {\n    color: var(--fr-text-3);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-fr-text\\/80 {\n    color: var(--fr-text);\n  }\n\n  @supports (color: color-mix(in lab, red, red)) {\n    :where([data-slot=\"general-agents-page\"]) .text-fr-text\\/80 {\n      color: color-mix(in oklab, var(--fr-text) 80%, transparent);\n    }\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-fr-warn {\n    color: var(--fr-warn);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .text-transparent {\n    color: #0000;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .lowercase {\n    text-transform: lowercase;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .uppercase {\n    text-transform: uppercase;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .tabular-nums {\n    --tw-numeric-spacing: tabular-nums;\n    font-variant-numeric: var(--tw-ordinal, ) var(--tw-slashed-zero, ) var(--tw-numeric-figure, ) var(--tw-numeric-spacing, ) var(--tw-numeric-fraction, );\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .opacity-50 {\n    opacity: .5;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .opacity-55 {\n    opacity: .55;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .opacity-60 {\n    opacity: .6;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .opacity-70 {\n    opacity: .7;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .opacity-80 {\n    opacity: .8;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .shadow-\\[inset_0_1px_0_color-mix\\(in_oklab\\,var\\(--fr-text\\)_10\\%\\,transparent\\)\\] {\n    --tw-shadow: inset 0 1px 0 var(--tw-shadow-color, var(--fr-text));\n  }\n\n  @supports (color: color-mix(in lab, red, red)) {\n    :where([data-slot=\"general-agents-page\"]) .shadow-\\[inset_0_1px_0_color-mix\\(in_oklab\\,var\\(--fr-text\\)_10\\%\\,transparent\\)\\] {\n      --tw-shadow: inset 0 1px 0 var(--tw-shadow-color, color-mix(in oklab,var(--fr-text) 10%,transparent));\n    }\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .shadow-\\[inset_0_1px_0_color-mix\\(in_oklab\\,var\\(--fr-text\\)_10\\%\\,transparent\\)\\] {\n    box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .shadow-md {\n    --tw-shadow: 0 4px 6px -1px var(--tw-shadow-color, #0000001a), 0 2px 4px -2px var(--tw-shadow-color, #0000001a);\n    box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .ring, :where([data-slot=\"general-agents-page\"]) .ring-1 {\n    --tw-ring-shadow: var(--tw-ring-inset, ) 0 0 0 calc(1px + var(--tw-ring-offset-width)) var(--tw-ring-color, currentcolor);\n    box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .ring-fr-surface {\n    --tw-ring-color: var(--fr-surface);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .outline {\n    outline-style: var(--tw-outline-style);\n    outline-width: 1px;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .saturate-0 {\n    --tw-saturate: saturate(0%);\n    filter: var(--tw-blur, ) var(--tw-brightness, ) var(--tw-contrast, ) var(--tw-grayscale, ) var(--tw-hue-rotate, ) var(--tw-invert, ) var(--tw-saturate, ) var(--tw-sepia, ) var(--tw-drop-shadow, );\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .filter {\n    filter: var(--tw-blur, ) var(--tw-brightness, ) var(--tw-contrast, ) var(--tw-grayscale, ) var(--tw-hue-rotate, ) var(--tw-invert, ) var(--tw-saturate, ) var(--tw-sepia, ) var(--tw-drop-shadow, );\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .select-none {\n    -webkit-user-select: none;\n    user-select: none;\n  }\n\n  @media (hover: hover) {\n    :where([data-slot=\"general-agents-page\"]) .group-hover\\/card\\:border-fr-border:is(:where(.group\\/card):hover *) {\n      border-color: var(--fr-border);\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .group-hover\\/step\\:bg-fr-border:is(:where(.group\\/step):hover *) {\n      background-color: var(--fr-border);\n    }\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .after\\:absolute:after {\n    content: var(--tw-content);\n    position: absolute;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .after\\:inset-0:after {\n    content: var(--tw-content);\n    inset: 0;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .after\\:rounded-lg:after {\n    content: var(--tw-content);\n    border-radius: var(--fr-r);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .after\\:content-\\[\\'\\'\\]:after {\n    --tw-content: \"\";\n    content: var(--tw-content);\n  }\n\n  @media (hover: hover) {\n    :where([data-slot=\"general-agents-page\"]) .hover\\:border-fr-border:hover {\n      border-color: var(--fr-border);\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .hover\\:border-fr-iris\\/70:hover {\n      border-color: var(--fr-iris);\n    }\n\n    @supports (color: color-mix(in lab, red, red)) {\n      :where([data-slot=\"general-agents-page\"]) .hover\\:border-fr-iris\\/70:hover {\n        border-color: color-mix(in oklab, var(--fr-iris) 70%, transparent);\n      }\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .hover\\:bg-fr-surface-2:hover {\n      background-color: var(--fr-surface-2);\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .hover\\:bg-fr-surface-3:hover {\n      background-color: var(--fr-surface-3);\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .hover\\:text-fr-del:hover {\n      color: var(--fr-del);\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .hover\\:text-fr-text:hover {\n      color: var(--fr-text);\n    }\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .focus-visible\\:bg-fr-surface-2:focus-visible {\n    background-color: var(--fr-surface-2);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .focus-visible\\:ring-2:focus-visible {\n    --tw-ring-shadow: var(--tw-ring-inset, ) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color, currentcolor);\n    box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .focus-visible\\:ring-fr-accent-line:focus-visible {\n    --tw-ring-color: var(--fr-accent-line);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .focus-visible\\:outline-none:focus-visible {\n    --tw-outline-style: none;\n    outline-style: none;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .focus-visible\\:after\\:ring-2:focus-visible:after {\n    content: var(--tw-content);\n    --tw-ring-shadow: var(--tw-ring-inset, ) 0 0 0 calc(2px + var(--tw-ring-offset-width)) var(--tw-ring-color, currentcolor);\n    box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .focus-visible\\:after\\:ring-fr-accent-line:focus-visible:after {\n    content: var(--tw-content);\n    --tw-ring-color: var(--fr-accent-line);\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .disabled\\:cursor-default:disabled {\n    cursor: default;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .disabled\\:opacity-30:disabled {\n    opacity: .3;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .disabled\\:opacity-50:disabled {\n    opacity: .5;\n  }\n\n  @container (min-width: 28rem) {\n    :where([data-slot=\"general-agents-page\"]) .\\@md\\:grid-cols-3 {\n      grid-template-columns: repeat(3, minmax(0, 1fr));\n    }\n  }\n\n  @container (min-width: 36rem) {\n    :where([data-slot=\"general-agents-page\"]) .\\@xl\\:grid-cols-2 {\n      grid-template-columns: repeat(2, minmax(0, 1fr));\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .\\@xl\\:grid-cols-3 {\n      grid-template-columns: repeat(3, minmax(0, 1fr));\n    }\n  }\n\n  @container (min-width: 42rem) {\n    :where([data-slot=\"general-agents-page\"]) .\\@2xl\\:w-56 {\n      width: calc(var(--spacing, .25rem) * 56);\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .\\@2xl\\:grid-cols-2 {\n      grid-template-columns: repeat(2, minmax(0, 1fr));\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .\\@2xl\\:flex-row {\n      flex-direction: row;\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .\\@2xl\\:items-start {\n      align-items: flex-start;\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .\\@2xl\\:gap-6 {\n      gap: calc(var(--spacing, .25rem) * 6);\n    }\n  }\n\n  @container (min-width: 48rem) {\n    :where([data-slot=\"general-agents-page\"]) .\\@3xl\\:block {\n      display: block;\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .\\@3xl\\:w-60 {\n      width: calc(var(--spacing, .25rem) * 60);\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .\\@3xl\\:max-w-80 {\n      max-width: calc(var(--spacing, .25rem) * 80);\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .\\@3xl\\:grid-cols-4 {\n      grid-template-columns: repeat(4, minmax(0, 1fr));\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .\\@3xl\\:flex-row {\n      flex-direction: row;\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .\\@3xl\\:items-center {\n      align-items: center;\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .\\@3xl\\:items-start {\n      align-items: flex-start;\n    }\n  }\n\n  @container (min-width: 56rem) {\n    :where([data-slot=\"general-agents-page\"]) .\\@4xl\\:grid-cols-2 {\n      grid-template-columns: repeat(2, minmax(0, 1fr));\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .\\@4xl\\:grid-cols-4 {\n      grid-template-columns: repeat(4, minmax(0, 1fr));\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .\\@4xl\\:grid-cols-6 {\n      grid-template-columns: repeat(6, minmax(0, 1fr));\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .\\@4xl\\:grid-cols-\\[3fr_2fr\\] {\n      grid-template-columns: 3fr 2fr;\n    }\n  }\n\n  @container (min-width: 64rem) {\n    :where([data-slot=\"general-agents-page\"]) .\\@5xl\\:grid-cols-2 {\n      grid-template-columns: repeat(2, minmax(0, 1fr));\n    }\n\n    :where([data-slot=\"general-agents-page\"]) .\\@5xl\\:grid-cols-3 {\n      grid-template-columns: repeat(3, minmax(0, 1fr));\n    }\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .\\[\\&\\>button\\]\\:w-full > button {\n    width: 100%;\n  }\n\n  :where([data-slot=\"general-agents-page\"]) .\\[\\&\\>button\\]\\:justify-center > button {\n    justify-content: center;\n  }\n}\n\n@property --tw-translate-x {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0;\n}\n\n@property --tw-translate-y {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0;\n}\n\n@property --tw-translate-z {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0;\n}\n\n@property --tw-divide-x-reverse {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0;\n}\n\n@property --tw-border-style {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: solid;\n}\n\n@property --tw-leading {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-font-weight {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-tracking {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-ordinal {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-slashed-zero {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-numeric-figure {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-numeric-spacing {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-numeric-fraction {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-shadow {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}\n\n@property --tw-shadow-color {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-shadow-alpha {\n  syntax: \"<percentage>\";\n  inherits: false;\n  initial-value: 100%;\n}\n\n@property --tw-inset-shadow {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}\n\n@property --tw-inset-shadow-color {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-inset-shadow-alpha {\n  syntax: \"<percentage>\";\n  inherits: false;\n  initial-value: 100%;\n}\n\n@property --tw-ring-color {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-ring-shadow {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}\n\n@property --tw-inset-ring-color {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-inset-ring-shadow {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}\n\n@property --tw-ring-inset {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-ring-offset-width {\n  syntax: \"<length>\";\n  inherits: false;\n  initial-value: 0;\n}\n\n@property --tw-ring-offset-color {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: #fff;\n}\n\n@property --tw-ring-offset-shadow {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: 0 0 #0000;\n}\n\n@property --tw-outline-style {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: solid;\n}\n\n@property --tw-blur {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-brightness {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-contrast {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-grayscale {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-hue-rotate {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-invert {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-opacity {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-saturate {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-sepia {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-drop-shadow {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-drop-shadow-color {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-drop-shadow-alpha {\n  syntax: \"<percentage>\";\n  inherits: false;\n  initial-value: 100%;\n}\n\n@property --tw-drop-shadow-size {\n  syntax: \"*\";\n  inherits: false\n}\n\n@property --tw-content {\n  syntax: \"*\";\n  inherits: false;\n  initial-value: \"\";\n}\n\n@keyframes pulse {\n  50% {\n    opacity: .5;\n  }\n}\n";
//#endregion
//#region page/sheet.ts
var HOLDERS = "holders";
/** Hold the sheet `id` in `doc`, adding it first when no one holds it. The
*  returned function releases this hold, once. */
function holdSheet(doc, id, css) {
	if (!doc) return () => void 0;
	let style = doc.getElementById(id);
	if (style === null) {
		style = doc.createElement("style");
		style.id = id;
		style.textContent = css;
		doc.head.append(style);
	}
	style.dataset[HOLDERS] = `${Number(style.dataset[HOLDERS] ?? 0) + 1}`;
	let held = true;
	return () => {
		if (!held) return;
		held = false;
		const sheet = doc.getElementById(id);
		if (sheet === null) return;
		const left = Number(sheet.dataset[HOLDERS] ?? 1) - 1;
		if (left > 0) sheet.dataset[HOLDERS] = `${left}`;
		else sheet.remove();
	};
}
//#endregion
//#region page/styles.ts
var STYLE_ID = "general-agents-page-styles";
/** Keep the page's sheet in the document while the calling page is mounted: in
*  place before its first paint, gone with its last instance. */
function usePageStyles() {
	useInsertionEffect(() => holdSheet(globalThis.document, STYLE_ID, page_default), []);
}
//#endregion
//#region page/index.tsx
/** The Code space's default agent: a session opened as no agent is its. */
var DEFAULT_AGENT = "coding";
/** How often the page asks its server for the Machinist's undecided proposals. */
var PROPOSALS_MS = 4e3;
/** The listing before its first read: one array, so nothing keyed on it changes. */
var NO_AGENTS = [];
function GeneralAgentsPage(props) {
	usePageStyles();
	const { store, workspace, avatar, agentPresences, bridgedPresences, onIntent } = props;
	const workspacePath = workspace?.path;
	const forge = useMemo(() => forgeOf(store, workspacePath), [store, workspacePath]);
	const facts = useFact(store, AGENTS_KEY);
	const usage = useFact(store, USAGE_KEY);
	const catalog = useFact(store, CATALOG_KEY);
	const models = useFact(store, MODELS_KEY);
	const speechProfiles = useFact(store, SPEECH_PROFILES_KEY);
	const speechAgents = useFact(store, SPEECH_AGENTS_KEY);
	const sampler = props.voice?.sampler;
	const assigner = props.voice?.assigner;
	const voiceAgents = useMemo(() => readAgentVoices(speechAgents), [speechAgents]);
	const voiceKit = useMemo(() => ({
		profiles: readProfilesFact(speechProfiles),
		agents: voiceAgents,
		...sampler ? { sampler } : {},
		...assigner ? { assigner } : {}
	}), [
		speechProfiles,
		voiceAgents,
		sampler,
		assigner
	]);
	const now = useNow(3e4);
	const activity = useActivity(store, now, DEFAULT_AGENT);
	const listing = usePolled(useCallback(() => forge.listAgents(), [forge]), null, forge);
	const refreshListing = listing.refresh;
	useEffect(() => {
		if (facts !== void 0) refreshListing();
	}, [facts, refreshListing]);
	const proposals = usePolled(useCallback(() => forge.pendingProposals(), [forge]), PROPOSALS_MS, forge);
	const listed = useMemo(() => listing.value?.agents ?? NO_AGENTS, [listing.value]);
	const roster = useMemo(() => joinRoster(facts, listing.value?.agents), [facts, listing.value]);
	const faceOf = useMemo(() => rememberFaces((name) => agentPresenceFace(avatar, name, agentPresences)), [avatar, agentPresences]);
	const [profile, setProfile] = useState(null);
	const [notice, setNotice] = useState(void 0);
	const [busy, setBusy] = useState(/* @__PURE__ */ new Set());
	/** Proposals the human decided: dismissed on the server, never laid again. One
	*  on the open profile is held back by that profile, and when the profile
	*  closes undecided it is held back by nothing: it is on the home again. */
	const [decided, setDecided] = useState(/* @__PURE__ */ new Set());
	/** The agent a save just wrote: its profile reopens on the fresh file. */
	const reopen = useRef(null);
	const pending = useMemo(() => proposalsToReview(proposals.value?.proposals ?? [], profile, decided), [
		proposals.value,
		profile,
		decided
	]);
	useEffect(() => {
		const name = reopen.current;
		if (name === null) return;
		const file = listing.value?.agents.find((agent) => agent.name === name);
		if (file === void 0) return;
		reopen.current = null;
		setProfile(openListed(file));
	}, [listing.value]);
	useEffect(() => {
		if (profile === null) return;
		const mine = proposalsForProfile(profile, pending);
		if (mine.length === 0) return;
		setProfile(mine.reduce((next, entry) => receiveProposal(next, entry.id, entry.proposal, listed), profile));
	}, [
		pending,
		profile,
		listed
	]);
	const review = (entry) => setProfile(receiveProposal(null, entry.id, entry.proposal, listed));
	const decide = async (state, keep) => {
		const ids = state.proposal?.ids ?? [];
		setDecided((current) => /* @__PURE__ */ new Set([...current, ...ids]));
		setProfile(keep ? acceptProposal(state) : discardProposal(state));
		try {
			await Promise.all(ids.map((id) => forge.dismissProposal(id)));
		} catch (cause) {
			setNotice(errorText(cause));
		} finally {
			proposals.refresh();
		}
	};
	const configure = useCallback(async (name, patch) => {
		setBusy((current) => /* @__PURE__ */ new Set([...current, name]));
		setNotice(void 0);
		try {
			await forge.configure(name, patch);
		} catch (cause) {
			setNotice(errorText(cause));
		} finally {
			setBusy((current) => {
				const next = new Set(current);
				next.delete(name);
				return next;
			});
		}
	}, [forge]);
	const openAgent = useCallback((name) => {
		const file = listed.find((agent) => agent.name === name);
		if (file !== void 0) setProfile(openListed(file));
	}, [listed]);
	const openDock = onIntent ? () => onIntent({ t: "dock.open" }) : void 0;
	const canConfigure = store.call !== void 0;
	return /* @__PURE__ */ jsx("div", {
		"data-slot": PAGE_SLOT,
		style: { display: "contents" },
		children: profile !== null ? /* @__PURE__ */ jsx(AgentProfile, {
			state: profile,
			onChange: setProfile,
			onClose: () => setProfile(null),
			onExtend: (base) => setProfile(extendFrom(base)),
			onDecide: (keep) => void decide(profile, keep),
			onSaved: (name) => {
				reopen.current = name;
				setNotice(void 0);
				listing.refresh();
			},
			forge,
			roster,
			listed,
			activity,
			usage,
			catalog,
			models,
			now,
			faceOf,
			bridged: bridgedPresences,
			onDock: openDock,
			configure: canConfigure ? configure : void 0,
			voice: voiceKit,
			hasWorkspace: workspace != null,
			busy,
			notice
		}, profile.draft.key) : /* @__PURE__ */ jsx(AgentsHome, {
			roster,
			loading: facts === void 0,
			listingError: listing.error,
			activity,
			usage,
			catalog,
			now,
			faceOf,
			voices: voiceAgents,
			bridged: bridgedPresences,
			proposals: pending,
			onReview: review,
			onOpen: openAgent,
			onCreate: () => setProfile(openBlank()),
			onDock: openDock,
			configure: canConfigure ? configure : void 0,
			busy,
			notice
		})
	});
}
//#endregion
export { DEFAULT_AGENT, GeneralAgentsPage };
