/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a pack installed from its `files` list (npm pack, a marketplace that copies the listed files) gets a server whose `browser_run` fails on every call with "Tab worker
 * failed during startup", while every plain tool keeps working, so nobody notices. The server loads the code worker from beside itself (`app/code-worker.mjs`); the list must name every bundle it loads.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { WORKER_BUNDLE } from "../src/code/host/transport";

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

/** Whether `files` ships `path`: listed itself, or inside a listed directory. */
function ships(files: readonly string[], path: string): boolean {
  return files.some(entry => entry === path || (entry.endsWith("/") && path.startsWith(entry)));
}

describe("what the pack ships", () => {
  const { files } = read("package.json") as { files: string[] };
  const { mcpServers } = read("ai.insodimension.dimension/mcp.json") as { mcpServers: Record<string, { args: string[] }> };

  test("every bundle the server loads is in the shipped file list: the server itself and its code worker", () => {
    const server = mcpServers.browser?.args[0];
    expect(server).toBe("app/server.mjs");
    const loaded = [server as string, `app/${WORKER_BUNDLE}`];
    expect(loaded.filter(bundle => !ships(files, bundle))).toEqual([]);
  });

  test("the check itself notices a missing bundle", () => {
    expect(ships(["app/server.mjs", "app/dist/"], `app/${WORKER_BUNDLE}`)).toBe(false);
    expect(ships(["app/server.mjs", "app/dist/"], "app/dist/index.html")).toBe(true);
  });
});
