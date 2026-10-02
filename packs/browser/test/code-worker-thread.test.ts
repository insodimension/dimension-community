/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the model's code runs inside the pack's worker thread, in the same process as the pack's server. A worker
 *  thread starts with a copy of the server's environment, which holds the jev key and every other DIMENSION_* secret; if the worker does not replace it
 *  with the scrubbed one the host sent, `process.env.TYPESAFE_API_KEY` in a cell hands the model the key (doc 77 §7.4.5 promises it never can). Real worker
 *  threads, the pack's own worker core; only the tab realm is a stand-in (lane L3's needs a Chrome).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import type { HostToWorker, WorkerToHost } from "../src/code/contracts.js";

const workers = new Set<Worker>();
/** A second `terminate()` on a thread that is already gone never settles under Bun, so each thread is ended once, by whoever gets there first. */
async function stop(worker: Worker): Promise<void> {
  if (workers.delete(worker)) await worker.terminate();
}
afterEach(async () => {
  await Promise.all([...workers].map(stop));
});

const SECRETS = { TYPESAFE_API_KEY: "jev-secret-key", TEXT_MODEL_API_KEY: "text-secret-key", DIMENSION_BROWSER_ROOT: "/private/root", DIMENSION_ANYTHING: "x" };

/** A worker thread as the tests drive it: what it sends the host is kept, and `next` waits for the first message that matches. */
interface Thread {
  worker: Worker;
  next(matches: (m: WorkerToHost) => boolean): Promise<WorkerToHost>;
  send(m: HostToWorker): void;
}

/** Starts the fake-realm worker the obvious way: no `env` option, so the thread gets a copy of this process's environment. */
function startThread(): Thread {
  const worker = new Worker(new URL("./fixtures-code/fake-realm-worker.ts", import.meta.url));
  workers.add(worker);
  const seen: WorkerToHost[] = [];
  const waiting: Array<{ matches: (m: WorkerToHost) => boolean; resolve: (m: WorkerToHost) => void }> = [];
  worker.on("message", (message: WorkerToHost) => {
    seen.push(message);
    for (const wait of [...waiting]) {
      if (!wait.matches(message)) continue;
      waiting.splice(waiting.indexOf(wait), 1);
      wait.resolve(message);
    }
  });
  return {
    worker,
    next(matches) {
      const found = seen.find(matches);
      if (found) return Promise.resolve(found);
      const { promise, resolve } = Promise.withResolvers<WorkerToHost>();
      waiting.push({ matches, resolve });
      return promise;
    },
    send: message => worker.postMessage(message),
  };
}

async function textOfRun(thread: Thread, runId: string, code: string): Promise<string> {
  thread.send({ t: "run", runId, code, timeoutMs: 10_000 });
  const result = await thread.next(m => m.t === "result" && m.runId === runId);
  if (result.t !== "result" || !result.ok) throw new Error(`the run failed: ${JSON.stringify(result)}`);
  return result.payload.displays.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
}

describe("the environment a cell sees", () => {
  test("is exactly the one the host sent: the server's secrets are not in it, in any spelling", async () => {
    const before = { ...process.env };
    Object.assign(process.env, SECRETS);
    try {
      const thread = startThread();
      thread.send({ t: "init", session: "s1", env: { PATH: "/bin", LANG: "C", PUPPETEER_CACHE_DIR: "/cache" } });
      await thread.next(m => m.t === "ready");
      const text = await textOfRun(
        thread,
        "r1",
        `JSON.stringify({
          direct: process.env.TYPESAFE_API_KEY ?? null,
          keys: Object.keys(process.env).sort(),
          inherited: Object.entries(process.env).filter(([k, v]) => /secret/.test(v) || k.startsWith("DIMENSION_")).map(([k]) => k),
          spawned: (await import("node:child_process")).execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.env.TYPESAFE_API_KEY))"], { encoding: "utf8" }),
        })`,
      );
      const seen = JSON.parse(text.replace(/^display\[1\]:\n/, ""));
      expect(seen.direct).toBeNull();
      expect(seen.keys).toEqual(["LANG", "PATH", "PUPPETEER_CACHE_DIR"]);
      expect(seen.inherited).toEqual([]);
      // A process the cell starts inherits the worker's environment, so the scrub covers it too.
      expect(seen.spawned).toBe("undefined");
      // The server's own environment is what it was.
      expect(process.env.TYPESAFE_API_KEY).toBe("jev-secret-key");
    } finally {
      for (const key of Object.keys(SECRETS)) delete process.env[key];
      Object.assign(process.env, before);
    }
  }, 30_000);
});

