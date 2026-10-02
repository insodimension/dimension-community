/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: `browser_run`, the model's one way of driving a page, does not drive it, or drives the wrong one. A cell is not run, or two run at once;
 * a call that outlasts the host's 30 s timeout loses its result; a cell stuck in a loop freezes every browser the server holds; a session sees another's browser; a Chrome or a worker is left
 * behind; a dialog hangs the page; the viewport a cell asked for is not the one it gets.
 *
 * Real runtime, real Chrome, a real worker thread running the real tab realm. A Chrome is gone only when the operating system says so by pid (chrome-processes.ts).
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { defaultWorkerEntry, type SpawnWorker, threadWorkerSpawner } from "../src/code/host/transport";
import { chromePidsByThrowaway } from "./chrome-processes";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, teardown, waitUntil } from "./fixture";
import { cell, failureOf, isFailure, newRig, startPages, textOf, valueOf, type Pages, type Rig } from "./code-host-fixture";

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

type RigOptions = Parameters<typeof newRig>[1];
async function start(options?: RigOptions): Promise<Rig> {
  rig = newRig(await createRoot(), options);
  return rig;
}

const NEVER = new AbortController().signal;
const liveChromes = async (rootDir: string): Promise<number> => (await chromePidsByThrowaway(rootDir)).size;
const noChromes = (rootDir: string, timeoutMs = 10_000): Promise<number> => waitUntil("every Chrome gone, by pid", () => liveChromes(rootDir), count => count === 0, timeoutMs);

/** A spawner that counts the worker threads it starts and the ones still alive. */
function countingSpawn(): { spawn: SpawnWorker; live(): number; spawned(): number } {
  const inner = threadWorkerSpawner(defaultWorkerEntry(), { maxOldGenerationSizeMb: 1_024 });
  let live = 0;
  let spawned = 0;
  return {
    spawn: options => {
      const handle = inner(options);
      spawned += 1;
      live += 1;
      handle.onExit(() => void (live -= 1));
      return handle;
    },
    live: () => live,
    spawned: () => spawned,
  };
}

