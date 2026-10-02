// Written for the Browser pack; the output cap (`enforceInlineByteCap`) and the "(no output)" line follow OMP (https://github.com/can1357/oh-my-pi, MIT),
// packages/coding-agent/src/session/streaming-output.ts:618-680 and tools/eval.ts:905 @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../third-party/omp/LICENSE.
// Changed for the Browser pack: the full text goes to a file of the pack's own folder (OMP's session artifact does not exist here) and the footer names its absolute path.

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CodeHostPort, ImageBlock, RunError, RunResult, RunStarted } from "./contracts.js";
import { ToolAbortError } from "./errors.js";
import promptText from "./prompt.md";

/** What the model reads: OMP's `browser.md` as the pack ports it, without the licence comment that heads the file. */
export const BROWSER_RUN_DESCRIPTION = promptText.replace(/^<!--[\s\S]*?-->\s*/, "").trim();

/** The host times an MCP call out at 30 s and does not reset the timer on progress (doc 77 §7.8, settled by L1); a call waits at most this long. */
export const RUN_WAIT_CAP_MS = 25_000;
/** OMP's `TOOL_TIMEOUTS.browser`, seconds. */
const DEFAULT_CELL_SECONDS = 30;
/** OMP's `DEFAULT_MAX_BYTES`: what one result carries inline. */
export const MAX_INLINE_BYTES = 50 * 1024;
/** Spilled outputs kept in the folder (the one a model is about to read and a good few before it). */
export const SPILL_FILES_KEPT = 20;
/** A harness with no host stamp is one anonymous session (doc 77 §7.4.3). */
export const ANONYMOUS_SESSION = "anonymous";
const SPILL_NAME = /^browser-run-\d{13}-\d{6}-[0-9a-f]{8}\.txt$/;

type CodeCallExtra = { signal: AbortSignal; _meta?: Record<string, unknown> };

export interface CodeToolDeps {
  host: CodeHostPort;
  /** The host's session for the call (the stamp), if it has one. */
  sessionOf(extra: { _meta?: Record<string, unknown> }): string | undefined;
  /** Where a result over the cap keeps its full text. Resolved when a result first needs it, so a server that never spills never makes the folder. */
  artifactsDir(): string;
  /** `_meta` of the tool: the host's approval tier and the spaces that may offer it (policy lives in server.ts). */
  meta: Record<string, unknown>;
  /** One call's wait, ms. Defaults to {@link RUN_WAIT_CAP_MS}; a test shortens it. */
  waitCapMs?: number;
}

/** Longest prefix of `text` within `max` UTF-8 bytes, cut on a character boundary. */
function headBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/** Longest suffix of `text` within `max` UTF-8 bytes, cut on a character boundary. */
function tailBytes(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= max) return text;
  let start = bytes.length - max;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

/** Keeps the output of a result over the cap, newest few, in one folder of the pack's own with names it picks. */
export class OutputSpill {
  readonly #dir: () => string;
  #sequence = 0;

  constructor(dir: () => string) {
    this.#dir = dir;
  }

  /** The absolute path of a file holding `text`, or undefined when it could not be written (the model still gets the capped text). */
  save(text: string): string | undefined {
    try {
      const dir = resolve(this.#dir());
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.#sequence += 1;
      const name = `browser-run-${String(Date.now()).padStart(13, "0")}-${String(this.#sequence).padStart(6, "0")}-${randomBytes(4).toString("hex")}.txt`;
      const path = join(dir, name);
      writeFileSync(path, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      this.#prune(dir);
      return path;
    } catch {
      return undefined;
    }
  }

  #prune(dir: string): void {
    let names: string[];
    try {
      names = readdirSync(dir).filter(name => SPILL_NAME.test(name)).sort();
    } catch {
      return;
    }
    for (const name of names.slice(0, Math.max(0, names.length - SPILL_FILES_KEPT))) {
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        // A file another process holds open stays until the next spill.
      }
    }
  }
}

/**
 * OMP's `enforceInlineByteCap`: text that fits is returned as it is. Longer text keeps the first 60% and the last 25% of the budget, cut on line boundaries,
 * with `[…NB elided…]` between; the rest of the budget is slack for the marker and the footer naming the file that holds all of it.
 */
