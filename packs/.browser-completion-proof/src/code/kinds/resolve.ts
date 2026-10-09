// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser.ts:103-142 (resolveBrowserKind), :423-462 (describeBrowser, describeKind, sameBrowserKind), tools/browser/relay/kind.ts and tools/browser/cmux/rpc.ts:178-200 (resolveRelayKind, resolveCmuxKind) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: OMP's session settings are the pack's environment variables (matrix H2-H6); a saved `profile` wins before the order; an explicit `app.relay: true` while the relay is switched off (DIMENSION_BROWSER_RELAY=0) is refused instead of falling through to another kind (matrix H3); ToolError and `~` expansion are the pack's own.

/**
 * Which browser a cell's `browser.open` means, from its `app` options and the environment. The order is OMP's:
 * `app.cdp_url` (connected), `app.path` (spawned), `app.relay: true` (relay), the relay and cdpUrl settings, cmux, then a headless browser.
 * Only the choice is made here; nothing is launched or probed.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { DEFAULT_RELAY_URL } from "../../engines/attach.js";
import type { BrowserKind, BridgeRequest } from "../contracts.js";
import { ToolError } from "../errors.js";

/** The environment the kinds read. Names are the pack's (matrix H2-H6, H12); `CMUX_*` are cmux's own. */
export interface KindEnv {
  DIMENSION_BROWSER_CODE_ALLOW_ATTACH?: string;
  DIMENSION_BROWSER_CDP_URL?: string;
  DIMENSION_BROWSER_RELAY?: string;
  DIMENSION_BROWSER_RELAY_URL?: string;
  DIMENSION_BROWSER_CMUX?: string;
  DIMENSION_BROWSER_HEADLESS?: string;
  CMUX_SOCKET_PATH?: string;
  CMUX_SOCKET_PASSWORD?: string;
  CMUX_RELAY_ID?: string;
  CMUX_RELAY_TOKEN?: string;
  [name: string]: string | undefined;
}

/** What a cell's `open` asks: OMP's `app` object, and the pack's `profile`. */
export interface KindRequest {
  app?: BridgeRequest["app"];
  profile?: string;
}

const TRUTHY = new Set(["1", "Y", "y", "TRUE", "true", "YES", "yes", "ON", "on"]);

/** OMP's `parseFlag`: unset or empty is `def`; anything not in the truthy list is false (so "0" is off). */
export function parseFlag(value: string | undefined, def: boolean): boolean {
  if (!value) return def;
  return TRUTHY.has(value);
}

/** A path as the model wrote it: `~` is the home folder, a relative path is against the session's folder. */
function resolveToCwd(path: string, cwd: string): string {
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), `.${path.slice(1)}`);
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The relay kind, or null when relay mode is off. The setting opts in; the environment flag overrides it in both directions (`0` is the final kill switch). */
export function resolveRelayKind(options: { settingEnabled?: boolean; url?: string } | null, env: KindEnv): BrowserKind | null {
  if (!parseFlag(env.DIMENSION_BROWSER_RELAY, options?.settingEnabled ?? false)) return null;
  const url = options?.url?.trim() || DEFAULT_RELAY_URL;
  return { kind: "relay", cdpUrl: trimUrl(url) };
}

/** The cmux kind, or null: off by flag, or no cmux socket in the environment (so a machine without cmux never reaches it). */
export function resolveCmuxKind(options: { surface?: string; settingEnabled?: boolean } | null, env: KindEnv): BrowserKind | null {
  if (!parseFlag(env.DIMENSION_BROWSER_CMUX, options?.settingEnabled ?? true)) return null;
  const socketPath = env.CMUX_SOCKET_PATH;
  if (!socketPath) return null;
  const kind: BrowserKind = { kind: "cmux", socketPath };
  if (env.CMUX_SOCKET_PASSWORD) kind.password = env.CMUX_SOCKET_PASSWORD;
  if (env.CMUX_RELAY_ID) kind.relayId = env.CMUX_RELAY_ID;
  if (env.CMUX_RELAY_TOKEN) kind.relayToken = env.CMUX_RELAY_TOKEN;
  if (options?.surface) kind.surface = options.surface;
  return kind;
}

/**
 * The person's opt-in to a cell driving a browser or an application the pack did not launch. It is read from the host's environment each time a cell opens one, never from the cell: the code worker's own
 * environment is an allowlist that does not carry it, and a cell that sets it in its own cannot reach this process's. Until the host asks the human at the call (the exec approval tier, host contract H1, which
 * `browser_run` declares and the host does not honour yet) this is the one human gate the three model-chosen kinds have; H1 adds the approval on top of it and does not replace it.
 */
export const ATTACH_OPT_IN = "DIMENSION_BROWSER_CODE_ALLOW_ATTACH";

const ATTACH_REFUSAL =
  `code_needs_consent: driving a browser or an application you did not launch (app.cdp_url, app.path, app.relay) needs the person's yes, and they have not given it. Do not retry it or look for a way around it: ` +
  `ask the user to set ${ATTACH_OPT_IN}=1 in the browser pack's environment and restart the pack, or open a throwaway browser with browser.open() and no app.`;

