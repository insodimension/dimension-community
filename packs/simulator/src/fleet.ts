// The fleet: which virtual devices THIS pack booted, and the rules that keep
// them from outliving their use.
//
//   ownership   Only a device the pack booted is ever stopped by it, and "booted" means
//               a PROCESS: the record is {pid, startedAt} (plus the serial it answers
//               to, for display), and stop acts on that process tree after checking the
//               pid still started when the pack spawned it. A serial alone never stops
//               anything: serials are reused, and an emulator the person started
//               (Android Studio, a terminal) once got stopped by one. Such a device
//               is theirs: stop is refused, idle shutdown skips it, exit leaves it.
//   duplicates  `boot` asks every running emulator which AVD it is, and returns the one
//               that already runs the AVD (recorded as not owned) instead of starting a
//               second. A second instance takes an explicit `readOnly`.
//   cap         At most `simulator.maxDevices` booted at once.
//   idle        An owned device with no viewer and no tool call for
//               `simulator.idleMinutes` is stopped. One timer per device, set and
//               reset by events (a tool call, a viewer coming or going): nothing polls.
//   orphans     The ownership record is a file, so a crashed pack's emulators are
//               found again at the next start. A record is adopted only when its pid is
//               still running AND started when the record says, and its previous owner
//               is dead: never from `adb devices` alone, so an emulator the person
//               started since is never mistaken for ours.
//   exit        `shutdown()` stops what the pack booted.

import { parseJsonBytes, readDurableFileSync, writeFileAtomicSync } from "../../../lib/durable-file.mjs";
import type { BootHandle, BootObserver, DeviceBackend, StopOptions, StopOutcome } from "./backend";
import { type BootRequest, type DeviceInfo, fail } from "./contracts";
import type { SimulatorSettings } from "./settings";

export interface OwnedRecord {
  /** The serial the emulator answers to, once its console was matched to `pid`; null while it boots. Shown and used to reach the device; never what the pack stops. */
  readonly serial: string | null;
  readonly avd: string;
  /** The emulator process the pack spawned and when it started (epoch ms): together, the only handle anything is stopped by. */
  readonly pid: number;
  readonly startedAt: number;
  readonly bootedAt: number;
  /** The pack process that booted (or adopted) it. */
  readonly ownerPid: number;
  readonly ownerStartedAt: number;
}

export interface OwnershipStore {
  read(): OwnedRecord[];
  write(records: readonly OwnedRecord[]): void;
}

export function fileOwnershipStore(path: string): OwnershipStore {
  return {
    read: () =>
      (readDurableFileSync(path, parseRecordList) ?? []).filter(
        (entry): entry is OwnedRecord =>
          typeof entry === "object" &&
          entry !== null &&
          (entry.serial === null || typeof entry.serial === "string") &&
          typeof entry.avd === "string" &&
          isEmulatorPid(entry.pid) &&
          Number.isFinite(entry.startedAt) &&
          Number.isFinite(entry.bootedAt) &&
          Number.isSafeInteger(entry.ownerPid) &&
          (entry.ownerPid as number) > 0 &&
          Number.isFinite(entry.ownerStartedAt),
      ),
    write: records => writeFileAtomicSync(path, JSON.stringify(records, null, 2), { backup: { parse: parseRecordList } }),
  };
}

function parseRecordList(bytes: Buffer): Array<{ readonly [field in keyof OwnedRecord]?: unknown } | null> {
  const parsed = parseJsonBytes(bytes);
  if (!Array.isArray(parsed)) throw new Error("the ownership record is not a list");
  return parsed;
}

export interface Timer {
  cancel(): void;
}

export interface FleetDeps {
  readonly backend: DeviceBackend;
  readonly settings: () => SimulatorSettings;
  readonly store: OwnershipStore;
  readonly log: (message: string) => void;
  readonly now?: () => number;
  readonly pid?: number;
  readonly ownerStartedAt?: number;
  readonly isAlive?: (pid: number) => boolean;
  readonly schedule?: (run: () => void, ms: number) => Timer;
}

export interface BootOutcome {
  readonly avd: string;
  /** The device. null only while it is still starting and its console has not been matched to the process yet: there is no serial to name. */
  readonly device: DeviceInfo | null;
  /** True while the device is still starting; call device_boot again to wait for it. */
  readonly pending: boolean;
  /** True when an already-running device was returned instead of booting another. */
  readonly reused: boolean;
  /** What the person or agent should be told about this boot (software graphics fallback, a read-only instance, a flag that was not applied). */
  readonly notes: readonly string[];
}

