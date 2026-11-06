import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";

const CONFIG_TARGET = join(homedir(), ".config", "dimension-discord", "token.json");
const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_WEB = "https://discord.com/channels";
const MAX_MESSAGE_TEXT = 500;
const MESSAGE_LIMIT = 2000;
const THREAD_NAME_LIMIT = 100;
const FORUM_TAG_LIMIT = 5;
const SEARCH_PAGE_LIMIT = 25;
const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PUBLISHES_PER_HOUR = 10;
const IMAGE_TYPES: Readonly<Record<string, string>> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

const storedCredential = type({
	access: "string",
});

async function botToken(): Promise<string> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_TARGET, "utf-8");
	} catch {
		throw new Error(
			"Discord isn't connected yet. Open the plugin's Connect dialog (Plugins → Discord → Set up) and paste a bot token.",
		);
	}
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors) {
		throw new Error(`Discord's stored credential at ${CONFIG_TARGET} is malformed. Reconnect the plugin.`);
	}
	return parsed.access;
}

async function discordFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
	const res = await fetch(`${DISCORD_API}${path}`, {
		...init,
		headers: { Authorization: `Bot ${token}`, ...(init?.headers ?? {}) },
	});
	if (res.status === 401) {
		throw new Error("Discord rejected the bot token (401). Reconnect the plugin (Plugins → Discord → Reconnect).");
	}
	return res;
}

async function failure(res: Response, op: string): Promise<Error> {
	const payload = (await res.json().catch(() => null)) as { message?: string } | null;
	const detail = payload && typeof payload.message === "string" ? payload.message : res.statusText;
	const hint = res.status === 403 ? " The bot lacks the permission this needs in that server or channel." : "";
	return new Error(`Discord ${op} failed (${res.status}): ${detail}.${hint}`);
}

async function discordJson<T>(path: string, token: string, op: string, init?: RequestInit): Promise<T> {
	const res = await discordFetch(path, token, init);
	if (!res.ok) throw await failure(res, op);
	return (await res.json()) as T;
}

async function discordVoid(path: string, token: string, op: string, init?: RequestInit): Promise<void> {
	const res = await discordFetch(path, token, init);
	if (!res.ok) throw await failure(res, op);
}

