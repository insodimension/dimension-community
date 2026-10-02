// The surface against a fake voice conversation, mounted for real (linkedom + react-dom, the head still
// "loading" so no WebGL is asked for). Defended here: CONSENT (the microphone opens from the user's click on
// "Tap to talk" and nowhere else, in every phase and after an error), the ways OUT (Back and Esc both end the
// conversation and leave), and that the mic state on screen is the hook's. The pure phase mapping is in
// surface-model.test.ts; the door in surface-door.test.tsx.
import { afterEach, describe, expect, jest, test } from "bun:test";
import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FaceSurfaceBody } from "../src/surface/face-surface";
import { type HeadState, loadHead } from "../src/surface/head";
import type { Intent } from "../src/surface/surface-model";
import type { FaceVoice } from "../src/surface/voice";
import { mountPage, unmountAll, unmountRoots } from "./surface-dom";

afterEach(unmountAll);

function fakeVoice(over: Partial<FaceVoice> = {}) {
	const calls = { start: 0, stop: 0, toggleMute: 0 };
	const voice: FaceVoice = {
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
		start: async () => void calls.start++,
		stop: async () => void calls.stop++,
		toggleMute: () => void calls.toggleMute++,
		...over,
	};
	return { voice, calls };
}

async function mount(over: Partial<FaceVoice> = {}, head: HeadState = { status: "loading" }) {
	const { voice, calls } = fakeVoice(over);
	const intents: Intent[] = [];
	const page = await mountPage(<FaceSurfaceBody voice={voice} head={head} onIntent={(i) => intents.push(i)} />);
	return { ...page, calls, intents };
}

const PHASES: Partial<FaceVoice>[] = [
	{ phase: "idle", supported: true },
	{ phase: "idle", supported: false },
	{ phase: "connecting" },
	{ phase: "listening", micLive: true },
	{ phase: "thinking" },
	{ phase: "speaking" },
	{ phase: "error", error: "The microphone was blocked." },
];

