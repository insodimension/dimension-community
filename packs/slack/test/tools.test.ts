import { expect, test } from "bun:test";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { type CredentialStore, SlackSignInError, type StoredCredential } from "../credential";
import { type McpClient, McpRequestError, type McpTool } from "../mcp-client";
import { createNativeRoutes, type NativeRoutes } from "../native-routes";
import {
	approvalDetails,
	createSlackActTool,
	createSlackReadTool,
	createSlackToolsTool,
	createToolCatalog,
	type SlackCallTool,
} from "../tools";
import { SlackApiError, type WebApiClient } from "../web-api";

const SEARCH: McpTool = {
	name: "slack_search_public",
	description: "Search public channels\nLong second line",
	inputSchema: { type: "object", properties: { query: { type: "string" } } },
	annotations: { readOnlyHint: true },
};
const SEND: McpTool = { name: "slack_send_message", description: "Send a message", annotations: {} };
const UNLABELLED_READ: McpTool = { name: "slack_read_channel", description: "Read a channel", annotations: {} };
const SCHEDULE: McpTool = { name: "slack_schedule_message", description: "Schedule a message", annotations: {} };
const REACT: McpTool = { name: "slack_add_reaction", description: "Add a reaction", annotations: {} };

const NO_CONTEXT = {} as Parameters<ToolDefinition["execute"]>[4];

interface Harness {
	readonly calls: { readonly name: string; readonly args: Record<string, unknown> }[];
	readonly web: { readonly method: string; readonly params: Record<string, unknown> }[];
	readonly listings: { count: number };
	readonly clock: { now: number };
	readonly deps: Parameters<typeof createSlackActTool>[0];
}

function harness(
	options: {
		readonly tools?: readonly McpTool[];
		readonly credential?: StoredCredential;
		readonly callTool?: McpClient["callTool"];
		readonly web?: WebApiClient["call"];
		readonly routes?: NativeRoutes;
	} = {},
): Harness {
	const calls: Harness["calls"] = [];
	const web: Harness["web"] = [];
	const listings = { count: 0 };
	const clock = { now: 0 };
	const client: McpClient = {
		async listTools() {
			listings.count += 1;
			return [...(options.tools ?? [SEARCH, SEND, UNLABELLED_READ])];
		},
		callTool:
			options.callTool ??
			(async (name, args) => {
				calls.push({ name, args });
				return { text: `ran ${name}`, isError: false };
			}),
	};
	const credential: StoredCredential = options.credential ?? { access: "xoxp-1", scopes: ["chat:write"] };
	const store: CredentialStore = {
		peek: () => credential,
		accessToken: async () => credential.access,
		renewRejected: async () => credential.access,
	};
	return {
		calls,
		web,
		listings,
		clock,
		deps: {
			client,
			store,
			catalog: createToolCatalog(client, () => clock.now),
			identity: { label: () => "ada in Acme", warm: async () => undefined },
			api: {
				call: async (method, params, signal) => {
					web.push({ method, params });
					if (!options.web) throw new Error(`unexpected Web API call ${method}`);
					return options.web(method, params, signal);
				},
			},
			routes: options.routes ?? new Map(),
		},
	};
}

