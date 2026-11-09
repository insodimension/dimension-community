// What the pane shows, derived from facts. Pure: no DOM, no network. The pane's
// states are listed once here so "what does a person with no adb see?" has one
// answer, written next to the others.

import type { MarkShape, MarkTool } from "@dimension/mcp-app-kit/annotate";
import type { DeviceInfo } from "../contracts";
import type { Size } from "../shared/pointer";

export interface MissingTool {
  readonly tool: string;
  readonly needed: string;
  readonly fix: string;
}

export interface ListState {
  readonly devices: readonly DeviceInfo[];
  readonly avds: readonly { readonly name: string; readonly running: boolean }[];
  readonly toolchain: { readonly adb: string | null; readonly emulator: string | null; readonly scrcpyServer: string | null; readonly missing: readonly MissingTool[] };
  readonly live: boolean;
}

export type Screen =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "missing-adb"; readonly missing: readonly MissingTool[] }
  /** `hiddenPhones`: attached phones the pane is not listing (emulators only, unless the person asks). `listedPhones`: phones in the picker that nobody picked. */
  | { readonly kind: "no-device"; readonly avds: readonly string[]; readonly missing: readonly MissingTool[]; readonly hiddenPhones: number; readonly listedPhones: number }
  /** `notes`: what the boot said about itself (fell back to software graphics, ...). */
  | { readonly kind: "booting"; readonly avd: string; readonly notes: readonly string[] }
  /** `bootNotes`: what the boot that produced this device said about itself (software graphics fallback, an already-running device, ...). */
  | { readonly kind: "device"; readonly device: DeviceInfo; readonly notes: readonly MissingTool[]; readonly bootNotes: readonly string[] };

export interface Selection {
  /** A running device's serial, or null for "the first one". */
  readonly serial: string | null;
  /** An AVD being booted from this pane. */
  readonly booting: string | null;
  /** What the boot in progress has said about itself; empty when none is. */
  readonly notes: readonly string[];
}

/**
 * Online or starting devices the pane may offer: every emulator, and a physical
 * phone only while the person asked to see phones.
 * An emulator adb lists as `offline` is one that is still starting (it has a console
 * before adb has a transport): it is shown as booting, not as "no device".
 */
export function usableDevices(list: ListState, showPhysical: boolean): DeviceInfo[] {
  return list.devices.filter(device => (device.state === "online" || device.state === "booting" || (device.state === "offline" && device.kind === "emulator")) && (device.kind === "emulator" || showPhysical));
}

export function deriveScreen(list: ListState | null, selection: Selection, failure: string | null, showPhysical: boolean): Screen {
  if (failure !== null && list === null) return { kind: "unavailable", reason: failure };
  if (list === null) return { kind: "loading" };
  if (list.toolchain.adb === null) return { kind: "missing-adb", missing: list.toolchain.missing };
  if (selection.booting !== null) return { kind: "booting", avd: selection.booting, notes: selection.notes };
  const usable = usableDevices(list, showPhysical);
  // A phone is shown only when the person picked it: never as "the first device".
  const chosen = usable.find(device => device.serial === selection.serial) ?? usable.find(device => device.kind === "emulator");
  if (chosen === undefined) {
    const attachedPhones = list.devices.filter(device => device.kind === "physical" && (device.state === "online" || device.state === "booting")).length;
    const listedPhones = usable.length;
    return { kind: "no-device", avds: list.avds.filter(avd => !avd.running).map(avd => avd.name), missing: list.toolchain.missing.filter(missing => missing.tool !== "scrcpy-server"), hiddenPhones: attachedPhones - listedPhones, listedPhones };
  }
  if (chosen.state === "booting" || chosen.state === "offline") return { kind: "booting", avd: chosen.name, notes: [] };
  return { kind: "device", device: chosen, notes: list.toolchain.missing.filter(missing => missing.tool === "scrcpy-server"), bootNotes: chosen.serial === selection.serial ? selection.notes : [] };
}

/** How a device is doing, as the dot beside its name: up, still starting, or an AVD that is not running. */
export type DeviceDot = "online" | "starting" | "off";

