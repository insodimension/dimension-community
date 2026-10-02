/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a model is told to call a tool it does not have. The pack lends different tools to different spaces (doc 77 §7.5a): in the default mode a code or build model has
 * `browser_run`, `browser_view`, `browser_read`, `browser_profiles` and `browser_close`; chat, labor and watch have the six step tools besides the last four; Traction has the step tools and its publish set; and
 * `DIMENSION_BROWSER_MODEL_TOOLS` changes that for everyone. Every text a model can read that names a tool - a tool's own description, the skill, the annotation chip, the refusals a cell gets - is
 * checked here against the tools THAT model has: for every mode, with and without jev's key, for every space the manifest lends the pack to.
 *
 * What a space is offered is read the way the engine reads it (`ai.insodimension/spaces` and `ui.visibility` on each tool of the real server's `tools/list`). A text that every space reads (the skill, the chip) may name
 * only the tools EVERY space has; a reference file may name the tools of the set it is for, and says it applies only to a session that has them.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CodeHostPort } from "../src/code/contracts";
import type { BrowserRuntimePort } from "../src/contracts";
import { createBrowserServer, type ModelToolsMode } from "../src/server";
import { pageFact } from "../app/view/page-annotation";

const PACK = fileURLToPath(new URL("..", import.meta.url));
const SPACES_KEY = "ai.insodimension/spaces";
const MODES: readonly ModelToolsMode[] = ["code", "steps", "both"];
const NAME = /\bbrowser_[a-z]+(?:_[a-z]+)*\b/g;

const names = (text: string): string[] => [...new Set(text.match(NAME) ?? [])].sort();

interface Listed { name: string; text: string }
/** What each space's model is offered by a real server: the tools, each with the text the model reads of it. */
type Offer = Record<string, Listed[]>;