const defaultSchedule = (run: () => void, ms: number): Timer => {
  const handle = setTimeout(run, ms);
  handle.unref();
  return { cancel: () => clearTimeout(handle) };
};

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, we may not signal it.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A boot that failed after the call waiting for it had returned is told to the next call for that AVD, once; after this long it is stale news. */
const FAILURE_MEMORY_MS = 10 * 60_000;

/** A read-only instance is a different boot from the AVD's own. */
const bootKey = (avd: string, readOnly: boolean): string => (readOnly ? `${avd}#read-only` : avd);

interface Boot {
  readonly key: string;
  readonly avd: string;
  readonly notes: string[];
  readonly settled: Promise<DeviceInfo>;
}

type Decision = { readonly running: DeviceInfo } | { readonly boot: Boot };

const SHUTDOWN_GRACE_MS = 3_000;
const SHUTDOWN_KILL_FOLLOW_UP_MS = 3_000;

function isEmulatorPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid;
}

export class Fleet {
  readonly #deps: FleetDeps;
  readonly #pid: number;
  /** By an id of the pack's own (a boot's serial and pid are both unknown or change while it starts). */
  readonly #owned = new Map<string, OwnedRecord>();
  readonly #idle = new Map<string, Timer>();
  readonly #viewers = new Map<string, number>();
  readonly #booting = new Map<string, Boot>();
  readonly #failures = new Map<string, { readonly error: Error; readonly at: number }>();
  /** Boots the pack itself stopped: their end is not a failure to report. */
  readonly #stopped = new Set<string>();
  #starting = 0;
  #seq = 0;
  #reconciled: Promise<void> | null = null;
  readonly #deciding = new Map<string, Promise<void>>();
  readonly #owners = new Map<string, boolean>();
  readonly #proving = new Set<string>();
  readonly #ownerStartedAt: number;

  constructor(deps: FleetDeps) {
    this.#deps = deps;
    this.#pid = deps.pid ?? process.pid;
    this.#ownerStartedAt = deps.ownerStartedAt ?? Math.round(Date.now() - process.uptime() * 1000);
  }

