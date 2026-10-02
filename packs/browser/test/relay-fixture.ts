/**
 * A Chrome extension host for the relay tests: the REAL shipped `relay-extension/background.js`, run in a sandbox whose `chrome.*` is backed by a real
 * headless Chrome. `chrome.tabs` lists that Chrome's pages, `chrome.debugger` forwards commands and events over the pages' own DevTools sockets (one
 * attachment per tab, like Chrome's), and the extension dials the relay with a real WebSocket speaking the real protocol. What it cannot be is a real
 * Chrome loading the unpacked folder: there is no extension runtime here, no debugger infobar and no tab groups UI.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";
import { WebSocket } from "ws";
import { findFreeCdpPort } from "../src/code/kinds/cdp";
import type { DebugChrome } from "./kinds-fixture";

const PACK = resolve(import.meta.dirname, "..");
const BACKGROUND = resolve(PACK, "relay-extension", "background.js");

interface Tab {
	id: number;
	url: string;
	title: string;
	active: boolean;
	windowId: number;
	pinned: boolean;
	groupId: number;
}

interface PageInfo {
	id: string;
	type: string;
	url: string;
	title: string;
	webSocketDebuggerUrl: string;
}

type Listener = (...args: never[]) => void;

function event(): { addListener(listener: Listener): void; fire(...args: unknown[]): void } {
	const listeners: Listener[] = [];
	return {
		addListener: (listener) => void listeners.push(listener),
		fire: (...args) => {
			for (const listener of listeners) (listener as (...a: unknown[]) => void)(...args);
		},
	};
}

/** A running extension: what the test can look at, and how it ends. */
export interface FakeExtension {
	/** The badge text the extension last set ("on" while it is connected to a relay, "off" after). */
	badge(): string;
	/** The tab ids the extension reports for the Chrome's pages, by url. */
	tabIdOf(url: string): Promise<number | undefined>;
	/** The pages the extension has debugger-attached to (what the person's infobar would be on). */
	attachedPages(): string[];
	/** Make a page of the Chrome (a tab the person opens by hand): the extension hears of it through `chrome.tabs`. */
	openByHand(url: string): Promise<number>;
	dispose(): void;
}

