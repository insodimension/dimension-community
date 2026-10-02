/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a model that is refused at a password field is told to use a tool this server does not offer. The refusal names `browser_task` as a route (hand the login to it with a
 * credential) only when the host says in `init` that the server offers it, and the server offers it only where its task tools are registered (a TypeSafe key, once the jev hand-off is optional). Two settings that
 * have to be one: if the hint stays `true` while the tool is not in `tools/list`, the model is sent to a tool call that fails with "unknown tool".
 *
 * The server is the real one over an in-memory transport, the runtime the pack's own with a real headless Chrome, the code worker the real one; the page is the fixture's sign-in form.
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
let pages: Pages;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  pages = await startPages();
  // The memory watchdog is not what is under test: keep its probes (a PowerShell on a Node without the worker's own figure) out of this server.
  saved.memory = process.env.DIMENSION_BROWSER_CODE_MEMORY_MB;
  process.env.DIMENSION_BROWSER_CODE_MEMORY_MB = "0";
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await teardown();
  await pages.close();
  if (saved.memory === undefined) delete process.env.DIMENSION_BROWSER_CODE_MEMORY_MB;
  else process.env.DIMENSION_BROWSER_CODE_MEMORY_MB = saved.memory;
});

/** A server whose task tools are on or off, the tools it lists, and what a cell is told when it types into a password field. */
async function refusalWith(taskTools: boolean): Promise<{ tools: string[]; refusal: string }> {
  const root = await createRoot();
  const viewDir = join(root, "view");
  await mkdir(viewDir, { recursive: true });
  await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
  const server = await createBrowserServer({ runtime: newRuntime(root), viewDir, presets: [], taskTools });
  const client = new Client({ name: "code-task-credential-test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  const answer = await client.callTool({
    name: "browser_run",
    arguments: { code: `const tab = await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/password"))} }); await tab.fill("#pw", "hunter2")` },
    _meta: { "ai.insodimension/caller": "model", "ai.insodimension/session": { sessionId: "s1" } },
  });
  const content = (answer.content ?? []) as Array<{ type: string; text?: string }>;
  expect(answer.isError).toBe(true);
  return { tools, refusal: content.map(part => part.text ?? "").join("\n") };
}

describeWithChrome("the password refusal names browser_task exactly when the server offers it", () => {
  test("task tools registered: the tool is listed and the refusal sends the model to it", async () => {
    const { tools, refusal } = await refusalWith(true);
    expect(tools).toContain("browser_task");
    expect(refusal).toContain("is a password field");
    expect(refusal).toContain("browser_task");
  }, BROWSER_TEST_TIMEOUT_MS);

  test("task tools not registered: the tool is not listed and the refusal does not name it", async () => {
    const { tools, refusal } = await refusalWith(false);
    expect(tools).not.toContain("browser_task");
    expect(tools).not.toContain("browser_task_wait");
    expect(tools).not.toContain("browser_task_cancel");
    expect(refusal).toContain("is a password field");
    expect(refusal).not.toContain("browser_task");
  }, BROWSER_TEST_TIMEOUT_MS);
});
