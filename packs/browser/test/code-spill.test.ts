/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the `[raw output: <path>]` footer is the model's only way back to the part of an output it was not shown. If
 *  one session's spills can remove another's files the path is gone before it is read; if nothing ever removes a session's folder the artifacts folder grows
 *  for as long as the pack is installed (the old rule, the newest 20 files of the whole folder, bounded it; per-session folders must keep that bound).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardSessionSpills, saveSpill, sessionFolder, SPILL_BOUNDS, SpillFile, sweepSpills, type SpillBounds } from "../src/code/spill.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function artifactsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "browser-spill-"));
  roots.push(root);
  return root;
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("the folders that keep what the model was not shown", () => {
  test("a session's folder is a hash of its stamp: the same stamp the same folder, another stamp another, and the stamp itself is never a path", async () => {
    const root = await artifactsRoot();
    expect(sessionFolder(root, "chat-7")).toBe(sessionFolder(root, "chat-7"));
    expect(sessionFolder(root, "chat-7")).not.toBe(sessionFolder(root, "chat-8"));
    expect(sessionFolder(root, "../../etc").startsWith(root)).toBe(true);
    expect(sessionFolder(root, "../../etc")).toMatch(/[\\/][0-9a-f]{16}$/);
  });

  test("a session's files are pruned to its newest 20 and no other session's are touched", async () => {
    const root = await artifactsRoot();
    const other = saveSpill(sessionFolder(root, "other"), "kept");
    for (let i = 0; i < 25; i += 1) saveSpill(sessionFolder(root, "busy"), `text ${i}`);
    expect(await readdir(sessionFolder(root, "busy"))).toHaveLength(20);
    expect(await Bun.file(other!).text()).toBe("kept");
  });

  test("a session's folder whose newest file is more than a day old is removed when another session spills, and a younger one stays", async () => {
    const root = await artifactsRoot();
    const old = new Date(Date.now() - DAY_MS - 60_000);
    const NAME = "browser-run-1700000000000-000001-deadbeef.txt";
    const make = async (session: string, file: string, at?: Date): Promise<string> => {
      await mkdir(sessionFolder(root, session), { recursive: true });
      const path = join(sessionFolder(root, session), file);
      await writeFile(path, session);
      if (at) await utimes(path, at, at);
      return path;
    };
    await make("stale", NAME, old);
    const recent = await make("recent", NAME);
    // Something the pack did not write stays, and keeps its folder, however old.
    const foreign = await make("foreign", "notes.txt", old);

    saveSpill(sessionFolder(root, "now"), "trigger");
    const left = await readdir(root);
    expect(left).not.toContain(sessionFolder(root, "stale").slice(root.length + 1));
    expect(left).toContain(sessionFolder(root, "recent").slice(root.length + 1));
    expect(left).toContain(sessionFolder(root, "foreign").slice(root.length + 1));
    expect(await Bun.file(recent).text()).toBe("recent");
    expect(await Bun.file(foreign).text()).toBe("foreign");
  });
});

