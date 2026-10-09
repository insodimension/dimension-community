// Written for the Browser pack; the output cap (`capInline`) and the "(no output)" line follow OMP (https://github.com/can1357/oh-my-pi, MIT),
// packages/coding-agent/src/session/streaming-output.ts:618-680 and tools/eval.ts:905 @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../third-party/omp/LICENSE.
// Changed for the Browser pack: the full text goes to a file in the session's own folder of the pack's artifacts (OMP's session artifact does not exist here) and the footer names its absolute path.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { capText, ERROR_LINE_BYTES, MAX_INLINE_BYTES } from "./cell/output-sink.js";
import type { CodeHostPort, ImageBlock, RunError, RunResult, RunStarted } from "./contracts.js";
import { ToolAbortError } from "./errors.js";
import promptText from "./prompt.md";
import { saveSpill, sessionFolder } from "./spill.js";

/** What the model reads: OMP's `browser.md` as the pack ports it, without the licence comment that heads the file. */
export const BROWSER_RUN_DESCRIPTION = `${promptText.replace(/^<!--[\s\S]*?-->\s*/, "").trim()}\n\nSaved profiles cannot be driven by code. Use profileTool (instead of code/resume): {kind:"open",profile,url?}, then {kind:"state"|"snapshot"|"screenshot"|"inspect"|"act"|"close",browserId,...}. act takes the same ordinary browser_act actions; screenshot takes fullPage/selector/scale; inspect takes selector. A saved profile already on disk needs the person's approval in the Browser profile menu for this chat before it opens; a refusal leaves a pending request. The person sees the exact profile and observed sign-ins. Retry only after they allow. No browser_run code cell can use a saved profile.`;

/** The host times an MCP call out at 30 s and does not reset the timer on progress (doc 77 §7.8, settled by L1); a call waits at most this long. */
export const RUN_WAIT_CAP_MS = 25_000;
/** OMP's `TOOL_TIMEOUTS.browser`, seconds. */
const DEFAULT_CELL_SECONDS = 30;
/** A harness with no host stamp is one anonymous session (doc 77 §7.4.3). */
export const ANONYMOUS_SESSION = "anonymous";

type CodeCallExtra = {
  signal: AbortSignal;
  _meta?: Record<string, unknown>;
  sendNotification?: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; _meta: Record<string, unknown> } }) => Promise<void>;
};

/** Where a result over the cap keeps its full text: the text in, the absolute path of the file out (undefined: it could not be written). */
type SaveSpill = (text: string) => string | undefined;

export interface CodeToolDeps {
  host: CodeHostPort;
  /** The host's session for the call (the stamp), if it has one. */
  sessionOf(extra: { _meta?: Record<string, unknown> }): string | undefined;
  /** The root of the folders that keep a result over the cap, one per session. Resolved when a result first needs it, so a server that never spills never makes the folder. */
  artifactsDir(): string;
  /** `_meta` of the tool: the host's approval tier and the spaces that may offer it (policy lives in server.ts). */
  meta: Record<string, unknown>;
  /** Out-of-band source identity for the current host session; never included in model content. */
  preview?(session: string, browserId: string, running: boolean): Promise<unknown>;
  /** One call's wait, ms. Defaults to {@link RUN_WAIT_CAP_MS}; a test shortens it. */
  waitCapMs?: number;
  /** Trusted ordinary saved-profile path; never enters the code host or its Node worker. */
  profileOperation?: (operation: ProfileOperation, extra: CodeCallExtra, onBrowserActivity: (browserId: string) => void) => Promise<CallToolResult>;
}

/**
 * OMP's `enforceInlineByteCap`: text that fits is returned as it is. Longer text keeps the first 60% and the last 25% of the budget, cut on line boundaries,
 * with `[…NB elided…]` between; the rest of the budget is slack for the marker and the footer naming the file that holds all of it.
 * The text a cell realm hands over is already within the budget (it composes the stream and the displays under one), so this is the net for a host that does not: what it cuts IS that host's raw output.
 */
