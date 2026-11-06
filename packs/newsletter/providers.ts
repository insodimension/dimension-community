import { createHmac } from "node:crypto";
import {
	type BeehiivCredential,
	connectPath,
	type GhostCredential,
	type KeyCredential,
	PROVIDER_LABEL,
	type ProviderId,
	readCredential,
} from "./credentials.js";

const REQUEST_TIMEOUT_MS = 30_000;
const GHOST_TOKEN_SECONDS = 300;

export type IssueFilter = "draft" | "sent" | "all";

export interface DraftInput {
	readonly subject: string;
	readonly body: string;
	readonly previewText?: string;
}

export interface DraftResult {
	readonly id: string;
	readonly editUrl: string;
	readonly where: string;
}

export interface IssueRow {
	readonly id: string;
	readonly subject: string;
	readonly status: string;
	readonly date?: string;
	readonly url?: string;
}

export interface IssueStats {
	readonly subject?: string;
	readonly status?: string;
	readonly recipients?: number;
	readonly delivered?: number;
	readonly opens?: number;
	readonly uniqueClicks?: number;
	readonly verifiedClicks?: number;
	readonly unsubscribes?: number;
	readonly complaints?: number;
	readonly failures?: number;
	readonly replies?: number;
	readonly notes: readonly string[];
}

export interface NewsletterProvider {
	readonly id: ProviderId;
	identity(): Promise<string>;
	listIssues(filter: IssueFilter, limit: number): Promise<IssueRow[]>;
	issueStats(issueId: string): Promise<IssueStats>;
	audience(): Promise<Array<readonly [string, number | undefined]>>;
	createDraft(input: DraftInput): Promise<DraftResult>;
}

function errorText(payload: unknown): string | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const record = payload as Record<string, unknown>;
	if (Array.isArray(record.errors)) {
		const parts = record.errors
			.map(item => (typeof item === "string" ? item : typeof item?.message === "string" ? item.message : undefined))
			.filter((item): item is string => item !== undefined);
		if (parts.length > 0) return parts.join("; ");
	}
	for (const key of ["detail", "message", "error"]) {
		if (typeof record[key] === "string") return record[key] as string;
	}
	return undefined;
}

async function call<T>(id: ProviderId, url: string, what: string, init: RequestInit = {}): Promise<T> {
	const label = PROVIDER_LABEL[id];
	let res: Response;
	try {
		res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	} catch (error) {
		throw new Error(`${label} did not answer (${what}): ${error instanceof Error ? error.message : String(error)}`);
	}
	const text = await res.text();
	let payload: unknown = null;
	try {
		payload = text ? JSON.parse(text) : null;
	} catch {
		payload = null;
	}
	if (res.ok) return payload as T;
	const detail = errorText(payload) ?? (text.slice(0, 200) || res.statusText);
	if (res.status === 401) {
		throw new Error(`${label} rejected the saved key (${detail}). The person reconnects under ${connectPath(id)}.`);
	}
	if (res.status === 403) {
		throw new Error(
			`${label} refused ${what} for this key (${detail}). Usually the plan does not include API access for it, or the key lacks the permission; the newsletter skill lists what each plan allows.`,
		);
	}
	if (res.status === 429) throw new Error(`${label} rate limit hit (${what}). Wait a minute and try once more.`);
	throw new Error(`${label} refused ${what}: HTTP ${res.status} ${detail}`);
}

export function bodyHtml(body: string): string {
	return body
		.replace(/\r\n?/g, "\n")
		.split(/\n{2,}/)
		.map(paragraph => paragraph.trim())
		.filter(paragraph => paragraph.length > 0)
		.map(paragraph => {
			const escaped = paragraph.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
			const linked = escaped.replace(/https?:\/\/[^\s<]+?(?=[.,;:!?)]*(?:\s|$))/g, url => `<a href="${url}">${url}</a>`);
			return `<p>${linked.split("\n").join("<br>")}</p>`;
		})
		.join("\n");
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface BeehiivPost {
	id: string;
	title?: string;
	subject_line?: string;
	status?: string;
	created?: number;
	publish_date?: number;
	web_url?: string;
	preview_url?: string;
	stats?: {
		email?: Record<string, unknown>;
	};
}

const beehiivPublications = new Map<string, string>();

