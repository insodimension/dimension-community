/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the pack's Android backend does
 *  something to a process or a device that is not its own. In the live run it
 *  (1) passed `-qemu -lowram` and the emulator refused to start, (2) forced
 *  `-port 5554`, and when its own boot failed it stopped the SERIAL
 *  emulator-5554, which was the person's, (3) waited 80+ s on an emulator hung on
 *  the host GPU, and (4) drove a USB phone as if it were an emulator.
 *
 *  Nothing here is a real emulator or device. The backend runs real `adb` and
 *  `emulator` executables (fake-tool/main.ts, built once, answering from a world
 *  the test writes and logging every call); the host's process table is a fake
 *  that records which pids the backend asked to kill; the clock jumps instead of
 *  waiting 80 s. Assertions are on what was launched, what was killed, and what
 *  adb was asked.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidBackend } from "../src/android/backend";
import type { DeviceInfo } from "../src/contracts";
import type { ProcessRow } from "../src/android/process-table";
import type { OwnedProcess } from "../src/backend";
import type { GpuMode } from "../src/settings";
import type { Toolchain } from "../src/toolchain";
import { buildFakeTools, type FakeDevice, FakeHost, type FakeTools, type FakeWorld, JumpClock, probeOutput, until } from "./fake-android-tools";

setDefaultTimeout(60_000);

const AVD = "SimTest_Pixel";
const PHONE = "QGL78HORAISCWGVS";
const PERSON_PID = 7001;

/** The person's own emulator, running something else, from long before the pack started anything. */
const PERSON: FakeDevice = { serial: "emulator-5554", state: "device", avd: "Person_AVD", probe: probeOutput({ avd: "Person_AVD", qemu: true, hardware: "ranchu" }) };
const PERSON_ROW: ProcessRow = { pid: PERSON_PID, ppid: 1, startedAtMs: Date.now() - 3_600_000, cpuSeconds: 400, rssBytes: 2_000_000_000 };

let tools: FakeTools;
let logDir: string;

beforeAll(async () => {
  tools = await buildFakeTools();
  logDir = mkdtempSync(join(tmpdir(), "sim-boot-logs-"));
});

afterAll(() => {
  for (const dir of [tools?.dir, logDir]) {
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // a fake emulator that has not exited yet still holds its folder; it ends itself shortly
    }
  }
});

interface Rig {
  readonly backend: AndroidBackend;
  readonly host: FakeHost;
  readonly clock: JumpClock;
  setGpu(gpu: GpuMode): void;
}

function rig(world: FakeWorld, gpu: GpuMode = "auto"): Rig {
  tools.setWorld(world);
  const host = new FakeHost();
  host.others = [PERSON_ROW];
  host.othersListening = [{ pid: PERSON_PID, port: 5554 }];
  const clock = new JumpClock();
  let chosen = gpu;
  const toolchain: Toolchain = { adb: tools.adb, emulator: tools.emulator, scrcpyServer: null, sdkRoot: null, missing: [], tried: { adb: [], emulator: [], "scrcpy-server": [] } };
  const backend = new AndroidBackend({ toolchain: () => toolchain, log: () => undefined, logDir, gpu: () => chosen, processes: host, now: clock.now, timing: { pollMs: 5, stallCheckMs: 5, stopGraceMs: 10 } });
  return { backend, host, clock, setGpu: next => void (chosen = next) };
}

type Settled = { readonly device: DeviceInfo } | { readonly error: Error };

