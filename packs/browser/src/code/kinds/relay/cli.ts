// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/cli/browser-relay-cli.ts @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../../third-party/omp/LICENSE.
// Changed for the Browser pack: `omp browser-relay [install]` is `node app/server.mjs --relay [--relay-install]`; the extension is installed under the pack's data root from the shipped `relay-extension/` folder (not embedded as text); the texts name Dimension.

/**
 * The relay's two standalone commands: install the Chrome extension, and serve the relay by hand (for `--token` or `--no-group`; the pack
 * otherwise starts one itself the first time a cell asks for `app.relay`). Console output here is the command's user-facing output.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRootDir } from "../../../store.js";
import { DEFAULT_RELAY_URL } from "../../../engines/attach.js";
import { probeRelayServer } from "./ensure.js";
import { type RelayServer, startRelayServer } from "./server.js";

const DEFAULT_RELAY_PORT = Number(new URL(DEFAULT_RELAY_URL).port);

/** The shipped extension folder: beside the bundle (`app/server.mjs`) or, from source, at the pack root. */
export function relayExtensionSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, "..", "relay-extension"), resolve(here, "..", "..", "..", "..", "relay-extension")]) {
    if (existsSync(join(candidate, "manifest.json"))) return candidate;
  }
  throw new Error("the Browser pack's relay-extension folder is missing from this install");
}

/** Where the extension is installed: stable across pack updates, so Chrome's "Load unpacked" path keeps working. */
export function defaultRelayExtensionDir(root = process.env.DIMENSION_BROWSER_ROOT || defaultRootDir()): string {
  return join(root, "relay", "extension");
}

/** Copy the extension to `dir` (default: the pack's data root) and return the folder and the files written. */
export async function installRelayExtension(dir = defaultRelayExtensionDir(), source = relayExtensionSource()): Promise<{ dir: string; files: string[] }> {
  await mkdir(dir, { recursive: true });
  await cp(source, dir, { recursive: true, force: true });
  return { dir, files: (await readdir(dir)).sort() };
}

interface RelayArgs {
  action: "serve" | "install";
  port: number;
  token?: string;
  dir?: string;
  group: boolean;
  verbose: boolean;
}

/** `--relay` / `--relay-install` and their options; undefined when argv names neither (a normal MCP server start). */
export function parseRelayArgs(argv: string[]): RelayArgs | undefined {
  const install = argv.includes("--relay-install");
  if (!install && !argv.includes("--relay")) return undefined;
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const port = value("--port") === undefined ? DEFAULT_RELAY_PORT : Number(value("--port"));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`--port must be a port number (got ${JSON.stringify(value("--port"))})`);
  const token = value("--token");
  const dir = value("--dir");
  return { action: install ? "install" : "serve", port, ...(token ? { token } : {}), ...(dir ? { dir } : {}), group: !argv.includes("--no-group"), verbose: argv.includes("--verbose") };
}

/** Run the command `argv` names. Resolves for `install`; `serve` runs until SIGINT or SIGTERM. */
export async function runRelayCommand(args: RelayArgs): Promise<void> {
  if (args.action === "install") {
    const { dir } = await installRelayExtension(args.dir ? resolve(args.dir) : undefined);
    console.log(`Installed the Dimension Browser Relay extension to ${dir}`);
    console.log("");
    console.log("Finish setup in Chrome:");
    console.log("  1. Open chrome://extensions and enable Developer mode.");
    console.log(`  2. Click "Load unpacked" and select: ${dir}`);
    console.log("  3. Turn the mode on:  DIMENSION_BROWSER_RELAY=1 (or pass app: { relay: true } to browser.open)");
    console.log("");
    console.log("The pack starts the relay itself the first time a cell asks for it; run `node app/server.mjs --relay` only for --token or --no-group.");
    console.log("The extension badge shows 'on' once it reaches a relay.");
    return;
  }
  const log = args.verbose ? (message: string, data?: Record<string, unknown>) => console.error(`[relay] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`) : undefined;
  let relay: RelayServer;
  try {
    relay = await startRelayServer({ port: args.port, ...(args.token ? { token: args.token } : {}), group: args.group, ...(log ? { log } : {}) });
  } catch (error) {
    // The port is machine-global while relays can be started by any pack instance (or by hand): losing the bind to a live relay is success.
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      if (await probeRelayServer(`http://127.0.0.1:${args.port}`)) {
        console.log(`The browser relay is already running on http://127.0.0.1:${args.port}; nothing to do.`);
        return;
      }
      console.error(`Port ${args.port} is in use by something that is not a browser relay.`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
  console.log(`Dimension browser relay listening on http://127.0.0.1:${args.port}`);
  console.log(`  extension endpoint  ws://127.0.0.1:${args.port}/ext${args.token ? "?token=***" : ""}`);
  if (args.port !== DEFAULT_RELAY_PORT) console.log(`  enable with         DIMENSION_BROWSER_RELAY=1 DIMENSION_BROWSER_RELAY_URL=http://127.0.0.1:${args.port}`);
  console.log("Waiting for the Dimension Browser Relay extension to connect (node app/server.mjs --relay-install)...");

  let announced = false;
  const readiness = setInterval(() => {
    if (relay.bridge.ready && !announced) {
      announced = true;
      console.log("Extension connected. Cells can now drive your tabs.");
    } else if (!relay.bridge.ready && announced) {
      announced = false;
      console.log("Extension disconnected; waiting for it to reconnect...");
    }
  }, 500);
  const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
  const shutdown = (): void => {
    clearInterval(readiness);
    void relay.stop().finally(() => stop());
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await stopped;
}

/** The pack's entry: when argv names a relay command, run it and say so (true); otherwise false and nothing happened. */
export async function runRelayCliIfAsked(argv: string[]): Promise<boolean> {
  const args = parseRelayArgs(argv);
  if (args === undefined) return false;
  await runRelayCommand(args);
  return true;
}
