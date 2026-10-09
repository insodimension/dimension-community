// Written for the Browser pack (doc 77 §7.4.4). Windows has no process group to signal: ending the server leaves what it started running, and a cell inside an `execSync` of a dev server is exactly that case (the
// thread cannot be interrupted, so the process has to go, and the child it was waiting for would outlive it for as long as it likes). This ends what a cell left behind: the processes the server started that nothing
// else is responsible for.
//
// "Started by this server" is not "has our pid as its parent id". Windows never updates a parent id and reuses pids, so the surviving child of an EARLIER process that had this pid names it as its parent too; the
// sweep takes only processes that began after the server did. And a process whose end is someone's own business is never taken: a browser the runtime launched (a saved profile's is closed by its owner, a hard kill
// could cut a write to its logins) and an application the launch kinds left open for the person are in `ownedPids`. The kill is the pack's own pid-reuse-safe `taskkill` (it names the program as well as the pid, and
// takes the tree below).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { taskkillArgs } from "./engines/puppeteer.js";
import { type OwnedPids, ownedPids } from "./owned-pids.js";

const execFileAsync = promisify(execFile);

export interface ProcessRow {
  pid: number;
  parentPid: number;
  name: string;
  /** When it began, ms since the epoch. */
  createdMs: number;
}

/** A WMI date (`20261002100000.500000+120`: local time, then minutes east of UTC) as an instant. */
export function dmtfToMs(dmtf: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-]\d{3})$/.exec(dmtf.trim());
  if (match === null) return Number.NaN;
  const [, year, month, day, hour, minute, second, micros, offset] = match;
  const local = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return local + Number(micros) / 1000 - Number(offset) * 60_000;
}

/** The query's output: one `pid<TAB>parent<TAB>name<TAB>started` per line. A line that is not a process is skipped. */
export function parseProcessRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [pid, parentPid, name, started] = line.split("\t");
    if (pid === undefined || parentPid === undefined || name === undefined || started === undefined) continue;
    const row = { pid: Number(pid), parentPid: Number(parentPid), name, createdMs: dmtfToMs(started) };
    if (Number.isInteger(row.pid) && Number.isInteger(row.parentPid) && Number.isFinite(row.createdMs)) rows.push(row);
  }
  return rows;
}

export interface Selection {
  parentPid: number;
  owned: Pick<OwnedPids, "has">;
  /** Pids that are never taken (the helper that ran the query). */
  skip: readonly number[];
}

/** The rows the sweep may end: children of `parentPid` that began after it did and that nobody else owns. Without a row for `parentPid` itself, none. */
export function selectReapable(rows: readonly ProcessRow[], { parentPid, owned, skip }: Selection): ProcessRow[] {
  const self = rows.find(row => row.pid === parentPid);
  if (self === undefined) return [];
  return rows.filter(row => row.parentPid === parentPid && row.pid !== parentPid && row.createdMs > self.createdMs && !owned.has(row.pid) && !skip.includes(row.pid));
}

export interface ReapOptions {
  /** The server whose leftovers these are. Default: this process. */
  parentPid?: number;
  /** Default: the server's own registry. */
  owned?: Pick<OwnedPids, "has">;
  /** The shell that runs the query. Default `powershell`. */
  shell?: string;
  /** How long the query gets. */
  limitMs?: number;
}

/** One query for the server and its children, so their start times come from one clock. */
const QUERY = (pid: number): string =>
  `$t = [char]9; foreach ($p in ([wmisearcher]'select ProcessId,ParentProcessId,Name,CreationDate from Win32_Process where ParentProcessId=${pid} or ProcessId=${pid}').Get()) { "$($p.ProcessId)$t$($p.ParentProcessId)$t$($p.Name)$t$($p.CreationDate)" }`;

/** Ends what cells left behind below `parentPid` (Windows; elsewhere a process group does it and this does nothing). Returns the pids it ended. Never throws: it is the last act of a dying server. */
export async function reapChildren({ parentPid = process.pid, owned = ownedPids, shell = "powershell", limitMs = 3_000 }: ReapOptions = {}): Promise<number[]> {
  if (process.platform !== "win32") return [];
  try {
    const query = execFileAsync(shell, ["-NoProfile", "-NonInteractive", "-Command", QUERY(parentPid)], { windowsHide: true, timeout: limitMs, encoding: "utf8" });
    const helper = query.child.pid;
    const { stdout } = await query;
    const victims = selectReapable(parseProcessRows(stdout), { parentPid, owned, skip: helper === undefined ? [] : [helper] });
    const ended = await Promise.all(victims.map(async victim => {
      // Decided from what the query just saw: the program's name goes with the pid, so a pid that has been reused since matches nothing.
      const args = taskkillArgs({ pid: victim.pid, spawnfile: victim.name, exitCode: null, signalCode: null });
      if (args === undefined) return undefined;
      return await execFileAsync("taskkill", args, { windowsHide: true }).then(() => victim.pid, () => undefined);
    }));
    return ended.filter((pid): pid is number => pid !== undefined);
  } catch {
    return [];
  }
}
