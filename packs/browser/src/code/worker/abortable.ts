// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/utils/src/abortable.ts (untilAborted, AbortError) and packages/utils/src/async.ts (withTimeout) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: only those three helpers; `sleep` replaces Bun.sleep (the code worker runs on Node).

import assert from "node:assert/strict";

/** Rejection of an `untilAborted` race: the signal fired before the promise settled. */
export class AbortError extends Error {
  constructor(signal: AbortSignal) {
    assert(signal.aborted, "Abort signal must be aborted");

    const message = signal.reason instanceof Error ? signal.reason.message : "Cancelled";
    super(`Aborted: ${message}`, { cause: signal.reason });
    this.name = "AbortError";
  }
}

/**
 * Runs a promise-returning function (`pr`). If the given AbortSignal is aborted before or during
 * execution, the promise is rejected with an `AbortError`.
 */
export function untilAborted<T>(
  signal: AbortSignal | undefined | null,
  pr: Promise<T> | (() => Promise<T>),
): Promise<T> {
  if (!signal) return typeof pr === "function" ? pr() : pr;
  if (signal.aborted) return Promise.reject(new AbortError(signal));

  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = () => reject(new AbortError(signal));
  signal.addEventListener("abort", onAbort, { once: true });

  void (async () => {
    try {
      resolve(await (typeof pr === "function" ? pr() : pr));
    } catch (err) {
      reject(err);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  })();

  return promise;
}

/** Reject with `timeout` after `ms`, or settle as `promise` does; an aborted `signal` rejects early. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeout: string | Error,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
    return Promise.reject(reason);
  }

  const { promise: wrapped, resolve, reject } = Promise.withResolvers<T>();
  let settled = false;
  const timeoutId = setTimeout(() => {
    if (settled) return;
    settled = true;
    if (signal) signal.removeEventListener("abort", onAbort);
    reject(typeof timeout === "string" ? new Error(timeout) : timeout);
  }, ms);

  const onAbort = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
  };

  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  promise.then(
    (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(value);
    },
    (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    },
  );

  return wrapped;
}

/** Resolve after `ms` (OMP's `Bun.sleep`). */
export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
