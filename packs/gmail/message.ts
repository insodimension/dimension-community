import { realpathSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { parseAccount } from "./account";

export interface SendEmailParams {
	readonly to: readonly string[];
	readonly cc?: readonly string[];
	readonly bcc?: unknown;
	readonly subject: string;
	readonly body: string;
	readonly inReplyTo?: string;
	readonly account?: string;
	readonly attachments?: readonly string[];
}

export interface Attachment {
	readonly path: string;
	readonly requested: string;
	readonly hiddenLocation: boolean;
	readonly name: string;
	readonly bytes: number;
	readonly mimeType: string;
}

export interface Email {
	readonly to: readonly string[];
	readonly cc: readonly string[];
	readonly subject: string;
	readonly body: string;
	readonly inReplyTo: string | null;
	readonly account: string | null;
	readonly attachments: readonly Attachment[];
}

export const GMAIL_MESSAGE_LIMIT_BYTES = 25_000_000;

const ADDRESS =
	/^(?!\.)(?!.*\.\.)[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}(?<!\.)@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const MESSAGE_ID = /^[^\s<>]+$/;
const BCC_REFUSAL = "Bcc is not supported: send a separate message to each hidden recipient.";
const MML_TAG = /<#(part|multipart|\/part>|\/multipart>)/g;

export function isAddress(value: string): boolean {
	return value.length <= 254 && ADDRESS.test(value);
}

export function base64EncodedBytes(rawBytes: number): number {
	return Math.ceil(rawBytes / 3) * 4;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1000) return `${bytes} B`;
	if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
	return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function breaksALine(text: string): boolean {
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if ((code < 32 && code !== 9) || code === 127 || code === 0x85 || code === 0x2028 || code === 0x2029) return true;
	}
	return false;
}

function addressList(field: string, values: readonly string[] | undefined): readonly string[] {
	return (values ?? []).map(raw => {
		const value = raw.trim();
		if (!isAddress(value)) {
			throw new Error(
				`"${raw}" in \`${field}\` is not a plain email address. Give each address on its own, like alex@example.com: no names, no commas, no spaces.`,
			);
		}
		return value;
	});
}

const PROTECTED_FOLDERS: readonly string[] = [
	join(homedir(), ".ssh"),
	join(homedir(), ".config", "himalaya"),
	...(process.env.APPDATA === undefined ? [] : [join(process.env.APPDATA, "himalaya")]),
	...(process.env.HIMALAYA_CONFIG ?? "")
		.split(process.platform === "win32" ? ";" : ":")
		.filter(path => path.length > 0 && isAbsolute(path))
		.map(path => dirname(path)),
	...(process.platform === "win32" ? [] : ["/proc", "/sys", "/dev"]),
];

function pathRefusal(path: string): string | null {
	if (!isAbsolute(path) || breaksALine(path)) {
		return "is not an absolute file path. Give the full path of a file on this computer, like C:/Users/Me/Downloads/report.pdf";
	}
	if (/^[\\/]{2}/.test(path)) return "is a network or device path. Copy the file to this computer and attach that copy";
	if (path.includes("$") || path.includes('"') || (process.platform !== "win32" && path.includes("\\"))) {
		return 'contains $, " or a backslash, which the mail compiler would read as a different path. Rename or copy the file first';
	}
	if (path.indexOf(":", process.platform === "win32" ? 2 : 0) !== -1) {
		return "names a stream inside a file. Attach the file itself";
	}
	return null;
}

