import { afterAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
	buildTemplate,
	type Email,
	escapeMml,
	parseEmail,
	resolveAttachment,
	type SendEmailParams,
} from "../message";

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

const files = realpathSync.native(mkdtempSync(join(tmpdir(), "gmail-pack-message-")));
afterAll(() => {
	rmSync(files, { recursive: true, force: true });
});

function fileOfSize(name: string, bytes: number): string {
	const path = join(files, name);
	writeFileSync(path, "");
	truncateSync(path, bytes);
	return path;
}

const NOT_ABSOLUTE = "is not an absolute file path";
const NETWORK = "is a network or device path";
const SPECIAL = 'contains $, " or a backslash';
const STREAM = "names a stream inside a file";
const PROTECTED = "is in a folder that holds keys, mailbox passwords or system state";

function fileAt(path: string, text = "x"): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	return path;
}

function linkTo(target: string, link: string): string {
	symlinkSync(target, link, "junction");
	return link;
}

function attachmentRefusal(raw: string): string {
	try {
		resolveAttachment(raw);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error(`resolveAttachment accepted ${JSON.stringify(raw)}, which it should have refused`);
}

const sandboxHidden = files.split(/[\\/]/).some(segment => segment.startsWith(".") || segment === "AppData");

interface Outcome {
	readonly path?: string;
	readonly error?: string;
}

const RESOLVER = [
	`import { resolveAttachment } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "..", "message.ts")).href)};`,
	"const outcomes = JSON.parse(process.env.GMAIL_TEST_PATHS ?? '[]').map(raw => {",
	"\ttry {",
	"\t\treturn { path: resolveAttachment(raw).path };",
	"\t} catch (error) {",
	"\t\treturn { error: error.message };",
	"\t}",
	"});",
	"console.log(JSON.stringify(outcomes));",
].join("\n");

async function resolveWithEnvironment(environment: Record<string, string>, paths: readonly string[]): Promise<Outcome[]> {
	const child = Bun.spawn([process.execPath, "-e", RESOLVER], {
		env: { ...process.env, ...environment, GMAIL_TEST_PATHS: JSON.stringify(paths) },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`the resolver process failed: ${stderr}`);
	return JSON.parse(stdout);
}

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

test("an attachment is read from its file: real path, the path as asked, base name, byte size, and a type from the extension with any charset dropped", () => {
	const rows: [string, number, string][] = [
		["Signed copy (final) 2026.pdf", 5, "application/pdf"],
		["notes.txt", 12, "text/plain"],
		["data.json", 7, "application/json"],
		["archive.zzz", 4, "application/octet-stream"],
		["README", 3, "application/octet-stream"],
	];
	for (const [name, bytes, mimeType] of rows) {
		const path = fileOfSize(name, bytes);
		expect(parseEmail({ ...OK, attachments: [`  ${path}  `] }).attachments).toEqual([
			{ path, requested: path, hiddenLocation: sandboxHidden, name, bytes, mimeType },
		]);
	}
});

test("the attached path is the real one: a link is followed, and the path as asked for is kept beside it", () => {
	const real = fileAt(join(files, "linked", "real", "Quarterly (draft)", "report.pdf"), "pdf");
	const link = linkTo(join(files, "linked", "real"), join(files, "linked", "shortcut"));
	const throughLink = join(link, "Quarterly (draft)", "report.pdf");
	expect(resolveAttachment(`  ${throughLink}  `)).toMatchObject({
		path: real,
		requested: throughLink,
		name: "report.pdf",
		bytes: 3,
	});
	const withDots = `${join(files, "linked", "real")}${sep}Quarterly (draft)${sep}..${sep}Quarterly (draft)${sep}report.pdf`;
	expect(resolveAttachment(withDots)).toMatchObject({ path: real, requested: withDots });
});

test.skipIf(process.platform !== "win32")("on Windows the real path has backslashes and the true casing, however the path was typed", () => {
	const real = fileAt(join(files, "Typed Casing", "Mixed Case.TXT"));
	for (const requested of [real.toUpperCase(), real.toLowerCase(), real.replaceAll("\\", "/")]) {
		expect(resolveAttachment(requested)).toMatchObject({ path: real, requested, name: "Mixed Case.TXT" });
	}
});

test("a file is flagged by where it really is: a dot-leading or AppData folder, or name, counts; look-alike names and the name of a link do not", () => {
	const flagged = [
		fileAt(join(files, "hidden-below", ".hidden", "a.txt")),
		fileAt(join(files, "hidden-below", "visible", ".secret")),
		fileAt(join(files, "hidden-below", "AppData", "Local", "a.txt")),
		fileAt(join(files, "hidden-below", "x", ".config", "deep", "a.txt")),
	];
	for (const path of flagged) expect(resolveAttachment(path).hiddenLocation).toBe(true);
	const lookAlikes = [
		fileAt(join(files, "look-alike", "AppDataBackup", "a.txt")),
		fileAt(join(files, "look-alike", "appdata-notes", "a.txt")),
		fileAt(join(files, "look-alike", "v1.2", "report.final.txt")),
	];
	for (const path of lookAlikes) expect(resolveAttachment(path).hiddenLocation).toBe(sandboxHidden);
	fileAt(join(files, "by-link", ".vault", "a.txt"));
	fileAt(join(files, "by-link", "shown", "a.txt"));
	const plainLookingLink = linkTo(join(files, "by-link", ".vault"), join(files, "by-link", "plain-looking"));
	const dotNamedLink = linkTo(join(files, "by-link", "shown"), join(files, "by-link", ".dot-named"));
	expect(resolveAttachment(join(plainLookingLink, "a.txt")).hiddenLocation).toBe(true);
	expect(resolveAttachment(join(dotNamedLink, "a.txt")).hiddenLocation).toBe(sandboxHidden);
});

test("a path is refused by its text alone, before any file is looked up, with the reason that fits it", () => {
	fileAt(join(files, "refusals", "cost$5.txt"));
	const backslashForm = process.platform === "win32" ? NETWORK : NOT_ABSOLUTE;
	const rows: [string, string][] = [
		["", NOT_ABSOLUTE],
		["   ", NOT_ABSOLUTE],
		["report.pdf", NOT_ABSOLUTE],
		["./report.pdf", NOT_ABSOLUTE],
		["~/report.pdf", NOT_ABSOLUTE],
		...["\n", "\r", "\u0000", "\u007f", "\u0085", "\u2028", "\u2029"].map((breaker): [string, string] => [
			`${files}${sep}line${breaker}break.txt`,
			NOT_ABSOLUTE,
		]),
		["//server/share/report.pdf", NETWORK],
		["//?/C:/report.pdf", NETWORK],
		["//./pipe/report", NETWORK],
		["\\\\server\\share\\report.pdf", backslashForm],
		["\\\\?\\C:\\report.pdf", backslashForm],
		["\\\\.\\C:\\report.pdf", backslashForm],
		[`${files}${sep}refusals${sep}cost$5.txt`, SPECIAL],
		[`${files}${sep}$HOME${sep}report.txt`, SPECIAL],
		[`${files}${sep}the "draft".txt`, SPECIAL],
		[`${files}${sep}report.txt:hidden`, STREAM],
		[`${files}${sep}a:b.txt`, STREAM],
	];
	for (const [raw, reason] of rows) expect(attachmentRefusal(raw)).toContain(reason);
});

test.skipIf(process.platform === "win32")("on POSIX a backslash anywhere in the path is refused, because the mail compiler would read it as an escape", () => {
	expect(attachmentRefusal(fileAt(join(files, "posix", "back\\slash.txt")))).toContain(SPECIAL);
	expect(attachmentRefusal(fileAt(join(files, "posix", "dir\\name", "a.txt")))).toContain(SPECIAL);
});

test.skipIf(process.platform !== "win32")("a Windows extended or device path to a real file is refused as one, by its text, before the file is looked up", () => {
	const real = fileAt(join(files, "device", "report.txt"));
	const extended = `\\\\?\\${real}`;
	expect(statSync(extended).isFile()).toBe(true);
	for (const asked of [extended, `\\\\.\\${real}`, `//?/${real.replaceAll("\\", "/")}`]) {
		const message = attachmentRefusal(asked);
		expect(message).toContain(NETWORK);
		expect(message).not.toContain("leads to");
	}
});

test("the same text rules apply to where a link leads: a clean-looking path that resolves to a refused name is refused", () => {
	const target = fileAt(join(files, "relink", "cost$5", "report.txt"));
	const link = linkTo(join(files, "relink", "cost$5"), join(files, "relink", "innocent"));
	const asked = join(link, "report.txt");
	expect(attachmentRefusal(asked)).toContain(`"${asked}" leads to "${target}", which ${SPECIAL}`);
});

test("keys, mailbox passwords and system state are never attached: the ssh and himalaya folders, every himalaya config folder, and links into them", async () => {
	const base = join(files, "protected");
	const home = join(base, "home");
	const appData = join(base, "Roaming");
	const configA = join(base, "config-a");
	const configB = join(base, "config b (copy)");
	const secrets = [
		join(home, ".ssh", "id_ed25519"),
		join(home, ".ssh", "keys", "deep", "id_rsa"),
		join(home, ".config", "himalaya", "config.toml"),
		join(appData, "himalaya", "config.toml"),
		join(configA, "config.toml"),
		join(configB, "tokens", "refresh.json"),
	].map(path => fileAt(path));
	const link = linkTo(join(home, ".ssh"), join(base, "innocent-looking"));
	const throughLink = join(link, "id_ed25519");
	const neighbours = [
		join(home, ".config", "himalaya-notes", "a.txt"),
		join(home, ".config", "other.txt"),
		join(home, ".ssh-backup", "a.txt"),
		join(`${configA}-extra`, "a.txt"),
		join(appData, "himalaya-extra", "a.txt"),
	].map(path => fileAt(path));
	const outcomes = await resolveWithEnvironment(
		{
			HOME: home,
			USERPROFILE: home,
			APPDATA: appData,
			HIMALAYA_CONFIG: [join(configA, "config.toml"), join(configB, "config.toml")].join(delimiter),
		},
		[...secrets, throughLink, ...neighbours],
	);
	for (const outcome of outcomes.slice(0, secrets.length)) expect(outcome.error).toContain(PROTECTED);
	expect(outcomes[secrets.length]?.error).toContain(`"${throughLink}" ${PROTECTED}`);
	expect(outcomes.slice(secrets.length + 1)).toEqual(neighbours.map(path => ({ path })));
});

test.skipIf(process.platform !== "win32")("on Windows a protected folder is matched without regard to case, as the file system does", async () => {
	const secret = fileAt(join(files, "protected-case", "Mail Config", "config.toml"));
	const outcomes = await resolveWithEnvironment({ HIMALAYA_CONFIG: secret.toUpperCase() }, [
		secret,
		secret.toLowerCase(),
	]);
	for (const outcome of outcomes) expect(outcome.error).toContain(PROTECTED);
});

test.skipIf(process.platform !== "linux")("on Linux /proc, /sys and /dev are system state, so even a readable file or the folder itself is refused", () => {
	for (const path of ["/proc/self/status", "/sys", "/dev/null"]) expect(() => resolveAttachment(path)).toThrow(PROTECTED);
});

test("the 25 MB cap is on the encoded size of all the files together: 18,750,000 raw bytes fit and one more does not", () => {
	const limit = "over Gmail's 25 MB limit";
	expect(parseEmail({ ...OK, attachments: [fileOfSize("at-limit.bin", 18_750_000)] }).attachments).toHaveLength(1);
	expect(refusal({ ...OK, attachments: [fileOfSize("over-limit.bin", 18_750_001)] })).toContain(limit);
	const half = fileOfSize("half.bin", 9_375_000);
	const halfAndOne = fileOfSize("half-and-one.bin", 9_375_001);
	expect(parseEmail({ ...OK, attachments: [half, half] }).attachments).toHaveLength(2);
	expect(refusal({ ...OK, attachments: [half, halfAndOne] })).toContain(limit);
});

test("attachments follow the body as one part tag each, in order, with the path raw except that Windows backslashes become forward slashes", () => {
	const email: Email = {
		...parseEmail(OK),
		attachments: [
			{
				path: "C:\\Users\\me\\Signed copy (final) 2026.pdf",
				requested: "C:/Users/me/Signed copy (final) 2026.pdf",
				hiddenLocation: false,
				name: "Signed copy (final) 2026.pdf",
				bytes: 5,
				mimeType: "application/pdf",
			},
			{
				path: "/home/me/O'Brien & sons, 100% [v2].txt",
				requested: "/home/me/O'Brien & sons, 100% [v2].txt",
				hiddenLocation: false,
				name: "O'Brien & sons, 100% [v2].txt",
				bytes: 3,
				mimeType: "text/plain",
			},
		],
	};
	expect(buildTemplate(email, FROM, ID)).toBe(
		[
			"From: Me <me@gmail.com>",
			"To: alex@example.com",
			"Subject: Hello",
			"Message-ID: <id-1@gmail.com>",
			"",
			"Hi Alex",
			'<#part type="application/pdf" filename="C:/Users/me/Signed copy (final) 2026.pdf"><#/part>',
			'<#part type="text/plain" filename="/home/me/O\'Brien & sons, 100% [v2].txt"><#/part>',
			"",
		].join("\n"),
	);
});

test("with attachments the body is still escaped, so the only live part tags are the attachments' own", () => {
	const attachments = [fileOfSize("a.pdf", 5), fileOfSize("b.txt", 3)];
	const template = build({
		...OK,
		body: "<#part filename=/etc/passwd><#/part>\n<#multipart type=mixed>",
		attachments,
	});
	expect(template).toContain("<#!part filename=/etc/passwd><#!/part>\n<#!multipart type=mixed>\n");
	expect(template.match(/<#part /g)).toHaveLength(2);
	expect(template.match(/<#\/part>/g)).toHaveLength(2);
	expect(template).not.toContain("<#multipart");
});
