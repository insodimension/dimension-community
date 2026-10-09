/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: `browser.open({ app })` from a cell does not reach the browser it names, or reaches it and leaves it worse than it found it. A cell that asks for the person's own
 * Chrome (`app.cdp_url`, `app.relay`) gets a page it did not choose, resizes the window the person is looking at, answers a dialog that was theirs, or closes their tab when it is done; a spawned application
 * is ended when the cell only let go of it, or kept when the cell asked for it to be killed; a cmux surface is not opened, is closed when the person pointed the cell at it, or lets the cell read the daemon's
 * password. Every file under src/code/kinds has its own test; this is the seam: the REAL runtime and code host, a REAL worker thread running the real tab realm, over a real headless Chrome the test starts
 * (the person's own Chrome, or the application a cell spawns), the real relay with the shipped extension's own code against that Chrome, and a fake cmux daemon speaking cmux's wire protocol.
 *
 * Not shown here, because it needs what this machine does not have: a real Chrome loading the unpacked extension (no infobar, no tab group), and a real cmux on a Mac.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import type { BrowserKind, HostToWorker, TabHandle } from "../src/code/contracts";
import { CodeHost } from "../src/code/host/code-host";
import { RuntimeCodeBrowsers, type CodeSeam } from "../src/code/host/runtime-port";
import { defaultWorkerEntry, type SpawnWorker, threadWorkerSpawner } from "../src/code/host/transport";
import { establishKind } from "../src/code/kinds/establish";
import type { ProcessScanner } from "../src/code/kinds/spawned";
import { stopOwnedRelays } from "../src/code/kinds/relay/ensure";
import { alive, chromePath, gone, killTree, startDebugChrome, startPageServer, stopDebugChromes, type DebugChrome, type PageServer } from "./kinds-fixture";
import { cell, failureOf, isFailure, textOf, valueOf } from "./code-host-fixture";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, teardown, waitUntil } from "./fixture";
import { type FakeCmux, type FakePage, pageHandler, removeFakeCmuxDirs, startFakeCmux } from "./cmux-fixture";
import { type FakeExtension, removeRelayBundle, startFakeExtension, startRelayHost, stopRelayHosts } from "./relay-fixture";

/** The variables the kinds read; a test sets what it needs and the owner's own environment never leaks into it. */
const KIND_VARIABLES = [
  "DIMENSION_BROWSER_CDP_URL", "DIMENSION_BROWSER_RELAY", "DIMENSION_BROWSER_RELAY_URL", "DIMENSION_BROWSER_CMUX", "DIMENSION_BROWSER_HEADLESS",
  "CMUX_SOCKET_PATH", "CMUX_SOCKET_PASSWORD", "CMUX_RELAY_ID", "CMUX_RELAY_TOKEN", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "PUPPETEER_PROXY", "DIMENSION_BROWSER_CODE_ALLOW_ATTACH",
];

function kindEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of KIND_VARIABLES) delete env[name];
  // The person has said yes to a cell driving a browser it did not launch (code-host.test.ts defends the refusal without it); a test that wants it off says so.
  return { ...env, DIMENSION_BROWSER_CODE_ALLOW_ATTACH: "1", ...extra };
}

let pages: PageServer;
let host: CodeHost | undefined;
const stoppers: Array<() => Promise<void>> = [];
const extensions: FakeExtension[] = [];
const fakes: FakeCmux[] = [];
const scratch: string[] = [];

beforeAll(async () => {
  pages = await startPageServer();
});
afterAll(async () => {
  await pages.stop();
  await removeRelayBundle();
  await removeFakeCmuxDirs();
});
afterEach(async () => {
  await host?.dispose();
  host = undefined;
  for (const extension of extensions.splice(0)) extension.dispose();
  for (const stop of stoppers.splice(0).reverse()) await stop();
  for (const fake of fakes.splice(0)) await fake.stop();
  await stopOwnedRelays();
  await stopRelayHosts();
  await stopDebugChromes();
  await teardown();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
}, BROWSER_TEST_TIMEOUT_MS);

interface RigOptions {
  env?: Record<string, string>;
  idleMs?: number;
  /** Replaces how a non-headless kind is made ready (the scanner of running applications, say). Default: the real one. */
  establish?: typeof establishKind;
  /** Where the worker's messages can be looked at. */
  spawn?: SpawnWorker;
}

/** The pack's runtime and a code host over it, as the server builds them, with the kinds' environment this test chooses. */
async function start(options: RigOptions = {}): Promise<CodeHost> {
  const rootDir = await createRoot();
  host = new CodeHost({
    browsers: new RuntimeCodeBrowsers(newRuntime(rootDir).codeSeam(), { idleMs: options.idleMs ?? 1_800_000, establish: options.establish ?? establishKind }),
    env: kindEnv(options.env),
    artifactsRoot: join(rootDir, "artifacts"),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
  });
  return host;
}

