import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type } from "arktype";
import { connectedProviders, PROVIDER_LABEL, PROVIDERS, type ProviderId, resolveProvider } from "./credentials.js";
import { type IssueStats, providerFor } from "./providers.js";

const OPENS_WARNING =
	"unreliable: Apple Mail Privacy Protection opens mail on its own, and readers in France and Italy may be untracked. A trend inside this list at most, never readership";

const providerField = type("'beehiiv' | 'kit' | 'buttondown' | 'ghost'").describe(
	"Which connected provider. Optional when exactly one is connected.",
);

const providerSchema = type({});

const listSchema = type({
	"provider?": providerField,
	"status?": type("'draft' | 'sent' | 'all'").describe("draft, sent or all (default all)."),
	"limit?": type("1 <= number.integer <= 50").describe("How many, newest first (default 10)."),
});

const statsSchema = type({
	"provider?": providerField,
	issueId: type("string > 0").describe("The issue's id from newsletter_list_issues."),
});

const audienceSchema = type({
	"provider?": providerField,
});

const draftSchema = type({
	"provider?": providerField,
	subject: type("string > 0").describe("The chosen subject line, exactly."),
	body: type("string > 0").describe("The chosen body, exactly: plain text, blank lines between paragraphs, bare https links."),
	"previewText?": type("string").describe("The chosen preview line shown after the subject in the inbox."),
});

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }] };
}

function statsLines(id: ProviderId, issueId: string, stats: IssueStats): string[] {
	const label = PROVIDER_LABEL[id];
	const unknown = `unknown (${label} does not report it)`;
	const base = stats.delivered ?? stats.recipients;
	const share = (value: number | undefined) =>
		value === undefined ? unknown : base ? `${value} (${((value / base) * 100).toFixed(1)}% of ${stats.delivered !== undefined ? "delivered" : "recipients"})` : String(value);
	const lines = [
		`${label} issue ${issueId}${stats.subject ? `: "${stats.subject}"` : ""}${stats.status ? ` (${stats.status})` : ""}. Read ${new Date().toISOString()} from the ${label} API.`,
		`Recipients: ${stats.recipients ?? unknown}`,
		`Delivered: ${stats.delivered ?? unknown}`,
		`Bounced or failed: ${stats.failures ?? unknown}`,
		`Complaints (marked as spam): ${share(stats.complaints)}`,
		`Unsubscribes: ${share(stats.unsubscribes)}`,
		`Clicks: ${share(stats.uniqueClicks)}`,
	];
	if (stats.verifiedClicks !== undefined) lines.push(`Verified human clicks: ${share(stats.verifiedClicks)}`);
	lines.push(`Replies: ${stats.replies ?? unknown}`);
	lines.push(`Opens: ${stats.opens === undefined ? unknown : `${stats.opens}, ${OPENS_WARNING}`}`);
	return [...lines, ...stats.notes];
}

function createProviderTool(): ToolDefinition<typeof providerSchema> {
	return {
		name: "newsletter_provider",
		label: "Newsletter: Provider",
		description:
			"Which email providers (beehiiv, Kit, Buttondown, Ghost) are connected, and the publication each key reaches, checked live. Call it first. Substack has no API: its drafts are a paste hand-off and its numbers are read from its stats pages.",
		parameters: providerSchema,
		approval: "read" as const,
		async execute() {
			const connected = connectedProviders();
			if (connected.length === 0) {
				return text(
					"No newsletter provider is connected. The person connects one under Plugins, Newsletter, Connect: beehiiv, Kit, Buttondown or Ghost. Substack has no API: hand the person the text to paste and read numbers from its stats pages.",
				);
			}
			const lines = await Promise.all(
				connected.map(async id => {
					try {
						return `${PROVIDER_LABEL[id]} (${id}): ${await (await providerFor(id)).identity()}`;
					} catch (error) {
						return `${PROVIDER_LABEL[id]} (${id}): connected, but the check failed: ${error instanceof Error ? error.message : String(error)}`;
					}
				}),
			);
			const missing = PROVIDERS.filter(id => !connected.includes(id)).map(id => PROVIDER_LABEL[id]);
			return text([...lines, ...(missing.length > 0 ? [`Not connected: ${missing.join(", ")}.`] : [])].join("\n"));
		},
	};
}

