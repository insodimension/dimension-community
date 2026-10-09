/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the full facts of an annotation
 *  (every element under every mark) stop reaching the agent, or the View gains a
 *  way to write anything it likes to the user's disk. The shared annotation kit
 *  keeps its message under the host's 16 384 characters by putting the rest in
 *  ONE JSON document and naming the place; this is that place. It must hand
 *  back a path the agent can read, hold only the kit's document (never an
 *  arbitrary file a View chose), never overwrite an earlier annotation's file,
 *  and not grow without bound.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DETAIL_SCHEMA } from "@dimension/mcp-app-kit/annotate";
import { AnnotationFiles, ANNOTATION_FILES_KEPT, MAX_DETAIL_BYTES } from "../src/annotation-file";
import { BrowserRuntimeError } from "../src/store";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function files(): { store: AnnotationFiles; dir: string } {
	const root = mkdtempSync(join(tmpdir(), "dimension-annotation-file-"));
	dirs.push(root);
	const dir = join(root, "annotations");
	return { store: new AnnotationFiles(dir), dir };
}

const document = (extra: Record<string, unknown> = {}): string =>
	JSON.stringify({ schema: DETAIL_SCHEMA, kind: "browser-page", file: "https://example.com/", marks: [], ...extra });

function refusalCode(work: () => unknown): string {
	try {
		work();
	} catch (error) {
		if (error instanceof BrowserRuntimeError) return error.code;
		throw error;
	}
	throw new Error("expected the document to be refused, but it was stored");
}

test("accepts the document the kit assembles: the server follows the kit's schema id, it does not keep its own", () => {
	const { store } = files();

	expect(() => store.save(JSON.stringify({ schema: DETAIL_SCHEMA, kind: "browser-page", file: "x", marks: [] }))).not.toThrow();
});

test("stores the document byte for byte and answers the absolute path to read it at", () => {
	const { store, dir } = files();
	const json = document({ marks: [{ n: 1, summary: "button#go" }] });

	const path = store.save(json);

	expect(isAbsolute(path)).toBe(true);
	expect(path.startsWith(dir)).toBe(true);
	expect(path.endsWith(".json")).toBe(true);
	expect(readFileSync(path, "utf8")).toBe(json);
});

test("two annotations never share a file, even of the same words", () => {
	const { store } = files();

	const first = store.save(document());
	const second = store.save(document());

	expect(second).not.toBe(first);
	expect(existsSync(first)).toBe(true);
	expect(existsSync(second)).toBe(true);
});

test("keeps the newest few and removes the older ones, so the folder does not grow for ever", () => {
	const { store, dir } = files();
	const saved = Array.from({ length: ANNOTATION_FILES_KEPT + 5 }, (_, n) => store.save(document({ n })));

	expect(readdirSync(dir)).toHaveLength(ANNOTATION_FILES_KEPT);
	expect(existsSync(saved[0] as string)).toBe(false);
	expect(existsSync(saved.at(-1) as string)).toBe(true);
});

test("does not delete files it did not write", () => {
	const { store, dir } = files();
	const first = store.save(document());
	const other = join(dir, "notes.txt");
	Bun.write(other, "mine");
	for (let n = 0; n < ANNOTATION_FILES_KEPT + 3; n += 1) store.save(document({ n }));

	expect(existsSync(first)).toBe(false);
	expect(existsSync(other)).toBe(true);
});

const refused: ReadonlyArray<{ name: string; json: string }> = [
	{ name: "text that is not JSON", json: "not json" },
	{ name: "a JSON list", json: "[]" },
	{ name: "a document of another schema", json: JSON.stringify({ schema: "something/else", marks: [] }) },
	{ name: "a document with no schema", json: JSON.stringify({ marks: [] }) },
	{ name: "a document over the size limit", json: document({ pad: "x".repeat(MAX_DETAIL_BYTES) }) },
];

for (const { name, json } of refused) {
	test(`refuses ${name}, and writes nothing`, () => {
		const { store, dir } = files();

		expect(refusalCode(() => store.save(json))).toBe("bad_detail");
		expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
	});
}
