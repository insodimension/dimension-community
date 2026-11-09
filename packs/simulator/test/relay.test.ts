import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import http from "node:http";
import { Duplex } from "node:stream";
import type { VideoStream, VideoStreamHandlers, VideoStreamOptions } from "../src/backend";
import type { Screenshot } from "../src/contracts";
import { FrameRelay, type RelayOptions } from "../src/relay/relay";
import { decodeFrame, FrameTag, type MediaFrame, type StreamMode } from "../src/shared/frame-protocol";
import { until } from "./fake-android-tools";
import { FakeBackend } from "./fake-backend";

const EMULATOR = "emulator-5554";
const NEVER_MS = 600_000;
const PATIENCE_MS = 5_000;
const CLIENT_KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const REFUSED_SOCKET_GONE_MS = 1_000;
const TIMING = { stopGraceMs: 25, tokenIdleMs: NEVER_MS } as const;

const STALE_CONFIG = Buffer.from([0, 0, 0, 1, 0x67, 0x11]);
const STALE_KEY = Buffer.from([0, 0, 0, 1, 0x65, 0x11]);
const FRESH_CONFIG = Buffer.from([0, 0, 0, 1, 0x67, 0x22]);
const FRESH_KEY = Buffer.from([0, 0, 0, 1, 0x65, 0x22]);

const within = (condition: () => boolean, what: string): Promise<void> => until(condition, what, PATIENCE_MS);

class FakeEncoder implements VideoStream {
  closes = 0;
  readonly keys: string[] = [];

  constructor(readonly serial: string) {}

  size(): { width: number; height: number } {
    return { width: 1080, height: 2400 };
  }

  requestKeyframe(): void {}

  touch(): boolean {
    return true;
  }

  key(key: string): boolean {
    this.keys.push(key);
    return true;
  }

  text(): boolean {
    return true;
  }

  async close(): Promise<void> {
    this.closes += 1;
  }
}

interface Start {
  readonly serial: string;
  readonly handlers: VideoStreamHandlers;
  readonly encoder: FakeEncoder;
  open(): void;
  fail(error: Error): void;
}

class LiveBackend extends FakeBackend {
  readonly starts: Start[] = [];
  readonly pendingShots: (() => void)[] = [];
  shotCalls = 0;
  autoShots = false;

  override liveAvailable(): boolean {
    return true;
  }

  override openStream(serial: string, _options: VideoStreamOptions, handlers: VideoStreamHandlers): Promise<VideoStream> {
    const encoder = new FakeEncoder(serial);
    const opening = Promise.withResolvers<VideoStream>();
    this.starts.push({ serial, handlers, encoder, open: () => opening.resolve(encoder), fail: error => opening.reject(error) });
    return opening.promise;
  }

  override async screenshot(serial: string): Promise<Screenshot> {
    this.shotCalls += 1;
    if (!this.autoShots) {
      const turn = Promise.withResolvers<void>();
      this.pendingShots.push(() => turn.resolve());
      await turn.promise;
    }
    return super.screenshot(serial);
  }

  releaseShots(): void {
    for (const release of this.pendingShots.splice(0)) release();
  }
}

interface Target {
  readonly url: string;
  readonly path?: string;
  readonly host?: string;
  readonly origin?: string;
  readonly version?: string;
  readonly head?: Buffer;
  readonly clientNeverCloses?: boolean;
}

class FakeServer extends EventEmitter {
  closed = false;

  constructor(readonly port: number) {
    super();
  }

  listen(_port: number, _host: string, listening: () => void): this {
    listening();
    return this;
  }

  address(): { port: number } {
    return { port: this.port };
  }

  close(): this {
    this.closed = true;
    return this;
  }

  closeAllConnections(): void {}
}

const servers = new Map<number, FakeServer>();
let nextPort = 41_000;

class ClientSocket extends Duplex {
  constructor(
    private readonly toClient: (chunk: Buffer) => void,
    private readonly closesWhenServerDoes: boolean,
  ) {
    super();
    this.resume();
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  override _read(): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    this.toClient(chunk);
    done();
  }

