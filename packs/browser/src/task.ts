/**
 * Runs the jev agent loop against a browser this pack already holds, through
 * the Python worker in `packs/browser/python`.
 *
 * The worker is a published-package consumer, nothing more: it constructs the
 * library's own `Agent`, points it at our Chrome's CDP endpoint and reports
 * each step as a JSON line. We maintain the protocol, not the agent.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { TaskStatus, TaskUsage } from "./contracts.js";
import { launchSecrets } from "./secrets.js";
import { fail } from "./store.js";

/** `packs/browser/python`, from both `src/task.ts` and the bundled `app/server.mjs`. */
const PYTHON_DIR = fileURLToPath(new URL("../python/", import.meta.url));
const CANCEL_GRACE_MS = 15_000;
/** After the worker exits, how long its stdout may take to drain before the result is settled without `close`. */
const EXIT_DRAIN_MS = 2_000;
const STDERR_KEEP = 4_096;
/** An unused pre-spawned worker is let go after this long, returning its memory. */
const SPARE_IDLE_MS = 10 * 60_000;

export interface WorkerStep { n: number; action: string; url: string; elapsedMs: number; usage: TaskUsage }
export interface WorkerResult { status: Exclude<TaskStatus, "running">; summary: string; steps: number; elapsedMs: number; usage: TaskUsage }
export interface WorkerJob {
  cdpUrl: string;
  task: string;
  maxSteps: number;
  startUrl: string;
  /** Resolved by the runtime; travels only on the worker's stdin. */
  credential?: { origin: string; password: string };
}
export interface RunningWorker {
  /** Settles with the worker's final result; never rejects. */
  readonly done: Promise<WorkerResult>;
  /** Ask the worker to stop between steps; force-kill after a grace period. */
  cancel(): void;
}

/** jev's key: its task tools are offered, and a spare worker kept, only where it is set (doc 77 §6). */
export function jevKeyConfigured(): boolean {
  return Boolean(launchSecrets.get("TYPESAFE_API_KEY")?.trim());
}

function interpreter(): string {
  const configured = process.env.DIM_BROWSER_PYTHON?.trim();
  if (configured) return configured;
  const venv = process.platform === "win32" ? join(PYTHON_DIR, ".venv", "Scripts", "python.exe") : join(PYTHON_DIR, ".venv", "bin", "python");
  if (!existsSync(venv)) {
    fail(
      "python_env_missing",
      `The jev task agent needs its pinned Python environment. Run: cd "${PYTHON_DIR}" && uv sync --python 3.12 ` +
        "(or set DIM_BROWSER_PYTHON to an interpreter that has it).",
    );
  }
  return venv;
}

function usageOf(line: Record<string, unknown>): TaskUsage {
  const count = (key: string): number => (typeof line[key] === "number" && Number.isFinite(line[key]) ? (line[key] as number) : 0);
  return {
    modelCalls: count("modelCalls"),
    inputTokens: count("inputTokens"),
    outputTokens: count("outputTokens"),
    costUsd: typeof line.costUsd === "number" ? line.costUsd : null,
  };
}

const FINAL: Record<string, true> = { done: true, blocked: true, failed: true, cancelled: true };

/** A worker process whose stderr is already being kept (a spare must not block on a full pipe). */
interface Spawned {
  child: ChildProcessWithoutNullStreams;
  stderr(): string;
}

function spawnWorker(): Spawned {
  const child = spawn(interpreter(), ["-m", "dim_browser_bridge"], {
    cwd: PYTHON_DIR,
    // The keys are not in this process's environment any more (secrets.ts took them at start): the worker is handed them here, and nothing else gets them.
    env: { ...launchSecrets.environment(), PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP);
  });
  child.on("error", () => undefined);
  // A pipe error (the worker or a process it spawned dying mid-write) is an
  // 'error' event; unheard, Node throws it and takes the whole MCP server down.
  child.stdin.on("error", () => undefined);
  child.stdout.on("error", () => undefined);
  child.stderr.on("error", () => undefined);
  return { child, stderr: () => stderr };
}

/**
 * One pre-spawned worker, waiting on stdin, so a jev task's clock starts
 * without the interpreter's start-up. jev's harness reads its env at import
 * time, so nothing of it can be loaded ahead: start-up is all this saves.
 * Kept only where jev's key is set and only once tasks are in use: the first
 * task spawns the next spare, every later one takes it and spawns its
 * successor. Unused, it exits after SPARE_IDLE_MS (the same ten minutes a
 * throwaway browser may sit idle), and the runtime lets it go when disposed.
 */
