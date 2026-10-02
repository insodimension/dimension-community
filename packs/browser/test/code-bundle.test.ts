/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the pack as it ships. The server runs as `node app/server.mjs`, its code worker as `app/code-worker.mjs` beside it (the two esbuild entries), under
 * Node, not Bun: a worker that does not start from the bundle, a stray write that corrupts the MCP stream, a cell that can read the server's keys, a runaway cell that takes the server down with
 * it, a server that exits and leaves a Chrome behind, a `browser_state` that waits for a cell to finish.
 *
 * The two bundles are built into a temp folder exactly as scripts/build.mjs builds them, `node` runs the server, and a plain JSON-RPC client speaks MCP to it over stdio. Real Chrome.
 * The numbers the PR reports (cold and warm open, 20 `tab.url()`, `browser_state` while a cell spins) are measured here and printed to stderr.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { chromePidsByThrowaway, isAlive } from "./chrome-processes";
import { startPages, type Pages } from "./code-host-fixture";
import { BROWSER_TEST_TIMEOUT_MS, chromePath, waitUntil } from "./fixture";

const PACK = fileURLToPath(new URL("..", import.meta.url));
// The runtime under test: the `node` on PATH, or the one BROWSER_TEST_NODE names (a Node of another version, to run the same proofs on it).
const NODE = process.env.BROWSER_TEST_NODE ?? Bun.which("node");
/** Whether this Node can read a worker's own memory (`Worker.getHeapStatistics()`, Node 22.16+ and 24). Without it the watchdog reads the whole process: the commit charge on Windows (through a helper), the resident set elsewhere. */
const WORKER_MEMORY_IS_OWN = NODE !== null && spawnSync(NODE, ["-p", "typeof require('node:worker_threads').Worker.prototype.getHeapStatistics"], { encoding: "utf8" }).stdout.trim() === "function";
const describeBundle = chromePath === undefined || NODE === null ? describe.skip : describe;

let pages: Pages;
let out = "";

