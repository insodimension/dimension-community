import { dirname } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { createPageFrame } from "@dimension/mcp-app-kit/annotate";
import type { App } from "@modelcontextprotocol/ext-apps";
import * as react from "react";
import { createElement } from "react";
import * as jsxDevRuntime from "react/jsx-dev-runtime";
import * as jsxRuntime from "react/jsx-runtime";
import * as reactDom from "react-dom";
import type { PaneExtras as PaneExtrasComponent } from "../app/view/pane-extras";
import type { PaneExtrasProps } from "../app/view/pane-shared";
import type { DocTab } from "../app/view/tabs";
import { installReact, type ReactEnv } from "./media-react";

// The kit's tsconfig maps `react` and its JSX runtimes onto their type declarations, which bun cannot load as code,
// and bun applies that map to the kit's sources wherever they are imported from. The map's targets are mocked with the
// real modules (the same instances this file and the pane use, so there is one React), which is what lets the pane
// import the kit here the way the kit's own React tests do from inside the kit.
const kitSource = dirname(Bun.resolveSync("@dimension/mcp-app-kit/annotate/react", import.meta.dir));
for (const [id, real] of [
	["react", react],
	["react/jsx-runtime", jsxRuntime],
	["react/jsx-dev-runtime", jsxDevRuntime],
	["react-dom", reactDom],
] as const) {
	mock.module(Bun.resolveSync(id, kitSource), () => real);
}

let env: ReactEnv;
let PaneExtras: typeof PaneExtrasComponent;
const restores: (() => void)[] = [];

interface StagedContext {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
}
const sent: StagedContext[] = [];
const landed: StagedContext[] = [];
const posted: Record<string, unknown>[] = [];

/** Put a global (or a property of one) in place for the whole file, remembering how to take it out. */
function install(target: object, name: string, value: unknown): void {
	const previous = Object.getOwnPropertyDescriptor(target, name);
	Object.defineProperty(target, name, { value, configurable: true, writable: true });
	restores.push(() => (previous ? Object.defineProperty(target, name, previous) : void Reflect.deleteProperty(target, name)));
}

const win = (): Window & typeof globalThis => env.document.defaultView as Window & typeof globalThis;

beforeAll(async () => {
	env = await installReact();
	const window = win();
	// `installDom` leaves out the field classes the shortcut hook tests a key's target against, the frame class the
	// pane tests its reading frame against, and the width query the pane's list asks.
	install(globalThis, "HTMLInputElement", window.HTMLInputElement);
	install(globalThis, "HTMLTextAreaElement", window.HTMLTextAreaElement);
	install(globalThis, "HTMLIFrameElement", window.HTMLIFrameElement);
	// No layout in linkedom: every box is 800 x 600 at the origin.
	install(window.Element.prototype, "getBoundingClientRect", () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 }));
	const frameWindows = new WeakMap<object, { postMessage(data: unknown): void }>();
	install(window.HTMLIFrameElement.prototype, "contentWindow", undefined);
	Object.defineProperty(window.HTMLIFrameElement.prototype, "contentWindow", {
		configurable: true,
		get(this: HTMLIFrameElement) {
			let value = frameWindows.get(this);
			if (value === undefined) {
				const standIn: { postMessage(data: unknown): void } = {
					postMessage: (data: unknown) => {
						posted.push(data as Record<string, unknown>);
						const request = data as { t?: unknown; id?: unknown };
						if (typeof request.t !== "string" || typeof request.id !== "string" || "c" in request || !runningPage.answers) return;
						queueMicrotask(() => {
							const reply = { t: request.t, id: request.id, html: runningPage.html, x: runningPage.x, y: runningPage.y };
							win().dispatchEvent(Object.assign(new (win().Event)("message"), { data: reply, source: standIn, origin: "null" }));
						});
					},
				};
				value = standIn;
				frameWindows.set(this, value);
			}
			return value;
		},
	});
	// A narrow View: the list goes under the document, into the pane (the width the artifact column really has).
	install(window, "matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
	// Dynamic by necessity: react-dom decides once, when it loads, whether there is a DOM, and the layer binds the
	// kit's React hooks at load.
	({ PaneExtras } = await import("../app/view/pane-extras"));
});
afterEach(async () => {
	await env.cleanup();
	sent.length = 0;
	landed.length = 0;
	posted.length = 0;
	Object.assign(runningPage, { html: PAGE, x: 0, y: 0, answers: true });
});
afterAll(() => {
	while (restores.length > 0) restores.pop()?.();
	env.restore();
});

