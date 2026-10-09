/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: the person using the Browser View cannot use a page. A click does not
 *  reach a button (or reaches it as a script's click, so a site that checks for a real one ignores it); a double click,
 *  a right click, a drag that selects text, the wheel, typing and pasting do not behave as in Chrome; input applied
 *  while an agent's task owns the page; a bad batch applied half; the picture stops following the page.
 *
 *  Real Chrome, a real page that records what reaches it. Input goes through `runtime.input` (the same door the
 *  direct channel calls) and pictures through `runtime.watchFrames` (the same source the stream reads).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BrowserRuntime } from "../src/runtime";
import type { LiveFrame } from "../src/engines/types";
import { BROWSER_TEST_TIMEOUT_MS, createRuntime, describeWithChrome, teardown, waitUntil } from "./fixture";

const VIEWPORT = { width: 800, height: 600 };

const PAGE = `<!doctype html><meta charset="utf-8"><title>live input</title>
<style>body{margin:0}
#btn{position:absolute;left:20px;top:20px;width:120px;height:40px}
#field{position:absolute;left:20px;top:80px;width:240px;height:30px;font-size:18px}
#para{position:absolute;left:20px;top:140px;margin:0;font:20px monospace;white-space:nowrap}
#tall{position:absolute;top:220px;left:0;height:4000px;width:10px}
#flash{position:absolute;left:400px;top:20px;width:100px;height:100px;background:#d33}</style>
<button id="btn">go</button><input id="field"><p id="para">select this exact text</p><div id="tall"></div><div id="flash"></div>
<script>
  window.log = [];
  const push = (entry) => window.log.push(entry);
  const btn = document.getElementById("btn");
  btn.addEventListener("click", (e) => push("click:" + (e.isTrusted ? "trusted" : "script") + ":" + e.detail));
  btn.addEventListener("dblclick", () => push("dblclick"));
  btn.addEventListener("contextmenu", (e) => { e.preventDefault(); push("context:" + e.button); });
  btn.addEventListener("mousedown", (e) => push("down:" + e.button + ":" + e.buttons));
  btn.addEventListener("mouseup", (e) => push("up:" + e.button));
  document.getElementById("field").addEventListener("keydown", (e) => push("key:" + e.key + (e.shiftKey ? "+shift" : "")));
  document.getElementById("para").addEventListener("mousemove", () => { if (window.log.at(-1) !== "hover") push("hover"); });
</script>`;

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop(true);
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

async function openPage(): Promise<{ runtime: BrowserRuntime; browserId: string; url: string }> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }) });
	servers.push(server);
	const { runtime } = await createRuntime();
	// No profile: a throwaway browser, the only kind `eval` may read the page of.
	const { browserId } = await runtime.open({ viewport: VIEWPORT });
	const url = `http://127.0.0.1:${server.port}/`;
	const navigated = await runtime.act(browserId, { kind: "navigate", url });
	expect(navigated.status).toBe("completed");
	return { runtime, browserId, url };
}

async function pageValue<T>(runtime: BrowserRuntime, browserId: string, expression: string): Promise<T> {
	const outcome = await runtime.actMany(browserId, [{ kind: "eval", expression }]);
	expect(outcome.status).toBe("completed");
	return JSON.parse(outcome.steps[0]?.value ?? "null") as T;
}

const log = (runtime: BrowserRuntime, browserId: string) => pageValue<string[]>(runtime, browserId, "window.log");

/** A full click: move, press, release. */
const click = (x: number, y: number, extra: Record<string, unknown> = {}) => [
	{ kind: "mouse", type: "move", x, y },
	{ kind: "mouse", type: "down", x, y, buttons: extra.button === "right" ? 2 : 1, ...extra },
	{ kind: "mouse", type: "up", x, y, ...extra },
];

