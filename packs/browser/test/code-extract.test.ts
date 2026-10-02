/**
 * `tab.extract` makes the same markdown and text as OMP's own extractor on the same HTML. `code-extract-golden.json` is what OMP's extractor produced for each page in
 * `code-extract-fixtures.ts` (its in-tree Readability and DOM reimplementations, run once and recorded); the pack runs the upstream `@mozilla/readability`, `linkedom` and `turndown`
 * packages, so an equal answer on all five pages is the evidence the swap lost nothing.
 */
import { describe, expect, test } from "bun:test";
import { extractReadableFromHtml, type ReadableFormat, type ReadableResult } from "../src/code/extract/readable";
import golden from "./code-extract-golden.json";
import { EXTRACT_FIXTURES } from "./code-extract-fixtures";

const FORMATS: ReadableFormat[] = ["markdown", "text"];
const recorded: Record<string, Partial<Record<ReadableFormat, ReadableResult | null>>> = golden;

describe("tab.extract equals OMP's extractor", () => {
  for (const [name, fixture] of Object.entries(EXTRACT_FIXTURES)) {
    for (const format of FORMATS) {
      test(`${name} as ${format}`, async () => {
        const result = await extractReadableFromHtml(fixture.html, fixture.url, format);
        expect(result).toEqual(recorded[name]?.[format] ?? null);
      });
    }
  }

  test("the golden file covers every fixture in both formats, so a new fixture cannot go unchecked", () => {
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(EXTRACT_FIXTURES).sort());
    for (const name of Object.keys(EXTRACT_FIXTURES)) expect(Object.keys(recorded[name] ?? {}).sort()).toEqual([...FORMATS].sort());
  });
});
