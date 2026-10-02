import { ActivityDot, FraymRailActions, Icon, IconButton, Input, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, VoicemailMark, sessionGroupsFromCatalog, useObservable, useRailActionSet, useRailSessionPresence, useStandardRootFacts } from "@fraym/ui";
import { isValidElement, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
//#region src/collections-store.ts
/** The `localStorage` key. Versioned in the name so a future shape change can
*  read the old blob from the old key and write the new one beside it. */
var COLLECTIONS_STORAGE_KEY = "chat.collections.v1";
var EMPTY = {
	collections: [],
	assignments: /* @__PURE__ */ new Map()
};
/** A collection name is a short label, not a document. */
var MAX_NAME = 60;
function cleanName(name) {
	return name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Parse whatever storage holds into a valid state. Anything that is not
*  exactly the shape this file writes contributes nothing — never an
*  exception, and never a half-trusted entry. */
function parse(raw) {
	if (!raw) return EMPTY;
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		return EMPTY;
	}
	if (!isRecord(value) || value.v !== 1) return EMPTY;
	const collections = [];
	const ids = /* @__PURE__ */ new Set();
	if (Array.isArray(value.collections)) for (const entry of value.collections) {
		if (!isRecord(entry)) continue;
		const { id, name, createdAt } = entry;
		if (typeof id !== "string" || id === "" || ids.has(id)) continue;
		if (typeof name !== "string" || cleanName(name) === "") continue;
		if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) continue;
		ids.add(id);
		collections.push({
			id,
			name: cleanName(name),
			createdAt
		});
	}
	const assignments = /* @__PURE__ */ new Map();
	if (isRecord(value.assignments)) {
		for (const [sessionId, collectionId] of Object.entries(value.assignments)) if (typeof collectionId === "string" && ids.has(collectionId)) assignments.set(sessionId, collectionId);
	}
	return {
		collections,
		assignments
	};
}
function serialize(state) {
	return JSON.stringify({
		v: 1,
		collections: state.collections,
		assignments: Object.fromEntries(state.assignments)
	});
}
function newId() {
	const uuid = globalThis.crypto?.randomUUID?.();
	if (uuid) return `col_${uuid}`;
	return `col_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
/** Build a store over `storage`. With no storage (a locked-down webview, a
*  server render) it degrades to memory-only: the rail still works, nothing
*  survives the session. */
function createCollectionsStore(storage) {
	let state = EMPTY;
	let warned = false;
	/** The raw string storage held when `state` last agreed with it — read, or
	*  written successfully. `undefined` = never looked. */
	let synced;
	/** The state a mutation must build on. Storage is the truth (another window may
	*  have written since), so it is consulted every time — but only RE-PARSED when
	*  its raw text differs from what this store last saw. That keeps two things:
	*  `list()` keeps its identity across mutations that do not touch it, and a
	*  change storage refused to take (quota, a revoked store) is not read back
	*  as "nothing happened" by the very next click. */
	const sync = () => {
		if (!storage) return state;
		let raw;
		try {
			raw = storage.getItem(COLLECTIONS_STORAGE_KEY);
		} catch {
			return state;
		}
		if (raw !== synced) {
			state = parse(raw);
			synced = raw;
		}
		return state;
	};
	sync();
	const listeners = /* @__PURE__ */ new Set();
	const emit = () => {
		for (const listener of [...listeners]) listener();
	};
	const commit = (next) => {
		state = next;
		if (storage) {
			const raw = serialize(next);
			try {
				storage.setItem(COLLECTIONS_STORAGE_KEY, raw);
				synced = raw;
			} catch (error) {
				if (!warned) {
					warned = true;
					console.warn("[chat-rail] collections could not be saved; they will not persist", error);
				}
			}
		}
		emit();
	};
	/** Adopt a change another window made, and tell subscribers. */
	const refresh = () => {
		const before = state;
		if (sync() !== before) emit();
	};
	const onStorage = (event) => {
		if (event.key === "chat.collections.v1" || event.key === null) refresh();
	};
	const target = storage && typeof globalThis.addEventListener === "function" ? globalThis : void 0;
	return {
		list: () => state.collections,
		create(name) {
			const base = sync();
			const collection = {
				id: newId(),
				name: cleanName(name) || "Untitled",
				createdAt: Date.now()
			};
			commit({
				collections: [...base.collections, collection],
				assignments: base.assignments
			});
			return collection;
		},
		rename(id, name) {
			const base = sync();
			const next = cleanName(name);
			const index = base.collections.findIndex((collection) => collection.id === id);
			if (next === "" || index < 0 || base.collections[index].name === next) return;
			const collections = base.collections.slice();
			collections[index] = {
				...collections[index],
				name: next
			};
			commit({
				collections,
				assignments: base.assignments
			});
		},
		remove(id) {
			const base = sync();
			if (!base.collections.some((collection) => collection.id === id)) return;
			const assignments = /* @__PURE__ */ new Map();
			for (const [sessionId, collectionId] of base.assignments) if (collectionId !== id) assignments.set(sessionId, collectionId);
			commit({
				collections: base.collections.filter((collection) => collection.id !== id),
				assignments
			});
		},
		assign(sessionId, collectionId) {
			if (sessionId === "") return;
			const base = sync();
			if (collectionId !== null && !base.collections.some((collection) => collection.id === collectionId)) return;
			if ((base.assignments.get(sessionId) ?? null) === collectionId) return;
			const assignments = new Map(base.assignments);
			if (collectionId === null) assignments.delete(sessionId);
			else assignments.set(sessionId, collectionId);
			commit({
				collections: base.collections,
				assignments
			});
		},
		collectionOf: (sessionId) => state.assignments.get(sessionId) ?? null,
		subscribe(fn) {
			if (listeners.size === 0) {
				sync();
				target?.addEventListener("storage", onStorage);
			}
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
				if (listeners.size === 0) target?.removeEventListener("storage", onStorage);
			};
		}
	};
}
function ambientStorage() {
	try {
		return globalThis.localStorage;
	} catch {
		return;
	}
}
/** The one store the rail uses. */
var collectionsStore = createCollectionsStore(ambientStorage());
//#endregion
//#region src/menu.tsx
/** Where a menu opens for a click or a keyboard-summoned context menu. A
*  keyboard `contextmenu` arrives with no pointer (`0, 0`); the element's own
*  corner is the honest anchor then. */
function anchorOf(event) {
	if (event.clientX === 0 && event.clientY === 0) {
		const rect = event.currentTarget.getBoundingClientRect();
		return {
			x: rect.left + 12,
			y: rect.bottom
		};
	}
	return {
		x: event.clientX,
		y: event.clientY
	};
}
var VIEWPORT_MARGIN = 8;
function clamp(value, min, max) {
	return Math.max(min, Math.min(value, Math.max(min, max)));
}
var ITEM_SELECTOR = "[role^=\"menuitem\"]:not(:disabled)";
function MenuShell({ anchor, label, onClose, children }) {
	const ref = useRef(null);
	const [place, setPlace] = useState(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const fit = () => {
			const { width, height } = el.getBoundingClientRect();
			const left = clamp(anchor.x, VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
			const top = clamp(anchor.y, VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
			setPlace((current) => current && current.left === left && current.top === top ? current : {
				left,
				top
			});
		};
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(el);
		return () => observer.disconnect();
	}, [anchor]);
	const closeRef = useRef(onClose);
	useLayoutEffect(() => {
		closeRef.current = onClose;
	});
	useEffect(() => {
		const opener = document.activeElement;
		const menu = ref.current;
		menu?.querySelector(`${ITEM_SELECTOR}, input`)?.focus({ preventScroll: true });
		const close = () => closeRef.current();
		const insideMenu = (event) => event.target instanceof Node && menu?.contains(event.target) === true;
		const onPointerDown = (event) => {
			if (!insideMenu(event)) close();
		};
		const onKeyDown = (event) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			close();
		};
		const onScroll = (event) => {
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
			const focused = document.activeElement;
			if ((focused === document.body || focused === null) && opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
		};
	}, []);
	const onKeyDown = (event) => {
		if (event.key === "Tab") {
			onClose();
			return;
		}
		const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
		const edge = event.key === "Home" ? 0 : event.key === "End" ? -1 : void 0;
		if (move === 0 && edge === void 0) return;
		const items = [...event.currentTarget.querySelectorAll(ITEM_SELECTOR)];
		if (items.length === 0) return;
		event.preventDefault();
		const at = items.indexOf(document.activeElement);
		items[edge !== void 0 ? edge === 0 ? 0 : items.length - 1 : (at + move + items.length) % items.length]?.focus();
	};
	return createPortal(/* @__PURE__ */ jsx("div", {
		ref,
		role: "menu",
		"aria-label": label,
		"data-slot": "chat-rail-menu",
		"data-fr-enter": "pop",
		style: {
			left: place?.left ?? anchor.x,
			top: place?.top ?? anchor.y
		},
		onKeyDown,
		onContextMenu: (event) => event.preventDefault(),
		children
	}), document.body);
}
function MenuItem({ icon, checked, tone, onSelect, children }) {
	return /* @__PURE__ */ jsxs("button", {
		type: "button",
		role: checked === void 0 ? "menuitem" : "menuitemradio",
		"aria-checked": checked,
		className: "erm-item",
		"data-tone": tone,
		onClick: onSelect,
		children: [/* @__PURE__ */ jsx("span", {
			className: "erm-glyph",
			"aria-hidden": "true",
			children: checked ? /* @__PURE__ */ jsx(Icon, {
				name: "check",
				size: 13,
				strokeWidth: 2
			}) : icon ? /* @__PURE__ */ jsx(Icon, {
				name: icon,
				size: 13,
				strokeWidth: 1.8
			}) : null
		}), /* @__PURE__ */ jsx("span", {
			className: "erm-label",
			children
		})]
	});
}
function MenuHeading({ children }) {
	return /* @__PURE__ */ jsx("div", {
		className: "erm-heading",
		role: "presentation",
		children
	});
}
function MenuRule() {
	return /* @__PURE__ */ jsx("div", {
		className: "erm-rule",
		role: "separator"
	});
}
//#endregion
//#region src/model.ts
/** Read the desk off the registered spaces, so the rail names no workspace of
*  its own: the space declares it (`workspace.scope`), the rail obeys. */
function resolveDesk(spaces, spaceId, agents) {
	return {
		spaceId,
		workspaceId: (spaces.find((space) => space.id === spaceId)?.workspace.scope)?.workspace,
		agents
	};
}
/**
* Narrow the raw session list to this desk. The host's `scopeSessionCatalog`
* (`packages/app/src/bench-catalog.ts`) matches a stamped row on the stamp alone,
* which is right for a space that owns its sessions but wrong for a desk shared
* with a bubble: an Aether conversation begun from the Code bubble is stamped
* `code` and runs in the same home workspace, and doc 72 §2 says Aether
* conversations from the main pane and from the bubble are ONE family. So:
*
*  - a row stamped for THIS space belongs, on the stamp alone (doc 72 §2);
*  - any other row belongs when it lives in the desk workspace and was made by
*    one of the space's agents (or the space names none), whatever space
*    stamped it — never a room.
*
* Returns the input array itself when nothing is filtered out, so a memo keyed
* on it does not see a new list per render.
*/
function narrowToDesk(rows, desk) {
	const belongs = (row) => {
		if (row.space === desk.spaceId) return true;
		if (row.kind === "room") return false;
		if (desk.workspaceId === void 0) return false;
		if (desk.agents.length > 0 && (row.profile === void 0 || !desk.agents.includes(row.profile))) return false;
		return row.ref.workspaceId === desk.workspaceId;
	};
	return rows.every(belongs) ? rows : rows.filter(belongs);
}
/** The rows a person would call "my sessions" out of the kit's grouped fold.
*  The kit keeps archived rows in the list (its own filter hides them), lists a
*  room's seat only to carry an ask, and parks unregistered-folder rows in a
*  search-only bucket — none of which belong on this rail. */
function railItemsOf(groups) {
	const out = [];
	for (const group of groups) {
		if (group.searchOnly) continue;
		for (const item of group.items) {
			if (item.archived || item.askOnly || item.kind === "room") continue;
			out.push(item);
		}
	}
	return out;
}
/** The open session, read off the host's grouped fold — the one place the rail
*  channel says which row is foreground. */
function activeSessionOf(groups) {
	for (const group of groups) for (const item of group.items) if (item.active && item.sessionRef) return item.sessionRef;
	return null;
}
/** What a collection is keyed by: the session's stable identity. A row that
*  stands for a handoff chain answers with the chain's ROOT, so a `/handoff`
*  (which changes the row's live session id) does not drop it out of its
*  collection. */
function collectionKey(item) {
	return item.lineage?.rootRef.sessionId ?? item.sessionRef?.sessionId ?? item.id;
}
var UNFILED_ID = "unfiled";
function itemTime(item) {
	const time = Date.parse(item.updatedAt ?? "");
	return Number.isFinite(time) ? time : 0;
}
/** A row matches a query on its title, preview, or — for a folded handoff chain —
*  any member's title, so a session the kit folded away is still findable by the
*  name it once had. */
function matches(item, needle) {
	if (needle === "") return true;
	return `${item.title} ${item.preview ?? ""} ${item.lineage?.text ?? ""}`.toLowerCase().includes(needle);
}
/**
* Newest first (`updatedAt`, descending — not live-first, not pinned-first: the
* rail is one honest recency list), partitioned into the user's collections.
*
* A session whose collection no longer exists falls to Unfiled: the store
* unassigns on delete, but a stale or hand-edited blob must degrade to "not
* filed", never to "not shown".
*
* Empty collections are drawn while browsing (a place to file into, and a thing
* to delete) and dropped while searching (a header over nothing is noise).
*/
function foldRail(items, input) {
	const needle = input.query.trim().toLowerCase();
	const ranked = items.filter((item) => matches(item, needle)).map((item) => ({
		item,
		time: itemTime(item)
	})).sort((a, b) => b.time - a.time || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0)).map((entry) => entry.item);
	const known = new Set(input.collections.map((collection) => collection.id));
	const byCollection = /* @__PURE__ */ new Map();
	const unfiled = [];
	for (const item of ranked) {
		const filed = input.collectionOf(collectionKey(item));
		if (filed !== null && known.has(filed)) {
			const bucket = byCollection.get(filed);
			if (bucket) bucket.push(item);
			else byCollection.set(filed, [item]);
		} else unfiled.push(item);
	}
	const sections = [];
	for (const collection of input.collections) {
		const rows = byCollection.get(collection.id) ?? [];
		if (needle !== "" && rows.length === 0) continue;
		sections.push({
			id: collection.id,
			collection,
			items: rows
		});
	}
	if (unfiled.length > 0) sections.push({
		id: UNFILED_ID,
		collection: null,
		items: unfiled
	});
	return {
		sections,
		grouped: input.collections.length > 0,
		total: ranked.length
	};
}
/** A section shows its first `limit` rows and folds the rest behind "Show more"
*  — but never folds away the open session, which would leave the user looking
*  at a conversation the rail claims not to have. `limit` of `Infinity` shows all. */
function clipRows(rows, limit) {
	if (rows.length <= limit) return rows;
	const head = rows.slice(0, limit);
	const active = rows.slice(limit).find((item) => item.active);
	return active ? [...head, active] : head;
}
//#endregion
//#region src/styles.ts
var STYLE_SLOT = "chat-rail-styles";
var EMBER_RAIL_CSS = `
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
/* The voice message mark (doc 91 §8): a sibling of the row button, in flow at the trailing edge. The row button gives
   up exactly its width, so the title and the time keep their own columns. The options button moves left of it, onto the
   time it already replaces on hover, so the mark never sits under it. Keyed on the mark actually being DRAWN (the kit's mark
   decides: it draws nothing with voice off, and stays up under its open popover after the last message is played), not on the
   summary. */
[data-slot="chat-rail"] .er-mail {
	margin-right: 8px;
}
[data-slot="chat-rail"] .er-row:has(> .er-mail) .er-options {
	right: 32px;
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
function ensureStyles() {
	if (typeof document === "undefined") return;
	if (document.head.querySelector(`style[data-slot="chat-rail-styles"]`)) return;
	const style = document.createElement("style");
	style.dataset.slot = STYLE_SLOT;
	style.textContent = EMBER_RAIL_CSS;
	document.head.appendChild(style);
}
//#endregion
//#region src/index.tsx
var MINUTE_MS = 6e4;
/** Relative times ("5m", "2h") are computed when the kit builds a row, so they
*  go stale between facts. One tick a minute re-folds them — the cadence the
*  shipped rails use. */
function useMinute() {
	const [minute, setMinute] = useState(() => Math.floor(Date.now() / MINUTE_MS));
	useEffect(() => {
		const timer = setInterval(() => setMinute(Math.floor(Date.now() / MINUTE_MS)), MINUTE_MS);
		return () => clearInterval(timer);
	}, []);
	return minute;
}
/** A number that moves whenever the collections store changes, so a memo keyed
*  on it re-folds. The store's own `list()` cannot be the key: `assign` changes
*  the grouping without changing the list. */
function useStoreVersion(store) {
	const version = useRef(0);
	return useSyncExternalStore(useCallback((notify) => store.subscribe(() => {
		version.current += 1;
		notify();
	}), [store]), () => version.current, () => 0);
}
/** One text field for every "name this" moment (rename a session, rename a
*  collection, create a collection): Enter commits, Escape cancels, and a blur
*  commits what was typed — the shipped rail's rename convention. `doneRef`
*  stops the blur an Escape-driven unmount fires from committing after all. */
function InlineInput({ initial, label, placeholder, onCommit, onCancel, lead }) {
	const [value, setValue] = useState(initial);
	const doneRef = useRef(false);
	const finish = (commit) => {
		if (doneRef.current) return;
		doneRef.current = true;
		if (commit && value.trim() !== "") onCommit(value);
		else onCancel();
	};
	return /* @__PURE__ */ jsxs("div", {
		className: "er-edit",
		children: [/* @__PURE__ */ jsx("span", {
			className: "er-glyph",
			children: lead
		}), /* @__PURE__ */ jsx("input", {
			autoFocus: true,
			"aria-label": label,
			placeholder,
			value,
			maxLength: 120,
			onChange: (event) => setValue(event.target.value),
			onFocus: (event) => event.currentTarget.select(),
			onClick: (event) => event.stopPropagation(),
			onKeyDown: (event) => {
				event.stopPropagation();
				if (event.key === "Enter") {
					event.preventDefault();
					finish(true);
				} else if (event.key === "Escape") {
					event.preventDefault();
					finish(false);
				}
			},
			onBlur: () => finish(true)
		})]
	});
}
/** One level of `Object.is`, for a prop that is a flat bag the resolver rebuilds on every call (`signals`). */
function sameBag(a, b) {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) || Array.isArray(b)) return false;
	const x = a;
	const y = b;
	const keys = Object.keys(x);
	return keys.length === Object.keys(y).length && keys.every((key) => Object.is(x[key], y[key]));
}
/** Two resolver answers draw the same thing: both absent, the same element, or elements of one type whose props are equal
*  (a flat prop bag compared by value). The resolver's own identity moves with the ACTIVE session's live state on every
*  streamed flush; comparing what a row would draw lets the other rows - all but one - keep their render. */
function samePresence(a, b) {
	if (a === b) return true;
	if (!isValidElement(a) || !isValidElement(b) || a.type !== b.type || a.key !== b.key) return false;
	const x = a.props;
	const y = b.props;
	const keys = Object.keys(x);
	return keys.length === Object.keys(y).length && keys.every((key) => sameBag(x[key], y[key]));
}
/** What the voicemail mark DRAWS from a row: nothing, a message, or a message that needs you. A catalog republish
*  rebuilds `voicemail` on every fold, so the row's memo compares this, not the object. */
function mailKey(item) {
	const mail = item.voicemail;
	return mail && mail.unplayed > 0 ? mail.needsYou ? 2 : 1 : 0;
}
/** Equal when nothing the row DRAWS or ACTS ON changed. A re-fold hands every
*  row a fresh object (the kit builds them per call), so identity would defeat
*  the memo on every minute tick and every catalog change; the fields below are
*  the ones a handler reads back out of `item` when it fires (`sessionRef` and
*  `lineage` are what `selectSession`/`renameItem`/`archiveSessions` address). */
function sameRow(a, b) {
	const x = a.item;
	const y = b.item;
	return (x === y || x.id === y.id && x.title === y.title && x.time === y.time && x.status === y.status && x.dotState === y.dotState && x.active === y.active && x.unread === y.unread && mailKey(x) === mailKey(y) && x.continuedInto?.toSessionId === y.continuedInto?.toSessionId && x.sessionRef?.sessionId === y.sessionRef?.sessionId && x.sessionRef?.workspaceId === y.sessionRef?.workspaceId && x.lineage?.rootRef.sessionId === y.lineage?.rootRef.sessionId && x.profile === y.profile) && a.actions === b.actions && samePresence(a.presence, b.presence) && a.renaming === b.renaming && a.menuOpen === b.menuOpen && a.onOpenMenu === b.onOpenMenu && a.onRenamed === b.onRenamed;
}
/** The dot slot: the handoff mark for a frozen row, else the host's presence
*  answer (`useRailSessionPresence`, the only route to the vibr avatar), else the
*  status dot — `null` from the resolver is how a row falls back to the dot. */
function Lead({ item, presence }) {
	if (item.continuedInto) return /* @__PURE__ */ jsx("span", {
		className: "er-glyph",
		children: /* @__PURE__ */ jsx(Icon, {
			name: "branch",
			size: 13,
			strokeWidth: 1.8,
			"aria-hidden": "true"
		})
	});
	return /* @__PURE__ */ jsx("span", {
		className: "er-glyph",
		children: presence ?? /* @__PURE__ */ jsx(ActivityDot, { state: item.dotState ?? item.status })
	});
}
var Row = memo(function Row({ item, actions, presence, renaming, menuOpen, onOpenMenu, onRenamed }) {
	const ref = item.sessionRef;
	const onClick = useCallback(() => actions.selectSession?.(item), [actions, item]);
	const onContextMenu = useCallback((event) => {
		event.preventDefault();
		onOpenMenu(item, anchorOf(event));
	}, [item, onOpenMenu]);
	const onOptions = useCallback((event) => {
		const rect = event.currentTarget.getBoundingClientRect();
		onOpenMenu(item, {
			x: rect.right,
			y: rect.bottom + 4
		});
	}, [item, onOpenMenu]);
	const intent = actions.sessionIntent;
	const arrive = useCallback(() => ref && intent?.(ref, true), [intent, ref]);
	const leave = useCallback(() => ref && intent?.(ref, false), [intent, ref]);
	if (renaming) return /* @__PURE__ */ jsx("div", {
		className: "er-row",
		"data-renaming": "",
		"data-active": item.active ? "" : void 0,
		children: /* @__PURE__ */ jsx(InlineInput, {
			initial: item.title,
			label: "Rename session",
			lead: /* @__PURE__ */ jsx(Lead, {
				item,
				presence
			}),
			onCommit: (value) => onRenamed(item, value),
			onCancel: () => onRenamed(item, null)
		})
	});
	return /* @__PURE__ */ jsxs("div", {
		className: "er-row",
		"data-slot": "chat-session",
		"data-session-id": ref?.sessionId ?? item.id,
		"data-active": item.active ? "" : void 0,
		"data-unread": item.unread ? "" : void 0,
		"data-frozen": item.continuedInto ? "" : void 0,
		children: [
			/* @__PURE__ */ jsxs("button", {
				type: "button",
				className: "er-row-main",
				disabled: actions.selectSession === void 0,
				"aria-current": item.active ? "true" : void 0,
				onClick,
				onContextMenu,
				onPointerEnter: arrive,
				onPointerLeave: leave,
				onFocus: arrive,
				onBlur: leave,
				children: [
					/* @__PURE__ */ jsx(Lead, {
						item,
						presence
					}),
					/* @__PURE__ */ jsx("span", {
						className: "er-title",
						children: item.title
					}),
					/* @__PURE__ */ jsx("span", {
						className: "er-time",
						children: item.time
					})
				]
			}),
			ref ? /* @__PURE__ */ jsx(VoicemailMark, {
				sessionId: ref.sessionId,
				voicemail: item.voicemail,
				title: item.title,
				agent: item.profile,
				className: "er-mail"
			}) : null,
			/* @__PURE__ */ jsx("button", {
				type: "button",
				className: "er-options",
				"aria-label": `Options for ${item.title}`,
				"aria-haspopup": "menu",
				"aria-expanded": menuOpen,
				onClick: onOptions,
				children: /* @__PURE__ */ jsx(Icon, {
					name: "dots",
					size: 16,
					strokeWidth: 3.2,
					"aria-hidden": "true"
				})
			})
		]
	});
}, sameRow);
function SessionMenu({ anchor, item, collections, current, actions, store, onClose, onRename }) {
	const [naming, setNaming] = useState(false);
	const [name, setName] = useState("");
	const key = collectionKey(item);
	const file = (collectionId) => () => {
		store.assign(key, collectionId);
		onClose();
	};
	const createAndFile = (event) => {
		event.preventDefault();
		if (name.trim() === "") return;
		store.assign(key, store.create(name).id);
		onClose();
	};
	return /* @__PURE__ */ jsx(MenuShell, {
		anchor,
		label: `Options for ${item.title}`,
		onClose,
		children: naming ? /* @__PURE__ */ jsxs("form", {
			className: "erm-new",
			onSubmit: createAndFile,
			children: [/* @__PURE__ */ jsx("input", {
				autoFocus: true,
				"aria-label": "Collection name",
				placeholder: "Collection name",
				value: name,
				maxLength: 120,
				onChange: (event) => setName(event.target.value)
			}), /* @__PURE__ */ jsxs("div", {
				className: "erm-actions",
				children: [/* @__PURE__ */ jsx("button", {
					type: "submit",
					className: "erm-btn",
					disabled: name.trim() === "",
					children: "Create and add"
				}), /* @__PURE__ */ jsx("button", {
					type: "button",
					className: "erm-btn",
					onClick: () => setNaming(false),
					children: "Back"
				})]
			})]
		}) : /* @__PURE__ */ jsxs(Fragment, { children: [
			actions.renameItem ? /* @__PURE__ */ jsx(MenuItem, {
				icon: "edit",
				onSelect: () => {
					onClose();
					onRename(item);
				},
				children: "Rename"
			}) : null,
			actions.archiveSessions ? /* @__PURE__ */ jsx(MenuItem, {
				icon: "archive",
				onSelect: () => {
					onClose();
					actions.archiveSessions?.([item]);
				},
				children: "Archive"
			}) : null,
			actions.renameItem || actions.archiveSessions ? /* @__PURE__ */ jsx(MenuRule, {}) : null,
			/* @__PURE__ */ jsx(MenuHeading, { children: "Move to collection" }),
			collections.map((collection) => /* @__PURE__ */ jsx(MenuItem, {
				checked: collection.id === current,
				onSelect: file(collection.id),
				children: collection.name
			}, collection.id)),
			current !== null ? /* @__PURE__ */ jsx(MenuItem, {
				onSelect: file(null),
				children: "Remove from collection"
			}) : null,
			/* @__PURE__ */ jsx(MenuItem, {
				icon: "plus",
				onSelect: () => setNaming(true),
				children: "New collection…"
			}),
			/* @__PURE__ */ jsx(MenuRule, {}),
			/* @__PURE__ */ jsx(MenuItem, {
				onSelect: (event) => {
					onClose();
					const atOrigin = event.clientX === 0 && event.clientY === 0;
					actions.sessionContextMenu(item, atOrigin ? Object.create(event, {
						clientX: { value: anchor.x },
						clientY: { value: anchor.y }
					}) : event);
				},
				children: "More actions"
			})
		] })
	});
}
function CollectionMenu({ anchor, collection, onClose, onRename, onDelete }) {
	return /* @__PURE__ */ jsxs(MenuShell, {
		anchor,
		label: `Options for ${collection.name}`,
		onClose,
		children: [/* @__PURE__ */ jsx(MenuItem, {
			icon: "edit",
			onSelect: () => {
				onClose();
				onRename(collection);
			},
			children: "Rename"
		}), /* @__PURE__ */ jsx(MenuItem, {
			icon: "trash",
			tone: "danger",
			onSelect: () => {
				onClose();
				onDelete(collection);
			},
			children: "Delete collection"
		})]
	});
}
/** Rows a section shows before its "Show more" row. Searching lifts the fold: a
*  search that stops at a limit is indistinguishable from one that found nothing
*  more. */
var SECTION_FOLD = 30;
function SectionRows({ rows, sectionId, searching, expanded, onToggleExpanded, ctx }) {
	const shown = clipRows(rows, searching || expanded ? Number.POSITIVE_INFINITY : SECTION_FOLD);
	const hidden = rows.length - shown.length;
	return /* @__PURE__ */ jsxs("div", {
		className: "er-rows",
		children: [shown.map((item) => /* @__PURE__ */ jsx(Row, {
			item,
			actions: ctx.actions,
			presence: item.continuedInto ? null : ctx.sessionPresence(item),
			renaming: ctx.renamingId === item.id,
			menuOpen: ctx.menuItemId === item.id,
			onOpenMenu: ctx.onOpenMenu,
			onRenamed: ctx.onRenamed
		}, item.id)), hidden > 0 || expanded && rows.length > SECTION_FOLD && !searching ? /* @__PURE__ */ jsxs("button", {
			type: "button",
			className: "er-more",
			onClick: () => onToggleExpanded(sectionId),
			children: [/* @__PURE__ */ jsx("span", {
				className: "er-glyph",
				"aria-hidden": "true"
			}), expanded ? "Show less" : `Show ${hidden} more`]
		}) : null]
	});
}
function CollectionHead({ collection, count, open, renaming, onToggle, onOpenMenu, onRenamed }) {
	if (renaming) return /* @__PURE__ */ jsx(InlineInput, {
		initial: collection.name,
		label: "Rename collection",
		lead: /* @__PURE__ */ jsx(Icon, {
			name: "folder",
			size: 14,
			strokeWidth: 1.8,
			"aria-hidden": "true"
		}),
		onCommit: (value) => onRenamed(collection, value),
		onCancel: () => onRenamed(collection, null)
	});
	return /* @__PURE__ */ jsxs("div", {
		className: "er-section-head",
		"data-manage": "",
		children: [/* @__PURE__ */ jsxs("button", {
			type: "button",
			className: "er-section-toggle",
			"aria-expanded": open,
			onClick: () => onToggle(collection.id),
			onContextMenu: (event) => {
				event.preventDefault();
				onOpenMenu(collection, anchorOf(event));
			},
			children: [
				/* @__PURE__ */ jsx("span", {
					className: "er-glyph",
					children: /* @__PURE__ */ jsx(Icon, {
						name: "caretR",
						size: 12,
						strokeWidth: 2.2,
						className: "er-caret",
						"aria-hidden": "true"
					})
				}),
				/* @__PURE__ */ jsx("span", {
					className: "er-section-name",
					children: collection.name
				}),
				/* @__PURE__ */ jsx("span", {
					className: "er-count",
					children: count
				})
			]
		}), /* @__PURE__ */ jsx("button", {
			type: "button",
			className: "er-options",
			"aria-label": `Options for ${collection.name}`,
			"aria-haspopup": "menu",
			onClick: (event) => {
				const rect = event.currentTarget.getBoundingClientRect();
				onOpenMenu(collection, {
					x: rect.right,
					y: rect.bottom + 4
				});
			},
			children: /* @__PURE__ */ jsx(Icon, {
				name: "dots",
				size: 16,
				strokeWidth: 3.2,
				"aria-hidden": "true"
			})
		})]
	});
}
/** Rows the compact (56px) rail draws: one glyph each, so a long list is a
*  column of dots, not a rail. */
var COMPACT_ROWS = 30;
/** A copy of `set` with `id` flipped in or out. */
function toggled(set, id) {
	const next = new Set(set);
	if (!next.delete(id)) next.add(id);
	return next;
}
var NO_RAW = [];
var NO_COLLECTED = {
	collections: [],
	collectionOf: () => null,
	query: ""
};
var ChatRailSection = memo(function ChatRailSection({ rail, actions, capabilities, switcher }) {
	const facts = useObservable(rail);
	const root = useStandardRootFacts();
	const store = collectionsStore;
	const compact = facts.mode.rail === "compact";
	const query = facts.search.value;
	const searching = query.trim() !== "";
	useEffect(ensureStyles, []);
	const agentKey = (capabilities.agents ?? []).map((agent) => agent.name).join("\0");
	const desk = useMemo(() => resolveDesk(facts.spaces, facts.mode.app, agentKey === "" ? [] : agentKey.split("\0")), [
		facts.spaces,
		facts.mode.app,
		agentKey
	]);
	const scoped = useMemo(() => narrowToDesk(root.sessions ?? NO_RAW, desk), [root.sessions, desk]);
	const activeRef = facts.activeSession ?? activeSessionOf(facts.sessions);
	const items = useMemo(() => railItemsOf(sessionGroupsFromCatalog(scoped, activeRef)), [
		scoped,
		activeRef ? `${activeRef.workspaceId}\u0000${activeRef.sessionId}` : "",
		useMinute()
	]);
	const storeVersion = useStoreVersion(store);
	const collections = store.list();
	const fold = useMemo(() => foldRail(items, {
		collections,
		collectionOf: store.collectionOf,
		query
	}), [
		items,
		collections,
		storeVersion,
		query,
		store
	]);
	const flat = useMemo(() => compact ? foldRail(items, NO_COLLECTED).sections[0]?.items ?? [] : [], [compact, items]);
	const sessionPresence = useRailSessionPresence(facts.presence);
	const spaceActions = useRailActionSet(facts.spaces, facts.mode.app);
	const extraActions = useMemo(() => spaceActions.filter((action) => action.target !== "new-session"), [spaceActions]);
	const [menu, setMenu] = useState(null);
	const closeMenu = useCallback(() => setMenu(null), []);
	const [renamingId, setRenamingId] = useState(null);
	const [renamingCollection, setRenamingCollection] = useState(null);
	const [creating, setCreating] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(null);
	const [collapsed, setCollapsed] = useState(() => /* @__PURE__ */ new Set());
	const [expanded, setExpanded] = useState(() => /* @__PURE__ */ new Set());
	const toggleCollapsed = useCallback((id) => setCollapsed((current) => toggled(current, id)), []);
	const toggleExpanded = useCallback((id) => setExpanded((current) => toggled(current, id)), []);
	const openSessionMenu = useCallback((item, anchor) => setMenu({
		anchor,
		target: {
			kind: "session",
			item
		}
	}), []);
	const openCollectionMenu = useCallback((collection, anchor) => setMenu({
		anchor,
		target: {
			kind: "collection",
			collection
		}
	}), []);
	const startRename = useCallback((item) => setRenamingId(item.id), []);
	const onSessionRenamed = useCallback((item, value) => {
		setRenamingId(null);
		const title = value?.trim();
		if (title && title !== item.title) actions.renameItem?.(item, title);
	}, [actions]);
	const onCollectionRenamed = useCallback((collection, name) => {
		setRenamingCollection(null);
		if (name !== null) store.rename(collection.id, name);
	}, [store]);
	const onCollectionCreated = useCallback((name) => {
		setCreating(false);
		if (name !== null) store.create(name);
	}, [store]);
	const deleteCollection = useCallback((collection) => {
		setConfirmDelete(null);
		store.remove(collection.id);
	}, [store]);
	const onSearchChange = useCallback((event) => actions.setSearch(event.currentTarget.value), [actions]);
	const onSearchFocus = useCallback(() => actions.setSearchOpen(true), [actions]);
	const onSearchKey = useCallback((event) => {
		if (event.key !== "Escape") return;
		actions.setSearch("");
		actions.setSearchOpen(false);
		event.currentTarget.blur();
	}, [actions]);
	const agent = capabilities.agents?.[0]?.name;
	const canCreate = actions.newSession !== void 0 || actions.newSessionAs !== void 0 && agent !== void 0;
	const onNewSession = useCallback(() => {
		actions.intent({ t: "create" });
		if (actions.newSession) actions.newSession();
		else if (agent !== void 0) actions.newSessionAs?.(agent);
	}, [actions, agent]);
	const ctx = useMemo(() => ({
		actions,
		sessionPresence,
		renamingId,
		menuItemId: menu?.target.kind === "session" ? menu.target.item.id : null,
		onOpenMenu: openSessionMenu,
		onRenamed: onSessionRenamed
	}), [
		actions,
		sessionPresence,
		renamingId,
		menu,
		openSessionMenu,
		onSessionRenamed
	]);
	const menuNode = menu === null ? null : menu.target.kind === "session" ? /* @__PURE__ */ jsx(SessionMenu, {
		anchor: menu.anchor,
		item: menu.target.item,
		collections,
		current: store.collectionOf(collectionKey(menu.target.item)),
		actions,
		store,
		onClose: closeMenu,
		onRename: startRename
	}) : /* @__PURE__ */ jsx(CollectionMenu, {
		anchor: menu.anchor,
		collection: menu.target.collection,
		onClose: closeMenu,
		onRename: (collection) => setRenamingCollection(collection.id),
		onDelete: (collection) => setConfirmDelete(collection.id)
	});
	if (compact) return /* @__PURE__ */ jsx(TooltipProvider, {
		delayDuration: 350,
		children: /* @__PURE__ */ jsxs("aside", {
			"data-slot": "chat-rail",
			"data-compact": "",
			className: "er-rail",
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "er-head",
					children: [/* @__PURE__ */ jsx(IconButton, {
						"aria-label": "Expand rail",
						onClick: actions.toggleCompact,
						children: /* @__PURE__ */ jsx(Icon, {
							name: "panel",
							size: 15,
							strokeWidth: 1.8,
							"aria-hidden": "true"
						})
					}), canCreate ? /* @__PURE__ */ jsx(IconButton, {
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
				/* @__PURE__ */ jsx("div", {
					className: "er-list er-compact-list",
					children: clipRows(flat, COMPACT_ROWS).map((item) => /* @__PURE__ */ jsxs(Tooltip, { children: [/* @__PURE__ */ jsx(TooltipTrigger, {
						asChild: true,
						children: /* @__PURE__ */ jsx("button", {
							type: "button",
							className: "er-compact-row",
							"data-active": item.active ? "" : void 0,
							"aria-label": item.title,
							disabled: actions.selectSession === void 0,
							onClick: () => actions.selectSession?.(item),
							onContextMenu: (event) => {
								event.preventDefault();
								actions.sessionContextMenu(item, event);
							},
							children: /* @__PURE__ */ jsx(Lead, {
								item,
								presence: item.continuedInto ? null : ctx.sessionPresence(item)
							})
						})
					}), /* @__PURE__ */ jsx(TooltipContent, {
						side: "right",
						children: item.title
					})] }, item.id))
				})
			]
		})
	});
	const renderRows = (section) => /* @__PURE__ */ jsx(SectionRows, {
		rows: section.items,
		sectionId: section.id,
		searching,
		expanded: expanded.has(section.id),
		onToggleExpanded: toggleExpanded,
		ctx
	});
	return /* @__PURE__ */ jsx(TooltipProvider, {
		delayDuration: 700,
		children: /* @__PURE__ */ jsxs("aside", {
			"data-slot": "chat-rail",
			className: "er-rail",
			children: [
				switcher,
				/* @__PURE__ */ jsxs("div", {
					className: "er-head",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "er-search",
						children: [/* @__PURE__ */ jsx(Icon, {
							name: "search",
							size: 13,
							strokeWidth: 1.8,
							"aria-hidden": "true"
						}), /* @__PURE__ */ jsx(Input, {
							size: "sm",
							variant: "ghost",
							type: "search",
							placeholder: "Search",
							"aria-label": "Search sessions",
							value: query,
							onChange: onSearchChange,
							onFocus: onSearchFocus,
							onKeyDown: onSearchKey
						})]
					}), canCreate ? /* @__PURE__ */ jsxs(Tooltip, { children: [/* @__PURE__ */ jsx(TooltipTrigger, {
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
					})] }) : null]
				}),
				extraActions.length > 0 ? /* @__PURE__ */ jsx(FraymRailActions, {
					actions: extraActions,
					onIntent: actions.intent,
					onOpenRailSession: actions.openRailSession,
					activeSurface: facts.mode.activeSurface ?? "session"
				}) : null,
				/* @__PURE__ */ jsxs("div", {
					className: "er-list",
					"data-slot": "chat-list",
					children: [
						searching ? null : creating ? /* @__PURE__ */ jsx(InlineInput, {
							initial: "",
							label: "New collection",
							placeholder: "Collection name",
							lead: /* @__PURE__ */ jsx(Icon, {
								name: "folder",
								size: 14,
								strokeWidth: 1.8,
								"aria-hidden": "true"
							}),
							onCommit: (name) => onCollectionCreated(name),
							onCancel: () => onCollectionCreated(null)
						}) : /* @__PURE__ */ jsxs("button", {
							type: "button",
							className: "er-plain",
							onClick: () => setCreating(true),
							children: [/* @__PURE__ */ jsx("span", {
								className: "er-glyph",
								children: /* @__PURE__ */ jsx(Icon, {
									name: "plus",
									size: 14,
									strokeWidth: 1.8,
									"aria-hidden": "true"
								})
							}), "New collection"]
						}),
						fold.total === 0 && (searching || !fold.grouped) ? /* @__PURE__ */ jsxs("div", {
							className: "er-empty",
							children: [/* @__PURE__ */ jsx("strong", { children: searching ? "No sessions match" : "No sessions yet" }), searching ? "Try a shorter query." : "Start a conversation and it will land here."]
						}) : null,
						fold.grouped ? fold.sections.map((section) => {
							const open = !collapsed.has(section.id);
							const collection = section.collection;
							return /* @__PURE__ */ jsxs("section", {
								className: "er-section",
								"data-slot": "chat-collection",
								"data-collection": collection ? section.id : void 0,
								"data-open": open ? "" : void 0,
								children: [
									collection ? /* @__PURE__ */ jsx(CollectionHead, {
										collection,
										count: section.items.length,
										open,
										renaming: renamingCollection === collection.id,
										onToggle: toggleCollapsed,
										onOpenMenu: openCollectionMenu,
										onRenamed: onCollectionRenamed
									}) : /* @__PURE__ */ jsx("div", {
										className: "er-section-head",
										children: /* @__PURE__ */ jsxs("button", {
											type: "button",
											className: "er-section-toggle",
											"aria-expanded": open,
											onClick: () => toggleCollapsed(section.id),
											children: [
												/* @__PURE__ */ jsx("span", {
													className: "er-glyph",
													children: /* @__PURE__ */ jsx(Icon, {
														name: "caretR",
														size: 12,
														strokeWidth: 2.2,
														className: "er-caret",
														"aria-hidden": "true"
													})
												}),
												/* @__PURE__ */ jsx("span", {
													className: "er-section-name",
													children: "Unfiled"
												}),
												/* @__PURE__ */ jsx("span", {
													className: "er-count",
													children: section.items.length
												})
											]
										})
									}),
									collection && confirmDelete === collection.id ? /* @__PURE__ */ jsxs("div", {
										className: "er-confirm",
										role: "alertdialog",
										"aria-label": `Delete ${collection.name}`,
										children: [/* @__PURE__ */ jsxs("span", { children: [
											"Delete ",
											/* @__PURE__ */ jsx("strong", { children: collection.name }),
											"? Its sessions stay, under Unfiled."
										] }), /* @__PURE__ */ jsxs("span", {
											className: "er-confirm-actions",
											children: [/* @__PURE__ */ jsx("button", {
												type: "button",
												className: "er-btn",
												"data-tone": "danger",
												onClick: () => deleteCollection(collection),
												children: "Delete"
											}), /* @__PURE__ */ jsx("button", {
												type: "button",
												className: "er-btn",
												onClick: () => setConfirmDelete(null),
												children: "Cancel"
											})]
										})]
									}) : null,
									open ? section.items.length === 0 ? /* @__PURE__ */ jsx("div", {
										className: "er-section-empty",
										children: "Move a session here from its menu."
									}) : renderRows(section) : null
								]
							}, section.id);
						}) : fold.sections.map((section) => /* @__PURE__ */ jsx("div", { children: renderRows(section) }, section.id))
					]
				}),
				menuNode
			]
		})
	});
});
/** The declarative half — the host validates id/contract against its own
*  manifest record; what matters here is the contract version it speaks. */
var implementation = {
	specVersion: 2,
	id: "chat-rail",
	slot: "rail",
	component: ChatRailSection
};
//#endregion
export { ChatRailSection, ChatRailSection as default, implementation };