type Finished = Extract<WorkerToHost, { t: "result" }>;

async function freshThread(): Promise<Thread> {
  const thread = startThread();
  thread.send({ t: "init", session: "s", env: {} });
  await thread.next(m => m.t === "ready");
  return thread;
}

/**
 * The host as the contract asks of it (L2's job, doc 77 §7.4.4): a failure that carries `recoverTab` ends the worker thread, and the next cell runs in a new one.
 * Without the flag the same thread is reused, which is what a worker that never asked would get.
 */
function hostOf(first: Thread): { start(runId: string, code: string, timeoutMs?: number): Promise<Finished>; cancel(runId: string): void; current(): Thread } {
  let current = first;
  return {
    current: () => current,
    cancel: runId => current.send({ t: "abort", runId }),
    start(runId, code, timeoutMs = 10_000) {
      const owner = current;
      owner.send({ t: "run", runId, code, timeoutMs });
      return owner.next(m => m.t === "result" && m.runId === runId).then(async message => {
        const result = message as Finished;
        if (!result.ok && result.error.recoverTab === true) {
          await stop(owner.worker);
          current = await freshThread();
        }
        return result;
      });
    },
  };
}

const outputOf = (result: Finished): string => (result.ok ? result.payload.displays.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n") : `ERROR ${result.error.message}`);

describe("a cancelled cell does not outlive its worker", () => {
  // OMP kills its JS worker on ANY abort (eval/js/context-manager.ts:430-448), because the only way to stop user code is to end the thread it runs in. These are the two ways a
  // cancelled cell goes on, run in a real worker thread: it keeps changing the state the next cell reads, and it keeps the thread so busy that the next cell's own budget timer never fires.

  test("a cancelled loop that changes state is not there for the next cell: the answer asks for a new worker, and the next cell starts clean", async () => {
    const host = hostOf(await freshThread());
    const looping = host.current().next(m => m.t === "text" && m.runId === "a");
    const cancelled = host.start("a", 'globalThis.n = 0; console.log("looping"); for (;;) { globalThis.n++; await new Promise(resolve => setTimeout(resolve, 5)); }');
    await looping;
    host.cancel("a");
    const result = await cancelled;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ name: "ToolAbortError", isAbort: true, recoverTab: true });
    // The cell that follows runs where the host put it. Had the worker not asked, it would be the thread the loop is still counting in.
    expect(outputOf(await host.start("b", "typeof globalThis.n"))).toBe("undefined");
  }, 30_000);

  test("a cancelled retry loop does not starve the next cell's budget timer: it answers at once, and the next cell finishes inside its own budget", async () => {
    const host = hostOf(await freshThread());
    // Once cancelled, `browser.open` throws at once, so the loop never waits again: from then on the thread runs microtasks and nothing else (no timer, no message).
    const looping = host.current().next(m => m.t === "text" && m.runId === "a");
    const cancelled = host.start("a", 'console.log("retrying"); for (;;) { try { await browser.open({ name: "x" }); } catch {} }');
    await looping;
    host.cancel("a");
    const result = await cancelled;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ isAbort: true, recoverTab: true });
    // With the budget of one second. A thread that was kept would never get to this cell's timer, and the test would end by its own limit.
    expect(outputOf(await host.start("b", "1 + 1", 1_000))).toBe("2");
  }, 30_000);
});
