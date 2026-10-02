// Written for the Browser pack (doc 77 §7.4.6, matrix F6). The code host's side of a cmux browser: what the runtime does for a Chrome (make it, hand out its tabs, end it), done for a cmux daemon, which the runtime knows nothing of.

/**
 * A cmux "browser" is a connection to the daemon of a terminal app and the surfaces (WKWebViews) a cell has open there. The runtime owns Chromes; this owns the surfaces, on the main thread, so the code host sees one
 * port (`CodeBrowserPort`): `acquire` connects, `openTab` opens a split (or attaches to the surface the environment named) and says what is in it, `closeTab` closes a split the pack opened, `release` lets go of the
 * connection. Cells run on a surface in the worker (cmux-realm.ts), over a connection of their own.
 *
 * Nothing here is reachable without cmux: a browser of this kind is only made when the environment names a daemon socket (`CMUX_SOCKET_PATH`, kinds/resolve.ts) or the cell asked for one.
 */
import { randomBytes } from "node:crypto";
import type { AcquiredBrowser, BrowserKind, TabRef, WaitUntil } from "../../contracts.js";
import { ToolError } from "../../errors.js";
import { establishKind, type EstablishOptions } from "../establish.js";
import { describeBrowser, describeKind } from "../resolve.js";
import { CmuxTab } from "./cmux-tab.js";
import { closeCmuxSurface, openCmuxSurface } from "./cmux-surface.js";
import type { CmuxSocketClient } from "./socket-client.js";

type CmuxKind = Extract<BrowserKind, { kind: "cmux" }>;
type EndListener = (browserId: string, why: "closed" | "retired" | "taken-over", reason?: string) => void;

export interface CmuxBrowsersOptions {
	/** How the daemon is reached; a test passes its fake socket. Default: {@link establishKind}. */
	establish?: typeof establishKind;
	/** A browser nothing has called for this long is let go, and the splits it opened with it (OMP's `browser.idleCloseSec`); 0 = never. Default 1,800,000. */
	idleMs?: number;
}

interface Surface {
	surfaceId: string;
	/** A split this host opened: closing the tab closes it. */
	owned: boolean;
	url: string;
	title: string;
}

interface Held {
	browserId: string;
	session: string;
	kind: CmuxKind;
	client: CmuxSocketClient;
	label: string;
	surfaces: Map<string, Surface>;
	/** The surface a cell most recently opened or navigated: the `active` one. */
	active: string | undefined;
	lastUsed: number;
	working: number;
	idle: NodeJS.Timeout | undefined;
}

/** OMP's `browser.idleCloseSec`: 1,800 s. */
const IDLE_MS = 1_800_000;

export class CmuxBrowsers {
	readonly #establish: typeof establishKind;
	readonly #idleMs: number;
	readonly #byId = new Map<string, Held>();
	/** Per session and daemon: the connection in flight, so two `browser.open`s that start together share one. */
	readonly #connecting = new Map<string, Promise<Held>>();
	readonly #endListeners = new Set<EndListener>();

	constructor(options: CmuxBrowsersOptions = {}) {
		this.#establish = options.establish ?? establishKind;
		this.#idleMs = options.idleMs ?? IDLE_MS;
	}

	owns(browserId: string): boolean {
		return this.#byId.has(browserId);
	}