const roots: string[] = [];
const clients: Client[] = [];
afterAll(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const manifest = JSON.parse(await readFile(join(PACK, "plugin.json"), "utf8")) as { extensions: Record<string, { artifactories: Array<{ mcpServer: string; modelSpaces: string[] }> }> };
const SPACES = manifest.extensions["ai.insodimension.dimension"]!.artifactories.find(artifactory => artifactory.mcpServer === "browser")!.modelSpaces;

const idleHost: CodeHostPort = {
  run: async () => ({ state: "running", runId: "r", outputSoFar: "" }),
  resume: async () => ({ state: "running", runId: "r", outputSoFar: "" }),
  dispose: async () => {},
};

async function offerOf(mode: ModelToolsMode, taskTools: boolean): Promise<Offer> {
  const root = await mkdtemp(join(tmpdir(), "browser-visible-names-"));
  roots.push(root);
  const viewDir = join(root, "view");
  await mkdir(viewDir, { recursive: true });
  await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
  const runtime = { connections: async () => ({}), profileMeta: async () => ({}), onConnectionsChanged: () => () => {}, dispose: async () => {} } as unknown as BrowserRuntimePort;
  const server = await createBrowserServer({ runtime, viewDir, presets: [], codeHost: idleHost, modelTools: mode, taskTools, codeArtifactsDir: join(root, "artifacts") });
  const client = new Client({ name: "model-visible-names", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  const { tools } = await client.listTools();
  const offer: Offer = {};
  for (const space of SPACES) {
    offer[space] = tools
      .filter(tool => {
        const visibility = (tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility;
        const audience = tool._meta?.[SPACES_KEY];
        return (visibility === undefined || visibility.includes("model")) && (!Array.isArray(audience) || audience.includes(space));
      })
      .map(tool => ({ name: tool.name, text: JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }) }));
  }
  return offer;
}

const offers = new Map<string, Offer>();
for (const mode of MODES) for (const taskTools of [false, true]) offers.set(`${mode}/${taskTools ? "jev" : "no jev"}`, await offerOf(mode, taskTools));

/** A text with its comments taken out: what is left is what a string literal could say. */
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

describe("the tools each space is offered are the ones the real server lists", () => {
  test("in the default mode a code or build model has browser_run and browser_view, browser_read, browser_profiles, browser_close - and no step tool, and Traction has the step tools and no browser_run", () => {
    const offer = offers.get("code/no jev")!;
    for (const space of ["code", "build"]) expect(offer[space]!.map(tool => tool.name).sort()).toEqual(["browser_close", "browser_profiles", "browser_read", "browser_run", "browser_view"]);
    expect(offer.traction!.map(tool => tool.name)).toContain("browser_open");
    expect(offer.traction!.map(tool => tool.name)).not.toContain("browser_run");
  });
});

describe("a tool's own text names only tools its reader has", () => {
  for (const [label, offer] of offers) {
    for (const space of SPACES) {
      test(`${label}, ${space}: every browser_ name in the description and the schema of every tool offered is a tool offered`, () => {
        const have = offer[space]!.map(tool => tool.name);
        const unreachable = offer[space]!.flatMap(tool => names(tool.text).filter(named => !have.includes(named)).map(named => `${tool.name} names ${named}`));
        expect(unreachable).toEqual([]);
      });
    }
  }
});

/** The tools every space has in every mode, with and without jev's key. */
const EVERY_SPACE: string[] = [...offers.values()].flatMap(offer => SPACES.map(space => offer[space]!.map(tool => tool.name))).reduce((common, list) => common.filter(name => list.includes(name)));

describe("a text every space reads names only the tools every space has", () => {
  test("the tools every space has, in every mode, are browser_view, browser_read, browser_profiles and browser_close", () => {
    expect(EVERY_SPACE.sort()).toEqual(["browser_close", "browser_profiles", "browser_read", "browser_view"]);
  });

  test("the skill's own file", async () => {
    const skill = await readFile(join(PACK, "skills/browser/SKILL.md"), "utf8");
    expect(names(skill).filter(name => !EVERY_SPACE.includes(name))).toEqual([]);
  });

  test("the annotation chip the person sends with a marked picture", () => {
    const fact = pageFact({
      url: "http://127.0.0.1:3000/", title: "App", scroll: { x: 0, y: 0, width: 1000, height: 2000 }, viewport: { width: 800, height: 600 },
      capturedAt: "2026-10-03T00:00:00.000Z", readAt: "2026-10-03T00:00:01.000Z",
    } as Parameters<typeof pageFact>[0]);
    expect(names(fact.summary).filter(name => !EVERY_SPACE.includes(name))).toEqual([]);
    // It still tells both sets of readers how: a cell by browser.active(), the step tools by leaving the id out.
    expect(fact.summary).toContain("no browserId");
    expect(fact.summary).toContain("browser.active().observe()");
  });
});

describe("a reference file names only tools of the set it is for, and is read only by a session that has that set", () => {
  const referenceFor = async (file: string, marker: string, onlyWithJev: boolean): Promise<void> => {
    const text = await readFile(join(PACK, "skills/browser/references", file), "utf8");
    const named = names(text);
    for (const [label, offer] of offers) {
      if (onlyWithJev && !label.endsWith("/jev")) continue;
      for (const space of SPACES) {
        const have = offer[space]!.map(tool => tool.name);
        // The file says it does not apply to a session without its marker tool; a session with it must have every tool the file names.
        if (!have.includes(marker)) continue;
        expect({ file, label, space, missing: named.filter(name => !have.includes(name)) }).toEqual({ file, label, space, missing: [] });
      }
    }
  };

  test("steps.md: every session with browser_open has every tool it names", async () => {
    await referenceFor("steps.md", "browser_open", false);
  });

  test("code.md: every session with browser_run has every tool it names", async () => {
    await referenceFor("code.md", "browser_run", false);
  });

  test("publishing-and-tasks.md: every session with browser_publish has the tools it names that exist (the task tools only where jev's key is set, as the file says)", async () => {
    await referenceFor("publishing-and-tasks.md", "browser_publish", true);
  });

  test("each reference says in its first lines that it applies only to a session that has its tools", async () => {
    for (const file of await readdir(join(PACK, "skills/browser/references"))) {
      const head = (await readFile(join(PACK, "skills/browser/references", file), "utf8")).split("\n").slice(0, 8).join("\n");
      expect(head).toMatch(/cannot see|If you cannot see|does not apply/);
    }
  });
});

describe("a text a cell can read names only tools a cell's space has", () => {
  // The code host, the worker and the launch kinds are what a cell's error comes from. A cell runs where browser_run is offered, and there the model has browser_run and the four tools every space has.
  test("no string literal under src/code names a tool but browser_run and the four every space has", async () => {
    const allowed = ["browser_run", ...EVERY_SPACE];
    const found: Record<string, string[]> = {};
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith(".ts")) {
          const stray = names(withoutComments(await readFile(path, "utf8"))).filter(name => !allowed.includes(name));
          if (stray.length > 0) found[path.slice(PACK.length)] = stray;
        }
      }
    };
    await walk(join(PACK, "src/code"));
    expect(found).toEqual({});
  });
});
