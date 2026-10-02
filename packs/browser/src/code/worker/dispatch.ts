// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser.ts (browserSchema, invokeBrowser, resolveBrowserRunCode, runBrowser) and tools/tool-timeouts.ts (clampTimeout) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: ArkType is zod; `open` and `close` are answered by the code host (a `bridge` message) while `run` and `call` stay in this thread, in the tab realm; a tab the host made is
// adopted here; the session's settings and the tab supervisor are not here.

import { isMainThread } from "node:worker_threads";
import { z } from "zod";
import type { BridgeDetails, BridgeRequest, BridgeResponse, HostToWorker, ImageBlock, RealmInit, RunError, RunResult, TabHandle, TabRealm, Transport, WorkerToHost } from "../contracts.js";
import { CellFailure, type CellInvoke, CodeCell, failureOf } from "../cell/cell.js";
import { MAX_IMAGE_BASE64_CHARS } from "../cell/display.js";
import { MAX_INLINE_BYTES, OutputSink } from "../cell/output-sink.js";
import { ToolAbortError, ToolError, throwIfAborted } from "../errors.js";

export const DEFAULT_TAB_NAME = "main";
/** OMP's TOOL_TIMEOUTS.browser: seconds. */
export const BROWSER_TIMEOUT = { default: 30, min: 1, max: 300 } as const;

const appSchema = z.object({
  path: z.string().optional(),
  cdp_url: z.string().optional(),
  relay: z.boolean().optional(),
  args: z.array(z.string()).optional(),
  target: z.string().optional(),
});

/** OMP's `browserSchema` field for field, plus `profile`. */
export const bridgeRequestSchema = z.object({
  action: z.enum(["open", "close", "run", "call", "tabs", "active"]),
  name: z.string().optional(),
  url: z.string().optional(),
  app: appSchema.optional(),
  viewport: z.object({ width: z.number(), height: z.number(), scale: z.number().optional() }).optional(),
  wait_until: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(),
  dialogs: z.enum(["accept", "dismiss"]).optional(),
  code: z.string().optional(),
  fn: z.string().optional(),
  args: z.array(z.unknown()).optional(),
  chain: z.array(z.object({ method: z.string(), args: z.array(z.unknown()) })).optional(),
  timeout: z.number().optional(),
  all: z.boolean().optional(),
  kill: z.boolean().optional(),
  persist: z.boolean().optional(),
  profile: z.string().optional(),
});

/**
 * Leaves `target` holding exactly `env`. A worker thread starts with a copy of the server's environment (the jev key, every DIMENSION_* secret); the cell must see only what the host sent.
 * In place, so a process the cell starts inherits it too.
 */
export function scrubEnvironment(target: NodeJS.ProcessEnv, env: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(target)) if (!Object.hasOwn(env, key)) delete target[key];
  Object.assign(target, env);
}

/** OMP's clampTimeout("browser", raw): the default when omitted, then the floor and the ceiling. */
export function clampBrowserTimeout(raw: number | undefined): number {
  const timeout = raw ?? BROWSER_TIMEOUT.default;
  return Math.max(BROWSER_TIMEOUT.min, Math.min(BROWSER_TIMEOUT.max, timeout));
}

/** The host's answer to `open` and `close`: the text and details the facade prints, and, for `open`, the tab to adopt. */
export type HostReply = BridgeResponse & { attach?: TabHandle };

export interface DispatcherPorts {
  realm: TabRealm;
  /** Sends one `open`/`close`/`tabs`/`active` request to the code host and answers with its reply; rejects when `signal` aborts. */
  host(request: BridgeRequest, o: { runId: string; signal: AbortSignal }): Promise<HostReply>;
}

