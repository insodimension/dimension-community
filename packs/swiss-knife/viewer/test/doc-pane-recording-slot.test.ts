import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import type { App } from "@modelcontextprotocol/ext-apps";
import { createElement } from "react";
import { RECORDING_SLOT_REFUSAL_FIRST_WORDS } from "../src/contract";
import { installReact, type ReactEnv } from "./media-react";
import { silencePaneExtras } from "./pane-extras-door";
import type { DocTab } from "../app/view/tabs";
import type * as docPaneModule from "../app/view/doc-pane";

const SLOT_REFUSAL = `${RECORDING_SLOT_REFUSAL_FIRST_WORDS} 2 recordings of this engine open — "take.mp4". Close one of those tabs (or close its session) before opening another.`;

let env: ReactEnv;
let unsilence: () => void;
let docPane: typeof docPaneModule;

beforeAll(async () => {
	env = await installReact();
	unsilence = await silencePaneExtras();
	mock.module("../app/view/renderers", () => ({ loadRenderer: () => Promise.resolve(null) }));
	docPane = await import("../app/view/doc-pane");
});
afterEach(async () => {
	armedCalls.length = 0;
	await env.cleanup();
});
afterAll(() => {
	armedCalls.length = 0;
	unsilence();
	env.restore();
});

const armedCalls: string[] = [];

const app = {
	callServerTool: async (request: { name: string }): Promise<unknown> => {
		armedCalls.push(request.name);
		if (request.name === "close_other_recordings") return { content: [] };
		return { isError: true, content: [{ type: "text", text: SLOT_REFUSAL }] };
	},
} as unknown as App;

const TAB: DocTab = { key: "take", path: "D:\\scratch\\take.mp4", filename: "take.mp4", kind: "video", size: 4096, mtimeMs: 1, revision: 0, annotateRequests: 0 };
const BANNER = '[data-slot="viewer-stage-frame"] [role="alert"]';
const buttonOf = (container: HTMLElement, label: string): HTMLButtonElement | undefined =>
	[...container.querySelectorAll<HTMLButtonElement>(`${BANNER} button`)].find((button) => button.textContent === label);

describe("a slot refusal's card", () => {
	test("names the way out and runs it, then opens again", async () => {
		const { container, render } = await env.mount(createElement(docPane.DocPane, { app, tab: TAB, active: true, theme: "dark" }));
		expect(armedCalls).toEqual(["open_media", "close_media"]);
		let banner = container.querySelector(BANNER);
		expect(banner?.textContent).toContain(SLOT_REFUSAL);
		const closeOthers = buttonOf(container, "Close other recordings");
		expect(closeOthers).toBeDefined();
		closeOthers?.click();
		await env.act(async () => undefined);
		expect(armedCalls).toContain("close_other_recordings");
		const after = armedCalls.slice(armedCalls.indexOf("close_other_recordings"));
		expect(after).toEqual(["close_other_recordings", "open_media", "close_media"]);
		banner = container.querySelector(BANNER);
		expect(banner?.textContent).toContain(SLOT_REFUSAL);
		expect(buttonOf(container, "Try again")).toBeDefined();
		expect(buttonOf(container, "Copy path")).toBeUndefined();
		await render(createElement(docPane.DocPane, { app, tab: TAB, active: true, theme: "dark" }));
	});
});