const app = {
	getHostCapabilities: () => ({ updateModelContext: { text: {}, image: {} } }),
	updateModelContext: async (payload: StagedContext) => {
		sent.push(payload);
		await Bun.sleep(5);
		landed.push(payload);
		return {};
	},
} as unknown as App;

const TAB: DocTab = {
	path: "/files/sample.html",
	filename: "sample.html",
	key: "/files/sample.html",
	kind: "html",
	size: 4096,
	mtimeMs: 1,
	revision: 0,
	annotateRequests: 0,
};

/** What the reading frame holds, and a piece of it the pick frame's copy must carry. */
const NEEDLE = '<p id="needle">hello</p>';
const PAGE = `<!doctype html><title>sample</title>${NEEDLE}`;

const runningPage = { html: PAGE, x: 0, y: 0, answers: true };

const slotOf = (name: string): HTMLElement => {
	const element = env.document.createElement("div");
	element.setAttribute("data-slot", name);
	return element;
};

/** The DOM the pane builds around the layer, and the ways a person looks at what the layer put in it. */
interface Pane {
	readonly frame: HTMLElement;
	/** The frame the kit stood over the reading frame (sandboxed `allow-scripts`), or null while there is none. */
	readonly pickFrame: HTMLElement | null;
	/** The document the pick frame was given, or null while there is no pick frame. */
	readonly pickPage: string | null;
	/** Pick's radio on the bar. */
	readonly pick: HTMLElement | null;
	/** Whether Pick is the checked radio. */
	readonly picking: boolean;
	/** Whether Whole page is switched off. */
	readonly wholePageOff: boolean;
	readonly reading: HTMLIFrameElement;
	readonly scriptsTool: HTMLElement | null;
	readonly bar: string;
}

function pane(): Pane {
	const element = slotOf("viewer-pane");
	const strip = slotOf("viewer-mode-strip");
	const frame = slotOf("viewer-stage-frame");
	const reading = createPageFrame(PAGE);
	reading.setAttribute("data-slot", "viewer-html-frame");
	frame.append(reading);
	element.append(strip, frame);
	env.document.body.append(element);
	const pick = () => strip.querySelector<HTMLElement>('[data-tool="pick"]');
	const pickFrame = () => frame.querySelector<HTMLElement>('iframe[data-slot="viewer-html-pick-frame"]');
	return {
		frame,
		get pickFrame() {
			return pickFrame();
		},
		get pickPage() {
			// linkedom keeps the attribute's name in the case React wrote it (`srcDoc`); a browser's is `srcdoc`.
			const given = Array.from(pickFrame()?.attributes ?? []).find(attribute => attribute.name.toLowerCase() === "srcdoc");
			return given?.value ?? null;
		},
		get pick() {
			return pick();
		},
		get picking() {
			return pick()?.getAttribute("aria-checked") === "true";
		},
		get wholePageOff() {
			return strip.querySelector('[data-tool="whole-page"]')?.hasAttribute("disabled") ?? false;
		},
		reading,
		get scriptsTool() {
			return strip.querySelector<HTMLElement>('[data-tool="scripts"]');
		},
		get bar() {
			return strip.textContent ?? "";
		},
	};
}

const mountAt = (at: Pane) =>
	env.mount(createElement(PaneExtras, { app, tab: TAB, active: true, ready: true, frame: at.frame, mode: "elements" } satisfies PaneExtrasProps));

function click(element: Element | null): Promise<void> {
	if (element === null) throw new Error("nothing to click");
	return env.act(async () => void element.dispatchEvent(new (win().Event)("click", { bubbles: true, cancelable: true })));
}