function beehiiv(cred: BeehiivCredential): NewsletterProvider {
	const api = "https://api.beehiiv.com/v2";
	const headers = { Authorization: `Bearer ${cred.access}`, Accept: "application/json" };
	const publicationId = async (): Promise<string> => {
		const known = cred.publicationId?.trim() || beehiivPublications.get(cred.access);
		if (known) return known;
		const list = await call<{ data?: Array<{ id: string; name?: string }> }>("beehiiv", `${api}/publications?limit=100`, "listing publications", { headers });
		const found = list?.data ?? [];
		if (found.length === 1 && found[0]) {
			beehiivPublications.set(cred.access, found[0].id);
			return found[0].id;
		}
		if (found.length === 0) throw new Error("This beehiiv key sees no publication.");
		throw new Error(
			`This beehiiv key sees ${found.length} publications (${found.map(item => `${item.name ?? "?"} ${item.id}`).join(", ")}). Reconnect under ${connectPath("beehiiv")} and fill in the publication id.`,
		);
	};
	return {
		id: "beehiiv",
		async identity() {
			const pub = await publicationId();
			const shown = await call<{ data?: { name?: string } }>("beehiiv", `${api}/publications/${pub}`, "reading the publication", { headers });
			return `${shown?.data?.name ?? "publication"} (${pub})`;
		},
		async listIssues(filter, limit) {
			const pub = await publicationId();
			const status = filter === "draft" ? "draft" : filter === "sent" ? "confirmed" : "all";
			const page = await call<{ data?: BeehiivPost[] }>(
				"beehiiv",
				`${api}/publications/${pub}/posts?limit=${limit}&status=${status}&order_by=created&direction=desc`,
				"listing posts",
				{ headers },
			);
			return (page?.data ?? []).map(post => {
				const seconds = post.publish_date || post.created;
				return {
					id: post.id,
					subject: post.subject_line || post.title || "(no subject)",
					status: post.status ?? "?",
					date: seconds ? new Date(seconds * 1000).toISOString() : undefined,
					url: post.web_url || undefined,
				};
			});
		},
		async issueStats(issueId) {
			const pub = await publicationId();
			const shown = await call<{ data?: BeehiivPost }>("beehiiv", `${api}/publications/${pub}/posts/${encodeURIComponent(issueId)}?expand[]=stats`, "reading post stats", {
				headers,
			});
			const post = shown?.data;
			const email = post?.stats?.email ?? {};
			return {
				subject: post?.subject_line || post?.title,
				status: post?.status,
				recipients: count(email.recipients),
				delivered: count(email.delivered),
				opens: count(email.unique_opens),
				uniqueClicks: count(email.unique_clicks),
				verifiedClicks: count(email.unique_verified_clicks),
				unsubscribes: count(email.unsubscribes),
				complaints: count(email.spam_reports),
				notes: [],
			};
		},
		async audience() {
			const pub = await publicationId();
			const shown = await call<{ data?: { stats?: Record<string, unknown> } }>("beehiiv", `${api}/publications/${pub}?expand[]=stats`, "reading subscriber counts", { headers });
			const stats = shown?.data?.stats ?? {};
			return [
				["Active subscriptions", count(stats.active_subscriptions)],
				["Free", count(stats.active_free_subscriptions)],
				["Premium", count(stats.active_premium_subscriptions)],
			] as const;
		},
		async createDraft(input) {
			const pub = await publicationId();
			const email_settings: Record<string, string> = { email_subject_line: input.subject };
			if (input.previewText) email_settings.email_preview_text = input.previewText;
			const created = await call<{ data?: BeehiivPost }>("beehiiv", `${api}/publications/${pub}/posts`, "creating the draft post", {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ title: input.subject, body_content: bodyHtml(input.body), status: "draft", email_settings }),
			});
			const post = created?.data;
			if (!post?.id) throw new Error("beehiiv accepted the post but returned no id. Check the Posts list in beehiiv before trying again.");
			const editUrl = post.preview_url || `https://app.beehiiv.com/posts/${post.id}/preview`;
			if (post.status !== undefined && post.status !== "draft") {
				throw new Error(`beehiiv created post ${post.id} with status "${post.status}", not "draft". Open ${editUrl} now and make sure it is not scheduled.`);
			}
			return { id: post.id, editUrl, where: "beehiiv, Posts, Drafts" };
		},
	};
}

