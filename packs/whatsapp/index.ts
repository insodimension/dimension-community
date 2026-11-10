// WhatsApp connector — send WhatsApp messages via Meta's WhatsApp Cloud API,
// authenticated by the plugin's `form` connect flow (see fraym.plugin.json).
// The connect flow renders connect/token.template.json → {access, phoneNumberId}
// at CONFIG_TARGET; this extension's ONLY job is to read that credential and
// expose the four send tools. No Meta SDK — plain fetch against the documented
// Graph API, matching the rest of this repo's connectors.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";

// MUST match `connect.configTarget` in fraym.plugin.json — the connect flow
// (packages/engine/src/plugin-connect.ts) renders connect/token.template.json
// there; this is the ONLY other place that path is spelled out (a JSON manifest
// can't share a TS constant with this file).
const CONFIG_TARGET = join(homedir(), ".config", "dimension-whatsapp", "token.json");
const GRAPH_API = "https://graph.facebook.com/v23.0";
// Meta's WhatsApp sample template ships in US English; default to it so a bare
// "send the hello_world template" works without the user knowing locale codes.
const DEFAULT_TEMPLATE_LANGUAGE = "en_US";

const storedCredential = type({
	access: "string",
	phoneNumberId: "string",
});
type StoredCredential = typeof storedCredential.infer;

async function readCredential(): Promise<StoredCredential> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_TARGET, "utf-8");
	} catch {
		throw new Error(
			"WhatsApp isn't connected yet. Open the plugin's Connect dialog (Plugins → WhatsApp → Set up) and paste your access token + Phone number ID.",
		);
	}
	const parsed = storedCredential(JSON.parse(raw));
	if (parsed instanceof type.errors) {
		throw new Error(`WhatsApp's stored credential at ${CONFIG_TARGET} is malformed. Reconnect the plugin.`);
	}
	return parsed;
}

interface GraphError {
	readonly message?: string;
	readonly type?: string;
	readonly code?: number;
}

interface SendResponse {
	readonly messages?: ReadonlyArray<{ readonly id?: string }>;
	readonly error?: GraphError;
}

// POST a message payload to the Cloud API's /{phoneNumberId}/messages endpoint.
// Surfaces Meta's `error.message` verbatim so the agent can relay the exact
// cause (e.g. the recipient-not-registered or 24h-window errors) to the user.
async function sendMessage(
	cred: StoredCredential,
	payload: Readonly<Record<string, unknown>>,
	op: string,
): Promise<string> {
	const res = await fetch(`${GRAPH_API}/${encodeURIComponent(cred.phoneNumberId)}/messages`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${cred.access}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
	});
	const body = (await res.json().catch(() => null)) as SendResponse | null;
	if (!res.ok || !body || body.error) {
		throw new Error(`WhatsApp ${op} failed: ${body?.error?.message ?? res.statusText}`);
	}
	const id = body.messages?.[0]?.id;
	if (!id) {
		throw new Error(`WhatsApp ${op} returned no message id (body: ${JSON.stringify(body)}).`);
	}
	return id;
}

/** One string argument off unvalidated tool args, for an approval card;
 *  `absent` stands in when it is not a non-empty string (the tools skip an empty
 *  optional field). Never throws: the card renders before the schema checks the
 *  call. Shown in full — WhatsApp caps a text at 4096 characters. */
function approvalArg(args: unknown, key: string, absent = "(missing)"): string {
	const value: unknown = typeof args === "object" && args !== null ? Reflect.get(args, key) : undefined;
	return typeof value === "string" && value.length > 0 ? value : absent;
}

const sendMessageSchema = type({
	to: type("string").describe(
		"Recipient phone number in international format (country code + number, digits only, e.g. 447700900123). This person MUST have messaged your number within the last 24h.",
	),
	body: type("string").describe("The plain-text message body to send."),
});

const sendTemplateSchema = type({
	to: type("string").describe(
		"Recipient phone number in international format (country code + number, digits only, e.g. 447700900123).",
	),
	template: type("string").describe('The approved template name, e.g. "hello_world".'),
	"languageCode?": type("string").describe('Template language/locale code — defaults to "en_US".'),
});

const sendImageSchema = type({
	to: type("string").describe(
		"Recipient phone number in international format (country code + number, digits only, e.g. 447700900123). This person MUST have messaged your number within the last 24h — media, like free-form text, is blocked outside the customer-service window.",
	),
	imageUrl: type("string").describe(
		"Publicly reachable HTTPS URL of the image to send (jpg/png). Meta downloads it server-side, so it must be accessible without auth.",
	),
	"caption?": type("string").describe("Optional caption text shown beneath the image."),
});

const sendDocumentSchema = type({
	to: type("string").describe(
		"Recipient phone number in international format (country code + number, digits only, e.g. 447700900123). This person MUST have messaged your number within the last 24h — media, like free-form text, is blocked outside the customer-service window.",
	),
	documentUrl: type("string").describe(
		"Publicly reachable HTTPS URL of the document to send (pdf, docx, etc.). Meta downloads it server-side, so it must be accessible without auth.",
	),
	"filename?": type("string").describe(
		'Optional filename shown to the recipient (e.g. "invoice.pdf"). Defaults to the name Meta derives from the URL.',
	),
	"caption?": type("string").describe("Optional caption text shown alongside the document."),
});

