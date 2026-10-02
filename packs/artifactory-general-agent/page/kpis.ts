// Every agent's activity, folded ONCE per page from the public `sessions/list`
// cell (never per card: the cell is rebuilt on every streaming event, so the
// page coalesces it and folds the whole roster in one pass). Pure.
//
// The rules (doc: agent://AgentKpis 'Recommended card KPIs' and 'Gotchas'):
// - A row belongs to its `profile`; a row with none is the DEFAULT agent's (the
//   Code space's default, `coding`), never unowned.
// - A SESSION is a non-room, unarchived row that an autonomy did not start.
//   A handoff chain (`continuedFrom` / `continuedInto`) is ONE conversation:
//   only its live end counts, so a /handoff never reads as two sessions.
// - Sessions 7d counts conversations whose last real message is within the
//   window (`updatedAt` only moves on a message write).
// - Last active is the newest `updatedAt` over the agent's rows, autonomy runs
//   included; no rows = never, not a fake date.
// - Working / Needs you come from the live fields of unarchived live ends.
// - Rooms led is the LIVE lead (`roomAuthority`), never membership.
import type { SessionRow } from "./types";

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface AgentActivity {
	readonly sessions7d: number;
	readonly sessionsTotal: number;
	/** Epoch ms; null = no row at all. */
	readonly lastActive: number | null;
	readonly working: number;
	readonly needsYou: number;
	readonly roomsLed: number;
	readonly runs7d: number;
}

export const NO_ACTIVITY: AgentActivity = {
	sessions7d: 0,
	sessionsTotal: 0,
	lastActive: null,
	working: 0,
	needsYou: 0,
	roomsLed: 0,
	runs7d: 0,
};

interface Tally {
	sessions7d: number;
	sessionsTotal: number;
	lastActive: number | null;
	working: number;
	needsYou: number;
	roomsLed: number;
	runs7d: number;
}

export function foldActivity(rows: readonly SessionRow[] | undefined, now: number, defaultAgent: string): ReadonlyMap<string, AgentActivity> {
	const out = new Map<string, Tally>();
	if (rows === undefined) return out;
	const tally = (agent: string): Tally => {
		let entry = out.get(agent);
		if (entry === undefined) {
			entry = { ...NO_ACTIVITY };
			out.set(agent, entry);
		}
		return entry;
	};
	// The ids a later row continues: each is a superseded link of its chain.
	const superseded = new Set<string>();
	for (const row of rows) if (row.continuedFrom !== undefined) superseded.add(row.continuedFrom);
	const since = now - WEEK_MS;
	for (const row of rows) {
		if (row.kind === "room") {
			if (row.archivedAt === undefined && row.roomAuthority !== undefined) tally(row.roomAuthority).roomsLed += 1;
			continue;
		}
		const entry = tally(row.profile ?? defaultAgent);
		const at = Date.parse(row.updatedAt);
		if (Number.isFinite(at) && (entry.lastActive === null || at > entry.lastActive)) entry.lastActive = at;
		if (row.archivedAt !== undefined) continue;
		const recent = Number.isFinite(at) && at >= since;
		if (row.source === "autonomy") {
			if (recent) entry.runs7d += 1;
			continue;
		}
		if (row.continuedInto !== undefined || superseded.has(row.ref.sessionId)) continue;
		entry.sessionsTotal += 1;
		if (recent) entry.sessions7d += 1;
		if (row.liveStatus === "running" || row.liveStatus === "background") entry.working += 1;
		if (row.blockedOnInput === true || row.attention !== undefined) entry.needsYou += 1;
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
export function shareActivity(previous: ReadonlyMap<string, AgentActivity> | undefined, next: ReadonlyMap<string, AgentActivity>): ReadonlyMap<string, AgentActivity> {
	if (previous === undefined) return next;
	const shared = new Map<string, AgentActivity>();
	for (const [agent, activity] of next) {
		const before = previous.get(agent);
		shared.set(agent, before !== undefined && sameActivity(before, activity) ? before : activity);
	}
	return shared;
}

function sameActivity(a: AgentActivity, b: AgentActivity): boolean {
	return (
		a.sessions7d === b.sessions7d &&
		a.sessionsTotal === b.sessionsTotal &&
		a.lastActive === b.lastActive &&
		a.working === b.working &&
		a.needsYou === b.needsYou &&
		a.roomsLed === b.roomsLed &&
		a.runs7d === b.runs7d
	);
}

/** An agent's live state, in the card's words. */
export type LiveState = "needs-you" | "working" | "idle";

export function liveStateOf(activity: AgentActivity): LiveState {
	if (activity.needsYou > 0) return "needs-you";
	if (activity.working > 0) return "working";
	return "idle";
}

// ── how a reading is printed ────────────────────────────────────────────────

/** `3h ago`, `2d ago`, `just now`; `Never` for no row. */
export function agoLabel(at: number | null, now: number): string {
	if (at === null) return "Never";
	const seconds = Math.max(0, Math.round((now - at) / 1000));
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
export function tokenLabel(tokens: number): string {
	if (tokens < 1000) return `${Math.round(tokens)}`;
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** `$0.00`, `$1.24`, `$312`. */
export function money(usd: number): string {
	if (usd >= 100) return `$${Math.round(usd)}`;
	return `$${usd.toFixed(2)}`;
}