function settle(ready: Promise<DeviceInfo>): Promise<Settled> {
  return ready.then(
    device => ({ device }),
    (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
  );
}

function failureOf(settled: Settled): Error {
  if ("device" in settled) throw new Error(`the boot succeeded: ${settled.device.serial}`);
  return settled.error;
}

function valueOf(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
}

function spawned(host: FakeHost, index: number): OwnedProcess {
  const process = host.spawned[index];
  if (process === undefined) throw new Error(`no emulator was spawned at index ${index}`);
  return process;
}

describe("booting: what the emulator is launched with", () => {
  test("the setting's GPU and the request's flags reach the process, as the emulator's own flags: no -qemu, no -port", async () => {
    const { backend, host, setGpu } = rig({ avds: [AVD], devices: [PERSON] }, "host");
    const first = await backend.startBoot({ avd: AVD, headless: true, cold: true }, host.observer);
    const firstEnd = settle(first.ready);
    await until(() => tools.launches().length === 1, "the first emulator launch");
    const [argv] = tools.launches();
    expect(valueOf(argv ?? [], "-avd")).toBe(AVD);
    expect(valueOf(argv ?? [], "-gpu")).toBe("host");
    expect(argv).toContain("-lowram");
    expect(argv).toContain("-no-window");
    expect(argv).toContain("-no-snapshot-load");
    expect(argv).not.toContain("-read-only");
    expect(argv).not.toContain("-qemu");
    expect(argv).not.toContain("-port");
    expect(await backend.stop(spawned(host, 0), null, { avd: AVD })).toBe("stopped");
    expect(failureOf(await firstEnd).message).toContain("exited");

    // The next boot reads the setting afresh; this one is windowed, warm, and a second instance of the AVD.
    setGpu("swiftshader_indirect");
    const second = await backend.startBoot({ avd: AVD, readOnly: true }, host.observer);
    const secondEnd = settle(second.ready);
    await until(() => tools.launches().length === 2, "the second emulator launch");
    const next = tools.launches()[1] ?? [];
    expect(valueOf(next, "-gpu")).toBe("swiftshader_indirect");
    expect(next).toContain("-read-only");
    expect(next).not.toContain("-no-window");
    expect(next).not.toContain("-no-snapshot-load");
    expect(next).not.toContain("-qemu");
    expect(next).not.toContain("-port");
    await backend.stop(spawned(host, 1), null, { avd: AVD });
    await secondEnd;
  });
});

describe("booting: a hung host GPU", () => {
  test("a stalled boot is killed by its own pid, relaunched ONCE with software graphics, and says so", async () => {
    const world: FakeWorld = {
      avds: [AVD],
      devices: [PERSON, { serial: "emulator-5556", state: "device", avd: AVD, afterLaunches: 2, probe: probeOutput({ avd: AVD, qemu: true, hardware: "ranchu" }) }],
    };
    const { backend, host, clock } = rig(world, "auto");
    // The measured hang: almost no CPU. The relaunch (index 1) is the one that answers on console 5556.
    host.cpuSeconds = () => 0.6;
    host.consolePorts = index => (index === 1 ? [5556, 5557] : []);
    const handle = await backend.startBoot({ avd: AVD }, host.observer);
    const end = settle(handle.ready);
    await until(() => tools.launches().length === 1, "the first launch");
    expect(valueOf(tools.launches()[0] ?? [], "-gpu")).toBe("auto");

    clock.jump(80_000);
    const settled = await end;

    // It booted, on the relaunch, as the emulator its own process tree listens for: not the person's 5554.
    expect("device" in settled ? settled.device : null).toMatchObject({ serial: "emulator-5556", kind: "emulator" });
    expect(host.serials).toEqual(["emulator-5556"]);
    expect(host.spawned).toHaveLength(2);
    expect(tools.launches()).toHaveLength(2);
    expect(valueOf(tools.launches()[1] ?? [], "-gpu")).toBe("swiftshader_indirect");
    // The hung tree, and only it, was killed; nobody was asked to close.
    expect(host.killed).toEqual([spawned(host, 0).pid]);
    expect(tools.killRequests()).toEqual([]);
    expect(host.notes).toHaveLength(1);
    expect(host.notes[0]).toContain("software graphics");
    expect(host.notes[0]).toContain("swiftshader_indirect");

    // Stopping it later closes THAT console, then ends THAT process: still not the person's emulator.
    expect(await backend.stop(spawned(host, 1), "emulator-5556", { avd: AVD })).toBe("stopped");
    expect(tools.killRequests()).toEqual(["emulator-5556"]);
    expect(host.killed).toEqual([spawned(host, 0).pid, spawned(host, 1).pid]);
    expect(host.killed).not.toContain(PERSON_PID);
  });

  test("a stall that persists on software graphics fails clearly and does not relaunch again", async () => {
    const { backend, host, clock } = rig({ avds: [AVD], devices: [PERSON] }, "swiftshader_indirect");
    host.cpuSeconds = () => 0.6;
    const handle = await backend.startBoot({ avd: AVD }, host.observer);
    const end = settle(handle.ready);
    await until(() => tools.launches().length === 1, "the launch");

    clock.jump(80_000);
    const error = failureOf(await end);

    expect(error.message).toContain("showed no sign of booting");
    expect(error.message).toContain("-gpu swiftshader_indirect");
    expect(error.message).toContain("0.6 s of CPU");
    expect(host.spawned).toHaveLength(1);
    expect(tools.launches()).toHaveLength(1);
    expect(host.killed).toEqual([spawned(host, 0).pid]);
    expect(host.notes).toEqual([]);
  });

  test("a busy slow boot is not stalled: it is left alone, however long it takes", async () => {
    const { backend, host, clock } = rig({ avds: [AVD], devices: [PERSON] }, "auto");
    host.cpuSeconds = () => 12;
    const handle = await backend.startBoot({ avd: AVD }, host.observer);
    const end = settle(handle.ready);
    await until(() => tools.launches().length === 1, "the launch");
    expect(host.processReads).toBe(0);

    clock.jump(80_000);
    // Several looks at the process table, every one of them a verdict of "busy".
    await until(() => host.processReads >= 3, "the stall checks");
    expect(host.spawned).toHaveLength(1);
    expect(host.killed).toEqual([]);

    expect(await backend.stop(spawned(host, 0), null, { avd: AVD })).toBe("stopped");
    await end;
  });

  test("a process table that cannot be read is never a reason to kill", async () => {
    const { backend, host, clock } = rig({ avds: [AVD], devices: [PERSON] }, "auto");
    host.tableReadable = false;
    const handle = await backend.startBoot({ avd: AVD }, host.observer);
    const end = settle(handle.ready);
    await until(() => tools.launches().length === 1, "the launch");

    clock.jump(80_000);
    await until(() => host.processReads >= 3, "the stall checks");
    expect(host.killed).toEqual([]);
    expect(host.spawned).toHaveLength(1);

    // The same unreadable table also means stop cannot prove the pid is ours... but the live handle does.
    expect(await backend.stop(spawned(host, 0), null, { avd: AVD })).toBe("stopped");
    await end;
  });
});

describe("booting: a boot that fails never reaches for somebody else's emulator", () => {
  test("a boot that never answers is stopped by its pid, not by the person's serial", async () => {
    const { backend, host, clock } = rig({ avds: [AVD], devices: [PERSON] }, "auto");
    host.cpuSeconds = () => 12;
    const handle = await backend.startBoot({ avd: AVD }, host.observer);
    const end = settle(handle.ready);
    await until(() => tools.launches().length === 1, "the launch");

    clock.jump(300_000);
    const error = failureOf(await end);

    expect(error.message).toContain("did not show up in adb");
    expect(error.message).toContain("the pack stopped it");
    // The person's emulator-5554 was there before and after: never the pack's, never asked to close, its process never killed.
    expect(host.killed).toEqual([spawned(host, 0).pid]);
    expect(host.killed).not.toContain(PERSON_PID);
    expect(tools.killRequests()).toEqual([]);
    expect(host.serials).toEqual([]);
  });

  test("an emulator that exits on its own leaves nothing to kill, and the failure ends with its own log", async () => {
    const world: FakeWorld = {
      avds: [AVD],
      devices: [PERSON],
      emulator: { output: "INFO    | starting\nERROR   | Running multiple emulators with the same AVD is an experimental feature.\n", exitCode: 1 },
    };
    const { backend, host } = rig(world, "auto");
    const handle = await backend.startBoot({ avd: AVD }, host.observer);
    const error = failureOf(await settle(handle.ready));

    expect(error.message).toContain("exited with code 1");
    expect(error.message).toContain("Running multiple emulators with the same AVD");
    expect(error.message).toContain("readOnly: true");
    expect(host.killed).toEqual([]);
    expect(tools.killRequests()).toEqual([]);
  });

  test("with the listener list available, a newcomer the spawned tree does not listen for is not adopted, even while its AVD matches", async () => {
    // Somebody else's emulator of the SAME AVD appears after the spawn; the pack's own process never opened a console.
    const lookalike: FakeDevice = { serial: "emulator-5556", state: "device", avd: AVD, afterLaunches: 1, probe: probeOutput({ avd: AVD, qemu: true, hardware: "ranchu" }) };
    const { backend, host, clock } = rig({ avds: [AVD], devices: [PERSON, lookalike] }, "auto");
    host.cpuSeconds = () => 12;
    const handle = await backend.startBoot({ avd: AVD }, host.observer);
    const end = settle(handle.ready);
    await until(() => tools.launches().length === 1, "the launch");
    await until(() => host.processReads >= 3, "the pack to look at the process table with the newcomer visible");
    expect(host.serials).toEqual([]);

    clock.jump(300_000);
    failureOf(await end);
    expect(host.killed).toEqual([spawned(host, 0).pid]);
    expect(tools.killRequests()).toEqual([]);
  });

  test("without a listener list, the one newcomer is adopted only after its console says it is this AVD", async () => {
    const other: FakeDevice = { serial: "emulator-5556", state: "device", avd: "Person_Other_AVD", afterLaunches: 1, probe: probeOutput({ avd: "Person_Other_AVD", qemu: true, hardware: "ranchu" }) };
    const { backend, host, clock } = rig({ avds: [AVD], devices: [PERSON, other] }, "auto");
    host.listenersReadable = false;
    host.cpuSeconds = () => 12;
    const handle = await backend.startBoot({ avd: AVD }, host.observer);
    const end = settle(handle.ready);
    await until(() => tools.calls().some(call => call.tool === "adb" && call.serial === "emulator-5556" && call.args[0] === "emu" && call.args[1] === "avd"), "the pack to ask the newcomer which AVD it is");
    expect(host.serials).toEqual([]);

    clock.jump(300_000);
    failureOf(await end);
    expect(host.killed).toEqual([spawned(host, 0).pid]);
    expect(tools.killRequests()).toEqual([]);
  });

  test("without a listener list, a newcomer that says it is this AVD is the pack's; stopping it then never asks a console to close", async () => {
    const ours: FakeDevice = { serial: "emulator-5556", state: "device", avd: AVD, afterLaunches: 1, probe: probeOutput({ avd: AVD, qemu: true, hardware: "ranchu" }) };
    const { backend, host } = rig({ avds: [AVD], devices: [PERSON, ours] }, "auto");
    host.listenersReadable = false;
    const handle = await backend.startBoot({ avd: AVD }, host.observer);
    const settled = await settle(handle.ready);
    expect("device" in settled ? settled.device.serial : null).toBe("emulator-5556");
    expect(host.serials).toEqual(["emulator-5556"]);

    // No listener list: the console cannot be tied to the process, so nothing is asked to close; the process is ended by pid.
    expect(await backend.stop(spawned(host, 0), "emulator-5556", { avd: AVD })).toBe("stopped");
    expect(tools.killRequests()).toEqual([]);
    expect(host.killed).toEqual([spawned(host, 0).pid]);
  });

  const lostAfterBoot: { name: string; mode: "fail" | "empty"; says: string }[] = [
    { name: "adb cannot answer the listing", mode: "fail", says: "adb could not list it" },
    { name: "adb no longer lists the device", mode: "empty", says: "is not listed by adb" },
  ];
  for (const row of lostAfterBoot) {
    test(`a boot that completes but ${row.name} is ended by its pid, and the failure says so`, async () => {
      const ours: FakeDevice = { serial: "emulator-5556", state: "device", avd: AVD, afterLaunches: 1, probe: probeOutput({ avd: AVD, qemu: true, hardware: "ranchu" }) };
      const { backend, host } = rig({ avds: [AVD], devices: [PERSON, ours], devicesAfterWait: row.mode });
      host.consolePorts = () => [5556, 5557];
      const handle = await backend.startBoot({ avd: AVD }, host.observer);
      const error = failureOf(await settle(handle.ready));

      expect(error.message).toContain("booted but");
      expect(error.message).toContain(row.says);
      expect(host.serials).toEqual(["emulator-5556"]);
      expect(host.killed).toEqual([spawned(host, 0).pid]);
      expect(tools.killRequests()).toEqual([]);
    });
  }
});

describe("stopping a process the pack remembers (an orphan adopted after a crash)", () => {
  /** A real, harmless, hidden process standing in for an emulator the pack once spawned. */
  const children: ChildProcess[] = [];

  async function standIn(host: FakeHost): Promise<{ child: ChildProcess; owned: OwnedProcess }> {
    const startedAt = Date.now();
    const child = spawn(tools.emulator, ["-avd", "Standin"], { stdio: "ignore", windowsHide: true });
    children.push(child);
    if (child.pid === undefined) throw new Error("the stand-in did not start");
    host.allowKill(child.pid);
    return { child, owned: { pid: child.pid, startedAt } };
  }

  afterAll(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  });

  function running(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null;
  }

  test("a process that is verified ours and answers on the recorded console: that console is asked to close, then the process is ended", async () => {
    const world: FakeWorld = { avds: [AVD], devices: [PERSON, { serial: "emulator-5556", state: "device", avd: AVD, probe: probeOutput({ avd: AVD, qemu: true, hardware: "ranchu" }) }] };
    const { backend, host } = rig(world);
    const { child, owned } = await standIn(host);
    host.others.push({ pid: owned.pid, ppid: 1, startedAtMs: owned.startedAt + 40, cpuSeconds: 30, rssBytes: 1_000_000, command: `"${tools.emulator}" -avd ${AVD}` });
    host.othersListening.push({ pid: owned.pid, port: 5556 });

    expect(await backend.stop(owned, "emulator-5556", { avd: AVD })).toBe("stopped");
    expect(tools.killRequests()).toEqual(["emulator-5556"]);
    expect(host.killed).toEqual([owned.pid]);
    await until(() => !running(child), "the process to end");
  });

  test("a recorded serial that is not that process's console is never asked to close: the process is still ended, by its pid", async () => {
    const { backend, host } = rig({ avds: [AVD], devices: [PERSON] });
    const { child, owned } = await standIn(host);
    host.others.push({ pid: owned.pid, ppid: 1, startedAtMs: owned.startedAt + 40, cpuSeconds: 30, rssBytes: 1_000_000, command: `"${tools.emulator}" -avd ${AVD}` });
    host.othersListening.push({ pid: owned.pid, port: 5556 });

    // The record says emulator-5554, but that console belongs to the person's tree.
    expect(await backend.stop(owned, "emulator-5554", { avd: AVD })).toBe("stopped");
    expect(tools.killRequests()).toEqual([]);
    expect(host.killed).toEqual([owned.pid]);
    await until(() => !running(child), "the process to end");
  });

  test("a pid that started hours after the record is another process now: nothing is killed and nobody is asked to close", async () => {
    const { backend, host } = rig({ avds: [AVD], devices: [PERSON] });
    const { child, owned } = await standIn(host);
    host.others.push({ pid: owned.pid, ppid: 1, startedAtMs: owned.startedAt + 3 * 3_600_000, cpuSeconds: 30, rssBytes: 1_000_000, command: `"${tools.emulator}" -avd ${AVD}` });
    host.othersListening.push({ pid: owned.pid, port: 5554 });

    expect(await backend.stop(owned, "emulator-5554", { avd: AVD })).toBe("already-exited");
    expect(host.killed).toEqual([]);
    expect(tools.killRequests()).toEqual([]);
    expect(running(child)).toBe(true);
    child.kill();
  });

  test("a pid that is not running is left alone", async () => {
    const { backend, host } = rig({ avds: [AVD], devices: [PERSON] });
    expect(await backend.stop({ pid: 2_000_000_011, startedAt: Date.now() }, "emulator-5556", { avd: AVD })).toBe("already-exited");
    expect(host.killed).toEqual([]);
    expect(tools.killRequests()).toEqual([]);
  });

  test("a process table that cannot be read stops nothing it cannot prove, and says why", async () => {
    const { backend, host } = rig({ avds: [AVD], devices: [PERSON] });
    const { child, owned } = await standIn(host);
    host.tableReadable = false;

    await expect(backend.stop(owned, "emulator-5556", { avd: AVD })).rejects.toMatchObject({ code: "cannot_verify" });
    expect(host.killed).toEqual([]);
    expect(running(child)).toBe(true);
    child.kill();
  });

  async function adopted(host: FakeHost, command: string | undefined): Promise<{ child: ChildProcess; owned: OwnedProcess }> {
    const stand = await standIn(host);
    host.others.push({ pid: stand.owned.pid, ppid: 1, startedAtMs: stand.owned.startedAt + 40, cpuSeconds: 30, rssBytes: 1_000_000, ...(command === undefined ? {} : { command }) });
    host.othersListening.push({ pid: stand.owned.pid, port: 5556 });
    return stand;
  }

  const WITH_CONSOLE: FakeWorld = { avds: [AVD], devices: [PERSON, { serial: "emulator-5556", state: "device", avd: AVD, probe: probeOutput({ avd: AVD, qemu: true, hardware: "ranchu" }) }] };

  test("told to kill now while it waits for the emulator to close itself, it stops waiting and ends the process", async () => {
    const { backend, host } = rig(WITH_CONSOLE);
    const { child, owned } = await adopted(host, `"${tools.emulator}" -avd ${AVD}`);
    const killNow = new AbortController();
    const stopping = backend.stop(owned, "emulator-5556", { avd: AVD, graceMs: 30_000, killNow: killNow.signal });
    await until(() => tools.killRequests().length === 1, "the console to be asked to close");
    expect(host.killed).toEqual([]);

    const told = Date.now();
    killNow.abort();
    expect(await stopping).toBe("stopped");
    expect(Date.now() - told).toBeLessThan(10_000);
    expect(host.killed).toEqual([owned.pid]);
    await until(() => !running(child), "the process to end");
  });

  const launches: { name: string; command: (emulator: string) => string | undefined; outcome: "stopped" | "already-exited" | "cannot_verify" }[] = [
    { name: "the emulator launch of that AVD", command: emulator => `"${emulator}" -avd ${AVD}`, outcome: "stopped" },
    { name: "the emulator launch of another AVD", command: emulator => `"${emulator}" -avd Someone_Elses_AVD`, outcome: "already-exited" },
    { name: "another program given the emulator's flags", command: () => `C:\\Windows\\System32\\notepad.exe -avd ${AVD}`, outcome: "already-exited" },
    { name: "unreadable (the host gave none)", command: () => undefined, outcome: "cannot_verify" },
  ];
  for (const row of launches) {
    test(`an adopted pid whose command line is ${row.name}: ${row.outcome}`, async () => {
      const { backend, host } = rig({ avds: [AVD], devices: [PERSON] });
      const { child, owned } = await adopted(host, row.command(tools.emulator));
      if (row.outcome === "cannot_verify") await expect(backend.stop(owned, null, { avd: AVD })).rejects.toMatchObject({ code: "cannot_verify" });
      else expect(await backend.stop(owned, null, { avd: AVD })).toBe(row.outcome);

      expect(host.killed).toEqual(row.outcome === "stopped" ? [owned.pid] : []);
      if (row.outcome === "stopped") {
        await until(() => !running(child), "the process to end");
      } else {
        expect(running(child)).toBe(true);
        child.kill();
      }
    });
  }

  test("a pid asked about with no AVD named (the pack that owned a record) is judged by its start time alone; with one, by its command line too", async () => {
    const { backend, host } = rig({ avds: [AVD], devices: [PERSON] });
    const owner = { pid: 7300, startedAt: Date.now() };
    host.others.push({ pid: owner.pid, ppid: 1, startedAtMs: owner.startedAt + 40, cpuSeconds: 1, rssBytes: 1_000_000, command: "bun C:\\inso\\simulator\\server.mjs" });

    expect(await backend.processState(owner)).toBe("ours");
    expect(await backend.processState(owner, AVD)).toBe("reused");
    expect(await backend.processState({ pid: owner.pid, startedAt: owner.startedAt - 3 * 3_600_000 })).toBe("reused");
  });

  test("a launch that exited is gone for good: a process that took its pid a moment later is not it, whatever the table shows", async () => {
    const world: FakeWorld = { avds: [AVD], devices: [PERSON], emulator: { output: "INFO    | starting\n", exitCode: 1 } };
    const { backend, host } = rig(world);
    const handle = await backend.startBoot({ avd: AVD }, host.observer);
    failureOf(await settle(handle.ready));
    const exited = spawned(host, 0);
    host.others.push({ pid: exited.pid, ppid: 1, startedAtMs: exited.startedAt + 100, cpuSeconds: 1, rssBytes: 1_000_000, command: `"${tools.emulator}" -avd ${AVD}` });

    expect(await backend.processState(exited, AVD)).toBe("gone");
    expect(await backend.stop(exited, null, { avd: AVD })).toBe("already-exited");
    expect(host.killed).toEqual([]);
  });
});

