/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: an agent asked to use an
 *  EMULATOR drives the owner's own phone. That happened once for real (the only
 *  adb device was a USB phone, IV2201, and the serial may be left out), so the
 *  rules here are the safety net: anything that cannot be shown to be an
 *  emulator is a phone, and a phone is never picked for you.
 */
import { describe, expect, test } from "bun:test";
import type { DeviceKind, DeviceState } from "../src/contracts";
import { classifyDevice, type SelectableDevice, selectDefaultDevice } from "../src/device-safety";

const PHONE = "QGL78HORAISCWGVS";

function selectable(serial: string, kind: DeviceKind, state: DeviceState = "online", name = serial): SelectableDevice {
  return { serial, name, kind, state };
}

describe("classifyDevice", () => {
  const rows: { name: string; identity: Parameters<typeof classifyDevice>[0]; kind: DeviceKind }[] = [
    { name: "an emulator names itself emulator-<port>", identity: { serial: "emulator-5554" }, kind: "emulator" },
    { name: "the owner's USB phone with the properties it really reports", identity: { serial: PHONE, kernelQemu: "", bootQemu: "", hardware: "qcom", characteristics: "default" }, kind: "physical" },
    { name: "a USB phone whose properties could not be read at all (offline, probe failed): fail safe", identity: { serial: PHONE }, kind: "physical" },
    { name: "a USB phone whose properties came back null", identity: { serial: PHONE, kernelQemu: null, bootQemu: null, hardware: null, characteristics: null }, kind: "physical" },
    { name: "a Wi-Fi attached emulator is shown by ro.kernel.qemu", identity: { serial: "192.168.1.20:5555", kernelQemu: "1" }, kind: "emulator" },
    { name: "an emulator image shows by ro.boot.qemu, with whitespace around it", identity: { serial: "192.168.1.20:5555", bootQemu: " 1\n" }, kind: "emulator" },
    { name: "the ranchu hardware name, in any case", identity: { serial: "10.0.0.2:5555", hardware: " Ranchu " }, kind: "emulator" },
    { name: "the goldfish hardware name", identity: { serial: "10.0.0.2:5555", hardware: "goldfish" }, kind: "emulator" },
    { name: "the emulator build characteristic, among others", identity: { serial: "10.0.0.2:5555", characteristics: "nosdcard, Emulator" }, kind: "emulator" },
    { name: "a characteristic that merely contains the word is not it", identity: { serial: PHONE, characteristics: "emulatorish,tablet" }, kind: "physical" },
    { name: "qemu flag 0 is not an emulator", identity: { serial: PHONE, kernelQemu: "0", bootQemu: "0" }, kind: "physical" },
    { name: "a serial that only starts like an emulator's is not one", identity: { serial: "my-emulator-5554", hardware: "qcom" }, kind: "physical" },
  ];
  for (const row of rows) {
    test(row.name, () => {
      expect(classifyDevice(row.identity)).toBe(row.kind);
    });
  }
});

describe("selectDefaultDevice: what a call that left serial out can mean", () => {
  test("the owner's phone as the ONLY adb device is not picked: this is the live-run incident", () => {
    const pick = selectDefaultDevice([selectable(PHONE, "physical", "online", "IV2201")], undefined);
    expect(pick.ok).toBe(false);
    if (pick.ok) return;
    expect(pick.code).toBe("no_emulator");
    // The refusal points the model at the way out, and tells it the phone is not the answer.
    expect(pick.message).toContain("device_boot");
    expect(pick.message).toContain(PHONE);
    expect(pick.message).toContain("never picked for you");
  });

  test("with an emulator and a phone, the emulator is the one", () => {
    const pick = selectDefaultDevice([selectable(PHONE, "physical"), selectable("emulator-5554", "emulator", "online", "Pixel_8")], undefined);
    expect(pick).toEqual({ ok: true, serial: "emulator-5554" });
  });

  test("a held phone is not honoured: the session's held device is chosen among emulators only", () => {
    const pick = selectDefaultDevice([selectable(PHONE, "physical"), selectable("emulator-5554", "emulator")], PHONE);
    expect(pick).toEqual({ ok: true, serial: "emulator-5554" });
  });

  test("two emulators and nothing held: the model must say which, with the choices", () => {
    const pick = selectDefaultDevice([selectable("emulator-5554", "emulator", "online", "Pixel_8"), selectable("emulator-5556", "emulator", "online", "Pixel_6")], undefined);
    expect(pick.ok).toBe(false);
    if (pick.ok) return;
    expect(pick.code).toBe("serial_required");
    expect(pick.message).toContain("emulator-5554 (Pixel_8)");
    expect(pick.message).toContain("emulator-5556 (Pixel_6)");
  });

  test("two emulators: the one the session holds wins", () => {
    const devices = [selectable("emulator-5554", "emulator"), selectable("emulator-5556", "emulator")];
    expect(selectDefaultDevice(devices, "emulator-5556")).toEqual({ ok: true, serial: "emulator-5556" });
  });

  test("a held emulator that is gone falls back to the one emulator that runs", () => {
    expect(selectDefaultDevice([selectable("emulator-5556", "emulator")], "emulator-5554")).toEqual({ ok: true, serial: "emulator-5556" });
  });

  test("an emulator that is offline or unauthorized is not a candidate; a booting one is", () => {
    expect(selectDefaultDevice([selectable("emulator-5554", "emulator", "offline")], undefined).ok).toBe(false);
    expect(selectDefaultDevice([selectable("emulator-5554", "emulator", "unauthorized")], undefined).ok).toBe(false);
    expect(selectDefaultDevice([selectable("emulator-5554", "emulator", "booting")], undefined)).toEqual({ ok: true, serial: "emulator-5554" });
  });

  test("no device at all says to boot one", () => {
    const pick = selectDefaultDevice([], undefined);
    expect(pick.ok).toBe(false);
    if (!pick.ok) expect(pick.code).toBe("no_emulator");
  });
});
