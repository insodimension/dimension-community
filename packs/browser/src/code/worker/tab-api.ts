// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/tab-worker.ts (TabApi, #createTabApi, #drag, #select, #uploadFile, #waitForUrl, #waitForResponse, #resolveCachedHandle,
// #resolveAriaRef, #resolveActionHandle, clickQueryHandlerText and its actionability helpers) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: the helpers are built over a TabSession (one adopted page) instead of WorkerCore; Bun.sleep is `sleep`; `uploadFile` paths are absolute or resolve against the cwd the host
// gave the realm (MCP carries none: matrix D21); an opt-in refusal of password fields (matrix D18, off by default = OMP's behaviour); the ARIA, readable and screenshot pieces live in their own modules.

import * as os from "node:os";
import * as path from "node:path";
import type { ElementHandle, Frame, HTTPResponse, KeyInput, Page } from "puppeteer-core";
import { ToolError, throwIfAborted } from "../errors";
import { type AriaSnapshotOptions, captureAriaSnapshot, resolveAriaRefHandle } from "../extract/aria-snapshot";
import { extractReadableFromHtml, type ReadableFormat } from "../extract/readable";
import { sleep, untilAborted } from "./abortable";
import { type ActionableHandle, fillViaHandle, toActionableHandle } from "./handles";
import { collectObservation, type Observation } from "./observe";
import type { RunOutput } from "./run-output";
import { markHandled } from "./run-scope";
import { captureScreenshot, describeScreenshot, type ScreenshotOptions, type ShotConfig } from "./screenshot";
import { normalizeSelector, parseAriaRefSelector } from "./selectors";
import { dispatchScroll, resolveOpTimeouts, resolveWaitTimeout, type RunState, ZERO_MATCH_FAIL_FAST_MS } from "./tab-ops";
import type { TabSession } from "./tab-session";

type DragTarget = string | { readonly x: number; readonly y: number };
type WaitUntil = "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
type ActionabilityResult = { ok: true; x: number; y: number } | { ok: false; reason: string };

/** The `tab` object `tab.run` code receives (and what a `call` chain is rendered against): OMP's helpers, with OMP's signatures. */
export interface TabApi {
  readonly name: string;
  readonly page: Page;
  readonly signal?: AbortSignal;
  url(): string;
  title(): Promise<string>;
  goto(url: string, opts?: { waitUntil?: WaitUntil }): Promise<void>;
  observe(opts?: { includeAll?: boolean; viewportOnly?: boolean }): Promise<Observation>;
  ariaSnapshot(selector?: string, opts?: AriaSnapshotOptions): Promise<string>;
  screenshot(opts?: ScreenshotOptions): Promise<string>;
  extract(format?: ReadableFormat): Promise<string>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  press(key: KeyInput, opts?: { selector?: string }): Promise<void>;
  scroll(deltaX: number, deltaY: number): Promise<void>;
  drag(from: DragTarget, to: DragTarget): Promise<void>;
  waitFor(selector: string, opts?: { timeout?: number }): Promise<ActionableHandle>;
  evaluate<R, TArgs extends unknown[]>(fn: string | ((...args: TArgs) => R | Promise<R>), ...args: TArgs): Promise<R>;
  scrollIntoView(selector: string): Promise<void>;
  select(selector: string, ...values: string[]): Promise<string[]>;
  uploadFile(selector: string, ...filePaths: string[]): Promise<void>;
  waitForUrl(pattern: string | RegExp, opts?: { timeout?: number }): Promise<string>;
  waitForResponse(
    pattern: string | RegExp | ((response: HTTPResponse) => boolean | Promise<boolean>),
    opts?: { timeout?: number },
  ): Promise<HTTPResponse>;
  waitForSelector(
    selector: string,
    opts?: { timeout?: number; visible?: boolean; hidden?: boolean },
  ): Promise<ActionableHandle | null>;
  waitForNavigation(opts?: { waitUntil?: WaitUntil; timeout?: number }): Promise<HTTPResponse | null>;
  id(n: number): Promise<ActionableHandle>;
  ref(id: string): Promise<ActionableHandle>;
}

