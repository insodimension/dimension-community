// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/session/streaming-output.ts (OutputSink: the head window, the rolling tail window, the file the whole stream spills to,
// the throttled chunk; enforceInlineByteCap: the elision and its footer) and eval/js/executor.ts:82-90 (how a cell's output goes through it) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: the windows are the 60% and 25% of the 50 KiB that doc 77 §7.4.2 gives the tool result, so a sink's text is what `capInline` would make of the whole stream; the file is written with
// node:fs, synchronously and to a cap (OMP's Bun.FileSink queues, and a queue is a buffer); the chunk the progress channel gets is bounded as well as throttled, and the throttle reads the clock on every push
// because a cell that never yields to the event loop (`for (;;) { print(x); await null }`) starves a timer; no column cap, no sixel, no carriage-return folding.

import { headWindow, tailWindow } from "../bytes.js";
import { SpillFile } from "../spill.js";

/** OMP's `DEFAULT_MAX_BYTES`: what one result carries inline. */
export const MAX_INLINE_BYTES = 50 * 1024;
/** What a failed cell leaves room for in its text: the tool appends the error line (the message and the lines of the model's own code), cut to this. */
export const ERROR_LINE_BYTES = 4 * 1024;
/** More than the elision line `\n[…NB elided…]\n` ever takes. */
export const ELISION_MARKER_BYTES = 48;
/** More than the footer `[raw output: <path>]` plus the file's stop line ever take. */
export const FOOTER_BYTES = 1024;
/** The share of the budget kept from the start of an output, and from its end (the rest is slack for the marker and the footer). */
const HEAD_SHARE = 0.6;
const TAIL_SHARE = 0.25;
/** The most one progress chunk carries, and the least time between two: a run of any length costs the host at most this much a second, however fast the cell prints. */
export const PROGRESS_CHUNK_BYTES = 16 * 1024;
export const PROGRESS_INTERVAL_MS = 100;

const NEWLINE = "\n";

/** `[…NB elided…]` between the start and the end of a text of `totalBytes`, each cut on a line boundary (OMP's enforceInlineByteCap). */
export function elideMiddle(head: string, tail: string, totalBytes: number): string {
  const headCut = head.lastIndexOf(NEWLINE);
  const kept = headCut > 0 ? head.slice(0, headCut) : head;
  const tailCut = tail.indexOf(NEWLINE);
  const rest = tailCut < 0 || tailCut === tail.length - 1 ? tail : tail.slice(tailCut + 1);
  const elided = Math.max(0, totalBytes - Buffer.byteLength(kept, "utf8") - Buffer.byteLength(rest, "utf8"));
  return `${kept}\n[…${elided}B elided…]\n${rest}`;
}

/** What `text` becomes inline when it is over `maxBytes`, before any footer: its first 60% and last 25%. */
export function capText(text: string, maxBytes = MAX_INLINE_BYTES): string {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= maxBytes) return text;
  return elideMiddle(headWindow(text, Math.floor(maxBytes * HEAD_SHARE)).text, tailWindow(text, Math.floor(maxBytes * TAIL_SHARE)).text, total);
}

export interface OutputSinkOptions {
  /** Inline budget. Default {@link MAX_INLINE_BYTES}. */
  maxBytes?: number;
  /** The session's folder for the file that keeps the whole stream once it outgrows the budget. Absent: no file, and what is elided is gone. */
  spillDir?: string;
  /** Progress: each chunk is at most {@link PROGRESS_CHUNK_BYTES}, at most one every {@link PROGRESS_INTERVAL_MS}; output past that within a chunk is counted, `[…NB elided…]`. */
  onChunk?: (chunk: string) => void;
  /** Tests: the clock. */
  now?: () => number;
}

