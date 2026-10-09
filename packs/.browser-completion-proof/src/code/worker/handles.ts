// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/tab-worker.ts (ActionableHandle, toActionableHandle, runGuardedHandleAction, typeViaHandle, fillViaHandle) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: imports only; ToolError, throwIfAborted and the abort helpers come from the pack's own modules.

import type { ElementHandle, KeyboardTypeOptions } from "puppeteer-core";
import { ToolError, throwIfAborted } from "../errors";
import { untilAborted, withTimeout } from "./abortable";

/** Bound cleanup window after a timed-out raw handle action. */
export const HANDLE_ACTION_INVALIDATION_TIMEOUT_MS = 500;

/** ElementHandle enriched with the `fill()` the tool docs promise on handles from `tab.id()`/`tab.ref()`/`tab.waitFor()`. */
export type ActionableHandle = ElementHandle & { fill(value: string): Promise<void> };

/**
 * A named per-op guard: runs `fn` inside the active run's fail-fast deadline and
 * in-flight tracking (the same wrapper `tab.click(selector)` uses), so a stalled
 * handle action rejects with a named error before the cell budget instead of
 * hanging on puppeteer's protocol timeout.
 */
export type HandleOpGuard = <T>(label: string, fn: (signal: AbortSignal) => Promise<T>) => Promise<T>;

/**
 * Every `ElementHandle` method that dispatches input, pointer/touch, drag, or navigation
 * work and can therefore stall on a busy page. When {@link toActionableHandle} is given a
 * guard, each is routed through the per-op fail-fast wrapper; without it the inherited
 * puppeteer method runs outside the op map and a stall consumes the whole cell (issue #9535).
 * Pure reads (`boundingBox`, `screenshot`, `evaluate`, queries) are omitted — they are not
 * user-driven actions and keep their native puppeteer behavior.
 */
const GUARDED_HANDLE_METHODS = [
	"click",
	"type",
	"hover",
	"tap",
	"focus",
	"press",
	"select",
	"uploadFile",
	"scrollIntoView",
	"drag",
	"dragEnter",
	"dragOver",
	"drop",
	"dragAndDrop",
	"touchStart",
	"touchMove",
	"touchEnd",
	"autofill",
] as const satisfies readonly (keyof ElementHandle)[];

type GuardedHandleMethod = (typeof GUARDED_HANDLE_METHODS)[number];
type RawHandleMethod = (...args: unknown[]) => Promise<unknown>;

interface RawHandleMethods {
	interactive: Partial<Record<GuardedHandleMethod, RawHandleMethod>>;
	type: ElementHandle["type"];
	invalidatedBy?: string;
}

/** Symbol-keyed original methods travel with each cached handle without enumerating or colliding. */
const RAW_HANDLE_METHODS = Symbol("browser.rawHandleMethods");

type HandleWithRawMethods = ActionableHandle & { [RAW_HANDLE_METHODS]?: RawHandleMethods };

async function runGuardedHandleAction<T>(
	handle: ElementHandle,
	state: RawHandleMethods,
	label: string,
	signal: AbortSignal,
	action: () => Promise<T>,
	invalidate?: () => Promise<void>,
): Promise<T> {
	if (state.invalidatedBy) {
		throw new ToolError(
			`${label} cannot run: this handle was invalidated after ${state.invalidatedBy} timed out; ` +
				"run tab.observe() or tab.ariaSnapshot() to resolve a fresh handle",
		);
	}
	throwIfAborted(signal);
	const pending = action();
	try {
		return await untilAborted(signal, () => pending);
	} catch (error) {
		if (!signal.aborted) throw error;
		state.invalidatedBy = label;
		void pending.catch(() => undefined);
		await withTimeout(
			Promise.all([handle.dispose().catch(() => undefined), invalidate?.().catch(() => undefined)]),
			HANDLE_ACTION_INVALIDATION_TIMEOUT_MS,
			`Timed out invalidating ${label}`,
		).catch(() => undefined);
		throw error;
	}
}

