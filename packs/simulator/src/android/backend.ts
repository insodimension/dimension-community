// The Android DeviceBackend: adb for everything a person or an agent does to a
// device, the emulator binary for booting one, scrcpy-server for live video.

import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { BootHandle, BootObserver, DeviceBackend, OwnedProcess, ResolvedBoot, RunningEmulator, StopOptions, StopOutcome, VideoStream, VideoStreamHandlers, VideoStreamOptions } from "../backend";
import { type DeviceInfo, type DeviceState, fail, type KeyName, type Screenshot, type UiSnapshot } from "../contracts";
import { classifyDevice } from "../device-safety";
import type { Size } from "../shared/pointer";
import type { GpuMode } from "../settings";
import { fixFor, type Toolchain } from "../toolchain";
import { Adb } from "./adb";
import { type AdbEntry, type BootSample, avdLockHolder, bootFailureMessage, bootStalled, buildEmulatorArgs, consolePortOf, emulatorLaunchVerdict, fallbackNote, freshEmulators, isLockRaceExit, LAUNCH_MARKER, LOCK_EXIT_CODE, parseAvdName, pickSerial, relaunchBlockers, RESUMED_NOTE, SOFTWARE_GPU, STALL_POLICY, type StallPolicy, stillSuspendedReason, SUSPEND_POLICY, type SuspendPolicy } from "./emulator-boot";
import { emulatorProcess, isProcessAlive, nodeProcessTable, type ProcessRow, type ProcessTable, processTree, processVerdict, START_TOLERANCE_MS, stillInTree, suspendedVerdict, treePorts, treeUsage } from "./process-table";
import { rawToPng } from "./png";
import { openVideoSession } from "./scrcpy";
import { KEYCODES } from "./scrcpy-wire";
import { parseUiDump } from "./ui-tree";

/** How long each part of a boot waits. The defaults are the measured ones; a test shrinks them. */
export interface BootTiming {
  /** Between looks at `adb devices` while the emulator starts. Boot-bounded: it ends when the device is found, the process dies or the budget runs out. */
  readonly pollMs: number;
  /** When a boot with no device counts as stalled, and on how little CPU. */
  readonly stall: StallPolicy;
  /** Between stall checks once the first is due (each reads the process table). */
  readonly stallCheckMs: number;
  /** The whole boot, spawn to `sys.boot_completed`. */
  readonly budgetMs: number;
  /** How long an emulator asked to close itself gets before its process tree is killed. */
  readonly stopGraceMs: number;
  /** When the emulator's threads are looked at for a suspend, and how often it may be resumed. */
  readonly suspend: SuspendPolicy;
  /** How long a relaunch waits for the killed tree to be gone and the AVD's lock to be let go of. */
  readonly relaunchWaitMs: number;
}

export const DEFAULT_BOOT_TIMING: BootTiming = { pollMs: 1_000, stall: STALL_POLICY, stallCheckMs: 15_000, budgetMs: 240_000, stopGraceMs: 20_000, suspend: SUSPEND_POLICY, relaunchWaitMs: 10_000 };

export interface AndroidBackendDeps {
  /** The toolchain as it is NOW (the caller decides how often it is re-resolved). */
  readonly toolchain: () => Toolchain;
  readonly log: (message: string) => void;
  /** Where emulator logs go. */
  readonly logDir: string;
  /** The `-gpu` mode the person chose (`simulator.gpu`), read when a boot starts. */
  readonly gpu: () => GpuMode;
  /** The host's process and listener tables. The real ones unless a test supplies its own. */
  readonly processes?: ProcessTable;
  /** The AVD directory (`ANDROID_AVD_HOME`, then the SDK's own rule) unless a test points it elsewhere. */
  readonly avdHome?: () => string;
  readonly timing?: Partial<BootTiming>;
  readonly now?: () => number;
}

interface Probe {
  readonly version: string | null;
  readonly booted: boolean;
  readonly avd: string | null;
  readonly model: string | null;
  readonly display: Size | null;
  readonly density: number | null;
  /** `ro.kernel.qemu`, `ro.boot.qemu`, `ro.hardware`, `ro.build.characteristics`: what says whether it is an emulator (see classifyDevice). */
  readonly kernelQemu: string | null;
  readonly bootQemu: string | null;
  readonly hardware: string | null;
  readonly characteristics: string | null;
}

/** One `adb shell` instead of six: marker lines, so a missing property cannot shift the rest. */
const PROBE_COMMAND = [
  "echo V=$(getprop ro.build.version.release)",
  "echo B=$(getprop sys.boot_completed)",
  "echo A=$(getprop ro.boot.qemu.avd_name)",
  "echo K=$(getprop ro.kernel.qemu.avd_name)",
  "echo M=$(getprop ro.product.model)",
  "echo Q=$(getprop ro.kernel.qemu)",
  "echo QB=$(getprop ro.boot.qemu)",
  "echo H=$(getprop ro.hardware)",
  "echo C=$(getprop ro.build.characteristics)",
  "wm size",
  "wm density",
].join("; ");

