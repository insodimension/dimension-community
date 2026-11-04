#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomFillSync } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statfsSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const USAGE = `Usage: node bench/stress-publish.mjs [options]

Stress-tests browser_publish with large files through app/server.mjs (build it first) and real headless Chromium.

Scenarios, in order:
  concurrent  --servers pack servers (one per engine; each holds at most 4 browsers), every browser publishing the
              same shared file at once with waitSeconds 0 (the host-timeout path: returns "preparing", followed with
              browser_publish_wait), plus one duplicate publish per server on a busy browser (must be refused
              publish_pending). Every parked post is confirmed and its upload counted at the fake Studio.
  hash-rate   one publish of the shared file vs one of a 1-byte file on an idle server, --repeats times.
  host-wait   a compose page held 3 s with waitSeconds 1: returns "preparing", then browser_publish_wait.
  swap        the file is changed after Approve and after park started, before attach: must fail file_changed with
              nothing uploaded, and the approval must survive (the restored file parks again). Also a swap before
              the call: publish_unapproved.
  cancel      browser_publish_cancel while the compose page is still loading: cancelled, nothing uploaded, the
              approval survives.
  paths       UNC, device-namespace and pipe paths, and a symlink to a UNC share: each refused, by what it is.

Options:
  --servers <n>    Pack servers for the concurrent scenario (default 6, so 24 concurrent publishes)
  --size-mb <n>    Size of the shared file in MiB (default 1024)
  --repeats <n>    hash-rate repetitions (default 3)
  -h, --help       Show this help

Disk: one shared file (--size-mb; every publish and the swap use it, the swap flips one byte and restores it) plus
about 1 GiB of browser profiles. The run refuses to start unless the volume holding .scratch has that much free with
512 MiB to spare.
Output: a table on stdout and bench/results/<timestamp>-publish-stress.{md,json}. Exit 1 if any expectation failed.`;

const { values: opts } = parseArgs({
  options: {
    servers: { type: "string", default: "6" },
    "size-mb": { type: "string", default: "1024" },
    repeats: { type: "string", default: "3" },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (process.platform !== "win32") {
  console.error("The publish stress bench runs on Windows only: its device, UNC and symlink cases and its process census are Windows ones.");
  process.exit(2);
}
const SERVERS = Number(opts.servers);
const SIZE = Number(opts["size-mb"]) * 1024 * 1024;
const REPEATS = Number(opts.repeats);
if (!Number.isInteger(SERVERS) || SERVERS < 1 || !Number.isInteger(SIZE) || SIZE < 1 || !Number.isInteger(REPEATS) || REPEATS < 1) {
  console.error("--servers, --size-mb and --repeats must be positive integers");
  process.exit(2);
}
const BROWSERS_PER_SERVER = 4;
const MIB = 1024 * 1024;

const packDir = fileURLToPath(new URL("../", import.meta.url));
const serverPath = fileURLToPath(new URL("../app/server.mjs", import.meta.url));
if (!existsSync(serverPath)) {
  console.error(`Missing ${serverPath}; run \`npm run build\` in packs/browser first.`);
  process.exit(2);
}

