// Copied from OMP (https://github.com/can1357/oh-my-pi, MIT), packages/coding-agent/src/tools/browser/tab-supervisor.ts:508-585 (acquireCmuxTab: the split's opening, its wait and the abort rule) @ dc5f95d9e1 (Dimension omp fork).
// Copyright (c) 2025 Mario Zechner; (c) 2025-2026 Can Bölük; (c) 2026 Stencil Labs, Inc. See ../../../../third-party/omp/LICENSE.
// Changed for the Browser pack: (matrix F6) opening is separate from running. The code host opens (or attaches to) the surface on the main thread, where `browser.open` is answered and the cell is told the page's URL and title; the worker
// then adopts it by its UUID and runs cells on it (cmux-realm.ts). OMP's supervisor held the surface and the run in one process; here a cell never runs on the thread that holds the server.

/**
 * Opens a cmux browser surface, or attaches to one that exists. A surface is a WKWebView in the person's terminal app, not a Chrome page: there is no CDP and no engine,
 * so the daemon's socket is the only way to it. A split this opens is the pack's to close (`ownsSurface`); a surface it was pointed at is the person's and stays.
 */
import type { WaitUntil } from "../../contracts.js";
import { ToolAbortError, ToolError } from "../../errors.js";
import { CmuxTab, type ReadyInfo } from "./cmux-tab.js";
import { mapWaitUntil } from "./rpc.js";
import type { CmuxSocketClient } from "./socket-client.js";

export interface CmuxOpenOptions {
	client: CmuxSocketClient;
	/** Attach to this surface (a UUID) instead of opening a split. */
	surface?: string;
	url?: string;
	waitUntil?: WaitUntil;
	timeoutMs: number;
	signal?: AbortSignal;
	viewport?: { width: number; height: number; deviceScaleFactor?: number };
}

export interface OpenedSurface {
	surfaceId: string;
	/** A split this call opened: closing the tab closes it. */
	ownsSurface: boolean;
	/** What the surface says of itself now. */
	info: ReadyInfo;
}

/** `app.surface` must be the UUID cmux gives (`CMUX_SURFACE_ID`), not a `surface:N` ref. */
export function assertSurfaceId(surface: string | undefined): void {
	if (surface?.startsWith("surface:")) {
		throw new ToolError("app.surface must be a surface UUID (e.g. CMUX_SURFACE_ID), not a 'surface:N' ref; omit it to open a new split");
	}
}

/** Open a split at `url` (waiting for it to load) or attach to `surface` (navigating it when `url` is given). A caller that gave up while the split was opening gets nothing, and the split is closed again. */
export async function openCmuxSurface(o: CmuxOpenOptions): Promise<OpenedSurface> {
	assertSurfaceId(o.surface);
	let surfaceId = o.surface;
	let initialUrl = o.url;
	let ownsSurface = false;
	try {
		if (!surfaceId) {
			const params: Record<string, unknown> = { url: o.url ?? "about:blank", focus: false };
			if (process.env.CMUX_WORKSPACE_ID) params.workspace_id = process.env.CMUX_WORKSPACE_ID;
			if (process.env.CMUX_SURFACE_ID) params.surface_id = process.env.CMUX_SURFACE_ID;
			const result = await o.client.request("browser.open_split", params, { timeoutMs: o.timeoutMs });
			if (typeof result.surface_id !== "string" || result.surface_id.length === 0) throw new ToolError("cmux browser.open_split did not return a surface_id");
			surfaceId = result.surface_id;
			ownsSurface = true;
			if (typeof result.url === "string" && result.url.length > 0) initialUrl = result.url;
			if (o.url) {
				await o.client.request(
					"browser.wait",
					{ surface_id: surfaceId, load_state: mapWaitUntil(o.waitUntil ?? "load"), timeout_ms: o.timeoutMs },
					{ timeoutMs: o.timeoutMs },
				);
			}
		}
		const tab = new CmuxTab({ client: o.client, surfaceId, ...(initialUrl === undefined ? {} : { url: initialUrl }) });
		if (o.surface && o.url) await tab.goto(o.url, { waitUntil: o.waitUntil ?? "load", timeoutMs: o.timeoutMs });
		const info = await tab.readyInfo(o.viewport);
		if (o.signal?.aborted) throw new ToolAbortError("Browser tab open aborted");
		return { surfaceId, ownsSurface, info };
	} catch (error) {
		if (ownsSurface && surfaceId) await o.client.request("surface.close", { surface_id: surfaceId }).catch(() => undefined);
		throw error;
	}
}

/** Close a surface the pack opened. Best effort: the person may have closed it already. */
export async function closeCmuxSurface(client: CmuxSocketClient, surfaceId: string): Promise<void> {
	await client.request("surface.close", { surface_id: surfaceId }).catch(() => undefined);
}
