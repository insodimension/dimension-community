/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the human marks the page, presses
 *  Request edits, and either nothing reaches their message, or what reaches it is
 *  not about the page they marked, or a refusal is silent, or a half-working
 *  lookup throws their marks away. This mounts the Browser's annotation seat on
 *  the REAL shared kit (the marks, the panel, the send pipeline) against a fake
 *  MCP App host that records every tool call and every context update, and
 *  drives it from the keyboard (a pin placed with Enter), the same way a person
 *  who cannot drag does. Only the canvas is replaced: linkedom cannot decode or
 *  paint a picture, and the burned-in painter is the kit's own test's to defend
 *  (a real browser proves it end to end).
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as realPaint from "../../../../packages/mcp-app-kit/src/annotate/paint";
import type { BrowserFrame } from "../src/contracts";
import { BrowserClient } from "../app/view/browser-client";
import { mount, unmountAll } from "./dom-harness";

const NATURAL = { width: 1280, height: 800 };
// The painter needs a canvas. The session's own rules (what is asked of the host, in what order) do not.
mock.module("../../../../packages/mcp-app-kit/src/annotate/paint.js", () => ({
	...realPaint,
	measureImage: async () => NATURAL,
	paintMarkup: async (_source: unknown, marks: readonly unknown[]) => ({
		frame: { mimeType: "image/png", data: "AAAA", bytes: 3, width: NATURAL.width, height: NATURAL.height },
		crops: [],
		natural: NATURAL,
		scale: 1,
		marksPainted: marks.length,
		notes: [],
	}),
}));
// Dynamic by necessity: the seat binds the kit's painter when it loads, so it must load AFTER the mock above exists (static imports hoist above it).
const { AnnotationSeat } = await import("../app/view/annotation-seat");
const { BrowserApp } = await import("../app/view/browser-app");

afterEach(unmountAll);

const FRAME: BrowserFrame = {
	frameId: "f1",
	mimeType: "image/png",
	data: "AAAA",
	capturedAt: "2026-10-02T10:00:00.000Z",
	state: {
		browserId: "b1",
		profile: null,
		engine: "chromium",
		app: "chrome",
		url: "https://example.com/pricing",
		title: "Pricing",
		revision: 1,
		viewport: NATURAL,
		task: null,
		tabs: [],
		activeTabId: "",
		loading: false,
		canGoBack: false,
		canGoForward: false,
		publish: null,
		dialogs: [],
	},
};

interface Call {
	readonly name: string;
	readonly args: Record<string, unknown>;
}
interface Update {
	readonly content: readonly { type: string; text?: string }[];
}

const asked = (args: Record<string, unknown>) =>
	Array.isArray(args.regions)
		? args.regions.map(region => ({
				region,
				truncated: false,
				elements: [{ tag: "button", id: "buy", label: "Buy now", box: { x: 412, y: 300, width: 96, height: 32 } }],
			}))
		: [];