/** What the person sees of their own tab: where it is and how big its window is, read over a connection of the test's own. */
async function personTab(chrome: DebugChrome, url?: string): Promise<{ url: string; width: number; height: number }> {
  const browser = await puppeteer.connect({ browserURL: chrome.cdpUrl, defaultViewport: null });
  try {
    const [page = await browser.newPage()] = await browser.pages();
    if (url !== undefined) await page.goto(url, { waitUntil: "load" });
    return { url: page.url(), ...(await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))) };
  } finally {
    await browser.disconnect();
  }
}

/** The person's tab as they have it: window size and pixel ratio, read over a connection of the test's own. */
async function personMetrics(chrome: DebugChrome): Promise<[number, number, number]> {
  const browser = await puppeteer.connect({ browserURL: chrome.cdpUrl, defaultViewport: null });
  try {
    const [page] = await browser.pages();
    return (await page!.evaluate(() => [innerWidth, innerHeight, devicePixelRatio])) as [number, number, number];
  } finally {
    await browser.disconnect();
  }
}

/** A worker spawner that keeps every tab handle the host hands the worker (what `open` and `active` reply with), so a test can read what the worker was told about a tab. */
function tapSpawn(handles: TabHandle[]): SpawnWorker {
  const inner = threadWorkerSpawner(defaultWorkerEntry(), { maxOldGenerationSizeMb: 1_024 });
  return options => {
    const worker = inner(options);
    const send = worker.transport.send.bind(worker.transport);
    worker.transport.send = (message: HostToWorker) => {
      if (message.t === "bridge-reply" && message.ok && message.value.attach !== undefined) handles.push(message.value.attach);
      send(message);
    };
    return worker;
  };
}

async function pageUrls(chrome: DebugChrome): Promise<string[]> {
  const list = (await (await fetch(`${chrome.cdpUrl}/json/list`)).json()) as Array<{ type: string; url: string }>;
  return list.filter(target => target.type === "page").map(target => target.url);
}

