/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: on a runtime that cannot read a worker thread's own memory (Node 22.12 to 22.15, Bun), the figure the watchdog compares with its limit is the whole process's. On Windows
 * that must be the COMMIT charge, because a runaway `Buffer.alloc` loop commits memory that is never resident; where the helper that reads it cannot start (no PowerShell) the resident set is used, and that is a
 * stated limit: untouched Buffers are invisible to it. `bun test` is such a runtime, which is why this file can hold the real spawner to both.
 */
import { describe, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { CommitProbe } from "../src/code/host/commit-probe";
import { defaultWorkerEntry, threadWorkerSpawner } from "../src/code/host/transport";

const MB = 1024 * 1024;
const cannotSayWorkerMemory = typeof Worker.prototype.getHeapStatistics !== "function";
const describeHere = process.platform === "win32" && cannotSayWorkerMemory ? describe : describe.skip;

describeHere("where a worker's own memory cannot be read, on Windows", () => {
  test("with the helper up, the figure is the commit charge: 300 MB of Buffer.alloc that nothing touched is counted", async () => {
    const probe = new CommitProbe();
    const handle = threadWorkerSpawner(defaultWorkerEntry(), { maxOldGenerationSizeMb: 256 }, probe)({ env: {} });
    try {
      await handle.warm?.();
      const before = await handle.memory();
      // Two of them, kept: the test process's allocator may serve the first from memory an earlier test gave back, and a buffer served from that commits nothing new.
      const kept = [Buffer.alloc(300 * MB), Buffer.alloc(300 * MB)]; // calloc: committed, not resident
      const after = await handle.memory();
      expect(before).toMatchObject({ own: false, basis: "commit" });
      expect(after).toMatchObject({ own: false, basis: "commit" });
      expect(after!.mb - before!.mb).toBeGreaterThan(250);
      expect(kept).toHaveLength(2);
    } finally {
      await handle.terminate(5_000);
      probe.close();
    }
  }, 60_000);

  test("with no helper (no shell to run it), the figure is the resident set and says so, and nothing waits for the helper", async () => {
    const probe = new CommitProbe({ shell: "no-such-shell-for-the-commit-probe" });
    const handle = threadWorkerSpawner(defaultWorkerEntry(), { maxOldGenerationSizeMb: 256 }, probe)({ env: {} });
    try {
      const began = performance.now();
      await handle.warm?.();
      expect(performance.now() - began).toBeLessThan(5_000);
      expect(await handle.memory()).toMatchObject({ own: false, basis: "resident" });
    } finally {
      await handle.terminate(5_000);
      probe.close();
    }
  }, 60_000);
});
