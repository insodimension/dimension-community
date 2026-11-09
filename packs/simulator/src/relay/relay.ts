// The frames lane: a loopback WebSocket the View connects to for pictures, and
// speaks input back over. Control (MCP tools) never travels here and frames never
// travel there, so a burst of video cannot make a tool call wait.
//
// Who may connect. The listener is on 127.0.0.1 only, on an ephemeral port, and
// exists only while a token or a viewer does. A View asks (`device_stream`) for a
// token: 24 random bytes, minted per View, naming one device and one mode. A
// request must carry `Host: 127.0.0.1:<port>` (DNS rebinding), `Origin` absent or
// `null` (the sandboxed View's own; any real web origin is refused), and a live
// token. A wrong token and an unknown path are both 404.
//
// What it sends. ONE shared encoder per device however many viewers: viewer N+1
// is handed the cached session, config and the key frame with the deltas since it
// (a bounded cache), so it shows a picture at once and nothing restarts. The
// encoder runs only while a viewer is attached and stops after a short grace when
// the last one leaves. A viewer whose socket backlog passes the bound has frames
// DROPPED, never queued; it is parked at the frame gate until the next key frame
// (requested, with a cooldown, from the encoder).

import http from "node:http";
import type { AddressInfo } from "node:net";
import type net from "node:net";
import { randomBytes } from "node:crypto";
import { DEFAULT_VIDEO_OPTIONS, type DeviceBackend, type VideoStream, type VideoStreamOptions } from "../backend";
import type { VideoPacket } from "../contracts";
import { deliveryDecision, FrameGate, KeyframeThrottle } from "../shared/frame-gate";
import { FRAME_HEADER_BYTES, FrameTag, type StreamMode, parseInputMessage, sessionPayload, writeFrameHeader, type InputMessage } from "../shared/frame-protocol";
import { classifyGesture, type Size, toPixels } from "../shared/pointer";
import { frameHeader, handshakeResponse, OP_BINARY, validClientKey, WS_INTERNAL_ERROR, WsPeer } from "./websocket";

export interface RelayOptions {
  readonly backend: DeviceBackend;
  readonly log: (message: string) => void;
  /** The viewer count of `serial` changed (the fleet's idle clock). */
  readonly onViewers: (serial: string, total: number) => void;
  /** A viewer drove the device (the fleet's idle clock, throttled here). */
  readonly onActivity: (serial: string) => void;
  readonly ensureConnected: (serial: string) => Promise<void>;
  readonly now?: () => number;
  /** How long the encoder outlives its last viewer (a reloaded View re-attaches within it). */
  readonly stopGraceMs?: number;
  readonly maxBacklogBytes?: number;
  readonly keyframeCooldownMs?: number;
  /** A token nobody is connected with expires after this. */
  readonly tokenIdleMs?: number;
  readonly stream?: VideoStreamOptions;
  /** Longest edge of a Shot-mode picture. */
  readonly shotEdge?: number;
}

export interface StreamGrant {
  readonly url: string;
  /** The mode the viewer will actually get (h264 falls back to shot when Live is unavailable). */
  readonly mode: StreamMode;
  /** Why it is not what was asked for, or null. */
  readonly downgraded: string | null;
}

const GOP_CAP_BYTES = 1.5 * 1024 * 1024;
const MAX_INPUT_BYTES = 8 * 1024;
const ACTIVITY_EVERY_MS = 5_000;
const MIN_SHOT_INTERVAL_MS = 120;
const SANDBOXED_VIEW_ORIGIN = "null";
const STREAM_PATH = /^\/f\/([A-Za-z0-9_-]{16,64})(?:\?|$)/;

function mediaFrame(tag: FrameTag, seq: number, at: number, payload: Uint8Array): Buffer {
  const length = FRAME_HEADER_BYTES + payload.length;
  const header = frameHeader(OP_BINARY, length);
  const out = Buffer.allocUnsafe(header.length + length);
  header.copy(out, 0);
  writeFrameHeader(out, header.length, tag, seq, at);
  out.set(payload, header.length + FRAME_HEADER_BYTES);
  return out;
}

interface Token {
  readonly serial: string;
  readonly mode: StreamMode;
  timer: NodeJS.Timeout | undefined;
}

