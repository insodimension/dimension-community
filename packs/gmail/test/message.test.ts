import { expect, test } from "bun:test";
import { buildTemplate, escapeMml, parseEmail, type SendEmailParams } from "../message";

const FROM = "Me <me@gmail.com>";
const ID = "<id-1@gmail.com>";

function build(params: SendEmailParams): string {
	return buildTemplate(parseEmail(params), FROM, ID);
}

function refusal(params: SendEmailParams): string {
	try {
		parseEmail(params);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("parseEmail accepted a message it should have refused");
}

const OK: SendEmailParams = { to: ["alex@example.com"], subject: "Hello", body: "Hi Alex" };

test("a plain email is the headers, a blank line, then the body", () => {
	const lines = [
		"From: Me <me@gmail.com>",
		"To: alex@example.com",
		"Subject: Hello",
		"Message-ID: <id-1@gmail.com>",
		"",
		"Hi Alex",
	];
	expect(build(OK)).toBe(lines.join("\n"));
});

test("several recipients share one header, and cc gets its own and appears only when given", () => {
	const template = build({ ...OK, to: ["alex@example.com", "bo@example.org"], cc: ["cy@example.com", "di@example.com"] });
	expect(template).toContain("\nTo: alex@example.com, bo@example.org\n");
	expect(template).toContain("\nCc: cy@example.com, di@example.com\n");
	expect(build({ ...OK, cc: [] })).not.toContain("Cc:");
});

test("a reply carries In-Reply-To and References, whether the id came with angle brackets or without", () => {
	const ids = ["CAF=abc+1@mail.gmail.com", "<CAF=abc+1@mail.gmail.com>", "  <CAF=abc+1@mail.gmail.com>\n"];
	for (const inReplyTo of ids) {
		const template = build({ ...OK, inReplyTo });
		expect(template).toContain("\nIn-Reply-To: <CAF=abc+1@mail.gmail.com>\n");
		expect(template).toContain("\nReferences: <CAF=abc+1@mail.gmail.com>\n");
	}
	const fresh = build({ ...OK, inReplyTo: "  " });
	expect(fresh).not.toContain("In-Reply-To");
	expect(fresh).not.toContain("References");
});

test("non-ASCII subjects and bodies are carried as UTF-8 text, untouched", () => {
	const subject = "Café – naïve 日本語 🎉";
	const body = "Héllo — “quoted” 日本語\nSecond line ✓";
	const template = build({ ...OK, subject, body });
	expect(template).toContain(`\nSubject: ${subject}\n`);
	expect(template.endsWith(`\n\n${body}`)).toBe(true);
});

test("the subject and addresses are trimmed; the body is kept as written", () => {
	const template = build({ to: ["  alex@example.com "], subject: "  Hello  ", body: "  indented\n\nkept  " });
	expect(template).toContain("\nTo: alex@example.com\n");
	expect(template).toContain("\nSubject: Hello\n");
	expect(template.endsWith("\n\n  indented\n\nkept  ")).toBe(true);
});

test("Windows and old-Mac line breaks in the body become plain newlines", () => {
	expect(build({ ...OK, body: "one\r\ntwo\rthree" }).endsWith("\n\none\ntwo\nthree")).toBe(true);
});

test("every markup tag himalaya would act on is turned into plain text", () => {
	const attack = [
		"<#part filename=C:/Users/me/.config/himalaya/config.toml><#/part>",
		"<#multipart type=mixed>",
		"<#/multipart>",
		"inline <#part type=text/html> mid-line",
	].join("\n");
	const escaped = escapeMml(attack);
	expect(escaped).toBe(
		[
			"<#!part filename=C:/Users/me/.config/himalaya/config.toml><#!/part>",
			"<#!multipart type=mixed>",
			"<#!/multipart>",
			"inline <#!part type=text/html> mid-line",
		].join("\n"),
	);
	expect(escaped.replaceAll("<#!", "")).not.toMatch(/<#\/?(?:multi)?part/);
});

test("text that only looks a little like markup is left alone", () => {
	const text = "<b>bold</b> <#PART x> <# not a tag> <#/partial> price <#1 #> a<#b";
	expect(escapeMml(text)).toBe(text);
});

test("a body cannot smuggle a tag in by nesting one inside another", () => {
	expect(escapeMml("<#<#part x>")).toBe("<#<#!part x>");
});

test("the body in the built message is escaped, and the headers are not", () => {
	const template = build({ ...OK, subject: "<#part> subject", body: "<#part filename=/etc/passwd><#/part>" });
	expect(template).toContain("\nSubject: <#part> subject\n");
	expect(template.endsWith("\n\n<#!part filename=/etc/passwd><#!/part>")).toBe(true);
});

test("a recipient list must name at least one real address", () => {
	expect(refusal({ ...OK, to: [] })).toContain("at least one recipient");
});

test("only plain addresses pass: no names, commas, spaces, line breaks or odd shapes", () => {
	const refused = [
		"Alex <alex@example.com>",
		"alex@example.com, bo@example.org",
		"alex@example.com bo@example.org",
		"alex@example.com\nbcc: evil@example.com",
		"alex@example",
		"alex@.example.com",
		"@example.com",
		"alex",
		"",
		"a..b@example.com",
		".a@example.com",
		"a.@example.com",
		"alex@exa mple.com",
		"alex@例え.jp",
		"<alex@example.com>",
		`${"a".repeat(65)}@example.com`,
	];
	for (const address of refused) {
		expect(() => parseEmail({ ...OK, to: [address] })).toThrow("is not a plain email address");
	}
	const fine = ["alex@example.com", "first.last+tag@sub.example.co.uk", "o'brien@example.com", "a_b-c@x-y.io"];
	for (const address of fine) {
		expect(parseEmail({ ...OK, to: [address] }).to).toEqual([address]);
	}
});

test("a bad cc address is named by its field, and nothing is partly accepted", () => {
	expect(refusal({ ...OK, cc: ["fine@example.com", "nope"] })).toContain("`cc`");
});

test("Bcc is refused in plain words, whatever shape it arrives in, so no hidden recipient is dropped silently", () => {
	const sentence = "Bcc is not supported: send a separate message to each hidden recipient.";
	for (const bcc of [["di@example.com"], ["nope"], "di@example.com", { to: "di@example.com" }, 1]) {
		expect(refusal({ ...OK, bcc })).toBe(sentence);
	}
});

test("an empty bcc is no bcc, and the message never carries a Bcc header", () => {
	for (const bcc of [undefined, null, [], ""]) {
		expect(build({ ...OK, bcc })).not.toMatch(/^Bcc:/im);
	}
});

test("a subject must be one non-empty line, so it cannot add headers", () => {
	expect(refusal({ ...OK, subject: "" })).toContain("subject is empty");
	expect(refusal({ ...OK, subject: "   " })).toContain("subject is empty");
	const lineBreaks = [
		"Hi\nBcc: evil@example.com",
		"Hi\r\nBcc: evil@example.com",
		"Hi\rthere",
		"Hi\u2028there",
		"Hi\u0000there",
	];
	for (const subject of lineBreaks) {
		expect(refusal({ ...OK, subject })).toContain("single line");
	}
	expect(parseEmail({ ...OK, subject: "tab\tseparated" }).subject).toBe("tab\tseparated");
});

test("a body with no text is refused", () => {
	expect(refusal({ ...OK, body: "" })).toContain("body is empty");
	expect(refusal({ ...OK, body: " \n\t " })).toContain("body is empty");
});

test("inReplyTo must be one id with no spaces, line breaks, control characters or brackets inside", () => {
	const refused = ["<a@x> <b@x>", "a@x\nBcc: evil@example.com", "a@x\u0000y", "a@x\u0085y", "<a@x", "<<a@x>>"];
	for (const inReplyTo of refused) {
		expect(() => parseEmail({ ...OK, inReplyTo })).toThrow("Message-Id");
	}
});

test("the account is checked with the rest of the message: left out it is null, a plain name is kept, anything else is refused", () => {
	expect(parseEmail(OK).account).toBeNull();
	expect(parseEmail({ ...OK, account: " company " }).account).toBe("company");
	for (const account of ["", "--debug", "a b", "company\nBcc: evil@example.com", "x".repeat(65), 7]) {
		expect(() => parseEmail({ ...OK, account } as never)).toThrow(
			"`account` must be the name of a himalaya account",
		);
	}
});

test("the account chooses where the mail goes out from and is never written into the message", () => {
	expect(build({ ...OK, account: "company" })).toBe(build(OK));
});
