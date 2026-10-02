// Written for the Browser pack; the file that keeps the whole of an output the model was shown only the ends of follows OMP's artifact (https://github.com/can1357/oh-my-pi, MIT),
// packages/coding-agent/src/session/streaming-output.ts (the sink's file, `artifactMaxBytes`) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../third-party/omp/LICENSE.
// Changed for the Browser pack: OMP's artifact is an id in the session; here it is a file in the session's own folder under `<root>/artifacts/`, and its name is what the footer tells the model.
// The file is written synchronously and stops at a cap, so a cell that prints without end costs the disk a bounded amount and the process no queue. The folders are bounded too (files and bytes, a session's and
// the whole root's, oldest first) and a host that ends a session removes its folder (`discardSessionSpills`).

import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, rmdirSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { headWindow } from "./bytes.js";

/** Files kept in one session's folder (the one a model is about to read and a good few before it). */
export const SPILL_FILES_KEPT = 20;
/** The most one spill file holds. Output past it is counted, not kept. */
export const SPILL_FILE_MAX_BYTES = 16 * 1024 * 1024;
/** The most one session's folder holds, the file being written counted at its cap: eight full files. */
export const SPILL_SESSION_MAX_BYTES = 128 * 1024 * 1024;
/** The most the whole artifacts root holds, across sessions: fifty sessions that each flood no longer hold gigabytes. */
export const SPILL_ROOT_MAX_BYTES = 1024 * 1024 * 1024;
/** A session's folder whose newest file is older than this is removed when another session spills (a footer path is read within the conversation, not weeks later). */
export const SPILL_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** What a folder of spill files may hold. The shipped bounds are {@link SPILL_BOUNDS}; a test passes smaller ones. */
export interface SpillBounds {
  filesPerSession: number;
  sessionBytes: number;
  rootBytes: number;
  sessionTtlMs: number;
}
export const SPILL_BOUNDS: SpillBounds = {
  filesPerSession: SPILL_FILES_KEPT,
  sessionBytes: SPILL_SESSION_MAX_BYTES,
  rootBytes: SPILL_ROOT_MAX_BYTES,
  sessionTtlMs: SPILL_SESSION_TTL_MS,
};

const SPILL_NAME = /^browser-run-\d{13}-\d{6}-[0-9a-f]{8}\.txt$/;
const SESSION_FOLDER = /^[0-9a-f]{16}$/;
let sequence = 0;

/**
 * One folder per session for what a cell keeps on disk: a hash of the stamp, so the id itself is never a path, and one session's files are never pruned by another's.
 * This is THE session folder: the cell realm's `init.outputDir` (the worker's spills) and the tool's own (`saveSpill`) both name it, so a host takes it from here, with the artifacts root, and defines no copy.
 */
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

/** A spill file the pack wrote. Its name sorts by creation time, folder by folder and across folders. */
interface Held {
  folder: string;
  path: string;
  name: string;
  bytes: number;
  mtimeMs: number;
}

function heldIn(folder: string): Held[] {
  return spillNames(folder).flatMap(name => {
    const path = join(folder, name);
    try {
      const stat = statSync(path);
      return [{ folder, path, name, bytes: stat.size, mtimeMs: stat.mtimeMs }];
    } catch {
      return [];
    }
  });
}

function forget(file: Held): boolean {
  try {
    rmSync(file.path, { force: true });
    return true;
  } catch {
    // Held open elsewhere: it stays until a later spill.
    return false;
  }
}

/** Removes the oldest of `files` (never `keep`) until `fits` says the rest do; what could not be removed stays. `files` ends as what is left. */
function trimOldest(files: Held[], keep: string | undefined, fits: (left: Held[]) => boolean): void {
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  while (!fits(files)) {
    const index = files.findIndex(file => file.path !== keep);
    if (index < 0) return;
    forget(files[index]!);
    files.splice(index, 1);
  }
}

const total = (files: Held[]): number => files.reduce((sum, file) => sum + file.bytes, 0);

