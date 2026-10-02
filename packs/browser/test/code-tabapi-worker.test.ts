/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a cell that drives a page pays a message hop to the host for every `tab.click`, as OMP's does twice. The pack's promise (doc 77 §7.4.4) is that
 * only `open` and `close` leave the worker; `run` and `call` stay inside it. This starts the real worker thread with the real tab realm and a real Chrome, plays the host for the one
 * `open` the cell makes, and counts what crossed the thread boundary.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import type { HostToWorker, TabHandle, WorkerToHost } from "../src/code/contracts.js";
import { type Fixture, type LaunchedChrome, launchChrome, startFixture } from "./code-tab-fixture";
import { describeWithChrome } from "./fixture";

describeWithChrome("a cell driving a page in the real worker thread", () => {
  let chrome: LaunchedChrome;
  let fixture: Fixture;
  let worker: Worker;
  const seen: WorkerToHost[] = [];
  const waiting: Array<{ matches: (m: WorkerToHost) => boolean; resolve: (m: WorkerToHost) => void }> = [];
  let handle: TabHandle;

  const send = (message: HostToWorker): void => worker.postMessage(message);
  function next(matches: (m: WorkerToHost) => boolean): Promise<WorkerToHost> {
    const found = seen.find(matches);
    if (found) return Promise.resolve(found);
    const { promise, resolve } = Promise.withResolvers<WorkerToHost>();
    waiting.push({ matches, resolve });
    return promise;
  }

  beforeAll(async () => {
    fixture = await startFixture();
    chrome = await launchChrome();
    ({ handle } = await chrome.openTab(fixture.url("/form")));
    worker = new Worker(new URL("./fixtures-code/tab-realm-worker.ts", import.meta.url));
    worker.on("message", (message: WorkerToHost) => {
      seen.push(message);
      // The host's part: the engine already made the page; the cell's `open` is answered with it.
      if (message.t === "bridge" && message.request.action === "open") {
        send({ t: "bridge-reply", id: message.id, ok: true, value: { text: 'Opened tab "main"', details: { action: "open", name: "main", url: handle.url }, attach: handle } });
      }
      for (const wait of [...waiting]) {
        if (!wait.matches(message)) continue;
        waiting.splice(waiting.indexOf(wait), 1);
        wait.resolve(message);
      }
    });
    send({ t: "init", session: "s1", env: { PATH: "/bin" } });
    await next(m => m.t === "ready");
  }, 60_000);

  afterAll(async () => {
    await worker?.terminate();
    await chrome?.close();
    await fixture?.stop();
  }, 30_000);

  test("one open crosses to the host; twenty reads, a fill, a click and a function run inside the page do not", async () => {
    const code = `
      const tab = await browser.open({ name: "main" });
      const urls = [];
      for (let i = 0; i < 20; i++) urls.push(await tab.url());
      await tab.fill("#name", "from the worker");
      await tab.click("#submit");
      const out = await tab.run(async ({ page }) => page.evaluate(() => document.getElementById("out").textContent));
      console.log(JSON.stringify({ distinct: [...new Set(urls)], out }));
    `;
    send({ t: "run", runId: "r1", code, timeoutMs: 20_000 });
    const result = await next(m => m.t === "result" && m.runId === "r1");
    if (result.t !== "result" || !result.ok) throw new Error(`the cell failed: ${JSON.stringify(result)}`);
    const printed = result.payload.displays.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
    expect(JSON.parse(printed.slice(printed.indexOf("{")))).toEqual({ distinct: [fixture.url("/form")], out: "submitted:from the worker" });
    // Everything the worker said to the host while the cell ran: one bridge request, for `open`.
    const bridged = seen.flatMap(m => (m.t === "bridge" ? [m.request.action] : []));
    expect(bridged).toEqual(["open"]);
  }, 30_000);
});