describeWithChrome("the human's input on a real page", () => {
	test(
		"a click is the browser's own: a trusted press then release then one click, in that order",
		async () => {
			const { runtime, browserId } = await openPage();
			await runtime.input(browserId, click(80, 40));
			expect(await log(runtime, browserId)).toEqual(["down:0:1", "up:0", "click:trusted:1"]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a double click is a dblclick, and a right press is a contextmenu with button 2 (and no click)",
		async () => {
			const { runtime, browserId } = await openPage();
			await runtime.input(browserId, [...click(80, 40, { clickCount: 1 }), ...click(80, 40, { clickCount: 2 })]);
			expect(await log(runtime, browserId)).toContain("dblclick");

			const other = await openPage();
			await other.runtime.input(other.browserId, click(80, 40, { button: "right" }));
			const seen = await log(other.runtime, other.browserId);
			expect(seen).toContain("context:2");
			expect(seen.some((entry) => entry.startsWith("click:"))).toBe(false);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"typing: keys carrying characters land in the focused field, shift is seen, Backspace deletes, pasted text inserts",
		async () => {
			const { runtime, browserId } = await openPage();
			await runtime.input(browserId, click(100, 95));
			const type = (key: string, code: string, keyCode: number, extra: Record<string, unknown> = {}) => [
				{ kind: "key", type: "down", key, code, keyCode, ...extra },
				{ kind: "key", type: "up", key, code, keyCode },
			];
			await runtime.input(browserId, [
				...type("h", "KeyH", 72, { text: "h" }),
				...type("I", "KeyI", 73, { text: "I", modifiers: 8 }),
				...type("x", "KeyX", 88, { text: "x" }),
				...type("Backspace", "Backspace", 8),
			]);
			expect(await pageValue<string>(runtime, browserId, "document.getElementById('field').value")).toBe("hI");
			expect(await log(runtime, browserId)).toContain("key:I+shift");

			await runtime.input(browserId, [{ kind: "text", text: " pasted — ünï 🚀" }]);
			expect(await pageValue<string>(runtime, browserId, "document.getElementById('field').value")).toBe("hI pasted — ünï 🚀");
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a drag selects text: press, move with the button held, release",
		async () => {
			const { runtime, browserId } = await openPage();
			await runtime.input(browserId, [
				{ kind: "mouse", type: "move", x: 21, y: 150 },
				{ kind: "mouse", type: "down", x: 21, y: 150, buttons: 1 },
				{ kind: "mouse", type: "move", x: 120, y: 150, button: "left", buttons: 1 },
				{ kind: "mouse", type: "move", x: 190, y: 150, button: "left", buttons: 1 },
				{ kind: "mouse", type: "up", x: 190, y: 150 },
			]);
			const selected = await pageValue<string>(runtime, browserId, "String(getSelection())");
			expect(selected.length).toBeGreaterThan(5);
			expect("select this exact text".startsWith(selected.trimEnd())).toBe(true);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"hover reaches the page without a button, and the wheel scrolls the page under the pointer",
		async () => {
			const { runtime, browserId } = await openPage();
			await runtime.input(browserId, [{ kind: "mouse", type: "move", x: 60, y: 150 }, { kind: "mouse", type: "move", x: 70, y: 150 }]);
			expect(await log(runtime, browserId)).toEqual(["hover"]);

			expect(await pageValue<number>(runtime, browserId, "scrollY")).toBe(0);
			await runtime.input(browserId, [{ kind: "wheel", x: 300, y: 300, deltaX: 0, deltaY: 400 }]);
			await waitUntil("the page to scroll", () => pageValue<number>(runtime, browserId, "scrollY"), (y) => y > 0);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a batch with one bad event applies none of it; a bad batch never reaches the page",
		async () => {
			const { runtime, browserId } = await openPage();
			await expect(runtime.input(browserId, [...click(80, 40), { kind: "mouse", type: "teleport", x: 1, y: 1 }])).rejects.toMatchObject({ code: "bad_input" });
			expect(await log(runtime, browserId)).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"input for a browser that is not open is refused as unknown_browser",
		async () => {
			const { runtime } = await openPage();
			await expect(runtime.input("nope", click(1, 1))).rejects.toMatchObject({ code: "unknown_browser" });
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"while an agent's task owns the page the human's input is refused and nothing reaches it",
		async () => {
			const { runtime, browserId } = await openPage();
			// A task needs a Python worker this test does not have; the runtime's own record of "a task is running" is what the rule reads.
			const entry = (runtime as unknown as { byId: Map<string, { task: unknown }> }).byId.get(browserId);
			if (!entry) throw new Error("no entry");
			entry.task = { status: "running" };

			await expect(runtime.input(browserId, click(80, 40))).rejects.toMatchObject({ code: "task_running" });
			entry.task = null;
			expect(await log(runtime, browserId)).toEqual([]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"input waits for no page work: a click lands while a navigation to a slow page is still in flight",
		async () => {
			const { runtime, browserId, url } = await openPage();
			const slow = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { await new Promise((done) => setTimeout(done, 2_500)); return new Response("slow"); } });
			servers.push(slow);
			const landing = runtime.act(browserId, { kind: "navigate", url: `http://127.0.0.1:${slow.port}/` });
			const started = performance.now();
			// The old page is still the committed document: the click goes to it, at once.
			await runtime.input(browserId, click(80, 40));
			expect(performance.now() - started).toBeLessThan(1_500);
			void url;
			await landing;
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a batch is applied however long the page takes to reach it, never dropped: a press and its release sent as two batches, the page stalled between them, still complete as one click",
		async () => {
			const { runtime, browserId } = await openPage();
			// The runtime has no public door to a browser's driver; this test replaces its `input`, the way publish.test.ts does.
			const seam = runtime as unknown as { byId: Map<string, { driver: { input(events: unknown): Promise<void> } }> };
			const entry = seam.byId.get(browserId);
			if (!entry) throw new Error("no entry");
			// The page takes the first batch and does not acknowledge it, as a renderer stuck in a navigation would; the later ones go straight through.
			const stalled = Promise.withResolvers<void>();
			let reached = 0;
			const send = entry.driver.input.bind(entry.driver);
			entry.driver.input = async (events) => {
				reached += 1;
				if (reached === 1) await stalled.promise;
				await send(events);
			};

			const [move, down, up] = click(80, 40);
			const outcomes: string[] = [];
			const press = runtime.input(browserId, [move, down]).then(
				() => outcomes.push("press taken"),
				() => outcomes.push("press refused"),
			);
			await waitUntil("the press reaches the page", async () => reached, (count) => count === 1);
			// The release of the same click, queued behind the stalled press.
			const release = runtime.input(browserId, [up]).then(
				() => outcomes.push("release taken"),
				() => outcomes.push("release refused"),
			);

			// A real wait, on purpose: the bound under test is the runtime's own timer, and Chrome runs on the platform clock, so no fake clock can pass it.
			// Longer than the 5 s an earlier version gave a batch before dropping it, which left the button held in Chrome.
			await Bun.sleep(5_600);
			expect(outcomes).toEqual([]);

			stalled.resolve();
			await Promise.all([press, release]);
			// Fails if either batch was dropped or refused for taking long: Chrome would hold the button, with no click.
			expect(outcomes).toEqual(["press taken", "release taken"]);
			expect(await log(runtime, browserId)).toEqual(["down:0:1", "up:0", "click:trusted:1"]);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});

describeWithChrome("the live picture", () => {
	/** Collect frames until `done` says so; fails with what arrived. */
	function watch(runtime: BrowserRuntime, browserId: string): { frames: LiveFrame[]; stop: () => void } {
		const frames: LiveFrame[] = [];
		const stop = runtime.watchFrames(browserId, (frame) => frames.push(frame));
		return { frames, stop };
	}
	const newest = (frames: LiveFrame[]): LiveFrame | undefined => frames.at(-1);

	test(
		"a watcher is given a real JPEG at once even when the page is not changing, at the page's size",
		async () => {
			const { runtime, browserId } = await openPage();
			const { frames, stop } = watch(runtime, browserId);
			await waitUntil("the first picture", async () => frames.length, (count) => count >= 1);
			stop();

			expect([...(frames[0] as LiveFrame).jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
			expect(frames[0]?.viewport).toEqual(VIEWPORT);
			expect(Math.abs((frames[0]?.capturedAt ?? 0) - Date.now())).toBeLessThan(10_000);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a click's result shows up in a later picture, and pictures keep coming across navigations (a cross-site swap among them)",
		async () => {
			const { runtime, browserId, url } = await openPage();
			const { frames, stop } = watch(runtime, browserId);
			await waitUntil("the first picture", async () => frames.length, (count) => count >= 1);
			const before = frames.length;

			await runtime.input(browserId, click(450, 60));
			await runtime.actMany(browserId, [{ kind: "eval", expression: "document.getElementById('flash').style.background = '#33d'" }]);
			await waitUntil("a picture after the change", async () => frames.length, (count) => count > before);

			// The second page is a different picture: the cast must show it, not repeat the first.
			const blank = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><body style='background:#000'>", { headers: { "content-type": "text/html" } }) });
			servers.push(blank);
			for (const next of [`http://localhost:${blank.port}/`, url, `http://127.0.0.1:${blank.port}/`]) {
				const previous = frames.at(-1) as LiveFrame;
				await runtime.act(browserId, { kind: "navigate", url: next });
				await waitUntil(`a different picture after going to ${next}`, async () => frames.at(-1), (frame) => frame !== undefined && frame.id !== previous.id && !Buffer.from(frame.jpeg).equals(Buffer.from(previous.jpeg)));
			}
			stop();
			expect(new Set(frames.map((frame) => frame.id)).size).toBe(frames.length);
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a second watcher is given the newest picture without waiting for the page to change, and the cast outlives the first watcher",
		async () => {
			const { runtime, browserId } = await openPage();
			const first = watch(runtime, browserId);
			await waitUntil("the first picture", async () => first.frames.length, (count) => count >= 1);

			const second = watch(runtime, browserId);
			await waitUntil("a picture for the late watcher", async () => second.frames.length, (count) => count >= 1);
			first.stop();
			expect(newest(second.frames)?.viewport).toEqual(VIEWPORT);
			second.stop();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"after the last watcher leaves, no more pictures are made; a new watcher gets pictures again",
		async () => {
			const { runtime, browserId } = await openPage();
			const first = watch(runtime, browserId);
			await waitUntil("the first picture", async () => first.frames.length, (count) => count >= 1);
			first.stop();
			const stopped = first.frames.length;
			// The page animates itself (a CSS animation would repaint): force changes the cast would have sent.
			for (let i = 0; i < 5; i += 1) await runtime.actMany(browserId, [{ kind: "eval", expression: `document.getElementById('flash').style.background = 'hsl(${i * 60},80%,50%)'` }]);
			expect(first.frames.length).toBe(stopped);

			const again = watch(runtime, browserId);
			await waitUntil("pictures again", async () => again.frames.length, (count) => count >= 1);
			again.stop();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a resize restarts the cast at the new page size, and the pictures say so",
		async () => {
			const { runtime, browserId } = await openPage();
			const { frames, stop } = watch(runtime, browserId);
			await waitUntil("the first picture", async () => frames.length, (count) => count >= 1);

			await runtime.resize(browserId, { width: 640, height: 480 }, 1);
			await waitUntil("a picture at 640x480", async () => frames.at(-1)?.viewport, (viewport) => viewport?.width === 640 && viewport.height === 480);
			stop();
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