function summarize(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.length > 0 ? `${issue.path.join(".")} ` : ""}${issue.message}`).join("; ");
}

/** What `run` executes: the code, or the function with its arguments. Exactly one of the two (browser.ts resolveBrowserRunCode). */
function runTarget(request: BridgeRequest): { code: string } | { fn: string; args: unknown[] } {
  const code = request.code?.trim();
  const fn = request.fn?.trim();
  if ((code === undefined || code.length === 0) === (fn === undefined || fn.length === 0)) {
    throw new ToolError("Action 'run' requires exactly one of 'code' or 'fn'.");
  }
  return fn !== undefined && fn.length > 0 ? { fn, args: request.args ?? [] } : { code: code ?? "" };
}

const TAB_TEXT_CUT_NOTE = "[tab output over 50 KiB: its middle was not kept here; print less, or return the value]";

/**
 * The text parts of a tab call, joined with newlines as the facade shows them, within the inline budget. A realm that prints without end (`tab.run` with a loop of `console.log`) is not copied whole into the cell's
 * realm: over the budget the parts go through an {@link OutputSink} (the start, the end, a count of the rest) and the note says the middle is not kept. A text that fits is joined untouched.
 */
function boundedText(parts: string[]): string {
  let total = Math.max(0, parts.length - 1);
  for (const part of parts) {
    total += Buffer.byteLength(part, "utf8");
    if (total > MAX_INLINE_BYTES) break;
  }
  if (total <= MAX_INLINE_BYTES) return parts.join("\n");
  const sink = new OutputSink();
  parts.forEach((part, index) => {
    if (index > 0) sink.push("\n");
    sink.push(part);
  });
  return `${sink.dump().text}\n${TAB_TEXT_CUT_NOTE}`;
}

/** The images of a tab call up to the ceiling a cell may keep in all (the cell's own output enforces it again over the whole cell); the rest is counted. */
function boundedImages(images: ImageBlock[]): { kept: ImageBlock[]; dropped: number } {
  const kept: ImageBlock[] = [];
  let chars = 0;
  for (const image of images) {
    if (chars + image.data.length > MAX_IMAGE_BASE64_CHARS) continue;
    chars += image.data.length;
    kept.push(image);
  }
  return { kept, dropped: images.length - kept.length };
}

/**
 * The tab realm's result as the facade reads it: the text parts joined by newlines, the images apart, the returned value in `details`. Text and images are bounded here, where they cross into the cell;
 * the returned value is the page code's own value and goes through as it is (the same object: it is neither copied nor cut, a cell that returns a page's HTML needs all of it).
 */
function bridgeResponse(result: RunResult, details: BridgeDetails): BridgeResponse {
  const { kept: images, dropped } = boundedImages(result.displays.flatMap(part => (part.type === "image" ? [part] : [])));
  const note = dropped === 0 ? "" : `[tab output: ${dropped} image${dropped === 1 ? "" : "s"} dropped — one call keeps at most ${MAX_IMAGE_BASE64_CHARS / (1024 * 1024)} MiB of images]`;
  const text = [boundedText(result.displays.flatMap(part => (part.type === "text" ? [part.text] : []))), note].filter(part => part.length > 0).join("\n");
  if (result.screenshots.length > 0) details.screenshots = result.screenshots;
  if (result.returnValue !== undefined) details.value = result.returnValue;
  return { text, details, ...(images.length > 0 ? { images } : {}) };
}

/** `browser.*` from a cell: validated, then `open`/`close`/`tabs`/`active` to the host and `run`/`call` to the tab realm. */
export function createDispatcher(ports: DispatcherPorts): CellInvoke {
  const { realm, host } = ports;
  return async (parameters, { runId, signal }) => {
    const parsed = bridgeRequestSchema.safeParse(parameters);
    if (!parsed.success) throw new ToolError(`browser received invalid arguments: ${summarize(parsed.error)}`);
    const request: BridgeRequest = parsed.data;
    throwIfAborted(signal);
    const timeoutSeconds = clampBrowserTimeout(request.timeout);
    const timeoutMs = timeoutSeconds * 1000;
    const name = request.name ?? DEFAULT_TAB_NAME;
    const details: BridgeDetails = { action: request.action, name };
    switch (request.action) {
      case "open": {
        const reply = await host({ ...request, name, timeout: timeoutSeconds }, { runId, signal });
        if (reply.attach) await realm.adopt(name, reply.attach);
        return { text: reply.text, details: { ...details, ...reply.details, name }, ...(reply.images ? { images: reply.images } : {}) };
      }
      case "close": {
        const reply = await host({ ...request, name, timeout: timeoutSeconds }, { runId, signal });
        // The host closed or released the tabs; the pages this realm held for them go with them. A tab the host did not know is released here too (nothing to drop is not an error).
        for (const held of request.all ? realm.names() : [name]) await realm.release(held);
        return { text: reply.text, details: { ...details, ...reply.details, name }, ...(reply.images ? { images: reply.images } : {}) };
      }
      case "tabs": {
        const reply = await host({ ...request, name, timeout: timeoutSeconds }, { runId, signal });
        return { text: reply.text, details: { ...details, ...reply.details, action: "tabs", name: reply.details.name ?? name } };
      }
      case "active": {
        const reply = await host({ ...request, name, timeout: timeoutSeconds }, { runId, signal });
        const found = reply.details.name;
        if (typeof found !== "string" || found.length === 0) throw new ToolError("There is no active tab to drive");
        // The tab the human is looking at may be one no cell ever named: the host says what to call it and hands over its page, as it does for `open`.
        if (reply.attach) await realm.adopt(found, reply.attach);
        return { text: reply.text, details: { ...details, ...reply.details, action: "active", name: found }, ...(reply.images ? { images: reply.images } : {}) };
      }
      case "call":
        return bridgeResponse(await realm.call({ name, chain: request.chain ?? [], timeoutMs, signal }), details);
      case "run":
        return bridgeResponse(await realm.run({ name, ...runTarget(request), timeoutMs, signal }), details);
    }
  };
}

function errorOf(payload: RunError): Error {
  if (payload.isAbort) return new ToolAbortError(payload.message);
  const error = payload.name === "ToolError" ? new ToolError(payload.message) : new Error(payload.message);
  error.name = payload.name;
  if (payload.stack !== undefined) error.stack = payload.stack;
  return error;
}

export interface WorkerCoreOptions {
  transport: Transport<HostToWorker, WorkerToHost>;
  /** Builds the tab realm once the host has said who the worker serves. */
  createRealm(init: RealmInit): TabRealm;
  /** Take part in `unhandledRejection` for the cell (a worker: yes; a test: only where it proves it). */
  guardRejections?: boolean;
}

interface PendingBridge {
  runId: string;
  resolve(reply: HostReply): void;
  reject(error: Error): void;
}

/**
 * The worker's message loop (the host's `HostToWorker` in, `WorkerToHost` out): `init` builds the realms and answers `ready`; `run` runs a cell and answers with a `result`; the cell's `open`/`close`/`tabs`/`active` become
 * `bridge` messages the host answers with a `bridge-reply` (`tabs` and `active` too); `abort` cancels a run, `end` drops a browser's tabs, `close` ends the worker.
 */
export class WorkerCore {
  readonly #transport: Transport<HostToWorker, WorkerToHost>;
  readonly #options: WorkerCoreOptions;
  readonly #runs = new Map<string, AbortController>();
  readonly #pending = new Map<number, PendingBridge>();
  readonly #unsubscribe: () => void;
  #realm: TabRealm | undefined;
  #cell: CodeCell | undefined;
  /** The session's folder (from `init`) for the file that keeps a cell's output longer than the inline budget. */
  #outputDir: string | undefined;
  #nextBridgeId = 1;
  #closing = false;

  constructor(options: WorkerCoreOptions) {
    this.#options = options;
    this.#transport = options.transport;
    this.#unsubscribe = this.#transport.onMessage(message => this.#handle(message));
  }

  #send(message: WorkerToHost): void {
    try {
      this.#transport.send(message);
    } catch (error) {
      // The host side is gone; there is nobody to tell.
      if (!this.#closing) throw error;
    }
  }

  #handle(message: HostToWorker): void {
    switch (message.t) {
      case "init":
        this.#outputDir = message.outputDir;
        void this.#init(message);
        return;
      case "run":
        void this.#runOne(message.runId, message.code, message.timeoutMs);
        return;
      case "bridge-reply": {
        const pending = this.#pending.get(message.id);
        if (!pending) return; // its run was aborted or finished first
        this.#pending.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(errorOf(message.error));
        return;
      }
      case "abort":
        this.#runs.get(message.runId)?.abort(new ToolAbortError());
        return;
      case "end":
        void this.#realm?.end(message.browserId, message.reason).catch(error => this.#send({ t: "log", level: "warn", msg: `Dropping the tabs of ${message.browserId} failed: ${failureOf(error).message}` }));
        return;
      case "close":
        void this.#close();
        return;
    }
  }

  async #init(message: Extract<HostToWorker, { t: "init" }>): Promise<void> {
    try {
      // Only a worker thread has an environment of its own to replace: in the main thread this would wipe the server's.
      if (!isMainThread) scrubEnvironment(process.env, message.env);
      const { session, env, screenshotDir, cwd, refusePasswordFields, excludeWebP, taskCredential } = message;
      const realm = this.#options.createRealm({ session, env, screenshotDir, cwd, refusePasswordFields, excludeWebP, taskCredential });
      this.#realm = realm;
      this.#cell = new CodeCell({ guardRejections: this.#options.guardRejections ?? false });
      // A rebuilt worker takes its session's tabs back before it says it is ready, so a cell's `browser.tab("main")` still names a page. A tab that has gone since is the host's to forget.
      for (const { name, handle } of message.tabs ?? []) {
        await realm.adopt(name, handle).catch(error => this.#send({ t: "log", level: "warn", msg: `Re-adopting tab "${name}" failed: ${failureOf(error).message}` }));
      }
      this.#send({ t: "ready" });
    } catch (error) {
      this.#send({ t: "log", level: "error", msg: `The code worker could not start: ${failureOf(error).message}` });
      void this.#close();
    }
  }

  /** One `open`/`close`/`tabs`/`active` to the host, cancelled with the run that asked. */
  #hostCall(request: BridgeRequest, { runId, signal }: { runId: string; signal: AbortSignal }): Promise<HostReply> {
    throwIfAborted(signal);
    const id = this.#nextBridgeId++;
    return new Promise<HostReply>((resolve, reject) => {
      const onAbort = (): void => {
        this.#pending.delete(id);
        reject(signal.reason instanceof Error ? signal.reason : new ToolAbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        runId,
        resolve: reply => { signal.removeEventListener("abort", onAbort); resolve(reply); },
        reject: error => { signal.removeEventListener("abort", onAbort); reject(error); },
      });
      this.#send({ t: "bridge", id, runId, request });
    });
  }

  async #runOne(runId: string, code: string, timeoutMs: number): Promise<void> {
    const realm = this.#realm;
    const cell = this.#cell;
    if (!realm || !cell) {
      this.#send({ t: "result", runId, ok: false, error: { name: "ToolError", message: "The code worker has not been initialised", isAbort: false } });
      return;
    }
    const controller = new AbortController();
    this.#runs.set(runId, controller);
    const invoke = createDispatcher({ realm, host: (request, o) => this.#hostCall(request, o) });
    try {
      // `onText` is already bounded and throttled by the cell's output sink (16 KiB, 100 ms), so a flooding cell cannot flood the host through this message.
      const payload = await cell.run({ runId, code, timeoutMs, signal: controller.signal, invoke, onText: chunk => this.#send({ t: "text", runId, chunk }), ...(this.#outputDir === undefined ? {} : { spillDir: this.#outputDir }) });
      this.#send({ t: "result", runId, ok: true, payload });
    } catch (error) {
      const error_ = error instanceof CellFailure ? { ...error.error, partial: error.partial } : failureOf(error);
      this.#send({ t: "result", runId, ok: false, error: error_ });
    } finally {
      this.#runs.delete(runId);
      for (const [id, pending] of this.#pending) {
        if (pending.runId !== runId) continue;
        this.#pending.delete(id);
        pending.reject(new ToolAbortError());
      }
    }
  }

  async #close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    for (const controller of this.#runs.values()) controller.abort(new ToolAbortError());
    this.#unsubscribe();
    try {
      await this.#realm?.dispose();
    } catch (error) {
      this.#transport.send({ t: "log", level: "warn", msg: `Closing the tab realm failed: ${failureOf(error).message}` });
    }
    this.#cell?.dispose();
    this.#transport.send({ t: "closed" });
    this.#transport.close();
  }
}