export interface PickerOption {
  /** `serial:<serial>` for a running device, `avd:<name>` for one to boot. */
  readonly value: string;
  readonly name: string;
  readonly serial: string | null;
  readonly group: "running" | "physical" | "boot";
  readonly dot: DeviceDot;
}

function dotOf(device: DeviceInfo): DeviceDot {
  return device.state === "online" ? "online" : "starting";
}

/** Running emulators first; then phones (only when shown); then every AVD that is not running, to boot. */
export function pickerOptions(list: ListState, showPhysical: boolean): PickerOption[] {
  const usable = usableDevices(list, showPhysical);
  const listed = (group: "running" | "physical", kind: DeviceInfo["kind"]): PickerOption[] =>
    usable.filter(device => device.kind === kind).map(device => ({ value: `serial:${device.serial}`, name: device.name, serial: device.serial, group, dot: dotOf(device) }));
  const bootable = list.avds.filter(avd => !avd.running && list.toolchain.emulator !== null).map((avd): PickerOption => ({ value: `avd:${avd.name}`, name: avd.name, serial: null, group: "boot", dot: "off" }));
  return [...listed("running", "emulator"), ...listed("physical", "physical"), ...bootable];
}

export interface DeviceControls {
  /** What the device button names: the AVD picked to boot, the device on screen, the one booting, or nothing. */
  readonly current: { readonly value: string; readonly name: string; readonly serial: string | null; readonly dot: DeviceDot; readonly physical: boolean } | null;
  readonly options: readonly PickerOption[];
  readonly pickerDisabled: boolean;
  readonly boot: { readonly avd: string | null; readonly disabled: boolean; readonly label: string };
  /** `serial` is set only for a device this pack booted: nothing else is ever stopped from the pane. */
  readonly stop: { readonly serial: string | null; readonly disabled: boolean; readonly label: string };
  readonly refreshDisabled: boolean;
  readonly physical: { readonly on: boolean; readonly disabled: boolean; readonly label: string };
}

/** The device half of the toolbar. Every disabled control's label says why, because the label is its tooltip. */
export function deviceControls(screen: Screen, list: ListState | null, selectedAvd: string | null, busy: boolean, showPhysical: boolean): DeviceControls {
  const device = screen.kind === "device" ? screen.device : null;
  const current: DeviceControls["current"] =
    selectedAvd !== null
      ? { value: `avd:${selectedAvd}`, name: selectedAvd, serial: null, dot: "off", physical: false }
      : device !== null
        ? { value: `serial:${device.serial}`, name: device.name, serial: device.serial, dot: dotOf(device), physical: device.kind === "physical" }
        : screen.kind === "booting"
          ? { value: `avd:${screen.avd}`, name: screen.avd, serial: null, dot: "starting", physical: false }
          : null;
  const owned = device?.owned === true ? device.serial : null;
  return {
    current,
    options: list === null ? [] : pickerOptions(list, showPhysical),
    pickerDisabled: list === null || busy,
    boot: { avd: selectedAvd, disabled: busy || selectedAvd === null, label: selectedAvd === null ? "Boot: pick a device that is not running" : `Boot ${selectedAvd}` },
    stop: {
      serial: owned,
      disabled: busy || owned === null,
      label: device === null ? "Stop: no device is running" : owned === null ? `Stop: ${device.name} was not booted by the Simulator, so it is left running` : `Stop ${device.name}`,
    },
    refreshDisabled: busy,
    physical: {
      on: showPhysical,
      disabled: list === null || busy,
      label: showPhysical ? "Hide physical devices" : "Show physical devices",
    },
  };
}

export type StreamPhase = "connecting" | "live" | "reconnecting" | "ended";

export interface StreamStatus {
  readonly phase: StreamPhase;
  readonly mode: "h264" | "shot";
  /** Why it is not the live video the person expects ("Shot fallback"), or null. */
  readonly fallbackReason: string | null;
  readonly fps: number;
  readonly latencyMs: number | null;
  readonly detail: string | null;
}

export interface StatusLine {
  readonly text: string;
  /** `live` is the only accent; a degraded picture is `warn`, a stopped one `stop`. */
  readonly tone: "live" | "warn" | "stop" | "quiet";
  /** The why behind the words (a fallback's reason, a reconnect's cause): the tooltip. */
  readonly title: string;
}

