// A hand-written DeviceBackend: an in-memory phone and emulator world with no adb
// behind it. It records every call that ACTS on a device, so a test can say
// "nothing touched the phone" rather than "a mock was called with these args".

import type { BootHandle, BootObserver, DeviceBackend, OwnedProcess, ResolvedBoot, RunningEmulator, StopOptions, StopOutcome, VideoStream } from "../src/backend";
import { type DeviceInfo, fail, type KeyName, type Screenshot, type UiNode, type UiSnapshot } from "../src/contracts";
import type { Size } from "../src/shared/pointer";

export const PHONE_SERIAL = "QGL78HORAISCWGVS";

const SCREEN: Size = { width: 1080, height: 2400 };

export function emulatorDevice(serial: string, avd: string, over: Partial<DeviceInfo> = {}): DeviceInfo {
  return { serial, platform: "android", kind: "emulator", state: "online", name: avd, androidVersion: "14", display: SCREEN, density: 420, owned: false, live: false, viewers: 0, ...over };
}

export function phoneDevice(over: Partial<DeviceInfo> = {}): DeviceInfo {
  return { serial: PHONE_SERIAL, platform: "android", kind: "physical", state: "online", name: "IV2201", androidVersion: "14", display: SCREEN, density: 420, owned: false, live: false, viewers: 0, ...over };
}

/** A UI Automator node: a labelled control with sensible defaults. */
export function node(over: Partial<UiNode> & { index: number; bounds: UiNode["bounds"] }): UiNode {
  return { depth: 1, text: "", desc: "", id: "", cls: "android.widget.TextView", pkg: "com.example.app", clickable: false, longClickable: false, enabled: true, focusable: false, scrollable: false, checked: false, selected: false, password: false, ...over };
}

export function snapshot(nodes: readonly UiNode[], over: Partial<UiSnapshot> = {}): UiSnapshot {
  return { display: SCREEN, package: "com.example.app", nodes, ...over };
}

export interface FakeBoot {
  readonly request: ResolvedBoot;
  readonly observer: BootObserver;
  readonly process: OwnedProcess;
  readonly ready: PromiseWithResolvers<DeviceInfo>;
}

export class FakeBackend implements DeviceBackend {
  readonly platform = "android" as const;
  devices: DeviceInfo[] = [];
  avdNames: string[] = [];
  /** What each emulator's console says it is. Absent = the listed emulators' own names. */
  running: RunningEmulator[] | null = null;
  /** The screens `uiTree` shows, one per call; the last one stays. */
  screens: UiSnapshot[] = [snapshot([])];
  liveVideo = false;
  /** The host's process table, as the backend sees it. */
  tableReadable = true;
  /** pid -> start time and the console serial the process answers to. */
  readonly processes = new Map<number, { startedAt: number; serial: string | null; avd?: string }>();
  /** Every call that reads or drives a device, as "verb serial ...". */
  readonly acts: string[] = [];
  readonly boots: FakeBoot[] = [];
  readonly stops: { process: OwnedProcess; serial: string | null }[] = [];
  readonly stopOptions: (StopOptions | undefined)[] = [];
  readonly waitBootedCalls: string[] = [];
  waitBootedHold: Promise<void> | null = null;
  #nextPid = 4000;
  #uiReads = 0;

  async list(): Promise<DeviceInfo[]> {
    return [...this.devices];
  }

  async ensureConnected(serial: string): Promise<void> {
    if (!this.devices.some(candidate => candidate.serial === serial)) fail("not_connected", `${serial} is not connected. Run device_list to see what is, or device_boot to start an emulator.`);
  }

  async avds(): Promise<string[]> {
    return [...this.avdNames];
  }

