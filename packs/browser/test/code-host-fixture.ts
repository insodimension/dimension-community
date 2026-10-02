/**
 * What the code host's tests stand on: the pack's REAL runtime over a real headless Chrome (test/fixture.ts), a REAL code host with a real worker thread running the real tab realm, and a
 * local server with the few pages the cells drive. A cell is run the way `browser_run` runs it: through `CodeHost.run`.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { CodeHostPort, RunError, RunResult, RunStarted } from "../src/code/contracts";
import { CodeHost, type CodeHostOptions } from "../src/code/host/code-host";
import { RuntimeCodeBrowsers } from "../src/code/host/runtime-port";
import type { BrowserRuntime } from "../src/runtime";
import { newRuntime } from "./fixture";

const PAGES: Record<string, string> = {
  "/form": `<!doctype html><meta charset="utf-8"><title>Form page</title><h1>Form page</h1>
<input id="name" type="text"><button id="go" onclick="document.getElementById('out').textContent='hello:'+document.getElementById('name').value">Go</button><div id="out"></div>`,
  "/other": `<!doctype html><meta charset="utf-8"><title>Other page</title><h1>Other page</h1>`,
  "/dialog": `<!doctype html><meta charset="utf-8"><title>Dialog</title><button id="ask" onclick="document.title = 'asked:' + confirm('sure?')">Ask</button>`,
};

export interface Pages {
  url(path: string): string;
  close(): Promise<void>;
}

/** The local pages, plus `/slow` (the response is held for `holdMs` before it starts). */
export function startPages(holdMs = 4_000): Promise<Pages> {
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (path === "/slow") {
      const timer = setTimeout(() => response.end("<!doctype html><title>Slow</title>slow"), holdMs);
      response.on("close", () => clearTimeout(timer));
      return;
    }
    const body = PAGES[path];
    response.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
    response.end(body ?? "not found");
  });
  const ready = Promise.withResolvers<Pages>();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    ready.resolve({
      url: path => `http://127.0.0.1:${port}${path}`,
      close: () => {
        const closed = Promise.withResolvers<void>();
        server.closeAllConnections();
        server.close(() => closed.resolve());
        return closed.promise;
      },
    });
  });
  return ready.promise;
}

export interface Rig {
  runtime: BrowserRuntime;
  host: CodeHost;
  rootDir: string;
}

/** A runtime on `rootDir` and a code host over it. `host` options override the timing and the spawn. */
export function newRig(rootDir: string, o: { idleMs?: number; host?: Partial<CodeHostOptions>; runtime?: Parameters<typeof newRuntime>[1] } = {}): Rig {
  const runtime = newRuntime(rootDir, o.runtime);
  const host = new CodeHost({
    browsers: new RuntimeCodeBrowsers(runtime.codeSeam(), { idleMs: o.idleMs ?? 1_800_000 }),
    artifactsRoot: join(rootDir, "artifacts"),
    ...o.host,
  });
  return { runtime, host, rootDir };
}

const NEVER = new AbortController().signal;

/** Runs a cell and waits for it to end: fails the test if it is still running at `waitMs`. */
export async function cell(host: CodeHostPort, session: string, code: string, o: { timeoutMs?: number; waitMs?: number; signal?: AbortSignal } = {}): Promise<RunResult | { error: RunError }> {
  const started = await host.run(session, { code, timeoutMs: o.timeoutMs ?? 30_000, waitMs: o.waitMs ?? 25_000, signal: o.signal ?? NEVER });
  if (started.state !== "done") throw new Error(`the cell was still running (${started.runId}) when the call returned`);
  return started.result;
}

export function isFailure(result: RunResult | { error: RunError }): result is { error: RunError } {
  return "error" in result;
}

/** The value a cell returned; a cell that failed fails the test with its error. */
export async function valueOf(host: CodeHostPort, session: string, code: string, o?: Parameters<typeof cell>[3]): Promise<unknown> {
  const result = await cell(host, session, code, o);
  if (isFailure(result)) throw new Error(`the cell failed: ${result.error.name}: ${result.error.message}`);
  return result.returnValue;
}

/** The text a cell showed (displays joined). */
export function textOf(result: RunResult): string {
  return result.displays.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** The failure a cell ended in; a cell that succeeded fails the test. */
export async function failureOf(host: CodeHostPort, session: string, code: string, o?: Parameters<typeof cell>[3]): Promise<RunError> {
  const result = await cell(host, session, code, o);
  if (!isFailure(result)) throw new Error("expected the cell to fail, but it returned");
  return result.error;
}

export async function running(started: RunStarted): Promise<Extract<RunStarted, { state: "running" }>> {
  if (started.state !== "running") throw new Error("expected the cell to still be running");
  return started;
}