/**
 * Attach `fill()` to a puppeteer ElementHandle before handing it to user code and,
 * when a `guard` is supplied, route every interactive method ({@link GUARDED_HANDLE_METHODS})
 * through the same fail-fast per-op wrapper as the selector-based helpers — so
 * `(await tab.id(n)).click()` fails fast with `handle.click() timed out after …ms`
 * instead of stalling until the whole browser cell expires. Repeated enrichment is
 * idempotent: cached handles are always rewrapped from their original bound methods,
 * never from wrappers retaining an earlier run's guard. A timed-out action invalidates
 * and disposes its handle before surfacing the named error, so catching it cannot
 * dispatch a duplicate retry through the stale handle. Puppeteer handles expose
 * `type()` but no `fill()`; the `fill()` semantics mirror the selector-based
 * `tab.fill()`: focus, clear any existing value, then type.
 */
export function toActionableHandle(
	handle: ElementHandle,
	guard?: HandleOpGuard,
	invalidate?: () => Promise<void>,
): ActionableHandle {
	const enriched = handle as HandleWithRawMethods;
	const methods = enriched as unknown as Partial<Record<GuardedHandleMethod, RawHandleMethod>>;
	const preserved = enriched[RAW_HANDLE_METHODS];
	if (!guard) {
		if (preserved) {
			for (const method of GUARDED_HANDLE_METHODS) {
				const original = preserved.interactive[method];
				if (original) methods[method] = original;
			}
		}
		enriched.fill = value => fillViaHandle(enriched, value, undefined, preserved?.type);
		return enriched;
	}

	let originals = preserved;
	if (!originals) {
		const interactive: Partial<Record<GuardedHandleMethod, RawHandleMethod>> = {};
		for (const method of GUARDED_HANDLE_METHODS) {
			const original = methods[method];
			if (typeof original === "function") interactive[method] = original.bind(enriched);
		}
		originals = { interactive, type: enriched.type.bind(enriched) };
		enriched[RAW_HANDLE_METHODS] = originals;
	}

	for (const method of GUARDED_HANDLE_METHODS) {
		if (method === "type") continue;
		const original = originals.interactive[method];
		if (!original) continue;
		methods[method] = (...args) =>
			guard(`handle.${method}()`, signal =>
				runGuardedHandleAction(
					enriched,
					originals,
					`handle.${method}()`,
					signal,
					() => original(...args),
					invalidate,
				),
			);
	}
	enriched.type = (text, options) =>
		guard<void>("handle.type()", signal =>
			runGuardedHandleAction(
				enriched,
				originals,
				"handle.type()",
				signal,
				() => typeViaHandle(enriched, text, options, signal),
				invalidate,
			),
		);
	enriched.fill = value =>
		guard<void>("handle.fill()", signal =>
			runGuardedHandleAction(
				enriched,
				originals,
				"handle.fill()",
				signal,
				() => fillViaHandle(enriched, value, signal, text => typeViaHandle(enriched, text, { delay: 0 }, signal)),
				invalidate,
			),
		);
	return enriched;
}

/** Focus once, then type one code point at a time so abort stops before the next key dispatch. */
export async function typeViaHandle(
	handle: ElementHandle,
	text: string,
	options: Readonly<KeyboardTypeOptions> | undefined,
	signal: AbortSignal,
): Promise<void> {
	await untilAborted(signal, () =>
		handle.evaluate(el => {
			const node = el as unknown as { focus?: () => void };
			node.focus?.();
		}),
	);
	for (const character of text) {
		throwIfAborted(signal);
		await untilAborted(signal, () => handle.frame.page().keyboard.type(character, options));
	}
}

/** Focus, clear any existing value, then retype — shared by `tab.fill(aria-ref)` and enriched handles. */
export async function fillViaHandle(
	handle: ElementHandle,
	value: string,
	signal?: AbortSignal,
	type: (text: string) => Promise<unknown> = text => handle.type(text, { delay: 0 }),
): Promise<void> {
	await untilAborted(signal, () =>
		handle.evaluate(el => {
			const node = el as unknown as { value?: string; focus?: () => void };
			node.focus?.();
			if ("value" in node) node.value = "";
		}),
	);
	await untilAborted(signal, () => type(value));
}