function isInside(path: string, folder: string): boolean {
	const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
	const child = relative(fold(folder), fold(path));
	return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export function resolveAttachment(raw: string): Attachment {
	const requested = raw.trim();
	const refusal = pathRefusal(requested);
	if (refusal !== null) throw new Error(`"${raw}" in \`attachments\` ${refusal}. Nothing was sent.`);
	let path: string;
	let stats: Stats;
	try {
		path = realpathSync.native(requested);
		stats = statSync(path);
	} catch {
		throw new Error(`There is no file at "${requested}", so nothing was sent. Check the path and try again.`);
	}
	const resolvedRefusal = pathRefusal(path);
	if (resolvedRefusal !== null) throw new Error(`"${requested}" leads to "${path}", which ${resolvedRefusal}. Nothing was sent.`);
	if (PROTECTED_FOLDERS.some(folder => isInside(path, folder))) {
		throw new Error(
			`"${requested}" is in a folder that holds keys, mailbox passwords or system state, so it is never attached. Nothing was sent.`,
		);
	}
	if (!stats.isFile()) throw new Error(`"${requested}" is not a file, so nothing was sent. Attach files one by one.`);
	const mimeType = Bun.file(path).type.split(";")[0]?.trim() || "application/octet-stream";
	const hiddenLocation = path.split(/[\\/]/).some(segment => segment.startsWith(".") || segment === "AppData");
	return { path, requested, name: basename(path), bytes: stats.size, mimeType, hiddenLocation };
}

function attachmentList(values: readonly string[] | undefined): readonly Attachment[] {
	const attachments = (values ?? []).map(resolveAttachment);
	const encoded = base64EncodedBytes(attachments.reduce((sum, attachment) => sum + attachment.bytes, 0));
	if (encoded > GMAIL_MESSAGE_LIMIT_BYTES) {
		throw new Error(
			`The attachments come to ${formatBytes(encoded)} once encoded, over Gmail's 25 MB limit, so nothing was sent. Send fewer or smaller files, or share a link instead.`,
		);
	}
	return attachments;
}

export function parseEmail(params: SendEmailParams): Email {
	const account = parseAccount(params.account);
	if (Array.isArray(params.bcc) ? params.bcc.length > 0 : Boolean(params.bcc)) throw new Error(BCC_REFUSAL);
	const to = addressList("to", params.to);
	if (to.length === 0) throw new Error("Name at least one recipient in `to`.");
	const subject = params.subject.trim();
	if (subject.length === 0) throw new Error("The subject is empty. Give the email a one-line subject.");
	if (breaksALine(subject)) throw new Error("The subject must be a single line, with no line breaks.");
	if (params.body.trim().length === 0) throw new Error("The body is empty. Write the email text to send.");
	let inReplyTo: string | null = null;
	if (params.inReplyTo !== undefined && params.inReplyTo.trim().length > 0) {
		const id = params.inReplyTo.trim().replace(/^<(.*)>$/, "$1");
		if (!MESSAGE_ID.test(id) || breaksALine(id)) {
			throw new Error(
				"`inReplyTo` must be one Message-Id, like <abc123@mail.example.com>, copied from the original email.",
			);
		}
		inReplyTo = `<${id}>`;
	}
	return {
		account,
		to,
		cc: addressList("cc", params.cc),
		subject,
		body: params.body,
		inReplyTo,
		attachments: attachmentList(params.attachments),
	};
}

export function escapeMml(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(MML_TAG, "<#!$1");
}

export function buildTemplate(email: Email, from: string, messageId: string): string {
	const headers = [
		`From: ${from}`,
		`To: ${email.to.join(", ")}`,
		...(email.cc.length > 0 ? [`Cc: ${email.cc.join(", ")}`] : []),
		`Subject: ${email.subject}`,
		`Message-ID: ${messageId}`,
		...(email.inReplyTo === null ? [] : [`In-Reply-To: ${email.inReplyTo}`, `References: ${email.inReplyTo}`]),
	];
	const body = escapeMml(email.body);
	if (email.attachments.length === 0) return `${headers.join("\n")}\n\n${body}`;
	const parts = email.attachments.map(
		attachment => `<#part type="${attachment.mimeType}" filename="${attachment.path.replaceAll("\\", "/")}"><#/part>`,
	);
	return `${headers.join("\n")}\n\n${body.endsWith("\n") ? body : `${body}\n`}${parts.join("\n")}\n`;
}
