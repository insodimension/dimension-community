/** WHAT BREAKS IN THE PRODUCT IF THIS GOES RED: a person who opens a dropdown (a native <select>) in the Browser View sees
 *  nothing open, because Chrome draws that list outside the page's picture, and cannot pick from it with the mouse; or a pick
 *  made in the View's own drawing of the list is a script's value change the page can tell from a real one; or the list is
 *  read while nobody watches.
 *
 *  Real Chrome, real pages. Input goes through `runtime.input` (the direct channel's door), the list through
 *  `runtime.liveState` (what the stream sends the View), with `runtime.watchFrames` standing in for a watching View.
 */
import { afterEach, expect, test } from "bun:test";
import type { NativePicker } from "../src/contracts";
import type { BrowserRuntime } from "../src/runtime";
import { BROWSER_TEST_TIMEOUT_MS, createRuntime, describeWithChrome, failureCode, teardown, waitUntil } from "./fixture";

const VIEWPORT = { width: 800, height: 600 };
const BUSY_FOR_MS = 20_000;
const PICKER_SHOWN_WITHIN_MS = 5_000;

const RECORDER = `window.log = [];
for (const select of document.querySelectorAll("select")) {
  for (const type of ["input", "change"]) select.addEventListener(type, (event) => {
    const entry = type + ":" + (event.isTrusted ? "trusted" : "script") + ":" + select.value;
    window.log.push(entry);
    if (parent !== window) parent.postMessage(entry, "*");
  });
}
addEventListener("message", (event) => {
  if (event.data === "painted") window.framePainted = true;
  else window.log.push("frame:" + event.data);
});`;

const OPTIONS = `<option value="a">Alpha</option><option value="b">Bravo</option><option value="c" disabled>Charlie</option>
<optgroup label="Later"><option value="d">Delta</option><option value="e">Echo</option><option value="f">Foxtrot</option></optgroup>`;

const MAIN = (port: number) => `<!doctype html><meta charset="utf-8"><title>pickers</title>
<style>body{margin:0} select{position:absolute;font:16px sans-serif;height:30px} iframe{position:absolute;left:400px;top:200px;width:300px;height:200px;border:0}</style>
<select id="top" style="left:40px;top:40px;width:200px">${OPTIONS}</select>
<iframe src="http://localhost:${port}/inner"></iframe>
<script>${RECORDER}</script>`;

const INNER = `<!doctype html><meta charset="utf-8"><style>body{margin:0} select{position:absolute;left:20px;top:30px;width:160px;height:30px;font:16px sans-serif}</style>
<select id="inner">${OPTIONS}</select><script>${RECORDER}
requestAnimationFrame(() => requestAnimationFrame(() => parent.postMessage("painted", "*")));</script>`;

const BUSY_PAGE = `<!doctype html><meta charset="utf-8"><title>busy</title>
<style>body{margin:0} button{position:absolute;left:10px;top:10px;width:120px;height:40px}</style>
<button id="go">go</button>
<script>
addEventListener("message", () => { fetch("/busy-started"); const end = Date.now() + ${BUSY_FOR_MS}; while (Date.now() < end) {} }, { once: true });
document.getElementById("go").addEventListener("click", () => postMessage("busy", "*"));
</script>`;

const servers: Array<{ stop(force?: boolean): unknown }> = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop(true);
	await teardown();
}, BROWSER_TEST_TIMEOUT_MS);

async function openPage(): Promise<{ runtime: BrowserRuntime; browserId: string; origin: string; hits: string[] }> {
	const hits: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request: Request): Response => {
			const url = new URL(request.url);
			hits.push(url.pathname);
			if (url.pathname === "/busy-started") return new Response(null, { status: 204 });
			if (url.pathname === "/busy") return new Response(BUSY_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
			return new Response(url.pathname === "/inner" ? INNER : MAIN(Number(url.port)), { headers: { "content-type": "text/html; charset=utf-8" } });
		},
	});
	servers.push(server);
	const origin = `http://127.0.0.1:${server.port}`;
	const { runtime } = await createRuntime();
	const { browserId } = await runtime.open({ viewport: VIEWPORT });
	expect((await runtime.act(browserId, { kind: "navigate", url: `${origin}/` })).status).toBe("completed");
	await waitUntil("the cross-origin frame to paint", () => pageValue<boolean>(runtime, browserId, "window.framePainted === true"), (painted) => painted);
	return { runtime, browserId, origin, hits };
}

async function pageValue<T>(runtime: BrowserRuntime, browserId: string, expression: string): Promise<T> {
	const outcome = await runtime.actMany(browserId, [{ kind: "eval", expression }]);
	expect(outcome.status).toBe("completed");
	return JSON.parse(outcome.steps[0]?.value ?? "null") as T;
}

const click = (x: number, y: number) => [
	{ kind: "mouse", type: "move", x, y },
	{ kind: "mouse", type: "down", x, y, buttons: 1 },
	{ kind: "mouse", type: "up", x, y },
];

const watched = (runtime: BrowserRuntime, browserId: string): (() => void) => runtime.watchFrames(browserId, () => undefined);

async function openList(runtime: BrowserRuntime, browserId: string): Promise<NativePicker> {
	const picker = await waitUntil("the open list in the live state", async () => (await runtime.liveState(browserId)).picker, (shown) => shown !== undefined);
	if (picker === undefined) throw new Error("no open list");
	return picker;
}

