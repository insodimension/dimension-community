/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: one wrong line of configuration for the code tool takes the whole browser down. `DIMENSION_BROWSER_CODE_ISOLATION=process` or a non-numeric
 * `DIMENSION_BROWSER_CODE_HEAP_MB` made the server throw at start: no plain tool, no View, for a setting that only concerns `browser_run`. The server must start, say on stderr what is wrong, leave
 * `browser_run` off, and keep the step tools the model needs in its place.
 *
 * The runtime is the pack's real one (no browser is launched until a tool asks for one); the server is the real one, reached the way a host reaches it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createRuntimeCodeHost } from "../src/code/host/code-host";
import { createBrowserServer } from "../src/server";
import { createRoot, newRuntime, teardown } from "./fixture";

const SETTINGS = ["DIMENSION_BROWSER_CODE_ISOLATION", "DIMENSION_BROWSER_CODE_HEAP_MB", "DIMENSION_BROWSER_CODE_MEMORY_MB", "DIMENSION_BROWSER_CODE_IDLE_MS", "DIMENSION_BROWSER_FREEZE_IDLE_MS", "DIMENSION_BROWSER_MODEL_TOOLS"] as const;
const saved: Record<string, string | undefined> = {};
const logged: string[] = [];
const realError = console.error;
const clients: Client[] = [];

beforeEach(() => {
  for (const name of SETTINGS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  console.error = (...parts: unknown[]) => void logged.push(parts.map(String).join(" "));
});

afterEach(async () => {
  console.error = realError;
  logged.length = 0;
  for (const name of SETTINGS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await teardown();
});

/** The tools a server started with the environment as it is now lists. */
async function toolsOffered(): Promise<Tool[]> {
  const root = await createRoot();
  const viewDir = join(root, "view");
  await mkdir(viewDir, { recursive: true });
  await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
  const server = await createBrowserServer({ runtime: newRuntime(root), viewDir, presets: [] });
  const client = new Client({ name: "code-settings-test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  return (await client.listTools()).tools;
}

const SPACES_META_KEY = "ai.insodimension/spaces";
const names = (tools: Tool[]): string[] => tools.map(tool => tool.name);
/** The step tools are hidden from the spaces that are offered `browser_run`: in that case they carry a spaces list. */
const stepToolsHidden = (tools: Tool[]): boolean => tools.find(tool => tool.name === "browser_open")?._meta?.[SPACES_META_KEY] !== undefined;

describe("a wrong setting that only concerns browser_run", () => {
  test("DIMENSION_BROWSER_CODE_ISOLATION=process starts the server without browser_run, says why, and keeps the step tools", async () => {
    process.env.DIMENSION_BROWSER_CODE_ISOLATION = "process";
    const tools = await toolsOffered();
    expect(names(tools)).not.toContain("browser_run");
    expect(names(tools)).toContain("browser_state");
    // The model keeps the step tools: nothing hides them from any space.
    expect(stepToolsHidden(tools)).toBe(false);
    expect(logged.join("\n")).toContain("browser_run is off");
    expect(logged.join("\n")).toContain("DIMENSION_BROWSER_CODE_ISOLATION");
  });

  test("a non-numeric memory setting does the same, and the message names its unit as megabytes", async () => {
    process.env.DIMENSION_BROWSER_CODE_HEAP_MB = "lots";
    const tools = await toolsOffered();
    expect(names(tools)).not.toContain("browser_run");
    expect(stepToolsHidden(tools)).toBe(false);
    expect(logged.join("\n")).toContain("DIMENSION_BROWSER_CODE_HEAP_MB must be a number of megabytes");
    expect(logged.join("\n")).not.toContain("milliseconds");
  });

  test("a time setting names milliseconds", () => {
    expect(() => createRuntimeCodeHost(newRuntime("unused-root"), { taskCredential: false, env: { DIMENSION_BROWSER_FREEZE_IDLE_MS: "soon" } })).toThrow("DIMENSION_BROWSER_FREEZE_IDLE_MS must be a number of milliseconds");
  });

  test("asking for the code tool by name (DIMENSION_BROWSER_MODEL_TOOLS=code) beside a wrong setting still starts, with the step tools", async () => {
    process.env.DIMENSION_BROWSER_CODE_ISOLATION = "process";
    process.env.DIMENSION_BROWSER_MODEL_TOOLS = "code";
    const tools = await toolsOffered();
    expect(names(tools)).not.toContain("browser_run");
    expect(stepToolsHidden(tools)).toBe(false);
  });

  test("with every setting right, browser_run is offered", async () => {
    const tools = await toolsOffered();
    expect(names(tools)).toContain("browser_run");
    expect(stepToolsHidden(tools)).toBe(true);
    expect(logged.join("\n")).not.toContain("browser_run is off");
  });
});
