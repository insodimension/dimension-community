// The microphone picker mounted for real (linkedom + react-dom): what the button and the menu show, how a choice is
// made and dismissed, and the keyboard. The menu's rules (which entry is live, what an entry is called) are in
// mic-model.test.ts; how the surface uses the picker is in surface-flow.test.tsx.
import { afterEach, describe, expect, test } from "bun:test";
import { MicPicker, type MicPickerVoice } from "../src/surface/mic-picker";
import { mountPage, unmountAll } from "./surface-dom";

afterEach(unmountAll);

const SYSTEM = { id: "default", label: "Default - Built-in Mic" };
const ALIAS = { id: "communications", label: "Communications - Built-in Mic" };
const USB = { id: "usb-id", label: "USB Microphone" };
const HEADSET = { id: "bt-id", label: "Headset (AirPods)" };

function fakeVoice(over: Partial<MicPickerVoice> = {}) {
	const chosen: (string | undefined)[] = [];
	const voice: MicPickerVoice = {
		micDevices: [SYSTEM, ALIAS, USB, HEADSET],
		micDeviceId: USB.id,
		micLabel: USB.label,
		micSilent: false,
		setMicDevice: (id) => void chosen.push(id),
		...over,
	};
	return { voice, chosen };
}

async function mount(over: Partial<MicPickerVoice> = {}) {
	const { voice, chosen } = fakeVoice(over);
	const page = await mountPage(
		<>
			<MicPicker voice={voice} />
			<p id="elsewhere">the rest of the page</p>
		</>,
	);
	const button = () => page.find(".f2f-mp-btn");
	const items = () => [...page.container.querySelectorAll('[role="menuitemradio"]')];
	// booleans, not elements: a failed expect prints what it received, and a linkedom node is huge
	const has = (selector: string) => page.find(selector) !== null;
	const isOpen = () => has('[role="menu"]');
	const open = async () => page.press(button());
	return { ...page, chosen, button, items, has, isOpen, open };
}

describe("what the picker offers", () => {
	test("nothing when there is no input to choose, or only the browser's alias of the default", async () => {
		for (const micDevices of [[], [ALIAS]]) {
			const view = await mount({ micDevices });
			expect(view.has(".f2f-mp")).toBe(false);
			expect(view.has(".f2f-mp-btn")).toBe(false);
			await unmountAll();
		}
	});

	test("closed, it names the live microphone the way a person would, or just 'Microphone' before one is open", async () => {
		const named = await mount({ micLabel: "Default - Headset Microphone (INZONE H9 II - Chat)" });
		expect(named.button()?.textContent?.trim()).toBe("INZONE H9 II");
		expect(named.button()?.getAttribute("aria-expanded")).toBe("false");
		expect(named.isOpen()).toBe(false);
		await unmountAll();

		const unnamed = await mount({ micLabel: undefined, micDeviceId: undefined });
		expect(unnamed.button()?.textContent?.trim()).toBe("Microphone");
	});

	test("the button warns (data-warn) exactly while the microphone is silent", async () => {
		const silent = await mount({ micSilent: true });
		expect(silent.button()?.getAttribute("data-warn")).toBe("true");
		await unmountAll();
		const fine = await mount({ micSilent: false });
		expect(fine.button()?.getAttribute("data-warn")).toBe("false");
	});

	test("opening lists one radio entry per device (the alias left out), with only the live one checked", async () => {
		const view = await mount();
		await view.open();
		expect(view.button()?.getAttribute("aria-expanded")).toBe("true");
		expect(view.items().map((item) => [item.textContent?.trim(), item.getAttribute("aria-checked")])).toEqual([
			["System default \u00b7 Built-in Mic", "false"],
			["USB Microphone", "true"],
			["Headset (AirPods)", "false"],
		]);
	});

	test("the button toggles the menu", async () => {
		const view = await mount();
		await view.open();
		expect(view.isOpen()).toBe(true);
		await view.open();
		expect(view.isOpen()).toBe(false);
		expect(view.button()?.getAttribute("aria-expanded")).toBe("false");
	});
});

describe("choosing", () => {
	test("an entry switches the microphone once, with that entry's id, and closes the menu", async () => {
		const view = await mount();
		await view.open();
		await view.press(view.items()[2]);
		expect(view.chosen).toEqual([HEADSET.id]);
		expect(view.isOpen()).toBe(false);
	});

	test("the system default is chosen by its own id, not as 'nothing'", async () => {
		const view = await mount();
		await view.open();
		await view.press(view.items()[0]);
		expect(view.chosen).toEqual(["default"]);
	});

	test("opening and closing the menu changes nothing", async () => {
		const view = await mount();
		await view.open();
		await view.open();
		expect(view.chosen).toEqual([]);
	});
});

describe("dismissing", () => {
	test("Esc in the menu closes it, is marked handled so the surface does not leave, and returns focus to the button", async () => {
		const view = await mount();
		await view.open();
		const esc = await view.keyOn(view.items()[0], "Escape");
		expect(esc.defaultPrevented).toBe(true);
		expect(view.isOpen()).toBe(false);
		expect(view.focused() === view.button()).toBe(true);
		expect(view.chosen).toEqual([]);
	});

	test("Esc with the menu closed is left alone, so the surface can leave", async () => {
		const view = await mount();
		const esc = await view.keyOn(view.button(), "Escape");
		expect(esc.defaultPrevented).toBe(false);
	});

	test("a press outside closes the menu; a press on the button or an entry does not (the click that follows must land)", async () => {
		const view = await mount();
		await view.open();
		await view.pointerDown(view.items()[1]);
		await view.pointerDown(view.button());
		expect(view.isOpen()).toBe(true);
		await view.pointerDown(view.find("#elsewhere"));
		expect(view.isOpen()).toBe(false);
		expect(view.chosen).toEqual([]);
	});

	test("once closed, a press outside does nothing to the next opening", async () => {
		const view = await mount();
		await view.open();
		await view.pointerDown(view.find("#elsewhere"));
		await view.open();
		expect(view.isOpen()).toBe(true);
		await view.pointerDown(view.find("#elsewhere"));
		expect(view.isOpen()).toBe(false);
	});
});

describe("keyboard", () => {
	const focusedLabel = (view: { focused: () => HTMLElement | null }) => view.focused()?.textContent?.trim();

	test("opening puts focus on the live entry", async () => {
		const view = await mount();
		await view.open();
		expect(focusedLabel(view)).toBe("USB Microphone");
	});

	test("with no entry live, opening puts focus on the first", async () => {
		const view = await mount({ micDeviceId: "unplugged-id", micLabel: undefined });
		await view.open();
		expect(focusedLabel(view)).toBe("System default \u00b7 Built-in Mic");
	});

	test("arrows, Home and End move between entries and wrap at both ends", async () => {
		const view = await mount();
		await view.open();
		const steps: [string, string][] = [
			["ArrowDown", "Headset (AirPods)"],
			["ArrowDown", "System default \u00b7 Built-in Mic"],
			["ArrowUp", "Headset (AirPods)"],
			["ArrowUp", "USB Microphone"],
			["Home", "System default \u00b7 Built-in Mic"],
			["End", "Headset (AirPods)"],
		];
		for (const [key, expected] of steps) {
			await view.keyOn(view.focused(), key);
			expect(focusedLabel(view)).toBe(expected);
		}
		expect(view.chosen).toEqual([]);
		expect(view.isOpen()).toBe(true);
	});
});
