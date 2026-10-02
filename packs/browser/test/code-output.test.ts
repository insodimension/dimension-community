/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the model's code runs in a worker thread inside the pack's server process, and a cell can print without end
 *  (`for (;;) { console.log(big); await null }`). If the worker keeps what it prints, or posts every print to the host, the server's memory is the cell's to
 *  fill and every other session's browser goes with it (doc 77 §7.4.4, review of #160). The output of a cell is bounded whatever it prints: its start, its end,
 *  a count of what is between, a file of the pack's own with as much of the rest as a cap allows, and a progress channel with a fixed rate.
 *
 *  Real workers, real files; only the tab realm is a stand-in. The bounds are asserted as numbers here, not as the constants of the code.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { CellFailure, CodeCell } from "../src/code/cell/cell.js";
import { CellOutput } from "../src/code/cell/display.js";
import { OutputSink } from "../src/code/cell/output-sink.js";
import type { HostToWorker, RunResult, WorkerToHost } from "../src/code/contracts.js";

const KIB = 1024;
const MIB = 1024 * KIB;
/** The bounds under test, written out: the inline budget, a progress chunk, the gap between two, the file's cap. */
const INLINE_BYTES = 50 * KIB;
const CHUNK_BYTES = 16 * KIB;
const CHUNK_GAP_MS = 100;
const FILE_CAP_BYTES = 16 * MIB;

const dirs: string[] = [];
const workers = new Set<Worker>();
/** A second `terminate()` on a thread that is already gone never settles under Bun, so each thread is ended once, by whoever gets there first. */
async function stop(worker: Worker): Promise<void> {
  if (workers.delete(worker)) await worker.terminate();
}
afterEach(async () => {
  await Promise.all([...workers].map(stop));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "browser-output-"));
  dirs.push(dir);
  return dir;
}

const textOf = (result: RunResult): string => result.displays.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const FOOTER = /\n\[raw output: (.+)\]/;

describe("a cell that prints without end", () => {
  const FLOOD = "for (;;) { console.log('x'.repeat(1e6)); await new Promise(resolve => setImmediate(resolve)); }";

  test("ends by its budget with an output within the inline bound, the start and the end of what it printed, and a footer naming the file that holds the start of the rest", async () => {
    const spillDir = await tempDir();
    const cell = new CodeCell({ guardRejections: true });
    const chunks: string[] = [];
    const startedAt = Date.now();
    try {
      const run = cell.run({ runId: "flood", code: FLOOD, timeoutMs: 400, signal: new AbortController().signal, invoke: async () => { throw new Error("no host"); }, onText: chunk => chunks.push(chunk), spillDir });
      const failure = await run.then(() => undefined, error => error as CellFailure);
      expect(failure).toBeInstanceOf(CellFailure);
      expect(failure!.error.budget).toBe(true);
      const text = textOf(failure!.partial);

      // What the worker hands the host is within the inline bound, footer included.
      expect(bytes(text)).toBeLessThanOrEqual(INLINE_BYTES);
      expect(text.startsWith("xxxx")).toBe(true);
      expect(text).toMatch(/\n\[…\d+B elided…\]\n/);
      const footer = FOOTER.exec(text);
      expect(footer).not.toBeNull();
      const path = footer![1]!;
      expect(path.startsWith(spillDir)).toBe(true);

      // The file holds the start of the stream and stops at its cap; the footer says how much more was printed.
      const size = (await stat(path)).size;
      expect(size).toBeGreaterThan(INLINE_BYTES);
      expect(size).toBeLessThanOrEqual(FILE_CAP_BYTES);
      const stops = /\[the file stops at (\d+)B: (\d+)B more were printed and are not kept\]/.exec(text);
      expect(stops).not.toBeNull();
      expect(Number(stops![1])).toBe(size);
      expect(Number(stops![2])).toBeGreaterThan(0);
      expect((await readFile(path, "utf8")).startsWith("xxxx")).toBe(true);
      expect(await readdir(spillDir)).toEqual([path.slice(spillDir.length + 1)]);
    } finally {
      cell.dispose();
    }

    // The progress channel: one chunk per 100 ms at most, each within 16 KiB (plus the marker that counts what was left out).
    const elapsed = Date.now() - startedAt;
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThanOrEqual(Math.ceil(elapsed / CHUNK_GAP_MS) + 2);
    for (const chunk of chunks) expect(bytes(chunk)).toBeLessThanOrEqual(CHUNK_BYTES + 40);
  }, 30_000);

  test("holds memory that does not grow with what it prints: 256 MB through the output leaves the heap where it was", async () => {
    const spillDir = await tempDir();
    const output = new CellOutput({ spillDir, onText: () => {} });
    const { onText } = output.hooks();
    const print = (count: number): void => {
      for (let i = 0; i < count; i += 1) onText(`${String.fromCharCode(97 + (i % 26)).repeat(1_000_000)}\n`);
    };
    // The heap's number is noisy by tens of MB whatever runs (JSC sweeps lazily: the same 256 chunks measured +32, +23, -1 MB in one process, 1024 chunks -27 MB), and none of it grows with the volume. A sink that kept what it was
    // given would be 256 MB up, so the bound is far above the noise and far below the volume. The first megabytes through a cold process also allocate code and caches: they go through before `before` is read.
    print(16);
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    print(256);
    Bun.gc(true);
    const grown = process.memoryUsage().heapUsed - before;
    expect(grown).toBeLessThan(96 * MIB);
    expect(bytes(output.finish().text)).toBeLessThanOrEqual(INLINE_BYTES);
  }, 30_000);
});

