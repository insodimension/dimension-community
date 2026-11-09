// Shapes shared by the backend, the fleet, the relay and the MCP server.

import type { Size } from "./shared/pointer";

export type DevicePlatform = "android";
export type DeviceKind = "emulator" | "physical";
export type DeviceState = "online" | "booting" | "offline" | "unauthorized";

export interface DeviceInfo {
  readonly serial: string;
  readonly platform: DevicePlatform;
  readonly kind: DeviceKind;
  readonly state: DeviceState;
  /** The AVD name for an emulator, the model for a physical device. */
  readonly name: string;
  readonly androidVersion: string | null;
  /** Physical display in pixels: what tap/swipe/ui-tree coordinates are in. */
  readonly display: Size | null;
  readonly density: number | null;
  /** True when THIS pack booted it (only those are ever stopped by the pack). */
  readonly owned: boolean;
  /** An H.264 encoder is running for it (a viewer is attached). */
  readonly live: boolean;
  readonly viewers: number;
}

export interface BootRequest {
  readonly avd?: string;
  readonly headless?: boolean;
  /** Ignore any saved snapshot and boot from scratch. */
  readonly cold?: boolean;
  /** A SECOND instance of an AVD that already runs: the emulator's own `-read-only` (the emulator itself advises it). Its changes are discarded when it stops. */
  readonly readOnly?: boolean;
}

export interface Screenshot {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** image px / device px: a point (x, y) in the image is (x / scale, y / scale) on the device. */
  readonly scale: number;
  readonly display: Size;
}

export interface UiNode {
  readonly index: number;
  readonly depth: number;
  readonly text: string;
  readonly desc: string;
  readonly id: string;
  readonly cls: string;
  readonly pkg: string;
  readonly bounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
  readonly clickable: boolean;
  readonly longClickable: boolean;
  readonly enabled: boolean;
  readonly focusable: boolean;
  readonly scrollable: boolean;
  readonly checked: boolean;
  readonly selected: boolean;
  readonly password: boolean;
}

export interface UiSnapshot {
  readonly display: Size;
  /** The foreground app's package, when the dump names one. */
  readonly package: string | null;
  readonly nodes: readonly UiNode[];
}

export type KeyName = "home" | "back" | "recents" | "power" | "volumeUp" | "volumeDown" | "enter" | "delete" | "tab" | "escape" | "menu";

export type PacketKind = "config" | "key" | "delta";

/** One H.264 access unit (Annex-B) from a device's encoder: SPS/PPS, a key frame, or a delta. Platform-neutral. */
export interface VideoPacket {
  readonly kind: PacketKind;
  readonly data: Buffer;
}

/** A refusal that names its fix. The message is what the model / the human reads, verbatim. */
export class SimulatorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SimulatorError";
    this.code = code;
  }
}

export function fail(code: string, message: string): never {
  throw new SimulatorError(code, message);
}
