/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a cell that asks for `app: { relay: true }` cannot drive the person's own Chrome, or leaves it worse than it
 *  found it. Everything between the model and a page of that Chrome is exercised on the real parts: the shipped extension (`relay-extension/background.js`,
 *  run against a `chrome.*` backed by a real headless Chrome's own tabs and DevTools sockets), the relay command on Node, puppeteer's two connections per
 *  driven tab (the discovery connection and the code worker's second one that adopts the page by id), and `establishKind`'s relay branch with its two
 *  texts for a relay that is not there. What the person's browser must keep: a tab a cell drove is still open afterwards; and the extension finds the
 *  relay again by itself when the relay restarts. What this cannot show: a real Chrome loading the unpacked extension (no infobar, no tab group UI).
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import puppeteer, { type Target } from "puppeteer-core";
import { connectAttached } from "../src/engines/attach";
import { findFreeCdpPort, KIND_TIMINGS, waitForCdp } from "../src/code/kinds/cdp";
import { establishKind } from "../src/code/kinds/establish";
import { stopOwnedRelays } from "../src/code/kinds/relay/ensure";
import type { RelayServer } from "../src/code/kinds/relay/server";
import { BROWSER_TEST_TIMEOUT_MS, describeWithChrome } from "./fixture";
import { startDebugChrome, startPageServer, stopDebugChromes } from "./kinds-fixture";
import { type FakeExtension, type RelayHost, removeRelayBundle, startFakeExtension, startRelayHost, stopRelayHosts } from "./relay-fixture";

const extensions: FakeExtension[] = [];
const stoppers: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const extension of extensions.splice(0)) extension.dispose();
	for (const stop of stoppers.splice(0).reverse()) await stop();
	await stopOwnedRelays();
	await stopRelayHosts();
	await stopDebugChromes();
});
afterAll(removeRelayBundle);

/** puppeteer keeps a target's CDP id on a private field; the code worker adopts a page by that id. */
function targetIdOf(target: Target): string {
	const raw = target as unknown as { _targetId: string };
	return raw._targetId;
}

async function waitUntil(what: string, condition: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await condition()) return;
		await Bun.sleep(50); // real time: the extension and the relay are separate programs reaching each other over sockets
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function pagesOf(chromeUrl: string): Promise<Array<{ url: string; title: string; type: string }>> {
	return ((await (await fetch(`${chromeUrl}/json/list`)).json()) as Array<{ url: string; title: string; type: string }>).filter((target) => target.type === "page");
}

