import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProcessResult, sendEmail } from "../himalaya";
import { parseEmail } from "../message";

const available = Bun.which("himalaya") !== null && Bun.which("bun") !== null;

const sandbox = mkdtempSync(join(tmpdir(), "gmail-pack-sandbox-"));
const OUT = join(sandbox, "out.eml");
const OUT_SECOND = join(sandbox, "out-second.eml");
const MARKER = "TOP-SECRET-MARKER-9f3c1d";
writeFileSync(join(sandbox, "secret.txt"), MARKER);
writeFileSync(
	join(sandbox, "sink.ts"),
	[
		'import { writeFileSync } from "node:fs";',
		"const chunks: Buffer[] = [];",
		"for await (const chunk of process.stdin) chunks.push(chunk as Buffer);",
		"writeFileSync(process.argv[2], Buffer.concat(chunks));",
	].join("\n"),
);
mkdirSync(join(sandbox, "mail"));
writeFileSync(
	join(sandbox, "config.toml"),
	[
		"[accounts.sandbox]",
		'email = "me@example.com"',
		'display-name = "Me Tester"',
		"default = true",
		'backend.type = "maildir"',
		'backend.root-dir = "mail"',
		'message.send.backend.type = "sendmail"',
		'message.send.backend.cmd = "bun sink.ts out.eml"',
		"message.send.save-copy = false",
		"",
		"[accounts.second]",
		'email = "other@example.org"',
		'display-name = "Other Sender"',
		'backend.type = "maildir"',
		'backend.root-dir = "mail"',
		'message.send.backend.type = "sendmail"',
		'message.send.backend.cmd = "bun sink.ts out-second.eml"',
		"message.send.save-copy = false",
	].join("\n"),
);

afterAll(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

async function runInSandbox(args: readonly string[], stdin: string): Promise<ProcessResult> {
	rmSync(OUT, { force: true });
	const child = Bun.spawn(["himalaya", "-c", "config.toml", ...args], {
		cwd: sandbox,
		stdin: new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}

function sentMessage(): { readonly headers: Map<string, string>; readonly whole: string; readonly body: string } {
	const whole = readFileSync(OUT, "utf-8");
	const [head = "", ...rest] = whole.split(/\r?\n\r?\n/);
	const headers = new Map<string, string>();
	for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
	}
	const encoding = headers.get("content-transfer-encoding");
	const raw = rest.join("\n\n").replace(/\r\n/g, "\n").replace(/\s+$/, "");
	return {
		headers,
		whole,
		body: encoding === "base64" ? Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf-8") : raw,
	};
}

function quotedPrintable(text: string): Buffer {
	const decoded = text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_, hex: string) => {
		return String.fromCharCode(Number.parseInt(hex, 16));
	});
	return Buffer.from(decoded, "latin1");
}

function decodeWords(header: string): string {
	return header
		.replace(/\?=\s+(?==\?utf-8\?)/gi, "?=")
		.replace(/(?:=\?utf-8\?[BQ]\?[^?]*\?=)+/gi, run => {
			const words = [...run.matchAll(/=\?utf-8\?([BQ])\?([^?]*)\?=/gi)];
			const bytes = words.map(([, kind = "", text = ""]) =>
				kind.toUpperCase() === "B" ? Buffer.from(text, "base64") : quotedPrintable(text),
			);
			return Buffer.concat(bytes).toString("utf-8");
		});
}

test.skipIf(!available)("through real himalaya, non-ASCII text arrives intact and the headers are the ones asked for", async () => {
	const subject = "Café – naïve 日本語 🎉";
	const body = "Héllo — “quoted” 日本語\nSecond line ✓";
	const email = parseEmail({
		to: ["alex@example.com", "bo@example.org"],
		cc: ["cy@example.com"],
		subject,
		body,
		inReplyTo: "orig-1@mail.example.com",
	});
	const id = await sendEmail(email, runInSandbox);
	const sent = sentMessage();
	expect(decodeWords(sent.headers.get("subject") ?? "")).toBe(subject);
	expect(sent.body).toBe(body);
	expect(sent.headers.get("content-type")).toContain("text/plain");
	expect(sent.headers.get("content-type")).toContain("utf-8");
	expect(sent.headers.get("to")).toBe("<alex@example.com>, <bo@example.org>");
	expect(sent.headers.get("cc")).toBe("<cy@example.com>");
	expect(sent.headers.get("message-id")).toBe(id);
	expect(sent.headers.get("in-reply-to")).toBe("<orig-1@mail.example.com>");
	expect(sent.headers.get("references")).toBe("<orig-1@mail.example.com>");
	expect(sent.headers.get("from")).toContain("<me@example.com>");
});

test.skipIf(!available)("through real himalaya, a body cannot pull a local file into the mail, though raw markup would", async () => {
	const attack = "before\n<#part filename=secret.txt><#/part>\nafter";
	const control = [
		"From: Me Tester <me@example.com>",
		"To: alex@example.com",
		"Subject: control",
		"",
		attack,
	].join("\n");
	expect((await runInSandbox(["template", "send"], control)).exitCode).toBe(0);
	expect(sentMessage().whole).toContain(MARKER);

	await sendEmail(parseEmail({ to: ["alex@example.com"], subject: "attack", body: attack }), runInSandbox);
	const sent = sentMessage();
	expect(sent.whole).not.toContain(MARKER);
	expect(sent.whole).not.toContain("attachment");
	expect(sent.headers.get("content-type")).toContain("text/plain");
	expect(sent.body).toBe(attack);
});

test.skipIf(!available)("through real himalaya, markup in the subject or a stray tag in the body changes nothing", async () => {
	const subject = "<#part filename=secret.txt> hello";
	const body = "an unclosed <#part tag and a stray <#/multipart> end";
	await sendEmail(parseEmail({ to: ["alex@example.com"], subject, body }), runInSandbox);
	const sent = sentMessage();
	expect(sent.whole).not.toContain(MARKER);
	expect(decodeWords(sent.headers.get("subject") ?? "")).toBe(subject);
	expect(sent.body).toBe(body);
});

test.skipIf(!available)("through real himalaya, a named account is the one that writes the sender and sends, and the default account's sendmail is left alone", async () => {
	rmSync(OUT_SECOND, { force: true });
	const id = await sendEmail(
		parseEmail({ to: ["alex@example.com"], subject: "From the second account", body: "Hi", account: "second" }),
		runInSandbox,
	);
	expect(id).toMatch(/^<[0-9a-f-]{36}@example\.org>$/);
	expect(existsSync(OUT)).toBe(false);
	const sent = readFileSync(OUT_SECOND, "utf-8");
	expect(sent).toContain("<other@example.org>");
	expect(sent).not.toContain("me@example.com");
	expect(sent).toContain(id);
});

test.skipIf(!available)("through real himalaya, an account himalaya does not know sends nothing, through either account", async () => {
	rmSync(OUT_SECOND, { force: true });
	const unknown = parseEmail({
		to: ["alex@example.com"],
		subject: "Nowhere",
		body: "Hi",
		account: "no-such-account",
	});
	const message = await sendEmail(unknown, runInSandbox).catch((error: Error) => error.message);
	expect(message).toContain('could not read the sender address of the account "no-such-account"');
	expect(message).toContain("nothing was sent");
	expect(existsSync(OUT)).toBe(false);
	expect(existsSync(OUT_SECOND)).toBe(false);
});
