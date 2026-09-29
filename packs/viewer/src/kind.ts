// What a file IS, decided from its name and its first bytes. Pure: the server
// hands it the head of the file, so the same rules are testable without a disk.
//
// The order matters and is the whole design: CONTENT beats a wrong name for the
// formats with an unmistakable signature (a `.png` that is really a PDF opens as
// a PDF), the name decides what the bytes cannot say (`.md` vs `.txt`, and which
// Office format a ZIP is), and anything left is text unless it has a NUL byte.
// The logic mirrors fraym's `file-view/file-kind.ts` (extension tables) with the
// magic-byte layer added; it is a reference, not an import, because a server
// must not depend on the UI package.
import type { ViewerKind } from "./contract";

/** How many leading bytes {@link detectKind} wants; the server reads this many. */
export const KIND_HEAD_BYTES = 8192;

const EXTENSION_KINDS: Readonly<Record<string, ViewerKind>> = {
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	bmp: "image",
	ico: "image",
	avif: "image",
	svg: "image",
	pdf: "pdf",
	html: "html",
	htm: "html",
	xhtml: "html",
	md: "markdown",
	markdown: "markdown",
	mdx: "markdown",
	docx: "docx",
	pptx: "pptx",
	xlsx: "xlsx",
	xlsm: "xlsx",
};

/** Formats whose Office kind needs the ZIP container the name promises. */
const OFFICE_KINDS: Readonly<Record<string, true>> = { docx: true, pptx: true, xlsx: true };

export function fileExtension(filename: string): string {
	const base = filename.split(/[\\/]/).pop() ?? filename;
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

const startsWith = (head: Uint8Array, signature: readonly number[], at = 0): boolean =>
	head.length >= at + signature.length && signature.every((byte, index) => head[at + index] === byte);

const ascii = (text: string): number[] => Array.from(text, char => char.charCodeAt(0));

type Sniffed = "image" | "pdf" | "zip" | "binary" | undefined;

function sniff(head: Uint8Array): Sniffed {
	if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image"; // PNG
	if (startsWith(head, [0xff, 0xd8, 0xff])) return "image"; // JPEG
	if (startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a"))) return "image";
	if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8)) return "image";
	if (startsWith(head, ascii("ftypavif"), 4) || startsWith(head, ascii("ftypavis"), 4)) return "image"; // AVIF
	// A PDF may carry up to 1 KiB of junk before its header (the spec's own allowance).
	const pdf = ascii("%PDF-");
	for (let at = 0; at <= Math.min(1024, head.length - pdf.length); at++) if (startsWith(head, pdf, at)) return "pdf";
	if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return "zip";
	if (startsWith(head, [0x1f, 0x8b])) return "binary"; // gzip
	if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return "binary"; // ELF
	if (startsWith(head, [0x4d, 0x5a])) return "binary"; // MZ (exe, dll)
	if (startsWith(head, ascii("SQLite format 3\0"))) return "binary";
	if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || startsWith(head, ascii("Rar!"))) return "binary";
	if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "binary"; // legacy OLE (doc, xls)
	return undefined;
}

/** Which renderer a file gets. `head` is the file's first {@link KIND_HEAD_BYTES}
 *  bytes (or all of it); `size` is its full length. */
export function detectKind(filename: string, head: Uint8Array, size: number = head.length): ViewerKind {
	// Nothing to render: an empty file is an empty text, whatever it is called.
	if (size === 0) return "text";
	// A NUL byte in the head is the classic "this is not text" test (`head.includes(0)` below).
	const extension = fileExtension(filename);
	// `hasOwn`: a file called `x.constructor` must not resolve through the prototype chain.
	const named = Object.hasOwn(EXTENSION_KINDS, extension) ? EXTENSION_KINDS[extension] : undefined;
	const sniffed = sniff(head);
	if (sniffed === "image" || sniffed === "pdf") return sniffed;
	if (named !== undefined && OFFICE_KINDS[named]) {
		if (sniffed === "zip") return named;
	} else if (named === "image") {
		// SVG is text; the raster formats without a strong signature need the name AND a plausible head.
		if (extension === "svg") return head.includes(0) ? "binary" : "image";
		if (extension === "bmp" && startsWith(head, ascii("BM"))) return "image";
		if (extension === "ico" && (startsWith(head, [0, 0, 1, 0]) || startsWith(head, [0, 0, 2, 0]))) return "image";
	} else if (named === "html" || named === "markdown") {
		return head.includes(0) ? "binary" : named;
	}
	return sniffed === "binary" || sniffed === "zip" || head.includes(0) ? "binary" : "text";
}