describeWithChrome("a native list opened in the Browser View", () => {
	test(
		"opening a <select> in a watched View puts its list in the live state: every option, which are disabled, their group, the selected one, and where the select is",
		async () => {
			const { runtime, browserId } = await openPage();
			const stop = watched(runtime, browserId);
			try {
				await runtime.input(browserId, click(140, 55));
				const picker = await openList(runtime, browserId);
				expect(picker.options.map((option) => option.label)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"]);
				expect(picker.options.filter((option) => option.disabled).map((option) => option.label)).toEqual(["Charlie"]);
				expect(picker.options.map((option) => option.group)).toEqual([null, null, null, "Later", "Later", "Later"]);
				expect(picker.selected).toBe(0);
				expect(picker.truncated).toBe(false);
				expect(picker.box).toEqual({ x: 40, y: 40, width: 200, height: 30 });
				expect(await pageValue<boolean>(runtime, browserId, "document.getElementById('top').matches(':open')")).toBe(true);
			} finally {
				stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a pick from the View's list is Chrome's own: the value changes, input and change fire trusted, the list closes and leaves the live state",
		async () => {
			const { runtime, browserId } = await openPage();
			const stop = watched(runtime, browserId);
			try {
				await runtime.input(browserId, click(140, 55));
				const first = await openList(runtime, browserId);
				await runtime.input(browserId, [{ kind: "pick", picker: first.id, index: 3 }]);
				expect(await pageValue<string>(runtime, browserId, "document.getElementById('top').value")).toBe("d");
				expect(await pageValue<string[]>(runtime, browserId, "window.log")).toEqual(["input:trusted:d", "change:trusted:d"]);
				expect(await pageValue<boolean>(runtime, browserId, "document.getElementById('top').matches(':open')")).toBe(false);
				expect((await runtime.liveState(browserId)).picker).toBeUndefined();

				await runtime.input(browserId, click(140, 55));
				const second = await openList(runtime, browserId);
				expect(second.selected).toBe(3);
				await runtime.input(browserId, [{ kind: "pick", picker: second.id, index: 5 }]);
				await runtime.input(browserId, click(140, 55));
				const third = await openList(runtime, browserId);
				await runtime.input(browserId, [{ kind: "pick", picker: third.id, index: 1 }]);
				expect(await pageValue<string[]>(runtime, browserId, "window.log")).toEqual(["input:trusted:d", "change:trusted:d", "input:trusted:f", "change:trusted:f", "input:trusted:b", "change:trusted:b"]);
			} finally {
				stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a list in a cross-origin frame is placed where the frame shows it, and a pick there is the frame's own trusted change",
		async () => {
			const { runtime, browserId } = await openPage();
			const stop = watched(runtime, browserId);
			try {
				await runtime.input(browserId, click(500, 245));
				const picker = await openList(runtime, browserId);
				expect(picker.box).toEqual({ x: 420, y: 230, width: 160, height: 30 });
				await runtime.input(browserId, [{ kind: "pick", picker: picker.id, index: 4 }]);
				await waitUntil("the frame's change", () => pageValue<string[]>(runtime, browserId, "window.log"), (log) => log.length === 2);
				expect(await pageValue<string[]>(runtime, browserId, "window.log")).toEqual(["frame:input:trusted:e", "frame:change:trusted:e"]);
			} finally {
				stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a pick for a list that is no longer the open one is refused and changes nothing",
		async () => {
			const { runtime, browserId } = await openPage();
			const stop = watched(runtime, browserId);
			try {
				await runtime.input(browserId, click(140, 55));
				const picker = await openList(runtime, browserId);
				await runtime.input(browserId, [
					{ kind: "key", type: "down", key: "Escape", code: "Escape", keyCode: 27 },
					{ kind: "key", type: "up", key: "Escape", code: "Escape", keyCode: 27 },
				]);
				expect(await failureCode(() => runtime.input(browserId, [{ kind: "pick", picker: picker.id, index: 1 }]))).toBe("picker_closed");
				expect(await pageValue<string>(runtime, browserId, "document.getElementById('top').value")).toBe("a");
				expect(await pageValue<string[]>(runtime, browserId, "window.log")).toEqual([]);
			} finally {
				stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"a tab that cannot answer the list read does not hold up the list of the tab the person switched to",
		async () => {
			const { runtime, browserId, origin, hits } = await openPage();
			const calmTab = (await runtime.state(browserId)).activeTabId;
			const stop = watched(runtime, browserId);
			try {
				await runtime.tab(browserId, { op: "new", url: `${origin.replace("127.0.0.1", "localhost")}/busy` });
				await runtime.input(browserId, click(60, 30));
				await waitUntil("the busy tab's loop to start", () => hits, (seen) => seen.includes("/busy-started"));
				expect((await runtime.liveState(browserId)).picker).toBeUndefined();

				await runtime.tab(browserId, { op: "activate", tabId: calmTab });
				await runtime.input(browserId, click(140, 55));
				const picker = await waitUntil("the calm tab's list in the live state", async () => (await runtime.liveState(browserId)).picker, (shown) => shown !== undefined, PICKER_SHOWN_WITHIN_MS);
				expect(picker?.options.map((option) => option.label)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"]);
				expect(picker?.box).toEqual({ x: 40, y: 40, width: 200, height: 30 });
			} finally {
				stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);

	test(
		"is read only while a View watches: unwatched, the live state carries no list even with one open; watched, it does",
		async () => {
			const { runtime, browserId } = await openPage();
			await runtime.input(browserId, click(140, 55));
			expect(await pageValue<boolean>(runtime, browserId, "document.getElementById('top').matches(':open')")).toBe(true);
			for (let read = 0; read < 3; read += 1) expect((await runtime.liveState(browserId)).picker).toBeUndefined();
			const stop = watched(runtime, browserId);
			try {
				expect((await openList(runtime, browserId)).options).toHaveLength(6);
			} finally {
				stop();
			}
		},
		BROWSER_TEST_TIMEOUT_MS,
	);
});
