// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/run-output.ts @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: OMP's pi-ai content types become the contract's text/ImageBlock shapes; the evaluator's display payloads are
// image and json only (OMP's third "status" payload belongs to eval helpers the pack does not have).

import type { EvaluatorDisplay } from "../contracts";
import type { RunResult } from "../contracts";

type Entry = RunResult["displays"][number];

/**
 * Accumulates a browser run's result entries: explicit `display()` payloads,
 * screenshot captions/images, and buffered stream text (`console.*`, `print`,
 * `display()` of strings/primitives, which the evaluator emits through `onText`).
 * Stream text is buffered and flushed as one entry before the next
 * display/screenshot (and on `finish()`) so it reaches the tool result in order.
 */
export class RunOutput {
  readonly #displays: Entry[] = [];
  #textBuffer = "";

  /** Buffer a stream-text chunk; it joins the entries at the next push or on finish(). */
  pushText(chunk: string): void {
    this.#textBuffer += chunk;
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
    this.#flush();
    this.#displays.push(entry);
  }

  /** Flush any remaining stream text and return the ordered entries. */
  finish(): Entry[] {
    this.#flush();
    return this.#displays;
  }

  #flush(): void {
    if (!this.#textBuffer) return;
    // Entries are newline-joined at render; drop the stream's trailing newline.
    this.#displays.push({ type: "text", text: this.#textBuffer.replace(/\n$/, "") });
    this.#textBuffer = "";
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
