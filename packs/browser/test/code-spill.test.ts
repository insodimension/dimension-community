/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the `[raw output: <path>]` footer is the model's only way back to the part of an output it was not shown. If
 *  one session's spills can remove another's files the path is gone before it is read; if nothing ever removes a session's folder the artifacts folder grows
 *  for as long as the pack is installed (the old rule, the newest 20 files of the whole folder, bounded it; per-session folders must keep that bound).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSpill, sessionFolder } from "../src/code/spill.js";

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
