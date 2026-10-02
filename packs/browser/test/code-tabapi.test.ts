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

  /** Real timeouts are what these tests are about: each one waits the very deadline OMP's helper has, so the budget is the smallest that still tells the ceilings apart. */
  describe("a helper fails fast and says why (D7, D8, D9)", () => {
    test("a selector that matches nothing fails after two seconds, not at the action ceiling", async () => {
      const started = Date.now();
      const error = await failure('await tab.click("#nope")');
      expect(error.message).toBe(
        'tab.click("#nope") failed fast after 2000ms; selector currently matches no elements — run tab.observe() or tab.ariaSnapshot() to inspect the page',
      );
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(1_900);
      expect(elapsed).toBeLessThan(5_000);
    }, 15_000);

    test("an explicit wait timeout opts out of the fast fail and times out under its own name", async () => {
      const started = Date.now();
      const error = await failure('await tab.waitForSelector("#nope", { timeout: 3000 })');
      expect(error.message).toBe(
        'tab.waitForSelector("#nope") timed out after 3000ms; selector currently matches no elements — run tab.observe() or tab.ariaSnapshot() to inspect the page',
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    }, 15_000);

    test("an element that exists but never becomes visible waits out the action ceiling, which a short cell budget pulls in", async () => {
      const started = Date.now();
      const error = await failure('await tab.waitForSelector("#hidden-btn", { visible: true })', { timeoutMs: 4_000 });
      expect(error.message).toBe(
        'tab.waitForSelector("#hidden-btn") timed out after 3000ms; selector currently matches 1 element(s) but the action never became possible — the element may be hidden or covered (try tab.scrollIntoView() or a more specific selector)',
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    }, 15_000);

    test("a default cell lets that same wait run for eight seconds", async () => {
      const started = Date.now();
      const error = await failure('await tab.waitForSelector("#hidden-btn", { visible: true })');
      expect(error.message).toStartWith('tab.waitForSelector("#hidden-btn") timed out after 8000ms; selector currently matches 1 element(s)');
      expect(Date.now() - started).toBeGreaterThanOrEqual(7_900);
    }, 20_000);

    test("a cell stuck where no helper has a deadline ends at its own budget naming what it stalled on", async () => {
      const error = await failure("await tab.evaluate(() => new Promise(() => {}))", { timeoutMs: 2_000 });
      expect(error.message).toMatch(/^Browser code execution timed out after 2000ms \(stalled on tab\.evaluate\(\) \(2\.\ds\)\)$/);
    }, 15_000);

    test("a navigation that outlasts the budget is stopped and reported with the way out", async () => {
      const error = await failure("await tab.goto(" + JSON.stringify(fixture.url("/slow?ms=8000")) + ")", { timeoutMs: 2_000 });
      expect(error.message).toBe(
        "tab.goto(" + JSON.stringify(fixture.url("/slow?ms=8000")) + ") timed out after 1000ms; pending navigation stopped — retry with a longer tool timeout or waitUntil:\"domcontentloaded\"",
      );
      expect(await value("tab.url()")).not.toBe(fixture.url("/slow?ms=8000"));
      await run("await tab.goto(" + JSON.stringify(fixture.url("/form")) + ")");
    }, 20_000);
  });

  describe("selectors (D23)", () => {
    test("a Playwright-only pseudo-class is refused with OMP's text, and text/ and aria/ work", async () => {
      const error = await failure('await tab.click(":has-text(Submit)")');
      expect(error.message).toBe(
        'Playwright-only selector ":has-text(Submit)" is not supported by the browser tool. Use a puppeteer text selector ("text/Allow all"), an aria selector ("aria/Name"), CSS, or "xpath/...".',
      );
      await run('await tab.fill("#name", "typed"); await tab.click("text/Submit")');
      expect(await value("await tab.evaluate(() => document.getElementById('out').textContent)")).toBe("submitted:typed");
      await run('await tab.click("aria/Submit")');
      expect(await value("await tab.evaluate(() => document.getElementById('out').textContent)")).toBe("submitted:typed");
    }, 20_000);

    test("a legacy p- prefix is read as the handler it names, and a non-string selector is explained", async () => {
      await run('await tab.click("p-text/Submit")');
      const error = await failure("await tab.click(5)");
      expect(error.message).toStartWith("Browser selector must be a string; got a number.");
    }, 20_000);
  });

  /** The text of the fixture's `#out` line: what a click or a submit left on the page. */
  const out = (): Promise<unknown> => value("await tab.evaluate(() => document.getElementById('out').textContent)");
  const goto = (path: string): Promise<RunResult> => run(`await tab.goto(${JSON.stringify(fixture.url(path))})`);
  interface Observed {
    elements: Array<{ id: number; role: string; name?: string; value?: string; states: string[] }>;
    viewport: { width: number; height: number };
    url: string;
    title: string;
  }
  const observe = async (): Promise<Observed> => (await value("await tab.observe()")) as Observed;

  describe("observe and the element cache (D10, D11)", () => {
    test("observe lists the page's interactive elements in document order, numbered from one, with role, name, value and state", async () => {
      await goto("/form");
      const seen = await observe();
      expect(seen.url).toBe(fixture.url("/form"));
      expect(seen.title).toBe("Fixture form");
      expect(seen.viewport).toMatchObject({ width: 1000, height: 700 });
      expect(seen.elements.map(e => e.id)).toEqual(seen.elements.map((_, index) => index + 1));
      expect(seen.elements.slice(0, 3)).toEqual([
        { id: 1, role: "textbox", name: "Name", states: [] },
        { id: 2, role: "checkbox", name: "I agree", states: ["checked=false"] },
        { id: 3, role: "combobox", name: "Colour", value: "Red", states: ["expanded=false"] },
      ]);
      expect(seen.elements.find(e => e.name === "Submit")).toMatchObject({ role: "button" });
      expect(seen.elements.find(e => e.name === "Go on")).toMatchObject({ role: "link" });
    }, 20_000);

    test("each observe renumbers from one, and an id clicks the element it was given for", async () => {
      await goto("/form");
      const first = await observe();
      const second = await observe();
      expect(second.elements.map(e => e.id)).toEqual(first.elements.map(e => e.id));
      const submit = second.elements.find(e => e.name === "Submit")!;
      await run(`await tab.fill("#name", "by id"); await (await tab.id(${submit.id})).click()`);
      expect(await out()).toBe("submitted:by id");
    }, 20_000);

    test("an id nobody observed is unknown, and goto drops every id", async () => {
      await goto("/form");
      const seen = await observe();
      const id = seen.elements[0]!.id;
      expect((await failure("await tab.id(99)")).message).toBe("Unknown element id 99. Run tab.observe() to refresh the element list.");
      await goto("/done");
      expect((await failure(`await tab.id(${id})`)).message).toBe(`Unknown element id ${id}. Run tab.observe() to refresh the element list.`);
    }, 20_000);

    test("an element that left the page is stale, by removal and by a navigation the page made itself", async () => {
      await goto("/form");
      const seen = await observe();
      const submit = seen.elements.find(e => e.name === "Submit")!;
      await run("await tab.evaluate(() => document.getElementById('submit').remove())");
      expect((await failure(`await tab.id(${submit.id})`)).message).toBe(`Element id ${submit.id} is stale. Run tab.observe() again.`);

      await goto("/form");
      const again = await observe();
      const link = again.elements.find(e => e.name === "Go on")!;
      const textbox = again.elements.find(e => e.role === "textbox")!;
      await run(`await (await tab.id(${link.id})).click()`);
      await run('await tab.waitForUrl("/done")');
      expect((await failure(`await tab.id(${textbox.id})`)).message).toBe(`Element id ${textbox.id} is stale. Run tab.observe() again.`);
    }, 30_000);

    test("viewportOnly leaves out what is below the fold", async () => {
      await goto("/long");
      const all = (await value("await tab.observe({ includeAll: true })")) as Observed;
      const inView = (await value("await tab.observe({ includeAll: true, viewportOnly: true })")) as Observed;
      expect(all.elements.some(e => e.name === "Bottom")).toBe(true);
      expect(inView.elements.some(e => e.name === "Bottom")).toBe(false);
    }, 20_000);
  });

  describe("ariaSnapshot (D12)", () => {
    test("the snapshot carries refs, a ref clicks its element, and refs renumber with each snapshot", async () => {
      await goto("/form");
      const snapshot = (await value("await tab.ariaSnapshot()")) as string;
      expect(snapshot).toContain("[ref=e1]");
      const line = snapshot.split("\n").find(l => l.includes('button "Submit"'))!;
      const ref = /\[ref=(e\d+)\]/.exec(line)![1]!;
      await run(`await tab.fill("#name", "via ref"); await (await tab.ref(${JSON.stringify(ref)})).click()`);
      expect(await out()).toBe("submitted:via ref");
      await run(`await tab.click("aria-ref=${ref}")`);
      const rescoped = (await value('await tab.ariaSnapshot("#covered")')) as string;
      expect(rescoped).toBe('- button "Covered" [ref=e1]');
    }, 20_000);

    test("a selector that matches nothing is named, and a ref the page no longer has is unknown", async () => {
      await goto("/form");
      expect((await failure('await tab.ariaSnapshot("#nope")')).message).toBe('tab.ariaSnapshot: selector "#nope" matched no element');
      await value("await tab.ariaSnapshot()");
      expect((await failure('await tab.ref("e999")')).message).toBe(
        'Unknown ARIA ref "e999". Run tab.ariaSnapshot() to refresh refs (they renumber each snapshot).',
      );
    }, 20_000);
  });

  describe("call chains and function runs (C14, B8)", () => {
    test("a bare handle hop is explained, and a handle hop with a method acts", async () => {
      await goto("/form");
      const bare = await realm.call({ name: "main", chain: [{ method: "id", args: [1] }], timeoutMs: 5_000, signal: new AbortController().signal }).catch((e: Error) => e);
      expect((bare as Error).message).toBe("tab.id() returns an element handle; call a method on it (tab.id(5).click()) or use tab.run(fn).");
      await observe();
      const seen = await observe();
      const submit = seen.elements.find(e => e.name === "Submit")!;
      await run('await tab.fill("#name", "chained")');
      const clicked = await realm.call({ name: "main", chain: [{ method: "id", args: [submit.id] }, { method: "click", args: [] }], timeoutMs: 5_000, signal: new AbortController().signal });
      expect(clicked.returnValue).toBeUndefined();
      expect(await out()).toBe("submitted:chained");
      const url = await realm.call({ name: "main", chain: [{ method: "url", args: [] }], timeoutMs: 5_000, signal: new AbortController().signal });
      expect(url.returnValue).toBe(fixture.url("/form"));
    }, 20_000);

    test("a wait in a chain answers whether the element was found", async () => {
      const signal = new AbortController().signal;
      const found = await realm.call({ name: "main", chain: [{ method: "waitForSelector", args: ["#submit"] }], timeoutMs: 5_000, signal });
      expect(found.returnValue).toBe(true);
    }, 20_000);

    test("a function run gets the scope and its arguments, a RegExp argument arrives as a RegExp", async () => {
      const result = await realm.run({
        name: "main",
        fn: "async ({ tab }, base, pattern) => ({ href: tab.url().startsWith(base), matches: pattern.test('abc'), isRegExp: pattern instanceof RegExp })",
        args: [fixture.url("/"), { __omp_re: { source: "^a", flags: "i" } }],
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      });
      expect(result.returnValue).toEqual({ href: true, matches: true, isRegExp: true });
    }, 20_000);

    test("a run with neither code nor fn, or with both, is refused", async () => {
      const signal = new AbortController().signal;
      const neither = await realm.run({ name: "main", timeoutMs: 5_000, signal }).catch((e: Error) => e);
      expect((neither as Error).message).toBe("Action 'run' requires exactly one of 'code' or 'fn'.");
      const both = await realm.run({ name: "main", code: "1", fn: "() => 1", timeoutMs: 5_000, signal }).catch((e: Error) => e);
      expect((both as Error).message).toBe("Action 'run' requires exactly one of 'code' or 'fn'.");
    });
  });
});

if (chromePath === undefined) test.skip("the tab realm needs a Chrome", () => {});
