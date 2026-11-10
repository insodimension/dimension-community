/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the pane puts the person's own
 *  phone in front of them as a device to drive. The View lists EMULATORS only,
 *  unless the person turned "Show physical devices" on, and even then a phone
 *  is shown only when they picked it: never as "the first device".
 */
import { describe, expect, test } from "bun:test";
import { deriveScreen, deviceControls, keepFrozen, type ListState, markFact, markupKeysLive, pickerOptions, type Selection, type StreamStatus, statusLine, usableDevices } from "../src/view/view-model";
import { emulatorDevice, PHONE_SERIAL, phoneDevice } from "./fake-backend";

const NOTHING_PICKED: Selection = { serial: null, booting: null, notes: [] };

function list(devices: ListState["devices"], avds: ListState["avds"] = []): ListState {
  return { devices, avds, toolchain: { adb: "/sdk/platform-tools/adb", emulator: "/sdk/emulator/emulator", scrcpyServer: "/tools/scrcpy-server", missing: [] }, live: true };
}

describe("which devices the pane may offer", () => {
  const devices = [phoneDevice(), emulatorDevice("emulator-5554", "Pixel_8")];
  const rows = [
    { showPhysical: false, listed: ["emulator-5554"] },
    { showPhysical: true, listed: [PHONE_SERIAL, "emulator-5554"] },
  ];
  for (const row of rows) {
    test(`Show physical devices ${row.showPhysical ? "on" : "off"}: ${row.listed.length === 1 ? "emulators only" : "the phone too"}`, () => {
      const usable = usableDevices(list(devices), row.showPhysical);
      expect(usable.map(device => device.serial).sort()).toEqual([...row.listed].sort());
    });
  }

  test("an emulator adb calls offline is one still starting: shown. An offline or unauthorized phone is not", () => {
    const offline = [emulatorDevice("emulator-5554", "Pixel_8", { state: "offline" }), phoneDevice({ state: "offline" }), phoneDevice({ serial: "ZX1", state: "unauthorized" })];
    expect(usableDevices(list(offline), true).map(device => device.serial)).toEqual(["emulator-5554"]);
  });
});

describe("which screen the pane shows", () => {
  test("a phone that is the only device is not 'the first device': the pane shows no device and says a phone is attached but not offered", () => {
    const screen = deriveScreen(list([phoneDevice()]), NOTHING_PICKED, null, false);
    expect(screen).toMatchObject({ kind: "no-device", hiddenPhones: 1, listedPhones: 0 });
  });

  test("with Show physical devices on, a phone is offered in the picker but still not chosen for the person", () => {
    const screen = deriveScreen(list([phoneDevice()]), NOTHING_PICKED, null, true);
    expect(screen).toMatchObject({ kind: "no-device", hiddenPhones: 0, listedPhones: 1 });
  });

  test("a phone the person picked, with Show physical devices on, is shown", () => {
    const screen = deriveScreen(list([phoneDevice()]), { ...NOTHING_PICKED, serial: PHONE_SERIAL }, null, true);
    expect(screen).toMatchObject({ kind: "device", device: { serial: PHONE_SERIAL } });
  });

  test("a phone picked earlier is dropped as soon as Show physical devices goes off", () => {
    const picked = { ...NOTHING_PICKED, serial: PHONE_SERIAL };
    expect(deriveScreen(list([phoneDevice()]), picked, null, false).kind).toBe("no-device");
  });

  test("beside an emulator, the default device is the emulator, even with a phone listed first", () => {
    const screen = deriveScreen(list([phoneDevice(), emulatorDevice("emulator-5554", "Pixel_8")]), NOTHING_PICKED, null, true);
    expect(screen).toMatchObject({ kind: "device", device: { serial: "emulator-5554" } });
  });

  test("a device that is still starting is a boot, not an empty pane", () => {
    const screen = deriveScreen(list([emulatorDevice("emulator-5554", "Pixel_8", { state: "booting" })]), NOTHING_PICKED, null, false);
    expect(screen).toMatchObject({ kind: "booting", avd: "Pixel_8" });
  });

  test("a boot the person started from the pane carries what the boot said about itself", () => {
    const screen = deriveScreen(list([]), { serial: null, booting: "Pixel_8", notes: ["Fell back to software graphics"] }, null, false);
    expect(screen).toEqual({ kind: "booting", avd: "Pixel_8", notes: ["Fell back to software graphics"] });
  });

  test("no adb is its own screen, ahead of everything else", () => {
    const noAdb: ListState = { ...list([emulatorDevice("emulator-5554", "Pixel_8")]), toolchain: { adb: null, emulator: null, scrcpyServer: null, missing: [{ tool: "adb", needed: "everything", fix: "Install platform-tools." }] } };
    expect(deriveScreen(noAdb, NOTHING_PICKED, null, false)).toMatchObject({ kind: "missing-adb" });
  });
});