/**
 * Holds the folders of `root` to their bounds. Sessions whose newest file is older than the age limit go whole (a folder with anything else in it stays). `keep` is the file being written, of a session whose
 * folder holds at most {@link SpillBounds.filesPerSession} files and {@link SpillBounds.sessionBytes}; `reserve` is what the file may still grow to, counted against both. Then the root holds at most
 * {@link SpillBounds.rootBytes} across all sessions. Oldest files go first, and `keep` is never one of them. Only files this module names are touched.
 */
function enforceBounds(root: string, keep: string | undefined, reserve: number, now: number, bounds: SpillBounds): void {
  let names: string[];
  try {
    names = readdirSync(root).filter(name => SESSION_FOLDER.test(name));
  } catch {
    return;
  }
  const keepFolder = keep === undefined ? undefined : join(keep, "..");
  const sessions = names.map(name => {
    const folder = join(root, name);
    const files = heldIn(folder);
    return { folder, files, held: files.length };
  });
  for (const session of sessions) {
    if (session.folder === keepFolder || session.files.length === 0) continue;
    if (now - Math.max(...session.files.map(file => file.mtimeMs)) > bounds.sessionTtlMs) {
      for (const file of session.files) forget(file);
      session.files = [];
    }
  }
  const own = sessions.find(session => session.folder === keepFolder);
  if (own) trimOldest(own.files, keep, files => files.length <= bounds.filesPerSession && total(files) + reserve <= bounds.sessionBytes);
  const all = sessions.flatMap(session => session.files);
  trimOldest(all, keep, files => total(files) + reserve <= bounds.rootBytes);
  const alive = new Set(all.map(file => file.path));
  // A folder that lost a file and has none left goes (one that never had any is another process's, just made).
  for (const session of sessions) {
    if (session.folder === keepFolder || session.held === 0 || session.files.some(file => alive.has(file.path))) continue;
    try {
      rmdirSync(session.folder);
    } catch {
      // Not empty (a file this module does not name, or one held open): it stays.
    }
  }
}

/** Applies the bounds and the age limit to `root` with no spill to trigger them: once at server start, for a machine that never spills again. */
export function sweepSpills(root: string, bounds: SpillBounds = SPILL_BOUNDS, now: number = Date.now()): void {
  enforceBounds(root, undefined, 0, now, bounds);
}

/**
 * Removes a session's spill files and its folder: what the host calls when the session's browser ends (doc 77 §7.4.2: the files go with it). Not when its worker is rebuilt: a cell that failed or timed out
 * names a file in its message, and the model reads it after the rebuild. Only files this module names go; a folder with anything else in it stays.
 */
export function discardSessionSpills(root: string, session: string): void {
  const folder = sessionFolder(root, session);
  for (const file of heldIn(folder)) forget(file);
  try {
    rmdirSync(folder);
  } catch {
    // Gone already, or not empty.
  }
}

/** A new, unique file name: sorts by creation time, so the oldest are the first to prune. */
function newSpillName(now: number): string {
  sequence = (sequence + 1) % 1_000_000;
  return `browser-run-${String(now).padStart(13, "0")}-${String(sequence).padStart(6, "0")}-${randomBytes(4).toString("hex")}.txt`;
}

/** The absolute path of a file in `dir` holding `text`, or undefined when it could not be written (the model still gets the capped text). */
export function saveSpill(dir: string, text: string, bounds: SpillBounds = SPILL_BOUNDS): string | undefined {
  const bytes = Buffer.byteLength(text, "utf8");
  const file = SpillFile.open(dir, bytes, bounds);
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

  /** Creates a file in the session folder `dir` (made if needed, private to the user) and holds the folders to their bounds: this one's files and bytes (`maxBytes` counted whole), the root's bytes, the age limit. Undefined on any file-system error. */
  static open(dir: string, maxBytes = SPILL_FILE_MAX_BYTES, bounds: SpillBounds = SPILL_BOUNDS): SpillFile | undefined {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const now = Date.now();
      const path = join(dir, newSpillName(now));
      const fd = openSync(path, "wx", 0o600);
      const file = new SpillFile(path, fd, maxBytes);
      enforceBounds(join(dir, ".."), path, maxBytes, now, bounds);
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
