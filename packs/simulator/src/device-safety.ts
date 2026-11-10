// Which device a call means. Pure: no adb, no settings file, no clock, so every
// branch is provable with plain objects.
//
// Why it exists: an agent asked to use an EMULATOR once drove the owner's real
// phone, because it was the only device `adb devices` listed and the skill said
// "leave serial out when exactly one device runs". Two rules close that:
//
//   1. Classification   `classifyDevice` says emulator or physical. Anything that
//                       cannot be shown to be an emulator is physical.
//   2. Default pick     With no `serial`, only an EMULATOR is chosen
//                       (`selectDefaultDevice`). A phone is never picked for you,
//                       not even when it is the only device.

import type { DeviceKind, DeviceState } from "./contracts";

/** What is known about a device when it must be classified. Every property is `null`/absent when it could not be read (offline, unauthorized, probe failed). */
export interface DeviceIdentity {
  /** The adb serial. The emulator names itself `emulator-<console port>`; a USB phone reports its hardware serial. */
  readonly serial: string;
  /** `getprop ro.kernel.qemu`: "1" on an emulator's kernel. */
  readonly kernelQemu?: string | null;
  /** `getprop ro.boot.qemu`: "1" on emulator images since Android 8. */
  readonly bootQemu?: string | null;
  /** `getprop ro.hardware`: "ranchu" or "goldfish" on Google's emulator. */
  readonly hardware?: string | null;
  /** `getprop ro.build.characteristics`: contains "emulator" on emulator images. */
  readonly characteristics?: string | null;
}

const EMULATOR_HARDWARE: Record<string, true> = { ranchu: true, goldfish: true };

/**
 * Emulator when the serial is `emulator-*`, or the device reports qemu: the
 * kernel/boot flag, the emulator's hardware name, or the "emulator" build
 * characteristic. Anything else, including a device whose properties could not
 * be read, is `physical`.
 */
export function classifyDevice(identity: DeviceIdentity): DeviceKind {
  if (identity.serial.startsWith("emulator-")) return "emulator";
  if (identity.kernelQemu?.trim() === "1" || identity.bootQemu?.trim() === "1") return "emulator";
  if (identity.hardware !== undefined && identity.hardware !== null && EMULATOR_HARDWARE[identity.hardware.trim().toLowerCase()] === true) return "emulator";
  if (identity.characteristics?.toLowerCase().split(",").some(part => part.trim() === "emulator")) return "emulator";
  return "physical";
}

export interface SelectableDevice {
  readonly serial: string;
  readonly name: string;
  readonly kind: DeviceKind;
  readonly state: DeviceState;
}

export type DefaultDevice =
  | { readonly ok: true; readonly serial: string }
  | { readonly ok: false; readonly code: "no_emulator" | "serial_required"; readonly message: string };

/**
 * The device a call that left `serial` out can only mean: the session's held
 * emulator, or the one running emulator. Physical devices are never candidates.
 */
export function selectDefaultDevice(devices: readonly SelectableDevice[], heldSerial: string | undefined): DefaultDevice {
  const emulators = devices.filter(device => device.kind === "emulator" && (device.state === "online" || device.state === "booting"));
  const chosen = emulators.find(device => device.serial === heldSerial) ?? (emulators.length === 1 ? emulators[0] : undefined);
  if (chosen !== undefined) return { ok: true, serial: chosen.serial };
  if (emulators.length === 0) {
    const phones = devices.filter(device => device.kind === "physical");
    const aside = phones.length === 0 ? "" : ` A physical phone is attached (${phones.map(device => device.serial).join(", ")}); it is the person's own device and is never picked for you.`;
    return { ok: false, code: "no_emulator", message: `no emulator is running. Call device_boot (device_list shows the AVDs you can boot), or start an emulator yourself.${aside}` };
  }
  return { ok: false, code: "serial_required", message: `several emulators are running; pass serial. Running: ${emulators.map(device => `${device.serial} (${device.name})`).join(", ")}` };
}