  owned(): readonly OwnedRecord[] {
    return [...this.#owned.values()];
  }

  isOwned(serial: string): boolean {
    return this.#keyOf(serial) !== undefined;
  }

  #keyOf(serial: string): string | undefined {
    for (const [key, record] of this.#owned) if (record.serial === serial) return key;
    return undefined;
  }

  /** Adopt what a dead pack left running. Once per process, lazily, before anything that depends on ownership. */
  reconcile(): Promise<void> {
    this.#reconciled ??= this.#adoptOrphans();
    return this.#reconciled;
  }

  async #adoptOrphans(): Promise<void> {
    const backend = this.#deps.backend;
    const records = this.#deps.store.read();
    let changed = false;
    for (const record of records) {
      if (record.ownerPid !== this.#pid && (await this.#ownerRunning(record))) continue;
      changed = true;
      const proc = { pid: record.pid, startedAt: record.startedAt };
      const state = await backend.processState(proc, record.avd).catch(() => "unknown" as const);
      if (state !== "ours") {
        this.#deps.log(`[sim] dropped ownership record for ${record.serial ?? record.avd} (${record.avd}, pid ${record.pid}): ${state === "unknown" ? "the process table or its command line could not be read, so it cannot be verified" : state === "reused" ? "that pid is not the emulator the record names (another start time, or another program)" : "that process is gone"}`);
        continue;
      }
      let serial = await backend.serialOf(proc).catch(() => null);
      if (serial === null && record.serial !== null) {
        const running = await backend.runningEmulators().catch(() => []);
        if (running.some(emulator => emulator.serial === record.serial && emulator.avd === record.avd)) serial = record.serial;
      }
      if (serial === null) {
        this.#deps.log(`[sim] stopping unfinished boot of ${record.avd} (pid ${record.pid}) left by pack process ${record.ownerPid}`);
        await backend.stop(proc, null, { avd: record.avd }).catch(error => this.#deps.log(`[sim] could not stop it: ${error instanceof Error ? error.message : String(error)}`));
        continue;
      }
      const key = `pid-${record.pid}`;
      this.#owned.set(key, { ...record, serial, ownerPid: this.#pid, ownerStartedAt: this.#ownerStartedAt });
      this.#deps.log(`[sim] adopted orphan ${serial} (${record.avd}, pid ${record.pid}) left by pack process ${record.ownerPid}`);
      this.#schedule(key);
    }
    if (changed) this.#persist();
  }

  async #ownerRunning(record: OwnedRecord): Promise<boolean> {
    const alive = this.#deps.isAlive ?? processAlive;
    let running = alive(record.ownerPid);
    if (running) {
      const state = await this.#deps.backend.processState({ pid: record.ownerPid, startedAt: record.ownerStartedAt }).catch(() => "unknown" as const);
      running = state === "ours" || state === "unknown";
    }
    this.#owners.set(`${record.ownerPid}@${record.ownerStartedAt}`, running);
    return running;
  }

  #siblingRunning(record: OwnedRecord): boolean {
    if (!(this.#deps.isAlive ?? processAlive)(record.ownerPid)) return false;
    const key = `${record.ownerPid}@${record.ownerStartedAt}`;
    const known = this.#owners.get(key);
    if (known === false) return false;
    if (!this.#proving.has(key)) {
      this.#proving.add(key);
      void this.#ownerRunning(record)
        .then(running => {
          if (!running) this.#persist();
        })
        .catch(error => this.#deps.log(`[sim] could not rewrite the ownership file: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => this.#proving.delete(key));
    }
    return true;
  }

  /** This pack's records, plus those of OTHER pack processes that are still running. A dead owner's record was adopted (then it is ours) or dropped by `reconcile`: it is never carried forward. */
  #persist(): void {
    const mine = [...this.#owned.values()];
    const others = this.#deps.store.read().filter(record => record.ownerPid !== this.#pid && this.#siblingRunning(record) && !mine.some(own => own.pid === record.pid && own.startedAt === record.startedAt));
    this.#deps.store.write([...others, ...mine]);
  }

  async boot(request: BootRequest, waitMs: number): Promise<BootOutcome> {
    await this.reconcile();
    const backend = this.#deps.backend;
    const avds = await backend.avds();
    const avd = request.avd ?? (avds.length === 1 ? avds[0] : undefined);
    if (avd === undefined) {
      if (avds.length === 0) fail("no_avd", "there is no AVD to boot. Create one in Android Studio -> Device Manager (or `avdmanager create avd`), then call device_boot again.");
      fail("avd_required", `several AVDs exist; pass avd. Available: ${avds.join(", ")}`);
    }
    const readOnly = request.readOnly === true;
    const key = bootKey(avd, readOnly);

    for (let gate = this.#deciding.get(key); gate !== undefined; gate = this.#deciding.get(key)) await gate;
    const pending = this.#booting.get(key);
    if (pending) return this.#await(pending, waitMs, true);

    const decision = Promise.withResolvers<void>();
    this.#deciding.set(key, decision.promise);
    let decided: Decision;
    try {
      decided = await this.#decide(avd, key, request, readOnly);
    } finally {
      this.#deciding.delete(key);
      decision.resolve();
    }
    if ("running" in decided) return this.#reuse(decided.running, avd, request, waitMs);
    return this.#await(decided.boot, waitMs, false);
  }

  async #decide(avd: string, key: string, request: BootRequest, readOnly: boolean): Promise<Decision> {
    const failed = this.#takeFailure(avd);
    if (failed !== null) throw failed;

    if (!readOnly) {
      const running = await this.#findRunning(avd);
      if (running !== null) return { running };
    }

    const cap = this.#deps.settings().maxDevices;
    if (this.#owned.size + this.#starting >= cap) {
      const names = [...this.#owned.values()].map(record => `${record.serial ?? "(starting)"} (${record.avd})`).join(", ");
      fail("device_cap", `this pack already booted ${this.#owned.size + this.#starting} emulator(s) (cap ${cap}, setting simulator.maxDevices): ${names}. Stop one with device_stop, or raise the cap.`);
    }

    const id = `boot-${++this.#seq}`;
    const notes: string[] = [];
    if (readOnly) notes.push(`Started read-only (-read-only): this is a second instance of ${avd}, and what it changes is discarded when it stops.`);
    const observer: BootObserver = {
      spawned: proc => {
        this.#owned.set(id, { serial: null, avd, pid: proc.pid, startedAt: proc.startedAt, bootedAt: this.#owned.get(id)?.bootedAt ?? (this.#deps.now ?? Date.now)(), ownerPid: this.#pid, ownerStartedAt: this.#ownerStartedAt });
        this.#persist();
      },
      serial: serial => {
        const record = this.#owned.get(id);
        if (record === undefined) return;
        this.#owned.set(id, { ...record, serial });
        this.#persist();
      },
      note: message => {
        notes.push(message);
        this.#deps.log(`[sim] ${avd}: ${message}`);
      },
    };

    this.#starting++;
    let handle: BootHandle;
    try {
      handle = await this.#deps.backend.startBoot({ ...request, avd }, observer);
    } finally {
      this.#starting--;
    }
    const settled = handle.ready.then(
      device => {
        if (this.#booting.get(key) === boot) this.#booting.delete(key);
        this.#deps.log(`[sim] ${device.serial} (${avd}) is up`);
        this.#schedule(id);
        return device;
      },
      (error: unknown) => {
        if (this.#booting.get(key) === boot) this.#booting.delete(key);
        this.#release(id);
        this.#deps.log(`[sim] boot of ${avd} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!this.#stopped.delete(id)) this.#failures.set(avd, { error: error instanceof Error ? error : new Error(String(error)), at: (this.#deps.now ?? Date.now)() });
        throw error;
      },
    );
    settled.catch(() => undefined);
    const boot: Boot = { key: id, avd, notes, settled };
    this.#booting.set(key, boot);
    return { boot };
  }

  /** A boot that failed after the call waiting for it had returned: the next call for that AVD is told, once, rather than silently starting another. */
  #takeFailure(avd: string): Error | null {
    const entry = this.#failures.get(avd);
    if (entry === undefined) return null;
    this.#failures.delete(avd);
    if ((this.#deps.now ?? Date.now)() - entry.at > FAILURE_MEMORY_MS) return null;
    return new Error(`The boot of ${avd} that the earlier device_boot was waiting for failed after that call returned. ${entry.error.message}`);
  }

  /**
   * The emulator that already runs `avd`, whoever started it, or null. Every running emulator is asked which
   * AVD it is (its console answers while Android is still starting; the device list's name needs Android up),
   * and either source is enough to refuse a second instance, which the emulator itself would reject anyway.
   */
  async #findRunning(avd: string): Promise<DeviceInfo | null> {
    const backend = this.#deps.backend;
    const [asked, listed] = await Promise.all([backend.runningEmulators().catch(() => []), backend.list()]);
    const serials = new Set(asked.filter(emulator => emulator.avd === avd).map(emulator => emulator.serial));
    for (const device of listed) if (device.kind === "emulator" && device.name === avd) serials.add(device.serial);
    const matches = listed.filter(device => serials.has(device.serial));
    return matches.find(device => device.state === "online") ?? matches[0] ?? null;
  }

  async #reuse(found: DeviceInfo, avd: string, request: BootRequest, waitMs: number): Promise<BootOutcome> {
    const backend = this.#deps.backend;
    this.touch(found.serial);
    const notes = [`${found.serial} already runs ${avd}${this.isOwned(found.serial) ? "" : " (not started by this pack)"}: it is returned, not booted again. Pass readOnly: true for a second instance.`];
    if (request.cold === true || request.headless !== undefined) notes.push("cold and headless were not applied: the device was already running.");
    const up = found.state === "online" ? found : waitMs > 0 ? await backend.waitBooted(found.serial, waitMs) : null;
    const device: DeviceInfo = up === null ? { ...found, state: "booting" } : up;
    return { avd, device: { ...device, owned: this.isOwned(device.serial) }, pending: up === null, reused: true, notes };
  }

  async #await(boot: Boot, waitMs: number, reused: boolean): Promise<BootOutcome> {
    const timeout = Promise.withResolvers<null>();
    const timer = setTimeout(() => timeout.resolve(null), waitMs);
    try {
      const device = await Promise.race([boot.settled, timeout.promise]);
      if (device !== null) return { avd: boot.avd, device: { ...device, owned: this.isOwned(device.serial) }, pending: false, reused, notes: [...boot.notes] };
    } catch (error) {
      // This caller is the one being told: it is not news for the next one.
      this.#failures.delete(boot.avd);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const serial = this.#owned.get(boot.key)?.serial ?? null;
    const placeholder: DeviceInfo | null = serial === null ? null : { serial, platform: "android", kind: "emulator", state: "booting", name: boot.avd, androidVersion: null, display: null, density: null, owned: true, live: false, viewers: 0 };
    return { avd: boot.avd, device: placeholder, pending: true, reused, notes: [...boot.notes] };
  }

  /** Stop an emulator THIS pack booted: by the process it spawned, after checking it still is that process. */
  async stop(serial: string): Promise<StopOutcome> {
    await this.reconcile();
    const key = this.#keyOf(serial);
    if (key === undefined) {
      fail("not_owned", `${serial} was not booted by this pack, so the pack will not stop it. Close it yourself (its window, or \`adb -s ${serial} emu kill\`).`);
    }
    return this.#stopOwned(key);
  }

  async #stopOwned(key: string, hurry: Omit<StopOptions, "avd"> = {}): Promise<StopOutcome> {
    const record = this.#owned.get(key);
    if (record === undefined) return "already-exited";
    const name = record.serial ?? record.avd;
    this.#deps.log(`[sim] stopping ${name} (pid ${record.pid})`);
    if (this.#isBooting(key)) this.#stopped.add(key);
    let outcome: StopOutcome;
    try {
      outcome = await this.#deps.backend.stop({ pid: record.pid, startedAt: record.startedAt }, record.serial, { avd: record.avd, ...hurry });
    } catch (error) {
      this.#stopped.delete(key);
      throw error;
    }
    this.#release(key);
    this.#deps.log(outcome === "stopped" ? `[sim] stopped ${name}` : `[sim] ${name} had already exited; nothing was killed`);
    return outcome;
  }

  #isBooting(key: string): boolean {
    return [...this.#booting.values()].some(boot => boot.key === key);
  }

  #release(key: string): void {
    this.#idle.get(key)?.cancel();
    this.#idle.delete(key);
    const record = this.#owned.get(key);
    if (record?.serial) this.#viewers.delete(record.serial);
    if (this.#owned.delete(key)) this.#persist();
  }

  /** A tool call, or anything else that shows the device is in use. */
  touch(serial: string): void {
    const key = this.#keyOf(serial);
    if (key !== undefined) this.#schedule(key);
  }

  /** A viewer attached or left. With none, the idle clock runs; with one, it does not. */
  setViewers(serial: string, count: number): void {
    this.#viewers.set(serial, count);
    const key = this.#keyOf(serial);
    if (key !== undefined) this.#schedule(key);
  }

  #schedule(key: string): void {
    this.#idle.get(key)?.cancel();
    this.#idle.delete(key);
    const record = this.#owned.get(key);
    if (record === undefined) return;
    if (this.#isBooting(key)) return;
    if (record.serial !== null && (this.#viewers.get(record.serial) ?? 0) > 0) return;
    const minutes = this.#deps.settings().idleMinutes;
    const timer = (this.#deps.schedule ?? defaultSchedule)(() => {
      const name = this.#owned.get(key)?.serial ?? record.avd;
      this.#deps.log(`[sim] idle-stop ${name}: no viewer and no tool call for ${minutes} min`);
      void this.#stopOwned(key).catch(error => this.#deps.log(`[sim] idle-stop of ${name} failed: ${error instanceof Error ? error.message : String(error)}`));
    }, minutes * 60_000);
    this.#idle.set(key, timer);
  }

  /** Pack exit: stop everything this pack booted. Bounded: a hung emulator must not hold the process. */
  async shutdown(budgetMs = 10_000): Promise<void> {
    for (const timer of this.#idle.values()) timer.cancel();
    this.#idle.clear();
    const keys = [...this.#owned.keys()];
    if (keys.length === 0) return;
    this.#deps.log(`[sim] shutdown: stopping ${keys.map(key => this.#owned.get(key)?.serial ?? this.#owned.get(key)?.avd ?? key).join(", ")}`);
    const killNow = new AbortController();
    const stopped = Promise.allSettled(keys.map(key => this.#stopOwned(key, { graceMs: SHUTDOWN_GRACE_MS, killNow: killNow.signal })));
    const overBudget = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => overBudget.resolve(true), budgetMs);
    const late = await Promise.race([stopped.then(() => false), overBudget.promise]);
    clearTimeout(timer);
    if (!late) return;
    this.#deps.log(`[sim] shutdown: ${budgetMs} ms passed with emulators still stopping; killing what is left`);
    killNow.abort();
    const followUp = Promise.withResolvers<void>();
    const followUpTimer = setTimeout(() => followUp.resolve(), SHUTDOWN_KILL_FOLLOW_UP_MS);
    await Promise.race([stopped, followUp.promise]);
    clearTimeout(followUpTimer);
  }
}