const repoRoot = resolve(packDir, "..", "..", "..");
const scratchRoot = join(repoRoot, ".scratch", "browser-publish-stress");
const inside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const realHomes = [".inso", ".inso-dev"].map((name) => join(homedir(), name));
if (realHomes.some((home) => inside(resolve(scratchRoot), home) && !inside(resolve(scratchRoot), join(home, "wt")))) {
  console.error(`Refusing to start: ${scratchRoot} is inside ~/.inso or ~/.inso-dev (outside its wt/ worktrees).`);
  process.exit(2);
}
mkdirSync(scratchRoot, { recursive: true });
const fs = statfsSync(scratchRoot);
const freeBytes = Number(fs.bavail) * Number(fs.bsize);
const needBytes = SIZE + 1536 * MIB;
if (freeBytes < needBytes) {
  console.error(`Refusing to start: ${(freeBytes / 1024 / MIB).toFixed(1)} GiB free on the volume of ${scratchRoot}, need ${(needBytes / 1024 / MIB).toFixed(1)} GiB (one ${opts["size-mb"]} MiB file, profiles, 512 MiB spare). Lower --size-mb.`);
  process.exit(2);
}
const runDir = mkdtempSync(join(scratchRoot, "run-"));
const children = new Set();
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const pid of children) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  if (runDir === scratchRoot || !inside(runDir, scratchRoot)) throw new Error(`refusing to delete ${runDir}: not a directory this run made`);
  rmSync(runDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
process.once("exit", () => {
  try {
    cleanup();
  } catch (error) {
    console.error(`[stress] ${runDir} was not deleted: ${error.message}`);
  }
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(130));

const log = (line) => console.error(`[stress ${new Date().toISOString().slice(11, 23)}] ${line}`);
log(`run dir ${runDir}; ${(freeBytes / 1024 / MIB).toFixed(1)} GiB free before the files`);

function makeFile(path, size) {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(8 * MIB);
  const fd = openSync(path, "w");
  try {
    for (let written = 0; written < size; ) {
      const n = Math.min(chunk.length, size - written);
      randomFillSync(chunk, 0, n);
      writeSync(fd, chunk, 0, n);
      hash.update(chunk.subarray(0, n));
      written += n;
    }
  } finally {
    closeSync(fd);
  }
  return { path, size, sha256: hash.digest("hex") };
}

const filesDir = join(runDir, "files");
mkdirSync(filesDir);
let started = performance.now();
const shared = makeFile(join(filesDir, "master.mp4"), SIZE);
const tiny = makeFile(join(filesDir, "tiny.mp4"), 1);
log(`made the ${opts["size-mb"]} MiB file in ${((performance.now() - started) / 1000).toFixed(1)} s`);

function flipByte(path, offset = 0) {
  const fd = openSync(path, "r+");
  try {
    const one = Buffer.alloc(1);
    readSync(fd, one, 0, 1, offset);
    one[0] ^= 0xff;
    writeSync(fd, one, 0, 1, offset);
  } finally {
    closeSync(fd);
  }
}

const COOKIE = "studio_sid";
const session = randomBytes(8).toString("hex");
const uploads = new Map();
const submissions = [];
const holds = new Map();
function hold(key) {
  const entry = { arrived: Promise.withResolvers(), release: Promise.withResolvers() };
  holds.set(key, entry);
  return entry;
}
function studioPage(signedIn) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Studio</title></head><body>
${signedIn ? `<p id="me">@stress</p>` : `<p>sign in to upload</p>`}
<textarea id="title"></textarea>
<input type="file" id="video" accept="video/*">
<button id="post" type="button">Save</button>
<script>
  var p = new URLSearchParams(location.search).get("p") || "";
  document.getElementById("video").addEventListener("change", function (event) {
    var file = event.target.files[0];
    if (file) fetch("/__upload?p=" + encodeURIComponent(p), { method: "POST", body: file });
  });
  document.getElementById("post").addEventListener("click", async function () {
    var response = await fetch("/submit?p=" + encodeURIComponent(p), { method: "POST", body: document.getElementById("title").value });
    location.href = "/v/" + (await response.json()).id;
  });
</script></body></html>`;
}
const studio = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const html = (markup, headers = {}) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
    response.end(markup);
  };
  if (url.pathname === "/login") return html("<!doctype html><title>signed in</title><p>signed in</p>", { "set-cookie": `${COOKIE}=${session}; Path=/; SameSite=Lax` });
  if (url.pathname === "/compose") {
    const key = url.searchParams.get("hold");
    const held = key === null ? undefined : holds.get(key);
    if (held !== undefined) {
      held.arrived.resolve();
      await held.release.promise;
    }
    return html(studioPage((request.headers.cookie ?? "").includes(`${COOKIE}=${session}`)));
  }
  if (url.pathname === "/__upload" && request.method === "POST") {
    const profile = url.searchParams.get("p") ?? "";
    const upload = { bytes: 0, done: Promise.withResolvers(), startedAt: performance.now(), endedAt: 0 };
    uploads.set(profile, upload);
    request.on("data", (chunk) => {
      upload.bytes += chunk.length;
    });
    request.on("end", () => {
      upload.endedAt = performance.now();
      upload.done.resolve();
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    request.on("error", () => upload.done.resolve());
    return;
  }
  if (url.pathname === "/submit" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    submissions.push({ profile: url.searchParams.get("p") ?? "", title: body });
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ id: `v${String(submissions.length).padStart(6, "0")}` }));
  }
  if (/^\/v\/[A-Za-z0-9]+$/.test(url.pathname)) return html("<!doctype html><title>saved</title><p>saved</p>");
  response.writeHead(404);
  response.end();
});
studio.keepAliveTimeout = 1_000;
await new Promise((ready) => studio.listen(0, "127.0.0.1", ready));
const origin = `http://127.0.0.1:${studio.address().port}`;
log(`fake Studio on ${origin}`);

const probePath = join(runDir, "probe.mjs");
writeFileSync(
  probePath,
  `import { monitorEventLoopDelay, performance } from "node:perf_hooks";
const h = monitorEventLoopDelay({ resolution: 1 });
h.enable();
let elu = performance.eventLoopUtilization();
setInterval(() => {
  const now = performance.eventLoopUtilization();
  const busy = performance.eventLoopUtilization(now, elu).utilization;
  elu = now;
  process.stderr.write("STRESSPROBE " + JSON.stringify({ t: Date.now(), rss: process.memoryUsage().rss, max: h.max / 1e6, p99: h.percentile(99) / 1e6, busy }) + "\\n");
  h.reset();
}, 100).unref();
`,
);

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

async function startServer(index) {
  const root = join(runDir, `server-${index}`);
  await mkdir(root, { recursive: true });
  const samples = [];
  const tail = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", pathToFileURL(probePath).href, serverPath],
    cwd: packDir,
    env: { ...process.env, DIMENSION_BROWSER_ROOT: root, DIMENSION_BROWSER_HEADLESS: "true" },
    stderr: "pipe",
  });
  let pending = "";
  transport.stderr?.on("data", (chunk) => {
    pending += String(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("STRESSPROBE ")) samples.push(JSON.parse(line.slice(12)));
      else if (line.trim()) {
        tail.push(line);
        tail.splice(0, Math.max(0, tail.length - 40));
      }
    }
  });
  const client = new Client({ name: "browser-publish-stress", version: "0.1.0" });
  await client.connect(transport);
  if (transport.pid) children.add(transport.pid);
  return { index, root, client, samples, tail, pid: transport.pid };
}

