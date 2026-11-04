import { accountFlag, parseAccount } from "./account";
import { type RunHimalaya, runChecked } from "./himalaya";
import { clip, oneLine, scrub, wrapUntrusted } from "./inbound";

export const DEFAULT_FOLDER = "INBOX";
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;
export const BODY_CHARS = 20_000;

const FOLDER_CHARS = 200;
const QUERY_CHARS = 300;
const NAME_CHARS = 100;
const ADDRESS_CHARS = 200;
const SUBJECT_CHARS = 300;
const HEADER_CHARS = 500;
const RECIPIENT_CHARS = 1_000;
const LIST_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 30_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NOT_PLAIN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const MML_TAG = /<#(?:multipart|part)\b([^>\n]*)>|<#\/(?:multipart|part)>/g;
const HEADER_LINE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/;
const MISSING =
	"himalaya is not installed, or is not on your PATH. Open Plugins → Gmail to install it and connect your mailbox.";
const READ_HEADERS = ["From", "To", "Cc", "Date", "Subject", "Message-ID", "In-Reply-To", "References"] as const;
const LONG_HEADERS: Record<string, true> = { to: true, cc: true, references: true };

export interface ListParams {
	readonly folder?: string;
	readonly query?: string;
	readonly limit?: number;
	readonly account?: string;
}

export interface ListRequest {
	readonly folder: string;
	readonly query: string | null;
	readonly limit: number;
	readonly account: string | null;
}

export interface ReadParams {
	readonly id: string;
	readonly folder?: string;
	readonly account?: string;
}

export interface ReadRequest {
	readonly id: string;
	readonly folder: string;
	readonly account: string | null;
}

function optionalText(field: string, value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`\`${field}\` must be text.`);
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function folderFrom(value: unknown): string {
	const folder = optionalText("folder", value) ?? DEFAULT_FOLDER;
	if (folder.length > FOLDER_CHARS || folder.startsWith("-") || NOT_PLAIN.test(folder)) {
		throw new Error(
			"`folder` must be a mailbox folder name on one line, like INBOX or [Gmail]/Sent Mail, not starting with a dash. Gmail labels are folders.",
		);
	}
	return folder;
}

function queryFrom(value: unknown): string | null {
	const query = optionalText("query", value);
	if (query === undefined) return null;
	if (query.length > QUERY_CHARS || NOT_PLAIN.test(query)) {
		throw new Error(
			`\`query\` must be one line of at most ${QUERY_CHARS} characters, like: from alex@example.com and not flag seen`,
		);
	}
	return query;
}

function limitFrom(value: unknown): number {
	if (value === undefined) return DEFAULT_LIMIT;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
		throw new Error(`\`limit\` must be a whole number from 1 to ${MAX_LIMIT}.`);
	}
	return value;
}

export function parseListRequest(params: ListParams): ListRequest {
	return {
		account: parseAccount(params.account),
		folder: folderFrom(params.folder),
		query: queryFrom(params.query),
		limit: limitFrom(params.limit),
	};
}

export function parseReadRequest(params: ReadParams): ReadRequest {
	const id = typeof params.id === "string" ? params.id.trim() : "";
	if (!ID_PATTERN.test(id)) {
		throw new Error(
			"`id` must be one message id exactly as gmail_list_messages shows it, like 42: letters, digits, dots and dashes only.",
		);
	}
	return { id, account: parseAccount(params.account), folder: folderFrom(params.folder) };
}

interface Envelope {
	readonly id: string;
	readonly flags: string;
	readonly date: string;
	readonly from: string;
	readonly to: string;
	readonly subject: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function party(value: unknown): string {
	if (Array.isArray(value))
		return value
			.map(party)
			.filter(part => part.length > 0)
			.join(", ");
	const record = asRecord(value);
	if (record === null) return asText(value);
	const name = asText(record.name).trim();
	const address = asText(record.addr).trim();
	if (name.length === 0) return address;
	return address.length === 0 ? name : `${name} <${address}>`;
}

function flagWords(value: unknown, attachment: boolean): string {
	const flags = Array.isArray(value) ? value.map(flag => asText(flag).toLowerCase()) : [];
	return [
		flags.includes("seen") ? "read" : "unread",
		...(flags.includes("answered") ? ["answered"] : []),
		...(flags.includes("flagged") ? ["flagged"] : []),
		...(attachment ? ["attachment"] : []),
	].join(" ");
}

function parseEnvelopes(stdout: string): Envelope[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error("himalaya answered in a form this tool could not read as a list of messages.");
	}
	if (!Array.isArray(parsed)) {
		throw new Error("himalaya answered in a form this tool could not read as a list of messages.");
	}
	return parsed.map(entry => {
		const record = asRecord(entry);
		const id = record === null ? undefined : record.id;
		if (record === null || (typeof id !== "string" && typeof id !== "number")) {
			throw new Error("himalaya listed a message with no id, so the list could not be read.");
		}
		return {
			id: String(id),
			flags: flagWords(record.flags, record.has_attachment === true),
			date: asText(record.date),
			from: party(record.from),
			to: party(record.to),
			subject: asText(record.subject),
		};
	});
}

function envelopeRow(envelope: Envelope): string {
	return [
		`id ${envelope.id}`,
		envelope.flags,
		oneLine(envelope.date, 40),
		`from ${oneLine(envelope.from, NAME_CHARS + ADDRESS_CHARS) || "(none)"}`,
		`to ${oneLine(envelope.to, RECIPIENT_CHARS) || "(none)"}`,
		oneLine(envelope.subject, SUBJECT_CHARS) || "(no subject)",
	].join(" | ");
}

