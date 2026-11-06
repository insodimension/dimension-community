import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { connectPath } from "../credentials";
import { bodyHtml } from "../providers";
import { connect, run, stubFetch, useTempHome } from "./support";

useTempHome();

const ISSUE = {
	subject: "Week 12: the launch",
	previewText: "Three things we learned",
	body: "Hi friends,\n\nWe shipped <beta> & it works: https://example.com/launch.\nMore soon.",
};

const HTML = '<p>Hi friends,</p>\n<p>We shipped &lt;beta&gt; &amp; it works: <a href="https://example.com/launch">https://example.com/launch</a>.<br>More soon.</p>';

async function refusal(work: Promise<unknown>): Promise<string> {
	try {
		await work;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the call to fail");
}

test("the body becomes escaped paragraphs with line breaks and live links, trailing punctuation outside the link", () => {
	expect(bodyHtml(ISSUE.body)).toBe(HTML);
	expect(bodyHtml("\r\n\r\nOne\r\n\r\n\r\nTwo (see https://a.example/x)\n")).toBe('<p>One</p>\n<p>Two (see <a href="https://a.example/x">https://a.example/x</a>)</p>');
});

test("beehiiv: finds the one publication, creates a draft post with the subject and preview, and never schedules it", async () => {
	await connect("beehiiv", { apiKey: "bh-key", publicationId: "" });
	const sent = stubFetch(request => {
		if (request.method === "GET") return Response.json({ data: [{ id: "pub_1", name: "Field Notes" }] });
		return Response.json({ data: { id: "post_9", status: "draft", preview_url: "https://app.beehiiv.com/posts/post_9/preview" } }, { status: 201 });
	});
	const out = await run("newsletter_issue_draft", ISSUE);
	const create = sent.find(request => request.method === "POST");
	expect(create?.url).toBe("https://api.beehiiv.com/v2/publications/pub_1/posts");
	expect(create?.body).toEqual({
		title: ISSUE.subject,
		body_content: HTML,
		status: "draft",
		email_settings: { email_subject_line: ISSUE.subject, email_preview_text: ISSUE.previewText },
	});
	expect(out).toContain("post_9");
	expect(out).toContain("https://app.beehiiv.com/posts/post_9/preview");
});

test("beehiiv: the publication found once is reused, not listed again on the next call", async () => {
	await connect("beehiiv", { apiKey: "bh-once", publicationId: "" });
	const sent = stubFetch(request => {
		if (request.url.includes("/publications?")) return Response.json({ data: [{ id: "pub_1", name: "Field Notes" }] });
		return Response.json({ data: [] });
	});
	await run("newsletter_list_issues", {});
	await run("newsletter_list_issues", {});
	expect(sent.filter(request => request.url.includes("/publications?"))).toHaveLength(1);
});

test("beehiiv: a key that sees several publications and no saved id is refused before anything is created", async () => {
	await connect("beehiiv", { apiKey: "bh-several", publicationId: "" });
	const sent = stubFetch(() => Response.json({ data: [{ id: "pub_1", name: "A" }, { id: "pub_2", name: "B" }] }));
	const message = await refusal(run("newsletter_issue_draft", ISSUE));
	expect(message).toContain("pub_1");
	expect(message).toContain("pub_2");
	expect(sent.some(request => request.method === "POST")).toBe(false);
});

test("beehiiv: a plan without the create-post API is named as the cause", async () => {
	await connect("beehiiv", { apiKey: "bh-key", publicationId: "pub_1" });
	stubFetch(() => Response.json({ status: 403, statusText: "forbidden", errors: [{ message: "Upgrade to Pro", code: "FORBIDDEN" }] }, { status: 403 }));
	expect(await refusal(run("newsletter_issue_draft", ISSUE))).toContain("Upgrade to Pro");
});

test("Kit: a broadcast with no send time, not public, through the V4 key header", async () => {
	await connect("kit", { apiKey: "kit-key" });
	const sent = stubFetch(() => Response.json({ broadcast: { id: 31, send_at: null, public: false } }, { status: 201 }));
	const out = await run("newsletter_issue_draft", ISSUE);
	expect(sent[0]?.headers["x-kit-api-key"]).toBe("kit-key");
	expect(sent[0]?.body).toEqual({ subject: ISSUE.subject, preview_text: ISSUE.previewText, description: ISSUE.subject, content: HTML, public: false, send_at: null });
	expect(out).toContain("31");
});

test("Kit: an answer that is scheduled is an error that says where to unschedule it", async () => {
	await connect("kit", { apiKey: "kit-key" });
	stubFetch(() => Response.json({ broadcast: { id: 31, send_at: "2026-11-07T09:00:00Z", public: false } }, { status: 201 }));
	expect(await refusal(run("newsletter_issue_draft", ISSUE))).toContain("https://app.kit.com/campaigns");
});

test("Buttondown: the body goes in as the same escaped HTML, the preview as the description, status draft", async () => {
	await connect("buttondown", { apiKey: "bd-key" });
	const sent = stubFetch(() => Response.json({ id: "em_1", status: "draft" }, { status: 201 }));
	const out = await run("newsletter_issue_draft", ISSUE);
	expect(sent[0]?.url).toBe("https://api.buttondown.com/v1/emails");
	expect(sent[0]?.headers.authorization).toBe("Token bd-key");
	expect(sent[0]?.body).toEqual({ subject: ISSUE.subject, body: HTML, status: "draft", description: ISSUE.previewText });
	expect(out).toContain("https://buttondown.com/emails/em_1");
});

test("Buttondown: an email it reports as about to send is an error", async () => {
	await connect("buttondown", { apiKey: "bd-key" });
	stubFetch(() => Response.json({ id: "em_1", status: "about_to_send" }, { status: 201 }));
	expect(await refusal(run("newsletter_issue_draft", ISSUE))).toContain("about_to_send");
});

test("Ghost: a draft post with no newsletter attached, signed with a five-minute admin token", async () => {
	const secret = "a1b2c3d4e5f60718";
	await connect("ghost", { siteUrl: "https://example.ghost.io/", adminKey: `abc123:${secret}` });
	const sent = stubFetch(() => Response.json({ posts: [{ id: "p_7", status: "draft" }] }, { status: 201 }));
	const out = await run("newsletter_issue_draft", ISSUE);
	const request = sent[0];
	expect(request?.url).toBe("https://example.ghost.io/ghost/api/admin/posts/?source=html");
	expect(request?.url).not.toContain("newsletter");
	expect(request?.body).toEqual({ posts: [{ title: ISSUE.subject, html: HTML, status: "draft", custom_excerpt: ISSUE.previewText }] });
	const token = (request?.headers.authorization ?? "").replace(/^Ghost /, "");
	const [header = "", payload = "", signature = ""] = token.split(".");
	expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "HS256", kid: "abc123", typ: "JWT" });
	const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
	expect(claims.aud).toBe("/admin/");
	expect(claims.exp - claims.iat).toBe(300);
	expect(signature).toBe(createHmac("sha256", Buffer.from(secret, "hex")).update(`${header}.${payload}`).digest("base64url"));
	expect(out).toContain("https://example.ghost.io/ghost/#/editor/post/p_7");
});

