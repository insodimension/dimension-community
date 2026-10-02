/**
 * What the tab realm's tests stand on: a real headless Chrome the test launches itself (it plays the engine: it makes the pages) and a local
 * server with the pages the matrix names (form, long, slow, dialog, drag, redirect, article). The realm adopts a page from that Chrome by
 * targetId over a second CDP connection, exactly as the code worker adopts what the engine opened.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type { TabHandle } from "../src/code/contracts";
import { chromePath } from "./fixture";

export { chromePath };

const FORM = `<!doctype html><meta charset="utf-8"><title>Fixture form</title>
<style>
  body { font: 16px sans-serif; margin: 12px }
  #wrap { position: relative; width: 140px; height: 40px }
  #cover { position: absolute; inset: 0; background: #fff }
</style>
<h1>Fixture form</h1>
<label>Name <input id="name" type="text"></label>
<label><input id="agree" type="checkbox"> I agree</label>
<select id="color" aria-label="Colour"><option value="red">Red</option><option value="green">Green</option><option value="blue">Blue</option></select>
<button id="submit" onclick="document.getElementById('out').textContent = 'submitted:' + document.getElementById('name').value">Submit</button>
<div id="wrap"><button id="covered" onclick="document.getElementById('out').textContent = 'covered clicked'">Covered</button><div id="cover"></div></div>
<button id="hidden-btn" style="display:none">Hidden</button>
<label>Secret <input id="pw" type="password"></label>
<label>Upload <input id="file" type="file"></label>
<a id="go" href="/done">Go on</a>
<div id="out"></div>`;

const PAGES: Record<string, string> = {
  "/form": FORM,
  "/done": `<!doctype html><title>Done page</title><h1>All done</h1><button id="again">Again</button>`,
  "/long": `<!doctype html><title>Long</title><div style="height:4000px">tall</div><button id="bottom">Bottom</button>`,
  "/redirect": `<!doctype html><title>Redirect</title><p>wait for it</p><script>setTimeout(() => { location.href = "/done"; }, 400)</script>`,
  "/dialog": `<!doctype html><title>Dialog</title><button id="ask" onclick="alert('are you sure')">Ask</button>`,
  "/busy": `<!doctype html><title>Busy</title><button id="spin" onmousedown="const end = Date.now() + 3500; while (Date.now() < end) {}">Spin</button>`,
  // A two-step login: the password field is not there until a moment after "Next".
  "/twostep": `<!doctype html><title>Two step</title><label>Email <input id="email" type="text"></label>
<button id="next" onclick="setTimeout(() => { const i = document.createElement('input'); i.id = 'late-pw'; i.type = 'password'; document.body.appendChild(i); }, 600)">Next</button>`,
  // A field that reads as plain text for the first `reads` reads (default 1) and as a password after that: what a page swapping the element between a check and the typing looks like. The realm reads it once
  // for its own check and once for what holds focus; the fill's own predicate is the read after those.
  "/flaky": `<!doctype html><title>Flaky</title><input id="flaky" type="text"><script>
const f = document.getElementById("flaky"); let reads = 0; const text = Number(new URLSearchParams(location.search).get("reads") ?? "1");
Object.defineProperty(f, "type", { get() { reads += 1; return reads <= text ? "text" : "password"; } });
</script>`,
  // Where keys end up is not where a helper was pointed: a custom element that hands focus to the password field inside its shadow root, a field that moves focus to a password field when it gets it,
  // and a same-origin iframe holding the form (and so a password field of its own).
  "/delegate": `<!doctype html><title>Delegate</title><x-pw id="xpw"></x-pw><input id="plain" type="text"><script>
customElements.define("x-pw", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open", delegatesFocus: true }).innerHTML = '<input id="inner" type="password">'; } });
</script>`,
  "/focusmove": `<!doctype html><title>Focus move</title><input id="decoy" type="text" onfocus="document.getElementById('hidden-pw').focus()"><input id="hidden-pw" type="password">`,
  "/framed": `<!doctype html><title>Framed</title><iframe id="f" src="/form" width="600" height="300"></iframe><input id="top" type="text">`,
  "/drag": `<!doctype html><title>Drag</title>
<div id="a" style="position:absolute;left:20px;top:20px;width:60px;height:60px;background:#08f">a</div>
<div id="b" style="position:absolute;left:220px;top:120px;width:80px;height:80px;background:#f80">b</div>
<div id="log"></div>
<script>
  const log = document.getElementById("log");
  let down = false;
  document.getElementById("a").addEventListener("mousedown", () => { down = true; log.textContent = "down"; });
  document.addEventListener("mousemove", event => { if (down) log.dataset.last = event.clientX + "," + event.clientY; });
  document.addEventListener("mouseup", event => { if (down) { down = false; log.textContent = "up@" + event.clientX + "," + event.clientY; } });
</script>`,
  "/xhr": `<!doctype html><title>Xhr</title><script>setTimeout(() => fetch("/api/data?x=1"), 300)</script>`,
  // Two fetches, the second the one a waitForResponse predicate has to hold out for.
  "/xhr-two": `<!doctype html><title>Xhr two</title><script>setTimeout(() => fetch("/api/other"), 300); setTimeout(() => fetch("/api/data?x=2"), 700)</script>`,
  "/article": `<!doctype html><html><head><title>The article page</title></head><body>
<header><nav><a href="/">Home</a> <a href="/about">About</a></nav></header>
<main><article><h1>A real article</h1>
<p>${"The first paragraph carries enough prose for a readability pass to treat this as the article body. ".repeat(8)}</p>
<p>${"A second paragraph follows with further sentences about the subject at hand and its details. ".repeat(8)}</p>
<ul><li>one</li><li>two</li></ul></article></main><footer>copyright</footer></body></html>`,
};

export interface Fixture {
  /** Absolute URL for a path on the local server. */
  url(path: string): string;
  stop(): Promise<void>;
}

