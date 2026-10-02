// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/tab-worker.ts (nextElementId, cacheElement, #resolveCachedHandle, #clearElementCache) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../third-party/omp/LICENSE.
// Changed for the Browser pack: the worker's element map and counter become one class so the stale-handle rules sit together; behaviour and messages are OMP's.

import type { ElementHandle } from "puppeteer-core";
import { ToolError } from "../errors";

/**
 * The tab's observed elements: ids from a per-observe counter, invalidated wholesale by `observe`, `goto` and a timed-out handle action
 * (matrix D11). A cached handle that left the document is reported as stale, never silently re-resolved.
 */
export class ElementCache {
	#handles = new Map<number, ElementHandle>();
	#counter = 0;

	get size(): number {
		return this.#handles.size;
	}

	nextId(): number {
		this.#counter += 1;
		return this.#counter;
	}

	set(id: number, handle: ElementHandle): void {
		this.#handles.set(id, handle);
	}

	/** The live handle for `id`, or the OMP message naming what to do. */
	async resolve(id: number): Promise<ElementHandle> {
		const handle = this.#handles.get(id);
		if (!handle) throw new ToolError(`Unknown element id ${id}. Run tab.observe() to refresh the element list.`);
		try {
			const isConnected = (await handle.evaluate(el => el.isConnected)) as boolean;
			if (!isConnected) {
				this.clear();
				throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
			}
		} catch (err) {
			if (err instanceof ToolError) throw err;
			this.clear();
			throw new ToolError(`Element id ${id} is stale. Run tab.observe() again.`);
		}
		return handle;
	}

	/** Forget every id and dispose the handles; the next observe numbers from 1 again. */
	clear(): void {
		if (this.#handles.size === 0) {
			this.#counter = 0;
			return;
		}
		const handles = [...this.#handles.values()];
		this.#handles.clear();
		this.#counter = 0;
		for (const handle of handles) void handle.dispose().catch(() => undefined);
	}
}