let spare: { worker: Spawned; env: string; idle: NodeJS.Timeout } | undefined;

/** The spare is only good for the environment it was spawned in (interpreter, keys, PYTHONPATH). */
const envKey = (): string => JSON.stringify(launchSecrets.environment());

/** An idle spare must never keep the server process alive; a running task must. */
function hold(worker: Spawned, held: boolean): void {
  const { child } = worker;
  for (const handle of [child, child.stdin, child.stdout, child.stderr] as Array<{ ref?: () => void; unref?: () => void }>) {
    (held ? handle.ref : handle.unref)?.call(handle);
  }
}

function detachSpare(): typeof spare {
  const detached = spare;
  spare = undefined;
  if (detached) clearTimeout(detached.idle);
  return detached;
}

function takeSpare(): Spawned | undefined {
  const taken = detachSpare();
  if (!taken) return undefined;
  const { child } = taken.worker;
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null && taken.env === envKey()) {
    hold(taken.worker, true);
    return taken.worker;
  }
  child.stdin.end();
  return undefined;
}

function keepSpare(): void {
  if (spare || !jevKeyConfigured()) return;
  let worker: Spawned;
  try {
    worker = spawnWorker();
  } catch {
    return; // no interpreter: the next task reports it
  }
  const idle = setTimeout(() => {
    if (spare?.worker === worker) spare = undefined;
    worker.child.stdin.end();
  }, SPARE_IDLE_MS);
  idle.unref();
  worker.child.once("exit", () => {
    if (spare?.worker === worker) {
      clearTimeout(spare.idle);
      spare = undefined;
    }
  });
  hold(worker, false);
  spare = { worker, env: envKey(), idle };
}

/** Let the waiting spare go: a runtime that is disposed leaves no worker running behind it. */
export function releaseSpare(): void {
  detachSpare()?.worker.child.stdin.end();
}

export function startWorker(job: WorkerJob, onStep: (step: WorkerStep) => void): RunningWorker {
  const { child, stderr } = takeSpare() ?? spawnWorker();
  keepSpare();
  let result: WorkerResult | undefined;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (text) => {
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return; // a stray library print on stdout is not protocol
    }
    if (line.type === "step") {
      onStep({
        n: Number(line.n) || 0,
        action: String(line.action ?? ""),
        url: String(line.url ?? ""),
        elapsedMs: Number(line.elapsedMs) || 0,
        usage: usageOf(line),
      });
    } else if (line.type === "result" && typeof line.status === "string" && FINAL[line.status]) {
      result = {
        status: line.status as WorkerResult["status"],
        summary: String(line.summary ?? ""),
        steps: Number(line.steps) || 0,
        elapsedMs: Number(line.elapsedMs) || 0,
        usage: usageOf(line),
      };
    }
  });
  // The worker's pipes already carry their 'error' listeners (spawnWorker); the
  // result comes from `close` below either way.
  lines.on("error", () => undefined);
  child.stdin.write(`${JSON.stringify(job)}\n`);

  let killTimer: NodeJS.Timeout | undefined;
  const done = new Promise<WorkerResult>((resolve) => {
    const finish = (reason: string): void => {
      clearTimeout(killTimer);
      resolve(result ?? { status: "failed", summary: `${reason}${stderr() ? `: ${stderr().trim().slice(-600)}` : ""}`, steps: 0, elapsedMs: 0, usage: usageOf({}) });
      // Settled: a pipe a lingering grandchild still holds is ours to let go of.
      lines.close();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    child.once("error", (error) => finish(`task worker failed to start (${error.message})`));
    // `close` (not `exit`) so every stdout line has been read first. A process
    // the worker spawned can inherit its pipes and hold them open after it
    // exits, so `close` never comes: then `exit` plus a drain grace settles it.
    child.once("close", (code, signal) => finish(`task worker exited (${signal ?? code})`));
    child.once("exit", (code, signal) => {
      setTimeout(() => finish(`task worker exited (${signal ?? code})`), EXIT_DRAIN_MS).unref();
    });
  });
  return {
    done,
    cancel() {
      // Stdin EOF is the protocol's cancel: the worker stops between steps and
      // cleans up what it started. Killing is the fallback, not the method.
      child.stdin.end();
      killTimer ??= setTimeout(() => child.kill(), CANCEL_GRACE_MS);
    },
  };
}
