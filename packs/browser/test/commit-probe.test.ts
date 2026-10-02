/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: on Windows, on a Node that cannot read a worker's own memory (22.12 to 22.15, Bun), a cell that fills `Buffer.alloc` in a loop grows the server's COMMIT without limit
 * while its resident set does not move (calloc'd pages are committed, not resident until touched), so the memory watchdog sees nothing and the machine runs out of commit. The probe reads the process's private bytes
 * (what the OS charges against commit) through one long-lived helper, cheaply enough to ask every 100 ms while a cell runs.
 */
import { describe, expect, test } from "bun:test";
import { isAlive, waitUntilGone } from "./chrome-processes";
import { CommitProbe } from "../src/code/host/commit-probe";
import { waitUntil } from "./fixture";

const describeWindows = process.platform === "win32" ? describe : describe.skip;
// A process of its own to measure: the test process's allocator keeps memory it was given back (a second 300 MB buffer would be served from it, committing nothing new).
const NODE = Bun.which("node") ?? process.execPath;
const GROWS_ON_REQUEST = `process.stdin.once("data", () => { globalThis.kept = Buffer.alloc(300e6); process.stdout.write("allocated\\n"); }); setTimeout(() => {}, 60000);`;

describeWindows("the server's committed memory, read through one long-lived helper", () => {
  test("it sees 300 MB of Buffer.alloc that nothing ever touched (the resident set does not move), answers in well under a poll period, and the helper is gone after close", async () => {
    const child = Bun.spawn([NODE, "-e", GROWS_ON_REQUEST], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const probe = new CommitProbe({ pid: child.pid, idleMs: 60_000 });
    try {
      expect(await probe.ready(10_000)).toBe(true);
      const helper = probe.helperPid;
      expect(helper).toBeGreaterThan(0);
      const before = await probe.read();
      child.stdin.write("go\n");
      await child.stdin.flush();
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("allocated");
      const began = performance.now();
      const after = await probe.read();
      const askedMs = performance.now() - began;
      expect(before).toBeDefined();
      expect(after! - before!).toBeGreaterThan(250);
      expect(askedMs).toBeLessThan(500);
      probe.close();
      expect(await waitUntilGone([helper!], 10_000)).toEqual([]);
    } finally {
      probe.close();
      child.kill();
      await child.exited;
    }
  }, 60_000);

  test("a helper nobody has asked for in a while ends itself, and the next question starts a new one", async () => {
    const probe = new CommitProbe({ idleMs: 300 });
    try {
      expect(await probe.ready(10_000)).toBe(true);
      const first = probe.helperPid!;
      await waitUntil("the idle helper has ended", () => isAlive(first), alive => !alive, 10_000);
      expect(probe.helperPid).toBeUndefined();
      expect(await probe.ready(10_000)).toBe(true);
      expect(probe.helperPid).not.toBe(first);
      expect(await probe.read()).toBeGreaterThan(10);
    } finally {
      probe.close();
    }
  }, 60_000);

  test("without a shell to start, it says so and never throws: ready is false, read is undefined, no process is left", async () => {
    const probe = new CommitProbe({ shell: "no-such-shell-for-the-commit-probe" });
    expect(await probe.ready(5_000)).toBe(false);
    expect(await probe.read()).toBeUndefined();
    expect(probe.helperPid).toBeUndefined();
    probe.close();
  }, 30_000);
});
