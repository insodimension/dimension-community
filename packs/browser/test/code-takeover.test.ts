/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a person takes a browser over in the View and the model's cell keeps clicking in it, or a later cell starts on it while the person has the wheel.
 * Real runtime, real Chrome, real worker thread; the person's act is `runtime.control(…, "take", "app")`, the call the View makes.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, teardown } from "./fixture";
import { cell, isFailure, newRig, startPages, textOf, valueOf, type Pages, type Rig } from "./code-host-fixture";

let pages: Pages;
let rig: Rig | undefined;

beforeAll(async () => {
  pages = await startPages();
});
afterAll(async () => {
  await pages.close();
});
afterEach(async () => {
  await rig?.host.dispose();
  rig = undefined;
  await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

const NEVER = new AbortController().signal;

describeWithChrome("the person takes the wheel", () => {
  test("the running cell is stopped with human_driving, a later cell is refused until the browser is handed back, and then it drives again", async () => {
    rig = newRig(await createRoot());
    const { host, runtime } = rig;
    await valueOf(host, "s1", `await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/other"))} }); 0`);
    const browserId = runtime.codeSeam().browsersOf("s1")[0]?.browserId;
    if (browserId === undefined) throw new Error("the session holds no browser");
    const first = await host.run("s1", { code: `await browser.tab("main").waitForSelector("#never", { timeout: 20000 })`, timeoutMs: 30_000, waitMs: 300, signal: NEVER });
    if (first.state !== "running") throw new Error("the cell should be waiting");
    const began = performance.now();
    await runtime.control(browserId, "take", "app");
    const stopped = await host.resume("s1", first.runId, 5_000, NEVER);
    if (stopped.state !== "done" || !("error" in stopped.result)) throw new Error("the cell should have been stopped");
    expect(stopped.result.error.message).toContain("human_driving");
    expect(stopped.result.error.isAbort).toBe(true);
    expect(performance.now() - began).toBeLessThan(3_000);
    // While the person has the wheel, the next browser_run fails human_driving (matrix J3).
    await expect(host.run("s1", { code: "0", timeoutMs: 5_000, waitMs: 5_000, signal: NEVER })).rejects.toThrow(/human_driving/);
    // Handed back, it is the cell's again; the tab the person left on is the page it opens.
    await runtime.control(browserId, "return", "app");
    const back = await cell(host, "s1", `await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/form"))} }); await browser.tab("main").url()`);
    if (isFailure(back)) throw new Error(back.error.message);
    expect(textOf(back).split("\n").at(-1)).toBe(pages.url("/form"));
  }, BROWSER_TEST_TIMEOUT_MS);
});