beforeAll(async () => {
  pages = await startPages();
  out = mkdtempSync(join(tmpdir(), "dimension-browser-bundle-"));
  // The shipped layout: the bundles and the built View in app/, the presets beside it, the packages above.
  const app = join(out, "app");
  const bundle = { bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", sourcemap: false, loader: { ".txt": "text", ".md": "text" } } as const;
  await build({ ...bundle, entryPoints: [join(PACK, "src/stdio.ts")], outfile: join(app, "server.mjs"), logLevel: "silent" });
  await build({ ...bundle, entryPoints: [join(PACK, "src/code/worker/entry.ts")], outfile: join(app, "code-worker.mjs"), logLevel: "silent" });
  cpSync(join(PACK, "app/dist"), join(app, "dist"), { recursive: true });
  cpSync(join(PACK, "recipes"), join(out, "recipes"), { recursive: true });
  // The task worker runs from `python/` beside `app/`, as the pack ships it (package.json `files`).
  cpSync(join(PACK, "python"), join(out, "python"), { recursive: true, filter: source => !source.includes(".venv") && !source.includes("__pycache__") });
  // The bundles leave their packages external, as the shipped ones do; they find them through this link.
  symlinkSync(fileURLToPath(new URL("../../../../node_modules", import.meta.url)), join(out, "node_modules"), "junction");
}, 60_000);


interface ToolAnswer { isError?: boolean; content: Array<{ type: string; text?: string }> }

/** The server under test: a child `node` process, spoken to in newline-delimited JSON-RPC. */
class Server {
  readonly #proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  readonly #pending = new Map<number, PromiseWithResolvers<{ result?: unknown; error?: { message: string } }>>();
  readonly stray: string[] = [];
  stderr = "";
  #next = 1;

  constructor(readonly root: string, env: Record<string, string>) {
    this.#proc = Bun.spawn([NODE as string, join(out, "app", "server.mjs")], {
      cwd: out,
      env: { ...(process.env as Record<string, string>), DIMENSION_BROWSER_ROOT: root, ...env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.#read(this.#proc.stdout, line => this.#line(line));
    void this.#read(this.#proc.stderr, line => void (this.stderr += `${line}\n`));
  }

  get pid(): number {
    return this.#proc.pid;
  }

  get exited(): Promise<number> {
    return this.#proc.exited;
  }

  async #read(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (line.length > 0) onLine(line);
      }
    }
  }

  #line(line: string): void {
    let message: { id?: number; result?: unknown; error?: { message: string } };
    try {
      message = JSON.parse(line);
    } catch {
      this.stray.push(line);
      return;
    }
    if (typeof message.id === "number") this.#pending.get(message.id)?.resolve(message);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = this.#next++;
    const gate = Promise.withResolvers<{ result?: unknown; error?: { message: string } }>();
    this.#pending.set(id, gate);
    this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const answer = await gate.promise;
    this.#pending.delete(id);
    if (answer.error !== undefined) throw new Error(answer.error.message);
    return answer.result;
  }

  async start(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "code-bundle-test", version: "0" } });
    this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  async call(name: string, args: Record<string, unknown>, session = "s1"): Promise<ToolAnswer> {
    return (await this.request("tools/call", { name, arguments: args, _meta: { "ai.insodimension/caller": "model", "ai.insodimension/session": { sessionId: session } } })) as ToolAnswer;
  }

  /** What a host does when it lets a pack go, at its mildest: it closes the pack's stdin and waits as long as it takes. */
  async end(): Promise<number> {
    if (!this.#ended) {
      this.#ended = true;
      this.#proc.stdin.end();
    }
    return await this.#proc.exited;
  }
  #ended = false;

  /**
   * What the engine's app host does (the SDK's StdioClientTransport.close, @modelcontextprotocol/sdk/dist/esm/client/stdio.js): end stdin, wait 2,000 ms, then SIGTERM, which Node turns into TerminateProcess on
   * Windows - nothing in the server runs after it. OMP's own transport sends SIGTERM straight after ending stdin, which no server can answer on Windows; this is the window a server can use.
   */
  async endLikeTheSdk(): Promise<{ ms: number; killedByTheHost: boolean }> {
    const began = performance.now();
    this.#ended = true;
    this.#proc.stdin.end();
    const itself = await Promise.race([this.#proc.exited.then(() => true), new Promise<boolean>(resolve => setTimeout(resolve, 2_000, false))]);
    if (!itself) {
      this.#proc.kill();
      await this.#proc.exited;
    }
    return { ms: performance.now() - began, killedByTheHost: !itself };
  }

  kill(): void {
    if (isAlive(this.#proc.pid)) this.#proc.kill();
  }
}

const text = (answer: ToolAnswer): string => answer.content.map(part => part.text ?? "").join("\n");

const servers: Server[] = [];
async function launch(env: Record<string, string> = {}): Promise<Server> {
  const root = mkdtempSync(join(tmpdir(), "dimension-browser-bundle-root-"));
  const server = new Server(root, env);
  servers.push(server);
  await server.start();
  return server;
}
/** A server is let go the way a host lets it go (stdin closed), so its Chrome goes with it; a hard kill is only the fallback. After EVERY test: a server (a Node, a worker, a Chrome) left to the end of the file piles up with the next test's. */
async function retireServers(): Promise<void> {
  for (const server of servers.splice(0)) {
    const exited = await Promise.race([server.end(), new Promise<undefined>(resolve => setTimeout(resolve, 20_000, undefined))]);
    if (exited === undefined) server.kill();
    await server.exited;
    rmSync(server.root, { recursive: true, force: true });
  }
}
afterEach(retireServers);
afterAll(async () => {
  await retireServers();
  await pages.close();
  rmSync(out, { recursive: true, force: true });
});

describeBundle("the shipped server, under Node", () => {
  test("browser_run is on by default and drives a page through the bundled worker; the cell is handed a scrubbed environment without the server's keys (accident-proofing, not a boundary) and writes nothing onto the MCP stream", async () => {
    const server = await launch({ TYPESAFE_API_KEY: "sk-test-secret", DIMENSION_BROWSER_CODE_ISOLATION: "thread" });
    const tools = (await server.request("tools/list", {})) as { tools: Array<{ name: string }> };
    expect(tools.tools.map(tool => tool.name)).toContain("browser_run");
    const answer = await server.call("browser_run", {
      code: `
        const threads = await import("node:worker_threads");
        process.stdout.write("stray write\\n");
        console.log("stray log");
        const tab = await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/form"))} });
        await tab.fill("#name", "Ada");
        await tab.click("#go");
        await tab.waitForSelector("#out");
        await tab.screenshot();
        JSON.stringify({ worker: !threads.isMainThread, key: process.env.TYPESAFE_API_KEY ?? null, out: await tab.evaluate(() => document.getElementById("out").textContent) });`,
    });
    expect(answer.isError).toBeFalsy();
    expect(answer.content[0]?.type).toBe("image");
    expect(text(answer)).toContain('Opened tab "main" on headless browser (hidden)');
    expect(text(answer)).toContain('{"worker":true,"key":null,"out":"hello:Ada"}');
    expect(server.stray).toEqual([]);
    // The server goes when its host lets go of its stdin, and takes its Chrome and its worker with it.
    const running = [...(await chromePidsByThrowaway(server.root)).values()];
    expect(running).toHaveLength(1);
    const exit = await server.end();
    expect(exit).toBe(0);
    await waitUntil("every process of the server gone, by pid", async () => [...(await chromePidsByThrowaway(server.root)).values()].flatMap(chrome => chrome.all).filter(isAlive).length, alive => alive === 0, 15_000);
    expect(isAlive(server.pid)).toBe(false);
  }, BROWSER_TEST_TIMEOUT_MS);

  // The built bundle, as the review ran it: a second session's cell read TYPESAFE_API_KEY and a DIMENSION_* secret out of `process.report.getReport().environmentVariables`, which is the process's whole environment block,
  // whatever the worker's own `process.env` was scrubbed to. The keys are taken out of the block when the server starts (src/secrets.ts). A positive control keeps an empty report from passing: it carries DIMENSION_BROWSER_ROOT.
  test("a cell cannot read the pack's keys from process.env, from process.report, or from the environment of a child process it starts; the task tools are still listed", async () => {
    const secrets = { TYPESAFE_API_KEY: "sk-typesafe-5f1c2a", TEXT_MODEL_API_KEY: "sk-model-77ab31", DIMENSION_FAKE_SECRET: "fake-dimension-secret-93de08" };
    const server = await launch(secrets);
    const tools = (await server.request("tools/list", {})) as { tools: Array<{ name: string }> };
    expect(tools.tools.map(tool => tool.name)).toContain("browser_task"); // the key counts although it is no longer in the environment
    const answer = await server.call("browser_run", {
      code: `
        const { execFileSync } = await import("node:child_process");
        const child = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], { encoding: "utf8" });
        JSON.stringify({ env: process.env, report: process.report.getReport().environmentVariables, child: JSON.parse(child) })`,
    }, "s2");
    expect(answer.isError).toBeFalsy();
    const seen = JSON.parse(text(answer).split("\n").at(-1) as string) as { env: Record<string, string>; report: Record<string, string>; child: Record<string, string> };
    for (const where of ["env", "report", "child"] as const) {
      const block = JSON.stringify(seen[where]);
      for (const [name, value] of Object.entries(secrets)) {
        expect(block).not.toContain(value);
        expect(Object.keys(seen[where]).map(key => key.toUpperCase())).not.toContain(name);
      }
    }
    // The report is the process's real environment block: it carries the server's own setting, so an empty one would not have passed.
    expect(seen.report.DIMENSION_BROWSER_ROOT).toBe(server.root);
  }, BROWSER_TEST_TIMEOUT_MS);

  // The task worker gets its keys from the server, not from the environment block: the real python worker checks them first, and says which one is missing.
  const PYTHON = process.env.DIM_BROWSER_PYTHON?.trim() || join(PACK, "python", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  test.skipIf(!existsSync(PYTHON))("browser_task still reaches jev with the keys the server was started with: the python worker is handed them although the environment no longer carries them", async () => {
    for (const [env, expectation] of [
      [{ TYPESAFE_API_KEY: "sk-typesafe-5f1c2a" }, "jev needs TEXT_MODEL_API_KEY in the browser server's environment."],
      [{ TYPESAFE_API_KEY: "sk-typesafe-5f1c2a", TEXT_MODEL_API_KEY: "sk-model-77ab31" }, undefined],
    ] as const) {
      const server = await launch({ ...env, DIM_BROWSER_PYTHON: PYTHON });
      const opened = await server.call("browser_open", {});
      const { browserId } = JSON.parse(text(opened)) as { browserId: string };
      const task = await server.call("browser_task", { browserId, task: "say hi", waitSeconds: 25 });
      const said = text(task);
      if (expectation !== undefined) expect(said).toContain(expectation);
      else expect(said).not.toContain("jev needs"); // both keys arrived; whatever fails next is the library, not the keys
      expect(said).not.toContain("TYPESAFE_API_KEY and");
      await retireServers();
    }
  }, BROWSER_TEST_TIMEOUT_MS * 2);

  test("what a cell costs: cold and warm open, 20 sequential tab.url(), and browser_state while a cell spins for 5 s", async () => {
    const server = await launch();
    const url = pages.url("/other");
    const began = performance.now();
    const cold = await server.call("browser_run", { code: `const t0 = performance.now(); await browser.open({ name: "main", url: ${JSON.stringify(url)} }); Math.round(performance.now() - t0)` });
    const coldCall = performance.now() - began;
    expect(cold.isError).toBeFalsy();
    const coldInside = Number(text(cold).split("\n").at(-1));
    const warm = await server.call("browser_run", { code: `const t0 = performance.now(); await browser.open({ name: "second", url: ${JSON.stringify(url)} }); Math.round(performance.now() - t0)` });
    const warmTab = Number(text(warm).split("\n").at(-1));
    const urls = await server.call("browser_run", { code: `const tab = browser.tab("main"); const t0 = performance.now(); for (let i = 0; i < 20; i++) await tab.url(); Math.round(performance.now() - t0)` });
    const twentyUrls = Number(text(urls).split("\n").at(-1));
    const reopen = await server.call("browser_run", { code: `await browser.close({ all: true }); const t0 = performance.now(); await browser.open({ name: "again", url: ${JSON.stringify(url)} }); Math.round(performance.now() - t0)` });
    const warmBrowser = Number(text(reopen).split("\n").at(-1));
    // browser_state, asked while a cell spins in a synchronous loop for 5 s.
    const spin = server.call("browser_run", { code: "const t0 = Date.now(); while (Date.now() - t0 < 5000) {} 1", timeout: 20 });
    const latencies: number[] = [];
    for (let sample = 0; sample < 5; sample += 1) {
      await new Promise(resolve => setTimeout(resolve, 600)); // real time: the cell spins in real time
      const asked = performance.now();
      const state = await server.call("browser_state", {});
      latencies.push(Math.round(performance.now() - asked));
      expect(state.isError).toBeFalsy();
    }
    expect(text(await spin)).toBe("1");
    const worst = Math.max(...latencies);
    console.error(`[code-bundle] cold browser.open ${coldInside} ms in the cell (${Math.round(coldCall)} ms for the whole first call: worker + Chrome); warm: a second tab ${warmTab} ms, a new browser after close ${warmBrowser} ms; 20 sequential tab.url() ${twentyUrls} ms; browser_state during a 5 s spin: ${latencies.join(", ")} ms`);
    expect(worst).toBeLessThan(1_000);
    expect(twentyUrls).toBeLessThan(2_000);
  }, BROWSER_TEST_TIMEOUT_MS);

  test("a cell that outgrows its worker's heap ends the worker, not the server; the next cell runs", async () => {
    const server = await launch({ DIMENSION_BROWSER_CODE_HEAP_MB: "64" });
    const failed = await server.call("browser_run", { code: "const keep = []; for (;;) keep.push(new Array(100000).fill(1));", timeout: 60 });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("ran out of memory");
    expect(text(failed)).toContain("variables were reset");
    expect(isAlive(server.pid)).toBe(true);
    const next = await server.call("browser_run", { code: "40 + 2" });
    expect(text(next)).toBe("42");
  }, BROWSER_TEST_TIMEOUT_MS);

  // The runaway as it really happens: `Buffer.alloc` is calloc, whose pages are COMMITTED at once and RESIDENT only when touched, so a loop that never touches what it allocates grows the machine's commit while the resident
  // set stays put. Both kinds are held at the limit on every Node the pack supports, by the allocation guard in the worker (worker/memory-guard.ts): it asks before it allocates, so no look at an interval is needed. A
  // synchronous burst allocates 880 MB before the first look of a watchdog (measured), and this one stops at the limit.
  for (const touched of [false, true]) {
    test(`a synchronous burst of 100 MB ${touched ? "touched" : "untouched"} Buffers is refused at the limit of 300 MB, before any look at an interval: at most three of ten are made, and the worker and its variables live`, async () => {
      const server = await launch({ DIMENSION_BROWSER_CODE_MEMORY_MB: "300" });
      const fill = touched ? ", 1" : "";
      const burst = await server.call("browser_run", { code: `const keep = []; const names = []; for (let i = 0; i < 10; i++) { try { keep.push(Buffer.alloc(100e6${fill})); } catch (error) { names.push(error.name); } } JSON.stringify({ kept: keep.length, refused: names.length, name: names[0] })` });
      expect(burst.isError).toBeFalsy();
      const { kept, refused, name } = JSON.parse(text(burst).split("\n").at(-1) as string) as { kept: number; refused: number; name: string };
      console.error(`[code-bundle] allocation guard (${touched ? "touched" : "untouched"} Buffers, limit 300 MB): ${kept} of 10 allocations of 100 MB were made in one synchronous burst, ${refused} refused with ${name}`);
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThanOrEqual(3);
      expect(refused).toBe(10 - kept);
      expect(name).toBe("CellMemoryError");
      // Refused in the cell, not ended: the worker is the same one, and what the cell kept is still there.
      expect(text(await server.call("browser_run", { code: "keep.length" }))).toBe(String(kept));
      expect(isAlive(server.pid)).toBe(true);
    }, BROWSER_TEST_TIMEOUT_MS);
  }

  test("a refusal that nothing catches ends that cell with the reason and its limit, and the next cell runs", async () => {
    const server = await launch({ DIMENSION_BROWSER_CODE_MEMORY_MB: "300" });
    const failed = await server.call("browser_run", { code: "const keep = []; for (;;) keep.push(Buffer.alloc(100e6));", timeout: 60 });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toContain("CellMemoryError");
    expect(text(failed)).toContain("the limit is 300 MB");
    expect(text(failed)).toContain("DIMENSION_BROWSER_CODE_MEMORY_MB");
    expect(text(await server.call("browser_run", { code: "40 + 2" }))).toBe("42");
    expect(isAlive(server.pid)).toBe(true);
  }, BROWSER_TEST_TIMEOUT_MS);

  // What the guard does not see: memory that is not allocated through the worker's own `Buffer`, `ArrayBuffer` or typed arrays. `WebAssembly.Memory` is one such path (measured: ten of 100 MB were not refused at a limit of
  // 300 MB and showed as 962 MB held). Those reach the host's watchdog only, which looks every 100 ms, with a cell or without one.
  const memorySource = WORKER_MEMORY_IS_OWN ? "the worker's own figure" : process.platform === "win32" ? "the process's commit charge (helper)" : "the process's resident set";
  for (const touched of [false, true]) {
    const nothingToSee = !touched && !WORKER_MEMORY_IS_OWN && process.platform !== "win32";
    test.skipIf(nothingToSee)(`${touched ? "touched" : "untouched"} WebAssembly.Memory, which the guard cannot see, in a loop is ended by the memory watchdog within seconds: the server, its other Chrome and the next cell are untouched`, async () => {
      const server = await launch({ DIMENSION_BROWSER_CODE_MEMORY_MB: "300" });
      // Another session with a browser of its own, which must come through.
      const other = await server.call("browser_run", { code: `const tab = await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/other"))} }); await tab.title()` }, "s2");
      expect(text(other)).toContain("Other page");
      const before = [...(await chromePidsByThrowaway(server.root)).values()].flatMap(chrome => chrome.all).sort();
      const progress = join(server.root, "allocations.txt");
      // Ten 100 MB memories at most, one every 50 ms, in a synchronous loop that never gives the worker a turn (the case a heap limit and a timer inside the worker both miss). With the watchdog it stops at about four: the
      // test's own bound is that the file never shows more than seven, i.e. less than 700 MB, and the call answers well inside the budget.
      const touch = touched ? " new Uint8Array(memory.buffer).fill(1);" : "";
      const code = `const fs = await import("node:fs"); const keep = []; for (let i = 0; i < 10; i++) { const memory = new WebAssembly.Memory({ initial: 1526 }); keep.push(memory);${touch} fs.appendFileSync(${JSON.stringify(progress)}, "x"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } "survived"`;
      const began = performance.now();
      const failed = await server.call("browser_run", { code, timeout: 60 }, "s1");
      const tookMs = performance.now() - began;
      const allocated = existsSync(progress) ? statSync(progress).size : 0;
      console.error(`[code-bundle] memory watchdog (${memorySource}, ${touched ? "touched" : "untouched"} WebAssembly.Memory, limit 300 MB): the cell was ended after ${allocated} of 10 allocations of 100 MB, the call answered in ${Math.round(tookMs)} ms`);
      expect(failed.isError).toBe(true);
      expect(text(failed)).toContain("CellMemoryError");
      expect(text(failed)).toContain("the limit is 300 MB");
      expect(text(failed)).toContain("variables were reset");
      expect(allocated).toBeGreaterThan(0);
      expect(allocated).toBeLessThanOrEqual(7);
      expect(tookMs).toBeLessThan(8_000);
      expect(isAlive(server.pid)).toBe(true);
      expect([...(await chromePidsByThrowaway(server.root)).values()].flatMap(chrome => chrome.all).sort()).toEqual(before);
      // The other session's page still answers, and this session has a worker again.
      expect(text(await server.call("browser_run", { code: `await browser.tab("main").title()` }, "s2"))).toContain("Other page");
      expect(text(await server.call("browser_run", { code: "40 + 2" }, "s1"))).toBe("42");
    }, BROWSER_TEST_TIMEOUT_MS);
  }

  // The window the review measured: a cell returns, and its `setInterval` goes on allocating. The watchdog used to look at an idle worker every 5 s; the server held 1.2 GB for that long before the log line. Twelve
  // memories of 50 MB at most (the test's own bound is 600 MB), one every 20 ms, through the one path the guard does not see.
  test.skipIf(!WORKER_MEMORY_IS_OWN && process.platform !== "win32")("a timer a cell left behind keeps allocating after the cell returned: the watchdog ends the worker within a second of the return, not five", async () => {
    const server = await launch({ DIMENSION_BROWSER_CODE_MEMORY_MB: "300" });
    const code = `globalThis.held = []; let made = 0; const timer = setInterval(() => { if (made++ >= 12) return clearInterval(timer); held.push(new WebAssembly.Memory({ initial: 763 })); }, 20); "returned"`;
    const returned = await server.call("browser_run", { code });
    const returnedAt = performance.now();
    expect(text(returned)).toBe("returned");
    await waitUntil("the worker is ended", () => server.stderr.includes("a code worker held"), ended => ended, 10_000);
    const endedAfterMs = Math.round(performance.now() - returnedAt);
    console.error(`[code-bundle] a timer left behind by a returned cell (${memorySource}, limit 300 MB): the worker was ended ${endedAfterMs} ms after the cell returned`);
    expect(endedAfterMs).toBeLessThan(1_000);
    expect(text(await server.call("browser_run", { code: "typeof held" }))).toBe("undefined");
    expect(isAlive(server.pid)).toBe(true);
  }, BROWSER_TEST_TIMEOUT_MS);

  // The shipped server, with and without jev's key: the password refusal a cell gets names browser_view and never a tool the cell's space does not have (the step tools, and Traction's task tools with the key).
  // test/code-password-routes.test.ts holds it per space in-process; this holds the shipped path.
  for (const [label, env] of [["without TYPESAFE_API_KEY", {}], ["with TYPESAFE_API_KEY", { TYPESAFE_API_KEY: "sk-test-secret" }]] as const) {
    test(`the password refusal names browser_view and no step tool or task tool (${label})`, async () => {
      const server = await launch({ ...env });
      const refused = await server.call("browser_run", { code: `const tab = await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/password"))} }); await tab.fill("#pw", "hunter2")` });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain("is a password field");
      expect(text(refused)).toContain("browser_view({ profile })");
      for (const hidden of ["browser_act", "browser_open", "browser_task"]) expect(text(refused)).not.toContain(hidden);
    }, BROWSER_TEST_TIMEOUT_MS);
  }

  /**
   * A cell inside a 45 s `execSync` that nothing can interrupt, with a Chrome open: the sleeper child process says its own pid first, so the test can look for it by pid afterwards. The host ends the server the way
   * `end` says; the server, its Chrome and the cell's child must be gone by pid whatever the host does after that.
   */
  async function stuckCell(): Promise<{ server: Server; chromePids: number[]; sleeperPid: number }> {
    const server = await launch();
    const pidFile = join(server.root, "sleeper.pid");
    const sleeper = `"${NODE}" -e "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 45000)" "${pidFile}"`;
    const code = `await browser.open({ name: "main", url: ${JSON.stringify(pages.url("/other"))} }); const { execSync } = await import("node:child_process"); execSync(${JSON.stringify(sleeper)}); 1`;
    // The call never answers (the server is gone before the 45 s are up); the test is not waiting for it.
    void server.call("browser_run", { code, timeout: 120 }).catch(() => undefined);
    await waitUntil("the cell is inside its native call", () => existsSync(pidFile), present => present, 40_000);
    const chromePids = [...(await chromePidsByThrowaway(server.root)).values()].flatMap(chrome => chrome.all);
    const sleeperPid = Number(readFileSync(pidFile, "utf8"));
    expect(chromePids.length).toBeGreaterThan(0);
    expect(isAlive(sleeperPid)).toBe(true);
    return { server, chromePids, sleeperPid };
  }

  test("a cell stuck in a 45 s native call does not keep the server, its Chrome or the cell's child process alive: the host closes stdin and waits, and all three are gone within 3 s", async () => {
    const { server, chromePids, sleeperPid } = await stuckCell();
    const began = performance.now();
    await server.end();
    const tookMs = performance.now() - began;
    console.error(`[code-bundle] stdin closed with a cell inside a 45 s native call (the host waits): the server exited after ${Math.round(tookMs)} ms`);
    // By pid, from the operating system: neither the pack's bookkeeping nor an exit code says a process is gone.
    expect(isAlive(server.pid)).toBe(false);
    expect(await waitUntil("every Chrome of the session gone, by pid", () => chromePids.filter(isAlive), alive => alive.length === 0, 10_000)).toEqual([]);
    expect(tookMs).toBeLessThan(3_000);
    // Windows has no process group: the server ends the cell's child itself. Elsewhere nothing does yet (stated in the PR), and the test cleans it up.
    if (process.platform === "win32") expect(isAlive(sleeperPid)).toBe(false);
    else process.kill(sleeperPid, "SIGKILL");
  }, BROWSER_TEST_TIMEOUT_MS);

  test("the same cell, with the host that kills the server 2 s after closing stdin (the SDK's client): the server ends itself inside that window and nothing is orphaned - the cell's child and every Chrome are gone by pid", async () => {
    const { server, chromePids, sleeperPid } = await stuckCell();
    const { ms, killedByTheHost } = await server.endLikeTheSdk();
    console.error(`[code-bundle] stdin closed with a cell inside a 45 s native call (the host kills at 2 s): the server exited ${killedByTheHost ? "only when killed, at" : "by itself after"} ${Math.round(ms)} ms`);
    expect(killedByTheHost).toBe(false);
    expect(ms).toBeLessThan(2_000);
    expect(isAlive(server.pid)).toBe(false);
    expect(await waitUntil("every Chrome of the session gone, by pid", () => chromePids.filter(isAlive), alive => alive.length === 0, 5_000)).toEqual([]);
    if (process.platform === "win32") expect(isAlive(sleeperPid)).toBe(false);
    else process.kill(sleeperPid, "SIGKILL");
  }, BROWSER_TEST_TIMEOUT_MS);
});
