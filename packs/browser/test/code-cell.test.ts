import { afterAll, describe, expect, test } from "bun:test";
import type { BridgeResponse, RunResult } from "../src/code/contracts.js";
import { CellFailure, CellTimeoutError, CodeCell, type CellInvoke } from "../src/code/cell/cell.js";
import { coerceImageBase64 } from "../src/code/cell/display.js";
import { createCodeEvaluator } from "../src/code/cell/evaluator.js";
import { wrapCode } from "../src/code/cell/wrap-code.js";
import { ToolError } from "../src/code/errors.js";

const cell = new CodeCell({ guardRejections: true });
afterAll(() => cell.dispose());

const never: CellInvoke = async () => {
  throw new Error("this cell must not reach the host");
};
let sequence = 0;
async function run(code: string, o: { invoke?: CellInvoke; timeoutMs?: number; signal?: AbortSignal; target?: CodeCell } = {}): Promise<RunResult> {
  return (o.target ?? cell).run({ runId: `r${++sequence}`, code, timeoutMs: o.timeoutMs ?? 5_000, signal: o.signal ?? new AbortController().signal, invoke: o.invoke ?? never });
}
const textOf = (result: RunResult): string => result.displays.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
async function failure(code: string, o: Parameters<typeof run>[1] = {}): Promise<CellFailure> {
  try {
    await run(code, o);
  } catch (error) {
    if (error instanceof CellFailure) return error;
    throw error;
  }
  throw new Error("the cell was expected to fail");
}

describe("the cell keeps its names between runs", () => {
  test("a const from one run is read by the next, and the last expression is the result", async () => {
    await run("const kept = 41");
    expect(textOf(await run("kept + 1"))).toBe("42");
  });

  test("a let changed by a closure after its declaration keeps the changed value", async () => {
    await run("let counter = 0; const bump = () => { counter += 1; }; bump(); bump();");
    expect(textOf(await run("counter"))).toBe("2");
  });

  test("a function declared in one run prints into the run that calls it, not the one that defined it", async () => {
    await run('function shout(text) { console.log(text.toUpperCase()); }');
    expect(textOf(await run('shout("later")'))).toBe("LATER");
  });

  test("top-level await, a top-level return and a return from inside a branch all give the result", async () => {
    expect(textOf(await run("await Promise.resolve(7)"))).toBe("7");
    expect(textOf(await run("const v = await Promise.resolve(8); return v + 1;"))).toBe("9");
    expect(textOf(await run("if (true) { return 'early'; } 'late'"))).toBe("early");
  });

  test("a name a cell never declared is not made global, and one it declared is not either", async () => {
    await run("const private_to_cell = 1");
    expect((globalThis as Record<string, unknown>).private_to_cell).toBeUndefined();
  });

  test("two cells do not share names", async () => {
    const other = new CodeCell();
    try {
      await run("const mine = 'a'", { target: other });
      const result = await run("typeof mine", { target: cell });
      expect(textOf(result)).toBe("undefined");
    } finally {
      other.dispose();
    }
  });

  test("static and dynamic imports reach Node's modules", async () => {
    const result = await run('import os from "node:os"; const path = await import("node:path"); [typeof os.platform, typeof path.join].join(",")');
    expect(textOf(result)).toBe("function,function");
  });
});