/** The toolbar's one status: honest about what is on screen, never Live for still pictures. */
export function statusLine(status: StreamStatus | null): StatusLine | null {
  if (status === null) return null;
  const why = (text: string): string => status.fallbackReason ?? status.detail ?? text;
  switch (status.phase) {
    case "connecting":
      return { text: "Connecting…", tone: "quiet", title: why("Connecting to the device") };
    case "reconnecting":
      return { text: "Reconnecting…", tone: "warn", title: why("Reconnecting to the device") };
    case "ended":
      return { text: "Stopped", tone: "stop", title: why("The picture stopped") };
    case "live":
      if (status.mode === "shot") return { text: `Shot fallback · ${status.fps} fps`, tone: "warn", title: why("Still pictures, not video") };
      return { text: `Live H.264 · ${status.fps} fps${status.latencyMs === null ? "" : ` · ${status.latencyMs} ms`}`, tone: "live", title: why("Live video from the device") };
  }
}

// ── marking up the screen ─────────────────────────────────────────────

/**
 * A frozen frame lives while a tool is in hand or it carries marks. Putting the tool down with marks keeps the
 * frame and its marks (the pane goes live; picking a tool up shows them again) until Clear, undo or removal takes
 * the last mark; putting it down with none returns the frame, so the next tool freezes a fresh one.
 */
export function keepFrozen(tool: MarkTool | null, marks: number): boolean {
  return tool !== null || marks > 0;
}

/**
 * Whether the drawing keys (1-5, Ctrl+Z, Escape) are the markup's. While the device has the keyboard they are the
 * device's: a 1 typed into the emulator must reach it, not pick up the Pin. So only with a tool in hand or the
 * focus in the toolbar, and never while the device menu is open (its keys are its own).
 */
export function markupKeysLive(tool: MarkTool | null, barFocused: boolean, menuOpen: boolean): boolean {
  return !menuOpen && (tool !== null || barFocused);
}

/**
 * The device's own pixels for a frame of this size: what device_tap and device_swipe take. The display is reported
 * as the device stands upright; a rotated device sends a frame the other way round, so the display turns with it.
 */
export function deviceSpace(display: Size | null, frame: Size): Size | null {
  if (display === null || frame.width <= 0 || frame.height <= 0) return null;
  const turned = display.width > display.height !== frame.width > frame.height;
  return turned ? { width: display.height, height: display.width } : display;
}

/** One line about the frozen frame as a whole, so the agent knows which device and screen the marks are on. */
export function screenFact(device: DeviceInfo, frame: Size, at: string): string {
  const space = deviceSpace(device.display, frame);
  const what = device.kind === "physical" ? "physical Android phone" : "Android emulator";
  return [
    `A frame of the live screen of the ${what} ${device.name} (serial ${device.serial}${device.androidVersion === null ? "" : `, Android ${device.androidVersion}`}${space === null ? "" : `, ${space.width}×${space.height} px display`}), frozen at ${at}.`,
    "The marks point at what to change in the app on that screen; drive the device with the device_* tools on that serial.",
    space === null ? "" : "Each mark's facts give it in device pixels, which device_tap and device_swipe take.",
  ].filter(line => line !== "").join(" ");
}

/** Where a mark is on the device, in its own pixels; null when the display size is unknown. */
export function markFact(shape: MarkShape, display: Size | null, frame: Size): string | null {
  const space = deviceSpace(display, frame);
  if (space === null) return null;
  const px = (point: { readonly x: number; readonly y: number }): string => `(${Math.round(point.x * space.width)}, ${Math.round(point.y * space.height)})`;
  if (shape.kind === "pin") return `On the device at ${px(shape.at)} px.`;
  if (shape.kind === "arrow") return `On the device from ${px(shape.from)} to ${px(shape.to)} px.`;
  const points = shape.kind === "pen" ? shape.points : [shape.from, shape.to];
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return `On the device from ${px({ x: left, y: top })} to ${px({ x: right, y: bottom })} px, centre ${px({ x: (left + right) / 2, y: (top + bottom) / 2 })}.`;
}
