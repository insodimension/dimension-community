// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/registry.ts:264-325 (the spawned branch of openBrowserHandle) and tools/browser/attach.ts:123-224 (findReusableCdp and its argv helpers) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: `Process.fromPath` (OMP natives) is a scan of the running processes' command lines (PowerShell on Windows, /proc on Linux, ps on macOS) behind an injectable scanner; `Bun.spawn` is `child_process.spawn`, detached and unreferenced; a process that exits before its port opens fails the wait at once.

/**
 * `app.path`: start (or reuse) an application that speaks the Chrome DevTools protocol, and give back its HTTP debugging endpoint.
 * It stays open when the cell is done unless `close({ kill: true })` ends it. An instance that is already running with a debugging port is
 * reused instead of launched twice.
 */
import { execFile, spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { ownedPids } from "../../owned-pids.js";
import { ToolAbortError, ToolError, throwIfAborted } from "../errors.js";
import { findFreeCdpPort, gracefulKillTreeOnce, KIND_TIMINGS, probeCdpStatus, waitForCdp } from "./cdp.js";

const execFileAsync = promisify(execFile);

/** A running process of the application: its pid and its command line, split. */
export interface RunningProcess {
  pid: number;
  args: string[];
}

/** What a scan of the machine's processes found for one executable. `unreadable` is true when a matching process's command line could not be read. */
export interface ProcessScan {
  processes: RunningProcess[];
  unreadable: boolean;
}

/** Looks at the machine's running processes; tests pass a fake, the pack uses {@link systemScanner}. */
export interface ProcessScanner {
  running(exe: string): Promise<ProcessScan>;
}

/** What `child_process.spawn` is asked; tests may substitute it. */
export type Spawner = (exe: string, args: string[]) => { pid: number | undefined; exited: Promise<number | null> };

/** Pull a `--remote-debugging-port=<n>` value out of an argv array (Chromium accepts both `--flag=value` and `--flag value`). null if absent or malformed. */
export function findCdpPortInArgs(args: string[]): number | null {
  for (const arg of args) {
    const match = /^--remote-debugging-port=(\d+)$/.exec(arg);
    if (match) {
      const port = Number.parseInt(match[1]!, 10);
      if (Number.isFinite(port) && port > 0) return port;
    }
  }
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--remote-debugging-port") {
      const port = Number.parseInt(args[i + 1]!, 10);
      if (Number.isFinite(port) && port > 0) return port;
    }
  }
  return null;
}

/** The last `--user-data-dir` an argv names (the last one wins in Chromium); null when none or malformed. */
export function findUserDataDirInArgs(args: string[] | undefined): string | null {
  if (!args) return null;
  let result: string | null = null;
  const inlinePrefix = "--user-data-dir=";
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.startsWith(inlinePrefix)) {
      result = arg.length > inlinePrefix.length ? arg.slice(inlinePrefix.length) : null;
      continue;
    }
    if (arg !== "--user-data-dir") continue;
    const value = args[index + 1];
    result = value !== undefined && value.length > 0 && !value.startsWith("--") ? value : null;
    if (result !== null) index++;
  }
  return result;
}

function normalizeUserDataDir(userDataDir: string): string {
  const normalized = resolve(userDataDir);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** One-shot probe: true when `/json/version` answers 200 within the timeout. */
async function probeCdpAt(port: number, signal?: AbortSignal): Promise<boolean> {
  const status = await probeCdpStatus(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 1_500, ...(signal ? { signal } : {}) });
  return status !== null && status >= 200 && status < 300;
}

/**
 * A reusable CDP endpoint for `exe`, or null when no instance is running. An occupied instance is refused unless the caller can launch an
 * isolated profile (its own `--user-data-dir`, which no running instance uses): a second launch on the same profile would only hand over to the first.
 */
