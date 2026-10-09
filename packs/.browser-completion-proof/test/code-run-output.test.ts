/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a `tab.run` that prints without end (or displays, or screenshots, in a loop) grows the worker's heap for as long as it runs, because the tab realm collected everything
 * it was told and only the copy that crosses into the cell was bounded. One such run takes the worker, and with it every other tab's variables of the session, down at the memory limit. And the other way: a run
 * that prints a little must keep every byte as printed, whitespace and order included, because a cell written for OMP parses what `tab.run` printed.
 */
import { describe, expect, test } from "bun:test";
import type { RunResult } from "../src/code/contracts";
import { RunOutput } from "../src/code/worker/run-output";

const textOf = (displays: RunResult["displays"]): string => displays.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
const images = (displays: RunResult["displays"]) => displays.filter(part => part.type === "image");
const SMALL = { textBytes: 1_024, imageChars: 4_096 };

describe("what a run prints that fits is kept as it was printed", () => {
  test("stream text, a caption and an image come back in the order they arrived, leading whitespace and blank lines intact", () => {
    const output = new RunOutput(SMALL);
    output.pushText("  indented\n\n");
    output.pushText("second\n");
    output.push({ type: "text", text: "Screenshot captured" });
    output.push({ type: "image", data: "aGk=", mimeType: "image/png" });
    output.pushDisplay({ type: "json", data: { a: 1 } });
    output.pushText("tail");
    expect(output.finish()).toEqual([
      { type: "text", text: "  indented\n\nsecond" },
      { type: "text", text: "Screenshot captured" },
      { type: "image", data: "aGk=", mimeType: "image/png" },
      { type: "text", text: JSON.stringify({ a: 1 }, null, 2) },
      { type: "text", text: "tail" },
    ]);
  });
});

describe("what a run prints without end is held in bounded memory", () => {
  test("a flood of stream text keeps its start and its end and counts the rest, and the text is within the budget", () => {
    const output = new RunOutput(SMALL);
    for (let line = 0; line < 20_000; line += 1) output.pushText(`line ${String(line).padStart(5, "0")} ${"x".repeat(40)}\n`);
    const text = textOf(output.finish());
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1_024 + 400);
    expect(text).toStartWith("line 00000");
    expect(text).toContain("line 19999");
    expect(text).toMatch(/\[…\d+B elided…\]/);
    expect(text).toContain("tab output over");
    // The count adds up: what is shown plus what is elided is what was printed (separators of the join aside).
    const printed = 20_000 * "line 00000 ".length + 20_000 * 41;
    const elided = Number(/\[…(\d+)B elided…\]/.exec(text)?.[1]);
    expect(elided).toBeGreaterThan(printed - 2_000);
    expect(elided).toBeLessThan(printed);
  });

  test("a loop that alternates prints and displays of objects is bounded as one text, whatever the number of entries", () => {
    const output = new RunOutput(SMALL);
    for (let i = 0; i < 5_000; i += 1) {
      output.pushText(`step ${i}\n`);
      output.pushDisplay({ type: "json", data: { i, pad: "y".repeat(60) } });
    }
    const displays = output.finish();
    expect(displays.filter(part => part.type === "text").length).toBeLessThanOrEqual(1);
    const text = textOf(displays);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1_024 + 400);
    expect(text).toStartWith("step 0");
    expect(text).toContain('"i": 4999');
  });

  test("one chunk bigger than the whole budget is cut on arrival, not kept", () => {
    const output = new RunOutput(SMALL);
    output.pushText(`${"head ".repeat(1_000)}${"z".repeat(5_000_000)}${" tail".repeat(1_000)}`);
    const text = textOf(output.finish());
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1_024 + 400);
    expect(text).toStartWith("head head");
    expect(text).toContain("tail tail");
  });

  test("images past the ceiling are dropped and counted, and the run says so", () => {
    const output = new RunOutput(SMALL);
    for (let i = 0; i < 10; i += 1) output.push({ type: "image", data: "A".repeat(1_000), mimeType: "image/png" });
    const displays = output.finish();
    expect(images(displays)).toHaveLength(4);
    expect(textOf(displays)).toStartWith("[tab output: 6 images dropped — one call keeps at most ");
  });

  test("an image that alone is over the ceiling is dropped, and a smaller one after it is still kept", () => {
    const output = new RunOutput(SMALL);
    output.push({ type: "image", data: "A".repeat(10_000), mimeType: "image/png" });
    output.push({ type: "image", data: "A".repeat(100), mimeType: "image/png" });
    const displays = output.finish();
    expect(images(displays)).toHaveLength(1);
    expect(textOf(displays)).toContain("1 image dropped");
  });
});