export function capInline(text: string, spill: OutputSpill, maxBytes = MAX_INLINE_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const headWindow = headBytes(text, Math.floor(maxBytes * 0.6));
  const headCut = headWindow.lastIndexOf("\n");
  const head = headCut > 0 ? headWindow.slice(0, headCut) : headWindow;
  const tailWindow = tailBytes(text, Math.floor(maxBytes * 0.25));
  const tailCut = tailWindow.indexOf("\n");
  const tail = tailCut < 0 || tailCut === tailWindow.length - 1 ? tailWindow : tailWindow.slice(tailCut + 1);
  const elided = Math.max(0, Buffer.byteLength(text, "utf8") - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"));
  let composed = `${head}\n[…${elided}B elided…]\n${tail}`;
  const path = spill.save(text);
  if (path !== undefined) composed += `${composed.endsWith("\n") ? "" : "\n"}[raw output: ${path}]`;
  return composed;
}

/** A cell's displays as the result carries them: every image, and the text parts joined by newlines. */
function partsOf(displays: RunResult["displays"]): { images: ImageBlock[]; text: string } {
  return {
    images: displays.flatMap(part => (part.type === "image" ? [part] : [])),
    text: displays.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n"),
  };
}

/** What a cell shows, as a result: the images first, then ONE text block (OMP browser.ts:392-408), capped. A cell that showed nothing says so. */
function shown(result: RunResult, spill: OutputSpill): CallToolResult["content"] {
  const { images, text: full } = partsOf(result.displays);
  const text = capInline(full, spill);
  if (text.length === 0 && images.length === 0) return [{ type: "text", text: "(no output)" }];
  return [...images, ...(text.length > 0 ? [{ type: "text" as const, text }] : [])];
}

/** The lines of a stack that are the model's own code (`browser-cell-<id>.js:line:col`): the pack's internals below them are not the model's business. */
function cellFrames(stack: string | undefined): string[] {
  return (stack ?? "").split("\n").filter(line => /^\s+at .*browser-cell-/.test(line)).slice(0, 6);
}

/**
 * A failed cell is a tool error carrying what it had shown before it failed, then OMP's text for the failure: a timeout and a cancellation are their message
 * alone, anything else is `Name: message` with the lines of the model's own code.
 */
function failed(error: RunError, spill: OutputSpill): CallToolResult {
  const { images, text: body } = partsOf(error.partial?.displays ?? []);
  const own = error.isAbort || error.name === "TimeoutError" ? error.message : [`${error.name}: ${error.message}`, ...cellFrames(error.stack)].join("\n");
  const text = capInline(body.length > 0 ? `${body}\n${own}` : own, spill);
  return { isError: true, content: [...images, { type: "text", text }] };
}

function started(outcome: RunStarted, spill: OutputSpill, waitCapMs: number): CallToolResult {
  if (outcome.state === "running") {
    const seconds = Math.round(waitCapMs / 1000);
    const output = outcome.outputSoFar.trim();
    return {
      content: [{
        type: "text",
        text: [`running: ${outcome.runId}`, ...(output.length > 0 ? [capInline(output, spill)] : []), `Call browser_run({ "resume": "${outcome.runId}" }) to wait up to ${seconds} s more; start no new cell meanwhile.`].join("\n"),
      }],
    };
  }
  return "error" in outcome.result ? failed(outcome.result.error, spill) : { content: shown(outcome.result, spill) };
}

/** A thrown error from the host (busy, unknown run, a refusal) is the model's message as it is. */
function refused(error: unknown): CallToolResult {
  if (error instanceof Error && error.name === "ToolAbortError") return { isError: true, content: [{ type: "text", text: ToolAbortError.MESSAGE }] };
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}

const SPILLS = new WeakMap<CodeToolDeps, OutputSpill>();
function spillOf(deps: CodeToolDeps): OutputSpill {
  let spill = SPILLS.get(deps);
  if (!spill) {
    spill = new OutputSpill(() => deps.artifactsDir());
    SPILLS.set(deps, spill);
  }
  return spill;
}

export interface BrowserRunArgs {
  code?: string;
  resume?: string;
  timeout?: number;
}

/** One `browser_run` call. Exported for tests; the MCP server reaches it through {@link registerCodeTool}. */
export async function runCodeTool(deps: CodeToolDeps, args: BrowserRunArgs, extra: CodeCallExtra): Promise<CallToolResult> {
  if ((args.code === undefined) === (args.resume === undefined)) {
    return { isError: true, content: [{ type: "text", text: "Pass exactly one of code (a new cell) or resume (the runId of a cell still running)." }] };
  }
  const spill = spillOf(deps);
  const waitCapMs = deps.waitCapMs ?? RUN_WAIT_CAP_MS;
  const session = deps.sessionOf(extra) ?? ANONYMOUS_SESSION;
  try {
    if (args.resume !== undefined) return started(await deps.host.resume(session, args.resume, waitCapMs, extra.signal), spill, waitCapMs);
    const timeoutMs = Math.min(300, Math.max(1, args.timeout ?? DEFAULT_CELL_SECONDS)) * 1000;
    return started(await deps.host.run(session, { code: args.code!, timeoutMs, waitMs: waitCapMs, signal: extra.signal }), spill, waitCapMs);
  } catch (error) {
    return refused(error);
  }
}

/** Registers `browser_run`: the model's one way of driving a page by code (doc 77 §7.4.2). */
export function registerCodeTool(server: McpServer, deps: CodeToolDeps): void {
  server.registerTool("browser_run", {
    title: "Run Browser Code",
    description: BROWSER_RUN_DESCRIPTION,
    inputSchema: {
      code: z.string().min(1).max(200_000).optional(),
      resume: z.string().max(64).optional(),
      timeout: z.number().min(1).max(300).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: deps.meta,
  }, (args, extra) => runCodeTool(deps, args, extra));
}