export interface OutputSummary {
  /** The stream, trimmed; over the budget: its start, `[…NB elided…]`, its end, and the footer. */
  text: string;
  /** Bytes the stream had. */
  totalBytes: number;
  /** The file holding the stream (the whole of it unless it hit its cap), when the stream outgrew the budget and a file could be made. */
  spillPath?: string;
}

/**
 * The text a cell printed, held in bounded memory: its start (the first 60% of the budget), its end (a rolling window; the last 25% of the budget is shown) and a count of everything between. A stream that fits the
 * budget is kept whole and writes no file. One that does not is also written, from its first byte, to a file, up to {@link SpillFile}'s cap, and the summary's footer names it.
 */
export class OutputSink {
  readonly #max: number;
  readonly #headLimit: number;
  /** The tail window keeps what the head did not, up to the rest of the budget, so a stream within the budget is complete; the summary shows the last 25% of it. */
  readonly #tailLimit: number;
  readonly #spillDir: string | undefined;
  readonly #onChunk: ((chunk: string) => void) | undefined;
  readonly #now: () => number;
  #head = "";
  #headBytes = 0;
  #headClosed = false;
  #tail = "";
  #tailBytes = 0;
  #total = 0;
  #spill: SpillFile | undefined;
  #spillTried = false;
  #closed = false;
  #pending = "";
  #pendingBytes = 0;
  #lastChunkAt = Number.NEGATIVE_INFINITY;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: OutputSinkOptions = {}) {
    this.#max = options.maxBytes ?? MAX_INLINE_BYTES;
    this.#headLimit = Math.floor(this.#max * HEAD_SHARE);
    this.#tailLimit = this.#max - this.#headLimit;
    this.#spillDir = options.spillDir;
    this.#onChunk = options.onChunk;
    this.#now = options.now ?? Date.now;
  }

  push(chunk: string): void {
    if (this.#closed || chunk.length === 0) return;
    const bytes = Buffer.byteLength(chunk, "utf8");
    this.#progress(chunk, bytes);
    // The file is opened when the first chunk that cannot be kept whole arrives, while the windows still hold the stream from its first byte.
    if (this.#spill === undefined && !this.#spillTried && this.#spillDir !== undefined && this.#total + bytes > this.#max) this.#openSpill(this.#spillDir);
    this.#spill?.write(chunk);
    this.#total += bytes;
    this.#retain(chunk, bytes);
  }

  #openSpill(dir: string): void {
    this.#spillTried = true;
    const file = SpillFile.open(dir);
    if (file === undefined) return;
    file.write(this.#head);
    file.write(this.#tail);
    this.#spill = file;
  }

  #retain(chunk: string, bytes: number): void {
    let rest = chunk;
    let restBytes = bytes;
    if (!this.#headClosed) {
      const room = this.#headLimit - this.#headBytes;
      if (bytes <= room) {
        this.#head += chunk;
        this.#headBytes += bytes;
        return;
      }
      // The chunk that fills the head ends it, even when a few bytes of room are left over (a character that did not fit): a later small chunk must not land before this one's rest.
      const taken = headWindow(chunk, room);
      this.#head += taken.text;
      this.#headBytes += taken.bytes;
      this.#headClosed = true;
      rest = chunk.slice(taken.text.length);
      restBytes = bytes - taken.bytes;
    }
    if (restBytes >= this.#tailLimit) {
      const window = tailWindow(rest, this.#tailLimit);
      this.#tail = window.text;
      this.#tailBytes = window.bytes;
      return;
    }
    this.#tail += rest;
    this.#tailBytes += restBytes;
    // Trimmed at twice the window, so a run of small chunks does not re-encode the tail on every push.
    if (this.#tailBytes > this.#tailLimit * 2) {
      const window = tailWindow(this.#tail, this.#tailLimit);
      this.#tail = window.text;
      this.#tailBytes = window.bytes;
    }
  }

  #progress(chunk: string, bytes: number): void {
    if (this.#onChunk === undefined) return;
    this.#pendingBytes += bytes;
    // Only the end of what arrived since the last chunk can be sent, so only that is held.
    this.#pending = chunk.length >= PROGRESS_CHUNK_BYTES ? chunk.slice(chunk.length - PROGRESS_CHUNK_BYTES) : this.#pending + chunk;
    if (this.#pending.length > PROGRESS_CHUNK_BYTES * 2) this.#pending = this.#pending.slice(this.#pending.length - PROGRESS_CHUNK_BYTES);
    const now = this.#now();
    const wait = PROGRESS_INTERVAL_MS - (now - this.#lastChunkAt);
    if (wait <= 0) this.#flush(now);
    else if (this.#timer === undefined) {
      this.#timer = setTimeout(() => this.#flush(this.#now()), wait);
      this.#timer.unref?.();
    }
  }

  #flush(now: number): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#pendingBytes === 0) return;
    const sent = tailWindow(this.#pending, PROGRESS_CHUNK_BYTES);
    const dropped = this.#pendingBytes - sent.bytes;
    this.#pending = "";
    this.#pendingBytes = 0;
    this.#lastChunkAt = now;
    this.#onChunk?.(dropped > 0 ? `[…${dropped}B elided…]\n${sent.text}` : sent.text);
  }

  /**
   * About how many bytes {@link dump} shows of this stream so far, footer not counted: all of it while it fits the budget, else the two windows and the marker. Never less than what `dump` makes.
   */
  estimate(maxBytes = this.#max): number {
    const budget = Math.min(maxBytes, this.#max);
    return Math.min(this.#total, Math.floor(budget * (HEAD_SHARE + TAIL_SHARE)) + ELISION_MARKER_BYTES);
  }

  /**
   * What the stream shows now, and the end of it: the pending progress chunk is sent, the file is closed, nothing more is taken. `maxBytes` (never more than the sink's own budget) is what the text may take, footer not
   * counted: a stream that is longer is cut to its start and its end. A stream that fit the sink but not `maxBytes` has no file yet, and gets one now, so what is cut is still somewhere.
   */
  dump(maxBytes = this.#max): OutputSummary {
    this.#flush(this.#now());
    this.#closed = true;
    const budget = Math.min(maxBytes, this.#max);
    // The text is trimmed as a whole, as the cell's text always was: leading whitespace is the head's, trailing whitespace the tail's.
    if (this.#total <= budget) {
      this.#spill?.close();
      return { text: (this.#head + this.#tail).trim(), totalBytes: this.#total };
    }
    // Within the sink's budget the head and the tail are the whole stream between them; past it they are its two ends.
    const whole = this.#total <= this.#max;
    if (whole && this.#spillDir !== undefined && this.#spill === undefined && !this.#spillTried) this.#openSpill(this.#spillDir);
    this.#spill?.close();
    const start = whole ? this.#head + this.#tail : this.#head;
    const end = whole ? start : this.#tail;
    const headShown = headWindow(start, Math.floor(budget * HEAD_SHARE));
    const tailShown = tailWindow(end, Math.floor(budget * TAIL_SHARE));
    const head = headShown.text.trimStart();
    const tail = tailShown.text.trimEnd();
    const trimmed = headShown.bytes - Buffer.byteLength(head, "utf8") + (tailShown.bytes - Buffer.byteLength(tail, "utf8"));
    const elided = elideMiddle(head, tail, this.#total - trimmed);
    const spill = this.#spill;
    let text = elided;
    if (spill !== undefined) {
      text += `${text.endsWith(NEWLINE) ? "" : NEWLINE}[raw output: ${spill.path}]`;
      if (spill.notKeptBytes > 0) text += `\n[the file stops at ${spill.keptBytes}B: ${spill.notKeptBytes}B more were printed and are not kept]`;
    }
    return {
      text,
      totalBytes: this.#total,
      ...(spill === undefined ? {} : { spillPath: spill.path }),
    };
  }
}