interface KitBroadcast {
	id: number;
	subject?: string;
	status?: string;
	send_at?: string | null;
	public?: boolean;
	published_at?: string | null;
	created_at?: string;
	public_url?: string | null;
}

function kit(cred: KeyCredential): NewsletterProvider {
	const api = "https://api.kit.com/v4";
	const headers = { "X-Kit-Api-Key": cred.access, Accept: "application/json" };
	return {
		id: "kit",
		async identity() {
			const me = await call<{ account?: { name?: string; plan_type?: string } }>("kit", `${api}/account`, "reading the account", { headers });
			return `${me?.account?.name ?? "account"}${me?.account?.plan_type ? ` (${me.account.plan_type} plan)` : ""}`;
		},
		async listIssues(filter, limit) {
			const status = filter === "draft" ? "&status=draft" : filter === "sent" ? "&status=completed" : "";
			const page = await call<{ broadcasts?: KitBroadcast[] }>("kit", `${api}/broadcasts?per_page=${limit}&slim=true${status}`, "listing broadcasts", { headers });
			return (page?.broadcasts ?? []).slice(0, limit).map(item => ({
				id: String(item.id),
				subject: item.subject || "(no subject)",
				status: item.status ?? (item.send_at ? "scheduled" : "draft"),
				date: item.send_at ?? item.published_at ?? item.created_at ?? undefined,
				url: item.public_url ?? undefined,
			}));
		},
		async issueStats(issueId) {
			const shown = await call<{ broadcast?: { stats?: Record<string, unknown> } }>("kit", `${api}/broadcasts/${encodeURIComponent(issueId)}/stats`, "reading broadcast stats", {
				headers,
			});
			const stats = shown?.broadcast?.stats ?? {};
			const notes: string[] = [];
			if (stats.open_tracking_disabled === true) notes.push("Open tracking was off for this broadcast.");
			if (stats.click_tracking_disabled === true) notes.push("Click tracking was off for this broadcast.");
			return {
				status: typeof stats.status === "string" ? stats.status : undefined,
				recipients: count(stats.recipients),
				opens: count(stats.emails_opened),
				uniqueClicks: count(stats.total_clicks),
				unsubscribes: count(stats.unsubscribes),
				notes: ["Kit reports total clicks, not unique clicks, and no delivered or complaint counts.", ...notes],
			};
		},
		async audience() {
			const growth = await call<{ stats?: Record<string, unknown> }>("kit", `${api}/account/growth_stats`, "reading growth stats", { headers });
			const stats = growth?.stats ?? {};
			const window = typeof stats.starting === "string" && typeof stats.ending === "string" ? ` (${stats.starting.slice(0, 10)} to ${stats.ending.slice(0, 10)})` : "";
			return [
				["Subscribers", count(stats.subscribers)],
				[`New subscribers${window}`, count(stats.new_subscribers)],
				[`Cancellations${window}`, count(stats.cancellations)],
				[`Net new${window}`, count(stats.net_new_subscribers)],
			] as const;
		},
		async createDraft(input) {
			const created = await call<{ broadcast?: KitBroadcast }>("kit", `${api}/broadcasts`, "creating the draft broadcast", {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({
					subject: input.subject,
					preview_text: input.previewText ?? "",
					description: input.subject,
					content: bodyHtml(input.body),
					public: false,
					send_at: null,
				}),
			});
			const broadcast = created?.broadcast;
			if (broadcast?.id === undefined) throw new Error("Kit accepted the broadcast but returned no id. Check Broadcasts, Drafts in Kit before trying again.");
			const editUrl = "https://app.kit.com/campaigns";
			if ((broadcast.send_at ?? null) !== null || broadcast.public === true || (broadcast.status !== undefined && broadcast.status !== "draft")) {
				throw new Error(
					`Kit created broadcast ${broadcast.id} as "${broadcast.status ?? "scheduled"}" (send_at ${broadcast.send_at ?? "none"}), not a draft. Open ${editUrl} now and unschedule it.`,
				);
			}
			return { id: String(broadcast.id), editUrl, where: `Kit, Send, Broadcasts, Drafts (broadcast ${broadcast.id})` };
		},
	};
}

interface ButtondownEmail {
	id: string;
	subject?: string;
	status?: string;
	publish_date?: string | null;
	creation_date?: string;
	absolute_url?: string;
}