/** A host that takes text and pictures, answers the two annotation tools, and records everything. */
function host(over: { capabilities?: object; annotate?: (call: Call) => CallToolResult; other?: (call: Call) => CallToolResult } = {}) {
	const calls: Call[] = [];
	const updates: Update[] = [];
	const app = {
		callServerTool: async (request: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult> => {
			const call = { name: request.name, args: request.arguments ?? {} };
			calls.push(call);
			if (call.name === "browser_annotation_file") return { content: [], structuredContent: { path: "/tmp/annotation-1.json" } };
			if (call.name !== "browser_annotate") return over.other?.(call) ?? { isError: true, content: [{ type: "text", text: "unexpected" }] };
			return (
				over.annotate?.(call) ?? {
					content: [],
					structuredContent: {
						url: FRAME.state.url,
						title: FRAME.state.title,
						capturedAt: FRAME.capturedAt,
						readAt: "2026-10-02T10:00:01.000Z",
						viewport: NATURAL,
						scroll: { x: 0, y: 1200, width: 1280, height: 4300 },
						regions: asked(call.args),
					},
				}
			);
		},
		getHostCapabilities: () => over.capabilities ?? { updateModelContext: { text: {}, image: {} } },
		updateModelContext: async (update: Update) => {
			updates.push(update);
			return {};
		},
	} as unknown as App;
	return { app, calls, updates };
}

const label = (dom: { find: (selector: string) => Element[] }, name: string): Element => {
	const found = dom.find(`[aria-label="${name}"]`)[0];
	if (!found) throw new Error(`no control labelled ${name}`);
	return found;
};

/** Mount the seat on `app`, pick the pin tool and place one pin with the keyboard. */
async function marked(app: App, client = new BrowserClient(app), onDone = () => {}) {
	await client.follow("b1");
	const dom = await mount(<AnnotationSeat app={app} client={client} browserId="b1" frame={FRAME} onDone={onDone} />);
	await dom.click(label(dom, "Pin"));
	await dom.key(label(dom, "Draw on the page. Arrow keys move the cursor; Enter or Space places a point."), "Enter");
	return { dom, client };
}

const sendButton = (dom: { find: (selector: string) => Element[] }): Element => {
	const found = dom.find("button.dam-send")[0];
	if (!found) throw new Error("no send button");
	return found;
};
const status = (dom: { find: (selector: string) => Element[] }): string => dom.find(".dam-status")[0]?.textContent ?? "";

describe("the annotation seat", () => {
	test("a mark on the page reaches the next message as the page's own facts: where it is, what is under the mark, and where to read the rest", async () => {
		const { app, calls, updates } = host();
		const { dom } = await marked(app);
		expect(dom.find(".dam-row")).toHaveLength(1);

		await dom.click(sendButton(dom));
		await dom.settle();

		expect(updates).toHaveLength(1);
		expect(updates[0]?.content.map(block => block.type)).toEqual(["image", "text"]);
		const text = updates[0]?.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain('Annotations from the human on "https://example.com/pricing"');
		expect(text).toContain("About the picture: Words from the page");
		expect(text).toContain("Live web page");
		expect(text).toContain("y=1200");
		expect(text).toContain('Facts: Under it: "button#buy" "Buy now"');
		expect(text).toContain("/tmp/annotation-1.json");

		// One lookup for the one mark, on the frame that was frozen, around the point that was placed.
		const lookups = calls.filter(call => call.name === "browser_annotate");
		expect(lookups).toHaveLength(1);
		expect(lookups[0]?.args).toMatchObject({ browserId: "b1", frameId: "f1" });
		expect(lookups[0]?.args.regions).toEqual([expect.objectContaining({ width: 24, height: 24 })]);
		// The full list was handed to the pack's own server, as the kit's document.
		const filed = calls.find(call => call.name === "browser_annotation_file");
		expect(String(filed?.args.json)).toContain("dimension.annotation-detail/");
		// The button says what comes next.
		expect(sendButton(dom).textContent).toContain("Added");
	});

	test("what was sent can be taken back when the View moves to another browser", async () => {
		const { app, updates } = host();
		const { dom, client } = await marked(app);
		await dom.click(sendButton(dom));
		await dom.settle();
		expect(updates).toHaveLength(1);

		await client.follow("b2");

		expect(updates).toHaveLength(2);
		expect(updates[1]?.content).toEqual([]);
	});

	test("a host with no door for context refuses in writing and nothing is looked up or staged", async () => {
		const { app, calls, updates } = host({ capabilities: {} });
		const { dom } = await marked(app);

		await dom.click(sendButton(dom));
		await dom.settle();

		expect(status(dom)).toContain("cannot attach annotations");
		expect(updates).toEqual([]);
		expect(calls).toEqual([]);
		// The marks are kept, so the human can try again elsewhere.
		expect(dom.find(".dam-row")).toHaveLength(1);
	});

	test("a page that moved on loses the elements but not the marks: the picture goes, and the human is told why", async () => {
		const { app, updates } = host({
			annotate: () => ({
				isError: true,
				content: [{ type: "text", text: "frame f1 was captured at revision 1; the page is now at revision 2. Capture a new frame." }],
			}),
		});
		const { dom } = await marked(app);

		await dom.click(sendButton(dom));
		await dom.settle();

		expect(updates).toHaveLength(1);
		const text = updates[0]?.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain('on "https://example.com/pricing"');
		expect(text).not.toContain("Facts:");
		expect(status(dom)).toContain("could not be read");
		expect(status(dom)).toContain("revision 2");
	});

	test("Done leaves the seat and does not touch what was staged: the request stays in the next message, it is the human's to send or leave", async () => {
		let done = 0;
		const { app, updates } = host();
		const { dom } = await marked(app, undefined, () => {
			done += 1;
		});
		await dom.click(sendButton(dom));
		await dom.settle();
		expect(updates).toHaveLength(1);

		await dom.click(label(dom, "Done"));

		expect(done).toBe(1);
		// Exactly the one request, and no take-back after it.
		expect(updates).toHaveLength(1);
		expect(updates[0]?.content.length).toBeGreaterThan(0);
	});
});

describe("the Browser around the seat", () => {
	test("removing the annotation from the agent while marking leaves the seat: it must not go on saying 'Added' for a request the host no longer holds", async () => {
		const { app, updates } = host({
			other: call => {
				if (call.name === "browser_frame") {
					const png = call.args.format === "png";
					return { content: [], structuredContent: { state: FRAME.state, frameId: "f1", mimeType: png ? "image/png" : "image/jpeg", data: "AAAA", capturedAt: FRAME.capturedAt } };
				}
				return { content: [], structuredContent: FRAME.state };
			},
		});
		const dom = await mount(<BrowserApp app={app} toolState={{ state: FRAME.state, seq: 1 }} />);
		await dom.settle();
		await dom.click(label(dom, "Annotate for the agent (Ctrl+Shift+A)"));
		await dom.settle();
		await dom.click(label(dom, "Pin"));
		await dom.key(label(dom, "Draw on the page. Arrow keys move the cursor; Enter or Space places a point."), "Enter");
		await dom.click(sendButton(dom));
		await dom.settle();
		expect(sendButton(dom).textContent).toContain("Added");
		expect(updates).toHaveLength(1);

		await dom.click(label(dom, "More"));
		const remove = dom.find('[role="menuitem"]').find(item => item.textContent?.includes("Remove annotation from agent"));
		await dom.click(remove as Element);
		await dom.settle();

		expect(updates).toHaveLength(2);
		expect(updates[1]?.content).toEqual([]);
		expect(dom.find("[data-slot='annotation-seat']")).toHaveLength(0);
		expect(dom.text()).not.toContain("Added");
	});
});