describe("consent: the microphone opens from the click on Tap to talk, and only there", () => {
	test("mounting the surface never starts a conversation, whatever state the hook is in", async () => {
		for (const state of PHASES) {
			const view = await mount(state);
			expect(view.calls.start).toBe(0);
			await unmountRoots();
		}
	});

	test("Tap to talk is offered when idle, starts exactly once per click, and is gone once a conversation is open", async () => {
		const view = await mount({ phase: "idle", supported: true });
		expect(view.buttonByText("Tap to talk")).toBeDefined();
		await view.press(view.buttonByText("Tap to talk"));
		expect(view.calls.start).toBe(1);

		for (const phase of ["connecting", "listening", "thinking", "speaking"] as const) {
			const open = await mount({ phase });
			expect(open.buttonByText("Tap to talk")).toBeUndefined();
		}
	});

	test("after a failure the engine's words are shown verbatim and only Try again (a click) starts it again", async () => {
		const view = await mount({ phase: "error", error: "ElevenLabs answered 401: invalid API key" });
		expect(view.container.textContent).toContain("ElevenLabs answered 401: invalid API key");
		expect(view.calls.start).toBe(0);
		await view.press(view.buttonByText("Try again"));
		expect(view.calls.start).toBe(1);
	});

	test("an engine with no speech lane offers no mic: quiet during the probe, then an honest 'Voice is not ready'", async () => {
		jest.useFakeTimers();
		try {
			const view = await mount({ phase: "idle", supported: false });
			expect(view.container.textContent).not.toContain("Voice is not ready");
			await act(async () => {
				jest.advanceTimersByTime(2600);
			});
			expect(view.container.textContent).toContain("Voice is not ready");
			expect(view.buttonByText("Tap to talk")).toBeUndefined();
			expect(view.calls.start).toBe(0);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe("a face that cannot be drawn does not take the conversation with it", () => {
	// Bun prints a logged Error by source-mapping the whole react-dom dev bundle (seconds); the boundary, not the log, is under test.
	const { error, warn } = console;
	afterEach(() => {
		console.error = error;
		console.warn = warn;
	});

	test("no WebGL2 (linkedom has none): the card says so in the middle of the page, and Tap to talk and Back still work", async () => {
		console.error = () => {};
		console.warn = () => {};
		const bytes = readFileSync(resolve(import.meta.dir, "../assets/head-f01.bin"));
		const asset = await loadHead(`data:application/octet-stream;base64,${bytes.toString("base64")}`);
		const view = await mount({ phase: "idle", supported: true }, { status: "ready", asset });
		expect(view.find(".f2f-center")?.textContent).toContain("The face could not be drawn");
		expect(view.find(".f2f-center")?.textContent).toContain("WebGL2");
		await view.press(view.buttonByText("Tap to talk"));
		expect(view.calls.start).toBe(1);
		await view.press(view.buttonByText("Back to thread"));
		expect(view.intents).toEqual([{ t: "mount", surface: "session" }]);
		// React's dev-mode error path builds component stacks through Bun's source-mapper: ~7 s for the first caught render error
	}, 60_000);

	test("a head that failed to decode says it could not be LOADED (not a WebGL hint) and keeps the controls", async () => {
		const view = await mount({ phase: "idle", supported: true }, { status: "failed", message: "not a face head asset" });
		expect(view.find(".f2f-center")?.textContent).toContain("The face could not be loaded");
		expect(view.find(".f2f-center")?.textContent).not.toContain("WebGL2");
		expect(view.buttonByText("Tap to talk")).toBeDefined();
	});
});

describe("leaving", () => {
	test("Back to thread ends the conversation and mounts the session surface, in every phase", async () => {
		for (const state of PHASES) {
			const view = await mount(state);
			await view.press(view.buttonByText("Back to thread"));
			expect(view.calls.stop).toBe(1);
			expect(view.intents).toEqual([{ t: "mount", surface: "session" }]);
			await unmountRoots();
		}
	});

	test("Esc does the same as Back", async () => {
		const view = await mount({ phase: "speaking" });
		await view.key("Escape");
		expect(view.calls.stop).toBe(1);
		expect(view.intents).toEqual([{ t: "mount", surface: "session" }]);
	});

	test("after the surface unmounts, Esc no longer leaves anything", async () => {
		const view = await mount({ phase: "listening", micLive: true });
		await unmountRoots();
		await view.key("Escape");
		expect(view.calls.stop).toBe(0);
		expect(view.intents).toEqual([]);
	});
});

describe("what the mic controls show", () => {
	test("Mic on with the red dot follows micLive exactly; Mic off otherwise", async () => {
		const live = await mount({ phase: "listening", micLive: true });
		expect(live.find(".f2f-mic")?.getAttribute("data-on")).toBe("true");
		expect(live.find(".f2f-mic")?.textContent).toContain("Mic on");
		const off = await mount({ phase: "idle", micLive: false });
		expect(off.find(".f2f-mic")?.getAttribute("data-on")).toBe("false");
		expect(off.find(".f2f-mic")?.textContent).toContain("Mic off");
	});

	test("Mute exists only in an open conversation, says which way it will flip, and toggles through the hook", async () => {
		expect((await mount({ phase: "idle" })).buttonByText("Mute")).toBeUndefined();
		const listening = await mount({ phase: "listening", micLive: true });
		await listening.press(listening.buttonByText("Mute"));
		expect(listening.calls.toggleMute).toBe(1);
		const muted = await mount({ phase: "listening", micLive: false, muted: true });
		expect(muted.buttonByText("Unmute")).toBeDefined();
		expect(muted.find(".f2f-state")?.textContent).toContain("Muted");
	});

	test("muting while the agent speaks does not silence the face: it is still Speaking", async () => {
		const view = await mount({ phase: "speaking", muted: true });
		expect(view.find(".f2f-state")?.textContent).toContain("Speaking");
		expect(view.find(".f2f-root")?.getAttribute("data-phase")).toBe("speaking");
	});
});

const DEVICES = [
	{ id: "default", label: "Default - Headset Microphone (INZONE H9 II - Chat)" },
	{ id: "usb-id", label: "USB Microphone" },
];
const LISTENING: Partial<FaceVoice> = { phase: "listening", micLive: true, micDevices: DEVICES, micDeviceId: "usb-id", micLabel: "USB Microphone" };
const DEAD: Partial<FaceVoice> = { ...LISTENING, micSilent: true, micDeviceId: "default", micLabel: DEVICES[0]?.label };
// presence as a boolean: a failed expect prints what it received, and a linkedom node is huge
const has = (view: { find: (selector: string) => Element | null }, selector: string) => view.find(selector) !== null;

describe("the microphone picker", () => {
	test("sits with Mute in an open conversation, and is not offered when there is none or it has failed", async () => {
		for (const phase of ["listening", "thinking", "speaking"] as const) {
			const open = await mount({ ...LISTENING, phase });
			expect(has(open, ".f2f-mp")).toBe(true);
			await unmountRoots();
		}
		for (const state of [{ phase: "idle" }, { phase: "error", error: "The microphone was blocked." }] as const) {
			const closed = await mount({ ...LISTENING, ...state, micLive: false });
			expect(has(closed, ".f2f-mp")).toBe(false);
			await unmountRoots();
		}
	});

	test("choosing a microphone goes to the hook and keeps the conversation open", async () => {
		const chosen: (string | undefined)[] = [];
		const view = await mount({ ...LISTENING, setMicDevice: (id) => void chosen.push(id) });
		await view.press(view.find(".f2f-mp-btn"));
		await view.press([...view.container.querySelectorAll('[role="menuitemradio"]')][0]);
		expect(chosen).toEqual(["default"]);
		expect(view.calls.stop).toBe(0);
		expect(view.calls.start).toBe(0);
		expect(view.intents).toEqual([]);
	});

	test("Esc inside the open menu closes the menu and stays in the conversation; Esc with it closed leaves", async () => {
		const view = await mount(LISTENING);
		await view.press(view.find(".f2f-mp-btn"));
		await view.keyOn(view.find('[role="menuitemradio"]'), "Escape");
		expect(has(view, '[role="menu"]')).toBe(false);
		expect(view.calls.stop).toBe(0);
		expect(view.intents).toEqual([]);

		await view.keyOn(view.find(".f2f-mp-btn"), "Escape");
		expect(view.calls.stop).toBe(1);
		expect(view.intents).toEqual([{ t: "mount", surface: "session" }]);
	});
});

describe("a microphone that hears nothing", () => {
	test("the label says No sound (not Listening), the note names the device and asks for another, and the picker is flagged", async () => {
		const view = await mount(DEAD);
		expect(view.find(".f2f-label")?.textContent).toBe("No sound");
		expect(view.find(".f2f-state")?.textContent).not.toContain("Listening");
		expect(view.find(".f2f-note")?.textContent).toBe("No sound from INZONE H9 II. Pick another microphone.");
		expect(view.find(".f2f-note")?.getAttribute("data-warn")).toBe("true");
		expect(view.find(".f2f-mp-btn")?.getAttribute("data-warn")).toBe("true");
	});

	test("a working microphone is Listening, and an ordinary engine notice is not dressed as a warning", async () => {
		const quiet = await mount(LISTENING);
		expect(quiet.find(".f2f-label")?.textContent).toBe("Listening");
		expect(has(quiet, ".f2f-note")).toBe(false);
		const notice = "Downloading the voice model (42%)…";
		const busy = await mount({ ...LISTENING, notice });
		expect(busy.find(".f2f-note")?.textContent).toBe(notice);
		expect(busy.find(".f2f-note")?.getAttribute("data-warn")).toBe("false");
	});

	test("no warning while muted (silence is the point) or while the agent thinks or speaks", async () => {
		for (const [state, label] of [
			[{ muted: true, micLive: false }, "Muted"],
			[{ phase: "thinking" }, "Thinking"],
			[{ phase: "speaking" }, "Speaking"],
		] as const) {
			const view = await mount({ ...DEAD, ...state });
			expect(view.find(".f2f-label")?.textContent).toBe(label);
			expect(has(view, ".f2f-note")).toBe(false);
			await unmountRoots();
		}
	});
});

describe("the send countdown", () => {
	test("the hairline under the user's words is drawn only while their words are being captured", async () => {
		const WORDS = "book me a table";
		const rows: readonly (readonly [string, Partial<FaceVoice>])[] = [
			["listening, words captured", { ...LISTENING, partial: WORDS }],
			["listening, nothing said", { ...LISTENING, partial: "" }],
			["listening, only blanks heard", { ...LISTENING, partial: "   " }],
			["muted", { ...LISTENING, muted: true, micLive: false, partial: WORDS }],
			["thinking", { phase: "thinking", micLive: true, partial: WORDS }],
			["speaking", { phase: "speaking", micLive: true, partial: WORDS }],
			["idle", { phase: "idle", partial: WORDS }],
		];
		const drawn: Record<string, boolean> = {};
		for (const [name, over] of rows) {
			drawn[name] = has(await mount(over), ".f2f-silence");
			await unmountRoots();
		}

		expect(drawn).toEqual({
			"listening, words captured": true,
			"listening, nothing said": false,
			"listening, only blanks heard": false,
			muted: false,
			thinking: false,
			speaking: false,
			idle: false,
		});
	});
});

describe("words the host could not send", () => {
	const REASON = "Couldn't send that: Session is not connected; nothing was sent.";

	test("the note says so as a warning and the words stay in the caption, with the send hairline at rest", async () => {
		const view = await mount({ ...LISTENING, partial: "book me a table", refusal: REASON });

		expect(view.find(".f2f-note")?.textContent).toBe(REASON);
		expect(view.find(".f2f-note")?.getAttribute("data-warn")).toBe("true");
		expect(view.find(".f2f-usercap")?.textContent).toBe("book me a table");
		expect(view.find(".f2f-label")?.textContent).toBe("Listening");
	});

	test("a send that went fine shows no note", async () => {
		const view = await mount({ ...LISTENING, partial: "", refusal: undefined });

		expect(has(view, ".f2f-note")).toBe(false);
		expect(has(view, ".f2f-usercap")).toBe(false);
	});
});