function jsonInit(method: string, body: Record<string, unknown>): RequestInit {
	return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

interface Guild {
	readonly id: string;
	readonly name: string;
}

interface ForumTag {
	readonly id: string;
	readonly name: string;
}

interface Channel {
	readonly id: string;
	readonly name?: string;
	readonly type: number;
	readonly guild_id?: string;
	readonly parent_id?: string | null;
	readonly message_count?: number;
	readonly applied_tags?: readonly string[];
	readonly available_tags?: readonly ForumTag[];
	readonly thread_metadata?: { readonly archived?: boolean; readonly create_timestamp?: string };
}

interface DiscordUser {
	readonly id?: string;
	readonly username?: string;
	readonly global_name?: string | null;
	readonly bot?: boolean;
}

export interface Message {
	readonly id: string;
	readonly channel_id?: string;
	readonly content: string;
	readonly timestamp: string;
	readonly author?: DiscordUser;
	readonly message_reference?: { readonly message_id?: string };
	readonly reactions?: readonly { readonly count: number; readonly emoji: { readonly name?: string | null } }[];
	readonly attachments?: readonly { readonly filename?: string }[];
	readonly thread?: { readonly id: string; readonly name?: string; readonly message_count?: number };
}

const CHANNEL_TYPE_NAME: Readonly<Record<number, string>> = {
	0: "text",
	1: "dm",
	2: "voice",
	3: "group-dm",
	4: "category",
	5: "announcement",
	10: "announcement-thread",
	11: "public-thread",
	12: "private-thread",
	13: "stage-voice",
	14: "directory",
	15: "forum",
	16: "media",
};

const ANNOUNCEMENT = 5;
const PUBLIC_THREAD = 11;
const FORUM_TYPES: ReadonlySet<number> = new Set([15, 16]);
const THREAD_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

const CHANNEL_KIND_TYPE: Readonly<Record<string, number>> = {
	text: 0,
	voice: 2,
	category: 4,
	announcement: 5,
	forum: 15,
};

function oneLine(text: string, max: number): string {
	const flattened = text.replace(/\s+/g, " ").trim();
	return flattened.length > max ? `${flattened.slice(0, max)}…` : flattened;
}

function permalink(guildId: string | undefined, channelId: string, messageId?: string): string {
	return `${DISCORD_WEB}/${guildId ?? "@me"}/${channelId}${messageId ? `/${messageId}` : ""}`;
}

export function renderMessageLine(message: Message, guildId: string | undefined, channelId: string): string {
	const author = message.author?.global_name || message.author?.username || "unknown";
	const marks = [
		message.message_reference?.message_id ? `reply-to ${message.message_reference.message_id}` : null,
		message.thread
			? `thread ${message.thread.id} "${message.thread.name ?? ""}"${message.thread.message_count !== undefined ? ` ${message.thread.message_count} msgs` : ""}`
			: null,
		message.reactions?.length
			? `reactions ${message.reactions.map(r => `${r.emoji.name ?? "?"}${r.count}`).join(" ")}`
			: null,
		message.attachments?.length ? `attachments ${message.attachments.length}` : null,
	].filter(Boolean);
	const body = message.content ? oneLine(message.content, MAX_MESSAGE_TEXT) : "(no text — embed or attachment only)";
	return `${message.id}  ${message.timestamp}  ${author}${message.author?.id ? ` (${message.author.id})` : ""}${message.author?.bot ? " [bot]" : ""}${marks.length ? `  [${marks.join("; ")}]` : ""}\n    ${body}\n    ${permalink(guildId, message.channel_id ?? channelId, message.id)}`;
}

const PROMPT_EVERY_MODE = { tier: "write", policy: "prompt" } as const;

function approvalArg(args: unknown, key: string, absent = "(missing)"): string {
	const value: unknown = typeof args === "object" && args !== null ? Reflect.get(args, key) : undefined;
	return typeof value === "string" || typeof value === "number" ? String(value) : absent;
}

function approvalList(args: unknown, key: string): string[] {
	const value: unknown = typeof args === "object" && args !== null ? Reflect.get(args, key) : undefined;
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function mentionCard(args: unknown): string {
	const users = approvalList(args, "mentionUserIds");
	return users.length
		? `Pings: only users ${users.join(", ")}`
		: "Pings: none (@everyone, @here, roles and users are not notified)";
}

export function allowedMentions(userIds: readonly string[] | undefined, repliedUser = false): Record<string, unknown> {
	return { parse: [], users: [...(userIds ?? [])], replied_user: repliedUser };
}

function checkLength(content: string, what: string): void {
	if (content.length > MESSAGE_LIMIT) {
		throw new Error(`${what} is ${content.length} characters; Discord's limit is ${MESSAGE_LIMIT}. Nothing was sent.`);
	}
	if (!content.trim()) throw new Error(`Refusing to send an empty ${what.toLowerCase()}.`);
}

export async function messageBody(
	payload: Record<string, unknown>,
	imagePath: string | undefined,
): Promise<RequestInit> {
	if (!imagePath) return jsonInit("POST", payload);
	const mime = IMAGE_TYPES[extname(imagePath).toLowerCase()];
	if (!mime) throw new Error(`${imagePath} is not a PNG, JPEG, GIF or WebP image. Nothing was sent.`);
	const bytes = await readFile(imagePath).catch(() => {
		throw new Error(`Cannot read the image at ${imagePath}. Nothing was sent.`);
	});
	if (bytes.byteLength > MAX_IMAGE_BYTES) {
		throw new Error(`${imagePath} is ${bytes.byteLength} bytes; the upload limit is ${MAX_IMAGE_BYTES}. Nothing was sent.`);
	}
	const filename = basename(imagePath);
	const form = new FormData();
	form.set("payload_json", JSON.stringify({ ...payload, attachments: [{ id: 0, filename }] }));
	form.set("files[0]", new Blob([bytes], { type: mime }), filename);
	return { method: "POST", body: form };
}

async function channelOf(channelId: string, token: string): Promise<Channel> {
	return discordJson<Channel>(`/channels/${encodeURIComponent(channelId)}`, token, "read channel");
}

function tagIds(parent: Channel, names: readonly string[]): string[] {
	const available = parent.available_tags ?? [];
	if (names.length > FORUM_TAG_LIMIT) throw new Error(`A forum post takes at most ${FORUM_TAG_LIMIT} tags.`);
	return names.map(name => {
		const found = available.find(tag => tag.name.toLowerCase() === name.trim().toLowerCase());
		if (!found) {
			throw new Error(
				`Forum ${parent.name ?? parent.id} has no tag "${name}". Its tags: ${available.map(tag => tag.name).join(", ") || "none"}.`,
			);
		}
		return found.id;
	});
}

function tagNames(parent: Channel | undefined, ids: readonly string[] | undefined): string[] {
	const available = parent?.available_tags ?? [];
	return (ids ?? []).map(id => available.find(tag => tag.id === id)?.name ?? id);
}

const imagePathField = type("string").describe(
	"Optional absolute path of ONE local image (PNG, JPEG, GIF or WebP, at most 10 MB) to attach. Needs the bot's Attach Files permission.",
);
const mentionField = type("string[]").describe(
	"User ids the person explicitly named to notify. Default none: @everyone, @here, role and user mentions in the text do NOT ping.",
);

const listGuildsSchema = type({});

const listChannelsSchema = type({
	guildId: type("string").describe("The server (guild) id, from discord_list_guilds."),
});

const readMessagesSchema = type({
	channelId: type("string").describe("The channel or thread id, from discord_list_channels or discord_list_threads."),
	"limit?": type("number").describe("How many messages to fetch, default 20, capped at 100."),
	"before?": type("string").describe("Page backwards: only messages older than this message id."),
	"after?": type("string").describe("Page forwards: only messages newer than this message id."),
	"around?": type("string").describe("Messages around this message id (fetch one message in context)."),
});

const sendMessageSchema = type({
	channelId: type("string").describe("The channel or thread id to post into, from discord_list_channels."),
	content: type("string").describe("The message text (Discord markdown, at most 2000 characters; no tables)."),
	"imagePath?": imagePathField,
	"mentionUserIds?": mentionField,
});

const createThreadSchema = type({
	channelId: type("string").describe("The parent channel id (a text, announcement or forum channel)."),
	name: type("string").describe("The thread or forum post title, at most 100 characters."),
	"messageId?": type("string").describe(
		"Text channels only: create the thread FROM this existing message. Omit for a standalone thread.",
	),
	"content?": type("string").describe("Forum channels: the post's first message (required there), at most 2000 characters."),
	"tags?": type("string[]").describe("Forum channels: tag NAMES to apply (at most 5), from discord_list_threads."),
	"mentionUserIds?": mentionField,
});

const replyMessageSchema = type({
	channelId: type("string").describe("The channel or thread id containing the message to reply to."),
	messageId: type("string").describe("The id of the message to reply to (from discord_read_messages)."),
	content: type("string").describe("The reply text (Discord markdown, at most 2000 characters)."),
	"imagePath?": imagePathField,
	"mentionUserIds?": mentionField,
	"pingAuthor?": type("boolean").describe("Notify the author of the replied-to message. Default true."),
});

const addReactionSchema = type({
	channelId: type("string").describe("The channel id containing the message, from discord_list_channels."),
	messageId: type("string").describe("The id of the message to react to, from discord_read_messages."),
	emoji: type("string").describe(
		"The emoji to add. A standard emoji is the character itself (e.g. 👍); a custom guild emoji is `name:id`. The reaction is added AS THE BOT.",
	),
});

const editMessageSchema = type({
	channelId: type("string").describe("The channel id containing the message, from discord_list_channels."),
	messageId: type("string").describe("The id of the bot's OWN message to edit — Discord rejects edits to other users' messages."),
	content: type("string").describe("The new message text, which fully replaces the current content (at most 2000 characters)."),
	"mentionUserIds?": mentionField,
});

const deleteMessageSchema = type({
	channelId: type("string").describe("The channel id containing the message, from discord_list_channels."),
	messageId: type("string").describe(
		"The id of the message to delete (from discord_read_messages). With Manage Messages this deletes ANYONE's message and is IRREVERSIBLE.",
	),
});

const pinMessageSchema = type({
	channelId: type("string").describe("The channel id containing the message, from discord_list_channels."),
	messageId: type("string").describe("The id of the message to pin (or unpin), from discord_read_messages."),
	"unpin?": type("boolean").describe("Set true to UNPIN the message instead of pinning it. Default false (pin)."),
});

const createChannelSchema = type({
	guildId: type("string").describe("The server (guild) id to create the channel in, from discord_list_guilds."),
	name: type("string").describe("The new channel name (text channels: lowercase with dashes; at most 100 characters)."),
	"kind?": type('"text" | "voice" | "category" | "announcement" | "forum"').describe(
		'The channel kind: "text" (default), "voice", "category", "announcement" or "forum" (the last two need Community on).',
	),
	"topic?": type("string").describe("Optional channel topic, or a forum's post guidelines (at most 1024 characters)."),
	"parentId?": type("string").describe("Optional id of a category channel to nest this channel under."),
});

const timeoutMemberSchema = type({
	guildId: type("string").describe("The server (guild) id, from discord_list_guilds."),
	userId: type("string").describe("The id of the member to time out — the exact user the person named."),
	minutes: type("number").describe(
		"How long to time the member out, in minutes (1–40320, up to 28 days; clamped). Pass 0 (or clear:true) to LIFT a timeout.",
	),
	"clear?": type("boolean").describe("Set true to lift the member's timeout now. Overrides minutes."),
});

const listThreadsSchema = type({
	guildId: type("string").describe("The server (guild) id, from discord_list_guilds."),
	"channelId?": type("string").describe("Only threads under this parent channel (a forum, for its posts)."),
	"includeArchived?": type("boolean").describe(
		"Also list the parent's public archived threads (needs channelId). Default false: active threads only.",
	),
	"limit?": type("number").describe("Max archived threads to list, default 25, capped at 100."),
});

const searchMessagesSchema = type({
	guildId: type("string").describe("The server (guild) id to search, from discord_list_guilds."),
	"content?": type("string").describe("Words to find in message text."),
	"authorId?": type("string").describe("Only messages by this user id."),
	"channelId?": type("string").describe("Only messages in this channel or thread id."),
	"has?": type("'link' | 'embed' | 'file' | 'image' | 'video' | 'sound'").describe("Only messages carrying this."),
	"limit?": type("number").describe("Results per page, default 25 (Discord's maximum)."),
	"offset?": type("number").describe("Skip this many results, to page (from the previous call's next offset)."),
});

const guildSnapshotSchema = type({
	guildId: type("string").describe("The server (guild) id, from discord_list_guilds."),
});

const createInviteSchema = type({
	channelId: type("string").describe("The channel the invite lands people in (usually a start-here or rules channel)."),
	source: type("string").describe(
		"Where this code will be posted (e.g. 'x-bio', 'youtube-description', 'readme'). Not sent to Discord; echoed so the code can be attributed by its uses later.",
	),
	"maxAgeSeconds?": type("number").describe("Seconds until the invite expires; 0 (default) never expires."),
	"maxUses?": type("number").describe("Uses before the invite stops working; 0 (default) is unlimited."),
	"roleIds?": type("string[]").describe("Role ids granted to people who join with this invite (e.g. a Beta role)."),
});

const publishMessageSchema = type({
	channelId: type("string").describe("The announcement channel id holding the message."),
	messageId: type("string").describe("The message to publish to every server following the channel."),
});

const setThreadTagsSchema = type({
	threadId: type("string").describe("The forum post (thread) id, from discord_list_threads."),
	tags: type("string[]").describe(
		"The tag NAMES the post should carry after this call (replaces its tags; at most 5), e.g. ['Question', 'Solved'].",
	),
});

const createEventSchema = type({
	guildId: type("string").describe("The server (guild) id, from discord_list_guilds."),
	name: type("string").describe("The event name, 1-100 characters."),
	startTime: type("string").describe("Start time, ISO 8601 with offset (e.g. 2026-11-20T17:00:00Z)."),
	"endTime?": type("string").describe("End time, ISO 8601. Required for an external event (location)."),
	"description?": type("string").describe("What happens at the event, at most 1000 characters."),
	"channelId?": type("string").describe("A voice or stage channel id to hold it in. Give this OR location."),
	"location?": type("string").describe("Where it happens outside Discord (a URL or place). Give this OR channelId."),
});

const listAutomodSchema = type({
	guildId: type("string").describe("The server (guild) id, from discord_list_guilds."),
});

const createAutomodSchema = type({
	guildId: type("string").describe("The server (guild) id, from discord_list_guilds."),
	name: type("string").describe("The rule name shown in Server Settings → AutoMod."),
	trigger: type("'keyword' | 'spam' | 'keyword_preset' | 'mention_spam'").describe(
		"keyword: block listed words; spam: Discord's spam filter; keyword_preset: Discord's word lists; mention_spam: too many mentions.",
	),
	"keywords?": type("string[]").describe("keyword trigger: words or phrases (wildcards with *), at most 1000."),
	"presets?": type("('profanity' | 'sexual_content' | 'slurs')[]").describe("keyword_preset trigger: which lists."),
	"mentionLimit?": type("number").describe("mention_spam trigger: unique mentions per message before it acts (max 50)."),
	"action?": type("'block' | 'alert' | 'timeout'").describe(
		"block (default): stop the message; alert: post it to alertChannelId; timeout: time the author out (keyword and mention_spam only).",
	),
	"alertChannelId?": type("string").describe("alert action: the staff channel the alert goes to."),
	"timeoutSeconds?": type("number").describe("timeout action: seconds, at most 2419200 (28 days)."),
});

function createListGuildsTool(): ToolDefinition<typeof listGuildsSchema> {
	return {
		name: "discord_list_guilds",
		label: "Discord: List Servers",
		description:
			"List the Discord servers (guilds) the connected bot is a member of. Returns id and name per line — pass a server id to discord_list_channels.",
		parameters: listGuildsSchema,
		approval: "read" as const,
		async execute() {
			const guilds = await discordJson<Guild[]>("/users/@me/guilds", await botToken(), "list guilds");
			const text =
				guilds.length === 0
					? "The bot isn't in any servers yet. Invite it via OAuth2 → URL Generator (scope `bot`)."
					: guilds.map(g => `${g.id}  ${g.name}`).join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createListChannelsTool(): ToolDefinition<typeof listChannelsSchema> {
	return {
		name: "discord_list_channels",
		label: "Discord: List Channels",
		description:
			"List the channels in a Discord server the bot can view. Returns id, name, type and parent per line, and a forum's tag names — pass a channel id to discord_read_messages or discord_send_message, a forum id to discord_list_threads.",
		parameters: listChannelsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listChannelsSchema.infer) {
			const channels = await discordJson<Channel[]>(
				`/guilds/${encodeURIComponent(params.guildId)}/channels`,
				await botToken(),
				"list channels",
			);
			const text =
				channels.length === 0
					? "No channels found (the bot may lack the View Channels permission in this server)."
					: channels
							.map(c => {
								const kind = CHANNEL_TYPE_NAME[c.type] ?? `type ${c.type}`;
								const tags = c.available_tags?.length ? `  tags: ${c.available_tags.map(t => t.name).join(", ")}` : "";
								return `${c.id}  ${c.name ?? "(unnamed)"}  (${kind})${c.parent_id ? `  in ${c.parent_id}` : ""}${tags}`;
							})
							.join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createReadMessagesTool(): ToolDefinition<typeof readMessagesSchema> {
	return {
		name: "discord_read_messages",
		label: "Discord: Read Messages",
		description:
			"Read messages in a Discord channel or thread, newest first. Each line: message id, timestamp, author name and id, then reply-to id, thread (id, name, message count), reaction counts and attachment count when present, the text, and the message's permalink. Page with before/after/around a message id. Requires the bot's Message Content intent to see text.",
		parameters: readMessagesSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof readMessagesSchema.infer) {
			const cursors = (["before", "after", "around"] as const).filter(key => params[key]);
			if (cursors.length > 1) throw new Error("Pass at most one of before, after and around.");
			const token = await botToken();
			const channel = await channelOf(params.channelId, token);
			const query = new URLSearchParams({ limit: String(Math.min(Math.max(params.limit ?? 20, 1), 100)) });
			for (const key of cursors) query.set(key, params[key] ?? "");
			const messages = await discordJson<Message[]>(
				`/channels/${encodeURIComponent(params.channelId)}/messages?${query.toString()}`,
				token,
				"read messages",
			);
			if (messages.length === 0) return { content: [{ type: "text" as const, text: "No messages here." }] };
			const lines = messages.map(m => renderMessageLine(m, channel.guild_id, params.channelId));
			const oldest = messages[messages.length - 1];
			if (oldest) lines.push(`\n[older: pass before: "${oldest.id}"]`);
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function createSendMessageTool(): ToolDefinition<typeof sendMessageSchema> {
	return {
		name: "discord_send_message",
		label: "Discord: Send Message",
		description:
			"Post a message to a Discord channel or thread, optionally with one image. PUBLIC — it publishes to a live channel; confirm the exact channel and text with the user first. Mentions in the text never ping unless the person named those users (mentionUserIds). Returns the message id and permalink.",
		parameters: sendMessageSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			const image = approvalArg(args, "imagePath", "");
			return [
				`Channel: ${approvalArg(args, "channelId")}`,
				`Message:\n${approvalArg(args, "content")}`,
				...(image ? [`Image: ${image}`] : []),
				mentionCard(args),
			];
		},
		async execute(_toolCallId: string, params: typeof sendMessageSchema.infer) {
			checkLength(params.content, "Message");
			const token = await botToken();
			const channel = await channelOf(params.channelId, token);
			const sent = await discordJson<Message>(
				`/channels/${encodeURIComponent(params.channelId)}/messages`,
				token,
				"send message",
				await messageBody(
					{ content: params.content, allowed_mentions: allowedMentions(params.mentionUserIds) },
					params.imagePath,
				),
			);
			const publish = channel.type === ANNOUNCEMENT ? "\nAnnouncement channel: followers see it only after discord_publish_message." : "";
			return {
				content: [
					{
						type: "text" as const,
						text: `Message sent (id ${sent.id}).\n${permalink(channel.guild_id, params.channelId, sent.id)}${publish}`,
					},
				],
			};
		},
	};
}

function createCreateThreadTool(): ToolDefinition<typeof createThreadSchema> {
	return {
		name: "discord_create_thread",
		label: "Discord: Create Thread",
		description:
			"Create a thread. In a forum channel this is a forum post: `content` is its first message (required) and `tags` are tag names to apply. In a text channel, pass `messageId` to thread off a message, or omit it for a standalone public thread. PUBLIC — confirm the channel, title, text and tags with the user first. Returns the thread id and permalink.",
		parameters: createThreadSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			const from = approvalArg(args, "messageId", "");
			const content = approvalArg(args, "content", "");
			const tags = approvalList(args, "tags");
			return [
				`Channel: ${approvalArg(args, "channelId")}`,
				`Thread name: ${approvalArg(args, "name")}`,
				...(from ? [`From message: ${from}`] : []),
				...(content ? [`First message:\n${content}`] : []),
				...(tags.length ? [`Tags: ${tags.join(", ")}`] : []),
				mentionCard(args),
			];
		},
		async execute(_toolCallId: string, params: typeof createThreadSchema.infer) {
			if (params.name.length > THREAD_NAME_LIMIT) {
				throw new Error(`A thread name is at most ${THREAD_NAME_LIMIT} characters; this one is ${params.name.length}.`);
			}
			const token = await botToken();
			const parent = await channelOf(params.channelId, token);
			const channelId = encodeURIComponent(params.channelId);
			let thread: Channel;
			if (FORUM_TYPES.has(parent.type)) {
				if (params.messageId) throw new Error("A forum post cannot start from an existing message; pass content.");
				if (!params.content) throw new Error("A forum post needs content: its first message.");
				checkLength(params.content, "First message");
				thread = await discordJson<Channel>(
					`/channels/${channelId}/threads`,
					token,
					"create forum post",
					jsonInit("POST", {
						name: params.name,
						message: { content: params.content, allowed_mentions: allowedMentions(params.mentionUserIds) },
						applied_tags: tagIds(parent, params.tags ?? []),
					}),
				);
			} else {
				if (params.content || params.tags?.length) {
					throw new Error(
						`Channel ${parent.name ?? params.channelId} is a ${CHANNEL_TYPE_NAME[parent.type] ?? "non-forum"} channel: content and tags apply to forum posts only. Create the thread, then post into it with discord_send_message.`,
					);
				}
				thread = params.messageId
					? await discordJson<Channel>(
							`/channels/${channelId}/messages/${encodeURIComponent(params.messageId)}/threads`,
							token,
							"create thread from message",
							jsonInit("POST", { name: params.name }),
						)
					: await discordJson<Channel>(
							`/channels/${channelId}/threads`,
							token,
							"create thread",
							jsonInit("POST", { name: params.name, type: PUBLIC_THREAD }),
						);
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Thread created (id ${thread.id}, name "${thread.name ?? params.name}").\n${permalink(parent.guild_id, thread.id)}`,
					},
				],
			};
		},
	};
}

function createReplyMessageTool(): ToolDefinition<typeof replyMessageSchema> {
	return {
		name: "discord_reply_message",
		label: "Discord: Reply to Message",
		description:
			"Reply to a specific Discord message (a new message linked to the original), optionally with one image. PUBLIC — confirm the channel, target message and text with the user first. Only the replied-to author is notified (pingAuthor false turns that off); other mentions ping only users the person named. Returns the message id and permalink.",
		parameters: replyMessageSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			const image = approvalArg(args, "imagePath", "");
			return [
				`Channel: ${approvalArg(args, "channelId")}`,
				`Reply to message: ${approvalArg(args, "messageId")}`,
				`Message:\n${approvalArg(args, "content")}`,
				...(image ? [`Image: ${image}`] : []),
				mentionCard(args),
			];
		},
		async execute(_toolCallId: string, params: typeof replyMessageSchema.infer) {
			checkLength(params.content, "Reply");
			const token = await botToken();
			const channel = await channelOf(params.channelId, token);
			const sent = await discordJson<Message>(
				`/channels/${encodeURIComponent(params.channelId)}/messages`,
				token,
				"reply to message",
				await messageBody(
					{
						content: params.content,
						message_reference: { message_id: params.messageId },
						allowed_mentions: allowedMentions(params.mentionUserIds, params.pingAuthor !== false),
					},
					params.imagePath,
				),
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Reply sent (id ${sent.id}).\n${permalink(channel.guild_id, params.channelId, sent.id)}`,
					},
				],
			};
		},
	};
}

function createAddReactionTool(): ToolDefinition<typeof addReactionSchema> {
	return {
		name: "discord_add_reaction",
		label: "Discord: Add Reaction",
		description:
			"Add an emoji reaction to a Discord message AS THE BOT. Low-risk but public (everyone sees the bot reacted) — mention it to the user. For a custom guild emoji pass `name:id`; for a standard emoji pass the character.",
		parameters: addReactionSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof addReactionSchema.infer) {
			await discordVoid(
				`/channels/${encodeURIComponent(params.channelId)}/messages/${encodeURIComponent(params.messageId)}/reactions/${encodeURIComponent(params.emoji)}/@me`,
				await botToken(),
				"add reaction",
				{ method: "PUT" },
			);
			return {
				content: [{ type: "text" as const, text: `Reacted with ${params.emoji} on message ${params.messageId}.` }],
			};
		},
	};
}

function createEditMessageTool(): ToolDefinition<typeof editMessageSchema> {
	return {
		name: "discord_edit_message",
		label: "Discord: Edit Message",
		description:
			"Edit the content of one of the bot's OWN messages (Discord rejects edits to other users' messages). The previous content is replaced; confirm the exact message and new text with the user first. Mentions ping only users the person named.",
		parameters: editMessageSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			return [
				`Channel: ${approvalArg(args, "channelId")}`,
				`Edit message: ${approvalArg(args, "messageId")}`,
				`New content:\n${approvalArg(args, "content")}`,
				mentionCard(args),
			];
		},
		async execute(_toolCallId: string, params: typeof editMessageSchema.infer) {
			checkLength(params.content, "Message");
			const edited = await discordJson<Message>(
				`/channels/${encodeURIComponent(params.channelId)}/messages/${encodeURIComponent(params.messageId)}`,
				await botToken(),
				"edit message",
				jsonInit("PATCH", { content: params.content, allowed_mentions: allowedMentions(params.mentionUserIds) }),
			);
			return { content: [{ type: "text" as const, text: `Message edited (id ${edited.id}).` }] };
		},
	};
}

function createDeleteMessageTool(): ToolDefinition<typeof deleteMessageSchema> {
	return {
		name: "discord_delete_message",
		label: "Discord: Delete Message",
		description:
			'MODERATION. Permanently delete a Discord message — with the Manage Messages permission this works on ANYONE\'s message, not just the bot\'s. IRREVERSIBLE. NEVER call without the user naming the EXACT message (channel + message id, ideally quoting its content) in the current turn. Refuse vague instructions like "clean up the channel".',
		parameters: deleteMessageSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			return [`Channel: ${approvalArg(args, "channelId")}`, `Delete message: ${approvalArg(args, "messageId")}`];
		},
		async execute(_toolCallId: string, params: typeof deleteMessageSchema.infer) {
			await discordVoid(
				`/channels/${encodeURIComponent(params.channelId)}/messages/${encodeURIComponent(params.messageId)}`,
				await botToken(),
				"delete message",
				{ method: "DELETE" },
			);
			return { content: [{ type: "text" as const, text: `Message ${params.messageId} deleted.` }] };
		},
	};
}

function createPinMessageTool(): ToolDefinition<typeof pinMessageSchema> {
	return {
		name: "discord_pin_message",
		label: "Discord: Pin Message",
		description:
			"Pin a Discord message to its channel (or unpin it with `unpin: true`). Pinned messages are highlighted for everyone in the channel; confirm the exact message with the user first.",
		parameters: pinMessageSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof pinMessageSchema.infer) {
			const unpin = params.unpin === true;
			await discordVoid(
				`/channels/${encodeURIComponent(params.channelId)}/pins/${encodeURIComponent(params.messageId)}`,
				await botToken(),
				unpin ? "unpin message" : "pin message",
				{ method: unpin ? "DELETE" : "PUT" },
			);
			return {
				content: [{ type: "text" as const, text: `Message ${params.messageId} ${unpin ? "unpinned" : "pinned"}.` }],
			};
		},
	};
}

function createCreateChannelTool(): ToolDefinition<typeof createChannelSchema> {
	return {
		name: "discord_create_channel",
		label: "Discord: Create Channel",
		description:
			"Create a channel in a Discord server — text (default), voice, category, announcement or forum (the last two need Community on). It adds a visible channel; confirm the server, name and kind with the user first. Returns the new channel id.",
		parameters: createChannelSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof createChannelSchema.infer) {
			const body: Record<string, unknown> = { name: params.name, type: CHANNEL_KIND_TYPE[params.kind ?? "text"] ?? 0 };
			if (params.topic) body.topic = params.topic;
			if (params.parentId) body.parent_id = params.parentId;
			const channel = await discordJson<Channel>(
				`/guilds/${encodeURIComponent(params.guildId)}/channels`,
				await botToken(),
				"create channel",
				jsonInit("POST", body),
			);
			return {
				content: [
					{ type: "text" as const, text: `Channel created (id ${channel.id}, name "${channel.name ?? params.name}").` },
				],
			};
		},
	};
}

