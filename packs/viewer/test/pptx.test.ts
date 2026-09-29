// `fixtures/deck.pptx` is four text slides (title, bullets, a table, closing) made by
// pptxgenjs 4.0.1:
//   const p = new PptxGenJS(); p.layout = "LAYOUT_16x9";
//   p.addSlide().addText("Chat Roadmap", {...}); ... p.writeFile({ fileName: "deck.pptx" });
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import pptx from "../app/view/renderers/pptx";
import { installDom, stage, type TestDom } from "./dom";

let dom: TestDom;
let deck: Uint8Array;
beforeAll(async () => {
	dom = installDom();
	deck = new Uint8Array(await readFile(new URL("./fixtures/deck.pptx", import.meta.url)));
});
afterAll(() => dom.restore());

const ctx = { filename: "deck.pptx", theme: "dark" } as const;

describe("pptx renderer", () => {
	test("the pager counts the slides the file holds, not some other number", async () => {
		const slidesInFile = Object.keys((await JSZip.loadAsync(deck)).files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
		expect(slidesInFile).toBe(4);

		const el = stage(dom.document);
		const mounted = await pptx.mount(el, deck, ctx);
		expect(mounted.pageCount).toBe(slidesInFile);
		expect(mounted.goto).toBeFunction();
		expect(mounted.zoom).toBeFunction();
		mounted.destroy();
		expect(el.childNodes).toHaveLength(0);
	});

	test("a deck with no slides says so instead of drawing a blank page", async () => {
		const zip = await JSZip.loadAsync(deck);
		const presentation = await zip.file("ppt/presentation.xml")?.async("string");
		zip.file("ppt/presentation.xml", (presentation ?? "").replace(/<p:sldIdLst>.*<\/p:sldIdLst>/s, "<p:sldIdLst/>"));
		zip.remove("ppt/slides");
		const el = stage(dom.document);
		await pptx.mount(el, await zip.generateAsync({ type: "uint8array" }), ctx);
		expect(el.querySelector("[role=alert]")?.textContent).toMatch(/no slides/i);
	});
});