/** A real worker thread over the pack's own worker core, as the host starts it (no `env` option: it gets a copy of this process's). */
function startThread(): { worker: Worker; messages: WorkerToHost[]; send(message: HostToWorker): void; next(matches: (m: WorkerToHost) => boolean): Promise<WorkerToHost> } {
  const worker = new Worker(new URL("./fixtures-code/fake-realm-worker.ts", import.meta.url));
  workers.add(worker);
  const messages: WorkerToHost[] = [];
  const waiting: Array<{ matches: (m: WorkerToHost) => boolean; resolve: (m: WorkerToHost) => void }> = [];
  worker.on("message", (message: WorkerToHost) => {
    messages.push(message);
    for (const wait of [...waiting]) {
      if (!wait.matches(message)) continue;
      waiting.splice(waiting.indexOf(wait), 1);
      wait.resolve(message);
    }
  });
  return {
    worker,
    messages,
    send: message => worker.postMessage(message),
    next(matches) {
      const found = messages.find(matches);
      if (found) return Promise.resolve(found);
      const { promise, resolve } = Promise.withResolvers<WorkerToHost>();
      waiting.push({ matches, resolve });
      return promise;
    },
  };
}

describe("a worker whose cell never lets the event loop turn", () => {
  test("posts the host a fixed rate of progress however much it prints, and writes a file that stops at its cap", async () => {
    // `await null` is a microtask: no timer fires, no message arrives, the budget cannot end this cell. The host ends it by terminating the thread (doc 77 §7.4.4);
    // until then the worker must not turn the host's side into a buffer for what it prints.
    const outputDir = await tempDir();
    const thread = startThread();
    thread.send({ t: "init", session: "s", env: {}, outputDir });
    await thread.next(m => m.t === "ready");
    let posted = 0;
    const flooded = Promise.withResolvers<void>();
    thread.worker.on("message", (message: WorkerToHost) => {
      if (message.t !== "text") return;
      posted += bytes(message.chunk);
      // A worker with no bound would be 64 MiB in well under a second: stop it there, so the test fails by its assertion and not by the machine's.
      if (posted > 64 * MIB) flooded.resolve();
    });
    thread.send({ t: "run", runId: "r", code: "for (;;) { console.log('x'.repeat(1e6)); await null; }", timeoutMs: 500 });

    // A real clock on purpose: the claim is a rate per second of wall time against a thread that cannot be asked anything, so no fake timer can stand in for it.
    const windowMs = 1_500;
    const startedAt = Date.now();
    await Promise.race([Bun.sleep(windowMs), flooded.promise]);
    const elapsed = Date.now() - startedAt;
    await stop(thread.worker);

    const texts = thread.messages.flatMap(message => (message.t === "text" ? [message.chunk] : []));
    expect(posted).toBeLessThan(64 * MIB);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.length).toBeLessThanOrEqual(Math.ceil(elapsed / CHUNK_GAP_MS) + 3);
    for (const chunk of texts) expect(bytes(chunk)).toBeLessThanOrEqual(CHUNK_BYTES + 40);

    const files = await readdir(outputDir);
    expect(files).toHaveLength(1);
    expect((await stat(join(outputDir, files[0]!))).size).toBeLessThanOrEqual(FILE_CAP_BYTES);
  }, 30_000);
});

