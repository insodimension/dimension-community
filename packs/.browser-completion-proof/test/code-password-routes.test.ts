/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a model that is refused at a password field is sent to a tool its space cannot call. A cell runs only in the spaces that have `browser_run` (code and build), and in the
 * default mode those spaces see `browser_run`, `browser_view`, `browser_read`, `browser_profiles` and `browser_close` and nothing else: not the step tools (`browser_act`, `browser_open`), and not Traction's task tools
 * whether or not jev's key is set. The refusal used to name `browser_act`, `browser_open` and, with the key, `browser_task`: three calls the model could not make, leaving "ask the user" as its only real route.
 *
 * The server is the real one over an in-memory transport, the runtime the pack's own with a real headless Chrome, the code worker the real one; the page is the fixture's sign-in form. What a space is offered is read
 * the way the engine reads it (`ai.insodimension/spaces` on each tool), and every tool name in the refusal must be one of those.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrowserServer } from "../src/server";
import { startPages, type Pages } from "./code-host-fixture";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, newRuntime, teardown } from "./fixture";

const clients: Client[] = [];
const servers: Array<{ close(): Promise<void> }> = [];
let pages: Pages;
const saved: Record<string, string | undefined> = {};
const WATCHDOG = ["DIMENSION_BROWSER_CODE_MEMORY_MB", "DIMENSION_BROWSER_CODE_TOTAL_MB"] as const;

beforeEach(async () => {
  pages = await startPages();
  // The memory watchdog is not what is under test: keep its probes (a PowerShell on a Node without the worker's own figure) out of this server.
  for (const name of WATCHDOG) {
    saved[name] = process.env[name];
    process.env[name] = "0";
  }
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const client of clients.splice(0)) await client.close();
  await teardown();
  await pages.close();
  for (const name of WATCHDOG) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const SPACES_KEY = "ai.insodimension/spaces";

/** The tools the model of `space` is offered: the engine's `toolsVisibleTo("model", space)`. */
async function offeredTo(client: Client, space: string): Promise<string[]> {
  return (await client.listTools()).tools
    .filter(tool => {
      const visibility = (tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility;
      const audience = tool._meta?.[SPACES_KEY];
      return (visibility === undefined || visibility.includes("model")) && (!Array.isArray(audience) || audience.includes(space));
    })
    .map(tool => tool.name);
}

/** What a cell is told when it types into a password field, and what each code space is offered, on a server whose task tools are on or off. */
async function refusalWith(taskTools: boolean): Promise<{ refusal: string; offered: Record<string, string[]> }> {
  const root = await createRoot();
  const viewDir = join(root, "view");
  await mkdir(viewDir, { recursive: true });
  await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
  const server = await createBrowserServer({ runtime: newRuntime(root), viewDir, presets: [], taskTools });
  servers.push(server);
  const client = new Client({ name: "code-password-routes-test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  const meta = { "ai.insodimension/caller": "model", "ai.insodimension/session": { sessionId: "s1" } };
  let answer = await client.callTool({
    name: "browser_run",
    arguments: { code: `const tab = await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/password"))} }); await tab.fill("#pw", "hunter2")` },
    _meta: meta,
  });
  // A cold Chrome may outlast one MCP call. "running: id" is a successful intermediate
  // response, not the password refusal; follow the same resume instruction a model receives.
  for (let remaining = 2; remaining > 0 && answer.isError !== true; remaining--) {
    const content = (answer.content ?? []) as Array<{ type: string; text?: string }>;
    const runId = /^running: ([^\s]+)/.exec(content.map(part => part.text ?? "").join("\n"))?.[1];
    if (runId === undefined) break;
    answer = await client.callTool({ name: "browser_run", arguments: { resume: runId }, _meta: meta });
  }
  const content = (answer.content ?? []) as Array<{ type: string; text?: string }>;
  expect(answer.isError).toBe(true);
  const offered: Record<string, string[]> = {};
  for (const space of ["code", "build"]) offered[space] = await offeredTo(client, space);
  return { refusal: content.map(part => part.text ?? "").join("\n"), offered };
}

describeWithChrome("the password refusal sends a code or build model only to tools its space has", () => {
  for (const taskTools of [false, true]) {
    test(`${taskTools ? "with" : "without"} jev's key: every tool the refusal names is offered to code and to build, it names browser_view, and it names no step tool or task tool`, async () => {
      const { refusal, offered } = await refusalWith(taskTools);
      expect(refusal).toContain("is a password field");
      const named = [...new Set(refusal.match(/\bbrowser_[a-z_]+\b/g) ?? [])];
      expect(named).toContain("browser_view");
      for (const space of ["code", "build"]) {
        // The list is what the engine would show this space, and the key changes nothing about it: the task tools are Traction's.
        expect(offered[space]).toContain("browser_run");
        expect(offered[space]).not.toContain("browser_act");
        expect(offered[space]).not.toContain("browser_task");
        for (const name of named) expect(offered[space]).toContain(name);
      }
      expect(refusal).toContain("Ask the user to type it themselves in the Browser View");
    }, BROWSER_TEST_TIMEOUT_MS);
  }
});
