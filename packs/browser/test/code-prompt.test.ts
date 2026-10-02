/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: `prompt.md` is the model's only knowledge of the API it writes code against (doc 77 §7.4.2). A method it names
 *  that the facade does not have is a TypeError the model meets on its first try; a method the facade has that it does not name is a feature the model never
 *  uses (the owner's rule: nothing OMP's browser has is lost); and a description that grows past the budget costs every turn of every session that is offered
 *  the tool (doc 77 §7.9: the model set at or under 1,711 tokens, o200k).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { CodeCell } from "../src/code/cell/cell.js";
import type { CodeHostPort } from "../src/code/contracts.js";
import { BROWSER_RUN_DESCRIPTION } from "../src/code/tool.js";
import type { BrowserRuntimePort } from "../src/contracts.js";
import { createBrowserServer } from "../src/server.js";
import { bridgeRequestSchema } from "../src/code/worker/dispatch.js";

const cell = new CodeCell({ guardRejections: true });
afterAll(() => cell.dispose());

/** The names the real facade has: `browser`, a tab, and an element handle. The calls are never made, so no host is needed. */
async function facadeNames(): Promise<{ browser: string[]; tab: string[]; element: string[] }> {
  const result = await cell.run({
    runId: "names",
    code: "JSON.stringify({ browser: Object.keys(browser), tab: Object.keys(browser.tab('t')), element: Object.keys(browser.tab('t').id(0)) })",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    invoke: async () => {
      throw new Error("no host");
    },
  });
  const text = result.displays.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
  return JSON.parse(text) as { browser: string[]; tab: string[]; element: string[] };
}

const description = BROWSER_RUN_DESCRIPTION;
const backticked = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]!);
const identifiers = (text: string, pattern: RegExp): string[] => [...new Set([...text.matchAll(pattern)].map(match => match[1]!))];
const lineStartingWith = (prefix: string): string => {
  const line = description.split("\n").find(candidate => candidate.trimStart().startsWith(prefix));
  if (line === undefined) throw new Error(`prompt.md has no line starting with ${prefix}`);
  return line;
};
/** The identifiers a bullet list names in backticks, e.g. "Navigation: `url`, `title`, `goto`." → ["url", "title", "goto"]. */
const namedBy = (text: string): string[] => backticked(text).filter(name => /^[A-Za-z_]\w*$/.test(name));

// OMP's facade, as the pack ports it, has these on a tab besides the direct helpers; they are named in prompt.md in other lines.
const TAB_EXTRAS = ["name", "toString", "id", "ref", "run", "close"];
const PACK_ONLY = ["tabs", "active"];

