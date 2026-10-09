// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/run-output.ts @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: OMP's pi-ai content types become the contract's text/ImageBlock shapes; the evaluator's display payloads are
// image and json only (OMP's third "status" payload belongs to eval helpers the pack does not have); and what a run collects is bounded as it is collected (the text through the cell's own
// {@link OutputSink}, the images under the cell's own ceiling), because OMP's tool call ends in its own process and the pack's runs in the worker that holds every other tab's variables.

import type { EvaluatorDisplay } from "../contracts";
import type { RunResult } from "../contracts";
import { MAX_IMAGE_BASE64_CHARS } from "../cell/display";
import { MAX_INLINE_BYTES, OutputSink } from "../cell/output-sink";

type Entry = RunResult["displays"][number];

/** What a run that outgrew its text budget ends with: the middle of its text is not kept anywhere (the realm has no file for it). */
export const TAB_TEXT_CUT_NOTE = "[tab output over 50 KiB: its middle was not kept here; print less, or return the value]";

/** The line that says images were left out of one call's output. */
export function droppedImagesNote(dropped: number, ceilingChars: number): string {
  return `[tab output: ${dropped} image${dropped === 1 ? "" : "s"} dropped — one call keeps at most ${ceilingChars / (1024 * 1024)} MiB of images]`;
}

export interface RunOutputLimits {
  /** Bytes of text a run keeps: its start and its end, and a count of what lies between. Default {@link MAX_INLINE_BYTES}, the budget the bridge cuts a call's text to. */
  textBytes?: number;
  /** Base64 characters of images a run keeps. Default {@link MAX_IMAGE_BASE64_CHARS}, the ceiling the bridge applies. */
  imageChars?: number;
}

/**
 * Accumulates a browser run's result entries: explicit `display()` payloads,
 * screenshot captions/images, and buffered stream text (`console.*`, `print`,
 * `display()` of strings/primitives, which the evaluator emits through `onText`).
 * Stream text is buffered and flushed as one entry before the next
 * display/screenshot (and on `finish()`) so it reaches the tool result in order.
 *
 * A run that prints a little is kept exactly as printed. A run whose text outgrows `textBytes` (a loop of `console.log` that never ends) goes on through an {@link OutputSink}: the start, the end and
 * a count of what lay between are all that is held, so the worker's heap does not grow with what the page code prints. From then on its text is one entry, first, and the images follow in order
 * (the bridge joins the text parts and takes the images apart, so nothing downstream reads the order between the two). Images past `imageChars` are dropped and counted.
 */
export class RunOutput {
  readonly #displays: Entry[] = [];
  readonly #textLimit: number;
  readonly #imageLimit: number;
  #textBuffer = "";
  /** Bytes of text held in the entries and the buffer, until the run outgrows its budget. */
  #textBytes = 0;
  #imageChars = 0;
  #imagesDropped = 0;
  /** The run's whole text once it outgrew the budget; absent until then. */
  #sink: OutputSink | undefined;
  /** Something has been put into the sink, so an entry after it is separated by a newline. */
  #sinkStarted = false;
  #sinkInStream = false;
  /** The stream's last newline is held back: an entry that follows replaces it with its own separator, the way the entries of a run are joined. */
  #heldNewline = false;

  constructor(limits: RunOutputLimits = {}) {
    this.#textLimit = limits.textBytes ?? MAX_INLINE_BYTES;
    this.#imageLimit = limits.imageChars ?? MAX_IMAGE_BASE64_CHARS;
  }

  /** Buffer a stream-text chunk; it joins the entries at the next push or on finish(). */
  pushText(chunk: string): void {
    if (this.#sink !== undefined) {
      this.#intoStream(this.#sink, chunk);
      return;
    }
    this.#textBuffer += chunk;
    this.#textBytes += Buffer.byteLength(chunk, "utf8");
    if (this.#textBytes > this.#textLimit) this.#outgrown();
  }

  /** Append a `display()` payload (image or json), flushing buffered text first. */
  pushDisplay(output: EvaluatorDisplay): void {
    if (output.type === "image") {
      this.push({ type: "image", data: output.data, mimeType: output.mimeType });
      return;
    }
    this.push({ type: "text", text: safeJsonStringify(output.data) });
  }

  /** Append a pre-built entry (e.g. a screenshot caption/image), flushing buffered text first. */
  push(entry: Entry): void {
    if (entry.type === "image") {
      this.#flush();
      if (this.#imageChars + entry.data.length > this.#imageLimit) {
        this.#imagesDropped += 1;
        return;
      }
      this.#imageChars += entry.data.length;
      this.#displays.push(entry);
      return;
    }
    if (this.#sink !== undefined) {
      this.#asEntry(this.#sink, entry.text);
      return;
    }
    this.#flush();
    this.#displays.push(entry);
    this.#textBytes += Buffer.byteLength(entry.text, "utf8");
    if (this.#textBytes > this.#textLimit) this.#outgrown();
  }

  /** Flush any remaining stream text and return the ordered entries. */
  finish(): Entry[] {
    this.#flush();
    const note = this.#imagesDropped === 0 ? "" : droppedImagesNote(this.#imagesDropped, this.#imageLimit);
    if (this.#sink === undefined) return note === "" ? this.#displays : [...this.#displays, { type: "text", text: note }];
    const text = [this.#sink.dump().text, TAB_TEXT_CUT_NOTE, note].filter(part => part.length > 0).join("\n");
    return [{ type: "text", text }, ...this.#displays];
  }

  #flush(): void {
    if (!this.#textBuffer) return;
    // Entries are newline-joined at render; drop the stream's trailing newline.
    this.#displays.push({ type: "text", text: this.#textBuffer.replace(/\n$/, "") });
    this.#textBuffer = "";
  }

  /** The text of the run no longer fits its budget: everything so far goes into a sink, and the entries keep only the images. */
  #outgrown(): void {
    const sink = new OutputSink({ maxBytes: this.#textLimit });
    this.#sink = sink;
    const images: Entry[] = [];
    for (const entry of this.#displays) {
      if (entry.type === "text") this.#asEntry(sink, entry.text);
      else images.push(entry);
    }
    this.#displays.length = 0;
    this.#displays.push(...images);
    const buffered = this.#textBuffer;
    this.#textBuffer = "";
    this.#intoStream(sink, buffered);
  }

  #asEntry(sink: OutputSink, text: string): void {
    this.#heldNewline = false;
    this.#sinkInStream = false;
    if (this.#sinkStarted) sink.push("\n");
    sink.push(text);
    this.#sinkStarted = true;
  }

  #intoStream(sink: OutputSink, chunk: string): void {
    if (!this.#sinkInStream) {
      // A stream after an entry starts after the newline that joins them.
      if (this.#sinkStarted) sink.push("\n");
      this.#sinkInStream = true;
      this.#sinkStarted = true;
    }
    if (this.#heldNewline) {
      sink.push("\n");
      this.#heldNewline = false;
    }
    if (chunk.endsWith("\n")) {
      this.#heldNewline = true;
      sink.push(chunk.slice(0, -1));
    } else sink.push(chunk);
  }
}

/** JSON.stringify that never throws (cycles/BigInt → String(value)). */
export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Pass a return value across the run boundary: structured-cloneable as-is, else JSON round-trip, else String. */
export function cloneSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    structuredClone(value);
    return value;
  } catch {}
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {}
  return String(value);
}
