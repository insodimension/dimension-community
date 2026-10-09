/**
 * The tab realm on a real Chrome: pages the test's own Chrome opened (the engine's role) are adopted by targetId and driven through OMP's helpers.
 * Every expectation is something the model reads back: a returned value, a printed line, or the exact text of an error. The strings are OMP's
 * (tab-worker.ts); the timings are OMP's (2 s zero-match fail-fast, 8 s action ceiling, 20 s quick ceiling, the cell budget less one second).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "puppeteer-core";
import { createCodeEvaluator } from "../src/code/cell/evaluator";
import type { RunResult, TabRealm } from "../src/code/contracts";
import { producesText } from "../src/code/worker/password-guard";
import { RunOutput } from "../src/code/worker/run-output";
import { createTabRealm } from "../src/code/worker/tab-realm";
import { readImageDimensions } from "../src/code/worker/image-size";
import { resolveScreenshotDir } from "../src/code/worker/screenshot";
import { resolveUploadPath, textClickLoopMs } from "../src/code/worker/tab-api";
import { OpRunner, type RunState, resolveOpTimeouts, resolveWaitTimeout } from "../src/code/worker/tab-ops";
import { chromePath, type Fixture, type LaunchedChrome, launchChrome, startFixture } from "./code-tab-fixture";
import { describeWithChrome } from "./fixture";

/** What globalThis held before any realm was made (module load, imports done): a global a run adds shows up against it, however early in the file the run was. */
const GLOBALS_AT_LOAD = Object.getOwnPropertyNames(globalThis);

/** The first printed line group of a run: a screenshot's caption. */
function captionOf(result: RunResult): string {
  const first = result.displays[0];
  if (first?.type !== "text") throw new Error("the run printed no caption");
  return first.text;
}

/** Answer a dialog nobody was going to: a page stuck behind one cannot be closed cleanly. */
async function dismissDialog(page: Page): Promise<void> {
  const session = await page.createCDPSession();
  await session.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined);
  await session.detach().catch(() => undefined);
}

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

describe("how long a text click keeps trying before the op's own ceiling ends it", () => {
  test("it stops 250 ms before the ceiling so the model reads the actionability reason, and a short ceiling still gets at least half of itself rather than one attempt", () => {
    expect(textClickLoopMs(8_000)).toBe(7_750);
    expect(textClickLoopMs(500)).toBe(250);
    expect(textClickLoopMs(400)).toBe(200);
    expect(textClickLoopMs(100)).toBe(50);
    expect(textClickLoopMs(1)).toBe(1);
  });
});

describe("which keys count as typing into a password field (D18)", () => {
  test("a character does, and so does a printable key by its code name; Enter, Tab, the arrows and the editing keys do not", () => {
    for (const typing of ["a", "Z", "7", " ", "é", "KeyA", "Digit1", "Numpad5", "NumpadDecimal", "Space", "Minus", "Slash"] as const) expect(producesText(typing)).toBe(true);
    for (const quiet of ["Enter", "NumpadEnter", "Tab", "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowDown", "Home", "End", "PageUp", "F5", "Shift", "Control"] as const) expect(producesText(quiet)).toBe(false);
  });
});

describe("the zero-match watchdog counts only what it is sure of", () => {
  // A page whose probe can be made to answer or to fail, the way a page in the middle of a navigation does; Chrome cannot be made to fail a probe on cue.
  function runOver(probe: () => Promise<unknown[]>): Promise<string> {
    const runner = new OpRunner(() => ({ $$: probe }) as unknown as Page);
    const ac = new AbortController();
    const state: RunState = {
      id: "1",
      ac,
      signal: ac.signal,
      output: new RunOutput(),
      screenshots: [],
      filename: "browser-run-1.js",
      rejectionOwner: {},
      floatingRejections: [],
      floatingFailure: Promise.withResolvers<never>(),
      inflight: new Map(),
      opCounter: 0,
    };
    const slowOp = async (): Promise<string> => {
      await Bun.sleep(900);
      return "finished";
    };
    return runner.runOp(state, 'tab.click("#x")', ac.signal, 8_000, slowOp, { selector: "#x", zeroMatchAfterMs: 300 });
  }

  test("a selector confirmed absent fails fast, naming the label", async () => {
    await expect(runOver(async () => [])).rejects.toThrow('tab.click("#x") failed fast after 300ms; selector currently matches no elements');
  });

  test("a probe that fails (a page mid-navigation) never counts toward the window, so the operation is left to finish", async () => {
    const failing = async (): Promise<unknown[]> => {
      throw new Error("Execution context was destroyed, most likely because of a navigation");
    };
    expect(await runOver(failing)).toBe("finished");
  });
});

