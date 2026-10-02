/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the model opens a page in a cell and hands the whole job to `browser_task`; 20 s later the code host freezes the tab under the task agent, which stops the
 * page's timers and network-driven updates while the agent waits on them. A task's steps never stamp the browser as used, so the idle clock alone cannot tell the tab is busy. And a tab that was already
 * frozen when the task began must be thawed for it.
 *
 * Real runtime, real Chrome, a real code host with a short freeze period, and the pack's fake task worker (test/fake-worker) holding a task open. Freezing and thawing are read at the port the host calls.
 */
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { CodeHost } from "../src/code/host/code-host";
import { RuntimeCodeBrowsers } from "../src/code/host/runtime-port";
import { BROWSER_TEST_TIMEOUT_MS, chromePath, createRoot, newRuntime, teardown, waitUntil } from "./fixture";
import { startPages, valueOf, type Pages } from "./code-host-fixture";

const FAKE_WORKER = fileURLToPath(new URL("./fake-worker/", import.meta.url));
const VENV_PYTHON = fileURLToPath(new URL(`../python/.venv/${process.platform === "win32" ? "Scripts/python.exe" : "bin/python"}`, import.meta.url));

/** The interpreter the fake worker needs: the pack's venv, DIM_BROWSER_PYTHON, or a python on the PATH that can import `websockets`. */
function workingPython(): string | undefined {
  for (const candidate of [VENV_PYTHON, process.env.DIM_BROWSER_PYTHON, Bun.which("python3"), Bun.which("python")]) {
    if (candidate === undefined || candidate === null) continue;
    try {
      if (Bun.spawnSync([candidate, "-c", "import websockets"]).exitCode === 0) return candidate;
    } catch {
      // Not runnable here: try the next.
    }
  }
  return undefined;
}

const PYTHON = workingPython();
const describeTasks = chromePath === undefined || PYTHON === undefined ? describe.skip : describe;

/** The code host's port onto the runtime, with every freeze and thaw it is asked for written down. */
class RecordingBrowsers extends RuntimeCodeBrowsers {
  readonly asked: boolean[] = [];

  override async setFrozen(browserId: string, tabId: string, frozen: boolean): Promise<void> {
    this.asked.push(frozen);
    await super.setFrozen(browserId, tabId, frozen);
  }
}

let pages: Pages;
const saved: Record<string, string | undefined> = {};
let host: CodeHost | undefined;

beforeAll(async () => {
  pages = await startPages();
  for (const key of ["DIM_BROWSER_PYTHON", "PYTHONPATH", "PYTHONDONTWRITEBYTECODE"]) saved[key] = process.env[key];
  if (PYTHON !== undefined) process.env.DIM_BROWSER_PYTHON = PYTHON;
  process.env.PYTHONPATH = FAKE_WORKER;
  process.env.PYTHONDONTWRITEBYTECODE = "1";
});
afterAll(async () => {
  await pages.close();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterEach(async () => {
  await host?.dispose();
  host = undefined;
  await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

describeTasks("a task agent drives a browser a cell opened", () => {
  test("its tab is thawed when the task begins and is not frozen while it runs, however long since a call reached it; it freezes again once the task is over", async () => {
    const rootDir = await createRoot();
    const runtime = newRuntime(rootDir);
    const browsers = new RecordingBrowsers(runtime.codeSeam(), {});
    const freezeIdleMs = 300;
    host = new CodeHost({ browsers, timing: { freezeIdleMs }, artifactsRoot: rootDir });
    await valueOf(host, "s1", `await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/other"))} }); 1`);
    const browserId = browsers.existing("s1")?.browserId;
    if (browserId === undefined) throw new Error("the cell's browser is not the session's");
    // Idle with nobody about: the tab freezes.
    await waitUntil("the idle tab freezes", () => browsers.asked.filter(frozen => frozen).length, count => count === 1, 10_000);

    await runtime.startTask(browserId, { task: JSON.stringify({ steps: [{ action: "thinking", url: "" }], hold: true }) });
    await waitUntil("the task's start thaws it", () => browsers.asked.length, count => count === 2, 10_000);
    expect(browsers.asked).toEqual([true, false]);

    // Five freeze periods with the task running and nothing calling the browser. A real wait: the thing under test is that no freeze happens in this window.
    await Bun.sleep(freezeIdleMs * 5);
    expect(browsers.asked).toEqual([true, false]);

    await runtime.cancelTask(browserId);
    await waitUntil("the tab freezes again once the task is over", () => browsers.asked.filter(frozen => frozen).length, count => count === 2, 10_000);
  }, BROWSER_TEST_TIMEOUT_MS);
});
