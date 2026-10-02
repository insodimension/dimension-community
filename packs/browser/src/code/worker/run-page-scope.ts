// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/tab-worker.ts (RunPageScope, createRunPageScope) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: none beyond imports; the error payload mapping is in run-error.ts.

import type { Page } from "puppeteer-core";
import { withTimeout } from "./abortable";
import { RequestInterceptionCleanupError } from "./run-error";

/** Cleanup must settle inside the host's 750ms post-run grace window. */
export const REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS = 500;

export interface RunPageScope {
  page: Page;
  cleanup(): Promise<void>;
}

/**
 * Expose the tab page while retaining the request handlers created by this run.
 * Puppeteer's Page wraps an internal emitter, so `removeAllListeners("request")`
 * would also remove its forwarding listener; the facade removes only user handlers.
 */
export function createRunPageScope(page: Page): RunPageScope {
  const requestHandlers: unknown[] = [];
  const on = page.on;
  const off = page.off;
  const once = page.once;
  const removeAllListeners = page.removeAllListeners;
  const onDescriptor = Object.getOwnPropertyDescriptor(page, "on");
  const offDescriptor = Object.getOwnPropertyDescriptor(page, "off");
  const onceDescriptor = Object.getOwnPropertyDescriptor(page, "once");
  const removeAllDescriptor = Object.getOwnPropertyDescriptor(page, "removeAllListeners");

  Object.defineProperties(page, {
    on: {
      configurable: true,
      value: (type: unknown, handler: unknown): Page => {
        Reflect.apply(on, page, [type, handler]);
        if (type === "request") requestHandlers.push(handler);
        return page;
      },
    },
    once: {
      configurable: true,
      value: (type: unknown, handler: unknown): Page => {
        if (type !== "request" || typeof handler !== "function") {
          Reflect.apply(once, page, [type, handler]);
          return page;
        }
        const wrapper = (event: unknown): void => {
          const index = requestHandlers.lastIndexOf(wrapper);
          if (index >= 0) requestHandlers.splice(index, 1);
          Reflect.apply(off, page, ["request", wrapper]);
          Reflect.apply(handler, page, [event]);
        };
        requestHandlers.push(wrapper);
        Reflect.apply(on, page, [type, wrapper]);
        return page;
      },
    },
    off: {
      configurable: true,
      value: (type: unknown, handler?: unknown): Page => {
        Reflect.apply(off, page, [type, handler]);
        if (type === "request") {
          if (handler === undefined) requestHandlers.length = 0;
          else {
            const index = requestHandlers.lastIndexOf(handler);
            if (index >= 0) requestHandlers.splice(index, 1);
          }
        }
        return page;
      },
    },
    removeAllListeners: {
      configurable: true,
      value: (type?: unknown): Page => {
        Reflect.apply(removeAllListeners, page, [type]);
        if (type === undefined || type === "request") requestHandlers.length = 0;
        return page;
      },
    },
  });

  return {
    page,
    async cleanup() {
      if (onDescriptor) Object.defineProperty(page, "on", onDescriptor);
      else Reflect.deleteProperty(page, "on");
      if (offDescriptor) Object.defineProperty(page, "off", offDescriptor);
      else Reflect.deleteProperty(page, "off");
      if (onceDescriptor) Object.defineProperty(page, "once", onceDescriptor);
      else Reflect.deleteProperty(page, "once");
      if (removeAllDescriptor) Object.defineProperty(page, "removeAllListeners", removeAllDescriptor);
      else Reflect.deleteProperty(page, "removeAllListeners");
      for (const handler of requestHandlers) Reflect.apply(off, page, ["request", handler]);
      requestHandlers.length = 0;
      try {
        await withTimeout(
          page.setRequestInterception(false),
          REQUEST_INTERCEPTION_CLEANUP_TIMEOUT_MS,
          "Timed out clearing browser request interception",
        );
      } catch (error) {
        throw new RequestInterceptionCleanupError("Failed to clear browser request interception after browser.run", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
