/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the start and the end of a long output are cut by bytes, and a cut inside a character (an emoji, a ZWJ
 *  sequence, a euro sign) turns it into U+FFFD in what the model reads, or makes a window longer than its budget. Checked against a code-point reference. */
import { expect, test } from "bun:test";
import { headWindow, tailWindow } from "../src/code/bytes.js";

const ALPHABET = ["a", "é", "€", "😀", "\n", "z", "日", "\u{1F9D1}\u200D\u{1F4BB}"];
function reference(text: string, max: number): { head: string; tail: string } {
  const chars = [...text];
  let head = "";
  for (const c of chars) {
    if (Buffer.byteLength(head + c) > max) break;
    head += c;
  }
  let tail = "";
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    if (Buffer.byteLength(chars[i]! + tail) > max) break;
    tail = chars[i]! + tail;
  }
  return { head, tail };
}
test("the head and tail windows are the longest whole-character prefix and suffix within the byte budget", () => {
  // mulberry32: a seeded generator whose low bits are as good as its high ones (a plain LCG modulo a small n cycles, and never reaches most cuts).
  let state = 0x9e3779b9;
  const rnd = (n: number): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  for (let i = 0; i < 3000; i += 1) {
    const length = rnd(40);
    let text = "";
    for (let j = 0; j < length; j += 1) text += ALPHABET[rnd(ALPHABET.length)];
    const max = rnd(60);
    const want = reference(text, max);
    const head = headWindow(text, max);
    const tail = tailWindow(text, max);
    expect(head.text).toBe(want.head);
    expect(head.bytes).toBe(Buffer.byteLength(want.head));
    expect(tail.text).toBe(want.tail);
    expect(tail.bytes).toBe(Buffer.byteLength(want.tail));
  }
});
