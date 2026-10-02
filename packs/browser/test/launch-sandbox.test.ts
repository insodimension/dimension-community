/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: on Linux as root (a container, a CI box) the default headless `browser_open` or `browser_run` fails, because Chrome refuses to start with its sandbox and one of the
 * browsers the pack starts did not get the switches that say otherwise. Every headless open first starts a throwaway Chrome to read the binary's identity, then the browser itself; `browser_read` starts a third.
 * All three must carry the root user's switches, or the first of them fails the open. puppeteer's `launch` is replaced by a recorder that refuses, so no browser starts and the arguments each launch was given are read.
 */
import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { createPuppeteerDriver, launchReader } from "../src/engines/puppeteer";

const ROOT_SWITCHES = ["--no-sandbox", "--disable-setuid-sandbox"];
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const realGetuid = process.getuid;
let dir: string;
let launches: Array<{ args?: string[]; protocolTimeout?: number }>;
let launcher: Mock<typeof puppeteer.launch>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dimension-launch-sandbox-"));
  launches = [];
  launcher = spyOn(puppeteer, "launch");
  launcher.mockImplementation(async (options?: { args?: string[]; protocolTimeout?: number }) => {
    launches.push(options ?? {});
    throw new Error("no browser is started by this test");
  });
});
afterEach(() => {
  // puppeteer is one module for the whole test run: the recorder must not outlive this file.
  launcher.mockRestore();
  Object.defineProperty(process, "platform", realPlatform);
  process.getuid = realGetuid;
  rmSync(dir, { recursive: true, force: true });
});

/** Runs `work` as Linux root, as far as the pack's launch code can tell. */
async function asLinuxRoot(root: boolean, work: () => Promise<unknown>): Promise<void> {
  Object.defineProperty(process, "platform", { value: "linux" });
  process.getuid = () => (root ? 0 : 1000);
  await work().catch(() => undefined);
}

describe("a Linux root user can start the pack's headless browsers", () => {
  test("the identity probe, the browser itself and the reader are all started with the sandbox switches off", async () => {
    // A file that exists stands in for the browser binary: the probe stamps it, and the recorder refuses to start it.
    const executablePath = join(dir, "chrome");
    writeFileSync(executablePath, "");
    // A headless open begins with the identity probe, and a failed probe fails the open before the browser is started; a visible one has no probe and starts the browser.
    await asLinuxRoot(true, () => createPuppeteerDriver("chromium", { profileDirectory: join(dir, "profile"), viewport: { width: 640, height: 480 }, executablePath, headless: true, onClosed: () => undefined }));
    await asLinuxRoot(true, () => createPuppeteerDriver("chromium", { profileDirectory: join(dir, "profile"), viewport: { width: 640, height: 480 }, executablePath, headless: false, onClosed: () => undefined }));
    await asLinuxRoot(true, () => launchReader({ executablePath }));
    expect(launches).toHaveLength(3);
    for (const launch of launches) expect(launch.args).toEqual(expect.arrayContaining(ROOT_SWITCHES));
  });

  test("a user who is not root gets no such switches", async () => {
    const executablePath = join(dir, "chrome-user");
    writeFileSync(executablePath, "");
    await asLinuxRoot(false, () => createPuppeteerDriver("chromium", { profileDirectory: join(dir, "profile"), viewport: { width: 640, height: 480 }, executablePath, headless: true, onClosed: () => undefined }));
    await asLinuxRoot(false, () => launchReader({ executablePath }));
    expect(launches).toHaveLength(2);
    for (const launch of launches) expect(launch.args).not.toContain("--no-sandbox");
  });

  test("no launch waits longer than a minute for one answer from its browser: the probe and the reader had puppeteer's 180 s", async () => {
    const executablePath = join(dir, "chrome-timeout");
    writeFileSync(executablePath, "");
    await asLinuxRoot(false, () => createPuppeteerDriver("chromium", { profileDirectory: join(dir, "profile"), viewport: { width: 640, height: 480 }, executablePath, headless: true, onClosed: () => undefined }));
    await asLinuxRoot(false, () => launchReader({ executablePath }));
    expect(launches.map((launch) => launch.protocolTimeout)).toEqual([60_000, 60_000]);
  });
});
