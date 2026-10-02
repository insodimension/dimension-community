/**
 * The tab realm on a real Chrome: pages the test's own Chrome opened (the engine's role) are adopted by targetId and driven through OMP's helpers.
 * Every expectation is something the model reads back: a returned value, a printed line, or the exact text of an error. The strings are OMP's
 * (tab-worker.ts); the timings are OMP's (2 s zero-match fail-fast, 8 s action ceiling, 20 s quick ceiling, the cell budget less one second).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "puppeteer-core";
import { createCodeEvaluator } from "../src/code/cell/evaluator";
import type { RunResult, TabRealm } from "../src/code/contracts";
import { createTabRealm } from "../src/code/worker/tab-realm";
import { resolveOpTimeouts, resolveWaitTimeout } from "../src/code/worker/tab-ops";
import { chromePath, type Fixture, type LaunchedChrome, launchChrome, startFixture } from "./code-tab-fixture";
import { describeWithChrome } from "./fixture";

const textOf = (result: RunResult): string => result.displays.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");

describe("the per-operation ceilings follow the cell budget", () => {
  test("a default cell keeps OMP's 20 s and 8 s, and a short cell pulls both under its own budget less one second", () => {
    expect(resolveOpTimeouts(30_000)).toEqual({ budgetBound: 29_000, quickOpMs: 20_000, actionOpMs: 8_000 });
    expect(resolveOpTimeouts(3_000)).toEqual({ budgetBound: 2_000, quickOpMs: 2_000, actionOpMs: 2_000 });
    expect(resolveOpTimeouts(500).budgetBound).toBe(1);
  });

  test("a wait takes the action ceiling by default, an explicit timeout clamped to the budget, zero and Infinity as the longest bounded wait, garbage as the default", () => {
    expect(resolveWaitTimeout(30_000)).toBe(8_000);
    expect(resolveWaitTimeout(30_000, 1_500)).toBe(1_500);
    expect(resolveWaitTimeout(30_000, 120_000)).toBe(29_000);
    expect(resolveWaitTimeout(30_000, 0)).toBe(29_000);
    expect(resolveWaitTimeout(30_000, Number.POSITIVE_INFINITY)).toBe(29_000);
    expect(resolveWaitTimeout(30_000, -5)).toBe(8_000);
    expect(resolveWaitTimeout(30_000, Number.NaN)).toBe(8_000);
  });
});

describeWithChrome("the tab realm drives a page it adopted", () => {
  let chrome: LaunchedChrome;
  let fixture: Fixture;
  let realm: TabRealm;
  /** The engine-side puppeteer page behind each adopted name: the test's way to observe and release a page the realm is driving. */
  const enginePages = new Map<string, Page>();

  const run = (code: string, o: { name?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> =>
    realm.run({ name: o.name ?? "main", code, timeoutMs: o.timeoutMs ?? 10_000, signal: o.signal ?? new AbortController().signal });
  /** What the code returned: OMP hands the final expression back as the run's value (the cell prints it), not as output. */
  const value = async (code: string, o: Parameters<typeof run>[1] = {}): Promise<unknown> => (await run(code, o)).returnValue;
  async function failure(code: string, o: Parameters<typeof run>[1] = {}): Promise<Error> {
    try {
      await run(code, o);
    } catch (error) {
      if (error instanceof Error) return error;
      throw error;
    }
    throw new Error("the run was expected to fail");
  }
  /** Open a fresh page the way the engine does and adopt it under `name`. */
  async function openTab(name: string, path = "/form"): Promise<Page> {
    const { page, handle } = await chrome.openTab(fixture.url(path));
    await realm.adopt(name, handle);
    enginePages.set(name, page);
    return page;
  }

  beforeAll(async () => {
    fixture = await startFixture();
    chrome = await launchChrome();
    realm = createTabRealm({ evaluator: createCodeEvaluator });
    await openTab("main");
  }, 60_000);

  afterAll(async () => {
    await realm?.dispose();
    await chrome?.close();
    await fixture?.stop();
  }, 30_000);

  describe("adoption (D5)", () => {
    test("a page the engine opened is driven by name and reports its own address", async () => {
      expect(await value("tab.url()")).toBe(fixture.url("/form"));
      expect(realm.names()).toEqual(["main"]);
    });

    test("a name nobody adopted is not alive, in OMP's words", async () => {
      expect((await failure("1", { name: "ghost" })).message).toBe('Tab "ghost" is not alive. Open it first with action:"open".');
    });

    test("a page opened after the realm connected is found by the event, not only by the first scan", async () => {
      await openTab("late", "/done");
      expect(await value("tab.url()", { name: "late" })).toBe(fixture.url("/done"));
      expect(await value("await tab.title()", { name: "late" })).toBe("Done page");
    });

    test("releasing a name forgets the page but never closes it", async () => {
      await realm.release("late");
      expect(realm.names()).toEqual(["main"]);
      expect((await failure("1", { name: "late" })).message).toContain("is not alive");
      const open = await chrome.browser.pages();
      expect(open.some(page => page.url() === fixture.url("/done"))).toBe(true);
    });

    test("a browser that ends rejects the run waiting on it with the tab named as closed", async () => {
      const engine = await openTab("doomed");
      const pending = failure('await tab.evaluate(() => { window.started = true; }); await tab.waitForSelector("#never", { timeout: 20000 })', { name: "doomed", timeoutMs: 25_000 });
      await engine.waitForFunction("window.started === true");
      await realm.end("b1");
      expect((await pending).message).toBe('Tab "doomed" was closed');
      expect(realm.names()).toEqual([]);
      await openTab("main");
    });

    test("a second run on a busy tab is refused by name, the first one finishes untouched", async () => {
      const engine = enginePages.get("main")!;
      const first = run("await tab.evaluate(() => new Promise(resolve => { window.release = resolve; window.running = true; })); 'first done'");
      await engine.waitForFunction("window.running === true");
      expect((await failure("1")).message).toBe('Tab "main" is busy');
      await engine.evaluate("window.release()");
      expect((await first).returnValue).toBe("first done");
    });
  });
});

if (chromePath === undefined) test.skip("the tab realm needs a Chrome", () => {});
