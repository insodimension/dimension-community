/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a cell that names a saved
 *  profile with browser.open({ profile }) does not get the person's logins, or
 *  gets another profile's, or one profile's browser is forked with a second
 *  Chrome instead of shared per chat, or a reopen starts a second Chrome, or
 *  two racing opens start two Chromes on one profile, or a profile combined
 *  with app is opened or refused as an attach consent instead of the conflict
 *  it is; or a tab name
 *  already bound to one browser is silently served another (the signed-out
 *  throwaway navigated when the cell asked for a profile, a profile's tab
 *  answering for a different profile), so logins are set or read in the wrong
 *  browser, or a refused open leaves a Chrome holding the profile.
 *
 *  The real runtime and code host over real headless Chrome and the profile
 *  fixture site.
 */
import { afterEach, expect, test } from "bun:test";
import type { BrowserRuntime } from "../src/runtime";
import { ProfileStore } from "../src/store";
import { chromePidsByThrowaway } from "./chrome-processes";
import { cell, failureOf, isFailure, newRig, textOf, valueOf, type Rig } from "./code-host-fixture";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, failureCode, type Fixture, startFixture, teardown } from "./fixture";

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.host.dispose();
  rig = undefined;
  await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

async function start(seed?: (store: ProfileStore) => void): Promise<Rig> {
  const rootDir = await createRoot();
  if (seed !== undefined) seed(new ProfileStore(rootDir));
  rig = newRig(rootDir);
  return rig;
}

const browserIdOf = async (runtime: BrowserRuntime, asker: string, profile: string): Promise<string> => {
  const id = (await runtime.profileList(asker)).find(listed => listed.name === profile)?.browserId;
  if (id === undefined) throw new Error(`${asker} holds no browser on profile ${profile}`);
  return id;
};

const urlsOf = async (runtime: BrowserRuntime, browserId: string): Promise<string[]> =>
  (await runtime.state(browserId)).tabs.map(tab => tab.url).sort();

const q = JSON.stringify;
const SLOW_CELL = { timeoutMs: 90_000, waitMs: 85_000 } as const;

