// A press is a pointer event, and a pointer event never reaches an element whose computed `pointer-events` is
// none. The surface lays its chrome over a full-bleed canvas with `pointer-events: none` on the overlay boxes and
// `auto` back on what is meant to be pressed; a control left under a `none` box is still found by a test that
// dispatches a click, and dead to a person (the Back button was exactly this). This resolves each control's
// effective `pointer-events` from the shipped stylesheet the way the cascade does for this sheet: the most
// specific matching declaration on the element, else its parent's, else `auto`.
import { afterEach, describe, expect, test } from "bun:test";
import { FaceSurfaceBody } from "../src/surface/face-surface";
import { STYLES } from "../src/surface/styles";
import type { FaceLive } from "../src/surface/live";
import type { FaceVoice } from "../src/surface/voice";
import { mountPage, unmountAll } from "./surface-dom";

afterEach(unmountAll);

type Rule = { selector: string; value: string; weight: number; index: number };

function weight(selector: string): number {
	const ids = (selector.match(/#[\w-]+/g) ?? []).length;
	const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
	const tags = (selector.replace(/\[[^\]]*\]/g, "").match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
	return ids * 10_000 + classes * 100 + tags;
}

function pointerRules(css: string): Rule[] {
	const flat = css.replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
	const rules: Rule[] = [];
	for (const [, selectors, body] of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const value = /(?:^|;|\s)pointer-events\s*:\s*([a-z-]+)/.exec(body)?.[1];
		if (!value) continue;
		for (const selector of selectors.split(",")) rules.push({ selector: selector.trim(), value, weight: weight(selector), index: rules.length });
	}
	return rules;
}

function matches(el: Element, selector: string): boolean {
	try {
		return el.matches(selector);
	} catch {
		return false;
	}
}

function effectivePointerEvents(el: Element, rules: Rule[]): string {
	for (let node: Element | null = el; node; node = node.parentElement) {
		const own = rules
			.filter((rule) => matches(node, rule.selector))
			.sort((a, b) => b.weight - a.weight || b.index - a.index)[0];
		if (own && own.value !== "inherit") return own.value;
	}
	return "auto";
}

function voice(over: Partial<FaceVoice> = {}): FaceVoice {
	return {
		supported: true,
		phase: "idle",
		error: undefined,
		refusal: undefined,
		notice: undefined,
		micLive: false,
		muted: false,
		micDevices: [],
		micDeviceId: undefined,
		micLabel: undefined,
		micSilent: false,
		setMicDevice: () => undefined,
		partial: "",
		words: [],
		turn: 0,
		faceModel: false,
		levels: { getMic: () => 0, getAgent: () => 0, getSilence: () => 0 },
		audioClock: () => 0,
		faceAt: () => null,
		start: async () => undefined,
		stop: async () => undefined,
		toggleMute: () => undefined,
		...over,
	};
}

function live(over: Partial<FaceLive> = {}): FaceLive {
	return {
		available: false,
		voice: null,
		phase: "off",
		enginePhase: "off",
		transcript: null,
		muted: false,
		seconds: 0,
		error: null,
		getInputLevel: () => 0,
		getOutputLevel: () => 0,
		start: async () => undefined,
		stop: () => undefined,
		toggleMute: () => undefined,
		...over,
	};
}

const STATES: { name: string; voice: Partial<FaceVoice>; live: Partial<FaceLive> }[] = [
	{ name: "idle", voice: { phase: "idle" }, live: {} },
	{ name: "listening", voice: { phase: "listening", micLive: true }, live: {} },
	{ name: "speaking", voice: { phase: "speaking" }, live: {} },
	{ name: "failed", voice: { phase: "error", error: "The microphone was blocked." }, live: {} },
	{ name: "live available", voice: { phase: "idle" }, live: { available: true } },
];

describe("every control on the Face surface can be pressed by a pointer", () => {
	const rules = pointerRules(STYLES);

	test("the stylesheet's overlay boxes do use pointer-events: none (the check below is not vacuous)", () => {
		expect(rules.some((rule) => rule.value === "none" && rule.selector === ".f2f-top")).toBe(true);
	});

	for (const state of STATES) {
		test(`${state.name}: no button, link or field sits under a pointer-events: none box`, async () => {
			const view = await mountPage(
				<FaceSurfaceBody voice={voice(state.voice)} live={live(state.live)} head={{ status: "loading" }} onIntent={() => undefined} />,
			);
			const controls = [...view.container.querySelectorAll("button, a[href], input, select, [role='button'], [role='menuitem']")];
			expect(controls.length).toBeGreaterThan(0);
			const dead = controls
				.filter((control) => effectivePointerEvents(control, rules) === "none")
				.map((control) => control.getAttribute("aria-label") ?? control.textContent?.trim() ?? control.tagName);
			expect(dead).toEqual([]);
		});
	}

	test("Back to thread is among the controls checked", async () => {
		const view = await mountPage(
			<FaceSurfaceBody voice={voice()} live={live()} head={{ status: "loading" }} onIntent={() => undefined} />,
		);
		expect(view.container.querySelector("button[aria-label='Back to thread (Esc)']")).not.toBeNull();
	});
});