export async function findReusableCdp(
  exe: string,
  options: { signal?: AbortSignal; appArgs?: string[]; scanner?: ProcessScanner } = {},
): Promise<{ cdpUrl: string; pid: number } | null> {
  const { processes, unreadable } = await (options.scanner ?? systemScanner).running(exe);
  for (const candidate of processes) {
    const port = findCdpPortInArgs(candidate.args);
    if (port === null) continue;
    if (await probeCdpAt(port, options.signal)) return { cdpUrl: `http://127.0.0.1:${port}`, pid: candidate.pid };
  }
  const requestedUserDataDir = findUserDataDirInArgs(options.appArgs);
  const normalizedRequested = requestedUserDataDir !== null && isAbsolute(requestedUserDataDir) ? normalizeUserDataDir(requestedUserDataDir) : null;
  const canLaunchIsolatedProfile =
    normalizedRequested !== null &&
    !unreadable &&
    processes.every((candidate) => {
      const existing = findUserDataDirInArgs(candidate.args);
      return existing === null || (isAbsolute(existing) && normalizeUserDataDir(existing) !== normalizedRequested);
    });
  if (!canLaunchIsolatedProfile && processes.length > 0) {
    const name = basename(exe);
    throw new ToolError(
      `Cannot launch ${name} because it is already running without a reusable CDP endpoint. Close ${name}, relaunch it with --remote-debugging-port, or pass app.cdp_url for an existing endpoint.`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// The process scan
// ---------------------------------------------------------------------------

/** Windows command line to argv (CommandLineToArgvW's quoting rules, enough for flags): spaces split, double quotes group, a backslash before a quote escapes it. */
export function splitWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let started = false;
  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i]!;
    if (ch === "\\") {
      let slashes = 0;
      while (commandLine[i] === "\\") {
        slashes++;
        i++;
      }
      if (commandLine[i] === '"') {
        current += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2 === 1) current += '"';
        else inQuotes = !inQuotes;
      } else {
        current += "\\".repeat(slashes);
        i--;
      }
      started = true;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
      started = true;
    } else if (/\s/.test(ch) && !inQuotes) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

const sameExe = (a: string, b: string): boolean => {
  const normal = (path: string): string => (process.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path);
  return normal(a) === normal(b);
};

async function scanWindows(exe: string): Promise<ProcessScan> {
  // The image name goes in through the environment: no quoting of an arbitrary path into a script.
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq $env:DIMENSION_SCAN_NAME } | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env: { ...process.env, DIMENSION_SCAN_NAME: basename(exe.replaceAll("\\", "/")) },
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const text = stdout.trim();
  if (text.length === 0) return { processes: [], unreadable: false };
  const parsed: unknown = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const processes: RunningProcess[] = [];
  let unreadable = false;
  for (const row of rows as Array<{ ProcessId?: number; ExecutablePath?: string | null; CommandLine?: string | null }>) {
    if (typeof row.ProcessId !== "number") continue;
    // A process whose path is hidden from us may still be the application: counted as unreadable, not skipped.
    if (typeof row.ExecutablePath === "string" && !sameExe(row.ExecutablePath, exe)) continue;
    if (typeof row.CommandLine !== "string") {
      unreadable = true;
      continue;
    }
    processes.push({ pid: row.ProcessId, args: splitWindowsCommandLine(row.CommandLine).slice(1) });
  }
  return { processes, unreadable };
}

function scanProc(exe: string): ProcessScan {
  const processes: RunningProcess[] = [];
  let unreadable = false;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let target: string;
    try {
      target = readlinkSync(`/proc/${entry}/exe`).replace(/ \(deleted\)$/, "");
    } catch {
      continue; // not ours to look at, or gone
    }
    if (target !== exe) continue;
    try {
      const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter((arg, index, all) => arg.length > 0 || index < all.length - 1);
      processes.push({ pid: Number(entry), args: args.slice(1) });
    } catch {
      unreadable = true;
    }
  }
  return { processes, unreadable };
}

async function scanPs(exe: string): Promise<ProcessScan> {
  const { stdout } = await execFileAsync("ps", ["-axww", "-o", "pid=,command="], { timeout: 15_000, maxBuffer: 16 * 1024 * 1024 });
  const processes: RunningProcess[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = match[2]!;
    // The command column starts with the executable path, which may hold spaces ("Google Chrome"): match the path, then split the rest.
    if (command !== exe && !command.startsWith(`${exe} `)) continue;
    processes.push({ pid: Number(match[1]), args: command.slice(exe.length).split(/\s+/).filter((arg) => arg.length > 0) });
  }
  return { processes, unreadable: false };
}

