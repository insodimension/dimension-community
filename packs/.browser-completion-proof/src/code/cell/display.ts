// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/eval/js/shared/runtime.ts (displayValue, coerceImageBase64, formatConsoleArgs, the stdout patch),
// packages/coding-agent/src/eval/js/shared/prelude.txt (the console bridge) and packages/coding-agent/src/tools/eval.ts (formatDisplayJsonForText) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: the bridge calls are plain closures over a run's hooks (no AsyncLocalStorage lookup for the lexical names), and the output of a finished cell is assembled here, held in bounded memory
// (the stream and the `display[n]:` blocks each go through an `OutputSink`, the images are counted against a ceiling).

import { Console } from "node:console";
import { Writable } from "node:stream";
import * as util from "node:util";
import type { EvaluatorDisplay, EvaluatorHooks } from "../contracts.js";
import { FOOTER_BYTES, MAX_INLINE_BYTES, OutputSink } from "./output-sink.js";

// Strict base64: characters from the standard alphabet plus optional `=` padding, and a length that is a multiple of four. URL-safe base64 and embedded
// whitespace are not accepted: the model APIs only honor strict base64 in image sources.
const BASE64_STRICT_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DECIMAL_CSV_RE = /^\d{1,3}(?:,\d{1,3})*$/;

function isStrictBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0) return false;
  return BASE64_STRICT_RE.test(s);
}

/**
 * Normalize the `data` field of an `{ type: "image", data, mimeType }` display payload into strict base64. Accepts already-valid base64 strings,
 * `Uint8Array` / `Buffer` / `ArrayBuffer` / typed array views, `{ type: "Buffer", data: number[] }` (the shape `JSON.stringify` gives a Buffer), and
 * decimal-CSV byte strings (what `uint8array.toString("base64")` returns: it ignores the encoding argument). Returns `null` if no recovery is possible.
 */
export function coerceImageBase64(data: unknown): string | null {
  if (typeof data === "string") {
    if (isStrictBase64(data)) return data;
    if (DECIMAL_CSV_RE.test(data)) {
      const parts = data.split(",");
      const bytes = new Uint8Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const n = Number(parts[i]);
        if (!Number.isInteger(n) || n < 0 || n > 255) return null;
        bytes[i] = n;
      }
      return Buffer.from(bytes).toString("base64");
    }
    return null;
  }
  if (data instanceof Uint8Array) return Buffer.from(data).toString("base64");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("base64");
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64");
  }
  if (data && typeof data === "object") {
    const obj = data as { type?: unknown; data?: unknown };
    if (obj.type === "Buffer" && Array.isArray(obj.data)) {
      const arr = obj.data as unknown[];
      const bytes = new Uint8Array(arr.length);
      for (let i = 0; i < arr.length; i++) {
        const n = arr[i];
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) return null;
        bytes[i] = n;
      }
      return Buffer.from(bytes).toString("base64");
    }
  }
  return null;
}

function describeDataType(data: unknown): string {
  if (data === null) return "null";
  if (typeof data !== "object") return typeof data;
  return Object.prototype.toString.call(data).slice(8, -1);
}

export function formatConsoleArgs(args: unknown[]): string {
  return args.map(arg => (typeof arg === "string" ? arg : util.inspect(arg, { depth: 6, colors: false, breakLength: 120 }))).join(" ");
}

/** What `display(value)` and the final value of a cell do with a value: images and objects become displays, everything else is text. */
export function displayValue(value: unknown, hooks: EvaluatorHooks): void {
  if (value === undefined) return;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "image" && typeof record.mimeType === "string") {
      const data = coerceImageBase64(record.data);
      if (data !== null) {
        hooks.onDisplay({ type: "image", data, mimeType: record.mimeType });
        return;
      }
      hooks.onText(
        `[display: image dropped — \`data\` must be a base64 string, Uint8Array/Buffer, or ArrayBuffer; got ${describeDataType(record.data)}]\n`,
      );
      return;
    }
    try {
      hooks.onDisplay({ type: "json", data: structuredClone(value) });
    } catch {
      hooks.onText(`${Object.prototype.toString.call(value)}\n`);
    }
    return;
  }
  hooks.onText(`${String(value)}\n`);
}