function buttondown(cred: KeyCredential): NewsletterProvider {
	const api = "https://api.buttondown.com/v1";
	const headers = { Authorization: `Token ${cred.access}`, Accept: "application/json" };
	const total = async (path: string, what: string): Promise<number | undefined> =>
		count((await call<{ count?: number }>("buttondown", `${api}${path}`, what, { headers }))?.count);
	return {
		id: "buttondown",
		async identity() {
			const list = await call<{ results?: Array<{ name?: string; username?: string }> }>("buttondown", `${api}/newsletters`, "reading the newsletter", { headers });
			const first = list?.results?.[0];
			return first ? `${first.name ?? first.username ?? "newsletter"}${first.username ? ` (${first.username})` : ""}` : "newsletter";
		},
		async listIssues(filter, limit) {
			const status = filter === "draft" ? "?status=draft" : filter === "sent" ? "?status=sent" : "";
			const page = await call<{ results?: ButtondownEmail[] }>("buttondown", `${api}/emails${status}`, "listing emails", { headers });
			return (page?.results ?? []).slice(0, limit).map(email => ({
				id: email.id,
				subject: email.subject || "(no subject)",
				status: email.status ?? "?",
				date: email.publish_date ?? email.creation_date ?? undefined,
				url: email.absolute_url || undefined,
			}));
		},
		async issueStats(issueId) {
			const id = encodeURIComponent(issueId);
			const [analytics, replies] = await Promise.all([
				call<Record<string, unknown>>("buttondown", `${api}/emails/${id}/analytics`, "reading email analytics", { headers }),
				total(`/events?email_id=${id}&event_type=replied`, "counting replies"),
			]);
			const stats = analytics ?? {};
			const failures = [count(stats.temporary_failures), count(stats.permanent_failures)];
			return {
				recipients: count(stats.recipients),
				delivered: count(stats.deliveries),
				opens: count(stats.opens),
				uniqueClicks: count(stats.clicks),
				unsubscribes: count(stats.unsubscriptions),
				complaints: count(stats.complaints),
				failures: failures.every(value => value === undefined) ? undefined : failures.reduce<number>((sum, value) => sum + (value ?? 0), 0),
				replies,
				notes: ["Buttondown counts opens and clicks only when Tracking is on in its email settings."],
			};
		},
		async audience() {
			const [regular, premium, unactivated] = await Promise.all([
				total("/subscribers?type=regular", "counting subscribers"),
				total("/subscribers?type=premium", "counting premium subscribers"),
				total("/subscribers?type=unactivated", "counting unconfirmed subscribers"),
			]);
			return [
				["Regular subscribers", regular],
				["Premium subscribers", premium],
				["Unconfirmed (not opted in yet)", unactivated],
			] as const;
		},
		async createDraft(input) {
			const payload: Record<string, string> = { subject: input.subject, body: bodyHtml(input.body), status: "draft" };
			if (input.previewText) payload.description = input.previewText;
			const email = await call<ButtondownEmail>("buttondown", `${api}/emails`, "creating the draft email", {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			if (!email?.id) throw new Error("Buttondown accepted the email but returned no id. Check Emails in Buttondown before trying again.");
			const editUrl = `https://buttondown.com/emails/${email.id}`;
			if (email.status !== undefined && email.status !== "draft") {
				throw new Error(`Buttondown created email ${email.id} with status "${email.status}", not "draft". Open ${editUrl} now and set it back to draft.`);
			}
			return { id: email.id, editUrl, where: "Buttondown, Emails, Drafts" };
		},
	};
}

function base64url(input: Buffer | string): string {
	return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function ghostToken(adminKey: string, nowSeconds: number): string {
	const [kid = "", secret = ""] = adminKey.split(":");
	const header = base64url(JSON.stringify({ alg: "HS256", kid, typ: "JWT" }));
	const payload = base64url(JSON.stringify({ iat: nowSeconds, exp: nowSeconds + GHOST_TOKEN_SECONDS, aud: "/admin/" }));
	const signature = base64url(createHmac("sha256", Buffer.from(secret, "hex")).update(`${header}.${payload}`).digest());
	return `${header}.${payload}.${signature}`;
}

interface GhostPost {
	id: string;
	title?: string;
	status?: string;
	url?: string;
	published_at?: string | null;
	updated_at?: string;
	email?: Record<string, unknown> | null;
}

function ghost(cred: GhostCredential): NewsletterProvider {
	const site = cred.url.replace(/\/+$/, "");
	const api = `${site}/ghost/api/admin`;
	const headers = (): Record<string, string> => ({
		Authorization: `Ghost ${ghostToken(cred.access, Math.floor(Date.now() / 1000))}`,
		"Accept-Version": "v5.0",
		Accept: "application/json",
	});
	const members = async (filter: string): Promise<number | undefined> =>
		count(
			(await call<{ meta?: { pagination?: { total?: number } } }>("ghost", `${api}/members/?limit=1${filter}`, "counting members", { headers: headers() }))?.meta?.pagination
				?.total,
		);
	return {
		id: "ghost",
		async identity() {
			const list = await call<{ newsletters?: Array<{ name?: string; status?: string }> }>("ghost", `${api}/newsletters/?limit=all`, "reading newsletters", { headers: headers() });
			const names = (list?.newsletters ?? []).filter(item => item.status !== "archived").map(item => item.name ?? "?");
			return `${site}${names.length > 0 ? ` (newsletters: ${names.join(", ")})` : ""}`;
		},
		async listIssues(filter, limit) {
			const where = filter === "draft" ? "&filter=status:draft" : filter === "sent" ? `&filter=${encodeURIComponent("status:[published,sent]")}` : "";
			const page = await call<{ posts?: GhostPost[] }>("ghost", `${api}/posts/?limit=${limit}&order=updated_at%20desc&fields=id,title,status,url,published_at,updated_at${where}`, "listing posts", {
				headers: headers(),
			});
			return (page?.posts ?? []).map(post => ({
				id: post.id,
				subject: post.title || "(no title)",
				status: post.status ?? "?",
				date: post.published_at ?? post.updated_at ?? undefined,
				url: post.status === "published" ? post.url : undefined,
			}));
		},
		async issueStats(issueId) {
			const shown = await call<{ posts?: GhostPost[] }>("ghost", `${api}/posts/${encodeURIComponent(issueId)}/?include=email`, "reading the post's email", { headers: headers() });
			const post = shown?.posts?.[0];
			const email = post?.email ?? null;
			if (!email) {
				return { subject: post?.title, status: post?.status, notes: ["This post was never sent as an email, so it has no email numbers."] };
			}
			return {
				subject: typeof email.subject === "string" ? email.subject : post?.title,
				status: typeof email.status === "string" ? email.status : post?.status,
				recipients: count(email.email_count),
				delivered: count(email.delivered_count),
				opens: count(email.opened_count),
				failures: count(email.failed_count),
				notes: ["Ghost's email record has no click, unsubscribe or complaint counts; read those in Ghost's post analytics."],
			};
		},
		async audience() {
			const [all, free, paid] = await Promise.all([members(""), members("&filter=status:free"), members("&filter=status:-free")]);
			return [
				["Members", all],
				["Free members", free],
				["Paid or complimentary members", paid],
			] as const;
		},
		async createDraft(input) {
			const post: Record<string, string> = { title: input.subject, html: bodyHtml(input.body), status: "draft" };
			if (input.previewText) post.custom_excerpt = input.previewText;
			const created = await call<{ posts?: GhostPost[] }>("ghost", `${api}/posts/?source=html`, "creating the draft post", {
				method: "POST",
				headers: { ...headers(), "Content-Type": "application/json" },
				body: JSON.stringify({ posts: [post] }),
			});
			const made = created?.posts?.[0];
			if (!made?.id) throw new Error("Ghost accepted the post but returned no id. Check Posts, Drafts in Ghost before trying again.");
			const editUrl = `${site}/ghost/#/editor/post/${made.id}`;
			if (made.status !== undefined && made.status !== "draft") {
				throw new Error(`Ghost created post ${made.id} with status "${made.status}", not "draft". Open ${editUrl} now and unpublish it.`);
			}
			return { id: made.id, editUrl, where: "Ghost, Posts, Drafts" };
		},
	};
}

export async function providerFor(id: ProviderId): Promise<NewsletterProvider> {
	switch (id) {
		case "beehiiv":
			return beehiiv(await readCredential("beehiiv"));
		case "kit":
			return kit(await readCredential("kit"));
		case "buttondown":
			return buttondown(await readCredential("buttondown"));
		case "ghost":
			return ghost(await readCredential("ghost"));
	}
}
