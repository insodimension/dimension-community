import { expect, test } from "bun:test";
import googleCalendarExtension from "../index";

type ApprovalSubject = { name: string; formatApprovalDetails?: (args: unknown) => string[] };

const tools = new Map<string, ApprovalSubject>();
googleCalendarExtension({
	registerTool(tool: ApprovalSubject) {
		tools.set(tool.name, tool);
	},
} as unknown as Parameters<typeof googleCalendarExtension>[0]);

function card(name: string, args: unknown): string {
	const format = tools.get(name)?.formatApprovalDetails;
	if (!format) throw new Error(`${name} has no approval card`);
	return format(args).join("\n");
}

const event = { summary: "Planning", startIso: "2026-10-01T10:00:00Z", endIso: "2026-10-01T11:00:00Z" };

test("the update card names the event and every field the patch changes", () => {
	const shown = card("google_calendar_update_event", {
		calendarId: "team@example.com",
		eventId: "evt_1",
		summary: "Renamed",
		startIso: "2026-10-02T10:00:00Z",
		endIso: "2026-10-02T11:00:00Z",
		description: "new agenda",
		location: "Room 2",
	});
	for (const part of [
		"team@example.com",
		"evt_1",
		"Renamed",
		"2026-10-02T10:00:00Z",
		"2026-10-02T11:00:00Z",
		"new agenda",
		"Room 2",
	]) {
		expect(shown).toContain(part);
	}
});

test.each([
	["no attendee list", event],
	["an empty attendee list", { ...event, attendeeEmails: [] }],
])("the create card says no one is invited for %s", (_label, args) => {
	const shown = card("google_calendar_create_event", args);
	expect(shown).toContain("Invites: none");
	expect(shown).not.toContain("malformed");
});

test("the create card flags a non-array attendee list as malformed", () => {
	expect(card("google_calendar_create_event", { ...event, attendeeEmails: "a@example.com" })).toContain(
		"(malformed attendeeEmails)",
	);
});
