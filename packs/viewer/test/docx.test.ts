import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import docx from "../app/view/renderers/docx";
import { LINK_ATTRIBUTE } from "../app/view/renderers/office/shared";
import { installDom, stage, type TestDom } from "./dom";
import { buildDocx, hyperlink, pageBreak, paragraph } from "./office-fixtures";

let dom: TestDom;
beforeAll(() => {
	dom = installDom();
});
afterAll(() => dom.restore());

const ctx = { filename: "report.docx", theme: "dark" } as const;

/** The document's own tree: docx renders into a shadow root so its styles stay off the pane. */
function page(el: HTMLElement): ShadowRoot {
	const host = el.querySelector(".vo-scroll > div");
	if (!host?.shadowRoot) throw new Error("the document was not rendered into a shadow root");
	return host.shadowRoot;
}

/** Everything written on the pages. */
const pagesText = (el: HTMLElement): string =>
	Array.from(page(el).querySelectorAll("section.docx"))
		.map(section => section.textContent ?? "")
		.join("\n");

describe("docx renderer", () => {
	test("draws the document's text on a page, and a single page has no pager", async () => {
		const el = stage(dom.document);
		const mounted = await docx.mount(el, await buildDocx(paragraph("Quarterly plan") + paragraph("Revenue grew")), ctx);
		expect(pagesText(el)).toContain("Quarterly plan");
		expect(pagesText(el)).toContain("Revenue grew");
		expect(mounted.pageCount).toBeUndefined();
		expect(mounted.goto).toBeUndefined();
		expect(mounted.zoom).toBeFunction();
		mounted.destroy();
		expect(el.childNodes).toHaveLength(0);
	});

	test("explicit page breaks become pages the pager can count", async () => {
		const el = stage(dom.document);
		const bytes = await buildDocx(paragraph("one") + pageBreak + paragraph("two") + pageBreak + paragraph("three"));
		const mounted = await docx.mount(el, bytes, ctx);
		expect(mounted.pageCount).toBe(3);
		expect(mounted.goto).toBeFunction();
		mounted.destroy();
	});

	test("a hyperlink in the file cannot navigate the frame or run script", async () => {
		const el = stage(dom.document);
		const bytes = await buildDocx(
			hyperlink("rId7", "safe link") + hyperlink("rId8", "hostile link"),
			{ rId7: "https://example.test/report", rId8: "javascript:alert(1)" },
		);
		await docx.mount(el, bytes, ctx);
		const links = Array.from(page(el).querySelectorAll("a"));
		expect(links).toHaveLength(2);
		for (const link of links) expect(link.hasAttribute("href")).toBe(false);
		const byText = (text: string) => links.find(link => link.textContent === text);
		expect(byText("safe link")?.getAttribute(LINK_ATTRIBUTE)).toBe("https://example.test/report");
		expect(byText("hostile link")?.hasAttribute(LINK_ATTRIBUTE)).toBe(false);
	});
});
