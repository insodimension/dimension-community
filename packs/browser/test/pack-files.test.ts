/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a pack installed from its `files` list (npm pack, a marketplace that copies the listed files) gets a server whose `browser_run` fails on every call with "Tab worker
 * failed during startup", while every plain tool keeps working, so nobody notices. The server loads the code worker from beside itself (`app/code-worker.mjs`); the list must name every bundle it loads.
 * The same list is what redistributes OMP (MIT) and Playwright (Apache-2.0) code: the bundles drop the `//` licence headers, so an install without `third-party/` and `THIRD-PARTY-NOTICES.md` carries
 * that code with no notice, which the licences do not allow. And a path listed that is not on disk ships nothing, silently.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { WORKER_BUNDLE } from "../src/code/host/transport";

const packUrl = (path: string): URL => new URL(`../${path}`, import.meta.url);
const read = (path: string): unknown => JSON.parse(readFileSync(packUrl(path), "utf8"));

/** Whether `files` ships `path`: listed itself, or inside a listed directory. */
function ships(files: readonly string[], path: string): boolean {
  return files.some(entry => entry === path || (entry.endsWith("/") && path.startsWith(entry)));
}

describe("what the pack ships", () => {
  const { files } = read("package.json") as { files: string[] };
  const { mcpServers } = read("ai.insodimension.dimension/mcp.json") as { mcpServers: Record<string, { args: string[] }> };

  test("every bundle the entry loads is in the shipped file list: the launcher, the server it hands over to, and the code worker", () => {
    const entry = mcpServers.browser?.args[0];
    expect(entry).toBe("app/launch.mjs");
    const loaded = [entry as string, "app/server.mjs", `app/${WORKER_BUNDLE}`];
    expect(loaded.filter(bundle => !ships(files, bundle))).toEqual([]);
  });

  test("the licence notices ship with the code they cover: THIRD-PARTY-NOTICES.md, OMP's licence, Playwright's licence and its NOTICE, and the relay extension's licence", () => {
    const notices = ["THIRD-PARTY-NOTICES.md", "third-party/omp/LICENSE", "third-party/playwright/LICENSE", "third-party/playwright/NOTICE", "relay-extension/LICENSE"];
    expect(notices.filter(notice => !ships(files, notice))).toEqual([]);
    expect(notices.filter(notice => !existsSync(packUrl(notice)))).toEqual([]);
  });

  test("every path the list names is on disk, so nothing it promises is silently missing from the install", () => {
    expect(files.filter(path => !existsSync(packUrl(path)))).toEqual([]);
  });

  test("the check itself notices a missing bundle", () => {
    expect(ships(["app/server.mjs", "app/dist/"], `app/${WORKER_BUNDLE}`)).toBe(false);
    expect(ships(["app/server.mjs", "app/dist/"], "app/dist/index.html")).toBe(true);
  });
});