function createSendMessageTool(): ToolDefinition<typeof sendMessageSchema> {
	return {
		name: "whatsapp_send_message",
		label: "WhatsApp: Send Message",
		description:
			"Send a free-form text WhatsApp message to a recipient. DESTRUCTIVE. Free-form text ONLY reaches people who messaged your number within the last 24 hours (the customer-service window); for first contact or any message outside that window a pre-approved template is required — use whatsapp_send_template instead. Returns the sent message id.",
		parameters: sendMessageSchema,
		approval: "write",
		formatApprovalDetails(args: unknown) {
			return [`To: ${approvalArg(args, "to")}`, `Message:\n${approvalArg(args, "body")}`];
		},
		async execute(_toolCallId: string, params: typeof sendMessageSchema.infer) {
			const cred = await readCredential();
			const id = await sendMessage(
				cred,
				{ to: params.to, type: "text", text: { body: params.body } },
				"send_message",
			);
			return { content: [{ type: "text" as const, text: `Message sent to ${params.to} (id: ${id}).` }] };
		},
	};
}

function createSendTemplateTool(): ToolDefinition<typeof sendTemplateSchema> {
	return {
		name: "whatsapp_send_template",
		label: "WhatsApp: Send Template",
		description:
			'Send a pre-approved WhatsApp message template to a recipient — required for first contact or any message outside the 24-hour customer-service window (where free-form text is blocked). DESTRUCTIVE. Language code defaults to "en_US". Returns the sent message id.',
		parameters: sendTemplateSchema,
		approval: "write",
		formatApprovalDetails(args: unknown) {
			return [
				`To: ${approvalArg(args, "to")}`,
				`Template: ${approvalArg(args, "template")}`,
				`Language: ${approvalArg(args, "languageCode", DEFAULT_TEMPLATE_LANGUAGE)}`,
			];
		},
		async execute(_toolCallId: string, params: typeof sendTemplateSchema.infer) {
			const cred = await readCredential();
			const id = await sendMessage(
				cred,
				{
					to: params.to,
					type: "template",
					template: {
						name: params.template,
						language: { code: params.languageCode ?? DEFAULT_TEMPLATE_LANGUAGE },
					},
				},
				"send_template",
			);
			return {
				content: [
					{
						type: "text" as const,
						text: `Template "${params.template}" sent to ${params.to} (id: ${id}).`,
					},
				],
			};
		},
	};
}

function createSendImageTool(): ToolDefinition<typeof sendImageSchema> {
	return {
		name: "whatsapp_send_image",
		label: "WhatsApp: Send Image",
		description:
			"Send an image (from a public HTTPS URL) to a WhatsApp recipient, with an optional caption. DESTRUCTIVE. Like free-form text, media ONLY reaches people who messaged your number within the last 24 hours (the customer-service window); outside it a pre-approved template is required instead. Returns the sent message id.",
		parameters: sendImageSchema,
		approval: "write",
		formatApprovalDetails(args: unknown) {
			return [
				`To: ${approvalArg(args, "to")}`,
				`Image: ${approvalArg(args, "imageUrl")}`,
				`Caption:\n${approvalArg(args, "caption", "(none)")}`,
			];
		},
		async execute(_toolCallId: string, params: typeof sendImageSchema.infer) {
			const cred = await readCredential();
			const image: Record<string, string> = { link: params.imageUrl };
			if (params.caption) image.caption = params.caption;
			const id = await sendMessage(cred, { to: params.to, type: "image", image }, "send_image");
			return { content: [{ type: "text" as const, text: `Image sent to ${params.to} (id: ${id}).` }] };
		},
	};
}

function createSendDocumentTool(): ToolDefinition<typeof sendDocumentSchema> {
	return {
		name: "whatsapp_send_document",
		label: "WhatsApp: Send Document",
		description:
			"Send a document/file (from a public HTTPS URL) to a WhatsApp recipient, with an optional filename and caption. DESTRUCTIVE. Like free-form text, media ONLY reaches people who messaged your number within the last 24 hours (the customer-service window); outside it a pre-approved template is required instead. Returns the sent message id.",
		parameters: sendDocumentSchema,
		approval: "write",
		formatApprovalDetails(args: unknown) {
			return [
				`To: ${approvalArg(args, "to")}`,
				`Document: ${approvalArg(args, "documentUrl")}`,
				`Filename: ${approvalArg(args, "filename", "(derived from the URL)")}`,
				`Caption:\n${approvalArg(args, "caption", "(none)")}`,
			];
		},
		async execute(_toolCallId: string, params: typeof sendDocumentSchema.infer) {
			const cred = await readCredential();
			const doc: Record<string, string> = { link: params.documentUrl };
			if (params.filename) doc.filename = params.filename;
			if (params.caption) doc.caption = params.caption;
			const id = await sendMessage(cred, { to: params.to, type: "document", document: doc }, "send_document");
			return { content: [{ type: "text" as const, text: `Document sent to ${params.to} (id: ${id}).` }] };
		},
	};
}

/**
 * WhatsApp plugin. A standard OMP plugin — `skills/`/`rules/` load via OMP's
 * native plugin discovery. This module registers the four send tools; the
 * connect flow (fraym.plugin.json's `connect.form`) obtains and stores the
 * {access, phoneNumberId} credential these tools read.
 */
export default function whatsappExtension(pi: ExtensionAPI): void {
	pi.registerTool(createSendMessageTool());
	pi.registerTool(createSendTemplateTool());
	pi.registerTool(createSendImageTool());
	pi.registerTool(createSendDocumentTool());
}