	#held(browserId: string): Held {
		const held = this.#byId.get(browserId);
		if (held === undefined) throw new ToolError(`The cmux browser is gone (it was closed, or let go after ${Math.round(this.#idleMs / 1_000)} s with no calls); open a new one with browser.open`);
		return held;
	}

	async acquire(session: string, kind: CmuxKind, signal: AbortSignal): Promise<AcquiredBrowser> {
		const key = `${session}\u0000${describeKind(kind)}`;
		for (const held of this.#byId.values()) {
			if (held.session === session && describeKind(held.kind) === describeKind(kind)) {
				this.#touch(held);
				return { browserId: held.browserId, created: false, wsEndpoint: "", label: held.label };
			}
		}
		let connecting = this.#connecting.get(key);
		const starter = connecting === undefined;
		if (connecting === undefined) {
			connecting = this.#connect(session, kind, signal).finally(() => this.#connecting.delete(key));
			this.#connecting.set(key, connecting);
		}
		const held = await connecting;
		return { browserId: held.browserId, created: starter, wsEndpoint: "", label: held.label };
	}

	async #connect(session: string, kind: CmuxKind, signal: AbortSignal): Promise<Held> {
		const options: EstablishOptions = { signal };
		const established = await this.#establish(kind, options);
		if (!("cmux" in established)) throw new ToolError("the cmux kind did not resolve to a cmux socket");
		const held: Held = {
			browserId: `cmux-${randomBytes(12).toString("base64url")}`,
			session,
			kind,
			client: established.cmux.client,
			label: describeBrowser(kind),
			surfaces: new Map(),
			active: undefined,
			lastUsed: performance.now(),
			working: 0,
			idle: undefined,
		};
		this.#byId.set(held.browserId, held);
		this.#watchIdle(held, this.#idleMs);
		return held;
	}

	async openTab(browserId: string, o: { url?: string; waitUntil?: WaitUntil; timeoutMs: number }, signal: AbortSignal): Promise<TabRef> {
		const held = this.#held(browserId);
		this.#touch(held);
		const opened = await openCmuxSurface({
			client: held.client,
			...(held.kind.surface === undefined ? {} : { surface: held.kind.surface }),
			...(o.url === undefined ? {} : { url: o.url }),
			...(o.waitUntil === undefined ? {} : { waitUntil: o.waitUntil }),
			timeoutMs: o.timeoutMs,
			signal,
		});
		const surface: Surface = { surfaceId: opened.surfaceId, owned: opened.ownsSurface, url: opened.info.url, title: opened.info.title ?? "" };
		// A surface two names are attached to is closed with the first split's own record, not twice.
		const known = held.surfaces.get(surface.surfaceId);
		held.surfaces.set(surface.surfaceId, { ...surface, owned: surface.owned || known?.owned === true });
		held.active = surface.surfaceId;
		return this.#ref(held, surface.surfaceId);
	}

	async navigateTab(browserId: string, tabId: string, o: { url: string; waitUntil?: WaitUntil; timeoutMs: number }, signal: AbortSignal): Promise<TabRef> {
		const held = this.#held(browserId);
		const surface = held.surfaces.get(tabId);
		if (surface === undefined) throw new ToolError(`The cmux surface ${tabId} is not one of this browser's tabs`);
		this.#touch(held);
		const tab = new CmuxTab({ client: held.client, surfaceId: tabId, url: surface.url });
		await tab.goto(o.url, { waitUntil: o.waitUntil ?? "load", timeoutMs: o.timeoutMs });
		if (signal.aborted) throw signal.reason;
		const info = await tab.readyInfo();
		surface.url = info.url;
		surface.title = info.title ?? surface.title;
		held.active = tabId;
		return this.#ref(held, tabId);
	}

	tabs(browserId: string): TabRef[] {
		const held = this.#held(browserId);
		return [...held.surfaces.keys()].map(surfaceId => this.#ref(held, surfaceId));
	}

	#ref(held: Held, surfaceId: string): TabRef {
		const surface = held.surfaces.get(surfaceId)!;
		return { tabId: surfaceId, targetId: surfaceId, url: surface.url, title: surface.title, active: held.active === surfaceId };
	}

	/** Close the split this host opened for `tabId`; a surface the person pointed the cell at is theirs and is left open. */
	async closeTab(browserId: string, tabId: string): Promise<void> {
		const held = this.#held(browserId);
		const surface = held.surfaces.get(tabId);
		if (surface === undefined) return;
		held.surfaces.delete(tabId);
		if (held.active === tabId) held.active = [...held.surfaces.keys()].at(-1);
		if (surface.owned) await closeCmuxSurface(held.client, tabId);
	}

	/** A cell is running on the browser: the idle clock does not let it go. */
	holdWork(browserId: string): () => void {
		const held = this.#held(browserId);
		held.working += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			held.working -= 1;
			held.lastUsed = performance.now();
		};
	}

	/** Let go of the connection, and of any split still open. */
	async release(browserId: string): Promise<void> {
		const held = this.#byId.get(browserId);
		if (held === undefined) return;
		await this.#drop(held);
	}

	async dispose(): Promise<void> {
		this.#endListeners.clear();
		await Promise.allSettled([...this.#byId.values()].map(held => this.#drop(held)));
	}

	onEnd(listener: EndListener): () => void {
		this.#endListeners.add(listener);
		return () => void this.#endListeners.delete(listener);
	}

	async #drop(held: Held): Promise<void> {
		if (this.#byId.get(held.browserId) !== held) return;
		this.#byId.delete(held.browserId);
		clearTimeout(held.idle);
		for (const surface of held.surfaces.values()) if (surface.owned) await closeCmuxSurface(held.client, surface.surfaceId);
		held.surfaces.clear();
		held.client.close();
	}

	#touch(held: Held): void {
		held.lastUsed = performance.now();
	}

	#watchIdle(held: Held, afterMs: number): void {
		if (this.#idleMs <= 0) return;
		held.idle = setTimeout(() => this.#checkIdle(held), afterMs);
		held.idle.unref();
	}

	#checkIdle(held: Held): void {
		if (this.#byId.get(held.browserId) !== held) return;
		const quiet = performance.now() - held.lastUsed;
		if (held.working > 0 || quiet < this.#idleMs) {
			this.#watchIdle(held, held.working > 0 ? this.#idleMs : this.#idleMs - quiet);
			return;
		}
		const reason = `it was a cmux browser, let go after ${Math.round(this.#idleMs / 1_000)} s with no calls; open a new one with browser.open`;
		void this.#drop(held).finally(() => {
			for (const listener of [...this.#endListeners]) listener(held.browserId, "retired", reason);
		});
	}
}
