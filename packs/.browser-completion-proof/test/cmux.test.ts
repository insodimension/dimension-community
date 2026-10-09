/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a model running inside cmux (the macOS terminal whose browser panes are WKWebViews) cannot drive its browser pane, or is told a
 *  picture is something it is not. cmux has no DevTools endpoint: the pack talks to its daemon over a socket (newline JSON, optionally behind a password or the relay's HMAC
 *  challenge), opens or attaches to a surface, and runs the model's code against a tab object that answers the same helpers as the Chrome ones. Everything here runs against a
 *  FAKE daemon that speaks that wire protocol; no real cmux and no Mac was involved, so it proves the pack's side of the conversation and nothing about cmux's. What must hold: a
 *  split the pack opened is closed again and a surface it was pointed at never is; the daemon's errors reach the cell in its own words; a picture over 1024 pixels is shrunk to it,
 *  and one the pack cannot shrink is sent whole WITH a note saying so; and an off-cmux machine never resolves to cmux (kinds.test.ts).
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { createCodeEvaluator } from "../src/code/cell/evaluator";
import type { ImageBlock, RunResult, TabHandle } from "../src/code/contracts";
import { establishKind } from "../src/code/kinds/establish";
import { CmuxBrowsers } from "../src/code/kinds/cmux/cmux-browsers";
import { CmuxRealm } from "../src/code/kinds/cmux/cmux-realm";
import { type CmuxOpenOptions, openCmuxSurface } from "../src/code/kinds/cmux/cmux-surface";
import { downscalePng, encodePng, pngSize } from "../src/code/kinds/cmux/png";
import { CmuxSocketClient } from "../src/code/kinds/cmux/socket-client";
import { type FakeCmux, type FakePage, pageHandler, removeFakeCmuxDirs, startFakeCmux } from "./cmux-fixture";

const fakes: FakeCmux[] = [];
const clients: CmuxSocketClient[] = [];
const realms: CmuxRealm[] = [];
const scratch: string[] = [];

async function daemon(options: Parameters<typeof startFakeCmux>[0] = {}): Promise<FakeCmux> {
	const fake = await startFakeCmux(options);
	fakes.push(fake);
	return fake;
}

async function connected(fake: FakeCmux, extra: { password?: string; relayId?: string; relayToken?: string } = {}): Promise<CmuxSocketClient> {
	const client = new CmuxSocketClient({ socketPath: fake.socketPath, ...extra });
	clients.push(client);
	await client.connect();
	return client;
}

afterEach(async () => {
	for (const realm of realms.splice(0)) await realm.dispose();
	for (const client of clients.splice(0)) client.close();
	for (const fake of fakes.splice(0)) await fake.stop();
	for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});
afterAll(removeFakeCmuxDirs);

/** A solid-colour image: channel values `rgba` repeated. */
function solid(width: number, height: number, channels: 1 | 2 | 3 | 4, values: number[]): Buffer {
	const pixels = Buffer.alloc(width * height * channels);
	for (let i = 0; i < width * height; i++) for (let c = 0; c < channels; c++) pixels[i * channels + c] = values[c]!;
	return encodePng(pixels, width, height, channels);
}

