// THE seam between the pack and a platform.
//
// Everything above this file (the fleet, the frame relay, the MCP tools, the
// View) is platform-neutral: it speaks `DeviceBackend`. Everything below it is
// one platform's tools. Android ships (src/android). An iOS simulator is a
// macOS-host backend that implements this same interface with `xcrun simctl`; see
// the README for why it is not here.

import type { BootRequest, DeviceInfo, KeyName, Screenshot, UiSnapshot, VideoPacket } from "./contracts";
import type { Size } from "./shared/pointer";

export interface VideoStreamOptions {
  /** Longest edge of the encoded video, in pixels. */
  readonly maxSize: number;
  readonly maxFps: number;
  readonly bitRate: number;
}

export const DEFAULT_VIDEO_OPTIONS: VideoStreamOptions = { maxSize: 1280, maxFps: 30, bitRate: 4_000_000 };

export interface VideoStreamHandlers {
  session(size: Size): void;
  packet(packet: VideoPacket): void;
  closed(reason: string, deliberate: boolean): void;
}

/** A live encoder on one device, shared by every viewer of it. */
export interface VideoStream {
  readonly serial: string;
  size(): Size | null;
  requestKeyframe(): void;
  /** Touch at a normalized point; false when it could not be delivered. */
  touch(action: "down" | "move" | "up", nx: number, ny: number): boolean;
  key(key: KeyName): boolean;
  text(text: string): boolean;
  close(): Promise<void>;
}

/** A boot request whose AVD is decided: the fleet resolves "the only AVD" before it asks a backend to start anything. */
export type ResolvedBoot = BootRequest & { readonly avd: string };

/** A process the pack spawned, named the only way that survives a pid being reused: the pid AND when it started. */
export interface OwnedProcess {
  readonly pid: number;
  /** Epoch ms the process started (the pack's clock at spawn; the OS's start time must agree within a few seconds). */
  readonly startedAt: number;
}

/** What a boot tells the fleet while it runs, so the fleet records ownership BEFORE anything can fail. */
export interface BootObserver {
  /** The pack spawned the emulator process (again, after a graphics fallback). */
  spawned(process: OwnedProcess): void;
  /** The emulator's console was matched to that process: this is the serial it answers to. */
  serial(serial: string): void;
  /** Something the person or the agent should be told ("fell back to software graphics"). */
  note(message: string): void;
}

/** What booting hands back: the process is already spawned and reported to the observer; `ready` settles when the device is usable. */
export interface BootHandle {
  readonly avd: string;
  /** Resolves when the device accepts input; rejects with the reason it never will. A rejected boot has already stopped everything it spawned. */
  readonly ready: Promise<DeviceInfo>;
}

/** An emulator that is running, and which AVD it says it is (asked of its console, which answers while Android is still starting). */
export interface RunningEmulator {
  readonly serial: string;
  readonly avd: string;
}

export type StopOutcome = "stopped" | "already-exited";

export interface StopOptions {
  readonly avd: string;
  readonly graceMs?: number;
  readonly killNow?: AbortSignal;
}

export interface DeviceBackend {
  readonly platform: "android";

  list(): Promise<DeviceInfo[]>;
  ensureConnected(serial: string): Promise<void>;
  /** Bootable virtual devices (AVD names). */
  avds(): Promise<string[]>;
  /** Start a virtual device. Does not wait for it to finish booting: see `BootHandle.ready`. */
  startBoot(request: ResolvedBoot, observer: BootObserver): Promise<BootHandle>;
  /**
   * Shut down the emulator the pack spawned: act on `process` and nothing else. The serial is never what is
   * stopped; a process that is gone, or whose pid now belongs to something else, is left alone.
   */
  stop(process: OwnedProcess, serial: string | null, options: StopOptions): Promise<StopOutcome>;
  /** Is `process` still the process the pack spawned? The check before adopting an orphan or killing anything. */
  processState(process: OwnedProcess, avd?: string): Promise<"ours" | "gone" | "reused" | "unknown">;
  /** The serial the emulator under `process` answers to, by its console port; null when it has none yet or the host cannot say. */
  serialOf(process: OwnedProcess): Promise<string | null>;
  /** Every running emulator and the AVD it is, asked of each one. Includes emulators the pack did not start. */
  runningEmulators(): Promise<RunningEmulator[]>;
  /** Wait up to `timeoutMs` for `serial` to finish booting; null = still booting. */
  waitBooted(serial: string, timeoutMs: number): Promise<DeviceInfo | null>;

  screenshot(serial: string, maxEdge: number): Promise<Screenshot>;
  tap(serial: string, x: number, y: number): Promise<void>;
  swipe(serial: string, from: { x: number; y: number }, to: { x: number; y: number }, durationMs: number): Promise<void>;
  text(serial: string, text: string): Promise<void>;
  key(serial: string, key: KeyName): Promise<void>;
  openUrl(serial: string, url: string): Promise<void>;
  install(serial: string, apkPath: string): Promise<string>;
  launch(serial: string, target: string): Promise<void>;
  uiTree(serial: string): Promise<UiSnapshot>;
  /** The device's current display size (what tap/swipe coordinates are in). */
  display(serial: string): Promise<Size>;

  /** Start the shared H.264 encoder. Throws with the missing-prerequisite fix when it cannot. */
  openStream(serial: string, options: VideoStreamOptions, handlers: VideoStreamHandlers): Promise<VideoStream>;
  /** Whether Live video is possible at all on this machine (the encoder's prerequisites are present). */
  liveAvailable(): boolean;
}
