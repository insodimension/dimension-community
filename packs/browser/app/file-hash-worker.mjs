// src/file-hash-worker.ts
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";

// src/local-path.ts
import { lstatSync, readlinkSync } from "node:fs";
import { parse, resolve } from "node:path";
var NETWORK_OR_DEVICE_PATH = /^[\\/]{2}|^[\\/][?.]{1,2}[\\/]/;
var ROOTED_WITHOUT_DRIVE_OR_DRIVE_RELATIVE = /^[\\/]|^[A-Za-z]:(?![\\/])/;
var PATH_SEPARATORS = /[\\/]+/;
var MAX_LINK_HOPS = 32;
function stampOf(stats) {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}
function segmentsBelowRoot(path) {
  const { root } = parse(path);
  return { root, segments: path.slice(root.length).split(PATH_SEPARATORS).filter((segment) => segment.length > 0) };
}
function linkTargetRefusal(target) {
  if (NETWORK_OR_DEVICE_PATH.test(target)) return `links to ${target}, a network or device path`;
  if (process.platform === "win32" && ROOTED_WITHOUT_DRIVE_OR_DRIVE_RELATIVE.test(target)) return `links to ${target}, a path on no drive letter (an NT or rooted path)`;
  return void 0;
}
function linkOffMachine(path) {
  let { root: walked, segments } = segmentsBelowRoot(resolve(path));
  let hops = 0;
  while (segments.length > 0) {
    const [segment, ...rest] = segments;
    const next = resolve(walked, segment);
    let stats;
    try {
      stats = lstatSync(next);
    } catch (error) {
      if (hops === 0 && error.code === "ENOENT") return void 0;
      return `goes through ${next}, which cannot be checked without following a link (${error.message})`;
    }
    segments = rest;
    if (!stats.isSymbolicLink()) {
      walked = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS) return `goes through more than ${MAX_LINK_HOPS} links`;
    let target;
    try {
      target = readlinkSync(next);
    } catch (error) {
      return `goes through ${next}, a link whose target cannot be read (${error.message}), so it is not followed`;
    }
    const refusal = linkTargetRefusal(target);
    if (refusal !== void 0) return refusal;
    const landed = segmentsBelowRoot(resolve(walked, target));
    walked = landed.root;
    segments = [...landed.segments, ...segments];
  }
  return void 0;
}

// src/file-hash-worker.ts
var HASH_CHUNK_BYTES = 1 << 20;
async function hashFile({ real }) {
  const refused = linkOffMachine(real);
  if (refused !== void 0) return { refused };
  const handle = await open(real, "r");
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (; ; ) {
      const { bytesRead } = await handle.read(chunk, 0, HASH_CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
    return { sha256: hash.digest("hex"), stamp: stampOf(await handle.stat()) };
  } finally {
    await handle.close();
  }
}
hashFile(workerData).then(
  (reply) => parentPort?.postMessage(reply),
  (error) => parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
);
