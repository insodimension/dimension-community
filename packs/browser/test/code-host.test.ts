/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: `browser_run`, the model's one way of driving a page, does not drive it. Real runtime, real Chrome, a real worker thread running the real tab realm. */
import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
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

async function start(): Promise<Rig> {
  rig = newRig(await createRoot());
  return rig;
}

describeWithChrome("a cell drives a real page", () => {
  test("open a page, fill, click, read, screenshot: through one cell", async () => {
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
    expect(result.returnValue).toBe("hello:Ada");
    expect(result.displays.some(part => part.type === "image")).toBe(true);
    expect(textOf(result)).toContain('Opened tab "main" on headless browser (hidden)');
    expect(result.screenshots.length).toBe(1);
  }, BROWSER_TEST_TIMEOUT_MS);
});
