import { expect, test } from "bun:test";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { type } from "arktype";
import type { ProcessResult, RunHimalaya } from "../himalaya";
import gmailExtension, { createSendEmailTool } from "../index";

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

const SENDER: ProcessResult = { exitCode: 0, stdout: "From: Me <me@gmail.com>\n\n", stderr: "" };
const SENT: ProcessResult = { exitCode: 0, stdout: "Message successfully sent!\n", stderr: "" };
const ARGS = { to: ["alex@example.com"], subject: "Hello", body: "Hi Alex" };

const never = stubHimalaya().run;
const tool = createSendEmailTool(never);

function card(args: unknown): string {
	const format = tool.formatApprovalDetails;
	if (!format) throw new Error("gmail_send_email has no approval card");
	const shown = format(args);
	return Array.isArray(shown) ? shown.join("\n") : String(shown);
}

test("the extension registers the two read tools and the one send tool, named the way the Clients agents and send gate expect", () => {
	const registered: string[] = [];
	gmailExtension({
		registerTool(definition: { name: string }) {
			registered.push(definition.name);
		},
	} as unknown as Parameters<typeof gmailExtension>[0]);
	expect(registered).toEqual(["gmail_list_messages", "gmail_read_message", "gmail_send_email"]);
});

test("sending asks the human in every approval mode, yolo included", () => {
	for (const mode of ["always-ask", "write", "yolo"] as const) {
		expect(resolveApproval(tool as unknown as ApprovalSubject, ARGS, mode).policy).toBe("prompt");
	}
});

test("the approval card shows every recipient, the subject, the thread and the whole text", () => {
	const body = `${"A long paragraph the person has to be able to read in full. ".repeat(20)}END-OF-EMAIL`;
	const shown = card({
		to: ["alex@example.com", "bo@example.org"],
		cc: ["cy@example.com"],
		subject: "Quarterly plan",
		inReplyTo: "<orig-1@mail.example.com>",
		body,
	});
	for (const expected of [
		"To: alex@example.com, bo@example.org",
		"Cc: cy@example.com",
		"Subject: Quarterly plan",
		"In reply to: <orig-1@mail.example.com>",
		body,
	]) {
		expect(shown).toContain(expected);
	}
});

test("the card leaves out cc and the thread when they are not used", () => {
	const shown = card({ ...ARGS, cc: [], inReplyTo: "  " });
	expect(shown).not.toContain("Cc:");
	expect(shown).not.toContain("In reply to:");
});

test("the card names the account the mail goes out from, and says so plainly when it is the default one", () => {
	expect(card({ ...ARGS, account: "company" }).split("\n")[0]).toBe("From account: company");
	expect(card({ ...ARGS, account: " company " }).split("\n")[0]).toBe("From account: company");
	for (const account of [undefined, "", "  "]) {
		expect(card({ ...ARGS, account }).split("\n")[0]).toBe("From account: (default account)");
	}
});

test("malformed arguments still draw a card instead of throwing", () => {
	for (const args of [undefined, null, 42, "text", {}, { to: "alex@example.com", subject: 7, body: [] }]) {
		expect(card(args)).toContain("To: (missing)");
	}
});

test("the declared arguments are the contract: to, cc, subject, body, inReplyTo, account, and no bcc", () => {
	expect(JSON.stringify(tool.parameters.json)).not.toContain("bcc");
	expect(JSON.stringify(tool.parameters.json)).toContain('"account"');
	const accepted = [
		ARGS,
		{ ...ARGS, cc: ["cy@example.com"], inReplyTo: "<orig-1@mail.example.com>" },
		{ ...ARGS, account: "company" },
	];
	for (const args of accepted) expect(tool.parameters(args) instanceof type.errors).toBe(false);
	const refused = [
		{ ...ARGS, to: "alex@example.com" },
		{ to: ARGS.to, body: ARGS.body },
		{ to: ARGS.to, subject: ARGS.subject },
		{ ...ARGS, cc: "cy@example.com" },
		{ ...ARGS, inReplyTo: 12 },
		{ ...ARGS, account: 5 },
		{ ...ARGS, account: ["company"] },
	];
	for (const args of refused) expect(tool.parameters(args) instanceof type.errors).toBe(true);
});

function send(run: RunHimalaya, args: unknown) {
	const definition = createSendEmailTool(run);
	return definition.execute("call", args as typeof ARGS, undefined, undefined, undefined as never);
}

test("a send reads the sender, sends once, and reports who it went to with the message id", async () => {
	const { run, calls } = stubHimalaya(SENDER, SENT);
	const result = await send(run, { ...ARGS, cc: ["cy@example.com"] });
	expect(calls).toEqual([
		["template", "write"],
		["template", "send"],
	]);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	expect(text).toMatch(
		/^Email sent to alex@example\.com; cc cy@example\.com \(id: <[0-9a-f-]{36}@gmail\.com>\)\.$/,
	);
});

test("a send with an account reads the sender from that account, sends through it, and says which account it used", async () => {
	const { run, calls } = stubHimalaya(SENDER, SENT);
	const result = await send(run, { ...ARGS, account: "company" });
	expect(calls).toEqual([
		["template", "write", "--account", "company"],
		["template", "send", "--account", "company"],
	]);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	expect(text).toMatch(/^Email sent to alex@example\.com from account company \(id: <[0-9a-f-]{36}@gmail\.com>\)\.$/);
});

test("bad arguments are refused in plain words before himalaya is run at all", async () => {
	const { run, calls } = stubHimalaya();
	const attempts: [unknown, string][] = [
		[{ ...ARGS, to: [] }, "at least one recipient"],
		[{ ...ARGS, to: ["Alex <alex@example.com>"] }, "is not a plain email address"],
		[{ ...ARGS, subject: "Hi\nBcc: evil@example.com" }, "single line"],
		[{ ...ARGS, bcc: ["di@example.com"] }, "Bcc is not supported: send a separate message to each hidden recipient."],
		[{ ...ARGS, body: "   " }, "body is empty"],
		[{ ...ARGS, account: "" }, "`account` must be the name of a himalaya account"],
		[{ ...ARGS, account: "--debug" }, "`account` must be the name of a himalaya account"],
		[{ ...ARGS, account: "company\ntemplate send" }, "`account` must be the name of a himalaya account"],
		[{ ...ARGS, account: "a b" }, "`account` must be the name of a himalaya account"],
		[{ ...ARGS, account: "x".repeat(65) }, "`account` must be the name of a himalaya account"],
		[{ ...ARGS, account: 7 }, "`account` must be the name of a himalaya account"],
	];
	for (const [args, reason] of attempts) {
		await expect(send(run, args)).rejects.toThrow(reason);
	}
	expect(calls).toHaveLength(0);
});

test("a himalaya failure comes back as an error the agent can read to the person", async () => {
	const { run } = stubHimalaya(SENDER, { exitCode: 1, stdout: "", stderr: "Error: \n   0: smtp login refused\n" });
	await expect(send(run, ARGS)).rejects.toThrow("smtp login refused");
});