/** `console.*` as the cell sees it: the text goes to the run's output, `error` and `warn` carry OMP's prefixes. */
export function createConsoleBridge(hooks: EvaluatorHooks): Console {
  const log = (level: string, ...args: unknown[]): void => {
    const prefix = level === "error" ? "[error] " : level === "warn" ? "[warn] " : "";
    const text = `${prefix}${formatConsoleArgs(args)}`;
    hooks.onText(text.endsWith("\n") ? text : `${text}\n`);
  };
  const table = (...args: unknown[]): void => {
    let buffer = "";
    const stream = new Writable({
      write(chunk, _enc, cb) {
        buffer += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
        cb();
      },
    });
    const tableConsole = new Console({ stdout: stream, colorMode: false });
    (tableConsole.table as (...a: unknown[]) => void)(...args);
    hooks.onText(buffer.endsWith("\n") ? buffer : `${buffer}\n`);
  };
  const timers = new Map<string, number>();
  const counts = new Map<string, number>();
  const bridge = {
    log: (...args: unknown[]) => log("log", ...args),
    info: (...args: unknown[]) => log("info", ...args),
    warn: (...args: unknown[]) => log("warn", ...args),
    error: (...args: unknown[]) => log("error", ...args),
    debug: (...args: unknown[]) => log("debug", ...args),
    table: (data: unknown, columns?: unknown) => (columns === undefined ? table(data) : table(data, columns)),
    dir: (value: unknown, _options?: unknown) => log("log", value),
    dirxml: (...args: unknown[]) => log("log", ...args),
    trace: (...args: unknown[]) => {
      const stack = (new Error().stack ?? "").split("\n").slice(2).join("\n");
      log("log", args.length > 0 ? `Trace: ${args.join(" ")}` : "Trace", `\n${stack}`);
    },
    assert: (condition: unknown, ...args: unknown[]) => {
      if (condition) return;
      if (args.length > 0) log("error", "Assertion failed:", ...args);
      else log("error", "Assertion failed");
    },
    group: (...args: unknown[]) => {
      if (args.length > 0) log("log", ...args);
    },
    groupCollapsed: (...args: unknown[]) => {
      if (args.length > 0) log("log", ...args);
    },
    groupEnd: () => {},
    time: (label?: unknown) => {
      timers.set(String(label ?? "default"), Date.now());
    },
    timeLog: (label?: unknown, ...args: unknown[]) => {
      const key = String(label ?? "default");
      const start = timers.get(key);
      if (start === undefined) {
        log("warn", `Timer '${key}' does not exist`);
        return;
      }
      log("log", `${key}: ${Date.now() - start}ms`, ...args);
    },
    timeEnd: (label?: unknown) => {
      const key = String(label ?? "default");
      const start = timers.get(key);
      if (start === undefined) {
        log("warn", `Timer '${key}' does not exist`);
        return;
      }
      timers.delete(key);
      log("log", `${key}: ${Date.now() - start}ms`);
    },
    count: (label?: unknown) => {
      const key = String(label ?? "default");
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      log("log", `${key}: ${next}`);
    },
    countReset: (label?: unknown) => {
      counts.delete(String(label ?? "default"));
    },
  };
  return bridge as unknown as Console;
}

/** Cap per `display()` value sent back to the model (eval.ts). */
const MAX_DISPLAY_TEXT_BYTES = 8000;

function formatDisplayJsonForText(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length > MAX_DISPLAY_TEXT_BYTES) {
    text = `${text.slice(0, MAX_DISPLAY_TEXT_BYTES)}\n[…${text.length - MAX_DISPLAY_TEXT_BYTES}ch elided…]`;
  }
  return text;
}

/** Base64 characters of images one cell may keep. Past it an image is dropped and counted: a loop of screenshots must not be able to fill the worker's heap. About 160 full-size model screenshots. */
export const MAX_IMAGE_BASE64_CHARS = 32 * 1024 * 1024;

/** Between the stream, the display blocks and the note: a blank line. */
const SECTION_GAP = "\n\n";

