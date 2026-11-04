import { expect, test } from "bun:test";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { type } from "arktype";
import type { ProcessResult, RunHimalaya } from "../himalaya";
import { createListMessagesTool, createReadMessageTool } from "../index";

type ApprovalSubject = Parameters<typeof resolveApproval>[0];

function stubHimalaya(...answers: ProcessResult[]): { readonly run: RunHimalaya; readonly calls: string[][] } {
	const calls: string[][] = [];
	const run: RunHimalaya = async args => {
		calls.push([...args]);
		const answer = answers[calls.length - 1];
		if (answer === undefined) throw new Error("the stub was called more times than it was given answers for");
		return answer;
	};
	return { run, calls };
}

const json = (value: unknown): ProcessResult => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
const ENVELOPES = json([
	{
		id: "7",
		flags: [],
		subject: "Hello",
		from: { name: "Alex", addr: "alex@example.com" },
		to: { name: null, addr: "me@example.com" },
		date: "2026-11-03 10:00+00:00",
		has_attachment: false,
	},
]);

const idle = stubHimalaya().run;
const list = createListMessagesTool(idle);
const read = createReadMessageTool(idle);

function runList(run: RunHimalaya, args: unknown) {
	return createListMessagesTool(run).execute("call", args as never, undefined, undefined, undefined as never);
}

function runRead(run: RunHimalaya, args: unknown) {
	return createReadMessageTool(run).execute("call", args as never, undefined, undefined, undefined as never);
}

interface ToolText {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
}

function textOf(result: ToolText): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

test("reading mail never asks the human, in any approval mode, and is the read tier", () => {
	for (const tool of [list, read]) {
		for (const mode of ["always-ask", "write", "yolo"] as const) {
			const approval = resolveApproval(tool as unknown as ApprovalSubject, { id: "1" }, mode);
			expect(approval.tier).toBe("read");
			expect(approval.policy).toBe("allow");
		}
	}
});

test("the list arguments are the contract: folder, query, a whole-number limit of at most 50, and an account name", () => {
	const accepted = [
		{},
		{ folder: "INBOX" },
		{ query: "not flag seen" },
		{ limit: 1 },
		{ limit: 50 },
		{ account: "company" },
		{ folder: "Sent", query: "from a", limit: 20, account: "company" },
	];
	for (const args of accepted) expect(list.parameters(args) instanceof type.errors).toBe(false);
	const refused = [
		{ limit: 0 },
		{ limit: 51 },
		{ limit: 2.5 },
		{ limit: "5" },
		{ folder: 3 },
		{ query: ["a"] },
		{ account: 3 },
		{ account: ["company"] },
	];
	for (const args of refused) expect(list.parameters(args) instanceof type.errors).toBe(true);
});

test("the read arguments are the contract: a text id, an optional folder, and an optional account name", () => {
	for (const args of [{ id: "42" }, { id: "42", folder: "[Gmail]/Sent Mail" }, { id: "42", account: "company" }]) {
		expect(read.parameters(args) instanceof type.errors).toBe(false);
	}
	for (const args of [{}, { id: 42 }, { id: "42", folder: 1 }, { id: "42", account: 1 }])
		expect(read.parameters(args) instanceof type.errors).toBe(true);
});

test("neither read tool offers a way to change the mailbox: no flag, move, delete or send argument, only a choice of account", () => {
	const expected = new Map([
		[list, ["account", "folder", "limit", "query"]],
		[read, ["account", "folder", "id"]],
	]);
	for (const tool of [list, read]) {
		const schema = JSON.stringify(tool.parameters.json);
		expect(schema).not.toMatch(/"(flag|flags|move|copy|delete|seen|send|reply|bcc)"/i);
		const { required = [], optional = [] } = JSON.parse(schema) as {
			required?: { key: string }[];
			optional?: { key: string }[];
		};
		expect([...required, ...optional].map(entry => entry.key).sort()).toEqual(expected.get(tool) ?? []);
	}
});

