// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/attach.ts:11-121 (findFreeCdpPort, probeCdpStatus, waitForCdp), :300-308 (gracefulKillTreeOnce), tools/browser/launch.ts:31 and tools/browser/registry.ts:38-44 (the timing constants) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: `Bun.connect` is `node:net`, `Bun.sleep` is an abortable timer, and `Process.terminate` (OMP natives) is `taskkill /T` on Windows and a process-group signal elsewhere.

/**
 * Talking to a Chrome DevTools endpoint that someone else runs: finding a free port, asking `/json/version` over a raw loopback socket,
 * waiting for it to answer, and ending a process tree the pack started. The probe uses a raw TCP socket on purpose: `fetch` and `node:http`
 * can route loopback requests through `HTTP_PROXY`, so a local proxy that answers 502 for internal addresses would make a healthy browser
 * look dead (OMP issue #8567).
 */
import { execFile } from "node:child_process";
import { connect, createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { taskkillArgs } from "../../engines/puppeteer.js";
import { ToolError, throwIfAborted } from "../errors.js";

/** How long each kind waits for its endpoint (OMP registry.ts:208, :294, :44). Injectable so a test does not wait them out. */
export interface KindTimings {
  /** `connected`: the discovery endpoint must answer within this. */
  connectedMs: number;
  /** `spawned`: a freshly started application must open its debugging port within this. */
  spawnedMs: number;
  /** `relay`: the extension must dial in (503 to 200) within this: one full 30 s keepalive alarm period plus the dial. */
  relayExtensionMs: number;
}
export const KIND_TIMINGS: KindTimings = { connectedMs: 5_000, spawnedMs: 30_000, relayExtensionMs: 35_000 };

const POLL_MS = 150;
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Allocate an unused TCP port on 127.0.0.1 by binding to port 0 and reading back the kernel-assigned port. There is a small race between
 * close and the subsequent bind in the launched application, but Chromium's listener retries.
 */
export async function findFreeCdpPort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.unref();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") {
      server.close((closeError) => (closeError ? reject(closeError) : resolve(address.port)));
    } else {
      server.close();
      reject(new Error("Failed to allocate ephemeral CDP port"));
    }
  });
  return promise;
}

/**
 * A loopback HTTP/1.1 GET that never routes through a proxy, resolving to the response status code (or null when the endpoint is
 * unreachable, aborted, malformed, or slower than `timeoutMs`).
 */
export async function probeCdpStatus(url: string, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<number | null> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (opts.signal?.aborted) return null;
  const port = target.port ? Number(target.port) : 80;
  const requestPath = `${target.pathname}${target.search}` || "/";
  const { promise, resolve } = Promise.withResolvers<number | null>();
  const socket = connect({ host: target.hostname.replace(/^\[|\]$/g, ""), port });
  let settled = false;
  let buffered = "";
  const finish = (status: number | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    socket.destroy();
    resolve(status);
  };
  const onAbort = (): void => finish(null);
  const timer = setTimeout(() => finish(null), opts.timeoutMs);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  socket.setNoDelay(true);
  socket.on("connect", () => socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${target.hostname}:${port}\r\nConnection: close\r\n\r\n`));
  socket.on("data", (chunk) => {
    buffered += chunk.toString("latin1");
    const match = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(buffered);
    if (match) finish(Number(match[1]));
  });
  socket.on("error", () => finish(null));
  socket.on("close", () => finish(null));
  return promise;
}

/** An abortable pause: resolves after `ms`, or at once when `signal` aborts (the caller checks the signal). */
async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, signal === undefined ? undefined : { signal });
  } catch {
    // Aborted: the loop's next `throwIfAborted` reports it.
  }
}

/** Poll `${cdpUrl}/json/version` until it answers 200, with abort and timeout support. */
export async function waitForCdp(cdpUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const probeUrl = `${cdpUrl.replace(/\/+$/, "")}/json/version`;
  let lastStatus: number | null = null;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const status = await probeCdpStatus(probeUrl, { timeoutMs: Math.min(PROBE_TIMEOUT_MS, Math.max(1, deadline - Date.now())), ...(signal ? { signal } : {}) });
    if (status !== null && status >= 200 && status < 300) return;
    lastStatus = status;
    await pause(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), signal);
  }
  throwIfAborted(signal);
  throw new ToolError(`Timed out waiting for CDP endpoint ${cdpUrl}${lastStatus !== null ? `: HTTP ${lastStatus}` : ""}`);
}

const execFileAsync = promisify(execFile);

/** True while `pid` names a live process (signal 0 only checks; `EPERM` means it exists but is not ours). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * End `pid` and everything it started: ask politely, wait up to `gracePeriodMs`, then force. `exited` says whether the process is already known to be gone (the caller holds the child it started and has seen
 * its exit): a pid names a process only while it runs, so an exited one gets no signal at all, whatever the number names by now. Windows: `taskkill /T` takes the whole tree (killing only the main process leaves
 * Chrome's helpers), through the pack's one pid-reuse-safe command ({@link taskkillArgs}: the image filter makes a pid reused by a program of another name match nothing). Elsewhere: the process group the
 * child leads (it was started `detached`), else the process itself.
 */
export async function gracefulKillTreeOnce(pid: number, options: { exe: string; exited?: () => boolean; gracePeriodMs?: number }): Promise<void> {
  const gracePeriodMs = options.gracePeriodMs ?? 2_000;
  const exited = options.exited ?? ((): boolean => false);
  if (exited() || !isAlive(pid)) return;
  if (process.platform === "win32") {
    // Decided right before each command: the process may have exited since the caller looked.
    const command = (force: boolean): string[] | undefined => {
      const forced = taskkillArgs({ pid, spawnfile: options.exe, exitCode: exited() ? 0 : null, signalCode: null });
      return force ? forced : forced?.filter((arg) => arg !== "/F");
    };
    const polite = command(false);
    if (polite !== undefined) await execFileAsync("taskkill", polite, { windowsHide: true }).catch(() => undefined);
    const deadline = Date.now() + gracePeriodMs;
    while (isAlive(pid) && !exited() && Date.now() < deadline) await sleep(50);
    const forced = isAlive(pid) ? command(true) : undefined;
    if (forced !== undefined) await execFileAsync("taskkill", forced, { windowsHide: true }).catch(() => undefined);
    return;
  }
  const signal = (name: NodeJS.Signals): void => {
    if (exited()) return;
    try {
      process.kill(-pid, name);
    } catch {
      try {
        process.kill(pid, name);
      } catch {
        // already gone
      }
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + gracePeriodMs;
  while (isAlive(pid) && !exited() && Date.now() < deadline) await sleep(50);
  if (isAlive(pid)) signal("SIGKILL");
}