describe("the sink", () => {
  const lines = (count: number, width: number): string => Array.from({ length: count }, (_, i) => `line ${String(i).padStart(6, "0")} ${"é".repeat(width)}`).join("\n");

  test("a stream that fits the budget is returned whole, trimmed, and writes no file", async () => {
    const spillDir = join(await tempDir(), "session");
    const sink = new OutputSink({ spillDir });
    const text = lines(300, 20);
    for (let i = 0; i < text.length; i += 777) sink.push(text.slice(i, i + 777));
    expect(bytes(text)).toBeLessThan(INLINE_BYTES);
    expect(sink.dump().text).toBe(text);
    await expect(readdir(spillDir)).rejects.toThrow();
  });

  test("a stream over the budget keeps its first lines and its last lines, counts what it leaves out exactly, and the file holds all of it", async () => {
    const spillDir = await tempDir();
    const sink = new OutputSink({ spillDir });
    const text = `  \n${lines(4_000, 20)}\n\n`;
    // Chunks of 7 bytes' worth of characters, so the windows' edges fall inside multi-byte characters.
    for (let i = 0; i < text.length; i += 7) sink.push(text.slice(i, i + 7));
    const summary = sink.dump();

    expect(bytes(summary.text)).toBeLessThanOrEqual(INLINE_BYTES);
    expect(summary.text.startsWith("line 000000")).toBe(true);
    expect(summary.text).toContain("line 003999");
    expect(summary.text).not.toContain("\uFFFD");
    const marker = /\n\[…(\d+)B elided…\]\n/.exec(summary.text);
    expect(marker).not.toBeNull();
    // What is shown plus what is counted is the stream, trimmed: nothing is lost in the count.
    const shown = summary.text.replace(/\n\[…\d+B elided…\]\n/, "").replace(/\n\[raw output: .+\]$/, "");
    expect(bytes(shown) + Number(marker![1])).toBe(bytes(text.trim()));
    expect(summary.totalBytes).toBe(bytes(text));
    // The file is the stream as it was printed, byte for byte.
    expect(await readFile(summary.spillPath!, "utf8")).toBe(text);
    expect(summary.text.endsWith(`[raw output: ${summary.spillPath}]`)).toBe(true);
  });

  test("a file stops at its cap and says how much more was printed", async () => {
    const spillDir = await tempDir();
    const sink = new OutputSink({ spillDir });
    const chunk = "y".repeat(MIB);
    for (let i = 0; i < 20; i += 1) sink.push(chunk);
    const summary = sink.dump();
    expect((await stat(summary.spillPath!)).size).toBe(FILE_CAP_BYTES);
    expect(summary.text).toContain(`[the file stops at ${FILE_CAP_BYTES}B: ${4 * MIB}B more were printed and are not kept]`);
  });

  test("progress: chunks inside the gap are one chunk, a stretch past the chunk size is counted, and the last chunk is sent at the end", () => {
    let now = 1_000;
    const sent: string[] = [];
    const sink = new OutputSink({ onChunk: chunk => sent.push(chunk), now: () => now });
    sink.push("a\n"); // the first chunk goes at once
    now += 10;
    sink.push("b\n");
    now += 10;
    sink.push("c\n".repeat(20_000)); // 40,000 bytes inside the gap
    expect(sent).toEqual(["a\n"]);
    now += 100;
    sink.push("d\n");
    expect(sent).toHaveLength(2);
    expect(sent[1]!.startsWith("[…")).toBe(true);
    expect(bytes(sent[1]!)).toBeLessThanOrEqual(CHUNK_BYTES + 40);
    expect(sent[1]!.endsWith("c\nd\n")).toBe(true);
    // What is counted is exactly what was left out: b + 20,000 c lines + d, minus the 16 KiB sent.
    const counted = Number(/^\[…(\d+)B elided…\]/.exec(sent[1]!)![1]);
    expect(counted + bytes(sent[1]!.replace(/^\[…\d+B elided…\]\n/, ""))).toBe(2 + 40_000 + 2);
    now += 5;
    sink.push("e\n");
    sink.dump();
    expect(sent.at(-1)).toBe("e\n");
  });
});

