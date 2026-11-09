// Google Calendar connector — read the agenda, check availability, and create/
// update/delete events over the Calendar API v3, authenticated via the plugin's
// `oauth` connect flow (see fraym.plugin.json). The connect flow writes
// {access,refresh,expires,clientId,clientSecret?} to CONFIG_TARGET; this
// extension's ONLY job is to keep that access token fresh and expose it as agent
// tools. No Google SDK — plain fetch against the documented REST endpoints,
// matching the sibling google-drive connector.
//
// Tool surface adapted from OpenAI's Codex google-calendar plugin (MIT); the
// hosted-connector actions are reauthored here against our local-first,
// bring-your-own-client OAuth model.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";

// MUST match `connect.configTarget` in fraym.plugin.json — the connect flow
// (packages/engine/src/plugin-oauth.ts) writes the credential there; this is
// the ONLY other place that path is spelled out (JSON manifest can't share a
// TS constant with this file).
const CONFIG_TARGET = join(homedir(), ".config", "dimension-google-calendar", "token.json");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
// Refresh this many ms before actual expiry so a slow request never races a
// token that goes stale mid-flight.
const REFRESH_SKEW_MS = 60_000;
// Event descriptions can be arbitrarily long; cap what we surface to the agent.
const MAX_DESCRIPTION_CHARS = 4_000;

const storedCredential = type({
	"provider?": "string",
	access: "string",
	refresh: "string",
	expires: "number",
	clientId: "string",
	"clientSecret?": "string",
});
type StoredCredential = typeof storedCredential.infer;

async function readCredential(): Promise<StoredCredential> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_TARGET, "utf-8");
	} catch {
		throw new Error(
			"Google Calendar isn't connected yet. Open the plugin's Connect dialog (Plugins → Google Calendar) and sign in.",
		);
	}
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors) {
		throw new Error(`Google Calendar's stored credential at ${CONFIG_TARGET} is malformed. Reconnect the plugin.`);
	}
	return parsed;
}

/** Refresh the access token via the standard `refresh_token` grant if it's
 *  expired (or about to be), persisting the renewed credential. Google may not
 *  re-issue a refresh token on every call — the old one is kept when absent. */
async function refreshAccessToken(cred: StoredCredential): Promise<StoredCredential> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: cred.refresh,
		client_id: cred.clientId,
	});
	if (cred.clientSecret) body.set("client_secret", cred.clientSecret);
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: body.toString(),
	});
	const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!res.ok || !payload || typeof payload.access_token !== "string") {
		const detail =
			payload && typeof payload.error_description === "string" ? payload.error_description : res.statusText;
		throw new Error(`Google Calendar token refresh failed: ${detail}. Reconnect the plugin.`);
	}
	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
	const refreshed: StoredCredential = {
		...cred,
		access: payload.access_token,
		refresh: typeof payload.refresh_token === "string" ? payload.refresh_token : cred.refresh,
		expires: Date.now() + expiresIn * 1000,
	};
	await writeFile(CONFIG_TARGET, JSON.stringify(refreshed, null, 2));
	return refreshed;
}

/** A valid bearer token, refreshing first if the stored one is expired/near-expiry. */
async function freshAccessToken(): Promise<string> {
	const cred = await readCredential();
	if (Date.now() < cred.expires - REFRESH_SKEW_MS) return cred.access;
	return (await refreshAccessToken(cred)).access;
}

