// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/session/streaming-output.ts (truncateBytesWindowed, findUtf8BoundaryForward/Backward) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../third-party/omp/LICENSE.
// Changed for the Browser pack: the head and tail windows are two small functions on strings, each answering with the window's byte count too, and a text far longer than the window is sliced before it is encoded.

/** A window of a text: the characters, and how many UTF-8 bytes they are. */
export interface Window {
  text: string;
  bytes: number;
}

/** The longest prefix of `text` within `max` UTF-8 bytes, cut on a character boundary. */
export function headWindow(text: string, max: number): Window {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= max) return { text, bytes };
  if (max <= 0) return { text: "", bytes: 0 };
  const encoded = Buffer.from(text.length > max ? text.slice(0, max) : text, "utf8");
  let end = Math.min(max, encoded.length);
  // A cut inside a multi-byte character steps back to the character's first byte.
  while (end > 0 && end < encoded.length && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return { text: encoded.subarray(0, end).toString("utf8"), bytes: end };
}

/** The longest suffix of `text` within `max` UTF-8 bytes, cut on a character boundary. */
export function tailWindow(text: string, max: number): Window {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= max) return { text, bytes };
  if (max <= 0) return { text: "", bytes: 0 };
  // Every character is at least one byte, so the last `max` characters hold the last `max` bytes (a pair cut in half encodes as three bytes and is dropped by the cut below).
  const encoded = Buffer.from(text.length > max ? text.slice(text.length - max) : text, "utf8");
  let start = Math.max(0, encoded.length - max);
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return { text: encoded.subarray(start).toString("utf8"), bytes: encoded.length - start };
}