describeWithChrome("a cell opens a saved profile with no approval", () => {
  test("a login made in a saved profile survives the browser closing and is there for another chat's cell; another profile does not have it", async () => {
    const site = startFixture();
    const { host } = await start();
    await valueOf(host, "chat-1", `
      await browser.open({ name: "a", profile: "work", url: ${q(site.url("/set-cookie"))} });
      await browser.close({ all: true });
      0`, SLOW_CELL);
    const readBack = (session: string, profile: string) => valueOf(host, session, `
      const tab = await browser.open({ name: "a", profile: ${q(profile)}, url: ${q(site.url("/show-cookie"))} });
      await tab.evaluate(() => document.getElementById("cookie").textContent)`);
    expect(await readBack("chat-2", "work")).toBe(`COOKIE:${site.cookieValue}`);
    expect(await readBack("chat-3", "other")).toBe("COOKIE:none");
  }, BROWSER_TEST_TIMEOUT_MS);

  test("two chats share a profile's one browser on tabs of their own: each reads its own tab, one's close leaves the other working, and the last one out turns the lights off", async () => {
    const site = startFixture();
    const { host, runtime } = await start();
    await valueOf(host, "chat-1", `await browser.open({ name: "a", profile: "work", url: ${q(site.url("/page2"))} }); 0`);
    const holderBrowser = await browserIdOf(runtime, "chat-1", "work");

    await valueOf(host, "chat-2", `await browser.open({ name: "b", profile: "work", url: ${q(site.url("/show-cookie"))} }); 0`);

    expect(await browserIdOf(runtime, "chat-2", "work")).toBe(holderBrowser);
    expect(site.hits("/show-cookie")).toBe(1);
    expect(await valueOf(host, "chat-1", "browser.tab('a').url()")).toBe(site.url("/page2"));
    expect(await valueOf(host, "chat-2", "browser.tab('b').url()")).toBe(site.url("/show-cookie"));

    await valueOf(host, "chat-1", `await browser.close({ name: "a" }); 0`);
    expect(await heldBy(runtime, "chat-1", "work")).toBe("another chat");
    expect(await heldBy(runtime, "chat-2", "work")).toBe("this chat");
    expect((await runtime.state(holderBrowser)).browserId).toBe(holderBrowser);
    expect(await valueOf(host, "chat-2", "browser.tab('b').url()")).toBe(site.url("/show-cookie"));

    await valueOf(host, "chat-2", `await browser.close({ name: "b" }); 0`);
    expect(await heldBy(runtime, "chat-2", "work")).toBeNull();
    expect(await failureCode(() => runtime.state(holderBrowser))).toBe("unknown_browser");
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a chat that asks again for the profile it holds gets its one browser with a second tab, not a refusal and not a second Chrome", async () => {
    const site = startFixture();
    const { host, runtime } = await start();
    await valueOf(host, "chat-1", `await browser.open({ name: "a", profile: "work", url: ${q(site.url("/page2"))} }); 0`);
    const first = await browserIdOf(runtime, "chat-1", "work");

    await valueOf(host, "chat-1", `await browser.open({ name: "b", profile: "work", url: ${q(site.url("/signup"))} }); 0`);

    expect(await browserIdOf(runtime, "chat-1", "work")).toBe(first);
    expect(await urlsOf(runtime, first)).toEqual([site.url("/page2"), site.url("/signup")].sort());
  }, BROWSER_TEST_TIMEOUT_MS);

  test("opens that start together: two for one profile share its browser, and a throwaway opened beside them is a browser of its own", async () => {
    const site = startFixture();
    const { host, runtime } = await start();
    await valueOf(host, "chat-1", `
      await Promise.all([
        browser.open({ name: "a", profile: "work", url: ${q(site.url("/page2"))} }),
        browser.open({ name: "b", profile: "work", url: ${q(site.url("/signup"))} }),
        browser.open({ name: "t", url: ${q(site.url("/opener"))} }),
      ]);
      0`);

    const profileBrowser = await browserIdOf(runtime, "chat-1", "work");
    const throwaways = await runtime.openBrowsers("chat-1");
    expect(await urlsOf(runtime, profileBrowser)).toEqual([site.url("/page2"), site.url("/signup")].sort());
    expect(throwaways).toHaveLength(1);
    expect(throwaways[0]?.browserId).not.toBe(profileBrowser);
    expect(await urlsOf(runtime, throwaways[0]?.browserId ?? "")).toEqual([site.url("/opener")]);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a profile combined with another browser (app.cdp_url, app.path, app.relay) is refused before any browser opens, and is not mistaken for a missing consent", async () => {
    const { host, runtime } = await start();
    for (const app of ['{ cdp_url: "http://127.0.0.1:9" }', "{ path: process.execPath }", "{ relay: true }"]) {
      const refused = await failureOf(host, "chat-1", `await browser.open({ name: "x", profile: "work", app: ${app} })`);
      expect(refused.message).not.toContain("code_needs_consent");
      expect(await runtime.profileList("chat-1")).toEqual([]);
      expect(await runtime.openBrowsers("chat-1")).toEqual([]);
    }
  }, BROWSER_TEST_TIMEOUT_MS);
});

const boundElsewhere = (profile: string): string =>
  `Tab "main" is bound to a different browser than the saved profile "${profile}". Close it first, or open this one under another name.`;

const heldBy = async (runtime: BrowserRuntime, asker: string, profile: string) =>
  (await runtime.profileList(asker)).find(listed => listed.name === profile)?.heldBy ?? null;

const holdersOf = async (runtime: BrowserRuntime, asker: string): Promise<string[]> =>
  (await runtime.profileList(asker)).flatMap(listed => (listed.heldBy === "this chat" && listed.browserId !== undefined ? [listed.browserId] : []));

const throwawaysOf = async (runtime: BrowserRuntime, asker: string): Promise<string[]> =>
  (await runtime.openBrowsers(asker)).map(held => held.browserId);

const openTab = (site: Fixture, path: string, name = "main", profile?: string): string =>
  `await browser.open({ name: ${q(name)}, ${profile === undefined ? "" : `profile: ${q(profile)}, `}url: ${q(site.url(path))} })`;

const cookieOn = (name = "main"): string =>
  `await browser.tab(${q(name)}).evaluate(() => document.getElementById("cookie").textContent)`;

const textOfCell = async (host: Rig["host"], session: string, code: string): Promise<string> => {
  const result = await cell(host, session, code);
  if (isFailure(result)) throw new Error(`the cell failed: ${result.error.name}: ${result.error.message}`);
  return textOf(result);
};