describeWithChrome("connected: a cell drives a Chrome the person started", () => {
  test("it adopts the page in front as it is, drives it, and leaves the page and the Chrome open when it is done", async () => {
    const chrome = await startDebugChrome();
    const before = await personTab(chrome, pages.url("/one"));
    const cdp = JSON.stringify(chrome.cdpUrl);
    const code = await start();

    const result = await cell(code, "s1", `
      const tab = await browser.open({ app: { cdp_url: ${cdp} } });
      const first = await tab.title();
      await tab.goto(${JSON.stringify(pages.url("/two"))});
      const inside = await tab.evaluate(() => [innerWidth, innerHeight]);
      await tab.screenshot();
      await browser.close();
      JSON.stringify([first, inside]);
    `);
    if (isFailure(result)) throw new Error(`${result.error.name}: ${result.error.message}`);
    expect(textOf(result)).toContain(`Opened tab "main" on connected ${chrome.cdpUrl}`);
    expect(textOf(result)).toContain(`URL: ${pages.url("/one")}`);
    expect(textOf(result)).toContain("Title: Page one");
    const [first, inside] = JSON.parse(textOf(result).split("\n").at(-1)!) as [string, [number, number]];
    expect(first).toBe("Page one");
    // The person's window is theirs: it is the size it was, not the size a cell's own browser gets.
    expect(inside).toEqual([before.width, before.height]);
    expect(result.screenshots).toHaveLength(1);

    // Their tab is still open, on the page the cell left it on, and their Chrome still answers.
    expect(alive(chrome.pid)).toBe(true);
    expect(await pageUrls(chrome)).toEqual([pages.url("/two")]);
    expect(await personTab(chrome)).toEqual({ url: pages.url("/two"), width: before.width, height: before.height });
    // The pack kept nothing: no browser entry of its own is left to idle-close or to count against the four.
    expect(await valueOf(code, "s1", "typeof browser.tabs === 'function' && (await browser.tabs()).length")).toBe(0);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("app.target picks the tab whose URL or title contains it; a target that matches none lists the pages", async () => {
    const chrome = await startDebugChrome();
    await personTab(chrome, pages.url("/one"));
    await fetch(`${chrome.cdpUrl}/json/new?${encodeURIComponent(pages.url("/two"))}`, { method: "PUT" });
    await waitUntil("the second tab", async () => (await pageUrls(chrome)).length, count => count === 2, 10_000);
    const cdp = JSON.stringify(chrome.cdpUrl);
    const code = await start();

    expect(await valueOf(code, "s1", `const tab = await browser.open({ app: { cdp_url: ${cdp}, target: "Page two" } }); await tab.title()`)).toBe("Page two");
    const refused = await failureOf(code, "s1", `await browser.open({ name: "other", app: { cdp_url: ${cdp}, target: "nothing-like-this" } })`);
    expect(refused.message).toContain('No page target matched "nothing-like-this". Available pages:');
    expect(refused.message).toContain(pages.url("/one"));
    expect(refused.message).toContain(pages.url("/two"));
  }, BROWSER_TEST_TIMEOUT_MS);

  test("the worker is told the page is the person's: adopted not created, and not raised for a screenshot unless app.target named it", async () => {
    const chrome = await startDebugChrome();
    await personTab(chrome, pages.url("/one"));
    const handles: TabHandle[] = [];
    const code = await start({ spawn: tapSpawn(handles) });
    const cdp = JSON.stringify(chrome.cdpUrl);
    await valueOf(code, "s1", `await browser.open({ name: "front", app: { cdp_url: ${cdp} } }); 0`);
    await valueOf(code, "s1", `await browser.open({ name: "named", app: { cdp_url: ${cdp}, target: "Page one" } }); 0`);
    expect(handles.map(handle => ({ name: handle.kind, created: handle.created, activate: handle.activateForScreenshot }))).toEqual([
      { name: "connected", created: false, activate: false },
      { name: "connected", created: false, activate: true },
    ]);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a dialog on the person's page is not answered for the cell: it waits for the cell's own handler, or for the policy the cell asked for", async () => {
    const chrome = await startDebugChrome();
    await personTab(chrome, pages.url("/dialog"));
    const cdp = JSON.stringify(chrome.cdpUrl);
    const code = await start();

    // No policy: OMP leaves the dialog to the cell, so the cell's handler is the one that answers (a throwaway's engine would have dismissed the confirm first).
    expect(await valueOf(code, "s1", `
      const tab = await browser.open({ app: { cdp_url: ${cdp} } });
      await tab.run(async ({ page }) => {
        // The cell takes its time: an engine that answered first would have dismissed the confirm already, whoever the dialog belonged to.
        page.once("dialog", async dialog => {
          await new Promise(resolve => setTimeout(resolve, 400));
          await dialog.accept();
        });
        await page.click("#ask");
        await page.waitForFunction(() => document.title.startsWith("asked:"));
      });
      await tab.title();
    `)).toBe("asked:true");

    // dialogs: "dismiss" is the policy; from then on the engine answers, as it does for every tab the pack opens.
    expect(await valueOf(code, "s1", `
      const tab = await browser.open({ app: { cdp_url: ${cdp} }, dialogs: "dismiss" });
      await tab.run(async ({ page }) => {
        await page.evaluate(() => { document.title = "again"; });
        await page.click("#ask");
        await page.waitForFunction(() => document.title.startsWith("asked:"));
      });
      await tab.title();
    `)).toBe("asked:false");
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a browser nobody calls for the idle period is let go of, the cell is told why, and the person's Chrome is untouched", async () => {
    const chrome = await startDebugChrome();
    await personTab(chrome, pages.url("/one"));
    const code = await start({ idleMs: 400 });
    await valueOf(code, "s1", `await browser.open({ app: { cdp_url: ${JSON.stringify(chrome.cdpUrl)} } }); 0`);
    await Bun.sleep(1_500); // real time: the idle clock is the thing under test
    const error = await failureOf(code, "s1", "await browser.tab('main').title()");
    expect(error.message).toContain("it was a code browser, closed after 0.4 s with no calls");
    expect(alive(chrome.pid)).toBe(true);
    expect(await pageUrls(chrome)).toEqual([pages.url("/one")]);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a websocket URL is refused with OMP's text, and an endpoint nothing answers on fails naming it when the connection's 5 s wait is up", async () => {
    const code = await start();
    expect((await failureOf(code, "s1", 'await browser.open({ app: { cdp_url: "ws://127.0.0.1:9/devtools/browser/x" } })')).message)
      .toContain("browser app.cdp_url must be the HTTP CDP discovery endpoint (for example http://127.0.0.1:9222), not a ws:// browser websocket URL.");
    const refused = await failureOf(code, "s1", 'await browser.open({ app: { cdp_url: "http://127.0.0.1:9" } })');
    expect(refused.message).toContain("http://127.0.0.1:9");
  }, BROWSER_TEST_TIMEOUT_MS);

  test("no open or reuse that carries a viewport resizes the person's window: the first open, a second tab name on the same Chrome, and a reopen of a name", async () => {
    const chrome = await startDebugChrome();
    await personTab(chrome, pages.url("/one"));
    const before = await personMetrics(chrome);
    const cdp = JSON.stringify(chrome.cdpUrl);
    const code = await start();
    const asked = "viewport: { width: 1000, height: 700, scale: 2 }";
    expect(before).not.toEqual([1000, 700, 2]);

    await valueOf(code, "s1", `await browser.open({ name: "a", app: { cdp_url: ${cdp} }, ${asked} }); 0`);
    expect(await personMetrics(chrome)).toEqual(before);
    // Another name on the same endpoint finds the browser the session holds: this is the path that used to resize.
    await valueOf(code, "s1", `await browser.open({ name: "b", app: { cdp_url: ${cdp} }, ${asked} }); 0`);
    expect(await personMetrics(chrome)).toEqual(before);
    // A reopen of a name that exists.
    await valueOf(code, "s1", `await browser.open({ name: "a", app: { cdp_url: ${cdp} }, ${asked} }); 0`);
    expect(await personMetrics(chrome)).toEqual(before);
    // The cell sees the person's window too, not the size it asked for.
    expect(await valueOf(code, "s1", "JSON.stringify(await browser.tab('a').evaluate(() => [innerWidth, innerHeight, devicePixelRatio]))")).toEqual(before);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("DIMENSION_BROWSER_CDP_URL makes a plain open connect", async () => {
    const chrome = await startDebugChrome();
    await personTab(chrome, pages.url("/one"));
    const code = await start({ env: { DIMENSION_BROWSER_CDP_URL: chrome.cdpUrl } });
    const result = await cell(code, "s1", "await browser.open({ name: 'main' }); 0");
    if (isFailure(result)) throw new Error(result.error.message);
    expect(textOf(result)).toContain(`Opened tab "main" on connected ${chrome.cdpUrl}`);
  }, BROWSER_TEST_TIMEOUT_MS);
});

/** What a machine with the application not running looks like: every other Chrome on it (a test's, a person's) is out of sight, so a spawned open starts its own. */
const NOTHING_RUNNING: ProcessScanner = { running: async () => ({ processes: [], unreadable: false }) };
const spawnOwn: typeof establishKind = (kind, options) => establishKind(kind, { ...options, scanner: NOTHING_RUNNING });

describeWithChrome("spawned: a cell starts an application and drives it", () => {
  async function appArgs(): Promise<string> {
    const userDataDir = await mkdtemp(join(tmpdir(), "dimension-code-kinds-"));
    scratch.push(userDataDir);
    // headless: a cell on a test must never put a window in front of the person.
    return JSON.stringify(["--headless=new", `--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"]);
  }

  /** The pid a spawned open names in its first line. */
  function pidOf(text: string): number {
    const match = /\(pid (\d+)\)/.exec(text);
    if (!match) throw new Error(`no pid in: ${text}`);
    return Number(match[1]);
  }

  test("it is started with a debugging port and named with its pid, and closing the tab leaves it running", async () => {
    if (chromePath === undefined) throw new Error("no Chrome");
    const args = await appArgs();
    const code = await start({ establish: spawnOwn });
    const result = await cell(code, "s1", `
      const tab = await browser.open({ app: { path: ${JSON.stringify(chromePath)}, args: ${args} }, url: ${JSON.stringify(pages.url("/one"))} });
      const title = await tab.title();
      await browser.close();
      title;
    `);
    if (isFailure(result)) throw new Error(`${result.error.name}: ${result.error.message}`);
    const pid = pidOf(textOf(result));
    try {
      expect(textOf(result)).toContain(`Opened tab "main" on spawned ${chromePath} (pid ${pid})`);
      expect(textOf(result).split("\n").at(-1)).toBe("Page one");
      // Not the pack's to end when a cell only lets go: it stays open, as in OMP.
      expect(alive(pid)).toBe(true);
    } finally {
      await killTree(pid);
      expect(await gone(pid)).toBe(true);
    }
  }, BROWSER_TEST_TIMEOUT_MS);

  test("close({ kill: true }) ends the application the pack started, and nothing else", async () => {
    if (chromePath === undefined) throw new Error("no Chrome");
    // Another program on the machine, standing in for the person's other applications: it must be exactly as alive afterwards.
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    const bystanderPid = bystander.pid!;
    stoppers.push(async () => {
      await killTree(bystanderPid);
    });
    const args = await appArgs();
    const code = await start({ establish: spawnOwn });
    const result = await cell(code, "s1", `
      await browser.open({ app: { path: ${JSON.stringify(chromePath)}, args: ${args} } });
      await browser.close({ kill: true });
      0;
    `);
    if (isFailure(result)) throw new Error(`${result.error.name}: ${result.error.message}`);
    const pid = pidOf(textOf(result));
    try {
      expect(pid).not.toBe(bystanderPid);
      expect(await gone(pid)).toBe(true);
      expect(alive(bystanderPid)).toBe(true);
    } finally {
      await killTree(pid);
    }
  }, BROWSER_TEST_TIMEOUT_MS);

  test("an instance already running with a debugging port is adopted, not started twice, and close({ kill: true }) does not end it: the pack did not start it", async () => {
    if (chromePath === undefined) throw new Error("no Chrome");
    const running = await startDebugChrome();
    await personTab(running, pages.url("/one"));
    const exe = chromePath;
    const sees: ProcessScanner = { running: async () => ({ processes: [{ pid: running.pid, args: [exe, "--headless=new", `--remote-debugging-port=${running.port}`] }], unreadable: false }) };
    const code = await start({ establish: (kind, options) => establishKind(kind, { ...options, scanner: sees }) });
    const result = await cell(code, "s1", `
      const tab = await browser.open({ app: { path: ${JSON.stringify(chromePath)} } });
      const title = await tab.title();
      await browser.close({ kill: true });
      title;
    `);
    if (isFailure(result)) throw new Error(`${result.error.name}: ${result.error.message}`);
    expect(textOf(result)).toContain(`Opened tab "main" on spawned ${chromePath} (pid ${running.pid})`);
    expect(textOf(result).split("\n").at(-1)).toBe("Page one");
    // The person's own Chrome, given as an application path: still running, with its page.
    expect(alive(running.pid)).toBe(true);
    expect(await pageUrls(running)).toEqual([pages.url("/one")]);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("an open given up while the runtime attaches to the application it started ends that application: nothing is left running by pid", async () => {
    if (chromePath === undefined) throw new Error("no Chrome");
    const userDataDir = await mkdtemp(join(tmpdir(), "dimension-code-kinds-"));
    scratch.push(userDataDir);
    const started: number[] = [];
    const cancel = new AbortController();
    const runtime = newRuntime(await createRoot());
    const real = runtime.codeSeam();
    // The cell's deadline passes at the moment the runtime begins to attach: the application is up, and nobody waits for the open.
    const seam: CodeSeam = { ...real, open: async (...args) => (cancel.abort(), await real.open(...args)) };
    const port = new RuntimeCodeBrowsers(seam, {
      establish: async (kind, options) => {
        const made = await establishKind(kind, { ...options, scanner: NOTHING_RUNNING });
        if ("attach" in made && made.attach.pid !== undefined) started.push(made.attach.pid);
        return made;
      },
    });
    const kind: BrowserKind = { kind: "spawned", path: chromePath, args: ["--headless=new", `--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"] };
    try {
      await port.acquire("s1", { kind }, cancel.signal).catch(() => undefined);
      await waitUntil("the application the open started to be ended", async () => started.length === 1 && (await gone(started[0]!, 1_000)), done => done, 30_000);
      expect(real.browsersOf("s1")).toEqual([]);
    } finally {
      for (const pid of started) await killTree(pid);
    }
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a relative app.path is made absolute against the host's folder before it is asked for", async () => {
    const code = await start({ establish: spawnOwn });
    const refused = await failureOf(code, "s1", 'await browser.open({ app: { path: "no-such-dir/no-such-app" }, timeout: 5 })');
    expect(refused.message).toContain("no-such-app");
  }, BROWSER_TEST_TIMEOUT_MS);
});

describeWithChrome("relay: a cell drives the person's own Chrome through the pack's relay", () => {
  async function relayRig(options: RigOptions = {}): Promise<{ code: CodeHost; chrome: DebugChrome; extension: FakeExtension; relayUrl: string }> {
    const chrome = await startDebugChrome();
    const relay = await startRelayHost();
    const extension = startFakeExtension(chrome, { port: relay.port });
    extensions.push(extension);
    await extension.openByHand(pages.url("/one"));
    await waitUntil("the extension to dial in", async () => (await fetch(`${relay.url}/json/version`)).status, status => status === 200, 20_000);
    const code = await start({ ...options, env: { DIMENSION_BROWSER_RELAY_URL: relay.url, ...options.env } });
    return { code, chrome, extension, relayUrl: relay.url };
  }

  test("app.relay opens the person's tab through the relay, a cell navigates it, and closing leaves it open with the debugger let go of", async () => {
    const { code, chrome, extension, relayUrl } = await relayRig();
    const result = await cell(code, "s1", `
      const tab = await browser.open({ app: { relay: true } });
      const first = await tab.title();
      await tab.goto(${JSON.stringify(pages.url("/two"))});
      const second = await tab.title();
      await browser.close();
      JSON.stringify([first, second]);
    `);
    if (isFailure(result)) throw new Error(`${result.error.name}: ${result.error.message}`);
    expect(textOf(result)).toContain(`Opened tab "main" on relay ${relayUrl}`);
    expect(JSON.parse(textOf(result).split("\n").at(-1)!)).toEqual(["Page one", "Page two"]);
    // The person's tab is still there, and the extension no longer holds the debugger on any tab.
    expect(await pageUrls(chrome)).toContain(pages.url("/two"));
    await waitUntil("the extension to release the debugger on every tab", () => extension.attachedPages().length, count => count === 0, 15_000);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("DIMENSION_BROWSER_RELAY=1 makes a plain open use the relay, and =0 refuses app.relay with the reason", async () => {
    const { code } = await relayRig({ env: { DIMENSION_BROWSER_RELAY: "1" } });
    const result = await cell(code, "s1", "await browser.open({ name: 'main' }); 0");
    if (isFailure(result)) throw new Error(result.error.message);
    expect(textOf(result)).toMatch(/Opened tab "main" on relay http:\/\/127\.0\.0\.1:\d+/);

    await host?.dispose();
    const off = await start({ env: { DIMENSION_BROWSER_RELAY: "0" } });
    expect((await failureOf(off, "s2", "await browser.open({ app: { relay: true } })")).message).toContain("DIMENSION_BROWSER_RELAY=0");
  }, BROWSER_TEST_TIMEOUT_MS);

  test("the relay's browser has its own idle clock too: let go of when nobody calls, the person's tab untouched", async () => {
    const { code, chrome, extension } = await relayRig({ idleMs: 500 });
    const tabsBefore = await pageUrls(chrome);
    await valueOf(code, "s1", "await browser.open({ app: { relay: true } }); 0");
    await Bun.sleep(1_800); // real time: the idle clock is the thing under test
    const error = await failureOf(code, "s1", "await browser.tab('main').title()");
    expect(error.message).toContain("it was a code browser, closed after 0.5 s with no calls");
    expect(await pageUrls(chrome)).toEqual(tabsBefore);
    expect(tabsBefore).toContain(pages.url("/one"));
    await waitUntil("the extension to release the debugger", () => extension.attachedPages().length, count => count === 0, 15_000);
  }, BROWSER_TEST_TIMEOUT_MS);
});

const PAGE: FakePage = { url: "about:blank", title: "Fake page", html: "<h1>fake</h1> Fake page text", refs: { "@e1": { role: "button", name: "Go" } } };

async function cmuxRig(daemon: Parameters<typeof startFakeCmux>[0] = {}, env: Record<string, string> = {}, rig: Pick<RigOptions, "spawn"> = {}): Promise<{ code: CodeHost; fake: FakeCmux; closed: string[] }> {
  const { handler, closed } = pageHandler({ ...PAGE }, undefined);
  const fake = await startFakeCmux({ ...daemon, handler });
  fakes.push(fake);
  const code = await start({ env: { CMUX_SOCKET_PATH: fake.socketPath, ...env }, ...rig });
  return { code, fake, closed };
}

describeWithChrome("cmux: a cell drives a surface of the terminal app it runs in (a fake daemon speaking cmux's protocol)", () => {
  test("a plain open inside cmux opens a split, the cell reads and navigates it, and closing the tab closes the split", async () => {
    const { code, fake, closed } = await cmuxRig();
    const result = await cell(code, "s1", `
      const tab = await browser.open({ url: "https://example.test/start" });
      const seen = await tab.observe();
      await tab.goto("https://example.test/next");
      const url = await tab.url();
      await browser.close();
      JSON.stringify([seen.url, seen.title, url]);
    `);
    if (isFailure(result)) throw new Error(`${result.error.name}: ${result.error.message}`);
    expect(textOf(result)).toContain('Opened tab "main" on cmux browser (split)');
    expect(JSON.parse(textOf(result).split("\n").at(-1)!)).toEqual(["https://example.test/start", "Fake page", "https://example.test/next"]);
    expect(fake.requests.find(request => request.method === "browser.open_split")?.params).toMatchObject({ url: "https://example.test/start", focus: false });
    expect(fake.requests.find(request => request.method === "browser.navigate")?.params).toMatchObject({ url: "https://example.test/next", surface_id: "surface-uuid-1" });
    expect(closed).toEqual(["surface-uuid-1"]);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a second open of the same name navigates the surface it has; another name opens a second split; browser.tabs() lists both", async () => {
    const { code, fake, closed } = await cmuxRig();
    const result = await cell(code, "s1", `
      await browser.open({ name: "a", url: "https://example.test/a" });
      await browser.open({ name: "a", url: "https://example.test/again" });
      await browser.open({ name: "b", url: "https://example.test/b" });
      JSON.stringify((await browser.tabs()).map(tab => tab.id));
    `);
    if (isFailure(result)) throw new Error(`${result.error.name}: ${result.error.message}`);
    expect(textOf(result)).toContain('Reused tab "a" on cmux browser (split)');
    expect(JSON.parse(textOf(result).split("\n").at(-1)!)).toEqual(["surface-uuid-1", "surface-uuid-2"]);
    expect(fake.requests.filter(request => request.method === "browser.open_split")).toHaveLength(2);
    expect(closed).toEqual([]);
    // Closing the server closes the splits the pack opened and no others.
    await host?.dispose();
    host = undefined;
    expect(closed.sort()).toEqual(["surface-uuid-1", "surface-uuid-2"]);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("the worker is handed the surface and the way to the daemon, and the surface is not a CDP target", async () => {
    const handles: TabHandle[] = [];
    const { code, fake } = await cmuxRig({ password: "s3cret" }, { CMUX_SOCKET_PASSWORD: "s3cret" }, { spawn: tapSpawn(handles) });
    await valueOf(code, "s1", 'await browser.open({ url: "https://example.test/x" }); 0');
    expect(handles).toHaveLength(1);
    expect(handles[0]).toMatchObject({ kind: "cmux", tabId: "surface-uuid-1", targetId: "surface-uuid-1", wsEndpoint: "", url: "https://example.test/x", cmux: { socketPath: fake.socketPath, password: "s3cret" } });
  }, BROWSER_TEST_TIMEOUT_MS);

  test("the daemon's password reaches the daemon and never the cell: the worker's own environment has none, and the cell still drives the surface", async () => {
    const { code } = await cmuxRig({ password: "s3cret" }, { CMUX_SOCKET_PASSWORD: "s3cret" });
    expect(await valueOf(code, "s1", `
      const tab = await browser.open({ url: "https://example.test/x" });
      JSON.stringify([await tab.title(), process.env.CMUX_SOCKET_PASSWORD ?? "unset", process.env.CMUX_SOCKET_PATH ?? "unset"]);
    `)).toEqual(["Fake page", "unset", "unset"]);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("DIMENSION_BROWSER_CMUX=0 turns cmux off even where a socket is named: the open is a headless browser", async () => {
    const { code, fake } = await cmuxRig({}, { DIMENSION_BROWSER_CMUX: "0" });
    const result = await cell(code, "s1", `await browser.open({ url: ${JSON.stringify(pages.url("/one"))} }); 0`);
    if (isFailure(result)) throw new Error(`${result.error.name}: ${result.error.message}`);
    expect(textOf(result)).toContain('Opened tab "main" on headless browser (hidden)');
    expect(fake.requests).toEqual([]);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a daemon that is not there is a refusal the cell can read, not a crash", async () => {
    const code = await start({ env: { CMUX_SOCKET_PATH: join(tmpdir(), "dimension-cmux-nobody-home.sock") } });
    expect((await failureOf(code, "s1", "await browser.open({ url: 'https://example.test/' })")).message).toContain("Failed to connect to cmux socket");
  }, BROWSER_TEST_TIMEOUT_MS);
});

describe("freezing", () => {
  /** A seam whose one browser is `kind`, and every freeze its driver was asked for. */
  function portOver(kind: BrowserKind): { port: RuntimeCodeBrowsers; frozen: string[] } {
    const frozen: string[] = [];
    const entry = { browserId: "b", code: { idleMs: 1, persist: false, kind }, driver: { setFrozen: async (tabId: string, on: boolean): Promise<void> => void frozen.push(`${tabId}:${on}`) } };
    return { port: new RuntimeCodeBrowsers({ require: () => entry } as unknown as CodeSeam, {}), frozen };
  }

  test("the pages of a browser the pack only attached to are never frozen: they are the person's", async () => {
    for (const kind of [{ kind: "connected", cdpUrl: "http://x" }, { kind: "relay", cdpUrl: "http://x" }, { kind: "spawned", path: "/x" }] satisfies BrowserKind[]) {
      const { port, frozen } = portOver(kind);
      await port.setFrozen("b", "tab", true);
      expect(frozen).toEqual([]);
    }
  });

  test("a Chromium of the pack's is frozen and thawed as asked", async () => {
    const { port, frozen } = portOver({ kind: "headless", headless: true });
    await port.setFrozen("b", "tab", true);
    await port.setFrozen("b", "tab", false);
    expect(frozen).toEqual(["tab:true", "tab:false"]);
  });
});

describeWithChrome("two kinds of browser in one session", () => {
  test("opens that start together on different kinds each get their own browser: a connected Chrome and a cmux surface", async () => {
    const chrome = await startDebugChrome();
    await personTab(chrome, pages.url("/one"));
    const { code, closed } = await cmuxRig();
    const result = await cell(code, "s1", `
      await Promise.all([
        browser.open({ name: "chrome", app: { cdp_url: ${JSON.stringify(chrome.cdpUrl)} } }),
        browser.open({ name: "split", url: "https://example.test/split" }),
      ]);
      JSON.stringify([await browser.tab("chrome").title(), await browser.tab("split").title(), (await browser.tabs()).length]);
    `);
    if (isFailure(result)) throw new Error(`${result.error.name}: ${result.error.message}`);
    expect(textOf(result)).toContain(`on connected ${chrome.cdpUrl}`);
    expect(textOf(result)).toContain("on cmux browser (split)");
    expect(JSON.parse(textOf(result).split("\n").at(-1)!)).toEqual(["Page one", "Fake page", 2]);
    // Closing one leaves the other: the person's tab is not the split's to close.
    await valueOf(code, "s1", `await browser.tab("split").close(); 0`);
    expect(closed).toEqual(["surface-uuid-1"]);
    expect(await pageUrls(chrome)).toEqual([pages.url("/one")]);
    expect(await valueOf(code, "s1", `await browser.tab("chrome").title()`)).toBe("Page one");
  }, BROWSER_TEST_TIMEOUT_MS);
});

describe("acquiring a browser of a kind", () => {
  interface FakeEntry { browserId: string; code?: unknown; closed: boolean; opener: unknown; profile: null; engine: string; driver: { cdpEndpoint(): string }; viewers: number; pending: number; lastUsed: number }

  /** A runtime that attaches to whatever it is given (after a turn of the event loop, so opens really overlap) and records it, and an `establish` that answers for any endpoint. */
  function fakes(): { port: RuntimeCodeBrowsers; attached: string[]; closed: string[]; established: Array<{ url: string; signal: AbortSignal | undefined }> } {
    const entries = new Map<string, FakeEntry>();
    const attached: string[] = [];
    const closed: string[] = [];
    const established: Array<{ url: string; signal: AbortSignal | undefined }> = [];
    const seam = {
      async open(_options: unknown, opener: unknown, code: unknown, attach?: { cdpUrl: string }) {
        await Promise.resolve();
        const browserId = `b${entries.size + 1}`;
        entries.set(browserId, { browserId, code, closed: false, opener, profile: null, engine: "chrome-relay", driver: { cdpEndpoint: () => `ws://fake/${browserId}` }, viewers: 0, pending: 0, lastUsed: 0 });
        attached.push(attach!.cdpUrl);
        return { browserId };
      },
      require: (browserId: string) => entries.get(browserId)!,
      browsersOf: () => [...entries.values()],
      viewOf: () => undefined,
      bindView: () => undefined,
      async close(browserId: string) {
        closed.push(browserId);
        entries.delete(browserId);
      },
    } as unknown as CodeSeam;
    const establish = (async (kind: { kind: string; cdpUrl: string }, options: { signal?: AbortSignal }) => {
      established.push({ url: kind.cdpUrl, signal: options.signal });
      await Bun.sleep(30); // real time: two opens must overlap, and a third must arrive while they do
      return { attach: { kind: kind.kind, cdpUrl: kind.cdpUrl, label: `${kind.kind} ${kind.cdpUrl}` } };
    }) as unknown as typeof establishKind;
    return { port: new RuntimeCodeBrowsers(seam, { establish }), attached, closed, established };
  }

  const A: BrowserKind = { kind: "connected", cdpUrl: "http://127.0.0.1:1111" };
  const B: BrowserKind = { kind: "connected", cdpUrl: "http://127.0.0.1:2222" };
  const never = new AbortController().signal;

  test("opens that start together share a browser only when they name the same one", async () => {
    const { port, attached } = fakes();
    const [a, b, again] = await Promise.all([port.acquire("s", { kind: A }, never), port.acquire("s", { kind: B }, never), port.acquire("s", { kind: A }, never)]);
    expect(a.browserId).not.toBe(b.browserId);
    expect(again).toMatchObject({ browserId: a.browserId, created: false });
    expect(a.created).toBe(true);
    expect(attached.sort()).toEqual([A.kind === "connected" ? A.cdpUrl : "", B.kind === "connected" ? B.cdpUrl : ""].sort());
  });

  test("the wait for a browser that is starting ends when nobody is waiting for it any more, and what it made is let go of", async () => {
    const { port, established, attached, closed } = fakes();
    const gone = new AbortController();
    const waiting = port.acquire("s", { kind: A }, gone.signal).catch((error: unknown) => error);
    gone.abort();
    await waiting;
    expect(established).toHaveLength(1);
    expect(established[0]!.signal?.aborted).toBe(true);
    // Whatever the open had made by then is not left holding a slot for a cell that has gone.
    await waitUntil("every browser the abandoned open made to be closed", () => ({ made: attached.length, closed: closed.length }), now => now.made === now.closed, 2_000);
  });
});

describeWithChrome("PUPPETEER_PROXY: the Chrome a cell launches goes through the proxy the environment names", () => {
  const OFF_MACHINE = 'await browser.open({ url: "http://dimension-no-such-host.invalid/" })';

  test("a page off the machine fails at the proxy when the variable names one that is not there, and not at a proxy when it is unset", async () => {
    process.env.PUPPETEER_PROXY = "http://127.0.0.1:9"; // nothing listens on the discard port
    try {
      const proxied = await failureOf(await start(), "s1", OFF_MACHINE);
      expect(proxied.message).toContain("ERR_PROXY_CONNECTION_FAILED");
    } finally {
      delete process.env.PUPPETEER_PROXY;
    }
    // One Chrome at a time: the first is gone before the second starts.
    await host?.dispose();
    await teardown();
    const direct = await failureOf(await start(), "s2", OFF_MACHINE);
    expect(direct.message).not.toContain("ERR_PROXY_CONNECTION_FAILED");
  }, BROWSER_TEST_TIMEOUT_MS);
});