export interface CellOutputOptions {
  /** The session's folder for the file that keeps a stream longer than the inline budget. Absent: none is kept. */
  spillDir?: string;
  /** Progress: the text as it is printed, throttled and bounded (see {@link OutputSink}). */
  onText?: (chunk: string) => void;
}

/**
 * Collects what one cell shows: the stream text (`console.*`, `print`, strings and numbers handed to `display`, the final value) and the `display()`ed
 * objects and images. `finish()` is OMP's eval-cell text: the trimmed stream, then `display[n]:` blocks, separated by a blank line; images are returned
 * apart, and go first in the tool result. Whatever the cell prints, what is held stays within the inline budget (twice: the stream, the blocks) plus the images' ceiling,
 * and the text `finish()` makes is ONE budget's worth, shared by the two: the tool that carries it never has to cut it again.
 */
export class CellOutput {
  readonly #stream: OutputSink;
  readonly #blocks = new OutputSink();
  #blockCount = 0;
  readonly #images: Array<{ type: "image"; data: string; mimeType: string }> = [];
  #imageChars = 0;
  #imagesDropped = 0;

  constructor(options: CellOutputOptions = {}) {
    this.#stream = new OutputSink({
      ...(options.spillDir === undefined ? {} : { spillDir: options.spillDir }),
      ...(options.onText === undefined ? {} : { onChunk: options.onText }),
    });
  }

  hooks(): EvaluatorHooks {
    return {
      onText: chunk => this.#stream.push(chunk),
      onDisplay: (output: EvaluatorDisplay) => {
        if (output.type === "image") {
          if (this.#imageChars + output.data.length > MAX_IMAGE_BASE64_CHARS) this.#imagesDropped += 1;
          else {
            this.#imageChars += output.data.length;
            this.#images.push({ type: "image", data: output.data, mimeType: output.mimeType });
          }
          return;
        }
        this.#blockCount += 1;
        const block = `display[${this.#blockCount}]:\n${formatDisplayJsonForText(output.data)}`;
        this.#blocks.push(this.#blockCount === 1 ? block : `\n\n${block}`);
      },
    };
  }

  /**
   * The cell's text, within {@link MAX_INLINE_BYTES} less `reserveBytes` (room a failed cell leaves for its error line, which the tool appends). The stream and the blocks share the budget: a section that fits in its
   * half, or in what the other leaves, is shown whole; one that does not is cut to its start and its end with its own marker. A stream cut here has the whole of what it printed in the file the footer names, even if it
   * would have fitted the stream's own budget alone.
   */
  finish(reserveBytes = 0): { text: string; images: Array<{ type: "image"; data: string; mimeType: string }> } {
    const note = this.#imagesDropped === 0 ? "" : `[display: ${this.#imagesDropped} image${this.#imagesDropped === 1 ? "" : "s"} dropped — one cell keeps at most ${MAX_IMAGE_BASE64_CHARS / (1024 * 1024)} MiB of images]`;
    const gaps = SECTION_GAP.length * 2;
    const room = Math.max(0, MAX_INLINE_BYTES - reserveBytes - gaps - Buffer.byteLength(note, "utf8"));
    // Who gets what: each section asks for what it would show whole (the stream also for its footer); if both do not fit, the smaller keeps its ask up to half and the larger gets the rest.
    let streamRoom = this.#stream.estimate() + FOOTER_BYTES;
    let blocksRoom = this.#blocks.estimate();
    if (streamRoom + blocksRoom > room) {
      const half = Math.floor(room / 2);
      if (streamRoom <= half) blocksRoom = room - streamRoom;
      else if (blocksRoom <= half) streamRoom = room - blocksRoom;
      else {
        streamRoom = half;
        blocksRoom = room - half;
      }
    }
    const stdout = this.#stream.dump(Math.max(0, streamRoom - FOOTER_BYTES)).text;
    // The blocks get what the stream really took.
    const shown = this.#blocks.dump(Math.max(0, room - Buffer.byteLength(stdout, "utf8"))).text;
    const text = [stdout, shown, note].filter(part => part.length > 0).join(SECTION_GAP);
    return { text, images: this.#images };
  }
}