  override _final(done: () => void): void {
    if (this.closesWhenServerDoes) this.push(null);
    done();
  }
}

const opened: Wire[] = [];

class Wire {
  status = 0;
  closed = false;
  closeCode: number | null = null;
  readonly texts: string[] = [];
  readonly frames: MediaFrame[] = [];
  readonly socket: ClientSocket;
  readonly #headSeen = Promise.withResolvers<void>();
  #buffer: Buffer = Buffer.alloc(0);
  #headParsed = false;

  private constructor(clientNeverCloses: boolean) {
    this.socket = new ClientSocket(chunk => this.#feed(chunk), !clientNeverCloses);
    this.socket.on("close", () => {
      this.closed = true;
      this.#headSeen.resolve();
    });
  }

  static async open(target: Target): Promise<Wire> {
    const url = new URL(target.url);
    const wire = new Wire(target.clientNeverCloses === true);
    opened.push(wire);
    const server = servers.get(Number(url.port));
    if (server === undefined || server.closed) {
      wire.socket.destroy();
    } else {
      const headers: Record<string, string> = {
        host: target.host ?? url.host,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": CLIENT_KEY,
        "sec-websocket-version": target.version ?? "13",
      };
      if (target.origin !== undefined) headers.origin = target.origin;
      server.emit("upgrade", { url: target.path ?? url.pathname, method: "GET", headers }, wire.socket, target.head ?? Buffer.alloc(0));
    }
    await wire.#headSeen.promise;
    return wire;
  }

  get endedReason(): string | undefined {
    for (const text of this.texts) {
      const message = JSON.parse(text) as { t: string; reason?: string };
      if (message.t === "ended") return message.reason;
    }
    return undefined;
  }

  send(text: string): void {
    const body = Buffer.from(text);
    const mask = Buffer.from([7, 11, 13, 17]);
    const masked = Buffer.from(body.map((byte, index) => byte ^ (mask[index % 4] ?? 0)));
    this.socket.push(Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]));
  }

  close(): void {
    this.socket.destroy();
  }

  #feed(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (!this.#headParsed) {
      const end = this.#buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      this.status = Number(/^HTTP\/1\.1 (\d{3})/.exec(this.#buffer.toString("latin1", 0, end))?.[1] ?? 0);
      this.#buffer = this.#buffer.subarray(end + 4);
      this.#headParsed = true;
      this.#headSeen.resolve();
    }
    if (this.status === 101) this.#readFrames();
  }

  #readFrames(): void {
    for (;;) {
      if (this.#buffer.length < 2) return;
      const opcode = (this.#buffer[0] ?? 0) & 0x0f;
      let length = (this.#buffer[1] ?? 0) & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        length = Number(this.#buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.#buffer.length < offset + length) return;
      const payload = this.#buffer.subarray(offset, offset + length);
      this.#buffer = this.#buffer.subarray(offset + length);
      if (opcode === 0x1) this.texts.push(payload.toString("utf8"));
      else if (opcode === 0x2) {
        const frame = decodeFrame(Buffer.from(payload));
        if (frame !== null) this.frames.push(frame);
      } else if (opcode === 0x8 && payload.length >= 2) this.closeCode = payload.readUInt16BE(0);
    }
  }
}

interface Rig {
  readonly relay: FrameRelay;
  readonly backend: LiveBackend;
  readonly logs: string[];
  connect(serial: string, mode?: StreamMode): Promise<Wire>;
}

const relays: FrameRelay[] = [];
const backends: LiveBackend[] = [];

function rig(over: Partial<RelayOptions> = {}): Rig {
  const backend = new LiveBackend();
  const logs: string[] = [];
  const relay = new FrameRelay({
    backend,
    log: line => void logs.push(line),
    onViewers: () => undefined,
    onActivity: () => undefined,
    ensureConnected: async () => undefined,
    ...TIMING,
    ...over,
  });
  relays.push(relay);
  backends.push(backend);
  return {
    relay,
    backend,
    logs,
    connect: async (serial, mode = "h264") => {
      const grant = await relay.mint(serial, mode);
      return Wire.open({ url: grant.url });
    },
  };
}

beforeEach(() => {
  spyOn(http, "createServer").mockImplementation((() => {
    const server = new FakeServer(nextPort++);
    servers.set(server.port, server);
    return server;
  }) as unknown as typeof http.createServer);
});

afterEach(async () => {
  for (const wire of opened.splice(0)) wire.close();
  for (const backend of backends.splice(0)) {
    backend.autoShots = true;
    backend.releaseShots();
  }
  for (const relay of relays.splice(0)) await relay.close();
  mock.restore();
  servers.clear();
});

function stateOf(r: Rig, serial: string): string | undefined {
  return r.relay.snapshot().producers.find(producer => producer.serial === serial)?.state;
}

async function startAt(r: Rig, index: number): Promise<Start> {
  await within(() => r.backend.starts.length > index, `encoder start #${index + 1}`);
  const start = r.backend.starts[index];
  if (start === undefined) throw new Error(`no encoder start #${index + 1}`);
  return start;
}

async function liveEncoder(r: Rig, index: number): Promise<Start> {
  const start = await startAt(r, index);
  start.open();
  await within(() => stateOf(r, start.serial) === "live", `encoder #${index + 1} to go live`);
  return start;
}

async function replacedStart(r: Rig, options: { firstOpened: boolean }): Promise<{ stale: Start; current: Start; viewer: Wire }> {
  const first = await r.connect(EMULATOR);
  const stale = options.firstOpened ? await liveEncoder(r, 0) : await startAt(r, 0);
  first.close();
  if (options.firstOpened) await within(() => stale.encoder.closes === 1, "the first encoder to stop after its grace");
  else await within(() => stateOf(r, EMULATOR) === "idle", "the grace to end the first start");
  const viewer = await r.connect(EMULATOR);
  const current = await startAt(r, 1);
  return { stale, current, viewer };
}

describe("a stream token opens exactly one socket", () => {
  test("the same URL a second time is refused, while the first socket is up and after it has left", async () => {
    const r = rig();
    await r.connect(EMULATOR);
    const grant = await r.relay.mint(EMULATOR, "h264");

    const first = await Wire.open({ url: grant.url });
    expect(first.status).toBe(101);
    expect((await Wire.open({ url: grant.url })).status).toBe(404);

    first.close();
    await within(() => r.relay.viewerCount(EMULATOR) === 1, "the first socket to leave");
    expect((await Wire.open({ url: grant.url })).status).toBe(404);
  });

  test("once the last viewer has left the listener is gone, and a fresh token from the next device_stream connects", async () => {
    const r = rig();
    const first = await r.connect(EMULATOR);
    first.close();
    await within(() => !r.relay.snapshot().listening, "the listener to close");

    const again = await r.connect(EMULATOR);
    expect(again.status).toBe(101);
    await within(() => again.texts.length > 0, "the ready message");
    expect(JSON.parse(again.texts[0] ?? "{}")).toMatchObject({ t: "ready", serial: EMULATOR, mode: "h264" });
  });

  test("a token nobody connects with expires, and a late connect is refused while the listener still serves others", async () => {
    const r = rig({ tokenIdleMs: 150 });
    await r.connect(EMULATOR);
    const grant = await r.relay.mint(EMULATOR, "h264");
    await within(() => r.relay.snapshot().tokens === 0, "the unused token to expire");

    expect((await Wire.open({ url: grant.url })).status).toBe(404);
  });

  const REFUSALS: { name: string; target: Omit<Target, "url">; status: number }[] = [
    { name: "a web origin", target: { origin: "https://evil.example" }, status: 403 },
    { name: "a Host that is not the listener's", target: { host: "evil.example" }, status: 403 },
    { name: "a WebSocket version other than 13", target: { version: "8" }, status: 400 },
  ];

  for (const row of REFUSALS) {
    test(`${row.name} is refused ${row.status} and the token stays good for the real View`, async () => {
      const r = rig();
      const grant = await r.relay.mint(EMULATOR, "h264");

      expect((await Wire.open({ url: grant.url, ...row.target })).status).toBe(row.status);
      expect((await Wire.open({ url: grant.url })).status).toBe(101);
    });
  }

  test("the sandboxed View sends Origin: null and is let in", async () => {
    const r = rig();
    const grant = await r.relay.mint(EMULATOR, "h264");

    expect((await Wire.open({ url: grant.url, origin: "null" })).status).toBe(101);
  });
});

describe("a request target the pack cannot parse", () => {
  const TARGETS: { name: string; path: (token: string) => string }[] = [
    { name: "//", path: () => "//" },
    { name: "//[", path: () => "//[" },
    { name: "a token too short to be one", path: () => "/f/abc" },
    { name: "a real token with a path segment after it", path: token => `/f/${token}/extra` },
  ];

  for (const row of TARGETS) {
    test(`${row.name} is answered 404 before anything else, and the listener keeps serving the real token`, async () => {
      const r = rig();
      const grant = await r.relay.mint(EMULATOR, "h264");
      const token = new URL(grant.url).pathname.split("/").pop() ?? "";

      expect((await Wire.open({ url: grant.url, path: row.path(token) })).status).toBe(404);
      expect((await Wire.open({ url: grant.url })).status).toBe(101);
    });
  }

  test("a socket error after a refused upgrade is handled and tears the socket down: a reset peer cannot take the pack down", async () => {
    const r = rig();
    const grant = await r.relay.mint(EMULATOR, "h264");
    const refused = await Wire.open({ url: grant.url, host: "evil.example" });
    expect(refused.status).toBe(403);

    expect(() => refused.socket.emit("error", new Error("read ECONNRESET"))).not.toThrow();
    expect(refused.socket.destroyed).toBe(true);
  });

  const SILENT_CLIENT_REFUSALS: { name: string; target: Omit<Target, "url">; status: number }[] = [
    { name: "a Host that is not the listener's", target: { host: "evil.example" }, status: 403 },
    { name: "a token the pack never minted", target: { path: "/f/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, status: 404 },
  ];

  for (const row of SILENT_CLIENT_REFUSALS) {
    test(`${row.name} is refused ${row.status} and its socket is destroyed by the pack even though the client never closes its own side; the real token still gets in`, async () => {
      const r = rig();
      const grant = await r.relay.mint(EMULATOR, "h264");

      const refused = await Wire.open({ url: grant.url, clientNeverCloses: true, ...row.target });
      expect(refused.status).toBe(row.status);
      await until(() => refused.closed, "the pack to destroy the refused socket", REFUSED_SOCKET_GONE_MS);

      expect((await Wire.open({ url: grant.url })).status).toBe(101);
    });
  }

  test("a failure while a viewer is being set up costs that one socket, not the process, and the next viewer is served", async () => {
    let failuresLeft = 1;
    const r = rig({
      onViewers: () => {
        if (failuresLeft-- > 0) throw new Error("the fleet cannot be told");
      },
    });

    const doomed = await r.connect(EMULATOR);
    await within(() => doomed.closed, "the socket whose setup failed to be dropped");

    const next = await r.connect(EMULATOR);
    expect(next.status).toBe(101);
    await within(() => next.texts.length > 0, "the ready message");
  });

  test("an upgrade followed in the same segment by an unmasked frame is closed as a protocol error and attaches no viewer: no encoder starts for it, nothing is left listening, and the next View is served", async () => {
    const r = rig();
    const grant = await r.relay.mint(EMULATOR, "h264");
    const unmaskedTextFrame = Buffer.from([0x81, 0x01, 0x78]);

    const doomed = await Wire.open({ url: grant.url, head: unmaskedTextFrame });
    expect(doomed.status).toBe(101);
    expect(doomed.closeCode).toBe(1002);
    expect(r.backend.starts).toHaveLength(0);
    expect(r.relay.snapshot()).toEqual({ listening: false, tokens: 0, producers: [] });

    const next = await r.connect(EMULATOR);
    expect(next.status).toBe(101);
    await within(() => next.texts.length > 0, "the ready message");
    await startAt(r, 0);
    expect(r.backend.starts).toHaveLength(1);
    expect(r.relay.viewerCount(EMULATOR)).toBe(1);
  });
});

describe("the encoder start is tied to the session that asked for it", () => {
  test("a start that finishes after its viewer left is closed and never adopted over the newer start", async () => {
    const r = rig();
    const { stale, current, viewer } = await replacedStart(r, { firstOpened: false });

    stale.open();
    await within(() => stale.encoder.closes === 1, "the stale encoder to be closed");
    expect(stateOf(r, EMULATOR)).toBe("starting");

    current.open();
    await within(() => stateOf(r, EMULATOR) === "live", "the newer encoder to go live");
    expect(current.encoder.closes).toBe(0);
    expect(viewer.endedReason).toBeUndefined();

    viewer.close();
    await within(() => current.encoder.closes === 1, "the newer encoder to stop after its last viewer left");
    expect(stale.encoder.closes).toBe(1);
  });

  test("a replaced encoder's late packets and late close cannot reach the newer session", async () => {
    const r = rig();
    const { stale, current, viewer } = await replacedStart(r, { firstOpened: true });

    stale.handlers.closed("the encoder process exited", true);
    stale.handlers.packet({ kind: "config", data: STALE_CONFIG });
    stale.handlers.packet({ kind: "key", data: STALE_KEY });

    current.open();
    await within(() => stateOf(r, EMULATOR) === "live", "the newer encoder to go live");
    current.handlers.session({ width: 1080, height: 2400 });
    current.handlers.packet({ kind: "config", data: FRESH_CONFIG });
    current.handlers.packet({ kind: "key", data: FRESH_KEY });
    await within(() => viewer.frames.some(frame => frame.tag === FrameTag.Key), "the newer key frame");

    const received = (tag: FrameTag): string[] => viewer.frames.filter(frame => frame.tag === tag).map(frame => Buffer.from(frame.payload).toString("hex"));
    expect(received(FrameTag.Config)).toEqual([FRESH_CONFIG.toString("hex")]);
    expect(received(FrameTag.Key)).toEqual([FRESH_KEY.toString("hex")]);
    expect(current.encoder.closes).toBe(0);
    expect(viewer.endedReason).toBeUndefined();
  });

  test("a replaced start that fails late does not end the newer session's viewers", async () => {
    const r = rig();
    const { stale, current, viewer } = await replacedStart(r, { firstOpened: false });

    stale.fail(new Error("scrcpy-server died during the first start"));
    current.open();
    await within(() => stateOf(r, EMULATOR) === "live", "the newer encoder to go live");

    expect(viewer.endedReason).toBeUndefined();
    expect(viewer.closed).toBe(false);
  });

  test("a start that fails while it is current tells its viewers why, and the next viewer gets a new start", async () => {
    const r = rig();
    const pane = await r.connect(EMULATOR);
    const start = await startAt(r, 0);

    start.fail(new Error("scrcpy-server was not found"));
    await within(() => pane.closed, "the pane to be ended");

    expect(pane.endedReason).toBe("scrcpy-server was not found");
    await r.connect(EMULATOR);
    await startAt(r, 1);
  });

  test("an encoder that dies under a live viewer ends the pane with the reason, and the next viewer gets a new encoder", async () => {
    const r = rig();
    const pane = await r.connect(EMULATOR);
    const live = await liveEncoder(r, 0);

    live.handlers.closed("scrcpy exited with code 1", false);
    await within(() => pane.closed, "the pane to be ended");

    expect(pane.endedReason).toBe("scrcpy exited with code 1");
    await r.connect(EMULATOR);
    await startAt(r, 1);
  });
});

describe("the still-picture poller", () => {
  test("a viewer that arrives while the poller is winding down keeps being fed", async () => {
    const r = rig();
    const first = await r.connect(EMULATOR, "shot");
    await within(() => r.backend.shotCalls === 1, "the first screenshot to be asked for");
    first.close();
    await within(() => r.logs.some(line => line.includes("shot poller stop")), "the grace to wind the poller down");

    const second = await r.connect(EMULATOR, "shot");
    r.backend.releaseShots();

    await within(() => r.backend.shotCalls >= 2, "the poller to take another picture for the late viewer");
    expect(second.status).toBe(101);
  });
});