test("a rejected key names the Connect path to fix it", async () => {
	await connect("buttondown", { apiKey: "stale" });
	stubFetch(() => Response.json({ code: "authentication_failed", detail: "Invalid token." }, { status: 401 }));
	const message = await refusal(run("newsletter_issue_draft", ISSUE));
	expect(message).toContain("Invalid token.");
	expect(message).toContain(connectPath("buttondown"));
});

test("which provider: none, several, an unconnected one and Substack are each refused before any request", async () => {
	const sent = stubFetch(() => {
		throw new Error("no request expected");
	});
	await refusal(run("newsletter_issue_draft", ISSUE));
	await connect("kit", { apiKey: "k" });
	await connect("ghost", { siteUrl: "https://example.ghost.io", adminKey: "aa:bb" });
	const several = await refusal(run("newsletter_issue_draft", ISSUE));
	expect(several).toContain("kit");
	expect(several).toContain("ghost");
	expect(await refusal(run("newsletter_issue_draft", { ...ISSUE, provider: "beehiiv" }))).toContain(connectPath("beehiiv"));
	await refusal(run("newsletter_issue_draft", { ...ISSUE, provider: "substack" }));
	await refusal(run("newsletter_issue_draft", { ...ISSUE, provider: "kit", subject: "  " }));
	expect(sent).toEqual([]);
});

test("a saved key file that is not a key is reported as unreadable, not sent", async () => {
	await connect("ghost", { siteUrl: "not a url", adminKey: "nothex" });
	const sent = stubFetch(() => {
		throw new Error("no request expected");
	});
	expect(await refusal(run("newsletter_issue_draft", ISSUE))).toContain(connectPath("ghost"));
	expect(sent).toEqual([]);
});

test("a Ghost site saved with an http address is refused, so the admin token never travels unencrypted", async () => {
	await connect("ghost", { siteUrl: "http://example.ghost.io", adminKey: "aa:bb" });
	const sent = stubFetch(() => {
		throw new Error("no request expected");
	});
	expect(await refusal(run("newsletter_issue_draft", ISSUE))).toContain(connectPath("ghost"));
	expect(sent).toEqual([]);
});