interface Down {
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

class Viewer {
  readonly gate = new FrameGate();
  dropped = 0;
  sent = 0;
  bytes = 0;
  lastActivity = 0;
  /** H.264 mode: a finger is down at this normalized point (released if the socket dies). */
  touching: { x: number; y: number } | null = null;
  /** Shot mode: where the press began. */
  down: Down | null = null;
  lastPoint: { x: number; y: number } = { x: 0, y: 0 };

  constructor(
    readonly id: number,
    readonly peer: WsPeer,
    readonly serial: string,
    readonly mode: StreamMode,
  ) {}
}

interface Hub {
  readonly options: Required<Pick<RelayOptions, "stopGraceMs" | "maxBacklogBytes" | "keyframeCooldownMs" | "shotEdge">> & { readonly stream: VideoStreamOptions };
  readonly backend: DeviceBackend;
  log(message: string): void;
  now(): number;
  viewersChanged(serial: string): void;
}

abstract class Producer {
  readonly viewers = new Set<Viewer>();
  #stopTimer: NodeJS.Timeout | undefined;

  constructor(
    protected readonly hub: Hub,
    readonly serial: string,
    readonly mode: StreamMode,
  ) {}

  protected abstract onAttach(viewer: Viewer): void;
  protected abstract stopSource(reason: string): void;
  abstract get state(): string;

  attach(viewer: Viewer): void {
    clearTimeout(this.#stopTimer);
    this.#stopTimer = undefined;
    this.viewers.add(viewer);
    this.hub.log(`[sim] viewer+ ${this.serial} ${this.mode} v${viewer.id} (${this.viewers.size} viewer${this.viewers.size === 1 ? "" : "s"}${this.viewers.size > 1 ? ", sharing the encoder" : ""})`);
    this.hub.viewersChanged(this.serial);
    this.onAttach(viewer);
  }

  detach(viewer: Viewer): void {
    if (!this.viewers.delete(viewer)) return;
    this.hub.log(`[sim] viewer- ${this.serial} ${this.mode} v${viewer.id} (${this.viewers.size} left; sent ${viewer.sent}, dropped ${viewer.dropped}, ${(viewer.bytes / 1024).toFixed(0)} KiB)`);
    this.hub.viewersChanged(this.serial);
    if (this.viewers.size > 0) return;
    this.#stopTimer = setTimeout(() => {
      this.#stopTimer = undefined;
      if (this.viewers.size === 0) this.stopSource("last viewer left");
    }, this.hub.options.stopGraceMs);
    this.#stopTimer.unref();
  }

  /** The source died: tell every viewer and let go of them. */
  protected endViewers(reason: string): void {
    for (const viewer of [...this.viewers]) {
      viewer.peer.sendText(JSON.stringify({ t: "ended", reason }));
      viewer.peer.close(WS_INTERNAL_ERROR, reason.slice(0, 100));
    }
  }

  /** Write one frame to one viewer, honouring the gate and the backlog bound. Returns false when it was not written. */
  protected offer(viewer: Viewer, tag: FrameTag, frame: Buffer, onGap: () => void): boolean {
    const decision = deliveryDecision(viewer.gate, tag, viewer.peer.backlog, this.hub.options.maxBacklogBytes);
    if (!decision.write) {
      if (decision.dropped) viewer.dropped += 1;
      if (decision.resync) onGap();
      return false;
    }
    viewer.peer.writeFrame(frame);
    viewer.sent += 1;
    viewer.bytes += frame.length;
    return true;
  }

  async input(_viewer: Viewer, _message: InputMessage): Promise<void> {}

  close(reason: string): void {
    this.stopSource(reason);
  }
}

class H264Producer extends Producer {
  #state: "idle" | "starting" | "live" = "idle";
  #stream: VideoStream | null = null;
  #generation = 0;
  #seq = 0;
  #sessionFrame: Buffer | null = null;
  #configFrame: Buffer | null = null;
  #configBytes: Buffer | null = null;
  #gop: { tag: FrameTag; frame: Buffer }[] = [];
  #gopBytes = 0;
  #gopValid = false;
  readonly #throttle: KeyframeThrottle;
  #trailing: NodeJS.Timeout | undefined;

