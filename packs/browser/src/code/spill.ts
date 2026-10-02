// Written for the Browser pack; the file that keeps the whole of an output the model was shown only the ends of follows OMP's artifact (https://github.com/can1357/oh-my-pi, MIT),
// packages/coding-agent/src/session/streaming-output.ts (the sink's file, `artifactMaxBytes`) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../third-party/omp/LICENSE.
// Changed for the Browser pack: OMP's artifact is an id in the session; here it is a file in the session's own folder under `<root>/artifacts/`, and its name is what the footer tells the model.
// The file is written synchronously and stops at a cap, so a cell that prints without end costs the disk a bounded amount and the process no queue.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, rmdirSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { headWindow } from "./bytes.js";

/** Files kept in one session's folder (the one a model is about to read and a good few before it). */
export const SPILL_FILES_KEPT = 20;
/** The most one spill file holds. Output past it is counted, not kept. */
export const SPILL_FILE_MAX_BYTES = 16 * 1024 * 1024;
/** A session's folder whose newest file is older than this is removed when another session spills (a footer path is read within the conversation, not weeks later). */
export const SPILL_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** The stale folders of a root are looked for at most this often by a process. */
const SWEEP_EVERY_MS = 60 * 60 * 1000;

const SPILL_NAME = /^browser-run-\d{13}-\d{6}-[0-9a-f]{8}\.txt$/;
const SESSION_FOLDER = /^[0-9a-f]{16}$/;
let sequence = 0;
const sweptAt = new Map<string, number>();

/** One folder per session for what a cell keeps on disk: a hash of the stamp, so the id itself is never a path, and one session's files are never pruned by another's. */
export function sessionFolder(root: string, session: string): string {
  return join(root, createHash("sha256").update(session).digest("hex").slice(0, 16));
}

function spillNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter(name => SPILL_NAME.test(name)).sort();
  } catch {
    return [];
  }
}

/** Keeps the newest {@link SPILL_FILES_KEPT} files of one session's folder. A file another process holds open stays until the next spill. */
function pruneSession(dir: string): void {
  const names = spillNames(dir);
  for (const name of names.slice(0, Math.max(0, names.length - SPILL_FILES_KEPT))) {
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      // Held open elsewhere.
    }
  }
}

/** Removes the session folders beside `dir` whose newest file is older than the TTL. At most once an hour per root and process; only files this module names are touched, and a folder with anything else in it stays. */
function sweepStaleSessions(dir: string, now: number): void {
  const root = dirname(dir);
  if (now - (sweptAt.get(root) ?? Number.NEGATIVE_INFINITY) < SWEEP_EVERY_MS) return;
  sweptAt.set(root, now);
  let siblings: string[];
  try {
    siblings = readdirSync(root).filter(name => SESSION_FOLDER.test(name) && join(root, name) !== dir);
  } catch {
    return;
  }
  for (const name of siblings) {
    const folder = join(root, name);
    try {
      const files = spillNames(folder);
      const newest = files.reduce((latest, file) => Math.max(latest, statSync(join(folder, file)).mtimeMs), 0);
      if (now - newest <= SPILL_SESSION_TTL_MS) continue;
      for (const file of files) rmSync(join(folder, file), { force: true });
      rmdirSync(folder);
    } catch {
      // Not empty, or in use: it stays.
    }
  }
}

/** A new, unique file name: sorts by creation time, so the oldest are the first to prune. */
function newSpillName(now: number): string {
  sequence = (sequence + 1) % 1_000_000;
  return `browser-run-${String(now).padStart(13, "0")}-${String(sequence).padStart(6, "0")}-${randomBytes(4).toString("hex")}.txt`;
}

/** The absolute path of a file in `dir` holding `text`, or undefined when it could not be written (the model still gets the capped text). */
export function saveSpill(dir: string, text: string): string | undefined {
  const file = SpillFile.open(dir, Number.POSITIVE_INFINITY);
  if (file === undefined) return undefined;
  file.write(text);
  file.close();
  return file.path;
}

/** An open spill file. Writes are synchronous: nothing is queued, so what is waiting to be written is never more than the chunk in hand. */
export class SpillFile {
  readonly path: string;
  readonly #maxBytes: number;
  #fd: number | undefined;
  #kept = 0;
  #notKept = 0;

  private constructor(path: string, fd: number, maxBytes: number) {
    this.path = path;
    this.#fd = fd;
    this.#maxBytes = maxBytes;
  }

  /** Creates a file in the session folder `dir` (made if needed, private to the user), prunes the folder to its newest files and sweeps the stale folders beside it. Undefined on any file-system error. */
  static open(dir: string, maxBytes = SPILL_FILE_MAX_BYTES): SpillFile | undefined {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const now = Date.now();
      const path = join(dir, newSpillName(now));
      const fd = openSync(path, "wx", 0o600);
      const file = new SpillFile(path, fd, maxBytes);
      pruneSession(dir);
      sweepStaleSessions(dir, now);
      return file;
    } catch {
      return undefined;
    }
  }

  /** Appends `text`, up to the cap; the rest is counted. A failed write (a full disk) ends the file where it is and counts everything after it. */
  write(text: string): void {
    if (text.length === 0) return;
    const fd = this.#fd;
    if (fd === undefined) {
      this.#notKept += Buffer.byteLength(text, "utf8");
      return;
    }
    const room = this.#maxBytes - this.#kept;
    const fits = headWindow(text, room);
    try {
      if (fits.bytes > 0) writeSync(fd, fits.text);
      this.#kept += fits.bytes;
      this.#notKept += Buffer.byteLength(text, "utf8") - fits.bytes;
      if (this.#kept >= this.#maxBytes || fits.bytes < Buffer.byteLength(text, "utf8")) this.close();
    } catch {
      this.#notKept += Buffer.byteLength(text, "utf8");
      this.close();
    }
  }

  /** Bytes in the file. */
  get keptBytes(): number {
    return this.#kept;
  }

  /** Bytes printed after the file stopped. */
  get notKeptBytes(): number {
    return this.#notKept;
  }

  close(): void {
    const fd = this.#fd;
    if (fd === undefined) return;
    this.#fd = undefined;
    try {
      closeSync(fd);
    } catch {
      // Already gone.
    }
  }
}