export function parseProbe(output: string): Probe {
  const field = (marker: string): string | null => {
    const value = new RegExp(`^${marker}=(.*)$`, "m").exec(output)?.[1]?.trim();
    return value ? value : null;
  };
  // An override (set with `wm size`/`wm density`) is what input coordinates are in; it prints after the physical value.
  const sizes = [...output.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g)];
  const lastSize = sizes.at(-1);
  const densities = [...output.matchAll(/(?:Physical|Override) density:\s*(\d+)/g)];
  const lastDensity = densities.at(-1);
  return {
    version: field("V"),
    booted: field("B") === "1",
    avd: field("A") ?? field("K"),
    model: field("M"),
    display: lastSize?.[1] && lastSize[2] ? { width: Number(lastSize[1]), height: Number(lastSize[2]) } : null,
    density: lastDensity?.[1] ? Number(lastDensity[1]) : null,
    kernelQemu: field("Q"),
    bootQemu: field("QB"),
    hardware: field("H"),
    characteristics: field("C"),
  };
}

export interface ApkPathRefusal {
  readonly code: "apk_path_not_absolute" | "apk_path_network";
  readonly message: string;
}

export function apkPathRefusal(apkPath: string, platform: NodeJS.Platform): ApkPathRefusal | null {
  const windows = platform === "win32";
  if (windows && /^[\\/]{2}/.test(apkPath)) {
    return { code: "apk_path_network", message: `${apkPath} is a network or device path (UNC, \\\\?\\ or //host), which the pack will not open. Pass the absolute path of an .apk on a local drive.` };
  }
  if (!(windows ? win32 : posix).isAbsolute(apkPath)) {
    return { code: "apk_path_not_absolute", message: `${apkPath} is not an absolute path. Pass the absolute path of a built .apk on this machine.` };
  }
  return null;
}

const BOOT_COMPLETED_LOOP = 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done';
/** An emulator log past this is started afresh at the next launch. */
const LOG_ROTATE_BYTES = 1024 * 1024;

/** What one boot is, across a graphics fallback. */
interface BootContext {
  readonly avd: string;
  readonly request: ResolvedBoot;
  readonly emulator: string;
  readonly adb: Adb;
  readonly observer: BootObserver;
  /** adb's devices before the first spawn. */
  readonly before: readonly AdbEntry[];
  readonly baked: boolean;
  /** The AVD's own folder: where its snapshots and its lock live. */
  readonly avdDir: string;
  readonly timing: BootTiming;
  fellBack: boolean;
  /** Resumes spent so far, across the relaunches of this boot. */
  resumes: number;
  /** The tool result already says the emulator was resumed. */
  resumeNoted: boolean;
  /** The one start-again after losing a race for the AVD's lock has been used. */
  lockRetried: boolean;
}

/** One spawned emulator process. */
interface Launch {
  readonly process: OwnedProcess;
  readonly avd: string;
  readonly gpu: GpuMode;
  readonly logPath: string;
  exited: boolean;
  /** When it ended, on the pack's clock; null while it runs. */
  exitedAt: number | null;
  code: number | null;
  /** Settles with the exit code when the process ends. */
  readonly exit: Promise<number | null>;
}

type Watch =
  | { readonly kind: "found"; readonly serial: string }
  | { readonly kind: "exited" }
  | { readonly kind: "timeout" }
  | {
      readonly kind: "stalled";
      readonly sample: BootSample;
      /** The emulator was found suspended at the last look and was not resumed: a freeze, not a hung GPU. */
      readonly suspended: boolean;
    };

export class AndroidBackend implements DeviceBackend {
  readonly platform = "android" as const;
  readonly #deps: AndroidBackendDeps;
  readonly #adbs = new Map<string, Adb>();
  readonly #static = new Map<string, Probe>();
  readonly #displays = new Map<string, Size>();
  /** Emulators this backend spawned and still holds the handle of. */
  readonly #launches = new Map<number, Launch>();
  readonly #exited = new Set<string>();
  readonly #table: ProcessTable;

  constructor(deps: AndroidBackendDeps) {
    this.#deps = deps;
    this.#table = deps.processes ?? nodeProcessTable(deps.log);
  }

