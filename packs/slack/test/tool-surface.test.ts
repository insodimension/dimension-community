import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import slackExtension from "../index";
import { dimension } from "./support/pack";

interface RegisteredTool {
	readonly name: string;
	readonly approval?: unknown;
	readonly formatApprovalDetails?: (args: unknown) => string[];
}

const registered: RegisteredTool[] = [];
slackExtension({ registerTool: (tool: RegisteredTool) => registered.push(tool) } as unknown as ExtensionAPI);

const APPROVAL_MODES = ["always-ask", "write", "yolo"] as const;

interface Send {
	readonly tool: string;
	readonly asBot: boolean;
	readonly args: Record<string, unknown>;
	readonly shown: string[];
}

const SENDS: Send[] = [
	{
		tool: "slack_post_message",
		asBot: true,
		args: { channel: "C0123ABCD", text: "the deploy is done" },
		shown: ["C0123ABCD", "the deploy is done"],
	},
	{
		tool: "slack_reply_thread",
		asBot: true,
		args: { channel: "C0123ABCD", threadTs: "1700000000.000100", text: "on it" },
		shown: ["C0123ABCD", "1700000000.000100", "on it"],
	},
	{
		tool: "slack_edit_message",
		asBot: true,
		args: { channel: "C0123ABCD", messageTs: "1700000000.000200", text: "fixed the typo" },
		shown: ["C0123ABCD", "1700000000.000200", "fixed the typo"],
	},
	{
		tool: "slack_delete_message",
		asBot: true,
		args: { channel: "C0123ABCD", messageTs: "1700000000.000300" },
		shown: ["C0123ABCD", "1700000000.000300"],
	},
	{
		tool: "slack_upload_file",
		asBot: true,
		args: {
			channel: "C0123ABCD",
			path: "reports/q3-numbers.pdf",
			title: "Board pack",
			threadTs: "1700000000.000400",
			comment: "the Q3 numbers you asked for",
		},
		shown: [
			"C0123ABCD",
			"reports/q3-numbers.pdf",
			"Board pack",
			"1700000000.000400",
			"the Q3 numbers you asked for",
		],
	},
	{
		tool: "slack_act",
		asBot: false,
		args: { tool: "slack_send_message", arguments: { channel: "C0123ABCD", text: "back in five" } },
		shown: ["slack_send_message", "C0123ABCD", "back in five"],
	},
];

function registeredTool(name: string): RegisteredTool {
	const found = registered.find(tool => tool.name === name);
	if (!found) throw new Error(`the extension did not register ${name}`);
	return found;
}

test("the extension registers each of the 13 tools plugin.json lists once, and every one has a tool card", () => {
	const names = registered.map(tool => tool.name).sort();

	expect(names).toHaveLength(13);
	expect(names).toEqual(dimension.tools.map(tool => tool.name).sort());
	expect(names).toEqual(dimension.toolRenderer.map(card => card.match).sort());
});

test.each(SENDS)("$tool is a write: it asks in Ask mode and passes in Write and Full access", ({ tool, args }) => {
	const policies = APPROVAL_MODES.map(
		mode => resolveApproval(registeredTool(tool) as Parameters<typeof resolveApproval>[0], args, mode).policy,
	);

	expect(policies).toEqual(["prompt", "allow", "allow"]);
});

test.each(SENDS)(
	"$tool's approval card says whether it sends as the bot or as you, and shows what it sends",
	({ tool, asBot, args, shown }) => {
		const card = registeredTool(tool).formatApprovalDetails?.(args) ?? [];
		const sendsAs = card.find(line => line.startsWith("As:"));

		expect(sendsAs).toBeDefined();
		if (asBot) expect(sendsAs).toMatch(/bot/i);
		else expect(sendsAs).not.toMatch(/bot/i);
		for (const value of shown) expect(card.join("\n")).toContain(value);
	},
);

test("slack_upload_file's approval card names the bot, the channel and the file, and shows no title, thread or message line when there are none", () => {
	const args = { channel: "C0123ABCD", path: "reports/q3-numbers.pdf" };
	const card = registeredTool("slack_upload_file").formatApprovalDetails?.(args) ?? [];
	const text = card.join("\n");

	expect(card).toContain("As: the Slack bot app");
	expect(text).toContain("C0123ABCD");
	expect(text).toContain("reports/q3-numbers.pdf");
	expect(card.filter(line => /^(Title|Thread|Message):/.test(line))).toEqual([]);
	expect(text).not.toContain("(missing)");
});