const CALL_TIMEOUT_MS = 10 * 60_000;
async function call(server, name, args) {
  const startedAt = performance.now();
  const result = await server.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
  const ms = performance.now() - startedAt;
  const text = result.content?.find((part) => part.type === "text")?.text ?? "";
  return { ok: !result.isError, sc: result.structuredContent ?? {}, text, ms, at: startedAt };
}

async function approve(server, post) {
  const draftId = `draft-${randomBytes(6).toString("hex")}`;
  const folder = join(server.root, "publish-approvals");
  await mkdir(folder, { recursive: true });
  const files = Object.entries(post.files ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([label, file]) => [label, [file.path, file.size, file.sha256]]);
  const now = Date.now();
  await writeFile(
    join(folder, `${draftId}.json`),
    JSON.stringify({
      v: 1,
      draftId,
      nonce: randomBytes(16).toString("hex"),
      binding: createHash("sha256").update(JSON.stringify(["publish-approval/v1", post.origin, post.profile, null, post.values, ...(files.length === 0 ? [] : [Object.fromEntries(files)])])).digest("hex"),
      approvedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
    }),
  );
}

function recipe(profile, file, extra = "") {
  return {
    origin,
    composeUrl: `${origin}/compose?p=${encodeURIComponent(profile)}${extra}`,
    signedIn: "#me",
    fields: [{ label: "Title", selector: "#title", value: `Stress ${profile}` }],
    files: [{ label: "Video", selector: "#video", path: file.path }],
    submit: "#post",
    receipt: { path: "/v/{segment}" },
  };
}
const approveFor = (server, browser, file) => approve(server, { origin, profile: browser.profile, values: [`Stress ${browser.profile}`], files: { Video: file } });

async function openBrowser(server, profile) {
  const opened = await call(server, "browser_open", { profile });
  if (!opened.ok) throw new Error(`browser_open ${profile}: ${opened.text}`);
  const browserId = opened.sc.browserId;
  const signedIn = await call(server, "browser_act", { browserId, actions: [{ kind: "navigate", url: `${origin}/login` }] });
  if (!signedIn.ok) throw new Error(`sign-in ${profile}: ${signedIn.text}`);
  return { profile, browserId };
}

async function follow(server, browser, publishId) {
  const waits = [];
  for (;;) {
    const record = await call(server, "browser_publish_wait", { browserId: browser.browserId, publishId, waitSeconds: 1 });
    waits.push({ ms: round(record.ms), status: record.sc.status ?? record.text.slice(0, 120) });
    record.waits = waits;
    if (!record.ok || record.sc.status !== "preparing") return record;
  }
}

const expectFor = (browser, file) => ({ origin, profile: browser.profile, values: [`Stress ${browser.profile}`], files: { Video: file.path } });

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail });
  log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}
