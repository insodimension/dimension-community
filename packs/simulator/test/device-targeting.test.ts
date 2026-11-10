import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { DeviceInfo } from "../src/contracts";
import { emulatorDevice, FakeBackend, node, PHONE_SERIAL, phoneDevice, snapshot } from "./fake-backend";
import { connectServer, type McpSession, type ServerFolder, serverFolder } from "./mcp-session";

let folder: ServerFolder;
const open: McpSession[] = [];

beforeAll(() => {
  folder = serverFolder();
});

afterAll(() => {
  folder.dispose();
});

afterEach(async () => {
  for (const session of open.splice(0)) await session.close();
});

async function connect(backend: FakeBackend): Promise<McpSession> {
  const session = await connectServer(folder, backend);
  open.push(session);
  return session;
}

function world(...devices: DeviceInfo[]): FakeBackend {
  const backend = new FakeBackend();
  backend.devices = devices;
  backend.screens = [snapshot([node({ index: 1, text: "Save", clickable: true, cls: "android.widget.Button", bounds: { left: 100, top: 1000, right: 980, bottom: 1160 } })])];
  return backend;
}

const DRIVING: { name: string; tool: string; args: Record<string, unknown>; acted: RegExp }[] = [
  { name: "screenshot", tool: "device_screenshot", args: {}, acted: /^screenshot / },
  { name: "tap at a point", tool: "device_tap", args: { x: 10, y: 20 }, acted: /^tap / },
  { name: "tap by label", tool: "device_tap", args: { label: "Save" }, acted: /^tap / },
  { name: "swipe", tool: "device_swipe", args: { x1: 1, y1: 2, x2: 3, y2: 4 }, acted: /^swipe / },
  { name: "type", tool: "device_type", args: { text: "hello" }, acted: /^text / },
  { name: "key", tool: "device_key", args: { key: "home" }, acted: /^key / },
  { name: "open url", tool: "device_open_url", args: { url: "https://example.com/" }, acted: /^openUrl / },
  { name: "install", tool: "device_install", args: { apk: "/tmp/app.apk" }, acted: /^install / },
  { name: "launch", tool: "device_launch", args: { package: "com.example.app" }, acted: /^launch / },
  { name: "ui tree", tool: "device_ui_tree", args: {}, acted: /^uiTree / },
];

describe("a physical phone, named by serial", () => {
  for (const tool of DRIVING) {
    test(`${tool.name}: acts on that phone`, async () => {
      const backend = world(phoneDevice());
      const session = await connect(backend);
      const answer = await session.call(tool.tool, { ...tool.args, serial: PHONE_SERIAL });
      expect(answer.isError).toBe(false);
      const acted = backend.acts.filter(act => tool.acted.test(act));
      expect(acted).toHaveLength(1);
      expect(acted[0]).toContain(PHONE_SERIAL);
    });
  }

  test("stop: the pack stops no phone: it did not boot it", async () => {
    const backend = world(phoneDevice());
    const session = await connect(backend);
    const answer = await session.call("device_stop", { serial: PHONE_SERIAL });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("was not booted by this pack");
    expect(backend.stops).toEqual([]);
  });

  test("open the pane: it opens on that phone", async () => {
    const session = await connect(world(phoneDevice()));
    const answer = await session.call("device_open", { serial: PHONE_SERIAL });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain(`The simulator pane is open on ${PHONE_SERIAL}.`);
  });

  test("a serial that is not attached is reported as not connected, not driven", async () => {
    const backend = world(emulatorDevice("emulator-5554", "Pixel_8"));
    const session = await connect(backend);
    const answer = await session.call("device_tap", { serial: PHONE_SERIAL, x: 1, y: 1 });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("not connected");
    expect(backend.acts).toEqual([]);
  });
});

describe("a call that leaves serial out", () => {
  for (const tool of DRIVING) {
    test(`${tool.name}: the owner's phone as the ONLY device is not picked`, async () => {
      const backend = world(phoneDevice());
      const session = await connect(backend);
      const answer = await session.call(tool.tool, { ...tool.args });
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain("no emulator is running");
      expect(answer.text).toContain("never picked for you");
      expect(backend.acts).toEqual([]);
    });

    test(`${tool.name}: with an emulator beside the phone it is the emulator that is driven, and only it`, async () => {
      const backend = world(phoneDevice(), emulatorDevice("emulator-5554", "Pixel_8"));
      const session = await connect(backend);
      const answer = await session.call(tool.tool, { ...tool.args });
      expect(answer.isError).toBe(false);
      expect(backend.acts.length).toBeGreaterThan(0);
      for (const act of backend.acts) {
        expect(act).toContain("emulator-5554");
        expect(act).not.toContain(PHONE_SERIAL);
      }
    });
  }

  test("two emulators and no serial: the model is asked to choose, and nothing is driven", async () => {
    const backend = world(emulatorDevice("emulator-5554", "Pixel_8"), emulatorDevice("emulator-5556", "Pixel_6"));
    const session = await connect(backend);
    const answer = await session.call("device_key", { key: "home" });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("several emulators are running; pass serial");
    expect(backend.acts).toEqual([]);
  });

  test("the pane does not select the phone either: it opens with no device chosen", async () => {
    const session = await connect(world(phoneDevice()));
    const answer = await session.call("device_open", {});
    expect(answer.isError).toBe(false);
    expect(answer.text.startsWith("The simulator pane is open; no device is selected.")).toBe(true);
  });
});