/** The pack's scanner: what is running right now, from the operating system. A scan that cannot run reports nothing running (the launch's own wait then names the failure). */
export const systemScanner: ProcessScanner = {
  async running(exe) {
    try {
      if (process.platform === "win32") return await scanWindows(exe);
      if (process.platform === "linux") return scanProc(exe);
      return await scanPs(exe);
    } catch (error) {
      console.error(`[browser] could not list running ${basename(exe)} processes: ${error instanceof Error ? error.message : String(error)}`);
      return { processes: [], unreadable: false };
    }
  },
};

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

const systemSpawner: Spawner = (exe, args) => {
  const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  const exited = new Promise<number | null>((resolveExit) => {
    child.once("exit", (code) => resolveExit(code));
    child.once("error", () => resolveExit(null));
  });
  return { pid: child.pid, exited };
};

/** A spawned (or reused) application's debugging endpoint, and what ends it. */
export interface SpawnedApp {
  cdpUrl: string;
  pid: number;
  /** True when a running instance's debugging port was reused instead of starting one. */
  reused: boolean;
  /**
   * Ends the application's whole process tree (asked politely, then forced). Present only for an application THIS call started: one that was already running is somebody else's, and a pid the pack did not start
   * is not the pack's to signal. It does nothing once the process has been seen to exit.
   */
  terminate?: () => Promise<void>;
}

export interface SpawnOptions {
  signal?: AbortSignal;
  scanner?: ProcessScanner;
  spawner?: Spawner;
  /** How long a fresh application gets to open its port. */
  waitMs?: number;
}

/** Start `kind.path` with `--remote-debugging-port=<free>` (or reuse a running instance's port) and wait for its endpoint. */
export async function establishSpawned(kind: { path: string; args?: string[] }, opts: SpawnOptions = {}): Promise<SpawnedApp> {
  const exe = kind.path;
  if (!isAbsolute(exe)) {
    throw new ToolError(`app.path must be absolute (got ${JSON.stringify(exe)}). Pass the binary inside Foo.app/Contents/MacOS/, not the .app bundle.`);
  }
  const reused = await findReusableCdp(exe, { ...(opts.signal ? { signal: opts.signal } : {}), ...(kind.args ? { appArgs: kind.args } : {}), ...(opts.scanner ? { scanner: opts.scanner } : {}) });
  // An instance that was already running keeps running: `close({ kill: true })` ends only what this open started.
  if (reused) return { cdpUrl: reused.cdpUrl, pid: reused.pid, reused: true };
  const port = await findFreeCdpPort();
  const child = (opts.spawner ?? systemSpawner)(exe, [...(kind.args ?? []), `--remote-debugging-port=${port}`]);
  if (child.pid === undefined) throw new ToolError(`Failed to start ${basename(exe)}: the process did not start.`);
  const pid = child.pid;
  const cdpUrl = `http://127.0.0.1:${port}`;
  // A process that exits before its port opens (Chrome handing over to an instance that is already running does exactly this) fails the wait now, not at 30 s.
  const early = new AbortController();
  let exitedWith: number | null | undefined;
  // The application has its own end (the person's, or a cell's `close({ kill: true })`): the sweep of what cells left behind at the server's stop never takes it (owned-pids.ts).
  const disown = ownedPids.add(pid);
  void child.exited.then((code) => {
    exitedWith = code;
    disown();
    early.abort();
  });
  // Once the child has been seen to exit its number may name another program: nothing is signalled then.
  const terminate = (): Promise<void> => gracefulKillTreeOnce(pid, { exe, exited: () => exitedWith !== undefined });
  const waitSignal = opts.signal ? AbortSignal.any([opts.signal, early.signal]) : early.signal;
  try {
    await waitForCdp(cdpUrl, opts.waitMs ?? KIND_TIMINGS.spawnedMs, waitSignal);
    // Inside the guard: an abort that lands as the port opens still ends the application it would otherwise leave running with nobody holding it.
    throwIfAborted(opts.signal);
  } catch (error) {
    await terminate().catch(() => undefined);
    if (opts.signal?.aborted) throw error instanceof ToolAbortError ? error : new ToolAbortError();
    if (exitedWith !== undefined) {
      throw new ToolError(`Failed to attach to ${basename(exe)} on ${cdpUrl}: the process exited${exitedWith === null ? "" : ` (code ${exitedWith})`} before opening its CDP endpoint`);
    }
    throw new ToolError(`Failed to attach to ${basename(exe)} on ${cdpUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { cdpUrl, pid, reused: false, terminate };
}