function escape(): Promise<void> {
	const event = Object.assign(new (win().Event)("keydown", { bubbles: true, cancelable: true }), { key: "Escape" });
	return env.act(async () => void win().dispatchEvent(event));
}

async function typeNote(field: HTMLTextAreaElement, text: string): Promise<void> {
	const fire = (type: string): Promise<void> =>
		env.act(async () => void field.dispatchEvent(new (win().Event)(type, { bubbles: true, cancelable: true })));
	Object.assign(field, { attachEvent() {}, detachEvent() {} });
	await fire("focusin");
	Object.getOwnPropertyDescriptor(win().HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
	await fire("input");
	await fire("keyup");
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const AFTER_THE_PAUSE_MS = 900;

async function until(fact: () => boolean): Promise<void> {
	for (const started = Date.now(); !fact(); ) {
		if (Date.now() - started > 3000) throw new Error("the awaited fact never came true");
		await env.act(async () => sleep(5));
	}
}

/** Wait, in `act`, until the pick frame is there: the kit builds its document a few promise turns after Pick comes up. */
async function pickFrameUp(at: Pane): Promise<void> {
	for (const started = Date.now(); at.pickFrame === null && Date.now() - started < 2000; ) await env.act(async () => sleep(2));
}

/** Let the build that follows Pick coming up run its course, so that a frame that is merely late would be there. */
const quiet = () => env.act(async () => sleep(60));

/** Deliver a real picker-protocol message from this frame, not a call directly into the session. */
async function pageSays(frame: HTMLElement, data: Record<string, unknown>): Promise<void> {
	const event = Object.assign(new (win().Event)("message"), {
		data,
		source: (frame as HTMLIFrameElement).contentWindow,
		origin: "null",
	});
	await env.act(async () => void win().dispatchEvent(event));
}

function channelOf(at: Pane): string {
	const matches = [...(at.pickPage ?? "").matchAll(/\)\("([0-9a-f]{32})"\);/g)];
	const channel = matches[matches.length - 1]?.[1];
	if (channel === undefined) throw new Error("picker channel unavailable");
	return channel;
}

async function pickedPage(at: Pane): Promise<{ frame: HTMLElement; channel: string }> {
	if (!at.picking) await click(at.pick);
	await pickFrameUp(at);
	const frame = at.pickFrame;
	if (frame === null) throw new Error("picker frame unavailable");
	const channel = channelOf(at);
	await pageSays(frame, { c: channel, t: "ready", vw: 800, vh: 600 });
	return { frame, channel };
}

const noteTarget = {
	selector: "#needle",
	matches: 1,
	tag: "p",
	text: "hello",
	attrs: [],
	style: { color: "rgb(0, 0, 0)", background: "rgba(0, 0, 0, 0)", fontSize: "16px", fontWeight: "400" },
	box: { x: 30, y: 40, width: 100, height: 20 },
};

describe("HTML picks as notes in place", () => {
	test("opens the picked element beside the page, keeps its badge after an outside press, and reopens from that badge", async () => {
		const at = pane();
		await mountAt(at);
		const { frame, channel } = await pickedPage(at);
		await pageSays(frame, { c: channel, t: "pick", id: 7, target: noteTarget, steps: { wider: true, narrower: false } });
		await pageSays(frame, {
			c: channel, t: "layout", vw: 800, vh: 600, sx: 0, sy: 0,
			boxes: [{ id: 7, x: 30, y: 40, w: 100, h: 20 }], gone: [],
		});
		await env.runFrames();

		const popover = at.frame.querySelector('[data-slot="note-popover"]');
		expect(popover?.querySelector('[data-slot="note-popover-heading"]')?.textContent).toBe("#needle");
		expect(popover?.querySelector('[data-slot="note-popover-actions"]')?.textContent).toContain("Wider");
		expect(at.frame.querySelector('[data-slot="viewer-html-pick-frame"] [data-slot="note-popover"]')).toBeNull();
		expect(env.document.querySelector('[data-slot="annotation-panel"]')).toBeNull();

		await env.act(async () => {
			env.document.body.dispatchEvent(new (win().Event)("pointerdown", { bubbles: true, cancelable: true }));
		});
		expect(at.frame.querySelector('[data-slot="note-popover"]')).toBeNull();
		const badge = at.frame.querySelector('[data-slot="element-note-badge"]');
		expect(badge?.getAttribute("aria-label")?.toLowerCase()).toContain("no note");
		await env.act(async () => void badge?.dispatchEvent(new (win().Event)("mouseover", { bubbles: true })));
		expect(at.frame.querySelector('[data-slot="note-card-heading"]')?.textContent).toBe("#needle");
		await click(badge);
		expect(at.frame.querySelector('[data-slot="note-popover"] textarea')?.getAttribute("aria-label")).toBe("Note 1");
		await click(at.frame.querySelector('[data-slot="note-popover-delete"]'));
		await env.runFrames();
		expect(at.frame.querySelector('[data-slot="element-note-badge"]')).toBeNull();
	});

	test("a page reporting unavailable leaves the reading frame and no pick editor", async () => {
		const at = pane();
		await mountAt(at);
		await click(at.pick);
		await pickFrameUp(at);
		const frame = at.pickFrame;
		if (frame === null) throw new Error("picker frame unavailable");
		await pageSays(frame, { c: channelOf(at), t: "unavailable" });
		await env.runFrames();

		expect(at.pickFrame).toBeNull();
		expect(at.frame.querySelector('[data-slot="viewer-html-frame"]')).not.toBeNull();
		expect(at.frame.querySelector('[data-slot="note-popover"]')).toBeNull();
		expect(env.document.querySelector('[data-slot="viewer-mode-strip"]')?.textContent).toContain("Can't pick from this page");
	});

	test("Escape while typing in the opened note does not put Pick down", async () => {
		const at = pane();
		await mountAt(at);
		const { frame, channel } = await pickedPage(at);
		await pageSays(frame, { c: channel, t: "pick", id: 7, target: noteTarget, steps: { wider: true, narrower: false } });
		await pageSays(frame, {
			c: channel, t: "layout", vw: 800, vh: 600, sx: 0, sy: 0,
			boxes: [{ id: 7, x: 30, y: 40, w: 100, h: 20 }], gone: [],
		});
		await env.runFrames();
		expect(at.frame.querySelector('[data-slot="note-popover"] textarea')).not.toBeNull();
		const input = env.document.createElement("textarea");
		env.document.body.append(input);
		await env.act(async () => {
			const event = Object.assign(new (win().Event)("keydown", { bubbles: true, cancelable: true }), { key: "Escape" });
			input.dispatchEvent(event);
		});
		expect(at.picking).toBe(true);
		expect(at.pickFrame).not.toBeNull();
	});

	test("notes remain navigable after Escape closes the editor and then puts Pick down", async () => {
		const at = pane();
		await mountAt(at);
		const { frame, channel } = await pickedPage(at);
		await pageSays(frame, { c: channel, t: "pick", id: 7, target: noteTarget, steps: { wider: true, narrower: false } });
		await pageSays(frame, {
			c: channel, t: "layout", vw: 800, vh: 600, sx: 0, sy: 0,
			boxes: [{ id: 7, x: 30, y: 40, w: 100, h: 20 }], gone: [],
		});
		await env.runFrames();
		await escape();
		await escape();
		expect(at.picking).toBe(false);
		expect(at.pickFrame).toBeNull();

		const navigation = at.frame.querySelector('[data-slot="element-note-navigation"][aria-label="Notes on this page"]');
		const item = navigation?.querySelector('[data-slot="element-note-navigation-item"]');
		expect(item?.textContent).toContain("#needle");
		await click(item ?? null);
		expect(at.picking).toBe(false);
		expect(at.frame.querySelector('[data-slot="note-popover-heading"]')?.textContent).toBe("#needle");
		await click(at.frame.querySelector('[data-slot="note-popover-delete"]'));
		expect(navigation?.querySelector('[data-slot="element-note-navigation-item"]')).toBeNull();
	});

	test("notes stay readable and editable with Pick put down, without rebuilding the pick frame", async () => {
		const at = pane();
		await mountAt(at);
		await click(at.pick);
		const { frame, channel } = await pickedPage(at);
		await pageSays(frame, { c: channel, t: "pick", id: 7, target: noteTarget, steps: { wider: true, narrower: false } });
		await pageSays(frame, {
			c: channel, t: "layout", vw: 800, vh: 600, sx: 0, sy: 0,
			boxes: [{ id: 7, x: 30, y: 40, w: 100, h: 20 }], gone: [],
		});
		await env.runFrames();
		await escape();
		await escape();
		expect(at.pickFrame).toBeNull();
		await click(at.frame.querySelector('[data-slot="element-note-navigation-item"]'));
		const input = at.frame.querySelector<HTMLTextAreaElement>('[data-slot="note-popover"] textarea');
		expect(input?.getAttribute("aria-label")).toBe("Note 1");
		if (input === null) throw new Error("note editor unavailable");
		await typeNote(input, "Keep this paragraph");
		expect(at.frame.querySelector('[data-slot="element-note-navigation-item"]')?.textContent).toContain("Keep this paragraph");
		expect(at.pickFrame).toBeNull();
		await escape();
		expect(at.frame.querySelector('[data-slot="element-note-navigation-item"]')?.textContent).toContain("#needle");
		await click(at.frame.querySelector('[data-slot="element-note-navigation-item"]'));
		expect(at.frame.querySelector<HTMLTextAreaElement>('[data-slot="note-popover"] textarea')?.value).toBe("Keep this paragraph");
		expect(at.pickFrame).toBeNull();
	});

	test("an off-layer page retains note navigation and editing without activating the picker", async () => {
		const at = pane();
		const mounted = await mountAt(at);
		const { frame, channel } = await pickedPage(at);
		await pageSays(frame, { c: channel, t: "pick", id: 7, target: noteTarget, steps: { wider: true, narrower: false } });
		await env.runFrames();
		await mounted.render(createElement(PaneExtras, {
			app, tab: TAB, active: true, ready: true, frame: at.frame, mode: "comments",
		} satisfies PaneExtrasProps));
		expect(at.pickFrame).toBeNull();
		await click(at.frame.querySelector('[data-slot="element-note-navigation-item"]'));
		expect(at.frame.querySelector('[data-slot="element-note-navigation-item"]')?.textContent).toContain("#needle");
		expect(at.frame.querySelector('[data-slot="note-popover-heading"]')?.textContent).toBe("#needle");
		expect(at.pickFrame).toBeNull();
	});
});

describe("HTML picks staged by themselves", () => {
	async function pickNeedle(frame: HTMLElement, channel: string): Promise<void> {
		await pageSays(frame, { c: channel, t: "pick", id: 7, target: noteTarget, steps: { wider: true, narrower: false } });
		await pageSays(frame, {
			c: channel, t: "layout", vw: 800, vh: 600, sx: 0, sy: 0,
			boxes: [{ id: 7, x: 30, y: 40, w: 100, h: 20 }], gone: [],
		});
		await env.runFrames();
	}

	const layer = (at: Pane, mode: PaneExtrasProps["mode"]) =>
		createElement(PaneExtras, { app, tab: TAB, active: true, ready: true, frame: at.frame, mode } satisfies PaneExtrasProps);

	test("the pane has no send footer and no message field: its last child is the notice, there while the layer is up", async () => {
		const at = pane();
		const mounted = await env.mount(layer(at, "elements"));
		await pickedPage(at);
		const viewerPane = env.document.querySelector('[data-slot="viewer-pane"]');
		expect(viewerPane?.lastElementChild?.getAttribute("data-slot")).toBe("annotation-notice");
		expect(viewerPane?.querySelector('[data-slot="annotation-footer"]')).toBeNull();
		expect(viewerPane?.querySelector("textarea")).toBeNull();
		expect(viewerPane?.textContent).not.toContain("Request edits");

		await mounted.render(layer(at, "comments"));
		expect(viewerPane?.querySelector('[data-slot="annotation-notice"]')).toBeNull();
	});

	test("a pick stages by itself once the pause elapses, with the page's answer, and removing it takes the request back", async () => {
		const at = pane();
		await env.mount(layer(at, "elements"));
		const { frame, channel } = await pickedPage(at);
		await pickNeedle(frame, channel);
		expect(sent).toHaveLength(0);

		await until(() => posted.some(message => message.t === "describe"));
		const asked = posted.find(message => message.t === "describe");
		await pageSays(frame, { c: channel, t: "described", req: asked?.req, vw: 800, vh: 600, items: [{ id: 7, target: noteTarget }] });
		await until(() => landed.length === 1);
		await env.act(async () => {});
		expect(sent).toHaveLength(1);
		expect(sent[0]?.content.map(block => block.type)).toEqual(["text"]);
		expect(sent[0]?.content[0]?.text).toContain("#needle");

		await click(at.frame.querySelector('[data-slot="note-popover-delete"]'));
		expect(sent).toHaveLength(2);
		expect(sent[1]?.content).toEqual([]);
		await until(() => landed.length === 2);
	});

	test("notes made stay unstaged while the layer is down, and stage once it is back up", async () => {
		const at = pane();
		const mounted = await env.mount(layer(at, "elements"));
		const { frame, channel } = await pickedPage(at);
		await pickNeedle(frame, channel);

		await mounted.render(layer(at, "comments"));
		await env.act(async () => sleep(AFTER_THE_PAUSE_MS));
		expect(sent).toHaveLength(0);

		await mounted.render(layer(at, "elements"));
		await until(() => landed.length === 1);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.content[0]?.text).toContain("#needle");
	});
});

