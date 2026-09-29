import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import docx from "../app/view/renderers/docx";
import {
	EXCEL,
	inspectPackage,
	LINK_ATTRIBUTE,
	MAX_OFFICE_BYTES,
	neutralizeTree,
	POWERPOINT,
	type Problem,
	WORD,
	wireLinks,
} from "../app/view/renderers/office/shared";
import pptx from "../app/view/renderers/pptx";
import type { MountContext, Renderer } from "../app/view/renderers/types";
import xlsx from "../app/view/renderers/xlsx";
import { installDom, stage, type TestDom } from "./dom";
import { buildDocx, buildPackage, declareUncompressedSize, encryptedCompoundFile, paragraph } from "./office-fixtures";

let dom: TestDom;
beforeAll(() => {
	dom = installDom();
});
afterAll(() => dom.restore());

const ctx = (extra: Partial<MountContext> = {}): MountContext => ({ filename: "file", theme: "dark", ...extra });

describe("inspectPackage: what a person is told about the wrong bytes", () => {
	test("a real package is handed to the parser", async () => {
		expect(inspectPackage(await buildDocx(paragraph("hello")), WORD)).toBeNull();
	});

	test("each way a file can be unopenable gets its own explanation", async () => {
		const docxBytes = await buildDocx(paragraph("hello"));
		const truncated = docxBytes.subarray(0, Math.floor(docxBytes.length / 2));
		const legacy = new Uint8Array(1024);
		legacy.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

		const cases: [string, Problem | null, RegExp][] = [
			["empty", inspectPackage(new Uint8Array(0), WORD), /empty/i],
			["plain text renamed .docx", inspectPackage(new TextEncoder().encode("just some text, not a package at all"), WORD), /damaged/i],
			["a package cut in half", inspectPackage(truncated, WORD), /damaged/i],
			["password-protected", inspectPackage(encryptedCompoundFile(), WORD), /password/i],
			["pre-2007 binary Office", inspectPackage(legacy, WORD), /older/i],
			["a Word file handed to Excel", inspectPackage(docxBytes, EXCEL), /not an Excel/i],
			["a Word file handed to PowerPoint", inspectPackage(docxBytes, POWERPOINT), /not a PowerPoint/i],
			["a package that declares it inflates to 300 MB", inspectPackage(declareUncompressedSize(docxBytes, "word/document.xml", 300 * 1024 * 1024), WORD), /too large/i],
			["a file over the size cap", inspectPackage(new Uint8Array(MAX_OFFICE_BYTES + 1), WORD), /too large/i],
		];
		for (const [label, problem, title] of cases) {
			expect(problem, label).not.toBeNull();
			expect(problem?.title, label).toMatch(title);
		}
	});
});

describe("neutralizeTree: markup a document library produced", () => {
	const build = (html: string): HTMLElement => {
		const root = dom.document.createElement("div");
		root.innerHTML = html;
		return root;
	};

	test("links can never navigate the frame; only http(s) targets survive, parked for the host", () => {
		const root = build(
			`<a id="js" href="javascript:alert(1)">a</a>` +
				`<a id="ok" href="https://example.test/page?x=1">b</a>` +
				`<a id="frag" href="#bookmark">c</a>` +
				`<a id="data" href="data:text/html,<script>alert(1)</script>">d</a>`,
		);
		const tabbed = dom.document.createElement("a");
		tabbed.setAttribute("href", "java\tscript:alert(1)");
		root.append(tabbed);
		neutralizeTree(root);
		for (const link of Array.from(root.querySelectorAll("a"))) expect(link.hasAttribute("href")).toBe(false);
		expect(root.querySelector("#ok")?.getAttribute(LINK_ATTRIBUTE)).toBe("https://example.test/page?x=1");
		for (const id of ["js", "frag", "data"]) expect(root.querySelector(`#${id}`)?.hasAttribute(LINK_ATTRIBUTE)).toBe(false);
		expect(tabbed.hasAttribute(LINK_ATTRIBUTE)).toBe(false);
	});

	test("nothing that runs or fetches is left", () => {
		const root = build(
			`<script>alert(1)</script><iframe src="https://evil.test"></iframe><object data="x"></object>` +
				`<div id="d" onclick="alert(1)"><img id="local" src="data:image/png;base64,AAAA" onerror="alert(1)">` +
				`<img id="remote" src="https://evil.test/beacon.png"><img id="html" src="data:text/html;base64,PHNjcmlwdD4="></div>`,
		);
		neutralizeTree(root);
		for (const tag of ["script", "iframe", "object"]) expect(root.querySelector(tag)).toBeNull();
		expect(root.querySelector("#d")?.hasAttribute("onclick")).toBe(false);
		expect(root.querySelector("#local")?.hasAttribute("onerror")).toBe(false);
		expect(root.querySelector("#local")?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
		expect(root.querySelector("#remote")?.hasAttribute("src")).toBe(false);
		expect(root.querySelector("#html")?.hasAttribute("src")).toBe(false);
	});
});

describe("wireLinks", () => {
	function click(target: Element): Event {
		const event = new window.Event("click", { bubbles: true, cancelable: true });
		target.dispatchEvent(event);
		return event;
	}

	test("a click reaches the host only for a neutralised http(s) link, and never navigates", () => {
		const root = dom.document.createElement("div");
		root.innerHTML = `<a id="ok" href="https://example.test/a"><span id="inner">go</span></a><a id="bad" href="javascript:alert(1)">no</a>`;
		neutralizeTree(root);
		const opened: string[] = [];
		const unwire = wireLinks(root, ctx({ openLink: url => opened.push(url) }));

		const good = click(root.querySelector("#inner") as Element);
		const bad = click(root.querySelector("#bad") as Element);
		expect(opened).toEqual(["https://example.test/a"]);
		expect(good.defaultPrevented).toBe(true);
		expect(bad.defaultPrevented).toBe(true);

		unwire();
		click(root.querySelector("#ok") as Element);
		expect(opened).toHaveLength(1);
	});

	test("without a host opener links are inert but still swallowed", () => {
		const root = dom.document.createElement("div");
		root.innerHTML = `<a id="ok" href="https://example.test/a">go</a>`;
		neutralizeTree(root);
		wireLinks(root, ctx());
		expect(click(root.querySelector("#ok") as Element).defaultPrevented).toBe(true);
	});
});

describe("a file the parser cannot open never throws out of mount", () => {
	const renderers: [string, Renderer][] = [
		["docx", docx],
		["pptx", pptx],
		["xlsx", xlsx],
	];

	test.each(renderers)("%s: bytes that are not a package show the pane's message", async (_kind, renderer) => {
		const el = stage(dom.document);
		const mounted = await renderer.mount(el, new TextEncoder().encode("this is not an office file"), ctx());
		expect(el.querySelector("[role=alert]")?.textContent).toMatch(/damaged/i);
		mounted.destroy();
		expect(el.childNodes).toHaveLength(0);
	});

	test("a package the preflight accepts but the library rejects shows the message too", async () => {
		const bytes = await buildPackage({ "word/document.xml": "<<< this is not xml", "[Content_Types].xml": "" });
		const el = stage(dom.document);
		const mounted = await docx.mount(el, bytes, ctx({ filename: "broken.docx" }));
		const alert = el.querySelector("[role=alert]");
		expect(alert?.textContent).toMatch(/could not be previewed/i);
		expect(alert?.textContent).toContain("broken.docx");
		mounted.destroy();
	});
});