function createTimeoutMemberTool(): ToolDefinition<typeof timeoutMemberSchema> {
	return {
		name: "discord_timeout_member",
		label: "Discord: Timeout Member",
		description:
			'MODERATION. Time out (mute) a server member for up to 28 days, or lift a timeout (minutes 0 / clear:true). Needs Moderate Members. Asks the person in every mode. NEVER call without the user naming the EXACT member AND the duration in the current turn. Refuse vague instructions like "mute the spammers".',
		parameters: timeoutMemberSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			const clearing =
				(typeof args === "object" && args !== null && Reflect.get(args, "clear") === true) ||
				Number(approvalArg(args, "minutes", "0")) <= 0;
			return [
				`Server: ${approvalArg(args, "guildId")}`,
				`Member: ${approvalArg(args, "userId")}`,
				clearing ? "Action: lift the timeout" : `Action: time out for ${approvalArg(args, "minutes")} minutes`,
			];
		},
		async execute(_toolCallId: string, params: typeof timeoutMemberSchema.infer) {
			const clearing = params.clear === true || params.minutes <= 0;
			const until = clearing
				? null
				: new Date(
						Date.now() + Math.min(Math.max(Math.floor(params.minutes), 1), MAX_TIMEOUT_MINUTES) * 60_000,
					).toISOString();
			await discordVoid(
				`/guilds/${encodeURIComponent(params.guildId)}/members/${encodeURIComponent(params.userId)}`,
				await botToken(),
				clearing ? "clear member timeout" : "timeout member",
				jsonInit("PATCH", { communication_disabled_until: until }),
			);
			const text = clearing
				? `Timeout lifted for member ${params.userId}.`
				: `Member ${params.userId} timed out until ${until}.`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

export function renderThreadLine(thread: Channel, parent: Channel | undefined, guildId: string): string {
	const tags = tagNames(parent, thread.applied_tags);
	const solved = tags.some(tag => tag.toLowerCase() === "solved");
	const state = thread.thread_metadata?.archived ? "archived" : "active";
	const created = thread.thread_metadata?.create_timestamp?.slice(0, 16).replace("T", " ") ?? "";
	return `${thread.id}  ${thread.name ?? "(unnamed)"}  [${state}${solved ? ", SOLVED" : ""}]  ${thread.message_count ?? "?"} msgs${created ? `  created ${created}` : ""}${tags.length ? `  tags: ${tags.join(", ")}` : ""}${thread.parent_id ? `  in ${thread.parent_id}` : ""}\n    ${permalink(guildId, thread.id)}`;
}

function createListThreadsTool(): ToolDefinition<typeof listThreadsSchema> {
	return {
		name: "discord_list_threads",
		label: "Discord: List Threads",
		description:
			"List threads and forum posts: the server's active threads (optionally only under one parent channel), plus that parent's public archived threads when includeArchived is set. Each line: thread id, title, active or archived, SOLVED when it carries a tag named Solved, message count, created time, tag names, parent and permalink. The support-desk read: unanswered and unsolved posts.",
		parameters: listThreadsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listThreadsSchema.infer) {
			if (params.includeArchived && !params.channelId) throw new Error("includeArchived needs channelId: the forum or channel to list.");
			const token = await botToken();
			const active = await discordJson<{ threads: Channel[] }>(
				`/guilds/${encodeURIComponent(params.guildId)}/threads/active`,
				token,
				"list active threads",
			);
			const parent = params.channelId ? await channelOf(params.channelId, token) : undefined;
			const threads = active.threads.filter(thread => !params.channelId || thread.parent_id === params.channelId);
			if (params.includeArchived && params.channelId) {
				const archived = await discordJson<{ threads: Channel[] }>(
					`/channels/${encodeURIComponent(params.channelId)}/threads/archived/public?limit=${Math.min(Math.max(params.limit ?? 25, 1), 100)}`,
					token,
					"list archived threads",
				);
				threads.push(...archived.threads);
			}
			const text =
				threads.length === 0
					? "No threads found."
					: threads.map(thread => renderThreadLine(thread, parent, params.guildId)).join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createSearchMessagesTool(): ToolDefinition<typeof searchMessagesSchema> {
	return {
		name: "discord_search_messages",
		label: "Discord: Search Messages",
		description:
			"Search a server's messages by words, author, channel or attachment kind — the 'was this already answered?' check before replying, and the unanswered-question sweep. Returns the total, then message lines with ids and permalinks, 25 per page (page with offset). A new or large server may answer 'index not ready': wait the seconds it names, then retry once.",
		parameters: searchMessagesSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof searchMessagesSchema.infer) {
			const limit = Math.min(Math.max(params.limit ?? SEARCH_PAGE_LIMIT, 1), SEARCH_PAGE_LIMIT);
			const offset = Math.max(params.offset ?? 0, 0);
			const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
			if (params.content) query.set("content", params.content);
			if (params.authorId) query.set("author_id", params.authorId);
			if (params.channelId) query.set("channel_id", params.channelId);
			if (params.has) query.set("has", params.has);
			const res = await discordFetch(
				`/guilds/${encodeURIComponent(params.guildId)}/messages/search?${query.toString()}`,
				await botToken(),
			);
			if (res.status === 202) {
				const pending = (await res.json().catch(() => null)) as { retry_after?: number } | null;
				return {
					content: [
						{
							type: "text" as const,
							text: `Discord is still indexing this server's messages (index not ready). Retry once in ${pending?.retry_after ?? 2} seconds; do not loop.`,
						},
					],
				};
			}
			if (!res.ok) throw await failure(res, "search messages");
			const found = (await res.json()) as { total_results?: number; messages?: Message[][] };
			const hits = (found.messages ?? []).flatMap(group => group.slice(0, 1));
			const total = found.total_results ?? hits.length;
			const lines = [`${total} matching message(s); showing ${offset + 1}-${offset + hits.length}.`];
			for (const hit of hits) lines.push(renderMessageLine(hit, params.guildId, hit.channel_id ?? ""));
			if (offset + hits.length < total) lines.push(`\n[more: pass offset: ${offset + hits.length}]`);
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

interface GuildDetail {
	readonly name?: string;
	readonly description?: string | null;
	readonly approximate_member_count?: number;
	readonly approximate_presence_count?: number;
	readonly features?: readonly string[];
	readonly verification_level?: number;
	readonly explicit_content_filter?: number;
	readonly mfa_level?: number;
	readonly rules_channel_id?: string | null;
	readonly public_updates_channel_id?: string | null;
	readonly premium_subscription_count?: number;
}

interface Invite {
	readonly code: string;
	readonly uses?: number;
	readonly max_uses?: number;
	readonly max_age?: number;
	readonly channel?: { readonly name?: string };
}

interface ScheduledEvent {
	readonly id: string;
	readonly name: string;
	readonly scheduled_start_time: string;
	readonly user_count?: number;
}

const VERIFICATION = ["none", "low", "medium", "high", "highest"];
const CONTENT_FILTER = ["off", "members without roles", "all members"];

async function optionalRead<T>(read: () => Promise<T>): Promise<T | string> {
	try {
		return await read();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export function renderSnapshot(
	guild: GuildDetail,
	invites: readonly Invite[] | string,
	events: readonly ScheduledEvent[] | string,
	onboarding: { readonly enabled?: boolean } | string,
	readAt: string,
): string {
	const features = guild.features ?? [];
	const verification = guild.verification_level ?? 0;
	const filter = guild.explicit_content_filter ?? 0;
	const check = (ok: boolean, line: string) => `  [${ok ? "x" : " "}] ${line}`;
	const lines = [
		`${guild.name ?? "?"}  (read ${readAt})`,
		`Members: ${guild.approximate_member_count ?? "unknown"}  Online: ${guild.approximate_presence_count ?? "unknown"}  Boosts: ${guild.premium_subscription_count ?? 0}`,
		`Features: ${features.join(", ") || "none"}`,
		"Readiness:",
		check(features.includes("COMMUNITY"), "Community on (forums, announcements, onboarding, Discovery need it)"),
		check(verification >= 1, `verification level at least low (now ${VERIFICATION[verification] ?? verification})`),
		check(filter === 2, `explicit media filter on all members (now ${CONTENT_FILTER[filter] ?? filter})`),
		check(guild.mfa_level === 1, "2FA required for moderation"),
		check(Boolean(guild.rules_channel_id), "rules channel set"),
		check(typeof onboarding !== "string" && onboarding.enabled === true, `onboarding on${typeof onboarding === "string" ? ` (unknown: ${onboarding})` : ""}`),
		check(features.includes("DISCOVERABLE"), "listed in Server Discovery"),
	];
	if (guild.description) lines.push(`Description: ${oneLine(guild.description, 300)}`);
	lines.push("Invites (uses per code):");
	if (typeof invites === "string") lines.push(`  unknown: ${invites}`);
	else if (invites.length === 0) lines.push("  none");
	else
		for (const invite of invites) {
			lines.push(
				`  ${invite.code}  ${invite.uses ?? 0} uses${invite.max_uses ? ` of ${invite.max_uses}` : ""}  #${invite.channel?.name ?? "?"}${invite.max_age ? `  expires after ${invite.max_age}s` : ""}`,
			);
		}
	lines.push("Scheduled events:");
	if (typeof events === "string") lines.push(`  unknown: ${events}`);
	else if (events.length === 0) lines.push("  none");
	else for (const event of events) lines.push(`  ${event.id}  ${event.name}  ${event.scheduled_start_time}  ${event.user_count ?? "?"} interested`);
	lines.push("Not readable by a bot: Server Insights (joins, retention, Discovery reach) — read them in the Discord app.");
	return lines.join("\n");
}

function createGuildSnapshotTool(): ToolDefinition<typeof guildSnapshotSchema> {
	return {
		name: "discord_guild_snapshot",
		label: "Discord: Server Snapshot",
		description:
			"One read of a server's state for a review: member and online counts, features, a readiness checklist (Community, verification, explicit filter, 2FA for moderation, rules channel, onboarding, Discovery), every invite code with its uses (needs Manage Server), and scheduled events with interested counts. Each part the bot cannot read says unknown and why. Server Insights are not readable by a bot.",
		parameters: guildSnapshotSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof guildSnapshotSchema.infer) {
			const token = await botToken();
			const id = encodeURIComponent(params.guildId);
			const [guild, invites, events, onboarding] = await Promise.all([
				discordJson<GuildDetail>(`/guilds/${id}?with_counts=true`, token, "read server"),
				optionalRead(() => discordJson<Invite[]>(`/guilds/${id}/invites`, token, "read invites")),
				optionalRead(() =>
					discordJson<ScheduledEvent[]>(`/guilds/${id}/scheduled-events?with_user_count=true`, token, "read events"),
				),
				optionalRead(() => discordJson<{ enabled?: boolean }>(`/guilds/${id}/onboarding`, token, "read onboarding")),
			]);
			return {
				content: [
					{ type: "text" as const, text: renderSnapshot(guild, invites, events, onboarding, new Date().toISOString()) },
				],
			};
		},
	};
}

function createCreateInviteTool(): ToolDefinition<typeof createInviteSchema> {
	return {
		name: "discord_create_invite",
		label: "Discord: Create Invite",
		description:
			"Create a new invite code for one source (a bio, a video description, a README), so joins can be counted per source from its uses in discord_guild_snapshot. Optional expiry, use limit and roles granted on join. Asks the person in every mode. Returns the invite URL.",
		parameters: createInviteSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			const roles = approvalList(args, "roleIds");
			return [
				`Channel: ${approvalArg(args, "channelId")}`,
				`For: ${approvalArg(args, "source")}`,
				`Expires after: ${approvalArg(args, "maxAgeSeconds", "0")} s (0 = never)`,
				`Max uses: ${approvalArg(args, "maxUses", "0")} (0 = unlimited)`,
				...(roles.length ? [`Grants roles: ${roles.join(", ")}`] : []),
			];
		},
		async execute(_toolCallId: string, params: typeof createInviteSchema.infer) {
			const invite = await discordJson<Invite>(
				`/channels/${encodeURIComponent(params.channelId)}/invites`,
				await botToken(),
				"create invite",
				jsonInit("POST", {
					max_age: Math.max(Math.floor(params.maxAgeSeconds ?? 0), 0),
					max_uses: Math.max(Math.floor(params.maxUses ?? 0), 0),
					unique: true,
					...(params.roleIds?.length ? { role_ids: params.roleIds } : {}),
				}),
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Invite for ${params.source}: https://discord.gg/${invite.code}\nRecord the code ${invite.code} against "${params.source}"; its uses show in discord_guild_snapshot.`,
					},
				],
			};
		},
	};
}

function createPublishMessageTool(): ToolDefinition<typeof publishMessageSchema> {
	return {
		name: "discord_publish_message",
		label: "Discord: Publish Announcement",
		description: `Publish a message in an announcement channel to every server that follows it (Discord's Publish button). It reaches other servers and cannot be recalled there; Discord allows ${PUBLISHES_PER_HOUR} publishes per hour per channel. Asks the person in every mode.`,
		parameters: publishMessageSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			return [
				`Announcement channel: ${approvalArg(args, "channelId")}`,
				`Publish message: ${approvalArg(args, "messageId")}`,
				`Reaches every following server; at most ${PUBLISHES_PER_HOUR} publishes per hour per channel.`,
			];
		},
		async execute(_toolCallId: string, params: typeof publishMessageSchema.infer) {
			const token = await botToken();
			const channel = await channelOf(params.channelId, token);
			if (channel.type !== ANNOUNCEMENT) {
				throw new Error(
					`Channel ${channel.name ?? params.channelId} is not an announcement channel; only those can publish. Nothing was published.`,
				);
			}
			const published = await discordJson<Message>(
				`/channels/${encodeURIComponent(params.channelId)}/messages/${encodeURIComponent(params.messageId)}/crosspost`,
				token,
				"publish message",
				{ method: "POST" },
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Published message ${published.id} to followers.\n${permalink(channel.guild_id, params.channelId, published.id)}`,
					},
				],
			};
		},
	};
}

function createSetThreadTagsTool(): ToolDefinition<typeof setThreadTagsSchema> {
	return {
		name: "discord_set_thread_tags",
		label: "Discord: Set Post Tags",
		description:
			"Set a forum post's tags by name (replaces its tags; at most 5) — e.g. mark a help post Solved. The names must exist on the forum. Needs Manage Threads for posts the bot did not create.",
		parameters: setThreadTagsSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof setThreadTagsSchema.infer) {
			const token = await botToken();
			const thread = await channelOf(params.threadId, token);
			if (!THREAD_TYPES.has(thread.type) || !thread.parent_id) throw new Error(`${params.threadId} is not a thread.`);
			const parent = await channelOf(thread.parent_id, token);
			if (!FORUM_TYPES.has(parent.type)) throw new Error(`Thread ${params.threadId} is not a forum post; only forum posts carry tags.`);
			await discordJson<Channel>(
				`/channels/${encodeURIComponent(params.threadId)}`,
				token,
				"set post tags",
				jsonInit("PATCH", { applied_tags: tagIds(parent, params.tags) }),
			);
			return {
				content: [{ type: "text" as const, text: `Post ${params.threadId} now tagged: ${params.tags.join(", ") || "(no tags)"}.` }],
			};
		},
	};
}

function createCreateEventTool(): ToolDefinition<typeof createEventSchema> {
	return {
		name: "discord_create_event",
		label: "Discord: Create Event",
		description:
			"Schedule a server event (an AMA, a launch stream, office hours) in a voice or stage channel, or at an outside location with an end time. Members see it in the Events list. Needs Manage Events. Asks the person in every mode. Returns the event id and link.",
		parameters: createEventSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			const location = approvalArg(args, "location", "");
			return [
				`Server: ${approvalArg(args, "guildId")}`,
				`Event: ${approvalArg(args, "name")}`,
				`Starts: ${approvalArg(args, "startTime")}${approvalArg(args, "endTime", "") ? `  Ends: ${approvalArg(args, "endTime")}` : ""}`,
				location ? `Where: ${location}` : `Channel: ${approvalArg(args, "channelId")}`,
				`Description:\n${approvalArg(args, "description", "(none)")}`,
			];
		},
		async execute(_toolCallId: string, params: typeof createEventSchema.infer) {
			if (Boolean(params.channelId) === Boolean(params.location)) throw new Error("Give exactly one of channelId and location.");
			if (params.location && !params.endTime) throw new Error("An event at an outside location needs endTime.");
			if (Number.isNaN(Date.parse(params.startTime))) throw new Error(`startTime ${params.startTime} is not an ISO 8601 time.`);
			const token = await botToken();
			const where = params.channelId ? await channelOf(params.channelId, token) : undefined;
			if (where && where.type !== 2 && where.type !== 13) {
				throw new Error(`Channel ${where.name ?? params.channelId} is not a voice or stage channel.`);
			}
			const event = await discordJson<ScheduledEvent>(
				`/guilds/${encodeURIComponent(params.guildId)}/scheduled-events`,
				token,
				"create event",
				jsonInit("POST", {
					name: params.name,
					privacy_level: 2,
					scheduled_start_time: params.startTime,
					...(params.endTime ? { scheduled_end_time: params.endTime } : {}),
					...(params.description ? { description: params.description } : {}),
					...(where
						? { entity_type: where.type === 13 ? 1 : 2, channel_id: where.id }
						: { entity_type: 3, entity_metadata: { location: params.location } }),
				}),
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Event created (id ${event.id}).\nhttps://discord.com/events/${params.guildId}/${event.id}`,
					},
				],
			};
		},
	};
}

interface AutomodRule {
	readonly id: string;
	readonly name: string;
	readonly enabled?: boolean;
	readonly trigger_type: number;
	readonly trigger_metadata?: {
		readonly keyword_filter?: readonly string[];
		readonly presets?: readonly number[];
		readonly mention_total_limit?: number;
	};
	readonly actions?: readonly { readonly type: number; readonly metadata?: Record<string, unknown> }[];
}

const TRIGGER_TYPE: Readonly<Record<string, number>> = { keyword: 1, spam: 3, keyword_preset: 4, mention_spam: 5 };
const TRIGGER_NAME: Readonly<Record<number, string>> = { 1: "keyword", 3: "spam", 4: "keyword_preset", 5: "mention_spam", 6: "member_profile" };
const PRESET_TYPE: Readonly<Record<string, number>> = { profanity: 1, sexual_content: 2, slurs: 3 };
const ACTION_NAME: Readonly<Record<number, string>> = { 1: "block", 2: "alert", 3: "timeout", 4: "block member interaction" };

function createListAutomodRulesTool(): ToolDefinition<typeof listAutomodSchema> {
	return {
		name: "discord_list_automod_rules",
		label: "Discord: AutoMod Rules",
		description:
			"List a server's AutoMod rules: name, enabled, trigger (keyword, spam, keyword_preset, mention_spam), keyword count or mention limit, and actions. Needs Manage Server. The read before proposing a safety baseline.",
		parameters: listAutomodSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listAutomodSchema.infer) {
			const rules = await discordJson<AutomodRule[]>(
				`/guilds/${encodeURIComponent(params.guildId)}/auto-moderation/rules`,
				await botToken(),
				"list automod rules",
			);
			const text =
				rules.length === 0
					? "No AutoMod rules."
					: rules
							.map(rule => {
								const meta = rule.trigger_metadata;
								const detail = [
									meta?.keyword_filter?.length ? `${meta.keyword_filter.length} keywords` : null,
									meta?.presets?.length ? `presets ${meta.presets.join(",")}` : null,
									meta?.mention_total_limit ? `limit ${meta.mention_total_limit} mentions` : null,
								].filter(Boolean);
								const actions = (rule.actions ?? []).map(action => ACTION_NAME[action.type] ?? `action ${action.type}`);
								return `${rule.id}  ${rule.name}  [${rule.enabled === false ? "off" : "on"}]  ${TRIGGER_NAME[rule.trigger_type] ?? rule.trigger_type}${detail.length ? ` (${detail.join("; ")})` : ""}  → ${actions.join(", ") || "no action"}`;
							})
							.join("\n");
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

export function automodRuleBody(params: typeof createAutomodSchema.infer): Record<string, unknown> {
	const action = params.action ?? "block";
	if (action === "alert" && !params.alertChannelId) throw new Error("The alert action needs alertChannelId.");
	if (action === "timeout" && params.trigger !== "keyword" && params.trigger !== "mention_spam") {
		throw new Error("The timeout action applies to keyword and mention_spam rules only.");
	}
	if (params.trigger === "keyword" && !params.keywords?.length) throw new Error("A keyword rule needs keywords.");
	if (params.trigger === "keyword_preset" && !params.presets?.length) throw new Error("A keyword_preset rule needs presets.");
	if (params.trigger === "mention_spam" && !params.mentionLimit) throw new Error("A mention_spam rule needs mentionLimit.");
	const metadata =
		action === "alert"
			? { channel_id: params.alertChannelId }
			: action === "timeout"
				? { duration_seconds: Math.min(Math.max(Math.floor(params.timeoutSeconds ?? 60), 1), 2_419_200) }
				: {};
	return {
		name: params.name,
		event_type: 1,
		trigger_type: TRIGGER_TYPE[params.trigger],
		trigger_metadata:
			params.trigger === "keyword"
				? { keyword_filter: params.keywords }
				: params.trigger === "keyword_preset"
					? { presets: (params.presets ?? []).map(preset => PRESET_TYPE[preset]) }
					: params.trigger === "mention_spam"
						? { mention_total_limit: params.mentionLimit }
						: {},
		actions: [{ type: action === "block" ? 1 : action === "alert" ? 2 : 3, metadata }],
		enabled: true,
	};
}

function createCreateAutomodRuleTool(): ToolDefinition<typeof createAutomodSchema> {
	return {
		name: "discord_create_automod_rule",
		label: "Discord: Create AutoMod Rule",
		description:
			"Create one AutoMod rule the person approved (keyword list, spam filter, Discord's word presets, or a mention limit) with a block, alert or timeout action. Needs Manage Server. Asks the person in every mode. Read the existing rules with discord_list_automod_rules first; Discord allows 6 keyword rules per server.",
		parameters: createAutomodSchema,
		approval: PROMPT_EVERY_MODE,
		formatApprovalDetails(args: unknown) {
			const keywords = approvalList(args, "keywords");
			return [
				`Server: ${approvalArg(args, "guildId")}`,
				`Rule: ${approvalArg(args, "name")}`,
				`Trigger: ${approvalArg(args, "trigger")}${keywords.length ? ` (${keywords.join(", ")})` : ""}`,
				`Action: ${approvalArg(args, "action", "block")}`,
			];
		},
		async execute(_toolCallId: string, params: typeof createAutomodSchema.infer) {
			const rule = await discordJson<AutomodRule>(
				`/guilds/${encodeURIComponent(params.guildId)}/auto-moderation/rules`,
				await botToken(),
				"create automod rule",
				jsonInit("POST", automodRuleBody(params)),
			);
			return { content: [{ type: "text" as const, text: `AutoMod rule created (id ${rule.id}, "${rule.name}").` }] };
		},
	};
}

export default function discordExtension(pi: ExtensionAPI): void {
	pi.registerTool(createListGuildsTool());
	pi.registerTool(createListChannelsTool());
	pi.registerTool(createReadMessagesTool());
	pi.registerTool(createSendMessageTool());
	pi.registerTool(createCreateThreadTool());
	pi.registerTool(createReplyMessageTool());
	pi.registerTool(createAddReactionTool());
	pi.registerTool(createEditMessageTool());
	pi.registerTool(createDeleteMessageTool());
	pi.registerTool(createPinMessageTool());
	pi.registerTool(createCreateChannelTool());
	pi.registerTool(createTimeoutMemberTool());
	pi.registerTool(createListThreadsTool());
	pi.registerTool(createSearchMessagesTool());
	pi.registerTool(createGuildSnapshotTool());
	pi.registerTool(createCreateInviteTool());
	pi.registerTool(createPublishMessageTool());
	pi.registerTool(createSetThreadTagsTool());
	pi.registerTool(createCreateEventTool());
	pi.registerTool(createListAutomodRulesTool());
	pi.registerTool(createCreateAutomodRuleTool());
}