describe("the device picker", () => {
  const devices = [emulatorDevice("emulator-5554", "Pixel_8"), phoneDevice()];
  const avds = [
    { name: "Pixel_8", running: true },
    { name: "Pixel_6", running: false },
  ];

  test("with the phone hidden, the picker offers running emulators, then AVDs to boot", () => {
    const options = pickerOptions(list(devices, avds), false);
    expect(options.map(option => [option.group, option.value])).toEqual([
      ["running", "serial:emulator-5554"],
      ["boot", "avd:Pixel_6"],
    ]);
  });

  test("with Show physical devices on, the phone is listed between them, in its own group", () => {
    const options = pickerOptions(list(devices, avds), true);
    expect(options.map(option => option.group)).toEqual(["running", "physical", "boot"]);
    expect(options[1]?.value).toBe(`serial:${PHONE_SERIAL}`);
  });

  test("no AVD is offered for booting when the emulator binary is missing", () => {
    const noEmulator: ListState = { ...list(devices, avds), toolchain: { adb: "/sdk/adb", emulator: null, scrcpyServer: null, missing: [] } };
    expect(pickerOptions(noEmulator, false).map(option => option.group)).toEqual(["running"]);
  });
});

describe("the toolbar's device controls", () => {
  const avds = [{ name: "Pixel_6", running: false }];
  const screenOf = (devices: ListState["devices"]) => deriveScreen(list(devices, avds), NOTHING_PICKED, null, false);

  test("Stop is armed only for a device this pack booted; any other is left running and the button says why", () => {
    const mine = [emulatorDevice("emulator-5554", "Pixel_8", { owned: true })];
    const yours = [emulatorDevice("emulator-5554", "Pixel_8", { owned: false })];
    expect(deviceControls(screenOf(mine), list(mine, avds), null, false, false).stop).toMatchObject({ serial: "emulator-5554", disabled: false });
    const refused = deviceControls(screenOf(yours), list(yours, avds), null, false, false).stop;
    expect(refused).toMatchObject({ serial: null, disabled: true });
    expect(refused.label).toContain("left running");
  });

  test("Boot is armed only once an AVD that is not running is picked", () => {
    const devices = [emulatorDevice("emulator-5554", "Pixel_8")];
    expect(deviceControls(screenOf(devices), list(devices, avds), null, false, false).boot.disabled).toBe(true);
    expect(deviceControls(screenOf(devices), list(devices, avds), "Pixel_6", false, false).boot).toMatchObject({ avd: "Pixel_6", disabled: false });
  });

  test("while a boot or stop is under way, every device control is held", () => {
    const devices = [emulatorDevice("emulator-5554", "Pixel_8", { owned: true })];
    const held = deviceControls(screenOf(devices), list(devices, avds), "Pixel_6", true, false);
    expect([held.pickerDisabled, held.boot.disabled, held.stop.disabled, held.refreshDisabled, held.physical.disabled]).toEqual([true, true, true, true, true]);
  });
});

describe("the status the toolbar shows", () => {
  const live = (mode: StreamStatus["mode"]): StreamStatus => ({ phase: "live", mode, fallbackReason: mode === "shot" ? "no scrcpy-server" : null, fps: 3, latencyMs: null, detail: null });

  test("still pictures are never called Live, and say why in the tooltip", () => {
    const shot = statusLine(live("shot"));
    expect(shot?.text).not.toContain("Live");
    expect(shot).toMatchObject({ tone: "warn", title: "no scrcpy-server" });
    expect(statusLine(live("h264"))?.tone).toBe("live");
  });
});

describe("marking up the screen", () => {
  test("putting the tool down with no marks goes back to live; with marks the frozen frame is kept for them", () => {
    expect(keepFrozen(null, 0)).toBe(false);
    expect(keepFrozen(null, 2)).toBe(true);
    expect(keepFrozen("box", 0)).toBe(true);
  });

  test("a digit typed into the device is the device's: the drawing keys only work with a tool in hand or the toolbar focused", () => {
    expect(markupKeysLive(null, false, false)).toBe(false);
    expect(markupKeysLive(null, true, false)).toBe(true);
    expect(markupKeysLive("pen", false, false)).toBe(true);
    expect(markupKeysLive("pen", true, true)).toBe(false);
  });

  test("a mark is told in the device's own pixels, with the display turned when the frame is landscape", () => {
    const display = { width: 1080, height: 2400 };
    expect(markFact({ kind: "pin", at: { x: 0.5, y: 0.25 } }, display, { width: 540, height: 1200 })).toContain("(540, 600)");
    expect(markFact({ kind: "pin", at: { x: 0.5, y: 0.25 } }, display, { width: 1200, height: 540 })).toContain("(1200, 270)");
    expect(markFact({ kind: "pin", at: { x: 0.5, y: 0.5 } }, null, { width: 540, height: 1200 })).toBeNull();
  });
});