describeWithChrome("a tab name stays on the browser it was opened on", () => {
  test("a name opened as a throwaway is refused when the cell asks for a saved profile under it: the throwaway tab is untouched and the profile is left free for another chat", async () => {
    const site = startFixture();
    const { host, runtime, rootDir } = await start();
    await valueOf(host, "chat-1", `${openTab(site, "/page2")}; 0`);
    const throwaway = await throwawaysOf(runtime, "chat-1");
    expect(throwaway).toHaveLength(1);

    const refused = await failureOf(host, "chat-1", `${openTab(site, "/set-cookie", "main", "work")}; 0`);

    expect(refused.message).toContain(boundElsewhere("work"));
    expect(site.hits("/set-cookie")).toBe(0);
    expect(await valueOf(host, "chat-1", `browser.tab("main").url()`)).toBe(site.url("/page2"));
    expect(await throwawaysOf(runtime, "chat-1")).toEqual(throwaway);
    expect((await chromePidsByThrowaway(rootDir)).size).toBe(1);
    expect(await heldBy(runtime, "chat-1", "work")).toBeNull();
    expect(await runtime.profileList("chat-1")).toEqual([]);
    expect(await valueOf(host, "chat-2", `${openTab(site, "/show-cookie", "a", "work")}; ${cookieOn("a")}`)).toBe("COOKIE:none");
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a name opened on one saved profile is refused when the cell asks for another profile under it: the tab keeps its own logins and the other profile is left free for another chat", async () => {
    const site = startFixture();
    const { host, runtime } = await start();
    await valueOf(host, "chat-1", `${openTab(site, "/set-cookie", "main", "work")}; 0`);
    expect(site.hits("/set-cookie")).toBe(1);
    const holders = await holdersOf(runtime, "chat-1");
    expect(holders).toHaveLength(1);

    const refused = await failureOf(host, "chat-1", `${openTab(site, "/show-cookie", "main", "other")}; 0`);

    expect(refused.message).toContain(boundElsewhere("other"));
    expect(site.hits("/show-cookie")).toBe(0);
    expect(await heldBy(runtime, "chat-1", "other")).toBeNull();
    expect((await runtime.profileList("chat-1")).map(listed => listed.name)).toEqual(["work"]);
    expect(await holdersOf(runtime, "chat-1")).toEqual(holders);
    expect(await valueOf(host, "chat-1", `${openTab(site, "/show-cookie")}; ${cookieOn()}`)).toBe(`COOKIE:${site.cookieValue}`);
    expect(await valueOf(host, "chat-2", `${openTab(site, "/show-cookie", "a", "other")}; ${cookieOn("a")}`)).toBe("COOKIE:none");
  }, BROWSER_TEST_TIMEOUT_MS);

  test("asking again for the profile a tab is on, spelled by its label or in another case, reuses that tab on the same browser", async () => {
    const site = startFixture();
    const { host, runtime } = await start(store => store.saveMeta("acme-work", { label: "Work Account" }));
    await valueOf(host, "chat-1", `${openTab(site, "/set-cookie", "main", "acme-work")}; 0`);
    const holders = await holdersOf(runtime, "chat-1");
    expect(holders).toHaveLength(1);

    const spellings = ["Work Account", "  work ACCOUNT ", "ACME-WORK"];
    const reuses: Array<[string, boolean]> = [];
    for (const spelling of spellings) {
      const text = await textOfCell(host, "chat-1", openTab(site, "/show-cookie", "main", spelling));
      reuses.push([spelling, text.startsWith('Reused tab "main"')]);
    }

    expect(reuses).toEqual(spellings.map(spelling => [spelling, true]));
    expect(await holdersOf(runtime, "chat-1")).toEqual(holders);
    expect(await throwawaysOf(runtime, "chat-1")).toEqual([]);
    expect(await valueOf(host, "chat-1", cookieOn())).toBe(`COOKIE:${site.cookieValue}`);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("an open with no profile on a tab that is on a saved profile navigates that tab, with the profile's logins", async () => {
    const site = startFixture();
    const { host, runtime } = await start();
    await valueOf(host, "chat-1", `${openTab(site, "/set-cookie", "main", "work")}; 0`);
    const holders = await holdersOf(runtime, "chat-1");
    expect(holders).toHaveLength(1);

    const text = await textOfCell(host, "chat-1", openTab(site, "/show-cookie"));

    expect(text).toStartWith('Reused tab "main"');
    expect(await holdersOf(runtime, "chat-1")).toEqual(holders);
    expect(await throwawaysOf(runtime, "chat-1")).toEqual([]);
    expect(await valueOf(host, "chat-1", cookieOn())).toBe(`COOKIE:${site.cookieValue}`);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a saved profile opened under a new name while a throwaway holds `main` is a browser of its own, and `main` stays on the throwaway", async () => {
    const site = startFixture();
    const { host, runtime } = await start();
    await valueOf(host, "chat-1", `${openTab(site, "/page2")}; 0`);
    const throwaway = await throwawaysOf(runtime, "chat-1");

    const text = await textOfCell(host, "chat-1", openTab(site, "/set-cookie", "work-tab", "work"));

    expect(text).toStartWith('Opened tab "work-tab"');
    expect(site.hits("/set-cookie")).toBe(1);
    const holders = await holdersOf(runtime, "chat-1");
    expect(holders).toHaveLength(1);
    expect(throwaway).not.toContain(holders[0] as string);
    expect(await throwawaysOf(runtime, "chat-1")).toEqual(throwaway);
    expect(await valueOf(host, "chat-1", `browser.tab("main").url()`)).toBe(site.url("/page2"));
    expect(await valueOf(host, "chat-1", `${openTab(site, "/show-cookie", "work-tab")}; ${cookieOn("work-tab")}`)).toBe(`COOKIE:${site.cookieValue}`);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a refused open does not take away the profile's browser when another tab of the chat is on it", async () => {
    const site = startFixture();
    const { host, runtime } = await start();
    await valueOf(host, "chat-1", `${openTab(site, "/set-cookie", "work-tab", "work")}; ${openTab(site, "/page2")}; 0`);
    const holders = await holdersOf(runtime, "chat-1");
    const throwaway = await throwawaysOf(runtime, "chat-1");
    expect(holders).toHaveLength(1);
    expect(throwaway).toHaveLength(1);

    const refused = await failureOf(host, "chat-1", `${openTab(site, "/show-cookie", "main", "work")}; 0`);

    expect(refused.message).toContain(boundElsewhere("work"));
    expect(site.hits("/show-cookie")).toBe(0);
    expect(await holdersOf(runtime, "chat-1")).toEqual(holders);
    expect(await throwawaysOf(runtime, "chat-1")).toEqual(throwaway);
    expect(await valueOf(host, "chat-1", `${openTab(site, "/show-cookie", "work-tab")}; ${cookieOn("work-tab")}`)).toBe(`COOKIE:${site.cookieValue}`);
    expect(await valueOf(host, "chat-1", `browser.tab("main").url()`)).toBe(site.url("/page2"));
  }, BROWSER_TEST_TIMEOUT_MS);

  test("closing the throwaway tab, as the refusal says, lets the same name open on the saved profile, and its login sticks", async () => {
    const site = startFixture();
    const { host, runtime } = await start();
    await valueOf(host, "chat-1", `${openTab(site, "/page2")}; 0`);
    await failureOf(host, "chat-1", `${openTab(site, "/set-cookie", "main", "work")}; 0`);

    await valueOf(host, "chat-1", `await browser.close({ name: "main" }); 0`);
    const text = await textOfCell(host, "chat-1", openTab(site, "/set-cookie", "main", "work"));

    expect(text).toStartWith('Opened tab "main"');
    expect(await throwawaysOf(runtime, "chat-1")).toEqual([]);
    expect(await holdersOf(runtime, "chat-1")).toHaveLength(1);
    expect(await valueOf(host, "chat-1", `${openTab(site, "/show-cookie")}; ${cookieOn()}`)).toBe(`COOKIE:${site.cookieValue}`);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a refused open never adopts the saved profile's browser the person has open in this chat's View: it gets no cell clock, and the chat's cells keep working, even after the person takes it over", async () => {
    const site = startFixture();
    const { host, runtime } = await start();
    const person = (await runtime.open({ profile: "work" }, { caller: "app", session: "chat-1" })).browserId;
    await valueOf(host, "chat-1", `${openTab(site, "/page2")}; 0`);
    const throwaway = await throwawaysOf(runtime, "chat-1");
    expect(throwaway).toHaveLength(1);
    const seam = runtime.codeSeam();
    expect(seam.peek(person)).toBeDefined();
    expect(seam.peek(person)?.code).toBeUndefined();
    expect(await holdersOf(runtime, "chat-1")).toEqual([person]);

    const refused = await failureOf(host, "chat-1", `${openTab(site, "/show-cookie", "main", "work")}; 0`);

    expect(refused.message).toContain(boundElsewhere("work"));
    expect(site.hits("/show-cookie")).toBe(0);
    expect(seam.peek(person)).toBeDefined();
    expect(seam.peek(person)?.code).toBeUndefined();
    expect(await holdersOf(runtime, "chat-1")).toEqual([person]);
    expect(await throwawaysOf(runtime, "chat-1")).toEqual(throwaway);
    expect(await valueOf(host, "chat-1", `browser.tab("main").url()`)).toBe(site.url("/page2"));

    await runtime.control(person, "take", "app");

    expect(await valueOf(host, "chat-1", `browser.tab("main").url()`)).toBe(site.url("/page2"));
    expect(seam.peek(person)?.code).toBeUndefined();
  }, BROWSER_TEST_TIMEOUT_MS);

  test("two opens that start together, one on the name the throwaway holds and one for the same profile under a new name: the first is refused, the second gets the profile's Chrome, and the refusal does not close it", async () => {
    const site = startFixture();
    const { host, runtime } = await start();
    await valueOf(host, "chat-1", `${openTab(site, "/signup")}; 0`);
    const throwaway = await throwawaysOf(runtime, "chat-1");
    expect(throwaway).toHaveLength(1);

    const outcomes = await valueOf(host, "chat-1", `
      const settled = await Promise.allSettled([
        browser.open({ name: "main", profile: "work", url: ${q(site.url("/show-cookie"))} }),
        browser.open({ name: "w", profile: "work", url: ${q(site.url("/page2"))} }),
      ]);
      JSON.stringify(settled.map(one => (one.status === "fulfilled" ? "fulfilled" : String(one.reason?.message ?? one.reason))))`, SLOW_CELL);

    expect(outcomes).toEqual([expect.stringContaining(boundElsewhere("work")), "fulfilled"]);
    expect(site.hits("/show-cookie")).toBe(0);
    expect(site.hits("/page2")).toBe(1);
    expect(await heldBy(runtime, "chat-1", "work")).toBe("this chat");
    expect(await holdersOf(runtime, "chat-1")).toHaveLength(1);
    expect(await throwawaysOf(runtime, "chat-1")).toEqual(throwaway);
    expect(await valueOf(host, "chat-1", `await browser.tab("w").evaluate(() => document.title)`)).toBe("second page");
    expect(await valueOf(host, "chat-1", `browser.tab("main").url()`)).toBe(site.url("/signup"));
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a name whose page was closed behind the host is not bound to the throwaway any more: it opens on the saved profile instead of being refused, and the throwaway's other tab is untouched", async () => {
    const site = startFixture();
    const { host, runtime } = await start();
    await valueOf(host, "chat-1", `${openTab(site, "/page2")}; ${openTab(site, "/signup", "keep")}; 0`);
    const throwaway = await throwawaysOf(runtime, "chat-1");
    expect(throwaway).toHaveLength(1);
    const driver = runtime.codeSeam().browsersOf("chat-1")[0]?.driver;
    if (driver === undefined) throw new Error("the throwaway has no engine driver");
    const pages = await driver.tabs();
    const mainPage = pages.find(page => page.url === site.url("/page2"));
    expect(pages.map(page => page.url).sort()).toEqual([site.url("/page2"), site.url("/signup")].sort());
    if (mainPage === undefined) throw new Error("the throwaway has no page for tab main");

    await driver.closeTab(mainPage.tabId);

    expect((await driver.tabs()).map(page => page.url)).toEqual([site.url("/signup")]);
    const text = await textOfCell(host, "chat-1", openTab(site, "/set-cookie", "main", "work"));

    expect(text).toStartWith('Opened tab "main"');
    expect(site.hits("/set-cookie")).toBe(1);
    expect(await holdersOf(runtime, "chat-1")).toHaveLength(1);
    expect(await throwawaysOf(runtime, "chat-1")).toEqual(throwaway);
    expect(await valueOf(host, "chat-1", `${openTab(site, "/show-cookie")}; ${cookieOn()}`)).toBe(`COOKIE:${site.cookieValue}`);
    expect(await valueOf(host, "chat-1", `await browser.tab("keep").evaluate(() => document.title)`)).toBe("signup");
  }, BROWSER_TEST_TIMEOUT_MS);
});
