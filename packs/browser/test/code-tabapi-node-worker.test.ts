/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED:
 * - A promise the model's `tab.run` code floats and rejects late takes the whole worker down, and every tab's variables with it. Two `unhandledRejection` guards share the worker's process (the tab
 *   realm's and the cell's); the cell's used to rethrow what the realm had already handled.
 * - A realm setting the host sends in `init` (the working directory for uploads, the password-field rule, JPEG instead of WebP) never reaches the realm, or reaches it under another default.
 * Both are about the real worker thread, started the way the product starts it: a Node worker thread running the bundled production entry, the real tab realm on a real Chrome. (`bun test` cannot
 * stand in: it ends any worker thread that has an unhandled rejection, listeners or not. See test/code-node-worker.ts.)
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TabHandle } from "../src/code/contracts.js";
import { type NodeWorker, removeWorkerBundle, startNodeWorker } from "./code-node-worker";
import { type Fixture, type LaunchedChrome, launchChrome, startFixture } from "./code-tab-fixture";
import { describeWithChrome } from "./fixture";

describeWithChrome("the code worker as the product runs it (a Node worker thread)", () => {
  let chrome: LaunchedChrome;
  let fixture: Fixture;
  let tab: TabHandle;

  beforeAll(async () => {
    fixture = await startFixture();
    chrome = await launchChrome();
    ({ handle: tab } = await chrome.openTab(fixture.url("/form")));
  }, 60_000);

  afterAll(async () => {
    await chrome?.close();
    await fixture?.stop();
    await removeWorkerBundle();
  }, 30_000);

  async function withWorker<T>(init: Parameters<typeof startNodeWorker>[1], body: (worker: NodeWorker) => Promise<T>): Promise<T> {
    const worker = await startNodeWorker(tab, init);
    try {
      return await body(worker);
    } finally {
      await worker.stop();
    }
  }

  /**
   * What the cell answered with, or the failure's message. A cell reports a value by printing `value=<json>` (the cell prints its final expression as plain text, which says nothing about its shape).
   */
  async function outcome(worker: NodeWorker, runId: string, code: string): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
    const { result } = await worker.cell(runId, code);
    if (!result.ok) return { ok: false, message: result.error.message };
    const text = result.payload.displays.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
    const printed = /^value=(.*)$/m.exec(text)?.[1];
    return { ok: true, value: printed === undefined ? undefined : JSON.parse(printed) };
  }

  describe("a promise nobody awaited", () => {
    test("one tab.run's code rejects late fails that run, and the worker stays alive with its variables", () =>
      withWorker({}, async worker => {
        await worker.cell("open", `const tab = await browser.open({ name: "main" }); const keep = 41;`);
        // The reason's stack names only the tab run's own file (a timer callback): the tab realm's to claim, and the cell's guard must not rethrow it.
        const late = await outcome(worker, "late", `await tab.run("setTimeout(() => { Promise.reject(new Error('late')) }, 0); await wait(300)")`);
        expect(late).toEqual({ ok: false, message: "Unhandled rejection (missing await?): late" });
        // A reason the realm MARKED (a helper's own failure surfacing through a function nobody awaited) is the realm's as well, whatever its stack says.
        const marked = await outcome(worker, "marked", `await tab.run("(async () => { await tab.waitForSelector('#nope', { timeout: 200 }); })(); await wait(700)")`);
        expect(marked.ok).toBe(false);
        if (!marked.ok) expect(marked.message).toStartWith("Unhandled rejection (missing await?): ");
        // The same worker still holds the earlier names and its page (a dead worker would never answer, and `ended` says how it died).
        const after = await outcome(worker, "after", `console.log("value=" + JSON.stringify([keep + 1, await tab.url()]))`);
        expect(after).toEqual({ ok: true, value: [42, fixture.url("/form")] });
        expect(worker.ended()).toBeUndefined();
      }), 60_000);

    // The commonest missing await is in the cell itself, not inside `tab.run`: the call goes through the cell's own bridge, whose rejection carries the realm's error (its stack names tab-ops frames and
    // no cell file). Real wall-clock waits inside the cell on purpose: the late failure is a real worker thread's real timers racing a real Chrome; fake timers cannot stand in.
    test("a tab call the cell itself did not await fails that run with the error's text, and the worker keeps every earlier variable", () =>
      withWorker({}, async worker => {
        await worker.cell("open", `const tab = await browser.open({ name: "main" }); const keep = 41;`);
        const waited = await outcome(worker, "waited", `tab.waitForSelector("#nope", { timeout: 200 }); await new Promise(r => setTimeout(r, 1500)); 1`);
        expect(waited.ok).toBe(false);
        if (!waited.ok) {
          expect(waited.message).toStartWith("Unhandled rejection (missing await?): ");
          expect(waited.message).toContain("#nope");
        }
        const click = await outcome(worker, "click", `tab.click("#nope"); await new Promise(r => setTimeout(r, 3500)); 1`);
        expect(click.ok).toBe(false);
        if (!click.ok) {
          expect(click.message).toStartWith("Unhandled rejection (missing await?): ");
          expect(click.message).toContain("#nope");
        }
        expect(await outcome(worker, "after", `console.log("value=" + JSON.stringify([keep + 1, await tab.url()]))`)).toEqual({ ok: true, value: [42, fixture.url("/form")] });
        expect(worker.ended()).toBeUndefined();
      }), 60_000);

    test("a tab call that outlives the cell which started it is nobody's to fail: that cell is done, the next one is not blamed, and the worker lives", () =>
      withWorker({}, async worker => {
        await worker.cell("open", `const tab = await browser.open({ name: "main" }); const keep = 41;`);
        // The cell ends at once; the click fails about 2 s later (the zero-match watchdog), while the next cell is running.
        expect(await outcome(worker, "gone", `tab.click("#nope"); 1`)).toEqual({ ok: true, value: undefined });
        expect(await outcome(worker, "next", `await new Promise(r => setTimeout(r, 3000)); console.log("value=" + (keep + 1))`)).toEqual({ ok: true, value: 42 });
        expect(worker.ended()).toBeUndefined();
      }), 60_000);

    test("a rejection that is nobody's still ends the worker, as Node's default does for a real fault", () =>
      withWorker({}, async worker => {
        // After the cell is done, with no usable stack and no run's file in it: neither guard can claim it.
        const done = await outcome(worker, "fault", `setTimeout(() => { const e = new Error("not any run's"); e.stack = "Error: not any run's"; Promise.reject(e); }, 50); 1`);
        expect(done.ok).toBe(true);
        expect(await worker.whenEnded).toBe("error: not any run's");
      }), 30_000);

    test("a stackless rejection with no run live is nobody's either, and ends the worker", () =>
      withWorker({}, async worker => {
        // A reason that is not an Error has no stack to read and nothing the realm marked: with no run live there is no activity to blame it on.
        const done = await outcome(worker, "stackless", `setTimeout(() => { Promise.reject({ message: "an object nobody owns" }); }, 50); 1`);
        expect(done.ok).toBe(true);
        expect(await worker.whenEnded).toBe("error: an object nobody owns");
      }), 30_000);
  });

  describe("the realm settings the host sends in init", () => {
    test("password fields are refused from code unless the host lifts the rule, and the refusal says where to go instead", () =>
      withWorker({}, async worker => {
        const refused = await outcome(worker, "refused", `const tab = await browser.open({ name: "main" }); await tab.fill("#pw", "hunter2")`);
        expect(refused.ok).toBe(false);
        if (refused.ok) return;
        expect(refused.message).toStartWith('"#pw" is a password field');
        expect(refused.message).toContain("browser_act");
        expect(refused.message).toContain("ask the user");
        // browser_task is registered only with a TypeSafe key, which only the host can see: unless it said so in init, the refusal does not send the model to a tool that is not there. And the way in it does name
        // is truthful about the browser the cell drives: a throwaway one has no saved password.
        expect(refused.message).not.toContain("browser_task");
        expect(refused.message).toContain("saved profile");
        expect(refused.message).toContain("throwaway");
        // An ordinary field is not in the way, and nothing was typed into the password one.
        expect(await outcome(worker, "ok", `await tab.fill("#name", "fine"); console.log("value=" + JSON.stringify(await tab.evaluate(() => document.getElementById("pw").value)))`)).toEqual({ ok: true, value: "" });
      }), 30_000);

    test("the refusal names browser_task when the host says the server offers it", () =>
      withWorker({ taskCredential: true }, async worker => {
        const refused = await outcome(worker, "refused", `const tab = await browser.open({ name: "main" }); await tab.type("#pw", "hunter2")`);
        expect(refused.ok).toBe(false);
        if (!refused.ok) {
          expect(refused.message).toContain("browser_act");
          expect(refused.message).toContain("browser_task with a credential");
          expect(refused.message).toContain("ask the user");
        }
      }), 30_000);

    test("the host lifts it with refusePasswordFields: false", () =>
      withWorker({ refusePasswordFields: false }, async worker => {
        const typed = await outcome(worker, "typed", `const tab = await browser.open({ name: "main" }); await tab.fill("#pw", "hunter2"); console.log("value=" + JSON.stringify(await tab.evaluate(() => document.getElementById("pw").value)))`);
        expect(typed).toEqual({ ok: true, value: "hunter2" });
      }), 30_000);

    test("a relative uploadFile path resolves against the host's cwd, and is refused naming the rule when the host gave none", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dimension-code-cwd-"));
      try {
        await writeFile(join(dir, "up.txt"), "uploaded");
        const code = `const tab = await browser.open({ name: "main" }); await tab.uploadFile("#file", "up.txt"); console.log("value=" + JSON.stringify(await tab.evaluate(() => document.getElementById("file").files[0].name)))`;
        expect(await withWorker({ cwd: dir }, worker => outcome(worker, "up", code))).toEqual({ ok: true, value: "up.txt" });
        const refused = await withWorker({}, worker => outcome(worker, "up", code));
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.message).toStartWith('tab.uploadFile() needs an absolute path; got "up.txt"');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 60_000);

    test("the picture the model sees is WebP, or JPEG when the host sets excludeWebP, and with no screenshot directory it is kept under the temp directory", async () => {
      const shotOf = (worker: NodeWorker, runId: string): Promise<{ mimeType: string | undefined; dest: string | undefined }> =>
        worker.cell(runId, `const tab = await browser.open({ name: "main" }); await tab.screenshot({ silent: false }); 1`).then(({ result }) => {
          if (!result.ok) throw new Error(result.error.message);
          const image = result.payload.displays.find(part => part.type === "image");
          return { mimeType: image?.type === "image" ? image.mimeType : undefined, dest: result.payload.screenshots[0]?.dest };
        });
      const webp = await withWorker({}, worker => shotOf(worker, "webp"));
      expect(webp.mimeType).toBe("image/webp");
      // The host's scrubbed environment keeps TEMP, TMP and SystemRoot, so the worker's `os.tmpdir()` is the server's own (this harness sends the same keys the host does).
      expect(webp.dest?.startsWith(tmpdir())).toBe(true);
      expect((await withWorker({ excludeWebP: true }, worker => shotOf(worker, "jpeg"))).mimeType).toBe("image/jpeg");
    }, 60_000);
  });
});
