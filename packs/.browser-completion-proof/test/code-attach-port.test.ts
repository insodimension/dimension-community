/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a cell that drives the person's own browser (or an application it started, or a cmux surface) touches what is theirs, or holds something nobody waits for. A later
 * `browser.open({ viewport })` resizes the window the person is looking at; a spawned application opens on a different page than the one OMP would give; a cmux connection a cell gave up on stays registered for
 * thirty minutes; the relay the server started keeps the person's Chrome in its debugging bar after the server has gone. Each test states the rule at the port or the server it is kept by, with the runtime scripted
 * at its seam where a real Chrome would add nothing; the same rules on a real Chrome are in code-kinds.test.ts and attach-engine.test.ts.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { Browser, Page, Target } from "puppeteer-core";
import { RuntimeCodeBrowsers, type CodeSeam } from "../src/code/host/runtime-port";
import type { AcquiredBrowser, BrowserKind } from "../src/code/contracts";
import { savedProfileRefusal } from "../src/code/refusals";
import { CmuxBrowsers } from "../src/code/kinds/cmux/cmux-browsers";
import { findFreeCdpPort } from "../src/code/kinds/cdp";
import { ensureRelay, probeRelayServer } from "../src/code/kinds/relay/ensure";
import { pickAttachedPage } from "../src/engines/attach";
import { createBrowserServer } from "../src/server";
import { createRoot, newRuntime, teardown } from "./fixture";

afterEach(async () => {
  await teardown();
});

const never = new AbortController().signal;
function nextTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

describe("the person's pages are never resized by a later open or reuse that carries a viewport", () => {
  const VIEWPORT = { width: 800, height: 600, scale: 2 };

  function over(kind: BrowserKind): { port: RuntimeCodeBrowsers; resized: unknown[][] } {
    const resized: unknown[][] = [];
    const entry = { browserId: "b", code: { idleMs: 1, persist: false, kind } };
    const seam = { require: () => entry, resize: async (...args: unknown[]) => void resized.push(args) } as unknown as CodeSeam;
    return { port: new RuntimeCodeBrowsers(seam), resized };
  }

  test("a connected, a spawned and a relay browser keep the size they have", async () => {
    for (const kind of [{ kind: "connected", cdpUrl: "http://x" }, { kind: "spawned", path: "/x" }, { kind: "relay", cdpUrl: "http://x" }] satisfies BrowserKind[]) {
      const { port, resized } = over(kind);
      await port.resize("b", VIEWPORT);
      expect(resized).toEqual([]);
    }
  });

  test("a Chromium of the pack's is resized as asked, to the size and the pixel ratio", async () => {
    const { port, resized } = over({ kind: "headless", headless: true });
    await port.resize("b", VIEWPORT);
    expect(resized).toEqual([["b", { width: 800, height: 600 }, 2]]);
  });
});

describe("which page of an attached browser a cell gets", () => {
  interface AdoptCall { match?: string; preferVisible?: boolean }

  /** A seam whose one browser has `kind`, and every adoption its driver was asked for. */
  function over(kind: BrowserKind): { port: RuntimeCodeBrowsers; adopted: AdoptCall[] } {
    const adopted: AdoptCall[] = [];
    const ref = { tabId: "t", targetId: "t", url: "about:blank", title: "", active: true };
    const driver = { adoptTab: async (call: AdoptCall) => (adopted.push(call), ref), setDialogPolicy: () => undefined, navigateTab: async () => ref };
    const entry = { browserId: "b", code: { idleMs: 1, persist: false, kind }, driver };
    const seam = { require: () => entry, serialize: async <T>(_entry: unknown, work: () => Promise<T>) => await work() } as unknown as CodeSeam;
    return { port: new RuntimeCodeBrowsers(seam), adopted };
  }

  test("the page in front is what a person's Chrome gives, and only there: an application the pack started gets its first page", async () => {
    const cases: Array<[BrowserKind, boolean]> = [
      [{ kind: "connected", cdpUrl: "http://x" }, true],
      [{ kind: "relay", cdpUrl: "http://x" }, true],
      [{ kind: "spawned", path: "/x" }, false],
    ];
    for (const [kind, front] of cases) {
      const { port, adopted } = over(kind);
      await port.openTab("b", { timeoutMs: 1_000 }, never);
      expect(adopted).toEqual([{ preferVisible: front }]);
    }
  });

  test("a target the cell named is matched, whatever is in front", async () => {
    const { port, adopted } = over({ kind: "connected", cdpUrl: "http://x" });
    await port.openTab("b", { target: "Page two", timeoutMs: 1_000 }, never);
    expect(adopted).toEqual([{ match: "Page two", preferVisible: false }]);
  });

  /** A browser with three pages, the second of which is the one in front. */
  function browserWithPages(): Browser {
    const pages = ["one", "two", "three"].map((name, index): Page => ({ url: () => `http://x/${name}`, title: async () => name, evaluate: async () => index === 1 }) as unknown as Page);
    const targets = pages.map((page): Target => ({ type: () => "page", page: async () => page }) as unknown as Target);
    return { targets: () => targets, pages: async () => pages } as unknown as Browser;
  }

  test("the picker takes the page in front when asked, and the first in CDP order otherwise", async () => {
    expect((await pickAttachedPage(browserWithPages(), { preferVisible: true })).url()).toBe("http://x/two");
    expect((await pickAttachedPage(browserWithPages(), { preferVisible: false })).url()).toBe("http://x/one");
  });
});