async function calendarFetch(path: string, accessToken: string, init?: RequestInit): Promise<Response> {
	const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
	if (init?.body) headers["Content-Type"] = "application/json";
	const res = await fetch(`${CALENDAR_API}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
	if (res.status === 401) {
		throw new Error("Google Calendar rejected the access token (401). Reconnect the plugin.");
	}
	return res;
}

async function calendarJson<T>(path: string, accessToken: string, op: string, init?: RequestInit): Promise<T> {
	const res = await calendarFetch(path, accessToken, init);
	const payload = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
	if (!res.ok || !payload) {
		// Surface Google's own error.message verbatim — it names the exact cause
		// (disabled API, bad calendar id, invalid time range, …).
		throw new Error(`Calendar ${op} failed: ${payload?.error?.message ?? res.statusText}`);
	}
	return payload;
}

interface EventDateTime {
	readonly date?: string;
	readonly dateTime?: string;
	readonly timeZone?: string;
}

interface EventAttendee {
	readonly email?: string;
	readonly displayName?: string;
	readonly responseStatus?: string;
	readonly organizer?: boolean;
	readonly optional?: boolean;
}

interface ConferenceEntryPoint {
	readonly entryPointType?: string;
	readonly uri?: string;
	readonly label?: string;
}

interface CalendarEvent {
	readonly id: string;
	readonly summary?: string;
	readonly description?: string;
	readonly location?: string;
	readonly htmlLink?: string;
	readonly status?: string;
	readonly start?: EventDateTime;
	readonly end?: EventDateTime;
	readonly attendees?: readonly EventAttendee[];
	readonly recurrence?: readonly string[];
	readonly recurringEventId?: string;
	readonly hangoutLink?: string;
	readonly conferenceData?: { readonly entryPoints?: readonly ConferenceEntryPoint[] };
	readonly reminders?: {
		readonly useDefault?: boolean;
		readonly overrides?: readonly { method?: string; minutes?: number }[];
	};
}

interface CalendarListEntry {
	readonly id: string;
	readonly summary?: string;
	readonly primary?: boolean;
	readonly timeZone?: string;
}

interface FreeBusyCalendar {
	readonly busy?: readonly { start: string; end: string }[];
	readonly errors?: readonly { reason?: string }[];
}

/** A one-line human window for an event: "start – end" for timed events, or
 *  the date plus an all-day marker when the event has no clock time. */
function formatWhen(ev: CalendarEvent): string {
	if (ev.start?.dateTime) return `${ev.start.dateTime} – ${ev.end?.dateTime ?? "?"}`;
	if (ev.start?.date) return `${ev.start.date} (all-day)`;
	return "(no start time)";
}

// Event notes go to every attendee; the approval card shows the first 4000
// characters and says how much more follows.
const APPROVAL_BODY_CAP = 4000;

/** Event notes as an approval card shows them, capped at APPROVAL_BODY_CAP. */
function approvalDescription(description: string): string {
	return `Description:\n${description.length > APPROVAL_BODY_CAP ? `${description.slice(0, APPROVAL_BODY_CAP)}[…${description.length - APPROVAL_BODY_CAP} more chars]` : description}`;
}

/** One argument off unvalidated tool args, for an approval card or approval
 *  decision. Never throws: both run before the schema checks the call. */
function approvalArg(args: unknown, key: string): unknown {
	return typeof args === "object" && args !== null ? Reflect.get(args, key) : undefined;
}

const listCalendarsSchema = type({});

const listEventsSchema = type({
	"calendarId?": type("string").describe('Calendar id (from google_calendar_list_calendars). Defaults to "primary".'),
	"timeMin?": type("string").describe(
		"ISO 8601 lower bound, inclusive, e.g. 2026-07-02T00:00:00-07:00. Strongly prefer a bounded window.",
	),
	"timeMax?": type("string").describe("ISO 8601 upper bound, exclusive. Pair with timeMin to bound the search."),
	"query?": type("string").describe("Free-text search across event summary, description, location, and attendees."),
	"limit?": type("number").describe("Max events, default 25, capped at 250."),
});

const getEventSchema = type({
	"calendarId?": type("string").describe('Calendar id. Defaults to "primary".'),
	eventId: type("string").describe("Event id (from google_calendar_list_events)."),
});

const findFreeSlotsSchema = type({
	timeMin: type("string").describe("ISO 8601 start of the window to check (inclusive)."),
	timeMax: type("string").describe("ISO 8601 end of the window to check (exclusive)."),
	"calendarIds?": type("string[]").describe('Calendar ids or attendee emails to check. Defaults to ["primary"].'),
});

const createEventSchema = type({
	"calendarId?": type("string").describe('Calendar id to create on. Defaults to "primary".'),
	summary: type("string").describe("Event title."),
	startIso: type("string").describe(
		"Start — full ISO 8601 dateTime with offset for timed events, or a YYYY-MM-DD date when allDay is true.",
	),
	endIso: type("string").describe(
		"End — ISO 8601 dateTime for timed events, or the exclusive end date (YYYY-MM-DD) when allDay is true.",
	),
	"allDay?": type("boolean").describe(
		"When true, treat startIso/endIso as calendar dates (date) rather than clock times (dateTime).",
	),
	"description?": type("string").describe("Event notes / description."),
	"location?": type("string").describe("Event location."),
	"attendeeEmails?": type("string[]").describe("Attendee email addresses to invite."),
});

const updateEventSchema = type({
	"calendarId?": type("string").describe('Calendar id. Defaults to "primary".'),
	eventId: type("string").describe(
		"Event id to patch. For a recurring series this edits THAT occurrence; use the master id (recurringEventId) for a series-level change.",
	),
	"summary?": type("string").describe("New title."),
	"startIso?": type("string").describe("New start as ISO 8601 dateTime with offset."),
	"endIso?": type("string").describe("New end as ISO 8601 dateTime with offset."),
	"description?": type("string").describe("New description."),
	"location?": type("string").describe("New location."),
});

const deleteEventSchema = type({
	"calendarId?": type("string").describe('Calendar id. Defaults to "primary".'),
	eventId: type("string").describe("Event id to permanently delete."),
});

function createListCalendarsTool(): ToolDefinition<typeof listCalendarsSchema> {
	return {
		name: "google_calendar_list_calendars",
		label: "Google Calendar: List Calendars",
		description:
			'List the calendars in the connected Google account — id, name, primary flag, and time zone. Use a calendar id with the other tools (the default everywhere is "primary").',
		parameters: listCalendarsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, _params: typeof listCalendarsSchema.infer) {
			const accessToken = await freshAccessToken();
			const payload = await calendarJson<{ items?: CalendarListEntry[] }>(
				"/users/me/calendarList?maxResults=250",
				accessToken,
				"calendarList.list",
			);
			const items = payload.items ?? [];
			const text =
				items.length === 0
					? "No calendars found."
					: items
							.map(
								cal =>
									`${cal.id}  ${cal.summary ?? "(untitled)"}${cal.primary ? "  [primary]" : ""}${cal.timeZone ? `  ${cal.timeZone}` : ""}`,
							)
							.join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createListEventsTool(): ToolDefinition<typeof listEventsSchema> {
	return {
		name: "google_calendar_list_events",
		label: "Google Calendar: List Events",
		description:
			"List or search events on a calendar within a time window. Always prefer a bounded [timeMin, timeMax) window in the user's timezone — unbounded pulls are slow and noisy; page or chunk instead of widening blindly. Returns start–end, summary, id, location, and attendee count; pass an id to google_calendar_get_event for full detail.",
		parameters: listEventsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listEventsSchema.infer) {
			const accessToken = await freshAccessToken();
			const calendarId = params.calendarId ?? "primary";
			const limit = Math.min(Math.max(params.limit ?? 25, 1), 250);
			const search = new URLSearchParams({
				singleEvents: "true",
				orderBy: "startTime",
				maxResults: String(limit),
			});
			if (params.timeMin) search.set("timeMin", params.timeMin);
			if (params.timeMax) search.set("timeMax", params.timeMax);
			if (params.query) search.set("q", params.query);
			const payload = await calendarJson<{ items?: CalendarEvent[] }>(
				`/calendars/${encodeURIComponent(calendarId)}/events?${search.toString()}`,
				accessToken,
				"events.list",
			);
			const items = payload.items ?? [];
			const text =
				items.length === 0
					? "No events in that window."
					: items
							.map(ev => {
								const parts = [`${formatWhen(ev)}  ${ev.summary ?? "(no title)"}  [${ev.id}]`];
								if (ev.location) parts.push(`@ ${ev.location}`);
								if (ev.attendees?.length) parts.push(`(${ev.attendees.length} attendees)`);
								return parts.join("  ");
							})
							.join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createGetEventTool(): ToolDefinition<typeof getEventSchema> {
	return {
		name: "google_calendar_get_event",
		label: "Google Calendar: Get Event",
		description:
			"Read one event's full detail — attendees with RSVP status, description, recurrence rule, conferencing link, and reminders. Use this (not the list summary) when attendee emails or notes matter.",
		parameters: getEventSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof getEventSchema.infer) {
			const accessToken = await freshAccessToken();
			const calendarId = params.calendarId ?? "primary";
			const ev = await calendarJson<CalendarEvent>(
				`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}`,
				accessToken,
				"events.get",
			);
			const lines: string[] = [`${ev.summary ?? "(no title)"}  [${ev.id}]`];
			lines.push(`When: ${formatWhen(ev)}${ev.start?.timeZone ? ` (${ev.start.timeZone})` : ""}`);
			if (ev.location) lines.push(`Location: ${ev.location}`);
			if (ev.status) lines.push(`Status: ${ev.status}`);
			const conferencing =
				ev.hangoutLink ?? ev.conferenceData?.entryPoints?.find(p => p.entryPointType === "video")?.uri;
			if (conferencing) lines.push(`Conferencing: ${conferencing}`);
			if (ev.htmlLink) lines.push(`Link: ${ev.htmlLink}`);
			if (ev.recurrence?.length) lines.push(`Recurrence: ${ev.recurrence.join("; ")}`);
			if (ev.recurringEventId) lines.push(`Part of a series (master event id: ${ev.recurringEventId})`);
			if (ev.reminders) {
				const overrides = ev.reminders.overrides?.map(o => `${o.method ?? "?"}@${o.minutes ?? "?"}m`).join(", ");
				lines.push(`Reminders: ${ev.reminders.useDefault ? "default" : (overrides ?? "none")}`);
			}
			if (ev.attendees?.length) {
				lines.push(`Attendees (${ev.attendees.length}):`);
				for (const a of ev.attendees) {
					const flags = `${a.organizer ? " [organizer]" : ""}${a.optional ? " [optional]" : ""}`;
					lines.push(`  - ${a.email ?? a.displayName ?? "?"}${flags} — ${a.responseStatus ?? "needsAction"}`);
				}
			}
			if (ev.description) {
				const desc =
					ev.description.length > MAX_DESCRIPTION_CHARS
						? `${ev.description.slice(0, MAX_DESCRIPTION_CHARS)}\n[...truncated]`
						: ev.description;
				lines.push(`\nDescription:\n${desc}`);
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function createFindFreeSlotsTool(): ToolDefinition<typeof findFreeSlotsSchema> {
	return {
		name: "google_calendar_find_free_slots",
		label: "Google Calendar: Find Free Slots",
		description:
			"Query busy blocks across one or more calendars (or attendee emails) in a window via the freeBusy API. Returns each calendar's busy intervals so you can compute the open gaps — always pass a bounded [timeMin, timeMax) window.",
		parameters: findFreeSlotsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof findFreeSlotsSchema.infer) {
			const accessToken = await freshAccessToken();
			const ids = params.calendarIds?.length ? params.calendarIds : ["primary"];
			const payload = await calendarJson<{ calendars?: Record<string, FreeBusyCalendar> }>(
				"/freeBusy",
				accessToken,
				"freeBusy.query",
				{
					method: "POST",
					body: JSON.stringify({
						timeMin: params.timeMin,
						timeMax: params.timeMax,
						items: ids.map(id => ({ id })),
					}),
				},
			);
			const calendars = payload.calendars ?? {};
			const lines: string[] = [`Busy blocks ${params.timeMin} → ${params.timeMax}:`];
			for (const id of ids) {
				const cal = calendars[id];
				if (cal?.errors?.length) {
					lines.push(`${id}: error — ${cal.errors.map(e => e.reason ?? "unknown").join(", ")}`);
				} else if (!cal?.busy?.length) {
					lines.push(`${id}: (free — no busy blocks in window)`);
				} else {
					lines.push(`${id}:`);
					for (const b of cal.busy) lines.push(`  busy ${b.start} – ${b.end}`);
				}
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function createCreateEventTool(): ToolDefinition<typeof createEventSchema> {
	return {
		name: "google_calendar_create_event",
		label: "Google Calendar: Create Event",
		description:
			"Create an event on a calendar. Timed events take ISO 8601 dateTimes with a timezone offset; set allDay to treat startIso/endIso as calendar dates instead. Returns the new event id and htmlLink.",
		parameters: createEventSchema,
		approval: "write",
		formatApprovalDetails(args: unknown) {
			const text = (key: string) => {
				const value = approvalArg(args, key);
				return typeof value === "string" ? value : undefined;
			};
			const attendees = approvalArg(args, "attendeeEmails");
			const description = text("description");
			const lines = [
				`Calendar: ${text("calendarId") ?? "primary"}`,
				`Summary: ${text("summary") ?? "(missing)"}`,
				`When: ${text("startIso") ?? "(missing)"} – ${text("endIso") ?? "(missing)"}${approvalArg(args, "allDay") === true ? " (all-day)" : ""}`,
				`Invites: ${
					attendees === undefined || (Array.isArray(attendees) && attendees.length === 0)
						? "none"
						: Array.isArray(attendees)
							? attendees.map(String).join(", ")
							: "(malformed attendeeEmails)"
				}`,
			];
			const location = text("location");
			if (location) lines.push(`Location: ${location}`);
			if (description) lines.push(approvalDescription(description));
			return lines;
		},
		async execute(_toolCallId: string, params: typeof createEventSchema.infer) {
			const accessToken = await freshAccessToken();
			const calendarId = params.calendarId ?? "primary";
			const start: EventDateTime = params.allDay ? { date: params.startIso } : { dateTime: params.startIso };
			const end: EventDateTime = params.allDay ? { date: params.endIso } : { dateTime: params.endIso };
			const body: Record<string, unknown> = { summary: params.summary, start, end };
			if (params.description) body.description = params.description;
			if (params.location) body.location = params.location;
			if (params.attendeeEmails?.length) body.attendees = params.attendeeEmails.map(email => ({ email }));
			const created = await calendarJson<CalendarEvent>(
				`/calendars/${encodeURIComponent(calendarId)}/events`,
				accessToken,
				"events.insert",
				{ method: "POST", body: JSON.stringify(body) },
			);
			const text = `Created "${created.summary ?? params.summary}" (${formatWhen(created)})  [${created.id}]${created.htmlLink ? `\n${created.htmlLink}` : ""}`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createUpdateEventTool(): ToolDefinition<typeof updateEventSchema> {
	return {
		name: "google_calendar_update_event",
		label: "Google Calendar: Update Event",
		description:
			"Patch an existing event — only the fields you pass change; everything else is preserved. Note: for a recurring series, PATCHing the event id edits THAT occurrence; series-level edits need the master event id (recurringEventId, from google_calendar_get_event).",
		parameters: updateEventSchema,
		approval: "write",
		formatApprovalDetails(args: unknown) {
			const text = (key: string) => {
				const value = approvalArg(args, key);
				return typeof value === "string" ? value : undefined;
			};
			// The same fields, under the same conditions, that execute patches.
			const summary = text("summary");
			const startIso = text("startIso");
			const endIso = text("endIso");
			const description = text("description");
			const location = text("location");
			const lines = [`Calendar: ${text("calendarId") ?? "primary"}`, `Update event: ${text("eventId") ?? "(missing)"}`];
			if (summary !== undefined) lines.push(`Summary: ${summary}`);
			if (startIso) lines.push(`Start: ${startIso}`);
			if (endIso) lines.push(`End: ${endIso}`);
			if (location !== undefined) lines.push(`Location: ${location}`);
			if (description !== undefined) lines.push(approvalDescription(description));
			return lines;
		},
		async execute(_toolCallId: string, params: typeof updateEventSchema.infer) {
			const accessToken = await freshAccessToken();
			const calendarId = params.calendarId ?? "primary";
			const body: Record<string, unknown> = {};
			if (params.summary !== undefined) body.summary = params.summary;
			if (params.startIso) body.start = { dateTime: params.startIso };
			if (params.endIso) body.end = { dateTime: params.endIso };
			if (params.description !== undefined) body.description = params.description;
			if (params.location !== undefined) body.location = params.location;
			if (Object.keys(body).length === 0) {
				throw new Error(
					"No fields to update — pass at least one of summary, startIso, endIso, description, or location.",
				);
			}
			const updated = await calendarJson<CalendarEvent>(
				`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}`,
				accessToken,
				"events.patch",
				{ method: "PATCH", body: JSON.stringify(body) },
			);
			const text = `Updated "${updated.summary ?? "(no title)"}" (${formatWhen(updated)})  [${updated.id}]${updated.htmlLink ? `\n${updated.htmlLink}` : ""}`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createDeleteEventTool(): ToolDefinition<typeof deleteEventSchema> {
	return {
		name: "google_calendar_delete_event",
		label: "Google Calendar: Delete Event",
		description:
			"Permanently delete an event from a calendar. DESTRUCTIVE and irreversible — read the event first (google_calendar_get_event) so the id is the exact event meant. Do not guess the event id.",
		parameters: deleteEventSchema,
		approval: "write",
		formatApprovalDetails(args: unknown) {
			const calendarId = approvalArg(args, "calendarId");
			const eventId = approvalArg(args, "eventId");
			return [
				`Calendar: ${typeof calendarId === "string" ? calendarId : "primary"}`,
				`Delete event: ${typeof eventId === "string" ? eventId : "(missing)"}`,
			];
		},
		async execute(_toolCallId: string, params: typeof deleteEventSchema.infer) {
			const accessToken = await freshAccessToken();
			const calendarId = params.calendarId ?? "primary";
			// Read the event first so the result echoes exactly what was removed.
			const ev = await calendarJson<CalendarEvent>(
				`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}`,
				accessToken,
				"events.get",
			);
			const res = await calendarFetch(
				`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}`,
				accessToken,
				{ method: "DELETE" },
			);
			if (res.status === 410) {
				return {
					content: [
						{ type: "text" as const, text: `Event "${ev.summary ?? params.eventId}" was already deleted.` },
					],
				};
			}
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
				throw new Error(`Calendar events.delete failed: ${payload?.error?.message ?? res.statusText}`);
			}
			const text = `Deleted "${ev.summary ?? "(no title)"}" (${formatWhen(ev)}) from ${calendarId}.`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

/**
 * Google Calendar plugin. A standard OMP plugin — `skills/`/`rules/` load via
 * OMP's native plugin discovery. This module registers the seven read/write
 * tools; the connect flow (fraym.plugin.json's `connect.oauth`) is what obtains
 * and refreshes the credential these tools read.
 */
export default function googleCalendarExtension(pi: ExtensionAPI): void {
	pi.registerTool(createListCalendarsTool());
	pi.registerTool(createListEventsTool());
	pi.registerTool(createGetEventTool());
	pi.registerTool(createFindFreeSlotsTool());
	pi.registerTool(createCreateEventTool());
	pi.registerTool(createUpdateEventTool());
	pi.registerTool(createDeleteEventTool());
}