function windowStats(servers, fromWall, toWall) {
  let maxStall = 0;
  let peakRss = 0;
  let p99 = 0;
  let busy = 0;
  let samples = 0;
  for (const server of servers) {
    for (const sample of server.samples) {
      if (sample.t < fromWall || sample.t - 100 > toWall) continue;
      maxStall = Math.max(maxStall, sample.max);
      p99 = Math.max(p99, sample.p99);
      peakRss = Math.max(peakRss, sample.rss);
      busy += sample.busy;
      samples += 1;
    }
  }
  return { maxStallMs: round(maxStall), worstP99Ms: round(p99), peakRssMiB: round(peakRss / MIB), loopBusy: samples === 0 ? null : round(busy / samples, 2) };
}
const STALL_OF_NOTE_MS = 50;
function stallsOfNote(servers, fromWall, toWall) {
  return servers
    .flatMap((server) => server.samples.filter((sample) => sample.t >= fromWall && sample.t - 100 <= toWall && sample.max >= STALL_OF_NOTE_MS).map((sample) => ({ server: server.index, atMs: sample.t - fromWall, ms: round(sample.max) })))
    .sort((a, b) => a.atMs - b.atMs);
}
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? Number.NaN : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const results = { startedAt: new Date().toISOString(), servers: SERVERS, fileMiB: SIZE / MIB, node: process.version, scenarios: {} };

