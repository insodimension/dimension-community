import { expect, test } from "bun:test";
import { connect, run, stubFetch, useTempHome } from "./support";

useTempHome();

test("Buttondown stats: counts with shares of delivered, replies from events, opens marked unreliable", async () => {
	await connect("buttondown", { apiKey: "bd-key" });
	const sent = stubFetch(request => {
		if (request.url.includes("/analytics")) {
			return Response.json({ recipients: 1000, deliveries: 980, opens: 600, clicks: 49, temporary_failures: 5, permanent_failures: 15, unsubscriptions: 4, complaints: 1 });
		}
		return Response.json({ count: 7, results: [] });
	});
	const out = await run("newsletter_issue_stats", { issueId: "em_1" });
	expect(sent.map(request => request.url).sort()).toEqual([
		"https://api.buttondown.com/v1/emails/em_1/analytics",
		"https://api.buttondown.com/v1/events?email_id=em_1&event_type=replied",
	]);
	expect(out).toContain("Delivered: 980");
	expect(out).toContain("Bounced or failed: 20");
	expect(out).toContain("Complaints (marked as spam): 1 (0.1% of delivered)");
	expect(out).toContain("Clicks: 49 (5.0% of delivered)");
	expect(out).toContain("Replies: 7");
	expect(out).toContain("Opens: 600, unreliable: Apple Mail Privacy Protection");
	expect(out).toMatch(/Read \d{4}-\d\d-\d\dT.* from the Buttondown API\./);
});

test("Kit stats: what Kit does not report is unknown, never zero, and tracking-off is said", async () => {
	await connect("kit", { apiKey: "kit-key" });
	stubFetch(() =>
		Response.json({
			broadcast: {
				id: 31,
				stats: { recipients: 200, emails_opened: 90, total_clicks: 12, unsubscribes: 2, status: "completed", open_tracking_disabled: true, click_tracking_disabled: false },
			},
		}),
	);
	const out = await run("newsletter_issue_stats", { issueId: "31" });
	expect(out).toContain("Kit issue 31 (completed)");
	expect(out).toContain("Delivered: unknown (Kit does not report it)");
	expect(out).toContain("Complaints (marked as spam): unknown (Kit does not report it)");
	expect(out).toContain("Clicks: 12 (6.0% of recipients)");
	expect(out).toContain("Open tracking was off for this broadcast.");
});

test("beehiiv stats read the email block, verified clicks included", async () => {
	await connect("beehiiv", { apiKey: "bh-key", publicationId: "pub_1" });
	const sent = stubFetch(() =>
		Response.json({
			data: {
				id: "post_9",
				subject_line: "Week 12",
				status: "confirmed",
				stats: { email: { recipients: 500, delivered: 500, unique_opens: 300, unique_clicks: 40, unique_verified_clicks: 25, unsubscribes: 3, spam_reports: 0 } },
			},
		}),
	);
	const out = await run("newsletter_issue_stats", { issueId: "post_9" });
	expect(sent[0]?.url).toBe("https://api.beehiiv.com/v2/publications/pub_1/posts/post_9?expand[]=stats");
	expect(out).toContain('beehiiv issue post_9: "Week 12" (confirmed)');
	expect(out).toContain("Verified human clicks: 25 (5.0% of delivered)");
	expect(out).toContain("Complaints (marked as spam): 0 (0.0% of delivered)");
});

test("Ghost stats for a post never emailed say so instead of inventing zeros", async () => {
	await connect("ghost", { siteUrl: "https://example.ghost.io", adminKey: "aa:bb" });
	const sent = stubFetch(() => Response.json({ posts: [{ id: "p_7", title: "Week 12", status: "published", email: null }] }));
	const out = await run("newsletter_issue_stats", { issueId: "p_7" });
	expect(sent[0]?.url).toBe("https://example.ghost.io/ghost/api/admin/posts/p_7/?include=email");
	expect(out).toContain("This post was never sent as an email");
	expect(out).toContain("Recipients: unknown (Ghost does not report it)");
});

test("listing maps draft and sent to each provider's own status words, newest first", async () => {
	await connect("kit", { apiKey: "kit-key" });
	const sent = stubFetch(() =>
		Response.json({ broadcasts: [{ id: 31, subject: "Week 12", status: "completed", send_at: "2026-11-01T09:00:00Z", public_url: "https://fieldnotes.kit.com/posts/week-12" }] }),
	);
	const out = await run("newsletter_list_issues", { status: "sent", limit: 5 });
	expect(sent[0]?.url).toBe("https://api.kit.com/v4/broadcasts?per_page=5&slim=true&status=completed");
	expect(out).toContain("[31] completed  2026-11-01  Week 12  https://fieldnotes.kit.com/posts/week-12");

	await connect("buttondown", { apiKey: "bd" });
	const second = stubFetch(() => Response.json({ results: [] }));
	expect(await run("newsletter_list_issues", { provider: "buttondown", status: "draft" })).toBe("Buttondown: no draft issues.");
	expect(second[0]?.url).toBe("https://api.buttondown.com/v1/emails?status=draft");
});

test("audience: counts by kind, and unknown where the provider gives none", async () => {
	await connect("ghost", { siteUrl: "https://example.ghost.io", adminKey: "aa:bb" });
	stubFetch(request => {
		if (request.url.includes("status:free")) return Response.json({ meta: { pagination: { total: 90 } } });
		if (request.url.includes("status:-free")) return Response.json({ meta: {} });
		return Response.json({ meta: { pagination: { total: 100 } } });
	});
	const out = await run("newsletter_audience", {});
	expect(out).toContain("Members: 100");
	expect(out).toContain("Free members: 90");
	expect(out).toContain("Paid or complimentary members: unknown (Ghost does not report it)");
});

test("Kit audience reads the growth window it covers", async () => {
	await connect("kit", { apiKey: "kit-key" });
	stubFetch(() =>
		Response.json({ stats: { subscribers: 420, new_subscribers: 60, cancellations: 6, net_new_subscribers: 54, starting: "2026-08-08T00:00:00-04:00", ending: "2026-11-06T23:59:59-05:00" } }),
	);
	const out = await run("newsletter_audience", {});
	expect(out).toContain("Subscribers: 420");
	expect(out).toContain("Net new (2026-08-08 to 2026-11-06): 54");
});
