// Written for the Browser pack (doc 77 §7.4.4). OMP abstracts where the tab worker runs behind a `Transport` (tab-protocol.ts:139-143) with a subprocess rung and a Worker-thread rung
// (tab-supervisor.ts:1641-1778); this is the thread rung, which the pack uses: a thread starts in tens of milliseconds and shares the bundle. The inline rung is not ported — a cell stuck in a
// synchronous loop would freeze every browser the server holds, the reason OMP refuses it in a shared host (tab-supervisor.ts:1724-1728). Nothing above this file knows it is a thread.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HeapInfo } from "node:v8";
import { Worker } from "node:worker_threads";
import type { HostToWorker, Transport, WorkerToHost } from "../contracts.js";

/** What a worker holds in memory, as far as the runtime can tell. */
export interface WorkerMemory {
  /** The worker's JS heap plus its Buffers and ArrayBuffers (the memory a heap limit does not cover), in MB. */
  mb: number;
  /**
   * True when `mb` is this worker's own (Node 22.16+ and 24: `worker.getHeapStatistics()`, answered by the worker thread even while its JavaScript spins in a loop).
   * False when the runtime has no such call (Node 22.12 to 22.15, Bun): `mb` is then the whole process's resident set, and only a growth of it during a cell says anything about that cell.
   */
  own: boolean;
}

/** One running code worker, as the host sees it. */
export interface WorkerHandle {
  readonly transport: Transport<WorkerToHost, HostToWorker>;
  /**
   * Ends the worker. Answers `exited` once the thread is gone, or `stuck` when `limitMs` passed first: a thread inside a synchronous native call (an `execSync`, a blocking pipe read) cannot
   * be interrupted by anything, and `Worker.terminate()` answers only when that call returns (18.4 s measured for an 18 s call). The thread still ends when the call does; `onExit` tells.
   */
  terminate(limitMs: number): Promise<"exited" | "stuck">;
  /** Called once when the worker has exited, for any reason (`reason` says how). */
  onExit(handler: (reason: string) => void): void;
  /** What the worker holds now; undefined when it has exited or does not answer. Never waits longer than a moment for a worker that is stuck in a native call. */
  memory(): Promise<WorkerMemory | undefined>;
}

/** Starts a worker serving one session. `env` is the scrubbed environment the cell may see. */
export type SpawnWorker = (options: { env: Record<string, string> }) => WorkerHandle;

/** Worker threads created by this process that have not exited. `process.exit()` waits for every one of them, so a thread stuck in a native call keeps a finished server alive: whoever ends the process asks. */
let unexitedThreads = 0;
export function unexitedWorkerThreads(): number {
  return unexitedThreads;
}

export interface ThreadLimits {
  /** The worker's V8 old-generation heap, MB. A cell that outgrows it ends its own thread with an out-of-memory error; the server process and every other session's browsers go on. */
  maxOldGenerationSizeMb: number;
}

/** The code worker's bundle, beside the server's (`app/code-worker.mjs`). The pack's `files` list must ship it: a server without it answers every `browser_run` with a startup failure. */
export const WORKER_BUNDLE = "code-worker.mjs";

/**
 * Where the worker's code is. The bundled server (`app/server.mjs`) has the worker beside it (`app/code-worker.mjs`, the second esbuild entry);
 * running from source (the tests, a dev checkout) it is the worker's TypeScript entry.
 */
export function defaultWorkerEntry(): URL {
  const bundled = new URL(`./${WORKER_BUNDLE}`, import.meta.url);
  return existsSync(fileURLToPath(bundled)) ? bundled : new URL("../worker/entry.ts", import.meta.url);
}

const MB = 1024 * 1024;
/** How long one memory question to a worker gets: a worker blocked in a native call never answers, and that is not a reason to ask again and again. */
const MEMORY_ANSWER_MS = 500;

/** The thread rung: `worker_threads`, with its stdio held back (the server's stdout is the MCP stream; a stray write from a cell must never reach it). */
export function threadWorkerSpawner(entry: URL | string, limits: ThreadLimits): SpawnWorker {
  return ({ env }) => {
    const worker = new Worker(entry, { env, stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb } });
    unexitedThreads += 1;
    // Node keeps a worker's stdout and stderr off the parent's when asked to, and hands them over as streams (Bun gives none). Both go to the server's stderr, where its own logs go.
    worker.stdout?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    worker.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    const listeners = new Set<(message: WorkerToHost) => void>();
    worker.on("message", (message: WorkerToHost) => {
      for (const listener of [...listeners]) listener(message);
    });
    const exited = Promise.withResolvers<string>();
    let gone = false;
    let reason = "";
    worker.on("error", (error: Error & { code?: string }) => {
      // The error event precedes the exit; its text is why the thread died (an out-of-memory has its own code).
      reason = error.code === "ERR_WORKER_OUT_OF_MEMORY" ? `it ran out of memory (${limits.maxOldGenerationSizeMb} MB heap)` : error.message;
    });
    worker.once("exit", (code: number) => {
      gone = true;
      unexitedThreads -= 1;
      exited.resolve(reason || (code === 0 ? "it exited" : `it exited with code ${code}`));
    });
    // One terminate per thread however often it is asked: a second one on a thread that has already exited never settles under Bun, and on a stuck thread it would only be another pending promise.
    let terminating: Promise<unknown> | undefined;
    const end = (): Promise<unknown> => (terminating ??= worker.terminate());
    let asking: Promise<HeapInfo> | undefined;
    return {
      transport: {
        send: message => worker.postMessage(message),
        onMessage: handler => {
          listeners.add(handler);
          return () => void listeners.delete(handler);
        },
        close: () => {
          if (!gone) void end();
        },
      },
      terminate: async limitMs => {
        if (gone) return "exited";
        const timer = Promise.withResolvers<"stuck">();
        const limit = setTimeout(timer.resolve, limitMs, "stuck");
        try {
          return await Promise.race([end().then(() => exited.promise).then(() => "exited" as const), timer.promise]);
        } finally {
          clearTimeout(limit);
        }
      },
      onExit: handler => void exited.promise.then(handler),
      memory: async () => {
        if (gone) return undefined;
        if (typeof worker.getHeapStatistics !== "function") return { mb: process.memoryUsage.rss() / MB, own: false };
        const limit = Promise.withResolvers<undefined>();
        const timer = setTimeout(limit.resolve, MEMORY_ANSWER_MS);
        try {
          // One question in flight at a time: a worker in a native call leaves it unanswered, and asking again every tick would only queue more behind it.
          if (asking === undefined) {
            const asked = worker.getHeapStatistics();
            asking = asked;
            const clear = (): void => {
              if (asking === asked) asking = undefined;
            };
            asked.then(clear, clear);
          }
          const stats = await Promise.race([asking, limit.promise]);
          return stats === undefined ? undefined : { mb: (stats.used_heap_size + stats.external_memory) / MB, own: true };
        } catch {
          return undefined;
        } finally {
          clearTimeout(timer);
        }
      },
    };
  };
}