describe("one budget for the whole text of a cell", () => {
  // The stream and the `display[n]:` blocks are two collectors; the text the model reads is their composition, and it must be within 50 KiB by itself, so the tool never cuts it a second time
  // (two stacked markers, and a footer that names the cut text as if it were the raw output; review of #160, round 3).
  const ERROR_LINE_BYTES = 4 * KIB;
  const streamLine = (i: number): string => `line ${String(i).padStart(5, "0")} ${"é".repeat(8)}\n`;
  const streamText = (lines: number): string => Array.from({ length: lines }, (_, i) => streamLine(i)).join("");
  const printLines = (output: CellOutput, lines: number): void => {
    for (let i = 0; i < lines; i += 1) output.hooks().onText(streamLine(i));
  };
  /** What `display(array)` makes of a 300-item array: one block, cut at 8,000 characters. */
  const display300 = (output: CellOutput, count: number): void => {
    for (let i = 0; i < count; i += 1) output.hooks().onDisplay({ type: "json", data: Array.from({ length: 300 }, (_, k) => ({ index: k, label: `item ${k}` })) });
  };
  const markers = (text: string): number => (text.match(/\[…\d+B elided…\]/g) ?? []).length;
  const footers = (text: string): string[] => [...text.matchAll(/\[raw output: (.+)\]/g)].map(match => match[1]!);

  test("2,000 printed lines and three displays of a 300-item array: within the budget, one marker for the stream, one footer, and the file holds the whole stream", async () => {
    const spillDir = await tempDir();
    const output = new CellOutput({ spillDir });
    printLines(output, 2_000);
    display300(output, 3);
    const { text } = output.finish();

    expect(bytes(text)).toBeLessThanOrEqual(INLINE_BYTES);
    expect(markers(text)).toBe(1);
    const paths = footers(text);
    expect(paths).toHaveLength(1);
    expect(await readFile(paths[0]!, "utf8")).toBe(streamText(2_000));
    // The displays are what the model asked to see: all three are there.
    for (const n of [1, 2, 3]) expect(text).toContain(`display[${n}]:`);
    expect(text.startsWith("line 00000")).toBe(true);
  });

  test("a stream that fits the budget alone, and one display beside it that does not fit with it: the stream is cut once, and the file it never needed is written now", async () => {
    const spillDir = await tempDir();
    const output = new CellOutput({ spillDir });
    printLines(output, 1_700);
    expect(bytes(streamText(1_700))).toBeLessThan(INLINE_BYTES);
    expect(bytes(streamText(1_700))).toBeGreaterThan(INLINE_BYTES - 8_000);
    display300(output, 1);
    const { text } = output.finish();

    expect(bytes(text)).toBeLessThanOrEqual(INLINE_BYTES);
    expect(markers(text)).toBe(1);
    expect(text).toContain("display[1]:");
    const paths = footers(text);
    expect(paths).toHaveLength(1);
    expect(await readFile(paths[0]!, "utf8")).toBe(streamText(1_700));
  });

  test("a flood of displays beside a flood of lines: each section keeps its start and its end and says what it left out, and together they are within the budget", async () => {
    const output = new CellOutput({ spillDir: await tempDir() });
    printLines(output, 4_000);
    display300(output, 200);
    const { text } = output.finish();

    expect(bytes(text)).toBeLessThanOrEqual(INLINE_BYTES);
    expect(text).toContain("line 00000");
    expect(text).toContain("line 03999");
    expect(text).toContain("display[1]:");
    // The end of the last display is there (each ends with its own cut marker, a display being 8,000 characters at most); its first line is further back than a half budget's tail reaches.
    expect(text.endsWith("ch elided…]")).toBe(true);
    expect(markers(text)).toBe(2);
    expect(footers(text)).toHaveLength(1);
  });

  test("whatever the mix of stream and displays, the text is within the budget; a failed cell leaves room for its error line", async () => {
    const spillDir = await tempDir();
    for (const lines of [0, 1, 300, 1_000, 1_500, 1_700, 4_000, 20_000]) {
      for (const displays of [0, 1, 3, 7, 40]) {
        for (const reserve of [0, ERROR_LINE_BYTES]) {
          const output = new CellOutput({ spillDir });
          printLines(output, lines);
          display300(output, displays);
          expect(bytes(output.finish(reserve).text)).toBeLessThanOrEqual(INLINE_BYTES - reserve);
        }
      }
    }
  }, 60_000);
});

