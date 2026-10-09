// A plain-Node host for the real code worker, driven over stdin/stdout JSON lines by a test: `node node-host.mjs <worker bundle> <tab handle json> [init json]`.
// The product runs the worker as a Node worker thread (`node app/server.mjs`); `bun test` cannot stand in for that where unhandled rejections matter, because the bun test runner ends any worker thread that has an
// unhandled rejection, listeners or not. This starts the bundle in a worker thread, answers the cell's one `open` with the tab the test launched, and reports everything the worker says (and how it ends) as one JSON
// object per line.
//
// The thread is started the way PR #163's host starts it (src/code/host/transport.ts `threadWorkerSpawner`): `new Worker(entry, { env, stdout: true, stderr: true, resourceLimits })` with no `execArgv`, `env` the
// scrubbed environment (the same keys code-host.ts's `CELL_ENV` keeps, copied here because #163 is a different branch: change both together), the same scrubbed env sent again in `init`, and the heap limit
// (`DEFAULT_HEAP_MB`, 1,024; NODE_HOST_HEAP_MB makes it smaller for a test that must see a worker run out of heap). The worker's stdout and stderr are held back from the host's and forwarded to its stderr, as there. What this does not copy: the host's own supervision (timeouts, memory polling, recycling).
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";

const [bundle, handleJson, initJson] = process.argv.slice(2);
const handle = JSON.parse(handleJson);
const out = line => process.stdout.write(`${JSON.stringify(line)}\n`);

const CELL_ENV = /^(?:PATH|Path|PATHEXT|SystemRoot|SYSTEMROOT|windir|WINDIR|ComSpec|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LANG|LANGUAGE|LC_[A-Z_]+|TZ|PUPPETEER_[A-Z_]+)$/;
const env = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && CELL_ENV.test(key)) env[key] = value;

const worker = new Worker(bundle, { env, stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: Number(process.env.NODE_HOST_HEAP_MB) || 1_024 } });
worker.stdout?.on("data", chunk => process.stderr.write(chunk));
worker.stderr?.on("data", chunk => process.stderr.write(chunk));
worker.on("message", message => {
  out(message);
  if (message.t === "bridge" && message.request.action === "open") {
    worker.postMessage({ t: "bridge-reply", id: message.id, ok: true, value: { text: 'Opened tab "main"', details: { action: "open", name: "main", url: handle.url }, attach: handle } });
  }
});
worker.on("error", error => out({ t: "worker-error", message: error.message }));
worker.on("exit", code => {
  out({ t: "worker-exit", code });
  process.exit(0);
});
worker.postMessage({ t: "init", session: "s1", env, ...(initJson ? JSON.parse(initJson) : {}) });
createInterface({ input: process.stdin }).on("line", line => worker.postMessage(JSON.parse(line)));
