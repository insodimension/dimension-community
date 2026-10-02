// Written for the Browser pack (doc 77 §7.4.4). OMP abstracts where the tab worker runs behind a `Transport` (tab-protocol.ts:139-143) with a subprocess rung and a Worker-thread rung
// (tab-supervisor.ts:1641-1778); this is the thread rung, which the pack uses: a thread starts in tens of milliseconds and shares the bundle. The inline rung is not ported — a cell stuck in a
// synchronous loop would freeze every browser the server holds, the reason OMP refuses it in a shared host (tab-supervisor.ts:1724-1728). Nothing above this file knows it is a thread.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { HostToWorker, Transport, WorkerToHost } from "../contracts.js";

/** One running code worker, as the host sees it. */
export interface WorkerHandle {
  readonly transport: Transport<WorkerToHost, HostToWorker>;
  /** Ends the worker now. A cell in a synchronous loop cannot answer a `close`, so this is the only way to stop it. Resolves once the thread has exited (at once when it already has). */
  terminate(): Promise<void>;
  /** Called once when the worker has exited, for any reason (`reason` says how). */
  onExit(handler: (reason: string) => void): void;
}

/** Starts a worker serving one session. `env` is the scrubbed environment the cell may see. */
export type SpawnWorker = (options: { env: Record<string, string> }) => WorkerHandle;

export interface ThreadLimits {
  /** The worker's V8 old-generation heap, MB. A cell that outgrows it ends its own thread with an out-of-memory error; the server process and every other session's browsers go on. */
  maxOldGenerationSizeMb: number;
}

/**
 * Where the worker's code is. The bundled server (`app/server.mjs`) has the worker beside it (`app/code-worker.mjs`, the second esbuild entry);
 * running from source (the tests, a dev checkout) it is the worker's TypeScript entry.
 */
export function defaultWorkerEntry(): URL {
  const bundled = new URL("./code-worker.mjs", import.meta.url);
  return existsSync(fileURLToPath(bundled)) ? bundled : new URL("../worker/entry.ts", import.meta.url);
}

/** The thread rung: `worker_threads`, with its stdio held back (the server's stdout is the MCP stream; a stray write from a cell must never reach it). */
export function threadWorkerSpawner(entry: URL | string, limits: ThreadLimits): SpawnWorker {
  return ({ env }) => {
    const worker = new Worker(entry, { env, stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb } });
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
      exited.resolve(reason || (code === 0 ? "it exited" : `it exited with code ${code}`));
    });
    return {
      transport: {
        send: message => worker.postMessage(message),
        onMessage: handler => {
          listeners.add(handler);
          return () => void listeners.delete(handler);
        },
        close: () => {
          if (!gone) void worker.terminate();
        },
      },
      // A second `terminate` on a thread that has already exited never settles under Bun; it is not asked.
      terminate: async () => {
        if (!gone) await worker.terminate();
        await exited.promise;
      },
      onExit: handler => void exited.promise.then(handler),
    };
  };
}