/** How `work` stands after one turn of the event loop: what it rejected with, or that it is still waiting (a wait nothing bounds). */
async function standingAfterATurn(work: Promise<unknown>): Promise<string> {
  return await Promise.race([work.then(() => "resolved", (error: Error) => error.message), nextTurn().then(() => "still waiting")]);
}

describe("a cmux open is bounded by the open's deadline and lets go of a connection nobody waits for", () => {
  const CMUX: BrowserKind = { kind: "cmux", socketPath: "/tmp/cmux.sock" };

  /** A cmux whose daemon answers when the test says so. */
  function slowCmux(): { cmux: CmuxBrowsers; answer: () => void; released: string[] } {
    const released: string[] = [];
    const held = new Set<string>();
    const connected = Promise.withResolvers<void>();
    const cmux = {
      owns: (browserId: string) => held.has(browserId),
      async acquire(): Promise<AcquiredBrowser> {
        await connected.promise;
        held.add("cmux-1");
        return { browserId: "cmux-1", created: true, wsEndpoint: "" };
      },
      async release(browserId: string) {
        released.push(browserId);
        held.delete(browserId);
      },
      onEnd: () => () => undefined,
    } as unknown as CmuxBrowsers;
    return { cmux, answer: () => connected.resolve(), released };
  }

  test("a deadline that passes while the daemon does not answer ends the wait at once, and the connection that arrives late is let go of", async () => {
    const { cmux, answer, released } = slowCmux();
    const port = new RuntimeCodeBrowsers({} as CodeSeam, { cmux });
    const deadline = new AbortController();
    const waiting = port.acquire("s", { kind: CMUX }, deadline.signal);
    deadline.abort(new Error("deadline"));
    expect(await standingAfterATurn(waiting)).toBe("deadline");
    expect(released).toEqual([]);
    answer();
    await nextTurn();
    await nextTurn();
    expect(released).toEqual(["cmux-1"]);
  });

  test("a second open that shares the connection keeps it when the first gives up", async () => {
    const { cmux, answer, released } = slowCmux();
    const port = new RuntimeCodeBrowsers({} as CodeSeam, { cmux });
    const first = new AbortController();
    const abandoned = port.acquire("s", { kind: CMUX }, first.signal);
    const kept = port.acquire("s", { kind: CMUX }, never);
    first.abort(new Error("gave up"));
    expect(await standingAfterATurn(abandoned)).toBe("gave up");
    answer();
    expect(await kept).toMatchObject({ browserId: "cmux-1", created: false });
    await nextTurn();
    expect(released).toEqual([]);
  });
});

describe("the relay the server started stops with the server", () => {
  test("after the server is closed nothing serves the relay's port, and the next server can start its own", async () => {
    const root = await createRoot();
    const viewDir = join(root, "view");
    await mkdir(viewDir, { recursive: true });
    await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
    const server = await createBrowserServer({ runtime: newRuntime(root), viewDir, presets: [] });
    const cdpUrl = `http://127.0.0.1:${await findFreeCdpPort()}`;
    // What a cell's `app.relay: true` does: no relay serves the port, so this process starts one.
    expect(await ensureRelay({ cdpUrl })).toBe(true);
    expect(await probeRelayServer(cdpUrl)).toBe(true);

    await server.close();
    expect(await probeRelayServer(cdpUrl)).toBe(false);
  }, 60_000);
});

describe("a cell that asks for a saved profile is refused in the one text the model is taught", () => {
  test("code_needs_consent, with the words of savedProfileRefusal and no browser touched", async () => {
    const port = new RuntimeCodeBrowsers({} as CodeSeam);
    // `{}` is a seam with no methods: any call into the runtime would throw a TypeError instead of this refusal.
    await expect(port.acquire("s", { kind: { kind: "headless", headless: true }, profile: "work" }, never)).rejects.toMatchObject({ code: "code_needs_consent", message: savedProfileRefusal("work") });
  });
});
