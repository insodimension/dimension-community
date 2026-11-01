// Microsoft Teams connector — list teams/channels and post channel messages
// over Microsoft Graph v1.0, authenticated app-only via the OAuth2
// client-credentials grant (see fraym.plugin.json's `connect`). The connect
// flow writes {tenantId,clientId,clientSecret} to CONFIG_TARGET; this extension
// exchanges those for a Graph access token on demand, caches it in memory, and
// exposes the Graph calls as agent tools. No Microsoft SDK — plain fetch
// against the documented REST endpoints, matching the rest of this repo's
// connectors.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";

// MUST match `connect.configTarget` in fraym.plugin.json — the connect flow
// (packages/engine/src/plugin-connect.ts) writes the credential there; this is
// the ONLY other place that path is spelled out (the JSON manifest can't share
// a TS constant with this file).
const CONFIG_TARGET = join(homedir(), ".config", "dimension-teams", "token.json");
const GRAPH_API = "https://graph.microsoft.com/v1.0";
// App-only tokens carry the app's own permissions; `.default` requests every
// application permission the app registration was admin-consented for.
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
// Re-mint the token this many ms before actual expiry so a slow request never
// races a token that goes stale mid-flight.
const TOKEN_SKEW_MS = 60_000;

const storedCredential = type({
	tenantId: "string",
	clientId: "string",
	clientSecret: "string",
});
type StoredCredential = typeof storedCredential.infer;

async function readCredential(): Promise<StoredCredential> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_TARGET, "utf-8");
	} catch {
		throw new Error(
			"Microsoft Teams isn't connected yet. Open the plugin's Connect dialog (Plugins → Microsoft Teams → Set up) and paste your Azure app's tenant/client IDs and secret.",
		);
	}
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors) {
		throw new Error(`Microsoft Teams's stored credential at ${CONFIG_TARGET} is malformed. Reconnect the plugin.`);
	}
	return parsed;
}

// In-memory access-token cache. App-only tokens are cheap to re-mint and hold
// no user context, so a single module-level slot is enough; a 401 clears it.
//
// KEYED BY CREDENTIAL, not by expiry alone. The slot is process-wide, so it
// outlives a session: a user who reconnects mid-process (a different
// tenant, a rotated secret) would otherwise keep using the OLD tenant's token
// until it expired, and a wrong-but-valid token never trips the 401 that clears
// this cache.
let tokenCache: { access: string; expires: number; credential: string } | null = null;

/** A valid Graph access token, minting a fresh one via the client-credentials
 *  grant when the cached one is absent, expired, within the skew window, or was
 *  minted from a credential the user has since replaced.
 *
 *  The credential is read on EVERY call, so disconnecting the plugin stops the
 *  tools working at once rather than at the cached token's expiry — at the cost
 *  of a credential file that is unreadable right now throwing instead of riding
 *  an unexpired token. */
async function getAccessToken(): Promise<string> {
	const cred = await readCredential();
	// The cache key is the WHOLE parsed credential, taken off the object rather
	// than a hand-listed field set: a field added to `storedCredential` joins the
	// key automatically instead of silently failing to invalidate. Keys sorted so
	// the value depends on the credential's VALUES, not on its file order.
	const fingerprint = JSON.stringify(cred, Object.keys(cred).sort());
	if (tokenCache && tokenCache.credential === fingerprint && Date.now() < tokenCache.expires - TOKEN_SKEW_MS)
		return tokenCache.access;
	const body = new URLSearchParams({
		grant_type: "client_credentials",
		client_id: cred.clientId,
		client_secret: cred.clientSecret,
		scope: GRAPH_SCOPE,
	});
	const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cred.tenantId)}/oauth2/v2.0/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: body.toString(),
	});
	const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	if (!res.ok || !payload || typeof payload.access_token !== "string") {
		const detail =
			payload && typeof payload.error_description === "string" ? payload.error_description : res.statusText;
		throw new Error(
			`Microsoft Teams token request failed: ${detail}. Verify the tenant/client IDs and secret, then reconnect the plugin (Plugins → Microsoft Teams → Reconnect).`,
		);
	}
	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
	tokenCache = { access: payload.access_token, expires: Date.now() + expiresIn * 1000, credential: fingerprint };
	return tokenCache.access;
}