describe("Pick on a page, once its layer is up", () => {
	test("starts down: no pick frame, the live page is left running and is never asked for a copy of itself", async () => {
		const at = pane();
		await mountAt(at);
		await quiet();

		expect(at.picking).toBe(false);
		expect(at.pickFrame).toBeNull();
		expect(at.wholePageOff).toBe(true);
		expect(at.reading.getAttribute("sandbox")).toBe("allow-scripts");
		expect(at.reading.style.visibility).not.toBe("hidden");
		expect(posted.filter(message => !("c" in message))).toEqual([]);
		expect(at.frame.querySelector('[data-slot="note-popover"]')).toBeNull();
	});

	test("is picked up by Pick: the page is asked for a still of itself and the pick frame is made from the answer, not from the page's source", async () => {
		const drawn = '<p id="drawn">drawn by script</p>';
		runningPage.html = `${PAGE}${drawn}`;
		const at = pane();
		await mountAt(at);
		await click(at.pick);
		await pickFrameUp(at);

		expect(at.picking).toBe(true);
		expect(at.pickPage).toContain(NEEDLE);
		expect(at.pickPage).toContain(drawn);
		expect(at.reading.srcdoc).not.toContain(drawn);
		expect(at.wholePageOff).toBe(false);
	});

	test("is put down by Pick pressed again, and comes back when pressed once more", async () => {
		const at = pane();
		await mountAt(at);
		await click(at.pick);
		await pickFrameUp(at);
		expect(at.picking).toBe(true);
		expect(at.pickFrame).not.toBeNull();
		expect(at.wholePageOff).toBe(false);

		await click(at.pick);
		expect(at.picking).toBe(false);
		expect(at.pickFrame).toBeNull();
		expect(at.wholePageOff).toBe(true);
		await quiet();
		expect(at.pickFrame).toBeNull();

		await click(at.pick);
		await pickFrameUp(at);
		expect(at.picking).toBe(true);
		expect(at.pickFrame).not.toBeNull();
		expect(at.wholePageOff).toBe(false);
	});

	test("is put down by Escape, and no pick frame turns up late", async () => {
		const at = pane();
		await mountAt(at);
		await click(at.pick);
		await pickFrameUp(at);
		expect(at.picking).toBe(true);

		await escape();

		expect(at.picking).toBe(false);
		expect(at.pickFrame).toBeNull();
		await quiet();
		expect(at.pickFrame).toBeNull();
	});
});