/**
 * Which browser `request` means. Throws for an explicit `app.cdp_url`, `app.path` or `app.relay: true` the person has not allowed ({@link ATTACH_OPT_IN}), and for an explicit `app.relay: true` while the relay is switched off.
 * A kind the environment names (`DIMENSION_BROWSER_CDP_URL`, `DIMENSION_BROWSER_RELAY`) is the person's own choice and needs no second yes. `hidden` is whether the browser the pack
 * launches itself is hidden (the host's own setting); without it the environment's `DIMENSION_BROWSER_HEADLESS` says.
 */
export function resolveKind(request: KindRequest, env: KindEnv, cwd: string, hidden: boolean = env.DIMENSION_BROWSER_HEADLESS !== "false"): BrowserKind {
  const headless: BrowserKind = { kind: "headless", headless: hidden };
  // A saved profile is a Chromium the pack launches itself: no other kind can hold it, so it is chosen before the order.
  if (request.profile !== undefined) return headless;
  const app = request.app;
  if ((app?.cdp_url || app?.path || app?.relay) && !parseFlag(env[ATTACH_OPT_IN], false)) throw new ToolError(ATTACH_REFUSAL);
  if (app?.cdp_url) return { kind: "connected", cdpUrl: trimUrl(app.cdp_url) };
  if (app?.path) {
    const spawned: BrowserKind = { kind: "spawned", path: resolveToCwd(app.path, cwd) };
    if (app.args) spawned.args = app.args;
    return spawned;
  }
  const relayUrl = env.DIMENSION_BROWSER_RELAY_URL;
  // Explicit app.relay wins over every setting; DIMENSION_BROWSER_RELAY=0 stays the final kill switch (a relay that is down would otherwise brick the tool).
  if (app?.relay) {
    const relay = resolveRelayKind({ settingEnabled: true, ...(relayUrl === undefined ? {} : { url: relayUrl }) }, env);
    if (relay) return relay;
    throw new ToolError("app.relay is switched off in this environment (DIMENSION_BROWSER_RELAY=0); unset it to drive your own Chrome through the relay.");
  }
  // Relay before cdpUrl among settings: enabling the opt-out-by-default relay is a deliberate mode selection, while a configured cdpUrl is a
  // standing fallback endpoint. A configured endpoint is a default, not an override: explicit app options win.
  if (app?.relay !== false) {
    const relay = resolveRelayKind({ settingEnabled: false, ...(relayUrl === undefined ? {} : { url: relayUrl }) }, env);
    if (relay) return relay;
  }
  const configuredCdpUrl = env.DIMENSION_BROWSER_CDP_URL?.trim();
  if (configuredCdpUrl) return { kind: "connected", cdpUrl: trimUrl(configuredCdpUrl) };
  return resolveCmuxKind(null, env) ?? headless;
}

/** Two requests mean the same browser (OMP's `sameBrowserKind`): a tab name is bound to one browser until it is closed. */
export function sameBrowserKind(a: BrowserKind, b: BrowserKind): boolean {
  switch (a.kind) {
    case "headless":
      return b.kind === "headless" && a.headless === b.headless;
    case "spawned":
      return b.kind === "spawned" && a.path === b.path;
    case "connected":
      return b.kind === "connected" && a.cdpUrl === b.cdpUrl;
    case "relay":
      return b.kind === "relay" && a.cdpUrl === b.cdpUrl;
    case "cmux":
      return b.kind === "cmux" && a.socketPath === b.socketPath;
  }
}

/** The short name OMP uses in its "bound to a different browser" refusal. */
export function describeKind(kind: BrowserKind): string {
  switch (kind.kind) {
    case "headless":
      return `headless ${kind.headless ? "hidden" : "visible"}`;
    case "spawned":
      return `spawned:${kind.path}`;
    case "connected":
      return `connected:${kind.cdpUrl}`;
    case "relay":
      return `relay:${kind.cdpUrl}`;
    case "cmux":
      return `cmux:${kind.surface ?? "split"}`;
  }
}

/** What `Opened tab "main" on <this>` says (OMP's `describeBrowser`). `pid` is the spawned application's process, `shared` is absent in the pack (no shared daemon). */
export function describeBrowser(kind: BrowserKind, facts: { pid?: number; cdpUrl?: string } = {}): string {
  switch (kind.kind) {
    case "headless":
      return `headless browser (${kind.headless ? "hidden" : "visible"})`;
    case "spawned":
      return `spawned ${kind.path} (pid ${facts.pid ?? "?"})`;
    case "connected":
      return `connected ${facts.cdpUrl ?? kind.cdpUrl}`;
    case "relay":
      return `relay ${facts.cdpUrl ?? kind.cdpUrl}`;
    case "cmux":
      return `cmux browser (${kind.surface ?? "split"})`;
  }
}
