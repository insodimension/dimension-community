// Telegram connector — send messages, read incoming updates, and inspect chats
// over the Telegram Bot API (https://core.telegram.org/bots/api). Authenticated
// via the plugin's `form` connect flow (see fraym.plugin.json): the flow writes
// {access} — the bot's HTTP API token from @BotFather — to CONFIG_TARGET. The
// token rides the URL PATH (`/bot<token>/METHOD`), so there is NO Authorization
// header. No Telegram SDK — plain fetch against the documented REST endpoints,
// matching the rest of this repo's connectors.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";

// MUST match `connect.configTarget` in fraym.plugin.json — the connect flow
// (packages/engine/src/plugin-connect.ts) writes the credential there; this is
// the ONLY other place that path is spelled out (JSON manifest can't share a
// TS constant with this file).
const CONFIG_TARGET = join(homedir(), ".config", "dimension-telegram", "token.json");
const API_ROOT = "https://api.telegram.org/bot";
// Keep tool output legible: cap each message body and the update batch so a
// chatty group never floods the transcript.
const MAX_TEXT_CHARS = 500;
const MAX_UPDATES = 100;

const storedCredential = type({
	// The engine's http-verify probe reads `access` from configTarget, so the
	// bot token MUST be stored under this key (see connect/token.template.json).
	access: "string",
});
type StoredCredential = typeof storedCredential.infer;

async function readCredential(): Promise<StoredCredential> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_TARGET, "utf-8");
	} catch {
		throw new Error(
			"Telegram isn't connected yet. Open the plugin's Connect dialog (Plugins → Telegram → Set up) and paste your bot token.",
		);
	}
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors) {
		throw new Error(`Telegram's stored credential at ${CONFIG_TARGET} is malformed. Reconnect the plugin.`);
	}
	return parsed;
}

interface TelegramResponse<T> {
	readonly ok: boolean;
	readonly result?: T;
	readonly description?: string;
	readonly error_code?: number;
}

/** Call a Bot API method. The token rides the URL path — no auth header. GET
 *  methods pass `query`; `sendMessage` passes a JSON `body`. Telegram always
 *  replies `{ok, result|description}`; a falsy `ok` (or a non-2xx) throws the
 *  human-readable `description`, with auth failures pointing at Reconnect. */
async function telegramCall<T>(
	token: string,
	method: string,
	options: { readonly query?: Record<string, string>; readonly body?: Record<string, unknown> },
): Promise<T> {
	const url = new URL(`${API_ROOT}${token}/${method}`);
	if (options.query) {
		for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, value);
	}
	const init: RequestInit | undefined = options.body
		? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) }
		: undefined;
	const res = await fetch(url, init);
	const payload = (await res.json().catch(() => null)) as TelegramResponse<T> | null;
	if (!payload) {
		throw new Error(`Telegram ${method} returned an unreadable response (HTTP ${res.status}).`);
	}
	if (!payload.ok || payload.result === undefined) {
		const detail = payload.description ?? res.statusText;
		if (res.status === 401 || payload.error_code === 401 || /unauthorized/i.test(detail)) {
			throw new Error(
				`Telegram rejected the bot token (${detail}). Reconnect the plugin: Plugins → Telegram → Reconnect.`,
			);
		}
		throw new Error(`Telegram ${method} failed: ${detail}`);
	}
	return payload.result;
}