/** The pixels of a PNG this pack's own encoder wrote (every row unfiltered). */
function pixelsOf(png: Buffer, channels: number): Buffer {
	const size = pngSize(png)!;
	const idat: Buffer[] = [];
	for (let at = 8; at + 12 <= png.length; ) {
		const length = png.readUInt32BE(at);
		if (png.toString("latin1", at + 4, at + 8) === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
		at += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = size.width * channels;
	const out = Buffer.alloc(stride * size.height);
	for (let y = 0; y < size.height; y++) raw.copy(out, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
	return out;
}

// ---------------------------------------------------------------------------
// The picture the model is given
// ---------------------------------------------------------------------------

describe("shrinking a surface's screenshot to the model's 1024 pixels", () => {
	test("a wide picture is shrunk by whole-pixel averaging to a longest edge of 1024, in the same colour model", () => {
		// Left half black, right half white, so an average across the middle blends and everywhere else is exact.
		const width = 2048;
		const height = 1024;
		const pixels = Buffer.alloc(width * height * 4, 255);
		for (let y = 0; y < height; y++) for (let x = 0; x < width / 2; x++) pixels.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
		const shrunk = downscalePng(encodePng(pixels, width, height, 4));
		expect(shrunk).toMatchObject({ width: 1024, height: 512, originalWidth: 2048, originalHeight: 1024 });
		expect(shrunk.note).toBeUndefined();
		expect(pngSize(shrunk.buffer)).toEqual({ width: 1024, height: 512 });
		const out = pixelsOf(shrunk.buffer, 4);
		const at = (x: number, y: number): number[] => [...out.subarray((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 4)];
		expect(at(10, 10)).toEqual([0, 0, 0, 255]);
		expect(at(1000, 500)).toEqual([255, 255, 255, 255]);
	});

	test("an average is a real average: a 2x2 block of 0, 100, 200, 100 becomes 100", () => {
		const pixels = Buffer.from([0, 100, 200, 100]);
		const shrunk = downscalePng(encodePng(pixels, 2, 2, 1), 1);
		expect(pngSize(shrunk.buffer)).toEqual({ width: 1, height: 1 });
		expect([...pixelsOf(shrunk.buffer, 1)]).toEqual([100]);
	});

	test("grey, grey with alpha and RGB pictures keep their channels", () => {
		for (const channels of [1, 2, 3] as const) {
			const shrunk = downscalePng(solid(1500, 500, channels, [40, 80, 120].slice(0, channels)));
			expect(pngSize(shrunk.buffer)).toEqual({ width: 1024, height: 341 });
			expect([...pixelsOf(shrunk.buffer, channels).subarray(0, channels)]).toEqual([40, 80, 120].slice(0, channels));
		}
	});

	test("a picture that already fits is sent unchanged, byte for byte", () => {
		const small = solid(800, 600, 4, [1, 2, 3, 255]);
		const result = downscalePng(small);
		expect(result.buffer).toBe(small);
		expect(result.note).toBeUndefined();
	});

	test("an encoding the pack cannot shrink is sent whole and says so; it is never claimed to be shrunk", () => {
		const big = solid(2000, 400, 4, [9, 9, 9, 255]);
		const interlaced = Buffer.from(big);
		interlaced[28] = 1;
		const sixteenBit = Buffer.from(big);
		sixteenBit[24] = 16;
		const palette = Buffer.from(big);
		palette[25] = 3;
		for (const odd of [interlaced, sixteenBit, palette]) {
			const result = downscalePng(odd);
			expect(result.buffer).toBe(odd);
			expect(result.note).toBe("the picture is 2000x400 and this PNG encoding is not one the pack can shrink; it is sent at full size");
			expect(result).toMatchObject({ width: 2000, height: 400 });
		}
		expect(downscalePng(Buffer.from("not a png at all")).note).toContain("not a PNG");
		// Damaged pixel data is not guessed at either.
		const corrupt = Buffer.from(big);
		corrupt.fill(0xff, 40, 80);
		expect(downscalePng(corrupt).note).toContain("not one the pack can shrink");
	});
});

// ---------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------

describe("the cmux socket client against a daemon's protocol", () => {
	test("a request goes out as one JSON line and the result comes back; the daemon's own errors keep its words", async () => {
		const fake = await daemon({
			handler: (request) => (request.method === "boom" ? { error: { code: "not_found", message: "no such surface" } } : request.method === "ping" ? { result: { pong: request.params.n } } : undefined),
		});
		const client = await connected(fake);
		expect(await client.request("ping", { n: 7 })).toEqual({ pong: 7 });
		expect((await rejection(client.request("boom", {}))).message).toContain("not_found: no such surface");
		expect(fake.requests.map((request) => request.method)).toEqual(["ping", "boom"]);
	});

	test("an ERROR line is the daemon refusing, and a daemon that never answers fails at the request's own bound", async () => {
		const fake = await daemon({ handler: (request) => (request.method === "refused" ? { raw: "ERROR: Unknown command" } : request.method === "hang" ? "silence" : undefined) });
		const client = await connected(fake);
		expect((await rejection(client.request("refused", {}))).message).toContain("ERROR: Unknown command");
		const started = Date.now();
		expect((await rejection(client.request("hang", {}, { timeoutMs: 300 }))).message).toContain("Timed out waiting for cmux socket response");
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
	});

	test("a password is sent first and a wrong one is refused with the daemon's line", async () => {
		const fake = await daemon({ password: "hunter2" });
		expect((await rejection(new CmuxSocketClient({ socketPath: fake.socketPath, password: "nope" }).connect())).message).toContain("ERROR: Invalid password");
		const client = await connected(fake, { password: "hunter2" });
		expect(await client.request("ping", {})).toEqual({});
	});

	test("the relay form answers the daemon's HMAC challenge with the token; a wrong token is refused by name", async () => {
		const relay = { id: "relay-1", token: "00ff10ab" };
		const fake = await daemon({ relay });
		const client = await connected(fake, { relayId: relay.id, relayToken: relay.token });
		expect(await client.request("ping", {})).toEqual({});
		const wrong = new CmuxSocketClient({ socketPath: fake.socketPath, relayId: relay.id, relayToken: "00ff10ac" });
		expect((await rejection(wrong.connect())).message).toContain(`Cmux relay authentication failed for 127.0.0.1:${fake.socketPath.split(":")[1]}`);
	});

	test("a socket that is not there fails to connect with the path named; closing rejects what is waiting", async () => {
		const missing = process.platform === "win32" ? "\\\\.\\pipe\\dimension-cmux-nobody-home" : join(tmpdir(), "dimension-cmux-nobody-home.sock");
		expect((await rejection(new CmuxSocketClient({ socketPath: missing }).connect())).message).toContain(`Failed to connect to cmux socket at ${missing}`);
		const fake = await daemon({ handler: () => "silence" });
		const client = await connected(fake);
		const waiting = client.request("never", {}, { timeoutMs: 10_000 });
		const settled = waiting.then(
			() => "answered",
			(error: Error) => error.message,
		);
		client.close();
		expect(await settled).toBe("cmux socket closed");
	});

	test("establishKind connects a cmux kind to the daemon and names it as OMP does; an absent daemon is a ToolError, not a crash", async () => {
		const fake = await daemon();
		const established = await establishKind({ kind: "cmux", socketPath: fake.socketPath });
		if (!("cmux" in established)) throw new Error("expected a cmux target");
		clients.push(established.cmux.client);
		expect(established.cmux.label).toBe("cmux browser (split)");
		expect(await established.cmux.client.request("ping", {})).toEqual({});
		const surface = await establishKind({ kind: "cmux", socketPath: fake.socketPath, surface: "abc" });
		if (!("cmux" in surface)) throw new Error("expected a cmux target");
		clients.push(surface.cmux.client);
		expect(surface.cmux.label).toBe("cmux browser (abc)");
		expect((await rejection(establishKind({ kind: "cmux", socketPath: join(tmpdir(), "dimension-cmux-nobody-home.sock") }))).message).toContain("Failed to connect to cmux socket");
	});
});

// ---------------------------------------------------------------------------
// A tab on a surface
// ---------------------------------------------------------------------------

const PAGE: FakePage = { url: "about:blank", title: "Fake page", html: "<h1>fake</h1> Fake page text", refs: { "@e1": { role: "button", name: "Go" }, "@e2": { role: "link", name: "Docs" } } };

async function realmOn(options: { png?: Buffer; settings?: { screenshotDir?: string; excludeWebP?: boolean } } = {}): Promise<{ realm: CmuxRealm; client: CmuxSocketClient; fake: FakeCmux; closed: string[]; page: FakePage }> {
	const page = { ...PAGE };
	const { handler, closed } = pageHandler(page, options.png);
	const fake = await daemon({ handler });
	const client = await connected(fake);
	// The realm reaches the daemon by itself, over a connection of its own (the host opens surfaces over another), as the worker does.
	const realm = new CmuxRealm({ evaluator: createCodeEvaluator, settings: () => options.settings ?? {} });
	realms.push(realm);
	return { realm, client, fake, closed, page };
}

/** What the code host does for `browser.open` on cmux, and then the worker: open (or attach to) the surface over the host's connection, hand its handle over, adopt it by name. */
async function openOn(realm: CmuxRealm, fake: FakeCmux, client: CmuxSocketClient, name: string, o: Omit<CmuxOpenOptions, "client">): Promise<Awaited<ReturnType<typeof openCmuxSurface>>> {
	const opened = await openCmuxSurface({ client, ...o });
	const handle: TabHandle = {
		tabId: opened.surfaceId, targetId: opened.surfaceId, url: opened.info.url, title: opened.info.title ?? "", active: true,
		browserId: "cmux-test", wsEndpoint: "", kind: "cmux", created: opened.ownsSurface, cmux: { socketPath: fake.socketPath },
	};
	await realm.adopt(name, handle);
	return opened;
}

/** The error a promise rejects with. A try/catch, not `expect().rejects`: under Bun on Windows the latter starves a named pipe of I/O between two requests, so a second request on the same socket never gets its answer. */
async function rejection(work: Promise<unknown>): Promise<Error> {
	try {
		await work;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	throw new Error("expected the promise to reject");
}

function runOf(realm: CmuxRealm, code: string, timeoutMs = 5_000, signal: AbortSignal = new AbortController().signal): Promise<RunResult> {
	return realm.run({ name: "main", code, timeoutMs, signal });
}

function textOf(result: RunResult): string {
	return result.displays.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

describe("a cmux tab, as a cell uses it", () => {
	test("opening without a surface opens a split at the url and waits for it; the cell reads, navigates and acts on it", async () => {
		const { realm, client, fake } = await realmOn();
		const { info } = await openOn(realm, fake, client, "main", { url: "https://example.test/start", timeoutMs: 5_000 });
		expect(info).toMatchObject({ url: "https://example.test/start", targetId: "surface-uuid-1" });
		const split = fake.requests.find((request) => request.method === "browser.open_split")!;
		expect(split.params).toMatchObject({ url: "https://example.test/start", focus: false });
		expect(fake.requests.find((request) => request.method === "browser.wait")?.params).toMatchObject({ surface_id: "surface-uuid-1", load_state: "complete", timeout_ms: 5_000 });

		const result = await runOf(
			realm,
			`const seen = await tab.observe();
			 console.log(seen.url, seen.title, seen.elements.map(e => e.role + ":" + e.name).join("|"), seen.viewport.width + "x" + seen.viewport.height);
			 await tab.goto("https://example.test/next");
			 await tab.click("#go");
			 await tab.fill("#name", "Ada");
			 await tab.press("Enter");
			 return await tab.title();`,
		);
		expect(textOf(result)).toContain("https://example.test/start Fake page button:Go|link:Docs 1000x700");
		expect(result.returnValue).toBe("Fake page");
		const methods = fake.requests.map((request) => request.method);
		expect(methods).toEqual(expect.arrayContaining(["browser.navigate", "browser.click", "browser.fill", "browser.press"]));
		expect(fake.requests.find((request) => request.method === "browser.navigate")?.params).toMatchObject({ url: "https://example.test/next", surface_id: "surface-uuid-1" });
		expect(fake.requests.find((request) => request.method === "browser.fill")?.params).toMatchObject({ selector: "#name", text: "Ada" });
	});

	test("releasing a tab lets go of it and nothing more: the realm never closes a split, and a name can be taken again", async () => {
		const { realm, client, closed, fake } = await realmOn();
		await openOn(realm, fake, client, "owned", { timeoutMs: 5_000 });
		await openOn(realm, fake, client, "attached", { surface: "11111111-2222-3333-4444-555555555555", url: "https://example.test/x", timeoutMs: 5_000 });
		// Attaching opens nothing new, and navigates the surface it was given.
		expect(fake.requests.filter((request) => request.method === "browser.open_split")).toHaveLength(1);
		expect(fake.requests.find((request) => request.method === "browser.navigate")?.params).toMatchObject({ surface_id: "11111111-2222-3333-4444-555555555555" });
		expect(realm.names().sort()).toEqual(["attached", "owned"]);
		expect(await realm.release("attached")).toBe(true);
		expect(await realm.release("owned")).toBe(true);
		expect(await realm.release("owned")).toBe(false);
		expect(realm.names()).toEqual([]);
		expect(closed).toEqual([]);
	});

	test("a browser's tabs are dropped together when the browser ends, and a run on one ends at once saying why", async () => {
		const { realm, client, fake } = await realmOn();
		await openOn(realm, fake, client, "main", { timeoutMs: 5_000 });
		const running = realm.run({ name: "main", code: "await wait(30000)", timeoutMs: 60_000, signal: new AbortController().signal }).then(
			() => "finished",
			(error: Error) => error.message,
		);
		await Bun.sleep(150); // real time: the run must be in its wait before the browser goes
		await realm.end("cmux-test", "it was a cmux browser, let go after 1800 s with no calls");
		expect(await running).toBe("it was a cmux browser, let go after 1800 s with no calls");
		expect(realm.names()).toEqual([]);
	});

	test("a surface given as a 'surface:N' ref is refused with OMP's text, and nothing is opened", async () => {
		const { realm, client, fake } = await realmOn();
		expect((await rejection(openOn(realm, fake, client, "main", { surface: "surface:3", timeoutMs: 5_000 }))).message).toContain("app.surface must be a surface UUID (e.g. CMUX_SURFACE_ID), not a 'surface:N' ref; omit it to open a new split");
		expect(fake.requests).toEqual([]);
	});

	test("an open the caller gave up on closes the split it had made", async () => {
		const { realm, client, closed, fake } = await realmOn();
		const gone = new AbortController();
		gone.abort();
		expect((await rejection(openOn(realm, fake, client, "main", { timeoutMs: 5_000, signal: gone.signal }))).message).toContain("Browser tab open aborted");
		expect(closed).toEqual(["surface-uuid-1"]);
		expect(realm.names()).toEqual([]);
	});

	test("a tab that is not there, a tab already running, a cell that throws and one that overruns each say so in OMP's words", async () => {
		const { realm, client, fake } = await realmOn();
		expect((await rejection(realm.run({ name: "main", code: "1", timeoutMs: 1_000, signal: new AbortController().signal }))).message).toContain('Tab "main" is not alive. Open it first with action:"open".');
		await openOn(realm, fake, client, "main", { timeoutMs: 5_000 });
		expect((await rejection(runOf(realm, "throw new Error('cell failed')"))).message).toContain("cell failed");
		expect((await rejection(runOf(realm, "await wait(5000)", 300))).message).toContain("Browser code execution timed out after 300ms");

		const first = runOf(realm, "await wait(400); return 1");
		expect((await rejection(runOf(realm, "return 2"))).message).toContain('Tab "main" is busy');
		expect((await first).returnValue).toBe(1);
		// A run that was asked to stop before it began never runs.
		const stopped = new AbortController();
		stopped.abort();
		expect((await rejection(runOf(realm, "return 3", 1_000, stopped.signal))).name).toBe("ToolAbortError");
	});

	test("releasing a tab under a run ends the run at once with the tab named, not at its budget", async () => {
		const { realm, client, fake } = await realmOn();
		await openOn(realm, fake, client, "main", { timeoutMs: 5_000 });
		const started = Date.now();
		const running = runOf(realm, "await wait(30000)", 60_000);
		const outcome = running.then(
			() => "finished",
			(error: Error) => error.message,
		);
		await Bun.sleep(150); // real time: the run must be in its wait before the tab goes
		await realm.release("main");
		expect(await outcome).toBe('Tab "main" was closed');
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	test("a call chain runs the same way a cell does, and an unknown helper is refused before anything is sent", async () => {
		const { realm, client, fake } = await realmOn();
		await openOn(realm, fake, client, "main", { timeoutMs: 5_000 });
		const result = await realm.call({ name: "main", chain: [{ method: "url", args: [] }], timeoutMs: 5_000, signal: new AbortController().signal });
		expect(result.returnValue).toBe("about:blank");
		const before = fake.requests.length;
		expect((await rejection(realm.call({ name: "main", chain: [{ method: "launchMissiles", args: [] }], timeoutMs: 5_000, signal: new AbortController().signal }))).message).toMatch(/launchMissiles/);
		expect(fake.requests.length).toBe(before);
	});

	test("evaluate runs a page script and gives back its value; a script that throws names the page's own message, not the daemon's blank one", async () => {
		const { realm, client, fake } = await realmOn();
		await openOn(realm, fake, client, "main", { timeoutMs: 5_000 });
		expect((await runOf(realm, "return await tab.evaluate(() => document.title + '!')")).returnValue).toBe("Fake page!");
		expect((await rejection(runOf(realm, "return await tab.evaluate(() => { throw new Error('page broke') })"))).message).toMatch(/page broke/);
	});

	test("a screenshot over 1024 pixels is shrunk to it and captioned; the full-size picture is what is saved when a folder is set", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dimension-cmux-shots-"));
		scratch.push(dir);
		const { realm, client, fake } = await realmOn({ png: solid(2400, 1200, 4, [200, 100, 50, 255]), settings: { screenshotDir: dir } });
		await openOn(realm, fake, client, "main", { timeoutMs: 5_000 });
		const result = await runOf(realm, "return await tab.screenshot()");
		const image = result.displays.find((part): part is ImageBlock => part.type === "image")!;
		expect(image.mimeType).toBe("image/png");
		expect(pngSize(Buffer.from(image.data, "base64"))).toEqual({ width: 1024, height: 512 });
		expect(textOf(result)).toContain("Screenshot captured");
		expect(textOf(result)).toContain("[Image: original 2400x1200, displayed at 1024x512.");
		const saved = result.screenshots[0]!;
		expect(saved.dest.startsWith(dir)).toBe(true);
		expect(pngSize(await readFile(saved.dest))).toEqual({ width: 2400, height: 1200 });
		expect(result.returnValue).toBe(saved.dest);
	});

	test("with no folder set the shrunk picture is saved under the OS temp folder, and a selector is said to be the whole viewport", async () => {
		const { realm, client, fake } = await realmOn({ png: solid(1800, 900, 3, [10, 20, 30]) });
		await openOn(realm, fake, client, "main", { timeoutMs: 5_000 });
		const result = await runOf(realm, `return await tab.screenshot({ selector: "#hero" })`);
		const saved = result.screenshots[0]!;
		scratch.push(saved.dest);
		expect(saved.dest.startsWith(tmpdir())).toBe(true);
		expect((await stat(saved.dest)).size).toBe(saved.bytes);
		expect(pngSize(await readFile(saved.dest))).toEqual({ width: 1024, height: 512 });
		expect(textOf(result)).toContain("[cmux surface: selector \"#hero\" was scrolled into view, but this surface cannot clip to an element — the image is the full viewport]");
	});

	test("a picture the pack cannot shrink reaches the model whole with the note that it was not shrunk", async () => {
		const unreadable = solid(1800, 900, 4, [1, 2, 3, 255]);
		unreadable[28] = 1; // interlaced
		const { realm, client, fake } = await realmOn({ png: unreadable });
		await openOn(realm, fake, client, "main", { timeoutMs: 5_000 });
		const result = await runOf(realm, "await tab.screenshot()");
		scratch.push(result.screenshots[0]!.dest);
		const image = result.displays.find((part): part is ImageBlock => part.type === "image")!;
		expect(pngSize(Buffer.from(image.data, "base64"))).toEqual({ width: 1800, height: 900 });
		expect(textOf(result)).toContain("this PNG encoding is not one the pack can shrink; it is sent at full size");
	});
});