describeWithChrome("the relay, with the shipped extension and a real Chrome behind it", () => {
	test(
		"a cell drives a page of the person's Chrome through both of its connections, and the person's tab is still there afterwards",
		async () => {
			const pages = await startPageServer();
			stoppers.push(() => pages.stop());
			const chrome = await startDebugChrome();
			const host = await startRelayHost();
			const extension = startFakeExtension(chrome, { port: host.port });
			extensions.push(extension);
			await extension.openByHand(pages.url("/one"));

			// The extension dials in: the relay says so with a websocket URL, and the extension's badge says "on".
			await waitForCdp(host.url, 20_000);
			expect(extension.badge()).toBe("on");
			const version = (await (await fetch(`${host.url}/json/version`)).json()) as { webSocketDebuggerUrl: string };
			expect(version.webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${host.port}/cdp`);

			// Connection one: discovery. The person's page is among the targets, found by what is on it.
			const supervisor = await puppeteer.connect({ browserURL: host.url, defaultViewport: null, protocolTimeout: 20_000 });
			const found = (
				await Promise.all(supervisor.targets().map(async (target) => (String(target.type()) === "page" ? await target.page().catch(() => null) : null)))
			).filter((page) => page !== null);
			const onePage = found.find((page) => page.url() === pages.url("/one"));
			expect(onePage).toBeDefined();
			const targetId = targetIdOf(onePage!.target());

			// Connection two: the code worker's. It adopts the page the discovery connection picked, by id, over the relay's own websocket.
			const worker = await puppeteer.connect({ browserWSEndpoint: supervisor.wsEndpoint(), defaultViewport: null, protocolTimeout: 20_000 });
			const workerTarget = await worker.waitForTarget((target) => targetIdOf(target) === targetId, { timeout: 10_000 });
			const page = await workerTarget.page();
			expect(page).not.toBeNull();
			expect(await page!.title()).toBe("Page one");
			expect(await page!.evaluate("document.querySelector('#hero').textContent")).toBe("one");

			// Navigate the person's tab, take a picture, use a second CDP session on it.
			await page!.goto(pages.url("/two"), { waitUntil: "load", timeout: 20_000 });
			expect(await page!.title()).toBe("Page two");
			expect((await page!.screenshot({ type: "png" })).byteLength).toBeGreaterThan(100);
			const session = await page!.createCDPSession();
			const frameTree = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { url: string } } };
			expect(frameTree.frameTree.frame.url).toBe(pages.url("/two"));
			await session.detach();

			// A tab the cell opens itself is made and closed through the extension.
			const created = await supervisor.newPage();
			await created.goto("about:blank");
			expect(await pagesOf(chrome.cdpUrl).then((all) => all.some((entry) => entry.url === "about:blank" && entry.title !== "Page two"))).toBe(true);
			await created.close();

			await worker.disconnect();
			await supervisor.disconnect();

			// The person's own tab stays open (and on the page the cell left it on); their Chrome is untouched.
			const left = await pagesOf(chrome.cdpUrl);
			expect(left.map((entry) => entry.url)).toContain(pages.url("/two"));
			// The debugger is let go of: no tab keeps the "is being debugged" infobar once no cell is connected.
			await waitUntil("the extension to release the debugger on every tab", () => extension.attachedPages().length === 0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"the extension's badge follows the relay, and it dials back in by itself within 10 seconds of the relay returning",
		async () => {
			const chrome = await startDebugChrome();
			const first = await startRelayHost();
			const extension = startFakeExtension(chrome, { port: first.port });
			extensions.push(extension);
			await waitForCdp(first.url, 20_000);
			expect(extension.badge()).toBe("on");

			await first.stop();
			await waitUntil("the badge to go off", () => extension.badge() === "off");

			const started = Date.now();
			await startRelayHost({ port: first.port });
			await waitForCdp(first.url, 12_000);
			expect(Date.now() - started).toBeLessThan(10_500);
			expect(extension.badge()).toBe("on");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithChrome("a cell's `app: { relay: true }`: establishKind", () => {
	test(
		"with nothing serving the pack starts the relay, waits for the extension, and hands back the endpoint to attach to",
		async () => {
			const pages = await startPageServer();
			stoppers.push(() => pages.stop());
			const chrome = await startDebugChrome();
			const port = await findFreeCdpPort();
			let host: RelayHost | undefined;
			// The pack starts a relay in its own process; here that process is the relay command on Node, and the extension dials in once it is up.
			const startRelay = async (options: { port: number }): Promise<RelayServer> => {
				host = await startRelayHost({ port: options.port });
				const extension = startFakeExtension(chrome, { port: options.port });
				extensions.push(extension);
				await extension.openByHand(pages.url("/one"));
				return { port: options.port, stop: async () => host?.stop() } as unknown as RelayServer;
			};
					const established = await establishKind({ kind: "relay", cdpUrl: `http://127.0.0.1:${port}` }, { startRelay });
			if (!("attach" in established)) throw new Error("expected an attach target");
			expect(established.attach).toMatchObject({ kind: "relay", cdpUrl: `http://127.0.0.1:${port}`, label: `relay http://127.0.0.1:${port}` });
			expect(established.attach.terminate).toBeUndefined();

			const browser = await connectAttached(established.attach);
			const urls = await Promise.all((await browser.pages()).map((page) => page.url()));
			expect(urls).toContain(pages.url("/one"));
			await browser.disconnect();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test("a relay that is serving but whose extension never dials in is named as exactly that", async () => {
		const host = await startRelayHost();
		const started = Date.now();
		await expect(establishKind({ kind: "relay", cdpUrl: host.url }, { timings: { ...KIND_TIMINGS, relayExtensionMs: 600 } })).rejects.toThrow(
			`The Dimension browser relay is serving at ${host.url} but its extension never connected. Install it with \`node app/server.mjs --relay-install\` and check the toolbar badge shows "on".`,
		);
		expect(Date.now() - started).toBeGreaterThanOrEqual(550);
	});

	test("a relay that is not there and cannot be started is named as not reachable, with the command that starts it", async () => {
		const failing = async (): Promise<RelayServer> => {
			throw new Error("cannot bind");
		};
		await expect(establishKind({ kind: "relay", cdpUrl: "http://127.0.0.1:1" }, { startRelay: failing, timings: { ...KIND_TIMINGS, relayExtensionMs: 400 } })).rejects.toThrow(
			"The Dimension browser relay is not reachable at http://127.0.0.1:1. Start it with `node app/server.mjs --relay` (or check the endpoint), and make sure the Dimension Browser Relay extension is loaded in Chrome.",
		);
	});
});