describeWithChrome("the tab realm drives a page it adopted", () => {
  let chrome: LaunchedChrome;
  let fixture: Fixture;
  let realm: TabRealm;
  /** The engine-side puppeteer page behind each adopted name: the test's way to observe and release a page the realm is driving. */
  const enginePages = new Map<string, Page>();
  const chromePage = (name: string): Page => enginePages.get(name)!;

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

    test("a browser that ended for a stated reason carries it into the failure and into the next call on that tab", async () => {
      const engine = await openTab("retired");
      const pending = failure('await tab.evaluate(() => { window.started = true; }); await tab.waitForSelector("#never", { timeout: 20000 })', { name: "retired", timeoutMs: 25_000 });
      await engine.waitForFunction("window.started === true");
      await realm.end("b1", "idle for 30 minutes");
      expect((await pending).message).toBe('Tab "retired" was closed: idle for 30 minutes');
      expect((await failure("1", { name: "retired" })).message).toBe('Tab "retired" is not alive. Open it first with action:"open". Its browser ended (idle for 30 minutes).');
      await openTab("retired");
      expect(await value("tab.url()", { name: "retired" })).toBe(fixture.url("/form"));
      await realm.release("retired");
      await openTab("main");
    }, 20_000);

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

    test("once the selector has matched the fast fail is off for good, even if the element later goes away", async () => {
      const started = Date.now();
      const error = await failure(
        `await tab.evaluate(() => { const b = document.createElement("button"); b.id = "flick"; b.style.display = "none"; document.body.append(b); setTimeout(() => b.remove(), 600); });
         await tab.waitForSelector("#flick", { visible: true })`,
        { timeoutMs: 4_000 },
      );
      expect(error.message).toBe(
        'tab.waitForSelector("#flick") timed out after 3000ms; selector currently matches no elements — run tab.observe() or tab.ariaSnapshot() to inspect the page',
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
  /** Navigate the main tab; it is raised first, because input to a page behind another one waits for a frame it never paints (the engine raises the tab it hands over). */
  const goto = async (path: string): Promise<RunResult> => {
    await chromePage("main").bringToFront();
    return run(`await tab.goto(${JSON.stringify(fixture.url(path))})`);
  };
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

  describe("screenshots (D13, D14, H9)", () => {
    test("a screenshot prints OMP's caption and picture, returns where the picture is, and the picture fits the model's budget", async () => {
      await goto("/form");
      const result = await run("await tab.screenshot()");
      const [, image] = result.displays;
      const lines = captionOf(result).split("\n");
      expect(lines[0]).toBe("Screenshot captured");
      expect(lines[1]).toMatch(/^Format: image\/webp \(\d+(\.\d+)? KB\)$/);
      expect(lines[2]).toBe("Dimensions: 1000x700");
      expect(image).toMatchObject({ type: "image", mimeType: "image/webp" });
      const [shot] = result.screenshots;
      expect(typeof result.returnValue).toBe("string");
      expect(shot!.dest).toBe(result.returnValue as string);
      expect(shot!.bytes).toBeLessThanOrEqual(150 * 1024);
      expect(Math.max(shot!.width, shot!.height)).toBeLessThanOrEqual(1024);
      expect((await readFile(shot!.dest)).length).toBe(shot!.bytes);
    }, 20_000);

    test("a tall page is shrunk to 1024 on its long edge and the caption says how to map coordinates back", async () => {
      await goto("/long");
      const result = await run("await tab.screenshot({ fullPage: true })");
      expect(captionOf(result)).toMatch(/^Screenshot captured\nFormat: image\/webp \(.+ KB\)\nDimensions: \d+x1024\n\[Image: original 1000x\d+, displayed at \d+x1024\. Multiply coordinates by [\d.]+ to map to original image\.\]$/);
      const picture = result.displays[1];
      expect(picture).toMatchObject({ type: "image" });
      const dims = readImageDimensions(Buffer.from(picture?.type === "image" ? picture.data : "", "base64"));
      expect(dims?.height).toBe(1024);
    }, 20_000);

    test("silent keeps the output clean but still returns the path", async () => {
      await goto("/form");
      const result = await run("await tab.screenshot({ silent: true })");
      expect(result.displays).toEqual([]);
      expect(typeof result.returnValue).toBe("string");
    }, 20_000);

    /** The width and height Chrome actually encoded: what the model receives, whatever the caption claims. */
    function pictureSize(result: RunResult): { width: number; height: number } {
      const picture = result.displays.find(part => part.type === "image");
      const dims = readImageDimensions(Buffer.from(picture?.type === "image" ? picture.data : "", "base64"));
      if (!dims) throw new Error("the run printed no readable picture");
      return dims;
    }

    test("a selector captures that element alone, a small one is scaled up to the vision floor of 200 px on its short edge, and one that matches nothing is refused", async () => {
      await goto("/form");
      const result = await run('await tab.screenshot({ selector: "#submit" })');
      const { width, height } = pictureSize(result);
      // The button is about 58x21 CSS px: far below the floor, still one button, not the page.
      expect(Math.min(width, height)).toBeGreaterThanOrEqual(200);
      expect(width).toBeGreaterThan(height);
      expect(Math.max(width, height)).toBeLessThanOrEqual(1024);
      expect(captionOf(result)).toContain(`Dimensions: ${width}x${height}`);
      expect((await failure('await tab.screenshot({ selector: "#nope" })')).message).toBe("Screenshot selector did not resolve to an element");
    }, 20_000);

    test("a viewport wider than 1024 is shrunk to 1024 on its long edge", async () => {
      const page = await openTab("wide");
      try {
        await page.setViewport({ width: 1920, height: 1080 });
        const wide = pictureSize(await run("await tab.screenshot()", { name: "wide" }));
        expect(wide.width).toBe(1024);
        expect(wide.height).toBe(576);
      } finally {
        await realm.release("wide");
        await page.close();
      }
    }, 20_000);

    test("a page on a high-density screen gets the same sizes: the pixel ratio the engine's connection set does not halve the picture or the floor", async () => {
      const page = await openTab("dense");
      try {
        await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 2 });
        const full = pictureSize(await run("await tab.screenshot()", { name: "dense" }));
        expect(full.width).toBe(1024);
        expect(full.height).toBeGreaterThanOrEqual(716);
        expect(full.height).toBeLessThanOrEqual(718);
        const small = pictureSize(await run('await tab.screenshot({ selector: "#submit" })', { name: "dense" }));
        expect(Math.min(small.width, small.height)).toBeGreaterThanOrEqual(200);
      } finally {
        await realm.release("dense");
        await page.close();
      }
    }, 30_000);

    test("a screenshot directory keeps the full-resolution PNG and the caption names where", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dimension-code-shots-"));
      const configured = createTabRealm({ evaluator: createCodeEvaluator, screenshotDir: dir });
      try {
        const { handle } = await chrome.openTab(fixture.url("/long"));
        await configured.adopt("shots", handle);
        const result = await configured.run({ name: "shots", code: "await tab.screenshot({ fullPage: true })", timeoutMs: 15_000, signal: new AbortController().signal });
        const dest = result.returnValue as string;
        expect(dirname(dest)).toBe(dir);
        expect(dest).toEndWith(".png");
        const saved = readImageDimensions(await readFile(dest));
        expect(saved?.width).toBe(1000);
        expect(saved?.height).toBeGreaterThan(4000);
        const lines = captionOf(result).split("\n");
        expect(lines[0]).toBe("Screenshot captured");
        expect(lines[1]).toMatch(/^Saved: image\/png \(.+ KB\) to /);
        expect(lines[1]).toContain(dest);
        expect(lines[2]).toMatch(/^Model: image\/webp \(.+ KB, \d+x1024\)$/);
      } finally {
        await configured.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    }, 30_000);

    test("the directory setting expands ~ and ignores blank", () => {
      expect(resolveScreenshotDir({ DIMENSION_BROWSER_SCREENSHOT_DIR: "~/shots" }, "/home/me")).toBe(join("/home/me", "shots"));
      expect(resolveScreenshotDir({ DIMENSION_BROWSER_SCREENSHOT_DIR: "~" }, "/home/me")).toBe("/home/me");
      expect(resolveScreenshotDir({ DIMENSION_BROWSER_SCREENSHOT_DIR: "/abs/dir" }, "/home/me")).toBe("/abs/dir");
      expect(resolveScreenshotDir({ DIMENSION_BROWSER_SCREENSHOT_DIR: "   " }, "/home/me")).toBeUndefined();
      expect(resolveScreenshotDir({}, "/home/me")).toBeUndefined();
    });
  });

  describe("clicking, typing and moving (D17, D18)", () => {
    test("click, type, fill and press act on the page", async () => {
      await goto("/form");
      await run('await tab.fill("#name", "first"); await tab.type("#name", " second"); await tab.click("#submit")');
      expect(await out()).toBe("submitted:first second");
      await run('await tab.fill("#name", "again")');
      expect(await value("await tab.evaluate(() => document.getElementById('name').value)")).toBe("again");
      await run('await tab.press("Enter", { selector: "#go" })');
      await run('await tab.waitForUrl("/done")');
      expect(await value("tab.url()")).toBe(fixture.url("/done"));
    }, 20_000);

    test("a covered button is not clicked through its cover: the text selector waits for it to become actionable and says why it did not", async () => {
      await goto("/form");
      const error = await failure('await tab.click("text/Covered")', { timeoutMs: 4_000 });
      // The text click's own loop gives up just before the op's ceiling, so the model reads the reason the loop saw (the cover), not the op's generic line.
      expect(error.message).toBe(
        "Timed out clicking text/Covered (seen 1 matches; last reason: obscured). If there are multiple matching elements, use observe + tab.id() or a more specific selector.",
      );
      expect(await out()).toBe("");
    }, 15_000);

    test("a text selector clicks a visible match by its text", async () => {
      await goto("/form");
      await run('await tab.fill("#name", "by text"); await tab.click("text/Submit")');
      expect(await out()).toBe("submitted:by text");
    }, 20_000);

    test("scroll turns the wheel over the page", async () => {
      await goto("/long");
      await run("await tab.scroll(0, 1500)");
      await chromePage("main").waitForFunction("window.scrollY > 500");
    }, 20_000);

    test("drag carries a press from one element to another, by selector and by point", async () => {
      const log = "await tab.evaluate(() => document.getElementById('log').textContent)";
      await goto("/drag");
      await run('await tab.drag("#a", "#b")');
      expect(await value(log)).toBe("up@260,160");
      await goto("/drag");
      await run("await tab.drag({ x: 40, y: 50 }, { x: 300, y: 400 })");
      expect(await value(log)).toBe("up@300,400");
      expect((await failure('await tab.drag("#nope", "#b")')).message).toBe("Drag from selector did not resolve: #nope");
    }, 30_000);
  });

  describe("waits (D19) and evaluate (D20)", () => {
    test("each wait gives the type it documents", async () => {
      await goto("/form");
      // A handle that can be filled and clicked, and that is the element asked for.
      expect(await value('const handle = await tab.waitFor("#submit"); [typeof handle.fill, typeof handle.click, await handle.evaluate(el => el.id)]')).toEqual(["function", "function", "submit"]);
      // hidden:true is satisfied by absence (null) or by an element that is there but not shown (its handle).
      expect(await value('await tab.waitForSelector("#nope", { hidden: true })')).toBeNull();
      expect(await value('(await tab.waitForSelector("#hidden-btn", { hidden: true })) !== null')).toBe(true);
      expect(await value('(await tab.waitForSelector("#submit", { visible: true })) !== null')).toBe(true);
    }, 20_000);

    test("waitForUrl resolves after the page redirects itself, with the address it reached", async () => {
      await goto("/redirect");
      expect(await value('await tab.waitForUrl("/done")')).toBe(fixture.url("/done"));
      await goto("/redirect");
      expect(await value("await tab.waitForUrl(/done$/)")).toBe(fixture.url("/done"));
    }, 20_000);

    test("waitForNavigation and waitForResponse resolve on what the page does", async () => {
      await goto("/redirect");
      const navigated = (await value('(await tab.waitForNavigation()).url()')) as string;
      expect(navigated).toBe(fixture.url("/done"));
      await goto("/xhr");
      expect(await value('(await tab.waitForResponse("/api/data")).url()')).toBe(fixture.url("/api/data?x=1"));
      // A function predicate (sync or async) is asked about every response, and the wait goes on until it says yes: this page fetches /api/other at 300 ms and /api/data at 700 ms.
      await goto("/xhr-two");
      expect(await value("const response = await tab.waitForResponse(r => r.url().includes('/api/data')); new URL(response.url()).pathname + new URL(response.url()).search")).toBe("/api/data?x=2");
      await goto("/xhr-two");
      expect(await value("(await tab.waitForResponse(async r => r.url().includes('/api/data'))).status()")).toBe(200);
      await goto("/xhr");
      expect(await value("(await tab.waitForResponse(/\\/api\\/data\\?x=1$/)).status()")).toBe(200);
    }, 20_000);

    test("evaluate runs a function or an expression in the page, and a string with a top-level return is a syntax error", async () => {
      await goto("/form");
      expect(await value("await tab.evaluate(() => document.title)")).toBe("Fixture form");
      expect(await value("await tab.evaluate((a, b) => a + b, 2, 3)")).toBe(5);
      expect(await value('await tab.evaluate("document.title.length")')).toBe("Fixture form".length);
      const error = await failure('await tab.evaluate("return 1")');
      expect(error.name === "SyntaxError" || error.message.includes("SyntaxError")).toBe(true);
    }, 20_000);
  });

  describe("select, upload and scrolling to an element (D21)", () => {
    test("select sets the options, fires input and change, and returns the chosen values", async () => {
      await goto("/form");
      await run("await tab.evaluate(() => { window.events = []; for (const type of ['input', 'change']) document.getElementById('color').addEventListener(type, () => window.events.push(type)); })");
      expect(await value('await tab.select("#color", "green")')).toEqual(["green"]);
      expect(await value("await tab.evaluate(() => [document.getElementById('color').value, window.events])")).toEqual(["green", ["input", "change"]]);
      expect((await failure('await tab.select("#submit", "x")')).message).toBe("tab.select() requires a <select> element");
    }, 20_000);

    test("uploadFile attaches the file to an input, wants an absolute path, and refuses an element that is not a file input", async () => {
      await goto("/form");
      const dir = await mkdtemp(join(tmpdir(), "dimension-code-upload-"));
      const file = join(dir, "note.txt");
      await writeFile(file, "hello");
      try {
        await run(`await tab.uploadFile("#file", ${JSON.stringify(file)})`);
        expect(await value("await tab.evaluate(() => document.getElementById('file').files[0].name)")).toBe("note.txt");
        expect((await failure('await tab.uploadFile("#file", "relative.txt")')).message).toBe(
          'tab.uploadFile() needs an absolute path; got "relative.txt". browser_run has no working directory to resolve a relative path against.',
        );
        expect((await failure(`await tab.uploadFile("#submit", ${JSON.stringify(file)})`)).message).toBe(
          'tab.uploadFile() requires an <input type="file"> element (got <button>)',
        );
        expect((await failure('await tab.uploadFile("#file")')).message).toBe("tab.uploadFile() requires at least one file path");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 20_000);

    test("a relative upload path resolves against the working directory the host gave the realm", () => {
      expect(resolveUploadPath("note.txt", resolve("/work/dir"))).toBe(resolve("/work/dir", "note.txt"));
    });

    test("scrollIntoView centres the element", async () => {
      await goto("/long");
      await run('await tab.scrollIntoView("#bottom")');
      expect(await value("await tab.evaluate(() => window.scrollY)")).toBeGreaterThan(3_000);
    }, 20_000);
  });

  describe("a handle that timed out is dead (D22)", () => {
    test("a click the page holds up times out under its own name and the same handle then refuses, telling how to get a fresh one", async () => {
      await openTab("busy", "/busy");
      try {
        // A first run on the tab: the interception state is set once per page, and that must not be the call that meets the busy page.
        await run("1", { name: "busy" });
        const result = await run(
          `const handle = await tab.waitFor("#spin");
           const attempt = async () => { try { await handle.click(); return "clicked"; } catch (error) { return error.message; } };
           return [await attempt(), await attempt()];`,
          { name: "busy", timeoutMs: 3_500 },
        );
        expect(result.returnValue).toEqual([
          "handle.click() timed out after 2500ms",
          "handle.click() cannot run: this handle was invalidated after handle.click() timed out; run tab.observe() or tab.ariaSnapshot() to resolve a fresh handle",
        ]);
      } finally {
        await realm.release("busy");
      }
    }, 20_000);
  });

  describe("dialogs are observed, not answered (D28)", () => {
    test("a dialog the page opened and nobody closed is named when the run times out", async () => {
      const engine = await openTab("dlg", "/dialog");
      try {
        const error = await failure(
          `await page.evaluate(() => { setTimeout(() => alert("are you sure"), 0); return new Promise(() => {}); })`,
          { name: "dlg", timeoutMs: 2_000 },
        );
        expect(error.message).toBe(
          `Browser code execution timed out after 2000ms; a alert("are you sure") dialog opened during this run and may still block the page — reopen the tab with dialogs:"accept"|"dismiss" or handle page.on('dialog')`,
        );
      } finally {
        await dismissDialog(engine);
        await realm.release("dlg");
      }
    }, 20_000);

    test("a dialog the engine answered is forgotten, so a later timeout does not blame it", async () => {
      const engine = await openTab("dlg", "/dialog");
      engine.on("dialog", dialog => void dialog.dismiss());
      try {
        // The realm learns a dialog was answered from the page's own event stream, which it subscribes to as it adopts: a first run lets that settle.
        await run("1", { name: "dlg" });
        await run(`await page.evaluate(() => { setTimeout(() => alert("x"), 0); return new Promise(resolve => setTimeout(resolve, 400)); })`, { name: "dlg" });
        const error = await failure("await tab.evaluate(() => new Promise(() => {}))", { name: "dlg", timeoutMs: 1_500 });
        expect(error.message).toMatch(/^Browser code execution timed out after 1500ms \(stalled on tab\.evaluate\(\) \(1\.\ds\)\)$/);
      } finally {
        await realm.release("dlg");
      }
    }, 20_000);
  });

  describe("the run scope (D24, D25, D32)", () => {
    test("assert throws the model's text, or OMP's default", async () => {
      expect((await failure('assert(false, "the form never loaded")')).message).toBe("the form never loaded");
      expect((await failure("assert(0)")).message).toBe("Assertion failed");
      expect(await value('assert(true, "fine"); "passed"')).toBe("passed");
    });

    test("wait sleeps for a time, and polls a predicate until it is truthy or its deadline names it", async () => {
      const started = Date.now();
      await run("await wait(300)");
      expect(Date.now() - started).toBeGreaterThanOrEqual(290);
      expect(await value("let n = 0; await wait(() => ++n >= 3 && n, { interval: 10 })")).toBe(3);
      expect((await failure("await wait(() => false, { timeout: 300, interval: 20 })")).message).toBe(
        "wait(predicate) timed out after 300ms — predicate never returned truthy",
      );
      expect((await failure('await wait("soon")')).message).toBe("wait(...) expects milliseconds (number) or a predicate function to poll");
    }, 20_000);

    // Doc 77 §7.4.5: as in OMP the code is not sandboxed from Node (it can import node:fs), and nothing of the pack's own is lent to it. The import is in the code under test, not in this file.
    test("the code can reach Node as OMP's can, and nothing of the pack's own is lent to it", async () => {
      expect(await value('typeof (await import("node:fs")).readFileSync')).toBe("function");
      expect(await value("[typeof tab, typeof page, typeof browser, typeof assert, typeof wait]")).toEqual(["object", "object", "object", "function", "function"]);
      // The realm adds no global of its own, however many runs it has made: what the code sees on globalThis is what this process had before any realm existed. The scope names (tab, page, ...) are lexical.
      const theirs = (await value("Object.getOwnPropertyNames(globalThis)")) as string[];
      expect(theirs.filter(name => !GLOBALS_AT_LOAD.includes(name))).toEqual([]);
      // And `tab` hands out the documented helpers only: no session, run, realm or connection object rides on it.
      expect(await value("Object.keys(tab).sort()")).toEqual(
        [
          "ariaSnapshot", "click", "drag", "evaluate", "extract", "fill", "goto", "id", "name", "observe", "page", "press", "ref", "screenshot", "scroll", "scrollIntoView", "select", "signal", "title", "type",
          "uploadFile", "url", "waitFor", "waitForNavigation", "waitForResponse", "waitForSelector", "waitForUrl",
        ].sort(),
      );
    }, 20_000);

    test("a browser.disconnect() at the end of a run does not take the other tabs of that browser, or this one, with it", async () => {
      await goto("/form");
      await openTab("sibling", "/done");
      try {
        await run("await browser.disconnect(); 1");
        // `browser` is the one connection every tab of this Chrome shares: the sibling and this tab both still answer, and neither is reported as ended.
        expect(await value("await tab.title()", { name: "sibling" })).toBe("Done page");
        expect(await value("tab.url()")).toBe(fixture.url("/form"));
        expect(realm.names()).toContain("sibling");
        expect(await value("(await browser.pages()).length > 1")).toBe(true);
      } finally {
        await realm.release("sibling");
        await enginePages.get("sibling")?.close();
      }
    }, 20_000);

    test("the browser reached any other way (page.browser(), the page's context, the sibling page's) cannot be disconnected from code either: no tab is ended, none is reported as ended", async () => {
      await goto("/form");
      await openTab("sibling", "/done");
      try {
        for (const reach of ["page.browser()", "page.browserContext().browser()", "page.target().browser()", "(await browser.pages())[0].browser()"]) {
          await run(`await ${reach}.disconnect(); 1`);
          expect(await value("await tab.title()", { name: "sibling" })).toBe("Done page");
          expect(await value("tab.url()")).toBe(fixture.url("/form"));
          expect(realm.names()).toContain("sibling");
        }
      } finally {
        await realm.release("sibling");
        await enginePages.get("sibling")?.close();
      }
    }, 30_000);

    test("code cannot cut the realm's connection, but the realm still lets go of it when the last tab of that browser goes", async () => {
      const own = createTabRealm({ evaluator: createCodeEvaluator });
      try {
        const { handle } = await chrome.openTab(fixture.url("/form"));
        await own.adopt("solo", handle);
        const ask = (code: string): Promise<RunResult> => own.run({ name: "solo", code, timeoutMs: 8_000, signal: new AbortController().signal });
        // The Browser itself (the run's `browser` is a facade that stops answering when the run ends), taken out of the run to look at after it: its own `connected` is the proof either way.
        await ask("globalThis.leakedBrowser = page.browser(); 1");
        const leaked = Reflect.get(globalThis, "leakedBrowser") as { connected: boolean };
        expect(leaked.connected).toBe(true);
        await ask("await browser.disconnect(); await page.browser().disconnect(); 1");
        expect(leaked.connected).toBe(true);
        await own.release("solo");
        expect(leaked.connected).toBe(false);
      } finally {
        Reflect.deleteProperty(globalThis, "leakedBrowser");
        await own.dispose();
      }
    }, 30_000);

    test("the code gets raw puppeteer page and browser beside tab, and a run that is cancelled ends with the cancellation", async () => {
      expect(await value("page.url() === tab.url() && typeof browser.pages === 'function' && typeof tab.page.goto === 'function'")).toBe(true);
      const controller = new AbortController();
      const pending = failure("await tab.evaluate(() => { window.cancelStarted = true; }); await tab.evaluate(() => new Promise(() => {}))", { signal: controller.signal, timeoutMs: 20_000 });
      await chromePage("main").waitForFunction("window.cancelStarted === true");
      controller.abort();
      const error = await pending;
      expect(error.name).toBe("ToolAbortError");
    }, 20_000);

    test("request interception a run switched on is switched off when the run ends, so the next navigation is not held", async () => {
      await goto("/form");
      await run(`await page.setRequestInterception(true); page.on("request", request => { void request.continue(); });`);
      await run(`await tab.goto(${JSON.stringify(fixture.url("/done"))})`, { timeoutMs: 8_000 });
      expect(await value("tab.url()")).toBe(fixture.url("/done"));
      await run("await tab.goto(" + JSON.stringify(fixture.url("/form")) + ")", { timeoutMs: 8_000 });
    }, 30_000);
  });

  describe("extract (D15)", () => {
    test("a page's article comes back as markdown, or as text, without the page furniture", async () => {
      await goto("/article");
      const markdown = (await value("await tab.extract()")) as string;
      expect(markdown).toContain("# A real article");
      expect(markdown).toContain("The first paragraph carries enough prose");
      expect(markdown).toContain("- one");
      expect(markdown).not.toContain("copyright");
      const text = (await value('await tab.extract("text")')) as string;
      expect(text).toContain("A real article");
      expect(text).not.toContain("# ");
    }, 20_000);

    test("a page with nothing readable says so by name", async () => {
      const { handle } = await chrome.openTab();
      await realm.adopt("blank", handle);
      try {
        expect((await failure('await tab.extract("markdown")', { name: "blank" })).message).toBe('tab.extract("markdown") found no readable content on about:blank');
      } finally {
        await realm.release("blank");
      }
    }, 20_000);
  });

  describe("code the page's owner never awaited (D24)", () => {
    // `bun test` fails a test on any REAL unhandled rejection, listener or not, so the process event is emitted by hand: what it proves is the routing (owned by this run's source file, then the run fails with the hint).
    test("a rejection nobody handles fails the run that made it, with the missing-await hint, instead of ending the worker", async () => {
      const guarded = createTabRealm({ evaluator: createCodeEvaluator, guardRejections: true });
      try {
        const { handle } = await chrome.openTab(fixture.url("/form"));
        await guarded.adopt("main", handle);
        const started = Date.now();
        const failed = await guarded
          .run({ name: "main", code: `process.emit("unhandledRejection", new Error("dropped on the floor"), Promise.resolve()); await wait(3000); "unreachable"`, timeoutMs: 8_000, signal: new AbortController().signal })
          .then(() => new Error("the run was expected to fail"), (error: Error) => error);
        expect(failed.message).toBe("Unhandled rejection (missing await?): dropped on the floor");
        // It fails the run when it happens, not when the run would have finished anyway.
        expect(Date.now() - started).toBeLessThan(2_000);
        const after = await guarded.run({ name: "main", code: "tab.url()", timeoutMs: 5_000, signal: new AbortController().signal });
        expect(after.returnValue).toBe(fixture.url("/form"));
      } finally {
        await guarded.dispose();
      }
    }, 20_000);

    test("a helper that fails after nobody awaited it stays contained: the run goes on", async () => {
      await goto("/form");
      expect(await value('tab.waitForSelector("#nope", { timeout: 200 }); await wait(700); "went on"')).toBe("went on");
    }, 20_000);
  });

  describe("password fields (D18)", () => {
    const refusal = (selector: string): string => `${JSON.stringify(selector)} is a password field; browser_run does not type into password fields from code.`;
    const secret = (): Promise<unknown> => value("await tab.evaluate(() => document.getElementById('pw').value)");

    test("code is refused a password field by default, by name and with the way round it, and nothing is typed", async () => {
      await goto("/form");
      for (const code of ['await tab.fill("#pw", "hunter2")', 'await tab.type("#pw", "hunter2")']) {
        const refused = await failure(code, { timeoutMs: 5_000 });
        expect(refused.message).toStartWith(refusal("#pw"));
        expect(refused.message).toContain("browser_view({ profile })");
        expect(refused.message).toContain("Ask the user");
        expect(refused.message).not.toContain("browser_act");
      }
      expect(await secret()).toBe("");
      // The field beside it is no different from OMP's.
      await run('await tab.fill("#name", "fine")');
      expect(await value("await tab.evaluate(() => document.getElementById('name').value)")).toBe("fine");
    }, 30_000);

    test("a handle's own fill and type, however the handle was got, and an aria ref are refused the same way", async () => {
      await goto("/form");
      const snapshot = (await value("await tab.ariaSnapshot()")) as string;
      const ref = /\[ref=(e\d+)\]/.exec(snapshot.split("\n").find(line => line.includes('"Secret"'))!)![1]!;
      const password = (await observe()).elements.find(element => element.name === "Secret")!;
      const attempts = [
        '(await tab.waitFor("#pw")).fill("x")',
        '(await tab.waitFor("#pw")).type("x")',
        `(await tab.id(${password.id})).fill("x")`,
        `(await tab.waitForSelector("#pw")).type("x")`,
        `(await tab.ref(${JSON.stringify(ref)})).type("x")`,
        `tab.fill("aria-ref=${ref}", "x")`,
        `tab.type("aria-ref=${ref}", "x")`,
      ];
      for (const attempt of attempts) {
        const refused = await failure(`await ${attempt}`);
        expect(refused.message).toContain("is a password field; browser_run does not type into password fields from code.");
      }
      expect(await secret()).toBe("");
    }, 30_000);

    test("a field that renders a moment after the click is checked when it appears, not skipped for not being there yet", async () => {
      await goto("/twostep");
      const refused = await failure('await tab.click("#next"); await tab.fill("#late-pw", "hunter2")', { timeoutMs: 8_000 });
      expect(refused.message).toStartWith(refusal("#late-pw"));
      expect(await value("await tab.evaluate(() => document.getElementById('late-pw').value)")).toBe("");
    }, 20_000);

    test("a field that is a password by the time it has focus is refused, never typed into", async () => {
      await goto("/flaky");
      const refused = await failure('await tab.fill("#flaky", "hunter2")', { timeoutMs: 4_000 });
      expect(refused.message).toStartWith('typing into "#flaky" would reach a password field (the focused element is one); browser_run does not type into password fields from code.');
      expect(await value("await tab.evaluate(() => document.getElementById('flaky').value)")).toBe("");
    }, 20_000);

    test("a field that turns into a password after those checks is waited for, never typed into", async () => {
      // Two reads as text (the realm's own check, then what holds focus): the third is the fill's own predicate, which is what holds the keys back.
      await goto("/flaky?reads=2");
      const failed = await failure('await tab.fill("#flaky", "hunter2")', { timeoutMs: 4_000 });
      expect(failed.message).toStartWith('tab.fill("#flaky") timed out');
      expect(await value("await tab.evaluate(() => document.getElementById('flaky').value)")).toBe("");
    }, 20_000);

    test("keys pressed into a password field are refused, a key that types nothing is not, and a plain field still takes both", async () => {
      await goto("/form");
      // The model's way round: press the password one character at a time.
      const refused = await failure('for (const ch of "hunter2") await tab.press(ch, { selector: "#pw" })');
      expect(refused.message).toStartWith('tab.press("h", { selector: "#pw" }) would reach a password field (the focused element is one); browser_run does not type into password fields from code.');
      expect(await secret()).toBe("");
      // Enter in a password field is how a login is sent: it stays allowed, and so does every key that does not type.
      await run('await tab.evaluate(() => { window.pressed = []; document.getElementById("pw").addEventListener("keydown", event => window.pressed.push(event.key)); })');
      await run('await tab.press("Enter", { selector: "#pw" }); await tab.press("ArrowLeft"); await tab.press("Tab")');
      expect(await value("await tab.evaluate(() => window.pressed.slice(0, 2))")).toEqual(["Enter", "ArrowLeft"]);
      await run('await tab.press("o", { selector: "#name" }); await tab.press("k")');
      expect(await value("await tab.evaluate(() => document.getElementById('name').value)")).toBe("ok");
    }, 30_000);

    test("keys that would reach a password field through another element are refused: focus handed on by a custom element, moved by the page, held from an earlier click, or inside a frame", async () => {
      const innerValue = "document.getElementById('xpw').shadowRoot.getElementById('inner').value";
      await goto("/delegate");
      // A shadow root with delegatesFocus: the element the helper is pointed at is not an input at all.
      for (const code of ['tab.type("x-pw", "secret")', 'tab.fill("x-pw", "secret")', '(await tab.waitFor("x-pw")).type("secret")', '(await tab.waitFor("x-pw")).fill("secret")', 'tab.press("s", { selector: "x-pw" })']) {
        const refused = await failure(`await ${code}`);
        expect(refused.message).toContain("would reach a password field (the focused element is one); browser_run does not type into password fields from code.");
      }
      expect(await value(`await tab.evaluate(() => ${innerValue})`)).toBe("");
      await run('await tab.type("#plain", "ok")');
      expect(await value("await tab.evaluate(() => document.getElementById('plain').value)")).toBe("ok");

      // A field whose focus handler hands focus to a password field.
      await goto("/focusmove");
      expect((await failure('await tab.type("#decoy", "x")')).message).toContain('typing into "#decoy" would reach a password field');
      expect(await value("await tab.evaluate(() => document.getElementById('hidden-pw').value)")).toBe("");

      // A click gave the password field focus; a target that cannot take focus (the body) leaves it there, and so does a press with no selector.
      await goto("/form");
      await run('await tab.click("#pw")');
      for (const code of ['tab.type("body", "zz")', '(await tab.waitFor("body")).type("zz")', 'tab.press("z")']) {
        const refused = await failure(`await ${code}`);
        expect(refused.message).toContain("would reach a password field (the focused element is one); browser_run does not type into password fields from code.");
      }
      expect(await secret()).toBe("");

      // The password field is in an iframe of the page, and focus is there.
      await goto("/framed");
      await run('const frame = page.frames().find(f => f !== page.mainFrame()); await (await frame.$("#pw")).click()');
      expect((await failure('await tab.type("body", "zz")')).message).toContain('typing into "body" would reach a password field');
      // Pointing the helper at the iframe element itself: whether Chrome keeps the frame's focused field when the frame is focused this way is its own business; what matters is where the keys went.
      await run('try { await tab.type("#f", "zz"); } catch {}');
      expect(await value('await page.frames().find(f => f !== page.mainFrame()).evaluate(() => document.getElementById("pw").value)')).toBe("");
      // A field of the page itself is a different focus, and types.
      await run('await tab.type("#top", "fine")');
      expect(await value("await tab.evaluate(() => document.getElementById('top').value)")).toBe("fine");
    }, 60_000);

    test("the host lifts the rule with refusePasswordFields: false, and then the same calls type as OMP's do", async () => {
      const lifted = createTabRealm({ evaluator: createCodeEvaluator, refusePasswordFields: false });
      try {
        const { handle } = await chrome.openTab(fixture.url("/form"));
        await lifted.adopt("main", handle);
        const code = 'await tab.fill("#pw", "hunter2"); await tab.type("#pw", "!"); await tab.evaluate(() => document.getElementById("pw").value)';
        const result = await lifted.run({ name: "main", code, timeoutMs: 8_000, signal: new AbortController().signal });
        expect(result.returnValue).toBe("hunter2!");
      } finally {
        await lifted.dispose();
      }
    }, 30_000);
  });
});

if (chromePath === undefined) test.skip("the tab realm needs a Chrome", () => {});