  #adb(): Adb {
    const toolchain = this.#deps.toolchain();
    const path = toolchain.adb;
    if (path === null) fail("missing_adb", `adb is not installed or not found. ${fixFor(toolchain, "adb")}`);
    let adb = this.#adbs.get(path);
    if (adb === undefined) {
      adb = new Adb(path);
      this.#adbs.set(path, adb);
    }
    return adb;
  }

  liveAvailable(): boolean {
    return this.#deps.toolchain().scrcpyServer !== null;
  }

  async list(): Promise<DeviceInfo[]> {
    const adb = this.#adb();
    const devices = await adb.devices();
    const live = new Set(devices.map(device => device.serial));
    for (const serial of this.#static.keys()) if (!live.has(serial)) this.#static.delete(serial);
    return Promise.all(
      devices.map(async (device): Promise<DeviceInfo> => {
        const base = { serial: device.serial, platform: "android" as const, owned: false, live: false, viewers: 0 };
        const emulator = consolePortOf(device.serial) !== null;
        if (device.state !== "device") {
          const state: DeviceState = device.state === "unauthorized" ? "unauthorized" : "offline";
          const name = (emulator ? await this.#consoleAvd(adb, device.serial) : null) ?? device.model ?? device.serial;
          return { ...base, kind: classifyDevice({ serial: device.serial }), state, name, androidVersion: null, display: null, density: null };
        }
        // A device that has just appeared and does not answer a shell yet is still booting: not a reason for the whole list to fail.
        const probe = await this.#probe(adb, device.serial).catch(() => null);
        const display = probe?.display ?? this.#displays.get(device.serial) ?? null;
        if (probe?.display) this.#displays.set(device.serial, probe.display);
        const consoleName = emulator && (probe?.avd ?? null) === null ? await this.#consoleAvd(adb, device.serial) : null;
        return {
          ...base,
          kind: classifyDevice({ serial: device.serial, ...probe }),
          state: probe?.booted === true ? "online" : "booting",
          name: probe?.avd ?? consoleName ?? probe?.model ?? device.model ?? device.serial,
          androidVersion: probe?.version ?? null,
          display,
          density: probe?.density ?? null,
        };
      }),
    );
  }

  async ensureConnected(serial: string): Promise<void> {
    // An emulator names itself `emulator-<console port>`: the common case needs no round trip.
    if (classifyDevice({ serial }) === "emulator") return;
    const listed = (await this.#adb().devices()).find(device => device.serial === serial);
    if (listed === undefined) fail("not_connected", `${serial} is not connected. Run device_list to see what is, or device_boot to start an emulator.`);
  }

  async #probe(adb: Adb, serial: string): Promise<Probe> {
    try {
      const probe = parseProbe(await adb.shell(serial, PROBE_COMMAND, { timeoutMs: 10_000 }));
      // Identity does not change while the device runs; boot state and size do.
      this.#static.set(serial, probe);
      return probe;
    } catch (error) {
      const known = this.#static.get(serial);
      if (known) return { ...known, booted: false };
      throw error;
    }
  }

  async avds(): Promise<string[]> {
    const emulator = this.#deps.toolchain().emulator;
    if (emulator === null) return [];
    const { promise, resolve } = Promise.withResolvers<string[]>();
    const child = spawn(emulator, ["-list-avds"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.on("data", chunk => {
      out += chunk.toString();
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out.split(/\r?\n/).map(line => line.trim()).filter(line => line !== "" && !line.startsWith("INFO") && !line.includes(" ")));
    });
    child.on("error", () => resolve([]));
    return promise;
  }

  // ── booting ───────────────────────────────────────────────────────────────
  //
  // The pack spawns the emulator WITHOUT a port (it takes the first free pair, so it can never
  // collide with one the person runs), then learns which serial is its own from the process it
  // spawned: the tree listens on that console port. Everything it later does to that emulator
  // (stop, kill after a stall, kill after a failed boot) acts on that process tree, verified by
  // pid AND start time, and never on a serial.

  async startBoot(request: ResolvedBoot, observer: BootObserver): Promise<BootHandle> {
    const toolchain = this.#deps.toolchain();
    const { emulator } = toolchain;
    if (emulator === null) fail("missing_emulator", `the Android emulator is not installed or not found. ${fixFor(toolchain, "emulator")}`);
    const adb = this.#adb();
    const { avd } = request;
    const avds = await this.avds();
    if (!avds.includes(avd)) fail("unknown_avd", `no AVD named "${avd}". Available: ${avds.join(", ") || "none"}`);

    // What adb shows before the spawn is not ours, whatever appears next to it.
    const before = (await adb.devices()).map(({ serial, state }): AdbEntry => ({ serial, state }));
    const avdDir = join((this.#deps.avdHome ?? avdHome)(), `${avd}.avd`);
    const baked = existsSync(join(avdDir, "snapshots", "avdslim_clean"));
    const ctx: BootContext = { avd, request, emulator, adb, observer, before, baked, avdDir, timing: { ...DEFAULT_BOOT_TIMING, ...this.#deps.timing }, fellBack: false, resumes: 0, resumeNoted: false, lockRetried: false };
    const first = await this.#launch(ctx, this.#deps.gpu());
    const ready = this.#supervise(ctx, first);
    ready.catch(() => undefined);
    return { avd, ready };
  }

  /** Spawn the emulator and tell the observer which process it is, before anything else can fail. */
  async #launch(ctx: BootContext, gpu: GpuMode): Promise<Launch> {
    const { avd, request } = ctx;
    const readOnly = request.readOnly === true;
    const args = buildEmulatorArgs({ avd, headless: request.headless === true, cold: request.cold === true, bakedSnapshot: ctx.baked, gpu, ...(readOnly ? { readOnly } : {}) });
    mkdirSync(this.#deps.logDir, { recursive: true });
    const logPath = join(this.#deps.logDir, `${avd}${readOnly ? ".read-only" : ""}.log`);
    const fd = openSync(logPath, existsSync(logPath) && statSync(logPath).size > LOG_ROTATE_BYTES ? "w" : "a");
    const startedAt = this.#now();
    // The argv, first: the log then shows exactly what the pack asked for.
    writeSync(fd, `\n--- ${new Date(startedAt).toISOString()} ${LAUNCH_MARKER} emulator ${args.join(" ")}\n`);
    const child = spawn(ctx.emulator, args, { detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
    closeSync(fd);
    child.unref();
    const failure = (reason: string): Error => new Error(bootFailureMessage(reason, { path: logPath, text: readLogTail(logPath) }));
    const spawnError = Promise.withResolvers<Error>();
    const exit = Promise.withResolvers<number | null>();
    child.once("error", spawnError.resolve);
    if (child.pid === undefined) throw failure(`could not start the emulator: ${(await spawnError.promise).message}`);

    const launch: Launch = { process: { pid: child.pid, startedAt }, avd, gpu, logPath, exited: false, exitedAt: null, code: null, exit: exit.promise };
    const done = (code: number | null): void => {
      launch.exited = true;
      launch.exitedAt = this.#now();
      launch.code = code;
      this.#launches.delete(launch.process.pid);
      this.#exited.add(`${launch.process.pid}@${launch.process.startedAt}`);
      exit.resolve(code);
    };
    child.once("exit", done);
    void spawnError.promise.then(() => done(null));
    this.#launches.set(launch.process.pid, launch);
    ctx.observer.spawned(launch.process);
    this.#deps.log(`[sim] booting ${avd} (pid ${launch.process.pid}, ${request.headless ? "headless" : "windowed"}, ${request.cold ? "cold" : ctx.baked ? "baked snapshot" : "default snapshot"}, -gpu ${gpu}${readOnly ? ", read-only" : ""}); log ${logPath}`);
    return launch;
  }

  /** Watch one launch until the device is up, the process dies, the boot stalls or the budget ends. A frozen emulator is resumed (never mistaken for a hung GPU); a stall relaunches ONCE with software graphics; an exit that is only a lost race for the AVD's lock starts the emulator once more. Anything that fails leaves nothing of the pack's running. */
  async #supervise(ctx: BootContext, first: Launch): Promise<DeviceInfo> {
    let launch = first;
    for (;;) {
      const seen = await this.#watch(ctx, launch);
      const fallenBack = ctx.fellBack ? " (It had already fallen back to software graphics.)" : "";
      const retried = ctx.lockRetried ? " (It had already been started again once, after the AVD's lock was still held.)" : "";
      const failure = (reason: string): Error => new Error(bootFailureMessage(`${reason}${fallenBack}${retried}`, { path: launch.logPath, text: readLogTail(launch.logPath) }));
      switch (seen.kind) {
        case "found":
          return this.#finish(ctx, launch, seen.serial, failure);
        case "exited":
          if (!ctx.lockRetried && isLockRaceExit({ code: launch.code, elapsedMs: (launch.exitedAt ?? this.#now()) - launch.process.startedAt }, readLogTail(launch.logPath))) {
            ctx.lockRetried = true;
            this.#deps.log(`[sim] ${ctx.avd}: the emulator exited with code ${LOCK_EXIT_CODE} right after the spawn and printed no FATAL line: the AVD's lock was still held. Waiting for it, then starting the emulator once more.`);
            await this.#awaitAvdFree(ctx, []);
            launch = await this.#launch(ctx, launch.gpu);
            break;
          }
          throw failure(`the emulator for ${ctx.avd} exited with code ${launch.code ?? "?"} before it finished booting.`);
        case "timeout":
          await this.#end(launch);
          throw failure(`the emulator for ${ctx.avd} did not show up in adb within ${Math.round(ctx.timing.budgetMs / 1000)} s; the pack stopped it.`);
        case "stalled": {
          const relaunch = !seen.suspended && !ctx.fellBack && launch.gpu !== SOFTWARE_GPU;
          // What the kill has to be waited out of: read before it, while the tree is still there.
          const killed = relaunch ? await this.#treeOf(launch) : [];
          await this.#end(launch);
          if (seen.suspended) throw failure(stillSuspendedReason(ctx.avd, ctx.resumes));
          if (!relaunch) {
            const seconds = Math.round(seen.sample.elapsedMs / 1000);
            throw failure(`the emulator for ${ctx.avd} showed no sign of booting after ${seconds} s (${seen.sample.cpuSeconds?.toFixed(1) ?? "?"} s of CPU, no adb device, -gpu ${launch.gpu}); the pack stopped it.`);
          }
          const note = fallbackNote(seen.sample, launch.gpu);
          this.#deps.log(`[sim] ${ctx.avd}: ${note}`);
          ctx.observer.note(note);
          ctx.fellBack = true;
          await this.#awaitAvdFree(ctx, killed);
          launch = await this.#launch(ctx, SOFTWARE_GPU);
          break;
        }
      }
    }
  }

  /**
   * Wait for the device to appear. Two clocks tick beside it: the SUSPEND look (the
   * emulator's threads, first at `suspend.firstCheckMs`, then every `checkMs`, or
   * `recheckMs` after a resume or a suspended finding) and the STALL verdict (little
   * CPU for `stall.afterMs`). A resume restarts the stall clock: the time a process
   * spent frozen says nothing about the GPU.
   */
  async #watch(ctx: BootContext, launch: Launch): Promise<Watch> {
    const { timing } = ctx;
    const spawnedAt = launch.process.startedAt;
    let stallFrom = spawnedAt;
    let nextStallCheck = stallFrom + timing.stall.afterMs;
    let nextSuspendCheck = spawnedAt + timing.suspend.firstCheckMs;
    let frozen = false;
    for (;;) {
      if (launch.exited) return { kind: "exited" };
      const serial = await this.#findSerial(ctx, launch).catch(() => null);
      if (serial !== null) return { kind: "found", serial };
      if (this.#now() - spawnedAt >= timing.budgetMs) return { kind: "timeout" };
      if (this.#now() >= nextSuspendCheck || this.#now() >= nextStallCheck) {
        // One read of the table serves both questions.
        const rows = await this.#table.processes().catch(() => null);
        if (this.#now() >= nextSuspendCheck) {
          const look = await this.#lookForSuspension(ctx, launch, rows);
          frozen = look.suspended;
          nextSuspendCheck = this.#now() + (look.suspended || look.resumed ? timing.suspend.recheckMs : timing.suspend.checkMs);
          if (look.resumed) {
            stallFrom = this.#now();
            nextStallCheck = stallFrom + timing.stall.afterMs;
          }
        }
        if (this.#now() >= nextStallCheck) {
          nextStallCheck = this.#now() + timing.stallCheckMs;
          const usage = rows === null ? null : treeUsage(rows, launch.process.pid);
          const sample: BootSample = { elapsedMs: this.#now() - stallFrom, alive: !launch.exited, deviceSeen: false, cpuSeconds: usage === null ? null : usage.cpuSeconds };
          if (bootStalled(sample, timing.stall)) return { kind: "stalled", sample, suspended: frozen };
        }
      }
      await Promise.race([delay(timing.pollMs), launch.exit]);
    }
  }

  /**
   * One look at whether the emulator is frozen, and the resume if it is. `rows` is the
   * table just read. Only the emulator process under the pack's own launcher is looked at,
   * and it is resumed only after a second read proves it is STILL that process (same pid,
   * same start, same parent chain): a pid is a name until its start time agrees.
   * `suspended` = frozen and not resumed now; `resumed` = the host accepted a resume.
   */
  async #lookForSuspension(ctx: BootContext, launch: Launch, rows: readonly ProcessRow[] | null): Promise<{ readonly suspended: boolean; readonly resumed: boolean }> {
    const clear = { suspended: false, resumed: false };
    const frozen = { suspended: true, resumed: false };
    if (rows === null || launch.exited) return clear;
    const verdict = processVerdict(rows, launch.process);
    if (verdict !== "ours") {
      if (verdict === "reused") this.#deps.log(`[sim] ${ctx.avd}: not looking at pid ${launch.process.pid}: it started at another time than the pack recorded, so the pid now belongs to something else`);
      return clear;
    }
    const target = emulatorProcess(rows, launch.process.pid);
    if (target === null) return clear;
    if (suspendedVerdict(await this.#table.threadStates(target.pid).catch(() => null)) !== "suspended") return clear;
    this.#deps.log(`[sim] ${ctx.avd}: every thread of the emulator process (pid ${target.pid}) is suspended by the system`);
    if (ctx.resumes >= ctx.timing.suspend.maxResumes) return frozen;
    const fresh = await this.#table.processes().catch(() => null);
    if (fresh === null || launch.exited || processVerdict(fresh, launch.process) !== "ours" || !stillInTree(fresh, launch.process.pid, target)) return frozen;
    ctx.resumes++;
    const resumed = await this.#table.resume(target.pid, target.startedAtMs).catch(() => false);
    this.#deps.log(`[sim] ${ctx.avd}: ${resumed ? "resumed" : "could not resume"} the emulator process (pid ${target.pid}); resume ${ctx.resumes} of ${ctx.timing.suspend.maxResumes}`);
    if (resumed && !ctx.resumeNoted) {
      ctx.resumeNoted = true;
      ctx.observer.note(RESUMED_NOTE);
    }
    return { suspended: !resumed, resumed };
  }

  /** `launch`'s process and everything under it, as the table shows them now; empty when the table cannot be read. */
  async #treeOf(launch: Launch): Promise<ProcessRow[]> {
    const rows = await this.#table.processes().catch(() => null);
    return rows === null ? [] : processTree(rows, launch.process.pid);
  }

  /**
   * Before the AVD is launched again: wait (at most `relaunchWaitMs`) until nothing of the
   * `killed` tree runs and nothing runs under the pid in the AVD's lock. Launched sooner,
   * the new emulator finds the lock still named and exits at once with code 253. A table
   * that cannot be read cannot be waited on; the retry after a 253 is the backstop.
   */
  async #awaitAvdFree(ctx: BootContext, killed: readonly ProcessRow[]): Promise<void> {
    const deadline = this.#now() + ctx.timing.relaunchWaitMs;
    for (;;) {
      const rows = await this.#table.processes().catch(() => null);
      if (rows === null) return;
      const blockers = relaunchBlockers(rows, killed, avdLockHolder(ctx.avdDir, readTextOrNull));
      if (blockers.length === 0) return;
      if (this.#now() >= deadline) {
        this.#deps.log(`[sim] ${ctx.avd}: pid ${blockers.join(", ")} still running ${Math.round(ctx.timing.relaunchWaitMs / 1000)} s after the kill; starting the emulator anyway`);
        return;
      }
      await delay(Math.min(ctx.timing.pollMs, 250));
    }
  }

  /** The wait that follows the serial: Android itself reaching `sys.boot_completed`. */
  async #finish(ctx: BootContext, launch: Launch, serial: string, failure: (reason: string) => Error): Promise<DeviceInfo> {
    ctx.observer.serial(serial);
    this.#deps.log(`[sim] ${ctx.avd} (pid ${launch.process.pid}) answers as ${serial}`);
    const abort = new AbortController();
    void launch.exit.then(() => abort.abort());
    try {
      await this.#bootCompleted(ctx.adb, serial, Math.max(10_000, ctx.timing.budgetMs - (this.#now() - launch.process.startedAt)), abort.signal);
    } catch (error) {
      if (launch.exited) throw failure(`the emulator for ${ctx.avd} exited with code ${launch.code ?? "?"} before it finished booting.`);
      await this.#end(launch);
      throw failure(error instanceof Error ? error.message : String(error));
    }
    let info: DeviceInfo | undefined;
    let reason = `${serial} booted but is not listed by adb.`;
    try {
      info = (await this.list()).find(device => device.serial === serial);
    } catch (error) {
      reason = `${serial} booted but adb could not list it: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (info === undefined) {
      await this.#end(launch);
      throw failure(reason);
    }
    return info;
  }

  /** The serial of the emulator under `launch`, or null while it cannot be told. */
  async #findSerial(ctx: BootContext, launch: Launch): Promise<string | null> {
    const after = (await ctx.adb.devices()).map(({ serial, state }): AdbEntry => ({ serial, state }));
    // Nothing new to look at: no reason to read the process table.
    if (freshEmulators(ctx.before, after).length === 0) return null;
    const pick = pickSerial({ before: ctx.before, after, treePorts: await this.#consolePorts(launch.process.pid) });
    if (pick === null) return null;
    // Without a listener list the only newcomer is a guess: the emulator itself says whether it is our AVD.
    if (pick.basis === "diff" && (await this.#consoleAvd(ctx.adb, pick.serial)) !== ctx.avd) return null;
    return pick.serial;
  }

  /** TCP ports the process tree under `pid` listens on; null when the host cannot list processes or listeners. */
  async #consolePorts(pid: number): Promise<number[] | null> {
    const [rows, listeners] = await Promise.all([this.#table.processes().catch(() => null), this.#table.listeners().catch(() => null)]);
    return rows === null ? null : treePorts(rows, listeners, pid);
  }

  /** Stop what a boot spawned, and wait (briefly) until it is gone. */
  async #end(launch: Launch): Promise<void> {
    await this.#kill(launch.process, launch.avd);
    await Promise.race([launch.exit, delay(5_000)]);
  }

  /** Kill the tree under `target` if, and only if, it is still the process the pack spawned. */
  async #kill(target: OwnedProcess, avd: string): Promise<"ours" | "gone" | "reused" | "unknown"> {
    const verdict = await this.processState(target, avd);
    if (verdict !== "ours") {
      if (verdict !== "gone") this.#deps.log(`[sim] not killing pid ${target.pid}: ${verdict === "reused" ? "it is not the emulator process the pack launched (another start time, or another program), so the pid now belongs to something else" : "the process table or its command line could not be read, so it cannot be verified"}`);
      return verdict;
    }
    const rows = await this.#table.processes().catch(() => []);
    await this.#table.killTree(target.pid, rows);
    return verdict;
  }

  async processState(target: OwnedProcess, avd?: string): Promise<"ours" | "gone" | "reused" | "unknown"> {
    const launch = this.#launches.get(target.pid);
    if (launch !== undefined && !launch.exited && Math.abs(launch.process.startedAt - target.startedAt) <= START_TOLERANCE_MS) return "ours";
    if (this.#exited.has(`${target.pid}@${target.startedAt}`)) return "gone";
    const rows = await this.#table.processes().catch(() => null);
    const verdict = processVerdict(rows, target);
    if (verdict !== "ours" || avd === undefined) return verdict;
    const row = rows?.find(candidate => candidate.pid === target.pid);
    const launchVerdict = row === undefined ? "unknown" : emulatorLaunchVerdict(row, avd);
    return launchVerdict === "launch" ? "ours" : launchVerdict === "other" ? "reused" : "unknown";
  }

  async serialOf(target: OwnedProcess): Promise<string | null> {
    const adb = this.#adb();
    const [rows, listeners, devices] = await Promise.all([this.#table.processes().catch(() => null), this.#table.listeners().catch(() => null), adb.devices().catch(() => null)]);
    if (rows === null || devices === null) return null;
    const live = this.#launches.get(target.pid);
    if ((live === undefined || live.exited) && processVerdict(rows, target) !== "ours") return null;
    const ports = treePorts(rows, listeners, target.pid);
    if (ports === null) return null;
    return pickSerial({ before: [], after: devices.map(({ serial, state }): AdbEntry => ({ serial, state })), treePorts: ports })?.serial ?? null;
  }

  async stop(target: OwnedProcess, serial: string | null, options: StopOptions): Promise<StopOutcome> {
    const verdict = await this.processState(target, options.avd);
    if (verdict === "unknown") {
      fail("cannot_verify", `the pack could not read the host's process table or the command line of pid ${target.pid}, so it cannot prove that this is the emulator it started, and it stops nothing it cannot prove. Close the emulator yourself.`);
    }
    if (serial !== null) {
      this.#static.delete(serial);
      this.#displays.delete(serial);
    }
    if (verdict !== "ours") return "already-exited";
    const graceMs = options.graceMs ?? this.#timing().stopGraceMs;
    const { killNow } = options;
    if (serial !== null && killNow?.aborted !== true) {
      const consoleSerial = await this.serialOf(target);
      if (consoleSerial === serial && killNow?.aborted !== true) {
        await this.#adb().run(serial, ["emu", "kill"], { timeoutMs: options.graceMs === undefined ? 15_000 : Math.min(15_000, options.graceMs), ...(killNow ? { signal: killNow } : {}) }).catch(() => undefined);
        await this.#exitWithin(target, graceMs, killNow);
      }
    }
    if (this.#alive(target.pid)) {
      await this.#kill(target, options.avd);
      await this.#exitWithin(target, Math.min(5_000, graceMs));
    }
    return "stopped";
  }

  #alive(pid: number): boolean {
    const launch = this.#launches.get(pid);
    return launch === undefined ? isProcessAlive(pid) : !launch.exited;
  }

  async #exitWithin(target: OwnedProcess, ms: number, killNow?: AbortSignal): Promise<void> {
    const deadline = this.#now() + ms;
    while (this.#alive(target.pid) && this.#now() < deadline && killNow?.aborted !== true) await delay(250);
  }

  async runningEmulators(): Promise<RunningEmulator[]> {
    const adb = this.#adb();
    const emulators = (await adb.devices()).filter(device => consolePortOf(device.serial) !== null);
    const named = await Promise.all(emulators.map(async device => ({ serial: device.serial, avd: await this.#consoleAvd(adb, device.serial) })));
    return named.flatMap(emulator => (emulator.avd === null ? [] : [{ serial: emulator.serial, avd: emulator.avd }]));
  }

  /** The emulator's own answer to "which AVD are you?" (`adb -s <serial> emu avd name`): its console replies while Android is still starting, which `getprop` cannot. */
  async #consoleAvd(adb: Adb, serial: string): Promise<string | null> {
    return adb.text(serial, ["emu", "avd", "name"], { timeoutMs: 5_000 }).then(parseAvdName, () => null);
  }

  async waitBooted(serial: string, timeoutMs: number): Promise<DeviceInfo | null> {
    try {
      await this.#bootCompleted(this.#adb(), serial, timeoutMs);
    } catch {
      return null;
    }
    return (await this.list()).find(device => device.serial === serial) ?? null;
  }

  #bootCompleted(adb: Adb, serial: string, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
    return adb.run(serial, ["wait-for-device", "shell", BOOT_COMPLETED_LOOP], { timeoutMs, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) });
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #timing(): BootTiming {
    return { ...DEFAULT_BOOT_TIMING, ...this.#deps.timing };
  }

  async display(serial: string): Promise<Size> {
    const known = this.#displays.get(serial);
    if (known) return known;
    const probe = await this.#probe(this.#adb(), serial);
    if (probe.display === null) fail("no_display", `${serial} did not report a display size; is it fully booted?`);
    this.#displays.set(serial, probe.display);
    return probe.display;
  }

  async screenshot(serial: string, maxEdge: number): Promise<Screenshot> {
    const adb = this.#adb();
    const raw = await adb.execOut(serial, ["screencap"], { timeoutMs: 20_000 });
    const shot = await rawToPng(raw, maxEdge);
    this.#displays.set(serial, shot.source);
    return { png: shot.png, width: shot.width, height: shot.height, scale: shot.scale, display: shot.source };
  }

  async tap(serial: string, x: number, y: number): Promise<void> {
    await this.#adb().shell(serial, `input tap ${Math.round(x)} ${Math.round(y)}`);
  }

  async swipe(serial: string, from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number): Promise<void> {
    await this.#adb().shell(serial, `input swipe ${Math.round(from.x)} ${Math.round(from.y)} ${Math.round(to.x)} ${Math.round(to.y)} ${Math.round(durationMs)}`);
  }

  async text(serial: string, text: string): Promise<void> {
    if (!/^[\x20-\x7e]*$/.test(text)) fail("text_not_ascii", "device_type sends printable ASCII through adb. For other characters, open the pane (device_open) so a live session can type them, or paste them from the app.");
    // `input text` reads %s as a space; the quotes stop the device shell reading anything else.
    const body = text.replaceAll(" ", "%s").replaceAll("'", "'\\''");
    await this.#adb().shell(serial, `input text '${body}'`);
  }

  async key(serial: string, key: KeyName): Promise<void> {
    const code = KEYCODES[key];
    if (code === undefined) fail("unknown_key", `unknown key "${key}".`);
    await this.#adb().shell(serial, `input keyevent ${code}`);
  }

  async openUrl(serial: string, url: string): Promise<void> {
    const out = await this.#adb().shell(serial, `am start -W -a android.intent.action.VIEW -d '${url.replaceAll("'", "'\\''")}'`);
    if (/Error:|Exception/.test(out)) fail("open_url_failed", `no app on ${serial} could open ${url}: ${out.trim().split("\n").find(line => /Error/.test(line)) ?? out.trim().slice(0, 160)}`);
  }

  async install(serial: string, apkPath: string): Promise<string> {
    const refusal = apkPathRefusal(apkPath, process.platform);
    if (refusal !== null) fail(refusal.code, refusal.message);
    let resolved: string;
    try {
      resolved = realpathSync(apkPath);
    } catch {
      fail("apk_not_found", `no file at ${apkPath}. Pass the absolute path of a built .apk.`);
    }
    const resolvedRefusal = apkPathRefusal(resolved, process.platform);
    if (resolvedRefusal !== null) fail(resolvedRefusal.code, resolvedRefusal.message);
    if (!statSync(resolved).isFile()) fail("apk_not_found", `no file at ${apkPath}. Pass the absolute path of a built .apk.`);
    if (!resolved.toLowerCase().endsWith(".apk")) fail("apk_not_apk", `${apkPath} is not an .apk. For an .aab or split APKs, use bundletool to build a universal .apk first.`);
    const out = await this.#adb().text(serial, ["install", "-r", "-g", "-t", resolved], { timeoutMs: 180_000 });
    return out.trim().split(/\r?\n/).filter(line => line !== "").pop() ?? "Success";
  }

  async launch(serial: string, target: string): Promise<void> {
    if (!/^[A-Za-z0-9_.]+(\/[A-Za-z0-9_.$]+)?$/.test(target)) fail("bad_package", `"${target}" is not a package name (com.example.app) or a component (com.example.app/.MainActivity).`);
    const out = target.includes("/")
      ? await this.#adb().shell(serial, `am start -n '${target}'`)
      : await this.#adb().shell(serial, `monkey -p ${target} -c android.intent.category.LAUNCHER 1`);
    if (/No activities found|Error:|does not exist/.test(out)) fail("launch_failed", `could not launch ${target}: it is not installed on ${serial}, or has no launcher activity. device_install the .apk first.`);
  }

  async uiTree(serial: string): Promise<UiSnapshot> {
    const adb = this.#adb();
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const snapshot = parseUiDump((await adb.execOut(serial, ["uiautomator", "dump", "/dev/tty"], { timeoutMs: 25_000 })).toString("utf8"));
        if (snapshot.nodes.length > 0) {
          this.#displays.set(serial, snapshot.display);
          return snapshot;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    throw lastError instanceof Error ? lastError : new Error("uiautomator returned an empty hierarchy; the screen may be secure or mid-transition. Retry in a second.");
  }

  async openStream(serial: string, options: VideoStreamOptions, handlers: VideoStreamHandlers): Promise<VideoStream> {
    const toolchain = this.#deps.toolchain();
    const { scrcpyServer } = toolchain;
    if (scrcpyServer === null) fail("missing_scrcpy", `live video needs scrcpy-server (not found). ${fixFor(toolchain, "scrcpy-server")}`);
    return openVideoSession({ adb: this.#adb(), serverPath: scrcpyServer, log: this.#deps.log }, serial, options, handlers);
  }
}

/** The AVD directory, by the SDK's own rule: ANDROID_AVD_HOME, ANDROID_USER_HOME/avd, then ~/.android/avd. */
function avdHome(): string {
  const env = process.env;
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
  if (env.ANDROID_USER_HOME) return join(env.ANDROID_USER_HOME, "avd");
  return join(homedir(), ".android", "avd");
}

/** A small text file, or null when it cannot be read (no such file is the ordinary case). */
function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The end of a log file (at most 64 KiB), or null when it cannot be read. */
function readLogTail(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, 64 * 1024);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
