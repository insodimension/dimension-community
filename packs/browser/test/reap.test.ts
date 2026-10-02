/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: when the server has to end with a cell inside a call that cannot be interrupted, Windows leaves that cell's child processes (a dev server, `ping -t`) running, because
 * it has no process group. The sweep that ends them must end ONLY what this server started and means to end: Windows never updates a process's parent id and reuses pids, so a process whose "parent" is a dead
 * process that once had our pid is not ours; a saved profile's Chrome is closed by its owner (a hard kill could cut a write to its logins); an application a cell opened for the person (`app.path`) is documented
 * as staying open. Each of those is in `ownedPids` or older than the server, and none may be touched.
 */
import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { OwnedPids } from "../src/owned-pids";
import { dmtfToMs, parseProcessRows, reapChildren, selectReapable, type ProcessRow } from "../src/reap";
import { isAlive, waitUntilGone } from "./chrome-processes";

const row = (pid: number, parentPid: number, created: string, name = "node.exe"): ProcessRow => ({ pid, parentPid, name, createdMs: dmtfToMs(created) });
const SERVER = 1000;
const STARTED = "20261002100000.000000+120";
const LATER = "20261002100500.250000+120";
const EARLIER = "20261002095900.000000+120";

describe("which processes the sweep may end", () => {
  test("a child of the server that began after it did, and that nobody else owns", () => {
    const rows = [row(SERVER, 4, STARTED), row(11, SERVER, LATER)];
    expect(selectReapable(rows, { parentPid: SERVER, owned: new OwnedPids(), skip: [] }).map(r => r.pid)).toEqual([11]);
  });

  test("a process that names the server's pid as its parent but is older than the server is the child of an earlier process that had this pid, and is left alone", () => {
    const rows = [row(SERVER, 4, STARTED), row(11, SERVER, EARLIER), row(12, SERVER, LATER)];
    expect(selectReapable(rows, { parentPid: SERVER, owned: new OwnedPids(), skip: [] }).map(r => r.pid)).toEqual([12]);
  });

  test("a process the pack's browsers or applications own is left alone, and so is the helper that ran the query", () => {
    const owned = new OwnedPids();
    owned.add(21);
    const rows = [row(SERVER, 4, STARTED), row(21, SERVER, LATER, "chrome.exe"), row(22, SERVER, LATER, "powershell.exe"), row(23, SERVER, LATER)];
    expect(selectReapable(rows, { parentPid: SERVER, owned, skip: [22] }).map(r => r.pid)).toEqual([23]);
  });

  test("with no row for the server itself nothing is ended: its start cannot be told, so nothing can be called older or newer", () => {
    expect(selectReapable([row(11, SERVER, LATER)], { parentPid: SERVER, owned: new OwnedPids(), skip: [] })).toEqual([]);
  });

  test("a child of another process, and the server's own row, are never candidates", () => {
    const rows = [row(SERVER, 4, STARTED), row(31, 777, LATER), row(SERVER, SERVER, LATER)];
    expect(selectReapable(rows, { parentPid: SERVER, owned: new OwnedPids(), skip: [] })).toEqual([]);
  });

  test("start times are compared as instants: the same moment under two UTC offsets is the same moment", () => {
    expect(dmtfToMs("20261002100000.000000+120")).toBe(dmtfToMs("20261002090000.000000+060"));
    expect(dmtfToMs("20261002100000.500000+120") - dmtfToMs("20261002100000.000000+120")).toBe(500);
    expect(dmtfToMs("20261002100000.000000-300")).toBe(dmtfToMs("20261002150000.000000+000"));
  });

  test("the query's output is read line by line, and a line that is not a process is skipped", () => {
    const out = `1000\t4\tnode.exe\t${STARTED}\r\nnoise\r\n11\t1000\tcmd.exe\t${LATER}\r\n`;
    expect(parseProcessRows(out).map(r => [r.pid, r.parentPid, r.name])).toEqual([[1000, 4, "node.exe"], [11, 1000, "cmd.exe"]]);
  });
});

const describeWindows = process.platform === "win32" ? describe : describe.skip;
const NODE = Bun.which("node") ?? process.execPath;

/** A stand-in server with its own children, so no other test's process can be among them: it starts one child of each kind and reports their pids. */
const STAND_IN = `
const { spawn } = require("node:child_process");
const sleeper = ["-e", "setTimeout(() => {}, 120000)"];
const plain = spawn(process.execPath, sleeper, { stdio: "ignore" });
const browser = spawn(process.execPath, sleeper, { stdio: "ignore" });
const app = spawn(process.execPath, sleeper, { stdio: "ignore", detached: true });
app.unref();
process.stdout.write(JSON.stringify({ plain: plain.pid, browser: browser.pid, app: app.pid }) + "\\n");
setTimeout(() => {}, 120000);
`;

const stands: Array<{ kill(): void }> = [];
const spare: number[] = [];
afterEach(() => {
  for (const stand of stands.splice(0)) stand.kill();
  for (const pid of spare.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

describeWindows("the sweep on real processes", () => {
  test("it ends the child a cell left behind and not the saved profile's browser or the application the person keeps, and the stand-in server lives", async () => {
    const stand = Bun.spawn([NODE, "-e", STAND_IN], { stdout: "pipe", stderr: "ignore" });
    stands.push(stand);
    const line = await new Promise<string>(resolve => {
      let text = "";
      const reader = stand.stdout.getReader();
      void (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          text += new TextDecoder().decode(value);
          if (text.includes("\n")) return resolve(text);
        }
      })();
    });
    const pids = JSON.parse(line) as { plain: number; browser: number; app: number };
    spare.push(pids.browser, pids.app);
    const owned = new OwnedPids();
    owned.add(pids.browser); // a saved profile's Chrome: its owner closes it
    owned.add(pids.app); // an application opened for the person: it stays open
    // The children began after the stand-in did; a moment of margin keeps the clock's resolution out of it.
    const ended = await reapChildren({ parentPid: stand.pid, owned, limitMs: 10_000 });
    expect(ended).toEqual([pids.plain]);
    expect(await waitUntilGone([pids.plain], 10_000)).toEqual([]);
    expect(isAlive(pids.browser)).toBe(true);
    expect(isAlive(pids.app)).toBe(true);
    expect(isAlive(stand.pid)).toBe(true);
  }, 60_000);

  test("a sweep that cannot run (no such shell) ends nothing and does not throw", async () => {
    const child = spawn(NODE, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    spare.push(child.pid!);
    expect(await reapChildren({ parentPid: process.pid, owned: new OwnedPids(), shell: "no-such-shell-for-the-sweep", limitMs: 2_000 })).toEqual([]);
    expect(isAlive(child.pid!)).toBe(true);
  }, 30_000);
});