describe("the API prompt.md names is the API the facade has", () => {
  test("every `browser.x` and `tab.x` it writes, in prose or in the example, exists on the facade", async () => {
    const names = await facadeNames();
    for (const name of identifiers(description, /\bbrowser\.(\w+)/g)) expect(names.browser).toContain(name);
    for (const name of identifiers(description, /(?<![.\w])tab\.(\w+)/g)) expect(names.tab).toContain(name);
  });

  test("the direct tab helpers it lists are exactly the ones OMP's facade has", async () => {
    const names = await facadeNames();
    const start = description.indexOf("Direct tab helpers:");
    const end = description.indexOf("- `tab.id(n)`");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // Each sub-bullet is "Label: `a`, `b`."; what follows its first full stop is prose about the helper.
    const listed = description.slice(start, end).split("\n").flatMap(line => (/^\s+- [A-Za-z ]+:/.test(line) ? namedBy(line.slice(line.indexOf(":") + 1).split(/\.(?:\s|$)/)[0]!) : []));
    expect([...listed].sort()).toEqual(names.tab.filter(name => !TAB_EXTRAS.includes(name)).sort());
  });

  test("the element methods it lists are exactly the ones an element handle has", async () => {
    const names = await facadeNames();
    const line = lineStartingWith("- `tab.id(n)`");
    const listed = namedBy(line.slice(line.indexOf("supporting")));
    expect([...listed].sort()).toEqual(names.element.filter(name => name !== "toString").sort());
  });

  test("it names every method of `browser` that OMP's facade has (the pack's own tabs and active are not in OMP's text)", async () => {
    const names = await facadeNames();
    for (const name of names.browser.filter(candidate => !PACK_ONLY.includes(candidate))) expect(description).toContain(`browser.${name}`);
  });

  test("the options it lists for open and close are the bridge's: every one exists, and none of the bridge's open or close options is left out", () => {
    const [openPart, closePart] = lineStartingWith("- `open` options:").replace(/\(default `main`\)/, "").split("`close` options:") as [string, string];
    const listed = [...new Set([...namedBy(openPart).filter(name => name !== "open"), ...namedBy(closePart)])];
    const schema = Object.keys(bridgeRequestSchema.shape);
    for (const name of listed) expect(schema).toContain(name);
    // What the bridge takes besides: `action` is the call itself, `code`/`fn`/`args`/`chain` belong to run and call, `profile` is the pack's saved-profile option (refused in this tool).
    const notOptions = ["action", "code", "fn", "args", "chain", "profile"];
    expect(listed.sort()).toEqual(schema.filter(name => !notOptions.includes(name)).sort());
  });

  test("the application modes it lists are the ones the schema's `app` takes", () => {
    const app = bridgeRequestSchema.shape.app.unwrap().shape;
    for (const name of identifiers(description, /\bapp\.(\w+)/g)) expect(Object.keys(app)).toContain(name);
  });

  test("the critical lines OMP's prompt carries are still there", () => {
    const critical = description.slice(description.indexOf("<critical>"), description.indexOf("</critical>"));
    expect(critical).toContain("MUST open a tab before direct use; `browser.tab(name)` does not open one.");
    expect(critical).toContain("Default to `tab.observe()`; use screenshots for visual confirmation.");
    expect(critical).toContain("Relay and CDP actions operate on real user sessions.");
    expect(critical).toMatch(/not sandboxed/);
  });
});

describe("what the model is made to read", () => {
  const noRuntime = { connections: async () => ({}), profileMeta: async () => ({}), onConnectionsChanged: () => () => {}, dispose: async () => {} } as unknown as BrowserRuntimePort;
  const noHost: CodeHostPort = { run: async () => { throw new Error("unused"); }, resume: async () => { throw new Error("unused"); }, dispose: async () => {} };
  const viewDir = mkdtempSync(join(tmpdir(), "browser-prompt-"));
  writeFileSync(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
  const client = new Client({ name: "code-prompt-test", version: "0.0.0" });
  const connected = (async () => {
    const server = await createBrowserServer({ runtime: noRuntime, viewDir, presets: [], codeHost: noHost, modelTools: "code" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  })();
  afterAll(async () => {
    await connected.catch(() => undefined);
    await client.close();
    rmSync(viewDir, { recursive: true, force: true });
  });

  /** doc 77 §7.3's method: `JSON.stringify({ name, description, input_schema })` of every tool the model of a code space is offered, counted in o200k. */
  async function modelTools(): Promise<Array<{ name: string; tokens: number }>> {
    await connected;
    const { tools } = await client.listTools();
    return tools
      .filter(tool => {
        const meta = tool._meta as { ui?: { visibility?: string[] }; "ai.insodimension/spaces"?: string[] } | undefined;
        const appOnly = meta?.ui?.visibility?.length === 1 && meta.ui.visibility[0] === "app";
        const spaces = meta?.["ai.insodimension/spaces"];
        return !appOnly && (spaces === undefined || spaces.includes("code"));
      })
      .map(tool => ({ name: tool.name, tokens: countTokens(JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) }));
  }

  test("the model of a code space is offered browser_run, browser_view, browser_read, browser_profiles and browser_close, and their text is at most 1,711 tokens", async () => {
    const tools = await modelTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(["browser_close", "browser_profiles", "browser_read", "browser_run", "browser_view"]);
    const total = tools.reduce((sum, tool) => sum + tool.tokens, 0);
    expect(total).toBeLessThanOrEqual(1_711);
  });

  test("browser_run's description alone is at most OMP's 1,089 tokens", () => {
    expect(countTokens(BROWSER_RUN_DESCRIPTION)).toBeLessThanOrEqual(1_089);
  });
});
