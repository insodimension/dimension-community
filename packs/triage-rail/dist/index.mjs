import { ActivityDot, Button, Icon, IconButton, Input, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, VoicemailMark, useObservable } from "@fraym/ui";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
//#region src/model.ts
/** The host's lifted loop group carries this synthetic branch key
*  (`LOOPS_GROUP_BRANCH` in the kit). Matched by value so the pack needs no
*  import for it. */
var LOOPS_BRANCH = "autonomy";
var RECENCY_ORDER = [
	"now",
	"today",
	"yesterday",
	"week",
	"earlier"
];
var RECENCY_LABEL = {
	now: "Now",
	today: "Today",
	yesterday: "Yesterday",
	week: "This week",
	earlier: "Earlier"
};
var DAY_MS = 1440 * 60 * 1e3;
/** A row untouched for longer than this is a sweep candidate. */
var SWEEP_AGE_MS = 7 * DAY_MS;
function parseTime(value) {
	const time = Date.parse(value ?? "");
	return Number.isFinite(time) ? time : NaN;
}
function dot(row) {
	return row.dotState ?? row.status;
}
/** Live work: the dot claims it AND no terminal fact overrules the dot. The
*  host's own fold applies a grace window to a stale `working` claim; the row
*  it publishes already reflects that (its `time` reads the persisted age), so
*  the pack trusts the dot it was handed. */
function isLive(row) {
	if (row.archived || row.continuedInto) return false;
	const state = dot(row);
	return state === "working" || state === "background" || state === "needs-you";
}
function triageOf(row) {
	if (row.archived || row.continuedInto) return "resolved";
	const state = dot(row);
	if (state === "needs-you" || state === "failed" || row.unread === true || row.interrupted === true) return "needs-you";
	if (state === "working" || state === "background") return "working";
	return "idle";
}
/** The instant a needs-you row started waiting. `attention.since` when the
*  host says so, else the last activity. An unparseable time yields
*  `+Infinity`, so a row of unknown wait sorts LAST in an oldest-first strip
*  and never displaces a genuine oldest wait — the same rule
*  {@link sweepCandidates} applies to age: an unknown age is not an old one. */
function waitingSince(row) {
	const since = parseTime(row.attention?.since ?? row.updatedAt);
	return Number.isFinite(since) ? since : Number.POSITIVE_INFINITY;
}
/** Oldest wait first. Written as an ordering rather than a subtraction so two
*  unknown waits compare equal instead of `Infinity - Infinity` ⇒ NaN. */
function byWait(a, b) {
	const left = waitingSince(a.item);
	const right = waitingSince(b.item);
	return left === right ? 0 : left < right ? -1 : 1;
}
/** Local midnight for `now` — recency buckets follow the user's calendar, not
*  a rolling 24 h window: "Today" is the day you are in. */
function startOfDay(now) {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}
function recencyBucket(row, now, dayStart = startOfDay(now)) {
	if (isLive(row)) return "now";
	const updated = parseTime(row.updatedAt);
	if (!Number.isFinite(updated)) return "earlier";
	if (updated >= dayStart) return "today";
	if (updated >= dayStart - DAY_MS) return "yesterday";
	if (updated >= dayStart - 6 * DAY_MS) return "week";
	return "earlier";
}
/** Sort key inside a bucket: live rows first, then newest activity first,
*  pinned rows ahead of everything. Live work is `+Infinity` rather than
*  "now" so the key needs no clock — which is what lets the rail fold once per
*  day instead of once per minute tick. */
function recencyValue(row) {
	if (isLive(row)) return Number.POSITIVE_INFINITY;
	const updated = parseTime(row.updatedAt);
	return Number.isFinite(updated) ? updated : 0;
}
function byRecency(a, b) {
	const pin = Number(b.item.pinned === true) - Number(a.item.pinned === true);
	if (pin !== 0) return pin;
	const left = recencyValue(b.item);
	const right = recencyValue(a.item);
	return left === right ? 0 : left < right ? -1 : 1;
}
/** @param now any instant inside the day being rendered. The fold reads the
*  clock ONLY for the midnight boundary of the recency buckets, so a caller
*  that re-renders on a minute tick can key this on local midnight and keep
*  every `Placed` wrapper's identity (and every memoised row) stable.
*  @param hostStrip the host's own needs-you fold (`facts.triage`), when it
*  publishes one. That fact is AUTHORITATIVE — already deduped and
*  oldest-wait-first, and it sees rows the activity window hid from
*  `sessions` plus reasons the pack cannot name (a pending permission the host
*  tracks its own way). So the strip is SEEDED from it, in the host's order,
*  and never re-tested against the pack's predicate; a seeded row that is also
*  on screen keeps its group credit, a host-only row joins with no project
*  caption. The pack's own predicate is the FALLBACK, appended for rows the
*  host did not publish — which on a host that publishes none is the whole
*  strip, oldest wait first. */
function foldTriage(groups, now = Date.now(), hostStrip = []) {
	const dayStart = startOfDay(now);
	const seen = /* @__PURE__ */ new Set();
	const derived = [];
	const loops = [];
	const buckets = {
		now: [],
		today: [],
		yesterday: [],
		week: [],
		earlier: []
	};
	const onScreen = hostStrip.length > 0 ? /* @__PURE__ */ new Map() : void 0;
	for (const group of groups) {
		const isLoopGroup = group.branch === LOOPS_BRANCH;
		for (const item of group.items) {
			if (seen.has(item.id)) continue;
			seen.add(item.id);
			const placed = {
				item,
				repo: group.repo
			};
			onScreen?.set(item.id, placed);
			if (isLoopGroup) loops.push(placed);
			else buckets[recencyBucket(item, now, dayStart)].push(placed);
			if (triageOf(item) === "needs-you") derived.push(placed);
		}
	}
	let needsYou;
	if (onScreen === void 0) needsYou = derived.sort(byWait);
	else {
		needsYou = [];
		const striped = /* @__PURE__ */ new Set();
		for (const item of hostStrip) {
			if (striped.has(item.id)) continue;
			striped.add(item.id);
			needsYou.push(onScreen.get(item.id) ?? {
				item,
				repo: ""
			});
		}
		const extra = derived.filter((placed) => !striped.has(placed.item.id));
		if (extra.length > 0) needsYou.push(...extra.sort(byWait));
	}
	const sections = [];
	let total = 0;
	for (const bucket of RECENCY_ORDER) {
		const rows = buckets[bucket];
		if (rows.length === 0) continue;
		rows.sort(byRecency);
		sections.push({
			bucket,
			rows
		});
		total += rows.length;
	}
	return {
		needsYou,
		sections,
		loops,
		total: total + loops.length
	};
}
/** Rows a Sweep archives: idle (not unread, not live, not failed), unpinned,
*  addressable (a real `sessionRef`), and untouched for longer than
*  {@link SWEEP_AGE_MS}. A row with no parseable time is never swept — an
*  unknown age is not an old one. */
function sweepCandidates(rows, now = Date.now(), ageMs = SWEEP_AGE_MS) {
	const out = [];
	for (const placed of rows) {
		const { item } = placed;
		if (item.pinned || item.locating || !item.sessionRef) continue;
		if (triageOf(item) !== "idle") continue;
		const updated = parseTime(item.updatedAt);
		if (!Number.isFinite(updated) || now - updated <= ageMs) continue;
		out.push(placed);
	}
	return out;
}
/** Compact wait age for the needs-you strip: `now` · `5m` · `2h` · `3d`. An
*  unknown wait has no age to print, so it prints nothing — never the
*  `-Infinity` the sentinel would otherwise render. */
function waitLabel(row, now = Date.now()) {
	const since = waitingSince(row);
	if (!Number.isFinite(since)) return "";
	const seconds = Math.max(0, Math.round((now - since) / 1e3));
	if (seconds < 60) return "now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}
//#endregion
//#region src/styles.ts
var STYLE_SLOT = "triage-rail-styles";
var TRIAGE_RAIL_CSS = `
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
function ensureStyles() {
	if (typeof document === "undefined") return;
	if (document.head.querySelector(`style[data-slot="triage-rail-styles"]`)) return;
	const style = document.createElement("style");
	style.dataset.slot = STYLE_SLOT;
	style.textContent = TRIAGE_RAIL_CSS;
	document.head.appendChild(style);
}
//#endregion
//#region src/index.tsx
var SECTION_ICON = {
	now: "bolt",
	today: "sun",
	yesterday: "moon",
	week: "clock",
	earlier: "history"
};
/** Memoised on `item` IDENTITY, not on a wrapper: the host's row objects are
*  stable between facts, so a re-render of the rail (a minute tick, a search
*  keystroke) reconciles nothing. Taking `placed` whole would defeat that —
*  every fold allocates fresh wrappers. */
var Row = memo(function Row({ item, repo, trailing, actions }) {
	const onClick = useCallback(() => actions.selectSession?.(item), [actions, item]);
	const onContextMenu = useCallback((event) => {
		event.preventDefault();
		actions.sessionContextMenu(item, event);
	}, [actions, item]);
	const dotState = item.dotState ?? item.status;
	const row = /* @__PURE__ */ jsxs("button", {
		type: "button",
		className: "tr-row",
		"data-session-id": item.sessionRef?.sessionId ?? item.id,
		"data-active": item.active ? "" : void 0,
		"data-unread": item.unread ? "" : void 0,
		"data-frozen": item.continuedInto ? "" : void 0,
		disabled: item.locating,
		onClick,
		onContextMenu,
		children: [
			/* @__PURE__ */ jsx("span", {
				className: "tr-row-lead",
				children: item.continuedInto ? /* @__PURE__ */ jsx(Icon, {
					name: "branch",
					size: 13,
					strokeWidth: 1.8,
					"aria-hidden": "true"
				}) : item.avatarImage ? /* @__PURE__ */ jsx("img", {
					className: "tr-avatar",
					style: {
						width: 16,
						height: 16
					},
					src: item.avatarImage,
					alt: ""
				}) : /* @__PURE__ */ jsx(ActivityDot, { state: dotState })
			}),
			/* @__PURE__ */ jsxs("span", {
				className: "tr-row-body",
				children: [/* @__PURE__ */ jsx("span", {
					className: "tr-row-title",
					children: item.title
				}), repo || item.meta ? /* @__PURE__ */ jsx("span", {
					className: "tr-row-meta",
					children: [repo, item.meta].filter(Boolean).join(" · ")
				}) : null]
			}),
			/* @__PURE__ */ jsx("span", {
				className: "tr-row-time",
				children: trailing
			})
		]
	});
	const ref = item.sessionRef;
	if (!ref) return row;
	return /* @__PURE__ */ jsxs("div", {
		className: "tr-row-holder",
		children: [row, /* @__PURE__ */ jsx(VoicemailMark, {
			sessionId: ref.sessionId,
			voicemail: item.voicemail,
			title: item.title,
			agent: item.profile,
			className: "tr-mail"
		})]
	});
});
/** The strip shows the oldest waits and names the rest: a strip of two hundred
*  rows (every never-opened session on a fresh upgrade reads as unread) is a
*  list, not a call to action. Six is what fits above the first group. */
var STRIP_FOLD = 6;
function NeedsYouStrip({ rows, actions, now }) {
	const [expanded, setExpanded] = useState(false);
	if (rows.length === 0) return null;
	const shown = expanded ? rows : rows.slice(0, STRIP_FOLD);
	const hidden = rows.length - shown.length;
	return /* @__PURE__ */ jsxs("section", {
		className: "tr-strip",
		"data-slot": "triage-needs-you",
		"aria-label": `Needs you, ${rows.length}`,
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "tr-strip-head",
				children: [
					/* @__PURE__ */ jsx("span", {
						className: "tr-strip-dot",
						"aria-hidden": "true"
					}),
					/* @__PURE__ */ jsx("span", {
						className: "tr-eyebrow",
						children: "Needs you"
					}),
					/* @__PURE__ */ jsx("span", {
						className: "tr-count",
						style: { color: "var(--fr-iris)" },
						children: rows.length
					})
				]
			}),
			shown.map((placed) => /* @__PURE__ */ jsx(Row, {
				item: placed.item,
				repo: placed.repo,
				trailing: waitLabel(placed.item, now),
				actions
			}, placed.item.id)),
			rows.length > STRIP_FOLD ? /* @__PURE__ */ jsx("button", {
				type: "button",
				className: "tr-more",
				onClick: () => setExpanded((current) => !current),
				children: expanded ? "Show less" : `Show ${hidden} more`
			}) : null
		]
	});
}
var SWEEP_PREVIEW = 4;
function SweepCard({ candidates, onConfirm, onCancel }) {
	const n = candidates.length;
	const shown = candidates.slice(0, SWEEP_PREVIEW);
	const more = n - shown.length;
	return /* @__PURE__ */ jsxs("div", {
		className: "tr-sweep-card",
		role: "group",
		"aria-label": "Confirm sweep",
		children: [
			/* @__PURE__ */ jsxs("span", {
				className: "tr-sweep-title",
				children: [
					"Archive ",
					n,
					" idle session",
					n === 1 ? "" : "s",
					" untouched for 7+ days?"
				]
			}),
			/* @__PURE__ */ jsxs("ul", {
				className: "tr-sweep-list",
				children: [shown.map(({ item, repo }) => /* @__PURE__ */ jsxs("li", { children: [
					item.title,
					" ",
					/* @__PURE__ */ jsxs("span", {
						className: "tr-row-meta",
						children: ["· ", repo]
					})
				] }, item.id)), more > 0 ? /* @__PURE__ */ jsxs("li", {
					className: "tr-row-meta",
					children: [
						"and ",
						more,
						" more"
					]
				}) : null]
			}),
			/* @__PURE__ */ jsx("span", {
				className: "tr-sweep-note",
				children: "Archived sessions stay searchable and can be unarchived from their menu."
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "tr-sweep-actions",
				children: [/* @__PURE__ */ jsxs(Button, {
					size: "sm",
					onClick: onConfirm,
					children: [
						/* @__PURE__ */ jsx(Icon, {
							name: "archive",
							size: 13,
							strokeWidth: 1.8,
							"aria-hidden": "true"
						}),
						"Archive ",
						n
					]
				}), /* @__PURE__ */ jsx(Button, {
					size: "sm",
					variant: "ghost",
					onClick: onCancel,
					children: "Keep"
				})]
			})
		]
	});
}
/** Rows a section shows before its "Show more" row. "Now" is never folded —
*  live work is the reason the rail exists — and a fold that hides a row the
*  user is looking for still names the count. */
var SECTION_FOLD = 8;
function Section({ id, title, icon, rows, actions, open, onToggle, action, children }) {
	const toggle = useCallback(() => onToggle(id), [onToggle, id]);
	const [expanded, setExpanded] = useState(false);
	const foldable = id !== "now" && rows.length > SECTION_FOLD;
	const shown = foldable && !expanded ? rows.slice(0, SECTION_FOLD) : rows;
	const hidden = rows.length - shown.length;
	return /* @__PURE__ */ jsxs("section", {
		className: "tr-section",
		"data-slot": "triage-section",
		"data-bucket": id,
		"data-open": open ? "" : void 0,
		children: [/* @__PURE__ */ jsxs("div", {
			className: "tr-section-head",
			children: [/* @__PURE__ */ jsxs("button", {
				type: "button",
				className: "tr-section-toggle",
				"aria-expanded": open,
				onClick: toggle,
				children: [
					/* @__PURE__ */ jsx(Icon, {
						name: icon,
						size: 12,
						strokeWidth: 1.8,
						"aria-hidden": "true"
					}),
					/* @__PURE__ */ jsx("span", {
						className: "tr-eyebrow",
						children: title
					}),
					/* @__PURE__ */ jsx(Icon, {
						name: "caretR",
						size: 11,
						strokeWidth: 2.2,
						className: "tr-caret",
						"aria-hidden": "true"
					}),
					/* @__PURE__ */ jsx("span", {
						className: "tr-count",
						children: rows.length
					})
				]
			}), action]
		}), open ? /* @__PURE__ */ jsxs(Fragment, { children: [
			children,
			shown.map((placed) => /* @__PURE__ */ jsx(Row, {
				item: placed.item,
				repo: placed.repo,
				trailing: placed.item.time,
				actions
			}, placed.item.id)),
			foldable ? /* @__PURE__ */ jsx("button", {
				type: "button",
				className: "tr-more",
				onClick: () => setExpanded((current) => !current),
				children: expanded ? "Show less" : `Show ${hidden} more`
			}) : null
		] }) : null]
	});
}
function CompactRows({ rows, actions }) {
	return /* @__PURE__ */ jsx(Fragment, { children: rows.map(({ item, repo }) => /* @__PURE__ */ jsxs(Tooltip, { children: [/* @__PURE__ */ jsx(TooltipTrigger, {
		asChild: true,
		children: /* @__PURE__ */ jsx("button", {
			type: "button",
			className: "tr-compact-row",
			"data-active": item.active ? "" : void 0,
			"aria-label": item.title,
			onClick: () => actions.selectSession?.(item),
			onContextMenu: (event) => {
				event.preventDefault();
				actions.sessionContextMenu(item, event);
			},
			children: /* @__PURE__ */ jsx(ActivityDot, {
				state: item.dotState ?? item.status,
				size: 7
			})
		})
	}), /* @__PURE__ */ jsxs(TooltipContent, {
		side: "right",
		children: [
			item.title,
			" · ",
			repo
		]
	})] }, item.id)) });
}
/** The strip's wait ages tick without a facts change, and midnight moves
*  "Today" to "Yesterday". One minute is the host's own cadence. */
var TICK_MS = 6e4;
var TriageRailSection = memo(function TriageRailSection({ rail, actions, switcher }) {
	const facts = useObservable(rail);
	const compact = facts.mode.rail === "compact";
	useEffect(ensureStyles, []);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(timer);
	}, []);
	const dayStart = startOfDay(now);
	const fold = useMemo(() => foldTriage(facts.sessions, dayStart, facts.triage), [
		facts.sessions,
		facts.triage,
		dayStart
	]);
	const earlier = fold.sections.find((section) => section.bucket === "earlier");
	const candidates = useMemo(() => earlier ? sweepCandidates(earlier.rows, now) : [], [earlier, now]);
	const [closed, setClosed] = useState({});
	const toggleSection = useCallback((id) => {
		setClosed((current) => {
			const next = { ...current };
			if (next[id]) delete next[id];
			else next[id] = true;
			return next;
		});
	}, []);
	const [sweep, setSweep] = useState("idle");
	const onSweepClick = useCallback(() => setSweep((current) => current === "confirm" ? "idle" : "confirm"), []);
	const onSweepConfirm = useCallback(() => {
		actions.archiveSessions?.(candidates.map(({ item }) => item));
		setSweep("idle");
	}, [actions, candidates]);
	const onSweepCancel = useCallback(() => setSweep("idle"), []);
	useEffect(() => {
		if (candidates.length === 0) setSweep("idle");
	}, [candidates.length]);
	const onSearchChange = useCallback((event) => actions.setSearch(event.currentTarget.value), [actions]);
	const onSearchFocus = useCallback(() => actions.setSearchOpen(true), [actions]);
	const onSearchKey = useCallback((event) => {
		if (event.key === "Escape") {
			actions.setSearch("");
			actions.setSearchOpen(false);
			event.currentTarget.blur();
		}
	}, [actions]);
	const onNewSession = useCallback(() => {
		actions.intent({ t: "create" });
		actions.newSession?.();
	}, [actions]);
	const initials = facts.identity.userName.trim().slice(0, 1).toUpperCase() || "·";
	const searching = facts.search.value.trim().length > 0;
	const sweepButton = actions.archiveSessions !== void 0 && candidates.length > 0 ? /* @__PURE__ */ jsxs(Tooltip, { children: [/* @__PURE__ */ jsx(TooltipTrigger, {
		asChild: true,
		children: /* @__PURE__ */ jsxs(Button, {
			size: "sm",
			variant: "ghost",
			"aria-pressed": sweep === "confirm",
			onClick: onSweepClick,
			style: {
				padding: "2px 7px",
				fontSize: "var(--fr-fs-2xs)",
				fontFamily: "var(--fr-font-secondary)"
			},
			children: [
				/* @__PURE__ */ jsx(Icon, {
					name: "archive",
					size: 11,
					strokeWidth: 1.8,
					"aria-hidden": "true"
				}),
				"Sweep · ",
				candidates.length
			]
		})
	}), /* @__PURE__ */ jsx(TooltipContent, {
		side: "right",
		children: "Archive idle sessions untouched for 7+ days"
	})] }) : void 0;
	if (compact) {
		const all = fold.sections.flatMap((section) => section.bucket === "now" ? section.rows : section.rows.slice(0, SECTION_FOLD));
		return /* @__PURE__ */ jsx(TooltipProvider, {
			delayDuration: 350,
			children: /* @__PURE__ */ jsxs("aside", {
				"data-slot": "triage-rail",
				"data-compact": "",
				className: "tr-rail",
				children: [
					/* @__PURE__ */ jsxs("div", {
						className: "tr-head",
						children: [/* @__PURE__ */ jsx(IconButton, {
							"aria-label": "Expand rail",
							onClick: actions.toggleCompact,
							children: /* @__PURE__ */ jsx(Icon, {
								name: "panel",
								size: 15,
								strokeWidth: 1.8,
								"aria-hidden": "true"
							})
						}), actions.newSession ? /* @__PURE__ */ jsx(IconButton, {
							"aria-label": "New session",
							onClick: onNewSession,
							children: /* @__PURE__ */ jsx(Icon, {
								name: "plus",
								size: 15,
								strokeWidth: 2,
								"aria-hidden": "true"
							})
						}) : null]
					}),
					switcher,
					/* @__PURE__ */ jsxs("div", {
						className: "tr-list tr-compact-list",
						children: [
							fold.needsYou.length > 0 ? /* @__PURE__ */ jsxs(Fragment, { children: [
								/* @__PURE__ */ jsx("span", {
									className: "tr-compact-badge",
									"aria-label": `Needs you, ${fold.needsYou.length}`,
									children: fold.needsYou.length
								}),
								/* @__PURE__ */ jsx(CompactRows, {
									rows: fold.needsYou.slice(0, STRIP_FOLD),
									actions
								}),
								/* @__PURE__ */ jsx("span", {
									className: "tr-compact-rule",
									"aria-hidden": "true"
								})
							] }) : null,
							/* @__PURE__ */ jsx(CompactRows, {
								rows: all,
								actions
							}),
							fold.loops.length > 0 ? /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("span", {
								className: "tr-compact-rule",
								"aria-hidden": "true"
							}), /* @__PURE__ */ jsx(CompactRows, {
								rows: fold.loops,
								actions
							})] }) : null
						]
					}),
					/* @__PURE__ */ jsx("div", {
						className: "tr-foot",
						style: {
							justifyContent: "center",
							padding: "8px 0 10px"
						},
						children: /* @__PURE__ */ jsx(IconButton, {
							"aria-label": "Account menu",
							onClick: actions.openUserMenu,
							children: facts.identity.userAvatarUrl ? /* @__PURE__ */ jsx("img", {
								className: "tr-avatar",
								src: facts.identity.userAvatarUrl,
								alt: ""
							}) : /* @__PURE__ */ jsx("span", {
								className: "tr-avatar",
								children: initials
							})
						})
					})
				]
			})
		});
	}
	return /* @__PURE__ */ jsx(TooltipProvider, {
		delayDuration: 700,
		children: /* @__PURE__ */ jsxs("aside", {
			"data-slot": "triage-rail",
			className: "tr-rail",
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "tr-head",
					children: [
						/* @__PURE__ */ jsxs("div", {
							className: "tr-brand",
							children: [/* @__PURE__ */ jsx("span", {
								className: "tr-brand-name",
								children: facts.identity.productLabel
							}), /* @__PURE__ */ jsx("span", {
								className: "tr-eyebrow",
								children: "Triage rail"
							})]
						}),
						actions.newSession ? /* @__PURE__ */ jsxs(Tooltip, { children: [/* @__PURE__ */ jsx(TooltipTrigger, {
							asChild: true,
							children: /* @__PURE__ */ jsx(IconButton, {
								"aria-label": "New session",
								onClick: onNewSession,
								children: /* @__PURE__ */ jsx(Icon, {
									name: "plus",
									size: 15,
									strokeWidth: 2,
									"aria-hidden": "true"
								})
							})
						}), /* @__PURE__ */ jsx(TooltipContent, {
							side: "bottom",
							children: "New session"
						})] }) : null,
						/* @__PURE__ */ jsxs(Tooltip, { children: [/* @__PURE__ */ jsx(TooltipTrigger, {
							asChild: true,
							children: /* @__PURE__ */ jsx(IconButton, {
								"aria-label": "Collapse rail",
								onClick: actions.toggleCompact,
								children: /* @__PURE__ */ jsx(Icon, {
									name: "panel",
									size: 15,
									strokeWidth: 1.8,
									"aria-hidden": "true"
								})
							})
						}), /* @__PURE__ */ jsx(TooltipContent, {
							side: "bottom",
							children: "Collapse rail"
						})] })
					]
				}),
				switcher,
				/* @__PURE__ */ jsxs("div", {
					className: "tr-search",
					children: [/* @__PURE__ */ jsx(Icon, {
						name: "search",
						size: 13,
						strokeWidth: 1.8,
						"aria-hidden": "true"
					}), /* @__PURE__ */ jsx(Input, {
						size: "sm",
						variant: "ghost",
						type: "search",
						placeholder: "Search sessions…",
						"aria-label": "Search sessions",
						value: facts.search.value,
						onChange: onSearchChange,
						onFocus: onSearchFocus,
						onKeyDown: onSearchKey
					})]
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "tr-list",
					"data-slot": "triage-list",
					children: [
						/* @__PURE__ */ jsx(NeedsYouStrip, {
							rows: fold.needsYou,
							actions,
							now
						}),
						fold.total === 0 && fold.needsYou.length === 0 ? /* @__PURE__ */ jsxs("div", {
							className: "tr-empty",
							children: [/* @__PURE__ */ jsx("strong", { children: searching ? "No sessions match" : "Nothing to triage" }), searching ? "Try a shorter query." : "New work lands here the moment it starts."]
						}) : null,
						fold.sections.map((section) => /* @__PURE__ */ jsx(Section, {
							id: section.bucket,
							title: RECENCY_LABEL[section.bucket],
							icon: SECTION_ICON[section.bucket],
							rows: section.rows,
							actions,
							open: !closed[section.bucket],
							onToggle: toggleSection,
							action: section.bucket === "earlier" ? sweepButton : void 0,
							children: section.bucket === "earlier" && sweep === "confirm" && candidates.length > 0 ? /* @__PURE__ */ jsx(SweepCard, {
								candidates,
								onConfirm: onSweepConfirm,
								onCancel: onSweepCancel
							}) : null
						}, section.bucket)),
						fold.loops.length > 0 ? /* @__PURE__ */ jsx(Section, {
							id: LOOPS_BRANCH,
							title: "Autonomy",
							icon: "orbit",
							rows: fold.loops,
							actions,
							open: !closed[LOOPS_BRANCH],
							onToggle: toggleSection
						}) : null
					]
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "tr-foot",
					children: [
						facts.identity.userAvatarUrl ? /* @__PURE__ */ jsx("img", {
							className: "tr-avatar",
							src: facts.identity.userAvatarUrl,
							alt: ""
						}) : /* @__PURE__ */ jsx("span", {
							className: "tr-avatar",
							"aria-hidden": "true",
							children: initials
						}),
						/* @__PURE__ */ jsxs("span", {
							className: "tr-foot-user",
							children: [/* @__PURE__ */ jsx("span", {
								className: "tr-brand-name",
								children: facts.identity.userName
							}), /* @__PURE__ */ jsxs("span", {
								className: "tr-eyebrow",
								children: [
									facts.identity.planLabel,
									" · ",
									facts.identity.version
								]
							})]
						}),
						/* @__PURE__ */ jsx(IconButton, {
							"aria-label": "Account menu",
							onClick: actions.openUserMenu,
							children: /* @__PURE__ */ jsx(Icon, {
								name: "user",
								size: 14,
								strokeWidth: 1.8,
								"aria-hidden": "true"
							})
						})
					]
				})
			]
		})
	});
});
/** The declarative half — the host validates id/contract against its own
*  manifest record; what matters here is the contract version it speaks. */
var implementation = {
	specVersion: 2,
	id: "triage-rail",
	slot: "rail",
	component: TriageRailSection
};
//#endregion
export { TriageRailSection, TriageRailSection as default, implementation };
