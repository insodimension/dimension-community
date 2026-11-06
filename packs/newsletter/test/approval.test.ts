import { expect, test } from "bun:test";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { connect, tool, useTempHome } from "./support";

useTempHome();

const policy = (name: string, args: unknown, mode: "yolo" | "write") =>
	resolveApproval(tool(name) as unknown as Parameters<typeof resolveApproval>[0], args, mode).policy;

const card = (args: unknown) => (tool("newsletter_issue_draft").formatApprovalDetails?.(args) ?? []).join("\n");

const BODY = `Hi friends,\n\n${"Long paragraph of the approved issue. ".repeat(80)}\n\nReply and tell me one thing.`;

test("saving a draft asks the person in every mode, Full access included", () => {
	const args = { subject: "Week 12", body: "Hello" };
	expect(policy("newsletter_issue_draft", args, "yolo")).toBe("prompt");
	expect(policy("newsletter_issue_draft", args, "write")).toBe("prompt");
});

test("the reads run without a card in Full access", () => {
	for (const name of ["newsletter_provider", "newsletter_list_issues", "newsletter_issue_stats", "newsletter_audience"]) {
		expect(policy(name, {}, "yolo")).toBe("allow");
	}
});

test("the card names the provider and carries the subject, preview line and whole body untruncated", async () => {
	await connect("kit", { apiKey: "kit-key" });
	const shown = card({ subject: "Week 12: the launch", previewText: "Three things we learned", body: BODY });
	expect(shown).toContain("Saves an UNSENT draft in Kit. Nothing is sent or scheduled");
	expect(shown).toContain("Subject: Week 12: the launch");
	expect(shown).toContain("Preview text: Three things we learned");
	expect(shown).toContain(`Body:\n${BODY}`);
});

test("with several providers connected the card names the one the call picks", async () => {
	await connect("kit", { apiKey: "kit-key" });
	await connect("ghost", { siteUrl: "https://example.ghost.io", adminKey: "aa:bb" });
	expect(card({ provider: "ghost", subject: "s", body: "b" })).toContain("UNSENT draft in Ghost");
	expect(card({ subject: "s", body: "b" })).toContain("UNSENT draft in the connected newsletter provider");
});

test("malformed arguments still render a card instead of throwing", () => {
	expect(card(null)).toContain("Subject: (missing)");
	expect(card({ subject: 7, body: ["x"] })).toContain("Body:\n(missing)");
});
