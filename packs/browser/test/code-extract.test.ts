/**
 * WHAT BREAKS IF THIS GOES RED: `tab.extract` stops giving what OMP's extractor gives on the same page. The pack runs OMP's OWN Readability, DOM and HTML-to-markdown reimplementations, copied into
 * `src/code/extract` (no npm package: the upstream `@mozilla/readability`, `linkedom` and `turndown` do not produce OMP's output, see THIRD-PARTY-NOTICES.md). `code-extract-golden.json` is what OMP's
 * extractor produced for each page in `code-extract-fixtures.ts`, run once and recorded; so this is a pin that the COPY has not drifted from OMP's output on those five pages. It says nothing about
 * any upstream package.
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