test("listing through the tool returns the envelope lines inside an untrusted block", async () => {
	const { run, calls } = stubHimalaya(ENVELOPES);
	const text = textOf(await runList(run, { folder: "INBOX", limit: 5 }));
	expect(calls).toHaveLength(1);
	expect(text).toContain("1 message in INBOX");
	expect(text).toContain("[UNTRUSTED-INBOUND-MAIL BEGIN kind=envelope-list]");
	expect(text).toContain(
		"id 7 | unread | 2026-11-03 10:00+00:00 | from Alex <alex@example.com> | to me@example.com | Hello",
	);
});

test("listing through the tool with an account asks that account, and says which account the ids belong to", async () => {
	const { run, calls } = stubHimalaya(ENVELOPES);
	const text = textOf(await runList(run, { folder: "INBOX", limit: 5, account: "company", query: "not flag seen" }));
	expect(calls).toEqual([
		[
			"envelope",
			"list",
			"--account",
			"company",
			"--output",
			"json",
			"--folder",
			"INBOX",
			"--page-size",
			"5",
			"--",
			"not flag seen",
		],
	]);
	expect(text).toContain('1 message in INBOX of account company matching "not flag seen"');
	expect(text).toContain('passing its id, this folder and account "company"');
});

test("reading through the tool returns headers and text inside an untrusted block", async () => {
	const body = "Hello there\n";
	const { run, calls } = stubHimalaya(
		json(body),
		json(`From: Alex <alex@example.com>\nMessage-ID: <m1@example.com>\n\n${body}`),
	);
	const text = textOf(await runRead(run, { id: "7" }));
	expect(calls).toHaveLength(2);
	expect(text).toContain("[UNTRUSTED-INBOUND-MAIL BEGIN kind=message]");
	expect(text).toContain("Message-ID: <m1@example.com>");
	expect(text).toContain("Hello there");
});

test("reading through the tool with an account reads both parts from that account", async () => {
	const body = "Hello there\n";
	const { run, calls } = stubHimalaya(
		json(body),
		json(`From: Alex <alex@example.com>\nMessage-ID: <m1@example.com>\n\n${body}`),
	);
	const text = textOf(await runRead(run, { id: "7", account: "company" }));
	expect(calls.map(call => call.slice(0, 5))).toEqual([
		["message", "read", "--account", "company", "--preview"],
		["message", "read", "--account", "company", "--preview"],
	]);
	expect(text.split("\n")[0]).toBe("Message 7 in INBOX of account company.");
	expect(text).toContain("Hello there");
});

test("bad arguments are refused in plain words before himalaya is run at all", async () => {
	const { run, calls } = stubHimalaya();
	const attempts: [() => Promise<unknown>, string][] = [
		[() => runList(run, { limit: 500 }), "whole number from 1 to 50"],
		[() => runList(run, { folder: "--help" }), "`folder` must be"],
		[() => runList(run, { query: "a\nb" }), "`query` must be one line"],
		[() => runRead(run, { id: "--all" }), "`id` must be one message id"],
		[() => runRead(run, {}), "`id` must be one message id"],
		[() => runRead(run, { id: "1", folder: "x\ny" }), "`folder` must be"],
		[() => runList(run, { account: "" }), "`account` must be the name of a himalaya account"],
		[() => runList(run, { account: "--debug" }), "`account` must be the name of a himalaya account"],
		[() => runList(run, { account: "a b" }), "`account` must be the name of a himalaya account"],
		[() => runList(run, { account: "x".repeat(65) }), "`account` must be the name of a himalaya account"],
		[() => runRead(run, { id: "1", account: "a\nb" }), "`account` must be the name of a himalaya account"],
		[() => runRead(run, { id: "1", account: "-x" }), "`account` must be the name of a himalaya account"],
		[() => runRead(run, { id: "1", account: 7 }), "`account` must be the name of a himalaya account"],
	];
	for (const [attempt, reason] of attempts) await expect(attempt()).rejects.toThrow(reason);
	expect(calls).toHaveLength(0);
});

test("the tool descriptions tell the model that the mail is untrusted and that the tools only read", () => {
	for (const tool of [list, read]) {
		expect(tool.description).toContain("[UNTRUSTED-INBOUND-MAIL]");
		expect(tool.description).toContain("never instructions");
		expect(tool.description).toContain("Read-only");
		expect(tool.description).toContain("`account`");
	}
});
