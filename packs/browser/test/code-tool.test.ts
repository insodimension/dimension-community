/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the model's one way of driving a page. A result whose images come after the text, or a 200 KB
 *  print that is not capped, or a failure that is not an error, misleads or floods the model; a call that waits longer than the host's 30 s is
 *  killed by the host and the cell's work is lost; a cancelled request that does not stop the cell leaves a hung page behind; and a visibility
 *  switch that is wrong either hides the only way to drive a page or shows the model both sets of tools (the token cost the owner ruled out).
 *
 *  The code host (a worker per session, owned by lane L2) is a fake that keeps the port's contract; the MCP server is the real one.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { CodeHostPort, ImageBlock, RunError, RunResult, RunStarted } from "../src/code/contracts.js";
import { ToolAbortError } from "../src/code/errors.js";
import { BROWSER_RUN_DESCRIPTION, MAX_INLINE_BYTES, runCodeTool, SPILL_FILES_KEPT, type CodeToolDeps } from "../src/code/tool.js";
import type { BrowserRuntimePort } from "../src/contracts.js";
import { createBrowserServer, type ModelToolsMode } from "../src/server.js";

const SESSION_KEY = "ai.insodimension/session";
const clients: Client[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const Reply = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional(), data: z.string().optional(), mimeType: z.string().optional() })),
  structuredContent: z.unknown().optional(),
});
type Reply = z.infer<typeof Reply>;

interface Seen { kind: "run" | "resume"; session: string; code?: string; runId?: string; timeoutMs?: number; waitMs: number; signal: AbortSignal }
interface FakeHost extends CodeHostPort { seen: Seen[] }

/** A host whose answers are scripted; it records every call it gets. */
function fakeHost(answer: (call: Seen) => Promise<RunStarted> | RunStarted): FakeHost {
  const seen: Seen[] = [];
  const host: FakeHost = {
    seen,
    async run(session, o) {
      const call: Seen = { kind: "run", session, code: o.code, timeoutMs: o.timeoutMs, waitMs: o.waitMs, signal: o.signal };
      seen.push(call);
      return answer(call);
    },
    async resume(session, runId, waitMs, signal) {
      const call: Seen = { kind: "resume", session, runId, waitMs, signal };
      seen.push(call);
      return answer(call);
    },
    async dispose() {},
  };
  return host;
}

const shown = (...displays: RunResult["displays"]): RunStarted => ({ state: "done", result: { displays, screenshots: [] } });
const failedWith = (error: RunError): RunStarted => ({ state: "done", result: { error } });
const png: ImageBlock = { type: "image", data: "aGk=", mimeType: "image/png" };
const textOf = (reply: Reply): string => reply.content.flatMap(block => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");

async function stubRuntime(): Promise<{ runtime: BrowserRuntimePort; viewDir: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "browser-code-tool-"));
  dirs.push(root);
  const viewDir = join(root, "view");
  await mkdir(viewDir, { recursive: true });
  await writeFile(join(viewDir, "index.html"), "<!doctype html><title>view</title>");
  const runtime: Pick<BrowserRuntimePort, "connections" | "profileMeta" | "onConnectionsChanged" | "dispose"> = {
    connections: async () => ({}),
    profileMeta: async () => ({}),
    onConnectionsChanged: () => () => {},
    dispose: async () => {},
  };
  return { runtime: runtime as BrowserRuntimePort, viewDir, root };
}