/** Everything one `tab.run` hands its helpers. */
export interface TabApiContext {
  session: TabSession;
  run: RunState;
  /** The run's signal: its timeout, its abort and its end. */
  signal: AbortSignal;
  timeoutMs: number;
  shot: ShotConfig;
  /** Resolves relative `uploadFile` paths; unset means a relative path is refused (MCP carries no working directory). */
  cwd?: string;
  /** Refuse `type` and `fill` on a password input (the pack's rule, matrix D18). */
  refusePasswordFields: boolean;
}

/** Puppeteer's Frame as it is at runtime: `mainRealm` is internal, absent from its typings. */
type MainRealmFrame = Frame & { mainRealm?: () => { evaluate: (...args: unknown[]) => Promise<unknown> } };

interface RectPoint {
  x: number;
  y: number;
}

async function resolveActionableQueryHandlerClickTarget(handles: ElementHandle[]): Promise<ElementHandle | null> {
  const candidates: Array<{
    handle: ElementHandle;
    rect: { x: number; y: number; w: number; h: number };
    ownedProxy?: ElementHandle;
  }> = [];
  for (const handle of handles) {
    let clickable: ElementHandle = handle;
    let clickableProxy: ElementHandle | null = null;
    try {
      const proxy = await handle.evaluateHandle(el => {
        const target =
          (el as Element).closest('a,button,[role="button"],[role="link"],input[type="button"],input[type="submit"]') ?? el;
        return target;
      });
      clickableProxy = proxy.asElement() ? (proxy.asElement() as ElementHandle) : null;
      if (clickableProxy) clickable = clickableProxy;
    } catch {}
    try {
      const intersecting = await clickable.isIntersectingViewport();
      if (!intersecting) continue;
      const rect = (await clickable.evaluate(el => {
        const r = (el as Element).getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      })) as { x: number; y: number; w: number; h: number };
      if (rect.w < 1 || rect.h < 1) continue;
      candidates.push({ handle: clickable, rect, ownedProxy: clickableProxy ?? undefined });
    } catch {
    } finally {
      if (clickableProxy && clickableProxy !== handle && clickable !== clickableProxy) {
        await clickableProxy.dispose().catch(() => undefined);
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const winner = candidates[0]?.handle ?? null;
  for (let i = 1; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    if (candidate.ownedProxy) await candidate.ownedProxy.dispose().catch(() => undefined);
  }
  return winner;
}

async function isClickActionable(handle: ElementHandle): Promise<ActionabilityResult> {
  return (await handle.evaluate(el => {
    const element = el as HTMLElement;
    const style = globalThis.getComputedStyle(element);
    if (style.display === "none") return { ok: false as const, reason: "display:none" };
    if (style.visibility === "hidden") return { ok: false as const, reason: "visibility:hidden" };
    if (style.pointerEvents === "none") return { ok: false as const, reason: "pointer-events:none" };
    if (Number(style.opacity) === 0) return { ok: false as const, reason: "opacity:0" };
    const r = element.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { ok: false as const, reason: "zero-size" };
    const left = Math.max(0, Math.min(globalThis.innerWidth, r.left));
    const right = Math.max(0, Math.min(globalThis.innerWidth, r.right));
    const top = Math.max(0, Math.min(globalThis.innerHeight, r.top));
    const bottom = Math.max(0, Math.min(globalThis.innerHeight, r.bottom));
    if (right - left < 1 || bottom - top < 1) return { ok: false as const, reason: "off-viewport" };
    const x = Math.floor((left + right) / 2);
    const y = Math.floor((top + bottom) / 2);
    const topEl = globalThis.document.elementFromPoint(x, y);
    if (!topEl) return { ok: false as const, reason: "elementFromPoint-null" };
    if (topEl === element || element.contains(topEl) || (topEl as Element).contains(element)) return { ok: true as const, x, y };
    return { ok: false as const, reason: "obscured" };
  })) as ActionabilityResult;
}

async function clickQueryHandlerText(page: Page, selector: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const clickSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const start = Date.now();
  let lastSeen = 0;
  let lastReason: string | null = null;
  const timedOut = (): ToolError =>
    new ToolError(
      `Timed out clicking ${selector} (seen ${lastSeen} matches; last reason: ${lastReason ?? "unknown"}). ` +
        "If there are multiple matching elements, use observe + tab.id() or a more specific selector.",
    );
  try {
    while (Date.now() - start < timeoutMs) {
      throwIfAborted(clickSignal);
      const handles = (await untilAborted(clickSignal, () => page.$$(selector))) as ElementHandle[];
      try {
        lastSeen = handles.length;
        const target = await resolveActionableQueryHandlerClickTarget(handles);
        if (!target) {
          lastReason = handles.length ? "no-visible-candidate" : "no-matches";
          await untilAborted(clickSignal, () => sleep(100));
          continue;
        }
        const actionability = await isClickActionable(target);
        if (!actionability.ok) {
          lastReason = actionability.reason;
          await untilAborted(clickSignal, () => sleep(100));
          continue;
        }
        try {
          await untilAborted(clickSignal, () => target.click());
          return;
        } catch (err) {
          lastReason = err instanceof Error ? err.message : String(err);
          await untilAborted(clickSignal, () => sleep(100));
        }
      } finally {
        await Promise.all(handles.map(async handle => handle.dispose().catch(() => undefined)));
      }
    }
  } catch (err) {
    // The loop's own deadline races the per-op one at the same instant: whichever lands first, the model is told what the element was doing (OMP's loop let its own AbortError through as "Aborted: The operation timed out.").
    if (timeoutSignal.aborted && !signal?.aborted) throw timedOut();
    throw err;
  }
  throw timedOut();
}

/** Relative upload paths need a base: the host's cwd when it gave one, else the rule is named (MCP calls carry no working directory). `~` is the home directory. */
export function resolveUploadPath(filePath: string, cwd: string | undefined): string {
  const expanded = filePath === "~" ? os.homedir() : /^~[\\/]/.test(filePath) ? path.join(os.homedir(), filePath.slice(2)) : filePath;
  if (path.isAbsolute(expanded)) return expanded;
  if (cwd) return path.resolve(cwd, expanded);
  throw new ToolError(
    `tab.uploadFile() needs an absolute path; got ${JSON.stringify(filePath)}. browser_run has no working directory to resolve a relative path against.`,
  );
}

/**
 * Build the `tab` for one run. Every helper goes through the run's per-op guard (named fail-fast deadlines, in-flight tracking for timeout attribution, the zero-match watchdog on selector ops).
 */
export function createTabApi(c: TabApiContext, output: RunOutput, screenshots: Parameters<typeof captureScreenshot>[3]): TabApi {
  const { session, run, signal, timeoutMs, shot } = c;
  const { page, elements } = session;
  const { budgetBound, quickOpMs, actionOpMs } = resolveOpTimeouts(timeoutMs);
  const waitMs = (explicit?: number): number => resolveWaitTimeout(timeoutMs, explicit);
  const INF = Number.POSITIVE_INFINITY;
  const op = <T>(
    label: string,
    perOpMs: number,
    fn: (sig: AbortSignal) => Promise<T>,
    selectorOpts?: { selector?: string; zeroMatchAfterMs?: number },
  ): Promise<T> => markHandled(session.ops.runOp(run, label, signal, perOpMs, fn, selectorOpts));

  const isPasswordField = (handle: ElementHandle, sig: AbortSignal | undefined): Promise<boolean> =>
    untilAborted(sig, () => handle.evaluate(el => el instanceof HTMLInputElement && el.type === "password"));
  const refusePassword = (what: string): ToolError =>
    new ToolError(`${what} is a password field; browser_run does not type into password fields from code.`);

  const resolveAriaRef = async (id: string): Promise<ElementHandle> => {
    const ref = parseAriaRefSelector(id) ?? id.trim();
    const handle = await resolveAriaRefHandle(page, ref);
    if (!handle) {
      throw new ToolError(
        `Unknown ARIA ref ${JSON.stringify(ref)}. Run tab.ariaSnapshot() to refresh refs (they renumber each snapshot).`,
      );
    }
    return handle;
  };

  /** An `aria-ref=eN` selector resolves against the latest ariaSnapshot's refs (main world); anything else goes through the normal locator wait. */
  const resolveActionHandle = async (selector: string, ms: number, sig: AbortSignal): Promise<ElementHandle> => {
    if (parseAriaRefSelector(selector) !== null) return resolveAriaRef(selector);
    return (await untilAborted(sig, () =>
      page.locator(normalizeSelector(selector)).setTimeout(ms).waitHandle({ signal: sig }),
    )) as ElementHandle;
  };

  const enrich = (handle: ElementHandle): ActionableHandle => {
    // Hand user-facing handles the fail-fast per-op guard so their interactive methods (`.click()`, `.type()`, ...) can't outrun the cell budget.
    const enriched = toActionableHandle(
      handle,
      (label, fn) => op(label, actionOpMs, fn),
      async () => {
        // Raw Puppeteer actions have no AbortSignal. Poison + dispose every cached handle and stop navigation before reporting a recoverable timeout.
        elements.clear();
        await session.stopLoading();
      },
    );
    if (c.refusePasswordFields) {
      const type = enriched.type.bind(enriched);
      const fill = enriched.fill.bind(enriched);
      enriched.type = async (...args: Parameters<typeof type>) => {
        if (await isPasswordField(enriched, signal)) throw refusePassword("handle");
        return type(...args);
      };
      enriched.fill = async value => {
        if (await isPasswordField(enriched, signal)) throw refusePassword("handle");
        return fill(value);
      };
    }
    return enriched;
  };

  const drag = async (from: DragTarget, to: DragTarget, sig: AbortSignal): Promise<void> => {
    const resolveDragPoint = async (target: DragTarget, role: "from" | "to"): Promise<RectPoint & { handle?: ElementHandle }> => {
      if (typeof target === "string") {
        const handle =
          parseAriaRefSelector(target) !== null
            ? await resolveAriaRef(target)
            : ((await untilAborted(sig, () => page.$(normalizeSelector(target)))) as ElementHandle | null);
        if (!handle) throw new ToolError(`Drag ${role} selector did not resolve: ${target}`);
        const box = await untilAborted(sig, () => handle.boundingBox());
        if (!box) {
          await handle.dispose().catch(() => undefined);
          throw new ToolError(`Drag ${role} element has no bounding box (likely not visible): ${target}`);
        }
        return { x: box.x + box.width / 2, y: box.y + box.height / 2, handle };
      }
      if (target !== null && typeof target === "object" && typeof target.x === "number" && typeof target.y === "number") {
        return { x: target.x, y: target.y };
      }
      throw new ToolError(`Drag ${role} must be a selector string or { x: number, y: number } point. Got: ${typeof target}`);
    };
    const start = await resolveDragPoint(from, "from");
    let end: (RectPoint & { handle?: ElementHandle }) | undefined;
    try {
      end = await resolveDragPoint(to, "to");
      await untilAborted(sig, () => page.mouse.move(start.x, start.y));
      await untilAborted(sig, () => page.mouse.down());
      await untilAborted(sig, () => page.mouse.move(end!.x, end!.y, { steps: 12 }));
      await untilAborted(sig, () => page.mouse.up());
    } finally {
      if (start.handle) await start.handle.dispose().catch(() => undefined);
      if (end?.handle) await end.handle.dispose().catch(() => undefined);
    }
  };

  const select = async (selector: string, values: string[], ms: number, sig: AbortSignal): Promise<string[]> => {
    const handle = await resolveActionHandle(selector, ms, sig);
    try {
      return (await untilAborted(sig, () =>
        handle.evaluate((el, vals) => {
          interface SelectOption {
            value: string;
            selected: boolean;
          }
          interface SelectLike {
            tagName: string;
            options: ArrayLike<SelectOption>;
            dispatchEvent: (event: unknown) => boolean;
          }
          const sel = el as unknown as SelectLike;
          if (sel?.tagName !== "SELECT") throw new Error("tab.select() requires a <select> element");
          const EventCtor = (globalThis as unknown as { Event: new (type: string, init?: { bubbles: boolean }) => unknown }).Event;
          const wanted = new Set(vals as string[]);
          // Assign the full selection first, then read back: on a single <select>, un-selecting the current option mid-loop leaves the browser reporting it
          // selected until another option takes over, which double-counted the old value in the returned list.
          for (let i = 0; i < sel.options.length; i++) {
            const opt = sel.options[i] as SelectOption;
            opt.selected = wanted.has(opt.value);
          }
          const selected: string[] = [];
          for (let i = 0; i < sel.options.length; i++) {
            const opt = sel.options[i] as SelectOption;
            if (opt.selected) selected.push(opt.value);
          }
          sel.dispatchEvent(new EventCtor("input", { bubbles: true }));
          sel.dispatchEvent(new EventCtor("change", { bubbles: true }));
          return selected;
        }, values),
      )) as string[];
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  };

  const uploadFile = async (selector: string, filePaths: string[], ms: number, sig: AbortSignal): Promise<void> => {
    if (!filePaths.length) throw new ToolError("tab.uploadFile() requires at least one file path");
    const handle = await resolveActionHandle(selector, ms, sig);
    try {
      const absolute = filePaths.map(filePath => resolveUploadPath(filePath, c.cwd));
      const upload = handle as unknown as { uploadFile: (...paths: string[]) => Promise<void> };
      const tagName = (await untilAborted(sig, () => handle.evaluate(el => (el as unknown as { tagName: string }).tagName))) as string;
      if (tagName !== "INPUT") {
        throw new ToolError(`tab.uploadFile() requires an <input type="file"> element (got <${tagName.toLowerCase()}>)`);
      }
      await untilAborted(sig, () => upload.uploadFile(...absolute));
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  };

  const waitForUrl = async (pattern: string | RegExp, timeout: number, sig: AbortSignal): Promise<string> => {
    const isRegex = pattern instanceof RegExp;
    const matcher = isRegex ? pattern.source : pattern;
    const flags = isRegex ? pattern.flags : "";
    await untilAborted(sig, () =>
      page.waitForFunction(
        (m: string, isRe: boolean, fl: string) => {
          const url = (globalThis as unknown as { location: { href: string } }).location.href;
          return isRe ? new RegExp(m, fl).test(url) : url.includes(m);
        },
        { timeout, polling: 200, signal: sig },
        matcher,
        isRegex,
        flags,
      ),
    );
    return page.url();
  };

  const waitForResponse = async (
    pattern: string | RegExp | ((response: HTTPResponse) => boolean | Promise<boolean>),
    timeout: number,
    sig: AbortSignal,
  ): Promise<HTTPResponse> => {
    const predicate: (response: HTTPResponse) => boolean | Promise<boolean> =
      typeof pattern === "function"
        ? pattern
        : pattern instanceof RegExp
          ? response => pattern.test(response.url())
          : response => response.url().includes(pattern);
    return (await untilAborted(sig, () => page.waitForResponse(predicate, { timeout, signal: sig }))) as HTTPResponse;
  };

  return {
    name: session.name,
    page,
    signal,
    url: () => page.url(),
    title: () => op("tab.title()", INF, sig => untilAborted(sig, () => page.title())),
    goto: (url, opts) =>
      op(`tab.goto(${JSON.stringify(url)})`, INF, async sig => {
        elements.clear();
        try {
          // Default to "load" because dev servers with HMR/WS never reach networkidle. budgetBound (not the full cell) so a hung navigation fails named and
          // catchable inside the run instead of dying with the whole cell.
          await untilAborted(sig, () => page.goto(url, { waitUntil: opts?.waitUntil ?? "load", timeout: budgetBound }));
        } catch (err) {
          if (err instanceof Error && err.name === "TimeoutError") {
            // Abandon the hung navigation NOW: a still-pending load stalls every later op on this page and cascades into more opaque timeouts.
            await session.stopLoading();
            throw new ToolError(
              `tab.goto(${JSON.stringify(url)}) timed out after ${budgetBound}ms; pending navigation stopped — retry with a longer tool timeout or waitUntil:"domcontentloaded"`,
            );
          }
          throw err;
        }
      }),
    observe: opts => op("tab.observe()", quickOpMs, sig => collectObservation(page, elements, { ...opts, signal: sig })),
    ariaSnapshot: (selector, opts) =>
      op(selector ? `tab.ariaSnapshot(${JSON.stringify(selector)})` : "tab.ariaSnapshot()", quickOpMs, async sig => {
        let root: ElementHandle | null = null;
        if (selector) {
          root = (await untilAborted(sig, () => page.$(normalizeSelector(selector)))) as ElementHandle | null;
          if (!root) throw new ToolError(`tab.ariaSnapshot: selector ${JSON.stringify(selector)} matched no element`);
        }
        try {
          return await untilAborted(sig, () => captureAriaSnapshot(page, root, opts));
        } finally {
          await root?.dispose().catch(() => undefined);
        }
      }),
    screenshot: opts =>
      op(describeScreenshot(opts), quickOpMs, sig =>
        captureScreenshot(
          {
            page,
            cdp: () => session.cdp(),
            resolveElement: async selector =>
              parseAriaRefSelector(selector) !== null
                ? resolveAriaRef(selector)
                : ((await untilAborted(sig, () => page.$(normalizeSelector(selector)))) as ElementHandle | null),
          },
          shot,
          output,
          screenshots,
          sig,
          opts,
        ),
      ),
    extract: (format = "markdown") =>
      op(`tab.extract(${JSON.stringify(format)})`, quickOpMs, async sig => {
        const html = (await untilAborted(sig, () => page.content())) as string;
        const result = await extractReadableFromHtml(html, page.url(), format);
        if (!result) {
          throw new ToolError(`tab.extract(${JSON.stringify(format)}) found no readable content on ${page.url()}`);
        }
        const content = format === "markdown" ? result.markdown : result.text;
        if (!content) {
          throw new ToolError(`tab.extract(${JSON.stringify(format)}) produced empty ${format} content for ${page.url()}`);
        }
        return content;
      }),
    click: selector =>
      op(
        `tab.click(${JSON.stringify(selector)})`,
        actionOpMs,
        async sig => {
          if (parseAriaRefSelector(selector) !== null) {
            const handle = await resolveAriaRef(selector);
            try {
              await untilAborted(sig, () => handle.click());
            } finally {
              await handle.dispose().catch(() => undefined);
            }
            return;
          }
          const resolved = normalizeSelector(selector);
          if (resolved.startsWith("text/")) await clickQueryHandlerText(page, resolved, actionOpMs, sig);
          else await untilAborted(sig, () => page.locator(resolved).setTimeout(actionOpMs).click({ signal: sig }));
        },
        { selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
      ),
    type: (selector, text) =>
      op(
        `tab.type(${JSON.stringify(selector)})`,
        actionOpMs,
        async sig => {
          const handle = await resolveActionHandle(selector, actionOpMs, sig);
          try {
            if (c.refusePasswordFields && (await isPasswordField(handle, sig))) throw refusePassword(JSON.stringify(selector));
            await untilAborted(sig, () => handle.type(text, { delay: 0 }));
          } finally {
            await handle.dispose().catch(() => undefined);
          }
        },
        { selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
      ),
    fill: (selector, value) =>
      op(
        `tab.fill(${JSON.stringify(selector)})`,
        actionOpMs,
        async sig => {
          if (parseAriaRefSelector(selector) !== null) {
            const handle = await resolveAriaRef(selector);
            try {
              if (c.refusePasswordFields && (await isPasswordField(handle, sig))) throw refusePassword(JSON.stringify(selector));
              await fillViaHandle(handle, value, sig);
            } finally {
              await handle.dispose().catch(() => undefined);
            }
            return;
          }
          if (c.refusePasswordFields) {
            const probe = (await untilAborted(sig, () => page.$(normalizeSelector(selector)))) as ElementHandle | null;
            try {
              if (probe && (await isPasswordField(probe, sig))) throw refusePassword(JSON.stringify(selector));
            } finally {
              await probe?.dispose().catch(() => undefined);
            }
          }
          await untilAborted(sig, () => page.locator(normalizeSelector(selector)).setTimeout(actionOpMs).fill(value, { signal: sig }));
        },
        { selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
      ),
    press: (key, opts) =>
      op(`tab.press(${JSON.stringify(key)})`, actionOpMs, async sig => {
        const selector = opts?.selector;
        if (selector) {
          if (parseAriaRefSelector(selector) !== null) {
            const handle = await resolveAriaRef(selector);
            try {
              await untilAborted(sig, () => handle.focus());
            } finally {
              await handle.dispose().catch(() => undefined);
            }
          } else await untilAborted(sig, () => page.focus(normalizeSelector(selector)));
        }
        await untilAborted(sig, () => page.keyboard.press(key));
      }),
    scroll: (deltaX, deltaY) =>
      op("tab.scroll()", actionOpMs, sig => untilAborted(sig, () => dispatchScroll(() => page.mouse.wheel({ deltaX, deltaY })))),
    drag: (from, to) => op("tab.drag()", actionOpMs, sig => drag(from, to, sig)),
    waitFor: (selector, opts) => {
      const w = waitMs(opts?.timeout);
      return op(
        `tab.waitFor(${JSON.stringify(selector)})`,
        w,
        async sig => enrich(await resolveActionHandle(selector, w, sig)),
        { selector, zeroMatchAfterMs: opts?.timeout === undefined ? ZERO_MATCH_FAIL_FAST_MS : undefined },
      );
    },
    waitForSelector: (selector, opts) => {
      const w = waitMs(opts?.timeout);
      return op(
        `tab.waitForSelector(${JSON.stringify(selector)})`,
        w,
        async sig => {
          if (parseAriaRefSelector(selector) !== null) return enrich(await resolveAriaRef(selector));
          const handle = (await untilAborted(sig, () =>
            page.waitForSelector(normalizeSelector(selector), {
              timeout: w,
              visible: opts?.visible,
              hidden: opts?.hidden,
              signal: sig,
            }),
          )) as ElementHandle | null;
          return handle ? enrich(handle) : null;
        },
        {
          selector,
          // `hidden: true` waits for zero matches: that is success, never a fast-fail.
          zeroMatchAfterMs: opts?.timeout === undefined && !opts?.hidden ? ZERO_MATCH_FAIL_FAST_MS : undefined,
        },
      );
    },
    waitForNavigation: opts => {
      const w = waitMs(opts?.timeout);
      return op("tab.waitForNavigation()", w, sig =>
        untilAborted(sig, () => page.waitForNavigation({ waitUntil: opts?.waitUntil ?? "load", timeout: w, signal: sig })),
      );
    },
    evaluate: (fn, ...args) =>
      op("tab.evaluate()", INF, sig =>
        untilAborted(sig, () => {
          // The page's main world, where the app's own globals live. Frame.mainRealm() is puppeteer's internal handle on it; page.evaluate is the same call.
          const frame: MainRealmFrame = page.mainFrame();
          const realm = frame.mainRealm?.();
          const rest: unknown[] = args;
          return realm ? realm.evaluate(fn, ...rest) : page.evaluate(fn as never, ...(rest as never[]));
        }),
      ) as never,
    scrollIntoView: selector =>
      op(
        `tab.scrollIntoView(${JSON.stringify(selector)})`,
        actionOpMs,
        async sig => {
          const handle = await resolveActionHandle(selector, actionOpMs, sig);
          try {
            await untilAborted(sig, () =>
              handle.evaluate(el => {
                const target = el as unknown as { scrollIntoView: (opts: { behavior: string; block: string; inline: string }) => void };
                target.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
              }),
            );
          } finally {
            await handle.dispose().catch(() => undefined);
          }
        },
        { selector, zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS },
      ),
    select: (selector, ...values) =>
      op(`tab.select(${JSON.stringify(selector)})`, actionOpMs, sig => select(selector, values, actionOpMs, sig), {
        selector,
        zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS,
      }),
    uploadFile: (selector, ...filePaths) =>
      op(`tab.uploadFile(${JSON.stringify(selector)})`, actionOpMs, sig => uploadFile(selector, filePaths, actionOpMs, sig), {
        selector,
        zeroMatchAfterMs: ZERO_MATCH_FAIL_FAST_MS,
      }),
    waitForUrl: (pattern, opts) => {
      const w = waitMs(opts?.timeout);
      return op("tab.waitForUrl()", w, sig => waitForUrl(pattern, w, sig));
    },
    waitForResponse: (pattern, opts) => {
      const w = waitMs(opts?.timeout);
      return op("tab.waitForResponse()", w, sig => waitForResponse(pattern, w, sig));
    },
    // Through `op` like every sibling above. These two returned the raw promise in OMP's first version, so a caller that did not await left the rejection
    // unobserved and a stale ARIA ref killed a live session: `op` supplies markHandled, the run's abort signal, a per-op timeout and a labelled failure.
    id: n =>
      op(`tab.id(${JSON.stringify(n)})`, actionOpMs, async () => {
        const handle = await session.elements.resolve(n);
        return enrich(handle);
      }),
    ref: refId => op(`tab.ref(${JSON.stringify(refId)})`, actionOpMs, async () => enrich(await resolveAriaRef(refId))),
  };
}
