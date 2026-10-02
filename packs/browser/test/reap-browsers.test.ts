/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the sweep that ends a stuck cell's child processes when the server has to end (reap.ts) takes a Chrome it must not. A saved profile's Chrome is closed by its owner (a hard
 * kill could cut a write to its logins), a throwaway's by `killThrowaways`; both are children of the server and both are launched by the pack's engine, which registers them in `ownedPids` for as long as they run. The
 * sweep itself is proven on stand-in processes in reap.test.ts; this holds it against the real browsers the runtime launches, with a child a cell left behind beside them as the one that does go.
 *
 * The test process is the "server" here (the sweep's parent), so it starts no other child than what it names, and it runs alone in its file.
 */
import { spawn } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { reapChildren } from "../src/reap";
import { waitUntilGone } from "./chrome-processes";
import { BROWSER_TEST_TIMEOUT_MS, createRuntime, describeWithChrome, perform, teardown } from "./fixture";

const VIEWPORT = { width: 640, height: 480 };
const NODE = Bun.which("node") ?? process.execPath;
const left: number[] = [];

afterEach(async () => {
  for (const pid of left.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await teardown();
});

describeWithChrome("the sweep and the browsers the runtime launched", () => {
  test.skipIf(process.platform !== "win32")("a saved profile's Chrome and a throwaway's are untouched by a sweep that ends the child a cell left, and still answer", async () => {
    const { runtime } = await createRuntime();
    const saved = await runtime.open({ profile: "sweep-saved", viewport: VIEWPORT });
    const throwaway = await runtime.open({ viewport: VIEWPORT });
    const stranded = spawn(NODE, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
    left.push(stranded.pid!);
    const ended = await reapChildren({ parentPid: process.pid, limitMs: 15_000 });
    // Only the cell's leftover went; the pack's own helper that ran the query is not counted, and no browser is among the pids.
    expect(ended).toEqual([stranded.pid!]);
    expect(await waitUntilGone([stranded.pid!], 10_000)).toEqual([]);
    // A browser the sweep had killed cannot reload a page.
    for (const browserId of [saved.browserId, throwaway.browserId]) await perform(runtime, browserId, { kind: "reload" });
  }, BROWSER_TEST_TIMEOUT_MS);
});
