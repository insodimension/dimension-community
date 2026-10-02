/**
 * What the launch-kind tests stand on: a real headless Chrome the TEST starts with a remote-debugging port, playing the human's own Chrome
 * (or the application a cell spawns), and a local page server. Chrome is always headless and always on a profile of its own; every process
 * started here is ended by pid (the whole tree), never by name.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { findFreeCdpPort, waitForCdp } from "../src/code/kinds/cdp";
import { chromePath } from "./fixture";

export { chromePath };

const execFileAsync = promisify(execFile);

/** End `pid` and everything under it, at once. Safe on a pid that is already gone. */
export async function killTree(pid: number): Promise<void> {
	if (process.platform === "win32") {
		await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone
		}
	}
}

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Resolves once `pid` is gone, or false after `ms`. */
export async function gone(pid: number, ms = 8_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (!alive(pid)) return true;
		await sleep(50);
	}
	return !alive(pid);
}

export interface DebugChrome {
	cdpUrl: string;
	port: number;
	pid: number;
	userDataDir: string;
	stop(): Promise<void>;
}

const started: DebugChrome[] = [];

/** A headless Chrome with a debugging port on a fresh profile: the human's own Chrome, as far as the pack can tell. */
export async function startDebugChrome(): Promise<DebugChrome> {
	if (chromePath === undefined) throw new Error("no Chrome");
	const userDataDir = await mkdtemp(join(tmpdir(), "dimension-kinds-chrome-"));
	const port = await findFreeCdpPort();
	const child = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"], {
		detached: process.platform !== "win32",
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();
	const pid = child.pid;
	if (pid === undefined) throw new Error("Chrome did not start");
	const cdpUrl = `http://127.0.0.1:${port}`;
	const chrome: DebugChrome = {
		cdpUrl,
		port,
		pid,
		userDataDir,
		async stop() {
			await killTree(pid);
			await gone(pid);
			await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
		},
	};
	started.push(chrome);
	await waitForCdp(cdpUrl, 30_000);
	return chrome;
}

/** Stop every Chrome this file started (afterEach: one Chrome at a time, none left behind). */
export async function stopDebugChromes(): Promise<void> {
	for (const chrome of started.splice(0)) await chrome.stop();
}

export interface PageServer {
	url(path: string): string;
	port: number;
	stop(): Promise<void>;
}

/** Small pages, so a test can tell which one a browser is on; `/dialog` asks a confirm() when its button is clicked. */
export async function startPageServer(): Promise<PageServer> {
	const server: Server = createServer((request, response) => {
		const path = new URL(request.url ?? "/", "http://x").pathname;
		response.setHeader("content-type", "text/html");
		if (path === "/one") response.end("<!doctype html><title>Page one</title><h1 id=hero>one</h1>");
		else if (path === "/two") response.end("<!doctype html><title>Page two</title><h1 id=hero>two</h1>");
		else if (path === "/dialog") response.end("<!doctype html><title>Dialog page</title><button id=ask onclick=\"document.title = 'asked:' + confirm('sure?')\">Ask</button>");
		else {
			response.statusCode = 404;
			response.end("not found");
		}
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const { port } = server.address() as AddressInfo;
	return {
		port,
		url: (path) => `http://127.0.0.1:${port}${path}`,
		stop() {
			const closed = Promise.withResolvers<void>();
			server.closeAllConnections();
			server.close(() => closed.resolve());
			return closed.promise;
		},
	};
}
