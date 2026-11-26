import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { type } from "arktype";
import type { ProcessResult, RunHimalaya } from "../himalaya";
import gmailExtension, { createSendEmailTool } from "../index";
import { resolveAttachment } from "../message";

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

const files = realpathSync.native(mkdtempSync(join(tmpdir(), "gmail-pack-attachments-")));
afterAll(() => {
	rmSync(files, { recursive: true, force: true });
});

function fileOfSize(name: string, bytes: number): string {
	const path = join(files, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "");
	truncateSync(path, bytes);
	return path;
}

function refusalOf(raw: string): string {
	try {
		resolveAttachment(raw);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error(`resolveAttachment accepted ${JSON.stringify(raw)}, which it should have refused`);
}

const HIDDEN_NOTE = ", from a hidden or app-data folder";
const sandboxNote = files.split(/[\\/]/).some(segment => segment.startsWith(".") || segment === "AppData")
	? HIDDEN_NOTE
	: "";

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

test("the card leaves out cc, the thread and the attachments when they are not used", () => {
	const shown = card({ ...ARGS, cc: [], inReplyTo: "  ", attachments: [] });
	expect(shown).not.toContain("Cc:");
	expect(shown).not.toContain("In reply to:");
	expect(shown).not.toContain("Attachments:");
});

test("the card lists every attachment with its size, in the order given, and a padded path is the same file", () => {
	const report = fileOfSize("Signed copy (final) 2026.pdf", 1500);
	const note = fileOfSize("tiny.txt", 12);
	const deck = fileOfSize("deck.pdf", 2_500_000);
	const shown = card({ ...ARGS, attachments: [report, note, deck] });
	expect(shown).toContain(
		[
			"Attachments:",
			`- ${report} (1.5 KB${sandboxNote})`,
			`- ${note} (12 B${sandboxNote})`,
			`- ${deck} (2.5 MB${sandboxNote})`,
		].join("\n"),
	);
	expect(card({ ...ARGS, attachments: [`  ${report}  `] })).toContain(`- ${report} (1.5 KB${sandboxNote})`);
});

test("the card warns when a file sits in a hidden or app-data folder, or is itself a dot file", () => {
	const inDotFolder = fileOfSize(join(".config", "token.txt"), 12);
	const inAppData = fileOfSize(join("AppData", "Local", "cache.bin"), 2000);
	const dotFile = fileOfSize(".env", 7);
	const shown = card({ ...ARGS, attachments: [inDotFolder, inAppData, dotFile] });
	expect(shown).toContain(`- ${inDotFolder} (12 B${HIDDEN_NOTE})`);
	expect(shown).toContain(`- ${inAppData} (2.0 KB${HIDDEN_NOTE})`);
	expect(shown).toContain(`- ${dotFile} (7 B${HIDDEN_NOTE})`);
});

test("the card gives each refused path the same reason the send would stop with, and keeps the good files listed", () => {
	const report = fileOfSize("kept.pdf", 1500);
	const dollar = fileOfSize("cost$5.txt", 3);
	const refused: [string, string][] = [
		[join(files, "missing.pdf"), "There is no file at"],
		[files, "is not a file"],
		["report.pdf", "is not an absolute file path"],
		["//server/share/report.pdf", "is a network or device path"],
		[dollar, 'contains $, " or a backslash'],
		...(process.platform === "win32"
			? ([[`${files}${sep}a:b.txt`, "names a stream inside a file"]] satisfies [string, string][])
			: []),
	];
	const lines = refused.map(([asked, reason]) => {
		const message = refusalOf(asked);
		expect(message).toContain(reason);
		return `- ${asked} (refused: ${message})`;
	});
	const shown = card({ ...ARGS, attachments: [report, ...refused.map(([asked]) => asked)] });
	expect(shown).toContain(["Attachments:", `- ${report} (1.5 KB${sandboxNote})`, ...lines].join("\n"));
});

test("attachments that are not a list of paths still draw a card instead of throwing", () => {
	expect(card({ ...ARGS, attachments: "C:/Users/Me/report.pdf" })).not.toContain("Attachments:");
	const shown = card({ ...ARGS, attachments: [42, null] });
	expect(shown).toContain(`- 42 (refused: ${refusalOf("42")})`);
	expect(shown).toContain(`- null (refused: ${refusalOf("null")})`);
	expect(refusalOf("42")).toContain("is not an absolute file path");
});

test("the card shows where a link really leads, and nothing extra when a path only spells the same file differently", () => {
	const real = fileOfSize(join("link-target", "doc.txt"), 12);
	const link = join(files, "link-card");
	symlinkSync(join(files, "link-target"), link, "junction");
	const throughLink = join(link, "doc.txt");
	expect(card({ ...ARGS, attachments: [throughLink] })).toContain(`- ${throughLink} → ${real} (12 B${sandboxNote})`);
	const withDots = `${files}${sep}link-target${sep}..${sep}link-target${sep}doc.txt`;
	const shown = card({ ...ARGS, attachments: [withDots] });
	expect(shown).toContain(`- ${real} (12 B${sandboxNote})`);
	expect(shown).not.toContain("→");
});

test.skipIf(process.platform !== "win32")("on Windows a path typed in other casing or with forward slashes is shown once, as the real path", () => {
	const real = fileOfSize("Typed Casing.TXT", 12);
	for (const asked of [real.toUpperCase(), real.toLowerCase(), real.replaceAll("\\", "/")]) {
		const shown = card({ ...ARGS, attachments: [asked] });
		expect(shown).toContain(`- ${real} (12 B${sandboxNote})`);
		expect(shown).not.toContain("→");
	}
});

test.skipIf(process.platform !== "win32")("a Windows device path to a real file draws a refusal, not a size: its text is refused before the file is looked up", () => {
	const real = fileOfSize("device-card.txt", 12);
	const asked = `\\\\?\\${real}`;
	const message = refusalOf(asked);
	expect(message).toContain("is a network or device path");
	expect(message).not.toContain("leads to");
	const shown = card({ ...ARGS, attachments: [asked] });
	expect(shown).toContain(`- ${asked} (refused: ${message})`);
	expect(shown).not.toContain("12 B");
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

test("the declared arguments are the contract: to, cc, subject, body, inReplyTo, account, attachments, and no bcc", () => {
	expect(JSON.stringify(tool.parameters.json)).not.toContain("bcc");
	expect(JSON.stringify(tool.parameters.json)).toContain('"account"');
	expect(JSON.stringify(tool.parameters.json)).toContain('"attachments"');
	const accepted = [
		ARGS,
		{ ...ARGS, cc: ["cy@example.com"], inReplyTo: "<orig-1@mail.example.com>" },
		{ ...ARGS, account: "company" },
		{ ...ARGS, attachments: ["C:/Users/Me/report.pdf", "/home/me/notes.txt"] },
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
		{ ...ARGS, attachments: "C:/Users/Me/report.pdf" },
		{ ...ARGS, attachments: [7] },
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

test("a send with attachments names each file and its size in the result, after the recipients and the account", async () => {
	const { run, calls } = stubHimalaya(SENDER, SENT);
	const report = fileOfSize("report.pdf", 1500);
	const note = fileOfSize("tiny.txt", 12);
	const result = await send(run, {
		...ARGS,
		cc: ["cy@example.com"],
		account: "company",
		attachments: [report, note],
	});
	expect(calls).toHaveLength(2);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	expect(text.replace(/<[0-9a-f-]{36}@gmail\.com>/, "<id>")).toBe(
		"Email sent to alex@example.com; cc cy@example.com from account company with report.pdf (1.5 KB), tiny.txt (12 B) attached (id: <id>).",
	);
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

test("attachments that cannot be sent are refused in plain words before himalaya is run, and one bad file spoils the whole send", async () => {
	const { run, calls } = stubHimalaya();
	const report = fileOfSize("report.pdf", 1500);
	const missing = join(files, "missing.pdf");
	const relativeButThere = relative(process.cwd(), import.meta.path);
	const halves = [fileOfSize("half-a.bin", 10_000_000), fileOfSize("half-b.bin", 10_000_000)];
	const absoluteRefusal = (raw: string) => `"${raw}" in \`attachments\` is not an absolute file path`;
	const attempts: [string[], string][] = [
		[[relativeButThere], absoluteRefusal(relativeButThere)],
		[["report.pdf"], absoluteRefusal("report.pdf")],
		[["~/report.pdf"], absoluteRefusal("~/report.pdf")],
		[[`${files}/line\nbreak.pdf`], "contains a line break"],
		[[`${report}\u0000`], "contains a line break"],
		[[missing], `There is no file at "${missing}", so nothing was sent`],
		[[files], `"${files}" is not a file, so nothing was sent`],
		[[report, missing], `There is no file at "${missing}", so nothing was sent`],
		[halves, "26.7 MB once encoded, over Gmail's 25 MB limit, so nothing was sent"],
	];
	for (const [attachments, reason] of attempts) {
		await expect(send(run, { ...ARGS, attachments })).rejects.toThrow(reason);
	}
	expect(calls).toHaveLength(0);
});

test("a himalaya failure comes back as an error the agent can read to the person, even when himalaya exits 0 without confirming", async () => {
	const { run } = stubHimalaya(SENDER, { exitCode: 1, stdout: "", stderr: "Error: \n   0: smtp login refused\n" });
	await expect(send(run, ARGS)).rejects.toThrow("smtp login refused");
	const quiet = stubHimalaya(SENDER, { exitCode: 0, stdout: "", stderr: "Error: \n   0: smtp login refused\n" });
	await expect(send(quiet.run, ARGS)).rejects.toThrow("smtp login refused");
});