function createListTool(): ToolDefinition<typeof listSchema> {
	return {
		name: "newsletter_list_issues",
		label: "Newsletter: Issues",
		description: "List the connected provider's issues (drafts, sent or all), newest first, with id, status, date and web link. The ids feed newsletter_issue_stats.",
		parameters: listSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof listSchema.infer) {
			const id = resolveProvider(params.provider);
			const rows = await (await providerFor(id)).listIssues(params.status ?? "all", params.limit ?? 10);
			if (rows.length === 0) return text(`${PROVIDER_LABEL[id]}: no ${params.status === undefined || params.status === "all" ? "" : `${params.status} `}issues.`);
			return text(
				[
					`${PROVIDER_LABEL[id]}, ${rows.length} issue${rows.length === 1 ? "" : "s"}:`,
					...rows.map(row => `[${row.id}] ${row.status}  ${row.date?.slice(0, 10) ?? "no date"}  ${row.subject}${row.url ? `  ${row.url}` : ""}`),
				].join("\n"),
			);
		},
	};
}

function createStatsTool(): ToolDefinition<typeof statsSchema> {
	return {
		name: "newsletter_issue_stats",
		label: "Newsletter: Issue stats",
		description:
			"One sent issue's numbers from the provider's API: recipients, delivered, bounces, complaints, unsubscribes, clicks, replies, and opens marked unreliable. A number the provider does not report says unknown. The newsletter skill says how to judge them.",
		parameters: statsSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof statsSchema.infer) {
			const id = resolveProvider(params.provider);
			const stats = await (await providerFor(id)).issueStats(params.issueId);
			return text(statsLines(id, params.issueId, stats).join("\n"));
		},
	};
}

function createAudienceTool(): ToolDefinition<typeof audienceSchema> {
	return {
		name: "newsletter_audience",
		label: "Newsletter: Audience",
		description: "Subscriber counts from the connected provider (active, free and paid, and growth where the provider reports it). Counts only, never addresses.",
		parameters: audienceSchema,
		approval: "read" as const,
		async execute(_toolCallId: string, params: typeof audienceSchema.infer) {
			const id = resolveProvider(params.provider);
			const rows = await (await providerFor(id)).audience();
			return text(
				[
					`${PROVIDER_LABEL[id]} audience, read ${new Date().toISOString()}:`,
					...rows.map(([name, value]) => `${name}: ${value ?? `unknown (${PROVIDER_LABEL[id]} does not report it)`}`),
				].join("\n"),
			);
		},
	};
}

function createDraftTool(): ToolDefinition<typeof draftSchema> {
	return {
		name: "newsletter_issue_draft",
		label: "Newsletter: Save draft",
		description:
			"Save the chosen issue as an UNSENT draft in the person's email provider (beehiiv, Kit, Buttondown, Ghost) and return where to open it. It never sends, schedules or publishes: there is no parameter for that, and a draft the provider reports as anything but a draft is an error. The person reviews it there and presses Send. Pass the chosen subject and body exactly. Substack has no API: hand the text over to paste instead.",
		parameters: draftSchema,
		approval: "write" as const,
		async execute(_toolCallId: string, params: typeof draftSchema.infer) {
			if (!params.subject.trim() || !params.body.trim()) throw new Error("Refusing to save a draft with an empty subject or body.");
			const id = resolveProvider(params.provider);
			const draft = await (await providerFor(id)).createDraft({
				subject: params.subject,
				body: params.body,
				...(params.previewText ? { previewText: params.previewText } : {}),
			});
			return text(
				[
					`Unsent draft saved in ${PROVIDER_LABEL[id]}: "${params.subject}" [${draft.id}].`,
					`Open: ${draft.editUrl} (${draft.where}).`,
					`Nothing was sent. The person reviews it in ${PROVIDER_LABEL[id]} and presses Send; until then it is handed off, not published.`,
				].join("\n"),
			);
		},
	};
}

export default function newsletterExtension(pi: ExtensionAPI): void {
	pi.registerTool(createProviderTool());
	pi.registerTool(createListTool());
	pi.registerTool(createStatsTool());
	pi.registerTool(createAudienceTool());
	pi.registerTool(createDraftTool());
}
