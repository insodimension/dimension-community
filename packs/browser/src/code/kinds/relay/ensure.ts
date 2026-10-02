// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/relay/daemon.ts:33-36 (probeRelayServer), :39-47 (isLoopbackRelayUrl), :54-112 (ensureRelayDaemon) and cli/browser-relay-cli.ts:84-90 (a taken port) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../../third-party/omp/LICENSE.
// Changed for the Browser pack: no broker daemon (matrix F5e). The first relay open probes the port; a relay already serving there (OMP's own, or another pack instance) is adopted, and otherwise the pack's server starts one inside its own process.

/**
 * Make sure a relay answers at `cdpUrl`. The MV3 extension can only dial OUT (a service worker cannot listen on a socket), so something native
 * must own the relay port. Here that is: whoever already serves it (adopted without a second bind), else this process.
 */
import { ToolAbortError, ToolError, throwIfAborted } from "../../errors.js";
import { probeCdpStatus } from "../cdp.js";
import { type RelayServer, startRelayServer } from "./server.js";

const PROBE_TIMEOUT_MS = 1_500;

/** True when the relay HTTP server answers /json/version at all (200 = extension connected, 503 = waiting for it). */
export async function probeRelayServer(cdpUrl: string): Promise<boolean> {
  const status = await probeCdpStatus(`${cdpUrl}/json/version`, { timeoutMs: PROBE_TIMEOUT_MS });
  return status === 503 || (status !== null && status >= 200 && status < 300);
}

/** Auto-start is only safe for endpoints this machine can own. */
export function isLoopbackRelayUrl(cdpUrl: string): boolean {
  try {
    const { hostname } = new URL(cdpUrl);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

/** The relays this process started, by port: the second open of a session finds the first one's. */
const owned = new Map<number, Promise<RelayServer>>();

/** What starting a relay needs to be replaceable: tests pass a server on another port or a fake. */
export interface EnsureRelayOptions {
  cdpUrl: string;
  signal?: AbortSignal;
  /** Starts the relay server; the pack's own by default. */
  start?: typeof startRelayServer;
}

/**
 * Ensure a relay server answers at `cdpUrl`, starting one in this process when nothing is serving. Returns true once the HTTP endpoint responds:
 * the extension handshake (503 to 200) is the caller's wait. False for an endpoint this machine cannot own (remote, or not a loopback address),
 * which must already be serving. Throws when the port is held by something that is not a relay.
 */
export async function ensureRelay(opts: EnsureRelayOptions): Promise<boolean> {
  if (!isLoopbackRelayUrl(opts.cdpUrl)) return false;
  let port: number;
  try {
    port = Number(new URL(opts.cdpUrl).port || 80);
  } catch {
    return false;
  }
  throwIfAborted(opts.signal);
  // Adopt a relay that is already serving (OMP's own, another pack instance, or one this process started earlier).
  if (await probeRelayServer(opts.cdpUrl)) return true;
  throwIfAborted(opts.signal);
  let starting = owned.get(port);
  if (starting === undefined) {
    starting = (opts.start ?? startRelayServer)({ port, unref: true, log: (message, data) => console.error(`[relay] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`) });
    owned.set(port, starting);
    starting.catch(() => owned.delete(port));
  }
  try {
    await starting;
    return true;
  } catch (error) {
    if (opts.signal?.aborted) throw new ToolAbortError();
    // Lost the bind to a relay started since the probe: that is success. Anything else on the port is not ours to take.
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      if (await probeRelayServer(opts.cdpUrl)) return true;
      throw new ToolError(`Port ${port} is in use by something that is not a browser relay.`);
    }
    return false;
  }
}

/** Stop the relays this process started (server shutdown, and a test's cleanup). A relay someone else serves is never touched. */
export async function stopOwnedRelays(): Promise<void> {
  const servers = [...owned.values()];
  owned.clear();
  await Promise.allSettled(servers.map(async (server) => await (await server).stop()));
}