function textOf(result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string {
	return result.content[0]?.text ?? "";
}

function run(tool: SlackCallTool, params: Parameters<SlackCallTool["execute"]>[1], signal?: AbortSignal) {
	return tool.execute("c", params, signal, undefined, NO_CONTEXT);
}

const policyInYolo = (tool: ToolDefinition<never>, args: unknown) =>
	resolveApproval(tool as Parameters<typeof resolveApproval>[0], args, "yolo").policy;

test("slack_read refuses a tool Slack does not mark read-only, without calling it", async () => {
	const { deps, calls } = harness();
	const read = createSlackReadTool(deps);

	await expect(run(read, { tool: "slack_send_message", arguments: {} })).rejects.toThrow(
		"cannot run through slack_read",
	);
	await expect(run(read, { tool: "slack_read_channel" })).rejects.toThrow("cannot run through slack_read");
	expect(calls).toEqual([]);
});

test("slack_read runs a read-only tool with the arguments it was given", async () => {
	const { deps, calls } = harness();

	const result = await run(createSlackReadTool(deps), {
		tool: "slack_search_public",
		arguments: { query: "launch" },
	});

	expect(textOf(result)).toBe("ran slack_search_public");
	expect(calls).toEqual([{ name: "slack_search_public", args: { query: "launch" } }]);
});

test("slack_act runs a write tool", async () => {
	const { deps, calls } = harness();

	await run(createSlackActTool(deps), {
		tool: "slack_send_message",
		arguments: { channel: "C1", text: "hi" },
	});

	expect(calls).toEqual([{ name: "slack_send_message", args: { channel: "C1", text: "hi" } }]);
});

test("sending as the user is a write: it asks in Ask mode and passes in Write and Full access, and reading never asks", () => {
	const { deps } = harness();
	const send = { tool: "slack_send_message", arguments: {} };
	const policyIn = (mode: "always-ask" | "write" | "yolo") =>
		resolveApproval(createSlackActTool(deps) as Parameters<typeof resolveApproval>[0], send, mode).policy;

	expect([policyIn("always-ask"), policyIn("write"), policyIn("yolo")]).toEqual(["prompt", "allow", "allow"]);
	expect(policyInYolo(createSlackReadTool(deps), { tool: "slack_search_public" })).toBe("allow");
	expect(policyInYolo(createSlackToolsTool(deps), {})).toBe("allow");
});

test("the approval card carries the tool, the account, and every argument in full", () => {
	const text = "line one\nline two with the whole message";

	const card = approvalDetails(
		{ label: () => "ada in Acme", warm: async () => undefined },
		{
			tool: "slack_send_message",
			arguments: { channel: "C1", text, thread_ts: "1700000000.000100" },
		},
	);

	expect(card).toEqual([
		"Slack tool: slack_send_message",
		"As: ada in Acme",
		"channel: C1",
		`text: ${text}`,
		"thread_ts: 1700000000.000100",
	]);
});

test("the approval card says so when the account is not known yet, caps a huge value, and survives malformed arguments", () => {
	const unknown = { label: () => undefined, warm: async () => undefined };

	const huge = approvalDetails(unknown, { tool: "slack_send_message", arguments: { text: "x".repeat(5_000) } });
	expect(huge[1]).toBe("As: you (the signed-in Slack account)");
	expect(huge[2]).toContain("[...1000 more chars]");

	expect(approvalDetails(unknown, null)).toEqual(["Slack tool: (missing)", "As: you (the signed-in Slack account)"]);
	expect(approvalDetails(unknown, { tool: 5, arguments: "nope" })).toEqual([
		"Slack tool: (missing)",
		"As: you (the signed-in Slack account)",
	]);
});

test("a read-only connection refuses a write tool before anything is sent, and one with no recorded scopes or a write scope proceeds", async () => {
	const readOnly = harness({ credential: { access: "a", scopes: ["channels:history", "search:read.public"] } });
	await expect(run(createSlackActTool(readOnly.deps), { tool: "slack_send_message", arguments: {} })).rejects.toThrow(
		"authorized read-only",
	);
	expect(readOnly.calls).toEqual([]);

	for (const credential of [{ access: "a" }, { access: "a", scopes: ["chat:write"] }]) {
		const connected = harness({ credential });
		await run(createSlackActTool(connected.deps), { tool: "slack_send_message", arguments: {} });
		expect(connected.calls).toHaveLength(1);
	}
});

test("an unknown tool name triggers one refresh of the tool list and then names the tools Slack does have", async () => {
	const { deps, listings } = harness();

	await expect(run(createSlackReadTool(deps), { tool: "slack_teleport" })).rejects.toThrow(
		'no tool named "slack_teleport". Its tools: slack_search_public, slack_send_message, slack_read_channel',
	);

	expect(listings.count).toBe(2);
});

test("the tool list is cached until it expires or a refresh is asked for", async () => {
	const { deps, listings, clock } = harness();
	const read = createSlackReadTool(deps);
	const search = { tool: "slack_search_public" };

	await run(read, search);
	await run(read, search);
	expect(listings.count).toBe(1);

	await createSlackToolsTool(deps).execute("c", { refresh: true }, undefined, undefined, NO_CONTEXT);
	expect(listings.count).toBe(2);

	clock.now += 301_000;
	await run(read, search);
	expect(listings.count).toBe(3);
});

test("slack_tools lists read tools before write tools with their kind, and describes one tool with its schema", async () => {
	const { deps } = harness();
	const tools = createSlackToolsTool(deps);

	const listing = textOf(await tools.execute("c", {}, undefined, undefined, NO_CONTEXT));
	expect(listing.split("\n").slice(1)).toEqual([
		"- [read] slack_search_public — Search public channels",
		"- [write] slack_read_channel — Read a channel",
		"- [write] slack_send_message — Send a message",
	]);

	const detail = textOf(await tools.execute("c", { tool: "slack_search_public" }, undefined, undefined, NO_CONTEXT));
	expect(detail).toContain("slack_search_public (read)");
	expect(detail).toContain('"properties":{"query":{"type":"string"}}');
});

test("Slack's refusals reach the agent as actionable errors", async () => {
	const unauthorized = harness({
		callTool: async () => {
			throw new McpRequestError("Slack's MCP server answered 401: expired", 401);
		},
	});
	const read = createSlackReadTool(unauthorized.deps);
	const attempt = () => run(read, { tool: "slack_search_public" });
	await expect(attempt()).rejects.toBeInstanceOf(SlackSignInError);
	await expect(attempt()).rejects.toThrow("Slack MCP Server is switched on");

	const forbidden = harness({
		callTool: async () => {
			throw new McpRequestError("Slack's MCP server answered 403: nope", 403);
		},
	});
	await expect(run(createSlackReadTool(forbidden.deps), { tool: "slack_search_public" })).rejects.toThrow(
		"may not have approved the Dimension app",
	);

	const failing = harness({ callTool: async () => ({ text: "channel_not_found", isError: true }) });
	await expect(run(createSlackActTool(failing.deps), { tool: "slack_send_message", arguments: {} })).rejects.toThrow(
		"Slack slack_send_message failed: channel_not_found",
	);
});

test.each([
	["slack_read", createSlackReadTool, "slack_search_public"],
	["slack_act", createSlackActTool, "slack_send_message"],
] as const)(
	"cancelling %s stops waiting for Slack instead of letting the request run on",
	async (_name, create, tool) => {
		const controller = new AbortController();
		const cancelled = new Error("cancelled");
		let reachedSlack = false;
		const { deps } = harness({
			callTool: (_toolName, _args, signal) => {
				reachedSlack = true;
				const answer = Promise.withResolvers<{ text: string; isError: boolean }>();
				if (!signal) answer.resolve({ text: "Slack answered anyway", isError: false });
				else if (signal.aborted) answer.reject(cancelled);
				else signal.addEventListener("abort", () => answer.reject(cancelled), { once: true });
				return answer.promise;
			},
		});

		const pending = run(create(deps), { tool, arguments: {} }, controller.signal);
		controller.abort();

		await expect(pending).rejects.toBe(cancelled);
		expect(reachedSlack).toBe(true);
	},
);

test("slack_tools describes a tool Slack added after the list was cached, as slack_read and slack_act already do", async () => {
	const tools: McpTool[] = [SEARCH];
	const { deps, listings } = harness({ tools });
	const catalog = createSlackToolsTool(deps);
	await catalog.execute("c", {}, undefined, undefined, NO_CONTEXT);
	tools.push(SEND);

	const described = await catalog.execute("c", { tool: "slack_send_message" }, undefined, undefined, NO_CONTEXT);

	expect(textOf(described)).toContain("slack_send_message");
	expect(listings.count).toBe(2);
});

const ROUTED_TOOLS = [SEARCH, SEND, SCHEDULE, REACT];

const slackWorkspace: WebApiClient["call"] = async (method, params) => {
	switch (method) {
		case "conversations.info":
			return { ok: true, channel: { id: params.channel, is_ext_shared: false, is_pending_ext_shared: false } };
		case "chat.postMessage":
			return { ok: true, ts: "1700000000.000100" };
		case "chat.getPermalink":
			return { ok: true, permalink: "https://acme.slack.com/archives/C0123ABC/p1700000000000100" };
		case "chat.scheduleMessage":
			return { ok: true, scheduled_message_id: "Q0123ABC" };
		default:
			throw new Error(`unexpected Web API call ${method}`);
	}
};

test.each([
	["slack_send_message", { channel_id: "C0123ABC", message: "hello" }, "chat.postMessage", "Message sent."],
	[
		"slack_schedule_message",
		{ channel_id: "C0123ABC", message: "hello", post_at: 1_900_000_000 },
		"chat.scheduleMessage",
		"Message scheduled.",
	],
] as const)(
	"slack_act runs %s through the Web API and never through Slack's MCP server, whose send tools append a footer",
	async (tool, args, method, reported) => {
		const { deps, calls, web } = harness({ tools: ROUTED_TOOLS, routes: createNativeRoutes(), web: slackWorkspace });

		const result = await run(createSlackActTool(deps), { tool, arguments: args });

		expect(calls).toEqual([]);
		expect(web.find(call => call.method === method)?.params).toMatchObject({
			channel: "C0123ABC",
			markdown_text: "hello",
		});
		expect(textOf(result)).toContain(reported);
	},
);

test.each([
	[
		"Slack refusing the post",
		{ channel_id: "C0123ABC", message: "hello" },
		async (method: string) => {
			if (method === "chat.postMessage") throw new SlackApiError(method, "not_in_channel");
			return slackWorkspace(method, {});
		},
		"not_in_channel",
	],
	[
		"a conversation shared outside the workspace",
		{ channel_id: "C0123ABC", message: "hello" },
		async (method: string) =>
			method === "conversations.info" ? { ok: true, channel: { is_ext_shared: true } } : slackWorkspace(method, {}),
		"Slack Connect",
	],
	["a draft to delete", { channel_id: "C0123ABC", message: "hello", draft_id: "Dr0123" }, slackWorkspace, "draft_id"],
] as const)(
	"slack_act reports %s as an error and does not retry the send through Slack's MCP server",
	async (_name, args, answer, wording) => {
		const { deps, calls } = harness({ tools: ROUTED_TOOLS, routes: createNativeRoutes(), web: answer });

		await expect(run(createSlackActTool(deps), { tool: "slack_send_message", arguments: args })).rejects.toThrow(
			wording,
		);

		expect(calls).toEqual([]);
	},
);

test("a write tool with no native route still runs through Slack's MCP server and not the Web API", async () => {
	const { deps, calls, web } = harness({ tools: ROUTED_TOOLS, routes: createNativeRoutes() });

	const result = await run(createSlackActTool(deps), {
		tool: "slack_add_reaction",
		arguments: { channel_id: "C0123ABC", name: "tada", timestamp: "1700000000.000100" },
	});

	expect(textOf(result)).toBe("ran slack_add_reaction");
	expect(calls).toEqual([
		{ name: "slack_add_reaction", args: { channel_id: "C0123ABC", name: "tada", timestamp: "1700000000.000100" } },
	]);
	expect(web).toEqual([]);
});

test("slack_read cannot send through a native route: it is refused before the Web API or the MCP server is touched", async () => {
	const { deps, calls, web } = harness({ tools: ROUTED_TOOLS, routes: createNativeRoutes(), web: slackWorkspace });

	await expect(
		run(createSlackReadTool(deps), {
			tool: "slack_send_message",
			arguments: { channel_id: "C0123ABC", message: "hello" },
		}),
	).rejects.toThrow("cannot run through slack_read");

	expect(calls).toEqual([]);
	expect(web).toEqual([]);
});

test.each([
	["slack_send_message", { channel_id: "C0123ABC", message: "hello" }],
	["slack_schedule_message", { channel_id: "C0123ABC", message: "hello", post_at: 1_900_000_000 }],
] as const)("a read-only connection refuses %s before the Web API is called", async (tool, args) => {
	const { deps, calls, web } = harness({
		tools: ROUTED_TOOLS,
		routes: createNativeRoutes(),
		web: slackWorkspace,
		credential: { access: "a", scopes: ["channels:history", "search:read.public"] },
	});

	await expect(run(createSlackActTool(deps), { tool, arguments: args })).rejects.toThrow("authorized read-only");

	expect(web).toEqual([]);
	expect(calls).toEqual([]);
});

test("cancelling slack_act stops a routed send from waiting on Slack's Web API", async () => {
	const controller = new AbortController();
	const cancelled = new Error("cancelled");
	let reachedSlack = false;
	const { deps, calls } = harness({
		tools: ROUTED_TOOLS,
		routes: createNativeRoutes(),
		web: (_method, _params, signal) => {
			reachedSlack = true;
			const answer = Promise.withResolvers<Record<string, unknown>>();
			if (!signal) answer.resolve({ ok: true, channel: {} });
			else if (signal.aborted) answer.reject(cancelled);
			else signal.addEventListener("abort", () => answer.reject(cancelled), { once: true });
			return answer.promise;
		},
	});

	const pending = run(
		createSlackActTool(deps),
		{ tool: "slack_send_message", arguments: { channel_id: "C0123ABC", message: "hello" } },
		controller.signal,
	);
	controller.abort();

	await expect(pending).rejects.toBe(cancelled);
	expect(reachedSlack).toBe(true);
	expect(calls).toEqual([]);
});