describe("which devices are phones", () => {
  const phoneProbe = probeOutput({ model: "IV2201", hardware: "qcom", characteristics: "default" });
  const world: FakeWorld = {
    avds: [AVD],
    devices: [
      { serial: PHONE, state: "device", model: "IV2201", probe: phoneProbe },
      PERSON,
      // A device whose properties cannot be read (the shell answers with an error).
      { serial: "ZX1PROBEFAIL", state: "device", model: "Mystery" },
      { serial: "UNAUTH0001", state: "unauthorized" },
      // An emulator reached over the network: only its own properties say what it is.
      { serial: "10.0.0.9:5555", state: "device", probe: probeOutput({ qemu: true, hardware: "ranchu", characteristics: "emulator" }) },
      { serial: "NETPHONE:5555", state: "device", probe: probeOutput({ hardware: "mt6893", characteristics: "default" }) },
    ],
  };

  test("the device list tells emulators from phones, and the owner's phone is never called an emulator", async () => {
    const { backend } = rig(world);
    const listed = await backend.list();
    expect(Object.fromEntries(listed.map(device => [device.serial, device.kind]))).toEqual({
      [PHONE]: "physical",
      "emulator-5554": "emulator",
      ZX1PROBEFAIL: "physical",
      UNAUTH0001: "physical",
      "10.0.0.9:5555": "emulator",
      "NETPHONE:5555": "physical",
    });
  });
});

