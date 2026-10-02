/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an application a cell's `browser.open({ app: { path } })` started keeps running with nobody holding it, or the pack signals a process that is not its own. A detached Chrome
 * or Electron app left behind by a failed, cancelled or abandoned open has no entry, no idle clock and no retry; a pid that was recycled by another program after the application exited is a stranger, and
 * `taskkill /T` or a group signal on it takes whatever the person was running with it. These tests start REAL processes (a stand-in application that opens the debugging port it is told, and a bystander) and read
 * by pid whether they are gone; the runtime's pool refusals are scripted at the seam, the rest is the pack's own code. A real Chrome as the application is in code-kinds.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { RuntimeCodeBrowsers, type CodeLifetime, type CodeSeam } from "../src/code/host/runtime-port";
import type { AcquiredBrowser, BrowserKind } from "../src/code/contracts";
import { findFreeCdpPort } from "../src/code/kinds/cdp";
import { establishKind } from "../src/code/kinds/establish";
import { establishSpawned, type ProcessScanner } from "../src/code/kinds/spawned";
import { ownedPids } from "../src/owned-pids";
import { BrowserRuntimeError } from "../src/store";
import { alive, gone, killTree } from "./kinds-fixture";
import { createRoot, newRuntime, teardown, waitUntil } from "./fixture";

const FAKE_APP = fileURLToPath(new URL("./fake-cdp-app.ts", import.meta.url));
/** A machine with the application not running: every other process on it (a test's, a person's) is out of sight, so an open starts its own. */
const NOTHING_RUNNING: ProcessScanner = { running: async () => ({ processes: [], unreadable: false }) };

const pids = new Set<number>();
const bystanders: ChildProcess[] = [];
afterEach(async () => {
  for (const pid of pids) await killTree(pid);
  pids.clear();
  for (const child of bystanders.splice(0)) if (child.pid !== undefined) await killTree(child.pid);
  await teardown();
});

/** The kind a cell names for the stand-in application. */
const appKind = (extra: string[] = []): Extract<BrowserKind, { kind: "spawned" }> => ({ kind: "spawned", path: process.execPath, args: [FAKE_APP, ...extra] });

/** `establishKind` that remembers the pid of every application it started, so the test can look for it afterwards. */
function recordingEstablish(started: number[], after?: () => void): typeof establishKind {
  return async (kind, options) => {
    const made = await establishKind(kind, { ...options, scanner: NOTHING_RUNNING });
    if ("attach" in made && made.attach.pid !== undefined) {
      started.push(made.attach.pid);
      pids.add(made.attach.pid);
    }
    after?.();
    return made;
  };
}

function bystander(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  bystanders.push(child);
  return child.pid!;
}

interface FakeSeamLog { opened: number; closed: string[]; killWhenClosed: boolean[] }

/** A runtime scripted at the port's seam: `open` does what the test says, and `close` records what the entry's lifetime said at that moment. */
function scriptedSeam(open: (code: CodeLifetime) => Promise<{ browserId: string }>): { seam: CodeSeam; log: FakeSeamLog } {
  const log: FakeSeamLog = { opened: 0, closed: [], killWhenClosed: [] };
  const entries = new Map<string, { browserId: string; code: CodeLifetime; closed: boolean; profile: null; engine: string; driver: { cdpEndpoint(): string } }>();
  const seam = {
    async open(_options: unknown, _opener: unknown, code: CodeLifetime) {
      log.opened += 1;
      const state = await open(code);
      entries.set(state.browserId, { browserId: state.browserId, code, closed: false, profile: null, engine: "chrome-relay", driver: { cdpEndpoint: () => `ws://fake/${state.browserId}` } });
      return state;
    },
    require: (browserId: string) => entries.get(browserId)!,
    peek: (browserId: string) => entries.get(browserId),
    browsersOf: () => [...entries.values()],
    viewOf: () => undefined,
    bindView: () => undefined,
    async close(browserId: string) {
      log.closed.push(browserId);
      log.killWhenClosed.push(entries.get(browserId)?.code.kill === true);
      entries.delete(browserId);
    },
  } as unknown as CodeSeam;
  return { seam, log };
}