export function capInline(text: string, save: SaveSpill, maxBytes = MAX_INLINE_BYTES): string {
  const composed = capText(text, maxBytes);
  if (composed === text) return text;
  const path = save(text);
  return path === undefined ? composed : `${composed}${composed.endsWith("\n") ? "" : "\n"}[raw output: ${path}]`;
}

/** A cell's displays as the result carries them: every image, and the text parts joined by newlines. */
function partsOf(displays: RunResult["displays"]): { images: ImageBlock[]; text: string } {
  return {
    images: displays.flatMap(part => (part.type === "image" ? [part] : [])),
    text: displays.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n"),
  };
}

/** What a cell shows, as a result: the images first, then ONE text block (OMP browser.ts:392-408), capped. A cell that showed nothing says so. */
function shown(result: RunResult, save: SaveSpill): CallToolResult["content"] {
  const { images, text: full } = partsOf(result.displays);
  const text = capInline(full, save);
  if (text.length === 0 && images.length === 0) return [{ type: "text", text: "(no output)" }];
  return [...images, ...(text.length > 0 ? [{ type: "text" as const, text }] : [])];
}

/** The lines of a stack that are the model's own code (`browser-cell-<id>.js:line:col`): the pack's internals below them are not the model's business. */
function cellFrames(stack: string | undefined): string[] {
  return (stack ?? "").split("\n").filter(line => /^\s+at .*browser-cell-/.test(line)).slice(0, 6);
}

/**
 * A failed cell is a tool error carrying what it had shown before it failed, then OMP's text for the failure: a timeout and a cancellation are their message
 * alone, anything else is `Name: message` with the lines of the model's own code. The cell realm leaves {@link ERROR_LINE_BYTES} of the budget for that line, so the output is not cut again;
 * the line itself is cut alone, and is not an output anyone could ask a file for.
 */
function failed(error: RunError, save: SaveSpill): CallToolResult {
  const { images, text: shownBody } = partsOf(error.partial?.displays ?? []);
  const body = capInline(shownBody, save, MAX_INLINE_BYTES - ERROR_LINE_BYTES);
  const own = capText(error.isAbort || error.budget === true ? error.message : [`${error.name}: ${error.message}`, ...cellFrames(error.stack)].join("\n"), ERROR_LINE_BYTES);
  return { isError: true, content: [...images, { type: "text", text: body.length > 0 ? `${body}\n${own}` : own }] };
}

function started(outcome: RunStarted, save: SaveSpill, waitCapMs: number): CallToolResult {
  if (outcome.state === "running") {
    const seconds = Math.round(waitCapMs / 1000);
    const output = outcome.outputSoFar.trim();
    // Progress is not the output: it is cut to the budget and not kept (the finished cell's own footer names the file that is).
    return {
      content: [{
        type: "text",
        text: [`running: ${outcome.runId}`, ...(output.length > 0 ? [capText(output)] : []), `Call browser_run({ "resume": "${outcome.runId}" }) to wait up to ${seconds} s more; start no new cell meanwhile.`].join("\n"),
      }],
    };
  }
  return "error" in outcome.result ? failed(outcome.result.error, save) : { content: shown(outcome.result, save) };
}

/** A thrown error from the host (busy, unknown run, a refusal) is the model's message as it is. */
function refused(error: unknown): CallToolResult {
  if (error instanceof Error && error.name === "ToolAbortError") return { isError: true, content: [{ type: "text", text: ToolAbortError.MESSAGE }] };
  return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
}

export type ProfileOperation =
  | { kind: "open"; profile: string; url?: string }
  | { kind: "state"; browserId: string }
  | { kind: "snapshot"; browserId: string }
  | { kind: "close"; browserId: string }
  | { kind: "screenshot"; browserId: string; fullPage?: boolean; selector?: string; scale?: number }
  | { kind: "inspect"; browserId: string; selector: string }
  | { kind: "act"; browserId: string; actions: unknown[] };

