import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { BrowserOpenOptions, BrowserState } from "../src/contracts";
import { RuntimeCodeBrowsers, type CodeSeam, type CodeSeamEntry } from "../src/code/host/runtime-port";
import { createBrowserServer } from "../src/server";
import { chromePidsByProfile, chromePidsByThrowaway } from "./chrome-processes";
import { newRig, type Rig } from "./code-host-fixture";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, type Fixture, startFixture, teardown } from "./fixture";

const CALLER = "ai.insodimension/caller";
const SESSION = "ai.insodimension/session";
const q = JSON.stringify;

interface Who {
  caller: "model" | "app";
  session: string;
}
const PERSON_IN_A: Who = { caller: "app", session: "chat-a" };
const CHAT_A: Who = { caller: "model", session: "chat-a" };
const CHAT_B: Who = { caller: "model", session: "chat-b" };

const Answer = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ text: z.string().optional() }).passthrough()),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
type Answer = z.infer<typeof Answer>;

interface Wired extends Rig {
  fixture: Fixture;
  call(name: string, args: Record<string, unknown>, who: Who): Promise<Answer>;
}

const rigs: Rig[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const rig of rigs.splice(0)) await rig.host.dispose();
  await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

async function wire(): Promise<Wired> {
  const rootDir = await createRoot();
  const rig = newRig(rootDir);
  rigs.push(rig);
  const viewDir = join(rootDir, "view");
  await mkdir(viewDir, { recursive: true });
  await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
  const server = await createBrowserServer({ runtime: rig.runtime, codeHost: rig.host, viewDir, presets: [], modelTools: "code" });
  const client = new Client({ name: "browser-run-in-the-panel-test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  return {
    ...rig,
    fixture: startFixture(),
    call: async (name, args, who) => Answer.parse(await client.callTool({ name, arguments: args, _meta: { [CALLER]: who.caller, [SESSION]: { sessionId: who.session } } })),
  };
}

const textOf = (answer: Answer): string => answer.content.map(block => block.text ?? "").join("");

const browserIdOf = (answer: Answer): string => {
  const browserId = answer.structuredContent?.browserId;
  if (answer.isError || typeof browserId !== "string") throw new Error(`expected a browser, got: ${textOf(answer)}`);
  return browserId;
};

const ran = async (wired: Wired, who: Who, code: string): Promise<void> => {
  const answer = await wired.call("browser_run", { code }, who);
  if (answer.isError) throw new Error(`the cell failed: ${textOf(answer)}`);
};

const tabUrls = async (wired: Wired, browserId: string): Promise<string[]> =>
  (await wired.runtime.state(browserId)).tabs.map(tab => tab.url).sort();

const profileBrowsersOf = async (wired: Wired, session: string): Promise<string[]> =>
  (await wired.runtime.profileList(session)).flatMap(listed => (listed.heldBy === "this chat" && listed.browserId !== undefined ? [listed.browserId] : []));

const throwawaysOf = async (wired: Wired, session: string): Promise<string[]> =>
  (await wired.runtime.openBrowsers(session)).map(held => held.browserId);

describeWithChrome("a cell opens its pages in the browser the person's panel shows", () => {
  test("browser.open({ url }) in a chat whose panel is on a saved profile lands a tab in that browser: no second browser is made, and browser_view() answers with it", async () => {
    const wired = await wire();
    const page = wired.fixture.url("/page2");
    const panel = browserIdOf(await wired.call("browser_open", { profile: "default" }, PERSON_IN_A));

    await ran(wired, CHAT_A, `await browser.open({ url: ${q(page)} }); 0`);

    expect(await tabUrls(wired, panel)).toEqual([page]);
    expect(await throwawaysOf(wired, "chat-a")).toEqual([]);
    expect(await profileBrowsersOf(wired, "chat-a")).toEqual([panel]);
    expect((await chromePidsByThrowaway(wired.rootDir)).size).toBe(0);
    expect((await chromePidsByProfile(wired.rootDir)).size).toBe(1);
    expect(browserIdOf(await wired.call("browser_view", {}, CHAT_A))).toBe(panel);

    await ran(wired, CHAT_A, `await browser.open({ name: "second", url: ${q(wired.fixture.url("/signup"))} }); 0`);
    expect(await tabUrls(wired, panel)).toEqual([page, wired.fixture.url("/signup")].sort());
    expect(await throwawaysOf(wired, "chat-a")).toEqual([]);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("the cell tidying up its tabs leaves the person's panel browser open, and browser_view() still answers with it", async () => {
    const wired = await wire();
    const panel = browserIdOf(await wired.call("browser_open", { profile: "default" }, PERSON_IN_A));
    await ran(wired, CHAT_A, `await browser.open({ url: ${q(wired.fixture.url("/page2"))} }); 0`);

    await ran(wired, CHAT_A, "await browser.close({ all: true }); 0");

    expect((await wired.runtime.state(panel)).browserId).toBe(panel);
    expect(browserIdOf(await wired.call("browser_view", {}, CHAT_A))).toBe(panel);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a profile the cell names is still opened as that profile: the panel's browser does not stand in for it", async () => {
    const wired = await wire();
    const page = wired.fixture.url("/page2");
    const panel = browserIdOf(await wired.call("browser_open", { profile: "default" }, PERSON_IN_A));

    await ran(wired, CHAT_A, `await browser.open({ name: "w", profile: "work", url: ${q(page)} }); 0`);

    const held = await profileBrowsersOf(wired, "chat-a");
    expect(held).toHaveLength(2);
    expect(held).toContain(panel);
    const work = held.find(browserId => browserId !== panel) ?? "";
    expect(await tabUrls(wired, work)).toEqual([page]);
    expect(await tabUrls(wired, panel)).not.toContain(page);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("another chat's cell is not given the browser this chat's panel shows: it opens a browser of its own and the panel's tabs stay as they were", async () => {
    const wired = await wire();
    const page = wired.fixture.url("/page2");
    const panel = browserIdOf(await wired.call("browser_open", { profile: "default" }, PERSON_IN_A));
    const before = await tabUrls(wired, panel);

    await ran(wired, CHAT_B, `await browser.open({ url: ${q(page)} }); 0`);

    expect(await profileBrowsersOf(wired, "chat-b")).toEqual([]);
    const own = await throwawaysOf(wired, "chat-b");
    expect(own).toHaveLength(1);
    expect(own).not.toContain(panel);
    expect(await tabUrls(wired, own[0] ?? "")).toEqual([page]);
    expect(await tabUrls(wired, panel)).toEqual(before);
  }, BROWSER_TEST_TIMEOUT_MS);
});

interface ShownEntry {
  browserId: string;
  profile: string | null;
  engine: CodeSeamEntry["engine"];
}

interface Scripted {
  port: RuntimeCodeBrowsers;
  opened: BrowserOpenOptions[];
}

function portShowing(shown: ShownEntry, gated: ReadonlySet<string> = new Set()): Scripted {
  const opened: BrowserOpenOptions[] = [];
  const entries = new Map<string, CodeSeamEntry>();
  const entry = (browserId: string, profile: string | null, engine: CodeSeamEntry["engine"]): CodeSeamEntry =>
    ({ browserId, profile, engine, closed: false, openers: new Map(), driver: { cdpEndpoint: () => `ws://fake/${browserId}` } }) as unknown as CodeSeamEntry;
  entries.set(shown.browserId, entry(shown.browserId, shown.profile, shown.engine));
  const isThrowawayOrRelay = (candidate: CodeSeamEntry): boolean => candidate.profile === null || candidate.profile === "relay";
  const seam = {
    shownTo: () => entries.get(shown.browserId),
    viewOf: () => {
      const candidate = entries.get(shown.browserId);
      return candidate !== undefined && isThrowawayOrRelay(candidate) ? candidate.browserId : undefined;
    },
    browsersOf: () => [...entries.values()].filter(isThrowawayOrRelay),
    require: (browserId: string) => entries.get(browserId)!,
    resolveProfile: (raw: string) => raw.trim().toLowerCase(),
    gatedReason: (profile: string | null) => (profile !== null && gated.has(profile) ? `${profile} is a profile a Traction account posts from` : undefined),
    bindView: () => undefined,
    resize: async () => ({}) as BrowserState,
    open: async (options: BrowserOpenOptions) => {
      opened.push(options);
      if (options.profile === shown.profile) return { browserId: shown.browserId } as BrowserState;
      entries.set("made", entry("made", options.profile ?? null, options.engine ?? "chromium"));
      return { browserId: "made" } as BrowserState;
    },
  } as unknown as CodeSeam;
  return { port: new RuntimeCodeBrowsers(seam), opened };
}

const NEVER = new AbortController().signal;
const HEADLESS = { kind: "headless", headless: true } as const;

test("browser.open with no profile joins the saved Chromium profile the session is shown", async () => {
  const { port, opened } = portShowing({ browserId: "panel", profile: "work", engine: "chromium" });

  const acquired = await port.acquire("chat-a", { kind: HEADLESS }, NEVER);

  expect(acquired.browserId).toBe("panel");
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ profile: "work", engine: "chromium" });
});

test("browser.open with no profile refuses the shown saved profile a Traction account posts from, and opens nothing", async () => {
  const { port, opened } = portShowing({ browserId: "panel", profile: "godofrock", engine: "chromium" }, new Set(["godofrock"]));

  await expect(port.acquire("chat-a", { kind: HEADLESS }, NEVER)).rejects.toThrow("godofrock is a profile a Traction account posts from");
  expect(opened).toEqual([]);
});

test("a cell takes no hold on a browser whose profile a Traction account posts from", () => {
  const { port } = portShowing({ browserId: "panel", profile: "godofrock", engine: "chromium" }, new Set(["godofrock"]));

  expect(() => port.holdWork("panel")).toThrow("godofrock is a profile a Traction account posts from");
});

test("browser.open with no profile never takes a shown browser that is not a saved Chromium profile: it makes the throwaway a cell gets", async () => {
  const shownKinds: Array<{ name: string; shown: ShownEntry }> = [
    { name: "the person's own Chrome through the relay", shown: { browserId: "panel", profile: "relay", engine: "chrome-relay" } },
    { name: "a saved profile on another engine", shown: { browserId: "panel", profile: "work", engine: "abp" } },
  ];

  for (const { name, shown } of shownKinds) {
    const { port, opened } = portShowing(shown);

    const acquired = await port.acquire("chat-a", { kind: HEADLESS }, NEVER);

    expect([name, acquired.browserId, acquired.created]).toEqual([name, "made", true]);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.engine).toBe("chromium");
    expect(opened[0]?.profile).toBeUndefined();
  }
});
