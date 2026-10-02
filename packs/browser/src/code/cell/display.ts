// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/eval/js/shared/runtime.ts (displayValue, coerceImageBase64, formatConsoleArgs, the stdout patch),
// packages/coding-agent/src/eval/js/shared/prelude.txt (the console bridge) and packages/coding-agent/src/tools/eval.ts (formatDisplayJsonForText) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: the bridge calls are plain closures over a run's hooks (no AsyncLocalStorage lookup for the lexical names), and the output of a finished cell is assembled here.

import { Console } from "node:console";
import { Writable } from "node:stream";
import * as util from "node:util";
import type { EvaluatorDisplay, EvaluatorHooks } from "../contracts.js";

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

/**
 * Collects what one cell shows: the stream text (`console.*`, `print`, strings and numbers handed to `display`, the final value) and the `display()`ed
 * objects and images. `finish()` is OMP's eval-cell text: the trimmed stream, then `display[n]:` blocks, separated by a blank line; images are returned
 * apart, and go first in the tool result.
 */
export class CellOutput {
  #stream = "";
  readonly #json: unknown[] = [];
  readonly #images: Array<{ type: "image"; data: string; mimeType: string }> = [];

  /** Hooks for one run; `observe` sees every text chunk as it arrives (the progress channel). */
  hooks(observe?: (chunk: string) => void): EvaluatorHooks {
    return {
      onText: chunk => {
        this.#stream += chunk;
        observe?.(chunk);
      },
      onDisplay: (output: EvaluatorDisplay) => {
        if (output.type === "image") this.#images.push({ type: "image", data: output.data, mimeType: output.mimeType });
        else this.#json.push(output.data);
      },
    };
  }

  get streamText(): string {
    return this.#stream;
  }

  finish(): { text: string; images: Array<{ type: "image"; data: string; mimeType: string }> } {
    const stdout = this.#stream.trim();
    const shown = this.#json.map((data, index) => `display[${index + 1}]:\n${formatDisplayJsonForText(data)}`).join("\n\n");
    const text = stdout && shown ? `${stdout}\n\n${shown}` : stdout || shown;
    return { text, images: this.#images };
  }
}