export interface BrowserRunArgs {
  code?: string;
  resume?: string;
  profileTool?: ProfileOperation;
  timeout?: number;
}

/** One `browser_run` call. Exported for tests; the MCP server reaches it through {@link registerCodeTool}. */
export async function runCodeTool(deps: CodeToolDeps, args: BrowserRunArgs, extra: CodeCallExtra): Promise<CallToolResult> {
  if ([args.code, args.resume, args.profileTool].filter(value => value !== undefined).length !== 1 || (args.profileTool !== undefined && args.timeout !== undefined)) {
    return { isError: true, content: [{ type: "text", text: "Pass exactly one of code, resume or profileTool; timeout applies only to code." }] };
  }
  const waitCapMs = deps.waitCapMs ?? RUN_WAIT_CAP_MS;
  const session = deps.sessionOf(extra) ?? ANONYMOUS_SESSION;
  // The session's own folder: one session's files are never pruned by another's spills.
  const save: SaveSpill = text => saveSpill(sessionFolder(deps.artifactsDir(), session), text);
  let acceptingActivity = true;
  try {
    let activeBrowserId: string | undefined;
    let activitySequence = 0;
    const progressToken = extra._meta?.progressToken;
    const onBrowserActivity = (browserId: string): void => {
      activeBrowserId = browserId;
      const sequence = ++activitySequence;
      if ((typeof progressToken !== "string" && typeof progressToken !== "number") || !extra.sendNotification || !deps.preview) return;
      void deps.preview(session, browserId, true).then(preview => {
        if (sequence !== activitySequence || !acceptingActivity || preview === undefined || extra.signal.aborted) return;
        return extra.sendNotification!({
          method: "notifications/progress",
          params: { progressToken, progress: sequence, _meta: { "ai.insodimension/preview": preview } },
        });
      }).catch(() => undefined);
    };
    if (args.profileTool !== undefined) {
      if (deps.profileOperation === undefined) return refused(new Error("Saved-profile ordinary operations are unavailable in this server."));
      const answer = await deps.profileOperation(args.profileTool, extra, onBrowserActivity);
      const preview = activeBrowserId ? await deps.preview?.(session, activeBrowserId, false) : undefined;
      return preview ? { ...answer, _meta: { "ai.insodimension/preview": preview } } : answer;
    }
    const outcome = args.resume !== undefined
      ? await deps.host.resume(session, args.resume, waitCapMs, extra.signal, onBrowserActivity)
      : await deps.host.run(session, {
          code: args.code!, timeoutMs: Math.min(300, Math.max(1, args.timeout ?? DEFAULT_CELL_SECONDS)) * 1000,
          waitMs: waitCapMs, signal: extra.signal, onBrowserActivity,
        });
    const answer = started(outcome, save, waitCapMs);
    const browserId = outcome.previewBrowserId ?? activeBrowserId;
    const preview = browserId ? await deps.preview?.(session, browserId, outcome.state === "running") : undefined;
    return preview ? { ...answer, _meta: { "ai.insodimension/preview": preview } } : answer;
  } catch (error) {
    return refused(error);
  } finally {
    acceptingActivity = false;
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
      profileTool: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("open"), profile: z.string().min(1).max(48), url: z.string().max(2048).optional() }).strict(),
        z.object({ kind: z.literal("state"), browserId: z.string() }).strict(),
        z.object({ kind: z.literal("snapshot"), browserId: z.string() }).strict(),
        z.object({ kind: z.literal("screenshot"), browserId: z.string(), fullPage: z.boolean().optional(), selector: z.string().optional(), scale: z.number().gt(0).max(1).optional() }).strict(),
        z.object({ kind: z.literal("inspect"), browserId: z.string(), selector: z.string() }).strict(),
        z.object({ kind: z.literal("close"), browserId: z.string() }).strict(),
        z.object({ kind: z.literal("act"), browserId: z.string(), actions: z.array(z.unknown()).min(1).max(25) }).strict(),
      ]).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: deps.meta,
  }, (args, extra) => runCodeTool(deps, args, extra));
}