describe("Run scripts and Stop scripts on the bar", () => {
	test("the bar says what the person is looking at: scripts running offline, a still when picking, a page shown without scripts once stopped", async () => {
		const at = pane();
		await mountAt(at);
		expect(at.scriptsTool?.getAttribute("aria-label")).toBe("Stop scripts");
		expect(at.bar).toContain("Scripts run offline");

		await click(at.pick);
		await pickFrameUp(at);
		expect(at.bar).toContain("Picking from a still of the page");
		expect(at.bar).not.toContain("Scripts run offline");

		await click(at.scriptsTool);
		expect(at.scriptsTool?.getAttribute("aria-label")).toBe("Run scripts");
		expect(at.bar).toContain("Shown without scripts");
	});

	test("Stop flips the same reading frame to no scripts with the page it started from, and puts Pick down with its pick frame", async () => {
		const at = pane();
		await mountAt(at);
		await click(at.pick);
		await pickFrameUp(at);
		expect(at.picking).toBe(true);

		await click(at.scriptsTool);

		expect(at.frame.querySelector('[data-slot="viewer-html-frame"]')).toBe(at.reading);
		expect(at.reading.getAttribute("sandbox")).toBe("");
		expect(at.reading.srcdoc).toBe(PAGE);
		expect(at.picking).toBe(false);
		expect(at.pickFrame).toBeNull();
		await quiet();
		expect(at.pickFrame).toBeNull();
	});

	test("Run puts the sandbox and the run document back and leaves Pick down, whatever it was before", async () => {
		const at = pane();
		await mountAt(at);
		await click(at.scriptsTool);
		expect(at.reading.getAttribute("sandbox")).toBe("");

		await click(at.scriptsTool);

		expect(at.reading.getAttribute("sandbox")).toBe("allow-scripts");
		expect(at.reading.srcdoc).toBe(createPageFrame(PAGE).srcdoc);
		expect(at.picking).toBe(false);
		expect(at.pickFrame).toBeNull();
		expect(at.scriptsTool?.getAttribute("aria-label")).toBe("Stop scripts");
	});

	test("a stopped page is picked from its own bytes, and is never asked for a copy of itself", async () => {
		const drawn = '<p id="drawn">drawn by script</p>';
		runningPage.html = `${PAGE}${drawn}`;
		const at = pane();
		await mountAt(at);
		await click(at.scriptsTool);
		await click(at.pick);
		await pickFrameUp(at);

		expect(at.picking).toBe(true);
		expect(at.pickPage).toContain(NEEDLE);
		expect(at.pickPage).not.toContain(drawn);
		expect(posted.filter(message => !("c" in message))).toEqual([]);
	});
});

describe("an annotate request from the agent", () => {
	const asked = (at: Pane, requests: number) =>
		createElement(PaneExtras, {
			app,
			tab: { ...TAB, annotateRequests: requests },
			active: true,
			ready: true,
			frame: at.frame,
			mode: "elements",
		} satisfies PaneExtrasProps);

	test("picks Pick up on a page that started with it down, and again after the person put it down", async () => {
		const at = pane();
		const mounted = await env.mount(asked(at, 0));
		await quiet();
		expect(at.picking).toBe(false);
		expect(at.pickFrame).toBeNull();

		await mounted.render(asked(at, 1));
		await pickFrameUp(at);
		expect(at.picking).toBe(true);
		expect(at.pickFrame).not.toBeNull();

		await click(at.pick);
		expect(at.picking).toBe(false);
		expect(at.pickFrame).toBeNull();

		await mounted.render(asked(at, 2));
		await pickFrameUp(at);
		expect(at.picking).toBe(true);
		expect(at.pickFrame).not.toBeNull();
	});
});