function truncate(text: string): string {
	return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

interface TelegramChat {
	readonly id: number;
	readonly type: string;
	readonly title?: string;
	readonly username?: string;
	readonly description?: string;
	readonly first_name?: string;
	readonly last_name?: string;
}

interface TelegramUser {
	readonly id: number;
	readonly username?: string;
	readonly first_name?: string;
	readonly last_name?: string;
}

interface TelegramMessage {
	readonly message_id: number;
	readonly chat: TelegramChat;
	readonly from?: TelegramUser;
	readonly text?: string;
}

interface TelegramUpdate {
	readonly update_id: number;
	readonly message?: TelegramMessage;
	readonly edited_message?: TelegramMessage;
	readonly channel_post?: TelegramMessage;
}

function personLabel(user: TelegramUser | undefined): string {
	if (!user) return "unknown";
	if (user.username) return `@${user.username}`;
	const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
	return name || String(user.id);
}

function chatLabel(chat: TelegramChat): string {
	if (chat.title) return chat.title;
	const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
	return name || String(chat.id);
}

/** One argument off unvalidated tool args, for an approval card; `absent`
 *  stands in when it is not a string or number. Never throws: the card renders
 *  before the schema checks the call. Shown in full — Telegram caps a message
 *  at 4096 characters. */
function approvalArg(args: unknown, key: string, absent = "(missing)"): string {
	const value: unknown = typeof args === "object" && args !== null ? Reflect.get(args, key) : undefined;
	return typeof value === "string" || typeof value === "number" ? String(value) : absent;
}

const sendMessageSchema = type({
	chatId: type("string").describe(
		"Target chat: a numeric chat id (from telegram_get_updates), or a public @channelusername. A bot can only message users who have messaged it first.",
	),
	text: type("string").describe("The message text to send (plain text)."),
});

const getUpdatesSchema = type({
	"limit?": type("number").describe("Max updates to return, default 10, capped at 100."),
	"offset?": type("number").describe(
		"Return updates with update_id ≥ offset. Pass (last update_id + 1) to acknowledge and skip already-seen updates.",
	),
});

const getChatSchema = type({
	chatId: type("string").describe("A numeric chat id or a public @channelusername to look up."),
});

const replyMessageSchema = type({
	chatId: type("string").describe(
		"Target chat: a numeric chat id (from telegram_get_updates) or a public @channelusername where the message being replied to lives.",
	),
	messageId: type("number").describe(
		"The message_id to reply to (Telegram threads the new message under it). Get it from telegram_get_updates.",
	),
	text: type("string").describe("The reply text to send (plain text)."),
});

const editMessageSchema = type({
	chatId: type("string").describe("The chat id or @channelusername where the message lives."),
	messageId: type("number").describe(
		"The message_id to edit. A bot can ONLY edit its own messages — editing someone else's fails.",
	),
	text: type("string").describe("The new full text that replaces the message body (plain text)."),
});

const deleteMessageSchema = type({
	chatId: type("string").describe("The chat id or @channelusername where the message lives."),
	messageId: type("number").describe(
		"The message_id to delete. The bot can delete its OWN messages any time; other users' messages only within 48h of posting and only if the bot has 'delete messages' admin rights in the group.",
	),
});

const pinMessageSchema = type({
	chatId: type("string").describe("The chat id or @channelusername where the message lives."),
	messageId: type("number").describe(
		"The message_id to pin (or unpin). Requires 'pin messages' admin rights in groups/channels.",
	),
	"disable_notification?": type("boolean").describe(
		"When true, pin silently without notifying all members. Ignored when unpin is true.",
	),
	"unpin?": type("boolean").describe("When true, UNPIN the message instead of pinning it."),
});

const sendPhotoSchema = type({
	chatId: type("string").describe(
		"Target chat: a numeric chat id (from telegram_get_updates) or a public @channelusername.",
	),
	photoUrl: type("string").describe(
		"An https:// URL to the photo (Telegram fetches it). Must be a direct image URL under 5MB; .jpg/.png/.gif work.",
	),
	"caption?": type("string").describe("Optional caption shown under the photo (0-1024 chars, plain text)."),
});

function createSendMessageTool(): ToolDefinition<typeof sendMessageSchema> {
	return {
		name: "telegram_send_message",
		label: "Telegram: Send Message",
		description:
			"Send a text message to a Telegram chat via the bot. DESTRUCTIVE. Returns the sent message_id.",
		parameters: sendMessageSchema,
		approval: "write",
		formatApprovalDetails(args: unknown) {
			return [`Chat: ${approvalArg(args, "chatId")}`, `Message:\n${approvalArg(args, "text")}`];
		},
		async execute(_toolCallId: string, params: typeof sendMessageSchema.infer) {
			const { access } = await readCredential();
			const message = await telegramCall<TelegramMessage>(access, "sendMessage", {
				body: { chat_id: params.chatId, text: params.text },
			});
			const text = `Sent to ${chatLabel(message.chat)} (chat ${message.chat.id}) — message_id ${message.message_id}.`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createGetUpdatesTool(): ToolDefinition<typeof getUpdatesSchema> {
	return {
		name: "telegram_get_updates",
		label: "Telegram: Get Updates",
		description:
			"Read recent incoming messages the bot has received (one per line: chat id/title, sender, text). Use this to discover a chat_id after someone messages the bot. Only works when NO webhook is set on the bot.",
		parameters: getUpdatesSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof getUpdatesSchema.infer) {
			const { access } = await readCredential();
			const limit = Math.min(Math.max(params.limit ?? 10, 1), MAX_UPDATES);
			const query: Record<string, string> = { limit: String(limit) };
			if (params.offset !== undefined) query.offset = String(params.offset);
			const updates = await telegramCall<TelegramUpdate[]>(access, "getUpdates", { query });
			if (updates.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No recent updates. A bot only receives messages after a user sends it /start (or it is added to a group). If you set a webhook, getUpdates stays empty until it is removed.",
						},
					],
				};
			}
			const lines = updates.map(update => {
				const msg = update.message ?? update.edited_message ?? update.channel_post;
				if (!msg) return `update ${update.update_id}: (non-message update)`;
				const body = msg.text ? truncate(msg.text) : "(no text)";
				return `[chat ${msg.chat.id} "${chatLabel(msg.chat)}"] ${personLabel(msg.from)}: ${body}`;
			});
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function createGetChatTool(): ToolDefinition<typeof getChatSchema> {
	return {
		name: "telegram_get_chat",
		label: "Telegram: Get Chat",
		description:
			"Look up a chat's details (title, type, username, description) by chat_id or @username. The bot must be a member of the chat.",
		parameters: getChatSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof getChatSchema.infer) {
			const { access } = await readCredential();
			const chat = await telegramCall<TelegramChat>(access, "getChat", { query: { chat_id: params.chatId } });
			const lines = [
				`id: ${chat.id}`,
				`type: ${chat.type}`,
				chat.title ? `title: ${chat.title}` : undefined,
				chat.username ? `username: @${chat.username}` : undefined,
				chat.first_name ? `name: ${[chat.first_name, chat.last_name].filter(Boolean).join(" ")}` : undefined,
				chat.description ? `description: ${truncate(chat.description)}` : undefined,
			].filter(Boolean);
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	};
}

function createReplyMessageTool(): ToolDefinition<typeof replyMessageSchema> {
	return {
		name: "telegram_reply_message",
		label: "Telegram: Reply to Message",
		description:
			"Reply to a specific message in a chat (threads under the original via reply_parameters). DESTRUCTIVE. Returns the sent message_id.",
		parameters: replyMessageSchema,
		approval: "write",
		formatApprovalDetails(args: unknown) {
			return [
				`Chat: ${approvalArg(args, "chatId")}`,
				`Reply to message: ${approvalArg(args, "messageId")}`,
				`Message:\n${approvalArg(args, "text")}`,
			];
		},
		async execute(_toolCallId: string, params: typeof replyMessageSchema.infer) {
			const { access } = await readCredential();
			const message = await telegramCall<TelegramMessage>(access, "sendMessage", {
				body: { chat_id: params.chatId, text: params.text, reply_parameters: { message_id: params.messageId } },
			});
			const text = `Replied in ${chatLabel(message.chat)} (chat ${message.chat.id}) to message ${params.messageId} — new message_id ${message.message_id}.`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createEditMessageTool(): ToolDefinition<typeof editMessageSchema> {
	return {
		name: "telegram_edit_message",
		label: "Telegram: Edit Message",
		description:
			"Replace the text of a message the bot ITSELF sent (editMessageText). A bot cannot edit other users' messages. DESTRUCTIVE. Returns the edited message_id.",
		parameters: editMessageSchema,
		approval: "write",
		formatApprovalDetails(args: unknown) {
			return [
				`Chat: ${approvalArg(args, "chatId")}`,
				`Edit message: ${approvalArg(args, "messageId")}`,
				`New text:\n${approvalArg(args, "text")}`,
			];
		},
		async execute(_toolCallId: string, params: typeof editMessageSchema.infer) {
			const { access } = await readCredential();
			const message = await telegramCall<TelegramMessage>(access, "editMessageText", {
				body: { chat_id: params.chatId, message_id: params.messageId, text: params.text },
			});
			const text = `Edited message ${message.message_id} in ${chatLabel(message.chat)} (chat ${message.chat.id}).`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createDeleteMessageTool(): ToolDefinition<typeof deleteMessageSchema> {
	return {
		name: "telegram_delete_message",
		label: "Telegram: Delete Message",
		description:
			"Delete a message from a chat (deleteMessage). IRREVERSIBLE — the message is gone for everyone. The bot can delete its OWN messages any time; other users' messages only within 48h of posting and only with 'delete messages' admin rights in the group. Returns confirmation.",
		parameters: deleteMessageSchema,
		approval: "write",
		formatApprovalDetails(args: unknown) {
			return [`Chat: ${approvalArg(args, "chatId")}`, `Delete message: ${approvalArg(args, "messageId")}`];
		},
		async execute(_toolCallId: string, params: typeof deleteMessageSchema.infer) {
			const { access } = await readCredential();
			await telegramCall<boolean>(access, "deleteMessage", {
				body: { chat_id: params.chatId, message_id: params.messageId },
			});
			const text = `Deleted message ${params.messageId} from chat ${params.chatId}.`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

function createPinMessageTool(): ToolDefinition<typeof pinMessageSchema> {
	return {
		name: "telegram_pin_message",
		label: "Telegram: Pin Message",
		description:
			"Pin a message to the top of a chat (pinChatMessage), or unpin it when unpin=true (unpinChatMessage). In groups/channels the bot needs 'pin messages' admin rights. Returns confirmation.",
		parameters: pinMessageSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof pinMessageSchema.infer) {
			const { access } = await readCredential();
			if (params.unpin) {
				await telegramCall<boolean>(access, "unpinChatMessage", {
					body: { chat_id: params.chatId, message_id: params.messageId },
				});
				return {
					content: [
						{ type: "text" as const, text: `Unpinned message ${params.messageId} in chat ${params.chatId}.` },
					],
				};
			}
			const body: Record<string, unknown> = { chat_id: params.chatId, message_id: params.messageId };
			if (params.disable_notification !== undefined) body.disable_notification = params.disable_notification;
			await telegramCall<boolean>(access, "pinChatMessage", { body });
			return {
				content: [{ type: "text" as const, text: `Pinned message ${params.messageId} in chat ${params.chatId}.` }],
			};
		},
	};
}

function createSendPhotoTool(): ToolDefinition<typeof sendPhotoSchema> {
	return {
		name: "telegram_send_photo",
		label: "Telegram: Send Photo",
		description:
			"Send a photo to a chat by https:// URL (sendPhoto), with an optional caption. DESTRUCTIVE. Returns the sent message_id.",
		parameters: sendPhotoSchema,
		approval: "write",
		formatApprovalDetails(args: unknown) {
			return [
				`Chat: ${approvalArg(args, "chatId")}`,
				`Photo: ${approvalArg(args, "photoUrl")}`,
				`Caption:\n${approvalArg(args, "caption", "(none)")}`,
			];
		},
		async execute(_toolCallId: string, params: typeof sendPhotoSchema.infer) {
			const { access } = await readCredential();
			const body: Record<string, unknown> = { chat_id: params.chatId, photo: params.photoUrl };
			if (params.caption !== undefined) body.caption = params.caption;
			const message = await telegramCall<TelegramMessage>(access, "sendPhoto", { body });
			const text = `Sent photo to ${chatLabel(message.chat)} (chat ${message.chat.id}) — message_id ${message.message_id}.`;
			return { content: [{ type: "text" as const, text }] };
		},
	};
}

/**
 * Telegram plugin. A standard OMP plugin — `skills/`/`rules/` load via OMP's
 * native plugin discovery. This module registers the eight Bot API tools; the
 * connect flow (fraym.plugin.json's `connect.form`) is what stores the bot
 * token these tools read.
 */
export default function telegramExtension(pi: ExtensionAPI): void {
	pi.registerTool(createSendMessageTool());
	pi.registerTool(createGetUpdatesTool());
	pi.registerTool(createGetChatTool());
	pi.registerTool(createReplyMessageTool());
	pi.registerTool(createEditMessageTool());
	pi.registerTool(createDeleteMessageTool());
	pi.registerTool(createPinMessageTool());
	pi.registerTool(createSendPhotoTool());
}