  async startBoot(request: ResolvedBoot, observer: BootObserver): Promise<BootHandle> {
    if (!this.avdNames.includes(request.avd)) fail("unknown_avd", `no AVD named "${request.avd}"`);
    this.#nextPid += 4;
    const process: OwnedProcess = { pid: this.#nextPid, startedAt: Date.now() };
    this.processes.set(process.pid, { startedAt: process.startedAt, serial: null });
    const ready = Promise.withResolvers<DeviceInfo>();
    this.boots.push({ request, observer, process, ready });
    observer.spawned(process);
    return { avd: request.avd, ready: ready.promise };
  }

  async processState(process: OwnedProcess, avd?: string): Promise<"ours" | "gone" | "reused" | "unknown"> {
    if (!this.tableReadable) return "unknown";
    const entry = this.processes.get(process.pid);
    if (entry === undefined) return "gone";
    if (Math.abs(entry.startedAt - process.startedAt) > 5_000) return "reused";
    if (avd !== undefined && entry.avd !== undefined && entry.avd !== avd) return "reused";
    return "ours";
  }

  async serialOf(process: OwnedProcess): Promise<string | null> {
    return this.processes.get(process.pid)?.serial ?? null;
  }

  /** Like the real one: only a process that is verified ours is ended (which ends its boot too); anything else is left alone. */
  async stop(process: OwnedProcess, serial: string | null, options?: StopOptions): Promise<StopOutcome> {
    this.stops.push({ process, serial });
    this.stopOptions.push(options);
    const state = await this.processState(process, options?.avd);
    if (state === "unknown") fail("cannot_verify", "the process table cannot be read");
    if (state !== "ours") return "already-exited";
    this.processes.delete(process.pid);
    this.boots.find(boot => boot.process.pid === process.pid)?.ready.reject(new Error("the emulator exited before it finished booting."));
    return "stopped";
  }

  async runningEmulators(): Promise<RunningEmulator[]> {
    return this.running ?? this.devices.filter(device => device.kind === "emulator").map(device => ({ serial: device.serial, avd: device.name }));
  }

  async waitBooted(serial: string): Promise<DeviceInfo | null> {
    this.waitBootedCalls.push(serial);
    await this.waitBootedHold;
    return this.devices.find(device => device.serial === serial && device.state === "online") ?? null;
  }

  async screenshot(serial: string): Promise<Screenshot> {
    this.acts.push(`screenshot ${serial}`);
    return { png: Uint8Array.of(137, 80, 78, 71), width: 540, height: 1200, scale: 0.5, display: SCREEN };
  }

  async tap(serial: string, x: number, y: number): Promise<void> {
    this.acts.push(`tap ${serial} ${x},${y}`);
  }

  async swipe(serial: string, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    this.acts.push(`swipe ${serial} ${from.x},${from.y}->${to.x},${to.y}`);
  }

  async text(serial: string, text: string): Promise<void> {
    this.acts.push(`text ${serial} ${text}`);
  }

  async key(serial: string, key: KeyName): Promise<void> {
    this.acts.push(`key ${serial} ${key}`);
  }

  async openUrl(serial: string, url: string): Promise<void> {
    this.acts.push(`openUrl ${serial} ${url}`);
  }

  async install(serial: string, apkPath: string): Promise<string> {
    this.acts.push(`install ${serial} ${apkPath}`);
    return "Success";
  }

  async launch(serial: string, target: string): Promise<void> {
    this.acts.push(`launch ${serial} ${target}`);
  }

  async uiTree(serial: string): Promise<UiSnapshot> {
    this.acts.push(`uiTree ${serial}`);
    const screen = this.screens[Math.min(this.#uiReads++, this.screens.length - 1)];
    if (screen === undefined) throw new Error("no screen scripted");
    return screen;
  }

  async display(serial: string): Promise<Size> {
    this.acts.push(`display ${serial}`);
    return SCREEN;
  }

  async openStream(serial: string): Promise<VideoStream> {
    this.acts.push(`openStream ${serial}`);
    fail("no_live_video", "the fake has no encoder");
  }

  liveAvailable(): boolean {
    return this.liveVideo;
  }
}
