import type { BrowserEngine } from "../contracts.js";
import { fail } from "../store.js";
import { createPuppeteerDriver } from "./puppeteer.js";
import { isRefused, REFUSED_ENGINES } from "./refused.js";
import type { EngineDriver, EngineOptions } from "./types.js";

/** Refused engines are rejected before anything is locked or launched. */
export function assertEngineAvailable(engine: BrowserEngine): void {
  if (isRefused(engine)) fail(REFUSED_ENGINES[engine].code, REFUSED_ENGINES[engine].message);
}

export function createEngineDriver(engine: BrowserEngine, options: EngineOptions): Promise<EngineDriver> {
  assertEngineAvailable(engine);
  // A browser to attach to is the attach engine's alone; no other engine has one to give it to.
  if (options.attach !== undefined && engine !== "chrome-relay") fail("bad_engine", `engine ${engine} launches its own browser; an attach target belongs to chrome-relay`);
  return createPuppeteerDriver(engine === "chrome-relay" ? "chrome-relay" : "chromium", options);
}
