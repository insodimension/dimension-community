// The KPI fold over `sessions/list`: whose row it is, what counts as a session
// this week, how a handoff chain counts once, and where the default agent's
// sessions go.
import { describe, expect, test } from "bun:test";
import { agoLabel, foldActivity, liveStateOf, NO_ACTIVITY, shareActivity, WEEK_MS } from "../page/kpis";
import type { SessionRow } from "../page/types";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function row(id: string, profile: string | undefined, hoursAgo: number, extra: Partial<SessionRow> = {}): SessionRow {
	return { ref: { sessionId: id }, ...(profile !== undefined ? { profile } : {}), updatedAt: new Date(NOW - hoursAgo * HOUR).toISOString(), ...extra };
}

const of = (rows: readonly SessionRow[], agent: string) => foldActivity(rows, NOW, "coding").get(agent) ?? NO_ACTIVITY;

describe("the activity fold", () => {
	test("a row is its profile's, never another agent's", () => {
		const rows = [row("a", "cmo", 1), row("b", "cmo", 2), row("c", "scribe", 3)];
		expect(of(rows, "cmo").sessions7d).toBe(2);
		expect(of(rows, "scribe").sessions7d).toBe(1);
		expect(of(rows, "herald")).toEqual(NO_ACTIVITY);
	});

	test("a row with no profile is the default agent's", () => {
		const rows = [row("a", undefined, 1), row("b", undefined, 30), row("c", "cmo", 1)];
		expect(of(rows, "coding").sessions7d).toBe(2);
		expect(of(rows, "cmo").sessions7d).toBe(1);
	});

	test("Sessions 7d counts only the last 7 days of messages; the total and last active see every row", () => {
		const inside = WEEK_MS / HOUR - 1;
		const outside = WEEK_MS / HOUR + 1;
		const rows = [row("a", "cmo", inside), row("b", "cmo", outside), row("c", "cmo", 400)];
		const cmo = of(rows, "cmo");
		expect(cmo.sessions7d).toBe(1);
		expect(cmo.sessionsTotal).toBe(3);
		expect(cmo.lastActive).toBe(NOW - inside * HOUR);
	});

	test("a handoff chain is one conversation: only its live end counts, and the frozen link's live fields are ignored", () => {
		const rows = [
			row("first", "cmo", 5, { continuedInto: { toSessionId: "second" }, liveStatus: "running" }),
			row("second", "cmo", 4, { continuedFrom: "first", continuedInto: { toSessionId: "third" } }),
			row("third", "cmo", 1, { continuedFrom: "second", liveStatus: "running" }),
		];
		const cmo = of(rows, "cmo");
		expect(cmo.sessions7d).toBe(1);
		expect(cmo.sessionsTotal).toBe(1);
		expect(cmo.working).toBe(1);
		// A successor alone (its predecessor listed without `continuedInto`) still folds it.
		expect(of([row("x", "cmo", 3), row("y", "cmo", 2, { continuedFrom: "x" })], "cmo").sessionsTotal).toBe(1);
	});

	test("rooms count as the lead's, not as sessions; autonomy runs count as runs, not sessions; archived rows count for neither", () => {
		const rows = [
			row("r1", undefined, 1, { kind: "room", roomAuthority: "cmo" }),
			row("r2", undefined, 1, { kind: "room", roomAuthority: "cmo", archivedAt: new Date(NOW).toISOString() }),
			row("run", "cmo", 2, { source: "autonomy" }),
			row("gone", "cmo", 2, { archivedAt: new Date(NOW).toISOString() }),
			row("live", "cmo", 3),
		];
		const cmo = of(rows, "cmo");
		expect(cmo.roomsLed).toBe(1);
		expect(cmo.runs7d).toBe(1);
		expect(cmo.sessions7d).toBe(1);
		expect(of(rows, "coding").sessionsTotal).toBe(0);
		expect(cmo.lastActive).toBe(NOW - 2 * HOUR);
	});

	test("waiting on you outranks working, and an idle agent says when it was last active, or Never", () => {
		const rows = [row("a", "cmo", 0.1, { liveStatus: "running" }), row("b", "cmo", 1, { blockedOnInput: true }), row("c", "scribe", 0.2, { liveStatus: "background" })];
		expect(liveStateOf(of(rows, "cmo"))).toBe("needs-you");
		expect(liveStateOf(of(rows, "scribe"))).toBe("working");
		expect(agoLabel(of(rows, "herald").lastActive, NOW)).toBe("Never");
		expect(agoLabel(NOW - 3 * HOUR, NOW)).toBe("3h ago");
	});
});

describe("sharing activity between folds", () => {
	const fold = (rows: readonly SessionRow[]) => foldActivity(rows, NOW, "coding");

	test("an agent whose numbers did not move keeps the object it had, so its card can be skipped; one that moved gets a new one", () => {
		const before = fold([row("a", "cmo", 1), row("b", "scribe", 2)]);
		// cmo gains a live session; scribe is untouched.
		const after = shareActivity(before, fold([row("a", "cmo", 1), row("c", "cmo", 0.1, { liveStatus: "running" }), row("b", "scribe", 2)]));
		expect(after.get("scribe")).toBe(before.get("scribe"));
		expect(after.get("cmo")).not.toBe(before.get("cmo"));
		expect(after.get("cmo")).toMatchObject({ sessions7d: 2, working: 1 });
	});

	test("sharing never changes a reading: an agent that appeared or went quiet is exactly what the fold said", () => {
		const before = fold([row("a", "cmo", 1)]);
		const next = fold([row("b", "scribe", 2)]);
		const after = shareActivity(before, next);
		expect([...after.keys()]).toEqual(["scribe"]);
		expect(after.get("scribe")).toEqual(next.get("scribe"));
		expect(shareActivity(undefined, next)).toBe(next);
	});
});