async function graphFetch(path: string, init?: RequestInit): Promise<Response> {
	const accessToken = await getAccessToken();
	const res = await fetch(`${GRAPH_API}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
	});
	if (res.status === 401) {
		// Drop the cached token so the next call re-mints; a 401 usually means
		// the app lacks admin-consented permissions rather than a stale token.
		tokenCache = null;
		throw new Error(
			"Microsoft Graph rejected the access token (401). The Azure app likely lacks admin-consented permissions (Group.Read.All / Channel.ReadBasic.All / ChannelMessage.Send) — grant admin consent, then reconnect (Plugins → Microsoft Teams → Reconnect).",
		);
	}
	return res;
}

async function graphJson<T>(path: string, op: string): Promise<T> {
	const res = await graphFetch(path);
	const payload = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
	if (!res.ok || !payload) {
		throw new Error(`Microsoft Graph ${op} failed: ${payload?.error?.message ?? res.statusText}`);
	}
	return payload;
}

// POST a channel message (or reply) as `{ body: { content } }` and return Graph's
// {id, webUrl}, surfacing Graph's own error verbatim — on app-only tenants this
// is where the "migration/import only" restriction shows up.
async function graphPostMessage(path: string, content: string, op: string): Promise<{ id?: string; webUrl?: string }> {
	const res = await graphFetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ body: { content } }),
	});
	const payload = (await res.json().catch(() => null)) as {
		id?: string;
		webUrl?: string;
		error?: { message?: string };
	} | null;
	if (!res.ok || !payload) {
		throw new Error(`Microsoft Teams ${op} failed: ${payload?.error?.message ?? res.statusText}`);
	}
	return payload;
}

interface TeamGroup {
	readonly id: string;
	readonly displayName?: string;
	readonly description?: string;
}

interface Channel {
	readonly id: string;
	readonly displayName?: string;
	readonly description?: string;
}

interface ChatMessage {
	readonly id: string;
	readonly createdDateTime?: string;
	readonly from?: { user?: { displayName?: string } | null } | null;
	readonly body?: { contentType?: string; content?: string };
}

interface ConversationMember {
	readonly id: string;
	readonly displayName?: string;
	readonly roles?: readonly string[];
	readonly email?: string;
}

// Channel messages come back as HTML (contentType "html") even when a user typed
// plain text. Reduce to readable text for the agent: drop tags, decode the few
// entities Graph emits, collapse whitespace, and cap length so a long thread
// stays scannable.
function htmlToText(html: string, max = 500): string {
	const text = html
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, " ")
		.replace(/<\/(p|div|li)>/gi, " ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Posting to a shared channel reaches other people, so it demands a human
 *  click in EVERY approval mode — a bare "write" tier is auto-approved by write
 *  and yolo mode. */
const PROMPT_EVERY_MODE = { tier: "write", policy: "prompt" } as const;
// A channel message may be far longer than a card can hold; the approval card
// shows the first 4000 characters and says how much more follows.
const APPROVAL_BODY_CAP = 4000;

/** One argument off unvalidated tool args, for an approval card. Never throws:
 *  the card renders before the schema checks the call. The body is shown raw,
 *  HTML included, because that is exactly what Graph receives. */
function approvalArg(args: unknown, key: string): string {
	const value: unknown = typeof args === "object" && args !== null ? Reflect.get(args, key) : undefined;
	if (typeof value !== "string") return "(missing)";
	return value.length > APPROVAL_BODY_CAP
		? `${value.slice(0, APPROVAL_BODY_CAP)}[…${value.length - APPROVAL_BODY_CAP} more chars]`
		: value;
}

const listTeamsSchema = type({});
const listChannelsSchema = type({
	teamId: type("string").describe("The team (group) id, from teams_list_teams."),
});
const sendMessageSchema = type({
	teamId: type("string").describe("The team (group) id, from teams_list_teams."),
	channelId: type("string").describe("The channel id, from teams_list_channels."),
	content: type("string").describe(
		"Message body to post. Plain text works; Graph also accepts basic HTML (e.g. <b>, <br>, <a>).",
	),
});
const readMessagesSchema = type({
	teamId: type("string").describe("The team (group) id, from teams_list_teams."),
	channelId: type("string").describe("The channel id, from teams_list_channels."),
	"limit?": type("number").describe("How many recent messages to fetch, default 20, capped at 50 by Graph's $top."),
});
const replyMessageSchema = type({
	teamId: type("string").describe("The team (group) id, from teams_list_teams."),
	channelId: type("string").describe("The channel id, from teams_list_channels."),
	messageId: type("string").describe(
		"The id of the top-level channel message to reply under, from teams_read_channel_messages.",
	),
	content: type("string").describe(
		"Reply body to post under the message. Plain text works; Graph also accepts basic HTML (e.g. <b>, <br>, <a>).",
	),
});
const listMembersSchema = type({
	teamId: type("string").describe("The team (group) id, from teams_list_teams."),
});

function createListTeamsTool(): ToolDefinition<typeof listTeamsSchema> {
	return {
		name: "teams_list_teams",
		label: "Microsoft Teams: List Teams",
		description:
			"List the Microsoft Teams in the connected Azure AD tenant (Graph groups where a team is provisioned). Returns id/name/description per line — pass a team id to teams_list_channels.",
		parameters: listTeamsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, _params: typeof listTeamsSchema.infer) {
			const filter = encodeURIComponent("resourceProvisioningOptions/Any(x:x eq 'Team')");
			const select = encodeURIComponent("id,displayName,description");
			const payload = await graphJson<{ value?: TeamGroup[] }>(
				`/groups?$filter=${filter}&$select=${select}`,
				"groups.list",
			);
			const teams = payload.value ?? [];
			const text =
				teams.length === 0
					? "No teams found. The app may lack Group.Read.All (with admin consent), or the tenant has no teams."
					: teams
							.map(t => `${t.id}  ${t.displayName ?? "(no name)"}${t.description ? ` — ${t.description}` : ""}`)
							.join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createListChannelsTool(): ToolDefinition<typeof listChannelsSchema> {
	return {
		name: "teams_list_channels",
		label: "Microsoft Teams: List Channels",
		description:
			"List the channels of a Microsoft Team. Returns id/displayName per line — pass a channel id to teams_send_channel_message.",
		parameters: listChannelsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listChannelsSchema.infer) {
			const payload = await graphJson<{ value?: Channel[] }>(
				`/teams/${encodeURIComponent(params.teamId)}/channels`,
				"channels.list",
			);
			const channels = payload.value ?? [];
			const text =
				channels.length === 0
					? "No channels found for that team. Check the team id, or that the app has Channel.ReadBasic.All (with admin consent)."
					: channels
							.map(c => `${c.id}  ${c.displayName ?? "(no name)"}${c.description ? ` — ${c.description}` : ""}`)
							.join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createSendMessageTool(): ToolDefinition<typeof sendMessageSchema> {
	return {
		name: "teams_send_channel_message",
		label: "Microsoft Teams: Send Channel Message",
		description:
			"Post a message to a Microsoft Teams channel. DESTRUCTIVE — this publishes to a shared channel; ALWAYS confirm the exact team, channel, and message text with the user before calling. Note: sending as an application requires the ChannelMessage.Send application permission WITH admin consent, and Microsoft restricts app-only channel messages to migration/import scenarios on some tenants — if Graph refuses, its exact error is surfaced verbatim.",
		parameters: sendMessageSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			return [
				`Team: ${approvalArg(args, "teamId")}`,
				`Channel: ${approvalArg(args, "channelId")}`,
				`Message:\n${approvalArg(args, "content")}`,
			];
		},
		async execute(_toolCallId: string, params: typeof sendMessageSchema.infer) {
			const payload = await graphPostMessage(
				`/teams/${encodeURIComponent(params.teamId)}/channels/${encodeURIComponent(params.channelId)}/messages`,
				params.content,
				"message send",
			);
			const idText = payload.id ? ` (message id ${payload.id})` : "";
			const urlText = payload.webUrl ? `\n${payload.webUrl}` : "";
			return {
				content: [
					{ type: "text" as const, text: `Message posted to channel ${params.channelId}${idText}${urlText}` },
				],
			};
		},
	};
}

function createReadMessagesTool(): ToolDefinition<typeof readMessagesSchema> {
	return {
		name: "teams_read_channel_messages",
		label: "Microsoft Teams: Read Channel Messages",
		description:
			"Read the most recent messages in a Microsoft Teams channel. Returns sender · timestamp · text (HTML stripped and truncated) per message, newest first. Reading channel messages as an application requires the ChannelMessage.Read.All application permission WITH admin consent — without it Graph returns 403, which is surfaced verbatim.",
		parameters: readMessagesSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof readMessagesSchema.infer) {
			const top = Math.min(Math.max(params.limit ?? 20, 1), 50);
			const payload = await graphJson<{ value?: ChatMessage[] }>(
				`/teams/${encodeURIComponent(params.teamId)}/channels/${encodeURIComponent(params.channelId)}/messages?$top=${top}`,
				"channel.messages.list",
			);
			const messages = payload.value ?? [];
			const text =
				messages.length === 0
					? "No messages found in that channel. Check the team/channel ids, or that the app has ChannelMessage.Read.All (with admin consent)."
					: messages
							.map(m => {
								const sender = m.from?.user?.displayName ?? "(system/unknown)";
								const when = m.createdDateTime ?? "(no timestamp)";
								const bodyText = m.body?.content ? htmlToText(m.body.content) : "(no text content)";
								return `${sender} · ${when}\n${bodyText}`;
							})
							.join("\n\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createReplyMessageTool(): ToolDefinition<typeof replyMessageSchema> {
	return {
		name: "teams_reply_channel_message",
		label: "Microsoft Teams: Reply to Channel Message",
		description:
			"Reply to a message in a Microsoft Teams channel (posts under the given top-level message). DESTRUCTIVE — this publishes to a shared channel; ALWAYS confirm the exact team, channel, target message id, and reply text with the user before calling. Like teams_send_channel_message, replying as an application requires the ChannelMessage.Send application permission WITH admin consent, and Microsoft restricts app-only channel messages to migration/import scenarios on some tenants — if Graph refuses, its exact error is surfaced verbatim.",
		parameters: replyMessageSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			return [
				`Team: ${approvalArg(args, "teamId")}`,
				`Channel: ${approvalArg(args, "channelId")}`,
				`Reply to message: ${approvalArg(args, "messageId")}`,
				`Reply:\n${approvalArg(args, "content")}`,
			];
		},
		async execute(_toolCallId: string, params: typeof replyMessageSchema.infer) {
			const payload = await graphPostMessage(
				`/teams/${encodeURIComponent(params.teamId)}/channels/${encodeURIComponent(params.channelId)}/messages/${encodeURIComponent(params.messageId)}/replies`,
				params.content,
				"reply",
			);
			const idText = payload.id ? ` (reply id ${payload.id})` : "";
			const urlText = payload.webUrl ? `\n${payload.webUrl}` : "";
			return {
				content: [
					{
						type: "text" as const,
						text: `Reply posted under message ${params.messageId} in channel ${params.channelId}${idText}${urlText}`,
					},
				],
			};
		},
	};
}

function createListMembersTool(): ToolDefinition<typeof listMembersSchema> {
	return {
		name: "teams_list_members",
		label: "Microsoft Teams: List Members",
		description:
			"List the members of a Microsoft Team. Returns displayName · roles (e.g. owner, member) per line. Requires the TeamMember.Read.All application permission WITH admin consent — without it Graph returns 403, which is surfaced verbatim.",
		parameters: listMembersSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listMembersSchema.infer) {
			const payload = await graphJson<{ value?: ConversationMember[] }>(
				`/teams/${encodeURIComponent(params.teamId)}/members`,
				"team.members.list",
			);
			const members = payload.value ?? [];
			const text =
				members.length === 0
					? "No members found for that team. Check the team id, or that the app has TeamMember.Read.All (with admin consent)."
					: members
							.map(mem => {
								const name = mem.displayName ?? mem.email ?? "(no name)";
								const roles = mem.roles && mem.roles.length > 0 ? mem.roles.join(", ") : "member";
								return `${name} · ${roles}`;
							})
							.join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

/**
 * Microsoft Teams plugin. A standard OMP plugin — `skills/`/`rules/` load via
 * OMP's native plugin discovery. This module registers the six Graph tools;
 * the connect flow (fraym.plugin.json's `connect.form`) is what stores the
 * Azure app credential these tools exchange for a token.
 */
export default function teamsExtension(pi: ExtensionAPI): void {
	pi.registerTool(createListTeamsTool());
	pi.registerTool(createListChannelsTool());
	pi.registerTool(createSendMessageTool());
	pi.registerTool(createReadMessagesTool());
	pi.registerTool(createReplyMessageTool());
	pi.registerTool(createListMembersTool());
}