export async function startFixture(): Promise<Fixture> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/slow") {
      const ms = Number(url.searchParams.get("ms") ?? "1000");
      setTimeout(() => {
        response.setHeader("content-type", "text/html");
        response.end("<!doctype html><title>Slow</title><p>slow page</p>");
      }, ms);
      return;
    }
    if (url.pathname === "/api/data" || url.pathname === "/api/other") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    const page = PAGES[url.pathname];
    if (page === undefined) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(page);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: path => `http://127.0.0.1:${port}${path}`,
    stop: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface LaunchedChrome {
  browser: Browser;
  wsEndpoint: string;
  /** The Chrome root process: a test proves it is gone after `close`. */
  pid: number | undefined;
  /** What the engine does: open a page and hand over what the worker adopts. */
  openTab(url?: string): Promise<{ page: Page; handle: TabHandle }>;
  close(): Promise<void>;
}

/** The engine's own CDP handle on a page: puppeteer keeps the target id privately. */
export async function targetIdOf(page: Page): Promise<string> {
  const session = await page.createCDPSession();
  try {
    const { targetInfo } = await session.send("Target.getTargetInfo");
    return targetInfo.targetId;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

export async function launchChrome(browserId = "b1"): Promise<LaunchedChrome> {
  if (!chromePath) throw new Error("no Chrome to launch");
  const userDataDir = await mkdtemp(join(tmpdir(), "dimension-code-tab-"));
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    userDataDir,
    defaultViewport: { width: 1000, height: 700 },
    args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking"],
  });
  const wsEndpoint = browser.wsEndpoint();
  return {
    browser,
    wsEndpoint,
    pid: browser.process()?.pid,
    async openTab(url) {
      const page = await browser.newPage();
      // What the engine's prepareTab does: a tab behind another keeps rendering, or puppeteer's element actions wait for ever on a page that never paints.
      await page.emulateFocusedPage(true);
      if (url) await page.goto(url);
      const targetId = await targetIdOf(page);
      return {
        page,
        handle: { tabId: targetId, targetId, url: page.url(), title: await page.title(), active: true, browserId, wsEndpoint, kind: "headless", created: true },
      };
    },
    async close() {
      await browser.close().catch(() => undefined);
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
    },
  };
}