describe("what a cell's displays may hold", () => {
  // A screenshot loop or a `display()` loop must not be able to fill the worker's heap (doc 77 §7.4.4): images are kept up to a ceiling, display blocks in a bounded sink.
  const IMAGE_CEILING_CHARS = 32 * MIB;

  test("images past 32 MiB are dropped and counted: 40 one-MiB screenshots keep 32, and the text says how many were left out", () => {
    const output = new CellOutput();
    const shot = "A".repeat(MIB);
    for (let i = 0; i < 40; i += 1) output.hooks().onDisplay({ type: "image", data: shot, mimeType: "image/png" });
    const { images, text } = output.finish();
    expect(images.reduce((sum, image) => sum + image.data.length, 0)).toBeLessThanOrEqual(IMAGE_CEILING_CHARS);
    // The ceiling is on what is kept in all: the 32nd fills it exactly and is kept, the 33rd is the first dropped.
    expect(images).toHaveLength(32);
    expect(text).toBe("[display: 8 images dropped — one cell keeps at most 32 MiB of images]");
  });

  test("one image larger than the ceiling is dropped alone, and a small one after it is still kept", () => {
    const output = new CellOutput();
    output.hooks().onDisplay({ type: "image", data: "A".repeat(IMAGE_CEILING_CHARS + 4), mimeType: "image/png" });
    output.hooks().onDisplay({ type: "image", data: "aGk=", mimeType: "image/png" });
    const { images, text } = output.finish();
    expect(images.map(image => image.data)).toEqual(["aGk="]);
    expect(text).toBe("[display: 1 image dropped — one cell keeps at most 32 MiB of images]");
  });

  test("40,000 display blocks of 8,000 characters: the text is within 50 KiB with the first block and the last, and memory does not grow with their number", () => {
    const output = new CellOutput();
    const { onDisplay } = output.hooks();
    const block = { filler: "y".repeat(9_000) };
    const push = (count: number): void => {
      for (let i = 0; i < count; i += 1) onDisplay({ type: "json", data: block });
    };
    // Same measure as the sink's own test above: warmed up, and a bound far above the heap's noise and far below the 320 MB a sink that kept its blocks would hold.
    push(2_000);
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    push(38_000);
    Bun.gc(true);
    const grown = process.memoryUsage().heapUsed - before;
    expect(grown).toBeLessThan(96 * MIB);

    const { text } = output.finish();
    expect(bytes(text)).toBeLessThanOrEqual(INLINE_BYTES);
    expect(text.startsWith("display[1]:\n")).toBe(true);
    expect(text).toContain("display[40000]:");
    expect(text).toMatch(/\n\[…\d+B elided…\]\n/);
  }, 60_000);
});