describe("what the cell shows", () => {
  test("display, print, console and the returned value come out in order, errors and warnings prefixed as OMP does", async () => {
    const result = await run('display("a"); print("b"); console.log("c", 1); console.warn("w"); console.error("e"); return 2;');
    expect(textOf(result)).toBe("a\nb\nc 1\n[warn] w\n[error] e\n2");
  });

  test("an object is shown as a display block, in OMP's wording", async () => {
    const result = await run("display({ a: 1 }); ({ b: [2] })");
    expect(textOf(result)).toBe('display[1]:\n{\n  "a": 1\n}\n\ndisplay[2]:\n{\n  "b": [\n    2\n  ]\n}');
  });

  test("an image display comes back as an image, a Buffer's bytes become base64, and bad data says what was dropped", async () => {
    const result = await run('display({ type: "image", mimeType: "image/png", data: Buffer.from("hi") }); display({ type: "image", mimeType: "image/png", data: 12 });');
    expect(result.displays[0]).toEqual({ type: "image", data: Buffer.from("hi").toString("base64"), mimeType: "image/png" });
    expect(textOf(result)).toContain("[display: image dropped");
    expect(textOf(result)).toContain("got number");
  });

  test("coerceImageBase64 recovers what JSON.stringify and toString('base64') make of bytes, and refuses the rest", () => {
    expect(coerceImageBase64("aGk=")).toBe("aGk=");
    expect(coerceImageBase64("104,105")).toBe("aGk=");
    expect(coerceImageBase64({ type: "Buffer", data: [104, 105] })).toBe("aGk=");
    expect(coerceImageBase64("not base64!")).toBeNull();
    expect(coerceImageBase64({ type: "Buffer", data: [300] })).toBeNull();
  });

  test("a run that prints nothing and returns nothing has no text part", async () => {
    expect((await run("const quiet = 1")).displays).toEqual([]);
  });

  test("the text of a run is streamed as it is printed", async () => {
    const chunks: string[] = [];
    await cell.run({ runId: "stream", code: 'console.log("one"); await Promise.resolve(); console.log("two");', timeoutMs: 5_000, signal: new AbortController().signal, invoke: never, onText: chunk => chunks.push(chunk) });
    expect(chunks).toEqual(["one\n", "two\n"]);
  });
});

describe("what a failing cell reports", () => {
  test("a thrown error keeps its name and message, and the output printed before it is not lost", async () => {
    const failed = await failure('console.log("before"); display({ type: "image", mimeType: "image/png", data: "aGk=" }); throw new TypeError("nope");');
    expect(failed.error).toMatchObject({ name: "TypeError", message: "nope", isAbort: false });
    expect(failed.partial.displays).toEqual([{ type: "image", data: "aGk=", mimeType: "image/png" }, { type: "text", text: "before" }]);
  });

  test("a syntax error is the engine's own", async () => {
    expect((await failure("const = ;")).error.name).toBe("SyntaxError");
  });

  test("a ToolError thrown by an operation reaches the cell and can be caught there", async () => {
    const invoke: CellInvoke = async () => {
      throw new ToolError("No tab named \"x\"");
    };
    const result = await run('try { await browser.tab("x").url(); } catch (error) { console.log(error.name + ": " + error.message); }', { invoke });
    expect(textOf(result)).toBe('ToolError: No tab named "x"');
  });

  test("a promise the cell floats and never awaits fails the run that floated it", async () => {
    const failed = await failure('Promise.reject(new Error("floated")); "done"');
    expect(failed.error.message).toBe("Unhandled rejection (missing await?): floated");
  });

  test("a rejection that is not a cell's is not claimed", () => {
    expect(cell.consumeRejection(new Error("from somewhere else"))).toBe(false);
  });
});