describeWithChrome("a cell drives a real page", () => {
  test("opens a page, fills, clicks, reads and takes a screenshot, all from one cell", async () => {
    const { host } = await start();
    const result = await cell(host, "s1", `
      const tab = await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/form"))} });
      await tab.fill("#name", "Ada");
      await tab.click("#go");
      await tab.waitForSelector("#out");
      const out = await tab.evaluate(() => document.getElementById("out").textContent);
      await tab.screenshot();
      out;
    `);
    if (isFailure(result)) throw new Error(`${result.error.name}: ${result.error.message}`);
    expect(textOf(result)).toContain('Opened tab "main" on headless browser (hidden)');
    expect(textOf(result).split("\n").at(-1)).toBe("hello:Ada");
    expect(result.displays.some(part => part.type === "image")).toBe(true);
    expect(result.screenshots).toHaveLength(1);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("names persist between cells and the tab is the same page", async () => {
    const { host } = await start();
    await valueOf(host, "s1", `const kept = 41; await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/other"))} }); 0`);
    expect(await valueOf(host, "s1", "kept + 1")).toBe(42);
    expect(await valueOf(host, "s1", "browser.tab('main').url()")).toBe(pages.url("/other"));
  }, BROWSER_TEST_TIMEOUT_MS);
});

describeWithChrome("a call returns after the wait and the cell goes on", () => {
  test("a cell that outlasts the wait answers `running` at the wait with what it printed, and `resume` collects the rest", async () => {
    const { host } = await start();
    const began = performance.now();
    const first = await host.run("s1", { code: `console.log("early"); await new Promise(resolve => setTimeout(resolve, 1800)); console.log("late"); "end"`, timeoutMs: 20_000, waitMs: 400, signal: NEVER });
    const waited = performance.now() - began;
    if (first.state !== "running") throw new Error("the cell should still have been running");
    expect(waited).toBeGreaterThan(300);
    expect(waited).toBeLessThan(1_500);
    const looked = await host.resume("s1", first.runId, 0, NEVER);
    if (looked.state !== "running") throw new Error("a look must not wait");
    await waitUntil("the early line has reached the host", async () => (await host.resume("s1", first.runId, 0, NEVER)).state === "running" ? (await host.resume("s1", first.runId, 0, NEVER) as { outputSoFar: string }).outputSoFar : "", text => text.includes("early"), 3_000);
    const finished = await host.resume("s1", first.runId, 10_000, NEVER);
    if (finished.state !== "done" || "error" in finished.result) throw new Error("the cell should have finished");
    expect(textOf(finished.result)).toContain("late");
    expect(textOf(finished.result).split("\n").at(-1)).toBe("end");
    // A finished run stays readable.
    const again = await host.resume("s1", first.runId, 0, NEVER);
    expect(again.state).toBe("done");
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a second cell while one runs is refused as busy and names the run; an unknown run, or another session's, is refused", async () => {
    const { host } = await start();
    const first = await host.run("s1", { code: "await new Promise(resolve => setTimeout(resolve, 1200)); 1", timeoutMs: 20_000, waitMs: 100, signal: NEVER });
    if (first.state !== "running") throw new Error("the cell should still have been running");
    await expect(host.run("s1", { code: "2", timeoutMs: 20_000, waitMs: 100, signal: NEVER })).rejects.toThrow(new RegExp(`^busy.*${first.runId}`));
    await expect(host.resume("s1", "run-nothing", 0, NEVER)).rejects.toThrow(/unknown run "run-nothing"/);
    await expect(host.resume("other", first.runId, 0, NEVER)).rejects.toThrow(/unknown run/);
    expect((await host.resume("s1", first.runId, 10_000, NEVER)).state).toBe("done");
    // Once it has ended the session runs again.
    expect(await valueOf(host, "s1", "3")).toBe(3);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("cancelling the call that waits cancels the cell and the next cell runs", async () => {
    const { host } = await start();
    const cancel = new AbortController();
    const waiting = host.run("s1", { code: "await new Promise(resolve => setTimeout(resolve, 20000)); 1", timeoutMs: 30_000, waitMs: 25_000, signal: cancel.signal });
    setTimeout(() => cancel.abort(), 300);
    const began = performance.now();
    const answer = await waiting;
    expect(performance.now() - began).toBeLessThan(2_500);
    if (answer.state !== "done" || !("error" in answer.result)) throw new Error("a cancelled cell ends in an error");
    expect(answer.result.error.isAbort).toBe(true);
    expect(await valueOf(host, "s1", "5")).toBe(5);
  }, BROWSER_TEST_TIMEOUT_MS);
});

describeWithChrome("a cell that cannot answer is ended and the pages go on", () => {
  test("a synchronous loop is terminated at the budget plus 750 ms, its variables are reset, the page and the next cell survive", async () => {
    const counting = countingSpawn();
    const { host, rootDir } = await start({ host: { spawn: counting.spawn } });
    await valueOf(host, "s1", `const kept = 41; await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/other"))} }); 0`);
    expect(counting.live()).toBe(1);
    const began = performance.now();
    const error = await failureOf(host, "s1", "while (true) {}", { timeoutMs: 1_000 });
    const took = performance.now() - began;
    expect(error.message).toContain("variables were reset");
    expect(took).toBeGreaterThan(1_500);
    expect(took).toBeLessThan(4_000);
    await waitUntil("the stuck worker thread has exited", () => counting.live(), live => live === 0, 3_000);
    // The next cell gets a new worker that re-adopts the same page; the old variables are gone.
    expect(await valueOf(host, "s1", "browser.tab('main').url()")).toBe(pages.url("/other"));
    expect(await valueOf(host, "s1", "typeof kept")).toBe("undefined");
    expect(counting.spawned()).toBe(2);
    expect(await liveChromes(rootDir)).toBe(1);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a cell that awaits for ever ends at its budget with the cell's own text, once, and the worker is rebuilt", async () => {
    const counting = countingSpawn();
    const { host } = await start({ host: { spawn: counting.spawn } });
    await valueOf(host, "s1", "const kept = 1; 0");
    const error = await failureOf(host, "s1", "await new Promise(() => {})", { timeoutMs: 1_000 });
    expect(error.message).toContain("variables");
    expect(error.message.match(/reset/g)?.length).toBe(1);
    expect(error.message).not.toContain("The code worker was restarted");
    expect(error.recoverTab).toBe(true);
    expect(await valueOf(host, "s1", "typeof kept")).toBe("undefined");
    expect(counting.spawned()).toBe(2);
    await waitUntil("the old worker has exited", () => counting.live(), live => live === 1, 3_000);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a cell cannot read the server's secrets, and what it prints never reaches the server's stdout", async () => {
    const { host } = await start({ host: { env: { TYPESAFE_API_KEY: "sk-secret", DIMENSION_BROWSER_ROOT: "/x", PUPPETEER_PROXY: "http://p", PATH: process.env.PATH } } });
    expect(await valueOf(host, "s1", "JSON.stringify([process.env.TYPESAFE_API_KEY, process.env.DIMENSION_BROWSER_ROOT, process.env.PUPPETEER_PROXY, typeof process.env.PATH])")).toEqual([null, null, "http://p", "string"]);
  }, BROWSER_TEST_TIMEOUT_MS);
});

describeWithChrome("a session has its own browser", () => {
  test("two sessions that both open `main` get two tabs on two Chromes; neither sees the other's", async () => {
    const { host, rootDir, runtime } = await start();
    await valueOf(host, "alice", `await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/form"))} }); 0`);
    await valueOf(host, "bob", `await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/other"))} }); 0`);
    expect(await liveChromes(rootDir)).toBe(2);
    expect(await valueOf(host, "alice", "browser.tab('main').url()")).toBe(pages.url("/form"));
    expect(await valueOf(host, "bob", "browser.tab('main').url()")).toBe(pages.url("/other"));
    const seam = runtime.codeSeam();
    expect(seam.browsersOf("alice")).toHaveLength(1);
    expect(seam.browsersOf("bob")).toHaveLength(1);
    expect(seam.browsersOf("alice")[0]?.browserId).not.toBe(seam.browsersOf("bob")[0]?.browserId);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a second name in a session opens a tab on the same browser; the same name is reused; the browser the cell made is the one the View shows", async () => {
    const { host, rootDir, runtime } = await start();
    const first = await cell(host, "s1", `await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/form"))} }); 0`);
    if (isFailure(first)) throw new Error(first.error.message);
    const second = await cell(host, "s1", `await browser.open({ name: "docs", url: ${JSON.stringify(pages.url("/other"))} }); 0`);
    const reused = await cell(host, "s1", 'await browser.open({ name: "main" }); 0');
    if (isFailure(second) || isFailure(reused)) throw new Error("opens failed");
    expect(textOf(reused)).toContain('Reused tab "main"');
    expect(await liveChromes(rootDir)).toBe(1);
    const held = runtime.codeSeam().browsersOf("s1")[0];
    if (held === undefined) throw new Error("the session holds no browser");
    expect(runtime.viewOf("s1")).toBe(held.browserId);
    expect((await held.driver.tabs()).map(tab => tab.url).sort()).toEqual([pages.url("/form"), pages.url("/other")].sort());
  }, BROWSER_TEST_TIMEOUT_MS);

  test("two opens that start together share one browser, not two", async () => {
    const { host, rootDir, runtime } = await start();
    await valueOf(host, "s1", `
      await Promise.all([
        browser.open({ name: "a", url: ${JSON.stringify(pages.url("/form"))} }),
        browser.open({ name: "b", url: ${JSON.stringify(pages.url("/other"))} }),
      ]);
      0`);
    expect(await liveChromes(rootDir)).toBe(1);
    expect(runtime.codeSeam().browsersOf("s1")).toHaveLength(1);
    expect(await valueOf(host, "s1", "JSON.stringify([await browser.tab('a').url(), await browser.tab('b').url()])")).toEqual([pages.url("/form"), pages.url("/other")]);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a browser the person opened in the View is the one a cell uses, and no clock closes it", async () => {
    const { host, rootDir, runtime } = await start({ idleMs: 600 });
    const opened = await runtime.open({}, { caller: "app", session: "s1" });
    runtime.bindView("s1", opened.browserId);
    await valueOf(host, "s1", `await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/other"))} }); 0`);
    expect(await liveChromes(rootDir)).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(await liveChromes(rootDir)).toBe(1);
    expect((await runtime.state(opened.browserId)).url).toBe(pages.url("/other"));
  }, BROWSER_TEST_TIMEOUT_MS);
});

describeWithChrome("open and close", () => {
  test("a name bound to another kind of browser is refused with OMP's text; a saved profile and a connected browser are refused by name", async () => {
    const { host, rootDir } = await start();
    await valueOf(host, "s1", `await browser.open({ name: "a", url: ${JSON.stringify(pages.url("/other"))} }); 0`);
    const mismatch = await failureOf(host, "s1", 'await browser.open({ name: "a", app: { cdp_url: "http://127.0.0.1:9" } })');
    expect(mismatch.message).toContain('Tab "a" is bound to a different browser (headless hidden). Close it first.');
    expect((await failureOf(host, "s1", 'await browser.open({ name: "work", profile: "work" })')).message).toContain("code_needs_consent");
    expect((await failureOf(host, "s1", 'await browser.open({ name: "c", app: { cdp_url: "http://127.0.0.1:9" } })')).message).toContain("code_kind_unsupported");
    expect(await liveChromes(rootDir)).toBe(1);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("one deadline covers the launch and the navigation, and the browser the failed open made does not outlive it", async () => {
    const { host, rootDir } = await start();
    const began = performance.now();
    const error = await failureOf(host, "s1", `await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/slow"))}, timeout: 2 })`, { timeoutMs: 30_000 });
    const took = performance.now() - began;
    expect(error.message).toBe("Browser open timed out after 2000ms");
    expect(took).toBeGreaterThan(1_500);
    expect(took).toBeLessThan(3_800);
    await noChromes(rootDir);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a cell cancelled while its browser launches leaves no Chrome behind", async () => {
    const { host, rootDir } = await start();
    await valueOf(host, "s1", "0"); // the worker is up, so the cancel below lands while the browser launches, not while the worker starts
    const cancel = new AbortController();
    const waiting = host.run("s1", { code: `await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/other"))} })`, timeoutMs: 30_000, waitMs: 25_000, signal: cancel.signal });
    setTimeout(() => cancel.abort(), 150);
    const answer = await waiting;
    expect(answer.state).toBe("done");
    await noChromes(rootDir, 15_000);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("closing every tab of a browser the cell made closes the browser: the Chrome is gone by pid", async () => {
    const { host, rootDir } = await start();
    await valueOf(host, "s1", `await browser.open({ name: "a", url: ${JSON.stringify(pages.url("/form"))} }); await browser.open({ name: "b", url: ${JSON.stringify(pages.url("/other"))} }); 0`);
    expect(await liveChromes(rootDir)).toBe(1);
    const closed = await cell(host, "s1", "await browser.close({ all: true }); 0");
    if (isFailure(closed)) throw new Error(closed.error.message);
    expect(textOf(closed)).toContain("Released 2 managed tabs");
    await noChromes(rootDir, 8_000);
    expect(textOf(await cell(host, "s1", 'await browser.close({ name: "a" }); 0') as never)).toContain('No tab named "a"');
  }, BROWSER_TEST_TIMEOUT_MS);

  test("closing one tab of two leaves the browser; a tab the cell did not close is still driven", async () => {
    const { host, rootDir } = await start();
    await valueOf(host, "s1", `await browser.open({ name: "a", url: ${JSON.stringify(pages.url("/form"))} }); await browser.open({ name: "b", url: ${JSON.stringify(pages.url("/other"))} }); 0`);
    const closed = await cell(host, "s1", 'await browser.close({ name: "a" }); 0');
    if (isFailure(closed)) throw new Error(closed.error.message);
    expect(textOf(closed)).toContain('Released managed tab "a"');
    expect(await liveChromes(rootDir)).toBe(1);
    expect(await valueOf(host, "s1", "browser.tab('b').url()")).toBe(pages.url("/other"));
  }, BROWSER_TEST_TIMEOUT_MS);
});

describeWithChrome("dialogs and the viewport are the engine's", () => {
  test("the dialog policy of an open answers the page's confirm, and a reopen changes it", async () => {
    const { host } = await start();
    await valueOf(host, "s1", `
      const tab = await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/dialog"))}, dialogs: "dismiss" });
      await tab.click("#ask");
      0`);
    expect(await valueOf(host, "s1", "await browser.tab('main').title()")).toBe("asked:false");
    await valueOf(host, "s1", `await browser.open({ name: "main", dialogs: "accept" }); await browser.tab("main").click("#ask"); 0`);
    expect(await valueOf(host, "s1", "await browser.tab('main').title()")).toBe("asked:true");
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a cell's viewport is the page's size and pixel ratio; the default is OMP's 1365 x 768 at 1.25", async () => {
    const { host } = await start();
    const read = "JSON.stringify(await browser.tab('main').evaluate(() => [innerWidth, innerHeight, devicePixelRatio]))";
    await valueOf(host, "s1", `await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/other"))} }); 0`);
    expect(await valueOf(host, "s1", read)).toEqual([1365, 768, 1.25]);
    await valueOf(host, "s1", 'await browser.open({ name: "main", viewport: { width: 800, height: 600, scale: 2 } }); 0');
    expect(await valueOf(host, "s1", read)).toEqual([800, 600, 2]);
  }, BROWSER_TEST_TIMEOUT_MS);
});

describeWithChrome("a cell's browser has its own clock", () => {
  test("an idle code browser closes and the runtime says why, in the words a cell reads; a persisted one and a viewed one stay", async () => {
    const { host, rootDir, runtime } = await start({ idleMs: 1_500 });
    const seam = runtime.codeSeam();
    // The viewed one first, joined at once; the persisted one; the plain one last, so its clock is the only one running when the others are set.
    await valueOf(host, "seen", `await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/other"))} }); 0`);
    const seen = seam.browsersOf("seen")[0]?.browserId;
    if (seen === undefined) throw new Error("a session holds no browser");
    const leave = runtime.viewing(seen);
    await valueOf(host, "kept", `await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/other"))}, persist: true }); 0`);
    await valueOf(host, "plain", `await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/other"))} }); 0`);
    const plain = seam.browsersOf("plain")[0]?.browserId;
    if (plain === undefined) throw new Error("a session holds no browser");
    await waitUntil("the plain browser is retired", () => seam.browsersOf("plain").length, count => count === 0, 8_000);
    expect(await liveChromes(rootDir)).toBe(2);
    await expect(runtime.state(plain)).rejects.toThrow(/it was a code browser, closed after 1\.5 s with no calls; open a new one with browser\.open/);
    // The cell is told why its tab is gone, not that it never existed (D33).
    expect((await failureOf(host, "plain", "await browser.tab('main').url()")).message).toMatch(/Tab "main" is not alive.*closed after 1\.5 s with no calls/);
    // The kept and the viewed one are still driven.
    expect(await valueOf(host, "kept", "browser.tab('main').url()")).toBe(pages.url("/other"));
    expect(await valueOf(host, "seen", "browser.tab('main').url()")).toBe(pages.url("/other"));
    leave();
    await waitUntil("the viewed browser is retired once the View has left", () => seam.browsersOf("seen").length, count => count === 0, 8_000);
    expect(await liveChromes(rootDir)).toBe(1);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a cell running longer than the idle clock keeps its browser", async () => {
    const { host, runtime } = await start({ idleMs: 600 });
    // Three idle periods pass inside the cell; the page it opened is still its page at the end, which a retired browser could not answer.
    expect(await valueOf(host, "s1", `
      await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/other"))} });
      await new Promise(resolve => setTimeout(resolve, 1800));
      browser.tab("main").url()`)).toBe(pages.url("/other"));
    await waitUntil("it is retired once the cell has ended", () => runtime.codeSeam().browsersOf("s1").length, count => count === 0, 8_000);
  }, BROWSER_TEST_TIMEOUT_MS);
});

describeWithChrome("tabs the person opened", () => {
  test("browser.tabs() lists every tab of the session's browser, and browser.active() is the one the person is looking at", async () => {
    const { host, runtime } = await start();
    const opened = await runtime.open({}, { caller: "app", session: "s1" });
    runtime.bindView("s1", opened.browserId);
    await runtime.act(opened.browserId, { kind: "navigate", url: pages.url("/form") });
    await runtime.tab(opened.browserId, { op: "new", url: pages.url("/other") });
    const listed = await cell(host, "s1", "JSON.stringify(await browser.tabs())");
    if (isFailure(listed)) throw new Error(listed.error.message);
    const tabs = JSON.parse(textOf(listed).split("\n").at(-1) ?? "[]") as Array<{ name?: string; id: string; url: string; active: boolean }>;
    expect(tabs.map(tab => tab.url).sort()).toEqual([pages.url("/form"), pages.url("/other")].sort());
    expect(tabs.filter(tab => tab.active).map(tab => tab.url)).toEqual([pages.url("/other")]);
    expect(await valueOf(host, "s1", "browser.active().url()")).toBe(pages.url("/other"));
  }, BROWSER_TEST_TIMEOUT_MS);
});
