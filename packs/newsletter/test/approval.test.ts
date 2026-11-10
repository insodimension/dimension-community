import { expect, test } from "bun:test";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { tool, useTempHome } from "./support";

useTempHome();

const policy = (name: string, args: unknown, mode: "yolo" | "write") =>
	resolveApproval(tool(name) as unknown as Parameters<typeof resolveApproval>[0], args, mode).policy;

test("saving a draft carries no approval policy, only the plain write tier: it saves an unsent draft", () => {
	const draft = tool("newsletter_issue_draft");
	expect(draft.approval).toBe("write");
	expect(draft.formatApprovalDetails).toBeUndefined();
	const args = { subject: "Week 12", body: "Hello" };
	expect(policy("newsletter_issue_draft", args, "yolo")).toBe("allow");
	expect(policy("newsletter_issue_draft", args, "write")).toBe("allow");
});

test("the reads run without a card in Full access", () => {
	for (const name of ["newsletter_provider", "newsletter_list_issues", "newsletter_issue_stats", "newsletter_audience"]) {
		expect(policy(name, {}, "yolo")).toBe("allow");
	}
});