/** Run `background.js` against `chrome`'s pages. `port` and `token` are what the options page would have stored. */
export function startFakeExtension(chrome: DebugChrome, settings: { port: number; token?: string }): FakeExtension {
	const tabs = new Map<number, Tab>();
	const pageIdOf = new Map<number, string>();
	let nextTabId = 100;
	let badge = "";
	const debuggerSockets = new Map<number, WebSocket>();
	/** Commands sent over a page's socket, waiting for their answer: one message handler per socket reads them all. */
	const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const sockets = new Set<WebSocket>();
	let disposed = false;

	const onEvent = event();
	const onDetach = event();
	const onCreated = event();
	const onUpdated = event();
	const onRemoved = event();
	const onAlarm = event();
	const onStorageChanged = event();

	const listPages = async (): Promise<PageInfo[]> => ((await (await fetch(`${chrome.cdpUrl}/json/list`)).json()) as PageInfo[]).filter((page) => page.type === "page");

	/** Keep `tabs` equal to Chrome's pages: new pages get the next id, vanished ones are dropped. Returns the live tabs. */
	const sync = async (): Promise<Tab[]> => {
		const pages = await listPages();
		for (const page of pages) {
			let id = [...pageIdOf].find(([, pageId]) => pageId === page.id)?.[0];
			if (id === undefined) {
				id = nextTabId++;
				pageIdOf.set(id, page.id);
			}
			const known = tabs.get(id);
			tabs.set(id, known ? { ...known, url: page.url, title: page.title } : { id, url: page.url, title: page.title, active: false, windowId: 1, pinned: false, groupId: -1 });
		}
		for (const [id, pageId] of [...pageIdOf]) {
			if (!pages.some((page) => page.id === pageId)) {
				pageIdOf.delete(id);
				tabs.delete(id);
			}
		}
		const first = [...tabs.values()][0];
		for (const tab of tabs.values()) tab.active = tab === first;
		return [...tabs.values()];
	};

	const pageOf = async (tabId: number): Promise<PageInfo> => {
		const pageId = pageIdOf.get(tabId);
		const page = (await listPages()).find((candidate) => candidate.id === pageId);
		if (!page) throw new Error(`No tab with id: ${tabId}.`);
		return page;
	};

	const chromeApi = {
		storage: {
			local: { get: async (defaults: Record<string, unknown>) => ({ ...defaults, port: settings.port, token: settings.token ?? "" }) },
			session: { get: async (defaults: Record<string, unknown>) => defaults, set: async () => undefined },
			onChanged: onStorageChanged,
		},
		tabs: {
			query: async (filter: { groupId?: number }) => (filter.groupId === undefined ? await sync() : []),
			get: async (id: number) => {
				await sync();
				const tab = tabs.get(id);
				if (!tab) throw new Error(`No tab with id: ${id}.`);
				return tab;
			},
			create: async ({ url }: { url: string }) => {
				const response = await fetch(`${chrome.cdpUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
				const created = (await response.json()) as PageInfo;
				await sync();
				const id = [...pageIdOf].find(([, pageId]) => pageId === created.id)![0];
				onCreated.fire(tabs.get(id));
				return tabs.get(id);
			},
			remove: async (id: number) => {
				const pageId = pageIdOf.get(id);
				await fetch(`${chrome.cdpUrl}/json/close/${pageId}`);
				pageIdOf.delete(id);
				tabs.delete(id);
				onRemoved.fire(id, {});
			},
			update: async (id: number) => {
				await fetch(`${chrome.cdpUrl}/json/activate/${pageIdOf.get(id)}`);
				return tabs.get(id);
			},
			group: async () => 1,
			ungroup: async () => undefined,
			onCreated,
			onUpdated,
			onRemoved,
		},
		tabGroups: { query: async () => [], update: async () => undefined },
		windows: { update: async () => undefined },
		debugger: {
			getTargets: async () => [...debuggerSockets.keys()].map((tabId) => ({ attached: true, tabId })),
			attach: async ({ tabId }: { tabId: number }) => {
				if (debuggerSockets.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
				const page = await pageOf(tabId);
				const socket = new WebSocket(page.webSocketDebuggerUrl);
				sockets.add(socket);
				await new Promise<void>((done, fail) => {
					socket.once("open", () => done());
					socket.once("error", fail);
				});
				debuggerSockets.set(tabId, socket);
				socket.on("message", (data) => {
					const message = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown; sessionId?: string };
					if (message.id !== undefined) {
						const waiting = pending.get(message.id);
						pending.delete(message.id);
						if (message.error) waiting?.reject(new Error(message.error.message));
						else waiting?.resolve(message.result ?? {});
						return;
					}
					if (message.method) onEvent.fire({ tabId, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }, message.method, message.params);
				});
				socket.on("close", () => {
					sockets.delete(socket);
					if (debuggerSockets.get(tabId) === socket) {
						debuggerSockets.delete(tabId);
						onDetach.fire({ tabId }, "target_closed");
					}
				});
			},
			detach: async ({ tabId }: { tabId: number }) => {
				const socket = debuggerSockets.get(tabId);
				if (!socket) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
				debuggerSockets.delete(tabId);
				socket.close();
			},
			sendCommand: async ({ tabId, sessionId }: { tabId: number; sessionId?: string }, method: string, params?: Record<string, unknown>) => {
				const socket = debuggerSockets.get(tabId);
				if (!socket) throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
				const id = ++commandSeq;
				const answered = Promise.withResolvers<unknown>();
				pending.set(id, answered);
				socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
				return await answered.promise;
			},
			onEvent,
			onDetach,
		},
		action: {
			setBadgeText: async ({ text }: { text: string }) => void (badge = text),
			setBadgeBackgroundColor: async () => undefined,
			onClicked: event(),
		},
		alarms: { create: () => undefined, onAlarm },
		runtime: { onInstalled: event(), onStartup: event(), openOptionsPage: async () => undefined },
	};
	let commandSeq = 0;

	// The extension's timers and sockets belong to this fake alone: dispose() ends every one, so nothing outlives the test.
	const sandbox = {
		chrome: chromeApi,
		navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36" },
		encodeURIComponent,
		console,
		Promise,
		Set,
		Map,
		JSON,
		Number,
		String,
		Error,
		Date,
		WebSocket: class extends WebSocket {
			constructor(url: string) {
				super(url);
				sockets.add(this);
			}
		},
		setTimeout: (fn: () => void, ms: number) => {
			const timer = setTimeout(() => {
				timers.delete(timer);
				if (!disposed) fn();
			}, ms);
			timers.add(timer);
			return timer;
		},
		setInterval: (fn: () => void, ms: number) => {
			const timer = setInterval(() => {
				if (!disposed) fn();
			}, ms);
			timers.add(timer);
			return timer;
		},
		clearInterval: (timer: ReturnType<typeof setInterval> | undefined) => {
			if (timer !== undefined) {
				clearInterval(timer);
				timers.delete(timer);
			}
		},
	};
	createContext(sandbox);
	runInContext(readFileSync(BACKGROUND, "utf8"), sandbox, { filename: "background.js" });

	return {
		badge: () => badge,
		async tabIdOf(url) {
			return (await sync()).find((tab) => tab.url === url)?.id;
		},
		attachedPages: () => [...debuggerSockets.keys()].map((tabId) => tabs.get(tabId)?.url ?? `tab ${tabId}`),
		async openByHand(url) {
			const response = await fetch(`${chrome.cdpUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
			const created = (await response.json()) as PageInfo;
			await sync();
			const id = [...pageIdOf].find(([, pageId]) => pageId === created.id)![0];
			onCreated.fire(tabs.get(id));
			return id;
		},
		dispose() {
			disposed = true;
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
			for (const socket of sockets) socket.terminate();
			sockets.clear();
			debuggerSockets.clear();
		},
	};
}

// ---------------------------------------------------------------------------
// The relay, on Node
// ---------------------------------------------------------------------------

let bundled: Promise<{ dir: string; file: string }> | undefined;

/** The relay command bundled the way the pack's server is (esbuild, ESM, packages left to Node), once per test process, in a folder of its own beside the pack so Node finds the same node_modules. */
function relayBundle(): Promise<{ dir: string; file: string }> {
	bundled ??= (async () => {
		const dir = await mkdtemp(join(PACK, ".relay-host-"));
		const file = join(dir, "relay-host.mjs");
		await build({ entryPoints: [join(PACK, "test", "relay-host.entry.ts")], outfile: file, bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", sourcemap: false, logLevel: "silent" });
		return { dir, file };
	})();
	return bundled;
}

/** Remove the bundle folder (afterAll). */
export async function removeRelayBundle(): Promise<void> {
	if (bundled === undefined) return;
	const { dir } = await bundled;
	bundled = undefined;
	await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export interface RelayHost {
	port: number;
	url: string;
	/** Everything the command wrote to stdout so far. */
	output(): string;
	stop(): Promise<void>;
}

const hosts = new Set<RelayHost>();

/** `node relay-host.mjs --relay --port N` (the pack's own relay command) and wait for it to say it is listening; rejects with its output if it ends first. */
export async function startRelayHost(options: { port?: number; token?: string; args?: string[] } = {}): Promise<RelayHost> {
	const port = options.port ?? (await findFreeCdpPort());
	const { file } = await relayBundle();
	const child: ChildProcess = spawn("node", [file, "--relay", "--port", String(port), ...(options.token === undefined ? [] : ["--token", options.token]), ...(options.args ?? [])], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	let out = "";
	let err = "";
	child.stdout?.on("data", (chunk) => void (out += String(chunk)));
	child.stderr?.on("data", (chunk) => void (err += String(chunk)));
	const ended = Promise.withResolvers<number | null>();
	child.once("exit", (code) => ended.resolve(code));
	const listening = Promise.withResolvers<void>();
	const poll = setInterval(() => {
		if (out.includes("listening on")) listening.resolve();
		else if (out.includes("nothing to do")) listening.reject(new Error(`a relay already served port ${port}: ${out.trim()}`));
	}, 25);
	void ended.promise.then((code) => listening.reject(new Error(`the relay command ended (code ${code}) before it was listening: ${out}${err}`)));
	const host: RelayHost = {
		port,
		url: `http://127.0.0.1:${port}`,
		output: () => out,
		async stop() {
			hosts.delete(host);
			if (child.exitCode === null) child.kill();
			await ended.promise;
		},
	};
	hosts.add(host);
	try {
		await listening.promise;
	} catch (error) {
		await host.stop();
		throw error;
	} finally {
		clearInterval(poll);
	}
	return host;
}

/** Stop every relay command this process started (afterEach). */
export async function stopRelayHosts(): Promise<void> {
	for (const host of [...hosts]) await host.stop();
}
