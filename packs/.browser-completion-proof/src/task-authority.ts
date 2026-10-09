import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { EffectGuard } from "./contracts.js";

const HOST = "127.0.0.1";
const MAX_MESSAGE = 64 * 1024 * 1024; // CDP screenshots can be large base64 JSON messages.
const MAX_BUFFERED = 64 * 1024 * 1024;
const MAX_PENDING = 32;
const MAX_COMMAND = 1024 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;

function sizeOf(data: RawData): number {
  if (!Array.isArray(data)) return data.byteLength;
  let size = 0;
  for (const part of data) size += part.byteLength;
  return size;
}

/** A private, single-client CDP wire gate. The worker receives only `url`, never the Chrome endpoint. */
export async function createGuardedTaskEndpoint(
  upstreamUrl: string,
  authorize: EffectGuard,
): Promise<{ url: string; close(): void }> {
  let upstream: URL;
  try {
    upstream = new URL(upstreamUrl);
    if (upstream.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname) ||
        upstream.username || upstream.password || !upstream.port || upstream.hash) throw new Error();
  } catch {
    throw new Error("Invalid local CDP endpoint");
  }

  const route = `/${randomBytes(32).toString("hex")}`;
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_COMMAND, perMessageDeflate: false });
  let closed = false;
  let claimed = false;
  let client: WebSocket | undefined;
  let remote: WebSocket | undefined;
  const sockets = new Set<Socket>();
  const pending: Array<{ data: RawData; binary: boolean; bytes: number }> = [];
  let pendingBytes = 0;
  let draining = false;

  const close = (): void => {
    if (closed) return;
    closed = true; // Fence callbacks already awaiting authorization before terminating any I/O.
    pending.length = 0;
    pendingBytes = 0;
    client?.terminate();
    remote?.terminate();
    wss.close();
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  const fail = (): void => close();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("error", fail);
  wss.on("error", fail);
  server.on("upgrade", (request, socket, head) => {
    const address = server.address();
    const expectedHost = address && typeof address !== "string" ? `${HOST}:${address.port}` : "";
    if (closed || claimed || request.url !== route || request.headers.host !== expectedHost ||
        request.headers.origin !== undefined || request.method !== "GET" || !(socket instanceof Socket) || socket.remoteAddress !== HOST) {
      socket.destroy();
      return;
    }
    claimed = true;
    wss.handleUpgrade(request, socket, head, (accepted) => {
      if (closed) { accepted.terminate(); return; }
      client = accepted;
      accepted.on("error", fail);
      accepted.on("close", fail);
      accepted.on("message", (data, binary) => {
        const bytes = sizeOf(data);
        if (closed || bytes > MAX_COMMAND || pending.length + Number(draining) >= MAX_PENDING ||
            pendingBytes + bytes > MAX_PENDING_BYTES || accepted.bufferedAmount > MAX_BUFFERED) { fail(); return; }
        pending.push({ data, binary, bytes });
        pendingBytes += bytes;
        void drain();
      });
      // This socket never connects until the one authorized local worker has claimed the route.
      remote = new WebSocket(upstream, { maxPayload: MAX_MESSAGE, perMessageDeflate: false });
      remote.on("error", fail);
      remote.on("close", fail);
      remote.on("open", () => { void drain(); });
      remote.on("message", (data, binary) => {
        if (closed || !client || client.readyState !== WebSocket.OPEN || client.bufferedAmount + sizeOf(data) > MAX_BUFFERED) { fail(); return; }
        client.send(data, { binary }, (error) => { if (error) fail(); });
      });
    });
  });

  const drain = async (): Promise<void> => {
    if (draining || closed || remote?.readyState !== WebSocket.OPEN) return;
    draining = true;
    try {
      while (!closed && pending.length) {
        if (!remote || remote.readyState !== WebSocket.OPEN || remote.bufferedAmount > MAX_BUFFERED) { fail(); break; }
        const next = pending.shift()!;
        pendingBytes -= next.bytes;
        const authorization = authorize();
        if (authorization !== undefined) await authorization;
        authorize.assertCurrent();
        // An awaited host check can outlive revoke, cancellation, or the upstream socket.
        if (closed || remote.readyState !== WebSocket.OPEN || client?.readyState !== WebSocket.OPEN ||
            remote.bufferedAmount + next.bytes > MAX_BUFFERED) { fail(); break; }
        remote.send(next.data, { binary: next.binary }, (error) => { if (error) fail(); });
      }
    } catch { fail(); }
    finally { draining = false; }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (): void => reject(new Error("Cannot listen for guarded CDP task"));
      server.once("error", onError);
      server.listen(0, HOST, () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (closed || !address || typeof address === "string") throw new Error();
    return { url: `ws://${HOST}:${address.port}${route}`, close };
  } catch {
    close();
    throw new Error("Cannot start guarded CDP task");
  }
}
