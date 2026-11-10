// Google Meet REST connector (rest.ts) — the cross-platform, after-the-fact half
// of the plugin: create/end Meet spaces and read conference records, participants,
// recordings, and transcripts over the Meet REST API v2. Authenticated via the
// plugin's `oauth` connect flow (see fraym.plugin.json), which writes
// {access,refresh,expires,clientId,clientSecret?} to CONFIG_TARGET; these tools'
// only job is to keep that access token fresh and expose it as agent tools.
//
// No Google SDK — plain fetch against the documented REST endpoints, mirroring the
// sibling google-calendar connector's credential/refresh machinery verbatim in
// spirit. Live-join / audio / "be a voice in the call" is deliberately NOT here —
// that is bot.ts's browser transcriber plus a documented future capability.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";

// MUST match `connect.configTarget` in fraym.plugin.json — the connect flow
// (packages/engine/src/plugin-oauth.ts) writes the credential there; this is the
// ONLY other place that path is spelled out (a JSON manifest can't share a TS
// constant with this file).
const CONFIG_TARGET = join(homedir(), ".config", "dimension-google-meet", "token.json");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MEET_API = "https://meet.googleapis.com/v2";
// Refresh this many ms before actual expiry so a slow request never races a token
// that goes stale mid-flight.
const REFRESH_SKEW_MS = 60_000;

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
			"Google Meet isn't connected yet. Open the plugin's Connect dialog (Plugins → Google Meet) and sign in.",
		);
	}
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors) {
		throw new Error(`Google Meet's stored credential at ${CONFIG_TARGET} is malformed. Reconnect the plugin.`);
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
		throw new Error(`Google Meet token refresh failed: ${detail}. Reconnect the plugin.`);
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

async function meetFetch(path: string, accessToken: string, init?: RequestInit): Promise<Response> {
	const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
	if (init?.body) headers["Content-Type"] = "application/json";
	const res = await fetch(`${MEET_API}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
	if (res.status === 401) {
		throw new Error("Google Meet rejected the access token (401). Reconnect the plugin (Plugins → Google Meet).");
	}
	return res;
}

async function meetJson<T>(path: string, accessToken: string, op: string, init?: RequestInit): Promise<T> {
	const res = await meetFetch(path, accessToken, init);
	const payload = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
	if (!res.ok || !payload) {
		// Surface Google's own error.message verbatim — it names the exact cause
		// (disabled Meet API, bad resource id, workspace-account restriction, …).
		throw new Error(`Meet ${op} failed: ${payload?.error?.message ?? res.statusText}`);
	}
	return payload;
}

// ---- Resource-name normalizers -------------------------------------------------
// Meet resource names embed slashes that are meaningful path segments (never
// percent-encoded); ids/meeting-codes are safe chars ([a-z0-9-]), so we splice
// them into the path directly.

/** A space resource name: a raw meeting code (`abc-mnop-xyz`) becomes
 *  `spaces/abc-mnop-xyz`; an already-qualified `spaces/{id}` passes through. */
function spaceName(value: string): string {
	const v = value.trim();
	return v.includes("/") ? v : `spaces/${v}`;
}

/** A conference-record resource name: a bare id becomes `conferenceRecords/{id}`;
 *  an already-qualified `conferenceRecords/{id}` passes through. */
function conferenceRecordName(value: string): string {
	const v = value.trim();
	return v.includes("/") ? v : `conferenceRecords/${v}`;
}

/** Meet paginates at 25 by default, capped at 100. */
function clampLimit(limit: number | undefined): number {
	return Math.min(Math.max(limit ?? 25, 1), 100);
}

const MORE_AVAILABLE = "\n(more available — narrow with a filter or request the next page)";

// ---- Field shapes (authoritative — see the spec; do not invent fields) ---------

interface Space {
	readonly name: string;
	readonly meetingUri?: string;
	readonly meetingCode?: string;
	readonly config?: { readonly accessType?: string };
	readonly activeConference?: { readonly conferenceRecord?: string };
	readonly phoneAccess?: readonly PhoneAccess[];
}

interface PhoneAccess {
	readonly phoneNumber?: string;
	readonly pin?: string;
	readonly regionCode?: string;
	readonly languageCode?: string;
}

interface ConferenceRecord {
	readonly name: string;
	readonly startTime?: string;
	readonly endTime?: string;
	readonly expireTime?: string;
	readonly space?: string;
}

interface Participant {
	readonly name: string;
	readonly signedinUser?: { readonly user?: string; readonly displayName?: string };
	readonly anonymousUser?: { readonly displayName?: string };
	readonly phoneUser?: { readonly displayName?: string };
	readonly earliestStartTime?: string;
	readonly latestEndTime?: string;
}

interface Recording {
	readonly name: string;
	readonly driveDestination?: { readonly file?: string; readonly exportUri?: string };
	readonly state?: string;
	readonly startTime?: string;
	readonly endTime?: string;
}

interface Transcript {
	readonly name: string;
	readonly docsDestination?: { readonly document?: string; readonly exportUri?: string };
	readonly state?: string;
	readonly startTime?: string;
	readonly endTime?: string;
}

interface TranscriptEntry {
	readonly name: string;
	readonly participant?: string;
	readonly text?: string;
	readonly languageCode?: string;
	readonly startTime?: string;
	readonly endTime?: string;
}

/** Flatten a participant's user union to a display name + a type tag + the
 *  signed-in `user` id when present (the only stable people identifier Meet
 *  hands back). */
function describeParticipant(p: Participant): string {
	let display: string | undefined;
	let tag: string;
	let userId: string | undefined;
	if (p.signedinUser) {
		display = p.signedinUser.displayName;
		tag = "signed-in";
		userId = p.signedinUser.user;
	} else if (p.anonymousUser) {
		display = p.anonymousUser.displayName;
		tag = "anonymous";
	} else if (p.phoneUser) {
		display = p.phoneUser.displayName;
		tag = "phone";
	} else {
		tag = "unknown";
	}
	const span =
		p.earliestStartTime || p.latestEndTime ? `  ${p.earliestStartTime ?? "?"}–${p.latestEndTime ?? "?"}` : "";
	return `${p.name}  ${display ?? "(no display name)"}  [${tag}]${userId ? `  user=${userId}` : ""}${span}`;
}

/** One line for a recording/transcript artifact: `name  state  start–end`, plus a
 *  trailing export URI (the Drive MP4 / Docs link) once the file is generated. */
function formatArtifact(
	a: { readonly name: string; readonly state?: string; readonly startTime?: string; readonly endTime?: string },
	exportUri: string | undefined,
): string {
	const line = `${a.name}  ${a.state ?? "STATE_UNSPECIFIED"}  ${a.startTime ?? "?"}–${a.endTime ?? "?"}`;
	return exportUri ? `${line}  ${exportUri}` : line;
}

// ---- Schemas -------------------------------------------------------------------

const createSpaceSchema = type({
	"accessType?": type("'OPEN' | 'TRUSTED' | 'RESTRICTED'").describe(
		"Who can join without knocking. OPEN = anyone with the link; TRUSTED = same-org / invited; RESTRICTED = invited only. Omit to use the account default.",
	),
});

const getSpaceSchema = type({
	space: type("string").describe(
		"A space resource name (`spaces/{id}`) OR a raw meeting code (`abc-mnop-xyz`) — a bare code is looked up as `spaces/{code}`.",
	),
});

const endActiveConferenceSchema = type({
	space: type("string").describe(
		"The space whose live conference to end — `spaces/{id}` or a raw meeting code. Everyone is kicked from the call.",
	),
});

const listConferenceRecordsSchema = type({
	"filter?": type("string").describe(
		'Meet EBNF filter, e.g. `space.meeting_code="abc-mnop-xyz"` or `start_time>="2024-01-01T00:00:00Z"`. Omit for the account\'s most recent records.',
	),
	"limit?": type("number").describe("Max records, default 25, capped at 100."),
});

const getConferenceRecordSchema = type({
	conferenceRecord: type("string").describe(
		"A conference-record resource name (`conferenceRecords/{id}`) or a bare id (from google_meet_list_conference_records).",
	),
});

const listParticipantsSchema = type({
	conferenceRecord: type("string").describe(
		"Conference record (`conferenceRecords/{id}` or bare id) whose participants to list.",
	),
	"limit?": type("number").describe("Max participants, default 25, capped at 100."),
});

const listRecordingsSchema = type({
	conferenceRecord: type("string").describe(
		"Conference record (`conferenceRecords/{id}` or bare id) whose recordings to list.",
	),
});

const listTranscriptsSchema = type({
	conferenceRecord: type("string").describe(
		"Conference record (`conferenceRecords/{id}` or bare id) whose transcripts to list.",
	),
});

const listTranscriptEntriesSchema = type({
	transcript: type("string").describe(
		"A FULL transcript resource name — `conferenceRecords/{c}/transcripts/{t}` (copy the `name` from google_meet_list_transcripts).",
	),
	"limit?": type("number").describe("Max entries, default 25, capped at 100."),
});

// ---- Tools ---------------------------------------------------------------------

function createCreateSpaceTool(): ToolDefinition<typeof createSpaceSchema> {
	return {
		name: "google_meet_create_space",
		label: "Google Meet: Create Space",
		description:
			"Create a Google Meet space (a reusable meeting room) and return its join URL, meeting code, and resource name. Optionally set accessType (OPEN/TRUSTED/RESTRICTED). This makes a room; it does NOT put anyone in the call.",
		parameters: createSpaceSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof createSpaceSchema.infer) {
			const accessToken = await freshAccessToken();
			const body: Record<string, unknown> = {};
			if (params.accessType) body.config = { accessType: params.accessType };
			const space = await meetJson<Space>("/spaces", accessToken, "spaces.create", {
				method: "POST",
				body: JSON.stringify(body),
			});
			const lines = [`Created Meet space  [${space.name}]`];
			if (space.meetingUri) lines.push(`URL: ${space.meetingUri}`);
			if (space.meetingCode) lines.push(`Code: ${space.meetingCode}`);
			if (space.config?.accessType) lines.push(`Access: ${space.config.accessType}`);
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function createGetSpaceTool(): ToolDefinition<typeof getSpaceSchema> {
	return {
		name: "google_meet_get_space",
		label: "Google Meet: Get Space",
		description:
			"Look up a Meet space by resource name or raw meeting code — returns its join URL, access type, whether a conference is currently active (with its conferenceRecord id), and phone dial-in details.",
		parameters: getSpaceSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof getSpaceSchema.infer) {
			const accessToken = await freshAccessToken();
			const name = spaceName(params.space);
			const space = await meetJson<Space>(`/${name}`, accessToken, "spaces.get");
			const lines = [space.name];
			if (space.meetingUri) lines.push(`URL: ${space.meetingUri}`);
			if (space.meetingCode) lines.push(`Code: ${space.meetingCode}`);
			lines.push(`Access: ${space.config?.accessType ?? "(default)"}`);
			lines.push(
				space.activeConference?.conferenceRecord
					? `Active conference: yes — ${space.activeConference.conferenceRecord}`
					: "Active conference: no",
			);
			if (space.phoneAccess?.length) {
				lines.push("Phone access:");
				for (const p of space.phoneAccess) {
					lines.push(`  ${p.phoneNumber ?? "?"}  pin ${p.pin ?? "?"}  (${p.regionCode ?? "?"})`);
				}
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function createEndActiveConferenceTool(): ToolDefinition<typeof endActiveConferenceSchema> {
	return {
		name: "google_meet_end_active_conference",
		label: "Google Meet: End Active Conference",
		description:
			"End the conference currently in progress in a space, removing everyone from the call. DESTRUCTIVE and disruptive. No-ops with an error if no conference is active.",
		parameters: endActiveConferenceSchema,
		approval: "write",
		formatApprovalDetails(args: unknown) {
			const space: unknown = typeof args === "object" && args !== null ? Reflect.get(args, "space") : undefined;
			return [
				`End the live call in: ${typeof space === "string" ? spaceName(space) : "(missing)"}`,
				"Everyone in the call is removed.",
			];
		},
		async execute(_toolCallId: string, params: typeof endActiveConferenceSchema.infer) {
			const accessToken = await freshAccessToken();
			const name = spaceName(params.space);
			const res = await meetFetch(`/${name}:endActiveConference`, accessToken, {
				method: "POST",
				body: "{}",
			});
			if (!res.ok) {
				const payload = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
				throw new Error(`Meet spaces.endActiveConference failed: ${payload?.error?.message ?? res.statusText}`);
			}
			return { content: [{ type: "text" as const, text: `Ended the active conference in ${name}.` }] };
		},
	};
}

function createListConferenceRecordsTool(): ToolDefinition<typeof listConferenceRecordsSchema> {
	return {
		name: "google_meet_list_conference_records",
		label: "Google Meet: List Conference Records",
		description:
			"List past conference records (one per time a space was used for a call) — resource name, start/end, and the parent space. Optionally filter by an EBNF expression (meeting code, time range). Use a record's id with the participants / recordings / transcripts tools.",
		parameters: listConferenceRecordsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listConferenceRecordsSchema.infer) {
			const accessToken = await freshAccessToken();
			const limit = clampLimit(params.limit);
			const search = new URLSearchParams({ pageSize: String(limit) });
			if (params.filter) search.set("filter", params.filter);
			const payload = await meetJson<{ conferenceRecords?: ConferenceRecord[]; nextPageToken?: string }>(
				`/conferenceRecords?${search.toString()}`,
				accessToken,
				"conferenceRecords.list",
			);
			const items = payload.conferenceRecords ?? [];
			if (items.length === 0) return { content: [{ type: "text" as const, text: "No conference records found." }] };
			const text = items
				.map(cr => `${cr.name}  ${cr.startTime ?? "?"} – ${cr.endTime ?? "ongoing"}  space=${cr.space ?? "?"}`)
				.join("\n");
			return {
				content: [{ type: "text" as const, text: payload.nextPageToken ? text + MORE_AVAILABLE : text }],
			};
		},
	};
}

function createGetConferenceRecordTool(): ToolDefinition<typeof getConferenceRecordSchema> {
	return {
		name: "google_meet_get_conference_record",
		label: "Google Meet: Get Conference Record",
		description: "Read one conference record's detail — start/end time, expiry, and the parent space resource name.",
		parameters: getConferenceRecordSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof getConferenceRecordSchema.infer) {
			const accessToken = await freshAccessToken();
			const name = conferenceRecordName(params.conferenceRecord);
			const cr = await meetJson<ConferenceRecord>(`/${name}`, accessToken, "conferenceRecords.get");
			const lines = [cr.name];
			lines.push(`When: ${cr.startTime ?? "?"} – ${cr.endTime ?? "ongoing"}`);
			if (cr.space) lines.push(`Space: ${cr.space}`);
			if (cr.expireTime) lines.push(`Expires: ${cr.expireTime}`);
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function createListParticipantsTool(): ToolDefinition<typeof listParticipantsSchema> {
	return {
		name: "google_meet_list_participants",
		label: "Google Meet: List Participants",
		description:
			"List who was in a past conference — participant resource name, display name, a type tag (signed-in / anonymous / phone), the signed-in Google user id when present, and their join/leave window. Use this to map transcript participant names to people.",
		parameters: listParticipantsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listParticipantsSchema.infer) {
			const accessToken = await freshAccessToken();
			const name = conferenceRecordName(params.conferenceRecord);
			const limit = clampLimit(params.limit);
			const payload = await meetJson<{ participants?: Participant[]; nextPageToken?: string }>(
				`/${name}/participants?pageSize=${limit}`,
				accessToken,
				"conferenceRecords.participants.list",
			);
			const items = payload.participants ?? [];
			if (items.length === 0)
				return { content: [{ type: "text" as const, text: "No participants in that conference record." }] };
			const text = items.map(describeParticipant).join("\n");
			return {
				content: [{ type: "text" as const, text: payload.nextPageToken ? text + MORE_AVAILABLE : text }],
			};
		},
	};
}

function createListRecordingsTool(): ToolDefinition<typeof listRecordingsSchema> {
	return {
		name: "google_meet_list_recordings",
		label: "Google Meet: List Recordings",
		description:
			"List a past conference's recordings — resource name, state (STARTED/ENDED/FILE_GENERATED), the recording window, and the Drive export URI (the 'open the MP4 in Drive' link) once the file is generated.",
		parameters: listRecordingsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listRecordingsSchema.infer) {
			const accessToken = await freshAccessToken();
			const name = conferenceRecordName(params.conferenceRecord);
			const payload = await meetJson<{ recordings?: Recording[]; nextPageToken?: string }>(
				`/${name}/recordings`,
				accessToken,
				"conferenceRecords.recordings.list",
			);
			const items = payload.recordings ?? [];
			if (items.length === 0)
				return { content: [{ type: "text" as const, text: "No recordings for that conference record." }] };
			const text = items.map(r => formatArtifact(r, r.driveDestination?.exportUri)).join("\n");
			return {
				content: [{ type: "text" as const, text: payload.nextPageToken ? text + MORE_AVAILABLE : text }],
			};
		},
	};
}

function createListTranscriptsTool(): ToolDefinition<typeof listTranscriptsSchema> {
	return {
		name: "google_meet_list_transcripts",
		label: "Google Meet: List Transcripts",
		description:
			"List a past conference's transcripts — resource name, state, the transcript window, and the Google Docs export URI once generated. Pass a transcript's resource name to google_meet_list_transcript_entries for the actual spoken lines.",
		parameters: listTranscriptsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listTranscriptsSchema.infer) {
			const accessToken = await freshAccessToken();
			const name = conferenceRecordName(params.conferenceRecord);
			const payload = await meetJson<{ transcripts?: Transcript[]; nextPageToken?: string }>(
				`/${name}/transcripts`,
				accessToken,
				"conferenceRecords.transcripts.list",
			);
			const items = payload.transcripts ?? [];
			if (items.length === 0)
				return { content: [{ type: "text" as const, text: "No transcripts for that conference record." }] };
			const text = items.map(t => formatArtifact(t, t.docsDestination?.exportUri)).join("\n");
			return {
				content: [{ type: "text" as const, text: payload.nextPageToken ? text + MORE_AVAILABLE : text }],
			};
		},
	};
}

function createListTranscriptEntriesTool(): ToolDefinition<typeof listTranscriptEntriesSchema> {
	return {
		name: "google_meet_list_transcript_entries",
		label: "Google Meet: List Transcript Entries",
		description:
			"Read the spoken lines of a transcript, rendered as `participant: text`. Requires the FULL transcript resource name (conferenceRecords/{c}/transcripts/{t}) from google_meet_list_transcripts. Note: each line's participant is a resource NAME, not a display name — map names→people with google_meet_list_participants.",
		parameters: listTranscriptEntriesSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listTranscriptEntriesSchema.infer) {
			const transcript = params.transcript.trim();
			if (!transcript.includes("/transcripts/")) {
				throw new Error(
					"`transcript` must be a full transcript resource name like conferenceRecords/{c}/transcripts/{t} — copy the `name` from google_meet_list_transcripts.",
				);
			}
			const accessToken = await freshAccessToken();
			const limit = clampLimit(params.limit);
			const payload = await meetJson<{ transcriptEntries?: TranscriptEntry[]; nextPageToken?: string }>(
				`/${transcript}/entries?pageSize=${limit}`,
				accessToken,
				"conferenceRecords.transcripts.entries.list",
			);
			const items = payload.transcriptEntries ?? [];
			if (items.length === 0)
				return {
					content: [
						{ type: "text" as const, text: "No transcript entries (transcript may still be processing)." },
					],
				};
			const text = items.map(e => `${e.participant ?? "(unknown participant)"}: ${e.text ?? ""}`).join("\n");
			return {
				content: [{ type: "text" as const, text: payload.nextPageToken ? text + MORE_AVAILABLE : text }],
			};
		},
	};
}

/**
 * The REST tool family: space management + post-call conference records,
 * participants, recordings, and transcripts. The orchestrator's index.ts
 * registers each of these; the connect flow (fraym.plugin.json's `connect.oauth`)
 * obtains and refreshes the credential they read.
 */
export function createMeetRestTools(): ToolDefinition<any>[] {
	return [
		createCreateSpaceTool(),
		createGetSpaceTool(),
		createEndActiveConferenceTool(),
		createListConferenceRecordsTool(),
		createGetConferenceRecordTool(),
		createListParticipantsTool(),
		createListRecordingsTool(),
		createListTranscriptsTool(),
		createListTranscriptEntriesTool(),
	];
}