describe("the disk the model's spills may take", () => {
  // Bounds small enough to cross with a few KiB; the shipped ones are 20 files and 128 MiB a session, 1 GiB in all.
  const KIB = 1024;
  const SMALL: SpillBounds = { ...SPILL_BOUNDS, sessionBytes: 40 * KIB, rootBytes: 100 * KIB };
  /** A spill file as the pack names them, `n` its place in time (older first), `kib` its size. Returns its path. */
  async function put(root: string, session: string, n: number, kib: number): Promise<string> {
    const folder = sessionFolder(root, session);
    await mkdir(folder, { recursive: true });
    const path = join(folder, `browser-run-${String(1_700_000_000_000 + n).padStart(13, "0")}-${String(n).padStart(6, "0")}-deadbeef.txt`);
    await writeFile(path, "x".repeat(kib * KIB));
    return path;
  }
  const exists = async (path: string): Promise<boolean> => Bun.file(path).exists();

  test("a session's folder holds at most its byte bound, the oldest files going first; the file being written counts whole", async () => {
    const root = await artifactsRoot();
    const files: string[] = [];
    for (let n = 1; n <= 6; n += 1) files.push(await put(root, "busy", n, 10));
    // The new file may grow to 4 KiB, so 36 of the 40 KiB are for the others: the newest three (30 KiB).
    const fresh = saveSpill(sessionFolder(root, "busy"), "y".repeat(4 * KIB), SMALL)!;
    expect(await Promise.all(files.map(exists))).toEqual([false, false, false, true, true, true]);
    expect(await exists(fresh)).toBe(true);
  });

  test("the artifacts root holds at most its bound across sessions: the oldest files of any session go first, and a session left empty loses its folder", async () => {
    const root = await artifactsRoot();
    const sessions = ["s1", "s2", "s3", "s4", "s5"];
    const files: string[] = [];
    for (const [index, session] of sessions.entries()) for (let n = 1; n <= 3; n += 1) files.push(await put(root, session, index * 3 + n, 10));
    // 150 KiB are there; the new file may take 4 KiB, so 96 KiB may stay: the nine newest files (90 KiB), and s1 and s2 are gone whole.
    const fresh = saveSpill(sessionFolder(root, "newcomer"), "y".repeat(4 * KIB), SMALL)!;
    expect(await Promise.all(files.map(exists))).toEqual([false, false, false, false, false, false, true, true, true, true, true, true, true, true, true]);
    expect(await exists(fresh)).toBe(true);
    const left = await readdir(root);
    expect(left).not.toContain(sessionFolder(root, "s1").slice(root.length + 1));
    expect(left).not.toContain(sessionFolder(root, "s2").slice(root.length + 1));
    expect(left).toContain(sessionFolder(root, "s3").slice(root.length + 1));
  });

  test("the file being written is never the one removed, however small the bounds", async () => {
    const root = await artifactsRoot();
    const older = await put(root, "a", 1, 10);
    const file = SpillFile.open(sessionFolder(root, "b"), 200 * KIB, { ...SMALL, rootBytes: 10 * KIB, sessionBytes: 10 * KIB });
    expect(file).toBeDefined();
    expect(await exists(older)).toBe(false);
    expect(await exists(file!.path)).toBe(true);
    file!.close();
  });

  test("a session that ends takes its spill files with it, and nothing of any other session or that the pack did not write", async () => {
    const root = await artifactsRoot();
    const mine = await put(root, "ending", 1, 1);
    const other = await put(root, "other", 2, 1);
    discardSessionSpills(root, "ending");
    expect(await exists(mine)).toBe(false);
    expect(await readdir(root)).toEqual([sessionFolder(root, "other").slice(root.length + 1)]);
    expect(await exists(other)).toBe(true);

    // A folder with something else in it keeps that, and its folder.
    const shared = await put(root, "shared", 3, 1);
    const foreign = join(sessionFolder(root, "shared"), "notes.txt");
    await writeFile(foreign, "mine");
    discardSessionSpills(root, "shared");
    expect(await exists(shared)).toBe(false);
    expect(await Bun.file(foreign).text()).toBe("mine");
    // A session that never spilled has nothing to discard, and that is not an error.
    expect(() => discardSessionSpills(root, "never-spilled")).not.toThrow();
  });

  test("a sweep at start applies the bounds and the age limit with no spill to trigger it", async () => {
    const root = await artifactsRoot();
    const old = new Date(Date.now() - DAY_MS - 60_000);
    const stale = await put(root, "stale", 1, 1);
    await utimes(stale, old, old);
    const files: string[] = [];
    for (let n = 2; n <= 13; n += 1) files.push(await put(root, `s${n}`, n, 10));
    sweepSpills(root, SMALL);
    expect(await exists(stale)).toBe(false);
    // 120 KiB of files against a 100 KiB bound: the two oldest (20 KiB) go.
    expect(await Promise.all(files.map(exists))).toEqual([false, false, ...Array(10).fill(true)]);
  });
});
