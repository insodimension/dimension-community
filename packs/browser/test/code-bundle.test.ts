/**
 * WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the pack as it ships. The server runs as `node app/server.mjs`, its code worker as `app/code-worker.mjs` beside it (the two esbuild entries), under
 * Node, not Bun: a worker that does not start from the bundle, a stray write that corrupts the MCP stream, a cell that can read the server's keys, a runaway cell that takes the server down with
 * it, a server that exits and leaves a Chrome behind, a `browser_state` that waits for a cell to finish.
 *
 * The two bundles are built into a temp folder exactly as scripts/build.mjs builds them, `node` runs the server, and a plain JSON-RPC client speaks MCP to it over stdio. Real Chrome.
 * The numbers the PR reports (cold and warm open, 20 `tab.url()`, `browser_state` while a cell spins) are measured here and printed to stderr.
 */
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { build } from "esbuild";
import { chromePidsByThrowaway, isAlive } from "./chrome-processes";
import { startPages, type Pages } from "./code-host-fixture";
import { BROWSER_TEST_TIMEOUT_MS, chromePath, waitUntil } from "./fixture";

const PACK = fileURLToPath(new URL("..", import.meta.url));
const NODE = Bun.which("node");
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

  /** What a host does when it lets a pack go: it closes the pack's stdin. */
  async end(): Promise<number> {
    if (!this.#ended) {
      this.#ended = true;
      this.#proc.stdin.end();
    }
    return await this.#proc.exited;
  }
  #ended = false;

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
afterAll(async () => {
  // A server is let go the way a host lets it go (stdin closed), so its Chrome goes with it; a hard kill is only the fallback.
  for (const server of servers) {
    const exited = await Promise.race([server.end(), new Promise<undefined>(resolve => setTimeout(resolve, 20_000, undefined))]);
    if (exited === undefined) server.kill();
    await server.exited;
    rmSync(server.root, { recursive: true, force: true });
  }
  await pages.close();
  rmSync(out, { recursive: true, force: true });
});

describeBundle("the shipped server, under Node", () => {
  test("browser_run is on by default and drives a page through the bundled worker; the cell sees no key and writes nothing onto the MCP stream", async () => {
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
});
