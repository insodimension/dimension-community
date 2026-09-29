import { describe, expect, test } from "bun:test";
import { detectKind } from "../src/kind";

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0);

describe("detectKind", () => {
	test("content beats a wrong name for images and PDFs", () => {
		expect(detectKind("photo.txt", PNG)).toBe("image");
		expect(detectKind("report.png", text("%PDF-1.7\n"))).toBe("pdf");
		expect(detectKind("report.pdf", PNG)).toBe("image");
	});

	test("a PDF header after a little junk is still a PDF", () => {
		expect(detectKind("a.pdf", text(`${" ".repeat(600)}%PDF-1.4`))).toBe("pdf");
	});

	test("the name decides which Office format a ZIP is, and a ZIP is not one without the name", () => {
		expect(detectKind("a.docx", ZIP)).toBe("docx");
		expect(detectKind("a.pptx", ZIP)).toBe("pptx");
		expect(detectKind("a.xlsx", ZIP)).toBe("xlsx");
		expect(detectKind("a.xlsm", ZIP)).toBe("xlsx");
		expect(detectKind("a.zip", ZIP)).toBe("binary");
	});

	test("an Office name over text bytes is text, not a broken document", () => {
		expect(detectKind("notes.docx", text("this is really plain text"))).toBe("text");
	});

	test("text formats follow the name unless the bytes are binary", () => {
		expect(detectKind("README.md", text("# hi"))).toBe("markdown");
		expect(detectKind("page.HTML", text("<p>hi</p>"))).toBe("html");
		expect(detectKind("page.html", bytes(0x3c, 0, 0x70))).toBe("binary");
		expect(detectKind("main.rs", text("fn main() {}"))).toBe("text");
		expect(detectKind("Makefile", text("all:\n\techo"))).toBe("text");
	});

	test("SVG is an image and is checked as text", () => {
		expect(detectKind("logo.svg", text("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBe("image");
		expect(detectKind("logo.svg", bytes(0, 1, 2))).toBe("binary");
	});

	test("known binary signatures and NUL bytes are binary whatever the name", () => {
		expect(detectKind("tool.exe", bytes(0x4d, 0x5a, 0x90, 0))).toBe("binary");
		expect(detectKind("notes.txt", bytes(0x1f, 0x8b, 8, 0))).toBe("binary");
		expect(detectKind("data.dat", bytes(1, 2, 0, 3))).toBe("binary");
	});

	test("an empty file is empty text whatever it is called", () => {
		expect(detectKind("empty.png", new Uint8Array(0))).toBe("text");
		expect(detectKind("empty.pdf", new Uint8Array(0), 0)).toBe("text");
	});

	test("a name that collides with an object prototype key is just a name", () => {
		expect(detectKind("archive.constructor", text("plain"))).toBe("text");
		expect(detectKind("archive.toString", text("plain"))).toBe("text");
	});

	test("size, not the head length, decides emptiness", () => {
		expect(detectKind("a.md", text("# hi"), 1_000_000)).toBe("markdown");
	});
});