const servers = [];
try {
  started = performance.now();
  servers.push(...(await Promise.all(Array.from({ length: SERVERS }, (_, index) => startServer(index)))));
  const browsers = await Promise.all(servers.map((server) => Promise.all(Array.from({ length: BROWSERS_PER_SERVER }, (_, b) => openBrowser(server, `s${server.index}b${b}`)))));
  log(`${SERVERS} servers, ${SERVERS * BROWSERS_PER_SERVER} signed-in browsers in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  await sleep(1_000);
  const idle = windowStats(servers, Date.now() - 900, Date.now());
  results.idle = idle;

  {
    for (const [s, server] of servers.entries()) for (const browser of browsers[s]) await approveFor(server, browser, shared);
    const fromWall = Date.now();
    const t0 = performance.now();
    const publishes = servers.flatMap((server, s) =>
      browsers[s].map(async (browser) => {
        const parked = await call(server, "browser_publish", { browserId: browser.browserId, recipe: recipe(browser.profile, shared), mode: "post", waitSeconds: 0 });
        return { server, browser, parked, toPreparingMs: performance.now() - t0 };
      }),
    );
    const duplicates = servers.map(async (server, s) => {
      const browser = browsers[s][0];
      const refused = await call(server, "browser_publish", { browserId: browser.browserId, recipe: recipe(browser.profile, shared), mode: "post", waitSeconds: 0 });
      return { refused, ms: performance.now() - t0 };
    });
    const started_ = await Promise.all(publishes);
    const dup = await Promise.all(duplicates);
    const live = started_.filter((entry) => entry.parked.ok && entry.parked.sc.status === "preparing");
    const dupWon = dup.filter((entry) => entry.refused.ok);
    const dupRefused = dup.filter((entry) => !entry.refused.ok && /publish_pending|being prepared on this browser|already being prepared|awaiting confirmation/.test(entry.refused.text));
    check("concurrent: every browser's publish returned preparing (or lost admission to its duplicate)", live.length + dupWon.length === SERVERS * BROWSERS_PER_SERVER, `${live.length} preparing, ${dupWon.length} duplicates admitted instead`);
    check("concurrent: one publish per browser, the other refused publish_pending", dupRefused.length + (started_.length - live.length) === SERVERS && dupWon.length + dupRefused.length === SERVERS, `${dupRefused.length} duplicates refused`);

    const winners = [
      ...live.map((entry) => ({ server: entry.server, browser: entry.browser, publishId: entry.parked.sc.publishId })),
      ...dup.flatMap((entry, s) => (entry.refused.ok ? [{ server: servers[s], browser: browsers[s][0], publishId: entry.refused.sc.publishId }] : [])),
    ];
    const followed = await Promise.all(
      winners.map(async (entry) => {
        const record = await follow(entry.server, entry.browser, entry.publishId);
        return { ...entry, record, parkedMs: performance.now() - t0 };
      }),
    );
    const parkedWall = Date.now();
    const parkedOk = followed.filter((entry) => entry.record.ok && entry.record.sc.status === "awaiting-confirmation");
    check("concurrent: every live publish parked (awaiting-confirmation) via browser_publish_wait", parkedOk.length === winners.length, followed.filter((entry) => entry.record.sc.status !== "awaiting-confirmation").map((entry) => `${entry.browser.profile}: ${entry.record.sc.status} ${entry.record.sc.error ?? entry.record.text}`).join("; "));
    const allUploads = async () => {
      for (;;) {
        const started = winners.map((entry) => uploads.get(entry.browser.profile));
        if (started.every(Boolean)) return await Promise.all(started.map((upload) => upload.done.promise));
        await sleep(100);
      }
    };
    const uploaded = await Promise.race([allUploads(), sleep(5 * 60_000).then(() => "timeout")]);
    const fullUploads = winners.filter((entry) => uploads.get(entry.browser.profile)?.bytes === SIZE).length;
    check("concurrent: every upload reached the fake Studio whole before Save", uploaded !== "timeout" && fullUploads === winners.length, `${fullUploads}/${winners.length} uploads of ${SIZE} bytes`);
    const confirmed = await Promise.all(
      parkedOk.map(async (entry) => ({ ...entry, posted: await call(entry.server, "browser_publish_confirm", { browserId: entry.browser.browserId, publishId: entry.publishId, expect: expectFor(entry.browser, shared) }) })),
    );
    const postedOk = confirmed.filter((entry) => entry.posted.ok && entry.posted.sc.status === "posted" && /\/v\/v\d+$/.test(entry.posted.sc.url ?? ""));
    check("concurrent: every parked publish posted once with its receipt", postedOk.length === parkedOk.length && submissions.length === parkedOk.length, `${postedOk.length} posted, ${submissions.length} submissions`);
    const endWall = Date.now();
    const toPreparing = started_.map((entry) => entry.toPreparingMs);
    const parkedTimes = followed.map((entry) => entry.parkedMs);
    const uploadMs = winners.map((entry) => uploads.get(entry.browser.profile)).filter(Boolean).map((upload) => upload.endedAt - upload.startedAt);
    const lastParkedS = Math.max(...parkedTimes) / 1000;
    results.scenarios.concurrent = {
      publishes: SERVERS * BROWSERS_PER_SERVER,
      duplicates: SERVERS,
      toPreparingMs: { p50: round(quantile(toPreparing, 0.5)), p95: round(quantile(toPreparing, 0.95)), max: round(Math.max(...toPreparing)) },
      duplicateRefusalMs: { p50: round(quantile(dup.map((entry) => entry.ms), 0.5)), max: round(Math.max(...dup.map((entry) => entry.ms))) },
      toParkedMs: { p50: round(quantile(parkedTimes, 0.5)), max: round(Math.max(...parkedTimes)) },
      parkThroughputMBps: round((winners.length * SIZE) / MIB / lastParkedS),
      uploadMs: { p50: round(quantile(uploadMs, 0.5)), max: round(Math.max(...uploadMs, 0)) },
      whileHashing: windowStats(servers, fromWall, parkedWall),
      parkToUploaded: windowStats(servers, parkedWall, endWall),
      perServerWhileHashing: servers.map((server) => windowStats([server], fromWall, parkedWall)),
      stallsWhileHashing: stallsOfNote(servers, fromWall, parkedWall),
      rows: started_.map((entry) => ({ profile: entry.browser.profile, ok: entry.parked.ok, status: entry.parked.sc.status, toPreparingMs: round(entry.toPreparingMs), ...(entry.parked.ok ? {} : { error: entry.parked.text.slice(0, 300) }) })),
      duplicateRows: dup.map((entry, s) => ({ profile: browsers[s][0].profile, ok: entry.refused.ok, ms: round(entry.ms), text: entry.refused.text.slice(0, 300) })),
      followRows: followed.map((entry) => ({ profile: entry.browser.profile, parkedMs: round(entry.parkedMs), waits: entry.record.waits })),
    };
  }

  const s0 = servers[0];
  const [b0, b1, b2, b3] = browsers[0];
  for (const server of servers.slice(1)) await server.client.close().catch(() => undefined);

  {
    const big = [];
    const small = [];
    const stalls = [];
    for (let repeat = 0; repeat < REPEATS; repeat++) {
      for (const [file, into, browser] of [[shared, big, b2], [tiny, small, b3]]) {
        await approveFor(s0, browser, file);
        const fromWall = Date.now();
        const parked = await call(s0, "browser_publish", { browserId: browser.browserId, recipe: recipe(browser.profile, file), mode: "post", waitSeconds: 25 });
        if (!parked.ok) throw new Error(`hash-rate publish: ${parked.text}`);
        const record = parked.sc.status === "preparing" ? await follow(s0, browser, parked.sc.publishId) : parked;
        if (record.sc.status !== "awaiting-confirmation") throw new Error(`hash-rate publish did not park: ${record.text}`);
        into.push(performance.now() - parked.at);
        if (file === shared) stalls.push(windowStats([s0], fromWall, Date.now()));
        await call(s0, "browser_publish_cancel", { browserId: browser.browserId, publishId: parked.sc.publishId });
      }
    }
    const hashMs = quantile(big, 0.5) - quantile(small, 0.5);
    const worst = (key) => Math.max(...stalls.map((stat) => stat[key]));
    results.scenarios.hashRate = {
      toParkedBigMs: big.map((ms) => round(ms)),
      toParkedTinyMs: small.map((ms) => round(ms)),
      hashMBps: round(SIZE / MIB / (hashMs / 1000)),
      whileHashing: { maxStallMs: worst("maxStallMs"), worstP99Ms: worst("worstP99Ms"), peakRssMiB: worst("peakRssMiB"), loopBusy: worst("loopBusy") },
      note: "page-cache hot: the file was just written; hash time = median time to parked (1 GiB) minus median time to parked (1 byte)",
    };
    check("hash-rate: measured", Number.isFinite(results.scenarios.hashRate.hashMBps), `${results.scenarios.hashRate.hashMBps} MB/s`);
  }

  {
    const held = hold("slow");
    await approveFor(s0, b2, shared);
    held.arrived.promise.then(() => setTimeout(() => held.release.resolve(), 3_000));
    const parked = await call(s0, "browser_publish", { browserId: b2.browserId, recipe: recipe(b2.profile, shared, "&hold=slow"), mode: "post", waitSeconds: 1 });
    const followed = parked.ok ? await follow(s0, b2, parked.sc.publishId) : parked;
    check("host-wait: waitSeconds 1 returned preparing", parked.ok && parked.sc.status === "preparing", `${round(parked.ms)} ms`);
    check("host-wait: browser_publish_wait followed it to awaiting-confirmation", followed.sc.status === "awaiting-confirmation", followed.sc.status ?? followed.text);
    results.scenarios.hostWait = { waitSeconds: 1, toPreparingMs: round(parked.ms), toParkedMs: round(parked.ms + followed.ms) };
    if (parked.ok) await call(s0, "browser_publish_cancel", { browserId: b2.browserId, publishId: parked.sc.publishId });
  }

  {
    const held = hold("swap");
    await approveFor(s0, b0, shared);
    const before = uploads.get(b0.profile);
    uploads.delete(b0.profile);
    const pending = call(s0, "browser_publish", { browserId: b0.browserId, recipe: recipe(b0.profile, shared, "&hold=swap"), mode: "post", waitSeconds: 25 });
    await held.arrived.promise;
    flipByte(shared.path);
    held.release.resolve();
    const swapped = await pending;
    const record = swapped.sc;
    check("swap: failed with file_changed, nothing attached", record.status === "failed" && /file_changed/.test(record.error ?? "") && /nothing was attached/.test(record.error ?? ""), record.error ?? swapped.text);
    check("swap: no byte reached the fake Studio", !uploads.has(b0.profile), `${uploads.get(b0.profile)?.bytes ?? 0} bytes`);
    flipByte(shared.path);
    const again = await call(s0, "browser_publish", { browserId: b0.browserId, recipe: recipe(b0.profile, shared), mode: "post", waitSeconds: 25 });
    check("swap: the approval survived (restored bytes park again)", again.ok && again.sc.status === "awaiting-confirmation", again.sc.status ?? again.text);
    if (again.ok) await call(s0, "browser_publish_cancel", { browserId: b0.browserId, publishId: again.sc.publishId });
    await approveFor(s0, b0, shared);
    flipByte(shared.path);
    const early = await call(s0, "browser_publish", { browserId: b0.browserId, recipe: recipe(b0.profile, shared), mode: "post", waitSeconds: 25 });
    flipByte(shared.path);
    check("swap: changed between Approve and the call is refused publish_unapproved", !early.ok && early.text.includes("publish_unapproved") && !early.text.includes("already used"), early.text.slice(0, 160));
    results.scenarios.swap = { failedError: record.error ?? swapped.text, failedMs: round(swapped.ms), unapprovedMs: round(early.ms) };
    if (before) uploads.set(b0.profile, before);
  }

  {
    const held = hold("cancel");
    await approveFor(s0, b1, shared);
    uploads.delete(b1.profile);
    const parked = await call(s0, "browser_publish", { browserId: b1.browserId, recipe: recipe(b1.profile, shared, "&hold=cancel"), mode: "post", waitSeconds: 0 });
    await held.arrived.promise;
    const cancelling = call(s0, "browser_publish_cancel", { browserId: b1.browserId, publishId: parked.sc.publishId });
    await sleep(500);
    held.release.resolve();
    const cancelled = await cancelling;
    check("cancel: preparing publish ends cancelled", cancelled.ok && cancelled.sc.status === "cancelled", `${cancelled.sc.status ?? cancelled.text}: ${cancelled.sc.error ?? ""}`);
    check("cancel: nothing uploaded", !uploads.has(b1.profile), `${uploads.get(b1.profile)?.bytes ?? 0} bytes`);
    const again = await call(s0, "browser_publish", { browserId: b1.browserId, recipe: recipe(b1.profile, shared), mode: "post", waitSeconds: 25 });
    check("cancel: the approval survived (parks again)", again.ok && again.sc.status === "awaiting-confirmation", again.sc.status ?? again.text);
    if (again.ok) await call(s0, "browser_publish_cancel", { browserId: b1.browserId, publishId: again.sc.publishId });
    results.scenarios.cancel = { toPreparingMs: round(parked.ms), cancelMs: round(cancelled.ms), heldForMs: 500 };
  }

  {
    const local = shared.path;
    const noDrive = local.replace(/^[A-Za-z]:/, "");
    const drive = local.slice(0, 1);
    const asWritten = /is a network or device path/;
    const atTheLink = /links to .* a network or device path/;
    const paths = [
      ["UNC", "\\\\unc-refusal.invalid\\share\\master.mp4", asWritten],
      ["UNC forward slashes", "//unc-refusal.invalid/share/master.mp4", asWritten],
      ["admin share to the real file", `\\\\localhost\\${drive}$${noDrive}`, asWritten],
      ["\\\\?\\UNC", "\\\\?\\UNC\\unc-refusal.invalid\\share\\master.mp4", asWritten],
      ["\\\\?\\ device to the real file", `\\\\?\\${local}`, asWritten],
      ["\\\\.\\ device to the real file", `\\\\.\\${local}`, asWritten],
      ["\\\\.\\pipe", "\\\\.\\pipe\\master.mp4", asWritten],
      ["\\??\\ NT path", `\\??\\${local}`, asWritten],
    ];
    const links = [
      ["file symlink to an unreachable UNC share", join(filesDir, "link-to-unc.mp4"), "\\\\unc-refusal.invalid\\share\\master.mp4", "file", "link-to-unc.mp4"],
      ["file symlink to the real file over the admin share", join(filesDir, "link-to-admin-share.mp4"), `\\\\127.0.0.1\\${drive}$${noDrive}`, "file", "link-to-admin-share.mp4"],
      ["directory symlink to the admin share, file inside", join(filesDir, "share-dir"), `\\\\127.0.0.1\\${drive}$${dirname(noDrive)}`, "dir", join("share-dir", basename(local))],
      ["relative symlink chain ending at a UNC share", join(filesDir, "hop-1.mp4"), "hop-2.mp4", "file", "hop-1.mp4"],
    ];
    try {
      symlinkSync("\\\\unc-refusal.invalid\\share\\master.mp4", join(filesDir, "hop-2.mp4"), "file");
      for (const [name, at, target, type, published] of links) {
        symlinkSync(target, at, type);
        paths.push([name, join(filesDir, published), atTheLink]);
      }
    } catch (error) {
      check("paths: symlinks could be made", false, `not run: ${error.code} (symlinks need Developer Mode or admin)`);
    }
    const rows = [];
    for (const [name, path, expected] of paths) {
      await approve(s0, { origin, profile: b3.profile, values: [`Stress ${b3.profile}`], files: { Video: { ...shared, path } } });
      const refused = await call(s0, "browser_publish", { browserId: b3.browserId, recipe: recipe(b3.profile, { path }), mode: "post", waitSeconds: 0 });
      const byWhat = expected.test(refused.text);
      rows.push({ name, path, refused: !refused.ok, byWhat, ms: round(refused.ms), error: refused.text.slice(0, 300) });
      check(`paths: ${name} refused by what it is`, !refused.ok && byWhat, `${round(refused.ms)} ms: ${refused.text.slice(0, 200)}`);
    }
    results.scenarios.paths = rows;
  }
} catch (error) {
  check("run completed", false, error.stack ?? String(error));
  for (const server of servers) if (server.tail.length) log(`server ${server.index} stderr tail:\n${server.tail.join("\n")}`);
} finally {
  for (const server of servers) await server.client.close().catch(() => undefined);
  await new Promise((done) => studio.close(done));
  studio.closeAllConnections?.();
}

function survivors() {
  const listed = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($env:STRESS_RUN_DIR) } | ForEach-Object { $c = $_.CommandLine -replace '\\s+', ' '; '{0} {1} {2}' -f $_.ProcessId, $_.Name, $c.Substring(0, [Math]::Min(160, $c.Length)) }) -join [char]10"],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, STRESS_RUN_DIR: runDir } },
  );
  return listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
let leaked = survivors();
const closedAt = performance.now();
while (leaked.length > 0 && performance.now() - closedAt < 20_000) {
  await sleep(1_000);
  leaked = survivors();
}
results.exitMs = round(performance.now() - closedAt);
check("no process of this run is left running 20 s after its servers closed", leaked.length === 0, leaked.join(" | "));

results.checks = checks;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(packDir, "bench", "results");
mkdirSync(outDir, { recursive: true });
const c = results.scenarios.concurrent;
const h = results.scenarios.hashRate;
const lines = [
  `# Publish stress ${results.startedAt}`,
  "",
  `${SERVERS} pack servers x ${BROWSERS_PER_SERVER} browsers, ${SIZE / MIB} MiB files, Node ${process.version}, idle loop max ${results.idle?.maxStallMs} ms, idle RSS ${results.idle?.peakRssMiB} MiB`,
  "",
  "| Measure | Value |",
  "| --- | --- |",
  ...(c
    ? [
        `| Concurrent publishes (+ duplicates) | ${c.publishes} (+${c.duplicates}) |`,
        `| Time to preparing p50 / p95 / max | ${c.toPreparingMs.p50} / ${c.toPreparingMs.p95} / ${c.toPreparingMs.max} ms |`,
        `| Duplicate refusal p50 / max | ${c.duplicateRefusalMs.p50} / ${c.duplicateRefusalMs.max} ms |`,
        `| Time to parked p50 / max | ${c.toParkedMs.p50} / ${c.toParkedMs.max} ms |`,
        `| Hashed and parked, all servers (bytes / time to the last park) | ${c.parkThroughputMBps} MB/s |`,
        `| Event-loop max stall / main-thread busy while hashing (worst server) | ${c.whileHashing.maxStallMs} ms (p99 ${c.whileHashing.worstP99Ms} ms) / ${c.whileHashing.loopBusy} |`,
        `| Peak server RSS while hashing / park to uploaded | ${c.whileHashing.peakRssMiB} / ${c.parkToUploaded.peakRssMiB} MiB |`,
        `| Upload duration p50 / max | ${c.uploadMs.p50} / ${c.uploadMs.max} ms |`,
      ]
    : []),
  ...(h
    ? [
        `| Solo hash throughput | ${h.hashMBps} MB/s (time to parked ${h.toParkedBigMs.join(", ")} ms vs ${h.toParkedTinyMs.join(", ")} ms for 1 byte) |`,
        `| Solo event-loop max stall / main-thread busy while hashing | ${h.whileHashing.maxStallMs} ms (p99 ${h.whileHashing.worstP99Ms} ms) / ${h.whileHashing.loopBusy}, RSS ${h.whileHashing.peakRssMiB} MiB |`,
      ]
    : []),
  ...(results.scenarios.hostWait ? [`| waitSeconds 1, page held 3 s: preparing / parked | ${results.scenarios.hostWait.toPreparingMs} / ${results.scenarios.hostWait.toParkedMs} ms |`] : []),
  ...(results.scenarios.cancel ? [`| Cancel while preparing (page held 500 ms more) | ${results.scenarios.cancel.cancelMs} ms |`] : []),
  ...(results.scenarios.swap ? [`| Swap after park started: failed in | ${results.scenarios.swap.failedMs} ms |`] : []),
  "",
  "| Check | Result | Detail |",
  "| --- | --- | --- |",
  ...checks.map((entry) => `| ${entry.name} | ${entry.pass ? "PASS" : "FAIL"} | ${String(entry.detail ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 300)} |`),
];
writeFileSync(join(outDir, `${stamp}-publish-stress.md`), `${lines.join("\n")}\n`);
writeFileSync(join(outDir, `${stamp}-publish-stress.json`), `${JSON.stringify(results, null, 2)}\n`);
console.log(lines.join("\n"));
console.log(`\nReport: ${join(outDir, `${stamp}-publish-stress.md`)}`);
cleanup();
process.exit(checks.every((entry) => entry.pass) ? 0 : 1);