/** The real MCP server over the stub runtime and the fake code host, reached the way a host reaches it. */
async function connect(host: CodeHostPort | undefined, modelTools?: ModelToolsMode): Promise<{ client: Client; root: string; call: (code: string | undefined, extra?: Record<string, unknown>, meta?: Record<string, unknown>) => Promise<Reply> }> {
  const { runtime, viewDir, root } = await stubRuntime();
  const server = await createBrowserServer({ runtime, viewDir, presets: [], ...(host ? { codeHost: host } : {}), ...(modelTools ? { modelTools } : {}), codeArtifactsDir: join(root, "artifacts") });
  const client = new Client({ name: "code-tool-test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  const call = async (code: string | undefined, extra: Record<string, unknown> = {}, meta?: Record<string, unknown>): Promise<Reply> =>
    Reply.parse(await client.callTool({ name: "browser_run", arguments: { ...(code === undefined ? {} : { code }), ...extra }, ...(meta ? { _meta: meta } : {}) }));
  return { client, root, call };
}

describe("what a cell's result looks like to the model", () => {
  test("the images come first, then ONE text block with the text parts joined by newlines", async () => {
    const { call } = await connect(fakeHost(() => shown({ type: "text", text: "a" }, png, { type: "text", text: "1" })));
    const reply = await call("display('a'); return 1");
    expect(reply.isError).toBeUndefined();
    expect(reply.content).toEqual([{ type: "image", data: "aGk=", mimeType: "image/png" }, { type: "text", text: "a\n1" }]);
    // The View never calls this tool, so nothing rides beside the text for it.
    expect(reply.structuredContent).toBeUndefined();
  });

  test("a cell that showed nothing says so instead of answering with an empty result", async () => {
    const { call } = await connect(fakeHost(() => shown()));
    expect(textOf(await call("const quiet = 1"))).toBe("(no output)");
  });

  test("a result over 50 KiB keeps the start and the end with a marker, and a footer names the file that holds all of it", async () => {
    const lines = Array.from({ length: 4_000 }, (_, i) => `line ${String(i).padStart(5, "0")} ${"é".repeat(20)}`);
    const full = lines.join("\n");
    const { call, root } = await connect(fakeHost(() => shown({ type: "text", text: full })));
    const reply = await call("print(big)");
    const text = textOf(reply);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_INLINE_BYTES);
    expect(text.startsWith(lines[0]!)).toBe(true);
    expect(text).toContain(lines[3_999]!);
    expect(text).toMatch(/\n\[…\d+B elided…\]\n/);
    // No multi-byte character is cut in two.
    expect(text).not.toContain("\uFFFD");
    const footer = /\n\[raw output: (.+)\]$/.exec(text);
    expect(footer).not.toBeNull();
    expect(footer![1]!.startsWith(join(root, "artifacts"))).toBe(true);
    expect(await readFile(footer![1]!, "utf8")).toBe(full);
  });

  test("a result at the cap is returned whole and writes no file", async () => {
    const fits = "x".repeat(MAX_INLINE_BYTES);
    const { call, root } = await connect(fakeHost(() => shown({ type: "text", text: fits })));
    expect(textOf(await call("print(fits)"))).toBe(fits);
    await expect(readdir(join(root, "artifacts"))).rejects.toThrow();
  });

  test("only the newest spilled outputs are kept", async () => {
    const big = "y".repeat(MAX_INLINE_BYTES + 10);
    const { call, root } = await connect(fakeHost(() => shown({ type: "text", text: big })));
    for (let i = 0; i < SPILL_FILES_KEPT + 3; i += 1) await call("print(big)");
    expect(await readdir(join(root, "artifacts"))).toHaveLength(SPILL_FILES_KEPT);
  });
});

describe("what a failed cell tells the model", () => {
  const partial: RunResult = { displays: [png, { type: "text", text: "before" }], screenshots: [] };

  test("a thrown error is a tool error: the output printed before it, then the error and the lines of the model's own code only", async () => {
    const stack = "TypeError: nope\n    at <anonymous> (browser-cell-r1.js:2:9)\n    at eval (browser-cell-r1.js:3:3)\n    at <anonymous> (file:///pack/src/code/cell/evaluator.ts:111:47)";
    const { call } = await connect(fakeHost(() => failedWith({ name: "TypeError", message: "nope", stack, isAbort: false, partial })));
    const reply = await call("throw new TypeError('nope')");
    expect(reply.isError).toBe(true);
    // A screenshot taken before the step that threw is still the model's to see.
    expect(reply.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(textOf(reply)).toBe("before\nTypeError: nope\n    at <anonymous> (browser-cell-r1.js:2:9)\n    at eval (browser-cell-r1.js:3:3)");
  });

  test("a budget that ran out and a cancellation are their message alone", async () => {
    const message = "Command timed out after 30 seconds. The JS worker was force-killed and its VM state was reset; variables from earlier cells are gone.";
    const budget = await connect(fakeHost(() => failedWith({ name: "CellTimeoutError", message, isAbort: false, budget: true, recoverTab: true, partial })));
    const timedOut = await budget.call("await new Promise(() => {})");
    expect(timedOut.isError).toBe(true);
    expect(textOf(timedOut)).toBe(`before\n${message}`);

    const cancel = await connect(fakeHost(() => failedWith({ name: "ToolAbortError", message: "Operation aborted", isAbort: true })));
    expect(textOf(await cancel.call("1"))).toBe("Operation aborted");
  });

  test("a TimeoutError the page raised is an ordinary failure: its name and the lines of the model's own code say which wait it was", async () => {
    const stack = "TimeoutError: Waiting for selector `#go` failed\n    at <anonymous> (browser-cell-r1.js:4:11)\n    at <anonymous> (file:///pack/src/code/worker/tab-ops.ts:90:3)";
    const { call } = await connect(fakeHost(() => failedWith({ name: "TimeoutError", message: "Waiting for selector `#go` failed", stack, isAbort: false })));
    const reply = await call("await browser.tab().waitForSelector('#go')");
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toBe("TimeoutError: Waiting for selector `#go` failed\n    at <anonymous> (browser-cell-r1.js:4:11)");
  });

  test("a refusal the host throws (a cell still running, an unknown run) reaches the model as it was written", async () => {
    const { call } = await connect(fakeHost(() => {
      throw new Error("busy: run r7 is still running. Call browser_run({ resume: \"r7\" }) first.");
    }));
    const reply = await call("1");
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toBe('busy: run r7 is still running. Call browser_run({ resume: "r7" }) first.');
  });

  for (const [what, args] of [["a new cell", { code: "await browser.tab().waitForSelector('#never')" }], ["a wait for a running one", { resume: "r1" }]] as const) {
    test(`a call for ${what} that the client cancels is handed to the host as a cancellation, within OMP's grace`, async () => {
      const started = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      const host = fakeHost(call => {
        started.resolve();
        call.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        return new Promise<RunStarted>((_resolve, reject) => call.signal.addEventListener("abort", () => reject(new ToolAbortError()), { once: true }));
      });
      const { client } = await connect(host);
      const controller = new AbortController();
      const pending = client.callTool({ name: "browser_run", arguments: args }, undefined, { signal: controller.signal });
      pending.catch(() => undefined);
      await started.promise;
      const cancelledAt = Date.now();
      controller.abort();
      await expect(pending).rejects.toBeDefined();
      // The real clock is the point here: OMP stops a cancelled cell within 750 ms.
      const grace = setTimeout(() => aborted.reject(new Error("the host was not told within 750 ms")), 750);
      await aborted.promise;
      clearTimeout(grace);
      expect(Date.now() - cancelledAt).toBeLessThan(750);
      expect(host.seen[0]!.kind).toBe("code" in args ? "run" : "resume");
    });
  }
});

describe("what the call accepts", () => {
  test("exactly one of code and resume", async () => {
    const host = fakeHost(() => shown({ type: "text", text: "ok" }));
    const { call } = await connect(host);
    const neither = await call(undefined);
    const both = await call("1", { resume: "r1" });
    for (const reply of [neither, both]) {
      expect(reply.isError).toBe(true);
      expect(textOf(reply)).toContain("exactly one of code");
    }
    expect(host.seen).toEqual([]);
  });

  test("the schema holds OMP's budget range and the code limit; an out-of-range call never reaches the host", async () => {
    const host = fakeHost(() => shown({ type: "text", text: "ok" }));
    const { call } = await connect(host);
    expect((await call("1", { timeout: 0 })).isError).toBe(true);
    expect((await call("1", { timeout: 301 })).isError).toBe(true);
    expect((await call("x".repeat(200_001))).isError).toBe(true);
    expect((await call("")).isError).toBe(true);
    expect(host.seen).toEqual([]);
    expect((await call("1", { timeout: 300 })).isError).toBeUndefined();
    expect(host.seen[0]!.timeoutMs).toBe(300_000);
  });

  test("the cell's budget defaults to 30 s", async () => {
    const host = fakeHost(() => shown({ type: "text", text: "ok" }));
    const { call } = await connect(host);
    await call("1");
    expect(host.seen[0]!.timeoutMs).toBe(30_000);
  });

  test("the host's session stamp names the session; a call with no stamp is one anonymous session", async () => {
    const host = fakeHost(() => shown({ type: "text", text: "ok" }));
    const { call } = await connect(host);
    await call("1", {}, { [SESSION_KEY]: { sessionId: "chat-7" } });
    await call("1", {}, { [SESSION_KEY]: { sessionId: "" } });
    await call("1");
    expect(host.seen.map(seen => seen.session)).toEqual(["chat-7", "anonymous", "anonymous"]);
  });
});

describe("the 25-second rule", () => {
  /**
   * A cell that takes `cellMs` of the real clock (the rule IS about elapsed time, so a fake clock would test nothing), answered the way the port promises:
   * `run` and `resume` wait up to `waitMs` and say `running` if the cell is not done.
   */
  function slowCell(cellMs: number): { host: CodeHostPort; calls: Array<{ kind: string; waitMs: number }> } {
    const calls: Array<{ kind: string; waitMs: number }> = [];
    let doneAt = 0;
    const wait = async (kind: string, waitMs: number): Promise<RunStarted> => {
      calls.push({ kind, waitMs });
      const remaining = Math.max(0, doneAt - Date.now());
      await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, remaining)));
      return doneAt <= Date.now() ? shown({ type: "text", text: "all of it" }) : { state: "running", runId: "r1", outputSoFar: "half of it\n" };
    };
    const host: CodeHostPort = {
      run: async (_session, o) => {
        doneAt = Date.now() + cellMs;
        return wait("run", o.waitMs);
      },
      resume: async (_session, _runId, waitMs) => wait("resume", waitMs),
      dispose: async () => {},
    };
    return { host, calls };
  }

  const deps = (host: CodeHostPort, waitCapMs: number): CodeToolDeps => ({
    host,
    sessionOf: () => "s",
    artifactsDir: () => join(tmpdir(), "browser-code-tool-unused"),
    meta: {},
    waitCapMs,
  });
  const extra = { signal: new AbortController().signal };

  test("a cell longer than the wait comes back as running with its output so far, and resume collects the rest", async () => {
    const { host, calls } = slowCell(300);
    const first = await runCodeTool(deps(host, 80), { code: "await slow()", timeout: 300 }, extra);
    expect(first.isError).toBeUndefined();
    expect(first.content).toHaveLength(1);
    const text = textOf(Reply.parse(first));
    expect(text.split("\n")[0]).toBe("running: r1");
    expect(text).toContain("half of it");
    expect(text).toContain('browser_run({ "resume": "r1" })');

    const second = await runCodeTool(deps(host, 500), { resume: "r1" }, extra);
    expect(second.content).toEqual([{ type: "text", text: "all of it" }]);
    expect(calls.map(call => call.kind)).toEqual(["run", "resume"]);
  });

  test("a cell that finishes inside the wait is answered by the one call", async () => {
    const { host, calls } = slowCell(10);
    const reply = await runCodeTool(deps(host, 500), { code: "1" }, extra);
    expect(reply.content).toEqual([{ type: "text", text: "all of it" }]);
    expect(calls).toHaveLength(1);
  });

  test("however long the cell's own budget, no call is asked to wait past 25 s", async () => {
    const host = fakeHost(() => shown({ type: "text", text: "ok" }));
    const { call } = await connect(host);
    await call("1", { timeout: 300 });
    await call(undefined, { resume: "r1" });
    expect(host.seen.map(seen => [seen.kind, seen.waitMs])).toEqual([["run", 25_000], ["resume", 25_000]]);
  });
});

