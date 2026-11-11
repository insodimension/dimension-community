import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPageFrame, setPageScripts } from "@dimension/mcp-app-kit/annotate";
import html from "../app/view/renderers/html";
import { installDom, stage, type TestDom } from "./dom";

let dom: TestDom;
beforeAll(() => {
	dom = installDom();
});
afterAll(() => dom.restore());

const ctx = { filename: "landing.html", theme: "dark" as const };
const hostile = [
	"<!doctype html><title>x</title>",
	"<script>parent.postMessage('owned','*')</script>",
	'<img src="https://tracker.example/p.gif" onerror="parent.steal()">',
	'<form action="https://evil.example"><input name="parentElement"></form>',
	'<a href="javascript:alert(1)">click</a>',
	'<meta http-equiv="refresh" content="0;url=https://evil.example">',
].join("");

async function mount(source = hostile) {
	const el = stage(dom.document);
	const handle = await html.mount(el, new TextEncoder().encode(source), ctx);
	const frame = el.querySelector("iframe") as HTMLIFrameElement;
	return { el, handle, frame };
}

describe("the reading frame", () => {
	test("runs the page's scripts and grants nothing else: the one sandbox token is allow-scripts", async () => {
		const { frame } = await mount();
		expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
	});

	test("holds the page behind the run document, by `srcdoc` so it inherits the View's CSP, and not by `src`", async () => {
		const { frame } = await mount();
		expect(frame.srcdoc).toBe(createPageFrame(hostile).srcdoc);
		expect(frame.srcdoc).not.toBe(hostile);
		expect(frame.hasAttribute("src")).toBe(false);
	});

	test("keeps a page's markup inside the frame: nothing from it is put in the View's own tree", async () => {
		const { el } = await mount();
		expect(el.children).toHaveLength(1);
		expect(el.querySelectorAll("script, img, form, input, a, meta")).toHaveLength(0);
	});

	test("is named for the picker to find: `viewer-html-frame`, an iframe", async () => {
		const { frame } = await mount();
		expect(frame.tagName.toLowerCase()).toBe("iframe");
		expect(frame.dataset.slot).toBe("viewer-html-frame");
	});

	test("sends no referrer and is titled by its file", async () => {
		const { frame } = await mount();
		expect(frame.referrerPolicy).toBe("no-referrer");
		expect(frame.title).toBe("landing.html");
	});

	test("decodes the file as UTF-8", async () => {
		const text = "<p>naïve — 日本語</p>";
		const { frame } = await mount(text);
		setPageScripts(frame, false);
		expect(frame.srcdoc).toBe(text);
	});
});

describe("Stop scripts and Run scripts", () => {
	test("Stop drops the same frame to no sandbox token at all and hands the browser the page's original bytes", async () => {
		const { frame, el } = await mount();
		setPageScripts(frame, false);
		expect(frame.getAttribute("sandbox")).toBe("");
		expect(frame.srcdoc).toBe(hostile);
		expect(el.children).toHaveLength(1);
		expect(el.querySelector("iframe")).toBe(frame);
	});

	test("Run puts the sandbox and the run document back, and any number of cycles neither wrap the page twice nor lose a byte", async () => {
		const { frame } = await mount();
		const running = createPageFrame(hostile).srcdoc;
		for (let cycle = 0; cycle < 3; cycle += 1) {
			setPageScripts(frame, false);
			expect([frame.getAttribute("sandbox"), frame.srcdoc], `stopped, cycle ${cycle}`).toEqual(["", hostile]);
			setPageScripts(frame, true);
			expect([frame.getAttribute("sandbox"), frame.srcdoc], `running, cycle ${cycle}`).toEqual(["allow-scripts", running]);
		}
	});

	const leads = [
		{ name: "a no-break space before the doctype", page: "\u00a0<!doctype html><p>x</p>" },
		{ name: "an abrupt comment ahead of a script", page: "<!--><script>parent.x()</script><!-- --><!doctype html><p>x</p>" },
		{ name: "a banner, an xml instruction and a doctype", page: '  \n<!-- banner --><?xml version="1.0"?><!doctype html><p>x</p>' },
		{ name: "no doctype at all", page: "<p>no doctype</p>" },
		{ name: "an empty file", page: "" },
	];
	for (const { name, page } of leads) {
		test(`a page with ${name}: Stop gives its bytes back exactly, and Run holds the same run document the page was first given`, async () => {
			const { frame } = await mount(page);
			const running = createPageFrame(page).srcdoc;
			expect(frame.srcdoc).toBe(running);
			setPageScripts(frame, false);
			expect(frame.srcdoc).toBe(page);
			setPageScripts(frame, true);
			expect(frame.srcdoc).toBe(running);
		});
	}
});

describe("zoom and destroy", () => {
	test("zooming scales the page and grows the frame by the inverse, so it still fills the pane", async () => {
		const { handle, frame } = await mount();
		handle.zoom?.(2);
		expect([frame.style.transform, frame.style.width, frame.style.height]).toEqual(["scale(2)", "50%", "50%"]);
		handle.zoom?.(0.5);
		expect([frame.style.transform, frame.style.width, frame.style.height]).toEqual(["scale(0.5)", "200%", "200%"]);
		handle.zoom?.(1);
		expect([frame.style.transform, frame.style.width, frame.style.height]).toEqual(["", "", ""]);
	});

	test("destroy takes the frame away", async () => {
		const { el, handle } = await mount();
		handle.destroy();
		expect(el.children).toHaveLength(0);
	});
});
