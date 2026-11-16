import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBrowserServer } from "../src/server";
import { newRig, type Rig } from "./code-host-fixture";
import { BROWSER_TEST_TIMEOUT_MS, createRoot, describeWithChrome, teardown } from "./fixture";

const SESSION = "ai.insodimension/session";
const CALLER = "ai.insodimension/caller";
const MCP_HOST_TIMEOUT_MS = 30_000;
const BUSY_FOR_MS = 90_000;
const BUSY_PAGE = "data:text/html,<title>busy</title><h1>busy</h1>";
const START_BUSY_LOOP = `() => { setTimeout(() => { const end = Date.now() + ${BUSY_FOR_MS}; while (Date.now() < end) {} }, 0); }`;
const CALM_PAGE = "data:text/html,<title>calm</title><h1>calm</h1>";

const rigs: Rig[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const rig of rigs.splice(0)) await rig.host.dispose();
  await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

async function connect(): Promise<(code: string) => Promise<{ ms: number; text: string; isError: boolean }>> {
  const rootDir = await createRoot();
  const rig = newRig(rootDir);
  rigs.push(rig);
  const viewDir = join(rootDir, "view");
  await mkdir(viewDir, { recursive: true });
  await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
  const server = await createBrowserServer({ runtime: rig.runtime, codeHost: rig.host, viewDir, presets: [], modelTools: "code" });
  const client = new Client({ name: "hung-page-test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  return async code => {
    const startedAt = Date.now();
    const answer = await client.callTool(
      { name: "browser_run", arguments: { code, timeout: 60 }, _meta: { [CALLER]: "model", [SESSION]: { sessionId: "chat" } } },
      undefined,
      { timeout: 120_000 },
    );
    const content = (answer.content ?? []) as { text?: string }[];
    return { ms: Date.now() - startedAt, text: content.map(block => block.text ?? "").join(""), isError: answer.isError === true };
  };
}

describeWithChrome("a page whose main thread never yields", () => {
  test("the call that leaves a busy tab in front answers inside the host's call timeout, and later calls do too", async () => {
    const run = await connect();
    const occupying = await run(`await browser.open({ name: "calm", url: ${JSON.stringify(CALM_PAGE)} }); const busy = await browser.open({ name: "busy", url: ${JSON.stringify(BUSY_PAGE)} }); await busy.evaluate(${START_BUSY_LOOP}); "occupied"`);
    expect(occupying.text).toContain("occupied");
    expect(occupying.isError).toBe(false);
    expect(occupying.ms).toBeLessThan(MCP_HOST_TIMEOUT_MS);

    const onCalm = await run(`await browser.tab("calm").title()`);
    expect(onCalm.text).toContain("calm");
    expect(onCalm.ms).toBeLessThan(MCP_HOST_TIMEOUT_MS);
  }, BROWSER_TEST_TIMEOUT_MS);
});