describe("the budget and cancellation", () => {
  test("a cell that never finishes fails at its budget with OMP's timeout text, keeping what it printed", async () => {
    const started = Date.now();
    const failed = await failure('console.log("started"); await new Promise(() => {});', { timeoutMs: 60 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(failed.error).toMatchObject({ name: "TimeoutError", message: "Command timed out after 1 seconds.", isAbort: false });
    expect(failed.partial.displays).toEqual([{ type: "text", text: "started" }]);
    expect(new CellTimeoutError(30_000).message).toBe("Command timed out after 30 seconds.");
  });

  test("a cancelled run fails as an abort, and the operation it was waiting on is cancelled with it", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const { promise: started, resolve: begun } = Promise.withResolvers<void>();
    const invoke: CellInvoke = (_parameters, { signal }) => {
      seen = signal;
      begun();
      const { promise, reject } = Promise.withResolvers<BridgeResponse>();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      return promise;
    };
    const pending = failure("await browser.tab('main').waitForSelector('#never')", { invoke, signal: controller.signal });
    await started;
    controller.abort();
    const failed = await pending;
    expect(failed.error).toMatchObject({ name: "ToolAbortError", isAbort: true });
    expect(seen?.aborted).toBe(true);
  });

  test("a run whose signal is already aborted never dispatches anything", async () => {
    let dispatched = 0;
    const invoke: CellInvoke = async () => {
      dispatched += 1;
      return { text: "", details: { action: "call", name: "main" } };
    };
    const controller = new AbortController();
    controller.abort();
    expect((await failure("await browser.tab('main').url()", { invoke, signal: controller.signal })).error.isAbort).toBe(true);
    expect(dispatched).toBe(0);
  });

  test("a run that was raced out prints into nobody's output afterwards", async () => {
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    Reflect.set(globalThis, "testGate", gate);
    const failed = await failure('await testGate; console.log("too late");', { timeoutMs: 20 });
    open();
    // Let the abandoned cell run to its end, then see that its late print went nowhere.
    await new Promise<void>(resolve => setImmediate(resolve));
    Reflect.deleteProperty(globalThis, "testGate");
    expect(failed.partial.displays).toEqual([]);
  });
});

describe("OMP's facade, unchanged, in the cell", () => {
  const calls: unknown[] = [];
  const invoke: CellInvoke = async parameters => {
    calls.push(parameters);
    const request = parameters as { action: string; name?: string; chain?: Array<{ method: string }> };
    if (request.action === "open") return { text: `Opened tab "${request.name ?? "main"}" on headless browser (hidden)\nURL: about:blank`, details: { action: "open", name: request.name ?? "main" } };
    if (request.action === "call") return { text: "", details: { action: "call", name: request.name ?? "main", value: `${request.chain?.map(step => step.method).join(">")}!` } };
    return { text: "ran", details: { action: request.action as "run", name: request.name ?? "main", value: 5 }, images: [{ type: "image", data: "aGk=", mimeType: "image/png" }] };
  };

  test("open prints the host's lines into the cell and returns a tab that names itself", async () => {
    calls.length = 0;
    const result = await run('const t = await browser.open({ name: "docs", url: "https://example.com" }); String(t) + " " + t.name', { invoke });
    expect(textOf(result)).toBe('Opened tab "docs" on headless browser (hidden)\nURL: about:blank\n<tab docs> docs');
    expect(calls).toEqual([{ name: "docs", url: "https://example.com", action: "open" }]);
  });

  test("a tab helper is one call with a one-step chain and answers with the value in the details", async () => {
    calls.length = 0;
    expect(textOf(await run('await browser.tab().url()', { invoke }))).toBe("url!");
    expect(calls).toEqual([{ name: "main", chain: [{ method: "url", args: [] }], action: "call" }]);
  });

  test("an element handle is one hop then the method, and prints as OMP's string", async () => {
    calls.length = 0;
    const result = await run('const el = browser.tab("main").id(1); [String(el), await el.click()].join(" ")', { invoke });
    expect(textOf(result)).toBe("<element tab.id(1) on main> id>click!");
    expect(calls).toEqual([{ name: "main", chain: [{ method: "id", args: [1] }, { method: "click", args: [] }], action: "call" }]);
  });

  test("tab.run sends a function's source and its arguments, a RegExp as a marker, and returns the value", async () => {
    calls.length = 0;
    const result = await run('await browser.tab().run(({ tab }, suffix, re) => suffix, { args: ["!", /a+/gi], timeout: 9 })', { invoke });
    expect(textOf(result)).toBe("5");
    expect(calls).toEqual([{ name: "main", timeout: 9, fn: "({ tab }, suffix, re) => suffix", args: ["!", { __omp_re: { source: "a+", flags: "gi" } }], action: "run" }]);
    expect(result.displays[0]).toEqual({ type: "image", data: "aGk=", mimeType: "image/png" });
  });

  test("the facade's own checks and messages are OMP's", async () => {
    const messages = await run(
      `const out = [];
       const attempt = async fn => { try { await fn(); } catch (error) { out.push(error.name + ": " + error.message); } };
       await attempt(() => browser.open(5));
       await attempt(() => browser.tab(""));
       await attempt(() => browser.tab().run(42));
       await attempt(() => browser.tab().run(console.log));
       out.push(String(Object.isFrozen(browser)), String(Object.isFrozen(browser.tab())), String(browser.tab("x").id("not-a-number")));
       out.join("\\n")`,
      { invoke },
    );
    expect(textOf(messages)).toBe(
      [
        "TypeError: browser.open() expects an options object",
        "TypeError: browser.tab() expects a tab name",
        "TypeError: tab.run() expects a function or code string",
        "TypeError: tab.run() cannot serialize a native or bound function; pass an arrow or function expression",
        "true",
        "true",
        '<element tab.id("not-a-number") on x>',
      ].join("\n"),
    );
  });

  test("browser is only reachable while a cell runs", async () => {
    const leaked = await run("globalThis.escapedTab = browser.tab('main'); 1", { invoke });
    expect(textOf(leaked)).toBe("1");
    const late: { url(): Promise<unknown> } = Reflect.get(globalThis, "escapedTab");
    await expect(late.url()).rejects.toThrow("browser can only be used while a cell is running");
    Reflect.deleteProperty(globalThis, "escapedTab");
  });
});

describe("the evaluator's lexical scope", () => {
  const hooks = { onText: () => {}, onDisplay: () => {} };

  test("a scope name is visible to the code, wins over a global of the same name, and leaves no global behind", async () => {
    const evaluator = createCodeEvaluator();
    (globalThis as Record<string, unknown>).facadeLike = "global";
    try {
      const value = await evaluator.evaluate("facadeLike + ':' + page.id + ':' + typeof globalThis.page", { filename: "t.js", scope: { facadeLike: "scoped", page: { id: 7 } }, hooks });
      expect(value).toBe("scoped:7:undefined");
    } finally {
      delete (globalThis as Record<string, unknown>).facadeLike;
    }
  });

  test("two overlapping runs each see their own scope", async () => {
    const evaluator = createCodeEvaluator();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const first = evaluator.evaluate("await gate; page.id", { filename: "a.js", scope: { page: { id: "first" }, gate }, hooks });
    const second = await evaluator.evaluate("page.id", { filename: "b.js", scope: { page: { id: "second" } }, hooks });
    release();
    expect(second).toBe("second");
    expect(await first).toBe("first");
  });

  test("a callback the browser fires outside any run sees the newest run's scope, as OMP's globals did", async () => {
    const evaluator = createCodeEvaluator();
    const holder: { callback?: () => unknown } = {};
    await evaluator.evaluate("holder.callback = () => page.id", { filename: "c.js", scope: { page: { id: "run-1" }, holder }, hooks });
    await evaluator.evaluate("1", { filename: "d.js", scope: { page: { id: "run-2" } }, hooks });
    expect(holder.callback?.()).toBe("run-2");
  });

  test("declared names persist per evaluator and a scope name wins over a declaration of the same name", async () => {
    const evaluator = createCodeEvaluator();
    await evaluator.evaluate("const tab = 'mine'; const other = 'kept';", { filename: "e.js", scope: { tab: "theirs" }, hooks });
    expect(await evaluator.evaluate("tab + ' ' + other", { filename: "f.js", scope: { tab: "theirs" }, hooks })).toBe("theirs kept");
  });
});

describe("wrapCode", () => {
  test("a final expression, a top-level return and a declaration each wrap into one async function", async () => {
    expect((await wrapCode("x + 1")).finalExpressionReturned).toBe(true);
    expect((await wrapCode("return 5")).finalExpressionReturned).toBe(true);
    expect((await wrapCode("const x = 1")).finalExpressionReturned).toBe(false);
    expect((await wrapCode("const x = 1")).source.startsWith("(async () => {")).toBe(true);
  });
});
