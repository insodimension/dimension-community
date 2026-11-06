import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";

const home = await mkdtemp(join(tmpdir(), "dimension-discord-"));
await mkdir(join(home, ".config", "dimension-discord"), { recursive: true });
await writeFile(join(home, ".config", "dimension-discord", "token.json"), JSON.stringify({ access: "bot-token" }));
const priorHome = process.env.HOME;
const priorUserProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
const { default: discordExtension, automodRuleBody } = await import("../index.ts?discord-tools");
if (priorHome === undefined) delete process.env.HOME;
else process.env.HOME = priorHome;
if (priorUserProfile === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = priorUserProfile;

interface Call {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
	readonly form?: FormData;
}

interface Tool {
	name: string;
	approval?: unknown;
	formatApprovalDetails?: (args: unknown) => string[];
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
}

const tools = new Map<string, Tool>();
discordExtension({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never);

function tool(name: string): Tool {
	const found = tools.get(name);
	if (!found) throw new Error(`discord did not register ${name}`);
	return found;
}

const realFetch = globalThis.fetch;
let calls: Call[] = [];

const CHANNELS: Record<string, unknown> = {
	"/channels/text-1": { id: "text-1", name: "general", type: 0, guild_id: "guild-1" },
	"/channels/news-1": { id: "news-1", name: "announcements", type: 5, guild_id: "guild-1" },
	"/channels/forum-1": {
		id: "forum-1",
		name: "help",
		type: 15,
		guild_id: "guild-1",
		available_tags: [
			{ id: "tag-q", name: "Question" },
			{ id: "tag-s", name: "Solved" },
		],
	},
	"/channels/post-1": { id: "post-1", name: "crash on start", type: 11, guild_id: "guild-1", parent_id: "forum-1" },
};

function stub(answer: (call: Call) => Response | undefined = () => undefined): void {
	calls = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const path = url.pathname.replace("/api/v10", "");
		const form = init?.body instanceof FormData ? init.body : undefined;
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		const call: Call = { method: init?.method ?? "GET", path: `${path}${url.search}`, body, ...(form ? { form } : {}) };
		calls.push(call);
		const custom = answer(call);
		if (custom) return custom;
		if (call.method === "GET" && CHANNELS[path]) return Response.json(CHANNELS[path]);
		if (call.method === "POST" && path.endsWith("/messages")) return Response.json({ id: "msg-new", content: "", timestamp: "" });
		if (call.method === "POST" && path.endsWith("/threads")) return Response.json({ id: "thread-new", name: "t", type: 11 });
		if (call.method === "PATCH") return Response.json({ id: "post-1", type: 11 });
		throw new Error(`unexpected ${call.method} ${call.path}`);
	}) as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

afterAll(async () => {
	await rm(home, { recursive: true, force: true });
});

function yolo(name: string): string {
	return resolveApproval(tool(name) as Parameters<typeof resolveApproval>[0], {}, "yolo").policy;
}

test.each([
	"discord_send_message",
	"discord_reply_message",
	"discord_create_thread",
	"discord_edit_message",
	"discord_delete_message",
	"discord_timeout_member",
	"discord_create_invite",
	"discord_publish_message",
	"discord_create_event",
	"discord_create_automod_rule",
])("%s asks the person even in yolo mode", name => {
	expect(yolo(name)).toBe("prompt");
});

test.each(["discord_add_reaction", "discord_pin_message", "discord_set_thread_tags"])(
	"%s stays auto-approved in yolo mode",
	name => {
		expect(yolo(name)).toBe("allow");
	},
);

test("a send pings nobody unless the person named users, and returns the message's permalink", async () => {
	stub();
	const result = await tool("discord_send_message").execute("c", { channelId: "text-1", content: "@everyone shipped" });
	const post = calls.find(call => call.method === "POST");
	expect(post?.body).toMatchObject({
		content: "@everyone shipped",
		allowed_mentions: { parse: [], users: [], replied_user: false },
	});
	expect(result.content[0]?.text).toContain("https://discord.com/channels/guild-1/text-1/msg-new");

	stub();
	await tool("discord_send_message").execute("c", { channelId: "text-1", content: "thanks <@42>", mentionUserIds: ["42"] });
	expect(calls.find(call => call.method === "POST")?.body).toMatchObject({ allowed_mentions: { parse: [], users: ["42"] } });
});

test("a reply notifies the replied-to author by default and nobody else", async () => {
	stub();
	await tool("discord_reply_message").execute("c", { channelId: "text-1", messageId: "m-9", content: "fixed in 1.2" });
	expect(calls.find(call => call.method === "POST")?.body).toMatchObject({
		message_reference: { message_id: "m-9" },
		allowed_mentions: { parse: [], users: [], replied_user: true },
	});
});

test("the approval card says who is pinged", () => {
	expect(tool("discord_send_message").formatApprovalDetails?.({ channelId: "c", content: "hi" }).join("\n")).toContain(
		"Pings: none",
	);
	expect(
		tool("discord_send_message")
			.formatApprovalDetails?.({ channelId: "c", content: "hi", mentionUserIds: ["42"] })
			.join("\n"),
	).toContain("only users 42");
});

test("the AutoMod approval card shows what the rule will do: the clamped timeout, the alert channel, presets and the mention limit", () => {
	const card = (args: Record<string, unknown>) =>
		tool("discord_create_automod_rule")
			.formatApprovalDetails?.({ guildId: "g", name: "r", ...args })
			.join("\n") ?? "";
	expect(card({ trigger: "keyword", keywords: ["spam.link"], action: "timeout", timeoutSeconds: 9_999_999 })).toContain(
		"2419200 seconds",
	);
	expect(card({ trigger: "keyword", keywords: ["spam.link"], action: "timeout" })).toContain("60 seconds");
	expect(card({ trigger: "keyword", keywords: ["spam.link"], action: "alert", alertChannelId: "mods-7" })).toContain("mods-7");
	expect(card({ trigger: "keyword_preset", presets: ["slurs", "profanity"] })).toContain("slurs, profanity");
	expect(card({ trigger: "mention_spam", mentionLimit: 5 })).toContain("5");
	expect(card({ trigger: "spam", action: "timeout" })).toContain("keyword and mention_spam");
});

test("a message over 2000 characters is refused before anything is sent", async () => {
	stub();
	await expect(
		tool("discord_send_message").execute("c", { channelId: "text-1", content: "x".repeat(2001) }),
	).rejects.toThrow("2000");
	expect(calls).toHaveLength(0);
});

test("one image goes as a multipart upload beside the JSON payload; a non-image is refused", async () => {
	const image = join(home, "shot.png");
	await writeFile(image, new Uint8Array([137, 80, 78, 71]));
	stub();
	await tool("discord_send_message").execute("c", { channelId: "text-1", content: "look", imagePath: image });
	const form = calls.find(call => call.method === "POST")?.form;
	expect(JSON.parse(String(form?.get("payload_json")))).toMatchObject({
		content: "look",
		attachments: [{ id: 0, filename: "shot.png" }],
		allowed_mentions: { parse: [] },
	});
	expect((form?.get("files[0]") as File).name).toBe("shot.png");

	const notImage = join(home, "notes.txt");
	await writeFile(notImage, "text");
	stub();
	await expect(
		tool("discord_send_message").execute("c", { channelId: "text-1", content: "look", imagePath: notImage }),
	).rejects.toThrow("not a PNG");
	expect(calls.some(call => call.method === "POST")).toBe(false);
});

test("reading a channel prints ids, the author's id, reply refs, threads, reactions, attachments and a permalink, and pages", async () => {
	stub(call =>
		call.path.startsWith("/channels/text-1/messages")
			? Response.json([
					{
						id: "m-2",
						channel_id: "text-1",
						content: "does it work on linux?",
						timestamp: "2026-11-05T10:00:00Z",
						author: { id: "u-7", username: "dana" },
						message_reference: { message_id: "m-1" },
						reactions: [{ count: 3, emoji: { name: "👍" } }],
						attachments: [{ filename: "log.txt" }],
						thread: { id: "th-1", name: "linux", message_count: 4 },
					},
				])
			: undefined,
	);
	const result = await tool("discord_read_messages").execute("c", { channelId: "text-1", before: "m-9" });
	const text = result.content[0]?.text ?? "";
	expect(calls.find(call => call.path.startsWith("/channels/text-1/messages"))?.path).toContain("before=m-9");
	for (const piece of [
		"m-2",
		"dana (u-7)",
		"reply-to m-1",
		'thread th-1 "linux" 4 msgs',
		"reactions 👍3",
		"attachments 1",
		"https://discord.com/channels/guild-1/text-1/m-2",
		'before: "m-2"',
	]) {
		expect(text).toContain(piece);
	}
	await expect(tool("discord_read_messages").execute("c", { channelId: "text-1", before: "a", after: "b" })).rejects.toThrow(
		"at most one",
	);
});

test("a thread in a forum is a post with a first message and tag ids; an unknown tag is refused before posting", async () => {
	stub();
	await tool("discord_create_thread").execute("c", {
		channelId: "forum-1",
		name: "Crash on start",
		content: "Steps to reproduce…",
		tags: ["question"],
	});
	expect(calls.find(call => call.method === "POST")?.body).toEqual({
		name: "Crash on start",
		message: { content: "Steps to reproduce…", allowed_mentions: { parse: [], users: [], replied_user: false } },
		applied_tags: ["tag-q"],
	});

	stub();
	await expect(
		tool("discord_create_thread").execute("c", { channelId: "forum-1", name: "x", content: "y", tags: ["Bug"] }),
	).rejects.toThrow("Question, Solved");
	expect(calls.some(call => call.method === "POST")).toBe(false);
});

test("a thread in a text channel stays a public thread and refuses forum-only fields", async () => {
	stub();
	await tool("discord_create_thread").execute("c", { channelId: "text-1", name: "release" });
	expect(calls.find(call => call.method === "POST")?.body).toEqual({ name: "release", type: 11 });
	await expect(
		tool("discord_create_thread").execute("c", { channelId: "text-1", name: "x", content: "y" }),
	).rejects.toThrow("forum posts only");
});

test("marking a post Solved sends the forum's tag ids", async () => {
	stub();
	await tool("discord_set_thread_tags").execute("c", { threadId: "post-1", tags: ["Question", "Solved"] });
	expect(calls.find(call => call.method === "PATCH")?.body).toEqual({ applied_tags: ["tag-q", "tag-s"] });
});

test("search that hits a cold index says to retry once instead of failing", async () => {
	stub(call =>
		call.path.includes("/messages/search") ? Response.json({ code: 110000, retry_after: 3 }, { status: 202 }) : undefined,
	);
	const result = await tool("discord_search_messages").execute("c", { guildId: "guild-1", content: "linux" });
	expect(result.content[0]?.text).toContain("Retry once in 3 seconds");
});

test("search prints the total, the hits and the next offset", async () => {
	stub(call =>
		call.path.includes("/messages/search")
			? Response.json({
					total_results: 30,
					messages: [[{ id: "m-5", channel_id: "text-1", content: "linux build", timestamp: "t", author: { id: "u-1" } }]],
				})
			: undefined,
	);
	const result = await tool("discord_search_messages").execute("c", { guildId: "guild-1", content: "linux" });
	const text = result.content[0]?.text ?? "";
	expect(calls[0]?.path).toContain("content=linux");
	expect(text).toContain("30 matching message(s)");
	expect(text).toContain("https://discord.com/channels/guild-1/text-1/m-5");
	expect(text).toContain("offset: 1");
});

test("publishing refuses a channel that is not an announcement channel", async () => {
	stub();
	await expect(tool("discord_publish_message").execute("c", { channelId: "text-1", messageId: "m-1" })).rejects.toThrow(
		"not an announcement channel",
	);
	expect(calls.some(call => call.path.endsWith("/crosspost"))).toBe(false);
});

test("the snapshot reports a part the bot cannot read as unknown instead of failing", async () => {
	stub(call => {
		if (call.path.startsWith("/guilds/guild-1?")) {
			return Response.json({
				name: "Dimension",
				approximate_member_count: 120,
				approximate_presence_count: 14,
				features: ["COMMUNITY"],
				verification_level: 1,
				explicit_content_filter: 2,
				mfa_level: 1,
				rules_channel_id: "r-1",
			});
		}
		if (call.path === "/guilds/guild-1/invites") return Response.json({ message: "Missing Permissions" }, { status: 403 });
		if (call.path.startsWith("/guilds/guild-1/scheduled-events")) {
			return Response.json([{ id: "e-1", name: "AMA", scheduled_start_time: "2026-11-20T17:00:00Z", user_count: 9 }]);
		}
		if (call.path === "/guilds/guild-1/onboarding") return Response.json({ enabled: true });
		return undefined;
	});
	const text = (await tool("discord_guild_snapshot").execute("c", { guildId: "guild-1" })).content[0]?.text ?? "";
	expect(text).toContain("Members: 120  Online: 14");
	expect(text).toContain("[x] Community on");
	expect(text).toContain("[ ] listed in Server Discovery");
	expect(text).toMatch(/Invites[^\n]*\n {2}unknown: .*403/);
	expect(text).toContain("AMA  2026-11-20T17:00:00Z  9 interested");
});

test("an AutoMod rule is built from the person's choices and refuses a combination Discord would reject", () => {
	expect(
		automodRuleBody({ guildId: "g", name: "invite spam", trigger: "keyword", keywords: ["discord.gg/*"], action: "alert", alertChannelId: "mods" }),
	).toEqual({
		name: "invite spam",
		event_type: 1,
		trigger_type: 1,
		trigger_metadata: { keyword_filter: ["discord.gg/*"] },
		actions: [{ type: 2, metadata: { channel_id: "mods" } }],
		enabled: true,
	});
	expect(() => automodRuleBody({ guildId: "g", name: "spam", trigger: "spam", action: "timeout" })).toThrow(
		"keyword and mention_spam",
	);
	expect(() => automodRuleBody({ guildId: "g", name: "words", trigger: "keyword" })).toThrow("needs keywords");
});
