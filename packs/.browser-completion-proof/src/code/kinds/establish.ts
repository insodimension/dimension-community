// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/registry.ts:162-170 (normalizeConnectedCdpUrl) and :206-262 (the connected and relay branches of openBrowserHandle) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: the registry, refcounts and shared-daemon handles are the runtime's (this only finds and waits for the endpoint); the relay is started by `ensureRelay` (no broker); the errors name the Dimension relay and its commands.

/**
 * Make a non-headless browser ready to attach to: given a resolved kind, find or start whatever it names and wait until its DevTools endpoint
 * answers. Nothing here opens a tab or a page; the runtime's `attach` engine connects to what this returns, and a cell's `open` then adopts a page.
 * Headless needs none of this (the pack launches its own Chromium).
 */
import { type AttachTarget } from "../../engines/attach.js";
import type { BrowserKind } from "../contracts.js";
import { ToolAbortError, ToolError } from "../errors.js";
import { KIND_TIMINGS, type KindTimings, waitForCdp } from "./cdp.js";
import { CmuxSocketClient } from "./cmux/socket-client.js";
import { describeBrowser } from "./resolve.js";
import { ensureRelay, type EnsureRelayOptions } from "./relay/ensure.js";
import { establishSpawned, type ProcessScanner, type Spawner } from "./spawned.js";

/** A cmux surface to drive: the socket client is connected and the cell's tab API runs over it (there is no CDP endpoint). */
export interface CmuxTarget {
  client: CmuxSocketClient;
  surface?: string;
  label: string;
}

/** What `establishKind` made ready: a browser to attach to, or a cmux socket. */
export type Established = { attach: AttachTarget } | { cmux: CmuxTarget };

/** Every kind except headless. */
export type EstablishableKind = Exclude<BrowserKind, { kind: "headless" }>;

export interface EstablishOptions {
  signal?: AbortSignal;
  timings?: KindTimings;
  /** Spawned only: replace what scans the running processes, or what starts one. */
  scanner?: ProcessScanner;
  spawner?: Spawner;
  /** Relay only: replace how a relay is started. */
  startRelay?: EnsureRelayOptions["start"];
  /** Cmux only: replace the socket client (tests pass a fake socket). */
  connectCmux?: (kind: Extract<BrowserKind, { kind: "cmux" }>) => Promise<CmuxSocketClient>;
}

/** `app.cdp_url` is the HTTP discovery endpoint (for example http://127.0.0.1:9222); a `ws://` browser websocket URL is refused. */
export function normalizeConnectedCdpUrl(rawCdpUrl: string): string {
  const cdpUrl = rawCdpUrl.replace(/\/+$/, "");
  if (/^wss?:\/\//i.test(cdpUrl)) {
    throw new ToolError("browser app.cdp_url must be the HTTP CDP discovery endpoint (for example http://127.0.0.1:9222), not a ws:// browser websocket URL.");
  }
  return cdpUrl;
}

/** Abort and name the failure for a wait that ended because the caller's signal did. */
function rethrowAbort(error: unknown, signal: AbortSignal | undefined): void {
  if (error instanceof ToolAbortError) throw error;
  if (error instanceof Error && error.name === "AbortError") throw error;
  if (signal?.aborted) throw new ToolAbortError();
}

async function establishRelay(kind: Extract<BrowserKind, { kind: "relay" }>, opts: EstablishOptions): Promise<AttachTarget> {
  const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
  // A loopback relay is served by this process (or adopted when someone else already serves it); a remote relay must already be serving.
  const serving = await ensureRelay({ cdpUrl, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.startRelay ? { start: opts.startRelay } : {}) });
  // The relay answers /json/version with 503 until its extension dials in. A freshly revived extension service worker can take up to ~30 s
  // (its keepalive alarm) to reconnect, so the handshake gets that long.
  try {
    await waitForCdp(cdpUrl, (opts.timings ?? KIND_TIMINGS).relayExtensionMs, opts.signal);
  } catch (error) {
    rethrowAbort(error, opts.signal);
    throw new ToolError(
      serving
        ? `The Dimension browser relay is serving at ${cdpUrl} but its extension never connected. Install it with \`node app/server.mjs --relay-install\` and check the toolbar badge shows "on".`
        : `The Dimension browser relay is not reachable at ${cdpUrl}. Start it with \`node app/server.mjs --relay\` (or check the endpoint), and make sure the Dimension Browser Relay extension is loaded in Chrome.`,
    );
  }
  return { kind: "relay", cdpUrl, label: describeBrowser(kind, { cdpUrl }) };
}

async function establishConnected(kind: Extract<BrowserKind, { kind: "connected" }>, opts: EstablishOptions): Promise<AttachTarget> {
  const cdpUrl = normalizeConnectedCdpUrl(kind.cdpUrl);
  await waitForCdp(cdpUrl, (opts.timings ?? KIND_TIMINGS).connectedMs, opts.signal);
  return { kind: "connected", cdpUrl, label: describeBrowser(kind, { cdpUrl }) };
}

async function connectCmuxSocket(kind: Extract<BrowserKind, { kind: "cmux" }>): Promise<CmuxSocketClient> {
  const client = new CmuxSocketClient({ socketPath: kind.socketPath, ...(kind.password ? { password: kind.password } : {}), ...(kind.relayId ? { relayId: kind.relayId } : {}), ...(kind.relayToken ? { relayToken: kind.relayToken } : {}) });
  await client.connect();
  return client;
}

/** Make `kind` ready. Rejects with OMP's texts: a ToolError the cell reads as the model-facing message. */
export async function establishKind(kind: EstablishableKind, opts: EstablishOptions = {}): Promise<Established> {
  switch (kind.kind) {
    case "connected":
      return { attach: await establishConnected(kind, opts) };
    case "relay":
      return { attach: await establishRelay(kind, opts) };
    case "spawned": {
      const app = await establishSpawned(kind, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.scanner ? { scanner: opts.scanner } : {}),
        ...(opts.spawner ? { spawner: opts.spawner } : {}),
        ...(opts.timings ? { waitMs: opts.timings.spawnedMs } : {}),
      });
      return { attach: { kind: "spawned", cdpUrl: app.cdpUrl, label: describeBrowser(kind, { pid: app.pid }), pid: app.pid, ...(app.terminate ? { terminate: app.terminate } : {}) } };
    }
    case "cmux": {
      const client = opts.connectCmux ? await opts.connectCmux(kind) : await connectCmuxSocket(kind);
      return { cmux: { client, ...(kind.surface ? { surface: kind.surface } : {}), label: describeBrowser(kind) } };
    }
  }
}
