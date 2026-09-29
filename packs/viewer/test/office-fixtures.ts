// Documents the Office tests open, built in memory so a test reads as the file it
// is about. Each is the smallest package the parser accepts.
import JSZip from "jszip";
import { write, type WorkBook } from "xlsx/dist/xlsx.mini.min.js";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A ZIP of `files` (name -> text): a package with exactly the parts a test names, valid or not. */
export async function buildPackage(files: Record<string, string>): Promise<Uint8Array> {
	const zip = new JSZip();
	for (const [name, text] of Object.entries(files)) zip.file(name, text);
	return zip.generateAsync({ type: "uint8array" });
}

/** A .docx whose body is `body` (WordprocessingML) and whose external links are `links` (rel id -> URL). */
export async function buildDocx(body: string, links: Record<string, string> = {}): Promise<Uint8Array> {
	const zip = new JSZip();
	zip.file(
		"[Content_Types].xml",
		`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
	);
	zip.file("_rels/.rels", `${XML}<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="word/document.xml"/></Relationships>`);
	zip.file(
		"word/document.xml",
		`${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${OFFICE_REL}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
	);
	const relationships = Object.entries(links)
		.map(([id, target]) => `<Relationship Id="${id}" Type="${OFFICE_REL}/hyperlink" Target="${target}" TargetMode="External"/>`)
		.join("");
	zip.file("word/_rels/document.xml.rels", `${XML}<Relationships xmlns="${REL_NS}">${relationships}</Relationships>`);
	return zip.generateAsync({ type: "uint8array" });
}

export const paragraph = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
export const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
export const hyperlink = (id: string, text: string): string =>
	`<w:p><w:hyperlink r:id="${id}"><w:r><w:t>${text}</w:t></w:r></w:hyperlink></w:p>`;

/** An .xlsx from a SheetJS workbook, the way an agent's script would have saved it. */
export function buildXlsx(workbook: WorkBook): Uint8Array {
	return new Uint8Array(write(workbook, { type: "array", bookType: "xlsx" }));
}

/**
 * Overwrite what the ZIP central directory DECLARES as `name`'s uncompressed size
 * (the field a zip bomb inflates), leaving the data alone. The entry still opens;
 * the package now claims to be enormous.
 */
export function declareUncompressedSize(zipBytes: Uint8Array, name: string, size: number): Uint8Array {
	const patched = zipBytes.slice();
	const view = new DataView(patched.buffer);
	const wanted = new TextEncoder().encode(name);
	for (let at = 0; at + 46 <= patched.length; at++) {
		if (view.getUint32(at, true) !== 0x02014b50) continue;
		const nameLength = view.getUint16(at + 28, true);
		const entry = patched.subarray(at + 46, at + 46 + nameLength);
		if (entry.length === wanted.length && entry.every((byte, index) => byte === wanted[index])) {
			view.setUint32(at + 24, size, true);
			return patched;
		}
	}
	throw new Error(`no central-directory entry named ${name}`);
}

/** The signature and stream name of a password-protected Open XML file: a compound file holding `EncryptedPackage`. */
export function encryptedCompoundFile(): Uint8Array {
	const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
	const stream = new TextEncoder().encode("E\0n\0c\0r\0y\0p\0t\0e\0d\0P\0a\0c\0k\0a\0g\0e\0");
	const bytes = new Uint8Array(512 + stream.length);
	bytes.set(signature, 0);
	bytes.set(stream, 512);
	return bytes;
}