describe("which tools the model is shown", () => {
  const STEP_TOOLS = ["browser_open", "browser_state", "browser_snapshot", "browser_inspect", "browser_screenshot", "browser_act"];
  const VIEW_SIDE = ["browser_view", "browser_read", "browser_profiles", "browser_close"];
  const listed = async (client: Client): Promise<Map<string, Record<string, unknown> | undefined>> =>
    new Map((await client.listTools()).tools.map(tool => [tool.name, tool._meta as Record<string, unknown> | undefined]));
  const SPACES = "ai.insodimension/spaces";

  test("code: browser_run is offered with the exec approval tier to the spaces that have eval, and the step tools go to the spaces that do not", async () => {
    const { client } = await connect(fakeHost(() => shown()), "code");
    const tools = await listed(client);
    expect(tools.get("browser_run")).toMatchObject({ "ai.insodimension/approval": "exec", [SPACES]: ["code", "build", "traction"] });
    // The View keeps calling the step tools (no space gates the View), but the model of a space with browser_run no longer sees them.
    for (const name of STEP_TOOLS) expect(tools.get(name)?.[SPACES]).toEqual(["chat", "labor", "watch"]);
    for (const name of VIEW_SIDE) expect(tools.has(name)).toBe(true);
    // Everything the model of a code space sees for browsing: browser_run and the four that stay.
    const codeSpaceTools = [...tools].filter(([, meta]) => {
      const spaces = meta?.[SPACES];
      return !Array.isArray(spaces) || spaces.includes("code");
    }).map(([name]) => name).filter(name => name.startsWith("browser_") && !name.startsWith("browser_task") && !name.startsWith("browser_publish"));
    expect(codeSpaceTools.filter(name => !["browser_stream", "browser_frame", "browser_annotate", "browser_annotation_file", "browser_viewport"].includes(name)).sort()).toEqual(["browser_close", "browser_profiles", "browser_read", "browser_run", "browser_view"]);
  });

  test("steps: the six step tools for everyone and no browser_run", async () => {
    const { client } = await connect(fakeHost(() => shown()), "steps");
    const tools = await listed(client);
    expect(tools.has("browser_run")).toBe(false);
    for (const name of STEP_TOOLS) expect(tools.get(name)).toBeUndefined();
  });

  test("both: browser_run and the step tools, none gated away", async () => {
    const { client } = await connect(fakeHost(() => shown()), "both");
    const tools = await listed(client);
    expect(tools.has("browser_run")).toBe(true);
    for (const name of STEP_TOOLS) expect(tools.get(name)).toBeUndefined();
  });

  test("a server started with no code host keeps today's tools; asking for code without one is a start-up error, not a missing tool", async () => {
    const { client } = await connect(undefined);
    const tools = await listed(client);
    expect(tools.has("browser_run")).toBe(false);
    for (const name of STEP_TOOLS) expect(tools.get(name)).toBeUndefined();

    const { runtime, viewDir } = await stubRuntime();
    await expect(createBrowserServer({ runtime, viewDir, presets: [], modelTools: "code" })).rejects.toThrow("needs the code host");
  });

  test("DIMENSION_BROWSER_MODEL_TOOLS is read, and a value that is not code, steps or both is refused", async () => {
    const previous = process.env.DIMENSION_BROWSER_MODEL_TOOLS;
    try {
      process.env.DIMENSION_BROWSER_MODEL_TOOLS = "steps";
      const { client } = await connect(fakeHost(() => shown()));
      expect((await listed(client)).has("browser_run")).toBe(false);

      process.env.DIMENSION_BROWSER_MODEL_TOOLS = "everything";
      const { runtime, viewDir } = await stubRuntime();
      await expect(createBrowserServer({ runtime, viewDir, presets: [], codeHost: fakeHost(() => shown()) })).rejects.toThrow("must be code, steps or both");
    } finally {
      if (previous === undefined) delete process.env.DIMENSION_BROWSER_MODEL_TOOLS;
      else process.env.DIMENSION_BROWSER_MODEL_TOOLS = previous;
    }
  });

  test("closing the server ends the code host", async () => {
    const ended = Promise.withResolvers<void>();
    const host = fakeHost(() => shown());
    host.dispose = async () => {
      ended.resolve();
    };
    const { client } = await connect(host, "code");
    await client.close();
    await ended.promise;
  });

  test("the model's text is OMP's browser.md as the pack ports it, without the licence comment", () => {
    expect(BROWSER_RUN_DESCRIPTION.startsWith("Drive real Chromium tabs by running JavaScript")).toBe(true);
    expect(BROWSER_RUN_DESCRIPTION).not.toContain("<!--");
    expect(BROWSER_RUN_DESCRIPTION).toContain("browser_run({ resume:");
    expect(BROWSER_RUN_DESCRIPTION).not.toMatch(/python/i);
  });
});
