/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the model's code runs inside the pack's worker thread, in the same process as the pack's server. A worker
 *  thread starts with a copy of the server's environment, which holds the jev key and every other DIMENSION_* secret; if the worker does not replace it
 *  with the scrubbed one the host sent, `process.env.TYPESAFE_API_KEY` in a cell hands the model the key (doc 77 §7.4.5 promises it never can). Real worker
 *  threads, the pack's own worker core; only the tab realm is a stand-in (lane L3's needs a Chrome).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import type { HostToWorker, WorkerToHost } from "../src/code/contracts.js";

const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.terminate()));
});

const SECRETS = { TYPESAFE_API_KEY: "jev-secret-key", TEXT_MODEL_API_KEY: "text-secret-key", DIMENSION_BROWSER_ROOT: "/private/root", DIMENSION_ANYTHING: "x" };

/** Starts the fake-realm worker the obvious way: no `env` option, so the thread gets a copy of this process's environment. */
function startThread(): { worker: Worker; next(matches: (m: WorkerToHost) => boolean): Promise<WorkerToHost>; send(m: HostToWorker): void } {
  const worker = new Worker(new URL("./fixtures-code/fake-realm-worker.ts", import.meta.url));
  workers.push(worker);
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

async function textOfRun(thread: ReturnType<typeof startThread>, runId: string, code: string): Promise<string> {
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
