/**
 * The real code worker as the product runs it: the production entry (src/code/worker/entry.ts) bundled the way the pack's build bundles it, started as a worker thread by a plain Node
 * process (fixtures-code/node-host.mjs), the tab realm attached to a real Chrome. For the tests where `bun test`'s own worker handling would get in the way (it ends any worker thread
 * with an unhandled rejection) and for the ones that need the whole init contract to arrive in a worker the way the host sends it.
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { HostToWorker, RealmInit, TabHandle, WorkerToHost } from "../src/code/contracts.js";

const packRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// `.dev/` is the pack's ignored scratch folder; the bundle must sit under the pack so Node finds puppeteer-core and @babel/parser the way it finds them for app/server.mjs.
const buildDir = join(packRoot, ".dev", `node-worker-${process.pid}`);
let bundle: Promise<string> | undefined;

/** The worker bundle, built once per test process. */
export function workerBundle(): Promise<string> {
  bundle ??= (async () => {
    await mkdir(buildDir, { recursive: true });
    const outfile = join(buildDir, "code-worker.mjs");
    await build({
      entryPoints: [join(packRoot, "src/code/worker/entry.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      loader: { ".txt": "text" },
      logLevel: "error",
    });
    return outfile;
  })();
  return bundle;
}

export async function removeWorkerBundle(): Promise<void> {
  await rm(buildDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

export type NodeWorkerMessage = WorkerToHost | { t: "worker-error"; message: string } | { t: "worker-exit"; code: number };
type Result = Extract<WorkerToHost, { t: "result" }>;

export interface NodeWorker {
  /** Everything the worker sent, in order. */
  seen: NodeWorkerMessage[];
  /** How the worker thread ended, or undefined while it is alive. */
  ended(): string | undefined;
  /** Settles with how the worker thread ended. */
  whenEnded: Promise<string>;
  /** One cell, start to answer. `sent` is what the worker said to the host while it ran. */
  cell(runId: string, code: string, timeoutMs?: number): Promise<{ result: Result; sent: NodeWorkerMessage[] }>;
  send(message: HostToWorker): void;
  stop(): Promise<void>;
}

/** Starts the worker with `init` merged over the minimal one, and waits for `ready`. `tab` is what the cell's `open` is answered with. `heapMb` is the worker thread's heap ceiling (default 1,024, the product's). */
export async function startNodeWorker(tab: TabHandle, init: Partial<RealmInit> = {}, options: { heapMb?: number } = {}): Promise<NodeWorker> {
  const host: ChildProcessByStdio<Writable, Readable, null> = spawn("node", [join(packRoot, "test/fixtures-code/node-host.mjs"), await workerBundle(), JSON.stringify(tab), JSON.stringify(init)], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
    ...(options.heapMb === undefined ? {} : { env: { ...process.env, NODE_HOST_HEAP_MB: String(options.heapMb) } }),
  });
  const seen: NodeWorkerMessage[] = [];
  const waiting: Array<{ matches: (m: NodeWorkerMessage) => boolean; resolve: (m: NodeWorkerMessage) => void; reject: (e: Error) => void }> = [];
  let ended: string | undefined;
  const endedWith = Promise.withResolvers<string>();
  const end = (how: string): void => {
    ended ??= how;
    endedWith.resolve(ended);
    for (const wait of waiting.splice(0)) wait.reject(new Error(`the worker ended (${ended})`));
  };
  createInterface({ input: host.stdout }).on("line", line => {
    const message = JSON.parse(line) as NodeWorkerMessage;
    seen.push(message);
    if (message.t === "worker-error") end(`error: ${message.message}`);
    else if (message.t === "worker-exit") end(`exit ${message.code}`);
    for (const wait of [...waiting]) {
      if (!wait.matches(message)) continue;
      waiting.splice(waiting.indexOf(wait), 1);
      wait.resolve(message);
    }
  });
  host.on("exit", code => end(`host exit ${code}`));

  const next = (matches: (m: NodeWorkerMessage) => boolean): Promise<NodeWorkerMessage> => {
    const found = seen.find(matches);
    if (found) return Promise.resolve(found);
    if (ended !== undefined) return Promise.reject(new Error(`the worker ended (${ended})`));
    const { promise, resolve, reject } = Promise.withResolvers<NodeWorkerMessage>();
    waiting.push({ matches, resolve, reject });
    return promise;
  };
  const send = (message: HostToWorker): void => void host.stdin.write(`${JSON.stringify(message)}\n`);
  await next(m => m.t === "ready");
  return {
    seen,
    ended: () => ended,
    whenEnded: endedWith.promise,
    send,
    async cell(runId, code, timeoutMs = 20_000) {
      const from = seen.length;
      send({ t: "run", runId, code, timeoutMs });
      const result = await next(m => m.t === "result" && m.runId === runId);
      if (result.t !== "result") throw new Error("unreachable");
      return { result, sent: seen.slice(from) };
    },
    async stop() {
      if (ended === undefined) {
        send({ t: "close" });
        await next(m => m.t === "closed").catch(() => undefined);
      }
      host.stdin.end();
      host.kill();
    },
  };
}