  constructor(hub: Hub, serial: string) {
    super(hub, serial, "h264");
    this.#throttle = new KeyframeThrottle(hub.options.keyframeCooldownMs);
  }

  get state(): string {
    return this.#state;
  }

  protected onAttach(viewer: Viewer): void {
    if (this.#state === "idle") this.#start();
    else this.#catchUp(viewer);
  }

  #start(): void {
    this.#state = "starting";
    const generation = ++this.#generation;
    const startedAt = this.hub.now();
    this.hub.log(`[sim] encoder start ${this.serial} (h264 max ${this.hub.options.stream.maxSize}px ${this.hub.options.stream.maxFps}fps ${(this.hub.options.stream.bitRate / 1e6).toFixed(1)}Mbps)`);
    this.hub.backend
      .openStream(this.serial, this.hub.options.stream, {
        session: size => {
          if (this.#generation === generation) this.#onSession(size);
        },
        packet: packet => {
          if (this.#generation === generation) this.#onPacket(packet);
        },
        closed: (reason, deliberate) => {
          if (this.#generation !== generation) return;
          this.#reset();
          if (!deliberate) {
            this.hub.log(`[sim] encoder lost ${this.serial}: ${reason}`);
            this.endViewers(reason);
          }
        },
      })
      .then(opened => {
        if (this.#generation !== generation) {
          void opened.close();
          return;
        }
        this.#stream = opened;
        this.#state = "live";
        this.hub.log(`[sim] encoder live ${this.serial} in ${this.hub.now() - startedAt} ms`);
        if (this.viewers.size === 0) this.stopSource("viewers left during start");
      })
      .catch((error: unknown) => {
        if (this.#generation !== generation) return;
        this.#reset();
        const reason = error instanceof Error ? error.message : String(error);
        this.hub.log(`[sim] encoder start failed ${this.serial}: ${reason}`);
        this.endViewers(reason);
      });
  }

  #reset(): void {
    this.#generation += 1;
    this.#state = "idle";
    this.#stream = null;
    this.#sessionFrame = null;
    this.#configFrame = null;
    this.#configBytes = null;
    this.#gop = [];
    this.#gopBytes = 0;
    this.#gopValid = false;
    clearTimeout(this.#trailing);
    this.#trailing = undefined;
  }

  protected stopSource(reason: string): void {
    const stream = this.#stream;
    if (this.#state === "idle" && stream === null) return;
    this.hub.log(`[sim] encoder stop ${this.serial}: ${reason}`);
    this.#reset();
    void stream?.close();
  }

  #next(tag: FrameTag, payload: Uint8Array): Buffer {
    return mediaFrame(tag, this.#seq++, this.hub.now(), payload);
  }

  #onSession(size: Size): void {
    const frame = this.#next(FrameTag.Session, sessionPayload(size.width, size.height));
    this.#sessionFrame = frame;
    for (const viewer of this.viewers) this.offer(viewer, FrameTag.Session, frame, () => this.requestKeyframe());
  }

  #onPacket(packet: VideoPacket): void {
    if (packet.kind === "config") {
      const same = this.#configBytes !== null && this.#configBytes.equals(packet.data);
      const frame = this.#next(FrameTag.Config, packet.data);
      this.#configFrame = frame;
      this.#configBytes = packet.data;
      // The key frame cache belongs to the config before it.
      this.#gop = [];
      this.#gopBytes = 0;
      this.#gopValid = false;
      for (const viewer of this.viewers) {
        // The same SPS/PPS again (a key frame was requested): a viewer already decoding needs nothing, and a reconfigure would stutter it.
        if (same && viewer.gate.state === "streaming") continue;
        this.offer(viewer, FrameTag.Config, frame, () => this.requestKeyframe());
      }
      return;
    }
    const tag = packet.kind === "key" ? FrameTag.Key : FrameTag.Delta;
    const frame = this.#next(tag, packet.data);
    if (tag === FrameTag.Key) {
      this.#gop = [{ tag, frame }];
      this.#gopBytes = frame.length;
      this.#gopValid = this.#configFrame !== null;
    } else if (this.#gopValid) {
      this.#gop.push({ tag, frame });
      this.#gopBytes += frame.length;
      if (this.#gopBytes > GOP_CAP_BYTES) {
        // Too long to replay to a newcomer: they will wait for the next key frame instead.
        this.#gop = [];
        this.#gopBytes = 0;
        this.#gopValid = false;
      }
    }
    for (const viewer of this.viewers) this.offer(viewer, tag, frame, () => this.requestKeyframe());
  }

  /** A viewer joined a live encoder: replay what it needs to show the screen now. */
  #catchUp(viewer: Viewer): void {
    if (this.#sessionFrame === null || this.#configFrame === null) return; // the first broadcast delivers them
    this.offer(viewer, FrameTag.Session, this.#sessionFrame, () => undefined);
    this.offer(viewer, FrameTag.Config, this.#configFrame, () => undefined);
    if (this.#gopValid) {
      for (const entry of this.#gop) this.offer(viewer, entry.tag, entry.frame, () => this.requestKeyframe());
    } else {
      this.requestKeyframe();
    }
  }

  /** One request serves every viewer; a burst becomes one now and one trailing. */
  requestKeyframe(): void {
    const decision = this.#throttle.request(this.hub.now());
    if (decision.fire) {
      this.#stream?.requestKeyframe();
      return;
    }
    if (this.#trailing) return;
    this.#trailing = setTimeout(() => {
      this.#trailing = undefined;
      this.requestKeyframe();
    }, decision.retryInMs);
    this.#trailing.unref();
  }

  override async input(viewer: Viewer, message: InputMessage): Promise<void> {
    const stream = this.#stream;
    if (message.t === "kf") {
      this.requestKeyframe();
      return;
    }
    if (stream === null) return;
    if (message.t === "p") {
      viewer.touching = message.a === "up" ? null : { x: message.x, y: message.y };
      stream.touch(message.a, message.x, message.y);
    } else if (message.t === "k") {
      stream.key(message.key);
    } else {
      stream.text(message.text);
    }
  }

  /** The viewer's socket died with a finger down: lift it, or the device holds a press nobody is making. */
  release(viewer: Viewer): void {
    if (viewer.touching !== null) {
      this.#stream?.touch("up", viewer.touching.x, viewer.touching.y);
      viewer.touching = null;
    }
  }
}

class ShotProducer extends Producer {
  #running = false;
  #stopped = false;
  #seq = 0;
  #size: Size | null = null;
  #sessionFrame: Buffer | null = null;
  #shotFrame: Buffer | null = null;

  get state(): string {
    return this.#running ? "live" : "idle";
  }

  protected onAttach(viewer: Viewer): void {
    if (this.#sessionFrame) this.offer(viewer, FrameTag.Session, this.#sessionFrame, () => undefined);
    if (this.#shotFrame) this.offer(viewer, FrameTag.Shot, this.#shotFrame, () => undefined);
    if (this.#running) this.#stopped = false;
    else void this.#loop();
  }

  protected stopSource(reason: string): void {
    if (!this.#running) return;
    this.hub.log(`[sim] shot poller stop ${this.serial}: ${reason}`);
    this.#stopped = true;
  }

  async #loop(): Promise<void> {
    this.#running = true;
    this.#stopped = false;
    this.hub.log(`[sim] shot poller start ${this.serial}`);
    let failures = 0;
    while (this.viewers.size > 0 && !this.#stopped) {
      const started = this.hub.now();
      try {
        const shot = await this.hub.backend.screenshot(this.serial, this.hub.options.shotEdge);
        failures = 0;
        if (this.#size === null || this.#size.width !== shot.width || this.#size.height !== shot.height) {
          this.#size = { width: shot.width, height: shot.height };
          this.#sessionFrame = mediaFrame(FrameTag.Session, this.#seq++, this.hub.now(), sessionPayload(shot.width, shot.height));
          for (const viewer of this.viewers) this.offer(viewer, FrameTag.Session, this.#sessionFrame, () => undefined);
        }
        const frame = mediaFrame(FrameTag.Shot, this.#seq++, this.hub.now(), shot.png);
        this.#shotFrame = frame;
        for (const viewer of this.viewers) this.offer(viewer, FrameTag.Shot, frame, () => undefined);
      } catch (error) {
        failures += 1;
        if (failures >= 3) {
          const reason = error instanceof Error ? error.message : String(error);
          this.hub.log(`[sim] shot poller lost ${this.serial}: ${reason}`);
          this.endViewers(reason);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      const wait = MIN_SHOT_INTERVAL_MS - (this.hub.now() - started);
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    }
    this.#running = false;
    this.#sessionFrame = null;
    this.#shotFrame = null;
    this.#size = null;
  }

  override async input(viewer: Viewer, message: InputMessage): Promise<void> {
    const backend = this.hub.backend;
    try {
      if (message.t === "p") {
        viewer.lastPoint = { x: message.x, y: message.y };
        if (message.a === "down") {
          viewer.down = { x: message.x, y: message.y, at: this.hub.now() };
          return;
        }
        if (message.a !== "up" || viewer.down === null) return;
        const down = viewer.down;
        viewer.down = null;
        const display = await backend.display(this.serial);
        const from = toPixels(down.x, down.y, display);
        const to = toPixels(message.x, message.y, display);
        const gesture = classifyGesture(from, to, this.hub.now() - down.at);
        if (gesture.kind === "tap") await backend.tap(this.serial, gesture.at.x, gesture.at.y);
        else await backend.swipe(this.serial, gesture.from, gesture.to, gesture.durationMs);
      } else if (message.t === "k") {
        await backend.key(this.serial, message.key);
      } else if (message.t === "s") {
        await backend.text(this.serial, message.text);
      }
    } catch (error) {
      this.hub.log(`[sim] shot-mode input failed on ${this.serial}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export class FrameRelay {
  readonly #opts: RelayOptions;
  readonly #hub: Hub;
  readonly #tokens = new Map<string, Token>();
  readonly #producers = new Map<string, Producer>();
  readonly #tokenIdleMs: number;
  #server: http.Server | null = null;
  #listening: Promise<number> | null = null;
  #port = 0;
  #nextViewer = 1;

  constructor(options: RelayOptions) {
    this.#opts = options;
    this.#tokenIdleMs = options.tokenIdleMs ?? 60_000;
    this.#hub = {
      options: {
        stopGraceMs: options.stopGraceMs ?? 1_000,
        maxBacklogBytes: options.maxBacklogBytes ?? 1024 * 1024,
        keyframeCooldownMs: options.keyframeCooldownMs ?? 1_000,
        shotEdge: options.shotEdge ?? 1_280,
        stream: options.stream ?? DEFAULT_VIDEO_OPTIONS,
      },
      backend: options.backend,
      log: options.log,
      now: options.now ?? Date.now,
      viewersChanged: serial => {
        options.onViewers(serial, this.viewerCount(serial));
        this.#maybeCloseListener();
      },
    };
  }

  viewerCount(serial: string): number {
    let total = 0;
    for (const producer of this.#producers.values()) if (producer.serial === serial) total += producer.viewers.size;
    return total;
  }

  /** An encoder (or shot poller) is running for `serial`. */
  isLive(serial: string): boolean {
    for (const producer of this.#producers.values()) if (producer.serial === serial && producer.state !== "idle") return true;
    return false;
  }

  snapshot(): { listening: boolean; tokens: number; producers: { serial: string; mode: StreamMode; viewers: number; state: string }[] } {
    return {
      listening: this.#server !== null,
      tokens: this.#tokens.size,
      producers: [...this.#producers.values()].map(producer => ({ serial: producer.serial, mode: producer.mode, viewers: producer.viewers.size, state: producer.state })),
    };
  }

  async mint(serial: string, requested: StreamMode): Promise<StreamGrant> {
    await this.#opts.ensureConnected(serial);
    let mode = requested;
    let downgraded: string | null = null;
    if (mode === "h264" && !this.#opts.backend.liveAvailable()) {
      mode = "shot";
      downgraded = "scrcpy-server was not found, so there is no live video; showing still pictures.";
    }
    const port = await this.#ensureListening();
    const token = randomBytes(24).toString("base64url");
    const entry: Token = { serial, mode, timer: undefined };
    this.#tokens.set(token, entry);
    this.#armToken(token, entry);
    return { url: `ws://127.0.0.1:${port}/f/${token}`, mode, downgraded };
  }

  #armToken(token: string, entry: Token): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this.#tokens.delete(token);
      this.#maybeCloseListener();
    }, this.#tokenIdleMs);
    entry.timer.unref();
  }

  #ensureListening(): Promise<number> {
    this.#listening ??= (async () => {
      const server = http.createServer((_request, response) => {
        response.writeHead(404, { Connection: "close", "Content-Length": "0" });
        response.end();
      });
      server.on("upgrade", (request, socket, head) => this.#upgrade(request, socket as net.Socket, head));
      const ready = Promise.withResolvers<void>();
      server.once("error", ready.reject);
      server.listen(0, "127.0.0.1", () => ready.resolve());
      await ready.promise;
      this.#server = server;
      this.#port = (server.address() as AddressInfo).port;
      return this.#port;
    })();
    return this.#listening;
  }

  #maybeCloseListener(): void {
    if (this.#server === null || this.#tokens.size > 0) return;
    for (const producer of this.#producers.values()) if (producer.viewers.size > 0) return;
    const server = this.#server;
    this.#server = null;
    this.#listening = null;
    server.close();
    server.closeAllConnections();
  }

  #upgrade(request: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    socket.on("error", () => socket.destroy());
    try {
      this.#accept(request, socket, head);
    } catch (error) {
      this.#opts.log(`[sim] frames lane dropped an upgrade: ${error instanceof Error ? error.message : String(error)}`);
      socket.destroy();
    }
  }

  #accept(request: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const refuse = (status: number, text: string): void => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
    };
    // Host and Origin first: a page that is not ours learns nothing about which tokens exist.
    if (request.headers.host !== `127.0.0.1:${this.#port}`) return refuse(403, "Forbidden");
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== SANDBOXED_VIEW_ORIGIN) return refuse(403, "Forbidden");
    const token = STREAM_PATH.exec(request.url ?? "")?.[1];
    const entry = token === undefined ? undefined : this.#tokens.get(token);
    if (request.method !== "GET" || token === undefined || entry === undefined) return refuse(404, "Not Found");
    const key = request.headers["sec-websocket-key"];
    if (request.headers.upgrade?.toLowerCase() !== "websocket" || request.headers["sec-websocket-version"] !== "13" || !validClientKey(key)) return refuse(400, "Bad Request");

    socket.write(handshakeResponse(key));
    this.#tokens.delete(token);
    clearTimeout(entry.timer);
    entry.timer = undefined;

    const producerKey = `${entry.serial}|${entry.mode}`;
    let producer = this.#producers.get(producerKey);
    if (producer === undefined) {
      producer = entry.mode === "h264" ? new H264Producer(this.#hub, entry.serial) : new ShotProducer(this.#hub, entry.serial, "shot");
      this.#producers.set(producerKey, producer);
    }
    const owner = producer;
    let viewer: Viewer | null = null;
    const peer = new WsPeer(
      socket,
      head,
      {
        text: message => {
          if (viewer === null) return;
          const input = parseInputMessage(message);
          if (input === null) return;
          const at = this.#hub.now();
          if (at - viewer.lastActivity > ACTIVITY_EVERY_MS) {
            viewer.lastActivity = at;
            this.#opts.onActivity(entry.serial);
          }
          void owner.input(viewer, input);
        },
        binary: () => undefined,
        closed: () => {
          if (viewer !== null) {
            if (owner instanceof H264Producer) owner.release(viewer);
            owner.detach(viewer);
          }
          if (owner.viewers.size === 0 && owner.state === "idle") this.#producers.delete(producerKey);
          this.#maybeCloseListener();
        },
      },
      MAX_INPUT_BYTES,
    );
    if (!peer.open) return;
    viewer = new Viewer(this.#nextViewer++, peer, entry.serial, entry.mode);
    peer.sendText(JSON.stringify({ t: "ready", serial: entry.serial, mode: entry.mode }));
    owner.attach(viewer);
  }

  async close(): Promise<void> {
    for (const producer of this.#producers.values()) {
      for (const viewer of producer.viewers) viewer.peer.close(1001, "pack stopping");
      producer.close("relay closed");
    }
    this.#producers.clear();
    for (const entry of this.#tokens.values()) clearTimeout(entry.timer);
    this.#tokens.clear();
    this.#maybeCloseListener();
  }
}