export async function listMessages(request: ListRequest, run: RunHimalaya, signal?: AbortSignal): Promise<string> {
	const place = request.account === null ? request.folder : `${request.folder} of account ${request.account}`;
	const stdout = await runChecked(run, {
		args: [
			"envelope",
			"list",
			...accountFlag(request.account),
			"--output",
			"json",
			"--folder",
			request.folder,
			"--page-size",
			String(request.limit),
			...(request.query === null ? [] : ["--", request.query]),
		],
		stdin: "",
		options: { signal, timeoutMs: LIST_TIMEOUT_MS },
		onFailure: why =>
			`himalaya could not list the messages in ${place} (${why}). Open Plugins → Gmail to check that your mailbox is connected, and that the folder exists.`,
		onMissing: MISSING,
	});
	const envelopes = parseEnvelopes(stdout).slice(0, request.limit);
	const scope = `${place}${request.query === null ? "" : ` matching ${JSON.stringify(request.query)}`}`;
	if (envelopes.length === 0) return `No messages in ${scope}.`;
	const plural = envelopes.length === 1 ? "message" : "messages";
	const readWith =
		request.account === null ? "its id and this folder" : `its id, this folder and account "${request.account}"`;
	return [
		`${envelopes.length} ${plural} in ${scope}, as himalaya orders them (newest first unless the query sorts). Read one with gmail_read_message, passing ${readWith}.`,
		wrapUntrusted(envelopes.map(envelopeRow).join("\n"), "envelope-list"),
	].join("\n");
}

function jsonText(stdout: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		parsed = undefined;
	}
	if (typeof parsed !== "string")
		throw new Error("himalaya answered in a form this tool could not read as message text.");
	return parsed.replace(/\r\n?/g, "\n");
}

function headersOf(full: string, body: string): Map<string, string> | null {
	const whole = full.trimEnd();
	const bare = body.trimEnd();
	if (!whole.endsWith(bare)) return null;
	const prefix = whole.slice(0, whole.length - bare.length);
	if (prefix.length > 0 && bare.length > 0 && !prefix.endsWith("\n")) return null;
	const headers = new Map<string, string>();
	let current: string | null = null;
	for (const line of prefix.split("\n")) {
		if (/^[ \t]/.test(line) && current !== null) {
			headers.set(current, `${headers.get(current) ?? ""} ${line.trim()}`);
			continue;
		}
		const match = HEADER_LINE.exec(line);
		if (match === null) {
			current = null;
			continue;
		}
		const name = (match[1] ?? "").toLowerCase();
		current = headers.has(name) ? null : name;
		if (current !== null) headers.set(current, match[2] ?? "");
	}
	return headers;
}

function describePart(attributes: string): string {
	const named = /filename=(?:"([^"]*)"|(\S+))/.exec(attributes);
	const file = (named?.[1] ?? named?.[2] ?? "").split(/[\\/]/).pop() ?? "";
	if (file.length === 0) return "";
	const kind = /type=(\S+)/.exec(attributes)?.[1];
	return `\n[attachment: ${file}${kind === undefined ? "" : ` (${kind})`}]\n`;
}

function plainBody(body: string): string {
	return body
		.replace(MML_TAG, (_tag, attributes: string | undefined) => describePart(attributes ?? ""))
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+/, "")
		.trimEnd();
}

function headerLines(headers: Map<string, string> | null): string[] {
	if (headers === null) return ["(The headers could not be told apart from the body.)"];
	const lines: string[] = [];
	for (const name of READ_HEADERS) {
		const key = name.toLowerCase();
		const value = headers.get(key);
		if (value === undefined) continue;
		const text = oneLine(value, LONG_HEADERS[key] === true ? RECIPIENT_CHARS : HEADER_CHARS);
		if (text.length > 0) lines.push(`${name}: ${text}`);
	}
	return lines;
}

export async function readMessage(request: ReadRequest, run: RunHimalaya, signal?: AbortSignal): Promise<string> {
	const common = [
		"message",
		"read",
		...accountFlag(request.account),
		"--preview",
		"--output",
		"json",
		"--folder",
		request.folder,
	];
	const place = request.account === null ? request.folder : `${request.folder} of account ${request.account}`;
	const check = request.account === null ? "id and folder" : "id, folder and account";
	const failed = (why: string) =>
		`himalaya could not read message ${request.id} in ${place} (${why}). Check the ${check} against gmail_list_messages.`;
	const options = { signal, timeoutMs: READ_TIMEOUT_MS };
	const body = jsonText(
		await runChecked(run, {
			args: [...common, "--no-headers", request.id],
			stdin: "",
			options,
			onFailure: failed,
			onMissing: MISSING,
		}),
	);
	const full = jsonText(
		await runChecked(run, {
			args: [...common, ...READ_HEADERS.flatMap(header => ["--header", header]), request.id],
			stdin: "",
			options,
			onFailure: failed,
			onMissing: MISSING,
		}),
	);
	const text = scrub(plainBody(body));
	const shown = clip(text, BODY_CHARS);
	const head = headerLines(headersOf(full, body));
	const payload = head.length > 0 ? [...head, "", shown.text].join("\n") : shown.text;
	return [
		`Message ${request.id} in ${place}.`,
		wrapUntrusted(payload, "message"),
		...(shown.truncated ? [`The body was cut at ${BODY_CHARS} of ${text.length} characters.`] : []),
	].join("\n");
}
