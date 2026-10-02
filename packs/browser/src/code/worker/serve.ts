// Written for the Browser pack. The thread wiring of OMP's tab-worker-entry.ts (packages/coding-agent/src/tools/browser/tab-worker-entry.ts @ dc5f95d9e1) lives here so a test can start the real worker with a fake tab realm.

import { parentPort } from "node:worker_threads";
import type { HostToWorker, Transport, WorkerToHost } from "../contracts.js";
import { WorkerCore, type WorkerCoreOptions } from "./dispatch.js";

/** Serves the host's messages on this worker thread's parent port, with the tab realm `createRealm` makes. Throws outside a worker thread. */
export function serveOnParentPort(createRealm: WorkerCoreOptions["createRealm"]): WorkerCore {
  const port = parentPort;
  if (!port) throw new Error("The code worker must run in a worker thread");
  const transport: Transport<HostToWorker, WorkerToHost> = {
    send: message => port.postMessage(message),
    onMessage: handler => {
      const listener = (message: HostToWorker): void => handler(message);
      port.on("message", listener);
      return () => port.off("message", listener);
    },
    close: () => port.close(),
  };
  return new WorkerCore({ transport, guardRejections: true, createRealm });
}
