// The microphone rules, with no DOM: what a device is called to a person, which entry of the input menu is the
// live one, and the sentence for a microphone that only delivers silence.
import { describe, expect, test } from "bun:test";
import { describeMicMenu, type MicMenuItem, micName, micSilentNotice } from "../src/surface/mic-model";

describe("micName: what to call a device in a sentence", () => {
	const cases: [string, string | undefined, string | undefined][] = [
		["the OS's 'Default' alias, the generic front and the driver's channel all go", "Default - Headset Microphone (INZONE H9 II - Chat)", "INZONE H9 II"],
		["a numbered Windows endpoint loses its number and channel", "Microphone (3- Razer Kraken V4 Pro - Chat)", "Razer Kraken V4 Pro"],
		["a parenthesis inside the device name is not cut short", "Communications - Microphone (Realtek(R) Audio)", "Realtek(R) Audio"],
		["the alias prefix is matched whatever its case", "default - USB Microphone", "USB Microphone"],
		["a label with no noise is returned as it is", "MacBook Pro Microphone", "MacBook Pro Microphone"],
		["a dash that is part of the name stays: only a driver channel is dropped", "USB Audio - Studio Mic", "USB Audio - Studio Mic"],
		["no label (permission not granted yet)", undefined, undefined],
		["an empty label", "", undefined],
		["a whitespace label", "   ", undefined],
		["a label that is only the alias prefix", "Default - ", undefined],
		["a label that is only the alias prefix, communications", "Communications -", undefined],
	];
	for (const [name, label, expected] of cases) {
		test(name, () => {
			expect(micName(label)).toBe(expected);
		});
	}
});

describe("micSilentNotice: the warning for a microphone that hears nothing", () => {
	test("names the device the person would recognise, and asks for another", () => {
		expect(micSilentNotice("Default - Headset Microphone (INZONE H9 II - Chat)")).toBe(
			"No sound from INZONE H9 II. Pick another microphone.",
		);
	});

	test("with nothing to name it says 'your microphone' rather than a blank or 'undefined'", () => {
		const generic = "No sound from your microphone. Pick another microphone.";
		expect(micSilentNotice(undefined)).toBe(generic);
		expect(micSilentNotice("  ")).toBe(generic);
		expect(micSilentNotice("Default - ")).toBe(generic);
	});
});

describe("describeMicMenu: the input menu and its live entry", () => {
	const SYSTEM = { id: "default", label: "Default - Headset Microphone (INZONE H9 II - Chat)" };
	const ALIAS = { id: "communications", label: "Communications - Headset Microphone (INZONE H9 II - Chat)" };
	const HEADSET = { id: "headset-id", label: "Headset Microphone (INZONE H9 II - Chat)" };
	const RAZER = { id: "razer-id", label: "Microphone (3- Razer Kraken V4 Pro - Chat)" };
	const DEVICES = [SYSTEM, ALIAS, HEADSET, RAZER];
	const menu = (over: { micDeviceId?: string; micLabel?: string; micDevices?: typeof DEVICES } = {}) =>
		describeMicMenu({ micDevices: DEVICES, micDeviceId: undefined, micLabel: undefined, ...over });
	const checkedIds = (items: MicMenuItem[]) => items.filter((item) => item.checked).map((item) => item.id);

	test("an empty device list is an empty menu", () => {
		expect(menu({ micDevices: [] })).toEqual([]);
	});

	test("the browser's 'communications' alias repeats the default and is left out; the order is kept", () => {
		expect(menu().map((item) => item.id)).toEqual(["default", "headset-id", "razer-id"]);
	});

	test("the default entry says what it currently resolves to; other entries keep their label", () => {
		expect(menu().map((item) => item.label)).toEqual([
			"System default \u00b7 Headset Microphone (INZONE H9 II - Chat)",
			HEADSET.label,
			RAZER.label,
		]);
	});

	test("an unlabelled default (no permission yet) is just 'System default'", () => {
		for (const label of ["", "Default - "]) {
			const [first] = menu({ micDevices: [{ id: "default", label }, HEADSET] });
			expect(first?.label).toBe("System default");
		}
	});

	test("the live entry is the one whose id the capture reports", () => {
		expect(checkedIds(menu({ micDeviceId: "razer-id" }))).toEqual(["razer-id"]);
		expect(checkedIds(menu({ micDeviceId: "default" }))).toEqual(["default"]);
	});

	test("the id wins over a label that points at another entry", () => {
		expect(checkedIds(menu({ micDeviceId: "razer-id", micLabel: HEADSET.label }))).toEqual(["razer-id"]);
	});

	test("with no entry under that id (it was re-enumerated), the capture's label finds the live entry", () => {
		expect(checkedIds(menu({ micDeviceId: "stale-id", micLabel: HEADSET.label }))).toEqual(["headset-id"]);
	});

	test("with no id at all, a label match beats the system default; with neither, the system default is live", () => {
		expect(checkedIds(menu({ micLabel: RAZER.label }))).toEqual(["razer-id"]);
		expect(checkedIds(menu())).toEqual(["default"]);
	});

	test("a chosen id that is not in the list does not fall back to the default: nothing is checked", () => {
		expect(checkedIds(menu({ micDeviceId: "unplugged-id" }))).toEqual([]);
		expect(checkedIds(menu({ micDeviceId: "unplugged-id", micLabel: "Some other microphone" }))).toEqual([]);
	});

	test("never more than one entry is checked, even for two devices with the same label", () => {
		const twins = [
			{ id: "twin-a", label: "USB Microphone" },
			{ id: "twin-b", label: "USB Microphone" },
		];
		expect(checkedIds(menu({ micDevices: twins, micLabel: "USB Microphone" }))).toEqual(["twin-a"]);
		expect(checkedIds(menu({ micDevices: twins, micDeviceId: "twin-b", micLabel: "USB Microphone" }))).toEqual(["twin-b"]);

		const ids = [undefined, ...DEVICES.map((device) => device.id), "unplugged-id"];
		const labels = [undefined, ...DEVICES.map((device) => device.label), "Some other microphone"];
		for (const micDeviceId of ids) {
			for (const micLabel of labels) {
				expect(checkedIds(menu({ micDeviceId, micLabel })).length).toBeLessThanOrEqual(1);
			}
		}
	});
});