const never = new AbortController().signal;

describe("an application a cell started does not outlive an open that failed or was given up", () => {
  test("the runtime refusing the open after the application is up (the pool is full) ends the application", async () => {
    const started: number[] = [];
    const { seam } = scriptedSeam(async () => {
      throw new BrowserRuntimeError("too_many_browsers", "the pool is full");
    });
    const port = new RuntimeCodeBrowsers(seam, { establish: recordingEstablish(started) });
    await expect(port.acquire("s", { kind: appKind() }, never)).rejects.toMatchObject({ code: "too_many_browsers" });
    expect(started).toHaveLength(1);
    expect(await gone(started[0]!)).toBe(true);
  }, 60_000);

  test("a connection the application refuses (puppeteer.connect fails inside the real runtime) ends the application", async () => {
    const started: number[] = [];
    const runtime = newRuntime(await createRoot());
    const port = new RuntimeCodeBrowsers(runtime.codeSeam(), { establish: recordingEstablish(started) });
    await expect(port.acquire("s", { kind: appKind() }, never)).rejects.toMatchObject({ code: "attach_failed" });
    expect(started).toHaveLength(1);
    expect(await gone(started[0]!)).toBe(true);
  }, 60_000);

  test("a cell cancelled as the application comes up never reaches the runtime, and the application is ended", async () => {
    const started: number[] = [];
    const cancel = new AbortController();
    const { seam, log } = scriptedSeam(async () => ({ browserId: "b1" }));
    const port = new RuntimeCodeBrowsers(seam, { establish: recordingEstablish(started, () => cancel.abort()) });
    await port.acquire("s", { kind: appKind() }, cancel.signal).catch(() => undefined);
    await waitUntil("the application to be gone", async () => (started.length === 1 && !alive(started[0]!)), done => done, 15_000);
    expect(log.opened).toBe(0);
  }, 60_000);

  test("an open nobody waits for by the time the runtime has it is closed with the application's kill flag set, and the application is ended", async () => {
    const started: number[] = [];
    const cancel = new AbortController();
    const { seam, log } = scriptedSeam(async () => {
      cancel.abort(); // the cell's deadline passes while the runtime attaches
      await nextTurn();
      return { browserId: "b1" };
    });
    const port = new RuntimeCodeBrowsers(seam, { establish: recordingEstablish(started) });
    await port.acquire("s", { kind: appKind() }, cancel.signal).catch(() => undefined);
    await waitUntil("the abandoned browser to be closed", async () => log.closed, closed => closed.length === 1, 15_000);
    // The runtime ends the application only when the entry says so; this is what it read at close.
    expect(log.killWhenClosed).toEqual([true]);
  }, 60_000);

  test("an application that was already running is not the pack's to end: a failed open leaves it running", async () => {
    const port0 = await findFreeCdpPort();
    const running = spawn(process.execPath, [FAKE_APP, `--remote-debugging-port=${port0}`], { stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" });
    bystanders.push(running);
    await waitUntil("the application to listen", async () => (await fetch(`http://127.0.0.1:${port0}/json/version`).then(r => r.status, () => 0)), status => status === 200, 15_000);
    const sees: ProcessScanner = { running: async () => ({ processes: [{ pid: running.pid!, args: [FAKE_APP, `--remote-debugging-port=${port0}`] }], unreadable: false }) };
    const { seam } = scriptedSeam(async () => {
      throw new BrowserRuntimeError("too_many_browsers", "the pool is full");
    });
    const port = new RuntimeCodeBrowsers(seam, { establish: (kind, options) => establishKind(kind, { ...options, scanner: sees }) });
    await expect(port.acquire("s", { kind: appKind() }, never)).rejects.toMatchObject({ code: "too_many_browsers" });
    expect(alive(running.pid!)).toBe(true);
  }, 60_000);
});

/** A stand-in for an application's port inside this process: answers `/json/version` on the port the spawner was told to use, and stops. */
function answerOn(args: string[]): Server {
  const requested = Number(args.find(arg => arg.startsWith("--remote-debugging-port="))!.split("=")[1]);
  return createServer((_request, response) => response.end("{}")).listen(requested, "127.0.0.1");
}

function stop(server: Server | undefined): void {
  server?.closeAllConnections();
  server?.close();
}

function nextTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

describe("establishSpawned", () => {
  test("an abort that lands as the port opens ends the application it just started", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    bystanders.push(child);
    let flag = false;
    let server: Server | undefined;
    const cancel = new AbortController();
    // The cell's signal reads as aborted from the moment the application's port has answered: after the wait for it has finished, before anything is returned.
    Object.defineProperty(cancel.signal, "aborted", { get: () => flag });
    try {
      const app = establishSpawned(
        { path: process.execPath, args: ["unused"] },
        {
          scanner: NOTHING_RUNNING,
          signal: cancel.signal,
          spawner: (_exe, args) => {
            server = answerOn(args);
            server.on("request", () => setImmediate(() => (flag = true)));
            return { pid: child.pid, exited: new Promise<number | null>(resolve => child.once("exit", code => resolve(code))) };
          },
        },
      );
      await expect(app).rejects.toThrow("Operation aborted");
      expect(await gone(child.pid!)).toBe(true);
    } finally {
      stop(server);
    }
  }, 60_000);

  test("terminate ends the whole tree of the application it started", async () => {
    const app = await establishSpawned({ path: process.execPath, args: [FAKE_APP] }, { scanner: NOTHING_RUNNING });
    pids.add(app.pid);
    expect(alive(app.pid)).toBe(true);
    await app.terminate!();
    expect(await gone(app.pid)).toBe(true);
  }, 60_000);

  test("terminate does nothing once the application has exited: its pid names a stranger by then", async () => {
    const stranger = bystander();
    const exit = Promise.withResolvers<number | null>();
    let server: Server | undefined;
    try {
      const app = await establishSpawned(
        { path: process.execPath, args: ["unused"] },
        { scanner: NOTHING_RUNNING, spawner: (_exe, args) => ((server = answerOn(args)), { pid: stranger, exited: exit.promise }) },
      );
      // The application quit on its own; as far as anything can tell the number now belongs to the stranger.
      exit.resolve(0);
      await nextTurn();
      await app.terminate!();
      expect(alive(stranger)).toBe(true);
    } finally {
      stop(server);
    }
  }, 60_000);

  test("an application it started is owned while it runs, so the shutdown sweep of what cells left behind leaves it open, and is not once it has exited", async () => {
    const app = await establishSpawned({ path: process.execPath, args: [FAKE_APP] }, { scanner: NOTHING_RUNNING });
    pids.add(app.pid);
    expect(ownedPids.has(app.pid)).toBe(true);
    await app.terminate!();
    expect(await gone(app.pid)).toBe(true);
    await waitUntil("the exit to be seen", async () => ownedPids.has(app.pid), owned => !owned, 15_000);
  }, 60_000);

  test("an application that was already running has no terminate: it is not the pack's to end", async () => {
    const port = await findFreeCdpPort();
    const running = spawn(process.execPath, [FAKE_APP, `--remote-debugging-port=${port}`], { stdio: "ignore", windowsHide: true });
    bystanders.push(running);
    await waitUntil("the application to listen", async () => await fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.status, () => 0), status => status === 200, 15_000);
    const sees: ProcessScanner = { running: async () => ({ processes: [{ pid: running.pid!, args: [FAKE_APP, `--remote-debugging-port=${port}`] }], unreadable: false }) };
    const app = await establishSpawned({ path: process.execPath, args: [FAKE_APP] }, { scanner: sees });
    expect(app).toMatchObject({ reused: true, pid: running.pid });
    expect(app.terminate).toBeUndefined();
  }, 60_000);
});