describe("naming a device the pack acts on", () => {
  const world: FakeWorld = { avds: [AVD], devices: [{ serial: PHONE, state: "device", model: "IV2201", probe: probeOutput({ model: "IV2201", hardware: "qcom", characteristics: "default" }) }, PERSON] };

  test("an emulator by its serial needs no round trip to the device", async () => {
    const { backend } = rig(world);
    await backend.ensureConnected("emulator-5554");
    expect(tools.calls()).toEqual([]);
  });

  test("an attached phone is found in adb's own listing and nothing is run on it", async () => {
    const { backend } = rig(world);
    await backend.ensureConnected(PHONE);
    expect(tools.calls().filter(call => call.args[0] === "shell")).toEqual([]);
  });

  test("a serial that is not attached is reported as not connected", async () => {
    const { backend } = rig(world);
    await expect(backend.ensureConnected("NOT-ATTACHED")).rejects.toMatchObject({ code: "not_connected" });
  });
});

describe("launching an app", () => {
  const world: FakeWorld = { avds: [AVD], devices: [{ serial: "emulator-5556", state: "device", probe: probeOutput({}) }] };

  test("a component goes to the device's shell in single quotes, so the $ of a nested class is not expanded there", async () => {
    const { backend } = rig(world);
    await backend.launch("emulator-5556", "com.a/.Main$Inner");
    expect(tools.calls().filter(call => call.args[0] === "shell").map(call => call.args[1])).toEqual(["am start -n 'com.a/.Main$Inner'"]);
  });

  const refused: { name: string; target: string }[] = [
    { name: "a quote that would close the quoting", target: "com.a/.Main'$IFS'reboot" },
    { name: "a command substitution", target: "com.a/.Main$(reboot)" },
    { name: "a space", target: "com.a /.Main" },
  ];
  for (const row of refused) {
    test(`${row.name} is refused before the device is asked anything`, async () => {
      const { backend } = rig(world);
      await expect(backend.launch("emulator-5556", row.target)).rejects.toMatchObject({ code: "bad_package" });
      expect(tools.calls()).toEqual([]);
    });
  }
});
